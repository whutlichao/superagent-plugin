// Loopback HTTP API（§G.1、§G.3 第 1–9 条、§N.1 端口选择）：边界逐条、错误码映射逐项、
// 三种 token 角色的拒绝面与 `GET state` 的形状。
//
// 测试只用真 HTTP（`node:http` 客户端）、真 SQLite（临时状态目录）、真 token 文件；
// 时钟一律注入，不 sleep（§P.1 第 3、4 条）。
import { assert, test } from 'orca/testing'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { request as httpRequest, createServer } from 'node:http'
import { join } from 'node:path'
import type { Store } from '../src/worker/app/store'
import {
  ApiError,
  ERROR_CODES,
  statusForErrorCode,
  toApiError,
  type ApiEnvelope,
  type ErrorPayload
} from '../src/worker/http/errors'
import {
  createRateLimiter,
  RATE_LIMIT_BURST,
  RATE_LIMIT_PER_MINUTE,
  type RateLimiter
} from '../src/worker/http/rate-limit'
import {
  DEFAULT_PORT,
  PORT_ATTEMPTS,
  PORT_FILE,
  processAlive,
  readPortRecord,
  removePortRecord,
  writePortRecord
} from '../src/worker/http/port-file'
import {
  ensureApiToken,
  issueAssignmentToken,
  issueRouterToken,
  readApiToken,
  revokeAssignmentToken
} from '../src/worker/infra/tokens'
import {
  ROLE_RANK,
  ROUTE_TABLE,
  allowsRole,
  rolesFor,
  type RouteDefinition
} from '../src/worker/http/routes'
import {
  startHttpServer,
  type HttpServerHandle,
  type RequestLogLine
} from '../src/worker/http/server'
import type { HttpHost } from '../src/worker/http/state'
import { openStore } from '../src/worker/app/store'
import { SCHEMA_VERSION } from '../src/worker/app/schema'
import { runIdempotent } from '../src/worker/http/idempotency'
import { tempStateDir } from './support/state'

// ---------------------------------------------------------------- 错误码映射

test('every error-code family maps to the status §G.3 item 8 fixes', () => {
  const cases: readonly (readonly [string, number])[] = [
    ['invalid_params', 400],
    ['invalid_value', 400],
    ['invalid_assessment', 400],
    ['invalid_config', 400],
    ['incomplete_rules', 400],
    ['policy_changed', 400],
    ['too_late', 400],
    ['too_many_items', 400],
    ['refused', 400],
    ['stale_revision', 400],
    ['too_long', 400],
    ['unauthorized', 401],
    ['not_permitted_role', 403],
    ['origin_forbidden', 403],
    ['missing', 404],
    ['conflict', 409],
    ['too_large', 413],
    ['rate_limited', 429],
    ['unavailable', 503],
    // 表里没有的码一律 500：宁可说「内部错误」，也不假装是客户端问题。
    ['internal', 500],
    ['something_else', 500]
  ]
  for (const [code, status] of cases) {
    assert.equal(statusForErrorCode(code), status, code)
  }
})

test('an ApiError carries its code, status and fixed values', () => {
  const error = new ApiError(ERROR_CODES.missing, 'Unknown ticket', { ticket: 'ticket-1' })
  assert.equal(error.code, 'missing')
  assert.equal(error.status, 404)
  assert.deepEqual(error.toJSON(), {
    code: 'missing',
    message: 'Unknown ticket',
    values: { ticket: 'ticket-1' }
  })
  // 没有填槽值时，信封里不出现空的 values 键。
  assert.deepEqual(new ApiError(ERROR_CODES.refused, 'Refused').toJSON(), {
    code: 'refused',
    message: 'Refused'
  })
})

test('an unexpected throw becomes an internal error without leaking its message', () => {
  const wrapped = toApiError(new Error('connection string postgres://secret'))
  assert.equal(wrapped.code, 'internal')
  assert.equal(wrapped.status, 500)
  assert.equal(wrapped.message.includes('secret'), false, 'the internal message is not echoed')
  // ApiError 原样透传（含状态码）。
  assert.equal(toApiError(new ApiError(ERROR_CODES.conflict, 'Stale')).status, 409)
})

// ---------------------------------------------------------------- 限流

test('the limiter allows a burst of twenty and then asks the caller to wait', () => {
  let now = 0
  const limiter = createRateLimiter({ now: () => now })
  assert.equal(RATE_LIMIT_PER_MINUTE, 60)
  assert.equal(RATE_LIMIT_BURST, 20)

  for (let index = 0; index < RATE_LIMIT_BURST; index += 1) {
    assert.deepEqual(limiter.take('token-a'), { allowed: true }, `request ${index + 1}`)
  }
  const refused = limiter.take('token-a')
  assert.equal(refused.allowed, false)
  if (refused.allowed) return
  // 60/min = 1/s：攒回一个令牌正好一秒。
  assert.equal(refused.retryAfterMs, 1000)

  // 另一个 token 有自己的桶。
  assert.deepEqual(limiter.take('token-b'), { allowed: true })

  // 半秒不够，一秒够。
  now += 500
  assert.equal(limiter.take('token-a').allowed, false)
  now += 500
  assert.deepEqual(limiter.take('token-a'), { allowed: true })
  assert.equal(limiter.take('token-a').allowed, false)
})

test('a full minute of idleness refills the whole burst, never more', () => {
  let now = 0
  const limiter = createRateLimiter({ now: () => now })
  for (let index = 0; index < RATE_LIMIT_BURST; index += 1) limiter.take('token-a')
  now += 60_000
  for (let index = 0; index < RATE_LIMIT_BURST; index += 1) {
    assert.equal(limiter.take('token-a').allowed, true, `refilled request ${index + 1}`)
  }
  assert.equal(limiter.take('token-a').allowed, false, 'the bucket never exceeds its burst')
})

// ---------------------------------------------------------------- 端口文件

test('the port file records the actual port with pid and start time, mode 0600', () => {
  const stateDir = tempStateDir()
  const record = { port: 3912, pid: process.pid, startedAt: '2026-11-07T03:26:00.000Z' }
  const path = writePortRecord(stateDir, record)
  assert.equal(path, join(stateDir, PORT_FILE))
  assert.equal(statSync(path).mode & 0o777, 0o600, 'the port file is private')
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), record)
  assert.deepEqual(readPortRecord(stateDir), record)
  assert.equal(PORT_FILE, 'api-port', '§D.5 keeps the file name')
})

test('a port file whose process is gone reads as missing, so the reader re-probes', () => {
  const stateDir = tempStateDir()
  // S6 的回落：pid 已不存在的端口文件视为失效。
  assert.equal(processAlive(process.pid), true)
  writePortRecord(stateDir, { port: 3912, pid: 999_999, startedAt: '2026-11-07T03:26:00.000Z' })
  assert.equal(processAlive(999_999), false)
  assert.equal(readPortRecord(stateDir), null)
})

test('the plain-number port file §D.5 describes is still readable', () => {
  const stateDir = tempStateDir()
  writeFileSync(join(stateDir, PORT_FILE), '3847', 'utf8')
  assert.deepEqual(readPortRecord(stateDir), { port: 3847, pid: null, startedAt: null })
  // 坏内容与越界端口都当作「没有端口文件」。
  writeFileSync(join(stateDir, PORT_FILE), 'not-a-port', 'utf8')
  assert.equal(readPortRecord(stateDir), null)
  writeFileSync(join(stateDir, PORT_FILE), '70000', 'utf8')
  assert.equal(readPortRecord(stateDir), null)
})

test('removing the port file only removes the record this process wrote', () => {
  const stateDir = tempStateDir()
  const mine = { port: 3912, pid: process.pid, startedAt: '2026-11-07T03:26:00.000Z' }
  writePortRecord(stateDir, mine)
  assert.equal(removePortRecord(stateDir, { ...mine, port: 3913 }), false, 'another port record stays')
  assert.equal(existsSync(join(stateDir, PORT_FILE)), true)
  assert.equal(removePortRecord(stateDir, mine), true)
  assert.equal(existsSync(join(stateDir, PORT_FILE)), false)
})

test('the port search starts at 3847 and tries twenty increments before an ephemeral port', () => {
  assert.equal(DEFAULT_PORT, 3847)
  assert.equal(PORT_ATTEMPTS, 20)
})

// ---------------------------------------------------------------- 测试夹具

/** 一次 HTTP 调用的观测结果。 */
interface Observed {
  readonly status: number
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly text: string
  readonly json: unknown
}

/** 响应头里我们断言的那几个（`node:http` 的原始头允许数组值）。 */
function headerText(headers: Readonly<Record<string, string | readonly string[] | undefined>>, name: string): string | undefined {
  const value = headers[name]
  if (value === undefined) return undefined
  return Array.isArray(value) ? value.join(', ') : (value as string)
}

/** 起一个测试服务器的选项。 */
interface HarnessOptions {
  readonly preferredPort?: number
  readonly rateLimiter?: RateLimiter
  readonly host?: Partial<HttpHost>
  readonly routes?: readonly RouteDefinition[]
  readonly startedAt?: string
  readonly pid?: number
  readonly clock?: () => Date
}

/** 一个跑着的测试服务器与它的状态目录。 */
interface Harness {
  readonly stateDir: string
  readonly store: Store
  readonly server: HttpServerHandle
  readonly logs: RequestLogLine[]
  readonly operatorToken: string
  call(
    path: string,
    options?: {
      readonly method?: string
      readonly token?: string | null
      readonly headers?: Readonly<Record<string, string>>
      readonly body?: unknown
      readonly host?: string
    }
  ): Promise<Observed>
  close(): void
}

/** 一次测试里的默认时钟（固定时刻，便于断言）。 */
const STARTED_AT = '2026-11-07T03:26:00.000Z'

/** 宽容的限流器：边界测试不该被 60/min 绊倒（限流本身有专门用例）。 */
const GENEROUS_LIMITER = (): RateLimiter =>
  createRateLimiter({ perMinute: 60_000, burst: 10_000 })

/** 起一个测试服务器（真库、真 token 文件、真端口）。 */
async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const stateDir = tempStateDir()
  const store = openStore({ stateDir })
  const operatorToken = ensureApiToken(stateDir).token
  const logs: RequestLogLine[] = []
  const host: HttpHost = {
    store,
    stateDir,
    pid: options.pid ?? process.pid,
    startedAt: options.startedAt ?? STARTED_AT,
    ...options.host
  }
  const server = await startHttpServer({
    stateDir,
    host,
    preferredPort: options.preferredPort ?? 0,
    now: options.clock ?? (() => new Date(STARTED_AT)),
    pid: options.pid ?? process.pid,
    startedAt: options.startedAt ?? STARTED_AT,
    log: (line) => void logs.push(line),
    rateLimiter: options.rateLimiter ?? GENEROUS_LIMITER(),
    routes: options.routes
  })
  const call: Harness['call'] = (path, callOptions = {}) => {
    const method = callOptions.method ?? 'GET'
    const headers: Record<string, string> = {
      // 默认发一个合法的 Host；需要坏 Host 的用例显式覆盖。
      host: callOptions.host ?? `127.0.0.1:${server.port}`,
      ...callOptions.headers
    }
    if (callOptions.token !== null) {
      headers['authorization'] = `Bearer ${callOptions.token ?? operatorToken}`
    }
    // 写方法默认带上显式请求头；专测该边界的用例用 `headers` 覆盖成空串。
    if ((method === 'POST' || method === 'PUT') && headers['x-superagent-request'] === undefined) {
      headers['x-superagent-request'] = '1'
    }
    let payload: string | undefined
    if (callOptions.body !== undefined) {
      payload = typeof callOptions.body === 'string' ? callOptions.body : JSON.stringify(callOptions.body)
      headers['content-type'] = 'application/json'
    }
    return new Promise<Observed>((resolve, reject) => {
      const request = httpRequest(
        { host: '127.0.0.1', port: server.port, path, method, headers },
        (response) => {
          let text = ''
          response.setEncoding('utf8')
          response.on('data', (chunk) => {
            text += chunk
          })
          response.on('end', () => {
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers as Readonly<Record<string, string | undefined>>,
              text,
              json: text.length > 0 ? (JSON.parse(text) as unknown) : null
            })
          })
          response.on('error', reject)
        }
      )
      request.on('error', reject)
      request.end(payload)
    })
  }
  return {
    stateDir,
    store,
    server,
    logs,
    operatorToken,
    call,
    close: () => {
      server.close()
      store.close()
    }
  }
}

/** 断言信封是失败，并取出 `error` 段。 */
function failureOf(observed: Observed): ErrorPayload {
  const envelope = observed.json as ApiEnvelope
  if (envelope === null || typeof envelope !== 'object') throw new Error('no JSON envelope')
  if (envelope.ok) throw new Error(`expected a failure envelope, got ${observed.text}`)
  return envelope.error
}

/** 断言信封是成功，并取出 `result`。 */
function resultOf(observed: Observed): unknown {
  const envelope = observed.json as ApiEnvelope
  if (envelope === null || typeof envelope !== 'object' || !envelope.ok) {
    throw new Error(`expected a success envelope, got ${observed.text}`)
  }
  return envelope.result
}

// ---------------------------------------------------------------- 边界 1–9

test('binds 127.0.0.1 only and reports the address it actually bound', async () => {
  const harness = await startHarness()
  try {
    assert.equal(harness.server.host, '127.0.0.1')
    assert.equal(harness.server.boundHost, '127.0.0.1', 'the kernel accepted the loopback bind')
    assert.ok(harness.server.port > 0)
    assert.equal(harness.server.basePath, '/superagent/api')
    // 默认端口被占时可能不是 3847；这里只断言它真的在监听。
    const response = await harness.call('/superagent/api/state')
    assert.equal(response.status, 200)
  } finally {
    harness.close()
  }
})

test('a Host header outside the allow-list is refused with origin_forbidden', async () => {
  const harness = await startHarness()
  try {
    const evil = await harness.call('/superagent/api/state', { host: 'evil.example:9999' })
    assert.equal(evil.status, 403)
    assert.equal(failureOf(evil).code, 'origin_forbidden')

    // 同端口的 127.0.0.1 与 localhost 都允许（§G.3 第 2 条）。
    const loopback = await harness.call('/superagent/api/state', {
      host: `127.0.0.1:${harness.server.port}`
    })
    assert.equal(loopback.status, 200)
    const localhost = await harness.call('/superagent/api/state', {
      host: `localhost:${harness.server.port}`
    })
    assert.equal(localhost.status, 200)

    // 端口对不上也不允许。
    const wrongPort = await harness.call('/superagent/api/state', {
      host: `127.0.0.1:${harness.server.port + 1}`
    })
    assert.equal(wrongPort.status, 403)
  } finally {
    harness.close()
  }
})

test('a missing or invalid bearer token is 401, and cookies never authenticate', async () => {
  const harness = await startHarness()
  try {
    const missing = await harness.call('/superagent/api/state', { token: null })
    assert.equal(missing.status, 401)
    assert.equal(failureOf(missing).code, 'unauthorized')

    const wrong = await harness.call('/superagent/api/state', { token: 'not-a-token' })
    assert.equal(wrong.status, 401)

    // 非 Bearer 方案不认。
    const basic = await harness.call('/superagent/api/state', {
      token: null,
      headers: { authorization: 'Basic dXNlcjpwYXNz' }
    })
    assert.equal(basic.status, 401)

    // §G.3 第 3 条：不使用 cookie。
    const cookie = await harness.call('/superagent/api/state', {
      token: null,
      headers: { cookie: `superagent=${harness.operatorToken}` }
    })
    assert.equal(cookie.status, 401)
  } finally {
    harness.close()
  }
})

test('a cross-site Origin is refused, an allow-listed one is not', async () => {
  const harness = await startHarness()
  try {
    const crossSite = await harness.call('/superagent/api/state', {
      headers: { origin: 'http://evil.example' }
    })
    assert.equal(crossSite.status, 403)
    assert.equal(failureOf(crossSite).code, 'origin_forbidden')

    // 浏览器沙箱上下文发的是字面量 null：不在允许列表里，一律拒绝。
    const opaque = await harness.call('/superagent/api/state', { headers: { origin: 'null' } })
    assert.equal(opaque.status, 403)

    for (const origin of [
      `http://127.0.0.1:${harness.server.port}`,
      `http://localhost:${harness.server.port}`
    ]) {
      const allowed = await harness.call('/superagent/api/state', { headers: { origin } })
      assert.equal(allowed.status, 200, origin)
    }
  } finally {
    harness.close()
  }
})

test('write methods require x-superagent-request: 1', async () => {
  const harness = await startHarness()
  try {
    // 每条写方法挑一条真实存在的路由（POST 与 PUT 各一条）。
    const writes: readonly (readonly [string, string, unknown])[] = [
      ['POST', '/superagent/api/executor/pause', { paused: true }],
      ['PUT', '/superagent/api/settings/executor', { value: { maxWorkers: 2 }, revision: 1 }]
    ]
    for (const [method, path, body] of writes) {
      const missing = await harness.call(path, {
        method,
        body,
        headers: { 'x-superagent-request': '' }
      })
      assert.equal(missing.status, 403, `${method} ${path} without the header`)
      assert.equal(failureOf(missing).code, 'origin_forbidden')

      const present = await harness.call(path, { method, body })
      // 请求头是写方法的唯一额外要求：#8 接线了 `executor/pause`（200），`settings` 仍是
      // stub（503）。两者都不是 403——边界已过。
      assert.notEqual(present.status, 403, `${method} ${path} passes the header boundary`)
    }

    // GET 不要求该请求头（浏览器地址栏/CLI 的读命令）。
    const read = await harness.call('/superagent/api/state', {
      headers: { 'x-superagent-request': '' }
    })
    assert.equal(read.status, 200)
  } finally {
    harness.close()
  }
})

test('a body over 1 MiB is refused with too_large', async () => {
  const harness = await startHarness()
  try {
    // 413 先于读 body 判定（Content-Length 超限直接拒）。
    const over = await harness.call('/superagent/api/settings/executor', {
      method: 'PUT',
      body: { value: { note: 'x'.repeat(1024 * 1024) }, revision: 1 }
    })
    assert.equal(over.status, 413)
    assert.equal(failureOf(over).code, 'too_large')
  } finally {
    harness.close()
  }
})

test('the 1 MiB limit is on the body bytes, not on the route', async () => {
  // 一条允许所有角色的注入路由：让 413 与「body 被接受」两个结果都能观测到。
  const seen: number[] = []
  const harness = await startHarness({
    routes: [
      ...ROUTE_TABLE,
      {
        method: 'POST',
        path: 'test/echo',
        command: 'test echo',
        minimumRole: 'assignment',
        handler: ({ body }) => {
          const text = typeof body === 'string' ? body : JSON.stringify(body)
          seen.push(text.length)
          return { bytes: text.length }
        }
      }
    ]
  })
  try {
    // 恰好 1 MiB 的 body：接受（外层 JSON 字符串的两个引号让正文正好 1 MiB）。
    const exact = 'y'.repeat(1024 * 1024 - 2)
    const ok = await harness.call('/superagent/api/test/echo', { method: 'POST', body: JSON.stringify(exact) })
    assert.equal(ok.status, 200)
    assert.deepEqual(resultOf(ok), { bytes: 1024 * 1024 - 2 })

    // 超过 1 MiB：413。
    const over = await harness.call('/superagent/api/test/echo', {
      method: 'POST',
      body: JSON.stringify(`${exact}zz`)
    })
    assert.equal(over.status, 413)
    assert.equal(failureOf(over).code, 'too_large')
    assert.deepEqual(seen, [1024 * 1024 - 2], 'the oversized body never reached a handler')
  } finally {
    harness.close()
  }
})

test('more than the burst on one token is 429 with Retry-After, and another token is unaffected', async () => {
  let now = 1_000_000
  const limiter = createRateLimiter({ now: () => now })
  const harness = await startHarness({ rateLimiter: limiter })
  try {
    const router = issueRouterToken({ store: harness.store, stateDir: harness.stateDir }).token
    for (let index = 0; index < RATE_LIMIT_BURST; index += 1) {
      const allowed = await harness.call('/superagent/api/state')
      assert.equal(allowed.status, 200, `request ${index + 1}`)
    }
    const limited = await harness.call('/superagent/api/state')
    assert.equal(limited.status, 429)
    assert.equal(failureOf(limited).code, 'rate_limited')
    assert.equal(limited.headers['retry-after'], '1', 'Retry-After is the seconds until one token refills')

    // 另一个 token 有自己的桶。
    const other = await harness.call('/superagent/api/state', { token: router })
    assert.equal(other.status, 200)

    // 时间走过一秒后恢复。
    now += 1000
    const recovered = await harness.call('/superagent/api/state')
    assert.equal(recovered.status, 200)
  } finally {
    harness.close()
  }
})

test('the error table is observable end to end: 400/401/403/404/409/413/429/503/500', async () => {
  // 409 与 500 还没有生产路由会产生它们，所以用两条注入路由把映射本身测到底；
  // 其余码都由真实边界/真实路由产生（见本文件其它用例）。
  const harness = await startHarness({
    rateLimiter: createRateLimiter(),
    routes: [
      ...ROUTE_TABLE,
      {
        method: 'POST',
        path: 'test/conflict',
        command: 'test conflict',
        minimumRole: 'operator',
        handler: () => {
          throw new ApiError(ERROR_CODES.conflict, 'Already exists')
        }
      },
      {
        method: 'POST',
        path: 'test/boom',
        command: 'test boom',
        minimumRole: 'operator',
        handler: () => {
          throw new Error('postgres://user:secret@localhost/db')
        }
      }
    ]
  })
  try {
    const badBody = await harness.call('/superagent/api/settings/executor', {
      method: 'PUT',
      body: 'not json'
    })
    assert.equal(badBody.status, 400)
    assert.equal(failureOf(badBody).code, 'invalid_params')

    const badEscape = await harness.call('/superagent/api/tickets/%E0%A4%A')
    assert.equal(badEscape.status, 400)

    const unauthorized = await harness.call('/superagent/api/state', { token: null })
    assert.equal(unauthorized.status, 401)

    const forbidden = await harness.call('/superagent/api/state', { host: 'evil.example' })
    assert.equal(forbidden.status, 403)

    const missing = await harness.call('/superagent/api/no-such-route')
    assert.equal(missing.status, 404)
    assert.equal(failureOf(missing).code, 'missing')

    const conflict = await harness.call('/superagent/api/test/conflict', { method: 'POST' })
    assert.equal(conflict.status, 409)
    assert.equal(failureOf(conflict).code, 'conflict')

    const boom = await harness.call('/superagent/api/test/boom', { method: 'POST' })
    assert.equal(boom.status, 500)
    const boomError = failureOf(boom)
    assert.equal(boomError.code, 'internal')
    assert.equal(boomError.message.includes('secret'), false, 'internal failures are not echoed')

    const stub = await harness.call('/superagent/api/overview')
    assert.equal(stub.status, 503)
    assert.equal(failureOf(stub).code, 'unavailable')

    // 429 由专门的限流用例断言；这里用同一个限流器把桶打满再确认一次。
    for (let index = 0; index < RATE_LIMIT_BURST + 1; index += 1) {
      await harness.call('/superagent/api/state')
    }
    const limited = await harness.call('/superagent/api/state')
    assert.equal(limited.status, 429)
  } finally {
    harness.close()
  }
})

test('an unknown method on a known path is 404, not 405', async () => {
  const harness = await startHarness()
  try {
    const response = await harness.call('/superagent/api/state', { method: 'DELETE' })
    assert.equal(response.status, 404)
    assert.equal(failureOf(response).code, 'missing')
  } finally {
    harness.close()
  }
})

test('a write with the same request id replays the first result', async () => {
  // §G.1 幂等行在 HTTP 层的验证：同一个 `x-superagent-request-id` 重试只执行一次。
  let runs = 0
  const harness = await startHarness({
    routes: [
      ...ROUTE_TABLE,
      {
        method: 'POST',
        path: 'test/write-once',
        command: 'test write once',
        minimumRole: 'router',
        handler: ({ caller, at }) => {
          const run = runIdempotent({
            store: harness.store,
            caller: caller.role,
            requestId: 'fixed-request',
            at,
            run: () => {
              runs += 1
              return { runs }
            }
          })
          return run.outcome
        }
      }
    ]
  })
  try {
    const first = await harness.call('/superagent/api/test/write-once', { method: 'POST' })
    assert.equal(first.status, 200)
    assert.deepEqual(resultOf(first), { kind: 'ran', result: { runs: 1 } })

    const replay = await harness.call('/superagent/api/test/write-once', { method: 'POST' })
    assert.deepEqual(resultOf(replay), { kind: 'replayed', result: { runs: 1 } })
    assert.equal(runs, 1)
  } finally {
    harness.close()
  }
})

// ---------------------------------------------------------------- 访问日志

test('a request log line carries only method/path/status/code/ms/tokenRole', async () => {
  const harness = await startHarness()
  try {
    const marker = 'body-marker-should-never-be-logged'
    await harness.call('/superagent/api/settings/executor', {
      method: 'PUT',
      body: { value: { note: marker }, revision: 1 }
    })
    await harness.call('/superagent/api/state', { token: null })
    await harness.call('/superagent/api/state')

    assert.equal(harness.logs.length, 3)
    for (const line of harness.logs) {
      assert.deepEqual(Object.keys(line).sort(), ['code', 'method', 'ms', 'path', 'status', 'tokenRole'])
      assert.equal(Number.isInteger(line.ms), true, 'ms is a whole number of milliseconds')
      assert.equal(line.ms >= 0, true)
    }

    const [stubbed, unauthorized, ok] = harness.logs
    assert.deepEqual(
      { method: stubbed?.method, path: stubbed?.path, status: stubbed?.status, code: stubbed?.code },
      { method: 'PUT', path: '/superagent/api/settings/executor', status: 503, code: 'unavailable' }
    )
    assert.equal(stubbed?.tokenRole, 'operator')
    assert.equal(unauthorized?.status, 401)
    assert.equal(unauthorized?.code, 'unauthorized')
    assert.equal(unauthorized?.tokenRole, null, 'a refused request has no role')
    assert.equal(ok?.status, 200)
    assert.equal(ok?.code, null, 'successful requests carry no error code')
    assert.equal(ok?.tokenRole, 'operator')

    // 绝不记 body、token、查询串。
    const serialized = JSON.stringify(harness.logs)
    assert.equal(serialized.includes(marker), false, 'no body in the log')
    assert.equal(serialized.includes(harness.operatorToken), false, 'no token in the log')
  } finally {
    harness.close()
  }
})

// ---------------------------------------------------------------- 路由表

test('the route table carries every row §G.3 names', () => {
  const rows = ROUTE_TABLE.map((route) => `${route.method} ${route.path}`).sort()
  assert.deepEqual(rows, [
    'GET decisions',
    'GET models',
    'GET overview',
    'GET policy/history',
    'GET prompts',
    'GET search',
    'GET settings',
    'GET sources',
    'GET state',
    'GET threads',
    'GET threads/:key',
    'GET tickets',
    'GET tickets/:id',
    'POST ack',
    'POST admin/backup',
    'POST admin/rotate-token',
    'POST decisions/:id/dismiss',
    'POST doctor',
    'POST eval-decide/:id',
    'POST executor/pause',
    'POST policy-sync/:id',
    'POST prompts/preview',
    'POST reply',
    'POST report',
    'POST route',
    'POST router/restart',
    'POST setup/check',
    'POST sources/:id/labels',
    'POST threads/:key/unsubscribe',
    'POST tickets/:id/note',
    'POST tickets/:id/request-status',
    'POST tickets/:id/retry',
    'POST tickets/:id/stop',
    'POST triggers/:id/requeue',
    'POST workspaces/:id/open',
    'PUT prompts',
    'PUT settings/:block'
  ])
  // 每条路由都必须声明最低角色，且角色阶梯是三档（§G.1 角色行）。
  for (const route of ROUTE_TABLE) {
    assert.ok(
      ['operator', 'router', 'assignment'].includes(route.minimumRole),
      `${route.method} ${route.path} declares a minimum role`
    )
    assert.equal(typeof route.command, 'string', `${route.method} ${route.path} names its command`)
  }
  assert.deepEqual(ROLE_RANK, { assignment: 0, router: 1, operator: 2 })
})

test('a router token may reach every route whose minimum role is router', () => {
  // 阶梯的正面：router 覆盖 assignment 与 router 两档（§G.1：router 是路由与评估的子集）。
  const routerRoutes = ROUTE_TABLE.filter((route) => route.minimumRole !== 'operator')
  assert.ok(routerRoutes.length > 15, `${routerRoutes.length} routes are open to a router token`)
  for (const route of routerRoutes) {
    assert.equal(allowsRole(route, 'router'), true)
    assert.equal(allowsRole(route, 'operator'), true)
    // `state` 与 `tickets/:id` 的最低角色是 assignment（worker 自检/读自己的 Ticket），
    // 其余 router 档路由对 assignment 是拒绝的。
    assert.equal(allowsRole(route, 'assignment'), route.minimumRole === 'assignment', route.path)
  }
})

test('GET state answers the process/store/http/loops/health/setup/paused/load shape', async () => {
  const harness = await startHarness()
  try {
    // 两条 Ticket：一条最新 Assignment 在跑，一条在排队（§E.6 的负载口径）。
    harness.store.tickets.put({
      id: 'ticket-running',
      at: STARTED_AT,
      body: { assignments: [{ id: 'a1', state: 'running' }] }
    })
    harness.store.tickets.put({
      id: 'ticket-queued',
      at: STARTED_AT,
      body: { assignments: [{ id: 'a2', state: 'pending' }] }
    })

    const response = await harness.call('/superagent/api/state')
    assert.equal(response.status, 200)
    const state = resultOf(response) as Record<string, unknown>
    assert.deepEqual(Object.keys(state).sort(), [
      'health',
      'http',
      'load',
      'loops',
      'paused',
      'process',
      'setup',
      'store'
    ])

    assert.deepEqual(state['process'], {
      pid: process.pid,
      startedAt: STARTED_AT,
      stateDir: harness.stateDir
    })
    const storeView = state['store'] as Record<string, unknown>
    assert.deepEqual(Object.keys(storeView).sort(), ['journalMode', 'path', 'schemaVersion'])
    assert.equal(storeView['path'], join(harness.stateDir, 'superagent.sqlite'))
    assert.equal(storeView['schemaVersion'], SCHEMA_VERSION)
    assert.equal(storeView['journalMode'], 'wal')

    assert.deepEqual(state['http'], {
      host: '127.0.0.1',
      port: harness.server.port,
      requests: 1
    })
    assert.deepEqual(state['load'], { running: 1, queued: 1, maxWorkers: 2 })
    assert.equal(state['paused'], false)
    assert.deepEqual(state['loops'], [])
    assert.deepEqual(state['setup'], { problem: null })
    const health = state['health'] as Record<string, unknown>
    assert.deepEqual(Object.keys(health), ['runtime'])
    assert.deepEqual(health['runtime'], {
      state: 'ready',
      detail: `loopback api on 127.0.0.1:${harness.server.port}`,
      at: STARTED_AT
    })

    // 第二次请求能看到计数增长（同一份状态读数给 CLI 与面板首屏共用）。
    const again = resultOf(await harness.call('/superagent/api/state')) as Record<string, unknown>
    assert.equal((again['http'] as Record<string, unknown>)['requests'], 2)
  } finally {
    harness.close()
  }
})

test('the state view takes health/setup/paused/loops/maxWorkers from the host ports', async () => {
  const harness = await startHarness({
    host: {
      health: () => ({
        runtime: { state: 'ready', at: STARTED_AT },
        github: { state: 'error', detail: 'poll failed', at: STARTED_AT }
      }),
      setup: () => ({ problem: { place: 'repo', code: 'repo_missing', detail: 'no repository' } }),
      paused: () => true,
      loops: () => [{ name: 'passes', state: 'ready' }],
      maxWorkers: () => 5
    }
  })
  try {
    const state = resultOf(await harness.call('/superagent/api/state')) as Record<string, unknown>
    assert.deepEqual(state['health'], {
      runtime: { state: 'ready', at: STARTED_AT },
      github: { state: 'error', detail: 'poll failed', at: STARTED_AT }
    })
    assert.deepEqual(state['setup'], {
      problem: { place: 'repo', code: 'repo_missing', detail: 'no repository' }
    })
    assert.equal(state['paused'], true)
    assert.deepEqual(state['loops'], [{ name: 'passes', state: 'ready' }])
    assert.deepEqual(state['load'], { running: 0, queued: 0, maxWorkers: 5 })
  } finally {
    harness.close()
  }
})

// ---------------------------------------------------------------- 三种角色

test('an assignment token reads its own ticket but not another one', async () => {
  const harness = await startHarness()
  try {
    const { token } = issueAssignmentToken({
      store: harness.store,
      stateDir: harness.stateDir,
      ticketId: 'ticket-own',
      assignmentId: 'assignment-1',
      expiresAt: '2026-11-08T03:26:00.000Z'
    })
    const own = await harness.call('/superagent/api/tickets/ticket-own', { token })
    assert.equal(own.status, 503, 'the handler is still a stub, so authorization passed')

    const other = await harness.call('/superagent/api/tickets/ticket-other', { token })
    assert.equal(other.status, 403)
    assert.equal(failureOf(other).code, 'not_permitted_role')

    // 读列表/状态是 worker 自检需要的（§G.5 的 `status --json`）。
    assert.equal((await harness.call('/superagent/api/state', { token })).status, 200)
    assert.equal((await harness.call('/superagent/api/tickets', { token })).status, 403)
    assert.equal((await harness.call('/superagent/api/overview', { token })).status, 403)
    assert.equal((await harness.call('/superagent/api/settings', { token })).status, 403)

    // 写路由对 assignment 一律拒绝（worker 的能力集里没有它们）。
    const write = await harness.call('/superagent/api/tickets/ticket-own/stop', {
      method: 'POST',
      token,
      body: {}
    })
    assert.equal(write.status, 403)
    assert.equal(failureOf(write).code, 'not_permitted_role')
  } finally {
    harness.close()
  }
})

test('a router token may save ordinary settings but not a setup field', async () => {
  const harness = await startHarness()
  try {
    const { token } = issueRouterToken({ store: harness.store, stateDir: harness.stateDir })

    const ordinary = await harness.call('/superagent/api/settings/executor', {
      method: 'PUT',
      token,
      body: { value: { maxWorkers: 3 }, revision: 1 }
    })
    assert.equal(ordinary.status, 503, 'authorization passed; the handler is a stub')

    // §K.8 / §G.2：非 operator 改 setup 字段 → origin_forbidden。
    for (const value of [{ baseRepo: 'acme/widgets' }, { stateDir: '/tmp/x' }, { cli: '/usr/bin/gh' }]) {
      const refused = await harness.call('/superagent/api/settings/executor', {
        method: 'PUT',
        token,
        body: { value, revision: 1 }
      })
      assert.equal(refused.status, 403, JSON.stringify(value))
      assert.equal(failureOf(refused).code, 'origin_forbidden')
    }

    // operator 改同样的字段可以（后续由 settings.save 做真正的校验）。
    const operator = await harness.call('/superagent/api/settings/executor', {
      method: 'PUT',
      body: { value: { baseRepo: 'acme/widgets' }, revision: 1 }
    })
    assert.equal(operator.status, 503)

    // Router 不能做的运维动作（§F.6 的 Router 命令清单之外）。
    for (const [method, path] of [
      ['POST', '/superagent/api/executor/pause'],
      ['POST', '/superagent/api/setup/check'],
      ['POST', '/superagent/api/doctor']
    ] as const) {
      const refused = await harness.call(path, { method, token, body: {} })
      assert.equal(refused.status, 403, `${method} ${path}`)
      assert.equal(failureOf(refused).code, 'not_permitted_role')
    }

    // §F.6 把 `ticket retry/stop/note/request-status` 列为 Router 的命令，所以它们对
    // router 是允许的（落到 stub 的 503）；角色拒绝面由表驱动的测试覆盖。
    const retry = await harness.call('/superagent/api/tickets/ticket-1/retry', {
      method: 'POST',
      token,
      body: {}
    })
    assert.equal(retry.status, 503)
  } finally {
    harness.close()
  }
})

test('every route refuses a role below its minimum with not_permitted_role', async () => {
  // 表驱动（§O 角色行）：每条 minimumRole 高于 assignment 的路由，都要拒绝 assignment token；
  // 每条 minimumRole 是 operator 的路由，还要拒绝 router token。
  const harness = await startHarness()
  try {
    const { token: assignmentToken } = issueAssignmentToken({
      store: harness.store,
      stateDir: harness.stateDir,
      ticketId: 'ticket-own',
      assignmentId: 'assignment-1',
      expiresAt: '2026-11-08T03:26:00.000Z'
    })
    const { token: routerToken } = issueRouterToken({ store: harness.store, stateDir: harness.stateDir })
    const pathOf = (route: RouteDefinition): string =>
      `/superagent/api/${route.path.replace(/:[a-z]+/g, 'x')}`

    let checked = 0
    for (const route of ROUTE_TABLE) {
      const tokens: string[] = []
      if (route.minimumRole !== 'assignment') tokens.push(assignmentToken)
      if (route.minimumRole === 'operator') tokens.push(routerToken)
      for (const token of tokens) {
        const response = await harness.call(pathOf(route), {
          method: route.method,
          token,
          body: route.method === 'GET' ? undefined : {}
        })
        assert.equal(response.status, 403, `${route.method} ${route.path}`)
        assert.equal(failureOf(response).code, 'not_permitted_role')
        checked += 1
      }
    }
    // 37 条路由：32 条高于 assignment（5 条是 assignment 档），13 条是 operator → 45 次拒绝。
    assert.equal(checked, 45, 'every route above assignment refuses it, and every operator route refuses router')
  } finally {
    harness.close()
  }
})

test('assignment tokens are hashed in the store, written 0600, and deleted when the assignment ends', async () => {
  const harness = await startHarness()
  try {
    const issued = issueAssignmentToken({
      store: harness.store,
      stateDir: harness.stateDir,
      ticketId: 'ticket-own',
      assignmentId: 'assignment-7',
      expiresAt: '2026-11-08T03:26:00.000Z'
    })
    const path = join(harness.stateDir, 'tokens', 'assignment-7')
    assert.equal(issued.path, path)
    assert.equal(statSync(path).mode & 0o777, 0o600, 'the token file is private')
    assert.equal(readFileSync(path, 'utf8'), issued.token)

    // 库内只存哈希 + 归属：任何 kv 值里都不出现 token 原文。
    const values = harness.store.sql
      .all('SELECT value FROM kv')
      .map((row) => String((row as Record<string, unknown>)['value']))
    assert.equal(values.some((value) => value.includes(issued.token)), false, 'no token at rest')
    const record = harness.store.sql
      .all('SELECT value FROM kv WHERE key LIKE ?', ['token-hash:%'])
      .map((row) => JSON.parse(String((row as Record<string, unknown>)['value'])) as Record<string, unknown>)
    assert.equal(record.length, 1)
    assert.deepEqual(record[0], {
      role: 'assignment',
      ticketId: 'ticket-own',
      assignmentId: 'assignment-7',
      expiresAt: '2026-11-08T03:26:00.000Z'
    })

    assert.equal((await harness.call('/superagent/api/state', { token: issued.token })).status, 200)

    // Assignment 结束：文件删除、token 立即失效（§D.6、§O）。
    assert.equal(
      revokeAssignmentToken({ store: harness.store, stateDir: harness.stateDir, assignmentId: 'assignment-7' }),
      true
    )
    assert.equal(existsSync(path), false, 'the token file is gone')
    const after = await harness.call('/superagent/api/state', { token: issued.token })
    assert.equal(after.status, 401)
  } finally {
    harness.close()
  }
})

test('an expired assignment token is refused', async () => {
  const harness = await startHarness({ clock: () => new Date('2026-11-09T00:00:00.000Z') })
  try {
    const { token } = issueAssignmentToken({
      store: harness.store,
      stateDir: harness.stateDir,
      ticketId: 'ticket-own',
      assignmentId: 'assignment-8',
      expiresAt: '2026-11-08T03:26:00.000Z'
    })
    const response = await harness.call('/superagent/api/state', { token })
    assert.equal(response.status, 401)
  } finally {
    harness.close()
  }
})

test('the router token rotates on every issue, and only its hash is stored', async () => {
  const harness = await startHarness()
  try {
    const first = issueRouterToken({ store: harness.store, stateDir: harness.stateDir })
    assert.equal(statSync(first.path).mode & 0o777, 0o600)
    assert.equal((await harness.call('/superagent/api/state', { token: first.token })).status, 200)

    // Router 重启：签发新 token（§D.6「Router token 随 Router 重启轮换」）。
    const second = issueRouterToken({ store: harness.store, stateDir: harness.stateDir })
    assert.notEqual(second.token, first.token)
    assert.equal((await harness.call('/superagent/api/state', { token: first.token })).status, 401)
    assert.equal((await harness.call('/superagent/api/state', { token: second.token })).status, 200)

    const stored = harness.store.sql
      .all('SELECT value FROM kv')
      .map((row) => String((row as Record<string, unknown>)['value']))
    assert.equal(stored.some((value) => value.includes(second.token)), false, 'only the hash is stored')
  } finally {
    harness.close()
  }
})

test('the api token file is created once, 0600, and stays readable', () => {
  const stateDir = tempStateDir()
  const first = ensureApiToken(stateDir)
  assert.equal(first.created, true)
  assert.equal(statSync(join(stateDir, 'api-token')).mode & 0o777, 0o600)
  // 32 字节 base64url = 43 个字符。
  assert.equal(first.token.length, 43)
  assert.equal(/^[A-Za-z0-9_-]+$/.test(first.token), true, 'base64url alphabet only')
  assert.equal(readApiToken(stateDir), first.token)

  const again = ensureApiToken(stateDir)
  assert.equal(again.created, false)
  assert.equal(again.token, first.token, 'an existing token is reused, not replaced')
})

// ---------------------------------------------------------------- 端口选择（§N.1）

/** 占住一个端口；返回关闭函数。 */
function occupy(port: number): Promise<() => void> {
  const server = createServer((_request, response) => response.end('blocked'))
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => {
      resolve(() => {
        server.closeAllConnections()
        server.close()
      })
    })
  })
}

/** 找一个空闲端口 p，且 p+1 也空闲（用于断言「+1」规则）。 */
async function twoFreePorts(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const probe = createServer(() => undefined)
    const base = await new Promise<number>((resolve, reject) => {
      probe.on('error', reject)
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address()
        resolve(typeof address === 'object' && address !== null ? address.port : 0)
      })
    })
    probe.closeAllConnections()
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    try {
      const release = await occupy(base + 1)
      release()
      if (base < 65_535 - PORT_ATTEMPTS - 1) return base
    } catch {
      // base+1 被占：换一个 base。
    }
  }
  throw new Error('could not find two free ports')
}

/** 在 `[base, base+PORT_ATTEMPTS]` 内找一个**可用**的端口：用完即放，下一轮不再撞车。 */
async function pickPreferredPort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const probe = createServer(() => undefined)
    const candidate = await new Promise<number>((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address()
        resolve(typeof address === 'object' && address !== null ? address.port : 0)
      })
    })
    probe.closeAllConnections()
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    if (candidate > 1024 && candidate < 65_535 - PORT_ATTEMPTS - 1) return candidate
  }
  throw new Error('could not find a usable port')
}

test('the actual port is written to the state directory, and close removes it', async () => {
  const harness = await startHarness()
  try {
    const record = readPortRecord(harness.stateDir)
    assert.deepEqual(record, {
      port: harness.server.port,
      pid: process.pid,
      startedAt: STARTED_AT
    })
    assert.equal(statSync(join(harness.stateDir, PORT_FILE)).mode & 0o777, 0o600)
  } finally {
    harness.close()
  }
  const stateDirPath = harness.stateDir
  assert.equal(existsSync(join(stateDirPath, PORT_FILE)), false, 'a clean shutdown removes the port file')
})

test('an occupied port makes the server try the next one and record the port it got', async () => {
  // base 与 base+1 都空闲才断言「+1」：pickPreferredPort 只保证 base，另一个并发测试文件
  // 的系统分配端口可能正好拿走 base+1（这个 helper 本来就是为这条断言准备的）。
  const base = await twoFreePorts()
  const release = await occupy(base)
  const harness = await startHarness({ preferredPort: base })
  try {
    assert.equal(harness.server.port, base + 1)
    assert.equal(readPortRecord(harness.stateDir)?.port, base + 1)
    assert.equal((await harness.call('/superagent/api/state')).status, 200)
  } finally {
    harness.close()
    release()
  }
})

test('twenty occupied increments fall back to an ephemeral port', async () => {
  const base = await pickPreferredPort()
  const blockers: (() => void)[] = []
  try {
    // 逐个占住；万一某个端口刚被系统分出去，换一个起点重来（端口竞争不可避免）。
    for (let offset = 0; offset <= PORT_ATTEMPTS; offset += 1) blockers.push(await occupy(base + offset))
    const harness = await startHarness({ preferredPort: base })
    try {
      assert.ok(
        harness.server.port < base || harness.server.port > base + PORT_ATTEMPTS,
        `port ${harness.server.port} is outside the scanned range`
      )
      assert.equal(readPortRecord(harness.stateDir)?.port, harness.server.port)
      assert.equal((await harness.call('/superagent/api/state')).status, 200)
    } finally {
      harness.close()
    }
  } finally {
    for (const release of blockers) release()
  }
})

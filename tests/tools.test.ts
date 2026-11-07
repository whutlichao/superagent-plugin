// CLI 命令的入参/出参/错误码（§P.2 的 `tools.test.ts` 行：等价上游工具 schema 面）。
//
// 本票只覆盖 HTTP 这一层能测的部分：**请求幂等**（§G.1 幂等行：同 id 一小时内重试返回首次
// 结果）。命令本身的成功/固定拒绝面由 #8 的 `cli-contract.test.ts` 接管。
import { assert, test } from 'orca/testing'
import { chmodSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openStore } from '../src/worker/app/store'
import {
  IDEMPOTENCY_WINDOW_MS,
  requestIdOf,
  runIdempotent,
  type IdempotentOutcome
} from '../src/worker/http/idempotency'
import { ApiError, ERROR_CODES } from '../src/worker/http/errors'
import { REQUEST_ID_PREFIX } from '../src/worker/app/kv'
import {
  defaultStateDir,
  readStateDirPointer,
  removeStateDirPointer,
  resolveStateDir,
  writeStateDirPointer,
  STATE_DIR_ENV,
  STATE_DIR_NAME,
  STATE_DIR_POINTER
} from '../src/worker/infra/paths'
import {
  DEFAULT_PORT,
  PORT_FILE,
  TOKEN_ENV,
  encodePathSegment,
  resolvePort,
  resolveTarget,
  resolveToken
} from '../src/worker/cli/target'
import { RETRY_DELAY_MS, parseResponse, requestJson } from '../src/worker/cli/transport'
import { dispatch, ticketListQuery } from '../src/worker/cli/commands'
import type { CliTarget } from '../src/worker/cli/target'
import {
  envelopeForError,
  failureEnvelope,
  parseArgs,
  render,
  REPEATABLE_FLAGS,
  successEnvelope
} from '../src/worker/cli/io'
import { API_TOKEN_FILE, TOKENS_DIR, ROUTER_TOKEN_FILE } from '../src/worker/infra/tokens'
import { tempStateDir } from './support/state'
import { closedPort } from './support/ports'
import { startTestServer } from './support/cli-server'

/** 一个固定的测试时刻。 */
const AT = '2026-11-07T03:26:00.000Z'

/** 相对 `AT` 偏移若干毫秒的时刻。 */
const after = (ms: number): string => new Date(new Date(AT).getTime() + ms).toISOString()

/** 在临时状态目录上开库并跑一个幂等用例。 */
function withStore<T>(work: (store: ReturnType<typeof openStore>) => T): T {
  const stateDir = tempStateDir()
  const store = openStore({ stateDir })
  try {
    return work(store)
  } finally {
    store.close()
  }
}

test('the idempotency window is one hour and the header is the documented one', () => {
  assert.equal(IDEMPOTENCY_WINDOW_MS, 60 * 60 * 1000)
  assert.equal(requestIdOf({ 'x-superagent-request-id': 'r-1' }), 'r-1')
  assert.equal(requestIdOf({}), null)
  assert.equal(requestIdOf({ 'x-superagent-request-id': '' }), null, 'an empty header means no id')
})

test('the same request id within an hour returns the first result without running again', () => {
  withStore((store) => {
    let runs = 0
    const first = runIdempotent({
      store,
      caller: 'operator-token-hash',
      requestId: 'r-1',
      at: AT,
      run: () => {
        runs += 1
        return { retried: true, n: runs }
      }
    })
    assert.deepEqual(first.outcome, { kind: 'ran', result: { retried: true, n: 1 } })
    assert.equal(runs, 1)

    // 同 id + 同请求体（这里没有体）在一小时内 → 首次结果，不重跑。
    const replay = runIdempotent({
      store,
      caller: 'operator-token-hash',
      requestId: 'r-1',
      at: after(59 * 60 * 1000),
      run: () => {
        runs += 1
        return { retried: true, n: runs }
      }
    })
    assert.deepEqual(replay.outcome, { kind: 'replayed', result: { retried: true, n: 1 } })
    assert.equal(runs, 1, 'the work ran exactly once')

    // 超过一小时 → 重新执行（并覆盖记录）。
    const expired = runIdempotent({
      store,
      caller: 'operator-token-hash',
      requestId: 'r-1',
      at: after(61 * 60 * 1000),
      run: () => {
        runs += 1
        return { retried: true, n: runs }
      }
    })
    assert.deepEqual(expired.outcome, { kind: 'ran', result: { retried: true, n: 2 } })
    assert.equal(runs, 2)
  })
})

test('a different token or a different request id is a different operation', () => {
  withStore((store) => {
    const run = (caller: string, requestId: string, value: number): IdempotentOutcome => {
      let calls = 0
      const outcome = runIdempotent({
        store,
        caller,
        requestId,
        at: AT,
        run: () => {
          calls += 1
          return value
        }
      })
      assert.equal(calls, 1, 'each distinct operation runs')
      return outcome.outcome
    }
    assert.deepEqual(run('token-a', 'r-1', 1), { kind: 'ran', result: 1 })
    // 同一 id、另一个 token：独立记录（幂等键含 token 的哈希，而不是全局）。
    assert.deepEqual(run('token-b', 'r-1', 2), { kind: 'ran', result: 2 })
    // 同一 token、另一个 id：独立记录。
    assert.deepEqual(run('token-a', 'r-2', 3), { kind: 'ran', result: 3 })
    // 原组合仍然命中首次结果。
    let reran = false
    const replay = runIdempotent({
      store,
      caller: 'token-a',
      requestId: 'r-1',
      at: AT,
      run: () => {
        reran = true
        return 99
      }
    })
    assert.deepEqual(replay.outcome, { kind: 'replayed', result: 1 })
    assert.equal(reran, false)
  })
})

test('a failed run is not remembered, so a retry may succeed', () => {
  withStore((store) => {
    assert.throws(() =>
      runIdempotent({
        store,
        caller: 'operator-token-hash',
        requestId: 'r-1',
        at: AT,
        run: () => {
          throw new ApiError(ERROR_CODES.refused, 'no')
        }
      })
    )
    // 同一 id 再试：真的又跑了一次（失败不缓存）。
    let runs = 0
    const outcome = runIdempotent({
      store,
      caller: 'operator-token-hash',
      requestId: 'r-1',
      at: AT,
      run: () => {
        runs += 1
        return 'ok'
      }
    })
    assert.deepEqual(outcome.outcome, { kind: 'ran', result: 'ok' })
    assert.equal(runs, 1)
  })
})

test('without a request id the work always runs', () => {
  withStore((store) => {
    let runs = 0
    for (let index = 0; index < 3; index += 1) {
      const outcome = runIdempotent({
        store,
        caller: 'operator-token-hash',
        requestId: null,
        at: AT,
        run: () => {
          runs += 1
          return runs
        }
      })
      assert.deepEqual(outcome.outcome, { kind: 'ran', result: runs })
    }
    assert.equal(runs, 3)
  })
})

test('expired records are pruned on the next write, so the kv does not grow forever', () => {
  withStore((store) => {
    for (let index = 0; index < 5; index += 1) {
      runIdempotent({
        store,
        caller: 'operator-token-hash',
        requestId: `old-${index}`,
        at: AT,
        run: () => index
      })
    }
    const before = store
      .sql.all('SELECT key FROM kv WHERE key LIKE ?', [`${REQUEST_ID_PREFIX}%`])
      .length
    assert.equal(before, 5)
    // 两小时后写一条新记录：旧的过期记录应被清掉。
    runIdempotent({
      store,
      caller: 'operator-token-hash',
      requestId: 'fresh',
      at: after(2 * 60 * 60 * 1000),
      run: () => 'fresh'
    })
    const keys = store.sql
      .all('SELECT key FROM kv ORDER BY key')
      .map((row) => String((row as Record<string, unknown>)['key']))
    assert.deepEqual(
      keys.filter((key) => key.startsWith(REQUEST_ID_PREFIX)),
      [keys.find((key) => key.endsWith(':fresh')) ?? 'missing'],
      'only the fresh record stays'
    )
  })
})

// ---------------------------------------------------------------- #8 的 CLI 工具面
//
// 状态目录 / 端口 / token 的三重解析、连不上时的一次重试、参数解析与信封（§G.1、§G.4）。
// 一次警告：输出与错误绝不回显 argv 与 token——本文件的断言逐条覆盖。

test('the default state directory is $HOME/.local/state/orca-superagent', () => {
  const home = tempStateDir()
  try {
    assert.equal(defaultStateDir({ home, env: {} }), join(home, '.local', 'state', STATE_DIR_NAME))
    assert.equal(STATE_DIR_NAME, 'orca-superagent')
    assert.equal(STATE_DIR_ENV, 'ORCA_SUPERAGENT_STATE_DIR')
    assert.equal(STATE_DIR_POINTER, 'state-dir-pointer')
    // `XDG_STATE_HOME` 只替换基目录；空值视同未设置（§D.5 的 `${XDG_STATE_HOME:-…}`）。
    const xdg = join(home, 'xdg')
    assert.equal(defaultStateDir({ home, env: { XDG_STATE_HOME: xdg } }), join(xdg, STATE_DIR_NAME))
    assert.equal(
      defaultStateDir({ home, env: { XDG_STATE_HOME: '' } }),
      join(home, '.local', 'state', STATE_DIR_NAME)
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the flag beats the environment variable, which beats the default', () => {
  const home = tempStateDir()
  try {
    const env = { [STATE_DIR_ENV]: '/tmp/from-env' }
    assert.deepEqual(resolveStateDir({ argument: '/tmp/from-flag', env, home }), {
      stateDir: '/tmp/from-flag',
      source: 'argument'
    })
    assert.deepEqual(resolveStateDir({ env, home }), { stateDir: '/tmp/from-env', source: 'environment' })
    assert.deepEqual(resolveStateDir({ env: {}, home }), {
      stateDir: defaultStateDir({ home, env: {} }),
      source: 'default'
    })
    // 空串与缺失等价：不会把空路径当成一个显式选择。
    assert.deepEqual(resolveStateDir({ argument: '', env: { [STATE_DIR_ENV]: '' }, home }), {
      stateDir: defaultStateDir({ home, env: {} }),
      source: 'default'
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a pointer in the default directory redirects the default to the configured stateDir', () => {
  const home = tempStateDir()
  try {
    const fallback = defaultStateDir({ home, env: {} })
    const configured = join(home, 'elsewhere', 'state')
    mkdirSync(fallback, { recursive: true })
    writeFileSync(join(fallback, STATE_DIR_POINTER), `${configured}\n`, 'utf8')

    assert.equal(readStateDirPointer(fallback), configured)
    assert.deepEqual(resolveStateDir({ env: {}, home }), { stateDir: configured, source: 'pointer' })

    // 显式参数与环境变量一律不读指针：一次误写不能让显式路径失效。
    assert.equal(resolveStateDir({ argument: '/tmp/explicit', env: {}, home }).stateDir, '/tmp/explicit')
    assert.equal(
      resolveStateDir({ env: { [STATE_DIR_ENV]: '/tmp/from-env' }, home }).stateDir,
      '/tmp/from-env'
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the worker writes the pointer, and what it writes is what the CLI reads', () => {
  const home = tempStateDir()
  try {
    const fallback = defaultStateDir({ home, env: {} })
    const configured = join(home, 'configured')
    // worker 侧：设置里的 stateDir 与默认不同 → 写指针（0600）。
    const path = writeStateDirPointer(fallback, configured)
    assert.equal(path, join(fallback, STATE_DIR_POINTER))
    assert.equal(statSync(path).mode & 0o777, 0o600, 'the pointer is private')
    // CLI 侧：默认路径上命中指针 → 改用配置目录。两侧读写同一处字面量。
    assert.deepEqual(resolveStateDir({ env: {}, home }), { stateDir: configured, source: 'pointer' })
    // 相对路径写不进去（写一个读不出来的值等于没写）。
    assert.throws(() => writeStateDirPointer(fallback, 'relative/state'))
    // 改回默认目录时删掉指针；再解析就回到默认。
    assert.equal(removeStateDirPointer(fallback), true)
    assert.equal(removeStateDirPointer(fallback), false, 'removing twice is harmless')
    assert.deepEqual(resolveStateDir({ env: {}, home }), { stateDir: fallback, source: 'default' })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a missing, empty, relative or unreadable pointer leaves the default in place', () => {
  const home = tempStateDir()
  try {
    const fallback = defaultStateDir({ home, env: {} })
    assert.equal(resolveStateDir({ env: {}, home }).stateDir, fallback, 'no pointer file')
    mkdirSync(fallback, { recursive: true })
    for (const content of ['', '   ', 'relative/path', '~/state']) {
      writeFileSync(join(fallback, STATE_DIR_POINTER), content, 'utf8')
      assert.equal(readStateDirPointer(fallback), null, JSON.stringify(content))
      assert.deepEqual(resolveStateDir({ env: {}, home }), { stateDir: fallback, source: 'default' })
    }
    // 指针本身是个目录（读不出文本）：同样退回默认。
    rmSync(join(fallback, STATE_DIR_POINTER), { force: true })
    mkdirSync(join(fallback, STATE_DIR_POINTER), { recursive: true })
    assert.equal(readStateDirPointer(fallback), null)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the port comes from <stateDir>/api-port, falling back to 3847', () => {
  const stateDir = tempStateDir()
  try {
    assert.equal(resolvePort(stateDir), DEFAULT_PORT)
    assert.equal(DEFAULT_PORT, 3847)
    writeFileSync(join(stateDir, PORT_FILE), '4123', 'utf8')
    assert.equal(resolvePort(stateDir), 4123)
    // 带 pid 的 JSON 形态（#7 的端口文件）同样可读。
    writeFileSync(join(stateDir, PORT_FILE), JSON.stringify({ port: 4321, pid: process.pid }), 'utf8')
    assert.equal(resolvePort(stateDir), 4321)
    // 坏内容、越界端口、已死进程一律退回默认端口（S6 的回落）。
    for (const content of ['nope', '70000', JSON.stringify({ port: 4444, pid: 999_999 })]) {
      writeFileSync(join(stateDir, PORT_FILE), content, 'utf8')
      assert.equal(resolvePort(stateDir), DEFAULT_PORT, content)
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

/** 在临时状态目录里写一个 token 文件（0600）。 */
function writeToken(path: string, value: string): string {
  writeFileSync(path, value, { encoding: 'utf8', mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

test('the token is --token, then $ORCA_SUPERAGENT_TOKEN_FILE, then <stateDir>/api-token', () => {
  const stateDir = tempStateDir()
  try {
    const apiToken = writeToken(join(stateDir, API_TOKEN_FILE), 'operator-token\n')
    const envToken = writeToken(join(stateDir, 'env-token'), 'router-token\n')
    const flagFile = writeToken(join(stateDir, 'flag-token'), 'flag-file-token')

    // `--token-file` 是公开形态（§G.5 的 prompt 只给文件路径）；`--token` 只用于调试。
    assert.deepEqual(resolveToken({ stateDir, file: flagFile, env: { [TOKEN_ENV]: envToken } }), {
      token: 'flag-file-token',
      source: 'argument',
      tokenFile: flagFile
    })
    assert.deepEqual(resolveToken({ stateDir, argument: 'flag-token', env: { [TOKEN_ENV]: envToken } }), {
      token: 'flag-token',
      source: 'argument',
      tokenFile: null
    })
    assert.deepEqual(resolveToken({ stateDir, env: { [TOKEN_ENV]: envToken } }), {
      token: 'router-token',
      source: 'environment',
      tokenFile: envToken
    })
    assert.deepEqual(resolveToken({ stateDir, env: {} }), {
      token: 'operator-token',
      source: 'default',
      tokenFile: apiToken
    })
    assert.equal(TOKEN_ENV, 'ORCA_SUPERAGENT_TOKEN_FILE')

    // 空值视同未给；环境变量指向不存在的文件时也退到默认 token。
    assert.equal(resolveToken({ stateDir, argument: '  ', env: { [TOKEN_ENV]: '' } }).token, 'operator-token')
    assert.equal(resolveToken({ stateDir, env: { [TOKEN_ENV]: join(stateDir, 'missing') } }).source, 'default')

    // 一个 token 也没有：`token` 为 null（由调用点报 not_ready，而不是编一个空字符串去鉴权）。
    rmSync(apiToken)
    assert.deepEqual(resolveToken({ stateDir, env: {} }), { token: null, source: 'default', tokenFile: null })

    // 轮换后无需重启：每次解析都现读文件。
    writeToken(apiToken, 'rotated')
    assert.equal(resolveToken({ stateDir, env: {} }).token, 'rotated')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('the target combines the three resolutions and never carries the token into the base url', () => {
  const home = tempStateDir()
  try {
    const stateDir = join(home, 'state')
    mkdirSync(join(stateDir, TOKENS_DIR), { recursive: true })
    const routerToken = writeToken(join(stateDir, TOKENS_DIR, ROUTER_TOKEN_FILE), 'router-secret')
    const apiToken = writeToken(join(stateDir, API_TOKEN_FILE), 'operator-secret')
    writeFileSync(join(stateDir, PORT_FILE), '3999', 'utf8')

    const target = resolveTarget({ env: { ORCA_SUPERAGENT_STATE_DIR: stateDir }, home })
    assert.equal(target.stateDir, stateDir)
    assert.equal(target.stateDirSource, 'environment')
    assert.equal(target.port, 3999)
    assert.equal(target.baseUrl, 'http://127.0.0.1:3999/superagent/api')
    assert.equal(target.baseUrl.includes('router-secret'), false, 'the token never enters the url')
    assert.equal(target.baseUrl.includes('operator-secret'), false)
    // 默认 token 文件是主 token；router token 另有文件（doctor 用路径判断）。
    assert.equal(target.tokenFile, apiToken)
    assert.equal(target.token, 'operator-secret')
    assert.equal(routerToken.endsWith(join(TOKENS_DIR, ROUTER_TOKEN_FILE)), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a path segment is percent-encoded once for thread keys with slashes and spaces', () => {
  assert.equal(encodePathSegment('a/b c'), 'a%2Fb%20c')
  assert.equal(encodePathSegment('gh:o/r#1'), 'gh%3Ao%2Fr%231')
})

test('an unreachable worker is retried exactly once, after the fixed 200 ms', async () => {
  // 一个真实但已经没人监听的端口：`not_ready` 必须来自一次真实连接失败，不是假成功。
  // 端口取自内核临时区间之外的窄带（#53），不会被别的测试或另一轮测试半途绑定。
  const port = await closedPort()
  const waits: number[] = []
  const result = await requestJson({
    target: {
      stateDir: '/tmp/unused',
      stateDirSource: 'argument',
      port,
      baseUrl: `http://127.0.0.1:${port}/superagent/api`,
      token: 'operator-token',
      tokenSource: 'argument',
      tokenFile: null
    },
    method: 'GET',
    path: 'state',
    sleep: async (milliseconds: number) => {
      waits.push(milliseconds)
    }
  })
  assert.equal(RETRY_DELAY_MS, 200)
  assert.deepEqual(waits, [200], 'exactly one retry, after 200 ms')
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.notReady, true, 'an unreachable worker is not_ready, never a fake success')
    assert.equal(result.error.code, 'not_ready')
    assert.ok(result.error.message.includes('superagent doctor'), 'the hint names the doctor command')
  }
})

test('a server that answers is used on the first attempt, without waiting', async () => {
  const server = await startTestServer()
  try {
    const waits: number[] = []
    const result = await requestJson({
      target: server.target(),
      method: 'GET',
      path: 'state',
      sleep: async (milliseconds: number) => {
        waits.push(milliseconds)
      }
    })
    assert.deepEqual(waits, [])
    assert.equal(result.ok, true)
    assert.equal(server.requests.length, 1)
  } finally {
    server.close()
  }
})

test('a response that is not an envelope maps to internal, not to a refusal', () => {
  assert.deepEqual(parseResponse(200, JSON.stringify({ ok: true, result: { a: 1 } })), {
    ok: true,
    status: 200,
    result: { a: 1 }
  })
  const noEnvelope = parseResponse(502, '<html>bad gateway</html>')
  assert.equal(noEnvelope.ok, false)
  if (!noEnvelope.ok) {
    assert.equal(noEnvelope.error.code, 'internal')
    assert.equal(noEnvelope.notReady, false)
  }
  // 信封里的 values 原样带回，且不含任何提示文本改写。
  const refused = parseResponse(
    400,
    JSON.stringify({ ok: false, error: { code: 'refused', message: 'no', values: { ticket: 't1' } } })
  )
  assert.equal(refused.ok, false)
  if (!refused.ok) {
    assert.deepEqual(refused.error, { code: 'refused', message: 'no', values: { ticket: 't1' } })
    assert.equal(refused.notReady, false)
  }
})

// ---------------------------------------------------------------- 参数解析与信封（§G.1 输出）

test('argv is split into words and flags without deciding the command', () => {
  const parsed = parseArgs([
    'ticket',
    'stop',
    't-1',
    '--reason',
    'done',
    '--request-id=r-1',
    '--json',
    '--token-file',
    '/tmp/token'
  ])
  // 命令名也是词：由命令表判定哪几个词是命令路径。
  assert.deepEqual(parsed.words, ['ticket', 'stop', 't-1'])
  assert.deepEqual(parsed.flags, {
    reason: 'done',
    'request-id': 'r-1',
    json: true,
    'token-file': '/tmp/token'
  })
  assert.equal(parsed.text, false, '--json is the default output; --text is opt-in')
})

test('--text is a bare switch and never eats the next word', () => {
  const parsed = parseArgs(['status', '--text'])
  assert.equal(parsed.text, true)
  assert.deepEqual(parsed.flags, { text: true })
  assert.deepEqual(parsed.words, ['status'])
  // 开关后面的词仍是词，不会被当成它的值。
  assert.deepEqual(parseArgs(['status', '--text', 'extra']).words, ['status', 'extra'])
})

test('everything after -- is a word, so a path that starts with dashes survives', () => {
  const parsed = parseArgs(['eval-read', 't-1', '--', '--weird-name'])
  assert.deepEqual(parsed.words, ['eval-read', 't-1', '--weird-name'])
  assert.deepEqual(parsed.flags, {})
  assert.equal(parseArgs(['eval-read', 't-1', '--path=--weird-name']).flags['path'], '--weird-name')
  // 值以 `--` 开头、又不是等号形式：拒绝，而不是悄悄吞掉下一个 flag。
  assert.throws(
    () => parseArgs(['eval-read', 't-1', '--path', '--weird-name']),
    (error: unknown) => error instanceof ApiError && error.code === 'invalid_params'
  )
})

test('a missing value for a flag is invalid_params, never a guessed default', () => {
  assert.throws(
    () => parseArgs(['pause', '--reason']),
    (error: unknown) =>
      error instanceof ApiError && error.code === 'invalid_params' && error.message.includes('--reason')
  )
})

test('an unknown flag is invalid_params and the message never echoes the whole argv', async () => {
  const argv = ['status', '--not-a-flag', 'super-secret-token-value']
  const result = await dispatch({
    parsed: parseArgs(argv),
    target: {
      stateDir: '/tmp/unused',
      stateDirSource: 'argument',
      port: 1,
      baseUrl: 'http://127.0.0.1:1/superagent/api',
      token: 'x',
      tokenSource: 'argument',
      tokenFile: null
    },
    sleep: async () => undefined
  })
  assert.equal(result.exit, 2, 'unknown flags are refused before the wire')
  assert.equal(result.envelope.ok, false)
  if (result.envelope.ok) return
  assert.equal(result.envelope.error.code, 'invalid_params')
  const text = JSON.stringify(result.envelope)
  assert.equal(text.includes('super-secret-token-value'), false, 'the value is not echoed')
  assert.equal(text.includes(argv.join(' ')), false, 'argv is never echoed')
})

test('--token is accepted for debugging, and the parser never puts it into messages', () => {
  const parsed = parseArgs(['status', '--token', 'debug-secret'])
  assert.equal(parsed.flags['token'], 'debug-secret')
  let caught: unknown = null
  try {
    parseArgs(['status', '--token'])
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof ApiError)
  if (caught instanceof ApiError) {
    assert.equal(caught.code, 'invalid_params')
    assert.equal(caught.message.includes('debug-secret'), false)
  }
  assert.equal(parseArgs(['status', '--token-file', '/tmp/api-token']).flags['token-file'], '/tmp/api-token')
})

test('a repeated flag is invalid_params instead of the last one silently winning', () => {
  assert.throws(
    () => parseArgs(['status', '--state-dir', '/a', '--state-dir', '/b']),
    (error: unknown) => error instanceof ApiError && error.code === 'invalid_params'
  )
})

test('--item is the one repeatable flag: each value is kept in order for route', () => {
  assert.deepEqual(REPEATABLE_FLAGS, ['item'])
  const parsed = parseArgs(['route', '--item', '{"kind":"ignore"}', '--item={"kind":"stop"}'])
  assert.deepEqual(parsed.repeated['item'], ['{"kind":"ignore"}', '{"kind":"stop"}'])
  // 单次也给在 `repeated` 里：命令只有一处读法。
  assert.deepEqual(parseArgs(['route', '--item={}']).repeated['item'], ['{}'])
  // 其余 flag 照旧不可重复。
  assert.throws(
    () => parseArgs(['status', '--decisions', 'a', '--decisions', 'b']),
    (error: unknown) => error instanceof ApiError && error.code === 'invalid_params'
  )
})

test('the envelopes and exit codes are the §G.1 ones', () => {
  assert.deepEqual(successEnvelope({ a: 1 }), { ok: true, result: { a: 1 } })
  assert.deepEqual(failureEnvelope({ code: 'refused', message: 'no' }), {
    ok: false,
    error: { code: 'refused', message: 'no' }
  })
  // `ApiError` → 固定码；其余 → internal（不回显原文）。
  const refused = envelopeForError(new ApiError(ERROR_CODES.refused, 'no'))
  assert.equal(refused.exit, 2)
  const internal = envelopeForError(new Error('postgres://secret'))
  assert.equal(internal.exit, 1)
  assert.equal(JSON.stringify(internal.envelope).includes('secret'), false)
  // 渲染：JSON 是信封，`--text` 是人读文本但错误仍带 code。
  assert.equal(render(successEnvelope({ a: 1 }), { text: false }), JSON.stringify({ ok: true, result: { a: 1 } }, null, 2))
  assert.equal(render(failureEnvelope({ code: 'missing', message: 'gone' }), { text: true }), 'error: missing: gone')
  assert.equal(render(successEnvelope('hi'), { text: true }), 'hi')
  assert.equal(render(successEnvelope([1, 2]), { text: true }), '- 1\n- 2')
})

// ---------------------------------------------------------------- 命令面收尾（#56）

/**
 * 一台**只记录**的 loopback 服务器：返回固定的成功信封，把收到的 method/path/body/请求头记下来。
 * 这是「CLI 只做传输」的直接断言面——命令的语义由 worker 的 handler 决定（§G「同一份 handler」），
 * 客户端只该把参数放对位置、方法放对、幂等键放对。
 */
async function recordingServer(): Promise<{
  readonly target: CliTarget
  readonly calls: { method: string; path: string; body: unknown; requestId: string | null }[]
  close(): Promise<void>
}> {
  const { createServer } = await import('node:http')
  const calls: { method: string; path: string; body: unknown; requestId: string | null }[] = []
  const server = createServer((request, response) => {
    const chunks: string[] = []
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => chunks.push(chunk))
    request.on('end', () => {
      const text = chunks.join('')
      calls.push({
        method: request.method ?? 'GET',
        path: request.url ?? '/',
        body: text.length === 0 ? undefined : (JSON.parse(text) as unknown),
        requestId: (request.headers['x-superagent-request-id'] as string | undefined) ?? null
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, result: {} }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    target: {
      stateDir: '/tmp/unused',
      stateDirSource: 'argument',
      port,
      baseUrl: `http://127.0.0.1:${port}/superagent/api`,
      token: 'operator-token',
      tokenSource: 'argument',
      tokenFile: null
    },
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

test('ticket list carries --state and the documented page numbers to the read model', async () => {
  const server = await recordingServer()
  try {
    const run = async (argv: readonly string[], stdin?: string) =>
      dispatch({
        parsed: parseArgs(argv),
        target: server.target,
        sleep: async () => undefined,
        ...(stdin === undefined ? {} : { stdin: async () => stdin })
      })
    const listed = await run(['ticket', 'list', '--state', 'idle', '--limit', '3'])
    assert.equal(listed.exit, 0, JSON.stringify(listed.envelope))
    const [call] = server.calls
    assert.equal(call?.method, 'GET')
    const [pathname, search] = (call?.path ?? '/').split('?')
    assert.equal(pathname, '/superagent/api/tickets')
    // 查询串按 `&` 拆开（没有 URL 全局类型：tsconfig 不引入 DOM）。
    assert.deepEqual(
      Object.fromEntries((search ?? '').split('&').map((pair) => pair.split('='))),
      { limit: '3', state: 'idle' }
    )
    // `ticketListQuery` 是那个读法的单一实现（默认 20，与 `read tickets` 同）。
    assert.deepEqual(ticketListQuery({ positionals: [], flags: {}, repeated: {}, text: false }), { limit: 20 })
  } finally {
    await server.close()
  }
})

test('each closeout command puts its arguments where §G.3 says, and writes carry the request id', async () => {
  const server = await recordingServer()
  try {
    const run = async (argv: readonly string[], stdin?: string) =>
      dispatch({
        parsed: parseArgs(argv),
        target: server.target,
        sleep: async () => undefined,
        ...(stdin === undefined ? {} : { stdin: async () => stdin })
      })

    // 两条 thread 命令：键作为一段路径（含 `:`、`/`、`#`、空格），reason 进 body。
    await run(['thread', 'follow', 'gh:o/r #1', '--reason=Related', '--request-id=r-9'])
    assert.deepEqual(server.calls.at(-1), {
      method: 'POST',
      path: '/superagent/api/threads/gh%3Ao%2Fr%20%231/follow',
      body: { reason: 'Related' },
      requestId: 'r-9'
    })
    await run(['thread', 'unrelated', 'gh:o/r #1', '--reason=Not this'])
    assert.deepEqual(server.calls.at(-1)?.body, { reason: 'Not this' })
    await run(['thread', 'unsubscribe', 'gh:o/r #1'])
    assert.equal(server.calls.at(-1)?.path, '/superagent/api/threads/gh%3Ao%2Fr%20%231/unsubscribe')

    // trigger requeue 与 policy sync：路径参数、空 body。
    await run(['trigger', 'requeue', 't-1'])
    assert.deepEqual(server.calls.at(-1), {
      method: 'POST',
      path: '/superagent/api/triggers/t-1/requeue',
      body: {},
      requestId: null
    })
    await run(['policy', 'sync', 'feishu'])
    assert.equal(server.calls.at(-1)?.path, '/superagent/api/policy-sync/feishu')

    // settings get：一个块进查询串；`--history` 走 history 路由。
    await run(['settings', 'get', '--block', 'policy'])
    assert.equal(server.calls.at(-1)?.path, '/superagent/api/settings?block=policy')
    await run(['settings', 'get', '--history'])
    assert.equal(server.calls.at(-1)?.path, '/superagent/api/policy/history')

    // settings save：`--value` 从 stdin 读 JSON，块名作为一段路径，来源恒为 tool（§K.8）。
    await run(
      ['settings', 'save', '--block', 'source:github', '--value', '-', '--revision', '4'],
      '{"enabled":true,"config":{"repository":"acme/widgets"}}'
    )
    assert.deepEqual(server.calls.at(-1), {
      method: 'PUT',
      path: '/superagent/api/settings/source%3Agithub',
      body: {
        value: { enabled: true, config: { repository: 'acme/widgets' } },
        revision: 4,
        origin: 'tool'
      },
      requestId: null
    })
  } finally {
    await server.close()
  }
})

test('settings save refuses a bad revision or a missing value before the wire', async () => {
  // 参数形状先在客户端判（退出 2、零请求），服务端仍会再判一次（§K.8）。
  const target = {
    stateDir: '/tmp/unused',
    stateDirSource: 'argument' as const,
    port: 1,
    baseUrl: 'http://127.0.0.1:1/superagent/api',
    token: 'operator-token',
    tokenSource: 'argument' as const,
    tokenFile: null
  }
  for (const argv of [
    ['settings', 'save', '--block', 'eval', '--value=-', '--revision', 'nope'],
    ['settings', 'save', '--block', 'eval', '--revision', '1']
  ]) {
    const result = await dispatch({
      parsed: parseArgs(argv),
      target,
      sleep: async () => undefined,
      stdin: async () => '{}'
    })
    assert.ok(result.exit === 2, `${argv.join(' ')} exits 2`)
    assert.equal(result.envelope.ok, false)
    if (!result.envelope.ok) {
      assert.ok(['invalid_value', 'invalid_params'].includes(result.envelope.error.code))
    }
  }
})

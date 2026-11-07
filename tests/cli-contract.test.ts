// CLI 契约（§P.2 的 `cli-contract.test.ts` 行）：**表驱动**，每条命令至少一条成功与一条固定
// 拒绝，断言 `error.code` 而不是文案。
//
// 命令分两类，成功面的含义不同（票面「Router/Worker 命令先占住最终名字与参数，返回固定
// `unavailable` 直到拥有它的票接上实现」）：
// - **已接线**：成功用例打到真 loopback 服务器并断言 `result` 的形状；拒绝用例断言固定码；
// - **未落地**：成功面就是那条固定的 `unavailable`（退出 3），并断言**没有发出**任何 HTTP
//   请求——「这台构建还没有它」与「worker 不在」因此不会混淆；等拥有它的票接上后，这张表
//   的该行换成真成功用例（那时 `available` 变 true）。
//
// 每条命令都必须出现在表里（下面有断言），于是新增命令不会漏测；断言一律按 `error.code`。
import { assert, test } from 'orca/testing'
import { rmSync } from 'node:fs'
import { CLI_COMMANDS, commandFor } from '../src/worker/cli/commands'
import { ApiError } from '../src/worker/http/errors'
import { dispatch } from '../src/worker/cli/commands'
import { parseArgs } from '../src/worker/cli/io'
import { main } from '../src/worker/cli/main'
import { createDomainHandlers, withDomainHandlers } from '../src/worker/http/domain'
import { ROUTE_TABLE } from '../src/worker/http/routes'
import { AT, tempStateDir } from './support/state'
import { startTestServer, type TestServer } from './support/cli-server'
import type { Ticket } from '../src/worker/core/index'

/** 一条契约用例。`ok` 为真时断言成功，否则断言 `error.code` 与退出码。 */
interface Case {
  readonly argv: readonly string[]
  /** 期望的退出码（§G.1：0/1/2/3）。 */
  readonly exit: number
  /** 期望成功的 `result` 顶层字段（只列出必须有的）。 */
  readonly resultKeys?: readonly string[]
  /** 期望的固定错误码。 */
  readonly code?: string
  /** 用什么 token（缺省 operator）。`null` 表示一个都没有。 */
  readonly token?: 'operator' | 'router' | 'assignment' | null
  /** 这条用例不该发出 HTTP 请求（未落地命令的固定拒绝）。 */
  readonly offline?: boolean
}

/** 已接线命令的成功 + 固定拒绝。 */
const WIRED: readonly (readonly [string, Case, Case])[] = [
  [
    'status',
    { argv: ['status'], exit: 0, resultKeys: ['process', 'store', 'http', 'health', 'setup', 'paused', 'load'] },
    { argv: ['status', '--bogus', 'x'], exit: 2, code: 'invalid_params' }
  ],
  [
    'health',
    { argv: ['health'], exit: 0, resultKeys: ['health'] },
    { argv: ['health', '--offset', 'x'], exit: 2, code: 'invalid_params' }
  ],
  [
    'pause',
    { argv: ['pause'], exit: 0, resultKeys: ['paused', 'at', 'changed'] },
    // router token 不够 operator 档（§G.1 角色行）。
    { argv: ['pause'], exit: 2, code: 'not_permitted_role', token: 'router' }
  ],
  [
    'resume',
    { argv: ['resume'], exit: 0, resultKeys: ['paused', 'changed'] },
    { argv: ['resume'], exit: 2, code: 'not_permitted_role', token: 'router' }
  ],
  [
    'setup check',
    // 没有组合根的测试服务器不给 setup 端口：形状固定为 unavailable，绝不冒充「检查过了」。
    // 真的重跑（含「已无问题时 refused」）由 `deployment.test.ts` 在真组合根上断言。
    { argv: ['setup', 'check'], exit: 3, code: 'unavailable' },
    { argv: ['setup', 'check'], exit: 2, code: 'not_permitted_role', token: 'router' }
  ],
  [
    'source labels',
    { argv: ['source', 'labels', 'github'], exit: 3, code: 'unavailable' },
    { argv: ['source', 'labels'], exit: 2, code: 'invalid_params' }
  ],
  [
    'admin backup',
    { argv: ['admin', 'backup'], exit: 0, resultKeys: ['path', 'at', 'bytes', 'kept'] },
    { argv: ['admin', 'backup'], exit: 2, code: 'not_permitted_role', token: 'router' }
  ],
  [
    'admin rotate-token',
    { argv: ['admin', 'rotate-token', '--yes'], exit: 0, resultKeys: ['tokenFile', 'rotated'] },
    // 破坏性动作没有 `--yes`：固定拒绝（§O），且什么都不改。
    { argv: ['admin', 'rotate-token'], exit: 2, code: 'refused' }
  ],
  [
    'doctor',
    { argv: ['doctor'], exit: 0, resultKeys: ['checks', 'summary', 'stateDir', 'at'] },
    { argv: ['doctor'], exit: 2, code: 'not_permitted_role', token: 'router' }
  ],
  [
    'read',
    { argv: ['read', 'overview'], exit: 3, code: 'unavailable' },
    { argv: ['read', 'nope'], exit: 2, code: 'missing' }
  ],
  // 本票接线的 Worker 三条（§G.2 的 report / reply / ack）：打到真的领域 handler。
  [
    'reply',
    {
      argv: ['reply', '--purpose', 'attention', '--text', 'Need a decision', '--human-action', 'Which branch?'],
      exit: 0,
      resultKeys: ['id', 'status', 'reused']
    },
    { argv: ['reply', '--purpose', 'answer', '--text', 'yes'], exit: 2, code: 'invalid_params' }
  ],
  [
    'ack',
    {
      argv: ['ack', '--trigger', 'trigger-1', '--text', 'On it'],
      exit: 0,
      resultKeys: ['id', 'status', 'reused'],
      token: 'assignment'
    },
    // 没有 assignment token 的调用者不能替某个 Ticket 确认（§O）。
    { argv: ['ack', '--trigger', 'trigger-1', '--text', 'On it'], exit: 2, code: 'not_permitted_role' }
  ],
  [
    'report',
    {
      argv: ['report', '--state', 'ready', '--summary', 'The redirect is fixed.'],
      exit: 0,
      resultKeys: ['ticket', 'assignment'],
      token: 'assignment'
    },
    // report 只属于 assignment：Ticket 来自它的 token，不是参数（§G.2）。
    {
      argv: ['report', '--state', 'ready', '--summary', 'The redirect is fixed.'],
      exit: 2,
      code: 'not_permitted_role'
    }
  ]
]

/** 未落地命令：唯一的用例就是那条固定的 `unavailable`（离线，退出 3）。 */
const PENDING: readonly string[][] = [
  ['route'],
  ['eval', 't-1'],
  ['eval-read', 't-1'],
  ['eval-decide', 't-1'],
  ['ticket', 'retry', 't-1'],
  ['ticket', 'stop', 't-1'],
  ['ticket', 'note', 't-1', '--text=a note'],
  ['ticket', 'request-status', 't-1'],
  ['ticket', 'list'],
  ['trigger', 'requeue', 't-1'],
  ['trigger', 'handback', 't-1'],
  ['thread', 'unsubscribe', 'k'],
  ['thread', 'follow', 'k'],
  ['thread', 'unrelated', 'k'],
  ['settings', 'get'],
  ['settings', 'save', '--block', 'executor', '--value={}', '--revision', '1'],
  ['policy', 'sync', 'github'],
  ['prompts', 'get'],
  ['prompts', 'save']
]

/** 一个能通过领域 handler 形状检查的最小 Ticket（handler 只读它来组 view）。 */
function ticketForCommands(): Ticket {
  return {
    id: 'ticket-own',
    title: 'Fix the login redirect',
    decisionId: 'decision-1',
    mandate: {
      strength: 'explicit',
      policyVersion: 'v1',
      basis: { via: 'addressed', addressed: 'mention' },
      actor: { source: 'github', id: 'alice' },
      scope: 'ticket'
    },
    channels: [],
    assignments: [{ id: 'assignment-1', state: 'running', createdAt: AT, startedAt: AT }],
    inputs: [],
    undelivered: [],
    createdAt: AT,
    updatedAt: AT,
    origin: { triggerId: 'trigger-1', triggerIds: ['trigger-1'] }
  }
}

/** 真领域 handler 的接线：report/reply/ack 的写入口换成记录用的替身（它们各自有专门测试）。 */
function commandRoutes(): ReturnType<typeof withDomainHandlers> {
  const ticket = ticketForCommands()
  return withDomainHandlers(
    ROUTE_TABLE,
    createDomainHandlers({
      report: () => ticket,
      reply: () => ({ id: 'reply-1', status: 'pending', reused: false }),
      ticketOf: (id) => (id === ticket.id ? ticket : undefined),
      tickets: () => [ticket]
    })
  )
}

/** 跑一次用例：真服务器、真 token、真 HTTP；`offline` 的用例断言零请求。 */
async function runCase(server: TestServer, entry: Case): Promise<{ readonly exit: number; readonly envelope: unknown }> {
  const before = server.requests.length
  const token =
    entry.token === null
      ? null
      : entry.token === 'router'
        ? server.routerToken()
        : entry.token === 'assignment'
          ? server.assignmentToken('ticket-own', 'assignment-1')
          : server.readOperatorToken()
  const result = await dispatch({
    parsed: parseArgs(entry.argv),
    target: server.target(token),
    sleep: async () => undefined
  })
  if (entry.offline === true) {
    assert.equal(server.requests.length, before, `${entry.argv.join(' ')} refuses before the wire`)
  }
  return { exit: result.exit, envelope: result.envelope }
}

/** 断言失败信封的固定码与退出码。 */
function assertFailure(envelope: unknown, code: string): void {
  assert.equal(typeof envelope, 'object')
  const failure = envelope as { readonly ok?: unknown; readonly error?: { readonly code?: unknown } }
  assert.equal(failure.ok, false, 'a refusal envelope')
  assert.equal(failure.error?.code, code, 'the fixed error code')
}

test('the contract table covers every command in the dispatch table', () => {
  const covered = new Set<string>([
    ...WIRED.map(([name]) => name),
    ...PENDING.map((argv) => (commandFor(argv) ?? { name: ['?'] }).name.join(' '))
  ])
  const missing = CLI_COMMANDS.map((command) => command.name.join(' ')).filter((name) => !covered.has(name))
  assert.deepEqual(missing, [], 'every command has at least one contract case')
})

test('every command that is wired has a success case and a fixed refusal', async () => {
  const server = await startTestServer({
    // 本文件不测 doctor 的外部探针：注入一个「什么都装好了」的 runner 与假端口探测。
    ops: {
      run: async () => '{"identities":{"bot":{"status":"ready"}}}',
      cliPath: process.execPath,
      now: () => '2026-11-07T03:26:00.000Z',
      portOpen: async () => true
    },
    routes: commandRoutes()
  })
  try {
    for (const [name, success, refusal] of WIRED) {
      const ok = await runCase(server, { ...success, token: success.token ?? 'operator' })
      assert.equal(ok.exit, success.exit, `${name}: success exit`)
      const envelope = ok.envelope as {
        readonly ok?: unknown
        readonly result?: Record<string, unknown>
        readonly error?: { readonly code?: unknown }
      }
      if (success.code !== undefined) {
        // 「已接线但仍是明说的 stub」的命令：成功面是那条固定拒绝，不是 200。
        assertFailure(envelope, success.code)
      } else {
        assert.equal(envelope.ok, true, `${name}: success envelope`)
        for (const key of success.resultKeys ?? []) {
          assert.ok(envelope.result !== undefined && key in envelope.result, `${name}: result.${key}`)
        }
      }

      const refused = await runCase(server, refusal)
      assert.equal(refused.exit, refusal.exit, `${name}: refusal exit`)
      assertFailure(refused.envelope, refusal.code ?? 'invalid_params')
    }
  } finally {
    server.close()
  }
})

test('every command that has not landed yet refuses with a fixed unavailable, offline', async () => {
  const server = await startTestServer()
  try {
    for (const argv of PENDING) {
      const { exit, envelope } = await runCase(server, { argv, exit: 3, code: 'unavailable', offline: true })
      assert.equal(exit, 3, `${argv.join(' ')}: not-ready exit`)
      assertFailure(envelope, 'unavailable')
    }
  } finally {
    server.close()
  }
})

test('a command with a bad argument refuses before the fixed unavailable of a pending command', async () => {
  const server = await startTestServer()
  try {
    // 参数形状先于「有没有实现」判定：`ticket stop` 缺少 ticket id 是 invalid_params（退出 2），
    // 不是 unavailable（退出 3）。于是后票接上实现时，参数表的语义不会变。
    const missing = await runCase(server, { argv: ['ticket', 'stop'], exit: 2, code: 'invalid_params', offline: true })
    assertFailure(missing.envelope, 'invalid_params')

    // 枚举值也不合法：`--purpose` 只有三种取值。
    const choice = await runCase(server, {
      argv: ['reply', '--purpose', 'nope'],
      exit: 2,
      code: 'invalid_value',
      offline: true
    })
    assertFailure(choice.envelope, 'invalid_value')
  } finally {
    server.close()
  }
})

test('an unknown command is invalid_params and names no argv element', async () => {
  const server = await startTestServer()
  try {
    const result = await runCase(server, { argv: ['nonsense', '--text'], exit: 2, code: 'invalid_params', offline: true })
    assertFailure(result.envelope, 'invalid_params')
    const text = JSON.stringify(result.envelope)
    assert.equal(text.includes('nonsense'), false, 'the unknown word is not echoed back')
  } finally {
    server.close()
  }
})

test('a missing token is a fixed refusal: unauthorized is not "not ready"', async () => {
  const server = await startTestServer()
  try {
    // §G.1：401 是「有值的固定码」→ 退出 2。它与「worker 没起来」（not_ready，退出 3）必须
    // 分得开：前者要人去配 token，后者只是没启动。
    const result = await runCase(server, { argv: ['status'], exit: 2, code: 'unauthorized', token: null })
    assertFailure(result.envelope, 'unauthorized')
    assert.equal(result.exit, 2, 'HTTP 401 is a refusal (exit 2)')

    // 而「连不上」是 not_ready（退出 3）：同一台机器上换一个没人听的端口。
    const gone = await dispatch({
      parsed: parseArgs(['status']),
      target: { ...server.target(), port: 1, baseUrl: 'http://127.0.0.1:1/superagent/api' },
      sleep: async () => undefined
    })
    assert.equal(gone.exit, 3)
    assertFailure(gone.envelope, 'not_ready')
  } finally {
    server.close()
  }
})

test('a request id makes a retried write return the first result, and only once', async () => {
  const server = await startTestServer()
  try {
    // `admin backup` 每次都会真的落一个文件：用「返回的备份路径」数「执行了几次」，
    // 比看时间戳更直接（保留策略会删旧文件，所以不能数目录）。
    const first = await dispatch({
      parsed: parseArgs(['admin', 'backup', '--request-id', 'req-backup-1']),
      target: server.target()
    })
    assert.equal(first.exit, 0, JSON.stringify(first.envelope))
    const firstResult = (first.envelope as { result?: Record<string, unknown> }).result
    assert.equal(typeof firstResult?.['path'], 'string', 'the first call returned a backup path')

    // 同 id 重试（§G.1 幂等行）：返回首次结果，不再写第二个文件。
    const retry = await dispatch({
      parsed: parseArgs(['admin', 'backup', '--request-id', 'req-backup-1']),
      target: server.target()
    })
    assert.equal(retry.exit, 0)
    assert.deepEqual((retry.envelope as { result?: unknown }).result, firstResult, 'the first result is replayed')

    // 换一个 id 就是一次新的写：新的备份路径（保留策略只留最近五份，所以只比路径）。
    const fresh = await dispatch({
      parsed: parseArgs(['admin', 'backup', '--request-id', 'req-backup-2']),
      target: server.target()
    })
    assert.equal(fresh.exit, 0)
    assert.notEqual((fresh.envelope as { result?: Record<string, unknown> }).result?.['path'], firstResult?.['path'])
  } finally {
    server.close()
  }
})

test('read applies the documented page defaults and caps before it goes to the wire', async () => {
  const server = await startTestServer()
  try {
    // §G.2 的 read 行：默认 20、上限 50。上限在客户端就判（`invalid_value`，退出 2），
    // 不发一次注定被拒的请求。
    const { readQuery, readPath } = await import('../src/worker/cli/commands')
    const args = (flags: Record<string, string>) => ({ positionals: [], flags, text: false })
    assert.deepEqual(readQuery('threads', args({})), { limit: 20 })
    assert.deepEqual(readQuery('threads', args({ limit: '5', offset: '10' })), { limit: 5, offset: 10 })
    assert.deepEqual(readQuery('models', args({})), {}, 'non-paged resources get no limit')
    const badFlags: readonly Record<string, string>[] = [{ limit: '0' }, { limit: '51' }, { offset: '-1' }, { limit: 'x' }]
    for (const bad of badFlags) {
      let caught: unknown = null
      try {
        readQuery('threads', args(bad))
      } catch (error) {
        caught = error
      }
      assert.ok(caught instanceof ApiError, JSON.stringify(bad))
      if (caught instanceof ApiError) assert.equal(caught.code, 'invalid_value')
    }

    // 路径：单个参数进路径、带 `/` 与空格的键被转义成一段。
    assert.equal(readPath('tickets', undefined), 'tickets')
    assert.equal(readPath('ticket', 't-1'), 'tickets/t-1')
    assert.equal(readPath('thread', 'gh:o/r #1'), 'threads/gh%3Ao%2Fr%20%231')
    let missing: unknown = null
    try {
      readPath('nope', undefined)
    } catch (error) {
      missing = error
    }
    assert.ok(missing instanceof ApiError)
    if (missing instanceof ApiError) assert.equal(missing.code, 'missing')

    // 端到端：`read threads --limit 1` 打到未落地的视图路由 → 503 unavailable（退出 3）。
    const result = await dispatch({
      parsed: parseArgs(['read', 'threads', '--limit', '1']),
      target: server.target()
    })
    assert.equal(result.exit, 3)
    assert.equal((result.envelope as { error: { code: string } }).error.code, 'unavailable')
    assert.equal(server.requests.length, 1, 'one request, to the real route')
  } finally {
    server.close()
  }
})

test('stdout and stderr never carry the token, and the error line carries the fixed code', async () => {
  const server = await startTestServer()
  const dir = tempStateDir()
  try {
    const out: string[] = []
    const err: string[] = []
    const result = await main({
      argv: ['admin', 'rotate-token'],
      io: { out: (line) => out.push(line), err: (line) => err.push(line) },
      target: server.target()
    })
    assert.equal(result.exit, 2)
    const everything = [...out, ...err].join('\n')
    assert.equal(everything.includes(server.operatorToken), false, 'the token never reaches the output')
    assert.equal(everything.includes('Bearer'), false, 'no auth header leaks')
    assert.ok(err.join('\n').includes('refused'), 'the stderr line carries the code')
    // stdout 仍是 JSON 信封：脚本读它，人读 stderr 那一行。
    assert.equal(JSON.parse(out.join('\n')).error.code, 'refused')
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--text as a command value keeps the JSON envelope (it is not the output switch)', async () => {
  const server = await startTestServer({ routes: commandRoutes() })
  try {
    const out: string[] = []
    const result = await main({
      argv: ['reply', '--purpose', 'attention', '--text', 'Need a decision', '--human-action', 'Which branch?'],
      io: { out: (line) => out.push(line), err: () => undefined },
      target: server.target()
    })
    assert.equal(result.exit, 0)
    const printed = JSON.parse(out.join('\n')) as { readonly ok?: unknown }
    assert.equal(printed.ok, true, 'worker scripts parse the JSON envelope, not a human line')
  } finally {
    server.close()
  }
})

test('--text prints a human line for a refusal and still carries the code', async () => {
  const server = await startTestServer()
  try {
    const out: string[] = []
    const err: string[] = []
    const result = await main({
      argv: ['admin', 'rotate-token', '--text'],
      io: { out: (line) => out.push(line), err: (line) => err.push(line) },
      target: server.target()
    })
    assert.equal(result.exit, 2)
    assert.equal(out.join('\n'), 'error: refused: rotate-token replaces the operator token; pass --yes to confirm (reason=confirmation_required)')
  } finally {
    server.close()
  }
})

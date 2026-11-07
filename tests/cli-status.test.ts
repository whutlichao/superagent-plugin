// `status` 的退出码 0/1/2/3 与字段（§P.2 的 `cli-status.test.ts` 行、§N.4、§G.2 的 status 行）。
//
// 退出码口径与上游 `scripts/dsh-superagent status` 对齐（§N.4）：
//   0 正常运行；
//   1 没跑 / 跑了两份 / 不响应 / runtime 报错（重启可能修）；
//   2 某个**非 runtime** 部件报错（重启不修）；
//   3 等 setup（重启不修）。
// 另加 #8 的一条：**已暂停**也算「未就绪」（票面「未就绪（setup 未完成、暂停、未启动）为 3」），
// 因为暂停时它同样不在处理。
//
// 用真 loopback 服务器（#7）+ 真 HTTP：`status` 是 CLI 与面板共用的 `GET state` 读数，
// 所以退出码必须从**真实响应**算出来，而不是从本地的假快照。
import { assert, test } from 'orca/testing'
import { EXIT, exitForCode, NOT_READY_CODE } from '../src/worker/cli/io'
import { statusExitCode } from '../src/worker/cli/commands'
import { dispatch } from '../src/worker/cli/commands'
import { parseArgs } from '../src/worker/cli/io'
import type { HealthEntry } from '../src/worker/http/state'
import { startTestServer } from './support/cli-server'

/** 一份最简的 `GET state` 形状（只列退出码判定要用的字段）。 */
function stateOf(input: {
  readonly runtime?: string
  readonly paused?: boolean
  readonly setupProblem?: unknown
  readonly parts?: Readonly<Record<string, string>>
}): unknown {
  const health: Record<string, HealthEntry> = {
    runtime: { state: (input.runtime ?? 'ready') as HealthEntry['state'], at: '2026-11-07T03:26:00.000Z' }
  }
  for (const [name, state] of Object.entries(input.parts ?? {})) {
    health[name] = { state: state as HealthEntry['state'], at: '2026-11-07T03:26:00.000Z' }
  }
  return {
    process: { pid: 1, startedAt: '2026-11-07T03:26:00.000Z', stateDir: '/tmp/state' },
    store: { path: '/tmp/state/superagent.sqlite', schemaVersion: 1, journalMode: 'wal' },
    http: { host: '127.0.0.1', port: 3847, requests: 1 },
    loops: [],
    health,
    setup: { problem: input.setupProblem ?? null },
    paused: input.paused ?? false,
    load: { running: 0, queued: 0, maxWorkers: 2 }
  }
}

test('exit 0 when the runtime is ready and no other part reports an error', () => {
  assert.equal(statusExitCode(stateOf({})), EXIT.ok)
  assert.equal(EXIT.ok, 0)
})

test('exit 1 when the runtime is not ready (not running, unreachable or reporting an error)', () => {
  assert.equal(statusExitCode(stateOf({ runtime: 'error' })), EXIT.internal)
  // 与上游 `runtime_up()` 一致：只有 ready / paused 算「跑着」，starting 仍算没跑起来。
  assert.equal(statusExitCode(stateOf({ runtime: 'starting' })), EXIT.internal)
  // 没有 runtime 条目：等于「没跑」。
  assert.equal(statusExitCode({ health: {} }), EXIT.internal)
  assert.equal(statusExitCode({}), EXIT.internal)
  assert.equal(EXIT.internal, 1)
})

test('exit 2 when a non-runtime part reports an error (a restart does not fix it)', () => {
  assert.equal(statusExitCode(stateOf({ parts: { github: 'error' } })), EXIT.refused)
  assert.equal(statusExitCode(stateOf({ parts: { sources: 'error', feishu: 'ready' } })), EXIT.refused)
  assert.equal(EXIT.refused, 2)
  // 非 error 的部件状态不影响：ready/starting/paused 都不是故障。
  assert.equal(statusExitCode(stateOf({ parts: { github: 'ready', evals: 'paused' } })), EXIT.ok)
})

test('exit 3 while waiting for setup or while paused', () => {
  assert.equal(
    statusExitCode(stateOf({ setupProblem: { place: 'github', code: 'agentCliSignedOut' } })),
    EXIT.notReady
  )
  assert.equal(statusExitCode(stateOf({ paused: true })), EXIT.notReady)
  assert.equal(EXIT.notReady, 3)
  // runtime 挂了优先于 setup/paused：那是 1，不是 3。
  assert.equal(
    statusExitCode(stateOf({ runtime: 'error', setupProblem: { place: 'github', code: 'x' } })),
    EXIT.internal
  )
  // 暂停与部件报错同时存在：暂停（「不在处理」）优先，与 setup 的优先级一致（§N.4 的骨架）。
  assert.equal(statusExitCode(stateOf({ paused: true, parts: { github: 'error' } })), EXIT.notReady)
})

test('an unknown or unreadable state is treated as not running, never as success', () => {
  for (const value of [null, undefined, 'nope', 42, []]) {
    assert.equal(statusExitCode(value), EXIT.internal, JSON.stringify(value))
  }
})

test('the cli exit code table maps every fixed code family the design names', () => {
  // §G.1：0 成功、1 内部错误、2 固定拒绝、3 未就绪。
  assert.equal(exitForCode('refused'), 2)
  assert.equal(exitForCode('not_permitted_role'), 2)
  assert.equal(exitForCode('invalid_params'), 2)
  assert.equal(exitForCode('invalid_value'), 2)
  assert.equal(exitForCode('missing'), 2)
  assert.equal(exitForCode('too_long'), 2)
  assert.equal(exitForCode('stale_revision'), 2)
  assert.equal(exitForCode('unauthorized'), 2)
  assert.equal(exitForCode('conflict'), 2)
  assert.equal(exitForCode(NOT_READY_CODE), 3)
  assert.equal(exitForCode('unavailable'), 3)
  assert.equal(exitForCode('internal'), 1)
  // 没登记的码：说不清就按内部错误（1），绝不假装是固定拒绝（2）。
  assert.equal(exitForCode('something_new'), 2)
  assert.equal(exitForCode(''), 2)
})

test('status over the wire returns the fields the design names and exits 0', async () => {
  const server = await startTestServer({
    host: {
      health: () => ({ runtime: { state: 'ready', at: '2026-11-07T03:26:00.000Z' } }),
      setup: () => ({ problem: null })
    }
  })
  try {
    const result = await dispatch({ parsed: parseArgs(['status']), target: server.target() })
    assert.equal(result.exit, 0)
    const view = (result.envelope as { result: Record<string, unknown> }).result
    // §G.2 的 status 行：进程/库/HTTP/loop、health 每项、setup 问题、paused、load。
    assert.deepEqual(Object.keys(view).sort(), [
      'health',
      'http',
      'load',
      'loops',
      'paused',
      'process',
      'setup',
      'store'
    ])
    assert.deepEqual(Object.keys(view['load'] as object).sort(), ['maxWorkers', 'queued', 'running'])
    assert.equal(typeof (view['process'] as Record<string, unknown>)['pid'], 'number')
    assert.equal(typeof (view['http'] as Record<string, unknown>)['port'], 'number')
  } finally {
    server.close()
  }
})

test('status exits 2 when a part reports an error, and 3 when paused, over the wire', async () => {
  let paused = false
  const server = await startTestServer({
    host: {
      health: () => ({
        runtime: { state: 'ready', at: '2026-11-07T03:26:00.000Z' },
        github: { state: 'error', detail: 'poll failed', at: '2026-11-07T03:26:00.000Z' }
      }),
      paused: () => paused
    }
  })
  try {
    const partError = await dispatch({ parsed: parseArgs(['status']), target: server.target() })
    assert.equal(partError.exit, 2)

    // 暂停与部件报错同时存在：暂停（人在处理暂停，先解释「为什么没动静」）优先。
    paused = true
    const both = await dispatch({ parsed: parseArgs(['status']), target: server.target() })
    assert.equal(both.exit, 3, 'paused outranks a part error, as setup does')
  } finally {
    server.close()
  }

  const pausedOnly = await startTestServer({
    host: { paused: () => true }
  })
  try {
    const result = await dispatch({ parsed: parseArgs(['status']), target: pausedOnly.target() })
    assert.equal(result.exit, 3, 'paused is not-ready')
    assert.equal((result.envelope as { result: { paused: boolean } }).result.paused, true)
  } finally {
    pausedOnly.close()
  }
})

test('status exits 1 when the runtime itself is in error, over the wire', async () => {
  const server = await startTestServer({
    host: {
      health: () => ({ runtime: { state: 'error', detail: 'database unreadable', at: '2026-11-07T03:26:00.000Z' } })
    }
  })
  try {
    const result = await dispatch({ parsed: parseArgs(['status']), target: server.target() })
    assert.equal(result.exit, 1)
    assert.equal((result.envelope as { ok: boolean }).ok, true, 'the read itself succeeded; the exit code carries the verdict')
  } finally {
    server.close()
  }
})

test('status exits 3 when the worker is not reachable at all', async () => {
  const probe = await startTestServer()
  const port = probe.port
  probe.close()
  const waits: number[] = []
  const result = await dispatch({
    parsed: parseArgs(['status']),
    target: {
      stateDir: '/tmp/unused',
      stateDirSource: 'argument',
      port,
      baseUrl: `http://127.0.0.1:${port}/superagent/api`,
      token: 'operator-token',
      tokenSource: 'argument',
      tokenFile: null
    },
    sleep: async (milliseconds: number) => {
      waits.push(milliseconds)
    }
  })
  assert.equal(result.exit, 3)
  assert.deepEqual(waits, [200], 'one retry only, then give up with 3')
  assert.equal((result.envelope as { error: { code: string } }).error.code, 'not_ready')
})

test('pause over the wire flips status to 3, and resume flips it back to 0', async () => {
  // 同一台服务器上：`pause` 写库 → `GET state` 的 `paused` 立刻是 true（同一份读模型）。
  const server = await startTestServer()
  try {
    const before = await dispatch({ parsed: parseArgs(['status']), target: server.target() })
    assert.equal(before.exit, 0)

    const paused = await dispatch({ parsed: parseArgs(['pause']), target: server.target() })
    assert.equal(paused.exit, 0)
    const afterPause = await dispatch({ parsed: parseArgs(['status']), target: server.target() })
    assert.equal(afterPause.exit, 3, 'paused is not-ready')
    assert.equal((afterPause.envelope as { result: { paused: boolean } }).result.paused, true)

    const resumed = await dispatch({ parsed: parseArgs(['resume']), target: server.target() })
    assert.equal(resumed.exit, 0)
    const afterResume = await dispatch({ parsed: parseArgs(['status']), target: server.target() })
    assert.equal(afterResume.exit, 0)
    assert.equal((afterResume.envelope as { result: { paused: boolean } }).result.paused, false)
  } finally {
    server.close()
  }
})

test('health prints only the health entries and exits 0 on a successful read', async () => {
  const server = await startTestServer({
    host: {
      health: () => ({
        runtime: { state: 'ready', at: '2026-11-07T03:26:00.000Z' },
        github: { state: 'error', detail: 'poll failed', at: '2026-11-07T03:26:00.000Z' }
      })
    }
  })
  try {
    const result = await dispatch({ parsed: parseArgs(['health']), target: server.target() })
    // 一条 health 读成功就是 0：0/1/2/3 的判定口径只属于 `status`（§N.4），不扩大到读命令。
    assert.equal(result.exit, 0)
    const view = (result.envelope as { result: Record<string, unknown> }).result
    assert.deepEqual(Object.keys(view), ['health'])
    assert.deepEqual(Object.keys(view['health'] as object).sort(), ['github', 'runtime'])
  } finally {
    server.close()
  }
})

// 端到端 tracer bullet（§Q.1 的验收面）：通知轮询 → Issue 评论 → Trigger → Gate（允许+寻址）
// → accept（Ticket + Mandate）→ worktree → agent → assignment 投递 → worker 的 report/reply
// → GitHub 评论（隐藏标记）→ 面板快照。侧效只经 `FakeOrcaRuntime` 与 `FakeCommands` 观察，
// HTTP/CLI 用真 loopback 服务器（§P.1）。
import { assert, test } from 'orca/testing'
import { dispatch } from '../src/worker/cli/commands'
import { parseArgs } from '../src/worker/cli/io'
import { readApiToken } from '../src/worker/infra/tokens'
import { assignmentToken, openBoot } from './support/boot'

/** 一个指向 boot 服务器的 CLI 目标。 */
function target(stateDir: string, port: number, token: string | null) {
  return {
    stateDir,
    stateDirSource: 'argument' as const,
    port,
    baseUrl: `http://127.0.0.1:${port}/superagent/api`,
    token,
    tokenSource: 'argument' as const,
    tokenFile: null
  }
}

/** 跑一条 CLI 命令；返回退出码与结果。 */
async function cli(stateDir: string, port: number, argv: readonly string[], token: string | null) {
  return dispatch({ parsed: parseArgs(argv), target: target(stateDir, port, token), sleep: async () => undefined })
}

test('a mention becomes a ticket, an agent, a comment and a panel row', async () => {
  const h = await openBoot()
  try {
    const first = await h.handle.pollOnce()
    assert.deepEqual(first, { notifications: 1, triggers: 1 })
    await h.handle.passOnce()
    // 第二轮 pass：accept 的决定（pass 里排空评估器）→ launch effect → worktree + agent。
    await h.handle.passOnce()
    await h.handle.passOnce()

    // 侧效顺序：建 worktree → 启 agent → 写入终端（assignment 投递）。
    assert.equal(h.runtime.calls.ensureWorkspace.length >= 1, true, 'a worktree was created')
    assert.equal(h.runtime.calls.launchAgent.length >= 1, true, 'an agent was launched')
    assert.equal(h.runtime.calls.sent.length >= 1, true, 'the assignment was delivered')
    // 组合根同时起一个常驻 Router（#16）；这条用例关心的是 Ticket 的 worker。
    const spec = h.runtime.calls.launchAgent.find(
      (candidate) => !candidate.workspace.path.endsWith('/superagent-router')
    )!
    assert.equal(spec.surface, 'terminal')
    assert.equal(spec.workspace.path.startsWith(h.worktrees), true)

    // HTTP/CLI 验收：status 退出 0；read tickets 有该 Ticket。
    const port = h.handle.port()
    assert.notEqual(port, null)
    const status = await cli(h.stateDir, port!, ['status'], readApiToken(h.stateDir))
    assert.equal(status.exit, 0)
    const tickets = await cli(h.stateDir, port!, ['read', 'tickets'], readApiToken(h.stateDir))
    assert.equal(tickets.exit, 0)
    const result = (tickets.envelope as { result: { items: { id: string; title: string; assignment?: { id: string; state: string } }[] } }).result
    assert.equal(result.items.length, 1)
    const ticket = result.items[0]!
    assert.equal(ticket.title.includes('fix the login redirect'), true)
    assert.equal(ticket.assignment?.state, 'running')

    // 回执先发（accept 的 acknowledgement），带隐藏幂等标记。
    const posts = h.commands.calls.filter(
      (call) => call.args[1] === 'repos/acme/widgets/issues/42/comments' && call.args[2] === '-f'
    )
    assert.equal(posts.length >= 1, true, 'the acknowledgement was written')
    assert.deepEqual(h.commands.calls[0]?.program, 'gh')

    // worker 用 CLI 报 ready，再回结果；两条评论按「先确认后结果」发出。
    const token = assignmentToken(h.stateDir, ticket.assignment!.id)
    const report = await cli(
      h.stateDir,
      port!,
      ['report', '--state', 'ready', '--summary', 'The login redirect is fixed.'],
      token
    )
    assert.equal(report.exit, 0, JSON.stringify(report.envelope))
    const reply = await cli(
      h.stateDir,
      port!,
      ['reply', '--purpose', 'result', '--text', 'Done: the login redirect is fixed.'],
      token
    )
    assert.equal(reply.exit, 0, JSON.stringify(reply.envelope))
    await h.handle.passOnce()
    const bodies = h.commands.calls
      .filter((call) => call.args[1] === 'repos/acme/widgets/issues/42/comments' && call.args[2] === '-f')
      .map((call) => String(call.args[3] ?? ''))
    assert.equal(bodies.length, 2, 'the acknowledgement and the result')
    // `gh api -f body=…` 的 argv 形状：正文永远只是参数里的一个值（§I.4）。
    assert.equal(bodies[0]!.startsWith('body=On it:'), true)
    assert.equal(bodies[1]!.startsWith('body=Done:'), true)
    for (const body of bodies) {
      assert.equal(/<!-- superagent:[a-f0-9]{32} -->/.test(body), true, 'the hidden id marker')
    }

    // 面板快照：Ticket 行在，状态栏计数与待人工一致。
    const snapshot = h.handle.snapshot()
    assert.equal(snapshot.tickets?.length, 1)
    assert.equal(snapshot.tickets?.[0]?.title.includes('login redirect'), true)
  } finally {
    await h.cleanup()
  }
})

test('a message that is not for the agent leaves a filtered record and no ticket', async () => {
  const h = await openBoot({ scriptComment: false })
  try {
    await h.handle.pollOnce()
    await h.handle.passOnce()
    // Router 的专用 worktree 是组合根启动时建的；这里断言的是「没有为消息建 Ticket worktree」。
    assert.deepEqual(
      h.runtime.calls.ensureWorkspace.filter((spec) => spec.name !== 'superagent-router'),
      []
    )
    assert.equal(h.handle.snapshot().tickets?.length, 0)
  } finally {
    await h.cleanup()
  }
})

test('polling the same notification twice yields one ticket and one acknowledgement', async () => {
  const h = await openBoot()
  try {
    await h.handle.pollOnce()
    await h.handle.passOnce()
    await h.handle.passOnce()
    await h.handle.passOnce()
    const before = h.commands.calls.filter(
      (call) => call.args[1] === 'repos/acme/widgets/issues/42/comments' && call.args[2] === '-f'
    ).length
    await h.handle.pollOnce()
    await h.handle.passOnce()
    const after = h.commands.calls.filter(
      (call) => call.args[1] === 'repos/acme/widgets/issues/42/comments' && call.args[2] === '-f'
    ).length
    assert.equal(after, before, 'the cursor + the trigger id keep it to one')
    const port = h.handle.port()!
    const tickets = await cli(h.stateDir, port, ['read', 'tickets'], readApiToken(h.stateDir))
    assert.equal((tickets.envelope as { result: { items: unknown[] } }).result.items.length, 1)
  } finally {
    await h.cleanup()
  }
})

test('a restart adopts the running assignment instead of opening a second ticket', async () => {
  const first = await openBoot()
  const stateDir = first.stateDir
  try {
    await first.handle.pollOnce()
    await first.handle.passOnce()
    await first.handle.passOnce()
    await first.handle.passOnce()
    assert.equal(first.handle.snapshot().tickets?.length, 1)
    // 终端仍在（FakeOrcaRuntime 的 listTerminals 默认把已启动的 agent 列出来）。插件重启只换
    // 组合根，不换 Orca 宿主：第二段 boot 必须接同一个假宿主，否则模拟的是「应用也重启了」。
    await first.handle.shutdown()
    const second = await openBoot({ stateDir, boot: async (_dir, _runtime, commands) => {
      const { bootPlugin } = await import('../src/worker/boot')
      return bootPlugin({
        runtime: first.runtime,
        readSettings: async () => firstSettings(stateDir),
        commands,
        stateDir,
        disableTimers: true
      })
    } })
    try {
      const report = second.handle.resumeReport()
      assert.equal(report?.assignments.length, 1)
      assert.equal(report?.assignments[0]?.outcome, 'adopted')
      const port = second.handle.port()!
      const tickets = await cli(stateDir, port, ['read', 'tickets'], readApiToken(stateDir))
      assert.equal((tickets.envelope as { result: { items: unknown[] } }).result.items.length, 1)
    } finally {
      await second.cleanup()
    }
  } finally {
    await first.cleanup()
  }
})

/** 重启用的同一份设置。 */
function firstSettings(stateDir: string): Record<string, unknown> {
  return {
    stateDir,
    agent: 'pi',
    baseRepo: '/repos/widgets',
    executor: { agent: 'pi', maxWorkers: 2, confirmDelivery: false },
    sources: { github: { enabled: true, config: { repository: 'acme/widgets', cli: 'gh', pollSeconds: 60 } } },
    policy: { sources: { github: { allowed: ['alice'] } } }
  }
}

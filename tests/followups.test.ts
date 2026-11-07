// 人 follow-up 的归属（§P.2 的 `followups` 套件、§K.2 第 3 条、§D.1 Subscription）：
// 一条人写在已订阅 Thread 上的消息归该 Ticket 的 worker，**不会**被 Eval 再路由一次；
// 一条没有 Ticket 拥有的消息则照旧进 Eval。
//
// 跑在组合根上（真库 + 假 Orca 缝 + 假 CLI + 真临时目录，§P.1）：收信走真实的通知轮询与
// 订阅读取，投递看真的 inbox 文件与终端写入，候选看 Router 快照的未决计数。没有 sleep、
// 没有网络、没有对内层模块的 mock。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootPlugin, type BootHandle } from '../src/worker/boot.ts'
import { dispatch } from '../src/worker/cli/commands.ts'
import { parseArgs } from '../src/worker/cli/io.ts'
import { readApiToken } from '../src/worker/infra/tokens.ts'
import { FakeCommands } from './support/fake-commands.ts'
import { FakeOrcaRuntime } from './support/fake-orca-runtime.ts'
import { assignmentToken, COMMENT, NOTIFICATION, settingsOf } from './support/boot.ts'
import { readRepoJson } from './support/repo.ts'

/** 人后来在同一条 Issue 的 Thread 上写的一句话：不点名 agent。 */
const FOLLOWUP = {
  id: 9003,
  user: { login: 'alice', type: 'User' },
  body: '也把页面标题一并改了吧。',
  created_at: '2026-11-07T03:31:00Z',
  updated_at: '2026-11-07T03:31:00Z',
  html_url: 'https://github.com/acme/widgets/issues/42#issuecomment-9003'
}

/** 另一个 Issue 的通知与评论（新 Thread，没有任何 Ticket）。 */
const OTHER_NOTIFICATION = {
  ...NOTIFICATION,
  id: 'notification-2',
  updated_at: '2026-11-07T03:40:00Z',
  subject: {
    title: 'Docs typo',
    url: 'https://api.github.com/repos/acme/widgets/issues/43',
    type: 'Issue'
  }
}
const OTHER_COMMENT = {
  ...FOLLOWUP,
  id: 9103,
  body: 'Please fix the docs typo.',
  created_at: '2026-11-07T03:39:30Z',
  updated_at: '2026-11-07T03:39:30Z',
  html_url: 'https://github.com/acme/widgets/issues/43#issuecomment-9103'
}

/** 第三个 Issue（第 44 号）的一条点名评论：人类槽用例要的第二张 Ticket。 */
const THIRD_NOTIFICATION = {
  ...NOTIFICATION,
  id: 'notification-3',
  updated_at: '2026-11-07T03:50:00Z',
  subject: {
    title: 'Rotate the deploy token',
    url: 'https://api.github.com/repos/acme/widgets/issues/44',
    type: 'Issue'
  }
}
const THIRD_COMMENT = {
  ...FOLLOWUP,
  id: 9203,
  body: '@acme-agent please rotate the deploy token.',
  created_at: '2026-11-07T03:49:30Z',
  updated_at: '2026-11-07T03:49:30Z',
  html_url: 'https://github.com/acme/widgets/issues/44#issuecomment-9203'
}
/** 第 44 号上的又一句人话（不点名）：第二张 Ticket 的人 follow-up。 */
const THIRD_FOLLOWUP = {
  ...THIRD_COMMENT,
  id: 9204,
  body: 'Also put the note in the runbook.',
  created_at: '2026-11-07T03:52:00Z',
  updated_at: '2026-11-07T03:52:00Z',
  html_url: 'https://github.com/acme/widgets/issues/44#issuecomment-9204'
}

/** 一套 boot 夹具：真库、假缝、假 CLI、活的评论与通知列表。 */
interface FollowupHarness {
  readonly handle: BootHandle
  readonly runtime: FakeOrcaRuntime
  readonly commands: FakeCommands
  readonly stateDir: string
  /** 下一轮轮询读到的会话评论；测试在轮询之间往里加一条。 */
  readonly comments: Record<string, unknown>[]
  /** 下一轮轮询读到的通知；测试往里加第二条通知来引入另一个 Thread。 */
  readonly notifications: Record<string, unknown>[]
  /** 第 44 号 Issue 上的评论（人类槽用例的第二张 Ticket 与它的 follow-up）。 */
  readonly thirdComments: Record<string, unknown>[]
  cleanup(): Promise<void>
}

/**
 * 起一次 boot：一条通知、一条点名评论、开了「接收未点名的评论」（否则 follow-up 会被
 * Source 的监听范围挡在 Gate 之前）。评论与通知列表是活的，测试可追加后再轮询。
 */
async function openFollowup(options: { readonly maxWorkers?: number } = {}): Promise<FollowupHarness> {
  const stateDir = mkdtempSync(join(tmpdir(), 'superagent-followup-'))
  const worktrees = mkdtempSync(join(tmpdir(), 'superagent-followup-worktrees-'))
  const runtime = new FakeOrcaRuntime()
  runtime.worktreeRoot = worktrees
  const commands = new FakeCommands()
  const comments: Record<string, unknown>[] = [COMMENT]
  const notifications: Record<string, unknown>[] = [NOTIFICATION]
  // setup 探针也走同一个命令端口（`git --version`、`gh api user`，§I.4）。
  commands.script('git --version', () => 'git version 2.39.0\n')
  commands.script('gh api user', () => 'acme-agent\n')
  commands.script('gh api notifications', () => JSON.stringify(notifications))
  commands.script(['api', 'repos/acme/widgets/issues/42'], () =>
    JSON.stringify(readRepoJson('tests/fixtures/cli/github/issue.json'))
  )
  commands.script(['api', 'repos/acme/widgets/issues/42/comments', '--paginate'], () =>
    JSON.stringify(comments)
  )
  commands.script(['api', 'repos/acme/widgets/issues/42/comments?per_page=100', '-q'], () => '')
  commands.script(['api', 'repos/acme/widgets/issues/42/comments', '-f'], () => '{}')
  // 第二个 Issue：只有通知需要读它（没有 Ticket 订阅，因此订阅那一路不会读它）。
  const otherIssue = {
    ...readRepoJson<Record<string, unknown>>('tests/fixtures/cli/github/issue.json'),
    number: 43,
    html_url: 'https://github.com/acme/widgets/issues/43'
  }
  commands.script(['api', 'repos/acme/widgets/issues/43'], () => JSON.stringify(otherIssue))
  commands.script(['api', 'repos/acme/widgets/issues/43/comments', '--paginate'], () =>
    JSON.stringify([OTHER_COMMENT])
  )
  // 第三个 Issue（44）：点名评论建第二张 Ticket，之后的人话是它的 follow-up。
  const thirdIssue = {
    ...readRepoJson<Record<string, unknown>>('tests/fixtures/cli/github/issue.json'),
    number: 44,
    html_url: 'https://github.com/acme/widgets/issues/44'
  }
  const thirdComments: Record<string, unknown>[] = [THIRD_COMMENT]
  commands.script(['api', 'repos/acme/widgets/issues/44'], () => JSON.stringify(thirdIssue))
  commands.script(['api', 'repos/acme/widgets/issues/44/comments', '--paginate'], () =>
    JSON.stringify(thirdComments)
  )
  const settings = {
    ...settingsOf(stateDir),
    ...(options.maxWorkers === undefined
      ? {}
      : { executor: { agent: 'pi', maxWorkers: options.maxWorkers, confirmDelivery: false } }),
    sources: {
      github: {
        enabled: true,
        config: { repository: 'acme/widgets', cli: 'gh', pollSeconds: 60, observeComments: true }
      }
    }
  }
  const handle = await bootPlugin({
    runtime,
    readSettings: async () => settings,
    commands,
    stateDir,
    disableTimers: true
  })
  return {
    handle,
    runtime,
    commands,
    stateDir,
    comments,
    notifications,
    thirdComments,
    cleanup: async () => {
      await handle.shutdown()
      rmSync(stateDir, { recursive: true, force: true })
      rmSync(worktrees, { recursive: true, force: true })
    }
  }
}

/** 一条 Ticket 的 inbox 文件名（`0.md` 是作业文本，之后每条 Input 一个；还没起过就是空）。 */
function inboxFiles(stateDir: string, ticketId: string): string[] {
  const dir = join(stateDir, 'inbox', ticketId)
  return existsSync(dir) ? [...readdirSync(dir)].sort() : []
}

/** 发往会话的写入调用（Channel 的 `gh api … -f body=…`）。 */
function writes(commands: FakeCommands): number {
  return commands.calls.filter(
    (call) => call.args[1] === 'repos/acme/widgets/issues/42/comments' && call.args[2] === '-f'
  ).length
}

/** 跑一轮收信与三轮 pass，让 accept、launch 与投递都落地。 */
async function settle(h: FollowupHarness): Promise<void> {
  await h.handle.pollOnce()
  await h.handle.passOnce()
  await h.handle.passOnce()
  await h.handle.passOnce()
}

/** 一个指向 boot 服务器的 CLI 目标（与 `runtime.test.ts` 同一写法）。 */
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

/** 跑一条 CLI 命令（真 loopback 服务器、真 token，§G.1）。 */
async function cli(
  stateDir: string,
  port: number,
  argv: readonly string[],
  token: string | null
): Promise<{ readonly exit: number; readonly envelope: unknown }> {
  return dispatch({ parsed: parseArgs(argv), target: target(stateDir, port, token), sleep: async () => undefined })
}

/** boot 服务器的端口（没监听就是用例自己写错了）。 */
function portOf(h: FollowupHarness): number {
  const port = h.handle.port()
  assert.notEqual(port, null, 'the worker listens on a loopback port')
  return port!
}

/** 信封里的 `result`（断言失败信封时不该用它）。 */
function resultOf(envelope: unknown): Record<string, unknown> {
  const ok = envelope as { readonly ok?: unknown; readonly result?: Record<string, unknown> }
  assert.equal(ok.ok, true, 'a success envelope')
  assert.ok(ok.result !== undefined, 'the result is an object')
  return ok.result
}

/** 一条 Ticket 的读模型（`read ticket/<id>`，§G.2 的读面）。 */
async function ticketOf(
  h: FollowupHarness,
  id: string,
  token: string | null
): Promise<Record<string, unknown>> {
  const read = await cli(h.stateDir, portOf(h), ['read', 'ticket', id], token)
  assert.equal(read.exit, 0, 'the ticket is readable')
  return resultOf(read.envelope)
}

/** `count` 个词，用空白隔开（与 100 词上限同一口径，§G.2）。 */
function words(count: number): string {
  return Array.from({ length: count }, (_, index) => `w${index}`).join(' ')
}

test('keeps a person\'s follow-up on the ticket\'s thread with its worker, instead of routing it a second time', async () => {
  const h = await openFollowup()
  try {
    // 点名评论建 Ticket 并投递作业；到这一步已经有一条 running 的 Assignment。
    await settle(h)
    const [ticket] = h.handle.snapshot().tickets ?? []
    assert.ok(ticket, 'the mention opened a ticket')
    assert.equal(ticket.stage, 'working')
    const inputsBefore = inboxFiles(h.stateDir, ticket.id)
    // `0.md` 是作业文本；开始它的 Trigger 是 Ticket 的 origin，不是一条 Input。
    assert.deepEqual(inputsBefore, ['0.md'])
    const sentBefore = h.runtime.calls.sent.length
    const launchesBefore = h.runtime.calls.launchAgent.length
    const writesBefore = writes(h.commands)

    // 同一条 Thread 上人后来的一句话：订阅扇出把它交给这张 Ticket 的 worker。
    h.comments.push(FOLLOWUP)
    const round = await h.handle.pollOnce()
    assert.equal(round.triggers, 1)
    await h.handle.passOnce()
    await h.handle.passOnce()

    // 执行器已经拥有它：不产生候选（Router 的未决计数保持 0），不新开 Ticket、不新起 worker，
    // 也不对外发任何话。
    assert.equal(h.handle.routerStatus().undecidedCandidates, 0)
    assert.deepEqual(h.handle.snapshot().tickets?.map((item) => item.id), [ticket.id])
    assert.equal(h.runtime.calls.launchAgent.length, launchesBefore)
    assert.equal(writes(h.commands), writesBefore)
    // 投递沿用既有投递路径：inbox 多一条 Input，终端多一行带它的投递。
    const inputsAfter = inboxFiles(h.stateDir, ticket.id)
    assert.deepEqual(inputsAfter, ['0.md', '1.md'])
    const delivered = readFileSync(join(h.stateDir, 'inbox', ticket.id, '1.md'), 'utf8')
    assert.equal(delivered.includes(FOLLOWUP.body), true)
    assert.equal(
      h.runtime.calls.sent.slice(sentBefore).some((call) => call.text.includes(FOLLOWUP.body)),
      true
    )

    // 同一轮再读一次是同一个 Trigger（§D.1 幂等）：没有第二条 Input，也没有候选。
    const again = await h.handle.pollOnce()
    assert.equal(again.triggers, 0)
    await h.handle.passOnce()
    assert.deepEqual(inboxFiles(h.stateDir, ticket.id), inputsAfter)
    assert.equal(h.handle.routerStatus().undecidedCandidates, 0)
    assert.deepEqual(h.handle.snapshot().tickets?.map((item) => item.id), [ticket.id])
  } finally {
    await h.cleanup()
  }
})

test('still sends a message that reaches no ticket to Eval, not to the ticket on another Thread', async () => {
  const h = await openFollowup()
  try {
    await settle(h)
    const [first] = h.handle.snapshot().tickets ?? []
    assert.ok(first)
    const inputsBefore = inboxFiles(h.stateDir, first.id)
    // 另一个 Issue 上的评论：没有 Ticket 订阅那条 Thread，所以谁都不拥有它。
    h.notifications.push(OTHER_NOTIFICATION)
    const round = await h.handle.pollOnce()
    assert.equal(round.triggers, 1)
    // 它排队等主 Session（Router 的未决计数 1），而第一张 Ticket 一条 Input 都没多。
    assert.equal(h.handle.routerStatus().undecidedCandidates, 1)
    assert.deepEqual(inboxFiles(h.stateDir, first.id), inputsBefore)
    // 主 Session 处理完它之前，它也不会被扇出给任何 Ticket 的 worker。
    await h.handle.passOnce()
    await h.handle.passOnce()
    assert.equal(h.handle.routerStatus().undecidedCandidates, 0)
    assert.deepEqual(h.handle.snapshot().tickets?.map((item) => item.id), [first.id])
    assert.deepEqual(inboxFiles(h.stateDir, first.id), inputsBefore)
  } finally {
    await h.cleanup()
  }
})

test('sends a person note to the ticket as a note Input, refuses one over 100 words, and changes no authority', async () => {
  const h = await openFollowup()
  try {
    await settle(h)
    const [ticket] = h.handle.snapshot().tickets ?? []
    assert.ok(ticket)
    const token = readApiToken(h.stateDir)
    const inputsBefore = inboxFiles(h.stateDir, ticket.id)
    const sentBefore = h.runtime.calls.sent.length
    const launchesBefore = h.runtime.calls.launchAgent.length
    const writesBefore = writes(h.commands)
    const viewBefore = await ticketOf(h, ticket.id, token)

    // 101 个词：§G.2 的 100 词上限是固定拒绝，什么都不加（也不投递、不新建工作）。
    const refused = await cli(
      h.stateDir,
      portOf(h),
      ['ticket', 'note', ticket.id, `--text=${words(101)}`],
      token
    )
    assert.equal(refused.exit, 2)
    assert.equal((refused.envelope as { error?: { code?: string } }).error?.code, 'too_long')
    await h.handle.passOnce()
    assert.deepEqual(inboxFiles(h.stateDir, ticket.id), inputsBefore)
    assert.equal(h.runtime.calls.launchAgent.length, launchesBefore)

    // 正好 100 个词：作为一条 `note` Input 投递，执行器把它交给同一个 worker。
    const note = words(100)
    const sent = await cli(h.stateDir, portOf(h), ['ticket', 'note', ticket.id, `--text=${note}`], token)
    assert.equal(sent.exit, 0)
    assert.equal(resultOf(sent.envelope)['sent'], true)
    await h.handle.passOnce()
    assert.deepEqual(inboxFiles(h.stateDir, ticket.id), [...inputsBefore, '1.md'])
    const rendered = readFileSync(join(h.stateDir, 'inbox', ticket.id, '1.md'), 'utf8')
    assert.equal(rendered.includes('# Input #1 — note'), true, 'delivered as a note input')
    assert.equal(rendered.includes(note), true)
    assert.equal(
      h.runtime.calls.sent.slice(sentBefore).some((call) => call.text.includes('[superagent] #1 note:')),
      true,
      'the note reached the worker as a note'
    )

    // note 只带一个事实：Mandate（强度与发起人）一字不改，没有新 Ticket、没有候选、没有新 worker。
    const viewAfter = await ticketOf(h, ticket.id, token)
    assert.deepEqual(
      [viewAfter['strength'], viewAfter['actor']],
      [viewBefore['strength'], viewBefore['actor']]
    )
    assert.deepEqual(h.handle.snapshot().tickets?.map((item) => item.id), [ticket.id])
    assert.equal(h.handle.routerStatus().undecidedCandidates, 0)
    assert.equal(h.runtime.calls.launchAgent.length, launchesBefore)
    // 它也不是一次「回答」：note 不往任何会话写话（授权面与对外发言都不变）。
    assert.equal(writes(h.commands), writesBefore)

    // 未知的 Ticket 是固定的 `missing`。
    const missing = await cli(h.stateDir, portOf(h), ['ticket', 'note', 'nope', '--text=a fact'], token)
    assert.equal(missing.exit, 2)
    assert.equal((missing.envelope as { error?: { code?: string } }).error?.code, 'missing')
  } finally {
    await h.cleanup()
  }
})

test('asks a waiting worker for one status turn without creating work, and asks nobody when no assignment runs', async () => {
  const h = await openFollowup()
  try {
    await settle(h)
    const [ticket] = h.handle.snapshot().tickets ?? []
    assert.ok(ticket)
    const token = readApiToken(h.stateDir)
    const view = await ticketOf(h, ticket.id, token)
    const assignment = view['assignment'] as { readonly id: string; readonly terminalId?: string }
    const worker = assignmentToken(h.stateDir, assignment.id)

    // worker 还没报告 `waiting`：不打扰它（与 `noAnswer` 的口径一致）。
    const early = await cli(h.stateDir, portOf(h), ['ticket', 'request-status', ticket.id], token)
    assert.equal(early.exit, 0)
    assert.equal(resultOf(early.envelope)['asked'], false)
    await h.handle.passOnce()
    assert.deepEqual(inboxFiles(h.stateDir, ticket.id), ['0.md'])

    // worker 报 `waiting` 之后：正好一条状态请求，作为 Input 投给同一个 Assignment。
    const reported = await cli(
      h.stateDir,
      portOf(h),
      ['report', '--state', 'waiting', '--summary', 'Waiting for the next request.'],
      worker
    )
    assert.equal(reported.exit, 0)
    const waiting = await ticketOf(h, ticket.id, token)
    const launchesBefore = h.runtime.calls.launchAgent.length
    const sentBefore = h.runtime.calls.sent.length
    const asked = await cli(h.stateDir, portOf(h), ['ticket', 'request-status', ticket.id], token)
    assert.equal(asked.exit, 0)
    assert.equal(resultOf(asked.envelope)['asked'], true)
    await h.handle.passOnce()
    assert.deepEqual(inboxFiles(h.stateDir, ticket.id), ['0.md', '1.md'])
    const request = readFileSync(join(h.stateDir, 'inbox', ticket.id, '1.md'), 'utf8')
    assert.equal(request.includes('# Input #1 — text'), true)
    assert.equal(request.includes('Report the current ticket status'), true)
    assert.equal(
      h.runtime.calls.sent.slice(sentBefore).some((call) => call.text.includes('[superagent] #1')),
      true,
      'the status turn reached the worker'
    )
    // 不创建新工作：没有新 Assignment、没有新 worker、没有新 Ticket、没有候选。
    const after = await ticketOf(h, ticket.id, token)
    assert.deepEqual(after['assignment'], waiting['assignment'])
    assert.equal(h.runtime.calls.launchAgent.length, launchesBefore)
    assert.deepEqual(h.handle.snapshot().tickets?.map((item) => item.id), [ticket.id])
    assert.equal(h.handle.routerStatus().undecidedCandidates, 0)

    // Assignment 结束（agent 的 `waiting`）：没有在跑的 Assignment，就不问任何人。
    await h.handle.onAgentStatus(FakeOrcaRuntime.statusEvent(assignment.terminalId!, 'waiting'))
    const inputsAfter = inboxFiles(h.stateDir, ticket.id)
    const idle = await cli(h.stateDir, portOf(h), ['ticket', 'request-status', ticket.id], token)
    assert.equal(idle.exit, 0)
    assert.equal(resultOf(idle.envelope)['asked'], false)
    await h.handle.passOnce()
    assert.deepEqual(inboxFiles(h.stateDir, ticket.id), inputsAfter)

    // 未知 Ticket 是固定的 `missing`。
    const missing = await cli(h.stateDir, portOf(h), ['ticket', 'request-status', 'nope'], token)
    assert.equal(missing.exit, 2)
    assert.equal((missing.envelope as { error?: { code?: string } }).error?.code, 'missing')
  } finally {
    await h.cleanup()
  }
})

test('marks a follow-up that a worker still owns as delivered to that ticket, so nothing routes it twice', async () => {
  const h = await openFollowup()
  try {
    await settle(h)
    const [ticket] = h.handle.snapshot().tickets ?? []
    assert.ok(ticket)
    const token = readApiToken(h.stateDir)
    // 还没有人 follow-up：读模型里没有这个标记（不是空数组，是「没有」）。
    assert.equal('followups' in (await ticketOf(h, ticket.id, token)), false)

    h.comments.push(FOLLOWUP)
    await h.handle.pollOnce()
    await h.handle.passOnce()
    await h.handle.passOnce()

    const view = await ticketOf(h, ticket.id, token)
    const followups = view['followups'] as readonly {
      readonly triggerId: string
      readonly at: string
      readonly deliveredTo: string
      readonly assignmentId?: string
    }[]
    assert.equal(followups.length, 1, 'the follow-up is marked on the ticket')
    assert.equal(followups[0]!.deliveredTo, ticket.id, 'the mark names the ticket it was delivered to')
    assert.equal(followups[0]!.at, '2026-11-07T03:31:00.000Z', "the person's message time")
    assert.equal(followups[0]!.assignmentId, (view['assignment'] as { id: string }).id, 'the executor handed it to the assignment')
    // 同一条标记说明「不要再路由」：Router 没有候选，也没有第二张 Ticket。
    assert.equal(h.handle.routerStatus().undecidedCandidates, 0)
    assert.deepEqual(h.handle.snapshot().tickets?.map((item) => item.id), [ticket.id])
    // 读面每次都从同一份状态推出它：再读一次是同一份标记；列表与详情是同一份。
    assert.deepEqual((await ticketOf(h, ticket.id, token))['followups'], followups)
    const list = await cli(h.stateDir, portOf(h), ['read', 'tickets'], token)
    const [row] = (resultOf(list.envelope)['items'] ?? []) as readonly {
      readonly id: string
      readonly followups?: readonly unknown[]
    }[]
    assert.equal(row?.id, ticket.id)
    assert.deepEqual(row?.followups, followups)
  } finally {
    await h.cleanup()
  }
})

test('hands an owned follow-up back to evaluation exactly once, and refuses a trigger it does not own', async () => {
  const h = await openFollowup()
  try {
    await settle(h)
    const [ticket] = h.handle.snapshot().tickets ?? []
    assert.ok(ticket)
    const token = readApiToken(h.stateDir)
    const view = await ticketOf(h, ticket.id, token)
    const worker = assignmentToken(h.stateDir, (view['assignment'] as { readonly id: string }).id)

    // 没有到达过这个 worker 的 Trigger：固定 `not_owned`，什么都不排。
    const foreign = await cli(
      h.stateDir,
      portOf(h),
      ['trigger', 'handback', 'never-reached', '--reason=Not this one.'],
      worker
    )
    assert.equal(foreign.exit, 2)
    assert.equal((foreign.envelope as { error?: { code?: string } }).error?.code, 'not_owned')
    assert.equal(h.handle.routerStatus().undecidedCandidates, 0)

    // 同一条 Thread 上人后来的一句话：归这张 Ticket 的 worker，标记为「已投递到该 Ticket」。
    h.comments.push(FOLLOWUP)
    await h.handle.pollOnce()
    await h.handle.passOnce()
    await h.handle.passOnce()
    const marked = await ticketOf(h, ticket.id, token)
    const [followup] = marked['followups'] as readonly { readonly triggerId: string }[]
    assert.ok(followup, 'the follow-up is marked on the ticket')

    // 交回一次：它回到 Eval（恰一候选），Ticket 不再拥有它。
    const handed = await cli(
      h.stateDir,
      portOf(h),
      ['trigger', 'handback', followup.triggerId, '--reason=It asks for a different change.'],
      worker
    )
    assert.equal(handed.exit, 0)
    assert.equal(resultOf(handed.envelope)['queued'], true)
    assert.equal('followups' in (await ticketOf(h, ticket.id, token)), false)
    assert.equal(h.handle.routerStatus().undecidedCandidates, 1)

    // 同一条只交回一次：第二次是固定 `already_handed_back`，不再多一条候选。
    const again = await cli(
      h.stateDir,
      portOf(h),
      ['trigger', 'handback', followup.triggerId, '--reason=Again.'],
      worker
    )
    assert.equal(again.exit, 2)
    assert.equal((again.envelope as { error?: { code?: string } }).error?.code, 'already_handed_back')
    assert.equal(h.handle.routerStatus().undecidedCandidates, 1)

    // 评估只发生一次：交回的那条成为新工作（第二张 Ticket），没有第三张。
    await h.handle.passOnce()
    await h.handle.passOnce()
    const ids = h.handle.snapshot().tickets?.map((item) => item.id) ?? []
    assert.equal(ids.length, 2)
    assert.equal(h.handle.routerStatus().undecidedCandidates, 0)
    await h.handle.passOnce()
    assert.deepEqual(h.handle.snapshot().tickets?.map((item) => item.id) ?? [], ids)
  } finally {
    await h.cleanup()
  }
})

test('gives a human wake the human slot when the normal slots are full, and keeps a new launch out of it', async () => {
  const h = await openFollowup({ maxWorkers: 1 })
  try {
    await settle(h)
    const [first] = h.handle.snapshot().tickets ?? []
    assert.ok(first)
    const token = readApiToken(h.stateDir)
    /** 跑到 worktree 里的 worker 终端数（Router 的终端不算）。 */
    const workers = (): number =>
      h.runtime.calls.launchAgent.filter((spec) => !spec.workspace.path.endsWith('/superagent-router'))
        .length
    assert.equal(workers(), 1, 'the first ticket runs on the only normal slot')

    // 第二个 Thread 上点名 agent：Ticket 建好了，但普通槽已满，新的 launch 拿不到槽——人类槽不借给它。
    h.notifications.push(THIRD_NOTIFICATION)
    await h.handle.pollOnce()
    await h.handle.passOnce()
    await h.handle.passOnce()
    const ids = h.handle.snapshot().tickets?.map((item) => item.id) ?? []
    assert.equal(ids.length, 2)
    const second = ids.find((id) => id !== first.id)!
    assert.equal(workers(), 1, 'a new launch does not take the human slot')
    const pending = await ticketOf(h, second, token)
    assert.equal((pending['assignment'] as { state: string }).state, 'pending')
    assert.equal(inboxFiles(h.stateDir, second).includes('1.md'), false)

    // 人在这张 Ticket 的 Thread 上补一句：人的一次唤醒可以占那个人类槽，于是它真的跑起来。
    h.thirdComments.push(THIRD_FOLLOWUP)
    await h.handle.pollOnce()
    await h.handle.passOnce()
    await h.handle.passOnce()
    assert.equal(workers(), 2, 'the human wake took the human slot')
    const resumed = await ticketOf(h, second, token)
    assert.equal((resumed['assignment'] as { state: string }).state, 'running')
    const delivered = readFileSync(join(h.stateDir, 'inbox', second, '1.md'), 'utf8')
    assert.equal(delivered.includes(THIRD_FOLLOWUP.body), true)

    // 普通槽满（而且人类槽也用着）时，人对正在跑的 worker 的一次状态唤醒仍能投递。
    const firstView = await ticketOf(h, first.id, token)
    const worker = assignmentToken(h.stateDir, (firstView['assignment'] as { readonly id: string }).id)
    const reported = await cli(
      h.stateDir,
      portOf(h),
      ['report', '--state', 'waiting', '--summary', 'Waiting for the next request.'],
      worker
    )
    assert.equal(reported.exit, 0)
    const sentBefore = h.runtime.calls.sent.length
    const asked = await cli(h.stateDir, portOf(h), ['ticket', 'request-status', first.id], token)
    assert.equal(asked.exit, 0)
    assert.equal(resultOf(asked.envelope)['asked'], true)
    await h.handle.passOnce()
    assert.equal(
      h.runtime.calls.sent.slice(sentBefore).some((call) => call.text.includes('[superagent] #')),
      true,
      'the status turn was delivered while both slots are taken'
    )
  } finally {
    await h.cleanup()
  }
})

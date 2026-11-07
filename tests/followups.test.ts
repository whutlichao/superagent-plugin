// 人 follow-up 的归属（§P.2 的 `followups` 套件、§K.2 第 3 条、§D.1 Subscription）：
// 一条人写在已订阅 Thread 上的消息归该 Ticket 的 worker，**不会**被 Eval 再路由一次；
// 一条没有 Ticket 拥有的消息则照旧进 Eval。
//
// 跑在组合根上（真库 + 假 Orca 缝 + 假 CLI + 真临时目录，§P.1）：收信走真实的通知轮询与
// 订阅读取，投递看真的 inbox 文件与终端写入，候选看 Router 快照的未决计数。没有 sleep、
// 没有网络、没有对内层模块的 mock。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootPlugin, type BootHandle } from '../src/worker/boot.ts'
import { FakeCommands } from './support/fake-commands.ts'
import { FakeOrcaRuntime } from './support/fake-orca-runtime.ts'
import { COMMENT, NOTIFICATION, settingsOf } from './support/boot.ts'
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
  cleanup(): Promise<void>
}

/**
 * 起一次 boot：一条通知、一条点名评论、开了「接收未点名的评论」（否则 follow-up 会被
 * Source 的监听范围挡在 Gate 之前）。评论与通知列表是活的，测试可追加后再轮询。
 */
async function openFollowup(): Promise<FollowupHarness> {
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
  const settings = {
    ...settingsOf(stateDir),
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
    cleanup: async () => {
      await handle.shutdown()
      rmSync(stateDir, { recursive: true, force: true })
      rmSync(worktrees, { recursive: true, force: true })
    }
  }
}

/** 一条 Ticket 的 inbox 文件名（`0.md` 是作业文本，之后每条 Input 一个）。 */
function inboxFiles(stateDir: string, ticketId: string): string[] {
  return [...readdirSync(join(stateDir, 'inbox', ticketId))].sort()
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

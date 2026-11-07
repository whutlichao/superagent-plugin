// `read <resource>` 的读面（§G.2 的 read 行、§I.2 的「资源读取」行、§I.3 的五种 Feishu 读法、
// §G.1 的角色与限额、§O 的「无权限如实说」）：本票把 #36 / #22 已经在 kind 层实现的资源读取
// 接到同一个 handler 上，CLI 与 HTTP 都只调它。
//
// 断言面（每条都是「别的写法都算坏」）：
// - 每个资源名至少一条成功（§I.2 的八个 GitHub 形式 + §I.3 的五个 Feishu 形式）；
// - 分页：`--offset/--limit` 与资源自己的 `next` 都能推进，拼起来不重不漏；
// - 拒绝：`unknown_resource`、`refused`、`not_permitted_role`、`missing`、`too_large`；
// - 状态是状态：`forbidden` / `deleted` / `missing` 原样透出，绝不用空 items 冒充「没有内容」；
// - 角色矩阵：router/operator 全读；assignment 只读自己 Ticket 相关的资源。
//
// 不发网络：`gh` / `lark-cli` 都经 `FakeCommands`（§I.6），断言的是 argv 与返回形状。
import { describe, test } from 'orca/testing'
import assert from 'node:assert/strict'
import { FakeCommands, cliFailure } from './support/fake-commands.ts'
import { key } from '../src/worker/core/index.ts'
import type { Ticket, Trigger } from '../src/worker/core/index.ts'
import {
  READ_TEXT_DEFAULT_CHARS,
  READ_TEXT_MAX_CHARS,
  createReadTools,
  isSourceResource
} from '../src/worker/app/read.ts'
import type { ReadRefusal, ReadRequest, ReadTools, ReadView } from '../src/worker/app/read.ts'

const REPOSITORY = 'acme/widgets'
const CHAT = 'oc_chat'
const AT = '2026-11-09T12:00:00.000Z'
const CREATED = '1790000000000'
const SHA = '7241253bde5bcbbd0e3f7c278f5f0b9a0baa4eb1'

// ---------------------------------------------------------------- fixtures（真实 CLI 形状）

/** 一条 Issue（`/repos/:o/:r/issues/:n`）。 */
function issueJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 12,
    title: 'Login redirect loops',
    state: 'open',
    body: 'Signing in bounces back to /login.',
    html_url: 'https://github.com/acme/widgets/issues/12',
    created_at: '2026-11-07T03:20:00Z',
    updated_at: '2026-11-07T03:21:00Z',
    user: { login: 'alice', type: 'User' },
    ...overrides
  }
}

/** 一条 PR（`/repos/:o/:r/pulls/:n`）。 */
function pullJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 45,
    title: 'docs: describe the identity of the agent account',
    state: 'open',
    body: 'Clarifies the account paragraph.',
    html_url: 'https://github.com/acme/widgets/pull/45',
    created_at: '2026-11-07T04:00:00Z',
    updated_at: '2026-11-07T04:10:00Z',
    user: { login: 'alice', type: 'User' },
    merged: false,
    draft: false,
    head: { ref: 'docs/account', sha: SHA },
    base: { ref: 'main' },
    ...overrides
  }
}

/** 一条 Issue 会话评论（`/issues/:n/comments`）。 */
function commentJson(id: number, body = `comment ${id}`): Record<string, unknown> {
  return {
    id,
    user: { login: 'bob', type: 'User' },
    body,
    created_at: '2026-11-07T05:00:00Z',
    updated_at: '2026-11-07T05:00:00Z',
    html_url: `https://github.com/acme/widgets/issues/12#issuecomment-${id}`
  }
}

/** 一条评审评论（`/pulls/:n/comments`；根评论没有 `in_reply_to_id`）。 */
function reviewCommentJson(id: number, inReplyTo?: number): Record<string, unknown> {
  return {
    id,
    user: { login: 'bob', type: 'User' },
    body: `review comment ${id}`,
    created_at: '2026-11-07T05:00:00Z',
    updated_at: '2026-11-07T05:00:00Z',
    html_url: `https://github.com/acme/widgets/pull/45#discussion_r${id}`,
    path: 'docs/account.md',
    line: 12,
    ...(inReplyTo === undefined ? {} : { in_reply_to_id: inReplyTo })
  }
}

/** 一条评审（`/pulls/:n/reviews`）。 */
function reviewJson(id: number): Record<string, unknown> {
  return {
    id,
    user: { login: 'carol', type: 'User' },
    state: 'COMMENTED',
    body: `review ${id}`,
    submitted_at: '2026-11-07T06:00:00Z',
    commit_id: SHA,
    html_url: `https://github.com/acme/widgets/pull/45#pullrequestreview-${id}`
  }
}

/** 一次 `+messages-mget` 的输出。 */
function mget(rows: readonly Record<string, unknown>[]): string {
  return JSON.stringify({ messages: rows, total: rows.length })
}

/** `+messages-mget` 的一行。 */
function messageRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message_id: 'om_source',
    chat_id: CHAT,
    msg_type: 'text',
    create_time: CREATED,
    sender: { id: 'ou_alice', name: 'Alice', sender_type: 'user' },
    content: 'The original request',
    deleted: false,
    ...overrides
  }
}

/** `+threads-messages-list` 的一页。 */
function threadPage(rows: readonly Record<string, unknown>[], pageToken?: string): string {
  return JSON.stringify({
    messages: rows,
    total: rows.length,
    has_more: pageToken !== undefined,
    ...(pageToken === undefined ? {} : { page_token: pageToken })
  })
}

/** `+threads-messages-list` 的一行。 */
function threadRow(messageId: string, index: number): Record<string, unknown> {
  return {
    message_id: messageId,
    msg_type: 'text',
    create_time: String(Date.parse(AT) + index * 1000),
    sender: { id: 'ou_alice', name: 'Alice', sender_type: 'user' },
    content: `message ${messageId}`,
    deleted: false
  }
}

// ---------------------------------------------------------------- 宿主替身

/** 一条 Feishu Trigger（话题里的一条回复，字段与 `feishuTrigger` 产出的一致）。 */
function feishuTrigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: key('feishu', 'om_source'),
    source: 'feishu',
    threads: [{ source: 'feishu', id: `${CHAT}:om_root` }],
    actor: { source: 'feishu', id: 'ou_alice' },
    human: true,
    addressed: 'mention',
    at: AT,
    text: 'The original request',
    channel: {
      source: 'feishu',
      thread: `feishu:${CHAT}`,
      address: { chatId: CHAT, messageId: 'om_source' }
    },
    meta: {
      chatId: CHAT,
      messageId: 'om_source',
      direct: false,
      rootId: 'om_root',
      parentId: 'om_parent',
      threadId: 'omt_1'
    },
    ...overrides
  }
}

/** 一条 GitHub 评论 Trigger（Thread 是 `github:12`）。 */
function githubTrigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: 'trigger-gh',
    source: 'github',
    threads: [{ source: 'github', id: '12' }],
    actor: { source: 'github', id: 'alice' },
    human: true,
    addressed: 'mention',
    at: AT,
    text: 'please fix this',
    meta: { kind: 'comment', repository: REPOSITORY, issue: 12, commentId: 9001, updatedAt: AT },
    ...overrides
  }
}

/** 一张 Ticket：来源是那条 GitHub 评论，并跟随 PR 45。 */
function ticketOf(overrides: Partial<Ticket> = {}): Ticket {
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
    origin: { triggerId: 'trigger-gh', triggerIds: ['trigger-gh'] },
    follows: [{ thread: 'github:45', own: true }],
    ...overrides
  }
}

/** 另一张 Ticket：来源是别的 Thread，跟随别人的 PR，CI 看的是同一个提交。 */
function otherTicket(): Ticket {
  return ticketOf({
    id: 'ticket-other',
    origin: { triggerId: 'trigger-other', triggerIds: ['trigger-other'] },
    follows: [{ thread: 'github:77', own: true }]
  })
}

/** 另一张 Ticket 的来源 Trigger：Thread 77，CI 提交是 `SHA`。 */
function otherTrigger(): Trigger {
  return {
    ...githubTrigger(),
    id: 'trigger-other',
    threads: [{ source: 'github', id: '77' }],
    meta: { kind: 'ci', repository: REPOSITORY, branch: 'main', headSha: SHA, state: 'success' }
  }
}

/** 一条不属于任何 Ticket 的 GitHub Trigger（CI 那类：`meta.headSha` 说明它是哪一版）。 */
function ciTrigger(): Trigger {
  return {
    ...githubTrigger(),
    id: 'trigger-ci',
    threads: [{ source: 'github', id: 'ci:main' }],
    meta: { kind: 'ci', repository: REPOSITORY, branch: 'main', headSha: SHA, state: 'success' }
  }
}

/** 造一套读工具：命令端、Source 配置、Trigger 与 Ticket 都按用例给。 */
function readTools(options: {
  readonly commands: FakeCommands
  readonly triggers?: readonly Trigger[]
  readonly tickets?: readonly Ticket[]
  readonly github?: Record<string, unknown> | undefined
  readonly feishu?: Record<string, unknown> | undefined
}): ReadTools {
  const triggers = options.triggers ?? [feishuTrigger(), githubTrigger()]
  return createReadTools({
    commands: options.commands,
    sourceConfig: (kind) => {
      if (kind === 'github') {
        return 'github' in options
          ? options.github
          : { repository: REPOSITORY, cli: 'gh', pollSeconds: 60 }
      }
      if (kind === 'feishu') return 'feishu' in options ? options.feishu : { cli: 'lark-cli' }
      return undefined
    },
    trigger: (id) => triggers.find((trigger) => trigger.id === id),
    tickets: () => options.tickets ?? [ticketOf()]
  })
}

/** 跑一次读并断言它是成功。 */
async function readOk(tools: ReadTools, request: ReadRequest): Promise<ReadView> {
  const result = await tools.read(request)
  if (!result.ok) throw new Error(`expected a read, got ${result.code}: ${result.message}`)
  return result.result
}

/** 跑一次读并断言它是固定拒绝。 */
async function readRefusal(tools: ReadTools, request: ReadRequest): Promise<ReadRefusal> {
  const result = await tools.read(request)
  if (result.ok) throw new Error(`expected a refusal, got the status ${result.result.status}`)
  return result
}

/** 跑一次读并断言它是固定拒绝，返回它的码。 */
async function readRefused(tools: ReadTools, request: ReadRequest): Promise<string> {
  return (await readRefusal(tools, request)).code
}

/** GitHub 那一套脚本：Issue/PR 描述、评论页、评审页、评审线程、检查。 */
function githubCommands(options: { readonly issue?: Record<string, unknown> } = {}): FakeCommands {
  const cli = new FakeCommands()
  const json = (value: unknown): string => JSON.stringify(value)
  cli.script(['api', `repos/${REPOSITORY}/issues/12`], () => json(options.issue ?? issueJson()))
  for (const page of [1, 2]) {
    cli.script(
      ['api', `repos/${REPOSITORY}/issues/12/comments`, '--method', 'GET', '-f', 'per_page=20', '-f', `page=${page}`],
      () =>
        json(
          page === 1
            ? Array.from({ length: 20 }, (_, index) => commentJson(1000 + index))
            : [commentJson(2000), commentJson(2001)]
        )
    )
  }
  cli.script(['api', `repos/${REPOSITORY}/pulls/45`], () => json(pullJson()))
  // 评审线程读的是**分页**的 `/pulls/:n/comments`（`githubRead` 的 `pullComments`）。
  cli.script(
    ['api', `repos/${REPOSITORY}/pulls/45/comments`, '--paginate', '--method', 'GET', '-f', 'per_page=100'],
    () => json([reviewCommentJson(500), reviewCommentJson(501, 500)])
  )
  cli.script(
    ['api', `repos/${REPOSITORY}/pulls/45/comments`, '--method', 'GET', '-f', 'per_page=20', '-f', 'page=1'],
    () => json([reviewCommentJson(500), reviewCommentJson(501, 500)])
  )
  for (const page of [1, 2]) {
    cli.script(
      ['api', `repos/${REPOSITORY}/pulls/45/reviews`, '--method', 'GET', '-f', 'per_page=20', '-f', `page=${page}`],
      () => json(page === 1 ? [reviewJson(700)] : [])
    )
  }
  cli.script(['api', `repos/${REPOSITORY}/commits/${SHA}/check-runs`], () =>
    json([{ check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] }])
  )
  cli.script(['api', `repos/${REPOSITORY}/commits/${SHA}/statuses`], () => json([]))
  return cli
}

/** Feishu 那一套脚本：按 id 读、话题页（两页）。 */
function feishuCommands(): FakeCommands {
  const cli = new FakeCommands()
  cli.script(['im', '+messages-mget', '--as', 'bot', '--message-ids', 'om_source'], () =>
    mget([messageRow()])
  )
  cli.script(['im', '+messages-mget', '--as', 'bot', '--message-ids', 'om_root'], () =>
    mget([messageRow({ message_id: 'om_root', content: 'The topic root' })])
  )
  cli.script(['im', '+messages-mget', '--as', 'bot', '--message-ids', 'om_parent'], () =>
    mget([messageRow({ message_id: 'om_parent', content: 'The message before' })])
  )
  const threadArgs = ['im', '+threads-messages-list', '--as', 'bot', '--thread', 'omt_1', '--order', 'asc']
  // 第一页用 `once`：它的参数是第二页的前缀（`--page-token` 在后面），否则第二页会重读第一页。
  cli.script(
    [...threadArgs, '--page-size', '20'],
    () => threadPage([threadRow('om_root', 0), threadRow('om_source', 1)], 'page-2'),
    { once: true }
  )
  cli.script([...threadArgs, '--page-size', '20', '--page-token', 'page-2'], () =>
    threadPage([threadRow('om_later', 2)])
  )
  // `around`：更早一页（倒序）+ 更晚一页。
  const chatArgs = ['im', '+chat-messages-list', '--as', 'bot', '--chat-id', CHAT]
  cli.script([...chatArgs, '--order', 'desc', '--page-size', '6', '--end', AT], () =>
    threadPage([threadRow('om_source', 1), threadRow('om_root', 0)])
  )
  cli.script([...chatArgs, '--order', 'asc', '--page-size', '6', '--start', AT], () =>
    threadPage([threadRow('om_source', 1), threadRow('om_later', 2)])
  )
  return cli
}

/**
 * 把 `next`（资源名）原样交回继续读：两种 kind 都是这么推进的。游标不带页大小——
 * 想保持同一页大小就把 `--limit` 一起重复（`limit` 参数）。
 */
async function readNext(
  tools: ReadTools,
  view: ReadView,
  role: ReadRequest['role'] = 'router',
  limit?: number
): Promise<ReadView> {
  assert.notEqual(view.next, null, 'this read hands a next resource back')
  return readOk(tools, {
    resource: view.next as string,
    role,
    ...(limit === undefined ? {} : { limit })
  })
}

// ---------------------------------------------------------------- 每个资源名至少一条成功

describe('every GitHub resource of §I.2 reads through one handler', () => {
  test('github/issues/<n> reads the description as one message', async () => {
    const cli = githubCommands()
    const view = await readOk(readTools({ commands: cli }), { resource: 'github/issues/12', role: 'router' })
    assert.equal(view.kind, 'github')
    assert.equal(view.status, 'available')
    assert.equal(view.items.length, 1)
    assert.match(view.items[0]?.text ?? '', /Login redirect loops/)
    assert.match(view.items[0]?.text ?? '', /bounces back to \/login/)
    assert.equal(view.next, null)
    assert.equal(view.next_offset, null)
    // 读的仍是 kind 的那一份实现：一次 `gh api`，argv 数组（§I.4）。
    assert.deepEqual(cli.args[0], ['api', `repos/${REPOSITORY}/issues/12`])
  })

  test('github/issues/<n>/comments/<page> reads one page of comments and names the next page', async () => {
    const cli = githubCommands()
    const tools = readTools({ commands: cli })
    const first = await readOk(tools, { resource: 'github/issues/12/comments/1', role: 'router' })
    assert.equal(first.status, 'available')
    assert.equal(first.items.length, 20)
    assert.equal(first.next, 'github/issues/12/comments/2')
    const second = await readNext(tools, first)
    assert.deepEqual(second.items.map((item) => item.id), [
      'https://github.com/acme/widgets/issues/12#issuecomment-2000',
      'https://github.com/acme/widgets/issues/12#issuecomment-2001'
    ])
    // 不重不漏：两页的 id 没有交集。
    const ids = new Set([...first.items, ...second.items].map((item) => item.id))
    assert.equal(ids.size, first.items.length + second.items.length)
    assert.equal(second.next, null, 'a short page is the last page')
  })

  test('github/pulls/<n> reads the pull request description with its branches', async () => {
    const view = await readOk(readTools({ commands: githubCommands() }), {
      resource: 'github/pulls/45',
      role: 'router'
    })
    assert.equal(view.status, 'available')
    assert.equal(view.items.length, 1)
    assert.equal(view.body['head'], 'docs/account')
    assert.equal(view.body['base'], 'main')
  })

  test('github/pulls/<n>/comments/<page> reads inline review comments', async () => {
    const view = await readOk(readTools({ commands: githubCommands() }), {
      resource: 'github/pulls/45/comments/1',
      role: 'router'
    })
    assert.equal(view.status, 'available')
    assert.deepEqual(view.items.map((item) => item.path), ['docs/account.md', 'docs/account.md'])
    assert.equal(view.items[1]?.replyTo, '500', 'a reply names its review thread root')
  })

  test('github/pulls/<n>/reviews/<page> reads the reviews as messages', async () => {
    const view = await readOk(readTools({ commands: githubCommands() }), {
      resource: 'github/pulls/45/reviews/1',
      role: 'router'
    })
    assert.equal(view.status, 'available')
    assert.equal(view.items.length, 1)
    assert.equal(view.items[0]?.from, 'carol')
    assert.equal(view.next, null)
  })

  test('github/pulls/<n>/thread/<comment-id> reads the review thread root and its replies', async () => {
    const view = await readOk(readTools({ commands: githubCommands() }), {
      resource: 'github/pulls/45/thread/500',
      role: 'router'
    })
    assert.equal(view.status, 'available')
    assert.deepEqual(view.items.map((item) => item.replyTo ?? null), [null, '500'])
  })

  test('github/pulls/<n>/checks reads the checks of its head commit', async () => {
    const view = await readOk(readTools({ commands: githubCommands() }), {
      resource: 'github/pulls/45/checks',
      role: 'router'
    })
    assert.equal(view.status, 'available')
    assert.deepEqual(view.items, [], 'checks carry no messages')
    assert.equal(view.checks?.headSha, SHA)
    assert.equal(view.checks?.checks[0]?.name, 'build')
  })

  test('github/commits/<sha>/checks reads that commit', async () => {
    const view = await readOk(readTools({ commands: githubCommands() }), {
      resource: `github/commits/${SHA}/checks`,
      role: 'router'
    })
    assert.equal(view.status, 'available')
    assert.equal(view.checks?.headSha, SHA)
    assert.equal(view.next, null)
  })
})

describe('the five Feishu read forms of §I.3 read through the same handler', () => {
  const triggerId = key('feishu', 'om_source')

  test('feishu/<trigger>/message reads the trigger’s own message', async () => {
    const view = await readOk(readTools({ commands: feishuCommands() }), {
      resource: `feishu/${triggerId}/message`,
      role: 'router'
    })
    assert.equal(view.kind, 'feishu')
    assert.equal(view.status, 'available')
    assert.equal(view.items.length, 1)
    assert.equal(view.items[0]?.id, 'om_source')
    assert.equal(view.items[0]?.from, 'Alice')
  })

  test('feishu/<trigger>/root reads the topic root', async () => {
    const view = await readOk(readTools({ commands: feishuCommands() }), {
      resource: `feishu/${triggerId}/root`,
      role: 'router'
    })
    assert.equal(view.items[0]?.text, 'The topic root')
  })

  test('feishu/<trigger>/parent reads the message it answers', async () => {
    const view = await readOk(readTools({ commands: feishuCommands() }), {
      resource: `feishu/${triggerId}/parent`,
      role: 'router'
    })
    assert.equal(view.items[0]?.text, 'The message before')
    assert.equal(view.items[0]?.id, 'om_parent')
  })

  test('feishu/<trigger>/thread reads the topic and hands the next resource back', async () => {
    const tools = readTools({ commands: feishuCommands() })
    const first = await readOk(tools, { resource: `feishu/${triggerId}/thread`, role: 'router' })
    assert.equal(first.status, 'available')
    assert.deepEqual(first.items.map((item) => item.id), ['om_root', 'om_source'])
    assert.notEqual(first.next, null)
    const second = await readNext(tools, first)
    assert.deepEqual(second.items.map((item) => item.id), ['om_later'])
    assert.equal(second.next, null)
  })

  test('feishu/<trigger>/around reads the chat around the message', async () => {
    const view = await readOk(readTools({ commands: feishuCommands() }), {
      resource: `feishu/${triggerId}/around`,
      role: 'router'
    })
    assert.deepEqual(view.items.map((item) => item.id), ['om_root', 'om_source', 'om_later'])
  })
})

// ---------------------------------------------------------------- 分页

describe('paging: --offset/--limit and the resource’s own cursor both advance', () => {
  const triggerId = key('feishu', 'om_source')

  test('a text page defaults to 4000 characters and continues exactly where it stopped', async () => {
    const text = 'a'.repeat(READ_TEXT_DEFAULT_CHARS + 250)
    const cli = new FakeCommands()
    cli.script(['api', `repos/${REPOSITORY}/issues/12`], () =>
      JSON.stringify(issueJson({ title: '', body: text }))
    )
    const tools = readTools({ commands: cli })
    const first = await readOk(tools, { resource: 'github/issues/12', role: 'router' })
    assert.equal(first.items[0]?.text.length, READ_TEXT_DEFAULT_CHARS)
    assert.equal(first.items[0]?.truncated, true)
    assert.equal(first.items[0]?.chars, text.length)
    assert.equal(first.next_offset, READ_TEXT_DEFAULT_CHARS)
    const second = await readOk(tools, {
      resource: 'github/issues/12',
      role: 'router',
      offset: first.next_offset as number
    })
    assert.equal(second.next_offset, null, 'the last page ends the text')
    // 不重不漏：两页拼起来正好是全文。
    assert.equal(first.items[0]?.text + second.items[0]?.text, text)
  })

  test('a text page takes up to 8000 characters and refuses more', async () => {
    const cli = new FakeCommands()
    cli.script(['api', `repos/${REPOSITORY}/issues/12`], () => JSON.stringify(issueJson()))
    cli.script(['im', '+messages-mget', '--as', 'bot', '--message-ids', 'om_source'], () =>
      mget([messageRow({ content: 'b'.repeat(READ_TEXT_MAX_CHARS + 10) })])
    )
    const tools = readTools({ commands: cli })
    const long = await readOk(tools, {
      resource: `feishu/${triggerId}/message`,
      role: 'router',
      limit: READ_TEXT_MAX_CHARS
    })
    assert.equal(long.items[0]?.text.length, READ_TEXT_MAX_CHARS)
    assert.equal(long.next_offset, READ_TEXT_MAX_CHARS)
    assert.equal(
      await readRefused(tools, { resource: 'github/issues/12', role: 'router', limit: READ_TEXT_MAX_CHARS + 1 }),
      'invalid_value'
    )
  })

  test('an item page takes 20 by default, slices on --offset/--limit, and never repeats an item', async () => {
    const tools = readTools({ commands: githubCommands() })
    const whole = await readOk(tools, { resource: 'github/issues/12/comments/1', role: 'router' })
    assert.equal(whole.items.length, 20)
    assert.equal(whole.next, 'github/issues/12/comments/2')
    const sliced = await readOk(tools, {
      resource: 'github/issues/12/comments/1',
      role: 'router',
      offset: 18,
      limit: 5
    })
    assert.deepEqual(sliced.items.map((item) => item.id), whole.items.slice(18).map((item) => item.id))
    assert.equal(sliced.next_offset, null, 'nothing is left in this page')
    assert.equal(sliced.next, 'github/issues/12/comments/2', 'the resource cursor still advances')
    assert.equal(
      await readRefused(tools, { resource: 'github/issues/12/comments/1', role: 'router', limit: 51 }),
      'invalid_value'
    )
  })

  test('a Feishu page passes --limit as its page size, and the cursor it hands back resumes', async () => {
    const cli = new FakeCommands()
    const threadArgs = ['im', '+threads-messages-list', '--as', 'bot', '--thread', 'omt_1', '--order', 'asc']
    cli.script([...threadArgs, '--page-size', '10'], () => threadPage([threadRow('om_root', 0)], 'page-2'), {
      once: true
    })
    cli.script([...threadArgs, '--page-size', '10', '--page-token', 'page-2'], () =>
      threadPage([threadRow('om_source', 1)])
    )
    const tools = readTools({ commands: cli })
    const first = await readOk(tools, { resource: `feishu/${triggerId}/thread`, role: 'router', limit: 10 })
    assert.equal(cli.args[0]?.includes('--page-size'), true)
    const second = await readNext(tools, first, 'router', 10)
    assert.deepEqual(second.items.map((item) => item.id), ['om_source'])
    assert.equal(second.next, null)
    assert.equal(
      await readRefused(tools, { resource: `feishu/${triggerId}/thread`, role: 'router', offset: -1 }),
      'invalid_value'
    )
  })
})

// ---------------------------------------------------------------- 拒绝

describe('the read surface refuses before it pretends', () => {
  test('an unknown resource names the forms that work', async () => {
    const tools = readTools({ commands: githubCommands() })
    const result = await readRefusal(tools, { resource: 'github/comments/12', role: 'router' })
    assert.equal(result.code, 'unknown_resource')
    assert.match(result.values?.['forms'] ?? '', /github\/issues\/<number>/)
    assert.equal(await readRefused(tools, { resource: 'feishu/om_x/nope', role: 'router' }), 'unknown_resource')
    assert.equal(await readRefused(tools, { resource: 'overview', role: 'operator' }), 'unknown_resource')
    assert.equal(isSourceResource('overview'), false)
    assert.equal(isSourceResource('github/issues/12'), true)
  })

  test('a Feishu resource naming a Trigger this deployment never saw is missing', async () => {
    const tools = readTools({ commands: feishuCommands() })
    assert.equal(await readRefused(tools, { resource: 'feishu/om_unknown/message', role: 'router' }), 'missing')
  })

  test('a page bigger than one response can carry is too_large, not a silent cut', async () => {
    const cli = new FakeCommands()
    cli.script(['im', '+messages-mget', '--as', 'bot', '--message-ids', 'om_source'], () =>
      mget([messageRow({ content: 'c'.repeat(1024 * 1024 + 1) })])
    )
    const tools = readTools({ commands: cli })
    const result = await readRefusal(tools, {
      resource: `feishu/${key('feishu', 'om_source')}/message`,
      role: 'router'
    })
    assert.equal(result.code, 'too_large')
    assert.equal(result.values?.['limit'], String(1024 * 1024))
  })

  test('a disabled Source is unavailable, not an empty read', async () => {
    const tools = readTools({ commands: githubCommands(), github: undefined })
    assert.equal(await readRefused(tools, { resource: 'github/issues/12', role: 'router' }), 'unavailable')
    const feishuOff = readTools({ commands: feishuCommands(), feishu: { cli: '' } })
    assert.equal(
      await readRefused(feishuOff, { resource: `feishu/${key('feishu', 'om_source')}/message`, role: 'router' }),
      'unavailable'
    )
  })
})

// ---------------------------------------------------------------- 状态如实透出

describe('forbidden, deleted and missing are statuses, never an empty result', () => {
  test('GitHub 403/410/404 become explicit statuses', async () => {
    const cli = new FakeCommands()
    cli.fail('gh', ['api', `repos/${REPOSITORY}/issues/12`], cliFailure('gh', { code: 403 }))
    cli.fail('gh', ['api', `repos/${REPOSITORY}/pulls/45`], cliFailure('gh', { code: 410 }))
    cli.fail(
      'gh',
      ['api', `repos/${REPOSITORY}/pulls/45/reviews`, '--method', 'GET', '-f', 'per_page=20', '-f', 'page=1'],
      cliFailure('gh', { code: 404 })
    )
    const tools = readTools({ commands: cli })
    assert.equal((await readOk(tools, { resource: 'github/issues/12', role: 'router' })).status, 'forbidden')
    assert.equal((await readOk(tools, { resource: 'github/pulls/45', role: 'router' })).status, 'deleted')
    assert.equal((await readOk(tools, { resource: 'github/pulls/45/reviews/1', role: 'router' })).status, 'missing')
  })

  test('Feishu forbidden, deleted and missing keep their status and stay non-empty of explanation', async () => {
    const triggerId = key('feishu', 'om_source')
    for (const [message, expected] of [
      ['HTTP 403 permission denied', 'forbidden'],
      ['message withdrawn', 'deleted'],
      ['no such message', 'missing']
    ] as const) {
      const cli = new FakeCommands()
      cli.fail(
        'lark-cli',
        ['im', '+messages-mget', '--as', 'bot', '--message-ids', 'om_source'],
        cliFailure('lark-cli', { stderr: message })
      )
      const view = await readOk(readTools({ commands: cli }), {
        resource: `feishu/${triggerId}/message`,
        role: 'router'
      })
      assert.equal(view.status, expected)
      assert.deepEqual(view.items, [], 'no content is invented')
      assert.equal(view.body['status'], expected, 'the Source’s own body keeps the status too')
    }
  })
})

// ---------------------------------------------------------------- 角色矩阵

describe('the role matrix: router/operator read; assignment only its own ticket', () => {
  const triggerId = key('feishu', 'om_source')

  test('router and operator read every family', async () => {
    for (const role of ['router', 'operator'] as const) {
      const tools = readTools({ commands: githubCommands() })
      assert.equal((await readOk(tools, { resource: 'github/issues/12', role })).status, 'available')
      const feishu = readTools({ commands: feishuCommands() })
      assert.equal((await readOk(feishu, { resource: `feishu/${triggerId}/message`, role })).status, 'available')
    }
  })

  test('an assignment reads its own ticket’s issue, PR and Feishu thread', async () => {
    const tools = readTools({ commands: githubCommands(), triggers: [feishuTrigger(), githubTrigger()] })
    assert.equal(
      (await readOk(tools, { resource: 'github/issues/12', role: 'assignment', ticketId: 'ticket-own' })).status,
      'available'
    )
    assert.equal(
      (await readOk(tools, { resource: 'github/pulls/45', role: 'assignment', ticketId: 'ticket-own' })).status,
      'available'
    )
    // 这张 Ticket 的来源是一条 GitHub 消息，它读不到自己从未见过的 Feishu 会话；
    // 反过来，来源是 Feishu 的 Ticket 读得到那条 Thread。
    const feishuTicket = ticketOf({
      origin: { triggerId: triggerId, triggerIds: [triggerId] },
      follows: []
    })
    const feishuTools = readTools({ commands: feishuCommands(), tickets: [feishuTicket] })
    assert.equal(
      (
        await readOk(feishuTools, {
          resource: `feishu/${triggerId}/thread`,
          role: 'assignment',
          ticketId: 'ticket-own'
        })
      ).status,
      'available'
    )
  })

  test('another ticket’s resource is not_permitted_role, never a read', async () => {
    const tools = readTools({
      commands: githubCommands(),
      triggers: [githubTrigger(), otherTrigger()],
      tickets: [ticketOf(), otherTicket()]
    })
    assert.equal(
      await readRefused(tools, { resource: 'github/issues/77', role: 'assignment', ticketId: 'ticket-own' }),
      'not_permitted_role'
    )
    assert.equal(
      await readRefused(tools, {
        resource: `github/commits/${SHA}/checks`,
        role: 'assignment',
        ticketId: 'ticket-own'
      }),
      'not_permitted_role'
    )
  })

  test('an assignment may not read a resource no ticket claims', async () => {
    const tools = readTools({ commands: githubCommands() })
    assert.equal(
      await readRefused(tools, { resource: 'github/issues/999', role: 'assignment', ticketId: 'ticket-own' }),
      'refused'
    )
    assert.equal(
      await readRefused(tools, { resource: `feishu/${triggerId}/message`, role: 'assignment', ticketId: 'ticket-own' }),
      'refused'
    )
    // 没有 Ticket 的 assignment token 什么都读不到。
    assert.equal(
      await readRefused(tools, { resource: 'github/issues/12', role: 'assignment' }),
      'not_permitted_role'
    )
  })

  test('its own commit checks are readable when the ticket’s trigger names that sha', async () => {
    const ciTicket = ticketOf({
      origin: { triggerId: 'trigger-ci', triggerIds: ['trigger-ci'] },
      follows: []
    })
    const tools = readTools({
      commands: githubCommands(),
      triggers: [githubTrigger(), ciTrigger()],
      tickets: [ciTicket]
    })
    assert.equal(
      (
        await readOk(tools, {
          resource: `github/commits/${SHA}/checks`,
          role: 'assignment',
          ticketId: 'ticket-own'
        })
      ).status,
      'available'
    )
  })
})

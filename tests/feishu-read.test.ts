// Feishu 读面（§I.3「线程上下文」行、§H.17 的读侧）：一条 Trigger 的五种读法——单条消息、
// 话题根、它回复的那条、整条话题、它周围的聊天——都翻成统一的 `ContextMessage`，分页游标
// 原样交回；无权限与已删给出明确 `status`，绝不返回空结果冒充「没有内容」。
//
// 不发网络：所有 `lark-cli` 调用经 `FakeCommands`（§I.6），断言的是 argv 与返回形状，不是
// 内部实现；夹具字段取自 lark-cli 1.0.96 的输出契约（`+messages-mget` / `+threads-messages-list`
// / `+chat-messages-list`）。
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeCommands, cliFailure } from './support/fake-commands.ts'
import { key } from '../src/worker/core/index.ts'
import type { Trigger } from '../src/worker/core/index.ts'
import { createFeishuKind } from '../src/worker/sources/feishu/kind.ts'
import { feishuConfigSchema } from '../src/worker/sources/feishu/config.ts'
import {
  AROUND_OLDER_PAGE,
  AROUND_SIDE,
  FEISHU_READ_PAGE_SIZE,
  feishuFind,
  feishuRead,
  feishuThreadContext
} from '../src/worker/sources/feishu/read.ts'
import type { FeishuOne } from '../src/worker/sources/feishu/read.ts'

const CHAT = 'oc_chat'
const AT = '2026-11-09T12:00:00.000Z'
/** 夹具里的时刻（`create_time` 是 epoch 毫秒的字符串）。 */
const CREATED = '1790000000000'
const CONFIG = feishuConfigSchema.parse({ chats: [{ chatId: CHAT, listen: 'all' }] })

/** 一条 Trigger（话题里的一条回复；字段与 `feishuTrigger` 产出的一致）。 */
function triggerOf(meta: Record<string, unknown> = {}, overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: key('feishu', 'om_source'),
    source: 'feishu',
    threads: [{ source: 'feishu', id: `${CHAT}:om_root` }],
    actor: { source: 'feishu', id: 'ou_alice' },
    human: true,
    addressed: 'mention',
    at: AT,
    text: 'The original request',
    channel: { source: 'feishu', thread: `feishu:${CHAT}`, address: { chatId: CHAT, messageId: 'om_source' } },
    meta: {
      chatId: CHAT,
      messageId: 'om_source',
      direct: false,
      rootId: 'om_root',
      parentId: 'om_parent',
      threadId: 'omt_1',
      ...meta
    },
    ...overrides
  }
}

/** `+messages-mget` 的一行（真实输出的字段集合；`content` 是 CLI 渲染后的文本）。 */
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

/** `+messages-mget` 的一次输出。 */
function mget(rows: readonly Record<string, unknown>[]): string {
  return JSON.stringify({ messages: rows, total: rows.length })
}

/** `+chat-messages-list` 的一行（不带 `chat_id`：会话由调用方知道）。 */
function historyRow(messageId: string, index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message_id: messageId,
    msg_type: 'text',
    create_time: String(Date.parse(AT) + index * 1000),
    sender: { id: 'ou_alice', name: 'Alice', sender_type: 'user' },
    content: `message ${messageId}`,
    deleted: false,
    ...overrides
  }
}

/** 读一次并断言它是「一条消息」的形状。 */
async function readOne(options: Parameters<typeof feishuRead>[0]): Promise<FeishuOne> {
  const result = await feishuRead(options)
  assert.equal('message' in result, true, 'this read answers one message')
  return result as FeishuOne
}

describe('one message, its root and the message it answers', () => {
  test('each read names the message and its author, and asks lark-cli by message id only', async () => {
    const cli = new FakeCommands()
    cli.script(['im', '+messages-mget', '--as', 'bot', '--message-ids', 'om_source'], () =>
      mget([messageRow({ parent_id: 'om_parent' })])
    )
    const one = await readOne({
      host: cli,
      cli: 'lark-cli',
      trigger: triggerOf(),
      section: 'message'
    })
    assert.deepEqual(cli.args, [
      ['im', '+messages-mget', '--as', 'bot', '--message-ids', 'om_source', '--no-reactions']
    ])
    // 正文里的 @ 占位符换成名字；`from` 用发送者名字，没有名字才退回 open_id。
    const message = one.message
    assert.ok(message !== null)
    assert.deepEqual(
      { id: message.id, from: message.from, at: message.at },
      { id: 'om_source', from: 'Alice', at: new Date(Number(CREATED)).toISOString() }
    )
    assert.equal(one.status, 'available')
    // 它回复的那条消息记在 `replyTo` 上（`feishuTrigger` 的 meta.parentId 同一来源）。
    assert.equal(message.replyTo, 'om_parent')
    assert.equal(message.bot, undefined)
    assert.equal(message.deleted, undefined)
  })

  test('root and parent read the ids the Trigger retained, and say so when there are none', async () => {
    const cli = new FakeCommands()
    cli.script(['im', '+messages-mget', '--as', 'bot', '--message-ids', 'om_root'], () =>
      mget([messageRow({ message_id: 'om_root', content: 'The first message' })])
    )
    cli.script(['im', '+messages-mget', '--as', 'bot', '--message-ids', 'om_parent'], () =>
      mget([messageRow({ message_id: 'om_parent', content: 'The message answered' })])
    )
    const root = await readOne({ host: cli, cli: 'lark-cli', trigger: triggerOf(), section: 'root' })
    const parent = await readOne({ host: cli, cli: 'lark-cli', trigger: triggerOf(), section: 'parent' })
    assert.equal(root.message?.id, 'om_root')
    assert.equal(root.message?.text, 'The first message')
    assert.equal(parent.message?.text, 'The message answered')

    const without = new FakeCommands()
    const bare = triggerOf({ rootId: undefined, parentId: undefined, threadId: undefined })
    assert.equal((await readOne({ host: without, cli: 'lark-cli', trigger: bare, section: 'root' })).status, 'no_root')
    assert.equal((await readOne({ host: without, cli: 'lark-cli', trigger: bare, section: 'parent' })).status, 'no_parent')
    assert.deepEqual(without.calls, [], 'nothing is read when the Trigger names no root or parent')
  })

  test('a deleted message is a status with its content withheld, not an empty answer', async () => {
    const cli = new FakeCommands()
    cli.script(['im', '+messages-mget'], () => mget([messageRow({ deleted: true, content: 'secret' })]))
    const one = await readOne({ host: cli, cli: 'lark-cli', trigger: triggerOf(), section: 'message' })
    assert.equal(one.status, 'deleted')
    assert.equal(one.message?.deleted, true)
    // 已删消息的正文不展示（也不猜）。
    assert.equal(one.message?.text, '')
  })

  test('a message the CLI does not return is `missing`, and a malformed row is refused', async () => {
    const cli = new FakeCommands()
    cli.script(['im', '+messages-mget'], () => mget([]))
    const one = await readOne({ host: cli, cli: 'lark-cli', trigger: triggerOf(), section: 'message' })
    assert.equal(one.status, 'missing')
    assert.equal(one.message, null)

    // 畸形的行读不懂：状态是 `missing`（这条消息没有可读的内容），而不是把空结果当成功。
    const broken = new FakeCommands()
    broken.script(['im', '+messages-mget'], () => mget([{ message_id: 'om_source' }]))
    const unreadable = await readOne({ host: broken, cli: 'lark-cli', trigger: triggerOf(), section: 'message' })
    assert.equal(unreadable.status, 'missing')
    assert.equal(unreadable.message, null)
  })

  test('no permission and a withdrawn message are explicit statuses; anything else retries', async () => {
    const forbidden = new FakeCommands()
    forbidden.fail(
      'lark-cli',
      ['im', '+messages-mget'],
      cliFailure('lark-cli', { code: 99991672, stderr: '{"code":99991672,"msg":"permission denied"}' })
    )
    const denied = await readOne({ host: forbidden, cli: 'lark-cli', trigger: triggerOf(), section: 'message' })
    assert.equal(denied.status, 'forbidden')
    assert.equal(denied.message, null)

    const outside = new FakeCommands()
    outside.fail(
      'lark-cli',
      ['im', '+messages-mget'],
      cliFailure('lark-cli', { code: 230002, stderr: '{"code":230002,"msg":"Bot/User can NOT be out of the chat."}' })
    )
    assert.equal(
      (await readOne({ host: outside, cli: 'lark-cli', trigger: triggerOf(), section: 'message' })).status,
      'forbidden'
    )

    const withdrawn = new FakeCommands()
    withdrawn.fail(
      'lark-cli',
      ['im', '+messages-mget'],
      cliFailure('lark-cli', { code: 230011, stderr: '{"code":230011,"msg":"The message has been recalled."}' })
    )
    assert.equal(
      (await readOne({ host: withdrawn, cli: 'lark-cli', trigger: triggerOf(), section: 'message' })).status,
      'deleted'
    )

    // 限流、崩溃、没有业务码：抛错让调用方给出可重试的 unavailable。
    const busy = new FakeCommands()
    busy.fail(
      'lark-cli',
      ['im', '+messages-mget'],
      cliFailure('lark-cli', { code: 99991400, stderr: '{"code":99991400,"msg":"rate limited"}' })
    )
    await assert.rejects(
      readOne({ host: busy, cli: 'lark-cli', trigger: triggerOf(), section: 'message' }),
      /rate limited/
    )
  })
})

describe('a topic page', () => {
  test('reads the thread the Trigger names and hands back its cursor', async () => {
    const cli = new FakeCommands()
    cli.script(['im', '+threads-messages-list', '--as', 'bot', '--thread', 'omt_1'], () =>
      JSON.stringify({
        thread_id: 'omt_1',
        messages: [
          messageRow({ message_id: 'om_root', content: 'The first message', parent_id: undefined }),
          messageRow({ message_id: 'om_reply', parent_id: 'om_root', content: 'A reply' })
        ],
        has_more: true,
        page_token: 'a/b+next=',
        total: 2
      })
    )
    const page = await feishuRead({ host: cli, cli: 'lark-cli', trigger: triggerOf(), section: 'thread' })
    assert.equal('messages' in page, true)
    if (!('messages' in page)) return
    assert.deepEqual(cli.args, [
      [
        'im',
        '+threads-messages-list',
        '--as',
        'bot',
        '--thread',
        'omt_1',
        '--order',
        'asc',
        '--page-size',
        String(FEISHU_READ_PAGE_SIZE)
      ]
    ])
    assert.equal(page.status, 'available')
    assert.deepEqual(page.messages.map((message) => message.id), ['om_root', 'om_reply'])
    assert.equal(page.messages[1]?.replyTo, 'om_root')
    // 游标原样交回：下一次读带 `--page-token`。
    assert.equal(page.next, 'a/b+next=')

    const next = new FakeCommands()
    next.script(
      [
        'im',
        '+threads-messages-list',
        '--as',
        'bot',
        '--thread',
        'omt_1',
        '--order',
        'asc',
        '--page-size',
        String(FEISHU_READ_PAGE_SIZE),
        '--page-token',
        'a/b+next='
      ],
      () =>
      JSON.stringify({ thread_id: 'omt_1', messages: [messageRow({ message_id: 'om_third' })], has_more: false })
    )
    const second = await feishuRead({
      host: next,
      cli: 'lark-cli',
      trigger: triggerOf(),
      section: 'thread',
      cursor: 'a/b+next='
    })
    assert.ok('messages' in second, 'a thread read answers a page')
    assert.equal(second.next, undefined)
    assert.deepEqual(next.args, [
      [
        'im',
        '+threads-messages-list',
        '--as',
        'bot',
        '--thread',
        'omt_1',
        '--order',
        'asc',
        '--page-size',
        String(FEISHU_READ_PAGE_SIZE),
        '--page-token',
        'a/b+next='
      ]
    ])
  })

  test('skips and counts a row it cannot read, and refuses pagination that does not advance', async () => {
    const cli = new FakeCommands()
    cli.script(['im', '+threads-messages-list'], () =>
      JSON.stringify({
        thread_id: 'omt_1',
        messages: [messageRow({ message_id: 'om_reply' }), { message_id: 'om_odd', content: 'no sender' }],
        has_more: false
      })
    )
    const page = await feishuRead({ host: cli, cli: 'lark-cli', trigger: triggerOf(), section: 'thread' })
    assert.ok('messages' in page, 'a thread read answers a page')
    assert.deepEqual(page.messages.map((message) => message.id), ['om_reply'])
    assert.deepEqual((page.body as { skipped?: number }).skipped, 1)

    const stuck = new FakeCommands()
    stuck.script(['im', '+threads-messages-list'], () =>
      JSON.stringify({ thread_id: 'omt_1', messages: [], has_more: true })
    )
    await assert.rejects(
      feishuRead({ host: stuck, cli: 'lark-cli', trigger: triggerOf(), section: 'thread' }),
      /did not advance/
    )
  })

  test('a message outside a topic has no thread, and its Thread still reads the chat around it', async () => {
    const bare = triggerOf({ threadId: undefined, rootId: undefined })
    const none = new FakeCommands()
    assert.equal(
      (await feishuRead({ host: none, cli: 'lark-cli', trigger: bare, section: 'thread' })).status,
      'no_thread'
    )
    assert.deepEqual(none.calls, [])

    // Admission 走 kind 的 `read`：没有话题时退化成「聊天邻居」，并标明 `chat_neighbours`。
    const cli = new FakeCommands()
    cli.next(
      'lark-cli',
      aroundEarlierArgs(AROUND_SIDE + 1),
      JSON.stringify({ messages: [historyRow('om_before', -1)], has_more: false })
    )
    cli.next(
      'lark-cli',
      aroundLaterArgs(AROUND_SIDE + 1),
      JSON.stringify({ messages: [historyRow('om_source', 0), historyRow('om_after', 1)], has_more: false })
    )
    const context = feishuThreadContext('lark-cli')
    const part = await context.read(cli, bare, 'thread', undefined, CONFIG, new AbortController().signal)
    assert.equal(part.status, 'chat_neighbours')
    assert.deepEqual(part.messages.map((message) => message.id), ['om_before', 'om_source', 'om_after'])
    // 邻居窗口只有一页：不把整段群历史分页读进来。
    assert.equal(part.next, undefined)
  })

  test('a neighbour window that cannot be read keeps its explicit status', async () => {
    const cli = new FakeCommands()
    cli.fail(
      'lark-cli',
      aroundEarlierArgs(AROUND_SIDE + 1),
      cliFailure('lark-cli', { code: 99991672, stderr: '{"code":99991672,"msg":"permission denied"}' })
    )
    const context = feishuThreadContext('lark-cli')
    const part = await context.read(
      cli,
      triggerOf({ threadId: undefined, rootId: undefined }),
      'thread',
      undefined,
      CONFIG,
      new AbortController().signal
    )
    // 不是 `chat_neighbours`：那会假装「读到了邻居」，而实际是被权限挡住。
    assert.equal(part.status, 'forbidden')
    assert.deepEqual(part.messages, [])
  })

  test('root and parent go through the kind contract with the same statuses', async () => {
    const cli = new FakeCommands()
    cli.script(['im', '+messages-mget', '--as', 'bot', '--message-ids', 'om_root'], () =>
      mget([messageRow({ message_id: 'om_root', content: 'The first message' })])
    )
    const context = feishuThreadContext('lark-cli')
    const part = await context.read(cli, triggerOf(), 'root', undefined, CONFIG, new AbortController().signal)
    assert.equal(part.status, 'available')
    assert.deepEqual(part.messages.map((message) => message.id), ['om_root'])
    assert.equal(context.messageId(triggerOf()), 'om_source')
    // 没有图片能力的 kind 不实现 `images`；Feishu 有。
    assert.ok(context.images !== undefined, 'Feishu lists the images in a message')
    assert.deepEqual(context.images('see ![Image](img_one)'), ['img_one'])
  })
})

/** 首屏「更早」那一页的 argv。 */
function aroundEarlierArgs(size: number, cursor?: string): string[] {
  return [
    'im',
    '+chat-messages-list',
    '--as',
    'bot',
    '--chat-id',
    CHAT,
    '--order',
    'desc',
    '--page-size',
    String(size),
    ...(cursor === undefined ? [] : ['--page-token', cursor]),
    '--end',
    AT
  ]
}

/** 首屏「更晚」那一页的 argv。 */
function aroundLaterArgs(size: number): string[] {
  return [
    'im',
    '+chat-messages-list',
    '--as',
    'bot',
    '--chat-id',
    CHAT,
    '--order',
    'asc',
    '--page-size',
    String(size),
    '--start',
    AT
  ]
}

describe('the chat around a message', () => {
  test('reads five before, the message and five after, then pages backwards by time', async () => {
    const cli = new FakeCommands()
    // 更早的一页：倒序，含消息自己（服务端的 end_time 含同一秒）。
    cli.next(
      'lark-cli',
      aroundEarlierArgs(AROUND_SIDE + 1),
      JSON.stringify({
        messages: [0, -1, -2, -3, -4, -5].map((index) => historyRow(`om_${Math.abs(index)}`, index)),
        has_more: true,
        page_token: 'older'
      })
    )
    // 更晚的一页：正序，重读消息自己（按 id 去重）。
    cli.next(
      'lark-cli',
      aroundLaterArgs(AROUND_SIDE + 1),
      JSON.stringify({
        messages: [
          historyRow('om_0', 0),
          historyRow('om_after_1', 1),
          historyRow('om_after_2', 2)
        ],
        has_more: false
      })
    )
    const page = await feishuRead({ host: cli, cli: 'lark-cli', trigger: triggerOf(), section: 'around' })
    assert.ok('messages' in page, 'an around read answers a page')
    assert.equal(page.status, 'available')
    // 五条更早 + 自己 + 三条更晚；同一秒里的重复按 id 去掉一次。
    assert.deepEqual(page.messages.map((message) => message.id), [
      'om_5',
      'om_4',
      'om_3',
      'om_2',
      'om_1',
      'om_0',
      'om_after_1',
      'om_after_2'
    ])
    // 更早的一页交出游标；`page_token` 就是下一次读的 cursor。
    assert.equal(page.next, 'older')

    // 第二页：更早的十条，倒序读回再正过来。
    // 倒序返回：最新的一条在前（`-6` 是三者里最晚的），读回来再正过来。
    cli.next(
      'lark-cli',
      aroundEarlierArgs(AROUND_OLDER_PAGE, 'older'),
      JSON.stringify({ messages: [-6, -7, -8].map((index) => historyRow(`om_${-index}`, index)), has_more: false })
    )
    const older = await feishuRead({
      host: cli,
      cli: 'lark-cli',
      trigger: triggerOf(),
      section: 'around',
      cursor: 'older'
    })
    assert.ok('messages' in older, 'an around read answers a page')
    assert.deepEqual(older.messages.map((message) => message.id), ['om_8', 'om_7', 'om_6'])
    assert.equal(older.next, undefined)
  })

  test('a message with no time cannot read its neighbourhood', async () => {
    const cli = new FakeCommands()
    await assert.rejects(
      feishuRead({ host: cli, cli: 'lark-cli', trigger: triggerOf({}, { at: 'not a time' }), section: 'around' }),
      /no time/i
    )
    assert.deepEqual(cli.calls, [])
  })
})

describe('find: the three Feishu inputs become search terms', () => {
  test('a message id, a chat id and a link each name their tokens, never a guessed Thread key', () => {
    // 消息 id：没有 chat 就推不出 `<chat>:<root>`（Thread key 是「群 + 根消息」）。
    assert.deepEqual(feishuFind('om_40eb06e7b84dc71c03e009ad3c754195'), {
      threads: [],
      terms: ['om_40eb06e7b84dc71c03e009ad3c754195']
    })
    // 群 id：只说明是哪个群，说明不了根消息；配置也表达不了「这个 oc_ 是私聊」，所以不产出伪 key。
    assert.deepEqual(feishuFind('oc_092f0100fe59c35995727db1039777a8'), {
      threads: [],
      terms: ['oc_092f0100fe59c35995727db1039777a8']
    })
    // 会话链接：保留完整 URL，并从里面取出群 id（两者都去重）。
    const chatLink = 'https://applink.feishu.cn/client/chat/open?openChatId=oc_092f0100fe59c35995727db1039777a8'
    assert.deepEqual(feishuFind(chatLink), {
      threads: [],
      terms: [chatLink, 'oc_092f0100fe59c35995727db1039777a8']
    })
    // 消息链接：token 不透明，只作为精确 URL 的搜索词。
    const messageLink = 'https://applink.feishu.cn/client/message/link/open?token=t30'
    assert.deepEqual(feishuFind(messageLink), { threads: [], terms: [messageLink] })
  })

  test('ids inside prose, duplicated tokens and trailing punctuation are normalised', () => {
    const found = feishuFind('请看 om_123 和 om_123，还有 https://applink.feishu.cn/client/message/link/open?token=t.')
    assert.deepEqual(found.threads, [])
    assert.deepEqual(found.terms, [
      '请看 om_123 和 om_123，还有 https://applink.feishu.cn/client/message/link/open?token=t.',
      'om_123',
      'https://applink.feishu.cn/client/message/link/open?token=t'
    ])
    // 不含任何 Feishu 标识的普通查询原样作为搜索词（与 GitHub 的 find 一致）。
    assert.deepEqual(feishuFind('login test'), { threads: [], terms: ['login test'] })
    assert.deepEqual(feishuFind('   '), { threads: [], terms: [] })
  })

  test('the kind exposes the read surface and the search mapping', () => {
    const kind = createFeishuKind('lark-cli')
    assert.ok(kind.threadContext !== undefined, 'Feishu has a Thread context')
    assert.ok(kind.find !== undefined, 'Feishu maps search inputs')
    assert.deepEqual(kind.find('om_x'), { threads: [], terms: ['om_x'] })
  })
})

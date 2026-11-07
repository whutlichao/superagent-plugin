// Feishu Source 的读取面（§I.3 的事件流 / 历史回填 / 话题轮询 / Trigger 翻译四行）：
// 一条消息一个 Trigger、自身消息丢弃、编辑与删除按更新时间生成新 id、Thread 是「群 + 根消息」
// 而私聊是「群 + direct」；事件流就绪行之后才可用，非零退出按 1 s→60 s 退避重启，连续失败让
// `feishu` 健康项报错；回填只取游标之后；话题在水位线内才轮询。
//
// 不发网络：所有 `lark-cli` 调用都经 `CommandsHost`，测试用 `FakeCommands`（§I.6）；
// 事件夹具是 `tests/fixtures/cli/feishu/message-event.jsonl` 的真实输出片段。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readRepoFile, readRepoJson } from './support/repo.ts'
import { FakeCommands } from './support/fake-commands.ts'
import { key } from '../src/worker/core/index.ts'
import type { OutboundMessage, Trigger } from '../src/worker/core/index.ts'
import { feishuChatsKey, feishuCursorKey, feishuTopicsKey, sourceLabelsKey, threadSeenKey } from '../src/worker/app/kv.ts'
import { cliFailure, FakeStream } from './support/fake-commands.ts'
import { openBoot } from './support/boot.ts'
import { bootPlugin } from '../src/worker/boot.ts'
import { feishuConfigSchema } from '../src/worker/sources/feishu/config.ts'
import { createFeishuKind } from '../src/worker/sources/feishu/kind.ts'
import type { SyncContext } from '../src/worker/sources/kind.ts'
import { FakeHealthBoard } from './support/health-board.ts'
import { openStore } from '../src/worker/app/store.ts'
import { savedSettingsVersion } from '../src/worker/app/settings.ts'
import {
  SYNC_FIRST_DELAY_MS,
  SYNC_MAX_DELAY_MS,
  createPolicySync
} from '../src/worker/app/policy-sync.ts'
import type { PolicyBlock } from '../src/worker/policy/index.ts'
import { createFeishuApi } from '../src/worker/sources/feishu/api.ts'
import {
  POLL_HORIZON_MS,
  createFeishuBackfill,
  refreshChatNames,
  withinHorizon
} from '../src/worker/sources/feishu/poll.ts'
import type { FeishuKeys } from '../src/worker/sources/feishu/poll.ts'
import { wordCount, checkedImText } from '../src/worker/infra/text.ts'
import {
  feishuEventOf,
  feishuHistoryOf,
  feishuThreadId,
  feishuTrigger,
  feishuTriggerId
} from '../src/worker/sources/feishu/translate.ts'
import {
  CONSUMER_ARGS,
  MAX_EVENT_BYTES,
  MAX_RESTART_MS,
  MIN_RESTART_MS,
  READY_TIMEOUT_MS,
  WATCHDOG_MS,
  consumerRetry,
  createFeishuStream
} from '../src/worker/sources/feishu/stream.ts'

/** 夹具里的消息（`event consume` 的一行 NDJSON）。 */
const EVENT_FIXTURE = 'tests/fixtures/cli/feishu/message-event.jsonl'
const EVENT_EXPECTED = 'tests/fixtures/cli/feishu/message-event.expected.json'

/** 一条事件（夹具里的那一行）。 */
function fixtureEvent(): Record<string, unknown> {
  const line = readRepoFile(EVENT_FIXTURE)
    .split('\n')
    .find((entry) => entry.trim().length > 0)
  assert.ok(line !== undefined, 'the fixture holds at least one line')
  return JSON.parse(line) as Record<string, unknown>
}

/** 夹具里的机器人身份：它自己的 mention 用 `ou_` open_id，事件里也带 app id。 */
const BOT = { botId: 'ou_b155184d1e73cbfb8973e5a9e698e74f2', appId: 'cli_a1b2c3d4e5f6a7b8' }

/** Source 的 kv 键：键名只活在 `app/kv.ts`，组合根把它们注入（§D.3）。 */
const FEISHU_KEYS: FeishuKeys = {
  chats: feishuChatsKey,
  labels: sourceLabelsKey('feishu'),
  cursor: feishuCursorKey,
  topics: feishuTopicsKey,
  seen: threadSeenKey
}

test('the recorded live event becomes exactly the Trigger its expected file describes', () => {
  const event = fixtureEvent()
  const expected = readRepoJson<{ trigger: Record<string, unknown> & { idRecipe: string } }>(
    EVENT_EXPECTED
  )
  const { idRecipe, ...expectedTrigger } = expected.trigger
  const message = feishuEventOf(event)
  assert.ok(message !== undefined, 'the event parses')
  const trigger = feishuTrigger(message, BOT)
  assert.deepEqual(trigger, expectedTrigger)
  // 同一条消息在任何读取路径上都是同一个 id（§I.3 Trigger 行）：期望文件写下的 recipe。
  assert.equal(idRecipe, `key('feishu', '${String(event['message_id'])}')`)
  assert.equal(trigger?.id, feishuTriggerId(String(event['message_id'])))
  assert.equal(trigger?.id, key('feishu', String(event['message_id'])))
})

test('a message the bot wrote itself is dropped instead of becoming a Trigger', () => {
  const event = fixtureEvent()
  // 机器人自己的消息可能以 open_id 或 app id 出现（上游同）。
  for (const sender of [BOT.botId, BOT.appId]) {
    const message = feishuEventOf({ ...event, sender_id: sender, sender_type: 'bot' })
    assert.ok(message !== undefined)
    assert.equal(feishuTrigger(message, BOT), undefined, `sender ${sender} is the bot itself`)
  }
})

test('a direct message is addressed direct, and its Thread is the chat plus direct', () => {
  const event = fixtureEvent()
  const message = feishuEventOf({
    ...event,
    chat_type: 'p2p',
    mentions: [],
    root_id: undefined,
    reply_to: undefined
  })
  assert.ok(message !== undefined)
  const trigger = feishuTrigger(message, BOT)
  assert.equal(trigger?.addressed, 'direct')
  assert.deepEqual(trigger?.threads, [{ source: 'feishu', id: `${String(event['chat_id'])}:direct` }])
  assert.equal(trigger?.meta['direct'], true)
  assert.deepEqual(trigger?.channel?.address, {
    chatId: event['chat_id'],
    messageId: event['message_id'],
    direct: 'true'
  })
  // 话题键：没有根消息时话题根就是消息自己；私聊则固定是 `direct`。
  assert.equal(feishuThreadId(String(event['chat_id']), undefined, String(event['message_id'])), `${String(event['chat_id'])}:${String(event['message_id'])}`)
  assert.equal(feishuThreadId(String(event['chat_id']), 'om_root', 'om_msg', true), `${String(event['chat_id'])}:direct`)
})

test('an edit or a deletion reuses the message id plus its update time, so it is a new event', () => {
  const group = { chatId: 'oc_history_chat', direct: false }
  const edited = feishuHistoryOf({ ...historyMessage(), updated: true, update_time: '1790000005000' }, group)
  const deleted = feishuHistoryOf({ ...historyMessage(), deleted: true, update_time: '1790000006000' }, group)
  const plain = feishuHistoryOf(historyMessage(), group)
  assert.ok(edited !== undefined && deleted !== undefined && plain !== undefined)
  const plainTrigger = feishuTrigger(plain, BOT)
  const editedTrigger = feishuTrigger(edited, BOT)
  const deletedTrigger = feishuTrigger(deleted, BOT)
  assert.equal(plainTrigger?.id, feishuTriggerId('om_history_1'))
  // 编辑/删除：按 update_time 生成新 id（§I.3 Trigger 行），重复读到同一版本仍是同一个 id。
  assert.equal(editedTrigger?.id, feishuTriggerId('om_history_1', '1790000005000'))
  assert.equal(deletedTrigger?.id, feishuTriggerId('om_history_1', '1790000006000'))
  assert.notEqual(editedTrigger?.id, plainTrigger?.id)
  assert.notEqual(deletedTrigger?.id, plainTrigger?.id)
  assert.equal(
    feishuTrigger(
      feishuHistoryOf({ ...historyMessage(), deleted: true, update_time: '1790000006000' }, group) as never,
      BOT
    )?.id,
    deletedTrigger?.id
  )
  // 页面能用 meta 说明这条 Trigger 是编辑或删除。
  assert.equal(editedTrigger?.meta['edited'], true)
  assert.equal(deletedTrigger?.meta['deleted'], true)
})

/** 一条 `+chat-messages-list` 的消息（真实输出的字段集合，`content` 是 CLI 渲染后的文本）。 */
function historyMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message_id: 'om_history_1',
    msg_type: 'text',
    create_time: '1790000000000',
    sender: { id: 'ou_125b59ba923ce1b64c7aa6d8257e43cf', sender_type: 'user', name: 'Alice' },
    content: '@Superagent please look at this',
    deleted: false,
    mentions: [{ id: BOT.botId, key: '@_user_1', name: 'Superagent' }],
    ...overrides
  }
}

test('mention keys in the text are replaced with the names the event carries', () => {
  const message = feishuEventOf({
    ...fixtureEvent(),
    content: '@_user_1 please fix it',
    mentions: [{ id: BOT.botId, key: '@_user_1', name: 'Superagent' }]
  })
  assert.ok(message !== undefined)
  assert.equal(feishuTrigger(message, BOT)?.text, '@Superagent please fix it')
})

test('a group message that does not mention the bot carries no addressed value', () => {
  const event = fixtureEvent()
  const message = feishuEventOf({ ...event, mentions: [] })
  assert.ok(message !== undefined)
  const trigger = feishuTrigger(message, BOT) as Trigger
  assert.equal(trigger.addressed, undefined)
  assert.equal(trigger.meta['mentioned'], false)
})

test('the configuration fills its defaults and rejects a chat it cannot listen to', async () => {
  const { feishuConfigSchema } = await import('../src/worker/sources/feishu/config.ts')
  // 缺省：没有 CLI、没有群、私聊接收、其他群不接收（§I.3 配置行）。
  assert.deepEqual(feishuConfigSchema.parse({}), {
    cli: '',
    chats: [],
    directMessages: true,
    otherChats: 'none'
  })
  // strict：未知键拒绝（注册表按 safeParse 失败禁用实例）。
  assert.equal(feishuConfigSchema.safeParse({ surprise: 1 }).success, false)
  // 每个群只有两种接收方式。
  const bad = feishuConfigSchema.safeParse({
    chats: [{ chatId: 'oc_abc123', listen: 'everything' }]
  })
  assert.equal(bad.success, false)
  if (!bad.success) assert.deepEqual(bad.issues[0]?.path, ['chats', 0, 'listen'])
  // 群 id 是 `oc_` 形态；重复的群是配置错误。
  assert.equal(feishuConfigSchema.safeParse({ chats: [{ chatId: 'nope', listen: 'all' }] }).success, false)
  const duplicated = feishuConfigSchema.safeParse({
    chats: [
      { chatId: 'oc_abc123', listen: 'all' },
      { chatId: 'oc_abc123', listen: 'mentions' }
    ]
  })
  assert.equal(duplicated.success, false)
  // 完整配置原样保留（群名是可选的显示值）。
  assert.deepEqual(
    feishuConfigSchema.parse({
      cli: '/opt/lark-cli',
      chats: [{ chatId: 'oc_abc123', name: 'Bugs', listen: 'all' }],
      directMessages: false,
      otherChats: 'mentions'
    }),
    {
      cli: '/opt/lark-cli',
      chats: [{ chatId: 'oc_abc123', name: 'Bugs', listen: 'all' }],
      directMessages: false,
      otherChats: 'mentions'
    }
  )
})

test('the kind listens to the chats it is told to listen to, and nothing else', async () => {
  const { feishuKind } = await import('../src/worker/sources/feishu/kind.ts')
  const { feishuConfigSchema } = await import('../src/worker/sources/feishu/config.ts')
  const config = feishuConfigSchema.parse({
    chats: [
      { chatId: 'oc_all', listen: 'all' },
      { chatId: 'oc_mentions', listen: 'mentions' }
    ]
  })
  const scopeOf = (meta: Record<string, unknown>): unknown =>
    feishuKind.scope?.({ source: 'feishu', meta }, config)
  // 列出「全部消息」的群：没点名也监听，并且算观察。
  assert.deepEqual(scopeOf({ chatId: 'oc_all', direct: false }), {
    listened: true,
    observed: true,
    row: 'oc_all'
  })
  // 列出「仅 @」的群：监听，但不观察。
  assert.deepEqual(scopeOf({ chatId: 'oc_mentions', direct: false }), {
    listened: true,
    observed: false,
    row: 'oc_mentions'
  })
  // 没列出的群：默认不接收。
  assert.deepEqual(scopeOf({ chatId: 'oc_other', direct: false }), {
    listened: false,
    reason: 'chat_not_allowed'
  })
  // `otherChats: 'mentions'` 时接收未列出群里点名机器人的消息。
  const other = feishuConfigSchema.parse({ otherChats: 'mentions' })
  assert.deepEqual(feishuKind.scope?.({ source: 'feishu', meta: { chatId: 'oc_other', direct: false } }, other), {
    listened: true,
    observed: false,
    row: 'other'
  })
  // 私聊由 `directMessages` 开关决定。
  assert.deepEqual(scopeOf({ chatId: 'oc_dm', direct: true }), {
    listened: true,
    observed: false,
    row: 'direct'
  })
  assert.deepEqual(
    feishuKind.scope?.(
      { source: 'feishu', meta: { chatId: 'oc_dm', direct: true } },
      feishuConfigSchema.parse({ directMessages: false })
    ),
    { listened: false, reason: 'direct_messages_not_allowed' }
  )
})

test('the kind claims exactly the stream and history health entries the design names', async () => {
  const { feishuKind } = await import('../src/worker/sources/feishu/kind.ts')
  const { SourceRegistry, EMPTY_SOURCE_SETTINGS } = await import('../src/worker/sources/registry.ts')
  const { FakeHealthBoard } = await import('./support/health-board.ts')
  const board = new FakeHealthBoard()
  const registry = new SourceRegistry({ health: board, settings: () => EMPTY_SOURCE_SETTINGS })
  const unregister = registry.register(feishuKind)
  assert.equal(feishuKind.kind, 'feishu')
  assert.deepEqual(feishuKind.health, ['feishu', 'history'])
  assert.equal(board.held('feishu'), true)
  assert.equal(board.held('history'), true)
  // 没有存过实例时，注册表里仍有一条默认实例（面板要能显示它）。
  assert.equal(registry.instances().length, 1)
  assert.equal(registry.instances()[0]?.kind, 'feishu')
  unregister()
  assert.equal(board.held('feishu'), false)
  assert.equal(board.held('history'), false)
})

/**
 * 轮询到条件成立（§P.1 第 4 条：不 sleep，轮询带上限）。事件流的读侧是异步的：让出微任务
 * 直到回调落地，而不是等一个固定的毫秒数。
 */
async function until(check: () => boolean, turns = 200): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (check()) return
    await Promise.resolve()
  }
  if (!check()) throw new Error(`condition did not hold within ${turns} microtask turns`)
}

/** 一个记录收到 Trigger 的宿主（`SourceContext` 的最小读取面）。 */
function streamHost() {
  const received: Trigger[] = []
  const state = new Map<string, unknown>()
  const health: { entry: string; state: string; detail?: string }[] = []
  const patches: { id: string; meta: Record<string, unknown> }[] = []
  return {
    received,
    state,
    health,
    patches,
    port: {
      receive: (trigger: Trigger) => {
        received.push(trigger)
        return 'stored' as const
      },
      state: {
        get: (key: string) => state.get(key),
        set: (key: string, value: unknown) => {
          state.set(key, value)
        },
        delete: (key: string) => state.delete(key)
      },
      threads: {
        describe: () => undefined,
        patch: (ref: { source: string; id: string }, meta: Record<string, unknown>) => {
          patches.push({ id: ref.id, meta })
        }
      },
      report: (entry: string, value: { state: string; detail?: string }) => {
        health.push({ entry, ...value })
      }
    }
  }
}

/**
 * 手工推进的调度器（§P.1 第 4 条：不 sleep）。记录每次调度的毫秒数，`advance` 只跑到期的
 * 一次性回调——事件流的退避重启、看门狗与就绪超时都由测试推进。
 */
function scheduledWork() {
  const pending: { at: number; run: () => void; cancelled: boolean }[] = []
  const delays: number[] = []
  const cancelled: number[] = []
  let now = 0
  return {
    delays,
    cancelled,
    /** 退避重启的记录：去掉就绪超时与看门狗这两个固定周期，只留重启的等待。 */
    get retries(): number[] {
      return delays.filter((delay) => delay !== READY_TIMEOUT_MS && delay !== WATCHDOG_MS)
    },
    schedule(run: () => void, milliseconds: number): () => void {
      delays.push(milliseconds)
      const entry = { at: now + milliseconds, run, cancelled: false }
      pending.push(entry)
      return () => {
        entry.cancelled = true
        cancelled.push(milliseconds)
      }
    },
    async advance(milliseconds: number): Promise<void> {
      now += milliseconds
      for (;;) {
        const due = pending
          .filter((entry) => !entry.cancelled && entry.at <= now)
          .sort((left, right) => left.at - right.at)[0]
        if (due === undefined) return
        due.cancelled = true
        due.run()
        await Promise.resolve()
        await Promise.resolve()
      }
    }
  }
}

/** 跑一轮事件流（`enabled` 与信号由用例控制）。 */
function openStream(
  options: {
    readonly cli?: FakeCommands
    readonly host?: ReturnType<typeof streamHost>
    readonly work?: ReturnType<typeof scheduledWork>
    readonly stateDir?: string
  } = {}
) {
  const commands = options.cli ?? new FakeCommands()
  const h = options.host ?? streamHost()
  const work = options.work ?? scheduledWork()
  const controller = new AbortController()
  const enabled = { current: true }
  const stream = createFeishuStream({
    commands,
    cli: 'lark-cli',
    bot: BOT,
    host: h.port,
    keys: { chats: feishuChatsKey },
    enabled: () => enabled.current,
    signal: controller.signal,
    schedule: work.schedule
  })
  const running = stream.run()
  /** 停机并等循环结束（每个用例收尾都要走它，否则循环会接着重启）。 */
  const finish = async (): Promise<void> => {
    controller.abort()
    await running
  }
  return { commands, host: h, work, enabled, controller, stream, running, finish }
}

test('the consumer waits for the ready line before it accepts events', async () => {
  const cli = new FakeCommands()
  const child = cli.scriptStream('lark-cli', CONSUMER_ARGS)
  const open = openStream({ cli })
  await until(() => child.attached)
  // 就绪行之前到达的行不算数（§I.3：`[event] ready` 之后才算可用）。
  child.out(JSON.stringify(fixtureEvent()))
  await Promise.resolve()
  assert.deepEqual(open.host.received, [])
  child.err('[event] ready event_key=im.message.receive_v1')
  await until(() => open.host.health.some((entry) => entry.state === 'ready'))
  // 行可能先到、就绪行后到（真实进程不会，但读侧不该丢事件顺序）：再推一次才收。
  child.out(JSON.stringify(fixtureEvent()))
  await until(() => open.host.received.length === 1)
  assert.equal(open.host.received[0]?.id, key('feishu', String(fixtureEvent()['message_id'])))
  assert.deepEqual(open.host.state.get(feishuChatsKey), { oc_092f0100fe59c35995727db1039777a8: false })
  await open.finish()
})

test('an event over the one MiB cap is dropped and reported instead of parsed', async () => {
  const cli = new FakeCommands()
  const child = cli.scriptStream('lark-cli', CONSUMER_ARGS)
  const open = openStream({ cli })
  await until(() => child.attached)
  child.err('[event] ready')
  await until(() => open.host.health.some((entry) => entry.state === 'ready'))
  const oversized = JSON.stringify({ ...fixtureEvent(), content: 'x'.repeat(MAX_EVENT_BYTES) })
  child.out(oversized)
  await until(() => open.host.health.some((entry) => (entry.detail ?? '').includes('1 MiB')))
  assert.deepEqual(open.host.received, [], 'an oversized event never becomes a Trigger')
  child.err('[event] ready')
  child.out(JSON.stringify(fixtureEvent()))
  await until(() => open.host.received.length === 1)
  await open.finish()
})

test('a non-zero exit restarts with a doubling backoff up to a minute, and three failures mark feishu error', async () => {
  const cli = new FakeCommands()
  const exits = [3, 4, 5, 6]
  for (const code of exits) cli.scriptStream('lark-cli', CONSUMER_ARGS).exit(code)
  const open = openStream({ cli })
  // 每一次非零退出都会排一次退避；前三次失败把 `feishu` 报成 error。
  await until(() => open.work.retries.length >= 1)
  assert.deepEqual(open.work.retries, [1000])
  await open.work.advance(1000)
  await until(() => open.commands.streams.length >= 2)
  assert.deepEqual(open.work.retries, [1000, 2000])
  await open.work.advance(2000)
  await until(() => open.host.health.some((entry) => entry.entry === 'feishu' && entry.state === 'error'))
  assert.deepEqual(open.work.retries, [1000, 2000, 4000])
  // 封顶一分钟由 `consumerRetry` 单独守（下一次失败也只会等 8 s，翻倍到 60 s 为止）。
  await until(() => open.commands.streams.length >= 3)
  await open.finish()
  assert.ok(open.work.retries.every((delay) => delay <= MAX_RESTART_MS))
})

test('the restart delay resets to one second after a run that stayed up a minute', async () => {
  // 纯函数：同上游语义（§I.3「1 s→60 s 退避」）。
  assert.equal(consumerRetry(undefined, 0), 1000)
  assert.equal(consumerRetry(1000, 500), 2000)
  assert.equal(consumerRetry(32_000, 500), 60_000)
  assert.equal(consumerRetry(60_000, 500), 60_000)
  assert.equal(consumerRetry(32_000, 60_000), 1000)
})

test('disabling the source stops the consumer within five seconds and receives nothing more', async () => {
  const cli = new FakeCommands()
  const child = cli.scriptStream('lark-cli', CONSUMER_ARGS)
  const open = openStream({ cli })
  await until(() => child.attached)
  child.err('[event] ready')
  await until(() => open.host.health.some((entry) => entry.state === 'ready'))
  open.enabled.current = false
  // 看门狗每 5 s 看一次实例开关（§I.3「禁用后 5 s 内停」）。
  await open.work.advance(5000)
  await until(() => child.stopped)
  await open.finish()
  assert.equal(open.host.received.length, 0)
  assert.equal(open.work.delays.includes(MIN_RESTART_MS), false, 'a disabled source is not restarted')
})

test('a consumer that never says ready is stopped after forty-five seconds and counts as a failure', async () => {
  const cli = new FakeCommands()
  const child = cli.scriptStream('lark-cli', CONSUMER_ARGS)
  const open = openStream({ cli })
  await until(() => child.attached)
  await open.work.advance(READY_TIMEOUT_MS)
  await until(() => child.stopped)
  assert.ok(open.work.delays.includes(READY_TIMEOUT_MS), 'the ready timeout is scheduled')
  await until(() => open.work.delays.includes(consumerRetry(undefined, 0)))
  await open.finish()
})

test('a stop signal ends the consumer without scheduling a restart', async () => {
  const cli = new FakeCommands()
  const child = cli.scriptStream('lark-cli', CONSUMER_ARGS)
  const open = openStream({ cli })
  await until(() => child.attached)
  child.err('[event] ready')
  await open.finish()
  assert.equal(child.stopped, true, 'aborting stops the child')
})

/** 回填用的固定时刻：`2026-11-07T03:26:00Z`（与支持夹具同一刻，便于比对游标）。 */
const ROUND_AT = '2026-11-07T03:26:00.000Z'

/** 一条 `+chat-messages-list` 的页面（真实输出的字段集合：`messages` / `total` / `has_more` / `page_token`）。 */
function historyPage(messages: readonly Record<string, unknown>[], next?: string): string {
  return JSON.stringify({
    messages,
    total: messages.length,
    has_more: next !== undefined,
    ...(next === undefined ? {} : { page_token: next })
  })
}

/** 一条群历史消息（脱敏后的中性值；时刻落在回填时刻前一分钟，才在水位线内）。 */
function backfillMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message_id: 'om_backfill_1',
    msg_type: 'text',
    create_time: String(Date.parse(ROUND_AT) - 60_000),
    sender: { id: 'ou_alice', sender_type: 'user', name: 'Alice' },
    content: 'please fix the failing build',
    deleted: false,
    ...overrides
  }
}

/** 一套装好的回填（假 CLI + 记录收到的 Trigger 的宿主）。 */
function openBackfill(
  options: {
    readonly cli?: FakeCommands
    readonly host?: ReturnType<typeof streamHost>
    readonly config?: Record<string, unknown>
    readonly cursor?: string
    readonly chats?: Record<string, boolean>
    readonly topics?: Record<string, { at: string; rootId: string }>
    readonly seen?: Record<string, string[]>
    readonly subscribed?: () => readonly { ref: { source: string; id: string }; lastAt?: string; subscriptions: readonly string[]; meta: Record<string, unknown> }[]
    readonly ticket?: (id: string) => { ended?: { at: string } } | undefined
  } = {}
) {
  const commands = options.cli ?? new FakeCommands()
  const h = options.host ?? streamHost()
  const config = feishuConfigSchema.parse(
    options.config ?? { cli: 'lark-cli', chats: [{ chatId: 'oc_all', listen: 'all' }] }
  )
  if (options.cursor !== undefined) h.state.set(feishuCursorKey('oc_all'), options.cursor)
  if (options.chats !== undefined) h.state.set(feishuChatsKey, options.chats)
  if (options.topics !== undefined) h.state.set(feishuTopicsKey('oc_all'), options.topics)
  for (const [threadKey, ids] of Object.entries(options.seen ?? {})) {
    h.state.set(threadSeenKey(threadKey), ids)
  }
  const backfill = createFeishuBackfill({
    api: createFeishuApi(commands, 'lark-cli'),
    bot: BOT,
    config,
    host: h.port,
    keys: FEISHU_KEYS,
    now: () => Date.parse(ROUND_AT),
    ...(options.subscribed === undefined ? {} : { subscribed: options.subscribed }),
    ...(options.ticket === undefined ? {} : { ticket: options.ticket })
  })
  return { commands, host: h, config, backfill }
}

test('the first backfill round only records where reading starts', async () => {
  const { commands, host, backfill } = openBackfill()
  const result = await backfill.round()
  assert.deepEqual(result.failures, [])
  assert.deepEqual(host.received, [], 'nothing is read before there is a cursor')
  assert.equal(commands.calls.length, 0, 'no CLI call on the first round')
  // 游标是这一轮开始前 5 s（重叠一点：迟到的消息不会漏，重复的 id 由引擎幂等）。
  assert.equal(host.state.get(feishuCursorKey('oc_all')), '2026-11-07T03:25:55.000Z')
  assert.deepEqual(host.health.at(-1), { entry: 'history', state: 'ready', detail: 'Chat history recovered' })
})

test('the next round reads only what came after the cursor, then advances it', async () => {
  const cli = new FakeCommands()
  const cursor = '2026-11-07T03:25:55.000Z'
  cli.script(['im', '+chat-messages-list', '--as', 'bot', '--chat-id', 'oc_all'], () =>
    historyPage([backfillMessage({ thread_id: 'omt_1' })])
  )
  const { host, backfill } = openBackfill({ cli, cursor })
  const result = await backfill.round()
  assert.equal(result.triggers, 1)
  const read = cli.calls[0]
  assert.ok(read !== undefined)
  // 只回填游标之后的：`--start` 就是游标，结束时刻是这一轮的开始。
  assert.deepEqual(read.args, [
    'im',
    '+chat-messages-list',
    '--as',
    'bot',
    '--chat-id',
    'oc_all',
    '--order',
    'asc',
    '--page-size',
    '50',
    '--start',
    cursor,
    '--end',
    ROUND_AT
  ])
  assert.equal(host.received.length, 1)
  assert.equal(host.received[0]?.text, 'please fix the failing build')
  assert.equal(host.received[0]?.addressed, undefined)
  // 读成功才推进游标（下一轮从这一轮开始前 5 s 接着读）。
  assert.equal(host.state.get(feishuCursorKey('oc_all')), '2026-11-07T03:25:55.000Z')
  // 话题被记下来：话题轮询的候选集（§I.3 话题轮询行）。
  assert.deepEqual(host.state.get(feishuTopicsKey('oc_all')), {
    omt_1: { at: '2026-11-07T03:25:00.000Z', rootId: 'om_backfill_1' }
  })
})

test('a failing page keeps the cursor where it was and the next round retries', async () => {
  const cli = new FakeCommands()
  const cursor = '2026-11-07T03:25:55.000Z'
  cli.fail(
    'lark-cli',
    ['im', '+chat-messages-list'],
    cliFailure('lark-cli', { code: 99991400, exitCode: 1 }),
    { once: true }
  )
  const { host, backfill } = openBackfill({ cli, cursor })
  const failed = await backfill.round()
  assert.equal(failed.failures.length, 1)
  assert.match(failed.failures[0] ?? '', /lark-cli/)
  assert.equal(host.state.get(feishuCursorKey('oc_all')), cursor, 'the cursor did not move')
  assert.deepEqual(host.health.at(-1)?.state, 'error', 'a failed page is a history error until it succeeds')
  // 下一轮重读同一段（游标没动）并成功。
  cli.script(['im', '+chat-messages-list'], () => historyPage([backfillMessage()]))
  const retried = await backfill.round()
  assert.deepEqual(retried.failures, [])
  assert.equal(host.received.length, 1)
  assert.deepEqual(host.health.at(-1), { entry: 'history', state: 'ready', detail: 'Chat history recovered' })
})

test('a page token that does not advance ends the round instead of looping forever', async () => {
  const cli = new FakeCommands()
  // 两页都给出同一个 page_token：分页卡住了（真实 CLI 会 `meta.pagination.complete=false`）。
  cli.script(['im', '+chat-messages-list'], () => historyPage([backfillMessage()], 'same'))
  cli.script(['im', '+chat-messages-list'], () => historyPage([backfillMessage({ message_id: 'om_backfill_2' })], 'same'))
  const { host, backfill } = openBackfill({ cli, cursor: '2026-11-07T03:25:55.000Z' })
  const result = await backfill.round()
  assert.equal(result.failures.length, 1)
  assert.match(result.failures[0] ?? '', /pagination did not advance/)
  assert.equal(host.state.get(feishuCursorKey('oc_all')), '2026-11-07T03:25:55.000Z')
})

test('direct chats the event stream has seen are read too, unless direct messages are off', async () => {
  const cli = new FakeCommands()
  cli.script(['im', '+chat-messages-list', '--as', 'bot', '--chat-id', 'oc_dm'], () =>
    historyPage([backfillMessage({ message_id: 'om_dm_1' })])
  )
  const direct = openBackfill({
    cli,
    cursor: '2026-11-07T03:25:55.000Z',
    config: { cli: 'lark-cli', chats: [{ chatId: 'oc_all', listen: 'mentions' }] },
    chats: { oc_dm: true }
  })
  direct.host.state.set(feishuCursorKey('oc_dm'), '2026-11-07T03:25:55.000Z')
  await direct.backfill.round()
  const dmTriggers = direct.host.received.filter((trigger) => trigger.meta['direct'] === true)
  assert.equal(dmTriggers.length, 1)
  assert.deepEqual(dmTriggers[0]?.threads, [{ source: 'feishu', id: 'oc_dm:direct' }])

  // 关掉私聊之后不再读它（配置说了不算数就不读）。
  const offCli = new FakeCommands()
  offCli.script(['im', '+chat-messages-list', '--as', 'bot', '--chat-id', 'oc_all'], () =>
    historyPage([])
  )
  const off = openBackfill({
    cli: offCli,
    cursor: '2026-11-07T03:25:55.000Z',
    config: { cli: 'lark-cli', chats: [{ chatId: 'oc_all', listen: 'mentions' }], directMessages: false },
    chats: { oc_dm: true }
  })
  off.host.state.set(feishuCursorKey('oc_dm'), '2026-11-07T03:25:55.000Z')
  await off.backfill.round()
  assert.deepEqual(off.host.received, [])
  assert.deepEqual(
    off.commands.calls.filter((call) => call.args.includes('oc_dm')),
    [],
    'direct messages are off: the DM chat is never read'
  )
})

test('a history message the bot wrote itself never becomes a Trigger', async () => {
  const cli = new FakeCommands()
  cli.script(['im', '+chat-messages-list'], () =>
    historyPage([
      backfillMessage({
        message_id: 'om_own_1',
        sender: { id: 'cli_own_app', sender_type: 'bot', open_bot_id: BOT.botId }
      })
    ])
  )
  const { host, backfill } = openBackfill({ cli, cursor: '2026-11-07T03:25:55.000Z' })
  await backfill.round()
  assert.deepEqual(host.received, [])
})

/** 一个订阅了 Feishu 的 Thread（组合根从线程仓储读出的只读形状）。 */
function subscribedThread(
  id: string,
  subscriptions: readonly string[] = []
): { ref: { source: string; id: string }; subscriptions: readonly string[]; meta: Record<string, unknown> } {
  return { ref: { source: 'feishu', id }, subscriptions, meta: {} }
}

/** 一条话题里的消息（`+threads-messages-list` 的一项）。 */
function threadMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message_id: 'om_root',
    msg_type: 'text',
    create_time: String(Date.parse(ROUND_AT) - 3_600_000),
    sender: { id: 'ou_alice', sender_type: 'user', name: 'Alice' },
    content: 'the failing test is back',
    deleted: false,
    thread_id: 'omt_1',
    ...overrides
  }
}

/** 一条话题里的页面。 */
function threadPage(messages: readonly Record<string, unknown>[]): string {
  return JSON.stringify({ messages, total: messages.length, has_more: false })
}

test('a subscribed topic is polled and only replies nobody has seen become Triggers', async () => {
  const cli = new FakeCommands()
  cli.script(['im', '+chat-messages-list', '--as', 'bot', '--chat-id', 'oc_all'], () => historyPage([]))
  cli.script(['im', '+threads-messages-list', '--as', 'bot', '--thread', 'omt_1'], () =>
    threadPage([
      threadMessage(),
      threadMessage({
        message_id: 'om_reply_2',
        root_id: 'om_root',
        content: 'still failing on main',
        create_time: String(Date.parse(ROUND_AT) - 60_000)
      })
    ])
  )
  const { host, backfill } = openBackfill({
    cli,
    cursor: '2026-11-07T03:25:55.000Z',
    topics: { omt_1: { at: '2026-11-07T03:25:00.000Z', rootId: 'om_root' } },
    // 根消息已经读过（回填时记下来的），所以只有新回复出 Trigger。
    seen: { 'oc_all:om_root': ['om_root'] },
    subscribed: () => [subscribedThread('oc_all:om_root')]
  })
  const result = await backfill.round()
  assert.equal(result.topics, 1)
  assert.deepEqual(
    host.received.map((trigger) => trigger.text),
    ['still failing on main']
  )
  // 话题的 Thread 键是「群 + 根消息」，读成功清掉 pollError。
  assert.deepEqual(host.patches.at(-1), { id: 'oc_all:om_root', meta: { pollError: undefined } })
  assert.deepEqual(host.state.get(threadSeenKey('oc_all:om_root')), ['om_root', 'om_reply_2'])
})

test('a topic is polled while it has a live subscription or is inside the two-week horizon', async () => {
  // 纯判定（§I.3：活订阅 + 最后一条 Trigger/Ticket 结束后两周）。
  const at = Date.parse(ROUND_AT)
  const days = (count: number): string => new Date(at - count * 24 * 3600_000).toISOString()
  assert.equal(withinHorizon({ now: at, subscribed: true, lastAt: days(400), endedAt: [] }), true)
  assert.equal(withinHorizon({ now: at, subscribed: false, lastAt: days(13), endedAt: [] }), true)
  assert.equal(withinHorizon({ now: at, subscribed: false, lastAt: days(15), endedAt: [] }), false)
  assert.equal(withinHorizon({ now: at, subscribed: false, lastAt: days(400), endedAt: [days(3)] }), true)
  assert.equal(withinHorizon({ now: at, subscribed: false, lastAt: days(400), endedAt: [days(20)] }), false)
  assert.equal(withinHorizon({ now: at, subscribed: false, lastAt: undefined, endedAt: [] }), true)
  assert.equal(
    withinHorizon({ now: at, subscribed: false, lastAt: days(15), endedAt: [] }) === false &&
      POLL_HORIZON_MS === 14 * 24 * 3600_000,
    true,
    'the horizon is two weeks'
  )

  // 端到端：一个活订阅的老话题还会轮询；一个没有订阅、超出水位线的话题不再轮询（并从候选集删掉）。
  const cli = new FakeCommands()
  cli.script(['im', '+chat-messages-list'], () => historyPage([]))
  cli.script(['im', '+threads-messages-list', '--as', 'bot', '--thread', 'omt_live'], () =>
    threadPage([threadMessage({ message_id: 'om_live_reply', root_id: 'om_live_root' })])
  )
  const { host, backfill } = openBackfill({
    cli,
    cursor: '2026-11-07T03:25:55.000Z',
    topics: {
      omt_live: { at: days(200), rootId: 'om_live_root' },
      omt_stale: { at: days(30), rootId: 'om_stale_root' }
    },
    seen: { 'oc_all:om_live_root': ['om_live_root'], 'oc_all:om_stale_root': ['om_stale_root'] },
    subscribed: () => [subscribedThread('oc_all:om_live_root', ['ticket-1'])],
    ticket: (id) => (id === 'ticket-1' ? { ended: { at: days(200) } } : undefined)
  })
  await backfill.round()
  assert.deepEqual(
    cli.calls.filter((call) => call.args.includes('--thread')).map((call) => call.args[call.args.indexOf('--thread') + 1]),
    ['omt_live'],
    'the stale topic is not polled'
  )
  assert.deepEqual(Object.keys(host.state.get(feishuTopicsKey('oc_all')) as object), ['omt_live'])
})

test('a failing topic read leaves a pollError on that Thread, and success clears it', async () => {
  const cli = new FakeCommands()
  cli.script(['im', '+chat-messages-list'], () => historyPage([]))
  cli.fail(
    'lark-cli',
    ['im', '+threads-messages-list', '--as', 'bot', '--thread', 'omt_1'],
    cliFailure('lark-cli', { code: 99991400, exitCode: 1 }),
    { once: true }
  )
  cli.script(['im', '+threads-messages-list', '--as', 'bot', '--thread', 'omt_1'], () =>
    threadPage([threadMessage()])
  )
  const { host, backfill } = openBackfill({
    cli,
    cursor: '2026-11-07T03:25:55.000Z',
    topics: { omt_1: { at: '2026-11-07T03:25:00.000Z', rootId: 'om_root' } },
    seen: { 'oc_all:om_root': ['om_root'] }
  })
  const failed = await backfill.round()
  assert.equal(failed.failures.length, 1)
  assert.match(String(host.patches.at(-1)?.meta['pollError']), /lark-cli exited with code 1/)
  assert.equal(host.patches.at(-1)?.id, 'oc_all:om_root')
  assert.deepEqual(host.health.at(-1)?.state, 'error')
  // 下一轮成功：同一个 Thread 上清掉错误。
  const retried = await backfill.round()
  assert.deepEqual(retried.failures, [])
  assert.deepEqual(host.patches.at(-1), { id: 'oc_all:om_root', meta: { pollError: undefined } })
})

test('the chat name refresh writes the labels the panel reads, and keeps the old list on failure', async () => {
  const cli = new FakeCommands()
  cli.script(['im', '+chat-list', '--as', 'bot'], () =>
    JSON.stringify({
      chats: [
        { chat_id: 'oc_all', name: 'Build alerts', chat_mode: 'group' },
        { chat_id: 'oc_nameless', chat_mode: 'group' }
      ],
      has_more: false
    })
  )
  const host = streamHost()
  host.state.set(sourceLabelsKey('feishu'), { oc_old: 'Old name' })
  const names = await refreshChatNames({ api: createFeishuApi(cli, 'lark-cli'), host: host.port, keys: FEISHU_KEYS })
  assert.deepEqual(names, { oc_all: 'Build alerts' })
  assert.deepEqual(host.state.get(sourceLabelsKey('feishu')), { oc_all: 'Build alerts' })

  // 读失败：抛错，上一次的名单原样保留（显示名不该越读越少）。
  const broken = new FakeCommands()
  broken.fail('lark-cli', ['im', '+chat-list'], cliFailure('lark-cli', { exitCode: 1 }))
  const kept = streamHost()
  kept.state.set(sourceLabelsKey('feishu'), { oc_all: 'Build alerts' })
  await assert.rejects(
    refreshChatNames({ api: createFeishuApi(broken, 'lark-cli'), host: kept.port, keys: FEISHU_KEYS }),
    /lark-cli exited with code 1/
  )
  assert.deepEqual(kept.state.get(sourceLabelsKey('feishu')), { oc_all: 'Build alerts' })
})

/** Feishu 的 setup 探针脚本（`auth status` + 机器人信息）。 */
function scriptFeishuIdentity(cli: FakeCommands, options: { botReady?: boolean } = {}): void {
  cli.script('lark-cli auth status', () =>
    JSON.stringify({
      appId: BOT.appId,
      brand: 'feishu',
      identities: { bot: { status: options.botReady === false ? 'missing' : 'ready' } },
      identity: 'bot'
    })
  )
  cli.script(['api', 'GET', '/open-apis/bot/v3/info'], () =>
    JSON.stringify({ bot: { open_id: BOT.botId, app_name: 'Superagent' } })
  )
}

/** 一份带 Feishu 的设置（GitHub 侧保持可用，这样 `setupMissing` 只反映 Feishu 的问题）。 */
function settingsWithFeishu(
  stateDir: string,
  feishu: Record<string, unknown>,
  policySources: Record<string, unknown> = { github: { allowed: [{ id: 'alice' }] } }
): Record<string, unknown> {
  return {
    stateDir,
    agent: 'pi',
    baseRepo: '/repos/widgets',
    githubCommitEmail: '1+acme-agent@users.noreply.github.com',
    executor: { agent: 'pi', maxWorkers: 2, confirmDelivery: false },
    sources: {
      github: { enabled: true, config: { repository: 'acme/widgets', cli: 'gh', pollSeconds: 60 } },
      feishu
    },
    policy: { sources: policySources }
  }
}

test('a configured Feishu source consumes events, runs a round, and stops on shutdown', async () => {
  let child: FakeStream | undefined
  const config = {
    cli: 'lark-cli',
    chats: [{ chatId: 'oc_all', listen: 'all' }],
    // 夹具事件来自另一个群：`mentions` 让这条点名机器人的消息被监听（§I.3 配置行）。
    otherChats: 'mentions'
  }
  const harness = await openBoot({
    boot: async (stateDir, runtime, commands) => {
      scriptFeishuIdentity(commands)
      child = commands.scriptStream('lark-cli', CONSUMER_ARGS)
      commands.script(['im', '+chat-list'], () =>
        JSON.stringify({ chats: [{ chat_id: 'oc_all', name: 'Build alerts', chat_mode: 'group' }] })
      )
      commands.script(['im', '+chat-messages-list'], () => historyPage([]))
      return bootPlugin({
        runtime,
        readSettings: async () => settingsWithFeishu(stateDir, { enabled: true, config }),
        commands,
        stateDir,
        disableTimers: true,
        // 夹具事件的时刻就是「现在」：面板的 24 h 流水才数得到这条 Trigger。
        nowMs: () => Date.parse('2025-11-06T12:00:01.000Z')
      })
    }
  })
  try {
    // setup 完成：机器人身份读到了，插件不再报「缺 setup」。
    assert.equal(harness.handle.snapshot().health.setupMissing, false)
    await until(() => child?.attached === true)
    const consumer = harness.commands.streams.at(0)
    assert.ok(consumer !== undefined, 'the event consumer was started through the command port')
    // argv 是设计里那一条（§I.3）：`event consume im.message.receive_v1 --as bot`。
    assert.deepEqual(consumer.args, [...CONSUMER_ARGS])
    // 就绪行之后的一条事件成为 Trigger（经 Source 端口进库）。
    child?.err('[event] ready')
    child?.out(JSON.stringify(fixtureEvent()))
    await until(() => harness.handle.refresh().health.activity.received >= 1)
    // 一轮回填 + 群名刷新（测试用 `feishuOnce` 手动推；定时器在测试里是关的）。
    const round = await harness.handle.feishuOnce()
    assert.equal(round?.chats, 1)
    assert.deepEqual(round?.failures, [])
    // 群名刷新写进了面板读的那张表（§I.3 群名刷新行）。
    assert.deepEqual(harness.commands.calls.filter((call) => call.args[1] === '+chat-list').length, 1)
    await harness.handle.shutdown()
    assert.equal(child?.stopped, true, 'shutdown stops the event consumer')
  } finally {
    await harness.cleanup()
  }
})

test('a Feishu source without a CLI stays in setup and never starts a stream', async () => {
  const harness = await openBoot({
    boot: async (stateDir, runtime, commands) =>
      bootPlugin({
        runtime,
        readSettings: async () => settingsWithFeishu(stateDir, { enabled: true, config: { chats: [] } }),
        commands,
        stateDir,
        disableTimers: true
      })
  })
  try {
    assert.equal(harness.handle.snapshot().health.setupMissing, true)
    // 没有 CLI：一个 `lark-cli` 调用都不该发生（更没有事件流）。
    assert.deepEqual(
      harness.commands.calls.filter((call) => call.program === 'lark-cli'),
      []
    )
    assert.deepEqual(harness.commands.streams, [])
    assert.equal(await harness.handle.feishuOnce(), null)
  } finally {
    await harness.cleanup()
  }
})

test('a Feishu source whose bot identity is not ready stays in setup', async () => {
  const harness = await openBoot({
    boot: async (stateDir, runtime, commands) => {
      scriptFeishuIdentity(commands, { botReady: false })
      return bootPlugin({
        runtime,
        readSettings: async () =>
          settingsWithFeishu(stateDir, { enabled: true, config: { cli: 'lark-cli', chats: [] } }),
        commands,
        stateDir,
        disableTimers: true
      })
    }
  })
  try {
    assert.equal(harness.handle.snapshot().health.setupMissing, true)
    assert.deepEqual(harness.commands.streams, [])
  } finally {
    await harness.cleanup()
  }
})

// ---------------------------------------------------------------- Channel（§I.3、§J.1）

/** 一条出站消息（Channel 的输入）。 */
function replyMessage(text = 'Done', address: Record<string, string> = {}): OutboundMessage {
  return {
    id: 'reply-0123456789abcdef0123456789abcdef',
    channel: { source: 'feishu', thread: 'feishu:oc_all', address: { chatId: 'oc_all', messageId: 'om_root', ...address } },
    text,
    kind: 'reply'
  }
}

test('a reply lands in the topic of its root message with the message id as the idempotency key', async () => {
  const cli = new FakeCommands()
  cli.script(['im', '+messages-reply'], () => JSON.stringify({ code: 0, data: { message_id: 'om_sent' } }))
  const kind = createFeishuKind('lark-cli')
  assert.equal(await kind.channel?.send(cli, replyMessage()), 'sent')
  assert.deepEqual(cli.args, [
    [
      'im',
      '+messages-reply',
      '--as',
      'bot',
      '--message-id',
      'om_root',
      '--text',
      'Done',
      '--idempotency-key',
      'reply-0123456789abcdef0123456789abcdef'
    ]
  ])
})

test('a chat replies only where the Source still listens', async () => {
  const kind = createFeishuKind('lark-cli')
  const allowed = kind.channel?.allowed
  assert.ok(allowed !== undefined)
  const config = feishuConfigSchema.parse({
    chats: [{ chatId: 'oc_all', listen: 'all' }],
    directMessages: false
  })
  assert.equal(allowed({ chatId: 'oc_all', messageId: 'om_root' }, config), true)
  assert.equal(allowed({ chatId: 'oc_other', messageId: 'om_root' }, config), false)
  assert.equal(allowed({ chatId: 'oc_dm', messageId: 'om_root', direct: 'true' }, config), false)
  assert.equal(
    allowed({ chatId: 'oc_other', messageId: 'om_root' }, feishuConfigSchema.parse({ otherChats: 'mentions' })),
    true
  )
  assert.equal(
    allowed(
      { chatId: 'oc_dm', messageId: 'om_root', direct: 'true' },
      feishuConfigSchema.parse({ directMessages: true })
    ),
    true
  )
  // 链接指向群；缺群 id 时给空链接（面板不假装有页面）。
  assert.equal(
    kind.channel?.link?.({ chatId: 'oc_all' }, {})?.url,
    'https://applink.feishu.cn/client/chat/open?openChatId=oc_all'
  )
  assert.equal(kind.channel?.link?.({}, {})?.url, '')
})

test('a recalled or missing target message is gone, while every other failure retries', async () => {
  const kind = createFeishuKind('lark-cli')
  const send = async (error: Error): Promise<'sent' | 'gone' | undefined> => {
    const cli = new FakeCommands()
    cli.fail('lark-cli', ['im', '+messages-reply'], error)
    return kind.channel?.send(cli, replyMessage())
  }
  // 撤回：飞书的 230011（也认文本里的 withdrawn，不同版本的 CLI 会放进别的码里）。
  assert.equal(await send(cliFailure('lark-cli', { code: 230011, exitCode: 1 })), 'gone')
  assert.equal(
    await send(cliFailure('lark-cli', { code: 230020, exitCode: 1, stderr: 'the message was withdrawn' })),
    'gone'
  )
  // 找不到：2300xx + not found。
  assert.equal(
    await send(cliFailure('lark-cli', { code: 230012, exitCode: 1, stderr: '{"code":230012,"msg":"message not found"}' })),
    'gone'
  )
  // 其余（限流、超时、权限、没有业务码）：抛错让 outbox 退避重试，绝不 drop。
  await assert.rejects(send(cliFailure('lark-cli', { code: 99991400, exitCode: 1 })), /exited with code 1/)
  await assert.rejects(send(cliFailure('lark-cli', { exitCode: 1 })), /exited with code 1/)
  // 没有目标消息：地址本身说明永远送不到。
  const noTarget = new FakeCommands()
  assert.equal(
    await kind.channel?.send(noTarget, {
      ...replyMessage(),
      channel: { source: 'feishu', thread: 'feishu:oc_all', address: { chatId: 'oc_all' } }
    }),
    'gone'
  )
  assert.deepEqual(noTarget.calls, [])
})

test('the hundred-word ceiling refuses before any CLI call, counted across Chinese and English', async () => {
  // 分词规则只有一份（§I.3：中英混排按上游分词规则）。
  assert.equal(wordCount('Done'), 1)
  assert.equal(wordCount('中文 and English'), 3)
  assert.equal(wordCount('word '.repeat(100)), 100)
  assert.equal(wordCount('我们修复了登录问题，请重试。'.repeat(12)), 96)
  assert.equal(wordCount('我们修复了登录问题，请重试。'.repeat(13)), 104)
  assert.equal(wordCount('我们修复了登录问题，please retry。'.repeat(12)), 84)
  assert.throws(() => checkedImText('我们修复了登录问题，请重试。'.repeat(13)), /has 104 words; maximum is 100/)

  const kind = createFeishuKind('lark-cli')
  const cli = new FakeCommands()
  await assert.rejects(
    kind.channel?.send(cli, replyMessage('我们修复了登录问题，请重试。'.repeat(13))) ?? Promise.resolve(),
    /maximum is 100/
  )
  assert.deepEqual(cli.calls, [], 'nothing was sent')
  // 恰好一百词可以发（上限是上限，不是目标）。
  cli.script(['im', '+messages-reply'], () => '{}')
  assert.equal(await kind.channel?.send(cli, replyMessage('word '.repeat(100).trim())), 'sent')
})

/** 名单同步看到的引擎面：命令端口与自己的实例配置（`SyncContext`）。 */
function syncHost(cli: FakeCommands): SyncContext {
  const config = feishuConfigSchema.parse({ cli: 'lark-cli' })
  return {
    commands: cli,
    config: <C extends Record<string, unknown>>(kind: string): C | undefined =>
      kind === 'feishu' ? (config as unknown as C) : undefined
  }
}

/** `+chat-members-list` 的一次输出（真实字段集合：users / bots / has_more / truncations）。 */
function membersPage(users: readonly Record<string, unknown>[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ chat_id: 'oc_sync', users, bots: [], user_total: users.length, has_more: false, ...extra })
}

test('the sync makes the sync chat members the allowed list, and refuses an incomplete one', async () => {
  const kind = createFeishuKind('lark-cli')
  const sync = kind.policy?.sync
  assert.ok(sync !== undefined, 'Feishu declares a policy sync')
  // 只有点名了来源群的 part 才能同步（§I.1 `sync.ready`）。
  assert.equal(sync.ready({ syncChat: 'oc_sync' }), true)
  assert.equal(sync.ready({ syncChat: '' }), false)

  const cli = new FakeCommands()
  cli.script(['im', '+chat-members-list'], () =>
    membersPage([
      { member_id: 'ou_bob', name: 'Robert' },
      { member_id: 'ou_new', name: 'New' }
    ])
  )
  const part = {
    allowed: [
      { id: 'ou_bob', name: 'Bob' },
      { id: 'ou_left', name: 'Left' }
    ],
    bots: [],
    syncChat: 'oc_sync'
  }
  const signal = new AbortController().signal
  const next = await sync.run(syncHost(cli), part, signal)
  // 留下的人按原顺序更新名字，新成员追加，离开的人移除（§I.3 同步行）。
  assert.deepEqual(next, {
    allowed: [
      { id: 'ou_bob', name: 'Robert' },
      { id: 'ou_new', name: 'New' }
    ],
    bots: [],
    syncChat: 'oc_sync'
  })
  assert.deepEqual(cli.args, [
    [
      'im',
      '+chat-members-list',
      '--as',
      'bot',
      '--chat-id',
      'oc_sync',
      '--member-types',
      'user',
      '--page-all',
      '--page-limit',
      '0'
    ]
  ])
  // 取消信号经端口绑定到这次读（同步被停机时不会再发请求）。
  assert.equal(cli.calls[0]?.options.signal, signal)

  // 名单不完整：服务端截断或还有下一页时绝不把半份名单当成全部
  // （那会把没读到的成员踢出允许名单）。
  for (const extra of [{ has_more: true }, { truncations: [{ limit: 100, member_type: 'user' }] }]) {
    const incomplete = new FakeCommands()
    incomplete.script(['im', '+chat-members-list'], () => membersPage([{ member_id: 'ou_bob', name: 'Bob' }], extra))
    await assert.rejects(sync.run(syncHost(incomplete), part, signal), /incomplete/)
  }
})

/** 一份只有 Feishu 部分的 Policy 块（同步测试的最小块）。 */
function policyWithFeishu(part: Record<string, unknown>): PolicyBlock {
  return {
    rules: [],
    acceptMode: 'observe',
    sources: { feishu: { allowed: [], bots: [], admission: {}, ...part } },
    eval: { timeoutSeconds: 300 }
  }
}

/** 一个记录调度与取消的手工调度器（§P.1：不 sleep）。 */
function manualSchedule() {
  const scheduled: { run: () => void; milliseconds: number; cancelled: boolean }[] = []
  return {
    scheduled,
    delays: () => scheduled.map((entry) => entry.milliseconds),
    schedule(run: () => void, milliseconds: number): () => void {
      const entry = { run, milliseconds, cancelled: false }
      scheduled.push(entry)
      return () => {
        entry.cancelled = true
      }
    },
    /** 触发最近一次尚未取消的调度（重试链的下一跳）。 */
    fire(): void {
      const entry = [...scheduled].reverse().find((item) => !item.cancelled)
      assert.ok(entry !== undefined, 'something was scheduled')
      entry.cancelled = true
      entry.run()
    }
  }
}

test('a policy sync writes the members into the allow list and reports its own health entry', async () => {
  const board = new FakeHealthBoard()
  const schedule = manualSchedule()
  const cli = new FakeCommands()
  cli.script(['im', '+chat-members-list'], () =>
    membersPage([
      { member_id: 'ou_bob', name: 'Robert' },
      { member_id: 'ou_new', name: 'New' }
    ])
  )
  let current = policyWithFeishu({ allowed: [], syncChat: 'oc_sync' })
  const saved: PolicyBlock[] = []
  const runner = createPolicySync({
    current: () => current,
    revision: () => 0,
    save: (policy) => {
      saved.push(policy)
      current = policy
    },
    syncable: () => ['feishu'],
    run: (_id, part, signal) => createFeishuKind('lark-cli').policy!.sync!.run(syncHost(cli), part, signal),
    health: board,
    now: () => '2026-11-07T00:00:00.000Z',
    schedule: schedule.schedule,
    signal: new AbortController().signal
  })

  // 「立即同步」就是一次 `sync`：名单保存为 origin=sync 的 Policy 新版本（保存端口注入）。
  const part = await runner.sync('feishu')
  assert.deepEqual(part['allowed'], [
    { id: 'ou_bob', name: 'Robert' },
    { id: 'ou_new', name: 'New' }
  ])
  assert.equal(saved.length, 1)
  assert.deepEqual(saved[0]?.sources['feishu']?.allowed, part['allowed'])
  // 同步健康条目独立于 feishu/history（§N.4：写者是设置层）。
  assert.deepEqual(board.entries['sync:feishu'], { state: 'ready', detail: '2 allowed' })
  assert.equal(board.held('sync:feishu'), true)
  assert.deepEqual(schedule.delays(), [], 'success schedules no retry')
})

test('a sync that changes nothing saves nothing, and a non-syncable Source is refused', async () => {
  const board = new FakeHealthBoard()
  const cli = new FakeCommands()
  cli.script(['im', '+chat-members-list'], () => membersPage([{ member_id: 'ou_bob', name: 'Bob' }]))
  let saves = 0
  const runner = createPolicySync({
    current: () => policyWithFeishu({ allowed: [{ id: 'ou_bob', name: 'Bob' }], syncChat: 'oc_sync' }),
    revision: () => 3,
    save: () => {
      saves += 1
    },
    syncable: () => ['feishu'],
    run: (_id, part, signal) => createFeishuKind('lark-cli').policy!.sync!.run(syncHost(cli), part, signal),
    health: board,
    now: () => '2026-11-07T00:00:00.000Z',
    schedule: manualSchedule().schedule,
    signal: new AbortController().signal
  })
  await runner.sync('feishu')
  assert.equal(saves, 0, 'an unchanged list does not write a new policy version')
  assert.deepEqual(board.entries['sync:feishu'], { state: 'ready', detail: '1 allowed' })
  // 没有点名同步群（或实例没开）的 Source 不能同步。
  await assert.rejects(runner.sync('github'), /cannot sync now/)
})

test('a failed sync reports an error and retries after 1 minute, doubling to 1 hour', async () => {
  const board = new FakeHealthBoard()
  const schedule = manualSchedule()
  const cli = new FakeCommands()
  // 先连续失败（同步在退避里反复重试），最后放一次成功（清掉退避）。
  for (let attempt = 0; attempt < 8; attempt += 1) {
    cli.next('lark-cli', ['im', '+chat-members-list'], cliFailure('lark-cli', { code: 99991400, exitCode: 1 }))
  }
  cli.script(['im', '+chat-members-list'], () => membersPage([{ member_id: 'ou_bob', name: 'Bob' }]))
  const runner = createPolicySync({
    current: () => policyWithFeishu({ allowed: [], syncChat: 'oc_sync' }),
    revision: () => 0,
    save: () => {},
    syncable: () => ['feishu'],
    run: (_id, part, signal) => createFeishuKind('lark-cli').policy!.sync!.run(syncHost(cli), part, signal),
    health: board,
    now: () => '2026-11-07T00:00:00.000Z',
    schedule: schedule.schedule,
    signal: new AbortController().signal
  })

  await assert.rejects(runner.sync('feishu'), /exited with code 1/)
  assert.equal(board.entries['sync:feishu']?.state, 'error')
  assert.deepEqual(schedule.delays(), [SYNC_FIRST_DELAY_MS])
  assert.equal(SYNC_FIRST_DELAY_MS, 60_000)
  // 连续失败：1 min → 2 → 4 → 8 → 16 → 32 → 60 min（封顶 1 小时）。
  const seconds: number[] = [60]
  while (schedule.delays().length < 7) {
    const before = schedule.delays().length
    schedule.fire()
    await until(() => schedule.delays().length > before)
    seconds.push((schedule.delays().at(-1) ?? 0) / 1000)
  }
  assert.deepEqual(seconds, [60, 120, 240, 480, 960, 1920, 3600])
  assert.equal(SYNC_MAX_DELAY_MS, 3_600_000)
  // 再失败一次停在封顶值，不会无限增长。
  const before = schedule.delays().length
  schedule.fire()
  await until(() => schedule.delays().length > before)
  assert.equal(schedule.delays().at(-1), SYNC_MAX_DELAY_MS)

  // 一次成功清掉退避：健康回到 ready，之后不再排新的重试。
  const scheduledBefore = schedule.delays().length
  schedule.fire()
  await until(() => board.entries['sync:feishu']?.state === 'ready')
  assert.deepEqual(board.entries['sync:feishu'], { state: 'ready', detail: '1 allowed' })
  assert.equal(schedule.delays().length, scheduledBefore, 'success does not schedule another retry')
})

test('starting a sync runs every syncable Source once, and stopping cancels the pending retry', async () => {
  const board = new FakeHealthBoard()
  const schedule = manualSchedule()
  const cli = new FakeCommands()
  cli.script(['im', '+chat-members-list'], () => membersPage([{ member_id: 'ou_bob', name: 'Bob' }]))
  const runner = createPolicySync({
    current: () => policyWithFeishu({ allowed: [], syncChat: 'oc_sync' }),
    revision: () => 0,
    save: () => {},
    syncable: () => ['feishu'],
    run: (_id, part, signal) => createFeishuKind('lark-cli').policy!.sync!.run(syncHost(cli), part, signal),
    health: board,
    now: () => '2026-11-07T00:00:00.000Z',
    schedule: schedule.schedule,
    signal: new AbortController().signal
  })
  // 启动时一次：每个可同步的 Source 各跑一次。
  await runner.start()
  assert.equal(cli.calls.length, 1)
  assert.deepEqual(board.entries['sync:feishu'], { state: 'ready', detail: '1 allowed' })

  // 失败后的待重试在停机时被取消（`stop`），不会在关闭后还去读 CLI。
  const broken = new FakeCommands()
  broken.fail('lark-cli', ['im', '+chat-members-list'], cliFailure('lark-cli', { exitCode: 1 }))
  // 第二个驱动器用自己的一块健康板：`sync:<id>` 只有一个写者（§N.4）。
  const retryBoard = new FakeHealthBoard()
  const failing = createPolicySync({
    current: () => policyWithFeishu({ allowed: [], syncChat: 'oc_sync' }),
    revision: () => 0,
    save: () => {},
    syncable: () => ['feishu'],
    run: (_id, part, signal) => createFeishuKind('lark-cli').policy!.sync!.run(syncHost(broken), part, signal),
    health: retryBoard,
    now: () => '2026-11-07T00:00:00.000Z',
    schedule: schedule.schedule,
    signal: new AbortController().signal
  })
  await assert.rejects(failing.sync('feishu'), /exited with code 1/)
  assert.equal(schedule.scheduled.at(-1)?.cancelled, false)
  failing.stop()
  assert.equal(schedule.scheduled.at(-1)?.cancelled, true)
})

test('a configured Feishu source syncs its allow list at startup and on demand', async () => {
  const config = { cli: 'lark-cli', chats: [{ chatId: 'oc_all', listen: 'all' }] }
  let reads = 0
  const harness = await openBoot({
    boot: async (stateDir, runtime, commands) => {
      scriptFeishuIdentity(commands)
      commands.script(['im', '+chat-members-list'], () => {
        reads += 1
        return membersPage([{ member_id: 'ou_bob', name: 'Bob' }])
      })
      return bootPlugin({
        runtime,
        readSettings: async () =>
          settingsWithFeishu(
            stateDir,
            { enabled: true, config },
            // 同步来源群就是接收的群：成员成为允许名单。
            { github: { allowed: [{ id: 'alice' }] }, feishu: { allowed: [], syncChat: 'oc_all' } }
          ),
        commands,
        stateDir,
        disableTimers: true
      })
    }
  })
  try {
    // 启动时一次（生产不等它；测试等这个 promise）。
    await harness.handle.policySync()
    assert.equal(reads, 1)
    // 手动「立即同步」再读一次，返回新的 part。
    const part = await harness.handle.syncPolicy('feishu')
    assert.equal(reads, 2)
    assert.deepEqual(part['allowed'], [{ id: 'ou_bob', name: 'Bob' }])
    // 保存的是 origin=sync 的 Policy 版本（§K.8），名字来自群里。
    const store = openStore({ stateDir: harness.stateDir })
    const saved = savedSettingsVersion(store, 'policy')
    store.close()
    assert.equal(saved?.origin, 'sync')
    const savedPolicy = saved?.config as { sources: { feishu: { allowed: unknown[]; syncChat: string } } }
    assert.deepEqual(savedPolicy.sources.feishu.allowed, [{ id: 'ou_bob', name: 'Bob' }])
    assert.equal(savedPolicy.sources.feishu.syncChat, 'oc_all')
  } finally {
    await harness.cleanup()
  }
})

test('a Feishu configuration that can act as a user is disabled with its setup problem', async () => {
  const harness = await openBoot({
    boot: async (stateDir, runtime, commands) => {
      // 同一个 lark-cli 既登录了机器人也登录了人：配置可充当用户身份，插件拒绝以用户身份运行。
      commands.script('lark-cli auth status', () =>
        JSON.stringify({
          appId: BOT.appId,
          brand: 'feishu',
          identities: { bot: { status: 'ready' }, user: { status: 'ready' } },
          identity: 'bot'
        })
      )
      commands.script(['api', 'GET', '/open-apis/bot/v3/info'], () =>
        JSON.stringify({ bot: { open_id: BOT.botId, app_name: 'Superagent' } })
      )
      return bootPlugin({
        runtime,
        readSettings: async () =>
          settingsWithFeishu(stateDir, { enabled: true, config: { cli: 'lark-cli', chats: [] } }),
        commands,
        stateDir,
        disableTimers: true
      })
    }
  })
  try {
    // 实例被 setup 问题挡住：不启动事件流，也不做名单同步。
    assert.equal(harness.handle.snapshot().health.setupMissing, true)
    assert.deepEqual(harness.commands.streams, [])
    await harness.handle.policySync()
    assert.deepEqual(
      harness.commands.calls.filter((call) => call.args.includes('+chat-members-list')),
      []
    )
  } finally {
    await harness.cleanup()
  }
})

// Feishu 的历史回填与话题轮询（§I.3「历史回填 / 话题轮询 / 群名刷新」三行）。
//
// 回填：每个 chat 自己一个游标（`feishu-cursor:<chat>`），只读上次游标之后；第一轮只记下游标
// 的起点（不读任何东西——从安装那一刻开始读，而不是把群的全部历史灌进来）。读成功才推进游标，
// 所以失败的一页下一轮还会重读；游标落在「这一轮开始前 5 s」，迟到的消息不会漏，重复的 id
// 由引擎幂等（§D.2）。
//
// 话题：回填时顺手记下每个话题（`feishu-topics:<chat>`，`thread_id -> {at, rootId}`），
// 每轮把水位线内的话题各拉一次（§I.3：活订阅，或最后一条 Trigger/Ticket 结束后两周）。
// 每个话题的失败写它自己 Thread 的 `meta.pollError`，成功后清掉。
//
// 群名：每分钟重读一次群列表写进 `source-labels:<feishu>`，新群一分钟内出现在面板里。
//
// 依赖纪律（§C.2）：只 import core 的类型、命令端口与兄弟模块；键名由组合根注入（§D.3）。
import type { HealthEntry } from '../../core/index.ts'
import type { SourceContext } from '../kind.ts'
import type { FeishuApi } from './api.ts'
import type { FeishuConfig } from './config.ts'
import type { FeishuBot } from './translate.ts'
import { feishuTime, feishuTrigger } from './translate.ts'

/** 订阅的水位线（§I.3 话题轮询行，语义同上游 `POLL_HORIZON_MS`）：两周。 */
export const POLL_HORIZON_MS = 14 * 24 * 3600_000

/** 回填写的那条 health（§N.4 的条目表）。 */
export const HISTORY_HEALTH = 'history'

/** 游标回退的重叠量：这一轮的开始时刻减 5 s，迟到的消息不会漏（上游同）。 */
export const CURSOR_OVERLAP_MS = 5_000

/** 一个话题记住多少条已读消息（超出就丢最旧的：重复的 id 引擎会挡，不会重复出 Trigger）。 */
export const SEEN_LIMIT = 200

/** 事件流与回填共用的 kv 键（字面量只活在 `app/kv.ts`，由组合根注入）。 */
export interface FeishuKeys {
  /** 事件流见过的会话（`chat_id -> 是否私聊`）。 */
  readonly chats: string
  /** 行键的显示名（`source-labels:<kind>`）。 */
  readonly labels: string
  readonly cursor: (chatId: string) => string
  readonly topics: (chatId: string) => string
  readonly seen: (threadKey: string) => string
}

/** 回填与话题轮询要的宿主：收 Trigger、读写自己的 kv、写 Thread 的 pollError、报 health。 */
export type FeishuPollHost = Pick<SourceContext, 'receive' | 'state' | 'report' | 'threads'>

/**
 * 订阅了 Feishu 的 Thread 的只读形状。组合根接线程仓储的读面（`threads.list()`），
 * Source 自己拿不到 Store（§C.2 规则 2）。
 */
export interface SubscribedThread {
  readonly ref: { readonly source: string; readonly id: string }
  readonly lastAt?: string
  readonly subscriptions: readonly string[]
  readonly meta: Readonly<Record<string, unknown>>
}

/** 水位线判定的输入（纯函数，方便单独断言「结束后两周内仍轮询」）。 */
export interface HorizonInput {
  /** 现在（epoch 毫秒）。 */
  readonly now: number
  /** 这个话题的 Thread 是否还有 Ticket 订阅（活订阅永远轮询）。 */
  readonly subscribed: boolean
  /** 最后一条 Trigger 的时刻（ISO 文本）。 */
  readonly lastAt: string | undefined
  /** 相关 Ticket 的结束时刻（ISO 文本）。 */
  readonly endedAt: readonly string[]
}

/**
 * 话题是否还在水位线内（§I.3）：活订阅，或最后一条 Trigger/Ticket 结束后两周内。
 * 一个时刻都没有的话题保守地继续轮询（没有理由停它）。
 */
export function withinHorizon(input: HorizonInput): boolean {
  if (input.subscribed) return true
  const times = [input.lastAt, ...input.endedAt]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value))
  if (times.length === 0) return true
  return input.now - Math.max(...times) < POLL_HORIZON_MS
}

/** 一个话题在 kv 里的读数：最后一次见到消息的时刻与该话题的根消息 id。 */
export interface FeishuTopic {
  readonly at: string
  readonly rootId: string
}

/** 一个会话的话题表。 */
type FeishuTopics = Record<string, FeishuTopic>

/** 回填的依赖：全部注入；函数自己不读时钟、不建计时器、不碰网络。 */
export interface FeishuBackfillOptions {
  readonly api: FeishuApi
  readonly bot: FeishuBot
  readonly config: FeishuConfig
  readonly host: FeishuPollHost
  readonly keys: FeishuKeys
  readonly now?: () => number
  readonly signal?: AbortSignal
  readonly log?: (message: string) => void
  /** 订阅了 Feishu 的 Thread（水位线要它）；缺省表示一个都没有（只看「结束后两周」）。 */
  readonly subscribed?: () => readonly SubscribedThread[]
  /** 读一个 Ticket（水位线要它的结束时刻）；缺省表示读不到（按没有 Ticket 处理）。 */
  readonly ticket?: (id: string) => { readonly ended?: { readonly at: string } } | undefined
  readonly pageSize?: number
}

/** 一轮回填的读数（面板与测试用）。 */
export interface FeishuRoundResult {
  /** 这一轮要读的会话数（含第一轮只记游标的那些）。 */
  readonly chats: number
  /** 翻成 Trigger 并交给 Source 的条数。 */
  readonly triggers: number
  /** 这一轮轮询过的话题数。 */
  readonly topics: number
  /** 失败的会话/话题（`<id>: <原因>`）；有它就是 `history` 的 error 明细。 */
  readonly failures: readonly string[]
}

/** 回填的句柄：`round()` 可重复调用，游标与话题表都在 kv 里。 */
export interface FeishuBackfill {
  round(): Promise<FeishuRoundResult>
}

/** 一条错误的一行文本。 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 一个对象是否像 `{...}`（null 与数组都不算）。 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 读话题表（畸形值当作没有：宁愿多轮询一轮，也不漏掉回复）。 */
function topicsOf(value: unknown): FeishuTopics {
  if (!isRecord(value)) return {}
  const topics: FeishuTopics = {}
  for (const [threadId, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue
    const at = entry['at']
    const rootId = entry['rootId']
    if (typeof at !== 'string' || typeof rootId !== 'string' || rootId.length === 0) continue
    topics[threadId] = { at, rootId }
  }
  return topics
}

/** 读已读消息表（畸形值当作空表）。 */
function seenOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/** 造一个回填器。它不自己计时（组合根按 60 s 驱动），也不碰网络（`api` 注入）。 */
export function createFeishuBackfill(options: FeishuBackfillOptions): FeishuBackfill {
  const now = options.now ?? (() => Date.now())
  const log = options.log ?? (() => undefined)
  const signal = options.signal
  const pageSize = options.pageSize
  /** 轮次是否被中断（读函数里用；函数调用避开 `readonly aborted` 的类型收窄）。 */
  const stopped = (): boolean => signal?.aborted === true

  const report = (entry: HealthEntry): void => options.host.report(HISTORY_HEALTH, entry)

  /** 要读的会话：配置里列出的群 + 事件流见过的私聊（受 `directMessages` 约束）。 */
  const chatTargets = (): { chatId: string; direct: boolean }[] => {
    const targets = options.config.chats.map((chat) => ({ chatId: chat.chatId, direct: false }))
    const known = options.host.state.get(options.keys.chats)
    if (options.config.directMessages && isRecord(known)) {
      for (const [chatId, direct] of Object.entries(known)) {
        if (direct !== true) continue
        if (targets.some((target) => target.chatId === chatId)) continue
        targets.push({ chatId, direct: true })
      }
    }
    return targets
  }

  /** 这一轮的开始时刻回退 5 s：迟到的消息不会漏（重复的 id 由引擎幂等）。 */
  const overlap = (at: number): string => new Date(at - CURSOR_OVERLAP_MS).toISOString()

  /** Thread 键（§I.3）：私聊是「群 + direct」，其余是「群 + 根消息」。 */
  const threadKeyOf = (chatId: string, direct: boolean, rootId: string): string =>
    direct ? `${chatId}:direct` : `${chatId}:${rootId}`

  /** 把一条读到的消息记进话题表（回填与话题轮询共用）；`threadId` 缺省的消息不进话题。 */
  const remember = (
    chat: { chatId: string; direct: boolean },
    message: { readonly messageId: string; readonly threadId?: string; readonly rootId?: string; readonly createTime: string },
    topics: FeishuTopics
  ): string | undefined => {
    if (message.threadId === undefined) return undefined
    const at = feishuTime(message.createTime)
    const rootId = message.rootId ?? message.messageId
    const current = topics[message.threadId]
    if (current === undefined || Date.parse(current.at) <= Date.parse(at)) {
      topics[message.threadId] = { at, rootId: current?.rootId ?? rootId }
    }
    const topicRoot = topics[message.threadId]?.rootId ?? rootId
    return threadKeyOf(chat.chatId, chat.direct, topicRoot)
  }

  /** 一条消息是否已经读过（回填与话题轮询共用同一张表，重复的行不会出 Trigger）。 */
  const seen = (threadKey: string, messageId: string): boolean =>
    seenOf(options.host.state.get(options.keys.seen(threadKey))).includes(messageId)

  /** 记下「这条消息读过了」；超出上限就丢最旧的（重复的 id 引擎会挡）。 */
  const markSeen = (threadKey: string, messageId: string): void => {
    const key = options.keys.seen(threadKey)
    const current = seenOf(options.host.state.get(key))
    if (current.includes(messageId)) return
    options.host.state.set(key, [...current, messageId].slice(-SEEN_LIMIT))
  }

  /** 读一个会话的全部新页；被中断时 `completed: false`（游标不动）。 */
  const readChat = async (
    chat: { chatId: string; direct: boolean },
    since: string,
    until: string,
    topics: FeishuTopics
  ): Promise<{ triggers: number; completed: boolean }> => {
    let pageToken: string | undefined
    const tokens = new Set<string>()
    let triggers = 0
    for (;;) {
      if (stopped()) return { triggers, completed: false }
      const page = await options.api.chatMessages({
        chatId: chat.chatId,
        direct: chat.direct,
        since,
        until,
        ...(pageToken === undefined ? {} : { pageToken }),
        ...(pageSize === undefined ? {} : { pageSize })
      })
      for (const message of page.messages) {
        if (stopped()) return { triggers, completed: false }
        const threadKey = remember(chat, message, topics)
        if (threadKey !== undefined) markSeen(threadKey, message.messageId)
        const trigger = feishuTrigger(message, options.bot)
        if (trigger === undefined) continue
        options.host.receive(trigger)
        triggers += 1
      }
      if (!page.hasMore) return { triggers, completed: true }
      // 分页不前进（没有 token 或原地打转）当作这一页失败：下一轮重读，而不是死循环。
      if (page.pageToken === undefined || tokens.has(page.pageToken)) {
        throw new Error('Feishu history pagination did not advance')
      }
      tokens.add(page.pageToken)
      pageToken = page.pageToken
    }
  }

  /** 读一个话题的全部新回复；只收没见过的那条消息。 */
  const readTopic = async (
    chat: { chatId: string; direct: boolean },
    threadId: string,
    threadKey: string,
    topics: FeishuTopics
  ): Promise<number> => {
    let pageToken: string | undefined
    const tokens = new Set<string>()
    let triggers = 0
    for (;;) {
      if (stopped()) return triggers
      const page = await options.api.threadMessages({
        chatId: chat.chatId,
        direct: chat.direct,
        threadId,
        ...(pageToken === undefined ? {} : { pageToken }),
        ...(pageSize === undefined ? {} : { pageSize })
      })
      for (const message of page.messages) {
        if (stopped()) return triggers
        // 已经读过的消息不再出 Trigger（回填已经收过它）；但话题的最后时刻仍要更新。
        if (seen(threadKey, message.messageId)) {
          remember(chat, message, topics)
          continue
        }
        remember(chat, message, topics)
        markSeen(threadKey, message.messageId)
        const trigger = feishuTrigger(message, options.bot)
        if (trigger === undefined) continue
        options.host.receive(trigger)
        triggers += 1
      }
      if (!page.hasMore) return triggers
      if (page.pageToken === undefined || tokens.has(page.pageToken)) {
        throw new Error('Feishu thread pagination did not advance')
      }
      tokens.add(page.pageToken)
      pageToken = page.pageToken
    }
  }

  return {
    async round(): Promise<FeishuRoundResult> {
      const started = now()
      const until = new Date(started).toISOString()
      const failures: string[] = []
      const subscribedList = options.subscribed?.() ?? []
      const chats = chatTargets()
      let triggers = 0
      let topicsPolled = 0

      for (const chat of chats) {
        if (stopped()) break
        const cursorKey = options.keys.cursor(chat.chatId)
        const cursor = options.host.state.get(cursorKey)
        if (typeof cursor !== 'string' || cursor.length === 0) {
          // 第一轮只见证位置：从安装这一刻开始回填，而不是灌进整个群的历史。
          options.host.state.set(cursorKey, overlap(started))
          continue
        }
        const topics = topicsOf(options.host.state.get(options.keys.topics(chat.chatId)))
        try {
          const scan = await readChat(chat, cursor, until, topics)
          triggers += scan.triggers
          if (scan.completed && !stopped()) {
            options.host.state.set(cursorKey, overlap(started))
          }
        } catch (error) {
          // 单页失败：游标不动（下一轮重读）；明细进 history 的 error。
          failures.push(`${chat.chatId}: ${reasonOf(error)}`)
        } finally {
          options.host.state.set(options.keys.topics(chat.chatId), topics)
        }
      }

      // 话题轮询：订阅的话题在水位线内每轮拉一次（§I.3）。
      for (const chat of chats) {
        if (stopped()) break
        const topics = topicsOf(options.host.state.get(options.keys.topics(chat.chatId)))
        const kept: FeishuTopics = {}
        for (const [threadId, topic] of Object.entries(topics)) {
          if (stopped()) break
          const threadKey = threadKeyOf(chat.chatId, chat.direct, topic.rootId)
          const thread = subscribedList.find((candidate) => candidate.ref.id === threadKey)
          const endedAt = (thread?.subscriptions ?? [])
            .map((ticketId) => options.ticket?.(ticketId)?.ended?.at)
            .filter((value): value is string => typeof value === 'string')
          const live = thread !== undefined && thread.subscriptions.length > 0
          if (!withinHorizon({ now: started, subscribed: live, lastAt: topic.at, endedAt })) {
            // 超出水位线：不再轮询，也从候选集里删掉（它不会再有新理由）。
            continue
          }
          kept[threadId] = topic
          try {
            triggers += await readTopic(chat, threadId, threadKey, topics)
            options.host.threads.patch({ source: 'feishu', id: threadKey }, { pollError: undefined })
            topicsPolled += 1
          } catch (error) {
            const detail = reasonOf(error)
            failures.push(`${threadKey}: ${detail}`)
            options.host.threads.patch({ source: 'feishu', id: threadKey }, { pollError: detail })
          }
        }
        options.host.state.set(options.keys.topics(chat.chatId), kept)
      }

      const result: FeishuRoundResult = {
        chats: chats.length,
        triggers,
        topics: topicsPolled,
        failures
      }
      report(
        failures.length === 0
          ? { state: 'ready', detail: 'Chat history recovered' }
          : { state: 'error', detail: failures.join('\n') }
      )
      if (failures.length > 0) log(`the Feishu backfill had ${failures.length} failure(s): ${failures[0]}`)
      return result
    }
  }
}

/**
 * 群名刷新（§I.3 群名刷新行）：读机器人已加入的群，把 `chat_id -> name` 写进
 * `source-labels:<feishu>`。失败时抛错（不覆盖上一次的名单——显示名是展示辅助，不该越写越少）。
 */
export async function refreshChatNames(input: {
  readonly api: FeishuApi
  readonly host: Pick<SourceContext, 'state'>
  readonly keys: Pick<FeishuKeys, 'labels'>
  readonly signal?: AbortSignal
}): Promise<Record<string, string>> {
  const chats = await input.api.chats()
  if (input.signal?.aborted === true) return {}
  const names: Record<string, string> = {}
  for (const chat of chats) {
    if (chat.name !== undefined && chat.name.length > 0) names[chat.chatId] = chat.name
  }
  input.host.state.set(input.keys.labels, names)
  return names
}

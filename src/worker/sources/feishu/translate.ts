// Feishu 消息 → Trigger 的翻译（§I.3「Trigger」与「Thread」两行）。
//
// 四条规则，每条都在 `tests/sources-feishu.test.ts` 里：
// - 一条消息一个 Trigger，id 是 `key('feishu', <消息 id>)`；事件流、群历史、话题回复三条
//   读取路径给出同一个 id，引擎按 id 幂等（§D.2）；
// - 编辑与删除按更新时间生成新 id（`key('feishu', <消息 id>, <update_time>)`）：它们是新事件，
//   而同一版本的重复读取仍是同一个 id（§I.3 Trigger 行）；
// - bot 自身消息在翻译之前就被丢掉（发送者可能是 open_id，也可能是 app id）；
// - `addressed`：私聊一律 `direct`，群消息只有点名了机器人才是 `mention`（没点名就不带）；
//   Thread 是「群 + 根消息」，私聊固定是「群 + direct」。
//
// 本文件不做 I/O：只把三种 JSON 形状归一成 `FeishuMessage`，再翻成 Trigger。
import { key } from '../../core/index.ts'
import type { ChannelRef, ThreadRef, Trigger } from '../../core/index.ts'

/** 这个 Source 的稳定 id。 */
export const FEISHU_SOURCE = 'feishu'

/**
 * 机器人的身份（来自 setup 探针，§I.4）：`botId` 是 open_id，`appId` 是 `cli_` 应用 id。
 * 事件里发送者与 mention 可能用其中任一种，两种都要认（上游同）。
 */
export interface FeishuBot {
  readonly botId: string
  readonly appId: string
}

/** 一条 mention（事件流与读取路径都带，形状同 `im.message.receive_v1`）。 */
export interface FeishuMention {
  readonly id: string
  readonly key?: string
  readonly name?: string
}

/**
 * 归一化之后的一条消息：三条读取路径都翻成它，翻译因此只有一份。
 * `updated` / `deleted` 只由读取路径给出——事件流没有这两个标记（§I.3 Trigger 行）。
 */
export interface FeishuMessage {
  readonly messageId: string
  readonly chatId: string
  readonly chatType: 'p2p' | 'group'
  readonly senderId: string
  readonly senderType: 'user' | 'bot'
  readonly text: string
  readonly mentions: readonly FeishuMention[]
  readonly createTime: string
  readonly rootId?: string
  readonly parentId?: string
  readonly threadId?: string
  readonly link?: string
  /** 读取路径上「这条消息被编辑过」（`updated: true`）；CLI 只在编辑过时输出 `update_time`。 */
  readonly edited?: true
  /** 读取路径上「这条消息被撤回」（`deleted: true`，该字段总是存在）。 */
  readonly deleted?: true
  readonly updateTime?: string
}

/** 一个对象是否像 `{...}`（null 与数组都不算）。 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 取字符串字段（缺失 / 非字符串 → 空串，调用方按空串当「没有」）。 */
function textOf(value: Record<string, unknown>, field: string): string {
  const found = value[field]
  return typeof found === 'string' ? found : ''
}

/** 取布尔字段（只有 `true` 算真）。 */
function flagOf(value: Record<string, unknown>, field: string): true | undefined {
  return value[field] === true ? true : undefined
}

/** 解析 mention 数组：畸形条目跳过（§I.6「畸形条目跳过计数」的种子）。 */
function mentionsOf(value: unknown): FeishuMention[] {
  if (!Array.isArray(value)) return []
  const mentions: FeishuMention[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const id = textOf(entry, 'id')
    if (id.length === 0) continue
    const mentionKey = textOf(entry, 'key')
    const name = textOf(entry, 'name')
    mentions.push({
      id,
      ...(mentionKey.length === 0 ? {} : { key: mentionKey }),
      ...(name.length === 0 ? {} : { name })
    })
  }
  return mentions
}

/** 发送者类型：只有 `bot` 是机器人，其余一律按人处理（未知不等于机器人）。 */
const senderTypeOf = (value: string): 'user' | 'bot' => (value === 'bot' ? 'bot' : 'user')

/**
 * 把 `create_time` / `update_time` 变成 ISO-8601（§I.3）。
 * 事件流与 API 给 epoch 毫秒的字符串；话题页给本地时间字符串（如 `2026-09-11 12:00`）。
 */
export function feishuTime(value: string): string {
  const trimmed = value.trim()
  const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed)
  if (!Number.isFinite(parsed)) throw new Error(`Unreadable Feishu message time: ${value}`)
  return new Date(parsed).toISOString()
}

/** 正文里的 mention 占位符（`@_user_1`）换成事件给出的名字（渲染给评估看的文本才可读）。 */
export function withMentionNames(text: string, mentions: readonly FeishuMention[]): string {
  return mentions.reduce(
    (result, mention) =>
      mention.key !== undefined && mention.name !== undefined
        ? result.replaceAll(mention.key, `@${mention.name}`)
        : result,
    text
  )
}

/** Trigger id：一条消息一个 id；给了版本（编辑/删除的 `update_time`）就是新事件（§I.3）。 */
export function feishuTriggerId(messageId: string, version?: string): string {
  return version === undefined ? key('feishu', messageId) : key('feishu', messageId, version)
}

/**
 * Thread 键（§I.3 Thread 行）：「群 + 根消息」；私聊固定是「群 + direct」。
 * 没有根消息时话题根就是消息自己（它开了一个新话题）。
 */
export function feishuThreadId(
  chatId: string,
  rootId: string | undefined,
  messageId: string,
  direct = false
): string {
  return `${chatId}:${direct ? 'direct' : (rootId ?? messageId)}`
}

/** 回复地址（Channel 页与 #23 的发送都用它）：话题落在根消息上，私聊额外记 `direct`。 */
export function feishuChannel(chatId: string, messageId: string, direct = false): ChannelRef {
  return {
    source: FEISHU_SOURCE,
    thread: `feishu:${chatId}`,
    address: { chatId, messageId, ...(direct ? { direct: 'true' } : {}) }
  }
}

/** Trigger 的 Thread 引用。 */
const threadRef = (id: string): ThreadRef => ({ source: FEISHU_SOURCE, id })

/**
 * 一条 `im.message.receive_v1` 事件（`event consume` 的一行 NDJSON）→ 归一化消息。
 * 缺消息 id / 群 id / 发送者 / 时刻的条目不可翻译，返回 `undefined` 由调用方跳过。
 */
export function feishuEventOf(value: unknown): FeishuMessage | undefined {
  if (!isRecord(value)) return undefined
  const messageId = textOf(value, 'message_id')
  const chatId = textOf(value, 'chat_id')
  const senderId = textOf(value, 'sender_id')
  const createTime = textOf(value, 'create_time')
  if (messageId.length === 0 || chatId.length === 0 || senderId.length === 0) return undefined
  if (createTime.length === 0) return undefined
  const rootId = textOf(value, 'root_id')
  const parentId = textOf(value, 'parent_id')
  const threadId = textOf(value, 'thread_id')
  const link = textOf(value, 'message_app_link')
  return {
    messageId,
    chatId,
    chatType: textOf(value, 'chat_type') === 'p2p' ? 'p2p' : 'group',
    senderId,
    senderType: senderTypeOf(textOf(value, 'sender_type')),
    text: textOf(value, 'content'),
    mentions: mentionsOf(value['mentions']),
    createTime,
    ...(rootId.length === 0 ? {} : { rootId }),
    ...(parentId.length === 0 ? {} : { parentId }),
    ...(threadId.length === 0 ? {} : { threadId }),
    ...(link.length === 0 ? {} : { link })
  }
}

/**
 * 读取路径给出的一条消息（`+chat-messages-list` / `+threads-messages-list` 的一项）→ 归一化。
 * 列表输出不带 `chat_id`，所以群与是否私聊由调用方给（它知道自己读的是哪个会话）。
 */
export function feishuHistoryOf(
  value: unknown,
  input: { readonly chatId: string; readonly direct: boolean }
): FeishuMessage | undefined {
  if (!isRecord(value)) return undefined
  const messageId = textOf(value, 'message_id')
  const createTime = textOf(value, 'create_time')
  if (messageId.length === 0 || createTime.length === 0) return undefined
  const sender = isRecord(value['sender']) ? value['sender'] : {}
  // 机器人发送者带 `open_bot_id`（与事件流的 open_id 对齐）；没有就用 id。
  const senderId = textOf(sender, 'open_bot_id') || textOf(sender, 'id')
  if (senderId.length === 0) return undefined
  const rootId = textOf(value, 'root_id')
  const parentId = textOf(value, 'parent_id')
  const threadId = textOf(value, 'thread_id')
  const link = textOf(value, 'message_app_link')
  const updateTime = textOf(value, 'update_time')
  return {
    messageId,
    chatId: input.chatId,
    chatType: input.direct ? 'p2p' : 'group',
    senderId,
    senderType: senderTypeOf(textOf(sender, 'sender_type')),
    text: historyText(value['content']),
    mentions: mentionsOf(value['mentions']),
    createTime,
    ...(rootId.length === 0 ? {} : { rootId }),
    ...(parentId.length === 0 ? {} : { parentId }),
    ...(threadId.length === 0 ? {} : { threadId }),
    ...(link.length === 0 ? {} : { link }),
    ...(flagOf(value, 'updated') === undefined ? {} : { edited: true as const }),
    ...(flagOf(value, 'deleted') === undefined ? {} : { deleted: true as const }),
    ...(updateTime.length === 0 ? {} : { updateTime })
  }
}

/**
 * 读取路径的正文：`+chat-messages-list` 已经是渲染后的文本；raw API（`body.content`）是
 * `{"text":"…"}` 的 JSON 字符串，这里两种都认（非 JSON 的正文原样保留）。
 */
function historyText(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed.startsWith('{')) return value
    try {
      const parsed: unknown = JSON.parse(trimmed)
      const text = isRecord(parsed) ? parsed['text'] : undefined
      return typeof text === 'string' ? text : value
    } catch {
      return value
    }
  }
  if (!isRecord(value)) return ''
  const text = value['text']
  return typeof text === 'string' ? text : ''
}

/**
 * 编辑 / 删除的版本号（§I.3 Trigger 行）：优先 `update_time`；CLI 没给时用固定的
 * `edited` / `deleted` 标记——同一个版本的重复读取仍然是同一个 id。
 */
function versionOf(message: FeishuMessage): string | undefined {
  if (message.deleted === true) return message.updateTime ?? 'deleted'
  if (message.edited === true) return message.updateTime ?? 'edited'
  return undefined
}

/**
 * 一条归一化消息 → Trigger；机器人自己的消息返回 `undefined`（§I.3：自身消息丢弃）。
 * 群消息的点名与私聊的寻址都由这里落成 `addressed`，是否监听由 kind 的 `scope` 判。
 */
export function feishuTrigger(message: FeishuMessage, bot: FeishuBot): Trigger | undefined {
  if (message.senderId === bot.botId || message.senderId === bot.appId) return undefined
  const direct = message.chatType === 'p2p'
  const mentioned = message.mentions.some(
    (mention) => mention.id === bot.botId || mention.id === bot.appId
  )
  const thread = feishuThreadId(message.chatId, message.rootId, message.messageId, direct)
  return {
    id: feishuTriggerId(message.messageId, versionOf(message)),
    source: FEISHU_SOURCE,
    threads: [threadRef(thread)],
    actor: { source: FEISHU_SOURCE, id: message.senderId },
    human: message.senderType === 'user',
    ...(direct
      ? { addressed: 'direct' as const }
      : mentioned
        ? { addressed: 'mention' as const }
        : {}),
    at: feishuTime(message.createTime),
    text: withMentionNames(message.text, message.mentions),
    ...(message.link === undefined ? {} : { url: message.link }),
    channel: feishuChannel(message.chatId, message.messageId, direct),
    meta: {
      chatId: message.chatId,
      messageId: message.messageId,
      direct,
      mentioned,
      ...(message.rootId === undefined ? {} : { rootId: message.rootId }),
      ...(message.parentId === undefined ? {} : { parentId: message.parentId }),
      ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
      ...(message.edited === undefined ? {} : { edited: true }),
      ...(message.deleted === undefined ? {} : { deleted: true })
    }
  }
}

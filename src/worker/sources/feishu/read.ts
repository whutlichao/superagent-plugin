// Feishu Thread 语境与搜索（§I.3「线程上下文」与「find」两行、§H.17 的读侧）。
//
// 一条 Trigger 有五种读法，翻成同一份 `ContextMessage`：
// - `message`：它自己；`root`：话题根；`parent`：它回复的那条；
// - `thread`：整条话题（`+threads-messages-list`，分页游标原样交回）；没有话题时退化成
//   「聊天邻居」（`chat_neighbours`，与上游同）；
// - `around`：它周围的聊天——先读五条更早的、消息自己、五条更晚的，再按时间往前翻页。
//
// 两条硬纪律：
// - **无权限 / 已删是状态，不是空**：`forbidden` / `deleted` / `missing` 各有明确取值；只有
//   真正可重试的失败（限流、崩溃、没有业务码）才抛错，由调用方给 unavailable。
// - **不猜内容**：已删消息的正文是空串并带 `deleted: true`；不返回它的旧内容。
//
// 依赖纪律（§C.2）：只 import 命令端口、同目录的读取端口与翻译；`lark-cli` 只经 `CommandsHost`
// 调用，参数是 argv 数组（§I.4）。本文件不读时钟、不建计时器、不做网络。
import type { Trigger } from '../../core/index.ts'
import type { ContextMessage, ContextPart, ThreadContext } from '../admission-context.ts'
import type { CommandsHost } from '../commands.ts'
import { CliError } from '../commands.ts'
import { createFeishuApi } from './api.ts'
import type { FeishuApi } from './api.ts'
import { WITHDRAWN_CODE } from './channel.ts'
import type { FeishuConfig } from './config.ts'
import { admissionImageKeys, downloadFeishuImage } from './image.ts'
import type { FeishuMessage } from './translate.ts'
import { feishuTime, withMentionNames } from './translate.ts'

/** 一页话题的默认条数（与上游 `readPageSize` 的缺省一致；不新增设置项）。 */
export const FEISHU_READ_PAGE_SIZE = 20

/** 「周围」的两侧条数：前后各五条（§I.3）。 */
export const AROUND_SIDE = 5

/** 往后翻「更早」时每页十条（上游同）。 */
export const AROUND_OLDER_PAGE = 10

/** 五种读法（§I.3 的 `feishu/<trigger>/{message,root,parent,thread,around}`）。 */
export type FeishuReadSection = 'message' | 'root' | 'parent' | 'thread' | 'around'

/**
 * 一次读的状态。`available` 之外都不是「空结果」：
 * - `deleted`：消息被撤回（正文不下发）；`missing`：CLI 没返回这条消息；
 * - `forbidden`：机器人读不了这个会话/这条消息（权限、不在群里）；
 * - `no_thread` / `no_root` / `no_parent`：这条消息本来就没有那一项；
 * - `chat_neighbours`：没有话题，读到的是周围的聊天。
 */
export type FeishuReadStatus =
  | 'available'
  | 'deleted'
  | 'missing'
  | 'forbidden'
  | 'no_thread'
  | 'no_root'
  | 'no_parent'
  | 'chat_neighbours'

/** 一条消息的读（`message` / `root` / `parent`）：读不到时 `message` 是 null，状态说明原因。 */
export interface FeishuOne {
  readonly status: FeishuReadStatus
  readonly message: ContextMessage | null
  readonly body: Record<string, unknown>
}

/** 一页消息的读（`thread` / `around`）：`next` 是下一次读的 cursor（原样交回）。 */
export interface FeishuMany {
  readonly status: FeishuReadStatus
  readonly messages: readonly ContextMessage[]
  readonly next?: string | undefined
  readonly body: Record<string, unknown>
}

/** 两种结果之一；`'message' in result` 区分它们。 */
export type FeishuReadResult = FeishuOne | FeishuMany

/** 一次读的输入：命令端口、CLI、Trigger、读法，以及可选的游标与页大小。 */
export interface FeishuReadRequest {
  readonly host: CommandsHost
  readonly cli: string
  readonly trigger: Trigger
  readonly section: FeishuReadSection
  readonly cursor?: string | undefined
  readonly pageSize?: number | undefined
  readonly signal?: AbortSignal | undefined
}

/** `threadContext` 需要的部署事实：图片要落盘的位置（§H.17 的 `<stateDir>/inbox/images`）。 */
export interface FeishuContextOptions {
  readonly stateDir?: string | undefined
}

/** 取字符串字段（缺失 / 非字符串 → 空串）。 */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Trigger 的会话坐标：`meta` 是 `feishuTrigger` 写下的原文（§I.3 Trigger 行）。 */
function chatOf(trigger: Trigger): { chatId: string; direct: boolean } {
  return { chatId: textOf(trigger.meta['chatId']), direct: trigger.meta['direct'] === true }
}

/** 话题的读取 id：`omt_…` 优先；没有时用根消息 id（CLI 接受 `om_` 并解析成话题）。 */
function threadIdOf(trigger: Trigger): string {
  return textOf(trigger.meta['threadId']) || textOf(trigger.meta['rootId'])
}

/**
 * 一条读到的消息 → 语境里的一行（§I.1 的 `ContextMessage`）。`from` 优先用发送者名字，
 * 没有名字才退回 open_id；已删消息的正文留空（不展示撤回前的内容）。
 */
function viewOf(message: FeishuMessage): ContextMessage {
  const deleted = message.deleted === true
  return {
    id: message.messageId,
    from: message.senderName ?? message.senderId,
    at: feishuTime(message.createTime),
    text: deleted ? '' : withMentionNames(message.text, message.mentions),
    ...(message.senderType === 'bot' ? { bot: true as const } : {}),
    ...(deleted ? { deleted: true as const } : {}),
    ...(message.parentId === undefined ? {} : { replyTo: message.parentId }),
    ...(message.link === undefined ? {} : { url: message.link })
  }
}

/**
 * 把一次 CLI 失败折成明确状态（§I.3「无权限/已删 → 明确 `status` 而不是空」）：
 * - 撤回（业务码 `230011`，或文本说 withdrawn/recalled）→ `deleted`；
 * - 权限（401/403，或文本说 permission / forbidden / 不在群里 / scope）→ `forbidden`；
 * - 找不到（404，或文本说 not found）→ `missing`；
 * - 其余（限流、超时、崩溃、没有业务码）→ undefined，调用方抛错让它重试。
 *
 * 只认 `CliError`：解析器自己的错误（跨群、分页不前进）不该被当成远端状态。
 */
export function feishuReadStatus(error: unknown): 'deleted' | 'missing' | 'forbidden' | undefined {
  if (!(error instanceof CliError)) return undefined
  const message = error.message
  if (error.code === WITHDRAWN_CODE || /withdrawn|recalled|recall/i.test(message)) return 'deleted'
  if (
    error.code === 401 ||
    error.code === 403 ||
    /permission|forbidden|unauthori[sz]ed|no access|not (?:a )?member|out of the chat|not in (?:the )?chat|scope/i.test(
      message
    )
  ) {
    return 'forbidden'
  }
  if (error.code === 404 || /not found|no such message|does not exist/i.test(message)) return 'missing'
  return undefined
}

/** 分页必须前进：`has_more` 却没有新 token、或 token 原地打转，都是「读不完」。 */
function advancing(token: string | undefined, cursor: string | undefined): string {
  if (token === undefined || token === cursor) {
    throw new Error('Feishu pagination did not advance; the context is incomplete')
  }
  return token
}

/** 资源路径（§I.3）：`feishu/<trigger-id>/<section>[/<cursor>]`，也是 `body.next_resource`。 */
function resourceOf(trigger: Trigger, section: FeishuReadSection, next: string | undefined): string {
  const base = `feishu/${trigger.id}/${section}`
  return next === undefined ? base : `${base}/${encodeURIComponent(next)}`
}

/** 一页消息的 `body`：Source 自有的原始体（§I.1），下一层读法可直接照抄 `next_resource`。 */
function pageBody(
  trigger: Trigger,
  section: FeishuReadSection,
  messages: readonly ContextMessage[],
  next: string | undefined,
  extras: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    status: extras['status'] ?? 'available',
    messages,
    next_resource: next === undefined ? null : resourceOf(trigger, section, next),
    ...extras
  }
}

/** 一条消息的 `body`。 */
function oneBody(status: FeishuReadStatus, message: ContextMessage | null): Record<string, unknown> {
  return { status, message }
}

/** 读一条消息（`message` / `root` / `parent` 共用）。 */
async function readOneMessage(
  api: FeishuApi,
  trigger: Trigger,
  messageId: string
): Promise<FeishuOne> {
  const { chatId, direct } = chatOf(trigger)
  try {
    const page = await api.messages({ messageIds: [messageId], chatId, direct })
    const row = page.messages.find((message) => message.messageId === messageId)
    if (row === undefined) return { status: 'missing', message: null, body: oneBody('missing', null) }
    // 读回来的消息必须还在同一个会话里（`+messages-mget` 带 `chat_id`，§I.3 的读法按 Trigger 锚定）。
    if (row.chatId !== chatId) {
      throw new Error('Feishu returned a message outside the source chat')
    }
    const message = viewOf(row)
    const status: FeishuReadStatus = row.deleted === true ? 'deleted' : 'available'
    return { status, message, body: oneBody(status, message) }
  } catch (error) {
    const status = feishuReadStatus(error)
    if (status === undefined) throw error
    return { status, message: null, body: oneBody(status, null) }
  }
}

/** 读一页话题回复（`thread`）。 */
async function readThreadPage(request: FeishuReadRequest, api: FeishuApi): Promise<FeishuMany> {
  const { trigger, cursor } = request
  const { chatId, direct } = chatOf(trigger)
  const threadId = threadIdOf(trigger)
  if (threadId === '') {
    return { status: 'no_thread', messages: [], body: pageBody(trigger, 'thread', [], undefined, { status: 'no_thread' }) }
  }
  try {
    const page = await api.threadMessages({
      chatId,
      direct,
      threadId,
      ...(cursor === undefined ? {} : { pageToken: cursor }),
      pageSize: request.pageSize ?? FEISHU_READ_PAGE_SIZE
    })
    const messages = page.messages.map(viewOf)
    let next: string | undefined
    if (page.hasMore) next = advancing(page.pageToken, cursor)
    return {
      status: 'available',
      messages,
      ...(next === undefined ? {} : { next }),
      body: pageBody(trigger, 'thread', messages, next, {
        thread_id: threadId,
        ...(page.skipped === 0 ? {} : { skipped: page.skipped })
      })
    }
  } catch (error) {
    const status = feishuReadStatus(error)
    if (status === undefined) throw error
    return { status, messages: [], body: pageBody(trigger, 'thread', [], undefined, { status }) }
  }
}

/** 一条消息周围的聊天：五条更早 + 自己 + 五条更晚；游标页是更早的十条（倒序读回再正过来）。 */
async function readAroundPage(request: FeishuReadRequest, api: FeishuApi): Promise<FeishuMany> {
  const { trigger, cursor } = request
  const { chatId, direct } = chatOf(trigger)
  const at = Date.parse(trigger.at)
  if (!Number.isFinite(at)) {
    throw new Error('The source Feishu message has no time to read the chat around')
  }
  const when = new Date(at).toISOString()
  try {
    if (cursor !== undefined) {
      const older = await api.chatMessages({
        chatId,
        direct,
        until: when,
        order: 'desc',
        pageToken: cursor,
        pageSize: AROUND_OLDER_PAGE
      })
      const messages = older.messages.toReversed().map(viewOf)
      const next = older.hasMore ? advancing(older.pageToken, cursor) : undefined
      return {
        status: 'available',
        messages,
        ...(next === undefined ? {} : { next }),
        body: pageBody(trigger, 'around', messages, next, older.skipped === 0 ? {} : { skipped: older.skipped })
      }
    }
    // 服务端的时间窗含同一秒：更早一页因此也含消息自己，稍后一页重读时按 id 去重。
    const earlier = await api.chatMessages({
      chatId,
      direct,
      until: when,
      order: 'desc',
      pageSize: AROUND_SIDE + 1
    })
    const later = await api.chatMessages({
      chatId,
      direct,
      since: when,
      order: 'asc',
      pageSize: AROUND_SIDE + 1
    })
    const seen = new Set<string>()
    const merged: FeishuMessage[] = []
    for (const message of [...earlier.messages.toReversed(), ...later.messages]) {
      if (seen.has(message.messageId)) continue
      seen.add(message.messageId)
      merged.push(message)
    }
    const messages = merged.map(viewOf)
    const next = earlier.hasMore ? advancing(earlier.pageToken, undefined) : undefined
    const skipped = earlier.skipped + later.skipped
    return {
      status: 'available',
      messages,
      ...(next === undefined ? {} : { next }),
      body: pageBody(trigger, 'around', messages, next, skipped === 0 ? {} : { skipped })
    }
  } catch (error) {
    const status = feishuReadStatus(error)
    if (status === undefined) throw error
    return { status, messages: [], body: pageBody(trigger, 'around', [], undefined, { status }) }
  }
}

/**
 * 读一条 Trigger 的一段语境（§I.3 的五种读法）。`signal` 取消时底层调用抛 AbortError，
 * 调用方（评估窗口）据此给 `timedOut`；这里不把取消折成状态。
 */
export async function feishuRead(request: FeishuReadRequest): Promise<FeishuReadResult> {
  const host = request.signal === undefined ? request.host : request.host.withSignal(request.signal)
  const api = createFeishuApi(host, request.cli)
  const meta = request.trigger.meta
  switch (request.section) {
    case 'message': {
      const messageId = textOf(meta['messageId'])
      if (messageId === '') return { status: 'missing', message: null, body: oneBody('missing', null) }
      return readOneMessage(api, request.trigger, messageId)
    }
    case 'root': {
      const rootId = textOf(meta['rootId'])
      if (rootId === '') return { status: 'no_root', message: null, body: oneBody('no_root', null) }
      return readOneMessage(api, request.trigger, rootId)
    }
    case 'parent': {
      const parentId = textOf(meta['parentId'])
      if (parentId === '') return { status: 'no_parent', message: null, body: oneBody('no_parent', null) }
      return readOneMessage(api, request.trigger, parentId)
    }
    case 'thread':
      return readThreadPage(request, api)
    case 'around':
      return readAroundPage(request, api)
    default:
      throw new Error(`Unknown Feishu read section: ${String(request.section)}`)
  }
}

/** 把一次读折成 kind 契约里的 `ContextPart`（§I.1）；`body` 原样保留。 */
function partOf(result: FeishuReadResult): ContextPart {
  if ('message' in result) {
    return {
      messages: result.message === null ? [] : [result.message],
      body: result.body,
      status: result.status
    }
  }
  return {
    messages: result.messages,
    ...(result.next === undefined ? {} : { next: result.next }),
    body: result.body,
    status: result.status
  }
}

/**
 * kind 的 `threadContext`（§I.1）：绑定 CLI 与部署事实，评估与资源读都从这里进。
 * `thread` 没有话题时退化成 `around` 的「聊天邻居」，并带 `chat_neighbours`；邻居窗口只有
 * 一页（不把整段群历史读进评估窗口），与上游同。
 */
export function feishuThreadContext(
  cli: string,
  options: FeishuContextOptions = {}
): ThreadContext<FeishuConfig> {
  return {
    messageId: (trigger) => textOf(trigger.meta['messageId']),
    async read(host, trigger, part, cursor, _config, signal) {
      const result = await feishuRead({
        host,
        cli,
        trigger,
        section: part,
        ...(cursor === undefined ? {} : { cursor }),
        signal
      })
      if (part === 'thread' && result.status === 'no_thread') {
        const around = await feishuRead({ host, cli, trigger, section: 'around', signal })
        // 只有真的读到了邻居才是 `chat_neighbours`；读不了（无权限/已删）保留明确状态，
        // 不能用「空的 chat_neighbours」冒充读到了内容。
        if ('messages' in around && around.status === 'available') {
          return {
            messages: around.messages,
            body: {
              status: 'chat_neighbours',
              messages: around.messages,
              next_resource: null
            },
            status: 'chat_neighbours'
          }
        }
        return partOf(around)
      }
      return partOf(result)
    },
    images: admissionImageKeys,
    image: (host, trigger, imageId, signal) =>
      downloadFeishuImage({ host, cli, stateDir: options.stateDir, trigger, imageId, signal })
  }
}

/** 消息 id 的匹配（`om_…`）。 */
const MESSAGE_ID = /\bom_[A-Za-z0-9_-]+/g

/** 群 id 的匹配（`oc_…`）。 */
const CHAT_ID = /\boc_[A-Za-z0-9_-]+/g

/** 链接的匹配：到空白或常见的中英文断句符为止。 */
const LINK = /https?:\/\/[^\s<>"'`）】]+/g

/** 链接尾部的标点不属于 URL（`…?token=t.` 的那个句号）。 */
const TRAILING = /[)\],.;:!?，。；、）】]+$/

/**
 * `find`（§I.3、§M.2 Search）：把消息 id、群 id、链接解析成**搜索词**，`threads` 留空。
 *
 * 为什么不产出 Thread key（coordinator 裁决）：
 * - Feishu 的 Thread key 是 `<chatId>:<rootId>`（私聊是 `<chatId>:direct`）。消息 id 只说明
 *   是哪条消息，说明不了它在哪个群、根消息是谁；消息链接（`…/message/link/open?token=…`）
 *   的 token 不透明。`find` 是纯函数、没有 I/O，推不出来就不能编。
 * - 群 id 只说明是哪个群，说明不了根消息；而「这个群是私聊」在当前配置形状里表达不出来
 *   （`chats` 是群清单、`directMessages` 是开关，都不是「某个 oc_ 是 DM」），所以也不产出
 *   `<oc_>:direct` 这种伪 key。
 *
 * 搜索词保留用户原文（整段查询）与规范化后的 token（去重后的 `om_…` / `oc_…` / 完整 URL）；
 * 搜索页据此在 Trigger 正文、存储的链接与 Thread key 上匹配。不要把这里改成前缀/后缀匹配：
 * 那会让消费者（#48）约定的「精确 key」变成模式匹配。
 */
export function feishuFind(query: string): { threads: readonly string[]; terms: readonly string[] } {
  const terms: string[] = []
  const add = (value: string): void => {
    if (value.length > 0 && !terms.includes(value)) terms.push(value)
  }
  add(query.trim())
  for (const match of query.match(MESSAGE_ID) ?? []) add(match)
  for (const match of query.match(CHAT_ID) ?? []) add(match)
  for (const match of query.match(LINK) ?? []) add(match.replace(TRAILING, ''))
  return { threads: [], terms }
}

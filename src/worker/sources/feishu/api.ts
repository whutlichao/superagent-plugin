// Feishu 的读取端口（§I.3「历史回填 / 话题轮询 / 群名刷新」三行的最小面）：只读四种东西——
// 群列表、群历史、话题回复——而且只经 `CommandsHost` 调 `lark-cli`（§I.4 的白名单与 argv 数组）。
//
// 形状取自 lark-cli 1.0.96 自己的输出契约（`lark-cli skills read lark-im/references/
// lark-im-chat-messages-list.md`）：`{messages, total, has_more, page_token}`，每条消息带
// `message_id / msg_type / create_time / sender / content / deleted / updated / mentions /
// thread_id`。解析是**容忍**的：畸形条目记数跳过，缺字段不抛错。
import type { CommandsHost } from '../commands.ts'
import type { FeishuMessage } from './translate.ts'
import { feishuHistoryOf } from './translate.ts'

/** 一页消息（三条读取路径共用）。 */
export interface FeishuPage {
  readonly messages: readonly FeishuMessage[]
  readonly hasMore: boolean
  readonly pageToken?: string
  /** 这一页里读不懂、被跳过的条目数（§I.6 的「畸形条目跳过并计数」）。 */
  readonly skipped: number
}

/** 一个机器人已加入的群（`+chat-list` 的一行）。 */
export interface FeishuChat {
  readonly chatId: string
  readonly name?: string
  readonly direct: boolean
}

/** 读一页群历史需要的参数（`since`/`until` 是 ISO-8601 文本）。 */
export interface FeishuChatQuery {
  readonly chatId: string
  readonly direct: boolean
  readonly since?: string
  readonly until?: string
  readonly pageToken?: string
  readonly pageSize?: number
}

/** 读一页话题回复需要的参数。 */
export interface FeishuThreadQuery {
  readonly chatId: string
  readonly direct: boolean
  readonly threadId: string
  readonly pageToken?: string
  readonly pageSize?: number
}

/** Feishu 的读取面（测试用 FakeCommands 喂同一个契约）。 */
export interface FeishuApi {
  /** 机器人已加入的群（bot 身份拿不到私聊列表，私聊从事件流得知）。 */
  chats(): Promise<readonly FeishuChat[]>
  /** 一个会话的历史消息，按创建时间升序（分页）。 */
  chatMessages(query: FeishuChatQuery): Promise<FeishuPage>
  /** 一个话题的回复，按创建时间升序（分页）。 */
  threadMessages(query: FeishuThreadQuery): Promise<FeishuPage>
}

/** 一页的默认大小（lark-cli 上限 50）。 */
export const DEFAULT_PAGE_SIZE = 50

/** 一个对象是否像 `{...}`（null 与数组都不算）。 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 取字符串字段（缺失 / 非字符串 → 空串）。 */
function textOf(value: Record<string, unknown>, field: string): string {
  const found = value[field]
  return typeof found === 'string' ? found : ''
}

/** 解析一行 lark-cli 输出；不是 JSON 对象就抛错（这一页失败、游标不动）。 */
function parseObject(output: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    throw new Error('lark-cli returned a response that is not JSON')
  }
  if (!isRecord(parsed)) throw new Error('lark-cli returned a response that is not an object')
  return parsed
}

/** `messages` 数组（缺失当空页）。 */
function messagesOf(page: Record<string, unknown>): readonly unknown[] {
  const messages = page['messages']
  return Array.isArray(messages) ? messages : []
}

/** 把一页翻成端口形状：逐条翻译，读不懂的条目只记数（§I.6）。 */
function pageOf(page: Record<string, unknown>, chatId: string, direct: boolean): FeishuPage {
  const messages: FeishuMessage[] = []
  let skipped = 0
  for (const entry of messagesOf(page)) {
    const message = feishuHistoryOf(entry, { chatId, direct })
    if (message === undefined) skipped += 1
    else messages.push(message)
  }
  const pageToken = textOf(page, 'page_token')
  return {
    messages,
    hasMore: page['has_more'] === true,
    ...(pageToken.length === 0 ? {} : { pageToken }),
    skipped
  }
}

/**
 * `lark-cli` 驱动的读取端口。所有参数都是 argv 数组（§I.4）：群/话题 id 与时刻作为独立的
 * 参数进入，消息正文永远不出现在读路径里。
 */
export function createFeishuApi(commands: CommandsHost, cli: string): FeishuApi {
  /** 分页参数（三条命令同名同义）。 */
  const pageArgs = (pageSize: number | undefined, pageToken: string | undefined): string[] => [
    '--order',
    'asc',
    '--page-size',
    String(pageSize ?? DEFAULT_PAGE_SIZE),
    ...(pageToken === undefined ? [] : ['--page-token', pageToken])
  ]

  return {
    async chats(): Promise<readonly FeishuChat[]> {
      const output = await commands.run(cli, [
        'im',
        '+chat-list',
        '--as',
        'bot',
        '--page-all',
        '--page-size',
        '100'
      ])
      const parsed = parseObject(output)
      const rows = Array.isArray(parsed['chats']) ? parsed['chats'] : []
      const chats: FeishuChat[] = []
      for (const row of rows) {
        if (!isRecord(row)) continue
        const chatId = textOf(row, 'chat_id')
        if (chatId.length === 0) continue
        const name = textOf(row, 'name')
        chats.push({
          chatId,
          ...(name.length === 0 ? {} : { name }),
          direct: textOf(row, 'chat_mode') === 'p2p'
        })
      }
      return chats
    },

    async chatMessages(query: FeishuChatQuery): Promise<FeishuPage> {
      const output = await commands.run(cli, [
        'im',
        '+chat-messages-list',
        '--as',
        'bot',
        '--chat-id',
        query.chatId,
        ...pageArgs(query.pageSize, query.pageToken),
        ...(query.since === undefined ? [] : ['--start', query.since]),
        ...(query.until === undefined ? [] : ['--end', query.until])
      ])
      return pageOf(parseObject(output), query.chatId, query.direct)
    },

    async threadMessages(query: FeishuThreadQuery): Promise<FeishuPage> {
      const output = await commands.run(cli, [
        'im',
        '+threads-messages-list',
        '--as',
        'bot',
        '--thread',
        query.threadId,
        ...pageArgs(query.pageSize, query.pageToken)
      ])
      return pageOf(parseObject(output), query.chatId, query.direct)
    }
  }
}

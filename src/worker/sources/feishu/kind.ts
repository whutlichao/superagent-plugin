// Feishu Source kind（§I.1 的协议、§I.3 的读取面与写面）：监听范围、Channel、准入表与名单
// 同步都在这里声明；事件流、回填与话题轮询本身在 `stream.ts` / `poll.ts`（组合根按 §N.1 的
// 节奏驱动），发送与成员读取的实现分别在 `channel.ts` / `sync.ts`。
//
// `scope` 决定「这条 Trigger 我听不听」（Gate 之前的第一层，§K.1）：配置里列出的群按各自的
// `listen` 判，未列出的群看 `otherChats`，私聊看 `directMessages`。准入行 id 与它一致
// （`<chatId>` / `other` / `direct`），`policy.rows` 与 `channel.allowed` 因此不会各说各话。
import type { ScopeResult } from '../../core/index.ts'
import { array, object, refine, string } from '../../infra/schema.ts'
import type { Deployment, Localized, ScopeInput, SourceKind } from '../kind.ts'
import { sendFeishu, feishuLink } from './channel.ts'
import type { FeishuConfig } from './config.ts'
import { feishuConfigSchema } from './config.ts'
import { runFeishuSync } from './sync.ts'
import { FEISHU_SOURCE } from './translate.ts'
import { feishuFind, feishuThreadContext } from './read.ts'
import type { FeishuContextOptions } from './read.ts'

/** 这个 kind 的稳定 id。 */
export const FEISHU_KIND = 'feishu'

/** 中英双语短句的简写（`Localized` 两种语言都要有值，与 `locales.test` 同一纪律）。 */
const both = (zh: string, en: string): Localized => ({ zh, en })

/**
 * 一条 Trigger 的会话坐标（`meta` 里的 `chatId` / `direct`）。缺 `chatId` 的 Trigger 不是
 * Feishu 能读出来的形状：当作不在任何群里，交给 `otherChats` 的规则。
 */
function chatOf(meta: Record<string, unknown>): { chatId: string; direct: boolean } {
  const chatId = meta['chatId']
  return {
    chatId: typeof chatId === 'string' ? chatId : '',
    direct: meta['direct'] === true
  }
}

/**
 * 名单上的一行：Feishu 身份是 open_id（`ou_`）。名字是可选的显示值（同步会按群里的名字刷新）。
 */
const allowedUserSchema = object({
  id: string().trim().regex(/^ou_[a-zA-Z0-9]+$/),
  name: string().trim().min(1).max(100).optional()
}).strict()

/** `bots` 名单的一行：App ID（`cli_`）或 open_id（`ou_`）都可以（§K.2 第 5 条）。 */
const botIdentitySchema = object({
  id: string().trim().regex(/^(cli|ou)_[a-zA-Z0-9]+$/),
  name: string().trim().min(1).max(100).optional()
}).strict()

/**
 * Policy 里属于 Feishu 的部分（§K.1）：允许名单、bots 名单与名单同步的来源群。
 * `admission` 不在这里——它由 Policy 自己的 schema 校验，准入行的 id 由 `rows()` 声明。
 * 重复的 open_id 是配置错误（同一个人的两行没有意义）。
 */
const feishuPolicySchema = refine(
  object({
    allowed: array(allowedUserSchema).default([]),
    bots: array(botIdentitySchema).default([]),
    syncChat: string().trim().regex(/^(oc_[a-zA-Z0-9]+)?$/).default('')
  }).strict(),
  (part) => new Set(part.allowed.map((entry) => entry.id)).size === part.allowed.length,
  'must not repeat a user id'
)

/** 地址里的会话坐标（`ChannelRef.address` 的 `chatId` / `direct`）。 */
function addressChat(address: Record<string, string>): { chatId: string; direct: boolean } {
  return { chatId: address['chatId'] ?? '', direct: address['direct'] === 'true' }
}

/**
 * 监听范围（§I.3 准入行）：列出的群按 `listen` 判；未列出的群看 `otherChats`；私聊看
 * `directMessages`。`observed` 只对「列出的全部消息」为真——其余情况都要点名叫它。
 * `channel.allowed` 与 `policy.rows` 读同一条判定，避免「准入表允许、回复却发不出去」。
 */
export function feishuScope(trigger: ScopeInput, config: FeishuConfig): ScopeResult {
  const { chatId, direct } = chatOf(trigger.meta)
  if (direct) {
    return config.directMessages
      ? { listened: true, observed: false, row: 'direct' }
      : { listened: false, reason: 'direct_messages_not_allowed' }
  }
  const chat = config.chats.find((item) => item.chatId === chatId)
  if (chat !== undefined) {
    return { listened: true, observed: chat.listen === 'all', row: chat.chatId }
  }
  return config.otherChats === 'mentions'
    ? { listened: true, observed: false, row: 'other' }
    : { listened: false, reason: 'chat_not_allowed' }
}

/**
 * 造一个 Feishu kind。`cli` 是配置的机器人 `lark-cli`：Channel、名单同步、语境读与图片下载
 * 都需要它，而 `SourceChannel.send` / `sync.run` / `threadContext.image` 的签名里没有配置
 * （§I.1），所以由组合根在注册时闭包进来（设置变了就重新注册，与设计 §N.2 的「重启后生效」
 * 一致）。`options.stateDir` 是图片落盘的位置（§H.17：`<stateDir>/inbox/images`）。
 */
export function createFeishuKind(
  cli = 'lark-cli',
  options: FeishuContextOptions = {}
): SourceKind<FeishuConfig> {
  return {
    kind: FEISHU_KIND,
    title: both('飞书', 'Feishu'),
    description: both(
      '消费机器人事件流、补收群历史并轮询订阅的话题，把消息变成 Trigger。',
      'Consumes the bot event stream, recovers chat history and polls subscribed topics, turning messages into Triggers.'
    ),
    schema: feishuConfigSchema,
    fields: [
      {
        key: 'cli',
        type: 'text',
        label: both('机器人的 lark-cli', 'Bot lark-cli'),
        hint: both(
          '命令名或绝对路径，指向只允许机器人身份（strict mode bot）的 lark-cli 配置。',
          'A command name or absolute path of a lark-cli configuration that allows only the bot identity (strict mode bot).'
        )
      },
      {
        key: 'chats',
        type: 'rows',
        label: both('接收的群', 'Chats'),
        hint: both(
          '「仅 @」只接收点名机器人的消息和已有 Ticket 的话题；「全部消息」也接收其余消息，需要机器人有读取全部消息的权限。',
          '"@ only" receives messages that mention the bot and Topics that have Tickets; "All" also receives the rest, from which Eval may infer work; the bot needs permission to read all messages.'
        ),
        columns: [
          {
            key: 'chatId',
            type: 'text',
            label: both('群', 'Chat'),
            pattern: 'oc_[a-zA-Z0-9]+',
            choose: both('选择机器人已加入的群', 'Choose a chat the bot has joined'),
            refresh: both('刷新群列表', 'Refresh chats')
          },
          {
            key: 'listen',
            type: 'select',
            label: both('接收', 'Receive'),
            options: [
              { value: 'mentions', label: both('仅 @', '@ only') },
              { value: 'all', label: both('全部消息', 'All') }
            ]
          }
        ]
      },
      {
        key: 'otherChats',
        type: 'select',
        label: both('其他群', 'Other chats'),
        options: [
          { value: 'none', label: both('不接收', 'Not received') },
          { value: 'mentions', label: both('仅 @', '@ only') }
        ],
        hint: both(
          '机器人已加入、但没列在上面的群。「仅 @」接收那里点名机器人的消息；谁的消息能发起工作看准入。',
          'Chats the bot has joined that are not listed above. "@ only" receives messages there that mention the bot; whose messages may originate work is the admission.'
        )
      },
      {
        key: 'directMessages',
        type: 'switch',
        label: both('接收私聊', 'Direct messages')
      }
    ],
    facts: (deployment: Deployment) => [
      {
        key: 'bot',
        value:
          deployment.feishuBotId === ''
            ? both('未检查', 'Not checked')
            : deployment.feishuBotId
      }
    ],
    // 事件流一条、历史回填一条（§N.4 的条目表）：两者失败阈值不同，写者各自只有自己。
    health: ['feishu', 'history'],
    scope: feishuScope,
    /**
     * 写面（§I.3 Channel 行、§J.1）：回复落在话题根消息上；`allowed` 与 `scope` 同一条判定，
     * 于是「Source 不再监听这个群」就是 outbox 的 drop 原因 a。
     */
    channel: {
      allowed(address: Record<string, string>, config: FeishuConfig): boolean {
        const chat = addressChat(address)
        return feishuScope({ source: FEISHU_SOURCE, meta: chat }, config).listened
      },
      send: (host, message) => sendFeishu(host, cli, message),
      link: (address, links) => feishuLink(address, links)
    },
    /**
     * 读面（§I.3 线程上下文/图片两行）：五种读法 + 按 id 取图。语境只读 Trigger 自己锚定的
     * 消息与会话；图片落盘在 `<stateDir>/inbox/images`。
     */
    threadContext: feishuThreadContext(cli, options),
    /** 搜索（§I.3 find 行）：三类输入只产出搜索词；没有可推导的 Thread key 时不编一个。 */
    find: feishuFind,
    /**
     * Policy 的 Feishu 部分（§K.1、§I.3 准入行）：每个配置的群一行，再加「其他群」与
     * 「私聊」。行 id 与 `scope` 的 `row` 逐字相同（`<chatId>` / `other` / `direct`），
     * 保存时因此能校验准入表的 key 只指向这些行（§K.8）。
     */
    policy: {
      schema: feishuPolicySchema,
      fields: [
        {
          key: 'allowed',
          type: 'rows',
          label: both('能发起工作的飞书用户', 'Feishu users who may originate work'),
          columns: [
            {
              key: 'id',
              type: 'text',
              label: both('open_id', 'open_id'),
              pattern: 'ou_[a-zA-Z0-9]+'
            },
            { key: 'name', type: 'text', label: both('名字', 'Name'), optional: true }
          ]
        },
        {
          key: 'syncChat',
          type: 'text',
          label: both('同步来源群', 'Sync chat'),
          pattern: '(oc_[a-zA-Z0-9]+)?',
          choose: both('不同步', 'Do not sync'),
          hint: both(
            '同步时，名单变成这个群里的人：新成员加入，离开的人移除，名字取群里的名字。启动时与点「立即同步」时进行。',
            'Syncing makes the list the people in this chat: new members join, people who left are removed, and names follow the chat. It runs at startup and on Sync now.'
          )
        },
        {
          key: 'bots',
          type: 'rows',
          label: both('消息可以成为候选的机器人', 'Bots whose messages may become candidates'),
          hint: both(
            '名单里的机器人在接收的群里发的消息成为推断候选；它们不能发起明确请求，也不能停止 Ticket。其他机器人的消息不接收。',
            "A listed bot's messages in a received chat become inferred candidates; they never make an explicit request or stop a Ticket. Other bots' messages are not admitted."
          ),
          columns: [
            {
              key: 'id',
              type: 'text',
              label: both('App ID 或 open_id', 'App ID or open_id'),
              pattern: '(cli|ou)_[a-zA-Z0-9]+'
            },
            { key: 'name', type: 'text', label: both('名字', 'Name'), optional: true }
          ]
        }
      ],
      explicit: both(
        '名单内的人 @ 机器人或私聊机器人，总是明确的请求，不需要配置。',
        'Someone on the list who mentions the bot or messages it directly always makes an explicit request; that needs no setting.'
      ),
      unnamed: {
        person: both('飞书用户', 'Feishu user'),
        bot: both('飞书机器人', 'Feishu bot')
      },
      /**
       * 名单同步（§I.3「同步」行）：启动时一次、手动「立即同步」、失败按 1 min→1 h 退避，
       * 都由设置层驱动；`sync:<id>` 健康条目也由它写（§N.4）。
       */
      sync: {
        label: both('立即同步', 'Sync now'),
        ready: (part) => typeof part['syncChat'] === 'string' && part['syncChat'] !== '',
        run: (host, part, signal) => runFeishuSync(host, part, signal)
      },
      rows(stored) {
        const parsed = feishuConfigSchema.safeParse(stored)
        const config = parsed.success ? parsed.data : feishuConfigSchema.parse({})
        const all = both('全部消息', 'All')
        const mentions = both('仅 @', '@ only')
        const received = both('接收', 'Received')
        const notReceived = both('不接收', 'Not received')
        return [
          ...config.chats.map((chat) => ({
            id: chat.chatId,
            // 显示名优先（群名可空），但行的 id 永远是 chat id。
            label: chat.name ?? chat.chatId,
            note: chat.listen === 'all' ? all : mentions,
            // 只有「收全部消息」的群才有未点名的格子（票面：格的可用性由该行是否可 observe 决定）。
            cells: {
              listedUnaddressed: chat.listen === 'all',
              unlistedAddressed: true,
              unlistedUnaddressed: chat.listen === 'all'
            }
          })),
          {
            id: 'other',
            label: both('其他群', 'Other chats'),
            note: config.otherChats === 'mentions' ? mentions : notReceived,
            cells: {
              listedUnaddressed: false,
              unlistedAddressed: config.otherChats === 'mentions',
              unlistedUnaddressed: false
            }
          },
          {
            id: 'direct',
            label: both('私聊', 'Direct messages'),
            note: config.directMessages ? received : notReceived,
            cells: {
              listedUnaddressed: false,
              unlistedAddressed: config.directMessages,
              unlistedUnaddressed: false
            }
          }
        ]
      }
    }
  }
}

/** 缺省 kind（注册表、测试与面板的只读查询用）。 */
export const feishuKind: SourceKind<FeishuConfig> = createFeishuKind()

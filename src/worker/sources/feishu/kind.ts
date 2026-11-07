// Feishu Source kind（§I.1 的协议、§I.3 的读取面）：本票只落「监听范围」与「设置派生事实」，
// 事件流、回填与话题轮询本身在 `stream.ts` / `poll.ts`（组合根按 §N.1 的节奏驱动）。
//
// 这里**不发消息**：Channel、准入表与名单同步归 #23；话题语境、图片与搜索归 #22。所以本
// kind 没有 `channel` / `policy`，`registry.send` 对它会回答 `gone`，那正是「还没实现发送」
// 的诚实读数。
//
// `scope` 决定「这条 Trigger 我听不听」（Gate 之前的第一层，§K.1）：配置里列出的群按各自的
// `listen` 判，未列出的群看 `otherChats`，私聊看 `directMessages`。准入行 id 与这里一致
// （`<chatId>` / `other` / `direct`），#23 的 `policy.rows` 直接对齐。
import type { ScopeResult } from '../../core/index.ts'
import type { Deployment, Localized, ScopeInput, SourceKind } from '../kind.ts'
import type { FeishuConfig } from './config.ts'
import { feishuConfigSchema } from './config.ts'

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
 * 造一个 Feishu kind。纯值：没有 I/O，也不持有状态（配置由注册表按实例校验后传入）。
 */
export function createFeishuKind(): SourceKind<FeishuConfig> {
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
    /**
     * 监听范围（§I.3 准入行）：列出的群按 `listen` 判；未列出的群看 `otherChats`；私聊看
     * `directMessages`。`observed` 只对「列出的全部消息」为真——其余情况都要点名叫它。
     */
    scope(trigger: ScopeInput, config: FeishuConfig): ScopeResult {
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
  }
}

/** 缺省 kind（注册表、测试与面板的只读查询用）。 */
export const feishuKind: SourceKind<FeishuConfig> = createFeishuKind()

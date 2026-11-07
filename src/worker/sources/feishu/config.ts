// Feishu Source 的配置（§I.3「配置」行）：本票只落读取面需要的四项——
// - `cli`：机器人的 lark-cli（缺它 → Source 进 setup 态，轮询与事件流都不启动）；
// - `chats`：要接收的群与接收方式（`mentions` 只收 @ 机器人的消息，`all` 收全部）；
// - `directMessages`：是否接收私聊（缺省是）；
// - `otherChats`：机器人已加入但没列出的群（`none` 不接收，`mentions` 只收 @）。
//
// 依赖纪律（§C.2）：配置只有 schema 与类型，不做 I/O；`lark-cli` 的调用在 `api.ts`/`stream.ts`/`poll.ts`。
import { array, boolean, enumOf, object, refine, string } from '../../infra/schema.ts'

/** 一个群的接收方式：只收点名，或收全部消息。 */
export type FeishuListen = 'mentions' | 'all'

/** 一个群（`chats` 的一行）：id 必填，`name` 是给人看的显示名（可空）。 */
export type FeishuChatConfig = {
  readonly chatId: string
  readonly name?: string
  readonly listen: FeishuListen
}

/**
 * Feishu Source 的配置形状。写成类型别名（而不是 interface）：组合根按
 * `Record<string, unknown>` 传配置，别名才有隐式索引签名，不必到处 `as`。
 */
export type FeishuConfig = {
  readonly cli: string
  readonly chats: readonly FeishuChatConfig[]
  readonly directMessages: boolean
  readonly otherChats: 'none' | 'mentions'
}

/** 群 id 的形态（`oc_` + 字母数字；与 lark-cli 的 `chat_id` 一致）。 */
const CHAT_ID = /^oc_[a-zA-Z0-9]+$/

/**
 * 配置的校验与默认值（strict：未知键拒绝）。重复的群是配置错误：同一个群两种接收方式
 * 没有意义，允许它只会让「为什么这条没收到」变成猜谜。
 */
export const feishuConfigSchema = refine(
  object({
    cli: string().trim().default(''),
    chats: array(
      object({
        chatId: string().trim().regex(CHAT_ID),
        name: string().trim().max(60).optional(),
        listen: enumOf(['mentions', 'all'] as const)
      }).strict()
    ).default([]),
    directMessages: boolean().default(true),
    otherChats: enumOf(['none', 'mentions'] as const).default('none')
  }).strict(),
  (config) => new Set(config.chats.map((chat) => chat.chatId)).size === config.chats.length,
  'must not repeat a chat id'
)

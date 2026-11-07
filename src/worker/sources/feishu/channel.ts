// Feishu Channel（§I.3「Channel」行、§J.1 的 drop 原因 b）：在话题里回复。
//
// 四条纪律，`tests/sources-feishu.test.ts` 的 Channel 段逐条断言：
// - **落在话题里**：`--reply-in-thread`（lark-cli 1.0.96 的实测 flag；§I.3「Feishu 用话题回复」）；
// - **幂等**：`--idempotency-key <message id>`——同一条 outbox 消息重试不会在飞书里出现两次。
//   设计允许 `uuid` 或正文隐藏标记；隐藏标记会被人看到，所以用前者。CLI 的键有长度上限
//   （1.0.96：max 50 characters），超长时按 `feishuIdempotencyKey` 确定性截短；
// - **`gone` 只判永久失败**：撤回（业务码 230011）或「找不到」（2300xx + not found）才算目标
//   永远收不到；其余失败原样抛出，由 outbox 按 5 s→300 s 退避重试（§J.2）；
// - **一百词上限先于发送**：`checkedImText` 在调用 CLI 之前拒绝（中英混排按上游分词规则，
//   `infra/text.ts`）；消息正文经 `--markdown` 原样交给 CLI，Markdown→富文本是 CLI 的职责
//   （§I.3），不在这里拼富文本。
//
// 依赖纪律（§C.2）：本文件不 import app、不拿宿主；`lark-cli` 只经 `CommandsHost` 调用，
// 参数是 argv 数组（消息正文永远只是某一个元素，§I.4）。
import { key } from '../../core/index.ts'
import type { OutboundMessage } from '../../core/index.ts'
import { checkedImText } from '../../infra/text.ts'
import type { CommandsHost } from '../commands.ts'
import { CliError } from '../commands.ts'
import type { ChannelLink, ChannelLinks, Localized } from '../kind.ts'

/** 中英双语短句的简写（`Localized` 两种语言都要有值）。 */
const both = (zh: string, en: string): Localized => ({ zh, en })

/** 撤回一条消息的业务码（飞书 `im/v1/messages/:id/reply` 的目标已撤回）。 */
export const WITHDRAWN_CODE = 230011

/**
 * 这次失败是否说明目标消息**永远收不到**（§I.3 Channel 失败处理行）：
 * - `230011`：目标消息已撤回；
 * - 错误文本说 withdrawn（不同版本的 CLI 可能把它放进别的码里）；
 * - `2300xx` 且文本说 not found：目标消息不存在（群还在，消息没了）。
 * 时间超时、进程崩溃、权限问题都不算——它们可以稍后重试。
 */
export function feishuGone(error: unknown): boolean {
  if (!(error instanceof CliError) || error.code === undefined) return false
  if (error.code === WITHDRAWN_CODE) return true
  if (/withdrawn/i.test(error.message)) return true
  return Math.floor(error.code / 100) === 2300 && /not found/i.test(error.message)
}

/** 幂等键的长度上限（lark-cli 1.0.96 `--idempotency-key` 的硬限制：max 50 characters）。 */
export const IDEMPOTENCY_KEY_MAX = 50

/**
 * 一条 outbox 消息的幂等键：不超上限时就是消息 id 本身；超长时**确定性**截短——保留前缀，
 * 尾部换成由完整 id 派生的 32 位 hex。同样的 id 永远得到同样的键，不同的 id 也不会撞。
 */
export function feishuIdempotencyKey(messageId: string): string {
  if (messageId.length <= IDEMPOTENCY_KEY_MAX) return messageId
  const digest = key('feishu-idempotency', messageId)
  return `${messageId.slice(0, IDEMPOTENCY_KEY_MAX - digest.length - 1)}-${digest}`
}

/** 回复目标的消息 id（话题根）；空串表示这条消息没有可回复的对象。 */
function targetOf(address: Record<string, string>): string | undefined {
  const messageId = address['messageId'] ?? ''
  return messageId.length === 0 ? undefined : messageId
}

/**
 * 在目标消息的话题里回一条。命令与每个 flag 都是 lark-cli 1.0.96 的实测值：
 * `im +messages-reply --as bot --message-id <root> --reply-in-thread --markdown <text>
 * --idempotency-key <key>`。`cli` 是配置的机器人 CLI：由组合根在注册 kind 时闭包进来
 * （`SourceChannel.send` 拿不到配置，§I.1）。
 *
 * 先做一百词校验再调 CLI：超限时一个子进程都不该起（发送前拒绝，票面验收）。
 */
export async function sendFeishu(
  host: CommandsHost,
  cli: string,
  message: OutboundMessage
): Promise<'sent' | 'gone'> {
  const target = targetOf(message.channel.address)
  // 没有目标消息的消息永远送不到（不是「稍后重试」）。
  if (target === undefined) return 'gone'
  const text = checkedImText(message.text)
  try {
    await host.run(cli, [
      'im',
      '+messages-reply',
      '--as',
      'bot',
      '--message-id',
      target,
      '--reply-in-thread',
      '--markdown',
      text,
      '--idempotency-key',
      feishuIdempotencyKey(message.id)
    ])
  } catch (error) {
    if (feishuGone(error)) return 'gone'
    throw error
  }
  return 'sent'
}

/** 地址对应的页面：飞书的 chat 深链（缺群 id 时给空链接，面板不假装有页面）。 */
export function feishuLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  const chatId = address['chatId'] ?? links.feishu?.chatId ?? ''
  return {
    url:
      chatId === ''
        ? ''
        : `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(chatId)}`,
    label: both('飞书消息', 'Feishu message')
  }
}

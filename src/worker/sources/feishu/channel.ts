// Feishu Channel（§I.3「Channel」行、§J.1 的 drop 原因 b）：在话题里回复。
//
// 三条纪律，`tests/sources-feishu.test.ts` 的 Channel 段逐条断言：
// - **幂等**：`--idempotency-key <message id>`——同一条 outbox 消息重试不会在飞书里出现两次。
//   设计允许 `uuid` 或正文隐藏标记；飞书的 post 会把 HTML 注释原样显示给人，所以用前者；
// - **`gone` 只判永久失败**：撤回（业务码 230011）或「找不到」（2300xx + not found）才算目标
//   永远收不到；其余失败原样抛出，由 outbox 按 5 s→300 s 退避重试（§J.2）；
// - **一百词上限先于发送**：`checkedImText` 在调用 CLI 之前拒绝（中英混排按上游分词规则，
//   `infra/text.ts`）；Markdown 到富文本的转换由 CLI 负责。
//
// 依赖纪律（§C.2）：本文件不 import app、不拿宿主；`lark-cli` 只经 `CommandsHost` 调用，
// 参数是 argv 数组（消息正文永远只是某一个元素，§I.4）。
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

/** 回复目标：消息 id（话题根）与群 id（链接用）。 */
function targetOf(address: Record<string, string>): { messageId: string; chatId: string } | undefined {
  const messageId = address['messageId'] ?? ''
  if (messageId.length === 0) return undefined
  return { messageId, chatId: address['chatId'] ?? '' }
}

/**
 * 在目标消息的话题里回一条（`im +messages-reply`，lark-cli 1.0.96 的实测命令名）。`cli` 是
 * 配置的机器人 CLI，由组合根在
 * 注册 kind 时闭包进来（`SourceChannel.send` 拿不到配置，§I.1）。
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
      target.messageId,
      '--text',
      text,
      '--idempotency-key',
      message.id
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

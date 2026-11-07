// Input 投递（§E.4）：把一条 Input 渲染成 Markdown 落进 `<stateDir>/inbox/<ticket>/<seq>.md`，
// 再决定「直发」还是「只发指针」，发送恒带回车，可选的送达确认靠回读终端最后几行。
//
// 两条实测约束（附录 C S1，Orca 1.4.251）：
// - `accepted: true` 只代表写进去了：1024 字节以上的单行在 canonical PTY 上永不送达，回执
//   却一模一样，所以确认送达只能靠 `terminal.read` 回读；
// - 含换行的文本在普通终端上会被当成多次提交，所以**直发只发一行**；正文永远在文件里。
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Ticket, TicketInput, Trigger } from '../core/model.ts'
import type { OrcaRuntime } from '../runtime/orca-runtime.ts'
import { mandateInstructions } from './mandate.ts'

/** 直发上限的缺省值（§E.4；S1 实测单行 1023 字节可送达，留出余量取 1000）。 */
export const DEFAULT_INLINE_LIMIT = 1000

/** 送达确认的缺省开关（§E.4 第 4 步：缺省开）。 */
export const DEFAULT_CONFIRM_DELIVERY = true

/** 回读确认的次数与间隔：6 次 × 500 ms，覆盖 S1 实测的 250 ms 可见延迟。 */
export const CONFIRM_READS = 6
export const CONFIRM_INTERVAL_MS = 500

/** 回读时取终端最后多少行。 */
export const CONFIRM_LINES = 40

/** 渲染进文件的外部正文上限；超过就留一行截断指针（原文仍在 URL / Trigger 里）。 */
export const INPUT_TEXT_LIMIT = 4000

/** 投递设置（§E.4 的 `executor.inlineLimit` / `executor.confirmDelivery`）。 */
export interface DeliverySettings {
  readonly inlineLimit: number
  readonly confirmDelivery: boolean
}

/** 一次投递失败：哪一条、第几号、此前已经成功送达了哪些（队列据此退避重试）。 */
export class DeliveryError extends Error {
  readonly inputId: string
  readonly seq: number
  readonly delivered: readonly string[]

  constructor(
    inputId: string,
    seq: number,
    delivered: readonly string[],
    message: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'DeliveryError'
    this.inputId = inputId
    this.seq = seq
    this.delivered = delivered
  }
}

/** `deliverPendingInputs` 的输入。只依赖 seam 与领域类型（§C.2：executor → core, runtime）。 */
export interface DeliverOptions {
  readonly ticket: Ticket
  readonly terminalId: string
  /** `<stateDir>`；inbox 在它下面（§D.5 文件布局）。 */
  readonly stateDir: string
  readonly settings: DeliverySettings
  /** Trigger 的读取口（组合根接仓储；测试接内存表）。 */
  readonly triggerOf: (triggerId: string) => Trigger | undefined
  /** 注入的等待：测试用它记录间隔，不 sleep（§P.1）。 */
  readonly wait?: (milliseconds: number) => Promise<void>
  /** 每条 Input 成功送达后调用一次（组合根在这里立刻 `engine.inputsDelivered`）。 */
  readonly onDelivered?: (inputId: string) => void
}

/** 一次投递的结果。 */
export interface DeliveryResult {
  readonly delivered: readonly string[]
}

/** 一条 Input 在 Ticket 里的序号：`ticket.inputs` 的 1-based 位置，也是 inbox 文件名。 */
export function inputSequence(ticket: Ticket, inputId: string): number {
  const index = ticket.inputs.findIndex((input) => input.id === inputId)
  return index < 0 ? 0 : index + 1
}

/** 一条 Input 的 inbox 文件路径（§D.5：`inbox/<ticket>/<n>.md`）。 */
export function inboxPath(stateDir: string, ticketId: string, seq: number): string {
  return join(stateDir, 'inbox', ticketId, `${seq}.md`)
}

/** 指针行（§E.4 第 3 步的原文）。 */
export function pointerLine(seq: number, path: string): string {
  return `[superagent] 新输入 #${seq}，读它：${path}`
}

/** 一行文本：多行正文被压成单行，避免终端把换行当成多次提交（S1）。 */
export function flatten(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\s*\n\s*/g, ' ⏎ ')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/** 把正文裁到上限，并留一行说明（原文在 URL 或 Trigger 里，永不假装它完整）。 */
function clip(text: string, original: string): string {
  if (text.length <= INPUT_TEXT_LIMIT) return text
  const omitted = text.length - INPUT_TEXT_LIMIT
  return `${text.slice(0, INPUT_TEXT_LIMIT)}\n\n… (truncated: ${omitted} more characters; original: ${original})`
}

/** `replies_to` 的默认写法：Channel 的 source:thread 与地址键值（Source 可覆盖）。 */
export function repliesToOf(trigger: Trigger | undefined): string | undefined {
  const channel = trigger?.channel
  if (!channel) return undefined
  const address = Object.entries(channel.address)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ')
  return address === '' ? `${channel.source}:${channel.thread}` : `${channel.source}:${channel.thread} (${address})`
}

/**
 * `policy-changed` 的正文（§K.5 第 3 条）：旧版本 → 新版本，加上这次变更怎么影响这个
 * Ticket——哪条匹配规则被停用或改写（附新文本），主动工作是否还接受，发起人是否还能发起。
 * 只说这一份影响面里的东西，不把整份 Policy 灌给 worker。
 */
function policyChangeText(input: Extract<TicketInput, { kind: 'policy-changed' }>): string {
  const lines = [`policy changed ${input.from} → ${input.to}`]
  const { effect } = input
  if (effect === undefined) return lines.join('\n')
  for (const rule of effect.rules ?? []) {
    lines.push(
      rule.change === 'disabled'
        ? `- rule "${rule.name}" (${rule.id}) is disabled`
        : `- rule "${rule.name}" (${rule.id}) now reads: ${rule.instruction ?? ''}`
    )
  }
  if (effect.proactive === false) {
    lines.push('- proactive work is no longer accepted: finish only what these rules already allowed')
  }
  if (effect.requesterAllowed === false) {
    lines.push(
      `- ${effect.requester === undefined ? 'the requester' : `${effect.requester.id} (${effect.requester.source})`} can no longer start work here`
    )
  }
  return lines.join('\n')
}

/** 一条 Input 的类型标签（文件里的 `# Input #n — <kind>`）。 */
function kindOf(input: TicketInput): string {
  return input.kind
}

/** 文件里的正文与来源行：trigger 用 Trigger 卡，其余用 Input 自己的文本。 */
function bodyOf(
  input: TicketInput,
  trigger: Trigger | undefined
): { readonly text: string; readonly original: string; readonly source: string } | null {
  switch (input.kind) {
    case 'trigger':
      return trigger === undefined
        ? null
        : {
            text: trigger.text,
            original: trigger.url ?? trigger.id,
            source: `${trigger.source}:${trigger.actor.id}${trigger.human ? ' (human)' : ''}${
              trigger.addressed === undefined ? '' : `, ${trigger.addressed}`
            }`
          }
    case 'text':
    case 'note':
      return { text: input.text, original: input.id, source: input.kind }
    case 'resumed':
      return {
        text: trigger?.text ?? `resumed from ${input.triggerId}`,
        original: trigger?.url ?? input.triggerId,
        source: 'resumed'
      }
    case 'policy-changed':
      return {
        text: policyChangeText(input),
        original: input.id,
        source: 'policy'
      }
    default:
      // `TicketInput` 是闭联合（core/model.ts）；新增 kind 时这里给一条指针而不是猜内容。
      return null
  }
}

/** 渲染成文件用的 Markdown：标记行 + 元数据 + Trigger 卡（§E.4 第 2 步）。 */
export function renderInputMarkdown(
  ticket: Ticket,
  input: TicketInput,
  seq: number,
  trigger: Trigger | undefined,
  repliesTo: string | undefined = repliesToOf(trigger)
): string {
  const body = bodyOf(input, trigger)
  // 主动票的每一条 Input 都重复收窄句：worker 的上下文可能只含这一条。
  const mandate = mandateInstructions(ticket.mandate)
  const lines = [
    `[superagent] #${seq}`,
    '',
    `# Input #${seq} — ${kindOf(input)}`,
    '',
    `- ticket: ${ticket.id} "${ticket.title}"`,
    `- at: ${input.at}`,
    ...(body === null ? [] : [`- from: ${body.source}`]),
    ...(trigger === undefined ? [] : [`- thread: ${trigger.source}:${trigger.threads[0]?.id ?? ''}`]),
    ...(trigger?.url === undefined ? [] : [`- url: ${trigger.url}`]),
    ...(repliesTo === undefined ? [] : [`- replies_to: ${repliesTo}`]),
    ...(mandate === '' ? [] : ['', '## Mandate', '', mandate]),
    '',
    '## Body',
    '',
    body === null ? '(the trigger is not stored any more)' : clip(body.text, body.original)
  ]
  return `${lines.join('\n')}\n`
}

/** 直发用的一行：标记 + 来源 + 压成一行的正文（§E.4 第 3 步的「直发」）。 */
export function inlineDelivery(ticket: Ticket, input: TicketInput, seq: number, trigger: Trigger | undefined): string {
  const body = bodyOf(input, trigger)
  if (body === null) return `[superagent] #${seq} ${kindOf(input)}: (read ${ticket.id})`
  return `[superagent] #${seq} ${body.source}: ${flatten(body.text)}`
}

/**
 * 回读是否看到这一条投递：终端里必须有一行同时带 `[superagent]` 与该投递的 `#<n>`
 * （`#1` 不能匹配 `#12`）。§E.4 第 4 步的确认口径。
 */
export function confirmsDelivery(lines: readonly string[], seq: number): boolean {
  const marker = new RegExp(`#${seq}(?!\\d)`)
  return lines.some((line) => line.includes('[superagent]') && marker.test(line))
}

/**
 * 把一条 Input 写进 inbox（幂等：同一条 Input 每次写同一个路径）。返回文件路径。
 * 文件总是先写：即使发送失败，重试也能读到同一份正文。
 */
export function writeInboxFile(options: {
  readonly stateDir: string
  readonly ticketId: string
  readonly seq: number
  readonly markdown: string
}): string {
  const path = inboxPath(options.stateDir, options.ticketId, options.seq)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, options.markdown, 'utf8')
  return path
}

/** 默认等待：只有生产路径用真定时器，测试一律注入。 */
const realWait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

/**
 * 发送一条投递并按需回读确认。`accepted: false` 立即失败；确认没看到标记也失败——
 * 两次失败都由 effect 的 2 s → 60 s 退避重试（§E.4 第 5 步），而不是在这里等。
 */
async function send(
  runtime: OrcaRuntime,
  terminalId: string,
  text: string,
  seq: number,
  settings: DeliverySettings,
  wait: (milliseconds: number) => Promise<void>
): Promise<void> {
  const receipt = await runtime.sendText(terminalId, text, { enter: true })
  if (!receipt.accepted) throw new Error('the terminal did not accept the delivery')
  if (!settings.confirmDelivery) return
  for (let attempt = 0; attempt < CONFIRM_READS; attempt += 1) {
    const read = await runtime.readTerminal(terminalId, { maxLines: CONFIRM_LINES })
    if (confirmsDelivery(read.lines, seq)) return
    if (attempt < CONFIRM_READS - 1) await wait(CONFIRM_INTERVAL_MS)
  }
  throw new Error(`the terminal never showed [superagent] #${seq}`)
}

/**
 * 依次投递 Ticket 里所有未送达的 Input：每条先落文件，再按长度选直发或指针，发送带回车，
 * 成功一条就 `onDelivered` 一次（重试因此不会重复投已成功的那些）。第一条失败即抛
 * `DeliveryError`，让 effect 退避重试并把失败记在 Ticket 上。
 */
export async function deliverPendingInputs(
  runtime: OrcaRuntime,
  options: DeliverOptions
): Promise<DeliveryResult> {
  const wait = options.wait ?? realWait
  const delivered: string[] = []
  for (const inputId of options.ticket.undelivered) {
    const input = options.ticket.inputs.find((item) => item.id === inputId)
    if (!input) continue
    const seq = inputSequence(options.ticket, input.id)
    if (seq === 0) continue
    const trigger = input.kind === 'trigger' ? options.triggerOf(input.triggerId) : undefined
    const path = writeInboxFile({
      stateDir: options.stateDir,
      ticketId: options.ticket.id,
      seq,
      markdown: renderInputMarkdown(options.ticket, input, seq, trigger)
    })
    const inline = inlineDelivery(options.ticket, input, seq, trigger)
    const text = inline.length <= options.settings.inlineLimit ? inline : pointerLine(seq, path)
    try {
      await send(runtime, options.terminalId, text, seq, options.settings, wait)
    } catch (error) {
      throw new DeliveryError(
        input.id,
        seq,
        delivered,
        `input ${seq} was not delivered: ${error instanceof Error ? error.message : String(error)}`,
        error
      )
    }
    delivered.push(input.id)
    options.onDelivered?.(input.id)
  }
  return { delivered }
}

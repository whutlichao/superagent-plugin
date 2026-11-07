// 结构化原因码与模板：Decision、被过滤的 Trigger、结束的 Assignment 都用它（§K.2 / §K.4）。
// Policy 的 gate 与 Source 的监听范围也可以发自己的字面量原因码（面板会原样显示它）。
//
// 面板文案表按 `reason.<code>` 取词（§M.5）；`terms.test.ts` 断言本表的每个 code 都有对应的
// 键、且键集合与状态码/强度码/结局码一起构成完整的术语键集合。
export const REASONS = {
  said: '{text}',
  // 超时的结论记下尝试次数（§K.7：连续 2 次重试后第 3 次到期）；`{attempts}` 由 Decision 的
  // `reason.values` 提供，面板与 agent 读到的同一份记录。
  timeout: 'Assessment timed out after {attempts} attempts',
  policyChanged: 'Policy changed during assessment',
  noAdmissible: 'No admissible trigger',
  startedTicket: 'Already started ticket {ticket}',
  acceptedBefore: 'Trigger {trigger} was accepted before',
  routed: 'Routed to ticket {ticket}',
  explicitRouted: 'Explicit request from an allowed sender routed by the Router',
  humanStop: 'A person asked to stop',
  forwarded: 'Forwarded to the worker of the Ticket already on this Thread',
  senderNotMember: 'The sender is not on the Source\'s list',
  notHuman: 'The sender is not a person and is not on the Source\'s bots list',
  noMention: 'The message does not address the agent',
  retried: 'Retried by a person',
  hostRestarted: 'The host restarted',
  stopUnknown: 'Stop target is unknown or already ended',
  stopNotExplicit: 'A stop needs an explicit request from a sender on the list',
  directionUnsettled:
    'Implementation intent or target direction is not established, or a product/design decision is still required',
  noRuleMatched: 'No enabled admission rule matched',
  admissionIgnored: 'The admission table for this receiving scope does not admit it',
  ignoredFromCard: 'Ignored from its card, without a rule assessment',
  observed: 'Observe mode: would accept ({text})',
  reportMissing: 'The worker ended without a final report',
  worktreeRemoved: 'The ticket worktree was removed outside the plugin',
  interrupted: 'The host restarted during the assignment'
} as const

/** 原因码：上表的键，外加 Source / Policy 自有的字面量码。 */
export type ReasonCode = keyof typeof REASONS

/** 原因码与模板填槽；`triggerId` 指出一批 Trigger 里这条原因适用于哪一条。 */
export interface Reason {
  code: ReasonCode | (string & {})
  values?: Record<string, string>
  triggerId?: string
}

/** 「某人原话」的原因：面板原样显示，不做翻译。 */
export const said = (text: string): Reason => ({ code: 'said', values: { text } })

/** 把原因格式化成英文（有 `triggerId` 时前置），供 agent 读取。 */
export function reasonText(reasons: readonly Reason[] | Reason | undefined): string {
  return [reasons ?? []]
    .flat()
    .map((reason) => {
      const template: string = REASONS[reason.code as ReasonCode] ?? reason.code
      const text = template.replace(
        /\{(\w+)\}/g,
        (match, name: string) => reason.values?.[name] ?? match
      )
      return reason.triggerId ? `${reason.triggerId}: ${text}` : text
    })
    .join('; ')
}

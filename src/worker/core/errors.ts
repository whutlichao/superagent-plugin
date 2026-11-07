// 用户可见的固定错误码（§G.1：拒绝时给固定 error.code，文案由面板翻译，不解析 message）。
// 只收录 core 真正会抛的码；后续票新增命令时在这里补，面板文案表按 `userError.<code>` 取词。
export const USER_ERRORS = {
  unknownTicket: ['missing', 'Unknown ticket'],
  unknownTrigger: ['missing', 'Unknown trigger'],
  unknownAssignment: ['missing', 'Unknown assignment'],
  unknownDecision: ['missing', 'Unknown decision'],
  unknownProblem: ['missing', 'Unavailable Eval not found'],
  ticketEnded: ['refused', 'Ticket has ended'],
  assignmentEnded: ['refused', 'Assignment has ended; a newer assignment owns this ticket'],
  evalFinished: [
    'refused',
    "Eval {eval} has finished or a later eval replaced it; decide the trigger's current eval"
  ],
  notAdmissible: ['refused', 'Trigger is not admissible: {reason}'],
  notExplicit: [
    'refused',
    'An accept through the main Session is for explicit requests from allowed senders; proactive candidates are accepted only in auto mode with enabled matching rules'
  ],
  ticketStopped: [
    'refused',
    "A person stopped this ticket; new work needs an accept through the main Session"
  ],
  mandateRevoked: [
    'refused',
    "The current policy no longer holds this ticket's mandate; new work needs an accept through the main Session"
  ],
  notRetryable: [
    'refused',
    'Only an open ticket can be retried, and only when its worker last reported failed or blocked and no person has sent a message since, or when delivering an Input to its worker failed'
  ],
  sourceThread: ['refused', 'This is the thread the ticket started on; it stays subscribed'],
  followedThread: [
    'refused',
    "This thread is the ticket's own, such as its pull request's; it stays subscribed"
  ],
  notFollowing: ['refused', 'This ticket does not follow that thread'],
  questionWithResult: [
    'refused',
    'A question for a person cannot also be a ready result or an answer; report it separately'
  ],
  askerWithoutQuestion: ['refused', 'The message that raised a question needs the question it raised'],
  notAsker: [
    'refused',
    "A question must name the person's message that raised it, which reached this ticket"
  ],
  notAnswerable: [
    'refused',
    "An answer must name the person's question it answers, which reached this ticket"
  ],
  ackEnded: ['refused', 'Ticket ended; do not acknowledge historical requests'],
  notReached: ['refused', 'Trigger does not belong to this worker'],
  handedBack: ['refused', 'This ticket handed that trigger back already'],
  handedBackHere: [
    'refused',
    'The worker of this ticket handed that trigger back as beyond it: accept it as new work, attach it to another ticket, or ignore it'
  ],
  workerDecides: [
    'refused',
    'This message reached ticket {tickets} on its thread: its worker decides whether it belongs there and hands back what does not, which then arrives as a candidate. Only a stop goes through the main Session, with kind stop'
  ],
  ackNoChannel: ['refused', 'Acknowledgement requires an assigned human source message'],
  ackNotPerson: [
    'refused',
    'Use the original human trigger, not a bot, CI or worker report'
  ],
  notReady: [
    'refused',
    'Ticket is not ready for delivery. Keep progress internal and wait for a verified ready report; do not relabel progress as an answer or send it through another channel.'
  ],
  notAttention: [
    'refused',
    "Attention requires the ticket's current attention question in human_action. Routine unfinished work stays internal."
  ],
  notQuestion: [
    'refused',
    'An answer must target the original human question, not a worker report or automated trigger'
  ],
  noAnswer: [
    'refused',
    "No worker answer is ready for this human trigger. Wait for the worker's report, or request one with the ticket status command, which acts only on a worker that reported waiting; ordinary progress cannot be relabelled as an answer."
  ],
  noChannel: ['refused', 'No reply channel for this ticket or trigger']
} as const satisfies Record<string, readonly ['missing' | 'refused', string]>

/** core 与命令层会给用户看的固定错误码。 */
export type UserErrorCode = keyof typeof USER_ERRORS

/**
 * Engine 各部分与应用服务在请求无效或引用了不存在的状态时抛出的结构化错误。
 * 调用方只看 `code` 与 `missing`，文案由面板按码翻译（§G.1）。
 */
export class UserError extends Error {
  readonly code: UserErrorCode
  readonly values: Record<string, string>
  readonly missing: boolean

  constructor(code: UserErrorCode, values: Record<string, string> = {}) {
    const [kind, text] = USER_ERRORS[code]
    super(text.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match))
    this.name = 'UserError'
    this.code = code
    this.values = values
    this.missing = kind === 'missing'
  }
}

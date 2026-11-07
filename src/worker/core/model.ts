// 领域模型（§D.1）：Trigger / Thread / Decision / Ticket / Assignment / Mandate 的概念、
// 不变量与集中成表的状态码。本文件零 I/O、零外部依赖：只声明类型与纯函数。
//
// 与上游 `deepseek-ai/dsh-superagent-prototype` 的 `src/core/model.ts` 同形；差异只有两类，
// 都在 §D.1 里写明：
// - Assignment 多一个 `terminalId`（Orca agent 终端是它的外部句柄，§D.1 / §E.3）；
// - Attention 的字段按 §D.1 命名为 `forTriggerId` 并带 `at`，终端来源标 `via: 'terminal'`（§E.7）；
// - Decision 只保留 §D.2 的四种（上游的 legacy `reopen` 不移植）。

import type { Reason } from './reasons.ts'

/** 状态码表：面板文案表（`src/panel/copy.ts`）与它逐键对应，`terms.test.ts` 断言两边相等。 */
export const REPORT_STATES = [
  'progress',
  'waiting',
  'ready',
  'blocked',
  'failed',
  'dropped'
] as const
export type ReportState = (typeof REPORT_STATES)[number]

/** Assignment 的三态（§E.3）：`pending → running → ended`。 */
export const ASSIGNMENT_STATES = ['pending', 'running', 'ended'] as const
export type AssignmentState = (typeof ASSIGNMENT_STATES)[number]

/** Decision 的四种（§D.2）：accept / stop / ignore / unavailable。 */
export const DECISION_KINDS = ['accept', 'stop', 'ignore', 'unavailable'] as const
export type DecisionKind = (typeof DECISION_KINDS)[number]

/** 强度码（§K.2）：只有显式与推断；「未被准入」不是强度。 */
export const STRENGTHS = ['explicit', 'inferred'] as const
export type Strength = (typeof STRENGTHS)[number]

/** Ticket 的结局（§E.8 / §I.5）。 */
export const TICKET_OUTCOMES = ['completed', 'merged', 'closed', 'dropped', 'stopped'] as const
export type TicketOutcome = (typeof TICKET_OUTCOMES)[number]

/** 谁结束了 Ticket。 */
export const TICKET_END_BY = ['executor', 'human'] as const
export type TicketEndBy = (typeof TICKET_END_BY)[number]

/**
 * agent 的可观察状态（§E.7 的 `agent.status.changed` 四态）。领域只把它当作 stage 的
 * 一个输入维度，不解释事件本身；`runtime/orca-runtime.ts` 里的同名联合必须与它一致。
 */
export const AGENT_STATES = ['working', 'blocked', 'waiting', 'done'] as const
export type AgentState = (typeof AGENT_STATES)[number]

/** 准入表的三个格子（§K.2）：按发送者在不在名单、消息是否寻址划分。 */
export type AdmissionCell = 'listedUnaddressed' | 'unlistedAddressed' | 'unlistedUnaddressed'
/** accept mode 三档（§K.4）。 */
export type AcceptMode = 'off' | 'observe' | 'auto'

/** Source 的发送者身份，用该 Source 自己的词汇。 */
export interface ActorRef {
  source: string
  id: string
}
/** Thread 身份；由 Source 决定哪个原生事件构成一个 Thread。 */
export interface ThreadRef {
  source: string
  id: string
}
/** Thread 上可写的地址；地址格式属于 Source。 */
export interface ChannelRef {
  source: string
  thread: string
  address: Record<string, string>
}

/** 跨领域的 Thread 稳定键。 */
export const threadKey = (ref: ThreadRef): string => `${ref.source}:${ref.id}`

/**
 * 把合法时间规范成 `Date#toISOString()` 形态，使内存与 SQL 的文本比较即时间比较；
 * 解析不出来的值原样返回。
 */
export function isoTime(value: string): string {
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : value
}

/** Source 产出的一条不可变事件。`text` 与 `meta` 是不可信的外部数据。 */
export interface Trigger {
  /** `key('<kind>', <原生 id>[, <版本>])`——同一事件永远同一个 id，幂等由它保证（§D.1）。 */
  id: string
  source: string
  /**
   * 它所属的全部 Thread，按 Source 给的顺序；`threads[0]` 是 primary thread，
   * 承担 Eval（§D.1 Correlation 只加语境不路由）。
   */
  threads: ThreadRef[]
  actor: ActorRef
  /** Source 声明：这条是人写的，不是 bot、CI 或本 agent。 */
  human: boolean
  /** Source 声明：发送者点名了 agent（mention）或直接发给它（direct）。插件不推断。 */
  addressed?: 'mention' | 'direct'
  at: string
  text: string
  channel?: ChannelRef
  url?: string
  /** Source 自有的细节，core 从不解释。 */
  meta: Record<string, unknown>
}

/** 一条 Trigger 进入领域之后的去向；它本身不授予任何权限。 */
export interface TriggerDisposition {
  /** 在进入领域之前被 Source 的监听范围过滤掉，带 Source 的原因码。 */
  filtered?: Reason
  evalId?: string
  decisionId?: string
  /** 它到达的 Ticket（订阅扇出，或被主 Session attach）。已结束、且无法恢复的 Ticket 不算。 */
  fanout: string[]
  /** `fanout` 中只经「语境 Thread」到达的那些——这些 Ticket 不拥有这条消息。 */
  context?: string[]
  /** 人（或没有 Ticket 决定时的主 Session）把它重新送回 Eval；handback 不设它。 */
  requeued?: true
  /** 把这条当成「超出本 Ticket」交回的 Ticket，每个一次并带原因；没有 Ticket 决定它时回到 Eval。 */
  handbacks?: { ticketId: string; reason: string; at: string }[]
  /** 承认或回答过它的 Ticket（worker 接手了这条消息）。 */
  acked?: string[]
  at: string
}

/** 判定一条人 follow-up 的归属时要读的记录。 */
export interface FollowupRecords {
  tickets: { get(id: string): Ticket | undefined }
  threads: { get(key: string): Thread | undefined }
  triggers: { disposition(id: string): TriggerDisposition | undefined }
}
/**
 * 决定一条人 follow-up 的 Ticket：它经自己的 Thread 到达、仍能决定它、且没有交回的那些。
 * Ticket 活着时算；它结束后、不是被人停的、且还有等待它恢复的 Trigger 时也算。人被送进
 * Eval、或 Eval 正持有它时，一个都不算。
 */
export function followupOwners(
  trigger: Pick<Trigger, 'id' | 'human' | 'threads'>,
  records: FollowupRecords
): string[] {
  if (!trigger.human) return []
  const disposition = records.triggers.disposition(trigger.id)
  if (!disposition || disposition.requeued) return []
  const returned = new Set(disposition.handbacks?.map((item) => item.ticketId))
  const reached = disposition.fanout.filter(
    (id) => !returned.has(id) && !disposition.context?.includes(id)
  )
  if (
    !reached.length ||
    records.threads.get(threadKey(trigger.threads[0]!))?.evaluating?.triggerIds.includes(trigger.id)
  ) {
    return []
  }
  return reached.filter((id) => {
    const ticket = records.tickets.get(id)
    return (
      !!ticket &&
      (liveTicket(ticket) ||
        (ticket.ended?.by !== 'human' &&
          ticket.inputs.some(
            (input) =>
              input.kind === 'trigger' &&
              input.triggerId === trigger.id &&
              ticket.undelivered.includes(input.id)
          )))
    )
  })
}
/**
 * 一个 Decision 是否了结了一条人的消息所问的事：对它的 stop（无论采纳还是拒绝）只决定该
 * Ticket 的工作；把它路由给某个 Ticket 就交给那个 Ticket 的 worker；unavailable 什么都没定。
 */
export const settled = (decision: Pick<Decision, 'kind' | 'reason'>): boolean =>
  !['stop', 'unavailable'].includes(decision.kind) &&
  !decision.reason.some((reason) =>
    ['stopNotExplicit', 'stopUnknown', 'routed'].includes(reason.code)
  )

/** Mandate 的依据：哪条 Trigger 经哪个 Source、哪个接收行、以哪种方式被准入（§K.3）。 */
interface Received {
  source?: string
  scope?: Record<string, unknown>
  row?: string
}
/**
 * Gate 如何准入 Mandate 的来源 Trigger，`revalidate` 会逐来源复核（§K.3）：
 * - `addressed`：名单上的人点名了 agent；
 * - `followup`：Thread 上已有 Ticket 的人的消息；
 * - `admission`：接收行准入格的判定；`observation` 记下当时的 accept mode；
 * - `bot`：Source bots 名单上的 bot，最多推断强度，永远不是显式请求或 stop。
 * `sender` 是接受时的名单发送者，`rules` 是评估匹配到的规则。
 */
export type MandateBasis = Received & { sender?: string; rules?: string[] } & (
    | { via: 'addressed'; addressed: 'mention' | 'direct' }
    | { via: 'followup'; authority?: string }
    | {
        via: 'admission'
        cell: AdmissionCell
        addressed?: 'mention' | 'direct'
        observation?: { mode: AcceptMode }
      }
    | {
        via: 'bot'
        addressed?: 'mention' | 'direct'
        observation: { mode: AcceptMode }
      }
  )

/**
 * accept 产生的不可变授权；执行以它为界，它永不改变。
 * 建立只有一条路（accept），撤回只有一条路（人的 stop 结束 Ticket），撤销只有一条路
 * （复验失败后 Ticket 保持结束，§K.3）。
 */
export interface Mandate {
  strength: Strength
  policyVersion: string
  /** Gate 如何准入它，供复验与审计。 */
  basis: MandateBasis
  actor: ActorRef
  scope: string
}

/** Thread 上一次进行中的 Trigger 评估；每个 Thread 至多一个。 */
export interface Evaluation {
  id: string
  threadKey: string
  triggerIds: string[]
  /** 给这批评估提供强度的可准入 Trigger，accept 建 Ticket 时它就是 origin。 */
  primary?: string
  strength: Strength
  /** 最强可准入 Trigger 的 actor 与 gate 依据；accept 时它们成为 Mandate。 */
  actor: ActorRef
  basis: MandateBasis
  policyVersion: string
  startedAt: string
  /** 候选送达 assessor 会话的时刻；在那之前不会过期，截止时间从它起算。 */
  delivered?: string
  /** 截止时刻；暂停期间顺延。 */
  deadline: string
  /** 处理暂停开始的时刻；恢复时把 `deadline` 往后移暂停时长，恢复后清除。 */
  pausedAt?: string
}

/** Thread 聚合：Eval 的一致性边界，订阅与决定历史的持有者。 */
export interface Thread {
  key: string
  ref: ThreadRef
  createdAt: string
  /** 该 Thread 上最新 Trigger 的时刻。 */
  lastAt?: string
  /** 订阅该 Thread 的 Ticket；活着的会经扇出收到每条 Trigger 作为语境。 */
  subscriptions: string[]
  /** 订阅者中只把该 Thread 当只读语境的 Ticket（§D.1 / §I.5）。 */
  context?: string[]
  /** 与它共享过 Trigger 的 Thread 键；只加语境。 */
  correlated: string[]
  /** 等待下一次 Eval 的 Trigger（防抖缓冲）。 */
  pending: string[]
  evaluating?: Evaluation
  /** 连续多少次 Eval 过期并重新入队；一次 Decision 就清零。 */
  expired?: number
  /** Source 需要 Channel 或读取器用到的原生属性，以及给人看的 label / facts。 */
  meta: Record<string, unknown>
}
/** 两种界面语言的文本，或两种语言相同的文本。 */
export type Text = string | { zh: string; en: string }
/** Source 就它的 Thread 陈述的一条事实；`problem` 标出需要人的那条。 */
export interface ThreadFact {
  label?: Text
  value: Text
  problem?: true
}
/** Thread 的事实表，按 id 排列；每个写者拥有自己的 fact id。 */
export type ThreadFacts = Record<string, ThreadFact>

/** 一次 Eval 的结果，记在 Thread 上。 */
export interface Decision {
  id: string
  evalId: string
  threadKey: string
  triggerIds: string[]
  policyVersion: string
  at: string
  kind: DecisionKind
  /** 为什么，按码：一个原因，或这批里每条 Trigger 各一个。 */
  reason: Reason[]
  strength: Strength
  ticketId?: string
  mandate?: Mandate
  /** assessor 提供的审计数据（规则判定、方向、证据）。 */
  audit?: Record<string, unknown>
  /** 有人把一条 unavailable 决定暴露的问题 dismiss 了。 */
  dismissed?: true
}

/**
 * 一个 Assignment 报告的内容：工作进行中（progress）、worker 在等 Trigger（waiting）、
 * 有可评审结果（ready）、要人才能解除或恢复（blocked / failed）、无事可做（dropped）。
 */
/** 绑定：一个 Ticket 与一个执行器实例。 */
export interface Assignment {
  id: string
  state: AssignmentState
  createdAt: string
  startedAt?: string
  endedAt?: string
  endedReason?: string
  /** Orca agent 终端句柄；Assignment 的外部身份（§D.1 / §E.3）。 */
  terminalId?: string
  report?: { state: ReportState; summary: string; at: string }
  /** 最近一次 Input 送达 worker 的时刻；在 `report.at` 之后的说明 worker 自那次报告起在忙 Input。 */
  deliveredAt?: string
  /** worker 的一轮在没有任何可运行、也没有任何等待时结束的时刻。 */
  idleAt?: string
}

/** 投递给 Ticket 的一条输入。 */
export type TicketInput =
  /** 它某条 Thread 上、或被 attach 给它的一条 Trigger；人写的时候 `human`。 */
  | {
      id: string
      kind: 'trigger'
      triggerId: string
      at: string
      note?: string
      human?: true
      /** 它只经执行器当语境跟随的 Thread 到达。 */
      context?: true
      /** worker 的会话把承载它的消息取进某一步的时刻；`null` 表示还在会话里等。 */
      readAt?: string | null
      /** 最近一次投递给它的 Assignment。 */
      deliveredTo?: string
      /** 更早版本交给 worker 的时刻。 */
      deliveredAt?: string
    }
  /** Policy 以 `effect` 说的方式影响到了该 Ticket。 */
  | { id: string; kind: 'policy-changed'; from: string; to: string; at: string; effect?: PolicyEffect }
  /** 人的一条消息让已结束的 Ticket 在不变的 Mandate 下恢复。 */
  | { id: string; kind: 'resumed'; triggerId: string; at: string }
  | { id: string; kind: 'text'; text: string; at: string }
  /** 主 Session 从别处给 Ticket 的一条事实：只加语境，不要求也不授权任何事。 */
  | { id: string; kind: 'note'; text: string; at: string }

/**
 * Policy 变更如何影响一个 Ticket：它据以被接受的规则变了或不再适用；`proactive: false`
 * 表示推断工作不再被接受（例如 accept mode 离开 auto）；`requesterAllowed: false` 表示
 * 发起它的人或 bot 已不能在那里发起工作。
 */
export interface PolicyEffect {
  rules?: { id: string; name: string; change: 'changed' | 'disabled'; instruction?: string }[]
  proactive?: false
  requesterAllowed?: false
  requester?: ActorRef
}

/** 人提出的一个问题；`forTriggerId` 是提出它的人的消息，问题回到那个会话（§D.1）。 */
export interface Attention {
  id: string
  question: string
  forTriggerId?: string
  at: string
  /** 终端来源：Orca agent 的 `blocked` 状态额外产生的 Attention（§E.7）。 */
  via?: 'terminal'
}

/** Ticket 聚合：一项获授权的工作，带它的 Assignment、Channel、Thread 绑定与 Input。 */
export interface Ticket {
  id: string
  title: string
  decisionId: string
  mandate: Mandate
  /** 它被接受时那些消息的 Channel，回复走这里。 */
  channels: ChannelRef[]
  /** 何时、被谁、以什么结局结束；未结束的 Ticket 没有它。 */
  ended?: { at: string; by: TicketEndBy; outcome: TicketOutcome; reason?: string }
  /** 等人回答的问题；执行器清除或 Ticket 结束时清除。 */
  attention?: Attention
  /**
   * 执行器最近一次观测到的 agent 状态（§E.7 的四态，§E.8 的 stage 输入）。写者只有 Engine
   * （§D.4）：执行器经 `Engine.agentStateChanged` 写，Assignment 结束时由领域收尾成 `done`；
   * 没观察过就没有这个字段——它不满足 §E.8 任何集合成员条件。
   */
  agentState?: AgentState
  /** 上面那次观测的时刻（ISO-8601）：状态随 Ticket 持久化，重启后一起读回（§E.10）。 */
  agentStateAt?: string
  assignments: Assignment[]
  inputs: TicketInput[]
  /** 尚未交给运行中 Assignment 的 Input。 */
  undelivered: string[]
  /**
   * Source 让它跟随的 Thread（例如它的 PR）：`ready` 报告要等 `followsDone` 成立才结束
   * Ticket；让它成立的那次关闭以该结局结束 Ticket，除非工作尚未完成（§I.5）。
   */
  follows?: Follow[]
  /** worker 回答过的人的问题，主 Session 可以据此发送回答。 */
  answers?: string[]
  createdAt: string
  updatedAt: string
  /** 它据以被接受的 Trigger：开始它的那条，以及那次 Eval 持有的整批。 */
  origin: { triggerId: string; triggerIds: string[] }
  /** 执行器选定的东西：短名、目录与作业文本（§E.1–E.3）。 */
  execution?: Execution
  /** 最近一次把 Input 投递给 worker 的失败，直到一次投递成功。 */
  delivery?: { error: string; at: string }
}

/**
 * Ticket 跟随的一个 Thread，按它的键：`own` 表示该 Ticket 打开了它（例如它自己的 PR），
 * 以及何时、以什么结局关闭。`followsDone` 在它自己打开的 Thread 全关闭时成立；没有 own
 * 时，跟随的 Thread 全关闭也成立。
 */
export interface Follow {
  thread: string
  own: boolean
  closed?: { at: string; outcome: 'merged' | 'closed' }
}

/**
 * 执行器选定的执行事实。`name` 是 Ticket 短名（worktree 与分支由它派生），`directory`
 * 是 worktree 路径，`assignment` 是交给 worker 的作业文本（§E.1–§E.3）。
 */
export interface Execution {
  name: string
  directory: string
  assignment: string
}

/** Ticket 是否还开着：它没有结束。 */
export const liveTicket = (ticket: Pick<Ticket, 'ended'>): boolean => !ticket.ended
/** Ticket 以什么结局结束。 */
export const ticketOutcome = (ticket: Pick<Ticket, 'ended'>): TicketOutcome | undefined =>
  ticket.ended?.outcome
/** 正在运行该 Ticket 的 Assignment。 */
export const runningAssignment = (ticket: Ticket): Assignment | undefined =>
  ticket.assignments.find((assignment) => assignment.state === 'running')
/** 最新一个 Assignment（无论状态）。 */
export const latestAssignment = (ticket: Ticket): Assignment | undefined =>
  ticket.assignments.at(-1)
/** 该 Ticket 任一 Assignment 最近的一次报告，也就是 Ticket 最后说的话。 */
export const latestReport = (ticket: Pick<Ticket, 'assignments'>): Assignment['report'] =>
  ticket.assignments.findLast((assignment) => assignment.report)?.report

/**
 * 一条 Trigger 是否到达过该 Ticket：它开始过该 Ticket、作为 Input 到过、或该 Ticket
 * 订阅了它所在的 Thread；`context` 为 false 时，只经语境 Thread 到达的不算。
 */
export function reached(
  ticket: Ticket,
  trigger: Trigger,
  thread: (key: string) => Thread | undefined,
  context = true
): boolean {
  if (ticket.origin.triggerId === trigger.id) return true
  const input = ticket.inputs.some(
    (item) => item.kind === 'trigger' && item.triggerId === trigger.id
  )
  return (
    trigger.threads.some((ref) => {
      const current = thread(threadKey(ref))
      return (
        current?.subscriptions.includes(ticket.id) === true &&
        (context || !current.context?.includes(ticket.id))
      )
    }) ||
    (input &&
      (context ||
        !trigger.threads.every((ref) => thread(threadKey(ref))?.context?.includes(ticket.id))))
  )
}

/**
 * 到某个时刻为止，Ticket 的 worker 有过一轮来读到达它的东西：最近一次报告（`progress`
 * 为 false 时跳过 progress 报告）与最近一次轮次结束里较晚的那个。
 */
export function readUntil(ticket: Pick<Ticket, 'assignments'>, progress = true): string {
  const report = ticket.assignments.findLast(
    (assignment) =>
      assignment.report && (progress || assignment.report.state !== 'progress')
  )?.report
  return [report?.at ?? '', ...ticket.assignments.map((assignment) => assignment.idleAt ?? '')].reduce(
    (a, b) => (a > b ? a : b)
  )
}

/**
 * Ticket 是否在等人：它最新的 Assignment 报告了 blocked 或 failed，且此后没有人的消息
 * 到达。之后一次既非 blocked 也非 failed 的报告、一条人的消息，或一次重试（新建
 * Assignment）都会解除它。
 */
export function waitsForPerson(ticket: Ticket): boolean {
  const report = latestAssignment(ticket)?.report
  if (report?.state !== 'blocked' && report?.state !== 'failed') return false
  return !ticket.inputs.some(
    (input) => input.kind === 'trigger' && input.human && !input.context && input.at > report.at
  )
}

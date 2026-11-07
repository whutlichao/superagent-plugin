// 读模型：执行面（`read tickets` / `GET tickets` / 面板的 Execution 页）看到的 Ticket。
//
// 一处定义：CLI、HTTP 与面板快照都从这里取同一份形状，避免「列表里有、详情里没有」的两套
// 说法。stage 用 §E.8 的表（`core/stage.ts`），不在这里重写一遍判定。
import {
  followupOwners,
  latestAssignment,
  latestReport,
  ticketStage,
  type AgentState,
  type Assignment,
  type FollowupRecords,
  type Thread,
  type Ticket,
  type TicketInput,
  type Trigger
} from '../core/index.ts'
import { canRetry, type StageLabel } from '../core/stage.ts'
import type {
  PanelAssignment,
  PanelInput,
  PanelMandate,
  PanelReport,
  PanelSubscription,
  PanelTerminal,
  TicketDetailView
} from '../../panel/protocol'

/** Ticket 列表的一个筛选（`superagent ticket list --state`）。 */
export const TICKET_FILTERS = ['open', 'person', 'working', 'idle', 'ended'] as const
export type TicketFilter = (typeof TICKET_FILTERS)[number]

/** 一条仍归这张 Ticket 的人 follow-up（面板据此标「已投递到该 Ticket」，不再路由第二次）。 */
export interface TicketFollowup {
  readonly triggerId: string
  /** 人写那条消息的时刻。 */
  readonly at: string
  /** 仍拥有它的那张 Ticket（就是这条读模型自己的 id）。 */
  readonly deliveredTo: string
  /** 执行器把它交给了哪个 Assignment；还在等投递时省略（领域记作 `input.deliveredTo`）。 */
  readonly assignmentId?: string
}

/** 读一条 Ticket 的归属时要读的记录（比 `FollowupRecords` 多一个 Trigger 本身的读取口）。 */
export interface FollowupLookup extends FollowupRecords {
  readonly triggers: FollowupRecords['triggers'] & { get(id: string): Trigger | undefined }
}

/**
 * 仍归这张 Ticket 的人 follow-up：归属判定与 `followupOwners` 同一口径（§K.2 第 3 条、
 * §L.2 `runtime/work`），所以这个标记就是「不要再路由」的那个事实本身。交回过的、只当语境
 * 读的、被人重排进 Eval 的都不再算它的。
 */
export function deliveredFollowups(
  ticket: Ticket,
  records: FollowupLookup
): readonly TicketFollowup[] {
  const found = new Map<string, TicketFollowup>()
  for (const input of ticket.inputs) {
    if (input.kind !== 'trigger' || input.human !== true) continue
    const trigger = records.triggers.get(input.triggerId)
    if (trigger === undefined || !followupOwners(trigger, records).includes(ticket.id)) continue
    if (found.has(trigger.id)) continue
    found.set(trigger.id, {
      triggerId: trigger.id,
      at: trigger.at,
      deliveredTo: ticket.id,
      ...(input.deliveredTo === undefined ? {} : { assignmentId: input.deliveredTo })
    })
  }
  return [...found.values()]
}

/** 一条 Ticket 的读模型：列表与详情同一份。 */
export interface TicketView {
  readonly id: string
  readonly title: string
  /** §E.8 的七档之一；已结束的没有标签。 */
  readonly stage: StageLabel | 'ended'
  /**
   * 执行器观测到的 agent 状态（§E.7 的四态）。它已随 Ticket 持久化（`agentState`），所以
   * 读模型直接给出它——stage 的 §E.8 两行集合成员用的就是这次观测。没观测过则省略。
   */
  readonly agentState?: AgentState
  readonly strength: 'explicit' | 'inferred'
  readonly actor: string
  readonly createdAt: string
  readonly updatedAt: string
  /** 最新 Assignment 的状态与它最近一次报告（没有 Assignment 时省略）。 */
  readonly assignment?: {
    readonly id: string
    readonly state: 'pending' | 'running' | 'ended'
    readonly terminalId?: string
    readonly report?: { readonly state: string; readonly summary: string; readonly at: string }
  }
  /** 等工作区与目录（执行器写进 `ticket.execution`）。 */
  readonly worktree?: { readonly name: string; readonly directory: string }
  /** 当前等人回答的问题。 */
  readonly attention?: { readonly id: string; readonly question: string; readonly at: string }
  /** 仍归这张 Ticket 的人 follow-up（没有时省略）；面板按它标「已投递到该 Ticket」。 */
  readonly followups?: readonly TicketFollowup[]
  readonly ended?: { readonly at: string; readonly by: string; readonly outcome: string; readonly reason?: string }
}

/** 一条 Ticket → 读模型（不猜 stage：没有 agent 状态时按 §E.8 的表落）。 */
export function ticketView(
  ticket: Ticket,
  followups: readonly TicketFollowup[] = []
): TicketView {
  const assignment = latestAssignment(ticket)
  const report = latestReport(ticket)
  const label = ticketStage(ticket)
  const stage: TicketView['stage'] =
    label.stage === 'person'
      ? label.action === 'blocked' || label.action === 'failed'
        ? 'blockedFailed'
        : label.action === 'delivery'
          ? 'delivery'
          : label.action === 'review'
            ? 'review'
            : 'answer'
      : label.stage === 'working'
        ? label.action === 'queued'
          ? 'queued'
          : 'working'
        : label.stage === 'idle'
          ? 'idle'
          : 'ended'
  return {
    id: ticket.id,
    title: ticket.title,
    stage,
    ...(ticket.agentState === undefined ? {} : { agentState: ticket.agentState }),
    strength: ticket.mandate.strength,
    actor: `${ticket.mandate.actor.source}:${ticket.mandate.actor.id}`,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    ...(assignment === undefined
      ? {}
      : {
          assignment: {
            id: assignment.id,
            state: assignment.state,
            ...(assignment.terminalId === undefined ? {} : { terminalId: assignment.terminalId }),
            ...(report === undefined ? {} : { report })
          }
        }),
    ...(ticket.execution === undefined
      ? {}
      : { worktree: { name: ticket.execution.name, directory: ticket.execution.directory } }),
    ...(ticket.attention === undefined
      ? {}
      : {
          attention: {
            id: ticket.attention.id,
            question: ticket.attention.question,
            at: ticket.attention.at
          }
        }),
    ...(followups.length === 0 ? {} : { followups }),
    ...(ticket.ended === undefined ? {} : { ended: ticket.ended })
  }
}

/** 一条 Ticket 是否符合筛选（`undefined` 表示不筛）。 */export function matchesFilter(ticket: Ticket, filter: TicketFilter | undefined): boolean {
  if (filter === undefined) return true
  const label = ticketStage(ticket)
  switch (filter) {
    case 'open':
      return ticket.ended === undefined
    case 'person':
      return label.stage === 'person'
    case 'working':
      return label.stage === 'working'
    case 'idle':
      return label.stage === 'idle'
    case 'ended':
      return label.stage === 'ended'
  }
}

/**
 * 详情读模型要读的记录：订阅在 Thread 上（§D.1），Input 的原文在 Trigger 上。两个都只读，
 * 组合根接仓储，测试接固定表。
 */
export interface DetailRecords {
  readonly threads: { list(): readonly Thread[] }
  readonly triggers: { get(id: string): Trigger | undefined }
}

/** 面板上的一句话摘要最多几个字符（详情只给摘要，不重放整段原文）。 */
export const PREVIEW_CHARS = 160

/** 一段文本的摘要：空白折成单空格，过长截断（与面板的 `Text` 一词一致）。 */
function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat
}

/** ISO 文本 → epoch ms（面板的时间一律交给 `RelativeTime`）。解不开就是 0。 */
function epoch(at: string): number {
  const parsed = Date.parse(at)
  return Number.isFinite(parsed) ? parsed : 0
}

/** 一份 Assignment 报告 → 面板面（§E.8）。 */
function panelReportOf(report: Assignment['report']): PanelReport | undefined {
  if (report === undefined) return undefined
  return { state: report.state, summary: report.summary, at: epoch(report.at) }
}

/** 一条 Assignment → 面板面（§E.3）：带它的终端与报告。 */
function panelAssignmentOf(assignment: Assignment): PanelAssignment {
  const report = panelReportOf(assignment.report)
  return {
    id: assignment.id,
    state: assignment.state,
    createdAt: epoch(assignment.createdAt),
    ...(assignment.startedAt === undefined ? {} : { startedAt: epoch(assignment.startedAt) }),
    ...(assignment.endedAt === undefined ? {} : { endedAt: epoch(assignment.endedAt) }),
    ...(assignment.endedReason === undefined ? {} : { endedReason: assignment.endedReason }),
    ...(assignment.terminalId === undefined ? {} : { terminalId: assignment.terminalId }),
    ...(report === undefined ? {} : { report })
  }
}

/** 一条还在等投递的 Input → 面板面：种类 + 摘要（Trigger 的原话在 `records.triggers` 里）。 */
function panelInputOf(input: TicketInput, records: DetailRecords): PanelInput {
  const base = { id: input.id, at: epoch(input.at) }
  switch (input.kind) {
    case 'trigger': {
      const trigger = records.triggers.get(input.triggerId)
      return {
        ...base,
        kind: 'trigger',
        triggerId: input.triggerId,
        ...(trigger === undefined ? {} : { text: preview(trigger.text) }),
        ...(input.human === true ? { human: true } : {})
      }
    }
    case 'note':
    case 'text':
      return { ...base, kind: input.kind, text: preview(input.text) }
    case 'policy-changed':
      // 一条策略变更就是「从哪个版本到哪个版本」；文案由面板的 `policy-changed` 措辞包起来。
      return { ...base, kind: 'policy-changed', text: `${input.from} → ${input.to}` }
    default:
      return { ...base, kind: 'resumed', triggerId: input.triggerId }
  }
}

/** 授权面（§K.3）：强度、发起人、policy version、依据的种类与接收行、匹配到的规则。 */
function panelMandateOf(ticket: Ticket): PanelMandate {
  const basis = ticket.mandate.basis
  return {
    strength: ticket.mandate.strength,
    actor: `${ticket.mandate.actor.source}:${ticket.mandate.actor.id}`,
    policyVersion: ticket.mandate.policyVersion,
    via: basis.via,
    ...('cell' in basis ? { cell: basis.cell } : {}),
    rules: basis.rules ?? []
  }
}

/** 一个订阅 → 面板面（§D.1）：名字、最后一条时刻，以及它是否只当语境。 */
function panelSubscriptionOf(thread: Thread, ticketId: string): PanelSubscription {
  const label = thread.meta['label']
  return {
    key: thread.key,
    title: typeof label === 'string' && label !== '' ? label : thread.key,
    ...(thread.lastAt === undefined ? {} : { lastAt: epoch(thread.lastAt) }),
    context: thread.context?.includes(ticketId) === true
  }
}

/**
 * 一张工单的详情（§M.2 的 Execution 详情）。一份输入只读一次：stage 用与列表同一个判定
 * （`ticketStage`），派工、报告、待人工、worktree 与结局都取自这张 Ticket 自己的记录。
 *
 * 终端摘要不在这里读（那是 I/O）：调用方把 `terminal.read` 的结果传进来，读不到就省略。
 */
export function ticketDetail(
  ticket: Ticket,
  records: DetailRecords,
  options: { readonly terminal?: PanelTerminal } = {}
): TicketDetailView {
  const waiting = new Set(ticket.undelivered)
  const assignments = ticket.assignments.map(panelAssignmentOf)
  const reports = ticket.assignments.flatMap((assignment) => {
    const report = panelReportOf(assignment.report)
    return report === undefined ? [] : [report]
  })
  const attention = ticket.attention
  const ended = ticket.ended
  return {
    id: ticket.id,
    title: ticket.title,
    stage: ticketView(ticket).stage,
    ...(ticket.ended === undefined ? {} : { outcome: ticket.ended.outcome }),
    at: epoch(ticket.updatedAt),
    mandate: panelMandateOf(ticket),
    waitingInputs: ticket.inputs
      .filter((input) => waiting.has(input.id))
      .map((input) => panelInputOf(input, records)),
    subscriptions: records.threads
      .list()
      .filter((thread) => thread.subscriptions.includes(ticket.id))
      .map((thread) => panelSubscriptionOf(thread, ticket.id)),
    assignments,
    reports,
    ...(attention === undefined
      ? {}
      : {
          attention: {
            question: attention.question,
            at: epoch(attention.at),
            via: attention.via === 'terminal' ? ('terminal' as const) : null
          }
        }),
    ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
    ...(ticket.execution === undefined
      ? {}
      : { worktree: { name: ticket.execution.name, directory: ticket.execution.directory } }),
    ...(ended === undefined
      ? {}
      : {
          ended: {
            at: epoch(ended.at),
            by: ended.by,
            outcome: ended.outcome,
            ...(ended.reason === undefined ? {} : { reason: ended.reason })
          }
        }),
    canRetry: canRetry(ticket)
  }
}

/** 一页 Ticket（`next_offset` 为 `null` 表示没有下一页）。 */
export interface TicketPage {
  readonly items: readonly TicketView[]
  readonly next_offset: number | null
}

/** 列表读模型：按创建时间降序（与 `Repositories.tickets.list()` 同序）。 */
export function ticketsPage(
  tickets: readonly Ticket[],
  options: {
    readonly offset?: number
    readonly limit?: number
    readonly filter?: TicketFilter
    /** 每条 Ticket 的 follow-up 标记（与详情页同一份，缺省不标）。 */
    readonly followups?: (ticket: Ticket) => readonly TicketFollowup[]
  } = {}
): TicketPage {
  const limit = Math.max(1, Math.min(50, options.limit ?? 20))
  const offset = Math.max(0, options.offset ?? 0)
  const view = (ticket: Ticket): TicketView =>
    ticketView(ticket, options.followups === undefined ? [] : options.followups(ticket))
  const filtered = tickets.filter((ticket) => matchesFilter(ticket, options.filter)).map(view)
  const items = filtered.slice(offset, offset + limit)
  return {
    items,
    next_offset: offset + limit < filtered.length ? offset + limit : null
  }
}

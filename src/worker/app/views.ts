// 读模型：执行面（`read tickets` / `GET tickets` / 面板的 Execution 页）看到的 Ticket。
//
// 一处定义：CLI、HTTP 与面板快照都从这里取同一份形状，避免「列表里有、详情里没有」的两套
// 说法。stage 用 §E.8 的表（`core/stage.ts`），不在这里重写一遍判定。
import {
  followupOwners,
  latestAssignment,
  latestReport,
  ticketStage,
  type FollowupRecords,
  type Ticket,
  type Trigger
} from '../core/index.ts'
import type { StageLabel } from '../core/stage.ts'

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

/** 一条 Ticket 是否符合筛选（`undefined` 表示不筛）。 */
export function matchesFilter(ticket: Ticket, filter: TicketFilter | undefined): boolean {
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

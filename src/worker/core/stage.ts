// Ticket stage 分类与重试资格（§E.8）。Orca 版比上游多一个输入：agent 的可观察状态
// （`working | blocked | waiting | done`，§E.7）。规则按表里从上到下的顺序取第一条命中的。
import {
  latestAssignment,
  waitsForPerson,
  type AgentState,
  type Ticket
} from './model.ts'

/** Ticket 的执行阶段：等人、在工作中（或排队）、两轮之间的闲置、或已结束。 */
export type TicketStage =
  | { stage: 'person'; action: 'delivery' | 'answer' | 'review' | 'blocked' | 'failed' }
  | { stage: 'working'; action?: 'queued' }
  | { stage: 'idle' }
  | { stage: 'ended' }

/**
 * 面板上的七个标签（§E.8「面板标签」列）。`person` 的 blocked 与 failed 共用一个标签
 * 「阻塞或失败」；已结束的 Ticket 不参与 stage 标签，面板用它自己的结局措辞。
 */
export const STAGE_LABELS = [
  'delivery',
  'answer',
  'review',
  'blockedFailed',
  'queued',
  'idle',
  'working'
] as const
export type StageLabel = (typeof STAGE_LABELS)[number]

/**
 * agent 状态是否让「报告已停」的判定成立。没有 agent 状态（编排侧还没观察到，或该
 * Ticket 没有活着的终端）时不做这一维的过滤，按上游的报告与 Assignment 判定——否则
 * worker 报 blocked 却因为还没收到事件而显示「工作中」，那是不诚实的。
 */
const settledAgent = (state: AgentState | undefined): boolean =>
  state === undefined || state === 'blocked' || state === 'done'
/** agent 状态是否让「等待下一轮」的判定成立；同上，未知不做过滤。 */
const idleAgent = (state: AgentState | undefined): boolean =>
  state === undefined || state === 'waiting' || state === 'done'

/**
 * 按 §E.8 的表判定 Ticket 的阶段；`agentState` 是 Orca 新加的维度，省略表示未知。
 *
 * | 行 | 条件 | 阶段 |
 * | --- | --- | --- |
 * | 1 | 已结束 | ended |
 * | 2 | Input 投递失败（`delivery` 未清） | person / delivery |
 * | 3 | 有 Attention | person / answer |
 * | 4 | 最近 Report 是 `ready` | person / review |
 * | 5 | 最近 Report 是 `blocked`/`failed`，此后无人消息，且 agent 已停（blocked/done） | person / blocked·failed |
 * | 6 | 无 Assignment 或 pending | working / queued |
 * | 7 | 最近 Report 是 `waiting` 或 Assignment 已结束，且 agent 空闲（waiting/done） | idle |
 * | 8 | 其余 | working |
 */
export function ticketStage(ticket: Ticket, agentState?: AgentState): TicketStage {
  if (ticket.ended) return { stage: 'ended' }
  if (ticket.delivery) return { stage: 'person', action: 'delivery' }
  if (ticket.attention) return { stage: 'person', action: 'answer' }
  const assignment = latestAssignment(ticket)
  const report = assignment?.report?.state
  if (report === 'ready') return { stage: 'person', action: 'review' }
  // 人 follow-up 之后，blocked/failed 的 Ticket 回到执行器。
  if (
    (report === 'blocked' || report === 'failed') &&
    waitsForPerson(ticket) &&
    settledAgent(agentState)
  ) {
    return { stage: 'person', action: report }
  }
  if (!assignment || assignment.state === 'pending') return { stage: 'working', action: 'queued' }
  if ((report === 'waiting' || assignment.state === 'ended') && idleAgent(agentState)) {
    return { stage: 'idle' }
  }
  return { stage: 'working' }
}

/** stage → 七个面板标签之一；已结束的 Ticket 没有 stage 标签。 */
export function stageLabel(stage: TicketStage): StageLabel | undefined {
  switch (stage.stage) {
    case 'ended':
      return undefined
    case 'idle':
      return 'idle'
    case 'working':
      return stage.action === 'queued' ? 'queued' : 'working'
    case 'person':
      return stage.action === 'blocked' || stage.action === 'failed'
        ? 'blockedFailed'
        : stage.action
  }
}

/** 未结束、且卡在 blocked/failed 报告（此后无人消息）或 Input 投递失败时，可以重试。 */
export function canRetry(ticket: Ticket): boolean {
  return !ticket.ended && (waitsForPerson(ticket) || !!ticket.delivery)
}

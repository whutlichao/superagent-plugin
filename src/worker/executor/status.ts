// `agent.status.changed` 的四态映射（§E.7）：事件是 worker 生命周期的唯一真源，
// `terminal.read` 只用于取证（blocked 的摘要），绝不阻塞。本文件只经领域写入接口改状态
// （§D.4：Assignment 的写者是 core/engine），不直接改 Ticket。
//
// 定位：事件的 `terminalId` 是主键；宿主在某些版本里只给 `paneKey`（附录 C S7/S9 实测），
// 所以先用 `paneKey` 直接匹配，再退到 `listTerminals()`（全机权威）按 `workspaceId` 反查。
// 不用 `listAgents()`：它只投影当前聚焦工作区（附录 C S2）。
import type { Assignment, AgentState, Ticket } from '../core/model.ts'
import { latestAssignment, liveTicket } from '../core/model.ts'
import type { EngineForExecutor } from '../core/engine.ts'
import { reasonText } from '../core/reasons.ts'
import type { OrcaRuntime, AgentStatusEvent } from '../runtime/orca-runtime.ts'

/** blocked 摘要取终端最后多少行（§E.7）。 */
export const BLOCKED_SUMMARY_LINES = 20

/** 终端里一行提示都没有时，Attention 里明确写出来的句子（附录 C S9 的回落）。 */
export const NO_PROMPT = 'terminal shows no prompt'

/** 状态映射要读的仓储子集。 */
export interface StatusRecords {
  readonly tickets: {
    get(id: string): Ticket | undefined
    list(): readonly Ticket[]
  }
}

/** 一个事件命中的 Ticket 与它正在跑的 Assignment。 */
export interface LocatedAssignment {
  readonly ticket: Ticket
  readonly assignment: Assignment
}

/** 状态映射的依赖：领域写入、仓储、seam 与日志。 */
export interface StatusOptions {
  readonly engine: EngineForExecutor
  readonly records: StatusRecords
  readonly runtime: OrcaRuntime
  /** 后台计时（§E.9）：`working`/`waiting` 的观测同时喂给它。 */
  readonly background?: { observed(ticketId: string, state: AgentState): void }
  readonly log?: (message: string) => void
}

/** 事件处理器：永不抛错（宿主的事件派发不该被一次取证失败打断）。 */
export type AgentStatusHandler = (event: AgentStatusEvent) => Promise<void>

/** 一行失败说明（日志用）。 */
function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

/** 所有未结束 Ticket 里正在跑的 Assignment。 */
function runningAssignments(records: StatusRecords): LocatedAssignment[] {
  return records.tickets
    .list()
    .filter((ticket) => liveTicket(ticket))
    .flatMap((ticket) =>
      ticket.assignments
        .filter((assignment) => assignment.state === 'running')
        .map((assignment) => ({ ticket, assignment }))
    )
}

/**
 * 按终端句柄找 Ticket：`terminalId` 优先，`paneKey` 次之（某些版本把句柄放在这里）。
 * 两者都拿不到时，用 `listTerminals()` 按 `workspaceId` 反查——只有恰好一个命中才认，
 * 多个命中说明事件不足以定位，宁可不猜。
 */
export async function locateAssignment(
  runtime: OrcaRuntime,
  records: StatusRecords,
  event: AgentStatusEvent
): Promise<LocatedAssignment | undefined> {
  const running = runningAssignments(records)
  const handle = event.terminalId
  if (handle !== undefined) {
    return running.find((item) => item.assignment.terminalId === handle)
  }
  if (event.paneKey !== '') {
    const byPane = running.filter((item) => item.assignment.terminalId === event.paneKey)
    if (byPane.length === 1) return byPane[0]
  }
  if (event.workspaceId === null) return undefined
  const terminals = await runtime.listTerminals()
  const handles = new Set(
    terminals
      .filter((terminal) => terminal.worktreeId === event.workspaceId)
      .map((terminal) => terminal.handle)
  )
  const hits = running.filter(
    (item) => item.assignment.terminalId !== undefined && handles.has(item.assignment.terminalId)
  )
  return hits.length === 1 ? hits[0] : undefined
}

/** 终端最后若干行的摘要；读不到或没有内容时给附录 C S9 的回落句子。 */
export async function terminalSummary(
  runtime: OrcaRuntime,
  terminalId: string | undefined
): Promise<string> {
  if (terminalId === undefined) return NO_PROMPT
  try {
    const read = await runtime.readTerminal(terminalId, { maxLines: BLOCKED_SUMMARY_LINES })
    const lines = read.lines.map((line) => line.trimEnd()).filter((line) => line.trim() !== '')
    return lines.length === 0 ? NO_PROMPT : lines.slice(-BLOCKED_SUMMARY_LINES).join('\n')
  } catch {
    // `terminal.read` 是取证，不是判据：读不到就写清楚，绝不因此挡住事件处理。
    return NO_PROMPT
  }
}

/**
 * 建 `agent.status.changed` 的处理器。四态见 `apply`：`working` 保持运行，`blocked` 额外产生
 * 一条终端来源的 Attention，`waiting` 在没有待投 Input 与 pending Assignment 时结束该
 * Assignment，`done` 结束它并在没有最终 Report 时记「报告缺失」。
 */
export function createStatusHandler(options: StatusOptions): AgentStatusHandler {
  const log = options.log ?? (() => undefined)

  const apply = async (
    found: LocatedAssignment,
    event: AgentStatusEvent
  ): Promise<void> => {
    const { ticket, assignment } = found
    options.background?.observed(ticket.id, event.state)
    switch (event.state) {
      case 'working':
        // Assignment 保持运行；后台计时的起点由 background 记（§E.9）。
        return
      case 'blocked': {
        // worker 自己用 `report --human-action` 提的问题比终端摘要好，不拿它换掉。
        const current = options.records.tickets.get(ticket.id)
        if (current?.attention !== undefined) return
        const summary = await terminalSummary(options.runtime, assignment.terminalId)
        options.engine.report(ticket.id, {
          state: 'blocked',
          summary: 'The agent is blocked on a prompt in its terminal',
          question: summary,
          via: 'terminal'
        })
        return
      }
      case 'waiting': {
        // 空闲了：没有待投 Input、也没有 pending Assignment 就把这个 Assignment 收起来（§E.7）。
        const current = options.records.tickets.get(ticket.id)
        if (current === undefined || !liveTicket(current)) return
        if (current.undelivered.length > 0) return
        if (current.assignments.some((item) => item.state === 'pending')) return
        options.engine.assignmentEnded(ticket.id, assignment.id, 'waiting')
        return
      }
      case 'done': {
        const current = options.records.tickets.get(ticket.id)
        if (current === undefined || !liveTicket(current)) return
        // Orca 的 `done` 是「主 agent 的上一轮结束了」：会话启动与每一轮结束都会到达，
        // 不等于进程退出（附录 C S7 实测）。因此：有最终 report（waiting/ready/blocked/
        // failed/dropped）就按 §E.8 的规则办，只有没有最终 report（无 report 或只有
        // progress）才记「报告缺失」（§E.7）。
        const report = latestAssignment(current)?.report?.state
        if (report === undefined || report === 'progress') {
          options.engine.report(ticket.id, {
            state: 'failed',
            summary: reasonText({ code: 'reportMissing' })
          })
        }
        options.engine.assignmentEnded(ticket.id, assignment.id, 'done')
        return
      }
      default:
        // 四态是闭集合（`AgentState`）；宿主新增一态时留下可查的日志，不改任何状态。
        log(`unknown agent state ${String(event.state)} for ${ticket.id}`)
    }
  }

  return async (event: AgentStatusEvent): Promise<void> => {
    try {
      const found = await locateAssignment(options.runtime, options.records, event)
      if (found === undefined) {
        log(`agent status ${event.state} did not match a running assignment`)
        return
      }
      await apply(found, event)
    } catch (error) {
      log(`agent status ${event.state} failed: ${messageOf(error)}`)
    }
  }
}

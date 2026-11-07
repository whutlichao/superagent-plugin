// 崩溃 / 重启恢复（§E.5、§E.10）：插件启动时先看还有哪些 Assignment 在跑，再决定认领
// （终端仍活着且是这张 Ticket 的 worktree）还是标记中断并按恢复说明重建。
//
// 判据只用**全机**的读数：`listTerminals()`（终端是否还在）与 `listWorkspaces()`（worktree
// 是否还在）。`agents.list()` 只投影当前聚焦的工作区（附录 C S2），拿它枚举会把别的工单
// 当成不存在——这条纪律由测试断言（`calls.listAgents` 恒空）。
//
// 认领不新建 Assignment：worker 的会话还在跑，投一条「已恢复，继续」即可。中断则走
// `Engine.assignmentLost`（core 的唯一写者）：结束旧 Assignment、把没取走的 Input 放回队首、
// 带恢复说明新建一个并排队 launch。按最旧优先重建，重启后的 launch 因此保持接受顺序。
import type { Assignment, Ticket } from '../core/model.ts'
import { liveTicket } from '../core/model.ts'
import type { EngineForExecutor } from '../core/engine.ts'
import type { OrcaRuntime, TerminalRow, WorkspaceInfo } from '../runtime/orca-runtime.ts'

/** 认领时发给 worker 的一句话（单行：终端不吞多行，附录 C S1）。 */
export const RESTORED_INSTRUCTION =
  '[superagent] Restored: the plugin restarted while this assignment was running. Continue where you left off and inspect the worktree and any unread inbox file first.'

/** 恢复要读的仓储子集。 */
export interface ResumeRecords {
  readonly tickets: {
    list(): readonly Ticket[]
  }
}

/** 恢复的依赖：seam、领域写入与日志。 */
export interface ResumeOptions {
  readonly runtime: OrcaRuntime
  readonly engine: EngineForExecutor
  readonly records: ResumeRecords
  readonly log?: (message: string) => void
}

/** 一个运行中 Assignment 的恢复结局。 */
export interface ResumedAssignment {
  readonly ticketId: string
  readonly assignmentId: string
  readonly terminalId: string | null
  readonly outcome: 'adopted' | 'interrupted'
}

/** 一次启动恢复做了什么（日志与面板用）。 */
export interface ResumeReport {
  readonly assignments: readonly ResumedAssignment[]
}

/** 一行失败说明（日志用）。 */
function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

/** 未结束 Ticket 里正在跑的 Assignment，按 (Assignment 创建时刻, Ticket 创建时刻, id) 排序。 */
function runningAssignments(records: ResumeRecords): { ticket: Ticket; assignment: Assignment }[] {
  return records.tickets
    .list()
    .filter((ticket) => liveTicket(ticket))
    .flatMap((ticket) =>
      ticket.assignments
        .filter((assignment) => assignment.state === 'running')
        .map((assignment) => ({ ticket, assignment }))
    )
    .sort(
      (a, b) =>
        a.assignment.createdAt.localeCompare(b.assignment.createdAt) ||
        a.ticket.createdAt.localeCompare(b.ticket.createdAt) ||
        a.assignment.id.localeCompare(b.assignment.id)
    )
}

/**
 * 终端属于这张 Ticket 的 worktree 吗？三条判据：终端还连着、没被标为 orphaned，且它的
 * worktree（路径或工作区 id）就是 Ticket 记录下来的目录。对不上就不认领——宁可重建，也不
 * 把别人的会话当成自己的。
 */
export function belongsToTicket(
  terminal: TerminalRow,
  ticket: Ticket,
  workspaces: readonly WorkspaceInfo[]
): boolean {
  const directory = ticket.execution?.directory
  if (directory === undefined || directory === '') return false
  if (terminal.worktreePath === directory) return true
  if (terminal.worktreeId === null) return false
  return workspaces.some(
    (workspace) => workspace.workspaceId === terminal.worktreeId && workspace.path === directory
  )
}

/**
 * 启动时恢复：对每个运行中的 Assignment，终端仍活着且 worktree 命中本 Ticket 就认领并投递
 * 「已恢复，继续」；否则交给 `assignmentLost` 结束并重建（带恢复说明）。远程读一次终端表与
 * 工作区表，绝不逐条重查；任何一条失败只记日志，不打断其余 Ticket。
 */
export async function resumeAssignments(options: ResumeOptions): Promise<ResumeReport> {
  const log = options.log ?? (() => undefined)
  const running = runningAssignments(options.records)
  if (running.length === 0) return { assignments: [] }

  const [terminals, workspaces] = await Promise.all([
    options.runtime.listTerminals(),
    options.runtime.listWorkspaces()
  ])
  const byHandle = new Map(terminals.map((terminal) => [terminal.handle, terminal]))
  const resumed: ResumedAssignment[] = []

  for (const { ticket, assignment } of running) {
    const terminalId = assignment.terminalId ?? null
    const terminal = terminalId === null ? undefined : byHandle.get(terminalId)
    const adopted =
      terminal !== undefined &&
      terminal.connected &&
      !terminal.orphaned &&
      belongsToTicket(terminal, ticket, workspaces)
    if (adopted) {
      try {
        await options.runtime.sendText(terminal.handle, RESTORED_INSTRUCTION, { enter: true })
        log(`adopted ${ticket.id} on ${terminal.handle}`)
      } catch (error) {
        // 认领本身是对的（终端在、worktree 对）；写不进去由下一次投递重试，不动状态。
        log(`adopted ${ticket.id} but could not say so: ${messageOf(error)}`)
      }
      resumed.push({ ticketId: ticket.id, assignmentId: assignment.id, terminalId, outcome: 'adopted' })
      continue
    }
    options.engine.assignmentLost(ticket.id, assignment.id)
    log(`interrupted ${ticket.id} (${terminalId ?? 'no terminal'})`)
    resumed.push({
      ticketId: ticket.id,
      assignmentId: assignment.id,
      terminalId,
      outcome: 'interrupted'
    })
  }
  return { assignments: resumed }
}

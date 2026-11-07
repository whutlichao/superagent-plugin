// 停止与重试共用的终端收尾（§E.5）：关闭 worker 的终端，worktree 保留。
//
// 顺序是「领域先结束 Assignment，再关终端」：Assignment 的状态写者是 core/engine，本文件
// 只做事务之后的外部副作用。`orca terminal close` 失败（终端已经不在）只记日志，绝不打断
// 已经提交的事务。删 worktree 是另一个动作（§E.1 的清理策略，缺省 `keep`），停止/重试
// 路径上永不调用它——人能保住 worker 留下的东西。
import type { Assignment, Ticket } from '../core/model.ts'
import type { OrcaRuntime } from '../runtime/orca-runtime.ts'

/** 人停止 Ticket 时 Assignment 的结束原因（§E.5）。 */
export const STOPPED = 'stopped'

/** 人重试时被替换的 Assignment 的结束原因（§E.5）。 */
export const RETRIED = 'retried'

/** 要被关闭终端的那个 Assignment（Ticket 只用来写日志）。 */
export interface CloseTarget {
  readonly ticket: Pick<Ticket, 'id'>
  readonly assignment: Pick<Assignment, 'id' | 'terminalId'>
}

/** 关闭终端的依赖：seam 与日志；没有环境读取。 */
export interface CloseOptions {
  readonly runtime: OrcaRuntime
  readonly log?: (message: string) => void
}

/** 一行失败说明（日志用；不抛给调用方）。 */
function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

/**
 * 关闭一个 Assignment 的终端（§E.5 的 `closeTerminal`）。没有终端句柄（launch 还没成功）
 * 或终端已经关掉都算完成：返回是否发起了关闭，永不抛错。
 */
export async function closeAssignmentTerminal(
  target: CloseTarget,
  options: CloseOptions
): Promise<boolean> {
  const terminalId = target.assignment.terminalId
  if (terminalId === undefined) return false
  try {
    await options.runtime.closeTerminal(terminalId)
    return true
  } catch (error) {
    options.log?.(
      `close ${terminalId} for ${target.ticket.id} failed: ${messageOf(error)}`
    )
    return false
  }
}

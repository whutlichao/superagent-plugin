// 人的重试（§E.5）：结束卡住的 Assignment，在同一个 worktree、分支与 PR 上新建一个，并带
// 恢复说明「先看目录、git 历史与 GitHub，别重复已做的外部动作」。
//
// 领域状态只有 core 能写：本文件把原因拼进说明，交给 `Engine.retryTicket` 完成结束 + 新建
// + 排队 launch。被替换终端的关闭发生在同一事务里（`Executor.stop` 端口，见 `stop.ts`），
// 所以这里不碰 runtime，也就不可能开第二个 worktree：复用由 `ensureTicketWorkspace` 按
// `ticket.execution` 的记录做。
import type { Engine } from '../core/engine.ts'
import type { Ticket } from '../core/model.ts'
import { RECOVERY_INSTRUCTION } from '../core/assignments.ts'

/** 重试带给新 Assignment 的恢复说明（§E.5）。 */
export const RETRY_NOTE = `This assignment replaces one that ended before it finished. ${RECOVERY_INSTRUCTION}`

/**
 * 人重试一个卡住的 Ticket：调用领域的唯一写入（结束当前 Assignment、新建并排队 launch），
 * 说明用重试的措辞。可用性（`canRetry`）由领域判定并抛 `notRetryable`。
 */
export function retryTicket(engine: Pick<Engine, 'retryTicket'>, ticketId: string): Ticket {
  return engine.retryTicket(ticketId, RETRY_NOTE)
}

// Execution 页的纯逻辑（§M.2 的筛选、§E.8 的 stage 标签）：与页面拆开，映射在测试里单独钉。
//
// 纯数据：不 import `orca`，也不碰 worker（§C.2 规则 3）。筛选的判定本身在 worker 的读模型里
// （`app/views.ts` 的 `matchesFilter`），面板只把用户的档位原样发过去——两处各写一套「谁在等
// 人」的规则就一定会分叉。
import type { TicketRowData } from './rows'
import { ticketMark, type Mark } from './marks'
import type { PanelTicket } from './protocol'

/**
 * 一条 Execution 行的标记：stage 列、详情页的标记与 Overview 的「其他工单」共用。
 * `blockedFailed` 在两档里共用一个标签，语气按更重的 failed（§E.8 的「面板标签」列）。
 */
export function executionMark(ticket: Pick<PanelTicket, 'stage' | 'outcome'>): Mark {
  switch (ticket.stage) {
    case 'ended':
      return ticketMark({
        stage: 'ended',
        ...(ticket.outcome === undefined ? {} : { outcome: ticket.outcome })
      })
    case 'queued':
      return ticketMark({ stage: 'working', action: 'queued' })
    case 'blockedFailed':
      return ticketMark({ stage: 'person', action: 'failed' })
    case 'idle':
    case 'working':
      return ticketMark({ stage: ticket.stage })
    default:
      return ticketMark({ stage: 'person', action: ticket.stage })
  }
}

/** 一条 Execution 行 → 共享的 Ticket 行（Overview 的「其他工单」用它，标记因此在两页一致）。 */
export function executionRow(ticket: PanelTicket): TicketRowData {
  const base = { id: ticket.id, title: ticket.title, at: ticket.at }
  switch (ticket.stage) {
    case 'ended':
      return { ...base, stage: 'ended', ...(ticket.outcome === undefined ? {} : { outcome: ticket.outcome }) }
    case 'working':
    case 'idle':
      return { ...base, stage: ticket.stage }
    case 'queued':
      return { ...base, action: 'queued' }
    case 'blockedFailed':
      return { ...base, action: 'failed' }
    default:
      return { ...base, action: ticket.stage }
  }
}

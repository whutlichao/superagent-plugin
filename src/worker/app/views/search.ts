// Search 页的读数（§M.1 的第 7 项、§M.2 的 Search 行）：把 `read search` 的视图（CLI 面，
// 时间是 ISO-8601）换成面板的读数（时间换 epoch ms、行上要的字段）。
//
// 命中判定**不在**这里：分组、`find` 的语义（`#12`、Issue/PR 链接、评论链接、Feishu 消息 id）
// 与三处文本的匹配都由 `views/read.ts` 的 `search` 回答（#59 的同一份读模型），这里只换形状，
// 不重新判一次「算不算命中」。
//
// Trigger 的归属 Thread 来自领域记录（`Trigger.threads` 的第一条）——`read search` 的视图只带
// 触发本身。搜索页点一条 Trigger 就是去这条 Thread 的详情，所以映射时把它带上。
import type { PanelTicket, SearchPageView } from '../../../panel/protocol.ts'
import type { SearchView } from './read.ts'

/** 组合根注入的归属读口（面板形状转换需要的那一条领域事实）。 */
export interface SearchPageHost {
  /** 一条 Trigger 所属的 Thread key（`Trigger.threads` 的第一条）。 */
  readonly threadOfTrigger: (triggerId: string) => string | undefined
}

/** 工单的结局取值（与 `core` 的 `TicketOutcome` 同值；`TicketView` 里是裸字符串）。 */
const OUTCOMES = ['completed', 'merged', 'closed', 'dropped', 'stopped'] as const

/** `TicketView.ended.outcome`（裸字符串）→ 面板的结局联合；不认识就当没有。 */
function outcomeOf(value: string | undefined): PanelTicket['outcome'] | undefined {
  if (value === undefined) return undefined
  return (OUTCOMES as readonly string[]).includes(value)
    ? (value as PanelTicket['outcome'])
    : undefined
}

/** ISO-8601 → epoch ms（读模型保证是合法时间；坏值不印出 NaN）。 */
function msOf(iso: string): number {
  const at = Date.parse(iso)
  return Number.isFinite(at) ? at : 0
}

/** 把 `read search` 的视图换成 Search 页的读数。 */
export function searchPage(view: SearchView, host: SearchPageHost): SearchPageView {
  return {
    query: view.query,
    terms: view.terms,
    triggers: {
      truncated: view.triggers.truncated,
      items: view.triggers.items.map((hit) => {
        const thread = host.threadOfTrigger(hit.id)
        return {
          id: hit.id,
          source: hit.source,
          at: msOf(hit.at),
          from: hit.from,
          human: hit.human,
          text: hit.text,
          ...(hit.chars === undefined ? {} : { chars: hit.chars }),
          ...(hit.truncated === true ? { truncated: true as const } : {}),
          ...(hit.url === undefined ? {} : { url: hit.url }),
          ...(thread === undefined ? {} : { thread })
        }
      })
    },
    threads: {
      truncated: view.threads.truncated,
      items: view.threads.items.map((hit) => ({
        key: hit.key,
        source: hit.source,
        title: hit.title,
        ...(hit.url === undefined ? {} : { url: hit.url }),
        ...(hit.lastAt === undefined ? {} : { lastAt: msOf(hit.lastAt) })
      }))
    },
    tickets: {
      truncated: view.tickets.truncated,
      items: view.tickets.items.map((ticket) => {
        const outcome = ticket.stage === 'ended' ? outcomeOf(ticket.ended?.outcome) : undefined
        return {
          id: ticket.id,
          title: ticket.title,
          stage: ticket.stage,
          at: msOf(ticket.updatedAt),
          ...(outcome === undefined ? {} : { outcome })
        }
      })
    }
  }
}

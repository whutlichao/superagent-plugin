// `orca plugin check` 的情景集（§M.7）：每个值得看的状态一个场景；check 逐情景渲染面板，
// 并把 worker 挂到同一个替身宿主上，所以面板的 `plugin.request` 真的会走到 worker 的处理器。
//
// 情景名单（§M.7）：booting、empty、healthy、needs-person、problems、paused、setup-missing、
// long-lists、zh、en、danger-confirm。
//
// 已知边界（Orca 1.4.251）：`defineCheck` 的情景只吃 `mockHost` 的选项 + `persisted` / `theme` /
// `events`，**没有 `locale`**（check 的挂载固定用 `'en'`）。所以 `zh` / `en` 两个情景实际区分的
// 是浅色/深色主题；中英双语的键集合与页面文案由 `tests/locales.test.ts` 与
// `tests/panel-navigation.test.tsx` 覆盖（它们能传 `locale`）。这条边界在票的回报里记明。
import { defineCheck } from 'orca/testing'
import type { AttentionItem, PanelState, PanelTicket } from './protocol'

/** 一份快照；只写关心的字段，其余按健康默认值补齐。 */
function snapshot(overrides: {
  revision?: number
  booted?: boolean
  answer?: number
  review?: number
  problems?: number
  paused?: boolean
  error?: boolean
  setupMissing?: boolean
  items?: readonly AttentionItem[]
  tickets?: readonly PanelTicket[]
  activity?: Partial<PanelState['health']['activity']>
  executor?: Partial<PanelState['health']['executor']>
}): PanelState {
  const answer = overrides.answer ?? 0
  const review = overrides.review ?? 0
  return {
    revision: overrides.revision ?? 1,
    booted: overrides.booted ?? true,
    health: {
      error: overrides.error ?? false,
      paused: overrides.paused ?? false,
      setupMissing: overrides.setupMissing ?? false,
      activity: {
        received: 0,
        evaluated: 0,
        accepted: 0,
        ignored: 0,
        ended: 0,
        ...overrides.activity
      },
      executor: { running: 0, maxWorkers: 4, ...overrides.executor }
    },
    attention: {
      answer,
      review,
      problems: overrides.problems ?? 0,
      items: overrides.items ?? []
    },
    tickets: overrides.tickets ?? []
  }
}

/** 一名待人工的工单；`at` 是固定时刻（check 不看真实时钟）。 */
function ticket(id: string, title: string, action: AttentionItem['action'] = 'answer'): AttentionItem {
  return { id, title, action, at: 1_700_000_000_000 }
}

/** Execution 页的一行：同一个 Ticket 的读数（§Q.1 的验收面：两个情景都要有它）。 */
function ticketRow(
  id: string,
  title: string,
  stage: PanelTicket['stage'] = 'working',
  outcome?: PanelTicket['outcome']
): PanelTicket {
  return { id, title, stage, at: 1_700_000_000_000, ...(outcome === undefined ? {} : { outcome }) }
}

/** 长列表：60 行，超过一页（50）。 */
const manyTickets = Array.from({ length: 60 }, (_, index) =>
  ticket(`t${index}`, `Ticket ${index + 1}: keep the payroll export stable`)
)

/** 一个情景的宿主选项：`state` 的答案 + `pause` 的答案（改过 paused 的同一份快照）。 */
function hostFor(state: PanelState) {
  return {
    requests: {
      state: () => state,
      pause: (input: unknown) => {
        const paused = (input as { paused?: boolean } | null)?.paused === true
        return snapshot({
          revision: state.revision + 1,
          answer: state.attention.answer,
          review: state.attention.review,
          problems: state.attention.problems,
          items: state.attention.items,
          paused,
          error: state.health.error,
          setupMissing: state.health.setupMissing
        })
      }
    }
  }
}

export default defineCheck({
  /** 冷启动：worker 还没应答，面板说「正在启动」并只重试一次。 */
  booting: {
    requests: {
      state: () => {
        throw Object.assign(new Error('worker not started'), { code: 'unavailable' })
      }
    }
  },
  /** 健康且没什么要做：空态 + 24 h 流水。 */
  empty: hostFor(snapshot({ activity: { received: 2, evaluated: 1, accepted: 0, ignored: 1 } })),
  /** 健康且有流水与负载；Execution 页有一张真实形状的工单行。 */
  healthy: hostFor(
    snapshot({
      activity: { received: 12, evaluated: 9, accepted: 3, ignored: 6, ended: 1 },
      executor: { running: 1, maxWorkers: 4 },
      tickets: [ticketRow('t1', 'Fix the login redirect')]
    })
  ),
  /** 有待人工：两种阶段各一行。 */
  'needs-person': hostFor(
    snapshot({
      answer: 1,
      review: 1,
      activity: { received: 6, evaluated: 5, accepted: 2, ignored: 3 },
      items: [ticket('t1', 'Fix the login redirect'), ticket('t2', 'Review the parser rewrite', 'review')],
      tickets: [
        ticketRow('t1', 'Fix the login redirect', 'answer'),
        ticketRow('t2', 'Review the parser rewrite', 'review')
      ]
    })
  ),
  /** 有系统问题：概要与问题数同时可见。 */
  problems: hostFor(
    snapshot({
      error: true,
      problems: 2,
      activity: { received: 3, evaluated: 3, accepted: 0, ignored: 3 }
    })
  ),
  /** 处理已暂停：页面给「恢复处理」的入口（危险操作，按下后行内二次确认）。 */
  paused: hostFor(
    snapshot({
      paused: true,
      activity: { received: 1, evaluated: 0, accepted: 0, ignored: 0 }
    })
  ),
  /** setup 缺失：指向 Settings 的提示。 */
  'setup-missing': hostFor(snapshot({ setupMissing: true })),
  /** 长列表：60 行，首页 50 行 + 「加载更多」。 */
  'long-lists': hostFor(
    snapshot({
      answer: 60,
      activity: { received: 60, evaluated: 60, accepted: 60, ignored: 0 },
      items: manyTickets
    })
  ),
  /** 浅色主题下的待人工页面（`theme` 是 check 能区分的维度；`locale` 见文件头）。 */
  zh: {
    ...hostFor(
      snapshot({ answer: 1, items: [ticket('t1', '修复登录跳转')], tickets: [ticketRow('t1', '修复登录跳转', 'answer')] })
    ),
    theme: 'light' as const
  },
  /** 深色主题下的同一页面。 */
  en: {
    ...hostFor(
      snapshot({ answer: 1, items: [ticket('t1', 'Fix the login redirect')], tickets: [ticketRow('t1', 'Fix the login redirect', 'answer')] })
    ),
    theme: 'dark' as const
  },
  /** 危险操作入口：暂停态 + 待人工，页面上同时有「恢复处理」（需二次确认）与待办行。 */
  'danger-confirm': hostFor(
    snapshot({
      paused: true,
      answer: 1,
      items: [ticket('t1', 'Stop or keep the nightly import')]
    })
  )
})

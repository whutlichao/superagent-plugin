// worker 侧的读模型端口：面板壳只经 `src/panel/protocol.ts` 的 `state` 请求读它。
//
// 两个实现：
// - `createStubStateSource`：面板壳的恒定空快照（#14 的测试与 `plugin check` 夹具用）；
// - `createWorkerStateSource`：组合根接线后的真读数——待人工 Ticket、24 h 流水、Executor
//   负载与 Execution 页的行都从同一个库来（§M.2 ①③④、§N.7 的计数）。
//
// 依赖纪律（§C.2）：这里只依赖面板的协议类型与注入的读口；不 import `orca`、不 host.call。
import type {
  AttentionItem,
  ExecutionFilter,
  PanelState,
  PanelTicket,
  SystemProblem,
  TicketListInput,
  TicketListPage
} from '../../panel/protocol'
import { ticketStage, type Ticket } from '../core/index.ts'
import type { LoadReadout } from '../executor/slots.ts'
import { matchesFilter, ticketView, type TicketFilter } from './views.ts'

/** 一份快照的来源：读当前值，改暂停状态。每改一次，修订号加一（§M.6 的单调计数）。 */
export interface PanelStateSource {
  snapshot(): PanelState
  /** 设置 `paused` 并返回改后的快照（修订号已加一）。 */
  setPaused(paused: boolean): PanelState
  /** 订阅「状态变了」：调用方据此向面板推送并更新状态栏。 */
  onChange(listener: () => void): () => void
}

/** 空快照：没有待人工、没有错误、没有暂停、流水与负载都是零。 */
export function emptyState(revision = 1): PanelState {
  return {
    revision,
    booted: true,
    health: {
      error: false,
      paused: false,
      setupMissing: false,
      sources: { enabled: 0, problems: 0 },
      activity: { received: 0, evaluated: 0, accepted: 0, ignored: 0, ended: 0 },
      executor: { running: 0, maxWorkers: 4, humanSlot: 'free' }
    },
    attention: { answer: 0, review: 0, problems: 0, items: [] },
    problems: [],
    tickets: []
  }
}

/**
 * 本票的桩：一个恒定的空快照，只有 `paused` 会变。它让「面板问得到快照、状态栏按快照更新、
 * 暂停后推送 `state.changed`」这三条线现在就能跑通，而不是等真实计数到位才接。
 */
export function createStubStateSource(initial: PanelState = emptyState()): PanelStateSource {
  let current = initial
  const listeners = new Set<() => void>()
  const changed = (next: PanelState): PanelState => {
    current = next
    for (const listener of listeners) listener()
    return current
  }
  return {
    snapshot: () => current,
    setPaused(paused: boolean): PanelState {
      if (current.health.paused === paused) return current
      return changed({
        ...current,
        revision: current.revision + 1,
        health: { ...current.health, paused }
      })
    },
    onChange(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

/** 24 h 流水的计数（`app/store-read.ts` 之外的三个小查询，都在读模型里）。 */
export interface ActivityCounts {
  readonly received: number
  readonly evaluated: number
  readonly accepted: number
  readonly ignored: number
  readonly ended: number
}

/** 面板快照要读的注入端口（组合根接真库；测试接固定值）。 */
export interface WorkerStateInput {
  /** 全部 Ticket（新的在前）。 */
  readonly tickets: () => readonly Ticket[]
  /** 24 h 流水。 */
  readonly activity: () => ActivityCounts
  /** Executor 负载（§E.6）：运行数 / 上限 / 人类槽，与执行器自己的槽读数是同一份。 */
  readonly load: () => LoadReadout
  /** 是否有 health error 条目。 */
  readonly hasError: () => boolean
  /** setup 是否缺东西。 */
  readonly setupMissing: () => boolean
  readonly paused: () => boolean
  /**
   * Source 概况：启用的实例数与有问题的实例数（注册表的 `overview()` 读数）。缺省全零——
   * 面板壳的夹具与桩不假装有 Source。
   */
  readonly sources?: () => { readonly enabled: number; readonly problems: number }
  /**
   * §J.3 的「系统问题」行：health 的 error 条目 + 24 h 内未解决且未 dismiss 的 unavailable
   * + 连续失败 3 次的回复（回复那一项由组合根从 outbox 读出）。快照里的 `attention.problems`
   * 就是这些行的条数，因此状态栏 tooltip 与 Overview 的列表永远说的是同一件事。
   * 缺省空数组——面板壳的夹具与桩不假装有系统问题。
   */
  readonly problems?: () => readonly SystemProblem[]
  /** Execution 页最多几行（§M.4：无虚拟列表，一页 50 条）。 */
  readonly pageSize?: number
}

/** stage → 待人工行的动作（`AttentionItem.action`）。 */
const PERSON_ACTIONS = ['answer', 'review', 'blocked', 'failed', 'delivery'] as const
type PersonAction = (typeof PERSON_ACTIONS)[number]

const isPersonAction = (value: string): value is PersonAction =>
  (PERSON_ACTIONS as readonly string[]).includes(value)

/** 一条 Ticket 的 stage 是否在等人（§E.8 的 person 档）。 */
function personAction(ticket: Ticket): PersonAction | undefined {
  const stage = ticketStage(ticket)
  return stage.stage === 'person' && isPersonAction(stage.action) ? stage.action : undefined
}

/** 一条 Ticket 正在跑的终端（「Open terminal」那个直接动作用它；没有就不给这个动作）。 */
function runningTerminal(ticket: Ticket): string | undefined {
  const assignment = ticket.assignments.at(-1)
  return assignment?.state === 'running' ? assignment.terminalId : undefined
}

/** Ticket 的更新时间（epoch ms；没有可解析时刻时给 0，`RelativeTime` 会显示得很旧）。 */
function updatedAt(ticket: Ticket): number {
  const at = Date.parse(ticket.updatedAt)
  return Number.isFinite(at) ? at : 0
}

/** 一条 Ticket → Execution 页的一行。 */
export function panelTicketOf(ticket: Ticket): PanelTicket {
  return {
    id: ticket.id,
    title: ticket.title,
    stage: ticketView(ticket).stage,
    ...(ticket.ended === undefined ? {} : { outcome: ticket.ended.outcome }),
    at: updatedAt(ticket)
  }
}

/** 面板的五档筛选 → 领域读模型的筛选（`app/views.ts` 的 `TICKET_FILTERS`）。 */
const TICKET_FILTER_OF: Readonly<Record<ExecutionFilter, TicketFilter>> = {
  open: 'open',
  pending: 'person',
  working: 'working',
  waiting: 'idle',
  ended: 'ended'
}

/** Execution 列表的一页最多几行（§M.4：无虚拟列表，长列表靠分页 50 条）。 */
export const TICKET_PAGE_MAX = 50

/**
 * Execution 列表的一页（§M.2 的筛选 + §M.4 的分页）：筛选与分页交给领域读模型的同一个
 * 判定（`matchesFilter`），面板因此不会自己发明一套「谁在等人」的规则。
 */
export function panelTicketPage(
  tickets: readonly Ticket[],
  input: TicketListInput = {}
): TicketListPage {
  const filter = input.filter === undefined ? undefined : TICKET_FILTER_OF[input.filter]
  const limit = Math.max(1, Math.min(TICKET_PAGE_MAX, input.limit ?? TICKET_PAGE_MAX))
  const offset = Math.max(0, input.offset ?? 0)
  const matched = tickets.filter((ticket) => matchesFilter(ticket, filter))
  return {
    items: matched.slice(offset, offset + limit).map(panelTicketOf),
    nextOffset: offset + limit < matched.length ? offset + limit : null
  }
}

/**
 * 真读数：一份快照里的六个部分（待人工、健康、流水、负载、Execution 行、修订号）都来自
 * 注入的读口，因此 worker 重启后它们仍然一致（同一条 SQL 的同一个读法）。
 */
export function createWorkerStateSource(input: WorkerStateInput): PanelStateSource {
  let revision = 1
  let current = snapshot()
  const listeners = new Set<() => void>()

  function snapshot(): PanelState {
    const tickets = input.tickets()
    const items: AttentionItem[] = tickets.flatMap((ticket) => {
      const action = personAction(ticket)
      if (action === undefined) return []
      const terminalId = runningTerminal(ticket)
      return [
        {
          id: ticket.id,
          title: ticket.title,
          action,
          at: updatedAt(ticket),
          ...(terminalId === undefined ? {} : { terminalId })
        }
      ]
    })
    const answer = items.filter((item) => item.action === 'answer').length
    const review = items.filter((item) => item.action === 'review').length
    const load = input.load()
    const activity = input.activity()
    const problems = input.problems?.() ?? []
    const pageSize = input.pageSize ?? 50
    return {
      revision,
      booted: true,
      health: {
        error: input.hasError(),
        paused: input.paused(),
        setupMissing: input.setupMissing(),
        sources: input.sources?.() ?? { enabled: 0, problems: 0 },
        activity,
        executor: load
      },
      attention: {
        answer,
        review,
        problems: problems.length,
        items: items.sort((left, right) => right.at - left.at)
      },
      problems,
      tickets: tickets.slice(0, pageSize).map(panelTicketOf)
    }
  }

  const changed = (): PanelState => {
    revision += 1
    current = snapshot()
    for (const listener of listeners) listener()
    return current
  }

  return {
    snapshot: () => current,
    setPaused(paused: boolean): PanelState {
      if (current.health.paused === paused) return current
      return changed()
    },
    onChange(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

/** 一次读之后刷新快照（组合根在每次写/每轮 pass 之后调用）。 */
export interface RefreshableStateSource extends PanelStateSource {
  refresh(): PanelState
}

/**
 * 真读数 + 刷新口：`refresh()` 是组合根在收到 Trigger、跑完 pass、写完命令或 report 之后
 * 调用的那一次；修订号只在刷新时前进（推送因此总带着更大的号）。
 *
 * `setPaused` 不写暂停状态（那是 `app/pause.ts` 的唯一职责）：它只按当前读口重新取一份，
 * 让面板的 `pause` 请求拿到写后的快照。
 */
export function createRefreshableStateSource(input: WorkerStateInput): RefreshableStateSource {
  let revision = 1
  const listeners = new Set<() => void>()
  let current: PanelState = { ...createWorkerStateSource(input).snapshot(), revision }

  const next = (): PanelState => {
    revision += 1
    const base = createWorkerStateSource(input).snapshot()
    current = { ...base, revision }
    for (const listener of listeners) listener()
    return current
  }

  return {
    snapshot: () => current,
    setPaused(): PanelState {
      return next()
    },
    refresh: next,
    onChange(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

// worker 侧的读模型端口：面板壳只经 `src/panel/protocol.ts` 的 `state` 请求读它。
//
// 两个实现：
// - `createStubStateSource`：面板壳的恒定空快照（#14 的测试与 `plugin check` 夹具用）；
// - `createWorkerStateSource`：组合根接线后的真读数——待人工 Ticket、24 h 流水、Executor
//   负载与 Execution 页的行都从同一个库来（§M.2 ①③④、§N.7 的计数）。
//
// 依赖纪律（§C.2）：这里只依赖面板的协议类型与注入的读口；不 import `orca`、不 host.call。
import type { AttentionItem, PanelState, PanelTicket } from '../../panel/protocol'
import { ticketStage, type Ticket } from '../core/index.ts'
import { ticketView } from './views.ts'

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
      activity: { received: 0, evaluated: 0, accepted: 0, ignored: 0, ended: 0 },
      executor: { running: 0, maxWorkers: 4 }
    },
    attention: { answer: 0, review: 0, problems: 0, items: [] },
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
  /** Executor 负载（running / maxWorkers）。 */
  readonly load: () => { readonly running: number; readonly maxWorkers: number }
  /** 是否有 health error 条目。 */
  readonly hasError: () => boolean
  /** setup 是否缺东西。 */
  readonly setupMissing: () => boolean
  readonly paused: () => boolean
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

/** Ticket 的更新时间（epoch ms；没有可解析时刻时给 0，`RelativeTime` 会显示得很旧）。 */
function updatedAt(ticket: Ticket): number {
  const at = Date.parse(ticket.updatedAt)
  return Number.isFinite(at) ? at : 0
}

/** 一条 Ticket → Execution 页的一行。 */
function panelTicket(ticket: Ticket): PanelTicket {
  return { id: ticket.id, title: ticket.title, stage: ticketView(ticket).stage, at: updatedAt(ticket) }
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
      return action === undefined
        ? []
        : [{ id: ticket.id, title: ticket.title, action, at: updatedAt(ticket) }]
    })
    const answer = items.filter((item) => item.action === 'answer').length
    const review = items.filter((item) => item.action === 'review').length
    const load = input.load()
    const activity = input.activity()
    const pageSize = input.pageSize ?? 50
    return {
      revision,
      booted: true,
      health: {
        error: input.hasError(),
        paused: input.paused(),
        setupMissing: input.setupMissing(),
        activity,
        executor: load
      },
      attention: {
        answer,
        review,
        problems: 0,
        items: items.sort((left, right) => right.at - left.at)
      },
      tickets: tickets.slice(0, pageSize).map(panelTicket)
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

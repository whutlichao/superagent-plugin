// `protocol.ts` 是面板↔worker 的唯一契约（§M.6）：请求与推送在一处声明合并，
// 两侧共用一个文件、一份类型；本票只落地面板壳用到的名字，页面票（#37–#48）在此追加。
//
// 面板侧纯类型模块：不 import `orca` 的运行时值（`declare module` 只做类型增强），
// 不碰 worker（§C.2 规则 3）。
//
// 修订号语义：worker 每次状态变化后把 `revision` 加一（单调递增）并 `panels.post('state.changed')`；
// 面板只按修订号更大的推送覆盖手里的状态，因此乱序到达的旧推送不会回退页面。

export {}

/** 页面壳的七个导航项（§M.1）；术语表是页头覆盖层，不在其中。 */
export type NavPage =
  | 'overview'
  | 'source'
  | 'trigger'
  | 'eval'
  | 'execution'
  | 'settings'
  | 'search'

/**
 * 导航项的顺序与取值，一处定义：导航表、导航记忆的校验与测试都读它，
 * 避免「七项」这个事实被抄成三份。
 */
export const NAV_PAGES: readonly NavPage[] = [
  'overview',
  'source',
  'trigger',
  'eval',
  'execution',
  'settings',
  'search'
]

/** 判断一个（可能来自存储的）值是否是导航项。 */
export function isNavPage(value: unknown): value is NavPage {
  return typeof value === 'string' && (NAV_PAGES as readonly string[]).includes(value)
}

/** 待人工的三个分项计数（§N.7 的 tooltip）。 */
export interface AttentionCounts {
  /** 待回答：Ticket 上有 Attention（结构化提问或 agent 的 blocked 状态）。 */
  readonly answer: number
  /** 待评审：最近一份 Report 是 ready。 */
  readonly review: number
  /** 系统问题：health error 条目、反复失败的回复、未解决的 unavailable。 */
  readonly problems: number
}

/** 一名待人工的 Ticket（Overview 的行；详情页由 #38 填充）。 */
export interface AttentionItem {
  readonly id: string
  readonly title: string
  /** 该行等人做什么：直接决定行上的动作与标记（`marks.ticketMark`）。 */
  readonly action: 'answer' | 'review' | 'blocked' | 'failed' | 'delivery'
  /** 最后更新时间（epoch ms）；页面用相对时间组件显示，绝不自己计时。 */
  readonly at: number
  /**
   * 该 Ticket 当前 Assignment 的终端句柄（§E.3）。有它才给「Open terminal」这个直接动作
   * ——没有终端的行（例如投递失败）不该画一个按了会失败的按钮。
   */
  readonly terminalId?: string
}

/** 系统问题的三类来源（§J.3）：health 的 error 条目、反复失败的回复、未解决的 unavailable。 */
export type ProblemKind = 'health' | 'reply' | 'unavailable'

/**
 * Overview「System problems」的一行（§J.3）：把三处来源折成同一种行，点行去归属页面。
 * `name` 是出问题的部件或对象（health 条目名、回复的去处、Thread key），
 * `detail` 是 worker 侧的一句话事实（health 的 detail、unavailable 的原因）。
 */
export interface SystemProblem {
  readonly id: string
  readonly kind: ProblemKind
  readonly name: string
  /** 一句话原因；回复类没有原因，只有「发不出去」这个事实（页面用固定措辞）。 */
  readonly detail?: string
}

/**
 * Executor 的人类槽（§E.6「另有一个人类槽」）：只有人的唤醒能占用它，面板单列它的占用。
 */
export type HumanSlot = 'free' | 'used'

/** worker 的健康摘要：决定状态栏语气与 Overview 的错误态。 */
export interface WorkerHealth {
  /** 是否有 health error 条目。 */
  readonly error: boolean
  /** 处理是否暂停（`paused` 设置）。 */
  readonly paused: boolean
  /** setup 是否还缺东西（缺时页面提示去哪里补）。 */
  readonly setupMissing: boolean
  /**
   * Source 概况：启用的实例数与有问题的实例数（§I.1、§N.4 的 `sources` 条目）。
   * Overview 空态那行「Sources: N enabled, M problems」读它，与 Source 页同一份读数。
   */
  readonly sources: { readonly enabled: number; readonly problems: number }
  /** 首屏流水：24 h 内各去向的计数（Overview 用；页面票填充真实读数）。 */
  readonly activity: {
    readonly received: number
    readonly evaluated: number
    readonly accepted: number
    readonly ignored: number
    readonly ended: number
  }
  /** 执行器负载（§E.6）：运行中的 worker 数、上限，以及单列的人类槽。 */
  readonly executor: {
    readonly running: number
    readonly maxWorkers: number
    readonly humanSlot: HumanSlot
  }
}

/** Execution 页的一行（本票的垂直切片：真实的 Ticket 读数，详情页归 #38）。 */
export interface PanelTicket {
  readonly id: string
  readonly title: string
  /** §E.8 的七档之一；已结束是 `ended`。 */
  readonly stage:
    | 'delivery'
    | 'answer'
    | 'review'
    | 'blockedFailed'
    | 'queued'
    | 'idle'
    | 'working'
    | 'ended'
  /** 已结束时的结局（§E.8 的 `outcome.*` 措辞用）；未结束没有它。 */
  readonly outcome?: 'completed' | 'merged' | 'closed' | 'dropped' | 'stopped'
  /** 最后更新时间（epoch ms）。 */
  readonly at: number
}

/** 一份面板状态快照。本票只交付恒定骨架；真实读数由后续票填进同一形状。 */
export interface PanelState {
  /** 单调递增的修订号：面板据此丢弃过期推送。 */
  readonly revision: number
  /** worker 是否已经完成启动（false = 冷启动中，面板显示「正在启动」）。 */
  readonly booted: boolean
  readonly health: WorkerHealth
  readonly attention: AttentionCounts & { readonly items: readonly AttentionItem[] }
  /**
   * System problems 的行（§J.3）；`attention.problems` 就是它的条数（同一份读数，不另记一次）。
   * 三类来源：health 的 error 条目、连续失败 3 次的 reply、24 h 内未解决的 unavailable。
   */
  readonly problems: readonly SystemProblem[]
  /**
   * Execution 页的行（最近的 Ticket，最多 50 条）。可选：旧快照（面板壳的测试与
   * `plugin check` 的夹具）没有它时页面按空列表渲染。
   */
  readonly tickets?: readonly PanelTicket[]
}

/** 面板可发起的动作：暂停/恢复处理（§M.2 的 Overview 主操作，破坏性，需行内二次确认）。 */
export interface PauseInput {
  readonly paused: boolean
}

/** 一次动作的对象：一张 Ticket。 */
export interface TicketInput {
  readonly ticketId: string
}

/** 一次动作的对象：一台终端（`terminal.handle` 的 `term_…`）。 */
export interface TerminalInput {
  readonly terminalId: string
}

/** 聚焦终端的结果：worker 把 `orca terminal focus` 跑完才算成功（§M.2）。 */
export interface FocusOutcome {
  readonly focused: boolean
}

/**
 * 本票声明的请求名（运行时值，供测试与 worker 侧注册处对照）。
 * 类型侧由下面的声明合并给出：本清单必须与 `PluginRequests` 的键一致。
 */
export const PLUGIN_REQUESTS = ['state', 'pause', 'check', 'ticket.retry', 'terminal.focus'] as const

/** 本票声明的推送名（运行时值），与 `PluginPanelEvents` 的键一致。 */
export const PLUGIN_PANEL_EVENTS = ['state.changed'] as const

declare module 'orca' {
  interface PluginRequests {
    /** 首屏与每次推送后读一份状态快照（§M.6：面板不轮询，只在需要时问）。 */
    state: { output: PanelState }
    /** 暂停或恢复处理；返回动作后的快照。 */
    pause: { input: PauseInput; output: PanelState }
    /**
     * 让 worker 重新读一遍它的读模型再返回快照（Overview 的「Check again」）。
     * 与 `state` 的区别：`state` 回答缓存的那一份，`check` 真的重跑一次查询（§M.2 的主操作）。
     */
    check: { output: PanelState }
    /**
     * 人的重试（§E.5、§G.2 的 `ticket retry`）：结束卡住的 Assignment，在同一个 worktree、
     * 分支与 PR 上再起一个，带恢复说明。可用性由领域判定（不可重试时按 `invalid_params` 拒绝）。
     */
    'ticket.retry': { input: TicketInput; output: PanelState }
    /**
     * 聚焦一台终端（§M.2「面板不能直接做的两件事」）：面板没有这个宿主能力，
     * 由 worker 跑 `orca terminal focus --terminal <handle>`。
     */
    'terminal.focus': { input: TerminalInput; output: FocusOutcome }
  }

  interface PluginPanelEvents {
    /** worker 在状态变化后推送；`revision` 单调递增。 */
    'state.changed': { readonly revision: number }
  }
}

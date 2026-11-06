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
}

/** worker 的健康摘要：决定状态栏语气与 Overview 的错误态。 */
export interface WorkerHealth {
  /** 是否有 health error 条目。 */
  readonly error: boolean
  /** 处理是否暂停（`paused` 设置）。 */
  readonly paused: boolean
  /** setup 是否还缺东西（缺时页面提示去哪里补）。 */
  readonly setupMissing: boolean
  /** 首屏流水：24 h 内各去向的计数（Overview 用；页面票填充真实读数）。 */
  readonly activity: {
    readonly received: number
    readonly evaluated: number
    readonly accepted: number
    readonly ignored: number
    readonly ended: number
  }
  /** 执行器负载：运行中的 worker 数与上限。 */
  readonly executor: { readonly running: number; readonly maxWorkers: number }
}

/** 一份面板状态快照。本票只交付恒定骨架；真实读数由后续票填进同一形状。 */
export interface PanelState {
  /** 单调递增的修订号：面板据此丢弃过期推送。 */
  readonly revision: number
  /** worker 是否已经完成启动（false = 冷启动中，面板显示「正在启动」）。 */
  readonly booted: boolean
  readonly health: WorkerHealth
  readonly attention: AttentionCounts & { readonly items: readonly AttentionItem[] }
}

/** 面板可发起的动作：暂停/恢复处理（§M.2 的 Overview 主操作，破坏性，需行内二次确认）。 */
export interface PauseInput {
  readonly paused: boolean
}

/**
 * 本票声明的请求名（运行时值，供测试与 worker 侧注册处对照）。
 * 类型侧由下面的声明合并给出：本清单必须与 `PluginRequests` 的键一致。
 */
export const PLUGIN_REQUESTS = ['state', 'pause'] as const

/** 本票声明的推送名（运行时值），与 `PluginPanelEvents` 的键一致。 */
export const PLUGIN_PANEL_EVENTS = ['state.changed'] as const

declare module 'orca' {
  interface PluginRequests {
    /** 首屏与每次推送后读一份状态快照（§M.6：面板不轮询，只在需要时问）。 */
    state: { output: PanelState }
    /** 暂停或恢复处理；返回动作后的快照。 */
    pause: { input: PauseInput; output: PanelState }
  }

  interface PluginPanelEvents {
    /** worker 在状态变化后推送；`revision` 单调递增。 */
    'state.changed': { readonly revision: number }
  }
}

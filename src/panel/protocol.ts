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

/**
 * 健康条目的四档状态（§N.4、§J.3）：域内 `HEALTH_STATES` 的面板面，取值逐字相同。
 * 面板不 import worker（§C.2 规则 3），所以这里写一份字符串联合而不是转出领域类型。
 */
export type HealthStateName = 'starting' | 'ready' | 'paused' | 'error'

/** 一条 health 明细（§N.4）：条目名、四档状态与明细（明细里带计数）。 */
export interface HealthDetail {
  /** 条目名（`runtime`、`passes`、`sync:<source id>` …）；面板按部件分组，不翻译技术名。 */
  readonly name: string
  readonly state: HealthStateName
  /** 一句话明细（`waiting 2, failed 0` 这类计数就在里面）；还没报告过时省略。 */
  readonly detail?: string
}

/** 一条 setup 问题（§I.4、§N.1）：**只报缺什么**，附一句修法与重跑入口。 */
export interface DeploymentSetupIssue {
  /** 归属部件（`orca`/`state`/`executor`/`github`/`feishu`）。 */
  readonly place: string
  /** 固定码（面板按码说事，不解析 detail）。 */
  readonly code: string
  /** `missing` 是人还没填；`broken` 是填了但读不通。 */
  readonly kind: 'missing' | 'broken'
  /** 一句话说清现状（可含路径与选择器：路径不是秘密，§N.5）。 */
  readonly detail: string
  /** 一句话说清怎么修。 */
  readonly fix: string
  /** 修完从哪重跑（恒为 `superagent setup check`）。 */
  readonly checkAgain: string
}

/** 机器限额（§H.12、§H.22、§L.6、§D.2 要点 5）：本机在用的四个数值。 */
export interface DeploymentLimits {
  /** 保存的提示词配置总量上限（字符）。 */
  readonly promptMaxChars: number
  /** 一次评估最多读几页 Thread。 */
  readonly admissionContextMaxPages: number
  /** 一次评估语境读取的时限（毫秒）。 */
  readonly admissionContextTimeoutMs: number
  /** 保留阈值（天）。 */
  readonly retentionDays: number
}

/** Router 的读数（§F.1、§D.4；面板只读这一份，不推自己的状态机）。 */
export interface DeploymentRouter {
  readonly state: HealthStateName
  readonly detail: string
  readonly terminalId: string | null
  /** 会话启动时刻（ISO-8601）；没有会话时是 `null`。 */
  readonly startedAt: string | null
  /** 十分钟窗口内的自动重启次数。 */
  readonly restarts: number
  readonly lastError: string | null
}

/**
 * 部署页的一份读数（§M.3 Deployment）：一次读全部，面板不轮询。
 * `doctor` 单独一条请求（它会真的跑 `gh`/`lark-cli`，只在人要的时候跑）。
 */
export interface DeploymentView {
  /** 状态目录（只读展示；改它要去 Orca 设置并重启插件）。 */
  readonly stateDir: string
  /** 现在还有的 setup 问题（逐条可操作）；没有就是空表。 */
  readonly setup: readonly DeploymentSetupIssue[]
  readonly limits: DeploymentLimits
  /** 处理是否暂停（与 Overview 的暂停是同一个写者，§K.6）。 */
  readonly paused: boolean
  /** 每一条 health 明细（按条目名；面板按部件分组后渲染）。 */
  readonly health: readonly HealthDetail[]
  readonly router: DeploymentRouter
}

/** 一次「检查一次」的结果（§G.2 的 `setup check`）：本来没问题时 `checked: false`。 */
export interface SetupCheckView {
  readonly checked: boolean
  readonly problems: readonly DeploymentSetupIssue[]
}

/** 轮换主 token 的结果（§G.2 的 `admin rotate-token`）：只给路径，绝不给值（§O）。 */
export interface RotateTokenView {
  readonly rotated: boolean
  /** token 文件的绝对路径（值不出现在任何读数里）。 */
  readonly tokenFile: string
}

/** doctor 的一条结论（§G.2、§N.4）：只报有没有，不报是什么。 */
export interface DoctorCheckView {
  readonly name: string
  readonly state: 'ok' | 'warn' | 'fail'
  readonly detail: string
  /** 给人下一步做什么（只有 warn/fail 才有）。 */
  readonly hint?: string
}

/** doctor 的完整结果（§G.2 的 `doctor` 行；面板与 CLI 读同一份形状）。 */
export interface DoctorView {
  readonly checks: readonly DoctorCheckView[]
  readonly summary: { readonly ok: number; readonly warn: number; readonly fail: number }
  readonly at: string
  /** 一句分工说明：doctor 是诊断，能不能开工由 setup 检查决定。 */
  readonly note: string
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
   * Execution 页的行（最近的 Ticket，最多 50 条）。可选：旧快照（面板壳的测试与
   * `plugin check` 的夹具）没有它时页面按空列表渲染。
   */
  readonly tickets?: readonly PanelTicket[]
}

/** 面板可发起的动作：暂停/恢复处理（§M.2 的 Overview 主操作，破坏性，需行内二次确认）。 */
export interface PauseInput {
  readonly paused: boolean
}

/**
 * 本票声明的请求名（运行时值，供测试与 worker 侧注册处对照）。
 * 类型侧由下面的声明合并给出：本清单必须与 `PluginRequests` 的键一致。
 */
export const PLUGIN_REQUESTS = [
  'state',
  'pause',
  'deployment',
  'doctor',
  'setupCheck',
  'rotateToken',
  'restartRouter'
] as const

/** 本票声明的推送名（运行时值），与 `PluginPanelEvents` 的键一致。 */
export const PLUGIN_PANEL_EVENTS = ['state.changed'] as const

declare module 'orca' {
  interface PluginRequests {
    /** 首屏与每次推送后读一份状态快照（§M.6：面板不轮询，只在需要时问）。 */
    state: { output: PanelState }
    /** 暂停或恢复处理；返回动作后的快照。 */
    pause: { input: PauseInput; output: PanelState }
    /** Deployment 页的读数（§M.3）：setup 问题、状态目录、机器限额、暂停、health、Router。 */
    deployment: { output: DeploymentView }
    /** doctor 的结果（§G.2）：跑一次八项检查，只报有没有。 */
    doctor: { output: DoctorView }
    /** 重跑 setup 探针（「检查一次」）：本来没问题时 `checked: false`。 */
    setupCheck: { output: SetupCheckView }
    /** 轮换主 token（破坏性；面板先做行内二次确认）。 */
    rotateToken: { output: RotateTokenView }
    /** 人显式要求重启 Router（破坏性；面板先做行内二次确认）；返回重启后的读数。 */
    restartRouter: { output: DeploymentRouter }
  }

  interface PluginPanelEvents {
    /** worker 在状态变化后推送；`revision` 单调递增。 */
    'state.changed': { readonly revision: number }
  }
}

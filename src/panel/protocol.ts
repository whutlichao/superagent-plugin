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
  /**
   * 这条问题背后的 Decision（只有 `unavailable` 有，§K.7）：Overview 点行去 Eval 页时
   * 要打开的那一条，页面因此不必解析 `unavailable:<id>` 这个合成 id。
   */
  readonly decisionId?: string
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

/**
 * Execution 列表的五档筛选（§M.2：开放、待办、工作中、等待、已结束）。取值是面板的语言，
 * worker 把它映射到领域读模型的筛选（`app/views.ts` 的 `TICKET_FILTERS`），两边只有一个映射。
 */
export const EXECUTION_FILTERS = ['open', 'pending', 'working', 'waiting', 'ended'] as const
export type ExecutionFilter = (typeof EXECUTION_FILTERS)[number]

/** 一个值是否是五档筛选之一（存储里的旧值、面板与 worker 的入参都用这一处判定）。 */
export function isExecutionFilter(value: unknown): value is ExecutionFilter {
  return typeof value === 'string' && (EXECUTION_FILTERS as readonly string[]).includes(value)
}

/** 一次列表请求：筛选 + 分页窗口（与 CLI 的 `ticket list --state/--offset/--limit` 同义）。 */
export interface TicketListInput {
  /** 缺省是全部（`open` 的子集：未结束的都在内）。 */
  readonly filter?: ExecutionFilter
  /** 从第几行开始（缺省 0）。 */
  readonly offset?: number
  /** 一页最多几行（缺省 50，§M.4）。 */
  readonly limit?: number
}

/** 一页 Execution 行；`nextOffset` 为 `null` 表示没有下一页。 */
export interface TicketListPage {
  readonly items: readonly PanelTicket[]
  readonly nextOffset: number | null
}

/**
 * 一条 Decision 在面板上的原因（§D.2）：码 + 占位符 + 它属于哪条 Trigger。
 * 面板按 `reason.<code>` 自己翻译（§M.5），因此 worker 只传结构，不传英文句子。
 */
export interface PanelReason {
  readonly code: string
  readonly values?: Readonly<Record<string, string>>
  readonly triggerId?: string
}

/** Decision 的四种（§D.2，与 `core` 的 `DECISION_KINDS` 同值）。 */
export type PanelDecisionKind = 'accept' | 'stop' | 'ignore' | 'unavailable'

/** Eval 页的一行（§M.2：kind、reason、strength、policy version、at）。 */
export interface PanelDecision {
  readonly id: string
  readonly kind: PanelDecisionKind
  readonly reasons: readonly PanelReason[]
  readonly strength: 'explicit' | 'inferred'
  readonly policyVersion: string
  /** 决定落库的时刻（epoch ms）；页面交给 `RelativeTime`，绝不自己计时。 */
  readonly at: number
}

/** Eval 列表的一次请求：只有分页窗口（§M.4：无虚拟列表，一页 50 条）。 */
export interface DecisionListInput {
  readonly offset?: number
  readonly limit?: number
}

/**
 * 一页 Decision。`unresolved` 是 §K.7 的待人工条数（< 24 h、该 Thread 最新、未 dismiss、
 * Thread 不在排队/评估中），与 Overview 的 System problems 用同一份读数。
 */
export interface DecisionListPage {
  readonly items: readonly PanelDecision[]
  readonly nextOffset: number | null
  readonly unresolved: number
}

/** 一条 Decision 的详情（§M.2 的 Eval 详情）：字段、原因，以及到 Thread/Ticket 的链接。 */
export interface DecisionDetailView {
  readonly id: string
  readonly kind: PanelDecisionKind
  readonly reasons: readonly PanelReason[]
  readonly strength: PanelDecision['strength']
  readonly policyVersion: string
  /** 决定落库的时刻（epoch ms）。 */
  readonly at: number
  /** 它评的是哪条 Thread（title 是 Source 给的 label，没有就是 key）。 */
  readonly thread: { readonly key: string; readonly title: string }
  /** 它开的 Ticket（accept 才有；Ticket 已不在时仍给 id 与一句说明）。 */
  readonly ticket?: { readonly id: string; readonly title: string }
  /** 这次评估持有的 Trigger（§D.2）。 */
  readonly triggerIds: readonly string[]
  /** 已被 dismiss 的问题（§K.7）；不再计入待人工，但记录仍在。 */
  readonly dismissed: boolean
  /** 现在是否仍要人：§K.7 的四个条件都成立。 */
  readonly unresolved: boolean
  /** 只有未 dismiss 的 unavailable 才有入口（领域允许重复 dismiss，面板不重复问）。 */
  readonly canDismiss: boolean
}

/** 一次动作的对象：一条 Decision。 */
export interface DecisionInput {
  readonly decisionId: string
}

/** 一份 Report 的面板面（§E.8）：状态 + 摘要 + 时刻。 */
export interface PanelReport {
  readonly state: 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'
  readonly summary: string
  readonly at: number
}

/** 一条 Assignment 的面板面（§E.3）：详情页的折叠列表用它。 */
export interface PanelAssignment {
  readonly id: string
  readonly state: 'pending' | 'running' | 'ended'
  readonly createdAt: number
  readonly startedAt?: number
  readonly endedAt?: number
  readonly endedReason?: string
  readonly terminalId?: string
  readonly report?: PanelReport
}

/** 一条等待投递的 Input（§E.4）：面板只给一句摘要，不重放整段原文。 */
export interface PanelInput {
  readonly id: string
  readonly kind: 'trigger' | 'text' | 'note' | 'policy-changed' | 'resumed'
  readonly at: number
  /** 一句话摘要：Trigger 的原话（截短）、note 的正文，或固定措辞要用的数据。 */
  readonly text?: string
  /** `kind: 'trigger'` / `'resumed'` 指向的那条 Trigger。 */
  readonly triggerId?: string
  /** 人写的（Trigger 输入才标）：决定「解除 blocked」与否的是它。 */
  readonly human?: boolean
}

/** 一个订阅（§D.1）：该 Ticket 收到的 Thread。 */
export interface PanelSubscription {
  readonly key: string
  /** 人读的名字（Source 给的 label）；没有就是 key。 */
  readonly title: string
  readonly lastAt?: number
  /** 只当语境（§D.1 / §I.5）：这条 Thread 上的消息不路由给该 Ticket。 */
  readonly context: boolean
}

/** 授权面（§M.2 的 Mandate 块）：强度、依据、匹配规则与 policy version。 */
export interface PanelMandate {
  readonly strength: 'explicit' | 'inferred'
  /** 发起人（`<source>:<id>`，与读模型同一拼法）。 */
  readonly actor: string
  readonly policyVersion: string
  /** Gate 如何准入它（§K.3 的 `MandateBasis.via`）。 */
  readonly via: 'addressed' | 'followup' | 'admission' | 'bot'
  /** 接收行（`admission` / `bot` 才有，§K.1）。 */
  readonly cell?: 'listedUnaddressed' | 'unlistedAddressed' | 'unlistedUnaddressed'
  /** 评估匹配到的规则（`MandateBasis.rules` 的 id）。 */
  readonly rules: readonly string[]
}

/** 终端摘要（§E.7 的取证）：只给最后若干行，不是整段历史。 */
export interface PanelTerminal {
  readonly terminalId: string
  readonly lines: readonly string[]
  readonly truncated: boolean
}

/** 一张工单的详情（§M.2 的 Execution 详情）：授权、等待中的 Input、订阅、派工、报告、待人工与终端。 */
export interface TicketDetailView {
  readonly id: string
  readonly title: string
  /** §E.8 的七档之一（与列表同一判定，不带 `agentState` 时是表的严格结果）。 */
  readonly stage: PanelTicket['stage']
  readonly outcome?: PanelTicket['outcome']
  /** 最后更新时间（epoch ms）。 */
  readonly at: number
  readonly mandate: PanelMandate
  /** 等投递的 Input，按加入顺序（`ticket.undelivered`）。 */
  readonly waitingInputs: readonly PanelInput[]
  readonly subscriptions: readonly PanelSubscription[]
  readonly assignments: readonly PanelAssignment[]
  /** 每一份 Report（按派工顺序；详情页单列一块）。 */
  readonly reports: readonly PanelReport[]
  /** 现在等人回答的问题（§E.7 的终端来源标 `via: 'terminal'`）。 */
  readonly attention?: {
    readonly question: string
    readonly at: number
    readonly via: 'terminal' | null
  }
  /** 当前派工终端的摘要；终端已不在或没起来时省略。 */
  readonly terminal?: PanelTerminal
  /** 该工单的 worktree（§E.1）：有它才给「Open worktree」「Remove worktree」。 */
  readonly worktree?: { readonly name: string; readonly directory: string }
  readonly ended?: {
    readonly at: number
    readonly by: 'executor' | 'human'
    readonly outcome: 'completed' | 'merged' | 'closed' | 'dropped' | 'stopped'
    readonly reason?: string
  }
  /** 领域判定它现在可重试（`canRetry`）：不可重试时页面不画这个按钮。 */
  readonly canRetry: boolean
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

/** 给一张工单发一条 fact note（§G.2 的 `ticket note`）：只加语境，不授权任何事。 */
export interface TicketNoteInput extends TicketInput {
  readonly text: string
}

/** 「请求状态」的结果（§G.2 的 `ticket request-status`）：只有正在等 trigger 的 worker 才被问。 */
export interface StatusAskOutcome {
  readonly asked: boolean
}

/** 打开该工单的 worktree（§M.2：面板没有这个宿主方法，由 worker 调 `workspace.open`）。 */
export interface WorktreeOpened {
  readonly opened: boolean
}

/** 移除该工单的 worktree（§E.1 清理：破坏性，面板先做行内二次确认）。 */
export interface WorktreeRemoved {
  readonly removed: boolean
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
export const PLUGIN_REQUESTS = [
  'state',
  'pause',
  'check',
  'decisions',
  'decision.detail',
  'decision.dismiss',
  'tickets',
  'ticket.detail',
  'ticket.retry',
  'ticket.stop',
  'ticket.note',
  'ticket.requestStatus',
  'terminal.focus',
  'workspace.open',
  'workspace.remove',
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
     * Execution 列表的一页（§M.2 的筛选 + §M.4 的分页）：筛选与分页都在 worker 的读模型里，
     * 面板只画回来的窗口；`nextOffset` 为 `null` 就是没有下一页。
     */
    tickets: { input: TicketListInput; output: TicketListPage }
    /**
     * 一张工单的详情（§M.2 的 Execution 详情）：授权、等待中的 Input、订阅、派工、报告、
     * 待人工与终端摘要。终端摘要是一次 `terminal.read`，读不到就省略而不是编造。
     */
    'ticket.detail': { input: TicketInput; output: TicketDetailView }
    /**
     * 停止一张工单（§E.5、§G.2 的 `ticket stop`）：撤回 Mandate 并结束它。破坏性，面板先做
     * 行内二次确认；确认本身就是这一次请求（与 CLI 的 `--yes` 同一个意思）。
     */
    'ticket.stop': { input: TicketInput; output: PanelState }
    /** 发一条 fact note（§G.2 的 `ticket note`）：只加语境，不要求也不授权任何事。 */
    'ticket.note': { input: TicketNoteInput; output: PanelState }
    /** 请求状态（§G.2 的 `ticket request-status`）：只问正在等 trigger 的 worker。 */
    'ticket.requestStatus': { input: TicketInput; output: StatusAskOutcome }
    /**
     * 聚焦一台终端（§M.2「面板不能直接做的两件事」）：面板没有这个宿主能力，
     * 由 worker 跑 `orca terminal focus --terminal <handle>`。
     */
    'terminal.focus': { input: TerminalInput; output: FocusOutcome }
    /**
     * 打开该工单的 worktree（§M.2）：面板没有 `workspace.open` 这个宿主方法，
     * 由 worker 按 Ticket 记录的目录找到工作区再调宿主。
     */
    'workspace.open': { input: TicketInput; output: WorktreeOpened }
    /**
     * 移除该工单的 worktree（§E.1「清理」，破坏性、需二次确认）：Host API 没有删除方法，
     * 由 worker 跑 `orca worktree rm`。
     */
    'workspace.remove': { input: TicketInput; output: WorktreeRemoved }
    /** Deployment 页的读数（§M.3）：setup 问题、状态目录、机器限额、暂停、health、Router。 */
    deployment: { output: DeploymentView }
    /** doctor 的结果（§G.2）：跑一次八项检查，只报有没有。 */
    doctor: { output: DoctorView }
    /** 重跑 setup 探针（「检查一次」）：本来没问题时 `checked: false`。 */
    setupCheck: { output: SetupCheckView }
    /**
     * Eval 页的一页（§M.2 的 Decision 列表）：最新的在前，分页 50 条；
     * `unresolved` 是 §K.7 的四条件判出的待人工条数（与 Overview 的 System problems 同一份读数）。
     */
    decisions: { input: DecisionListInput; output: DecisionListPage }
    /**
     * 一条 Decision 的详情（§M.2 的 Eval 详情）：字段、原因，以及到 Thread/Ticket 的链接。
     * 未知决定按 `unknownDecision` 拒绝。
     */
    'decision.detail': { input: DecisionInput; output: DecisionDetailView }
    /**
     * 把一条 unavailable 决定暴露的问题标为已 dismiss（§K.7）：破坏性不高但不可逆，
     * 面板先做行内二次确认；其它 kind 由领域按 `unknownProblem` 拒绝。返回写后的快照。
     */
    'decision.dismiss': { input: DecisionInput; output: PanelState }
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

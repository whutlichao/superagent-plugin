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

/**
 * Trigger 页的四档 Thread 筛选（§M.2：Subscribed / Evaluating / New in 24 h / All）。取值是面板
 * 的语言，worker 把它映射到读模型自己的判定（`app/views/threads.ts`），两边只有一个映射。
 */
export const THREAD_FILTERS = ['subscribed', 'evaluating', 'recent', 'all'] as const
export type ThreadFilter = (typeof THREAD_FILTERS)[number]

/** 一个值是否是四档 Thread 筛选之一（存储里的旧值与 worker 的入参都用这一处判定）。 */
export function isThreadFilter(value: unknown): value is ThreadFilter {
  return typeof value === 'string' && (THREAD_FILTERS as readonly string[]).includes(value)
}

/**
 * Thread 的阶段（§M.2 的 Trigger 状态标记）：`marks.ts` 的 `threadMark` 按它给标记与语气。
 * 面板不 import worker（§C.2 规则 3），所以这里写一份字符串联合而不是转出领域类型。
 */
export type ThreadStageName =
  | 'subscribed'
  | 'evaluating'
  | 'queued'
  | 'error'
  | 'dormant'
  | 'unsubscribed'

/** 一条 Thread 行（§M.2 的 Trigger 表）：定位、订阅数、最近触发与状态标记。 */
export interface PanelThread {
  readonly key: string
  readonly source: string
  /** 人读的定位：Source 给的 label，没有就用 url，再没有就是 key。 */
  readonly title: string
  readonly url?: string
  readonly stage: ThreadStageName
  /** 排队中的触发数（`stage === 'queued'` 时标记会带这个数）。 */
  readonly pending: number
  /** 订阅数（还在订阅这条 Thread 的工单数）。 */
  readonly subscriptions: number
  /** 最新一条 Trigger 的时刻（epoch ms）；没有触发时是这条 Thread 的创建时刻。 */
  readonly lastAt: number
  readonly createdAt: number
  /** 最近一条 Trigger 的一句话（`actor` 是人读的 `<source>:<id>`）。 */
  readonly latest?: {
    readonly actor: string
    readonly human: boolean
    readonly at: number
    readonly preview: string
  }
  /** Source 的轮询失败：行内给出原因，状态标记是 `error`。 */
  readonly pollError?: string
}

/** 一页 Thread 行；`nextOffset` 为 `null` 表示没有下一页。 */
export interface ThreadListPage {
  readonly items: readonly PanelThread[]
  readonly nextOffset: number | null
}

/** 一次 Thread 列表请求：筛选 + 分页窗口（与 CLI 的 `read threads?filter=&offset=&limit=` 同义）。 */
export interface ThreadListInput {
  /** 缺省是全部（四档之外没有「不筛」的第二套语义）。 */
  readonly filter?: ThreadFilter
  /** 从第几行开始（缺省 0）。 */
  readonly offset?: number
  /** 一页最多几行（缺省 50，§M.4）。 */
  readonly limit?: number
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
  /**
   * 接单时开的那张工单（accept 才有）。Eval 页不用它；Trigger 页的时间线据此给出「打开工单」，
   * 所以列表行也带上它。
   */
  readonly ticketId?: string
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

/** 一条被交回的触发（§M.2「handback 原因」）：哪个 Ticket 交回的、为什么。 */
export interface PanelHandback {
  readonly ticketId: string
  readonly ticketTitle: string
  readonly reason: string
  readonly at: number
}

/**
 * 时间线上的一条 Trigger（§M.2 的触发卡）：原话、来源者、去向与消费它的决定。
 * 去重的四档（排队 / 评估中 / 已投递 / 已扇出）就是「这条消息现在归谁」的四个答案。
 */
export interface PanelTriggerCard {
  readonly id: string
  readonly source: string
  /** 谁说的（`<source>:<id>`）。 */
  readonly actor: string
  readonly human: boolean
  /** 这条触发的时刻（epoch ms）。 */
  readonly at: number
  readonly url?: string
  /** 原话（读模型按面板的渲染上限截断，§M.4 的已知限制）。 */
  readonly text: string
  /** 还在等 Eval（没有执行器拥有它）。 */
  readonly queued: boolean
  /** 正在被一次 Eval 处理。 */
  readonly evaluating: boolean
  /** 执行器拥有它（人的 follow-up 由那个 worker 决定，不再回 Eval）。 */
  readonly delivered: boolean
  /** 扇出到的 Ticket id。 */
  readonly fanout: readonly string[]
  /** 被交回的记录与原因。 */
  readonly handbacks: readonly PanelHandback[]
  /** 消费它的 Decision（时间线上的决定）。 */
  readonly decision?: PanelDecision
  /** 人可以把它重新送进 Eval（「再评估一次」的可用性）。 */
  readonly canRequeue: boolean
}

/** 一条 Thread 的订阅（§M.2 的订阅块）：哪张工单、还是不是活的、是否只当语境。 */
export interface PanelThreadTicket {
  readonly id: string
  readonly title: string
  readonly state: 'open' | 'ended' | 'unknown'
  /** 只订阅作语境（§D.1 / §I.5）：这条 Thread 上的消息不路由给它。 */
  readonly context: boolean
}

/** 正在进行的一次 Eval（§M.2 的评估横幅）。 */
export interface PanelEvaluating {
  readonly id: string
  readonly strength: 'explicit' | 'inferred'
  /** 这次 Eval 持有几条触发。 */
  readonly triggers: number
  readonly startedAt: number
  readonly deadline: number
}

/** 时间线的复合游标 `(at, id)`（§D.2 要点 1）；`earlier` 就是下一页要交回的 `before`。 */
export interface PanelTimelineCursor {
  /** 触发时刻（ISO-8601 文本，与存储里的 `at` 同形）。 */
  readonly at: string
  readonly triggerId: string
}

/** 一条 Thread 的详情（§M.2）：时间线、决定、订阅与 handback 原因。 */
export interface ThreadDetailView {
  readonly key: string
  readonly source: string
  readonly title: string
  readonly url?: string
  readonly stage: ThreadStageName
  readonly createdAt: number
  readonly lastAt: number
  /** Source 的轮询失败（详情里也给原因，不只是列表的一格）。 */
  readonly pollError?: string
  /** 排队中的触发数。 */
  readonly pending: number
  readonly evaluating?: PanelEvaluating
  readonly subscriptions: readonly PanelThreadTicket[]
  /** 这条 Thread 上做过的决定（新的在前）。 */
  readonly decisions: readonly PanelDecision[]
  /** 时间线的一页（最新在前；「更早」从 `earlier` 起）。 */
  readonly timeline: readonly PanelTriggerCard[]
  readonly earlier: PanelTimelineCursor | null
}

/** 一次 Thread 详情请求：`before` 是「更早一页」的游标，`limit` 是一页几条。 */
export interface ThreadDetailInput {
  readonly threadKey: string
  /** 上一页返回的 `earlier`；不给就是从最新一页开始。 */
  readonly before?: PanelTimelineCursor
  readonly limit?: number
}

/** 「再评估一次」的对象：一条 Trigger。 */
export interface RequeueTriggerInput {
  readonly triggerId: string
}

/** 「再评估一次」的结果：`queued: false` 表示已有 Eval 持有它（此时不动它）。 */
export interface RequeueOutcome {
  readonly queued: boolean
}

/** 「取消订阅」的对象：一条 Thread。 */
export interface UnsubscribeThreadInput {
  readonly thread: string
}

/** 「取消订阅」的结果：`removed: false` 表示本来就没有订阅可丢。 */
export interface UnsubscribeOutcome {
  readonly removed: boolean
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

/**
 * 一段两面文案，或一段不需要翻译的数据文本（群 id、仓库名）：Source 页的字段与事实
 * 由 kind 声明，其中选项/标签是两面的，文本值只是数据（§M.5）。
 */
export type PanelLocalizedText = string | { readonly zh: string; readonly en: string }

/**
 * Source 实例在面板上的生命周期（§I.1）：注册表的前六档（`missing`/`off`/`starting`/
 * `paused`/`error`/`ready`）加上面板自己的 `setup`（等待部署检查）。`setup` 是展示档，
 * 不是健康状态：setup 问题只挡住这个 Source 的轮询，不写成 health error（§I.4）。
 */
export type PanelSourceState = 'ready' | 'starting' | 'paused' | 'error' | 'setup' | 'off' | 'missing'

/** `rows` 字段的一行：键列的值 + 其余列（下拉列用选项文案，文本列用原值）。 */
export interface PanelSourceRow {
  readonly key: string
  readonly cells: readonly PanelLocalizedText[]
}

/** 卡片上一个只读字段的值（§M.2「字段」）：按 kind 的字段类型给面板可渲染的形状。 */
export type PanelSourceValue =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'flag'; readonly on: boolean }
  | { readonly type: 'choice'; readonly label: PanelLocalizedText }
  | { readonly type: 'rows'; readonly rows: readonly PanelSourceRow[] }

/** 一个字段：键、两面标签与已保存的值（只读展示；编辑在 Settings 的 Sources 组）。 */
export interface PanelSourceField {
  readonly key: string
  readonly label: PanelLocalizedText
  readonly value: PanelSourceValue
}

/** setup 派生的一条只读事实（账号、仓库）：键、两面标签与值（§I.1 `facts`）。 */
export interface PanelSourceFact {
  readonly key: string
  readonly label: PanelLocalizedText
  readonly value: PanelLocalizedText
}

/** 24 h 计数（§M.2「24 h 计数」）：收到的 Trigger、被过滤的 Trigger、最近一条的时刻。 */
export interface PanelSourceStats {
  readonly received: number
  readonly filtered: number
  /** 最近一条 Trigger 的时刻（epoch ms）；窗口里没有 Trigger 时省略。 */
  readonly lastAt?: number
}

/** 一条被过滤的 Trigger（§I.1 的 `scope` 原因码 + §J.1 的 disposition 行）。 */
export interface PanelFilteredTrigger {
  readonly id: string
  readonly at: number
  /** 发送者（`<source>:<id>` 的 id 部分；CI 这类没有发送者的 Trigger 是空串）。 */
  readonly actor: string
  /** disposition 行记下的原因码（面板按 `reason.<code>` 翻译，未知码原样显示）。 */
  readonly code: string
  readonly text?: string
  /** 它所属的 Thread（一条 Trigger 的 primary Thread）。 */
  readonly threadKey?: string
}

/**
 * 一条被 drop 的 outbox 消息（§J.1）：原因、时刻，以及它所属的 Ticket 或 Thread。
 * 有 Ticket 就链接工单（更准），否则链接 Thread；两者都没有的行不给链接。
 */
export interface PanelDroppedMessage {
  readonly id: string
  /** drop 的时刻（epoch ms）。 */
  readonly at: number
  readonly reason: 'channelIgnored' | 'channelGone' | 'withdrawn'
  readonly kind: 'acknowledgement' | 'reply' | 'notice'
  readonly text?: string
  readonly ticket?: { readonly id: string; readonly title: string }
  readonly thread?: { readonly key: string; readonly title: string }
}

/** 一个 24 h 窗口的列表：前 N 条与窗口里的总数（总数大于 `items` 时面板说明只列了最近几条）。 */
interface PanelListWindow<T> {
  readonly total: number
  readonly items: readonly T[]
}

/**
 * 一张 Source 卡（§M.2 的 Source 页）：开关、字段、facts、health 条目、24 h 计数、
 * 被过滤的 Trigger、被 drop 的消息，以及这个 Source 自己的 setup 问题（内联，不遮挡别的卡）。
 */
export interface PanelSource {
  readonly id: string
  readonly title: PanelLocalizedText
  readonly description?: PanelLocalizedText
  readonly installed: boolean
  readonly enabled: boolean
  readonly state: PanelSourceState
  /** 配置校验失败的原因（§I.1：校验失败即禁用，配置回落到默认值）。 */
  readonly configError?: string
  /** 这个 Source 自己的 setup 问题（§I.4）；不归属任何 Source 的问题在 `SourcePageView.elsewhere`。 */
  readonly problem?: DeploymentSetupIssue
  readonly fields: readonly PanelSourceField[]
  readonly facts: readonly PanelSourceFact[]
  readonly health: readonly HealthDetail[]
  readonly stats: PanelSourceStats
  readonly filtered: PanelListWindow<PanelFilteredTrigger>
  readonly dropped: PanelListWindow<PanelDroppedMessage>
  /** 「立即同步」是否可用（§I.3：kind 声明了 `policy.sync` 且现在能同步）。 */
  readonly canSync: boolean
  /** 「刷新显示名」是否可用（kind 实现了 `refreshLabels`）。 */
  readonly canRefreshLabels: boolean
}

/** Source 页的一份读数（§M.2）：每个配置过的 Source 一张卡，外加不归属任何 Source 的 setup 问题。 */
export interface SourcePageView {
  readonly items: readonly PanelSource[]
  readonly elsewhere: readonly DeploymentSetupIssue[]
}

/** 一次动作的对象：一个 Source 实例。 */
export interface SourceInput {
  readonly sourceId: string
}

/** 打开/关闭一个 Source（§M.2 的主操作）：写 Source 的 `enabled`，其余配置不动。 */
export interface SourceToggleInput extends SourceInput {
  readonly enabled: boolean
}

/** 「立即同步」的结果（§I.3 的 `policy sync`）：同步后的允许名单条数。 */
export interface SourceSyncOutcome {
  readonly sourceId: string
  readonly allowed: number
}

/** 「刷新显示名」的结果（§G.2 的 `source labels`）：新增多少、一共多少。 */
export interface SourceLabelsOutcome {
  readonly sourceId: string
  readonly added: number
  readonly total: number
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

// ---------------------------------------------------------------------------
// Prompts 组（§M.3 的四个子页、§L.3 占位符、§L.4 版本/历史/default-updated、§L.6 技能）
// ---------------------------------------------------------------------------

/**
 * Prompts 组的四个子页（§M.3）：编辑、全文、历史、技能。取值是面板的语言，导航与
 * 存储的校验都读这一处（旧版本留下的值按「编辑」渲染）。
 */
export const PROMPT_TABS = ['edit', 'full', 'history', 'skills'] as const
export type PromptTab = (typeof PROMPT_TABS)[number]

/** 一个值是否是一个子页（存储里的旧值也走它）。 */
export function isPromptTab(value: unknown): value is PromptTab {
  return typeof value === 'string' && (PROMPT_TABS as readonly string[]).includes(value)
}

/** 团队可编辑三段（与 worker 的 `TEAM_SECTIONS` 同值；面板不 import worker，§C.2）。 */
export const PROMPT_TEAM_SECTIONS = ['communication', 'scope', 'delivery'] as const
export type PromptTeamSection = (typeof PROMPT_TEAM_SECTIONS)[number]

/** 一个值是否是团队段（存下来的键、`sections` 列表都用这一处判定）。 */
export function isPromptTeamSection(value: unknown): value is PromptTeamSection {
  return typeof value === 'string' && (PROMPT_TEAM_SECTIONS as readonly string[]).includes(value)
}

/**
 * Full prompt 的对比基准（§M.3：「与『已保存』或『默认』的行级对比」）：两个基准都要求，
 * 于是「用哪一份当左边」只有这一处枚举。
 */
export const PROMPT_DIFF_BASES = ['saved', 'default'] as const
export type PromptDiffBase = (typeof PROMPT_DIFF_BASES)[number]

/** 一个值是否是基准之一。 */
export function isPromptDiffBase(value: unknown): value is PromptDiffBase {
  return typeof value === 'string' && (PROMPT_DIFF_BASES as readonly string[]).includes(value)
}

/** 一条 override：团队正文 + 它编辑自的内置文本键（§L.4 的 `base`）。 */
export interface PanelPromptOverride {
  readonly text: string
  /** 编辑自的内置文本键；缺省表示「没记过」（旧版本或刚生成的 override）。 */
  readonly base?: string
}

/**
 * 一份保存下来的提示词配置（= worker 的 `PromptConfig`）：团队三段、每个分片的 override
 * 与团队技能。面板编辑的就是这个形状，保存时原样发给 worker 校验。
 */
export interface PanelPromptConfig {
  readonly team?: Readonly<Partial<Record<PromptTeamSection, string>>>
  readonly overrides?: Readonly<Record<string, PanelPromptOverride>>
  /** 团队技能：名字 → 正文（§L.6；不是分片，只以文件存在）。 */
  readonly skills?: Readonly<Record<string, string>>
}

/** 一个分片在面板上的读数：内置正文（模板）、角色、必保留占位符与它正文的键。 */
export interface PanelPromptPart {
  readonly key: string
  readonly roles: readonly string[]
  readonly kind: 'built-in' | 'team' | 'generated'
  /** `prompt` 拼进提示词；`skill` 只写成文件（§L.6，编辑页不给 override）。 */
  readonly placement: 'prompt' | 'skill'
  /** 本版本的内置正文（生成段就是模板，占位符还在）。 */
  readonly text: string
  /** 模板必须保留的占位符（§L.3；空的表示这一段没有）。 */
  readonly placeholders: readonly string[]
  /** 当前内置正文的键（§L.4：override 的 `base` 等于它就是「已按当前默认审过」）。 */
  readonly base: string
}

/** 一条 default-updated：旧默认、新默认，以及「本版本已经没有这一段」（§L.4）。 */
export interface PanelPromptChange {
  readonly part: string
  readonly base: string | null
  readonly previous: string | null
  readonly next: string | null
  readonly removed: boolean
}

/**
 * 一条被拒的原因（§L.6、§L.3 的固定码）：码 + 哪一段 + 填槽值。面板按 `code` 翻译、
 * 按 `part` 把字段标成不合法，**从不解析 message**——与设置块保存被拒的 `issues[]` 同口径。
 */
export interface PanelPromptIssue {
  /** `missing_placeholder` / `reserved_skill_name` / `invalid_skill_name` / `too_long` / … */
  readonly code: string
  /** 出问题的分片键或技能名；`too_long` 这类整份配置的问题为 `null`。 */
  readonly part: string | null
  readonly values: Readonly<Record<string, string>>
}

/** 一个不可变的提示词版本（§L.4 的版本表一行）。 */
export interface PanelPromptVersion {
  readonly revision: number
  readonly predecessor: number | null
  readonly at: string
  readonly origin: 'panel' | 'tool'
}

/** 一个技能文件（§L.6）：内置只读，团队技能可增删改；路径是稳定约定。 */
export interface PanelPromptSkill {
  readonly name: string
  readonly path: string
  readonly text: string
  readonly readOnly: boolean
}

/** 两个角色的全文（Full prompt 页按角色看一份）。 */
export interface PanelPromptTexts {
  readonly orchestrator: string
  readonly worker: string
}

/**
 * Prompts 组的读数（§M.3）：当前版本、配置、每个分片的内置正文、default-updated、历史、
 * 技能文件与两份全文（已保存与默认）。面板只画它，不在面板侧重算任何一条规则。
 */
export interface PanelPromptsView {
  readonly revision: number
  readonly saved: PanelPromptVersion | null
  readonly config: PanelPromptConfig
  readonly sections: readonly PromptTeamSection[]
  readonly parts: readonly PanelPromptPart[]
  /**
   * 内置文本自编辑以来变过的分片键（§L.4）。与 `prompts get` 的 `default_changed` 同一个读数：
   * CLI 与面板读同一份事实，只有渲染不同。
   */
  readonly defaultChanged: readonly string[]
  /** 本版本已没有、保存时会丢弃的分片键（§L.4 第四条）。 */
  readonly removedParts: readonly string[]
  readonly changes: readonly PanelPromptChange[]
  readonly history: readonly PanelPromptVersion[]
  readonly skills: readonly PanelPromptSkill[]
  /** 技能路径的根（`<stateDir>/skills/<name>/SKILL.md`，面板显示路径用）。 */
  readonly stateDir: string
  /** §L.6 的 `promptMaxChars`：这一份配置的体量上限（保存与全文共用）。 */
  readonly maxChars: number
  /** 两份全文：已保存的配置，与「全部默认」（diff 的右边）各一份。 */
  readonly texts: { readonly saved: PanelPromptTexts; readonly defaults: PanelPromptTexts }
}

/** 一次保存：配置 + 它基于的版本号（§L.4 第二条，不匹配就是 `stale_revision`）。 */
export interface PromptSaveRequest {
  readonly config: PanelPromptConfig
  readonly baseRevision: number
}

/** 恢复一个版本（`revision: 0` = 恢复默认）：再存一个新版本，不改历史（§L.4）。 */
export interface PromptRestoreRequest {
  readonly revision: number
  readonly baseRevision: number
}

/** 预览一份草稿：与保存同一份校验，只回拼好的全文（不写库）。 */
export interface PromptPreviewRequest {
  readonly config: PanelPromptConfig
}

/**
 * 预览一份草稿的结果：与保存**同一份校验**，只是不写库。合法时给拼好的全文与「保存会写下的
 * 配置」；不合法时给 `issues[]`（填槽值还在，所以面板能说清哪一段、缺什么）。
 */
export type PanelPromptPreview =
  | {
      readonly ok: true
      readonly config: PanelPromptConfig
      /** 与默认逐字相同、保存时会被丢弃的 override 键（§L.6）。 */
      readonly dropped: readonly string[]
      readonly texts: PanelPromptTexts
    }
  | { readonly ok: false; readonly issues: readonly PanelPromptIssue[] }

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
  'threads',
  'thread.detail',
  'trigger.requeue',
  'thread.unsubscribe',
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
  'restartRouter',
  'sources',
  'source.setEnabled',
  'source.sync',
  'source.labels',
  'prompts',
  'prompts.preview',
  'prompts.save',
  'prompts.restore'
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
     * Trigger 列表的一页（§M.2 的四档筛选 + §M.4 的分页）：筛选与分页都在 worker 的读模型里，
     * 面板只画回来的窗口；`nextOffset` 为 `null` 就是没有下一页。
     */
    threads: { input: ThreadListInput; output: ThreadListPage }
    /**
     * 一条 Thread 的详情（§M.2）：时间线（`(at, id)` 复合游标分页）、决定、订阅与 handback 原因。
     * `before` 是上一页返回的 `earlier`；不给就是从最新一页开始。
     */
    'thread.detail': { input: ThreadDetailInput; output: ThreadDetailView }
    /**
     * 再评估一次（§G.2 的 `trigger requeue`）：把一条触发重新排进 Eval。执行器仍拥有它、
     * 或已有 Eval 持有它时不动它，如实回 `queued: false`。
     */
    'trigger.requeue': { input: RequeueTriggerInput; output: RequeueOutcome }
    /**
     * 取消订阅一条 Thread（§G.2 的 `thread unsubscribe`，破坏性：丢弃它上面全部 Ticket 的订阅）。
     * 面板先做行内二次确认；`removed: false` 表示本来就没有订阅可丢。
     */
    'thread.unsubscribe': { input: UnsubscribeThreadInput; output: UnsubscribeOutcome }
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
    /**
     * Prompts 组的一次读数（§M.3）：当前配置与版本、每个分片的内置正文与占位符、
     * default-updated 的详情、历史、技能文件，以及「已保存 / 默认」两份全文。
     */
    prompts: { output: PanelPromptsView }
    /**
     * 预览一份草稿的全文（§M.3 的 Full prompt）：与保存同一份校验（占位符、技能名、体量
     * 上限），只是不写库——被拒时按固定码拒绝，面板据此给出可读的原因。
     */
    'prompts.preview': { input: PromptPreviewRequest; output: PanelPromptPreview }
    /**
     * 保存一份配置（§L.4）：带 `baseRevision`，不匹配是 `stale_revision`（草稿不丢）；
     * 成功后回整个读数，因此一次保存 = 一次请求。
     */
    'prompts.save': { input: PromptSaveRequest; output: PanelPromptsView }
    /**
     * 恢复某个版本或默认（§L.4：再存一个新版本，单向追加，不改历史）：回整个读数，
     * 面板因此直接回到编辑页看到恢复后的文本。
     */
    'prompts.restore': { input: PromptRestoreRequest; output: PanelPromptsView }
    /**
     * Source 页的读数（§M.2）：每个配置过的 Source 一张卡——开关、字段、facts、health、
     * 24 h 计数、被过滤的 Trigger 与被 drop 的消息。页面打开时读一次，推送后再读。
     */
    sources: { output: SourcePageView }
    /**
     * 打开/关闭一个 Source（§M.2 的主操作）：写 `source:<id>` 设置块的 `enabled` 并立即
     * 作用到本进程的 Source 视图（下一个作业周期起按新状态判定监听与回复）。
     */
    'source.setEnabled': { input: SourceToggleInput; output: SourcePageView }
    /**
     * 「立即同步」一个 Source 的允许名单（§I.3 的 `policy.sync`，与 `policy sync` 命令同一个
     * 驱动器）；不能同步时按 `invalid_params` 拒绝。
     */
    'source.sync': { input: SourceInput; output: SourceSyncOutcome }
    /**
     * 「刷新显示名」（§G.2 的 `source labels`）：重读 kind 的行键显示名（例如飞书群名），
     * 写进 `source-labels:<kind>` 并报告新增条数；kind 没有这个能力时按 `invalid_params` 拒绝。
     */
    'source.labels': { input: SourceInput; output: SourceLabelsOutcome }
  }

  interface PluginPanelEvents {
    /** worker 在状态变化后推送；`revision` 单调递增。 */
    'state.changed': { readonly revision: number }
  }
}

// 存储层的记录形状（§D.2）：与表列一一对应，布尔用 `boolean` 表示、落库为 0/1，
// 时间一律 ISO-8601 文本（`Date#toISOString()`）。领域类型由 #9 建立，这里只描述
// 落库/读库的边界形状，避免存储内核依赖领域模块。

/** 时间的唯一形态：ISO-8601 文本，文本比较即时间比较（§D.2 要点 1）。 */
export type IsoTime = string

/** Trigger 的来源者（`actor` 列是 JSON `{source,id}`）。 */
export interface Actor {
  readonly source: string
  readonly id: string
}

/** 一条不可变 Trigger（`trigger` 表）。 */
export interface TriggerRecord {
  readonly id: string
  readonly source: string
  readonly at: IsoTime
  readonly actor: Actor
  readonly human: boolean
  /** `mention` / `direct` / `null`（`addressed` 列）。 */
  readonly addressed: 'mention' | 'direct' | null
  readonly text: string
  readonly url: string | null
  /** 完整 JSON 记录（含 channel/meta/threads），原样保存。 */
  readonly body: unknown
}

/** Trigger 的去向（`disposition` 表，与 trigger 一对一）。 */
export interface DispositionRecord {
  readonly triggerId: string
  /** 被 Source 过滤时的 reason code。 */
  readonly filtered: string | null
  readonly evalId: string | null
  readonly decisionId: string | null
  readonly requeuedAt: IsoTime | null
  /** reached/handedBack/acknowledged/answered 等集合。 */
  readonly body: unknown
}

/** Trigger 与 Thread 的关联（`trigger_thread` 表）。 */
export interface TriggerThreadRecord {
  readonly threadKey: string
  readonly at: IsoTime
  readonly triggerId: string
  /** 人写的（订阅扇出与「是否人消息」要用）。 */
  readonly human: boolean
  /** 这一条承担 Eval。 */
  readonly primaryThread: boolean
}

/** 时间线上的一行（`trigger_thread` 的投影）。 */
export interface TimelineItem {
  readonly at: IsoTime
  readonly triggerId: string
  readonly human: boolean
  readonly primaryThread: boolean
}

/** Thread 时间线的 `(at, id)` 复合游标（§D.2 要点 1）。 */
export interface TimelineCursor {
  readonly at: IsoTime
  readonly triggerId: string
}

/** 一页时间线：`next` 为 `null` 表示没有下一页。 */
export interface TimelinePage {
  readonly items: readonly TimelineItem[]
  readonly next: TimelineCursor | null
}

/** Thread 的 meta：Source 自有（label/url/facts/pollError），由 Source 经端口写。 */
export type ThreadMeta = Readonly<Record<string, unknown>>

/** 一个 Thread（`thread` 表；`active`/`subscribed` 是生成列，不入参）。 */
export interface ThreadRecord {
  readonly key: string
  readonly source: string
  readonly meta: ThreadMeta
  /** subscriptions/context/queued/eval/expired/decisions。 */
  readonly body: unknown
}

/** Thread 行的读模型（含两个生成列）。 */
export interface ThreadRow extends ThreadRecord {
  readonly active: boolean
  readonly subscribed: boolean
}

/** 一个 Ticket（`ticket` 表；`open`/`active` 是生成列，不入参）。 */
export interface TicketRecord {
  readonly id: string
  readonly at: IsoTime
  /** mandate/origin/execution/follows/inputs/assignments/report/attention。 */
  readonly body: unknown
}

/** Ticket 行的读模型（含两个生成列）。 */
export interface TicketRow extends TicketRecord {
  readonly open: boolean
  readonly active: boolean
}

/** Decision 的四种结局（§D.2 `decision.kind`）。 */
export type DecisionKind = 'accept' | 'stop' | 'ignore' | 'unavailable'

/** 一条 Decision（`decision` 表）。 */
export interface DecisionRecord {
  readonly id: string
  readonly threadKey: string
  readonly at: IsoTime
  readonly kind: DecisionKind
  /** reason/strength/rules/ticketId/dismissed。 */
  readonly body: unknown
}

/** 一条持久副作用（`effect` 表，§J.2）。 */
export interface EffectRecord {
  readonly kind: string
  readonly key: string
  readonly payload: unknown
  /** 单调入队序，决定处理顺序。 */
  readonly seq: number
  readonly dueAt: IsoTime
  readonly attempts: number
  readonly lastError: string | null
}

/** 一个 kind 的队列读数（健康条目的 `waiting N, failed M` 用它，§J.3）。 */
export interface EffectKindCount {
  readonly kind: string
  /** 还在库里的行数（跑成功的行被删掉）。 */
  readonly waiting: number
  /** 已失败过（`attempts > 0`）的行数。 */
  readonly failed: number
}

/** Outbox 行的状态（§D.2 `outbox.status`）。 */
export type OutboxStatus = 'pending' | 'sent' | 'dropped'

/** 一条对外消息 receipt（`outbox` 表，§J.1）。 */
export interface OutboxRecord {
  readonly id: string
  readonly ticketId: string | null
  /** 分组键：`ticket:<id>` 或 channel 地址。 */
  readonly channel: string
  readonly status: OutboxStatus
  /** 消息本体（`OutboundMessage`：id/channel/text/kind/ticketId）。 */
  readonly body: unknown
  /** 进入终态（sent/dropped）的时刻；保留策略按它算 30 天。 */
  readonly settledAt: IsoTime | null
  readonly droppedAt: IsoTime | null
  readonly droppedReason: string | null
}

/** 一条待发 Outbox 行与它 `reply` effect 的进度（§J.1 顺序与 §J.3 失败计数用）。 */
export interface OutboxWaitingRow {
  readonly record: OutboxRecord
  /** `reply` effect 的入队序；没有 effect 行时为 `null`（不参与排序）。 */
  readonly seq: number | null
  /** `reply` effect 的连续失败次数（`Later` 不计）。 */
  readonly attempts: number
}

/** 设置版本快照（`settings_version` 表，§D.2 要点 3、§K.5）。 */
export interface SettingsVersionRecord {
  readonly revision: number
  readonly predecessor: number | null
  readonly at: IsoTime
  /** 谁改的（§K.8）：面板、CLI、名单同步，或 operator（setup 字段唯一的外来来源）。 */
  readonly origin: 'panel' | 'tool' | 'sync' | 'operator'
  readonly block: string
  readonly config: unknown
  readonly policyVersion: string | null
}

/** Prompt 版本快照（`prompt_version` 表，§L.4）。 */
export interface PromptVersionRecord {
  readonly revision: number
  readonly predecessor: number | null
  readonly at: IsoTime
  readonly origin: 'panel' | 'tool'
  readonly config: unknown
}

/** 工作集（pass 只扫活行）：名字与查询一一对应（§D.2 生成列 + 部分索引）。 */
export interface WorkingSet {
  readonly activeThreads: readonly string[]
  readonly openTickets: readonly string[]
  readonly activeTickets: readonly string[]
  readonly pendingOutbox: readonly string[]
}

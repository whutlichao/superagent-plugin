// 领域端口（§C.1 `core/ports.ts`）：领域依赖的外部世界接口。实现都在后续票里：
// - `Repositories` 由 `app/store.ts` 用 SQLite 实现（F2 #5）；本票只给 `MemoryRepositories`；
// - `Policy` / `Assessor` 由 policy 与 Router 相关票实现（#20/#24/#25/#16）；
// - `Executor` 由执行器票实现（#11/#12）；
// - `Outbox` 由 outbox 票实现（#30）；
// - `SourceContext` 由 `app/source-context.ts` 构造，Source kind 只能经它访问引擎（#10）。
//
// 纪律（§C.2 规则 1）：本目录零 I/O、零外部依赖；只有一个受控的 `unknown` 别名 `JsonValue`。
import type {
  Assignment,
  ChannelRef,
  Decision,
  DecisionKind,
  Mandate,
  MandateBasis,
  Strength,
  Thread,
  Ticket,
  TicketEndBy,
  TicketOutcome,
  Trigger,
  TriggerDisposition
} from './model.ts'
import type { Reason } from './reasons.ts'

/**
 * 受控的 JSON 别名：领域里唯一的 `unknown` 逃逸点（与 `runtime/orca-runtime.ts` 的同名别名
 * 各自定义——core 不 import runtime，§C.2 规则 1）。
 */
export type JsonValue = unknown

/** Gate 的准入结果：要么不准入并带原因码，要么准入并带强度与 Mandate 依据（§K.2）。 */
export type GateResult =
  | { admissible: false; reason: string }
  | { admissible: true; strength: Strength; basis: MandateBasis }

/**
 * Source 是否接收一条 Trigger；`observed` 表示它也接收没有点名 agent 的消息，`row` 是
 * Policy 准入表里该接收 scope 的行名（例如某个 chat）。
 */
export type ScopeResult =
  | { listened: true; observed: boolean; row?: string }
  | { listened: false; reason: string }

/** 领域看到的 Source 配置：按 trigger 判断监听范围。 */
export interface SourceScope {
  scope(trigger: Trigger): ScopeResult
}

/**
 * 版本化的规则；`gate` 决定谁能发起工作。Source 的监听范围不属于 Policy（§K.5）。
 */
export interface Policy {
  version: string
  paused: boolean
  gate(trigger: Trigger, thread: Thread, tickets: Ticket[]): GateResult
  /** 按当前 Policy 复核 Mandate 在 gate 层的依据，例如已结束的 Ticket 恢复之前（§K.3）。 */
  revalidate(mandate: Mandate): boolean
  /** 一条推断候选能否被接受：评估接受、且每条匹配规则仍启用（§K.4）。 */
  admitsInferred(rules: readonly string[]): boolean
  /** assessor 可用多久，超过就把这次 Eval 记为 unavailable（§K.7）。 */
  evalTimeoutMs: number
}

/** assessor 收到的候选：有界的事实，绝不是权限（§K.7）。 */
export interface Candidate {
  evalId: string
  thread: Thread
  triggers: Trigger[]
  strength: Strength
  policyVersion: string
  /** 该 Thread 上的每个 Ticket（含已结束的），供判重。 */
  tickets: Ticket[]
}

/** 评估的结局，也是 Decision 的来源（§K.4）。 */
export type AssessmentOutcome =
  | { kind: 'ignore'; reason: string | Reason; audit?: Record<string, unknown> }
  | { kind: 'unavailable'; reason: string | Reason; audit?: Record<string, unknown> }
  | {
      kind: 'accept'
      title: string
      scope: string
      reason: string | Reason
      acknowledgement?: string
      rules?: string[]
      audit?: Record<string, unknown>
      /** Ticket 请求的短名（§E.1 的 `worktree_name`）。 */
      name?: string
      note?: string
    }
  | { kind: 'stop'; ticketId: string; reason: string | Reason; audit?: Record<string, unknown> }

/**
 * 语义判断。`request` 按 `evalId` 幂等地排队；结局经 `Engine.decide` 回来（§K.7）。
 */
export interface Assessor {
  request(candidate: Candidate): void
  /** 每次 Eval 结束（无论是否被决定）都调用，让 assessor 丢掉为它保留的状态。 */
  release?(evalId: string): void
}

/**
 * 执行 Assignment；并发与工作区管理是它自己的事。Engine 在命令内部调用它，所以每个方法
 * 只排队，结果经 Engine 的回调回来（§E.3）。
 */
export interface Executor {
  /** 排队启动一个 pending Assignment；经 `Engine.assignmentStarted` 或 `failed` 报告回来。 */
  start(ticket: Ticket, assignment: Assignment): void
  /** 排队把 Ticket 等待中的 Input 投递给运行中的 Assignment；经 `Engine.inputsDelivered` 或 `deliveryFailed` 回来。 */
  deliver(ticket: Ticket, assignment: Assignment): void
  /** 结束一个 Assignment 的工作（例如取消它的会话轮次）；调用时领域里它已经结束。 */
  stop(ticket: Ticket, assignment: Assignment, reason: string): void
}

/** 一条发往 Channel 的消息；`ticketId` 在有时指明它属于哪个 Ticket（§J.1）。 */
export interface OutboundMessage {
  id: string
  channel: ChannelRef
  text: string
  kind: 'acknowledgement' | 'reply' | 'notice'
  ticketId?: string
}

/** 排队中的消息在等（`pending`）、已发出（`sent`），或因会话永远收不到而丢弃（`dropped`）。 */
export type ReplyStatus = 'pending' | 'sent' | 'dropped'

/** Engine 在命令内部排队的消息；发送由 sender 稍后完成（§J.1）。 */
export interface Outbox {
  /** 幂等地排队；同一个 id 之前排过就保留第一条消息。 */
  send(message: OutboundMessage): void
  /** 消息是否排过队，以及后来怎样了。 */
  status(id: string): ReplyStatus | undefined
  /** 撤回一条还没发出的消息。 */
  withdraw(id: string): void
}

/** Engine 每次变更之后报告的事件，按类型区分（§C.1 notices 消费）。 */
export interface DomainEvents {
  'trigger.received': { triggerId: string; threads: string[] }
  'eval.started': { evalId: string; threadKey: string; triggerIds: string[]; strength: Strength }
  'decision.recorded': { decisionId: string; kind: DecisionKind; threadKey: string }
  'ticket.created': { ticketId: string; decisionId: string; strength: Strength }
  'ticket.resumed': { ticketId: string; triggerId: string }
  'ticket.ended': { ticketId: string; by: TicketEndBy; outcome: TicketOutcome; reason?: string }
  'assignment.started': { ticketId: string; assignmentId: string }
  'assignment.ended': { ticketId: string; assignmentId: string; reason: string }
  'thread.subscribed': { threadKey: string; ticketId: string }
  'thread.unsubscribed': {
    threadKey: string
    ticketId: string
    by: 'person' | 'executor'
    reason?: string
  }
  'trigger.requeued': { triggerId: string }
  'trigger.followup': { triggerId: string }
  'policy.changed': { from: string; to: string }
}
/** 一条带时刻的领域事件。 */
export type DomainEvent = {
  [K in keyof DomainEvents]: { type: K; at: string; data: DomainEvents[K] }
}[keyof DomainEvents]

/**
 * 持久状态。每个方法都是同步的，`atomic` 才能包住一个工作单元（§D.4：核心状态的唯一写者
 * 是 `core/engine.ts`；写只发生在 `atomic` 之内，见 `MemoryRepositories` 的运行时守卫）。
 */
export interface Repositories {
  atomic<T>(work: () => T): T
  triggers: {
    get(id: string): Trigger | undefined
    save(trigger: Trigger): void
    /** 某个 Thread 上的 Trigger，按 `(at, id)` 排序（时间线读模型与测试夹具用）。 */
    byThread(threadKey: string): Trigger[]
    disposition(id: string): TriggerDisposition | undefined
    saveDisposition(id: string, value: TriggerDisposition): void
  }
  threads: {
    get(key: string): Thread | undefined
    save(thread: Thread): void
    list(): Thread[]
    /** 有 Trigger 排队等 Eval、或 Eval 进行中的 Thread。 */
    active(): Thread[]
  }
  tickets: {
    get(id: string): Ticket | undefined
    save(ticket: Ticket): void
    list(): Ticket[]
    open(): Ticket[]
    /** 有未投递 Input、或有 pending/running Assignment 的 Ticket（那条 Assignment 总是最后一条）。 */
    active(): Ticket[]
  }
  decisions: {
    get(id: string): Decision | undefined
    save(decision: Decision): void
    byThread(key: string): Decision[]
  }
}

/**
 * 健康条目的状态：设计 §J.3 与 §N.4 把它钉成四档 `starting | ready | paused | error`。
 * `warning` **不是**健康状态——它是面板的语气（`MarkTone`）与条目 `detail` 的措辞；健康板
 * 只回答「这个部件现在能不能干活」。每个条目一个写者，重复 claim 由 HealthBoard 拒绝。
 *
 * - `starting`：条目已 claim，写者还没报告过（注册后的初始值）；
 * - `ready`：最近一次成功；
 * - `paused`：不在跑——effect 条目在处理暂停时如此（§K.6 / §J.3），Source 条目只在它自己
 *   暂停或关闭时如此（处理暂停期间 Sources 仍照常记录 Trigger，§K.6）。
 * - `error`：达到设计写明的失败阈值（如连续 3 次失败），直到下一次成功。
 */
export const HEALTH_STATES = ['starting', 'ready', 'paused', 'error'] as const
export type HealthState = (typeof HEALTH_STATES)[number]

/** Source 报告给健康板的一条状态。 */
export interface HealthEntry {
  state: HealthState
  detail?: string
}

/** Source 的 setup 问题（§I.1 `problem`）：面板按 code 取文案，values 填槽。 */
export interface SourceProblem {
  code: string
  values?: Record<string, string>
}

/**
 * Source kind 访问引擎的唯一端口（§I.1、§C.2 规则 2）。由 `app/source-context.ts` 构造；
 * Source 拿不到 `Engine` 本体，只能经这些成员读写自己的状态并调用领域的公开命令。
 * 后续票（#10）按 kind 协议补 `config` / `problem` / `commands` 等成员。
 */
export interface SourceContext {
  /** Source 实例是否已就绪（配置有效、CLI 可用）。 */
  ready: boolean
  /** 收一条 Trigger：幂等、扇出、排队 Eval。返回 'stored' | 'duplicate' | 'filtered'。 */
  receive(trigger: Trigger): ReceiveResult
  /** 在同一个事务里做多步变更。 */
  atomic<T>(work: () => T): T
  /** Source 自己的读位置等小型键值状态（`kv` 的行）。 */
  readonly state: {
    get(key: string): JsonValue | undefined
    set(key: string, value: JsonValue): void
    delete(key: string): void
  }
  /** Thread 的人读描述与 Source 自有 meta（§D.4：Source 经这里写 Thread meta）。 */
  readonly threads: {
    describe(thread: { source: string; id: string }): { label?: string; facts?: Record<string, JsonValue> } | undefined
    patch(thread: { source: string; id: string }, meta: Record<string, JsonValue>): void
  }
  /** Source 对 Ticket 的两条命令：跟随一个 Thread，或报告一个 Thread 关闭（§I.5）。 */
  readonly tickets: {
    bindThread(ticketId: string, thread: { source: string; id: string }, own: boolean): Ticket
    threadClosed(thread: { source: string; id: string }, outcome: 'merged' | 'closed', at: string): void
  }
  /** 读一条已存的 Trigger（搜索与视图用）。 */
  readonly triggers: {
    read(id: string): Trigger | undefined
  }
  /** 给面板的一条通知（`app/notices` 实现）。 */
  notify(input: { title: string; body?: string }): void
  /** 报告自己 claim 的那一条健康（§N.4：每个条目一个写者）。 */
  report(entry: string, health: HealthEntry): void
}

/** `receive` 的结果：存下、重复（同 id 已存在），或被 Source 的监听范围过滤。 */
export type ReceiveResult = 'stored' | 'duplicate' | 'filtered'

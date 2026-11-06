// 领域 Engine：core 的唯一入口，也是调用方拿到的按角色裁剪的接口（§C.1、§D.4）。
import { UserError } from './errors.ts'
import { isoTime, liveTicket } from './model.ts'
import type { Decision, PolicyEffect, ThreadRef, Ticket, Trigger } from './model.ts'
import type { Candidate, Repositories } from './ports.ts'
import type { EngineOptions } from './part.ts'
import { Assignments, type WorkerReport } from './assignments.ts'
import { Evals, type Outcome } from './evals.ts'
import { Intake } from './intake.ts'
import type { ReceiveResult } from './ports.ts'
import { Replies, type Reply, type ReplyRequest } from './replies.ts'
import { Tickets } from './tickets.ts'

export type { EngineOptions } from './part.ts'
export type { WorkerReport } from './assignments.ts'
export type { Outcome } from './evals.ts'
export type { ReceiveResult } from './ports.ts'
export type { Reply, ReplyRequest } from './replies.ts'

/**
 * Trigger、Thread、Decision、Ticket、Assignment 变更的唯一事务入口（§D.4：这些状态的写者
 * 只有这个类）。它协调 Intake、Evals、Tickets、Assignments、Replies，在同步的仓储事务里
 * 完成一次变更，并只经端口排队副作用。调用方拿到的是按角色裁剪的 `Pick` 接口，而不是
 * 整个 Engine。
 */
export class Engine {
  private readonly options: EngineOptions
  private readonly repo: Repositories
  private readonly replies: Replies
  private readonly tickets: Tickets
  private readonly assignments: Assignments
  private readonly evals: Evals
  private readonly intake: Intake

  constructor(options: EngineOptions) {
    this.options = options
    this.repo = options.repo
    this.replies = new Replies(options)
    this.tickets = new Tickets(options, this.replies)
    this.assignments = new Assignments(options, this.tickets, this.replies)
    this.evals = new Evals(options, this.tickets)
    this.intake = new Intake(options, this.tickets)
  }

  // Sources

  /**
   * Source 请求收一条 Trigger：只存一次，扇出给订阅了它 Thread 的 Ticket（已结束的只接人的
   * 消息并立即恢复它，人停过的一个也不接），并把没有 Ticket 的 worker 决定的 Trigger 排进它
   * primary thread 的 Eval。Eval 进行中到达的 Trigger 一起等下一次。
   */
  receive(trigger: Trigger): ReceiveResult {
    return this.repo.atomic(() => this.intake.receive(trigger))
  }

  /**
   * Source 请求让一个未结束的 Ticket 跟随它的一个 Thread（例如某个 PR 的），`own` 表示该
   * Ticket 打开了它：Ticket 订阅它，且 `ready` 报告要等 `followsDone` 成立才结束 Ticket。
   * @throws UserError Ticket 未知或已结束。
   */
  bindThread(ticketId: string, thread: ThreadRef, own: boolean): Ticket {
    return this.repo.atomic(() => this.tickets.bind(ticketId, thread, own))
  }

  /**
   * Source 报告一个 Thread 关闭了（例如 PR 合并），带它发生的时刻。跟随它的未结束 Ticket
   * 在与它跟随的 Thread 都了结后结束，除非此后恢复的工作还没做完。
   */
  threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): void {
    // 把 Source 的时间规范成 ISO 形态。
    this.repo.atomic(() => {
      this.tickets.threadClosed(thread, outcome, isoTime(at))
    })
  }

  // 时钟

  /**
   * 把逾期的 Eval 重新排队最多 `REQUEUES` 次、之后记 unavailable（未送达的 Eval 永不过期）；
   * 启动有待评 Trigger 的 Thread 的 Eval；恢复暂停期间被人的消息到达的已结束 Ticket。处理
   * 暂停时什么都不过期。每次 Eval 与每个 Ticket 的更新各占一个事务。
   */
  evaluateDue(): void {
    const policy = this.options.policy()
    for (const thread of this.repo.threads.active()) {
      if (thread.evaluating) {
        this.repo.atomic(() => {
          this.evals.due(thread, policy)
        })
      }
    }
    if (policy.paused) return
    for (const ticket of this.repo.tickets.active()) {
      if (!liveTicket(ticket) && ticket.undelivered.length) {
        this.repo.atomic(() => {
          this.tickets.wake(ticket.id)
        })
      }
    }
    for (const thread of this.repo.threads.active()) {
      if (thread.pending.length && !thread.evaluating) {
        this.repo.atomic(() => {
          this.evals.start(thread.key, policy)
        })
      }
    }
  }

  // 主 Session

  /** 持有某条 Trigger 的那次 Eval 的候选；没有 Eval 持有它时 undefined。 */
  candidate(triggerId: string): Candidate | undefined {
    return this.evals.candidate(triggerId)
  }

  /**
   * 决定一条 Trigger：持有它的 Eval，或没有 Eval 持有时对它单独的直接 Eval（例如主 Session
   * 路由一条人显式请求）。推断候选只有在 auto 模式、且匹配的规则仍启用时才被接受。
   * @throws UserError 见 `Evals.decide`。
   */
  decide(triggerId: string, outcome: Outcome): Decision {
    return this.repo.atomic(() => this.evals.decide(triggerId, outcome))
  }

  /**
   * 把一条 Trigger attach 给消息指向的 Ticket：Ticket 跟随它的 Thread 并把带路由说明的它
   * 作为 Input 收到；持有它的 Eval 结束，因为它现在属于该 Ticket。已结束的 Ticket 在它的
   * Mandate 下恢复。
   * @throws UserError 见 `Tickets.attachable`。
   */
  attach(ticketId: string, triggerId: string, note?: string): Ticket {
    return this.repo.atomic(() => {
      // 本 Ticket 的 worker 交回过的消息不是它的工作。
      const handedBack = this.repo.triggers
        .disposition(triggerId)
        ?.handbacks?.some((item) => item.ticketId === ticketId)
      if (handedBack) throw new UserError('handedBackHere')
      const trigger = this.tickets.attachable(ticketId, triggerId)
      this.evals.withdraw(trigger)
      this.tickets.attach(ticketId, trigger, note)
      this.evals.routed(triggerId, ticketId)
      this.tickets.wake(ticketId)
      return this.repo.tickets.get(ticketId)!
    })
  }

  /**
   * 向以 `waiting` 状态等待的运行中 worker 要一次状态；其它 worker 不动。
   * @returns 是否问了 worker。
   * @throws UserError Ticket 未知。
   */
  requestStatus(ticketId: string): boolean {
    return this.repo.atomic(() => this.tickets.requestStatus(ticketId))
  }

  /**
   * 按用途把一条消息排进对应 Channel（§J.1）。
   * @throws UserError Ticket/Trigger 未知，或用途的规则拒绝它。
   */
  reply(request: ReplyRequest): Reply {
    return this.repo.atomic(() => this.replies.reply(request))
  }

  // 人，经面板或主 Session

  /** assessor 已把一次 Eval 的候选送达它的会话：截止时间从此刻起算。 */
  candidateDelivered(evalId: string): void {
    this.repo.atomic(() => {
      this.evals.delivered(evalId, this.options.policy())
    })
  }

  /**
   * 把一条已存的 Trigger 重新排进新 Eval，例如人重放它；有 Eval 持有它时返回 false。
   * @throws UserError Trigger 未知。
   */
  reevaluate(triggerId: string): boolean {
    return this.repo.atomic(() => this.evals.reevaluate(triggerId))
  }

  /**
   * 人 dismiss 一条 unavailable Decision 展示的问题：总览不再列出它。
   * @throws UserError Decision 未知或不是 unavailable。
   */
  dismiss(decisionId: string): Decision {
    return this.repo.atomic(() => this.evals.dismiss(decisionId))
  }

  /**
   * 丢弃一个 Thread 上所有 Ticket 的 Subscription，直到新的 Decision 再订阅一个。
   * @returns 是否丢弃了订阅。
   */
  unsubscribe(thread: string): boolean {
    return this.repo.atomic(() => this.tickets.dropSubscriptions(thread, 'person'))
  }

  /**
   * 人停止一个 Ticket，由此撤回它的 Mandate：它结束，此后什么都不再接。
   * @throws UserError Ticket 未知。
   */
  stopTicket(ticketId: string, reason?: string): Ticket {
    return this.repo.atomic(() => this.tickets.stop(ticketId, reason))
  }

  /**
   * 人重试一个 worker 报告 failed/blocked（或 Input 投递失败）的 Ticket：卡住的 Assignment
   * 结束，在同一个 Mandate 下开一个新的。
   * @throws UserError Ticket 未知、已结束或不可重试。
   */
  retryTicket(ticketId: string): Ticket {
    return this.repo.atomic(() => this.tickets.retry(ticketId))
  }

  // 执行器

  /**
   * 执行器报告一个 Assignment 运行起来了；等它的 Input 随之投递。
   * @throws UserError Ticket 未知。
   */
  assignmentStarted(ticketId: string, assignmentId: string): void {
    this.repo.atomic(() => {
      this.assignments.started(ticketId, assignmentId)
    })
  }

  /**
   * 执行器报告 Input 到达了运行该 Ticket 的 Assignment，从而清掉投递失败。已不再运行的
   * Assignment 的事实被丢弃。
   */
  inputsDelivered(ticketId: string, assignmentId: string, inputIds: string[]): void {
    this.repo.atomic(() => {
      this.assignments.delivered(ticketId, assignmentId, inputIds)
    })
  }

  /**
   * 执行器报告未结束 Ticket 的 worker 会话把承载 Input 的消息取进了某一步，从该步起它的
   * 模型读到它们。
   * @throws UserError Ticket 未知。
   */
  inputsRead(ticketId: string, inputIds: string[]): void {
    this.repo.atomic(() => {
      this.assignments.read(ticketId, inputIds)
    })
  }

  /** 执行器报告运行该 Ticket 的 worker 一轮结束了（报告之后也算）。 */
  turnEnded(ticketId: string, assignmentId: string): void {
    this.repo.atomic(() => {
      this.assignments.turnEnded(ticketId, assignmentId)
    })
  }

  /** 执行器报告把 Input 投递给运行该 Ticket 的 Assignment 失败了；Ticket 显示它直到一次投递成功。 */
  deliveryFailed(ticketId: string, assignmentId: string, error: string): void {
    this.repo.atomic(() => {
      this.assignments.deliveryFailed(ticketId, assignmentId, error)
    })
  }

  /**
   * worker 认为 attach 给它的某个 Thread 与本 Ticket 无关，请求只丢它自己的 Subscription，
   * 带 `reason`。
   * @throws UserError Ticket 未知；或那是它开始的 Thread、Source 绑定的 Thread、它没跟随的。
   */
  markUnrelated(ticketId: string, thread: string, reason: string): void {
    this.repo.atomic(() => {
      this.tickets.markUnrelated(ticketId, thread, reason)
    })
  }

  /**
   * 执行器订阅一个它发现相关的 Thread，只作语境（见 `Thread.context`）。
   * @returns Ticket 已经跟随该 Thread 时返回 false。
   * @throws UserError Ticket 未知或已结束。
   */
  followForContext(ticketId: string, thread: ThreadRef): boolean {
    return this.repo.atomic(() => this.tickets.followForContext(ticketId, thread))
  }

  /**
   * 主 Session 给未结束 Ticket 的执行器一条事实（见 `Tickets.note`）。
   * @throws UserError Ticket 未知或已结束。
   */
  note(ticketId: string, text: string): Ticket {
    return this.repo.atomic(() => this.tickets.note(ticketId, text))
  }

  /**
   * 执行器交回一条到达它 Ticket、但要求超出它的消息（见 `Evals.handback`）。
   * @throws UserError Ticket/Trigger 未知、Trigger 没到达该 Ticket，或该 Ticket 已交回过它。
   */
  handback(ticketId: string, triggerId: string, reason: string): boolean {
    return this.repo.atomic(() => this.evals.handback(ticketId, triggerId, reason))
  }

  /**
   * 在未结束 Ticket 当前的 Assignment 上记一份报告（§E.8）：它给人的问题被提出、保留或清掉，
   * 被替换且尚未发出回复的问题从 outbox 撤回。`blocked`/`failed` 压住自动 Input 直到人的
   * 消息到达。`dropped` 结束 Ticket；`ready` 在没有跟随 Thread 时以 `completed` 结束，
   * 否则等 `followsDone` 以那次关闭的结局结束。
   * @throws UserError 见 `Assignments.report`。
   */
  report(ticketId: string, report: WorkerReport): Ticket {
    return this.repo.atomic(() => this.assignments.report(ticketId, report))
  }

  /**
   * 处理一个主机停止时正在运行的 Assignment：见 `Assignments.interrupted`。
   */
  assignmentInterrupted(ticketId: string, assignmentId: string): void {
    this.repo.atomic(() => {
      this.assignments.interrupted(ticketId, assignmentId)
    })
  }

  // 设置

  /**
   * Policy 变了：`effects` 里的每个未结束 Ticket 都被告知变化如何影响它，进行中的 Eval 在
   * 新版本下重新开始（§K.5）。
   */
  policyChanged(from: string, to: string, effects: ReadonlyMap<string, PolicyEffect> = new Map()): void {
    this.repo.atomic(() => {
      this.tickets.policyChanged(from, to, effects)
      this.evals.policyChanged(from, to)
    })
  }
}

/** Source 问 Engine 与告诉 Engine 的。 */
export type EngineForSources = Pick<Engine, 'receive' | 'bindThread' | 'threadClosed'>
/** 主 Session 向 Engine 要的。 */
export type EngineForMainSession = Pick<
  Engine,
  'candidate' | 'candidateDelivered' | 'decide' | 'attach' | 'reply' | 'requestStatus' | 'note'
>
/** 人（经面板或主 Session）向 Engine 要的。 */
export type EngineForPeople = Pick<
  Engine,
  'stopTicket' | 'retryTicket' | 'reevaluate' | 'unsubscribe' | 'dismiss'
>
/** 设置告诉 Engine 的。 */
export type EngineForSettings = Pick<Engine, 'policyChanged'>
/** 执行器告诉 Engine 的，以及它的 worker 向 Engine 要的。 */
export type EngineForExecutor = Pick<
  Engine,
  | 'assignmentStarted'
  | 'inputsDelivered'
  | 'inputsRead'
  | 'turnEnded'
  | 'deliveryFailed'
  | 'assignmentInterrupted'
  | 'report'
  | 'markUnrelated'
  | 'handback'
  | 'followForContext'
  | 'reply'
>

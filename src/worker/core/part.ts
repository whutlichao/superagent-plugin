// Engine 各部分的共享基类与配置（§C.1 `core/engine.ts` 的内部部件）。
import { UserError } from './errors.ts'
import { followupOwners, reached, threadKey } from './model.ts'
import type { Thread, ThreadRef, Ticket, Trigger } from './model.ts'
import type {
  Assessor,
  AssessmentOutcome,
  DomainEvent,
  DomainEvents,
  Executor,
  Outbox,
  Policy,
  Repositories,
  SourceScope
} from './ports.ts'

/** 领域引擎的依赖：全部是端口，没有实现（§C.2：core 只 import core）。 */
export interface EngineOptions {
  repo: Repositories
  policy: () => Policy
  /** 判断 Source 是否监听一条 Trigger；不监听的就存下并记 `filtered` 去向。 */
  scope: SourceScope
  assessor: Assessor
  executor: Executor
  outbox: Outbox
  /**
   * accept 建 Ticket 时的补充：执行器在这里写入 `execution`（短名、worktree 目录、作业
   * 文本，§E.1–E.3）。抛错会连带回滚整个 accept。
   */
  prepareTicket?: (ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>) => Ticket
  /**
   * 时钟。core 自己不读环境时钟：真实时间源由组合根注入（§P.1 其四「注入的虚拟时钟」），
   * 领域因此是确定性的、可重放的。
   */
  now: () => string
  emit?: (event: DomainEvent) => void
}

/**
 * Intake、Evals、Tickets、Assignments、Replies 的基类：提供仓储、Policy、时钟与事件的
 * 共享访问。每个子类只改自己的聚合，跨聚合的变更交给兄弟部件，全部在 Engine 打开的
 * 同一个事务里完成（§D.4：每个状态只有一个写者）。
 */
export abstract class EnginePart {
  protected readonly repo: Repositories
  protected readonly options: EngineOptions

  constructor(options: EngineOptions) {
    this.options = options
    this.repo = options.repo
  }

  /** 当前时刻：只来自注入的时钟，core 不读环境时钟。 */
  protected now(): string {
    return this.options.now()
  }

  protected policy(): Policy {
    return this.options.policy()
  }

  /** 决定一条人 follow-up 的 Ticket（见 `followupOwners`）。 */
  protected owners(trigger: Trigger): string[] {
    return followupOwners(trigger, this.repo)
  }

  /** 拒绝主 Session 路由一条仍由某 Ticket 的 worker 决定的人 follow-up。 */
  protected leftToWorkers(trigger: Trigger): void {
    const owners = this.owners(trigger)
    if (owners.length) throw new UserError('workerDecides', { tickets: owners.join(', ') })
  }

  /**
   * 记录某 Ticket 的 worker 把一条到达过它的 Trigger 交回，并带上原因；如果这条本来是
   * 该 Ticket 决定的、且再没有别的 Ticket 决定它，就把它排进 Eval（§K.3）。
   * @returns 是否排进了 Eval。
   */
  protected handBack(ticketId: string, trigger: Trigger, reason: string): boolean {
    const decided = this.owners(trigger).includes(ticketId)
    const disposition = this.repo.triggers.disposition(trigger.id) ?? { fanout: [], at: this.now() }
    const handbacks = [...(disposition.handbacks ?? []), { ticketId, reason, at: this.now() }]
    this.repo.triggers.saveDisposition(trigger.id, { ...disposition, handbacks })
    return decided && !this.owners(trigger).length && this.queueForEval(trigger)
  }

  /** 记录某 Ticket 的 worker 把一条人的消息当作本 Ticket 的工作接手（确认或回答）。 */
  protected takeUp(ticketId: string, triggerId: string): void {
    const disposition = this.repo.triggers.disposition(triggerId)
    if (disposition && !disposition.acked?.includes(ticketId)) {
      this.repo.triggers.saveDisposition(triggerId, {
        ...disposition,
        acked: [...(disposition.acked ?? []), ticketId]
      })
    }
  }

  /** 把一条 Trigger 排进它 primary thread 的下一次 Eval，除非它已经在那里等或被持有。 */
  protected queueForEval(trigger: Trigger): boolean {
    const primary = this.thread(trigger.threads[0]!)
    if (primary.pending.includes(trigger.id) || primary.evaluating?.triggerIds.includes(trigger.id)) {
      return false
    }
    primary.pending.push(trigger.id)
    this.repo.threads.save(primary)
    return true
  }

  protected emit<K extends keyof DomainEvents>(type: K, data: DomainEvents[K]): void {
    this.options.emit?.({ type, at: this.now(), data } as DomainEvent)
  }

  protected require(ticketId: string): Ticket {
    const ticket = this.repo.tickets.get(ticketId)
    if (!ticket) throw new UserError('unknownTicket')
    return ticket
  }

  /** 已存的 Thread，或一个未保存的空 Thread 聚合（写回由调用方 `save`）。 */
  protected thread(ref: ThreadRef): Thread {
    const k = threadKey(ref)
    return (
      this.repo.threads.get(k) ?? {
        key: k,
        ref: { source: ref.source, id: ref.id },
        createdAt: this.now(),
        subscriptions: [],
        correlated: [],
        pending: [],
        meta: {}
      }
    )
  }

  protected ticketsOnThread(thread: Thread): Ticket[] {
    return thread.subscriptions.flatMap((id) => {
      const ticket = this.repo.tickets.get(id)
      return ticket ? [ticket] : []
    })
  }

  protected source(ticket: Ticket): Trigger | undefined {
    return this.repo.triggers.get(ticket.origin.triggerId)
  }

  protected reaches(ticket: Ticket, trigger: Trigger, context = true): boolean {
    return reached(ticket, trigger, (k) => this.repo.threads.get(k), context)
  }
}

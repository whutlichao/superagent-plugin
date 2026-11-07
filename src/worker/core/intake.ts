// Intake：接收 Trigger、Thread 关联、订阅扇出与 Eval 排队（§D.4：Trigger / Thread 关联
// 的写者在这里，经 Engine 的事务执行）。
import { key } from './ids.ts'
import { isoTime, liveTicket, threadKey } from './model.ts'
import type { Ticket, Trigger } from './model.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import type { ReceiveResult } from './ports.ts'
import type { Tickets } from './tickets.ts'

export type { ReceiveResult } from './ports.ts'

/**
 * 接收 Source 发来的 Trigger：先按 Source 的监听范围过滤，再记 Thread 关联，然后把监听
 * 得到的 Trigger 扇出给订阅了它 Thread 的 Ticket，并把「没有 Ticket 的 worker 决定」的
 * Trigger 排进它 primary thread 的 Eval。
 */
export class Intake extends EnginePart {
  private readonly tickets: Tickets

  constructor(options: EngineOptions, tickets: Tickets) {
    super(options)
    this.tickets = tickets
  }

  /**
   * 收一条 Trigger：同 id 只存一次（幂等）；被监听范围拒绝的存下并记 `filtered` 去向。
   * 扇出到订阅该 Thread 的每个 open Ticket（已结束的只接人的消息并立即恢复它；人停过的
   * 一个都不接）。没有人决定它时，排进 primary thread 的 Eval。
   */
  receive(received: Trigger): ReceiveResult {
    // 把 Source 的时间（例如 GitHub 的整秒）规范成 ISO 形态。
    const trigger = { ...received, at: isoTime(received.at) }
    if (!trigger.threads.length) throw new Error('A trigger must belong to at least one thread')
    if (this.repo.triggers.get(trigger.id)) return 'duplicate'
    const at = this.now()
    const filter = this.options.scope.scope(trigger)
    if (!filter.listened) {
      this.repo.triggers.save(trigger)
      this.repo.triggers.saveDisposition(trigger.id, {
        filtered: { code: filter.reason },
        fanout: [],
        at
      })
      return 'filtered'
    }
    this.repo.triggers.save(trigger)
    const keys = trigger.threads.map(threadKey)
    // 记下到达的 Ticket，以及它是否只经语境 Thread 到达（Ticket 自己的 Thread 会让它为 false）。
    const reached = new Map<string, { ticket: Ticket; context: boolean }>()
    for (const ref of trigger.threads) {
      const thread = this.thread(ref)
      if (!thread.lastAt || trigger.at > thread.lastAt) thread.lastAt = trigger.at
      thread.correlated = [
        ...new Set([...thread.correlated, ...keys.filter((other) => other !== thread.key)])
      ]
      for (const ticketId of thread.subscriptions) {
        const ticket = this.repo.tickets.get(ticketId)
        // 只有人的消息、且不是语境 Thread，才恢复已结束的 Ticket；bot 与 CI 不会。
        // 人停过的 Ticket 什么都不接，因为它的 Mandate 已被撤回。
        const followed = !!thread.context?.includes(ticketId)
        const resumes = trigger.human && ticket?.ended?.by !== 'human' && !followed
        if (!ticket || (!liveTicket(ticket) && !resumes)) continue
        reached.set(ticketId, { ticket, context: followed && (reached.get(ticketId)?.context ?? true) })
      }
      this.repo.threads.save(thread)
    }
    for (const [ticketId, { ticket, context: followed }] of reached) {
      this.tickets.addInput(ticket, {
        id: key('input', ticketId, 'trigger', trigger.id),
        kind: 'trigger',
        triggerId: trigger.id,
        at,
        ...(trigger.human ? { human: true } : {}),
        ...(followed ? { context: true } : {})
      })
    }
    const fanout = [...reached.keys()]
    const context = fanout.filter((id) => reached.get(id)!.context)
    const disposition = { fanout, ...(context.length ? { context } : {}), at }
    this.repo.triggers.saveDisposition(trigger.id, disposition)
    // 没有 Ticket 决定的人的消息（例如到达的只有被人停掉的、或只当语境的），以及每条
    // bot 的消息，都进 Eval。
    if (!this.owners(trigger).length) this.queueForEval(trigger)
    for (const ticketId of fanout) this.tickets.wake(ticketId)
    this.emit('trigger.received', { triggerId: trigger.id, threads: trigger.threads.map(threadKey) })
    return 'stored'
  }
}

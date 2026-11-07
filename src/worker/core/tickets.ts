// Tickets：Ticket 从 accept 到结束的生命周期、它的 Subscription 与 Input（§D.4：这些状态
// 的写者只有本部件，经 Engine 的事务执行）。
import { UserError } from './errors.ts'
import { key } from './ids.ts'
import {
  latestAssignment,
  liveTicket,
  readUntil,
  runningAssignment,
  settled,
  threadKey,
  waitsForPerson
} from './model.ts'
import type {
  Assignment,
  ChannelRef,
  Evaluation,
  Follow,
  Mandate,
  PolicyEffect,
  ThreadRef,
  Ticket,
  TicketEndBy,
  TicketInput,
  TicketOutcome,
  Trigger,
  TriggerDisposition
} from './model.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import type { AssessmentOutcome } from './ports.ts'
import type { Replies } from './replies.ts'
import { canRetry } from './stage.ts'

/** 两条 Channel 是否同一个（地址是有序对象，逐字段比较）。 */
const sameChannel = (a: ChannelRef, b: ChannelRef): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

/** 一条 Input 是不是「没有人写的」消息，例如 CI、bot 或主 Session 的 note。 */
export const automatic = (input: TicketInput | undefined): boolean =>
  input?.kind === 'note' || (input?.kind === 'trigger' && !input.human)

/**
 * worker 在 `until` 之前是否读过一条 Trigger Input（它最近的报告或轮次结束）：会话在那之前
 * 把承载它的消息取进了某一步。早于读记录投递的，只要在 `until` 前到达过 worker 就算读过。
 */
const readBefore = (input: Extract<TicketInput, { kind: 'trigger' }>, until: string): boolean =>
  input.readAt === undefined
    ? (input.deliveredAt && input.deliveredAt > input.at ? input.deliveredAt : input.at) <= until
    : !!input.readAt && input.readAt < until

/**
 * 这条 Input 会不会唤醒一个已收起的 Assignment：真的输入（人的消息、attach 的 Trigger、
 * 作业文本）会；`policy-changed` 与 `note` 只加语境，不唤醒（§K.5、§D.1 note）。
 */
const idleWaker = (input: TicketInput): boolean =>
  input.kind === 'trigger' || input.kind === 'resumed' || input.kind === 'text'

/** 人向 worker 要一次状态时投递的固定文本：只报状态，不做实现。 */
const STATUS_REQUEST =
  'Report the current ticket status with the report command. This is a status-only request: do not resume implementation or perform external actions.'

/**
 * 管理每个 Ticket 的生命周期：为 accept 建 Ticket 与 Mandate、订阅与首个 Assignment；绑定
 * 与 attach Thread；加 Input；恢复、重试、重启与结束；丢弃 Subscription。
 */
export class Tickets extends EnginePart {
  private readonly replies: Replies

  constructor(options: EngineOptions, replies: Replies) {
    super(options)
    this.replies = replies
  }

  /**
   * 建 accept 决定的 Ticket：带 `mandate`、Eval 那批 Trigger 的 Channel 与 Thread、首个
   * Assignment，以及 accept 附带的确认，并排队 launch（§E.3）。
   * origin 是给这批提供强度的可准入 Trigger（`evaluation.primary`）。
   */
  create(
    id: string,
    decisionId: string,
    mandate: Mandate,
    evaluation: Pick<Evaluation, 'triggerIds' | 'primary'>,
    outcome: Extract<AssessmentOutcome, { kind: 'accept' }>,
    at: string
  ): void {
    const { triggerIds } = evaluation
    const primary = this.repo.triggers.get(evaluation.primary ?? triggerIds.at(-1)!)
    const origin = { triggerId: primary?.id ?? triggerIds[0]!, triggerIds }
    let ticket: Ticket = {
      id,
      title: outcome.title,
      decisionId,
      mandate,
      channels: [],
      assignments: [],
      inputs: [],
      undelivered: [],
      createdAt: at,
      updatedAt: at,
      origin
    }
    for (const triggerId of triggerIds) {
      const channel = this.repo.triggers.get(triggerId)?.channel
      if (channel && !ticket.channels.some((item) => sameChannel(item, channel))) {
        ticket.channels.push(channel)
      }
    }
    // 执行器在这里写入短名、worktree 目录与作业文本；它抛错时整个 accept 回滚。
    ticket = this.options.prepareTicket?.(ticket, outcome) ?? ticket
    const assignment = this.newAssignment(ticket)
    this.repo.tickets.save(ticket)
    for (const triggerId of triggerIds) {
      for (const ref of this.repo.triggers.get(triggerId)?.threads ?? []) this.subscribe(id, ref)
    }
    if (outcome.acknowledgement && primary) {
      this.replies.acknowledgeAccepted(id, primary, outcome.acknowledgement)
    }
    this.options.executor.start(this.require(id), assignment)
    this.emit('ticket.created', { ticketId: id, decisionId, strength: mandate.strength })
  }

  /**
   * 把未结束的 Ticket 订阅到 `thread`，并记进 `ticket.follows`（`own` 表示它是该 Ticket
   * 打开的）。重新绑定一个曾关闭的 Thread 会重开它；`own` 一旦置真就不再恢复。
   * @throws UserError Ticket 未知或已结束。
   */
  bind(ticketId: string, thread: ThreadRef, own: boolean): Ticket {
    if (!liveTicket(this.require(ticketId))) throw new UserError('ticketEnded')
    this.subscribe(ticketId, thread)
    const ticket = this.require(ticketId)
    const followed = threadKey(thread)
    const follow = ticket.follows?.find((item) => item.thread === followed)
    if (follow) {
      follow.own ||= own
      delete follow.closed
    } else {
      ticket.follows = [...(ticket.follows ?? []), { thread: followed, own }]
    }
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
    return ticket
  }

  /**
   * 记下某个未结束 Ticket 跟随的 Thread 关闭了，并结束那些已经与它们的 Thread 了结的
   * Ticket（见 `followsDone`），除非工作还没做完（见 `unfinished`）。
   */
  threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): void {
    const closed = threadKey(thread)
    for (const ticket of this.repo.tickets.open()) {
      const follow = ticket.follows?.find((item) => item.thread === closed && !item.closed)
      if (!follow) continue
      follow.closed = { at, outcome }
      this.repo.tickets.save(ticket)
      const done = this.followsDone(ticket)
      if (!done || this.unfinished(ticket, at)) continue
      // 关闭之后又开始、并已完成的工作，现在结束。
      const resumed = Date.parse(latestAssignment(ticket)?.createdAt ?? '') > Date.parse(at)
      this.end(ticket.id, 'executor', done.outcome, resumed ? this.now() : done.at)
    }
  }

  /**
   * 一个跟随 Thread 的 Ticket 何时与它们了结：它打开的（`own`）Thread 全关闭，或——它
   * 一个都没打开时——它跟随的 Thread 全关闭。结局取这些 Thread 里最晚的一次关闭。
   */
  followsDone(ticket: Ticket): Follow['closed'] {
    const follows = ticket.follows ?? []
    const own = follows.filter((item) => item.own)
    const counted = own.length ? own : follows
    if (!counted.length || counted.some((item) => !item.closed)) return undefined
    return counted
      .map((item) => item.closed!)
      .sort((a, b) => a.at.localeCompare(b.at))
      .at(-1)
  }

  /**
   * 可以被 attach 给某 Ticket 的那条 Trigger（前提是该 Ticket 现在能收它）。
   * @throws UserError 未知；某 Ticket 的 worker 仍决定它；人停过该 Ticket；或已结束的
   * Ticket 的 Mandate 在当前 Policy 下复验不过（§K.3）。
   */
  attachable(ticketId: string, triggerId: string): Trigger {
    const trigger = this.repo.triggers.get(triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    // 一条到达过某 Ticket 的 follow-up 只有在决定它的 worker 交回之后才去别处。
    this.leftToWorkers(trigger)
    const current = this.require(ticketId)
    if (current.ended?.by === 'human') throw new UserError('ticketStopped')
    if (!liveTicket(current) && !this.policy().revalidate(current.mandate)) {
      throw new UserError('mandateRevoked')
    }
    return trigger
  }

  /**
   * 把 Ticket 订阅到被 attach 的 Trigger 的所有 Thread，并把该 Trigger 作为带 note 的
   * Input 加给它。worker 之后决定它，就像决定一条经自己 Thread 到达的消息。
   */
  attach(ticketId: string, trigger: Trigger, note?: string): void {
    for (const ref of trigger.threads) this.subscribe(ticketId, ref)
    const current: TriggerDisposition = this.repo.triggers.disposition(trigger.id) ?? {
      fanout: [],
      at: this.now()
    }
    const { context, requeued, ...disposition } = current
    const followed = context?.filter((id) => id !== ticketId)
    this.repo.triggers.saveDisposition(trigger.id, {
      ...disposition,
      fanout: [...new Set([...disposition.fanout, ticketId])],
      ...(followed?.length ? { context: followed } : {})
    })
    const ticket = this.require(ticketId)
    const id = key('input', ticketId, 'trigger', trigger.id)
    const existing = ticket.inputs.find((input) => input.id === id)
    const at = this.now()
    const input = (inputId: string): TicketInput => ({
      id: inputId,
      kind: 'trigger',
      triggerId: trigger.id,
      at,
      ...(note ? { note } : {}),
      ...(trigger.human ? { human: true } : {})
    })
    if (existing?.kind !== 'trigger') {
      this.addInput(ticket, input(id))
    } else if (note && ticket.undelivered.includes(id)) {
      existing.note = note
      ticket.updatedAt = at
      this.repo.tickets.save(ticket)
    } else if (
      requeued ||
      !current.fanout.includes(ticketId) ||
      context?.includes(ticketId) ||
      !liveTicket(ticket)
    ) {
      // 人把它送进过 Eval、Ticket 在 worker 接手前放掉过它、只当语境读过它、或在 worker
      // 拿过之后结束了——worker 要再拿一次。
      this.addInput(ticket, input(key('input', ticketId, 'trigger', trigger.id, 'attached', at)))
    } else if (note) {
      // worker 已经拿到这条消息，note 就再随它走一遍。
      this.addInput(ticket, input(key('input', ticketId, 'trigger', trigger.id, 'note', note)))
    }
  }

  /**
   * 向最新报告是 `waiting` 的运行中 worker 要一次状态报告；其它 Ticket 不动。
   * @returns 是否排进了一条状态请求。
   * @throws UserError Ticket 未知。
   */
  requestStatus(ticketId: string): boolean {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket) || runningAssignment(ticket)?.report?.state !== 'waiting') return false
    this.addInput(ticket, {
      id: `status:${ticketId}:${ticket.updatedAt}`,
      kind: 'text',
      text: STATUS_REQUEST,
      at: this.now()
    })
    return true
  }

  /**
   * 人停止一个 Ticket：它结束（`stopped`），Mandate 由此撤回（§E.5、§K.3）。
   * @throws UserError Ticket 未知。
   */
  stop(ticketId: string, reason?: string): Ticket {
    this.end(ticketId, 'human', 'stopped', this.now(), reason)
    return this.require(ticketId)
  }

  /**
   * 重试一个可重试的未结束 Ticket：结束它卡住的 Assignment，新建一个并排队 launch。`note`
   * 是给新 Assignment 的恢复说明（§E.5），随第一个投递交给 worker。
   * @throws UserError Ticket 未知或不可重试。
   */
  retry(ticketId: string, note?: string): Ticket {
    const ticket = this.require(ticketId)
    const latest = latestAssignment(ticket)
    if (!canRetry(ticket) || !latest) throw new UserError('notRetryable')
    this.endAssignment(ticket, latest, 'retried')
    this.requeueUntaken(ticket, latest)
    const assignment = this.newAssignment(ticket)
    if (note !== undefined) {
      const input: TicketInput = {
        id: key('input', ticket.id, 'retry', assignment.id),
        kind: 'text',
        text: note,
        at: this.now()
      }
      ticket.inputs.push(input)
      ticket.undelivered.push(input.id)
    }
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
    this.options.executor.stop(ticket, latest, 'retried')
    this.options.executor.start(ticket, assignment)
    return ticket
  }

  /**
   * 丢弃某 Ticket 对一个它认为无关的 Thread 的订阅，并把该 Ticket 决定的、那条 Thread 上的
   * 人的消息交回 Eval（带 `reason`）。
   * @throws UserError Ticket 未知；`thread` 是它开始的 Thread、Source 绑定的 `follows`
   * Thread，或它没订阅。
   */
  markUnrelated(ticketId: string, thread: string, reason: string): void {
    const ticket = this.require(ticketId)
    if (this.source(ticket)?.threads.some((ref) => threadKey(ref) === thread)) {
      throw new UserError('sourceThread')
    }
    if (ticket.follows?.some((item) => item.thread === thread)) {
      throw new UserError('followedThread')
    }
    if (!this.repo.threads.get(thread)?.subscriptions.includes(ticketId)) {
      throw new UserError('notFollowing')
    }
    this.dropSubscriptions(thread, 'executor', ticketId, reason)
    for (const trigger of this.triggersOf(ticket)) {
      if (
        trigger.threads.some((ref) => threadKey(ref) === thread) &&
        this.owners(trigger).includes(ticketId)
      ) {
        this.handBack(ticketId, trigger, reason)
      }
    }
  }

  /**
   * 按接受顺序（最旧在前）通知每个受 Policy 变更影响的未结束 Ticket，使它们的投递按接受
   * 顺序排队；不受影响的不发（§K.5 第 3–4 条）。
   */
  policyChanged(from: string, to: string, effects: ReadonlyMap<string, PolicyEffect>): void {
    const at = this.now()
    for (const ticket of this.repo.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const effect = effects.get(ticket.id)
      // 输入键里含 `at`：同样的版本之间来回变化也要各记一条新输入。
      if (effect) {
        this.addInput(ticket, {
          id: key('input', ticket.id, 'policy', from, to, at),
          kind: 'policy-changed',
          from,
          to,
          at,
          effect
        })
      }
    }
  }

  /**
   * 丢弃一个 Thread 的订阅：全部 Ticket 的，或只有 `ticketId` 的；没有丢弃时返回 false。
   * 跟随该 Thread 的 Ticket 不再跟随它，它的关闭也不再结束该 Ticket。
   */
  dropSubscriptions(
    thread: string,
    by: 'person' | 'executor',
    ticketId?: string,
    reason?: string
  ): boolean {
    const current = this.repo.threads.get(thread)
    const tickets =
      current?.subscriptions.filter((id) => ticketId === undefined || id === ticketId) ?? []
    if (!current || !tickets.length) return false
    current.subscriptions = current.subscriptions.filter((id) => !tickets.includes(id))
    this.repo.threads.save(current)
    for (const id of tickets) {
      const ticket = this.repo.tickets.get(id)
      if (!ticket?.follows?.some((item) => item.thread === thread)) continue
      const { follows: before, ...rest } = ticket
      const follows = before.filter((item) => item.thread !== thread)
      this.repo.tickets.save(follows.length ? { ...rest, follows } : rest)
    }
    for (const id of tickets) {
      this.emit('thread.unsubscribed', {
        threadKey: current.key,
        ticketId: id,
        by,
        ...(reason ? { reason } : {})
      })
    }
    return true
  }

  /**
   * 幂等地加一条 Input，并请执行器投递它；若某个 pending Assignment 曾启动失败、且此刻
   * 没在等人，就再 launch 它一次。worker 在 `waiting` 里收起的 Assignment（§E.7）被一条
   * 真的 Input 唤醒时新建一个——单是 Policy 变更或 note 不会重新 launch。
   */
  addInput(ticket: Ticket, input: TicketInput): void {
    if (ticket.inputs.some((existing) => existing.id === input.id)) return
    ticket.inputs.push(input)
    ticket.updatedAt = this.now()
    // worker 在等人时，自动 Input 先压着（§E.8 blocked/failed 行）。
    const held = liveTicket(ticket) && automatic(input) && waitsForPerson(ticket)
    if (!held) ticket.undelivered.push(input.id)
    this.repo.tickets.save(ticket)
    if (!liveTicket(ticket) || held) return
    const running = runningAssignment(ticket)
    const latest = latestAssignment(ticket)
    if (running) this.options.executor.deliver(ticket, running)
    else if (latest?.state === 'pending' && !waitsForPerson(ticket)) {
      this.options.executor.start(ticket, latest)
    } else if (latest?.state === 'ended' && idleWaker(input)) {
      const next = this.newAssignment(ticket)
      ticket.updatedAt = this.now()
      this.repo.tickets.save(ticket)
      this.options.executor.start(ticket, next)
    }
  }

  /**
   * 人的消息在某条它的 Thread 上等着时，在不变的 Mandate 下恢复一个已结束的 Ticket：
   * 没有 Eval、没有 Decision，因为没有新授权（§K.3）。当前 Policy 不再持有它的 Mandate
   * 时保持结束并不吞消息（见 `refuse`）。处理暂停期间消息等待，暂停解除后的第一轮按当时
   * 的 Policy 恢复它。每次都重新读 Ticket，所以幂等。
   */
  wake(ticketId: string): void {
    const ticket = this.repo.tickets.get(ticketId)
    if (!ticket || liveTicket(ticket) || ticket.ended?.by === 'human' || !ticket.undelivered.length) {
      return
    }
    const policy = this.policy()
    if (policy.paused) return
    if (!policy.revalidate(ticket.mandate)) {
      this.refuse(ticket)
      return
    }
    // 只有人的消息能恢复已结束的 Ticket；bot/CI 的 Trigger 和结束前就在等的 Input 一起继续等。
    const first = ticket.undelivered
      .map((id) => ticket.inputs.find((input) => input.id === id))
      .find((input) => input?.kind === 'trigger' && input.human)
    if (first?.kind !== 'trigger') return
    const at = this.now()
    delete ticket.ended
    ticket.updatedAt = at
    const assignment = this.newAssignment(ticket)
    // 恢复标记排在最前，先于等待中的消息投递。
    const resumed: TicketInput = {
      id: key('input', ticket.id, 'resumed', first.triggerId),
      kind: 'resumed',
      triggerId: first.triggerId,
      at
    }
    ticket.inputs.push(resumed)
    ticket.undelivered.unshift(resumed.id)
    this.repo.tickets.save(ticket)
    this.options.executor.start(ticket, assignment)
    this.emit('ticket.resumed', { ticketId, triggerId: first.triggerId })
  }

  /** Ticket 的 trigger Input 对应的 Trigger；给了 `ids` 时只看这些 Input。 */
  private triggersOf(ticket: Ticket, ids?: readonly string[]): Trigger[] {
    return ticket.inputs.flatMap((input) =>
      input.kind === 'trigger' && (!ids || ids.includes(input.id))
        ? (this.repo.triggers.get(input.triggerId) ?? [])
        : []
    )
  }

  /** 一个 Ticket 的 worker 是否接手了一条人的消息（确认或回答过它）。 */
  private takenUp(ticket: Ticket, trigger: Trigger): boolean {
    const acked = this.repo.triggers.disposition(trigger.id)?.acked
    return acked ? acked.includes(ticket.id) : this.options.outbox.status(key('ack', trigger.id)) !== undefined
  }

  /** 一个 Ticket 的 Input `ids` 里，它决定、但 worker 没接手的人的消息。 */
  private untaken(ticket: Ticket, ids: readonly string[]): Trigger[] {
    return this.triggersOf(ticket, ids).filter(
      (trigger) => this.owners(trigger).includes(ticket.id) && !this.takenUp(ticket, trigger)
    )
  }

  /**
   * 一个结束（或无法恢复）的 Ticket 放掉它 worker 从未收到的消息 `waiting`，以及它决定、
   * 但 worker 可能没接手的人的消息 `left`：它们不再算「到达过」，其中每一条若没有别的
   * Ticket 决定、没被接手、也没有已了结的 Decision，就回到 Eval（§K.3）。
   */
  private letGo(ticketId: string, waiting: readonly Trigger[], left: readonly Trigger[]): void {
    for (const trigger of [...waiting, ...left]) {
      const disposition = this.repo.triggers.disposition(trigger.id)
      if (disposition?.fanout.includes(ticketId)) {
        this.repo.triggers.saveDisposition(trigger.id, {
          ...disposition,
          fanout: disposition.fanout.filter((id) => id !== ticketId)
        })
      }
    }
    for (const trigger of left) {
      const disposition = this.repo.triggers.disposition(trigger.id)
      const decision = disposition?.decisionId
        ? this.repo.decisions.get(disposition.decisionId)
        : undefined
      // 在这个消息上停掉该 Ticket 的主 Session 自己决定其余部分，除非有 Ticket 交回过它。
      const stopped =
        decision?.kind === 'stop' && decision.ticketId === ticketId && !disposition?.handbacks?.length
      const decided = !!decision && (settled(decision) || stopped)
      if (!this.owners(trigger).length && !disposition?.acked?.length && !decided) {
        this.queueForEval(trigger)
      }
    }
  }

  /** 一个无法恢复的已结束 Ticket 不收任何等它的消息（见 `letGo`）。 */
  private refuse(ticket: Ticket): void {
    const waiting = this.triggersOf(ticket, ticket.undelivered)
    const left = this.untaken(ticket, ticket.undelivered)
    ticket.undelivered = []
    this.repo.tickets.save(ticket)
    this.letGo(ticket.id, waiting, left)
  }

  /** 用一个新 Assignment 替换运行中的那个，先给它一条 `note`，并排队 launch。 */
  restart(ticket: Ticket, running: Assignment, reason: string, note: string): void {
    this.endAssignment(ticket, running, reason)
    this.requeueUntaken(ticket, running)
    const assignment = this.newAssignment(ticket)
    const at = this.now()
    const input: TicketInput = { id: key('input', ticket.id, 'restart', assignment.id), kind: 'text', text: note, at }
    ticket.inputs.push(input)
    ticket.undelivered.push(input.id)
    ticket.updatedAt = at
    this.repo.tickets.save(ticket)
    this.options.executor.start(ticket, assignment)
  }

  /**
   * 把投递给 `replaced`、但没有任何一步取走的 Trigger Input 放回等待队首：一次取消可能
   * 丢掉了它们，或取走它们的那一步被切断了。
   */
  private requeueUntaken(ticket: Ticket, replaced: Assignment): void {
    const untaken = ticket.inputs.filter(
      (input) =>
        input.kind === 'trigger' &&
        input.readAt === null &&
        input.deliveredTo === replaced.id &&
        !ticket.undelivered.includes(input.id)
    )
    ticket.undelivered.unshift(...untaken.map((input) => input.id))
  }

  /**
   * 以某个结局结束 Ticket。`at` 记下真正发生的时刻（例如 PR 合并），`reason` 用文字说明
   * 为什么，默认就是结局本身。结束时放掉 worker 从未收到的消息，以及它决定、但 worker 在
   * 最近一次报告或轮次结束（含结束 Ticket 的那次报告）之前没读过、也没确认/回答/交回的
   * 人的消息（见 `readBefore`）。
   */
  end(
    ticketId: string,
    by: TicketEndBy,
    outcome: TicketOutcome,
    at = this.now(),
    reason?: string
  ): void {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) return
    const stopping = ticket.assignments.filter((assignment) => assignment.state !== 'ended')
    const why = reason && reason !== outcome ? { reason } : {}
    const until = readUntil(ticket)
    const waiting = this.triggersOf(ticket, ticket.undelivered)
    const left = this.untaken(
      ticket,
      ticket.inputs.flatMap((input) =>
        input.kind === 'trigger' && (!readBefore(input, until) || ticket.undelivered.includes(input.id))
          ? [input.id]
          : []
      )
    )
    // 一个更早的结束时刻（例如 PR 的合并）不把 Ticket 的最后变更时间往回移。
    ticket.ended = { at, by, outcome, ...why }
    ticket.undelivered = []
    ticket.updatedAt = this.now()
    delete ticket.attention
    delete ticket.delivery
    // 结束停掉的 Assignment 也随它结束，记的是结局码（§E.5 的 `ended(reason: stopped)`）；
    // 人写的说明留在 `ticket.ended.reason` 上。
    for (const assignment of stopping) {
      assignment.state = 'ended'
      assignment.endedAt = at
      assignment.endedReason = outcome
    }
    this.repo.tickets.save(ticket)
    this.letGo(ticketId, waiting, left)
    // 人停掉 Ticket 时的收尾消息，与结束在同一事务里排队（§E.5、§J.1）；已经结束的不再发。
    if (outcome === 'stopped') this.replies.stopped(this.require(ticketId))
    this.emit('ticket.ended', { ticketId, by, outcome, ...why })
    for (const assignment of stopping) this.options.executor.stop(ticket, assignment, reason ?? outcome)
  }

  /**
   * 一次关闭（`at`）时 Ticket 的工作是否还没做完：worker 接手了一条它决定的人的消息，
   * 而此后没有非 progress 报告、也没有轮次结束；或关闭之后才开始的 Assignment 还没有
   * `ready` 报告、或有 Input 在那份报告之后到达。Policy 变更不算要求工作。
   */
  private unfinished(ticket: Ticket, at: string): boolean {
    const until = readUntil(ticket, false)
    const taken = this.triggersOf(
      ticket,
      ticket.inputs.flatMap((input) =>
        input.kind === 'trigger' && !readBefore(input, until) ? [input.id] : []
      )
    ).some((trigger) => this.owners(trigger).includes(ticket.id) && this.takenUp(ticket, trigger))
    const latest = latestAssignment(ticket)
    if (taken || !(Date.parse(latest?.createdAt ?? '') > Date.parse(at))) return taken
    const report = latest?.report
    const later = ticket.inputs.some(
      (input) => input.kind !== 'policy-changed' && Date.parse(input.at) > Date.parse(report?.at ?? '')
    )
    return report?.state !== 'ready' || ticket.undelivered.length > 0 || later
  }

  /** 加一个 pending Assignment；此前那个的投递失败不再与 Ticket 有关。 */
  private newAssignment(ticket: Ticket): Assignment {
    const assignment: Assignment = {
      id: key('assignment', ticket.id, String(ticket.assignments.length)),
      state: 'pending',
      createdAt: this.now()
    }
    ticket.assignments.push(assignment)
    delete ticket.delivery
    return assignment
  }

  private endAssignment(ticket: Ticket, assignment: Assignment, reason: string): void {
    assignment.state = 'ended'
    assignment.endedAt = this.now()
    assignment.endedReason = reason
    this.emit('assignment.ended', { ticketId: ticket.id, assignmentId: assignment.id, reason })
  }

  /**
   * 以一条 note Input 把一个事实交给未结束 Ticket 的执行器，例如另一个 Ticket 的发现；
   * 它不授予任何权限。
   * @throws UserError Ticket 未知或已结束。
   */
  note(ticketId: string, text: string): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    const at = this.now()
    this.addInput(ticket, { id: key('input', ticketId, 'note', at, text), kind: 'note', text, at })
    return this.require(ticketId)
  }

  /**
   * 把一个未结束的 Ticket 订阅到执行器发现相关的 Thread，只作语境（见 `Thread.context`）。
   * @returns 已经跟随该 Thread 时返回 false。
   * @throws UserError Ticket 未知或已结束。
   */
  followForContext(ticketId: string, ref: ThreadRef): boolean {
    if (!liveTicket(this.require(ticketId))) throw new UserError('ticketEnded')
    if (this.thread(ref).subscriptions.includes(ticketId)) return false
    this.subscribe(ticketId, ref)
    const thread = this.thread(ref)
    thread.context = [...(thread.context ?? []), ticketId]
    this.repo.threads.save(thread)
    return true
  }

  /** 把一个 Ticket 订阅到某个 Thread；此后该 Thread 上的 Trigger 作为 Input 到达它。 */
  private subscribe(ticketId: string, ref: ThreadRef): void {
    const thread = this.thread(ref)
    if (!thread.subscriptions.includes(ticketId)) {
      thread.subscriptions.push(ticketId)
      this.emit('thread.subscribed', { threadKey: thread.key, ticketId })
    }
    if (thread.context?.includes(ticketId)) {
      thread.context = thread.context.filter((id) => id !== ticketId)
    }
    this.repo.threads.save(thread)
  }
}

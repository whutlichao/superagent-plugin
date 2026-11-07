// Evals：Thread 层面排队 Trigger 的评估，以及它们结束时的 Decision（§K.2、§K.7、§D.4：
// Decision 的唯一写者在这里）。
import { UserError } from './errors.ts'
import { key } from './ids.ts'
import { liveTicket, threadKey } from './model.ts'
import type {
  Decision,
  DecisionKind,
  Evaluation,
  Mandate,
  MandateBasis,
  Strength,
  Thread,
  Trigger
} from './model.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import type { AssessmentOutcome, Candidate, Policy } from './ports.ts'
import { said, type Reason } from './reasons.ts'
import type { Tickets } from './tickets.ts'

/** 对持有某 Trigger 的那次 Eval 的结局；`evalId` 说明它是为哪次 Eval 判的，后来的 Eval 会拒绝它。 */
export type Outcome = AssessmentOutcome & { evalId?: string }

/** 一次 Eval 以什么结束，作为它的 Decision 记录。 */
interface Finished {
  kind: DecisionKind
  reason: Reason[]
  audit?: Record<string, unknown>
  ticketId?: string
  mandate?: Mandate
}

/** 结局的原因：它带的码，否则是 assessor 或人写的话。 */
const reasonOf = (reason: string | Reason): Reason[] => [
  typeof reason === 'string' ? said(reason) : reason
]
const stronger = (a: Strength, b: Strength): Strength =>
  a === 'explicit' || b === 'explicit' ? 'explicit' : 'inferred'
/** 连续多少次过期会把 Trigger 重新排队，之后记为 unavailable（§K.7）。 */
const REQUEUES = 2

/**
 * Evals 跑 Thread 的评估：把 Thread 上排队的 Trigger 合成一次 Eval，从 gate 取它的强度、
 * actor 与依据，问 assessor，跨暂停保持截止时间，并记下它结束时的 Decision：accept、stop、
 * ignore 或 unavailable。
 */
export class Evals extends EnginePart {
  private readonly tickets: Tickets

  constructor(options: EngineOptions, tickets: Tickets) {
    super(options)
    this.tickets = tickets
  }

  /**
   * 让一个 Thread 的 Eval 过期（见 `expire`），除非处理已暂停：那时 Eval 记下暂停开始的
   * 时刻，恢复后截止时间往后移暂停时长。候选还没送达 assessor 会话的 Eval 不过期。
   */
  due(thread: Thread, policy: Policy): void {
    const evaluation = thread.evaluating
    if (!evaluation || (policy.paused && evaluation.pausedAt)) return
    const now = this.now()
    if (policy.paused) {
      evaluation.pausedAt = now
    } else if (evaluation.pausedAt) {
      evaluation.deadline = new Date(
        Date.parse(evaluation.deadline) + Date.parse(now) - Date.parse(evaluation.pausedAt)
      ).toISOString()
      delete evaluation.pausedAt
    } else if (evaluation.delivered && evaluation.deadline <= now) {
      this.expire(thread)
      return
    } else {
      return
    }
    this.repo.threads.save(thread)
  }

  /** 一次 Eval 的候选送达了 assessor 会话：它的截止时间从此刻起算。 */
  delivered(evalId: string, policy: Policy): void {
    const thread = this.repo.threads.active().find((item) => item.evaluating?.id === evalId)
    if (!thread?.evaluating || thread.evaluating.delivered) return
    const now = this.now()
    thread.evaluating.delivered = now
    thread.evaluating.deadline = new Date(Date.parse(now) + policy.evalTimeoutMs).toISOString()
    this.repo.threads.save(thread)
  }

  /**
   * 过期的 Eval 把它的 Trigger 重新排队给新的 Eval，连续 `REQUEUES` 次，免得忙碌的 assessor
   * 丢掉请求；之后记为 unavailable。
   */
  private expire(thread: Thread): void {
    const expired = (thread.expired ?? 0) + 1
    if (expired > REQUEUES) {
      this.finish(thread, thread.evaluating!, {
        kind: 'unavailable',
        reason: [{ code: 'timeout' }]
      })
      return
    }
    const { id, triggerIds } = thread.evaluating!
    delete thread.evaluating
    thread.expired = expired
    thread.pending = [...triggerIds, ...thread.pending.filter((item) => !triggerIds.includes(item))]
    this.repo.threads.save(thread)
    this.options.assessor.release?.(id)
  }

  /** 开始一次对 Thread 上排队 Trigger 的 Eval，由 gate 判定，并问 assessor 要结果。 */
  start(threadKeyValue: string, policy: Policy): void {
    const thread = this.repo.threads.get(threadKeyValue)!
    const at = this.now()
    // 仍由某 Ticket 的 worker 决定的人 follow-up 属于那个 Ticket：更早版本误排进队的，
    // 现在无声地离队（没有 Decision）。
    const delivered = (id: string): boolean => {
      const trigger = this.repo.triggers.get(id)
      return !!trigger && this.owners(trigger).length > 0
    }
    if (thread.pending.some(delivered)) {
      const followups = thread.pending.filter(delivered)
      thread.pending = thread.pending.filter((id) => !followups.includes(id))
      this.repo.threads.save(thread)
      for (const triggerId of followups) this.emit('trigger.followup', { triggerId })
      if (!thread.pending.length) return
    }
    // 已经开过 Ticket 的 Trigger 既不能再给新评估授权，也不能再开一张重复的。
    const accepted = this.accepted(thread.key)
    const started = thread.pending.filter((id) => accepted.has(id))
    const startedTicket = (id: string): Reason => ({
      code: 'startedTicket',
      triggerId: id,
      values: { ticket: accepted.get(id)!.ticketId! }
    })
    if (started.length) this.ignore(thread, started, started.map(startedTicket), policy, at)
    const triggers = thread.pending.flatMap((id) => {
      const trigger = this.repo.triggers.get(id)
      return trigger ? [trigger] : []
    })
    const tickets = this.ticketsOnThread(thread)
    const reasons: Reason[] = []
    let strongest: { trigger: Trigger; strength: Strength; basis: MandateBasis } | undefined
    for (const trigger of triggers) {
      const gate = policy.gate(trigger, thread, tickets)
      if (!gate.admissible) {
        // §K.2：不产生候选，但要落一条可解释的被过滤记录（原因码）。
        this.recordFiltered(trigger, gate.reason)
        reasons.push({ code: gate.reason, triggerId: trigger.id })
        continue
      }
      const later = gate.strength === strongest?.strength && trigger.at >= strongest.trigger.at
      const weaker = !strongest || stronger(strongest.strength, gate.strength) !== strongest.strength
      if (weaker || later) strongest = { trigger, strength: gate.strength, basis: gate.basis }
    }
    if (!strongest) {
      if (thread.pending.length) {
        this.ignore(
          thread,
          [...thread.pending],
          reasons.length ? reasons : [{ code: 'noAdmissible' }],
          policy,
          at
        )
      }
      this.repo.threads.save(thread)
      return
    }
    const evalId = key('eval', thread.key, policy.version, at, ...thread.pending)
    const deadline = new Date(Date.parse(at) + policy.evalTimeoutMs).toISOString()
    const {
      strength,
      trigger: { actor },
      basis
    } = strongest
    thread.evaluating = {
      id: evalId,
      threadKey: thread.key,
      triggerIds: thread.pending,
      primary: strongest.trigger.id,
      strength,
      actor,
      basis,
      policyVersion: policy.version,
      startedAt: at,
      deadline
    }
    thread.pending = []
    this.repo.threads.save(thread)
    for (const trigger of triggers) {
      this.clearFiltered(trigger.id)
      this.repo.triggers.saveDisposition(trigger.id, {
        ...(this.repo.triggers.disposition(trigger.id) ?? { fanout: [], at }),
        evalId
      })
    }
    this.emit('eval.started', {
      evalId,
      threadKey: thread.key,
      triggerIds: thread.evaluating.triggerIds,
      strength: strongest.strength
    })
    this.options.assessor.request(this.candidateOf(thread))
  }

  /**
   * 一条被 Gate 拒绝的 Trigger 落一条被过滤记录（§K.2：`ignore` 不产生候选，
   * `disposition.filtered` 记原因码），面板据此解释「为什么它没理我」。
   */
  private recordFiltered(trigger: Trigger, reason: string): void {
    const disposition = this.repo.triggers.disposition(trigger.id) ?? { fanout: [], at: this.now() }
    if (disposition.filtered?.code === reason) return
    this.repo.triggers.saveDisposition(trigger.id, { ...disposition, filtered: { code: reason } })
  }

  /** 一条 Trigger 被新的 Eval 准入：清掉早先的被过滤记录，不再说它没被理。 */
  private clearFiltered(triggerId: string): void {
    const disposition = this.repo.triggers.disposition(triggerId)
    if (disposition?.filtered === undefined) return
    const { filtered: _filtered, ...rest } = disposition
    this.repo.triggers.saveDisposition(triggerId, rest)
  }

  /** 持有 `triggerId` 的那次 Eval 的候选；没有 Eval 持有它时 undefined。 */
  candidate(triggerId: string): Candidate | undefined {
    const thread = this.holding(triggerId)
    return thread && this.candidateOf(thread)
  }

  /**
   * 决定一条 Trigger：持有它的 Eval，或——没有 Eval 持有时——对它单独做一次直接 Eval
   * （例如主 Session 路由一条人显式请求）。
   * @throws UserError Trigger 未知或不可准入；`outcome.evalId` 指的是已结束的 Eval；某
   * Ticket 的 worker 仍决定它而结局不是 stop；推断候选在 auto 模式之外或没有匹配规则时被接受。
   */
  decide(triggerId: string, outcome: Outcome): Decision {
    const trigger = this.repo.triggers.get(triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    const held = this.holding(triggerId)
    if (outcome.evalId && held?.evaluating?.id !== outcome.evalId) {
      throw new UserError('evalFinished', { eval: outcome.evalId })
    }
    // 防止一条已经开过 Ticket 的 Trigger 被重放时再开一张。
    const earlier =
      outcome.kind === 'accept' ? this.accepted(threadKey(trigger.threads[0]!)).get(triggerId) : undefined
    if (earlier) {
      const others = held?.evaluating?.triggerIds.filter((id) => id !== triggerId) ?? []
      if (held && others.length) {
        this.reassess(held, { code: 'acceptedBefore', values: { trigger: triggerId } }, [triggerId])
      } else if (held) {
        this.finish(held, held.evaluating!, {
          kind: 'ignore',
          reason: [{ code: 'startedTicket', triggerId, values: { ticket: earlier.ticketId! } }]
        })
      }
      return earlier
    }
    // 一条到达过某 Ticket 的 follow-up 由它的 worker 判：主 Session 只能停掉它上面的工作。
    if (outcome.kind !== 'stop') this.leftToWorkers(trigger)
    const thread = held ?? this.thread(trigger.threads[0]!)
    const evaluation =
      held?.evaluating ??
      this.directEval(thread, trigger, outcome.kind, outcome.kind === 'stop' ? outcome.ticketId : undefined)
    // 推断候选只有在 auto 模式下、且评估匹配的规则仍启用时才能被接受（§K.4）。
    if (
      outcome.kind === 'accept' &&
      evaluation.strength !== 'explicit' &&
      !this.policy().admitsInferred(outcome.rules ?? [])
    ) {
      throw new UserError('notExplicit')
    }
    return this.decideEval(thread, evaluation, outcome)
  }

  /**
   * 把一条已存的 Trigger 重排进它 primary thread 的新 Eval，并发出 `trigger.requeued`；
   * 有 Eval 持有它时返回 false。
   * @throws UserError Trigger 未知。
   */
  reevaluate(triggerId: string): boolean {
    if (!this.requeue(triggerId)) return false
    this.emit('trigger.requeued', { triggerId })
    return true
  }

  /** 把一条 Trigger 排进新 Eval；有 Eval 持有它时返回 false。 */
  private requeue(triggerId: string): boolean {
    const trigger = this.repo.triggers.get(triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    if (this.holding(triggerId)) return false
    this.queueForEval(trigger)
    const disposition = this.repo.triggers.disposition(triggerId) ?? { fanout: [], at: this.now() }
    this.repo.triggers.saveDisposition(triggerId, { ...disposition, requeued: true })
    return true
  }

  /**
   * 记录执行器把它超出范围的 Trigger 交回，并在该 Ticket 决定它、且再没有别的 Ticket 决定
   * 时排进新 Eval（见 `handBack`）。Ticket 保留订阅，且同一条只交回一次。
   * @returns 是否排进 Eval：另一个 Ticket 仍决定它、或它根本不是该 Ticket 决定的时候为 false。
   */
  handback(ticketId: string, triggerId: string, reason: string): boolean {
    const ticket = this.require(ticketId)
    if (!ticket.inputs.some((input) => input.kind === 'trigger' && input.triggerId === triggerId)) {
      throw new UserError('notReached')
    }
    if (
      this.repo.triggers.disposition(triggerId)?.handbacks?.some((item) => item.ticketId === ticketId)
    ) {
      throw new UserError('handedBack')
    }
    return this.handBack(ticketId, this.repo.triggers.get(triggerId)!, reason)
  }

  /**
   * 把一条 `unavailable` 的 Decision 标为已 dismiss，总览不再列出它。
   * @throws UserError Decision 未知或不是 unavailable。
   */
  dismiss(decisionId: string): Decision {
    const decision = this.repo.decisions.get(decisionId)
    if (decision?.kind !== 'unavailable') throw new UserError('unknownProblem')
    decision.dismissed = true
    this.repo.decisions.save(decision)
    return decision
  }

  /** 把一条被手工路由的 Trigger 从它 Thread 的队列里拿走。 */
  withdraw(trigger: Trigger): void {
    const thread = this.repo.threads.get(threadKey(trigger.threads[0]!))
    if (!thread?.pending.includes(trigger.id)) return
    thread.pending = thread.pending.filter((id) => id !== trigger.id)
    this.repo.threads.save(thread)
  }

  /**
   * 结束持有某条被路由给 Ticket 的 Trigger 的那次 Eval，因为 Ticket 现在有了它；若那次
   * Eval 还持有别的 Trigger，就把其余的（不含它）重新排给新 Eval。
   */
  routed(triggerId: string, ticketId: string): void {
    const held = this.holding(triggerId)
    const reason: Reason = { code: 'routed', values: { ticket: ticketId } }
    if (held?.evaluating?.triggerIds.length === 1) {
      this.finish(held, held.evaluating, { kind: 'ignore', reason: [reason] })
    } else if (held) {
      this.reassess(held, { ...reason, triggerId }, [triggerId])
    }
  }

  /** 让进行中的 Eval 在新 Policy 版本下重新开始，并说明它变了。 */
  policyChanged(from: string, to: string): void {
    for (const thread of this.repo.threads.active()) {
      if (thread.evaluating) this.reassess(thread, { code: 'policyChanged' })
    }
    this.emit('policy.changed', { from, to })
  }

  /** 以 `reason` 把 Thread 的 Eval 结束为 unavailable，并把它除 `without` 之外的 Trigger 排到队首重评。 */
  private reassess(thread: Thread, reason: Reason, without: string[] = []): Decision {
    const ids = thread.evaluating!.triggerIds.filter((id) => !without.includes(id))
    const decision = this.finish(thread, thread.evaluating!, { kind: 'unavailable', reason: [reason] })
    const current = this.repo.threads.get(thread.key)!
    current.pending = [...ids, ...current.pending.filter((id) => !ids.includes(id))]
    this.repo.threads.save(current)
    return decision
  }

  /** 持有某条 Trigger 的 Thread：一次 Eval 跑在它持有的每条 Trigger 的 primary thread 上。 */
  private holding(triggerId: string): Thread | undefined {
    const trigger = this.repo.triggers.get(triggerId)
    const thread = trigger && this.repo.threads.get(threadKey(trigger.threads[0]!))
    return thread?.evaluating?.triggerIds.includes(triggerId) ? thread : undefined
  }

  private candidateOf(thread: Thread): Candidate {
    const evaluation = thread.evaluating!
    const triggers = evaluation.triggerIds.flatMap((id) => {
      const trigger = this.repo.triggers.get(id)
      return trigger ? [trigger] : []
    })
    const { id: evalId, strength, policyVersion } = evaluation
    return { evalId, thread, triggers, strength, policyVersion, tickets: this.ticketsOnThread(thread) }
  }

  /**
   * 记录 Thread 上排队的 Trigger `ids` 不启动 Eval，原因 `reason`，并把它们移出队列。它的
   * id 与一次 Eval 的不同，因而永远不会替换同一批 Trigger 更早那次 Eval 的 Decision。
   */
  private ignore(thread: Thread, ids: string[], reason: Reason[], policy: Policy, at: string): void {
    const evaluation: Evaluation = {
      id: key('eval', thread.key, 'ignored', policy.version, at, ...ids),
      threadKey: thread.key,
      triggerIds: ids,
      strength: 'inferred',
      actor: { source: thread.ref.source, id: '' },
      basis: { via: 'followup' },
      policyVersion: policy.version,
      startedAt: at,
      deadline: at
    }
    this.record(thread, evaluation, { kind: 'ignore', reason })
    thread.pending = thread.pending.filter((id) => !ids.includes(id))
    delete thread.expired
  }

  /**
   * primary thread 是 `threadKey` 的那些 Trigger 的 accept Decision，按 Trigger 索引。一次
   * Eval 与它的 Decision 跑在 Trigger 的 primary thread 上，所以按 Thread 读 Decision 就能
   * 拿全它们。
   */
  private accepted(threadKey: string): Map<string, Decision> {
    const accepted = new Map<string, Decision>()
    for (const decision of this.repo.decisions.byThread(threadKey)) {
      if (decision.kind !== 'accept' || !decision.ticketId) continue
      for (const id of decision.triggerIds) if (!accepted.has(id)) accepted.set(id, decision)
    }
    return accepted
  }

  /**
   * 对单条 Trigger 的 gate-only Eval，用于没有排队 Eval 时的结局，例如一条到达过 Ticket 的
   * follow-up。它当场判定，与 Thread 可能进行中的 Eval 并存，并把该 Trigger 移出队列。
   */
  private directEval(
    thread: Thread,
    trigger: Trigger,
    kind: AssessmentOutcome['kind'],
    ticketId?: string
  ): Evaluation {
    const policy = this.policy()
    const gate = policy.gate(trigger, thread, this.ticketsOnThread(thread))
    if (!gate.admissible) throw new UserError('notAdmissible', { reason: gate.reason })
    const at = this.now()
    if (thread.pending.includes(trigger.id)) {
      thread.pending = thread.pending.filter((id) => id !== trigger.id)
      this.repo.threads.save(thread)
    }
    const id = key('eval', thread.key, 'direct', trigger.id, kind, ...(ticketId ? [ticketId] : []), at)
    return {
      id,
      threadKey: thread.key,
      triggerIds: [trigger.id],
      primary: trigger.id,
      strength: gate.strength,
      actor: trigger.actor,
      basis: gate.basis,
      policyVersion: policy.version,
      startedAt: at,
      deadline: at
    }
  }

  /** 把一个结局应用到一次 Eval：进行中的，或 gate-only 的。 */
  private decideEval(thread: Thread, evaluation: Evaluation, outcome: AssessmentOutcome): Decision {
    const audit = outcome.audit ? { audit: outcome.audit } : {}
    // Policy 在没有活的 policyChanged 调用时变了（例如跨升级或重启），按过期版本处理。
    if (this.policy().version !== evaluation.policyVersion) {
      if (thread.evaluating?.id === evaluation.id) {
        return this.reassess(thread, { code: 'policyChanged' })
      }
      return this.finish(thread, evaluation, {
        kind: 'unavailable',
        reason: [{ code: 'policyChanged' }],
        ...audit
      })
    }
    // 一条未经评估、从卡片上忽略的推断候选，要在原因旁边说明这一点。
    const unassessed =
      outcome.kind === 'ignore' && evaluation.strength !== 'explicit' && !outcome.audit
        ? [{ code: 'ignoredFromCard' }]
        : []
    if (outcome.kind === 'ignore' || outcome.kind === 'unavailable') {
      return this.finish(thread, evaluation, {
        kind: outcome.kind,
        reason: [...unassessed, ...reasonOf(outcome.reason)],
        ...audit
      })
    }
    if (outcome.kind === 'stop') {
      const ticket = this.repo.tickets.get(outcome.ticketId)
      if (!ticket || !liveTicket(ticket)) {
        return this.finish(thread, evaluation, {
          kind: 'ignore',
          reason: [{ code: 'stopUnknown' }],
          ...audit
        })
      }
      if (evaluation.strength !== 'explicit') {
        return this.finish(thread, evaluation, {
          kind: 'ignore',
          reason: [{ code: 'stopNotExplicit' }],
          ...audit
        })
      }
      const decision = this.finish(thread, evaluation, {
        kind: 'stop',
        reason: reasonOf(outcome.reason),
        ticketId: ticket.id,
        ...audit
      })
      this.tickets.end(
        ticket.id,
        'human',
        'stopped',
        this.now(),
        typeof outcome.reason === 'string' ? outcome.reason : undefined
      )
      return decision
    }
    return this.accept(thread, evaluation, outcome)
  }

  /** 记下一个 accept 与它给出的 Mandate，并让 Tickets 建出它的 Ticket。 */
  private accept(
    thread: Thread,
    evaluation: Evaluation,
    outcome: Extract<AssessmentOutcome, { kind: 'accept' }>
  ): Decision {
    const at = this.now()
    const basis = { ...evaluation.basis, ...(outcome.rules ? { rules: outcome.rules } : {}) }
    const { strength, policyVersion, actor } = evaluation
    const mandate: Mandate = { strength, policyVersion, basis, actor, scope: outcome.scope }
    const ticketId = key('ticket', evaluation.id)
    const audit = outcome.audit ? { audit: outcome.audit } : {}
    const decision = this.finish(thread, evaluation, {
      kind: 'accept',
      reason: reasonOf(outcome.reason),
      ...audit,
      mandate,
      ticketId
    })
    this.tickets.create(ticketId, decision.id, mandate, evaluation, outcome, at)
    return decision
  }

  /** 记下一次 Eval 的 Decision；Thread 自己的 Eval 随之结束，gate-only 的则让它继续。 */
  private finish(thread: Thread, evaluation: Evaluation, outcome: Finished): Decision {
    const decision = this.record(thread, evaluation, outcome)
    if (thread.evaluating?.id !== evaluation.id) return decision
    delete thread.evaluating
    delete thread.expired
    this.repo.threads.save(thread)
    this.options.assessor.release?.(evaluation.id)
    return decision
  }

  private record(thread: Thread, evaluation: Evaluation, outcome: Finished): Decision {
    const at = this.now()
    const decision: Decision = {
      id: key('decision', evaluation.id),
      evalId: evaluation.id,
      threadKey: thread.key,
      triggerIds: evaluation.triggerIds,
      policyVersion: evaluation.policyVersion,
      at,
      kind: outcome.kind,
      reason: outcome.reason,
      strength: evaluation.strength,
      ...(outcome.ticketId ? { ticketId: outcome.ticketId } : {}),
      ...(outcome.mandate ? { mandate: outcome.mandate } : {}),
      ...(outcome.audit ? { audit: outcome.audit } : {})
    }
    this.repo.decisions.save(decision)
    for (const id of evaluation.triggerIds) {
      const disposition = this.repo.triggers.disposition(id) ?? { fanout: [], at }
      this.repo.triggers.saveDisposition(id, {
        ...disposition,
        evalId: evaluation.id,
        decisionId: decision.id
      })
    }
    this.emit('decision.recorded', {
      decisionId: decision.id,
      kind: decision.kind,
      threadKey: thread.key
    })
    return decision
  }
}

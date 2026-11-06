// Replies：Engine 发往 Channel 的消息，每条都按允许它的那条规则（§J.1、§G.2 的
// `reply` / `ack`）。每条消息有确定性的 id，重复请求不会发第二条。
import { UserError } from './errors.ts'
import { key } from './ids.ts'
import { latestAssignment, liveTicket, ticketOutcome } from './model.ts'
import type { ChannelRef, Ticket, Trigger } from './model.ts'
import { EnginePart } from './part.ts'
import type { ReplyStatus } from './ports.ts'

/**
 * 一条发往 Channel 的消息，按用途区分：执行器对人所提请求的确认（acknowledgement）、
 * 人的问题在 worker 报告之后的回答（answer）、`ready`/`completed`/`merged`/`dropped`
 * Ticket 的结果（result），或 Ticket 当前给人的问题（attention）。
 * 省略 `ticketId` 时，用 `triggerId` 到达过的那个 Ticket。
 */
export type ReplyRequest =
  | { purpose: 'acknowledgement'; ticketId: string; triggerId: string; text: string }
  | {
      purpose: 'answer' | 'result' | 'attention'
      ticketId?: string
      triggerId?: string
      question?: string
      text: string
    }

/** 一条已排队的消息：id、是否已发出，以及是否早先的请求已经排过它。 */
export interface Reply {
  id: string
  status: ReplyStatus
  reused: boolean
}

/**
 * Replies 经 Outbox 端口写出 Engine 的消息：确认、对人的回答、Ticket 的结果、以及它给人
 * 的问题——每条只在它的规则允许时才写，且用确定性 id 防止重复发送（幂等）。
 */
export class Replies extends EnginePart {
  /** 按用途把消息排进对应的 Channel；不允许时抛 `UserError`（§G.2 的固定错误码）。 */
  reply(request: ReplyRequest): Reply {
    return request.purpose === 'acknowledgement' ? this.acknowledge(request) : this.answer(request)
  }

  /**
   * 排队 accept 附带的确认：只在那条开始 Ticket 的消息有人写、且有 Channel 时。
   * 确认的 id 由 Trigger 派生，重复 accept 不会产生第二条。
   */
  acknowledgeAccepted(ticketId: string, trigger: Trigger, text: string): void {
    if (trigger.channel && trigger.human) {
      this.options.outbox.send({
        id: key('ack', trigger.id),
        channel: trigger.channel,
        text,
        kind: 'acknowledgement',
        ticketId
      })
    }
  }

  /** 撤回 Ticket 给人的问题对应的 outbox 消息，除非它已经发出。 */
  withdrawAttention(attentionId: string): void {
    this.options.outbox.withdraw(key('attention-reply', attentionId))
  }

  private acknowledge(request: Extract<ReplyRequest, { purpose: 'acknowledgement' }>): Reply {
    const ticket = this.require(request.ticketId)
    if (!liveTicket(ticket)) throw new UserError('ackEnded')
    const trigger = this.repo.triggers.get(request.triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    // 只作语境的 Thread 是只读的，不能收回执。
    if (!this.reaches(ticket, trigger, false)) throw new UserError('notReached')
    if (!trigger.channel) throw new UserError('ackNoChannel')
    const id = key('ack', trigger.id)
    const existing = this.options.outbox.status(id)
    // 先排过队的（例如 accept 自带的自动确认）保留原样，且允许它不是人的消息。
    if (!existing && !trigger.human) throw new UserError('ackNotPerson')
    if (!existing) {
      this.options.outbox.send({
        id,
        channel: trigger.channel,
        text: request.text,
        kind: 'acknowledgement',
        ticketId: ticket.id
      })
    }
    this.takeUp(ticket.id, trigger.id)
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }

  private answer(request: Exclude<ReplyRequest, { purpose: 'acknowledgement' }>): Reply {
    const trigger = request.triggerId ? this.repo.triggers.get(request.triggerId) : undefined
    if (request.triggerId && !trigger) throw new UserError('unknownTrigger')
    const ticket = request.ticketId
      ? this.require(request.ticketId)
      : trigger
        ? this.repo.tickets.list().find((item) => this.reaches(item, trigger))
        : undefined
    if (request.purpose === 'result') {
      const outcome = ticket && ticketOutcome(ticket)
      const reported = !!ticket && liveTicket(ticket) && latestAssignment(ticket)?.report?.state === 'ready'
      const ready = outcome === 'merged' || outcome === 'completed' || outcome === 'dropped' || reported
      if (!ticket || !ready) throw new UserError('notReady')
    }
    const attention = request.purpose === 'attention' ? ticket?.attention : undefined
    // attention 回复必须与 Ticket 当前的问题原文一致。
    if (request.purpose === 'attention' && (!attention || attention.question !== request.question)) {
      throw new UserError('notAttention')
    }
    if (request.purpose === 'answer' && !trigger?.human) throw new UserError('notQuestion')
    const id = attention
      ? key('attention-reply', attention.id)
      : key('reply', trigger?.id ?? ticket?.id ?? '', request.text)
    const existing = this.options.outbox.status(id)
    const answered = !ticket || !trigger || ticket.answers?.includes(trigger.id)
    if (request.purpose === 'answer' && !answered && !existing) throw new UserError('noAnswer')
    const asker = attention?.forTriggerId ? this.repo.triggers.get(attention.forTriggerId) : undefined
    const channel =
      request.purpose === 'answer'
        ? trigger!.channel
        : (asker?.channel ?? (ticket ? this.sourceChannel(ticket) : undefined))
    if (!channel) throw new UserError('noChannel')
    this.options.outbox.send({
      id,
      channel,
      text: request.text,
      kind: 'reply',
      ...(ticket ? { ticketId: ticket.id } : {})
    })
    // 一条回答用掉了 worker 记得的那个答案。
    if (request.purpose === 'answer' && ticket && trigger && ticket.answers?.includes(trigger.id)) {
      ticket.answers = ticket.answers.filter((item) => item !== trigger.id)
      this.repo.tickets.save(ticket)
    }
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }

  /** Ticket 开始的那个会话：origin Trigger 的 Channel，否则它的第一个 Channel。 */
  private sourceChannel(ticket: Ticket): ChannelRef | undefined {
    return this.source(ticket)?.channel ?? ticket.channels[0]
  }
}

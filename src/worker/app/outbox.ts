// Outbox（§J.1）：**先存后发**的消息 receipt。领域（`core/replies.ts`）只把消息排进这里；
// 真正的发送是 `reply` effect 的事（§J.2），因此一条消息在崩溃后仍然只有一个 receipt，
// 重复的 request 顶多返回同一个 id。
//
// 顺序与幂等：
// - `send` 幂等：同一个 id 之前排过就保留**第一条**消息（后到的文本不覆盖）；
// - 每条消息一行 `outbox`，`status = pending`；`reply` effect 成功后转 `sent`，目标永远
//   收不到（`gone`）时转 `dropped`；失败留在 pending 让队列退避重试（§J.2）；
// - `withdraw` 只撤回还没发出的（§J.1）：删行并拿掉它的 effect 行，让它永远不发。
//
// 依赖纪律（§C.2）：本文件在 `app/`，只 import core 的类型与 store；Channel 的发送是注入的
// 端口（组合根接 `SourceRegistry.send`）。
import type { Outbox, OutboundMessage, ReplyStatus } from '../core/index.ts'
import type { EffectKind, EffectPayloads } from './effects.ts'
import { Later } from './effects.ts'
import type { OutboxRecord } from './records.ts'
import type { Store } from './store.ts'

/** 一条消息所属的分组键：Ticket 优先，否则 channel 地址（§J.1 的顺序分组）。 */
export function outboxChannel(message: OutboundMessage): string {
  if (message.ticketId !== undefined) return `ticket:${message.ticketId}`
  return `${message.channel.source}:${message.channel.thread}`
}

/** 消息排队的载体：一行 outbox 的 `body` 就是这条消息本身。 */
export interface OutboxEntry {
  readonly record: OutboxRecord
  readonly message: OutboundMessage
}

/** Outbox 的写面（比 `Outbox` 端口多出 effect handler 需要的两个转移）。 */
export interface SqlOutboxPort extends Outbox {
  /** 一条 receipt（含消息本体）；没有时 undefined。 */
  entry(id: string): OutboxEntry | undefined
  /** 消息已发出。 */
  sent(id: string, at: string): void
  /** 消息永远送不到（锁定、已删、无权限）：记录原因并停止重试。 */
  dropped(id: string, at: string, reason: string): void
  /** 当前仍待发的消息数（健康与测试用）。 */
  pending(): number
}

/** 构造依赖：真库、效果队列（只入队）与时钟。 */
export interface SqlOutboxOptions {
  readonly store: Store
  readonly effects: {
    enqueue<K extends EffectKind>(kind: K, key: string, payload: EffectPayloads[K]): void
  }
  readonly now: () => string
}

/**
 * 在真库上实现 Outbox。`send`/`withdraw` 在调用方（引擎）的事务里执行；effect 行由
 * `enqueue` 在同一个事务里写入，因此「消息排过队」与「它会被发送」一起提交或一起回滚。
 */
export function createOutbox(options: SqlOutboxOptions): SqlOutboxPort {
  const store = options.store

  const read = (id: string): OutboxEntry | undefined => {
    const record = store.outbox.get(id)
    if (record === null) return undefined
    const body = record.body
    if (typeof body !== 'object' || body === null) return undefined
    return { record, message: body as OutboundMessage }
  }

  return {
    send(message: OutboundMessage): void {
      if (store.outbox.get(message.id) !== null) return
      store.outbox.put({
        id: message.id,
        ticketId: message.ticketId ?? null,
        channel: outboxChannel(message),
        status: 'pending',
        body: message,
        settledAt: null,
        droppedAt: null,
        droppedReason: null
      })
      options.effects.enqueue('reply', message.id, { messageId: message.id })
    },
    status(id: string): ReplyStatus | undefined {
      return store.outbox.get(id)?.status
    },
    withdraw(id: string): void {
      const record = store.outbox.get(id)
      if (record === null || record.status !== 'pending') return
      store.sql.run('DELETE FROM outbox WHERE id = ? AND status = ?', [id, 'pending'])
      const effect = store.effects.get('reply', id)
      if (effect !== null) {
        store.effects.remove('reply', id, effect.seq, effect.attempts)
      }
    },
    entry(id: string): OutboxEntry | undefined {
      return read(id)
    },
    sent(id: string, at: string): void {
      const record = store.outbox.get(id)
      if (record === null || record.status !== 'pending') return
      store.outbox.put({ ...record, status: 'sent', settledAt: at })
    },
    dropped(id: string, at: string, reason: string): void {
      const record = store.outbox.get(id)
      if (record === null || record.status !== 'pending') return
      store.outbox.put({
        ...record,
        status: 'dropped',
        settledAt: at,
        droppedAt: at,
        droppedReason: reason
      })
    },
    pending(): number {
      return store.sql.all("SELECT id FROM outbox WHERE status = 'pending'").length
    }
  }
}

/** Channel 的发送端口：kind 不在时 `waiting`（消息等它回来），目标永远收不到时 `gone`。 */
export interface OutboxChannelPort {
  send(message: OutboundMessage): Promise<'sent' | 'gone' | 'waiting'>
}

/** `reply` effect 的接线：队列 + outbox + 注入的 Channel 端口。 */
export interface ReplyEffectsOptions {
  readonly effects: {
    handle<K extends EffectKind>(
      kind: K,
      run: (payload: EffectPayloads[K], key: string) => void | Promise<void>
    ): void
  }
  readonly outbox: SqlOutboxPort
  readonly channel: OutboxChannelPort
  readonly now: () => string
  readonly log?: (message: string) => void
}

/**
 * 注册 `reply` handler（§J.2 的 kind 表：串行 1 条、不全局保序、暂停时不动）。
 * handler 只认 pending 的行：撤回过的、已发过的都不再发；`waiting` 抛 `Later` 等下一轮，
 * 其余失败原样抛出，让队列按 5 s→300 s 退避重试。
 */
export function registerReplyEffects(options: ReplyEffectsOptions): void {
  options.effects.handle('reply', async (payload) => {
    const entry = options.outbox.entry(payload.messageId)
    if (entry === undefined || entry.record.status !== 'pending') return
    const result = await options.channel.send(entry.message)
    const at = options.now()
    if (result === 'gone') {
      options.outbox.dropped(entry.record.id, at, 'the channel is gone')
      options.log?.(`message ${entry.record.id} was dropped: the channel is gone`)
      return
    }
    if (result === 'waiting') {
      throw new Later('the channel is not ready yet')
    }
    options.outbox.sent(entry.record.id, at)
    options.log?.(`message ${entry.record.id} was sent`)
  })
}

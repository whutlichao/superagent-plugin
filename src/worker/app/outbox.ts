// Outbox（§J.1）：**先存后发**的消息 receipt。领域（`core/replies.ts`）只把消息排进这里；
// 真正的发送是 `reply` effect 的事（§J.2），因此一条消息在崩溃后仍然只有一个 receipt，
// 重复的 request 顶多返回同一个 id。
//
// 顺序与幂等：
// - `send` 幂等：同一个 id 之前排过就保留**第一条**消息（后到的文本不覆盖）；
// - 每条消息一行 `outbox`，`status = pending`；`reply` effect 成功后转 `sent`，目标永远
//   收不到时转 `dropped`（只有两种原因，§J.1），失败留在 pending 让队列退避重试（§J.2）；
// - 顺序按 `(ticket_id, channel)` 分组：同组里后一条要等前一条发出、或前一条连续失败三次；
//   不同 Ticket 之间、无 Ticket 的消息互不等待；
// - `withdraw` / `withdrawTicket` 把尚未发出的消息 settle 成 `dropped(withdrawn)`（保留时间、
//   原因与 Ticket），并拿掉它的 effect 行：它们永不重发（§J.1 撤回行）。
//
// 依赖纪律（§C.2）：本文件在 `app/`，只 import core 的类型与 store；Channel 的发送是注入的
// 端口（组合根接 `SourceRegistry.send`）。
import type { Outbox, OutboundMessage, ReplyStatus } from '../core/index.ts'
import { FAILURES_BEFORE_ERROR } from '../infra/health.ts'
import type { EffectKind, EffectPayloads } from './effects.ts'
import { Later } from './effects.ts'
import type { OutboxRecord } from './records.ts'
import type { Store } from './store.ts'

/** 一条消息所属的分组键：Ticket + Channel 地址（§J.1 的顺序分组）。 */
export function outboxChannel(message: OutboundMessage): string {
  const address = `${message.channel.source}:${message.channel.thread}`
  // 无 Ticket 的消息自成一组（组键就是地址），因此永远不会等别的 Ticket。
  return message.ticketId === undefined ? address : `ticket:${message.ticketId}|${address}`
}

/**
 * 设计只允许两种 drop 原因（§J.1）：Source 不再监听该会话（`channelIgnored`），或 Source
 * 明确回答「永远收不到」（`channelGone`，例如 GitHub 已删/锁定、Feishu 撤回/找不到）。
 * 其余失败一律重试，绝不 drop。
 */
export const DROP_REASONS = ['channelIgnored', 'channelGone'] as const
export type DropReason = (typeof DROP_REASONS)[number]

/** 落库的 drop 原因：两种「送不到」，加上撤回（§J.1 撤回行：`dropped(reason: withdrawn)`）。 */
export type OutboxDropReason = DropReason | 'withdrawn'

/** 消息排队的载体：一行 outbox 的 `body` 就是这条消息本身。 */
export interface OutboxEntry {
  readonly record: OutboxRecord
  readonly message: OutboundMessage
}

/** Outbox 的写面（比 `Outbox` 端口多出 effect handler 需要的两个转移）。 */
export interface SqlOutboxPort extends Outbox {
  /** 一条 receipt（含消息本体）；没有时 undefined。 */
  entry(id: string): OutboxEntry | undefined
  /** 消息已发出（终态，不再改变）。 */
  sent(id: string, at: string): void
  /** 消息永远送不到：记录原因与时刻，停止重试（§J.1 的两种 drop 原因）。 */
  dropped(id: string, at: string, reason: OutboxDropReason): void
  /** 当前仍待发的消息数（健康与测试用）。 */
  pending(): number
  /**
   * 同组里是否还有更早的待发消息：它还没发出、也还没连续失败 `failures` 次（§J.1 顺序）。
   * 有就等一下（`Later`），否则可以发。
   */
  behind(id: string, failures: number): boolean
  /** 某个时刻之后被 drop 的消息，最新在前（面板 Source 页的 24 h 窗口，§J.1）。 */
  droppedSince(at: string): readonly OutboxEntry[]
  /** 连续失败达到 `minAttempts` 的待发消息，最老在前（§J.3 system problems）。 */
  failing(minAttempts: number): readonly OutboxEntry[]
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

  /** 撤回一条还没发出的消息：settle 成 `dropped(withdrawn)`，并拿掉它的 effect 行（永不再入队）。 */
  const cancel = (id: string): void => {
    const record = store.outbox.get(id)
    if (record === null || record.status !== 'pending') return
    const at = options.now()
    store.outbox.put({
      ...record,
      status: 'dropped',
      settledAt: at,
      droppedAt: at,
      droppedReason: 'withdrawn'
    })
    const effect = store.effects.get('reply', id)
    if (effect !== null) store.effects.remove('reply', id, effect.seq, effect.attempts)
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
      cancel(id)
    },
    withdrawTicket(ticketId: string, keep: readonly string[] = []): void {
      // 尚未发出的非收尾消息：settle 成 withdrawn 而不是删行，保留时间与原因（§J.1）。
      for (const record of store.outbox.pendingOfTicket(ticketId)) {
        if (!keep.includes(record.id)) cancel(record.id)
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
    dropped(id: string, at: string, reason: OutboxDropReason): void {
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
    },
    droppedSince(at: string): readonly OutboxEntry[] {
      return store.outbox.droppedSince(at).flatMap((record) => entriesOf(record))
    },
    failing(minAttempts: number): readonly OutboxEntry[] {
      return store.outbox.failing(minAttempts).flatMap((row) => entriesOf(row.record))
    },
    behind(id: string, failures: number): boolean {
      const record = store.outbox.get(id)
      if (record === null || record.status !== 'pending') return false
      const waiting = store.outbox.waiting(record.channel)
      const first = waiting.find((row) => row.record.id === id)
      // 自己还没有 `seq`（或没有 effect 行）就没有可比较的先后：不挡。
      if (first === undefined || first.seq === null) return false
      const selfSeq = first.seq
      return waiting.some(
        (row) =>
          row.record.id !== id &&
          row.seq !== null &&
          row.seq < selfSeq &&
          row.attempts < failures
      )
    }
  }
}

/** 一条 receipt（`body` 不是对象时无法当作消息：跳过它而不是抛错）。 */
function entriesOf(record: OutboxRecord): readonly OutboxEntry[] {
  const body = record.body
  if (typeof body !== 'object' || body === null) return []
  return [{ record, message: body as OutboundMessage }]
}

/** Channel 的发送端口：kind 不在时 `waiting`（消息等它回来），目标永远收不到时 `gone`。 */
export interface OutboxChannelPort {
  /** Source 实例是否还开着（§J.1 暂停行）：关了就是「现在发不了」，消息等待而不是 drop。 */
  enabled?(source: string): boolean
  /** 这个地址还应不应该收到回复（Source 的 `channel.allowed`）：假 = 不再监听（§J.1 drop 原因 a）。 */
  allowed?(message: OutboundMessage): boolean
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
    // 关闭（或未安装）的 Source：现在发不了，消息**等待**而不是 drop（§J.1 暂停行）。
    if (options.channel.enabled !== undefined && !options.channel.enabled(entry.message.channel.source)) {
      throw new Later('the Source is off or not installed')
    }
    // 顺序：同组里更早的消息没发出去、也还没连续失败三次时，这一条等下一轮（§J.1）。
    // `Later` 不计失败，因此等待不会把消息推向 drop。
    if (options.outbox.behind(entry.record.id, FAILURES_BEFORE_ERROR)) {
      throw new Later('an earlier message of this ticket to this conversation waits')
    }
    const at = options.now()
    // drop 原因 a)：Source 不再监听这个会话（配置里移除了它，或 `channel.allowed` 为假）。
    if (options.channel.allowed !== undefined && !options.channel.allowed(entry.message)) {
      options.outbox.dropped(entry.record.id, at, 'channelIgnored')
      options.log?.(`message ${entry.record.id} was dropped: the Source no longer listens`)
      return
    }
    const result = await options.channel.send(entry.message)
    // drop 原因 b)：Source 明确回答「永远收不到」（§J.1）；`waiting` 则是「现在不行」，等待。
    if (result === 'gone') {
      options.outbox.dropped(entry.record.id, at, 'channelGone')
      options.log?.(`message ${entry.record.id} was dropped: the channel is gone`)
      return
    }
    if (result === 'waiting') {
      throw new Later('the channel is not ready yet')
    }
    // `channel.send` 返回 `sent` 即视为已发出；不做事后确认（§J.1 送达确认行）。
    options.outbox.sent(entry.record.id, at)
    options.log?.(`message ${entry.record.id} was sent`)
  })
}

// Outbox（§J.1）：先存后发、按消息 id 幂等、可撤回、发送成功/永久失败各转一个终态。
// 真库 + 真效果队列 + 注入的 Channel 端口，绝不 sleep（§P.1）。
import { assert, test } from 'orca/testing'
import type { OutboundMessage } from '../src/worker/core/index.ts'
import { createOutbox, registerReplyEffects, outboxChannel } from '../src/worker/app/outbox'
import { openQueue } from './support/queue'

/** 一条发往 GitHub Issue 的回复。 */
function message(
  id = 'reply-1',
  overrides: Partial<OutboundMessage> = {}
): OutboundMessage {
  return {
    id,
    channel: {
      source: 'github',
      thread: 'github:42',
      address: { repo: 'acme/widgets', issue: '42' }
    },
    text: 'Done: the login redirect is fixed.',
    kind: 'reply',
    ticketId: 'ticket-1',
    ...overrides
  }
}

/** `reply` effect 的入队进度（顺序、失败次数与下一个到期时刻）。 */
function replyEffect(h: ReturnType<typeof harness>, id = 'reply-1') {
  return h.store.effects.get('reply', id)
}

/** 装上 outbox 与 reply handler；`send` 记录每次真正尝试的消息。 */
function harness(
  options: {
    readonly send?: (message: OutboundMessage) => 'sent' | 'gone' | 'waiting'
    readonly enabled?: (source: string) => boolean
    readonly allowed?: (message: OutboundMessage) => boolean
  } = {}
) {
  const queue = openQueue()
  const outbox = createOutbox({
    store: queue.store,
    effects: queue.effects,
    now: () => queue.clock.iso()
  })
  /** 交给 Channel 的消息（每次尝试，含 failed / gone）。 */
  const calls: OutboundMessage[] = []
  /** Channel 回答 `sent` 的消息。 */
  const sent: OutboundMessage[] = []
  registerReplyEffects({
    effects: queue.effects,
    outbox,
    channel: {
      enabled: options.enabled ?? (() => true),
      allowed: options.allowed ?? (() => true),
      send: async (item) => {
        calls.push(item)
        const result = (options.send ?? (() => 'sent'))(item)
        if (result === 'sent') sent.push(item)
        return result
      }
    },
    now: () => queue.clock.iso()
  })
  return { ...queue, outbox, calls, sent }
}

/** 把虚拟时钟推到下一行到期并跑一轮（等价于「等下一次 pass」）。 */
async function pass(h: ReturnType<typeof harness>): Promise<void> {
  // 取一小时内的全部行，再把时钟推到最近的下一个到期时刻（退避中的行不靠 sleep 等）。
  const rows = h.store.effects.due(new Date(h.clock.now() + 60 * 60 * 1000).toISOString())
  const next = rows
    .map((row) => Date.parse(row.dueAt))
    .filter((at) => at > h.clock.now())
    .sort((left, right) => left - right)[0]
  if (next !== undefined) h.clock.advance(next - h.clock.now())
  await h.effects.idle()
}

test('a message is stored before it is sent, and the handler sends it exactly once', async () => {
  const h = harness()
  try {
    h.store.transaction(() => h.outbox.send(message()))
    assert.equal(h.sent.length, 0, 'nothing is sent inside the writing transaction')
    assert.equal(h.outbox.status('reply-1'), 'pending')
    await h.effects.idle()
    assert.deepEqual(h.sent.map((item) => item.id), ['reply-1'])
    assert.equal(h.outbox.status('reply-1'), 'sent')
    // 同一条消息再次入队：保留第一条，不会发第二次。
    h.store.transaction(() => h.outbox.send(message('reply-1', { text: 'second text' })))
    await h.effects.idle()
    assert.deepEqual(h.sent.map((item) => item.id), ['reply-1'])
    assert.equal(h.outbox.entry('reply-1')?.message.text, 'Done: the login redirect is fixed.')
  } finally {
    h.cleanup()
  }
})

test('a rolled back transaction leaves neither a receipt nor a send', async () => {
  const h = harness()
  try {
    assert.throws(() =>
      h.store.transaction(() => {
        h.outbox.send(message())
        throw new Error('rolled back')
      })
    )
    await h.effects.idle()
    assert.equal(h.outbox.status('reply-1'), undefined)
    assert.deepEqual(h.sent, [])
  } finally {
    h.cleanup()
  }
})

test('a withdrawn message is never sent and keeps a withdrawn record', async () => {
  const h = harness()
  try {
    h.store.transaction(() => {
      h.outbox.send(message())
      h.outbox.withdraw('reply-1')
    })
    await h.effects.idle()
    assert.deepEqual(h.calls, [])
    const record = h.outbox.entry('reply-1')?.record
    assert.equal(record?.status, 'dropped')
    assert.equal(record?.droppedReason, 'withdrawn')
    assert.equal(record?.droppedAt, h.clock.iso())
    assert.equal(record?.ticketId, 'ticket-1')
    assert.equal(h.outbox.pending(), 0)
    assert.equal(h.effects.pending('reply', 'reply-1'), false)
  } finally {
    h.cleanup()
  }
})

test('a channel that is gone settles the message as dropped and stops retrying', async () => {
  const h = harness({ send: () => 'gone' })
  h.store.transaction(() => h.outbox.send(message()))
  await h.effects.idle()
  assert.equal(h.calls.length, 1)
  assert.equal(h.outbox.status('reply-1'), 'dropped')
  assert.equal(h.effects.pending('reply', 'reply-1'), false)
})

test('a channel that is not ready yet is a Later, so the message waits for the next pass', async () => {
  const h = harness({ send: () => 'waiting' })
  try {
    h.store.transaction(() => h.outbox.send(message()))
    await h.effects.idle()
    assert.equal(h.outbox.status('reply-1'), 'pending')
    assert.equal(h.effects.pending('reply', 'reply-1'), true, 'the row is still queued')
  } finally {
    h.cleanup()
  }
})

test('the group key is the ticket and the channel; different tickets and ticketless messages never wait', () => {
  assert.equal(outboxChannel(message()), 'ticket:ticket-1|github:github:42')
  const { ticketId: _omit, ...withoutTicket } = message()
  assert.equal(outboxChannel(withoutTicket), 'github:github:42')
  // 同一张 Ticket 的两个 Channel 是两组：一个发不出去不该挡住另一个。
  assert.notEqual(
    outboxChannel(message()),
    outboxChannel(
      message('reply-2', {
        channel: { source: 'feishu', thread: 'feishu:chat-1', address: { chat: 'chat-1' } }
      })
    )
  )
})

test('a later message of the same ticket and channel waits for the earlier one', async () => {
  const h = harness({
    send: (item) => {
      if (item.id === 'first') throw new Error('network is down')
      return 'sent'
    }
  })
  try {
    h.store.transaction(() => {
      h.outbox.send(message('first'))
      h.outbox.send(message('second'))
    })
    await h.effects.idle()
    // 前一条失败一次（还没到三次）：后一条一直等，不计数失败。
    assert.deepEqual(h.calls.map((item) => item.id), ['first'])
    assert.equal(h.outbox.status('second'), 'pending')
    assert.equal(replyEffect(h, 'second')?.attempts, 0, 'waiting is not a failure')
    // 再来一次：前一条仍没到三次，后一条仍等（它连 Channel 都不会碰）。
    await pass(h)
    assert.deepEqual(h.calls.map((item) => item.id), ['first', 'first'])
    await pass(h)
    assert.deepEqual(h.calls.map((item) => item.id), ['first', 'first'])
    assert.deepEqual(h.sent, [])
  } finally {
    h.cleanup()
  }
})

test('after the earlier message fails three times it stops blocking the next one', async () => {
  const h = harness({
    send: (item) => {
      if (item.id === 'first') throw new Error('network is down')
      return 'sent'
    }
  })
  try {
    h.store.transaction(() => {
      h.outbox.send(message('first'))
      h.outbox.send(message('second'))
    })
    await h.effects.idle()
    await pass(h)
    await pass(h)
    await pass(h)
    // `first` 连续失败三次（进入 system problem），`second` 不再等它。
    assert.equal(replyEffect(h, 'first')?.attempts, 3)
    assert.deepEqual(h.sent.map((item) => item.id), ['second'])
    // `first` 仍然是 pending：它自己的重试还在，只是不再挡后面。
    assert.equal(h.outbox.status('first'), 'pending')
    assert.equal(replyEffect(h, 'first')?.attempts, 3)
  } finally {
    h.cleanup()
  }
})

test('different tickets and ticketless messages never wait behind a failing group', async () => {
  const h = harness({
    send: (item) => {
      if (item.id === 'failing') throw new Error('network is down')
      return 'sent'
    }
  })
  try {
    h.store.transaction(() => {
      h.outbox.send(message('failing'))
      h.outbox.send(message('other-ticket', { ticketId: 'ticket-2' }))
      const { ticketId: _omit, ...ticketless } = message('ticketless', { ticketId: undefined })
      h.outbox.send(ticketless)
    })
    await h.effects.idle()
    assert.deepEqual(h.calls.map((item) => item.id).sort(), ['failing', 'other-ticket', 'ticketless'])
    assert.deepEqual(h.sent.map((item) => item.id).sort(), ['other-ticket', 'ticketless'])
    assert.equal(replyEffect(h, 'failing')?.attempts, 1)
  } finally {
    h.cleanup()
  }
})

test('a conversation the Source no longer listens to is dropped for that reason and never retried', async () => {
  const h = harness({ allowed: () => false })
  try {
    h.store.transaction(() => h.outbox.send(message('ignored')))
    await h.effects.idle()
    assert.deepEqual(h.calls, [], 'a dropped message never reaches the Channel')
    const record = h.outbox.entry('ignored')?.record
    assert.equal(record?.status, 'dropped')
    assert.equal(record?.droppedReason, 'channelIgnored')
    assert.equal(record?.droppedAt, h.clock.iso())
    assert.equal(record?.ticketId, 'ticket-1', 'the drop keeps its ticket link')
    assert.equal(h.effects.pending('reply', 'ignored'), false)
    // 永不再入队：同一个 id 再排一次也不发。
    h.store.transaction(() => h.outbox.send(message('ignored', { text: 'again' })))
    await h.effects.idle()
    assert.deepEqual(h.calls, [])
    assert.equal(h.outbox.entry('ignored')?.record.droppedReason, 'channelIgnored')
  } finally {
    h.cleanup()
  }
})

test('only an explicit permanent failure drops: other errors retry', async () => {
  const h = harness({
    send: () => {
      throw new Error('the network is down')
    }
  })
  try {
    h.store.transaction(() => h.outbox.send(message('broken')))
    await h.effects.idle()
    assert.equal(h.outbox.status('broken'), 'pending')
    assert.equal(h.outbox.entry('broken')?.record.droppedReason, null)
    assert.equal(replyEffect(h, 'broken')?.attempts, 1)
    assert.equal(replyEffect(h, 'broken')?.lastError, 'the network is down')
  } finally {
    h.cleanup()
  }
})

test('a Source that is off makes the message wait, and it goes out once the Source is back', async () => {
  let enabled = false
  let allowed = false
  const h = harness({ enabled: () => enabled, allowed: () => allowed })
  try {
    h.store.transaction(() => h.outbox.send(message('later')))
    await h.effects.idle()
    // 关闭的 Source 既不发也不 drop，更不算失败（§J.1 暂停行）。
    assert.deepEqual(h.calls, [])
    assert.equal(h.outbox.status('later'), 'pending')
    assert.equal(replyEffect(h, 'later')?.attempts, 0)
    enabled = true
    allowed = true
    h.clock.advance(5000)
    await h.effects.idle()
    assert.deepEqual(h.sent.map((item) => item.id), ['later'])
  } finally {
    h.cleanup()
  }
})

test('a paused plugin keeps the message pending without counting a failure, and sends on resume', async () => {
  const h = harness()
  try {
    h.controls.pause(true)
    h.store.transaction(() => h.outbox.send(message('paused')))
    await h.effects.idle()
    assert.deepEqual(h.calls, [])
    assert.equal(h.outbox.status('paused'), 'pending')
    assert.equal(replyEffect(h, 'paused')?.attempts, 0, 'a pause is not a failure')
    h.controls.pause(false)
    h.effects.kick()
    await h.effects.idle()
    assert.deepEqual(h.sent.map((item) => item.id), ['paused'])
  } finally {
    h.cleanup()
  }
})

test('the retry backoff starts at 5 s, doubles, and stops growing at 300 s', async () => {
  const h = harness({
    send: () => {
      throw new Error('the network is down')
    }
  })
  try {
    h.store.transaction(() => h.outbox.send(message('retry')))
    const gaps: number[] = []
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await h.effects.idle()
      const row = replyEffect(h, 'retry')
      assert.ok(row !== null, 'the message keeps waiting for its next attempt')
      const due = Date.parse(row.dueAt)
      gaps.push((due - h.clock.now()) / 1000)
      h.clock.advance(due - h.clock.now())
    }
    assert.deepEqual(gaps, [5, 10, 20, 40, 80, 160, 300, 300])
  } finally {
    h.cleanup()
  }
})

test('a sent message is final: no later write changes it and nothing sends it twice', async () => {
  const h = harness()
  try {
    h.store.transaction(() => h.outbox.send(message('once')))
    await h.effects.idle()
    assert.equal(h.outbox.status('once'), 'sent')
    h.store.transaction(() => {
      h.outbox.send(message('once', { text: 'a second text' }))
      h.outbox.sent('once', '2030-01-01T00:00:00.000Z')
      h.outbox.dropped('once', '2030-01-01T00:00:00.000Z', 'channelGone')
    })
    await h.effects.idle()
    assert.deepEqual(h.calls.map((item) => item.id), ['once'])
    const record = h.outbox.entry('once')?.record
    assert.equal(record?.status, 'sent')
    assert.equal(record?.droppedReason, null)
    assert.notEqual(record?.settledAt, '2030-01-01T00:00:00.000Z')
  } finally {
    h.cleanup()
  }
})

test('stopping a ticket withdraws its unsent messages but keeps the closing one', async () => {
  const h = harness()
  try {
    h.store.transaction(() => {
      h.outbox.send(message('ack:1', { kind: 'acknowledgement' }))
      h.outbox.send(message('reply-1'))
      h.outbox.send(message('other-ticket', { ticketId: 'ticket-2' }))
      // 停止：先撤回这张 Ticket 的待发消息（收尾消息除外），再排收尾消息。
      h.outbox.withdrawTicket('ticket-1', ['stopped:ticket-1'])
      h.outbox.send(
        message('stopped:ticket-1', { kind: 'notice', text: 'Stopped by a person: Fix the login redirect.' })
      )
    })
    await h.effects.idle()
    assert.deepEqual(h.sent.map((item) => item.id), ['other-ticket', 'stopped:ticket-1'])
    for (const id of ['ack:1', 'reply-1']) {
      const record = h.outbox.entry(id)?.record
      assert.equal(record?.status, 'dropped', `${id} is withdrawn`)
      assert.equal(record?.droppedReason, 'withdrawn')
      assert.equal(record?.droppedAt, h.clock.iso())
      assert.equal(record?.ticketId, 'ticket-1')
      assert.equal(h.effects.pending('reply', id), false, `${id} is never re-enqueued`)
    }
    // 别的 Ticket 的消息不受影响：它没有因为别人的停止而被撤回。
    assert.equal(h.outbox.status('other-ticket'), 'sent')
    // 再跑一轮也不会补发被撤回的消息。
    await h.effects.idle()
    assert.deepEqual(h.calls.map((item) => item.id).sort(), ['other-ticket', 'stopped:ticket-1'])
  } finally {
    h.cleanup()
  }
})

test('dropped messages are readable in a 24-hour window, keeping the ticket and the conversation', async () => {
  const h = harness({ send: () => 'gone' })
  try {
    h.store.transaction(() => h.outbox.send(message('old')))
    await h.effects.idle()
    // 25 小时后再 drop 一条：24 小时窗口只应列出新的那条。
    h.clock.advance(25 * 60 * 60 * 1000)
    h.store.transaction(() => h.outbox.send(message('new', { ticketId: 'ticket-2' })))
    await h.effects.idle()
    const since = new Date(h.clock.now() - 24 * 60 * 60 * 1000).toISOString()
    const window = h.outbox.droppedSince(since)
    assert.deepEqual(window.map((entry) => entry.record.id), ['new'])
    const [entry] = window
    assert.equal(entry?.record.droppedReason, 'channelGone')
    assert.equal(entry?.record.droppedAt, h.clock.iso())
    // drop 行保留两个链接：Ticket，以及原来那个会话（Source + Thread）。
    assert.equal(entry?.record.ticketId, 'ticket-2')
    assert.equal(entry?.message.channel.source, 'github')
    assert.equal(entry?.message.channel.thread, 'github:42')
    // 更早的那条仍然在库里，只是不在这个窗口内。
    assert.deepEqual(
      h.outbox.droppedSince('2026-01-01T00:00:00.000Z').map((item) => item.record.id),
      ['new', 'old']
    )
  } finally {
    h.cleanup()
  }
})

test('a message that failed three times is a system problem until it is sent', async () => {
  let fail = true
  const h = harness({
    send: () => {
      if (fail) throw new Error('the network is down')
      return 'sent'
    }
  })
  try {
    h.store.transaction(() => h.outbox.send(message('stuck')))
    await h.effects.idle()
    await pass(h)
    await pass(h)
    assert.deepEqual(h.outbox.failing(3).map((entry) => entry.record.id), ['stuck'])
    fail = false
    await pass(h)
    assert.equal(h.outbox.status('stuck'), 'sent')
    assert.deepEqual(h.outbox.failing(3), [], 'a sent message is no longer a problem')
  } finally {
    h.cleanup()
  }
})

test('a message that failed three times stops being a system problem when the ticket is stopped', async () => {
  const h = harness({
    send: () => {
      throw new Error('the network is down')
    }
  })
  try {
    h.store.transaction(() => h.outbox.send(message('stuck')))
    await h.effects.idle()
    await pass(h)
    await pass(h)
    assert.deepEqual(h.outbox.failing(3).map((entry) => entry.record.id), ['stuck'])
    h.store.transaction(() => h.outbox.withdrawTicket('ticket-1', []))
    assert.deepEqual(h.outbox.failing(3), [], 'a withdrawn message is no longer a problem')
    assert.equal(h.outbox.entry('stuck')?.record.droppedReason, 'withdrawn')
  } finally {
    h.cleanup()
  }
})

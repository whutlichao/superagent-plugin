// Outbox（§J.1）：先存后发、按消息 id 幂等、可撤回、发送成功/永久失败各转一个终态。
// 真库 + 真效果队列 + 注入的 Channel 端口，绝不 sleep（§P.1）。
import { assert, test } from 'orca/testing'
import type { OutboundMessage } from '../src/worker/core/index.ts'
import { createOutbox, registerReplyEffects, outboxChannel } from '../src/worker/app/outbox'
import { openQueue } from './support/queue'

/** 一条发往 GitHub Issue 的回复。 */
function message(id = 'reply-1', text = 'Done: the login redirect is fixed.'): OutboundMessage {
  return {
    id,
    channel: {
      source: 'github',
      thread: 'github:42',
      address: { repo: 'acme/widgets', issue: '42' }
    },
    text,
    kind: 'reply',
    ticketId: 'ticket-1'
  }
}

/** 装上 outbox 与 reply handler；`send` 记录每次真正发出去的消息。 */
function harness(reply: (message: OutboundMessage) => 'sent' | 'gone' | 'waiting' = () => 'sent') {
  const queue = openQueue()
  const outbox = createOutbox({
    store: queue.store,
    effects: queue.effects,
    now: () => queue.clock.iso()
  })
  const sent: OutboundMessage[] = []
  registerReplyEffects({
    effects: queue.effects,
    outbox,
    channel: {
      send: async (item) => {
        sent.push(item)
        return reply(item)
      }
    },
    now: () => queue.clock.iso()
  })
  return { ...queue, outbox, sent }
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
    h.store.transaction(() => h.outbox.send(message('reply-1', 'second text')))
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

test('a withdrawn message is never sent', async () => {
  const h = harness()
  try {
    h.store.transaction(() => {
      h.outbox.send(message())
      h.outbox.withdraw('reply-1')
    })
    await h.effects.idle()
    assert.deepEqual(h.sent, [])
    assert.equal(h.outbox.status('reply-1'), undefined)
    assert.equal(h.outbox.pending(), 0)
  } finally {
    h.cleanup()
  }
})

test('a channel that is gone settles the message as dropped and stops retrying', async () => {
  const h = harness(() => 'gone')
  h.store.transaction(() => h.outbox.send(message()))
  await h.effects.idle()
  assert.equal(h.sent.length, 1)
  assert.equal(h.outbox.status('reply-1'), 'dropped')
  assert.equal(h.effects.pending('reply', 'reply-1'), false)
})

test('a channel that is not ready yet is a Later, so the message waits for the next pass', async () => {
  const h = harness(() => 'waiting')
  try {
    h.store.transaction(() => h.outbox.send(message()))
    await h.effects.idle()
    assert.equal(h.outbox.status('reply-1'), 'pending')
    assert.equal(h.effects.pending('reply', 'reply-1'), true, 'the row is still queued')
  } finally {
    h.cleanup()
  }
})

test('the group key is the ticket when there is one, the channel otherwise', () => {
  assert.equal(outboxChannel(message()), 'ticket:ticket-1')
  const { ticketId: _omit, ...withoutTicket } = message()
  assert.equal(outboxChannel(withoutTicket), 'github:github:42')
})

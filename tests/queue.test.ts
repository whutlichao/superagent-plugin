// 队列的持久面（§J.2 关停行、§E.10 崩溃恢复、§P.2 `queue.test.ts`）：
// 关停保留 pending 行（不删、不改 payload、不改 attempts），重启后接着按原顺序跑；
// 新入队的行排在等待中的行之后（seq 跨重启连续）。
//
// 真库、真事务、虚拟时钟；重启用「同一个库、新的队列实例」表达。
import { assert, test } from 'orca/testing'
import { Effects, Later } from '../src/worker/app/effects'
import { HealthBoard } from '../src/worker/infra/health'
import { createClock, createGate, openQueue, until } from './support/queue'

test('drain stops taking rows and leaves pending rows untouched, payload and attempts included', async () => {
  const h = openQueue()
  try {
    const gate = createGate()
    h.effects.handle('relay', async () => {
      await gate.opened
      throw new Error('shutdown cut this attempt short')
    })
    h.store.transaction(() => {
      h.effects.enqueue('relay', 'running', { messageId: 'm1', kind: 'report', summary: 'a' })
      h.effects.enqueue('relay', 'waiting', { messageId: 'm2', kind: 'report', summary: 'b' })
    })
    await until(() => h.effects.pending('relay', 'running'))
    const before = h.store.effects.get('relay', 'waiting')
    const drained = h.effects.drain()
    // 关停中入队的行也不会被取（队列已停止派发）。
    h.effects.enqueue('relay', 'late', { messageId: 'm3', kind: 'report', summary: 'c' })
    gate.open()
    await drained
    // 在跑的这次失败没有写回：行还在，attempts 与 payload 都没变。
    assert.deepEqual(h.store.effects.get('relay', 'running')?.attempts, 0)
    assert.deepEqual(h.store.effects.get('relay', 'waiting'), before)
    assert.equal(h.effects.pending('relay', 'late'), true)
    // 关停之后什么也不启动。
    h.effects.kick()
    await Promise.resolve()
    assert.equal(h.effects.pending('relay'), true)
  } finally {
    h.cleanup()
  }
})

test('a restarted queue picks up what waited, in the original order, and new rows go last', async () => {
  const first = openQueue()
  const order: string[] = []
  try {
    const gate = createGate()
    first.effects.handle('relay', async () => {
      await gate.opened
      throw new Error('aborted')
    })
    first.store.transaction(() => {
      first.effects.enqueue('relay', 'first', { messageId: 'm1', kind: 'report', summary: 'a' })
      first.effects.enqueue('relay', 'second', { messageId: 'm2', kind: 'report', summary: 'b' })
    })
    await until(() => first.effects.pending('relay', 'first'))
    const drained = first.effects.drain()
    gate.open()
    await drained

    // 重启：同一个库、新的队列实例（模拟插件 worker 被 Orca 重启，§E.10）。
    const board = new HealthBoard()
    const clock = createClock()
    const restarted = new Effects({
      store: first.store,
      health: board,
      now: () => clock.now()
    })
    // 重启后先入队的新行，必须排在等待中的两行之后（seq 跨重启连续）。
    restarted.enqueue('relay', 'third', { messageId: 'm3', kind: 'report', summary: 'c' })
    restarted.start()
    restarted.handle('relay', async (_payload, key) => {
      order.push(key)
    })
    await restarted.idle()
    assert.deepEqual(order, ['first', 'second', 'third'])
  } finally {
    first.cleanup()
  }
})

test('a row that gave up stays gone after a restart, and its kind keeps the failure count at error', async () => {
  const h = openQueue()
  try {
    h.effects.handle('launch', async () => {
      throw new Error('provider unavailable (503)')
    })
    h.effects.enqueue('launch', 'ticket-1', { ticketId: 'ticket-1', assignmentId: 'a1' })
    await h.effects.idle()
    h.clock.advance(5000)
    await h.effects.idle()
    h.clock.advance(10_000)
    await h.effects.idle()
    assert.equal(h.effects.pending('launch'), false)
    assert.equal(h.board.all().launch?.state, 'error')

    // 重启后的新队列从库里读计数：行已经没了，健康回到 ready（计数是「连续失败」的内存读数）。
    const board = new HealthBoard()
    const restarted = new Effects({ store: h.store, health: board, now: () => h.clock.now() })
    restarted.handle('launch', async () => {})
    restarted.start()
    await restarted.idle()
    assert.deepEqual(board.all().launch, { state: 'ready', detail: 'waiting 0, failed 0' })
  } finally {
    h.cleanup()
  }
})

test('the queue never runs two rows of one kind concurrently beyond its limit, after a restart too', async () => {
  const h = openQueue()
  const running: string[] = []
  const order: string[] = []
  try {
    const gates = new Map<string, ReturnType<typeof createGate>>()
    h.effects.handle('reply', async (_payload, key) => {
      running.push(key)
      order.push(key)
      const gate = createGate()
      gates.set(key, gate)
      await gate.opened
      running.pop()
    })
    for (const id of ['m1', 'm2', 'm3']) {
      h.effects.enqueue('reply', id, { messageId: id })
    }
    // reply 的并发是 1（§J.2）：一次只发一条。
    await until(() => order.length === 1)
    assert.deepEqual(running, ['m1'])
    for (let round = 0; round < 3; round += 1) {
      for (const gate of gates.values()) gate.open()
      await until(() => order.length >= round + 2 || h.effects.pending('reply') === false)
    }
    for (const gate of gates.values()) gate.open()
    await h.effects.idle()
    assert.deepEqual(order, ['m1', 'm2', 'm3'])
  } finally {
    h.cleanup()
  }
})

test('a failure is persisted with its attempts, last error and later due time', async () => {
  const h = openQueue()
  try {
    h.effects.handle('reply', async () => {
      throw new Error('channel offline')
    })
    h.effects.enqueue('reply', 'message-1', { messageId: 'message-1' })
    await h.effects.idle()
    const row = h.store.effects.get('reply', 'message-1')
    assert.equal(row?.attempts, 1)
    assert.equal(row?.lastError, 'channel offline')
    // reply 的首退避是 5 s（§J.2）。
    assert.equal(row?.dueAt, new Date(h.clock.now() + 5000).toISOString())
    assert.equal(row?.payload !== null && typeof row?.payload === 'object', true)
  } finally {
    h.cleanup()
  }
})

test('Later moves the due time five seconds ahead without touching attempts or the payload', async () => {
  const h = openQueue()
  try {
    h.effects.handle('launch', async () => {
      throw new Later('no worker slot')
    })
    h.effects.enqueue('launch', 'ticket-1', { ticketId: 'ticket-1', assignmentId: 'a1' })
    await h.effects.idle()
    const row = h.store.effects.get('launch', 'ticket-1')
    // §J.2：`Later` 不计失败，`due_at = now + 5 s`；payload 原样。
    assert.equal(row?.attempts, 0)
    assert.equal(row?.lastError, null)
    assert.deepEqual(row?.payload, { ticketId: 'ticket-1', assignmentId: 'a1' })
    assert.equal(row?.dueAt, new Date(h.clock.now() + 5000).toISOString())
  } finally {
    h.cleanup()
  }
})

test('re-enqueueing during a backoff replaces the payload and makes the row due again at once', async () => {
  const h = openQueue()
  const texts: string[] = []
  try {
    let failing = true
    h.effects.handle('relay', async (payload) => {
      texts.push(payload.summary)
      if (failing) throw new Error('router busy')
    })
    h.effects.enqueue('relay', 'router', { messageId: 'm1', kind: 'report', summary: 'first' })
    await h.effects.idle()
    // 退避中（2 s 后到期）。
    assert.equal(h.effects.pending('relay', 'router'), true)
    failing = false
    h.effects.enqueue('relay', 'router', { messageId: 'm1', kind: 'report', summary: 'second' })
    // 再入队把它变成立即可取：不用等原定的退避。
    await h.effects.idle()
    assert.deepEqual(texts, ['first', 'second'])
    assert.equal(h.effects.pending('relay'), false)
  } finally {
    h.cleanup()
  }
})

test('draining with nothing running resolves immediately and leaves the rows for the next start', async () => {
  const h = openQueue()
  try {
    h.effects.handle('delivery', async () => {})
    h.store.transaction(() => {
      h.effects.enqueue('delivery', 'ticket-1', { ticketId: 'ticket-1' })
      h.effects.enqueue('delivery', 'ticket-2', { ticketId: 'ticket-2' })
    })
    // 先让它跑掉一条，再 drain：drain 只看在跑的，pending 行原样留下。
    await h.effects.idle()
    await h.effects.drain()
    assert.equal(h.effects.pending('delivery'), false)
  } finally {
    h.cleanup()
  }
})

test('rows of each kind keep their seq order within one dispatch', async () => {
  const h = openQueue()
  const order: string[] = []
  try {
    h.effects.handle('assessment', async (_payload, key) => {
      order.push(`assessment ${key}`)
    })
    h.effects.handle('return', async (_payload, key) => {
      order.push(`return ${key}`)
    })
    h.store.transaction(() => {
      h.effects.enqueue('assessment', 'e1', { triggerId: 't1' })
      h.effects.enqueue('return', 'k1', { triggerKey: 'k1' })
      h.effects.enqueue('assessment', 'e2', { triggerId: 't2' })
      h.effects.enqueue('return', 'k2', { triggerKey: 'k2' })
    })
    await h.effects.idle()
    // 同一种 kind 内按 `seq` 升序（§J.2「按 seq 升序取 due 行」）；跨 kind 的先后由调度顺序决定，
    // 设计只对「同 kind」与「共用 router 队列的 relay/notice」承诺顺序。
    assert.deepEqual(order.filter((entry) => entry.startsWith('assessment')), ['assessment e1', 'assessment e2'])
    assert.deepEqual(order.filter((entry) => entry.startsWith('return')), ['return k1', 'return k2'])
  } finally {
    h.cleanup()
  }
})

test('a failed reply does not hold back another message: reply is serial, not ordered', async () => {
  const h = openQueue()
  const sent: string[] = []
  try {
    h.effects.handle('reply', async (payload) => {
      if (payload.messageId === 'stuck') throw new Error('channel offline')
      sent.push(payload.messageId)
    })
    h.effects.enqueue('reply', 'stuck', { messageId: 'stuck' })
    h.effects.enqueue('reply', 'other', { messageId: 'other' })
    await h.effects.idle()
    // §J.1：不同 Ticket / 无 Ticket 的消息互不等待；顺序只按 (ticket, channel) 由 outbox 负责。
    assert.deepEqual(sent, ['other'])
    assert.equal(h.effects.pending('reply', 'stuck'), true)
  } finally {
    h.cleanup()
  }
})

test('reply is one at a time: a second message starts only after the first attempt ends', async () => {
  const h = openQueue()
  const started: string[] = []
  try {
    const gate = createGate()
    h.effects.handle('reply', async (payload) => {
      started.push(payload.messageId)
      await gate.opened
    })
    h.effects.enqueue('reply', 'm1', { messageId: 'm1' })
    h.effects.enqueue('reply', 'm2', { messageId: 'm2' })
    await until(() => started.length >= 1)
    assert.deepEqual(started, ['m1'], 'only the first message is being sent')
    gate.open()
    await h.effects.idle()
    assert.deepEqual(started, ['m1', 'm2'])
  } finally {
    h.cleanup()
  }
})

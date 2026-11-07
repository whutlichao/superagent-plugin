// 持久副作用队列（§J.2）：先存后做、按 (kind, key) 合并、按 seq 取、退避、`Later`、暂停、
// 并发上限、健康计数与关停。全部跑在真库上（临时目录 + 真 SQLite），时钟由测试推进，
// 绝不 sleep（§P.1）。
//
// 这些用例只经队列自己的接口观察行为：`enqueue` / `handle` / `pending` / `idle` /
// `drain` / 看板读数，不看内部表结构。
import { assert, test } from 'orca/testing'
import {
  EFFECT_KEY_SHAPES,
  EFFECT_KINDS,
  EFFECT_RULES,
  Effects,
  Later,
  ROUTER_EFFECT_KEY,
  type EffectKind
} from '../src/worker/app/effects'
import { HealthBoard } from '../src/worker/infra/health'
import { createGate, openQueue, until } from './support/queue'

test('an effect queued inside a transaction runs only once that transaction commits', async () => {
  const h = openQueue()
  const ran: string[] = []
  try {
    h.effects.handle('relay', async (payload) => {
      ran.push(payload.summary)
    })
    h.store.transaction(() => {
      h.effects.enqueue('relay', 'router', { messageId: 'm1', kind: 'report', summary: 'first' })
      assert.deepEqual(ran, [], 'a handler never runs inside the writing transaction')
    })
    await h.effects.idle()
    assert.deepEqual(ran, ['first'])
    assert.equal(h.effects.pending('relay'), false)
  } finally {
    h.cleanup()
  }
})

test('an effect queued in a transaction that rolls back never runs and leaves no row', async () => {
  const h = openQueue()
  const ran: string[] = []
  try {
    h.effects.handle('relay', async (payload) => {
      ran.push(payload.summary)
    })
    assert.throws(() =>
      h.store.transaction(() => {
        h.effects.enqueue('relay', 'router', { messageId: 'm1', kind: 'report', summary: 'rolled back' })
        throw new Error('rolled back')
      })
    )
    await h.effects.idle()
    assert.deepEqual(ran, [])
    assert.equal(h.effects.pending('relay'), false)
  } finally {
    h.cleanup()
  }
})

test('re-enqueueing the same kind and key replaces the payload and keeps one row', async () => {
  const h = openQueue()
  const seen: { summary: string; key: string }[] = []
  try {
    // 先占住串行队列，让第一行停在运行中；期间的再入队必须替换 payload 而不是排第二行。
    const gate = createGate()
    let first = true
    h.effects.handle('notice', async (payload, key) => {
      if (first) {
        first = false
        await gate.opened
      }
      seen.push({ summary: payload.summary, key })
    })
    h.effects.enqueue('notice', 'router', { summary: 'old' })
    h.effects.enqueue('notice', 'router', { summary: 'new' })
    gate.open()
    await h.effects.idle()
    assert.deepEqual(seen, [{ summary: 'new', key: 'router' }], 'one row, the latest payload')
  } finally {
    h.cleanup()
  }
})

test('a re-enqueued row keeps its seq, so the queue order does not change', async () => {
  const h = openQueue()
  const order: string[] = []
  try {
    // 用串行 kind 让顺序可观察：relay 一次只跑一条，按 seq 取。
    h.effects.handle('relay', async (_payload, key) => {
      order.push(key)
    })
    h.store.transaction(() => {
      h.effects.enqueue('relay', 'first', { messageId: 'm1', kind: 'report', summary: 'a' })
      h.effects.enqueue('relay', 'second', { messageId: 'm2', kind: 'report', summary: 'b' })
      h.effects.enqueue('relay', 'first', { messageId: 'm1', kind: 'report', summary: 'c' })
    })
    await h.effects.idle()
    assert.deepEqual(order, ['first', 'second'], 'the re-queued row did not move behind the other one')
  } finally {
    h.cleanup()
  }
})

test('a run that replaces its own row while running leaves the new payload to run again', async () => {
  const h = openQueue()
  const texts: string[] = []
  try {
    const started = createGate()
    const release = createGate()
    h.effects.handle('relay', async (payload) => {
      texts.push(payload.summary)
      if (payload.summary === 'first') {
        started.open()
        await release.opened
      }
    })
    h.effects.enqueue('relay', 'router', { messageId: 'm1', kind: 'report', summary: 'first' })
    await started.opened
    // 运行中把自己重新入队：旧尝试结束后不能删掉新行。
    h.effects.enqueue('relay', 'router', { messageId: 'm1', kind: 'report', summary: 'second' })
    release.open()
    await h.effects.idle()
    assert.deepEqual(texts, ['first', 'second'], 'the replacement ran once, with its own payload')
    assert.equal(h.effects.pending('relay'), false)
  } finally {
    h.cleanup()
  }
})

test('a failed effect retries after a delay that doubles, up to the kind maximum', async () => {
  const h = openQueue()
  const attempts: number[] = []
  try {
    h.effects.handle('notice', async () => {
      attempts.push(h.clock.now())
      throw new Error('router terminal busy')
    })
    const start = h.clock.now()
    h.effects.enqueue('notice', 'router', { summary: 'prompts saved' })
    await h.effects.idle()
    assert.deepEqual(attempts, [start], 'the first attempt is immediate')

    // notice 的退避是 2 s → 翻倍 → 60 s（§J.2）：2、4、8、16、32、60、60 秒。
    const delays = [2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]
    for (const delay of delays) {
      const before = attempts.length
      h.clock.advance(delay - 1)
      await h.effects.idle()
      assert.equal(attempts.length, before, `not before ${delay} ms`)
      h.clock.advance(1)
      await h.effects.idle()
      assert.equal(attempts.length, before + 1, `retried at ${delay} ms`)
    }
    // 独立真相：每次尝试相对第一次的偏移（手算的累加，不从代码推导）。
    assert.deepEqual(
      attempts.map((at) => at - start),
      [0, 2000, 6000, 14_000, 30_000, 62_000, 122_000, 182_000]
    )
  } finally {
    h.cleanup()
  }
})

test('Later means "cannot now": not a failure, retried after five seconds', async () => {
  const h = openQueue()
  let later = true
  const calls: number[] = []
  try {
    h.effects.handle('launch', async () => {
      calls.push(h.clock.now())
      if (later) throw new Later('no worker slot')
    })
    h.effects.enqueue('launch', 'ticket-1', { ticketId: 'ticket-1', assignmentId: 'a1' })
    await h.effects.idle()
    assert.equal(calls.length, 1)
    // 不计失败：健康读到的是计数，不是 error，也没有失败行。
    assert.deepEqual(h.board.all().launch, { state: 'ready', detail: 'waiting 1, failed 0' })

    later = false
    h.clock.advance(4999)
    await h.effects.idle()
    assert.equal(calls.length, 1, 'not before the five second delay')
    h.clock.advance(1)
    await h.effects.idle()
    assert.equal(calls.length, 2, 'retried after five seconds')
    assert.equal(h.effects.pending('launch'), false)
  } finally {
    h.cleanup()
  }
})

test('an effect enqueued in a nested savepoint that rolls back never runs, while the outer one does', async () => {
  const h = openQueue()
  const ran: string[] = []
  try {
    h.effects.handle('relay', async (payload) => {
      ran.push(payload.summary)
    })
    h.store.transaction(() => {
      h.effects.enqueue('relay', 'kept', { messageId: 'm1', kind: 'report', summary: 'kept' })
      try {
        h.store.transaction(() => {
          h.effects.enqueue('relay', 'dropped', { messageId: 'm2', kind: 'report', summary: 'dropped' })
          throw new Error('inner rolled back')
        })
      } catch {
        // 外层决定继续
      }
    })
    await h.effects.idle()
    assert.deepEqual(ran, ['kept'], 'only the outer transaction’s effect ran')
    assert.equal(h.effects.pending('relay', 'dropped'), false)
  } finally {
    h.cleanup()
  }
})

test('a re-enqueue that rolls back does not disturb the attempt already running', async () => {
  const h = openQueue()
  const texts: string[] = []
  try {
    const started = createGate()
    const release = createGate()
    h.effects.handle('relay', async (payload) => {
      texts.push(payload.summary)
      if (payload.summary === 'first') {
        started.open()
        await release.opened
      }
    })
    h.effects.enqueue('relay', 'router', { messageId: 'm1', kind: 'report', summary: 'first' })
    await started.opened
    // 运行中的这一条被「再入队」了一次，但那个事务回滚了：旧尝试结束时仍要正常删行。
    assert.throws(() =>
      h.store.transaction(() => {
        h.effects.enqueue('relay', 'router', { messageId: 'm1', kind: 'report', summary: 'never' })
        throw new Error('rolled back')
      })
    )
    release.open()
    await h.effects.idle()
    assert.deepEqual(texts, ['first'], 'the rolled-back replacement never ran')
    assert.equal(h.effects.pending('relay'), false, 'the finished row was removed as usual')
  } finally {
    h.cleanup()
  }
})

test('an effect enqueued outside any transaction is not run synchronously either', async () => {
  const h = openQueue()
  const ran: string[] = []
  try {
    h.effects.handle('relay', async (payload) => {
      ran.push(payload.summary)
    })
    h.effects.enqueue('relay', 'router', { messageId: 'm1', kind: 'report', summary: 'later' })
    assert.deepEqual(ran, [], 'the caller keeps its turn; the row is already persisted')
    assert.equal(h.effects.pending('relay'), true)
    await h.effects.idle()
    assert.deepEqual(ran, ['later'])
  } finally {
    h.cleanup()
  }
})

test('every effect kind reports its own health entry before any handler is registered', () => {
  const h = openQueue()
  try {
    // §J.3：每个 effect kind 一个条目，写者就是队列自己；还没接上 handler 的 kind 是
    // `starting` + 计数，而不是缺行、也不是假就绪。
    assert.deepEqual(Object.keys(h.board.all()).sort(), [...EFFECT_KINDS].sort())
    for (const kind of EFFECT_KINDS) {
      assert.deepEqual(h.board.all()[kind], { state: 'starting', detail: 'waiting 0, failed 0' })
    }
  } finally {
    h.cleanup()
  }
})

test('a second handler for one kind is refused, and the queue keeps the first', async () => {
  const h = openQueue()
  const ran: string[] = []
  try {
    h.effects.handle('relay', async () => {
      ran.push('first')
    })
    assert.throws(() => h.effects.handle('relay', async () => undefined), /already have a handler/)
    h.effects.enqueue('relay', 'router', { messageId: 'm1', kind: 'report', summary: 'a' })
    await h.effects.idle()
    assert.deepEqual(ran, ['first'])
  } finally {
    h.cleanup()
  }
})

test('dropped outbox messages are counted in the reply detail, never reported as an error', async () => {
  const h = openQueue()
  try {
    // §J.3：单条 dropped 不算错误，只计数；这里用 outbox 注入的读数模拟三条已 drop 的消息。
    const board = new HealthBoard()
    const withDropped = new Effects({
      store: h.store,
      health: board,
      now: () => h.clock.now(),
      dropped: (kind) => (kind === 'reply' ? 3 : 0)
    })
    withDropped.start()
    await withDropped.idle()
    assert.deepEqual(board.all().reply, { state: 'starting', detail: 'waiting 0, failed 0, dropped 3' })
    // 其它 kind 的计数里没有 dropped 这一项（outbox 只属于 reply）。
    assert.deepEqual(board.all().relay, { state: 'starting', detail: 'waiting 0, failed 0' })
  } finally {
    h.cleanup()
  }
})

test('a kick keeps the caller’s turn: dispatch happens on a later microtask, never inline', async () => {
  const h = openQueue()
  const ran: string[] = []
  try {
    h.effects.handle('relay', async (payload) => {
      ran.push(payload.summary)
    })
    h.effects.enqueue('relay', 'router', { messageId: 'm1', kind: 'report', summary: 'a' })
    // 入队返回时还没有跑：派发被推到微任务，调用方的事务与状态因此不会被 handler 打断。
    assert.deepEqual(ran, [])
    h.effects.kick()
    h.effects.kick()
    assert.deepEqual(ran, [], 'kicks coalesce and never run inline')
    await h.effects.idle()
    assert.deepEqual(ran, ['a'])
  } finally {
    h.cleanup()
  }
})

test('a queue that was never started takes no rows, and start() picks them up', async () => {
  const h = openQueue()
  try {
    const ran: string[] = []
    // 用同一个库、一块新看板（同一个库上两个队列会争同一批健康条目，那是单实例锁要挡的事），
    // 但换一个没 `start()` 的队列（模拟 setup 未完成时的 boot，§N.1）。
    const paused = new Effects({ store: h.store, health: new HealthBoard(), now: () => h.clock.now() })
    paused.handle('relay', async (payload) => {
      ran.push(payload.summary)
    })
    paused.enqueue('relay', 'router', { messageId: 'm1', kind: 'report', summary: 'a' })
    await paused.idle()
    assert.deepEqual(ran, [], 'nothing runs before start()')
    assert.equal(paused.pending('relay'), true)
    paused.start()
    await paused.idle()
    assert.deepEqual(ran, ['a'])
  } finally {
    h.cleanup()
  }
})

test('an effect kind with no handler waits without failing: the queue reports it and takes it later', async () => {
  const h = openQueue()
  const ran: string[] = []
  try {
    // 只注册 relay，投一条 assessment：没有 handler 的 kind 不被取走（§J.2「每 kind 一个 handler」）。
    h.effects.handle('relay', async () => undefined)
    h.effects.enqueue('assessment', 'eval-1', { triggerId: 't1' })
    await h.effects.idle()
    assert.deepEqual(ran, [])
    assert.equal(h.effects.pending('assessment'), true)
    // 没有 handler 的 kind 不取行，但健康条目仍报等待数（§J.3 的 detail 就是计数），
    // 状态是 `starting`——没有任何写者跑过它。
    assert.deepEqual(h.board.all().assessment, { state: 'starting', detail: 'waiting 1, failed 0' })
    // 接上 handler 之后才开始跑。
    h.effects.handle('assessment', async (_payload, key) => {
      ran.push(key)
    })
    await h.effects.idle()
    assert.deepEqual(ran, ['eval-1'])
  } finally {
    h.cleanup()
  }
})

test('each effect kind starts as `starting`, then says `ready` once it has reported', async () => {
  const h = openQueue()
  try {
    // §J.3：条目状态取 `starting|ready|paused|error`。刚 claim、还没有任何一次报告时是
    // `starting`（「已占用、还没测过」），一次报告之后才变成 ready。
    assert.deepEqual(h.board.all().notice, { state: 'starting', detail: 'waiting 0, failed 0' })
    h.effects.handle('notice', async () => undefined)
    assert.deepEqual(h.board.all().notice, { state: 'ready', detail: 'waiting 0, failed 0' })
    // 没有 handler 的 kind 还没有报告过：保持 starting，但计数照样是真的。
    h.effects.enqueue('assessment', 'eval-1', { triggerId: 't1' })
    await h.effects.idle()
    assert.deepEqual(h.board.all().assessment, { state: 'starting', detail: 'waiting 1, failed 0' })
  } finally {
    h.cleanup()
  }
})

test('a paused kind says `paused` with its counts, and returns to `ready` after resume', async () => {
  const h = openQueue()
  try {
    h.effects.handle('delivery', async () => {
      throw new Error('should not run while paused')
    })
    h.controls.pause(true)
    h.effects.enqueue('delivery', 'ticket-1', { ticketId: 'ticket-1' })
    await h.effects.idle()
    // §J.3 的四档里 `paused` 表示「不在跑」：被暂停挡住的 kind 用这一档，而不是 ready。
    assert.deepEqual(h.board.all().delivery, { state: 'paused', detail: 'waiting 1, failed 0' })
    // relay 不受暂停影响：它照跑，报 ready（或 error）。
    h.effects.handle('relay', async () => undefined)
    h.effects.enqueue('relay', 'router', { messageId: 'm1', kind: 'report', summary: 'a' })
    await h.effects.idle()
    assert.deepEqual(h.board.all().relay, { state: 'ready', detail: 'waiting 0, failed 0' })
    h.controls.pause(false)
    await h.effects.idle()
    // 恢复后它跑了一次并失败；`delivery` 的失败不上报健康（§J.3），只有计数变化。
    assert.deepEqual(h.board.all().delivery, { state: 'ready', detail: 'waiting 1, failed 1' })
  } finally {
    h.cleanup()
  }
})

test('the effect kind table is the one the design names, row by row', () => {
  // §J.2 的 kind 表逐行：key 形状在调用方，这里断言并发/退避/串行/暂停四面。
  // 期望值是设计表格的手抄，不从 `EFFECT_RULES` 推导。
  assert.deepEqual(EFFECT_KINDS, [
    'assessment',
    'launch',
    'delivery',
    'relay',
    'notice',
    'reply',
    'return'
  ])
  // key 形状（§J.2 的 key 列）：relay/notice 共用 `'router'`，其余各按自己的聚合 id。
  assert.deepEqual(EFFECT_KEY_SHAPES, {
    assessment: 'evalId',
    launch: 'ticketId',
    delivery: 'ticketId',
    relay: "'router'",
    notice: "'router'",
    reply: 'messageId',
    return: 'triggerKey'
  })
  assert.equal(ROUTER_EFFECT_KEY, 'router')
  const row = (kind: EffectKind) => EFFECT_RULES[kind]
  const running = { paused: false, slots: 3 }

  // assessment：4（暂停时 0），2 s→60 s。
  assert.equal(row('assessment').limit(running), 4)
  assert.equal(row('assessment').limit({ paused: true, slots: 3 }), 0)
  assert.deepEqual(row('assessment').retry, [2000, 60_000])
  // launch：空闲 slot 数（暂停时 0），5 s→300 s，最多 3 次 provider 失败。
  assert.equal(row('launch').limit(running), 3)
  assert.equal(row('launch').limit({ paused: true, slots: 3 }), 0)
  assert.deepEqual(row('launch').retry, [5000, 300_000])
  assert.equal(row('launch').maxAttempts, 3)
  // delivery：4（暂停时 0），2 s→60 s，失败不报健康。
  assert.equal(row('delivery').limit(running), 4)
  assert.equal(row('delivery').limit({ paused: true, slots: 3 }), 0)
  assert.deepEqual(row('delivery').retry, [2000, 60_000])
  assert.equal(row('delivery').quiet, true)
  // relay / notice：各 1、串行 FIFO、共用 router 队列，2 s→60 s。
  for (const kind of ['relay', 'notice'] as const) {
    assert.equal(row(kind).limit(running), 1)
    assert.equal(row(kind).ordered, true)
    assert.equal(row(kind).router, true)
    assert.deepEqual(row(kind).retry, [2000, 60_000])
  }
  // reply：1（暂停时 0），5 s→300 s；顺序由 outbox 按 (ticket, channel) 负责，不是全局串行。
  assert.equal(row('reply').limit(running), 1)
  assert.equal(row('reply').limit({ paused: true, slots: 3 }), 0)
  assert.deepEqual(row('reply').retry, [5000, 300_000])
  // return：1，2 s→60 s。
  assert.equal(row('return').limit(running), 1)
  assert.deepEqual(row('return').retry, [2000, 60_000])
  // 暂停只挡四种（§J.2 暂停行）：relay/notice/return 不在名单里。
  assert.deepEqual(
    EFFECT_KINDS.filter((kind) => row(kind).heldWhilePaused),
    ['assessment', 'launch', 'delivery', 'reply']
  )
})

test('kind limits hold under load: one kind at most as many at once as its limit allows', async () => {
  const h = openQueue({ slots: 2 })
  const running = new Map<string, number>()
  let peak = 0
  try {
    const gates = new Map<string, ReturnType<typeof createGate>>()
    h.effects.handle('launch', async (_payload, key) => {
      const next = (running.get('launch') ?? 0) + 1
      running.set('launch', next)
      peak = Math.max(peak, next)
      const gate = createGate()
      gates.set(key, gate)
      await gate.opened
      running.set('launch', (running.get('launch') ?? 1) - 1)
    })
    for (const id of ['a', 'b', 'c']) {
      h.effects.enqueue('launch', id, { ticketId: id, assignmentId: id })
    }
    // 夹具的 slot 是 2：同时最多两个 launch 在跑（§E.6）。
    await until(() => gates.size === 2)
    assert.equal(peak, 2)
    assert.deepEqual([...gates.keys()], ['a', 'b'], 'the two oldest rows start first')
    gates.get('a')?.open()
    await until(() => gates.has('c'))
    assert.deepEqual([...gates.keys()], ['a', 'b', 'c'], 'the next row starts when one finishes')
    gates.get('b')?.open()
    gates.get('c')?.open()
    await h.effects.idle()
    assert.equal(peak, 2)
    assert.equal(h.effects.pending('launch'), false)
  } finally {
    h.cleanup()
  }
})

test('the global cap of four holds across kinds', async () => {
  const h = openQueue()
  let running = 0
  let peak = 0
  let started = 0
  const gates: ReturnType<typeof createGate>[] = []
  const releaseAll = (): void => {
    for (const gate of gates.splice(0)) gate.open()
  }
  try {
    const handler = async (): Promise<void> => {
      running += 1
      started += 1
      peak = Math.max(peak, running)
      const gate = createGate()
      gates.push(gate)
      await gate.opened
      running -= 1
    }
    h.effects.handle('assessment', handler)
    h.effects.handle('delivery', handler)
    h.effects.handle('return', handler)
    for (let index = 0; index < 3; index += 1) {
      h.effects.enqueue('assessment', `eval-${index}`, { triggerId: `t${index}` })
      h.effects.enqueue('delivery', `ticket-${index}`, { ticketId: `ticket-${index}` })
      h.effects.enqueue('return', `trigger-${index}`, { triggerKey: `k${index}` })
    }
    // 全局并发 4（§J.2 并发行）：9 行里先跑 4 行，与它们属于哪个 kind 无关。
    await until(() => started === 4)
    assert.equal(peak, 4)
    // 每放行一批，队列继续取下一批；直到 9 行全部跑过。
    while (started < 9) {
      const before = started
      releaseAll()
      await until(() => started > before)
    }
    releaseAll()
    await h.effects.idle()
    assert.equal(peak, 4)
    assert.equal(started, 9)
    assert.equal(h.effects.pending('assessment'), false)
    assert.equal(h.effects.pending('delivery'), false)
    assert.equal(h.effects.pending('return'), false)
  } finally {
    h.cleanup()
  }
})

test('relay and notice share one serial router queue: they never write the router terminal at once', async () => {
  const h = openQueue()
  const events: string[] = []
  let inside = 0
  let overlap = false
  const gates: ReturnType<typeof createGate>[] = []
  try {
    const handler = async (label: string): Promise<void> => {
      inside += 1
      if (inside > 1) overlap = true
      events.push(`start ${label}`)
      const gate = createGate()
      gates.push(gate)
      await gate.opened
      events.push(`end ${label}`)
      inside -= 1
    }
    h.effects.handle('relay', async (payload) => handler(`relay ${payload.messageId}`))
    h.effects.handle('notice', async (payload) => handler(`notice ${payload.summary}`))
    // 交替入队：relay、notice、relay、notice。
    h.effects.enqueue('relay', 'router', { messageId: 'r1', kind: 'report', summary: 'a' })
    h.effects.enqueue('notice', 'router', { summary: 'n1' })
    h.effects.enqueue('relay', 'router2', { messageId: 'r2', kind: 'report', summary: 'b' })
    h.effects.enqueue('notice', 'router2', { summary: 'n2' })
    await until(() => events.length > 0)
    // 共用互斥：一次只有一个 router kind 在写终端。等一个开始 → 放行它 → 等它结束，
    // 逐个推进，直到四次写入都完成。
    let startedCount = 0
    while (startedCount < 4) {
      await until(() => events.filter((event) => event.startsWith('start')).length > startedCount)
      startedCount = events.filter((event) => event.startsWith('start')).length
      for (const gate of gates.splice(0)) gate.open()
      await until(() => events.filter((event) => event.startsWith('end')).length >= startedCount)
    }
    await h.effects.idle()
    assert.equal(overlap, false, 'two router writes never overlap')
    assert.equal(events.filter((event) => event.startsWith('end')).length, 4, 'all four writes finished')
    // 两个 kind 各自保序：relay 的 r1 在 r2 之前，notice 的 n1 在 n2 之前。
    const starts = events.filter((event) => event.startsWith('start'))
    assert.deepEqual(starts.filter((event) => event.includes('relay')), ['start relay r1', 'start relay r2'])
    assert.deepEqual(starts.filter((event) => event.includes('notice')), ['start notice n1', 'start notice n2'])
  } finally {
    h.cleanup()
  }
})

test('a failed relay blocks later relays but not notices: failure ordering stays per kind', async () => {
  const h = openQueue()
  const events: string[] = []
  try {
    let failing = true
    h.effects.handle('relay', async (payload) => {
      events.push(`relay ${payload.messageId}`)
      if (failing) throw new Error('router terminal gone')
    })
    h.effects.handle('notice', async (payload) => {
      events.push(`notice ${payload.summary}`)
    })
    h.effects.enqueue('relay', 'router', { messageId: 'first', kind: 'report', summary: 'a' })
    h.effects.enqueue('relay', 'router2', { messageId: 'second', kind: 'report', summary: 'b' })
    h.effects.enqueue('notice', 'router', { summary: 'unrelated' })
    await h.effects.idle()
    // §J.2 末注：共用的是「串行写终端」；失败的挡住的是「后来的同种」。
    assert.deepEqual(events, ['relay first', 'notice unrelated'], 'the second relay waits behind the first')
    failing = false
    h.clock.advance(2000)
    await h.effects.idle()
    assert.deepEqual(events, ['relay first', 'notice unrelated', 'relay first', 'relay second'])
  } finally {
    h.cleanup()
  }
})

test('three consecutive failures of one kind mark its health entry error until one succeeds', async () => {
  const h = openQueue()
  let fail = true
  try {
    h.effects.handle('notice', async () => {
      if (fail) throw new Error('router terminal busy')
    })
    h.effects.enqueue('notice', 'router', { summary: 'prompts saved' })
    await h.effects.idle()
    // 第一次失败：还没到三次，仍是 ready（§J.2「失败即问题」）。
    assert.equal(h.board.all().notice?.state, 'ready')
    h.clock.advance(2000)
    await h.effects.idle()
    assert.equal(h.board.all().notice?.state, 'ready')
    h.clock.advance(4000)
    await h.effects.idle()
    // 第三次连续失败：报 error，detail 带最后错误。
    assert.equal(h.board.all().notice?.state, 'error')
    assert.ok(/waiting 1, failed 1, last error: router terminal busy/.test(h.board.all().notice?.detail ?? ''))

    fail = false
    h.clock.advance(8000)
    await h.effects.idle()
    // 一次成功即清除，行也删掉。
    assert.deepEqual(h.board.all().notice, { state: 'ready', detail: 'waiting 0, failed 0' })
  } finally {
    h.cleanup()
  }
})

test('a Later does not clear or advance the consecutive failure count', async () => {
  const h = openQueue()
  try {
    let throws: 'error' | 'later' = 'error'
    h.effects.handle('return', async () => {
      throw throws === 'error' ? new Error('eval slot busy') : new Later('no slot')
    })
    h.effects.enqueue('return', 'trigger-a', { triggerKey: 'trigger-a' })
    h.effects.enqueue('return', 'trigger-b', { triggerKey: 'trigger-b' })
    await h.effects.idle()
    h.clock.advance(2000)
    await h.effects.idle()
    h.clock.advance(4000)
    await h.effects.idle()
    // 两个 key 各失败三次：health 报 error。
    assert.equal(h.board.all().return?.state, 'error')
    throws = 'later'
    h.clock.advance(8000)
    await h.effects.idle()
    // `Later` 不是成功：error 保持，直到真的有一次成功（§J.2）。
    assert.equal(h.board.all().return?.state, 'error')
  } finally {
    h.cleanup()
  }
})

test('delivery failures are counted but never reported as an error, because the ticket carries them', async () => {
  const h = openQueue()
  try {
    h.effects.handle('delivery', async () => {
      throw new Error('worker terminal gone')
    })
    h.effects.enqueue('delivery', 'ticket-1', { ticketId: 'ticket-1' })
    for (let round = 0; round < 5; round += 1) {
      await h.effects.idle()
      h.clock.advance(60_000)
    }
    // §J.3：`delivery` 的失败不上报健康，写在 Ticket 上；这里只应有计数。
    assert.equal(h.board.all().delivery?.state, 'ready')
    assert.ok(/waiting 1, failed 1/.test(h.board.all().delivery?.detail ?? ''))
  } finally {
    h.cleanup()
  }
})

test('a launch row gives up after three provider failures and reports the exhaustion once', async () => {
  const h = openQueue()
  const exhausted: string[] = []
  try {
    h.effects.handle(
      'launch',
      async () => {
        throw new Error('provider unavailable (503)')
      },
      { exhausted: (key) => exhausted.push(key) }
    )
    h.effects.enqueue('launch', 'ticket-1', { ticketId: 'ticket-1', assignmentId: 'a1' })
    // 5 s → 10 s → 放弃（§J.2：launch 的 provider 失败 5 s→300 s，最多 3 次）。
    await h.effects.idle()
    h.clock.advance(5000)
    await h.effects.idle()
    h.clock.advance(10_000)
    await h.effects.idle()
    assert.deepEqual(exhausted, ['ticket-1'], 'the executor learns the launch will not be retried')
    assert.equal(h.effects.pending('launch'), false)
    // 放弃仍是失败：三次连续失败让 launch 健康报 error。
    assert.equal(h.board.all().launch?.state, 'error')
  } finally {
    h.cleanup()
  }
})

test('paused holds assessment, launch, delivery and reply, and a running launch finishes normally', async () => {
  const h = openQueue()
  const ran: string[] = []
  const gate = createGate()
  try {
    const hold = (kind: string) => async (): Promise<void> => {
      ran.push(kind)
      if (kind === 'launch') await gate.opened
    }
    h.effects.handle('assessment', hold('assessment'))
    h.effects.handle('launch', hold('launch'))
    h.effects.handle('delivery', hold('delivery'))
    h.effects.handle('reply', hold('reply'))
    h.effects.handle('relay', hold('relay'))
    h.effects.handle('notice', hold('notice'))
    h.effects.handle('return', hold('return'))

    // 先在未暂停时起一个 launch，让它停在 handler 里。
    h.effects.enqueue('launch', 'ticket-running', { ticketId: 't-r', assignmentId: 'a-running' })
    await until(() => ran.includes('launch'))
    // 暂停：assessment/delivery/reply 不启动；已经在跑的 launch 继续（§J.2 暂停行）。
    h.controls.pause(true)
    h.effects.enqueue('assessment', 'eval-1', { triggerId: 't1' })
    h.effects.enqueue('delivery', 'ticket-2', { ticketId: 'ticket-2' })
    h.effects.enqueue('reply', 'message-1', { messageId: 'message-1' })
    // relay/notice/return 不在暂停名单里：它们照跑（relay 与 notice 共用串行队列）。
    h.effects.enqueue('relay', 'router', { messageId: 'm1', kind: 'report', summary: 'a' })
    h.effects.enqueue('notice', 'router', { summary: 'n' })
    h.effects.enqueue('return', 'trigger-key', { triggerKey: 'trigger-key' })
    gate.open()
    await until(() => ['relay', 'notice', 'return'].every((kind) => ran.includes(kind)))
    assert.deepEqual(
      ran.filter((kind) => ['assessment', 'delivery', 'reply'].includes(kind)),
      [],
      'the paused kinds did not start'
    )
    // 已在跑的 launch 正常结束（不是被暂停打断，也没有被重新排队）。
    assert.equal(h.effects.pending('launch', 'ticket-running'), false)
    assert.deepEqual(ran.filter((kind) => kind === 'launch'), ['launch'])
    h.controls.pause(false)
    await h.effects.idle()
    assert.deepEqual(
      ran.filter((kind) => ['assessment', 'delivery', 'reply'].includes(kind)).sort(),
      ['assessment', 'delivery', 'reply']
    )
    assert.equal(h.effects.pending('assessment'), false)
    assert.equal(h.effects.pending('delivery'), false)
    assert.equal(h.effects.pending('reply'), false)
  } finally {
    h.cleanup()
  }
})

test('a launch waiting for a worker slot starts only once a slot is free', async () => {
  const h = openQueue({ slots: 1 })
  const ran: string[] = []
  const gate = createGate()
  try {
    h.effects.handle('launch', async (_payload, key) => {
      ran.push(key)
      await gate.opened
    })
    h.effects.enqueue('launch', 'first', { ticketId: 'first', assignmentId: 'a1' })
    h.effects.enqueue('launch', 'second', { ticketId: 'second', assignmentId: 'a2' })
    await until(() => ran.length === 1)
    assert.deepEqual(ran, ['first'], 'only one launch runs while one slot exists')
    gate.open()
    await h.effects.idle()
    // 槽位在夹具里恒为 1：第二行在第一个结束后开始（不是被放弃）。
    assert.deepEqual(ran, ['first', 'second'])
  } finally {
    h.cleanup()
  }
})

test('a handler that defers with Later while paused retries five seconds later and succeeds after resume', async () => {
  const h = openQueue()
  const attempts: number[] = []
  try {
    h.effects.handle('launch', async () => {
      attempts.push(h.clock.now())
      // handler 自己也可以判暂停：这与 limit 为 0 是两条路（§E.6「占不到 → Later」）。
      if (h.board.all().launch?.state !== 'error' && attempts.length === 1) throw new Later('no slot')
    })
    h.effects.enqueue('launch', 'ticket-1', { ticketId: 'ticket-1', assignmentId: 'a1' })
    await h.effects.idle()
    assert.equal(attempts.length, 1)
    h.clock.advance(5000)
    await h.effects.idle()
    assert.equal(attempts.length, 2)
    assert.equal(h.effects.pending('launch'), false)
    // 两次尝试都没有失败计数。
    assert.deepEqual(h.board.all().launch, { state: 'ready', detail: 'waiting 0, failed 0' })
  } finally {
    h.cleanup()
  }
})


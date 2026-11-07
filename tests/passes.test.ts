// 单线程 pass 调度（§C.1 `app/passes.ts`、§N.4 `passes` 行）：
// - 一次 pass 先跑到期的副作用，再做 `evaluateDue`；
// - pass 期间到来的请求合并成一次后续 pass，绝不并发开两个 pass；
// - pass 失败连续三次把健康条目变成 error，一次成功即清除。
//
// 时钟与定时器都是注入的；测试用虚拟时间与手动推进的调度器，绝不 sleep（§P.1）。
import { assert, test } from 'orca/testing'
import { HealthBoard } from '../src/worker/infra/health'
import { PASS_INTERVAL_MS, Passes } from '../src/worker/app/passes'
import type { HealthEntry } from '../src/worker/core/index.ts'
import { createGate, until } from './support/queue'

/** 夹具：记录调用顺序的假 effects/engine、真健康板、手动调度器。`evals` 可选：`evals` 条目的读数。 */
function harness(evals?: () => HealthEntry) {
  const board = new HealthBoard()
  const calls: string[] = []
  const kicks: number[] = []
  const timers: { run: () => void; milliseconds: number }[] = []
  let cancelled = 0
  let idleGate: ReturnType<typeof createGate> | undefined
  let idleCalls = 0
  let evaluateError: Error | undefined
  let idleError: Error | undefined
  let closingAfter: number | undefined

  const effects = {
    kick: () => {
      kicks.push(kicks.length)
    },
    idle: async (): Promise<void> => {
      idleCalls += 1
      calls.push('effects')
      if (idleGate !== undefined) await idleGate.opened
      if (idleError !== undefined) throw idleError
    }
  }
  const engine = {
    evaluateDue: (): void => {
      calls.push('evaluate')
      if (evaluateError !== undefined) throw evaluateError
    }
  }
  const passes = new Passes({
    effects,
    engine,
    health: board,
    closing: () => closingAfter !== undefined && idleCalls >= closingAfter,
    schedule: (run, milliseconds) => {
      const timer = { run, milliseconds }
      timers.push(timer)
      return timer
    },
    cancel: () => {
      cancelled += 1
    },
    ...(evals === undefined ? {} : { evals })
  })
  return {
    board,
    calls,
    kicks,
    timers,
    passes,
    effects,
    engine,
    idleCalls: () => idleCalls,
    holdIdle: (gate: ReturnType<typeof createGate> | undefined) => {
      idleGate = gate
    },
    failEvaluateWith: (error: Error | undefined) => {
      evaluateError = error
    },
    failEffectsWith: (error: Error | undefined) => {
      idleError = error
    },
    closeAfter: (runs: number) => {
      closingAfter = runs
    },
    cancelled: () => cancelled
  }
}

test('the passes entry starts as starting and turns ready only after a pass succeeds', async () => {
  const h = harness()
  // §J.3 的四档：刚 claim、还没有报告过时是 `starting`，不是假就绪。
  assert.deepEqual(h.board.all().passes, { state: 'starting', detail: 'not run yet' })
  h.passes.request()
  await h.passes.idle()
  assert.deepEqual(h.board.all().passes, { state: 'ready', detail: 'ready' })
})

test('a pass runs the due effects first and then the due evaluations', async () => {
  const h = harness()
  h.passes.request()
  await h.passes.idle()
  // 顺序：先请求一次 effect 派发并等它跑完，再让引擎处理到期的 Eval（§C.1「先 due effects」）。
  assert.deepEqual(h.calls, ['effects', 'evaluate'])
  assert.equal(h.kicks.length, 1, 'the pass kicked the effect queue')
})

test('two requests do not run two passes in parallel: the second waits and becomes one follow-up', async () => {
  const h = harness()
  const gate = createGate()
  h.holdIdle(gate)
  h.passes.request()
  await until(() => h.idleCalls() === 1)
  // pass 进行中又来了两个请求：不会开第二个 pass，只记一次「再来一轮」。
  h.passes.request()
  h.passes.request()
  assert.equal(h.idleCalls(), 1, 'still one pass in flight')
  gate.open()
  await h.passes.idle()
  // 第一轮 + 恰好一次后续 pass（两个请求合并）。
  assert.equal(h.idleCalls(), 2)
  assert.deepEqual(h.calls, ['effects', 'evaluate', 'effects', 'evaluate'])
})

test('a request after a pass finished starts a new pass immediately', async () => {
  const h = harness()
  h.passes.request()
  await h.passes.idle()
  h.passes.request()
  await h.passes.idle()
  assert.equal(h.idleCalls(), 2)
  assert.deepEqual(h.calls, ['effects', 'evaluate', 'effects', 'evaluate'])
})

test('three consecutive pass failures mark the health entry error, and one success clears it', async () => {
  const h = harness()
  h.failEvaluateWith(new Error('database is locked'))
  for (let round = 0; round < 3; round += 1) {
    h.passes.request()
    await h.passes.idle()
  }
  // §N.4：`passes` 条目报「上一轮 pass 是否失败（连续 3 次 → error）」。
  assert.equal(h.board.all().passes?.state, 'error')
  assert.ok(/pass failed.*database is locked/.test(h.board.all().passes?.detail ?? ''))

  h.failEvaluateWith(undefined)
  h.passes.request()
  await h.passes.idle()
  assert.deepEqual(h.board.all().passes, { state: 'ready', detail: 'ready' })
})

test('a failure of the effect queue during a pass is a failed pass too', async () => {
  const h = harness()
  h.failEffectsWith(new Error('effect table is locked'))
  h.passes.request()
  await h.passes.idle()
  assert.equal(h.board.all().passes?.state, 'ready', 'one failure is below the threshold')
  assert.ok(/effect table is locked/.test(h.board.all().passes?.detail ?? ''))
  h.passes.request()
  await h.passes.idle()
  h.passes.request()
  await h.passes.idle()
  assert.equal(h.board.all().passes?.state, 'error')
})

test('starting the loop schedules a pass every two seconds and stopping cancels it', async () => {
  const h = harness()
  h.passes.start()
  h.passes.start()
  // 幂等：重复 start 不叠加定时器。
  assert.equal(h.timers.length, 1)
  assert.equal(h.timers[0]?.milliseconds, PASS_INTERVAL_MS)
  assert.equal(PASS_INTERVAL_MS, 2000)
  // 定时器到点 = 一次 pass 请求。
  h.timers[0]?.run()
  await h.passes.idle()
  assert.equal(h.idleCalls(), 1)
  await h.passes.stop()
  assert.equal(h.cancelled(), 1)
  // 停下之后到点的定时器不再开 pass（同一份 run 也不会被调用，因为已被取消）。
  h.passes.request()
  await h.passes.idle()
  assert.equal(h.idleCalls(), 1, 'a stopped scheduler starts no pass')
})

test('a request arriving while the follow-up pass runs becomes another follow-up, never a parallel pass', async () => {
  const h = harness()
  const first = createGate()
  h.holdIdle(first)
  h.passes.request()
  await until(() => h.idleCalls() === 1)
  h.passes.request()
  // 第一轮放行后开始后续 pass；再放行它，观察第二轮。
  first.open()
  await until(() => h.idleCalls() === 2)
  h.passes.request()
  await h.passes.idle()
  // 三轮总是串行：每一轮的 evaluate 都在同一轮的 effects 之后（§C.1 单线程）。
  assert.deepEqual(h.calls, ['effects', 'evaluate', 'effects', 'evaluate', 'effects', 'evaluate'])
  assert.equal(h.idleCalls(), 3)
})

test('a pass that fails does not stop later passes from running, and the health entry says which one failed', async () => {
  const h = harness()
  h.failEvaluateWith(new Error('engine unavailable'))
  h.passes.request()
  await h.passes.idle()
  assert.equal(h.board.all().passes?.state, 'ready', 'one failure is below the threshold')
  assert.ok(/pass failed after 1 attempt: engine unavailable/.test(h.board.all().passes?.detail ?? ''))
  h.failEvaluateWith(undefined)
  h.passes.request()
  await h.passes.idle()
  assert.deepEqual(h.board.all().passes, { state: 'ready', detail: 'ready' })
})

test('closing stops a pass before it evaluates, leaving the effects it already ran', async () => {
  const h = harness()
  h.closeAfter(1)
  h.passes.request()
  await h.passes.idle()
  // 关停判定在 effect 之后、评估之前：这一轮不再 evaluateDue。
  assert.deepEqual(h.calls, ['effects'])
  // 关停不是失败（不报 error），但这一轮没做完：条目说 `paused`（§J.3 四档）。
  assert.deepEqual(h.board.all().passes, { state: 'paused', detail: 'closing' })
})

test('the evals entry reports the unresolved unavailable count on every pass (§N.4)', async () => {
  let reading: HealthEntry = { state: 'ready', detail: 'unavailable 2 in the last hour' }
  const h = harness(() => reading)
  // 条目在构造时占住：第一次读数之前是 `starting`（还没跑过一轮）。
  assert.deepEqual(h.board.all().evals, { state: 'starting', detail: 'not counted yet' })
  h.passes.request()
  await h.passes.idle()
  assert.deepEqual(h.board.all().evals, reading, 'the entry follows the read model after the pass')
  // 读模型变了：下一次 pass 跟着变（不是缓存）。
  reading = { state: 'ready', detail: 'unavailable 0 in the last hour' }
  h.passes.request()
  await h.passes.idle()
  assert.deepEqual(h.board.all().evals, reading)
  // 一轮失败不刷新这个读数：`passes` 自己报错，上一次已知的读数留着。
  h.failEvaluateWith(new Error('database is locked'))
  reading = { state: 'ready', detail: 'unavailable 9 in the last hour' }
  h.passes.request()
  await h.passes.idle()
  assert.deepEqual(h.board.all().evals, { state: 'ready', detail: 'unavailable 0 in the last hour' })
})

test('without a reader the scheduler claims no evals entry', () => {
  const h = harness()
  assert.deepEqual(h.board.claimed(), ['passes'], 'this scheduler is the writer of passes only')
})

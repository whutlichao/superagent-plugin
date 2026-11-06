// 状态栏项（§N.7）：文本与语气由待人工计数与健康决定；更新最多每两秒一次，值未变不发。
// 纯逻辑 + 注入的时钟与定时器，因此测试用虚拟时间推进，不 sleep（§P.1 第 4 条）。
// 状态栏文本是设计给死的四种（`Superagent` / `Superagent 3` / `Superagent paused` /
// `Superagent error`）——worker 侧拿不到宿主的 UI 语言，所以它们不跟 `copy.ts` 走。
import { assert, test } from 'orca/testing'
import type { PanelState } from '../src/panel/protocol'
import { createStatusBarPublisher, statusBarView, STATUS_BAR_ID } from '../src/worker/app/status-bar'

/** 一份最小的快照；只关心状态栏读到的字段。 */
function state(overrides: {
  answer?: number
  review?: number
  problems?: number
  paused?: boolean
  error?: boolean
}): PanelState {
  return {
    revision: 1,
    booted: true,
    health: {
      error: overrides.error ?? false,
      paused: overrides.paused ?? false,
      setupMissing: false,
      activity: { received: 0, evaluated: 0, accepted: 0, ignored: 0, ended: 0 },
      executor: { running: 0, maxWorkers: 4 }
    },
    attention: {
      answer: overrides.answer ?? 0,
      review: overrides.review ?? 0,
      problems: overrides.problems ?? 0,
      items: []
    }
  }
}

test('the four texts of the design, with the tone each one maps to', () => {
  assert.deepEqual(statusBarView(state({})), {
    text: 'Superagent',
    tone: 'success',
    tooltip: '0 awaiting answer · 0 awaiting review · 0 problems'
  })
  assert.equal(statusBarView(state({ answer: 2, review: 1 })).text, 'Superagent 3')
  assert.equal(statusBarView(state({ answer: 2, review: 1 })).tone, 'warning')
  assert.equal(statusBarView(state({ paused: true })).text, 'Superagent paused')
  assert.equal(statusBarView(state({ paused: true })).tone, 'neutral')
  assert.equal(statusBarView(state({ error: true })).text, 'Superagent error')
  assert.equal(statusBarView(state({ error: true })).tone, 'danger')
})

test('an error outranks a pause, and a pause outranks the waiting count', () => {
  assert.equal(statusBarView(state({ error: true, paused: true, answer: 5 })).text, 'Superagent error')
  assert.equal(statusBarView(state({ paused: true, answer: 5 })).text, 'Superagent paused')
  // 计数仍在 tooltip 里分项给出，暂停/出错也不藏起来。
  assert.equal(
    statusBarView(state({ paused: true, answer: 5, review: 2, problems: 1 })).tooltip,
    '5 awaiting answer · 2 awaiting review · 1 problem'
  )
})

test('the tooltip breaks the count down by what the person has to do', () => {
  assert.equal(
    statusBarView(state({ answer: 2, review: 1, problems: 1 })).tooltip,
    '2 awaiting answer · 1 awaiting review · 1 problem'
  )
})

test('the item keeps the manifest id', () => {
  assert.equal(STATUS_BAR_ID, 'superagent')
})

/** 一台假时钟 + 假定时器：手动推进，不 sleep。 */
function fakeTimers(): {
  readonly now: () => number
  readonly schedule: (fn: () => void, ms: number) => unknown
  readonly cancel: (handle: unknown) => void
  readonly advance: (ms: number) => void
  readonly pending: () => number
} {
  let clock = 0
  let next = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => clock,
    schedule: (fn, ms) => {
      next += 1
      timers.set(next, { at: clock + ms, fn })
      return next
    },
    cancel: (handle) => {
      timers.delete(handle as number)
    },
    advance: (ms) => {
      clock += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at <= clock) {
          timers.delete(id)
          timer.fn()
        }
      }
    },
    pending: () => timers.size
  }
}

test('sends at most once every two seconds, and only when the value changed', () => {
  const timers = fakeTimers()
  const sent: string[] = []
  const publisher = createStatusBarPublisher({
    send: (next) => sent.push(next.text ?? ''),
    now: timers.now,
    schedule: timers.schedule,
    cancel: timers.cancel
  })
  publisher.publish(statusBarView(state({})))
  assert.deepEqual(sent, ['Superagent'], 'the first value goes at once')

  publisher.publish(statusBarView(state({})))
  assert.deepEqual(sent, ['Superagent'], 'an unchanged value is not sent')

  publisher.publish(statusBarView(state({ answer: 1 })))
  assert.deepEqual(sent, ['Superagent'], 'a change inside the window waits')

  timers.advance(1999)
  assert.deepEqual(sent, ['Superagent'], 'still inside the two seconds')
  timers.advance(1)
  assert.deepEqual(sent, ['Superagent', 'Superagent 1'], 'goes when the window opens')
  assert.equal(timers.pending(), 0, 'the timer is not rescheduled')

  timers.advance(5000)
  publisher.publish(statusBarView(state({ answer: 1 })))
  assert.deepEqual(sent, ['Superagent', 'Superagent 1'], 'nothing to send after the window')
})

test('coalesces several changes inside one window into the newest value', () => {
  const timers = fakeTimers()
  const sent: string[] = []
  const publisher = createStatusBarPublisher({
    send: (next) => sent.push(next.text ?? ''),
    now: timers.now,
    schedule: timers.schedule,
    cancel: timers.cancel
  })
  publisher.publish(statusBarView(state({})))
  publisher.publish(statusBarView(state({ answer: 1 })))
  publisher.publish(statusBarView(state({ answer: 2 })))
  publisher.publish(statusBarView(state({ answer: 3 })))
  assert.deepEqual(sent, ['Superagent'])
  assert.equal(timers.pending(), 1, 'one timer for the window, not one per change')
  timers.advance(2000)
  assert.deepEqual(sent, ['Superagent', 'Superagent 3'], 'only the newest value is sent')
})

test('a value that returns to the last sent one before the window opens sends nothing', () => {
  const timers = fakeTimers()
  const sent: string[] = []
  const publisher = createStatusBarPublisher({
    send: (next) => sent.push(next.text ?? ''),
    now: timers.now,
    schedule: timers.schedule,
    cancel: timers.cancel
  })
  publisher.publish(statusBarView(state({})))
  publisher.publish(statusBarView(state({ answer: 1 })))
  publisher.publish(statusBarView(state({})))
  timers.advance(2000)
  assert.deepEqual(sent, ['Superagent'], 'no update for a value nobody would see change')
})

test('the interval is two seconds by default and configurable for tests', () => {
  const timers = fakeTimers()
  const sent: string[] = []
  const publisher = createStatusBarPublisher({
    send: (next) => sent.push(next.text ?? ''),
    now: timers.now,
    schedule: timers.schedule,
    cancel: timers.cancel,
    intervalMs: 100
  })
  publisher.publish(statusBarView(state({})))
  publisher.publish(statusBarView(state({ answer: 1 })))
  timers.advance(100)
  assert.deepEqual(sent, ['Superagent', 'Superagent 1'])
})

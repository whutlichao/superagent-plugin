// 状态栏项（§N.7）：文本与语气由待人工计数与健康决定；更新最多每两秒一次，值未变不发。
// 纯逻辑 + 注入的时钟与定时器，因此测试用虚拟时间推进，不 sleep（§P.1 第 4 条）。
// 状态栏文本是设计给死的四种（`Superagent` / `Superagent 3` / `Superagent paused` /
// `Superagent error`）——worker 侧拿不到宿主的 UI 语言，所以它们不跟 `copy.ts` 走。
import { assert, test } from 'orca/testing'
import type { PanelState } from '../src/panel/protocol'
import { createStatusBarPublisher, statusBarView, STATUS_BAR_ID } from '../src/worker/app/status-bar'
import { emptyState } from '../src/worker/app/state-source'
import { readAttentionCounts } from '../src/worker/app/views/attention'
import { healthSummary } from '../src/worker/http/state'
import { HealthBoard } from '../src/worker/infra/health'
import { readRepoJson } from './support/repo'
import { AT, openTempStore } from './support/state'

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
  readonly schedule: (fn: () => void, ms: number) => { readonly id: number }
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
      return { id: next }
    },
    cancel: (handle) => {
      timers.delete((handle as { readonly id: number }).id)
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

// ---------------------------------------------------------------- 真实读数与惰性点击

/** 清单里的状态栏项与命令（独立真相：宿主拿到的就是这份 JSON）。 */
interface StatusBarManifest {
  readonly contributes: {
    readonly statusBarItems: readonly { readonly id: string; readonly command?: string }[]
    readonly commands: readonly { readonly id: string }[]
  }
}

test('the status bar item has no command: a click is inert (approved deviation from §N.7)', () => {
  // 协调者裁决（#45）：§N.7 原本让点击跑 `superagent.pause`，但状态栏常驻在标题栏上，
  // 误点会暂停整个处理。宿主没有「只读/打开面板」的点击动作可挂，所以宁可不挂，
  // 也不新增一个为了有得点而存在的破坏性命令。暂停仍在命令面板里（下一行断言）。
  // DOC2（#50）负责把设计文本改成同口径。
  const manifest = readRepoJson<StatusBarManifest>('orca-plugin.json')
  const item = manifest.contributes.statusBarItems[0]
  assert.ok(item !== undefined, 'the manifest contributes one status bar item')
  assert.equal(item.id, 'superagent')
  assert.equal('command' in item, false, 'no click action at all')
  assert.equal(item.command, undefined)
  assert.ok(
    manifest.contributes.commands.some((command) => command.id === 'superagent.pause'),
    'pause stays available in the command palette'
  )
})

test('the count comes from the real store tickets, not the shell stub zeros', () => {
  const { store, cleanup } = openTempStore()
  try {
    const base = {
      inputs: [],
      undelivered: [],
      assignments: [],
      channels: [],
      title: 'a ticket',
      decisionId: 'decision-1',
      mandate: {},
      budget: undefined,
      createdAt: AT,
      updatedAt: AT,
      origin: { triggerId: 'trigger-1', triggerIds: ['trigger-1'] }
    }
    // 一个等人回答的 Ticket。
    store.tickets.put({
      id: 'ticket-answer',
      at: AT,
      body: { ...base, attention: { id: 'attention-1', question: 'Which repo?', at: AT } }
    })
    // 一个最近报告是 ready、等评审的 Ticket。
    store.tickets.put({
      id: 'ticket-review',
      at: AT,
      body: {
        ...base,
        assignments: [
          {
            id: 'assignment-1',
            state: 'running',
            createdAt: AT,
            report: { state: 'ready', summary: 'done', at: AT }
          }
        ]
      }
    })
    // 一个还在工作中：不算待人工。
    store.tickets.put({ id: 'ticket-working', at: AT, body: base })
    // 已结束的 Ticket 即使留着 attention 也不算。
    store.tickets.put({
      id: 'ticket-ended',
      at: AT,
      body: {
        ...base,
        attention: { id: 'attention-2', question: 'stale?', at: AT },
        ended: { at: AT, by: 'person', outcome: 'dropped' }
      }
    })

    const counts = readAttentionCounts(store)
    assert.deepEqual(counts, { answer: 1, review: 1 })
    const shell = emptyState()
    const view = statusBarView({
      ...shell,
      attention: { ...shell.attention, ...counts }
    })
    assert.equal(view.text, 'Superagent 2')
    assert.equal(view.tone, 'warning', 'waiting for a person is a warning tone, not an error')
    assert.equal(view.tooltip, '1 awaiting answer · 1 awaiting review · 0 problems')
  } finally {
    cleanup()
  }
})

test('the problem count in the tooltip is the real health problem count', () => {
  const board = new HealthBoard()
  board.claim('runtime', { state: 'ready', detail: 'loopback api on 127.0.0.1:3847' })
  board.claim('github', { state: 'error', detail: 'poll failed 3 times' })
  board.claim('feishu', { state: 'error', detail: 'event stream closed' })
  const summary = healthSummary(
    Object.fromEntries(
      Object.entries(board.all()).map(([name, entry]) => [name, { ...entry, at: AT }])
    )
  )
  assert.equal(summary.problems, 2)
  const shell = emptyState()
  const view = statusBarView({
    ...shell,
    health: { ...shell.health, error: summary.error },
    attention: { ...shell.attention, problems: summary.problems }
  })
  assert.equal(view.text, 'Superagent error')
  assert.equal(view.tone, 'danger')
  assert.equal(view.tooltip, '0 awaiting answer · 0 awaiting review · 2 problems')
})

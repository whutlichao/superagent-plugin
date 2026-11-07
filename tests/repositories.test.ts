// `Repositories` 的 SQLite 实现（§D.2、§D.4）：领域对象 ↔ 表行的映射、生成列的存储形态、
// 时间线写入与确定性读序。真库 + 临时目录（§P.1），只经领域端口观察行为。
import { assert, test } from 'orca/testing'
import type { Decision, Thread, Ticket, Trigger } from '../src/worker/core/index.ts'
import { createRepositories } from '../src/worker/app/repositories'
import { AT, openTempStore } from './support/state'

/** 一条 GitHub 评论 Trigger：两条 Thread（primary + 语境）。 */
function trigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: 'gh-comment-1',
    source: 'github',
    threads: [
      { source: 'github', id: '42' },
      { source: 'github', id: '42/rt/7' }
    ],
    actor: { source: 'github', id: 'alice' },
    human: true,
    addressed: 'mention',
    at: AT,
    text: '@agent please fix the login flow',
    url: 'https://github.com/acme/widgets/issues/42#issuecomment-1',
    channel: { source: 'github', thread: 'github:42', address: { repo: 'acme/widgets', issue: '42' } },
    meta: { repository: 'acme/widgets', issue: 42 },
    ...overrides
  }
}

/** 一个未结束的 Ticket。 */
function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 'ticket-1',
    title: 'Fix the login flow',
    decisionId: 'decision-1',
    mandate: {
      strength: 'explicit',
      policyVersion: 'v1',
      basis: { via: 'addressed', addressed: 'mention' },
      actor: { source: 'github', id: 'alice' },
      scope: 'ticket'
    },
    channels: [],
    assignments: [
      { id: 'asg-1', state: 'running', createdAt: AT, startedAt: AT, terminalId: 'term_1' }
    ],
    inputs: [],
    undelivered: [],
    createdAt: AT,
    updatedAt: AT,
    origin: { triggerId: 'gh-comment-1', triggerIds: ['gh-comment-1'] },
    ...overrides
  }
}

/** 一个 Thread 聚合。 */
function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    key: 'github:42',
    ref: { source: 'github', id: '42' },
    createdAt: AT,
    lastAt: AT,
    subscriptions: [],
    correlated: [],
    pending: [],
    meta: { label: 'Issue #42' },
    ...overrides
  }
}

test('a trigger round-trips through the columns and its body, and lands on the timeline', () => {
  const { store, cleanup } = openTempStore()
  try {
    const repo = createRepositories(store)
    repo.atomic(() => {
      repo.triggers.save(trigger())
      repo.triggers.save(trigger({ id: 'gh-comment-2', at: '2026-11-07T03:27:00.000Z' }))
    })
    assert.deepEqual(repo.triggers.get('gh-comment-1'), trigger())
    assert.deepEqual(
      repo.triggers.byThread('github:42').map((item) => item.id),
      ['gh-comment-1', 'gh-comment-2'],
      'the timeline is ordered by (at, id)'
    )
    // `trigger_thread` 由 `triggers.save` 写入：primary 是 threads[0]。
    const page = store.triggerThreads.timeline('github:42/rt/7')
    assert.deepEqual(page.items.map((item) => item.triggerId), ['gh-comment-1', 'gh-comment-2'])
    assert.equal(page.items[0]?.primaryThread, false)
    assert.deepEqual(
      store.triggerThreads
        .timeline('github:42')
        .items.map((item) => ({ id: item.triggerId, primary: item.primaryThread })),
      [
        { id: 'gh-comment-1', primary: true },
        { id: 'gh-comment-2', primary: true }
      ]
    )
  } finally {
    cleanup()
  }
})

test('a disposition keeps its filtered reason code, fanout list and handbacks', () => {
  const { store, cleanup } = openTempStore()
  try {
    const repo = createRepositories(store)
    repo.atomic(() => {
      repo.triggers.save(trigger())
      repo.triggers.saveDisposition('gh-comment-1', {
        filtered: { code: 'not_addressed' },
        fanout: ['ticket-1'],
        context: ['ticket-2'],
        handbacks: [{ ticketId: 'ticket-1', reason: 'out of scope', at: AT }],
        acked: ['ticket-1'],
        at: AT
      })
    })
    assert.deepEqual(repo.triggers.disposition('gh-comment-1'), {
      filtered: { code: 'not_addressed' },
      fanout: ['ticket-1'],
      context: ['ticket-2'],
      handbacks: [{ ticketId: 'ticket-1', reason: 'out of scope', at: AT }],
      acked: ['ticket-1'],
      at: AT
    })
    // 再次写入只更新同一行（disposition 与 trigger 一对一）。
    repo.atomic(() => {
      repo.triggers.saveDisposition('gh-comment-1', { fanout: [], at: AT })
    })
    assert.equal(repo.triggers.disposition('gh-comment-1')?.filtered, undefined)
  } finally {
    cleanup()
  }
})

test('a thread keeps domain subscriptions and fills the generated columns from the stored form', () => {
  const { store, cleanup } = openTempStore()
  try {
    const repo = createRepositories(store)
    const saved = thread({
      subscriptions: ['ticket-1', 'ticket-2'],
      pending: ['gh-comment-1'],
      evaluating: {
        id: 'eval-1',
        threadKey: 'github:42',
        triggerIds: ['gh-comment-1'],
        strength: 'explicit',
        actor: { source: 'github', id: 'alice' },
        basis: { via: 'addressed', addressed: 'mention' },
        policyVersion: 'v1',
        startedAt: AT,
        deadline: '2026-11-07T03:27:00.000Z'
      }
    })
    repo.atomic(() => repo.threads.save(saved))
    assert.deepEqual(repo.threads.get('github:42'), saved)
    assert.equal(store.threads.flags('github:42')?.active, true, 'thread_active follows the stored projections')
    assert.equal(store.threads.flags('github:42')?.subscribed, true, 'thread_subscribed follows the domain list')
    assert.deepEqual(
      repo.threads.active().map((item) => item.key),
      ['github:42'],
      'active() means pending or evaluating'
    )
    repo.atomic(() =>
      repo.threads.save(thread({ subscriptions: [], pending: [], evaluating: undefined }))
    )
    assert.equal(store.threads.flags('github:42')?.active, false)
    assert.equal(store.threads.flags('github:42')?.subscribed, false)
    assert.deepEqual(repo.threads.active(), [])
  } finally {
    cleanup()
  }
})

test('a ticket round-trips, lists newest first and reports open/active with domain semantics', () => {
  const { store, cleanup } = openTempStore()
  try {
    const repo = createRepositories(store)
    const ended = ticket({
      id: 'ticket-0',
      createdAt: '2026-11-07T03:25:00.000Z',
      assignments: [{ id: 'asg-0', state: 'ended', createdAt: AT }],
      ended: { at: AT, by: 'executor', outcome: 'completed' }
    })
    repo.atomic(() => {
      repo.tickets.save(ended)
      repo.tickets.save(ticket())
    })
    assert.deepEqual(repo.tickets.get('ticket-1'), ticket())
    assert.deepEqual(repo.tickets.list().map((item) => item.id), ['ticket-1', 'ticket-0'])
    assert.deepEqual(repo.tickets.open().map((item) => item.id), ['ticket-1'])
    assert.deepEqual(repo.tickets.active().map((item) => item.id), ['ticket-1'])
    // 负载计数读 `assignments[#-1].state`，领域形态正好是它要的。
    assert.deepEqual(store.assignmentCounts(), { running: 1, queued: 0 })
    // 投递失败的 Ticket 仍是活跃的（`undelivered` 非空）。
    repo.atomic(() =>
      repo.tickets.save(
        ticket({
          id: 'ticket-2',
          createdAt: '2026-11-07T03:28:00.000Z',
          assignments: [{ id: 'asg-2', state: 'ended', createdAt: AT }],
          undelivered: ['input-1']
        })
      )
    )
    assert.deepEqual(repo.tickets.active().map((item) => item.id).sort(), ['ticket-1', 'ticket-2'])
  } finally {
    cleanup()
  }
})

test('a decision round-trips and reads back in (at, id) order per thread', () => {
  const { store, cleanup } = openTempStore()
  try {
    const repo = createRepositories(store)
    const accept: Decision = {
      id: 'decision-1',
      evalId: 'eval-1',
      threadKey: 'github:42',
      triggerIds: ['gh-comment-1'],
      policyVersion: 'v1',
      at: AT,
      kind: 'accept',
      reason: [{ code: 'said', values: { text: 'requested' } }],
      strength: 'explicit',
      ticketId: 'ticket-1',
      mandate: ticket().mandate
    }
    repo.atomic(() => {
      repo.decisions.save(accept)
      repo.decisions.save({
        ...accept,
        id: 'decision-2',
        at: '2026-11-07T03:24:00.000Z',
        kind: 'ignore',
        reason: [{ code: 'not_addressed' }]
      })
      repo.decisions.save({ ...accept, id: 'decision-3', threadKey: 'github:99' })
    })
    assert.deepEqual(repo.decisions.get('decision-1'), accept)
    assert.deepEqual(
      repo.decisions.byThread('github:42').map((item) => item.id),
      ['decision-2', 'decision-1']
    )
  } finally {
    cleanup()
  }
})

test('a failed transaction leaves no row behind', () => {
  const { store, cleanup } = openTempStore()
  try {
    const repo = createRepositories(store)
    assert.throws(() =>
      repo.atomic(() => {
        repo.triggers.save(trigger())
        throw new Error('rolled back')
      })
    )
    assert.equal(repo.triggers.get('gh-comment-1'), undefined)
    assert.deepEqual(store.triggerThreads.timeline('github:42').items, [])
  } finally {
    cleanup()
  }
})

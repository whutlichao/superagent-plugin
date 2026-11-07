// 保留策略基线（§D.2 要点 5–6）：
// - 阈值边界：Trigger/Disposition/Decision 90 天，已结算 Outbox 30 天；
// - 未结束 Ticket 与其 Thread 永不清理：落在它视野里的 Trigger/Decision 也不删（#63）；
// - 删除前写健康明细（`pruned: …`），不静默。
import { assert, test } from 'orca/testing'
import { DEFAULT_RETENTION, isoDaysBefore, prune, pruneDue, PRUNE_INTERVAL_MS } from '../src/worker/app/retention'
import {
  LAST_PRUNE_KEY,
  PROMPT_REVISION_KEY,
  SETTINGS_REVISION_KEY,
  promptVersionKey,
  settingsVersionKey
} from '../src/worker/app/kv'
import { outboxSettled } from '../src/worker/app/retention-sql'
import { AT, isoDaysAfter, openTempStore } from './support/state'

/**
 * 造一条 Trigger + Disposition + Trigger–Thread + Decision 的完整记录。
 * `thread` 是它挂的 Thread（默认 `github:1`），`decision: false` 时不给它 Decision。
 */
function seedTrigger(
  store: ReturnType<typeof openTempStore>['store'],
  id: string,
  at: string,
  extra: { readonly thread?: string; readonly decision?: boolean } = {}
): void {
  const thread = extra.thread ?? 'github:1'
  store.triggers.insert({
    id,
    source: 'github',
    at,
    actor: { source: 'github', id: 'alice' },
    human: true,
    addressed: 'mention',
    text: `text of ${id}`,
    url: null,
    body: { id }
  })
  store.dispositions.put({
    triggerId: id,
    filtered: null,
    evalId: `eval-${id}`,
    decisionId: extra.decision === false ? null : `decision-${id}`,
    requeuedAt: null,
    body: {}
  })
  store.triggerThreads.link({ threadKey: thread, at, triggerId: id, human: true, primaryThread: false })
  if (extra.decision !== false) {
    store.decisions.put({
      id: `decision-${id}`,
      threadKey: thread,
      at,
      kind: 'ignore',
      body: { reason: 'not-a-request' }
    })
  }
}

/** 造一条 Outbox 行（结算时刻可指定）。 */
function seedOutbox(
  store: ReturnType<typeof openTempStore>['store'],
  id: string,
  status: 'pending' | 'sent' | 'dropped',
  settledAt: string | null
): void {
  store.outbox.put({
    id,
    ticketId: null,
    channel: 'github:1',
    status,
    body: { text: id },
    settledAt,
    droppedAt: status === 'dropped' ? settledAt : null,
    droppedReason: status === 'dropped' ? 'gone' : null
  })
}

test('the baseline keeps ninety days and thirty days for settled outbox', () => {
  assert.deepEqual(DEFAULT_RETENTION, { days: 90, outboxDays: 30 })
  assert.equal(PRUNE_INTERVAL_MS, 24 * 60 * 60 * 1000)
  assert.equal(isoDaysBefore('2026-11-07T03:26:00.000Z', 90), '2026-08-09T03:26:00.000Z')
})

test('anything older than the threshold is deleted and everything newer stays', () => {
  const { store, cleanup } = openTempStore()
  try {
    const now = new Date(AT)
    const justInside = isoDaysBefore(AT, DEFAULT_RETENTION.days - 1)
    const justOutside = isoDaysBefore(AT, DEFAULT_RETENTION.days + 1)
    seedTrigger(store, 'old', justOutside)
    seedTrigger(store, 'new', justInside)

    const result = prune(store, { now: () => now })
    assert.deepEqual(result.pruned, {
      triggers: 1,
      dispositions: 1,
      triggerThreads: 1,
      decisions: 1,
      outbox: 0,
      versionSnapshots: 0
    })
    assert.equal(result.cutoff, isoDaysBefore(AT, DEFAULT_RETENTION.days))
    assert.deepEqual(
      store.triggers.byTime().map((trigger) => trigger.id),
      ['new'],
      'the boundary is exclusive: a row inside the window is kept'
    )
    assert.equal(store.dispositions.get('old'), null, 'disposition follows the cascade')
    assert.deepEqual(store.decisions.byThread('github:1').map((decision) => decision.id), ['decision-new'])
  } finally {
    cleanup()
  }
})

test('settled outbox goes after thirty days while pending outbox never does', () => {
  const { store, cleanup } = openTempStore()
  try {
    seedOutbox(store, 'sent-old', 'sent', isoDaysAfter(AT, -31))
    seedOutbox(store, 'sent-new', 'sent', isoDaysAfter(AT, -29))
    seedOutbox(store, 'dropped-old', 'dropped', isoDaysAfter(AT, -31))
    seedOutbox(store, 'pending-old', 'pending', null)
    // 一条 100 天前创建但至今 pending 的消息：状态是唯一依据，绝不按创建时间删。
    const result = prune(store, { now: () => new Date(AT) })
    assert.equal(result.pruned.outbox, 2)
    assert.equal(store.outbox.get('sent-old'), null)
    assert.equal(store.outbox.get('dropped-old'), null)
    assert.ok(store.outbox.get('sent-new'))
    assert.ok(store.outbox.get('pending-old'), 'pending outbox is never pruned')
  } finally {
    cleanup()
  }
})

test('unfinished tickets, their threads and what sits on them are never pruned', () => {
  const { store, cleanup } = openTempStore()
  try {
    const ancient = isoDaysAfter(AT, -365)
    // 一个一年前创建、至今未结束的 Ticket 及其 Thread，连同它的 inputs 与 assignment。
    store.tickets.put({
      id: 'ticket-live',
      at: ancient,
      body: { inputs: [{ id: 'input-1' }], execution: { assignment: { state: 'running' } } }
    })
    // 订阅集合的两种元素形态都认（读模型 `threadFrom` 也两种都认）。
    store.threads.put({
      key: 'github:1',
      source: 'github',
      meta: {},
      body: { eval: { id: 'eval-1' }, subscriptions: [{ ticketId: 'ticket-live' }] }
    })
    seedTrigger(store, 'old-trigger', ancient)

    const result = prune(store, { now: () => new Date(AT) })
    assert.deepEqual(
      result.pruned,
      { triggers: 0, dispositions: 0, triggerThreads: 0, decisions: 0, outbox: 0, versionSnapshots: 0 },
      'the trigger on an unfinished ticket’s thread is exempt, so nothing is deleted'
    )
    assert.ok(store.tickets.get('ticket-live'), 'the unfinished ticket stays')
    assert.equal(store.tickets.get('ticket-live')?.open, true)
    assert.ok(store.threads.get('github:1'), 'its thread stays')
    assert.ok(store.triggers.get('old-trigger'), 'the only trigger on that thread stays')
    assert.ok(store.dispositions.get('old-trigger'), 'its disposition stays')
    assert.deepEqual(
      store.triggerThreads.timeline('github:1').items.map((item) => item.triggerId),
      ['old-trigger'],
      'its trigger_thread row stays'
    )
    assert.deepEqual(
      store.decisions.byThread('github:1').map((decision) => decision.id),
      ['decision-old-trigger'],
      'the decision on that thread stays'
    )
  } finally {
    cleanup()
  }
})

test('the same ancient rows are pruned once the thread has no unfinished ticket left', () => {
  const { store, cleanup } = openTempStore()
  try {
    const ancient = isoDaysAfter(AT, -100)
    store.tickets.put({
      id: 'ticket-done',
      at: isoDaysAfter(AT, -150),
      body: { ended: { at: isoDaysAfter(AT, -120), by: 'human', outcome: 'stopped' } }
    })
    store.threads.put({
      key: 'github:1',
      source: 'github',
      meta: {},
      body: { subscriptions: ['ticket-done'] }
    })
    seedTrigger(store, 'old', ancient)

    const result = prune(store, { now: () => new Date(AT) })
    assert.deepEqual(result.pruned, {
      triggers: 1,
      dispositions: 1,
      triggerThreads: 1,
      decisions: 1,
      outbox: 0,
      versionSnapshots: 0
    })
    assert.equal(store.triggers.get('old'), null, 'an ended ticket does not exempt the trigger')
    assert.equal(store.dispositions.get('old'), null, 'nor its disposition')
    assert.deepEqual(store.triggerThreads.timeline('github:1').items, [], 'nor its trigger_thread row')
    assert.deepEqual(store.decisions.byThread('github:1'), [], 'nor the decision on that thread')
  } finally {
    cleanup()
  }
})

test('the originating trigger of an unfinished ticket stays even with no subscription left', () => {
  // 用户故事 32 的 Trigger→Ticket 历史：Ticket 页要展示它的起源 Trigger（`views/sources.ts`），
  // 所以除了 Thread 订阅那条腿，Ticket 自己指着的 Trigger 也是豁免（人取消订阅后仍然成立）。
  const { store, cleanup } = openTempStore()
  try {
    const ancient = isoDaysAfter(AT, -100)
    store.tickets.put({
      id: 'ticket-live',
      at: ancient,
      body: {
        origin: { triggerId: 'origin', triggerIds: ['origin'] },
        inputs: [{ id: 'input-1', kind: 'trigger', triggerId: 'follow-up', at: ancient }]
      }
    })
    store.threads.put({ key: 'github:1', source: 'github', meta: {}, body: {} })
    seedTrigger(store, 'origin', ancient)
    seedTrigger(store, 'follow-up', ancient)
    seedTrigger(store, 'unrelated', ancient, { thread: 'github:2' })

    const result = prune(store, { now: () => new Date(AT) })
    assert.equal(result.pruned.triggers, 1, 'only the trigger no unfinished ticket points at goes')
    assert.ok(store.triggers.get('origin'), 'the ticket’s origin trigger stays')
    assert.ok(store.triggers.get('follow-up'), 'a trigger that reached it as an input stays')
    assert.equal(store.triggers.get('unrelated'), null, 'an unrelated trigger goes')
  } finally {
    cleanup()
  }
})

test('a sweep leaves no dangling disposition, trigger_thread or decision row', () => {
  const { store, cleanup } = openTempStore()
  try {
    const ancient = isoDaysAfter(AT, -100)
    store.tickets.put({ id: 'ticket-live', at: ancient, body: { inputs: [] } })
    store.tickets.put({
      id: 'ticket-done',
      at: ancient,
      body: { ended: { at: ancient, by: 'human', outcome: 'stopped' } }
    })
    store.threads.put({
      key: 'github:1',
      source: 'github',
      meta: {},
      body: { subscriptions: ['ticket-live'] }
    })
    store.threads.put({
      key: 'github:2',
      source: 'github',
      meta: {},
      body: { subscriptions: ['ticket-done'] }
    })
    seedTrigger(store, 'kept', ancient)
    seedTrigger(store, 'gone', ancient, { thread: 'github:2' })
    // 一条没有任何 Thread 行、也没被未结束 Ticket 订阅的旧 Decision：按时间删。
    store.decisions.put({ id: 'decision-orphan', threadKey: 'github:404', at: ancient, kind: 'ignore', body: {} })

    const result = prune(store, { now: () => new Date(AT) })
    assert.equal(result.pruned.triggers, 1)
    assert.equal(result.pruned.decisions, 2)

    const count = (sql: string): number => Number((store.sql.all(sql)[0] as Record<string, unknown>)['n'])
    assert.equal(
      count('SELECT count(*) AS n FROM disposition WHERE trigger_id NOT IN (SELECT id FROM trigger)'),
      0,
      'no disposition points at a deleted trigger'
    )
    assert.equal(
      count('SELECT count(*) AS n FROM trigger_thread WHERE trigger_id NOT IN (SELECT id FROM trigger)'),
      0,
      'no trigger_thread row points at a deleted trigger'
    )
    assert.equal(
      count('SELECT count(*) AS n FROM decision WHERE thread_key NOT IN (SELECT key FROM thread)'),
      0,
      'no decision points at a missing thread'
    )
    // 反方向也要成立：存活的一侧带着它的关联行，而不是「全删干净」也能通过。
    assert.deepEqual(store.triggerThreads.timeline('github:1').items.map((item) => item.triggerId), ['kept'])
    assert.ok(store.dispositions.get('kept'))
    assert.deepEqual(store.decisions.byThread('github:1').map((decision) => decision.id), ['decision-kept'])
    assert.equal(count('SELECT count(*) AS n FROM trigger_thread'), 1)
    assert.equal(count('SELECT count(*) AS n FROM disposition'), 1)
  } finally {
    cleanup()
  }
})

test('the prune writes a health detail line before deleting, and records last-prune', () => {
  const { store, cleanup } = openTempStore()
  try {
    seedTrigger(store, 'old', isoDaysAfter(AT, -200))
    const logs: { level: string; msg: string }[] = []
    const result = prune(store, {
      now: () => new Date(AT),
      log: (line) => void logs.push({ level: line.level, msg: line.msg })
    })
    assert.equal(result.pruned.triggers, 1)
    assert.equal(
      result.detail.startsWith(
        'pruned: triggers 1, dispositions 1, trigger_threads 1, decisions 1, outbox 0, versions 0 ' +
          '(retention 90d, outbox 30d, before '
      ),
      true,
      `detail has the fixed shape: ${result.detail}`
    )
    assert.deepEqual(logs, [{ level: 'info', msg: result.detail }], 'the detail is logged, not silent')
    const last = store.kvGet<{ at: string; detail: string }>(LAST_PRUNE_KEY)
    assert.equal(last?.at, AT)
    assert.equal(last?.detail, result.detail)
  } finally {
    cleanup()
  }
})

test('old non-current version snapshots are pruned while the current ones stay', () => {
  const { store, cleanup } = openTempStore()
  try {
    const ancient = isoDaysAfter(AT, -200)
    store.kvSet(SETTINGS_REVISION_KEY, 3)
    store.kvSet(PROMPT_REVISION_KEY, 2)
    store.kvSet(settingsVersionKey(1), { at: ancient, origin: 'panel' })
    store.kvSet(settingsVersionKey(3), { at: ancient, origin: 'tool' }) // 当前版本，虽老也不删
    store.kvSet(promptVersionKey(1), { at: ancient, origin: 'panel' })
    store.kvSet(promptVersionKey(2), { at: ancient, origin: 'tool' }) // 当前版本
    store.kvSet(settingsVersionKey(4), { at: isoDaysAfter(AT, -1), origin: 'panel' }) // 太新

    const result = prune(store, { now: () => new Date(AT) })
    assert.equal(result.pruned.versionSnapshots, 2)
    assert.deepEqual(
      store.kvKeys().filter((key) => key.startsWith('settings-version:') || key.startsWith('prompt-version:')),
      ['prompt-version:2', 'settings-version:3', 'settings-version:4']
    )
  } finally {
    cleanup()
  }
})

test('prune runs at most once a day', () => {
  const { store, cleanup } = openTempStore()
  try {
    assert.equal(pruneDue(store, () => new Date(AT)), true, 'no last-prune means due')
    prune(store, { now: () => new Date(AT) })
    assert.equal(pruneDue(store, () => new Date(isoDaysAfter(AT, 1))), true, 'a day later it is due again')
    assert.equal(pruneDue(store, () => new Date(isoDaysAfter(AT, 0.5))), false, 'half a day is not due')
  } finally {
    cleanup()
  }
})

test('the settled-outbox delete reads through its partial index, not a full scan', () => {
  // §D.2 要点 2 的「只扫活行」同样适用于删除：清理不该把整张 outbox 扫一遍。
  const { store, cleanup } = openTempStore()
  try {
    const plan = store.sql
      .all(`EXPLAIN QUERY PLAN ${outboxSettled.deleteBefore}`, ['2026-01-01T00:00:00.000Z'])
      .map((row) => String((row as Record<string, unknown>)['detail']))
    assert.ok(
      plan.some((line) => line.includes('outbox_settled')),
      `the delete uses the settled partial index: ${plan.join(' / ')}`
    )
    assert.equal(plan.some((line) => /^SCAN outbox$/.test(line)), false)
  } finally {
    cleanup()
  }
})

test('trigger-thread links of a pruned trigger go with it, and cannot block anything', () => {
  // 关联表没有外键：如果不显式级联，旧 Trigger 的关联行会永远留在时间线上。
  const { store, cleanup } = openTempStore()
  try {
    seedTrigger(store, 'old', isoDaysAfter(AT, -200))
    seedTrigger(store, 'new', isoDaysAfter(AT, -1))
    prune(store, { now: () => new Date(AT) })
    const oldTimeline = store.triggerThreads.timeline('github:1')
    assert.deepEqual(oldTimeline.items.map((item) => item.triggerId), ['new'])
  } finally {
    cleanup()
  }
})

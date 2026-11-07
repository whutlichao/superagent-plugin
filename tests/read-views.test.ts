// 视图读面（§G.3 的 `GET overview/sources/search/threads/thread/decisions/models`、§M.1 的
// Thread 列表筛选、§M.2 的 Search 分组、§G.2 read 行的分页与固定拒绝、§O 的 assignment 边界）。
//
// 断言面（每条都是「别的写法都算坏」）：
// - 每类资源至少一条成功 + 一条固定拒绝；
// - 列表页 `--offset/--limit` 默认 20、上限 50，拼起来不重不漏；
// - Thread 的 `(at, triggerId)` 复合游标：`before` 每次往更早一页走、`around` 以锚点为中心，
//   两页之间没有交集；
// - `window=24h` 由服务端换算（同一份 now）；`kind` 与 `filter` 的未知值是 `invalid_value`；
// - `overview` 的时间是 ISO-8601（与 §G.1 的时间行一致），不是面板的 epoch；
// - assignment 只读自己 Ticket 相关的 Thread（§O）。
//
// 真库：Thread/Trigger/Ticket/Decision 都写进临时 SQLite（§P.1 第 3 条），视图读模型只经
// 注入的读口与 `store.sql` 取值——测试与生产走同一条查询。
import { describe, test } from 'orca/testing'
import assert from 'node:assert/strict'
import { createRepositories } from '../src/worker/app/repositories'
import type { Store } from '../src/worker/app/store'
import { readTimeline, readTimelineBefore, readTimelineItem, readTimelineTail } from '../src/worker/app/store-read'
import {
  CURSOR_SEPARATOR,
  THREAD_FILTERS,
  createViewReadTools,
  encodeCursor,
  parseCursor,
  type ViewReadHost,
  type ViewReadTools
} from '../src/worker/app/views/read'
import type { ReadRefusal } from '../src/worker/app/read'
import type { Decision, Thread, Ticket, Trigger } from '../src/worker/core/index'
import { githubFind } from '../src/worker/sources/github/read'
import type { PanelState } from '../src/panel/protocol'
import { AT, isoAfter, openTempStore } from './support/state'

const DAY = 24 * 60 * 60 * 1000

/** 一条 Thread（真库里由 `repo.threads.save` 落盘）。 */
function threadOf(key: string, overrides: Partial<Thread> = {}): Thread {
  const [source, ...rest] = key.split(':')
  return {
    key,
    ref: { source: source as string, id: rest.join(':') },
    createdAt: isoAfter(AT, -DAY),
    subscriptions: [],
    correlated: [],
    pending: [],
    meta: { label: `Thread ${key}` },
    ...overrides
  }
}

/** 一条 Trigger，挂在第一条 Thread 上。 */
function triggerOf(id: string, thread: Thread, at: string, overrides: Partial<Trigger> = {}): Trigger {
  return {
    id,
    source: thread.ref.source,
    threads: [thread.ref],
    actor: { source: thread.ref.source, id: 'alice' },
    human: true,
    at,
    text: `message ${id}`,
    meta: {},
    ...overrides
  }
}

/** 一条 Decision。 */
function decisionOf(id: string, thread: Thread, at: string, overrides: Partial<Decision> = {}): Decision {
  return {
    id,
    evalId: `eval-${id}`,
    threadKey: thread.key,
    triggerIds: [],
    policyVersion: 'policy-1',
    at,
    kind: 'ignore',
    reason: [{ code: 'noRuleMatched' }],
    strength: 'inferred',
    ...overrides
  }
}

/** 一张 Ticket：来源是 Thread 12 上的一条 Trigger，跟随 PR Thread 45。 */
function ticketOf(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 'ticket-own',
    title: 'Fix the login redirect',
    decisionId: 'decision-1',
    mandate: {
      strength: 'explicit',
      policyVersion: 'policy-1',
      basis: { via: 'addressed', addressed: 'mention' },
      actor: { source: 'github', id: 'alice' },
      scope: 'ticket'
    },
    channels: [],
    assignments: [],
    inputs: [],
    undelivered: [],
    createdAt: isoAfter(AT, -1_000),
    updatedAt: AT,
    origin: { triggerId: 'trigger-a', triggerIds: ['trigger-a'] },
    follows: [{ thread: 'github:45', own: true }],
    ...overrides
  }
}

/** 面板快照（overview 的数据源）。 */
function panelState(overrides: Partial<PanelState> = {}): PanelState {
  return {
    revision: 7,
    booted: true,
    health: {
      error: true,
      paused: false,
      setupMissing: false,
      sources: { enabled: 2, problems: 1 },
      activity: { received: 9, evaluated: 4, accepted: 2, ignored: 1, ended: 1 },
      executor: { running: 1, maxWorkers: 3, humanSlot: 'free' }
    },
    attention: {
      answer: 1,
      review: 0,
      problems: 1,
      items: [
        {
          id: 'ticket-own',
          title: 'Fix the login redirect',
          action: 'answer',
          at: Date.parse(AT),
          terminalId: 'terminal-1'
        }
      ]
    },
    problems: [{ id: 'github', kind: 'health', name: 'github', detail: 'poll failed' }],
    tickets: [],
    ...overrides
  }
}

/** 造一套视图读工具：数据都落在真库上，面板/Source/角色/find 由用例给。 */
function viewTools(store: Store, options: { readonly panel?: PanelState } = {}): ViewReadTools {
  const repo = createRepositories(store)
  // `readTimeline*` 要的是 `SqlReader`（all + plan）；视图只读，查询计划给空表就够。
  const reader = {
    all: (sql: string, params?: readonly (string | number | null | bigint | Uint8Array)[]) =>
      store.sql.all(sql, params as never),
    plan: () => [] as readonly string[]
  }
  const host: ViewReadHost = {
    reader: { sql: store.sql },
    now: () => AT,
    panel: () => options.panel ?? panelState(),
    sources: () => [
      {
        id: 'github',
        kind: 'github',
        title: { zh: 'GitHub', en: 'GitHub' },
        installed: true,
        enabled: true,
        state: 'ready',
        entries: ['github']
      }
    ],
    roles: () => ({
      router: { agent: 'pi', model: 'router-model' },
      worker: { agent: 'pi', model: 'worker-model', effort: 'high' }
    }),
    find: (query) => githubFind(query),
    threads: () => repo.threads.list(),
    thread: (key) => repo.threads.get(key),
    timeline: {
      tail: (key, limit) => readTimelineTail(reader, key, limit),
      before: (key, cursor, limit) => readTimelineBefore(reader, key, cursor, limit),
      after: (key, cursor, limit) => readTimeline(reader, key, { after: cursor, limit }),
      item: (key, cursor) => readTimelineItem(reader, key, cursor)
    },
    trigger: (id) => repo.triggers.get(id),
    disposition: (id) => repo.triggers.disposition(id),
    decisions: (key) => repo.decisions.byThread(key),
    tickets: () => repo.tickets.list(),
    ticket: (id) => repo.tickets.get(id)
  }
  return createViewReadTools(host)
}

/** 跑一次读并断言它是固定拒绝。 */
function refusalOf(result: unknown): ReadRefusal {
  const maybe = result as { readonly ok?: unknown }
  if (maybe.ok !== false) throw new Error('expected a refusal')
  return result as ReadRefusal
}

/** 六个 Trigger 的时间线（同一时刻的两条只有复合游标能分清）。 */
function seedTimeline(store: Store): Thread {
  const repo = createRepositories(store)
  const thread = threadOf('github:12', { lastAt: isoAfter(AT, -5_000), subscriptions: ['ticket-own'] })
  repo.threads.save(thread)
  const times = [
    isoAfter(AT, -5_000),
    isoAfter(AT, -4_000),
    isoAfter(AT, -3_000),
    isoAfter(AT, -3_000),
    isoAfter(AT, -2_000),
    isoAfter(AT, -1_000)
  ]
  const ids = ['trigger-a', 'trigger-b', 'trigger-c', 'trigger-d', 'trigger-e', 'trigger-f']
  ids.forEach((id, index) => {
    repo.triggers.save(triggerOf(id, thread, times[index] as string, { text: `message ${id}` }))
  })
  // 一条已决定的 Trigger：时间线条目要带上 decisionId。
  repo.triggers.saveDisposition('trigger-c', { fanout: [], decisionId: 'decision-ignore', at: AT })
  return thread
}

describe('read threads: the list is filtered and paged without loss or repetition', () => {
  test('offset/limit walk every thread once, newest first', () => {
    const { store, cleanup } = openTempStore()
    try {
      const repo = createRepositories(store)
      for (const [key, lastAt] of [
        ['github:12', isoAfter(AT, -3_000)],
        ['github:45', isoAfter(AT, -2_000)],
        ['github:99', isoAfter(AT, -1_000)]
      ] as const) {
        repo.threads.save(threadOf(key, { lastAt }))
      }
      const tools = viewTools(store)
      const first = tools.threads({ limit: 2 })
      if ('ok' in first) throw new Error('expected a page')
      assert.deepEqual(first.items.map((item) => item.key), ['github:99', 'github:45'])
      assert.equal(first.next_offset, 2)
      const second = tools.threads({ offset: first.next_offset as number, limit: 2 })
      if ('ok' in second) throw new Error('expected a page')
      assert.deepEqual(second.items.map((item) => item.key), ['github:12'])
      assert.equal(second.next_offset, null)
      // 不重不漏：两页的键没有交集，拼起来正好是全部。
      const keys = [...first.items, ...second.items].map((item) => item.key)
      assert.equal(new Set(keys).size, keys.length)
      assert.deepEqual(keys, ['github:99', 'github:45', 'github:12'])
      // 默认一页 20：没有第二页。
      const whole = tools.threads()
      if ('ok' in whole) throw new Error('expected a page')
      assert.equal(whole.items.length, 3)
      assert.equal(whole.next_offset, null)
    } finally {
      cleanup()
    }
  })

  test('subscribed / evaluating / new filter on the thread itself, and an unknown filter is invalid_value', () => {
    const { store, cleanup } = openTempStore()
    try {
      const repo = createRepositories(store)
      repo.threads.save(threadOf('github:1', { lastAt: isoAfter(AT, -DAY * 2), subscriptions: ['ticket-1'] }))
      repo.threads.save(threadOf('github:2', { lastAt: isoAfter(AT, -1_000), evaluating: { evalId: 'eval-1', at: AT } as never }))
      repo.threads.save(threadOf('github:3', { lastAt: isoAfter(AT, -DAY * 3) }))
      const tools = viewTools(store)
      const keysOf = (filter: string): readonly string[] => {
        const page = tools.threads({ filter })
        if ('ok' in page) throw new Error(`expected a page for ${filter}`)
        return page.items.map((item) => item.key)
      }
      assert.deepEqual(keysOf('all'), ['github:2', 'github:1', 'github:3'])
      assert.deepEqual(keysOf('subscribed'), ['github:1'])
      assert.deepEqual(keysOf('evaluating'), ['github:2'])
      assert.deepEqual(keysOf('new'), ['github:2'], 'new means lastAt within 24 hours')
      assert.deepEqual((THREAD_FILTERS as readonly string[]).slice(), ['all', 'subscribed', 'evaluating', 'new'])
      assert.equal(refusalOf(tools.threads({ filter: 'nope' })).code, 'invalid_value')
      assert.equal(refusalOf(tools.threads({ limit: 51 })).code, 'invalid_value')
      assert.equal(refusalOf(tools.threads({ offset: -1 })).code, 'invalid_value')
    } finally {
      cleanup()
    }
  })
})

describe('read thread/<key>: the (at, id) cursor pages back and centers on around', () => {
  test('before walks older pages with no overlap and stops with null', () => {
    const { store, cleanup } = openTempStore()
    try {
      seedTimeline(store)
      const tools = viewTools(store)
      const first = tools.thread('github:12', { limit: 2 })
      if ('ok' in first) throw new Error('expected a thread')
      assert.deepEqual(first.items.map((item) => item.id), ['trigger-e', 'trigger-f'])
      assert.equal(parseCursor(first.next as string)?.triggerId, 'trigger-f')
      assert.notEqual(first.before, null)

      const second = tools.thread('github:12', { limit: 2, before: first.before as string })
      if ('ok' in second) throw new Error('expected a thread')
      assert.deepEqual(second.items.map((item) => item.id), ['trigger-c', 'trigger-d'])
      assert.notEqual(second.before, null)

      const third = tools.thread('github:12', { limit: 2, before: second.before as string })
      if ('ok' in third) throw new Error('expected a thread')
      assert.deepEqual(third.items.map((item) => item.id), ['trigger-a', 'trigger-b'])
      assert.equal(third.before, null, 'the earliest page ends the walk')

      const seen = [...first.items, ...second.items, ...third.items].map((item) => item.id)
      assert.equal(new Set(seen).size, seen.length, 'no page repeats a trigger')
      assert.deepEqual(seen, [
        'trigger-e',
        'trigger-f',
        'trigger-c',
        'trigger-d',
        'trigger-a',
        'trigger-b'
      ])
    } finally {
      cleanup()
    }
  })

  test('around centers the page on the anchor and reveals both neighbours', () => {
    const { store, cleanup } = openTempStore()
    try {
      const thread = seedTimeline(store)
      const tools = viewTools(store)
      const anchor = encodeCursor({ at: isoAfter(AT, -3_000), triggerId: 'trigger-c' })
      const centered = tools.thread('github:12', { around: anchor, limit: 3 })
      if ('ok' in centered) throw new Error('expected a thread')
      assert.deepEqual(centered.items.map((item) => item.id), ['trigger-b', 'trigger-c', 'trigger-d'])
      assert.notEqual(centered.before, null)
      assert.notEqual(centered.next, null)
      // 时间线条目带 Trigger 的正文、作者与已存的 decisionId。
      const decided = centered.items.find((item) => item.id === 'trigger-c')
      assert.equal(decided?.from, 'alice')
      assert.equal(decided?.decisionId, 'decision-ignore')
      // 结构体的游标用同一个编码往返。
      assert.deepEqual(parseCursor(anchor), { at: isoAfter(AT, -3_000), triggerId: 'trigger-c' })
      assert.equal(encodeCursor(parseCursor(anchor) as never), anchor)
      assert.ok(anchor.includes(CURSOR_SEPARATOR))
      // 锚点不在这个 Thread 上：missing，不是空时间线。
      const missing = refusalOf(
        tools.thread('github:12', { around: encodeCursor({ at: AT, triggerId: 'trigger-nope' }) })
      )
      assert.equal(missing.code, 'missing')
      // 两个游标同时给：invalid_value。
      const both = refusalOf(tools.thread('github:12', { around: anchor, before: anchor }))
      assert.equal(both.code, 'invalid_value')
      // 坏游标：invalid_value，不是 missing。
      const bad = refusalOf(tools.thread('github:12', { before: 'not-a-cursor' }))
      assert.equal(bad.code, 'invalid_value')
      // 不存在的 Thread：missing。
      assert.equal(refusalOf(tools.thread('github:nope', {})).code, 'missing')
      // 详情带 Thread 自己的字段与它的 Decision（新的在前）。
      const repo = createRepositories(store)
      repo.decisions.save(decisionOf('decision-old', thread, isoAfter(AT, -4_000)))
      repo.decisions.save(decisionOf('decision-new', thread, isoAfter(AT, -1_000), { kind: 'accept' }))
      const detail = tools.thread('github:12', { limit: 1 })
      if ('ok' in detail) throw new Error('expected a thread')
      assert.equal(detail.thread.key, 'github:12')
      assert.equal(detail.thread.subscriptions.includes('ticket-own'), true)
      assert.deepEqual(detail.decisions.map((item) => item.id), ['decision-new'], 'decisions are newest first and capped')
    } finally {
      cleanup()
    }
  })

  test('a long trigger text is cut to the preview size and says how long it was', () => {
    const { store, cleanup } = openTempStore()
    try {
      const repo = createRepositories(store)
      const thread = threadOf('github:7', { lastAt: AT })
      repo.threads.save(thread)
      repo.triggers.save(triggerOf('trigger-long', thread, AT, { text: 'x'.repeat(900) }))
      const tools = viewTools(store)
      const detail = tools.thread('github:7', {})
      if ('ok' in detail) throw new Error('expected a thread')
      const [item] = detail.items
      assert.equal(item?.truncated, true)
      assert.equal(item?.chars, 900)
      assert.equal(item?.text.length, 400)
    } finally {
      cleanup()
    }
  })
})

describe('read decisions: kind and window filter on the row, paging stays stable', () => {
  function seed(store: Store): Thread {
    const repo = createRepositories(store)
    const thread = threadOf('github:12')
    repo.threads.save(thread)
    repo.decisions.save(decisionOf('decision-a', thread, isoAfter(AT, -5 * 60 * 60 * 1000), { kind: 'accept' }))
    repo.decisions.save(decisionOf('decision-b', thread, isoAfter(AT, -4 * 60 * 60 * 1000), { kind: 'ignore' }))
    repo.decisions.save(decisionOf('decision-c', thread, isoAfter(AT, -2 * 60 * 60 * 1000), { kind: 'unavailable' }))
    // 窗口之外的一条：`window=24h` 必须把它排除，而不是在客户端筛。
    repo.decisions.save(decisionOf('decision-old', thread, isoAfter(AT, -DAY * 2)))
    return thread
  }

  test('newest first, --offset/--limit pages, and kind narrows it', () => {
    const { store, cleanup } = openTempStore()
    try {
      seed(store)
      const tools = viewTools(store)
      const first = tools.decisions({ limit: 2 })
      if ('ok' in first) throw new Error('expected a page')
      assert.deepEqual(first.items.map((item) => item.id), ['decision-c', 'decision-b'])
      assert.equal(first.next_offset, 2)
      const second = tools.decisions({ offset: 2, limit: 2 })
      if ('ok' in second) throw new Error('expected a page')
      assert.deepEqual(second.items.map((item) => item.id), ['decision-a', 'decision-old'])
      assert.equal(second.next_offset, null)

      const accepted = tools.decisions({ kind: 'accept' })
      if ('ok' in accepted) throw new Error('expected a page')
      assert.deepEqual(accepted.items.map((item) => item.id), ['decision-a'])
      assert.equal(accepted.items[0]?.kind, 'accept')
      assert.equal(accepted.items[0]?.reason_text, 'No enabled admission rule matched')
      assert.equal(accepted.items[0]?.threadKey, 'github:12')
    } finally {
      cleanup()
    }
  })

  test('window=24h converts on the server, and unknown kind/window are invalid_value', () => {
    const { store, cleanup } = openTempStore()
    try {
      seed(store)
      const tools = viewTools(store)
      const today = tools.decisions({ window: '24h' })
      if ('ok' in today) throw new Error('expected a page')
      assert.deepEqual(today.items.map((item) => item.id), ['decision-c', 'decision-b', 'decision-a'])
      const hour = tools.decisions({ window: '1h' })
      if ('ok' in hour) throw new Error('expected a page')
      assert.deepEqual(hour.items, [], 'every decision is at least two hours old')
      for (const window of ['nope', '0h', '24', 'h24', '-1h']) {
        assert.equal(refusalOf(tools.decisions({ window })).code, 'invalid_value', window)
      }
      assert.equal(refusalOf(tools.decisions({ kind: 'maybe' })).code, 'invalid_value')
      assert.equal(refusalOf(tools.decisions({ limit: 51 })).code, 'invalid_value')
    } finally {
      cleanup()
    }
  })
})

describe('read overview / sources / models reuse the panel and role read models', () => {
  test('overview keeps the panel numbers and turns the attention time into ISO', () => {
    const { store, cleanup } = openTempStore()
    try {
      const view = viewTools(store).overview()
      assert.equal(view.revision, 7)
      assert.deepEqual(view.health, { error: true, paused: false, setupMissing: false })
      assert.deepEqual(view.activity, { received: 9, evaluated: 4, accepted: 2, ignored: 1, ended: 1 })
      assert.deepEqual(view.executor, { running: 1, maxWorkers: 3, humanSlot: 'free' })
      assert.deepEqual(view.sources, { enabled: 2, problems: 1 })
      assert.deepEqual(view.attention.items, [
        {
          id: 'ticket-own',
          title: 'Fix the login redirect',
          action: 'answer',
          at: AT,
          terminalId: 'terminal-1'
        }
      ])
      assert.equal(view.problems.length, 1)
    } finally {
      cleanup()
    }
  })

  test('sources is the registry overview verbatim', () => {
    const { store, cleanup } = openTempStore()
    try {
      const view = viewTools(store).sources()
      assert.deepEqual(view.items.map((item) => `${item.id}:${item.state}`), ['github:ready'])
    } finally {
      cleanup()
    }
  })

  test('models names the two role models, and says the catalog belongs to Orca', () => {
    const { store, cleanup } = openTempStore()
    try {
      const view = viewTools(store).models()
      assert.deepEqual(view.roles.router, { agent: 'pi', model: 'router-model' })
      assert.deepEqual(view.roles.worker, { agent: 'pi', model: 'worker-model', effort: 'high' })
      assert.deepEqual(view.models.map((item) => `${item.role}:${item.id}`), [
        'router:router-model',
        'worker:worker-model'
      ])
      assert.deepEqual(view.catalog, [])
      assert.match(view.note, /Orca/)
    } finally {
      cleanup()
    }
  })
})

describe('read search uses the Source find semantics and groups the matches', () => {
  function seed(store: Store): Thread {
    const repo = createRepositories(store)
    const thread = threadOf('github:12', { lastAt: AT })
    repo.threads.save(thread)
    repo.triggers.save(triggerOf('trigger-a', thread, AT, { text: 'please fix the build' }))
    const other = threadOf('feishu:oc_chat:om_root', { lastAt: AT, meta: { label: 'Design chat' } })
    repo.threads.save(other)
    repo.triggers.save(
      triggerOf('trigger-f', other, AT, { text: 'unrelated words', meta: { messageId: 'om_source' } })
    )
    repo.tickets.save(ticketOf())
    return thread
  }

  test('a thread reference, a message id and a word each land in the right group', () => {
    const { store, cleanup } = openTempStore()
    try {
      seed(store)
      const tools = viewTools(store)

      const byThread = tools.search({ query: '#12' })
      if ('ok' in byThread) throw new Error('expected a search')
      assert.deepEqual(byThread.threads.items.map((item) => item.key), ['github:12'])
      assert.deepEqual(byThread.triggers.items, [], 'no trigger text contains #12')
      // Ticket 跟随/来源的 Thread 命中，于是它也出现在结果里（§M.1 的「Ticket 或匹配 Thread」）。
      assert.deepEqual(byThread.tickets.items.map((item) => item.id), ['ticket-own'])

      const byMessage = tools.search({ query: 'om_source' })
      if ('ok' in byMessage) throw new Error('expected a search')
      assert.deepEqual(byMessage.triggers.items.map((item) => item.id), ['trigger-f'])

      const byWord = tools.search({ query: 'build' })
      if ('ok' in byWord) throw new Error('expected a search')
      assert.deepEqual(byWord.triggers.items.map((item) => item.id), ['trigger-a'])
      assert.equal(byWord.triggers.items[0]?.from, 'alice')
      assert.equal(byWord.triggers.items[0]?.text, 'please fix the build')

      // 无结果不是错误：三组为空、query 原样回。
      const none = tools.search({ query: 'nothing-matches-this' })
      if ('ok' in none) throw new Error('expected a search')
      assert.deepEqual(none.threads.items, [])
      assert.deepEqual(none.triggers.items, [])
      assert.deepEqual(none.tickets.items, [])
      assert.equal(none.query, 'nothing-matches-this')
      // 空查询与超限：invalid_value（不是空结果）。
      assert.equal(refusalOf(tools.search({ query: '   ' })).code, 'invalid_value')
      assert.equal(refusalOf(tools.search({ query: 'build', limit: 51 })).code, 'invalid_value')
    } finally {
      cleanup()
    }
  })
})

describe('the assignment boundary: only its own ticket and related threads (§O)', () => {
  test('an own thread, a followed thread and a subscription are related; others are not', () => {
    const { store, cleanup } = openTempStore()
    try {
      const repo = createRepositories(store)
      const own = threadOf('github:12')
      const followed = threadOf('github:45')
      const subscribed = threadOf('github:77', { subscriptions: ['ticket-own'] })
      const foreign = threadOf('github:99')
      for (const thread of [own, followed, subscribed, foreign]) repo.threads.save(thread)
      repo.triggers.save(triggerOf('trigger-a', own, AT))
      repo.tickets.save(ticketOf())
      const tools = viewTools(store)
      assert.equal(tools.mayReadThread('ticket-own', 'github:12'), true, 'origin thread')
      assert.equal(tools.mayReadThread('ticket-own', 'github:45'), true, 'followed thread')
      assert.equal(tools.mayReadThread('ticket-own', 'github:77'), true, 'subscribed thread')
      assert.equal(tools.mayReadThread('ticket-own', 'github:99'), false)
      assert.equal(tools.mayReadThread('ticket-other', 'github:12'), false, 'another ticket sees nothing')
      assert.equal(tools.mayReadThread('ticket-own', 'github:nope'), false)
    } finally {
      cleanup()
    }
  })
})

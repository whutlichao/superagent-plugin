// Trigger 页（§M.2、§D.2 的 thread 行）：四组 Thread 筛选、行（标签/链接、订阅数、最近触发、
// 状态标记）、Thread 详情的时间线（触发卡 + 决定 + 订阅 + handback 原因）与两个动作
// （再评估一次、取消订阅要二次确认）。
//
// 断言分两层：
// - 面板侧：挂载真面板模块停在 Trigger 页；列表与详情都是 worker 的请求（`threads` /
//   `thread.detail`），动作断言发出去的请求名与入参，并断言面板一次也没调宿主方法；
// - 读模型侧：真库（临时目录的 SQLite）上的 `threadListPage` / `threadDetailView`，时间线
//   分页用 (时间, id) 复合游标——同一时刻的两条既不丢也不重（§D.2 要点 1）。
import { assert, mockHost, mount, mountWorker, test } from 'orca/testing'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Decision, Thread, Ticket, Trigger } from '../src/worker/core/index'
import { createRepositories } from '../src/worker/app/repositories'
import { threadDetailView, threadListPage, threadRecordsOf } from '../src/worker/app/views/threads'
import type { Store } from '../src/worker/app/store'
import {
  THREAD_FILTERS,
  type PanelDecision,
  type PanelState,
  type PanelThread,
  type PanelTriggerCard,
  type ThreadDetailView,
  type ThreadFilter
} from '../src/panel/protocol'
import { COPY, translate } from '../src/panel/copy'
import * as panelModule from '../src/panel/panel'
import * as main from '../src/worker/main'
import { openTempStore, AT, isoAfter } from './support/state'

/** `mockHost` 的请求表类型（测试里只写用到的几个名字）。 */
type Requests = NonNullable<NonNullable<Parameters<typeof mockHost>[0]>['requests']>

/** 筛选读数的固定时刻：数据里的 `lastAt` 都以它为基准（「24 小时内有新触发」）。 */
const NOW = isoAfter(AT, 60 * 60 * 1000)

// ---------------------------------------------------------------------------
// 读模型：四组筛选、排序、分页（§M.2 的 Trigger 表）
// ---------------------------------------------------------------------------

/** 一张 Thread；每个用例只写它关心的字段。 */
function threadOf(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    key: `github:${id}`,
    ref: { source: 'github', id },
    createdAt: AT,
    subscriptions: [],
    correlated: [],
    pending: [],
    meta: {},
    ...overrides
  }
}

/** 一条 Trigger（`repo.triggers.save` 同时把它写进 Thread 时间线）。 */
function triggerOf(id: string, threadId: string, overrides: Partial<Trigger> = {}): Trigger {
  return {
    id,
    source: 'github',
    threads: [{ source: 'github', id: threadId }],
    actor: { source: 'github', id: 'alice' },
    human: true,
    at: AT,
    text: `message ${id}`,
    meta: {},
    ...overrides
  }
}

/** 一张工单（订阅数与「订阅者还有没有活的」都读它）。 */
function ticketOf(id: string, overrides: Partial<Ticket> = {}): Ticket {
  return {
    id,
    title: `Ticket ${id}`,
    decisionId: 'decision-1',
    mandate: {
      strength: 'explicit',
      policyVersion: 'v1',
      basis: { via: 'addressed', addressed: 'mention' },
      actor: { source: 'github', id: 'alice' },
      scope: 'ticket'
    },
    channels: [],
    assignments: [],
    inputs: [],
    undelivered: [],
    createdAt: AT,
    updatedAt: AT,
    origin: { triggerId: 'trigger-origin', triggerIds: ['trigger-origin'] },
    ...overrides
  }
}

/** 一个真库 + 真仓储上的读模型接线（与组合根同一处构造）。 */
function threadFixture(): {
  readonly store: Store
  readonly repo: ReturnType<typeof createRepositories>
  readonly records: ReturnType<typeof threadRecordsOf>
  readonly cleanup: () => void
} {
  const { store, cleanup } = openTempStore()
  const repo = createRepositories(store)
  return { store, repo, records: threadRecordsOf(repo, store), cleanup }
}

test('the thread list read model answers the four filters from real Threads', () => {
  const { repo, records, cleanup } = threadFixture()
  try {
    repo.tickets.save(ticketOf('t1'))
    repo.tickets.save(
      ticketOf('t2', { assignments: [], ended: { at: AT, by: 'executor', outcome: 'completed' } })
    )
    // A：活的订阅者；最近有新触发。
    repo.threads.save(
      threadOf('owner/widgets#12', {
        lastAt: isoAfter(AT, 5 * 60_000),
        subscriptions: ['t1'],
        meta: { label: 'owner/widgets#12', url: 'https://github.test/owner/widgets/pull/12' }
      })
    )
    repo.triggers.save(
      triggerOf('trigger-a', 'owner/widgets#12', {
        at: isoAfter(AT, 5 * 60_000),
        text: 'please fix the login redirect'
      })
    )
    // B：订阅者都结束了，也没有新的触发（沉睡）；没有 label 时行用 url 定位。
    repo.threads.save(
      threadOf('owner/widgets#13', {
        lastAt: isoAfter(AT, -2 * 24 * 60 * 60_000),
        subscriptions: ['t2'],
        meta: { url: 'https://github.test/owner/widgets/issues/13' }
      })
    )
    // C：排队中（还在等 Eval，没有执行器拥有它）。
    repo.threads.save(
      threadOf('owner/widgets#14', {
        lastAt: isoAfter(AT, 10 * 60_000),
        pending: ['trigger-c'],
        meta: { label: 'owner/widgets#14' }
      })
    )
    repo.triggers.save(
      triggerOf('trigger-c', 'owner/widgets#14', { human: false, text: 'CI: 3 checks, 0 failed' })
    )
    // D：正在评估。
    repo.threads.save(
      threadOf('owner/widgets#15', {
        lastAt: isoAfter(AT, 15 * 60_000),
        meta: { label: 'owner/widgets#15' },
        evaluating: {
          id: 'eval-1',
          threadKey: 'github:owner/widgets#15',
          triggerIds: ['trigger-d'],
          strength: 'explicit',
          actor: { source: 'github', id: 'alice' },
          basis: { via: 'addressed', addressed: 'mention' },
          policyVersion: 'v1',
          startedAt: AT,
          deadline: isoAfter(AT, 30 * 60_000)
        }
      })
    )
    // E：Source 的轮询失败（状态标记 `error`，原因随行带上），订阅者仍活着。
    repo.threads.save(
      threadOf('owner/widgets#16', {
        lastAt: isoAfter(AT, -3 * 24 * 60 * 60_000),
        subscriptions: ['t1'],
        meta: { label: 'owner/widgets#16', pollError: 'graphql: 502 Bad Gateway' }
      })
    )
    // F：没人订阅，也没有待办。
    repo.threads.save(threadOf('owner/widgets#17', { createdAt: isoAfter(AT, -5 * 24 * 60 * 60_000) }))

    const keys = (filter: ThreadFilter): string[] =>
      threadListPage(records, { filter, now: NOW }).items.map((item) => item.key)

    assert.deepEqual(keys('subscribed'), [
      'github:owner/widgets#12',
      'github:owner/widgets#16'
    ], 'a live subscription is a live Ticket on the Thread')
    assert.deepEqual(
      keys('evaluating'),
      ['github:owner/widgets#15', 'github:owner/widgets#14'],
      'an Eval in progress and a Trigger still waiting for one'
    )
    assert.deepEqual(
      keys('recent'),
      [
        'github:owner/widgets#15',
        'github:owner/widgets#14',
        'github:owner/widgets#12'
      ],
      'new Triggers in the last 24 hours'
    )
    assert.deepEqual(
      keys('all'),
      [
        'github:owner/widgets#15',
        'github:owner/widgets#14',
        'github:owner/widgets#12',
        'github:owner/widgets#13',
        'github:owner/widgets#16',
        'github:owner/widgets#17'
      ],
      'everything, newest first'
    )

    const row = (key: string) =>
      threadListPage(records, { filter: 'all', now: NOW }).items.find((item) => item.key === key)
    assert.equal(row('github:owner/widgets#12')?.title, 'owner/widgets#12', 'the Source label locates the Thread')
    assert.equal(row('github:owner/widgets#12')?.url, 'https://github.test/owner/widgets/pull/12')
    assert.equal(
      row('github:owner/widgets#13')?.title,
      'https://github.test/owner/widgets/issues/13',
      'with no label the url is the locator'
    )
    assert.equal(row('github:owner/widgets#17')?.title, 'github:owner/widgets#17', 'and the key if neither')
    assert.equal(row('github:owner/widgets#12')?.subscriptions, 1, 'the subscription count')
    assert.equal(row('github:owner/widgets#17')?.subscriptions, 0)
    assert.equal(row('github:owner/widgets#12')?.stage, 'subscribed')
    assert.equal(row('github:owner/widgets#13')?.stage, 'dormant', 'every subscriber ended')
    assert.equal(row('github:owner/widgets#14')?.stage, 'queued')
    assert.equal(row('github:owner/widgets#14')?.pending, 1, 'what waits behind the queued Thread')
    assert.equal(row('github:owner/widgets#15')?.stage, 'evaluating')
    assert.equal(row('github:owner/widgets#16')?.stage, 'error', 'a failed poll is its own stage')
    assert.equal(
      row('github:owner/widgets#16')?.pollError,
      'graphql: 502 Bad Gateway',
      'the reason travels with the row instead of hiding behind the chip'
    )
    assert.equal(row('github:owner/widgets#17')?.stage, 'unsubscribed')

    const latest = row('github:owner/widgets#12')?.latest
    assert.deepEqual(latest, {
      actor: 'github:alice',
      human: true,
      at: Date.parse(isoAfter(AT, 5 * 60_000)),
      preview: 'please fix the login redirect'
    }, 'the latest Trigger is the newest row of the Thread timeline')
    assert.deepEqual(row('github:owner/widgets#14')?.latest?.human, false)
    assert.equal(row('github:owner/widgets#17')?.latest, undefined, 'no Trigger, no latest')
  } finally {
    cleanup()
  }
})

test('the thread list read model pages 60 threads 50 at a time', () => {
  const { repo, records, cleanup } = threadFixture()
  try {
    for (let index = 0; index < 60; index += 1) {
      repo.threads.save(
        threadOf(`owner/widgets#${index}`, {
          lastAt: isoAfter(AT, index * 60_000),
          meta: { label: `owner/widgets#${index}` }
        })
      )
    }
    const first = threadListPage(records, { filter: 'all', now: NOW })
    assert.equal(first.items.length, 50, 'the first page holds one page of rows (§M.4)')
    assert.equal(first.nextOffset, 50, 'and says where the next page starts')
    assert.equal(first.items[0]?.title, 'owner/widgets#59', 'newest first')
    const second = threadListPage(records, { filter: 'all', now: NOW, offset: 50 })
    assert.equal(second.items.length, 10)
    assert.equal(second.nextOffset, null, 'the last page has no next page')
    assert.equal(second.items.at(-1)?.title, 'owner/widgets#0', 'nothing is repeated or dropped')
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// 面板：Trigger 列表（§M.2 的四档筛选、行的四列、三态与单行的错误）
// ---------------------------------------------------------------------------

/** 一份健康快照；Trigger 页自己读 `threads`，快照只决定全局三态。 */
function snapshot(): PanelState {
  return {
    revision: 1,
    booted: true,
    health: {
      error: false,
      paused: false,
      setupMissing: false,
      sources: { enabled: 0, problems: 0 },
      activity: { received: 0, evaluated: 0, accepted: 0, ignored: 0, ended: 0 },
      executor: { running: 0, maxWorkers: 4, humanSlot: 'free' }
    },
    attention: { answer: 0, review: 0, problems: 0, items: [] },
    problems: [],
    tickets: []
  }
}

/** 一条 Thread 行（面板只画 worker 回来的这份读数）。 */
function threadRow(
  key: string,
  title: string,
  stage: PanelThread['stage'] = 'subscribed',
  overrides: Partial<PanelThread> = {}
): PanelThread {
  return {
    key,
    source: 'github',
    title,
    stage,
    pending: 0,
    subscriptions: 0,
    lastAt: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
    ...overrides
  }
}

/** 一页行：按请求的窗口切（分页由读模型定，面板只画回来的窗口）。 */
function pagedThreads(all: readonly PanelThread[]): Requests['threads'] {
  return (input) => {
    const window = (input ?? {}) as { readonly offset?: number; readonly limit?: number }
    const offset = window.offset ?? 0
    const limit = window.limit ?? 50
    return {
      items: all.slice(offset, offset + limit),
      nextOffset: offset + limit < all.length ? offset + limit : null
    }
  }
}

/** 每一档筛选的固定回答（筛选判定在读模型里，面板只把档位发过去）。 */
function byFilter(answers: Readonly<Record<string, readonly PanelThread[]>>): Requests['threads'] {
  return (input) => {
    const filter = ((input ?? {}) as { readonly filter?: string }).filter ?? 'all'
    return { items: answers[filter] ?? [], nextOffset: null }
  }
}

let panel: Awaited<ReturnType<typeof mount>> | undefined

/** 挂载面板并停在 Trigger 列表。 */
async function openTriggerTab(
  requests: Requests
): Promise<Awaited<ReturnType<typeof mount>>> {
  panel = await mount(panelModule, {
    host: mockHost({ requests: { state: () => snapshot(), ...requests } }),
    locale: 'en'
  })
  await panel.select({ type: 'Tabs' }, 'trigger')
  return panel
}

/** 面板发过的请求（按顺序）。 */
function requestNames(host: ReturnType<typeof mockHost>): string[] {
  return host.callsOf('plugin.request').map((params) => (params as { name?: string }).name ?? '')
}

/** 一次请求的入参。 */
function requestInput(
  host: ReturnType<typeof mockHost>,
  name: string
): Record<string, unknown> | undefined {
  const call = host
    .callsOf('plugin.request')
    .map((params) => params as { name?: string; input?: Record<string, unknown> })
    .filter((params) => params.name === name)
    .at(-1)
  return call?.input
}

/** 面板绘制树的一个节点（`tree()` 的形状）。 */
interface TreeNode {
  readonly type: string
  readonly props?: Readonly<Record<string, unknown>>
  readonly children?: readonly (TreeNode | string)[]
}

/** 第一个某类型的节点（深度优先）。 */
function nodeOfType(mounted: Awaited<ReturnType<typeof mount>>, type: string): TreeNode | undefined {
  const seek = (node: TreeNode): TreeNode | undefined => {
    if (node.type === type) return node
    for (const child of node.children ?? []) {
      if (typeof child === 'string') continue
      const hit = seek(child)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  return seek(mounted.tree() as TreeNode)
}

/** 表格画出的行（`Table` 的 `rows` prop，按绘制顺序）。 */
function tableRows(mounted: Awaited<ReturnType<typeof mount>>): readonly Record<string, unknown>[] {
  const table = nodeOfType(mounted, 'Table')
  assert.ok(table !== undefined, 'the page draws a Table')
  const rows = table.props?.['rows']
  return Array.isArray(rows) ? (rows as readonly Record<string, unknown>[]) : []
}

/** 一段文案的字面量正则（文案里有括号/冒号，直接 `new RegExp` 会变成组语法）。 */
function literal(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
}

/** 表格一行的单元格。 */
function cellsOf(drawn: Record<string, unknown>): Readonly<Record<string, string>> {
  const cells = drawn['cells']
  return typeof cells === 'object' && cells !== null ? (cells as Record<string, string>) : {}
}

test('the Trigger table asks for one page and loads the next one on demand', async () => {
  const all = Array.from({ length: 60 }, (_, index) =>
    threadRow(`github:owner/widgets#${index}`, `owner/widgets#${index}`)
  )
  const mounted = await openTriggerTab({ threads: pagedThreads(all) })
  assert.equal(mounted.rowsOf({ type: 'Table' }).length, 50, 'the first page holds fifty rows (§M.4)')
  assert.deepEqual(requestInput(mounted.host, 'threads'), {
    filter: 'subscribed',
    offset: 0,
    limit: 50
  })

  await mounted.loadMore({ type: 'Table' })
  assert.equal(mounted.rowsOf({ type: 'Table' }).length, 60, 'load more appends the rest')
  assert.deepEqual(requestInput(mounted.host, 'threads'), {
    filter: 'subscribed',
    offset: 50,
    limit: 50
  })
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('the Trigger page asks for the Subscribed window first, then for each filter its own window', async () => {
  const mounted = await openTriggerTab({
    threads: byFilter({
      subscribed: [threadRow('github:owner/widgets#12', 'owner/widgets#12')],
      evaluating: [threadRow('github:owner/widgets#13', 'owner/widgets#13', 'evaluating')],
      recent: [threadRow('github:owner/widgets#14', 'owner/widgets#14', 'queued', { pending: 2 })],
      all: [threadRow('github:owner/widgets#15', 'owner/widgets#15', 'dormant')]
    })
  })
  assert.deepEqual(requestInput(mounted.host, 'threads'), {
    filter: 'subscribed',
    offset: 0,
    limit: 50
  })
  assert.ok(mounted.find({ text: /owner\/widgets#12/ }))

  for (const filter of THREAD_FILTERS) {
    await mounted.select({ type: 'RadioGroup' }, filter)
    assert.deepEqual(
      requestInput(mounted.host, 'threads'),
      { filter, offset: 0, limit: 50 },
      `${filter} asks for its own page`
    )
  }
  assert.ok(mounted.find({ text: /owner\/widgets#15/ }), 'the rows are the answer for the chosen filter')
  assert.equal(mounted.find({ text: /owner\/widgets#12/ }), null, 'the previous filter rows are gone')
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('a row names the Thread, its subscription count, its latest Trigger and its state', async () => {
  const mounted = await openTriggerTab({
    threads: () => ({
      items: [
        threadRow('github:owner/widgets#12', 'owner/widgets#12', 'subscribed', {
          subscriptions: 2,
          latest: {
            actor: 'github:alice',
            human: true,
            at: 1_700_000_000_000,
            preview: 'please fix the login redirect'
          }
        }),
        threadRow('github:owner/widgets#13', 'owner/widgets#13', 'queued', { pending: 3 })
      ],
      nextOffset: null
    })
  })
  const rows = tableRows(mounted)
  assert.deepEqual(rows.map((drawn) => cellsOf(drawn)['thread']), [
    'owner/widgets#12',
    'owner/widgets#13'
  ])
  assert.deepEqual(rows.map((drawn) => cellsOf(drawn)['subscriptions']), ['2', '0'])
  assert.equal(
    cellsOf(rows[0] ?? {})['latest'],
    'github:alice · please fix the login redirect',
    'the latest Trigger says who and what'
  )
  assert.equal(
    cellsOf(rows[1] ?? {})['latest'],
    COPY['thread.noLatest'].en,
    'a Thread with no Trigger says so instead of an empty cell'
  )
  assert.equal(cellsOf(rows[0] ?? {})['state'], COPY['thread.subscribed'].en)
  assert.equal(
    cellsOf(rows[1] ?? {})['state'],
    translate('en', 'thread.queued', { count: 3 }),
    'a queued Thread counts what waits behind it'
  )
  assert.deepEqual(
    nodeOfType(mounted, 'Table')?.props?.['columns'],
    [
      { key: 'thread', label: COPY['thread.columnThread'].en },
      { key: 'subscriptions', label: COPY['thread.columnSubscriptions'].en, align: 'end', width: 'xs' },
      { key: 'latest', label: COPY['thread.columnLatest'].en, hideBelow: 'sm' },
      { key: 'state', label: COPY['thread.columnState'].en, align: 'end', width: 'sm' }
    ],
    'the four columns of the design, in order'
  )
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('the Thread column shows the url when the Source gave no label', async () => {
  const mounted = await openTriggerTab({
    threads: () => ({
      items: [
        threadRow('github:owner/widgets#13', 'https://github.test/owner/widgets/issues/13', 'dormant', {
          url: 'https://github.test/owner/widgets/issues/13'
        })
      ],
      nextOffset: null
    })
  })
  assert.equal(cellsOf(tableRows(mounted)[0] ?? {})['thread'], 'https://github.test/owner/widgets/issues/13')
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('no Threads says so instead of drawing a placeholder page', async () => {
  const mounted = await openTriggerTab({ threads: () => ({ items: [], nextOffset: null }) })
  assert.ok(mounted.find({ text: COPY['thread.empty'].en }))
  assert.equal(
    mounted.find({ text: /A later ticket fills this page/ }),
    null,
    'the placeholder is gone'
  )
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('a Thread the Source could not poll carries the reason in its own row, next to the others', async () => {
  const mounted = await openTriggerTab({
    threads: () => ({
      items: [
        threadRow('github:owner/widgets#12', 'owner/widgets#12'),
        threadRow('github:owner/widgets#13', 'owner/widgets#13', 'error', {
          pollError: 'graphql: 502 Bad Gateway'
        })
      ],
      nextOffset: null
    })
  })
  const cells = tableRows(mounted).map(cellsOf)
  assert.equal(
    cells[1]?.['state'],
    `${COPY['thread.error'].en} · graphql: 502 Bad Gateway`,
    'the failed row says what failed'
  )
  assert.equal(cells[0]?.['state'], COPY['thread.subscribed'].en, 'the other rows are unaffected')
  assert.ok(mounted.find({ text: /graphql: 502 Bad Gateway/ }))
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('an unreadable list shows the reason and one retry that works', async () => {
  let fail = true
  const mounted = await openTriggerTab({
    threads: () => {
      if (fail) throw Object.assign(new Error('the read model is not ready'), { code: 'unavailable' })
      return { items: [threadRow('github:owner/widgets#12', 'owner/widgets#12')], nextOffset: null }
    }
  })
  assert.ok(mounted.find({ text: new RegExp(COPY['state.errorTitle'].en) }), 'the list error state')
  assert.ok(mounted.find({ text: /the read model is not ready/ }), 'the reason is shown')
  fail = false
  await mounted.press({ text: COPY['state.retry'].en })
  assert.equal(mounted.rowsOf({ type: 'Table' }).length, 1, 'the retry reads the page again')
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('a failed re-read keeps the rows already read and adds the reason', async () => {
  let fail = false
  const mounted = await openTriggerTab({
    threads: () => {
      if (fail) throw Object.assign(new Error('the store is busy'), { code: 'unavailable' })
      return { items: [threadRow('github:owner/widgets#12', 'owner/widgets#12')], nextOffset: null }
    }
  })
  assert.equal(mounted.rowsOf({ type: 'Table' }).length, 1)
  fail = true
  await mounted.post('state.changed', { revision: 2 })
  assert.ok(mounted.find({ text: /the store is busy/ }), 'the reason is inline')
  assert.equal(
    mounted.rowsOf({ type: 'Table' }).length,
    1,
    'one read failure does not clear the rows this page already read'
  )
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('the table says it is loading until the first page of Threads arrives', async () => {
  // 隐藏面板不发请求（§M.6），因此这一段稳定停在「还没读到第一页」——那正是 §M.2 的
  // `Table loading`：面板不自己画骨架，加载态就在表格上。
  const mounted = await mount(panelModule, {
    host: mockHost({
      requests: {
        state: () => snapshot(),
        threads: () => ({ items: [threadRow('github:owner/widgets#12', 'owner/widgets#12')], nextOffset: null })
      },
      // keyed atom 的 `persist: 'storage'` 读插件私有存储，与 worker 看到的是同一份。
      storage: { 'panel.page': 'trigger' }
    }),
    locale: 'en',
    visible: false
  })
  assert.equal(
    nodeOfType(mounted, 'Table')?.props?.['loading'],
    true,
    'Table loading while the list has not been read (§M.2)'
  )
  assert.equal(mounted.rowsOf({ type: 'Table' }).length, 0, 'and no row is invented meanwhile')

  await mounted.setVisible(true)
  await mounted.post('state.changed', { revision: 2 })
  assert.equal(nodeOfType(mounted, 'Table')?.props?.['loading'], false, 'the loading state ends with the rows')
  assert.equal(mounted.rowsOf({ type: 'Table' }).length, 1)
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

// ---------------------------------------------------------------------------
// 读模型：Thread 详情（§M.2 的时间线、决定、订阅与 handback 原因）
// ---------------------------------------------------------------------------

/** 一条决定（时间线上的决定与详情里的决定列表都读它）。 */
function decisionOf(overrides: Partial<Decision> = {}): Decision {
  return {
    id: 'decision-1',
    evalId: 'eval-1',
    threadKey: 'github:owner/widgets#12',
    triggerIds: ['trigger-a'],
    policyVersion: 'v3',
    at: AT,
    kind: 'accept',
    reason: [{ code: 'routed', values: { ticket: 't1' } }],
    strength: 'explicit',
    ticketId: 't1',
    ...overrides
  }
}

test('the thread detail read model carries the timeline, the decisions, the subscriptions and the handbacks', () => {
  const { repo, records, cleanup } = threadFixture()
  try {
    repo.tickets.save(ticketOf('t1'))
    repo.tickets.save(
      ticketOf('t2', { ended: { at: AT, by: 'executor', outcome: 'completed' } })
    )
    repo.threads.save(
      threadOf('owner/widgets#12', {
        lastAt: isoAfter(AT, 2 * 60_000),
        subscriptions: ['t1', 't2'],
        context: ['t2'],
        meta: { label: 'owner/widgets#12', url: 'https://github.test/owner/widgets/pull/12' },
        evaluating: {
          id: 'eval-1',
          threadKey: 'github:owner/widgets#12',
          triggerIds: ['trigger-c'],
          strength: 'inferred',
          actor: { source: 'github', id: 'bot' },
          basis: { via: 'bot', observation: { mode: 'auto' } },
          policyVersion: 'v3',
          startedAt: AT,
          deadline: isoAfter(AT, 30 * 60_000)
        }
      })
    )
    repo.triggers.save(
      triggerOf('trigger-a', 'owner/widgets#12', { text: 'please fix the login redirect' })
    )
    repo.triggers.save(
      triggerOf('trigger-b', 'owner/widgets#12', {
        at: isoAfter(AT, 60_000),
        actor: { source: 'github', id: 'bob' },
        text: 'also update the docs'
      })
    )
    repo.triggers.save(
      triggerOf('trigger-c', 'owner/widgets#12', {
        at: isoAfter(AT, 2 * 60_000),
        actor: { source: 'github', id: 'ci' },
        human: false,
        text: 'CI: 3 checks, 0 failed'
      })
    )
    repo.decisions.save(decisionOf())
    repo.triggers.saveDisposition('trigger-a', {
      evalId: 'eval-1',
      decisionId: 'decision-1',
      fanout: ['t1'],
      at: AT
    })
    repo.triggers.saveDisposition('trigger-b', {
      fanout: ['t1'],
      handbacks: [{ ticketId: 't1', reason: 'Asks for a new page', at: isoAfter(AT, 3 * 60_000) }],
      at: isoAfter(AT, 60_000)
    })

    const detail = threadDetailView(records, 'github:owner/widgets#12', { limit: 50 })
    assert.ok(detail !== undefined, 'a known Thread has a detail')
    assert.equal(detail.title, 'owner/widgets#12')
    assert.equal(detail.url, 'https://github.test/owner/widgets/pull/12')
    assert.equal(detail.source, 'github')
    assert.equal(detail.stage, 'evaluating', 'an Eval in progress is the stage')
    assert.equal(detail.pending, 0)
    assert.deepEqual(
      detail.timeline.map((card) => card.id),
      ['trigger-c', 'trigger-b', 'trigger-a'],
      'the timeline starts at the newest Trigger (§M.2)'
    )

    const [newest, handedBack, accepted] = detail.timeline
    assert.deepEqual(
      [newest?.actor, newest?.human, newest?.at, newest?.text],
      ['github:ci', false, Date.parse(isoAfter(AT, 2 * 60_000)), 'CI: 3 checks, 0 failed']
    )
    assert.equal(newest?.evaluating, true, 'the Eval in progress holds it')
    assert.equal(newest?.queued, false)
    assert.equal(newest?.canRequeue, false, 'a machine message is never requeued')

    assert.deepEqual(
      handedBack?.handbacks,
      [
        {
          ticketId: 't1',
          ticketTitle: 'Ticket t1',
          reason: 'Asks for a new page',
          at: Date.parse(isoAfter(AT, 3 * 60_000))
        }
      ],
      'a hand-back carries the Ticket it came from and why'
    )
    assert.deepEqual(handedBack?.fanout, ['t1'])
    assert.equal(handedBack?.delivered, false, 'a handed-back message is no longer owned by that worker')
    assert.equal(handedBack?.canRequeue, true, 'a person may send it to Eval again')

    assert.deepEqual(
      accepted?.decision,
      {
        id: 'decision-1',
        kind: 'accept',
        reasons: [{ code: 'routed', values: { ticket: 't1' } }],
        strength: 'explicit',
        policyVersion: 'v3',
        at: Date.parse(AT),
        ticketId: 't1'
      },
      'the Decision that consumed the Trigger is on its card'
    )
    assert.deepEqual(
      detail.decisions.map((decision) => [decision.id, decision.kind, decision.ticketId]),
      [['decision-1', 'accept', 't1']],
      'and listed in the Thread detail'
    )
    assert.deepEqual(detail.subscriptions, [
      { id: 't1', title: 'Ticket t1', state: 'open', context: false },
      { id: 't2', title: 'Ticket t2', state: 'ended', context: true }
    ], 'every subscriber, with the ones only there for context marked')
    assert.deepEqual(detail.evaluating, {
      id: 'eval-1',
      strength: 'inferred',
      triggers: 1,
      startedAt: Date.parse(AT),
      deadline: Date.parse(isoAfter(AT, 30 * 60_000))
    })
    assert.equal(detail.earlier, null, 'three Triggers fit in one page')
    assert.equal(threadDetailView(records, 'github:missing'), undefined, 'an unknown Thread has no detail')
  } finally {
    cleanup()
  }
})

test('the timeline pages backward by the (at, id) cursor without dropping or repeating a same-instant pair', () => {
  const { repo, records, cleanup } = threadFixture()
  try {
    repo.threads.save(threadOf('owner/widgets#12', { meta: { label: 'owner/widgets#12' } }))
    // 同一时刻的两条（a、b）正好落在页边界上：只用时间做游标会丢掉其中一条。
    const rows = [
      { id: 'trigger-a', at: AT },
      { id: 'trigger-b', at: AT },
      { id: 'trigger-c', at: isoAfter(AT, 60_000) },
      { id: 'trigger-d', at: isoAfter(AT, 2 * 60_000) }
    ]
    for (const row of rows) {
      repo.triggers.save(triggerOf(row.id, 'owner/widgets#12', { at: row.at }))
    }

    const first = threadDetailView(records, 'github:owner/widgets#12', { limit: 2 })
    assert.deepEqual(first?.timeline.map((card) => card.id), ['trigger-d', 'trigger-c'])
    assert.deepEqual(
      first?.earlier,
      { at: isoAfter(AT, 60_000), triggerId: 'trigger-c' },
      'the cursor is the oldest row of the page, as (at, id)'
    )

    const second = threadDetailView(records, 'github:owner/widgets#12', {
      limit: 2,
      ...(first?.earlier === null || first?.earlier === undefined ? {} : { before: first.earlier })
    })
    assert.deepEqual(
      second?.timeline.map((card) => card.id),
      ['trigger-b', 'trigger-a'],
      'the instant shared by two rows is neither skipped nor repeated'
    )
    assert.equal(second?.earlier, null, 'no more pages once the last page is short')
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// 面板：Thread 详情（时间线、决定、handback、订阅、往回翻页与三态）
// ---------------------------------------------------------------------------

/** 一条时间线上的触发卡；只写用例关心的字段。 */
function cardOf(overrides: Partial<PanelTriggerCard> = {}): PanelTriggerCard {
  return {
    id: 'trigger-a',
    source: 'github',
    actor: 'github:alice',
    human: true,
    at: 1_700_000_000_000,
    text: 'please fix the login redirect',
    queued: false,
    evaluating: false,
    delivered: false,
    fanout: [],
    handbacks: [],
    canRequeue: true,
    ...overrides
  }
}

/** 一条决定的面板面。 */
function decisionOf_(overrides: Partial<PanelDecision> = {}): PanelDecision {
  return {
    id: 'decision-1',
    kind: 'accept',
    reasons: [{ code: 'routed', values: { ticket: 't1' } }],
    strength: 'explicit',
    policyVersion: 'v3',
    at: 1_700_000_000_000,
    ticketId: 't1',
    ...overrides
  }
}

/** 一份 Thread 详情读数；只写用例关心的字段。 */
function detailOf(overrides: Partial<ThreadDetailView> = {}): ThreadDetailView {
  return {
    key: 'github:owner/widgets#12',
    source: 'github',
    title: 'owner/widgets#12',
    url: 'https://github.test/owner/widgets/pull/12',
    stage: 'subscribed',
    createdAt: 1_700_000_000_000,
    lastAt: 1_700_000_000_000,
    pending: 0,
    subscriptions: [
      { id: 't1', title: 'Ticket t1', state: 'open', context: false },
      { id: 't2', title: 'Ticket t2', state: 'ended', context: true }
    ],
    decisions: [decisionOf_()],
    timeline: [cardOf()],
    earlier: null,
    ...overrides
  }
}

test('a row opens the Thread detail: its timeline, Decision, hand-backs and subscriptions', async () => {
  const mounted = await openTriggerTab({
    threads: () => ({
      items: [threadRow('github:owner/widgets#12', 'owner/widgets#12')],
      nextOffset: null
    }),
    'thread.detail': () =>
      detailOf({
        timeline: [
          cardOf({
            id: 'trigger-b',
            actor: 'github:bob',
            at: 1_700_000_060_000,
            text: 'also update the docs',
            fanout: ['t1'],
            handbacks: [
              { ticketId: 't1', ticketTitle: 'Ticket t1', reason: 'Asks for a new page', at: 1_700_000_120_000 }
            ]
          }),
          cardOf({ id: 'trigger-a', decision: decisionOf_() })
        ]
      })
  })
  await mounted.activateRow({ type: 'Table' }, 'github:owner/widgets#12')
  assert.deepEqual(requestInput(mounted.host, 'thread.detail'), {
    threadKey: 'github:owner/widgets#12',
    limit: 50
  })
  assert.ok(mounted.find({ text: /owner\/widgets#12/ }), 'the Thread names itself')
  assert.ok(mounted.find({ text: new RegExp(COPY['thread.source'].en.replace('{source}', 'github')) }))
  assert.ok(mounted.find({ text: COPY['thread.openOriginal'].en }), 'the original link is one press away')

  // Trigger 卡：谁、什么时候、原话。
  assert.ok(mounted.find({ text: /please fix the login redirect/ }))
  assert.ok(mounted.find({ text: /also update the docs/ }))
  assert.ok(mounted.find({ text: /github:alice/ }))
  assert.ok(mounted.find({ text: /github:bob/ }))

  // Decision：消费它的决定与原因（原因按 `reason.<code>` 取词）。
  assert.ok(mounted.find({ text: new RegExp(COPY['decision.accept'].en) }))
  assert.ok(mounted.find({ text: /Routed to ticket t1/ }))

  // handback 的原因：哪个工单、为什么。
  assert.ok(mounted.find({ text: /Asks for a new page/ }))
  assert.ok(
    mounted.find({
      text: new RegExp(
        translate('en', 'thread.handedBack', { ticket: 'Ticket t1', reason: 'Asks for a new page' })
      )
    }),
    'the hand-back says which Ticket sent it back and why'
  )

  // 订阅：每张工单，只当语境的那张标出来。
  assert.ok(mounted.find({ text: /Ticket t1/ }))
  assert.ok(mounted.find({ text: /Ticket t2/ }))
  assert.ok(mounted.find({ text: new RegExp(COPY['thread.contextOnly'].en) }))
  assert.equal(
    mounted.find({ text: COPY['thread.loadEarlier'].en }),
    null,
    'one page of Triggers, so no earlier page is offered'
  )
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('the timeline reads older pages back without dropping or repeating a same-instant pair', async () => {
  // 最新在前；a 与 b 同一时刻，正好落在页边界上（只用时间做游标就会丢掉其中一条）。
  const cards: readonly PanelTriggerCard[] = [
    cardOf({ id: 'trigger-d', at: 120_000, text: 'message trigger-d' }),
    cardOf({ id: 'trigger-c', at: 60_000, text: 'message trigger-c' }),
    cardOf({ id: 'trigger-b', at: 0, text: 'message trigger-b' }),
    cardOf({ id: 'trigger-a', at: 0, text: 'message trigger-a' })
  ]
  const at = (card: PanelTriggerCard): string => new Date(card.at).toISOString()
  const mounted = await openTriggerTab({
    threads: () => ({
      items: [threadRow('github:owner/widgets#12', 'owner/widgets#12')],
      nextOffset: null
    }),
    'thread.detail': (input) => {
      const window = (input ?? {}) as {
        readonly before?: { readonly at: string; readonly triggerId: string }
        readonly limit?: number
      }
      const from =
        window.before === undefined
          ? 0
          : cards.findIndex(
              (card) => card.at === Date.parse(window.before!.at) && card.id === window.before!.triggerId
            ) + 1
      const page = cards.slice(from, from + 2)
      const last = page.at(-1)
      return {
        ...detailOf(),
        timeline: page,
        earlier:
          from + 2 < cards.length && last !== undefined
            ? { at: at(last), triggerId: last.id }
            : null
      }
    }
  })
  await mounted.activateRow({ type: 'Table' }, 'github:owner/widgets#12')
  assert.equal(mounted.findAll({ text: /message trigger-/ }).length, 2, 'the newest page first')

  await mounted.press({ text: COPY['thread.loadEarlier'].en })
  assert.deepEqual(
    requestInput(mounted.host, 'thread.detail'),
    {
      threadKey: 'github:owner/widgets#12',
      limit: 50,
      before: { at: new Date(60_000).toISOString(), triggerId: 'trigger-c' }
    },
    'the earlier page is asked for by the (at, id) cursor'
  )
  for (const id of ['trigger-a', 'trigger-b', 'trigger-c', 'trigger-d']) {
    assert.equal(mounted.findAll({ text: new RegExp(`message ${id}`) }).length, 1, `${id} appears once`)
  }
  assert.equal(
    mounted.find({ text: COPY['thread.loadEarlier'].en }),
    null,
    'the last page offers no earlier page'
  )
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('a Thread being evaluated and one whose polling failed say so on the detail', async () => {
  const mounted = await openTriggerTab({
    threads: () => ({
      items: [threadRow('github:owner/widgets#12', 'owner/widgets#12', 'evaluating')],
      nextOffset: null
    }),
    'thread.detail': () =>
      detailOf({
        stage: 'evaluating',
        pollError: 'graphql: 502 Bad Gateway',
        evaluating: {
          id: 'eval-1',
          strength: 'inferred',
          triggers: 2,
          startedAt: 1_700_000_000_000,
          deadline: 1_700_001_800_000
        }
      })
  })
  await mounted.activateRow({ type: 'Table' }, 'github:owner/widgets#12')
  assert.ok(
    mounted.find({
      text: literal(
        translate('en', 'thread.evaluatingBanner', {
          count: 2,
          strength: COPY['strength.inferred'].en
        })
      )
    }),
    'the Eval in progress is a banner'
  )
  assert.ok(
    mounted.find({
      text: literal(translate('en', 'thread.pollFailed', { error: 'graphql: 502 Bad Gateway' }))
    })
  )
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('an unreadable Thread detail shows the reason and one retry that works, leaving the list alone', async () => {
  let fail = true
  const mounted = await openTriggerTab({
    threads: () => ({
      items: [threadRow('github:owner/widgets#12', 'owner/widgets#12')],
      nextOffset: null
    }),
    'thread.detail': () => {
      if (fail) throw Object.assign(new Error('the thread read failed'), { code: 'unavailable' })
      return detailOf()
    }
  })
  await mounted.activateRow({ type: 'Table' }, 'github:owner/widgets#12')
  assert.ok(mounted.find({ text: new RegExp(COPY['state.errorTitle'].en) }))
  assert.ok(mounted.find({ text: /the thread read failed/ }), 'the reason is shown')

  // 这一行的读失败不影响列表：返回后行还在，且不用重读。
  await mounted.press({ text: COPY['thread.back'].en })
  assert.equal(mounted.rowsOf({ type: 'Table' }).length, 1, 'the list is still there')

  await mounted.activateRow({ type: 'Table' }, 'github:owner/widgets#12')
  assert.ok(mounted.find({ text: COPY['state.retry'].en }), 'the same row read again gives the error again')
  fail = false
  await mounted.press({ text: COPY['state.retry'].en })
  assert.ok(mounted.find({ text: /please fix the login redirect/ }), 'the retry reads it again')
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

// ---------------------------------------------------------------------------
// 动作：再评估一次（有结果反馈）、取消订阅（二次确认）、被拒绝时如实说原因
// ---------------------------------------------------------------------------

test('Evaluate again asks the worker for that Trigger and says whether an Eval took it', async () => {
  let queued = true
  const mounted = await openTriggerTab({
    threads: () => ({
      items: [threadRow('github:owner/widgets#12', 'owner/widgets#12')],
      nextOffset: null
    }),
    'thread.detail': () =>
      detailOf({
        timeline: [
          cardOf({ id: 'trigger-b', text: 'also update the docs', canRequeue: false }),
          cardOf({ id: 'trigger-a', decision: decisionOf_(), canRequeue: true })
        ]
      }),
    'trigger.requeue': () => ({ queued })
  })
  await mounted.activateRow({ type: 'Table' }, 'github:owner/widgets#12')

  assert.equal(
    mounted.findAll({ text: COPY['thread.requeue'].en }).length,
    1,
    'only the Trigger a person may send back offers the action'
  )
  await mounted.press({ text: COPY['thread.requeue'].en })
  assert.deepEqual(requestInput(mounted.host, 'trigger.requeue'), { triggerId: 'trigger-a' })
  assert.ok(mounted.find({ text: COPY['thread.requeued'].en }), 'the result is reported')

  queued = false
  await mounted.press({ text: COPY['thread.requeue'].en })
  assert.ok(
    mounted.find({ text: COPY['thread.requeueHeld'].en }),
    'an Eval that already holds it is reported as such, not as success'
  )
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('Unsubscribe asks before acting, and cancelling sends nothing', async () => {
  const mounted = await openTriggerTab({
    threads: () => ({
      items: [threadRow('github:owner/widgets#12', 'owner/widgets#12')],
      nextOffset: null
    }),
    'thread.detail': () => detailOf(),
    'thread.unsubscribe': () => ({ removed: true })
  })
  await mounted.activateRow({ type: 'Table' }, 'github:owner/widgets#12')
  await mounted.press({ text: COPY['thread.unsubscribe'].en })
  const question = translate('en', 'confirm.body', {
    action: COPY['thread.unsubscribe'].en,
    target: 'owner/widgets#12'
  })
  assert.ok(mounted.find({ text: literal(question) }), 'the inline confirm names the Thread')
  assert.equal(requestNames(mounted.host).includes('thread.unsubscribe'), false, 'nothing is sent yet')

  await mounted.press({ text: COPY['action.cancel'].en })
  assert.equal(mounted.find({ text: literal(question) }), null, 'cancel closes the confirmation')
  assert.equal(
    requestNames(mounted.host).includes('thread.unsubscribe'),
    false,
    'cancel has no side effect'
  )

  await mounted.press({ text: COPY['thread.unsubscribe'].en })
  await mounted.press({ text: COPY['action.confirm'].en })
  assert.deepEqual(requestInput(mounted.host, 'thread.unsubscribe'), {
    thread: 'github:owner/widgets#12'
  })
  assert.ok(mounted.find({ text: COPY['thread.unsubscribeDone'].en }), 'the result is reported')
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('a refused action names its reason instead of pretending it worked', async () => {
  const mounted = await openTriggerTab({
    threads: () => ({
      items: [threadRow('github:owner/widgets#12', 'owner/widgets#12')],
      nextOffset: null
    }),
    'thread.detail': () => detailOf({ timeline: [cardOf({ canRequeue: true })] }),
    'trigger.requeue': () => {
      throw Object.assign(new Error("A ticket's worker still owns this message"), {
        code: 'notRequeueable'
      })
    }
  })
  await mounted.activateRow({ type: 'Table' }, 'github:owner/widgets#12')
  await mounted.press({ text: COPY['thread.requeue'].en })
  assert.ok(mounted.find({ text: /A ticket's worker still owns this message/ }))
  assert.equal(mounted.find({ text: COPY['thread.requeued'].en }), null, 'no success is claimed')
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

// ---------------------------------------------------------------------------
// worker 侧的接线（§M.6）：面板发的每一条 Trigger 请求都由 worker 应答；不存在的对象是固定
// 拒绝，而不是编一个空壳读数。
// ---------------------------------------------------------------------------

test('the worker answers the Trigger requests the panel sends', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'superagent-trigger-'))
  const worker = await mountWorker(main, { host: mockHost({ settings: { stateDir } }) })
  try {
    // 空库也是一页：列表回答 `{items: [], nextOffset: null}`，不是拒绝。
    assert.deepEqual(await worker.request('threads', { filter: 'subscribed', offset: 0, limit: 50 }), {
      items: [],
      nextOffset: null
    })
    const refused = (name: string, input?: Record<string, unknown>, code = 'unknownThread') =>
      assert.rejects(worker.request(name, input), (error: unknown) => {
        assert.equal((error as { code?: string }).code, code, `${name} refuses with ${code}`)
        return true
      })
    await refused('thread.detail', { threadKey: 'github:nope' })
    await refused('thread.unsubscribe', { threadKey: 'github:nope' })
    await refused('trigger.requeue', { triggerId: 'trigger-nope' }, 'unknownTrigger')
    // 形状不对的请求是 `invalid_params`，而不是一个空答案。
    await refused('thread.detail', {}, 'invalid_params')
    await refused('thread.detail', { threadKey: 'github:x', before: { at: '' } }, 'invalid_params')
    await refused('trigger.requeue', {}, 'invalid_params')
    await refused('threads', { filter: 'always' }, 'invalid_params')
    assert.deepEqual(worker.refusals, [])
  } finally {
    await worker.deactivate()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

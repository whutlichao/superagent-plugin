// Search 页与术语表覆盖层（§M.1 的第 7 项、§M.2 的 Search 行、§M.5 的双语术语表）。
//
// 断言分两层：
// - 面板侧：挂载真面板模块，停在 Search 页。查询原样发给 worker 的 `search` 请求（`#12`、
//   链接、消息 id 与普通文字都不在面板里解释），三组命中各自成组，点结果跳到拥有它的详情页；
//   无结果与失败各有明确状态。术语表是页头的覆盖层：两种语言都能开能关，导航项仍是七个。
// - worker 侧：`worker.request('search', …)` 走真正的读模型与两个 Source 的 `find`——
//   `#12`、Issue/PR 链接、评论链接、Feishu 消息 id 与工单标题各自落在对的分组里。
import { assert, hostError, mockHost, mount, mountWorker, test } from 'orca/testing'
import { rmSync } from 'node:fs'
import * as main from '../src/worker/main'
import type { Thread, Ticket, Trigger } from '../src/worker/core/index'
import { createRepositories } from '../src/worker/app/repositories'
import { COPY, GLOSSARY_TERMS, translate } from '../src/panel/copy'
import * as panelModule from '../src/panel/panel'
import type {
  PanelSearchThread,
  PanelSearchTrigger,
  PanelState,
  PanelTicket,
  SearchPageView,
  ThreadDetailView,
  TicketDetailView
} from '../src/panel/protocol'
import { AT, isoAfter, openTempStore, tempStateDir } from './support/state'
import { currentPage, navOptions, openPage } from './support/panel-nav'

/** `mockHost` 的请求表类型（测试里只写用到的几个名字）。 */
type Requests = NonNullable<NonNullable<Parameters<typeof mockHost>[0]>['requests']>

/** 一份健康快照；Search 页自己发查询，快照只决定全局三态。 */
function snapshot(): PanelState {
  return {
    revision: 1,
    booted: true,
    health: {
      error: false,
      paused: false,
      setupMissing: false,
      sources: { enabled: 0, problems: 0 },
      activity: { received: 4, evaluated: 3, accepted: 1, ignored: 2, ended: 0 },
      executor: { running: 0, maxWorkers: 4, humanSlot: 'free' }
    },
    attention: { answer: 0, review: 0, problems: 0, items: [] },
    problems: []
  }
}

/** 固定的命中时刻（epoch ms）。 */
const AT_MS = 1_700_000_000_000

/** 一条命中的 Trigger；每个用例只写它关心的字段。 */
function triggerHit(overrides: Partial<PanelSearchTrigger> = {}): PanelSearchTrigger {
  return {
    id: 'trigger-a',
    source: 'github',
    at: AT_MS,
    from: 'alice',
    human: true,
    text: 'please fix the build',
    thread: 'github:12',
    ...overrides
  }
}

/** 一条命中的 Thread。 */
function threadHit(overrides: Partial<PanelSearchThread> = {}): PanelSearchThread {
  return { key: 'github:12', source: 'github', title: 'owner/widgets#12', ...overrides }
}

/** 一条命中的 Ticket（与 Execution 行同形）。 */
function ticketHit(overrides: Partial<PanelTicket> = {}): PanelTicket {
  return { id: 't1', title: 'Fix the login redirect', stage: 'working', at: AT_MS, ...overrides }
}

/** 一份 Search 读数；默认三组为空。 */
function pageOf(overrides: Partial<SearchPageView> = {}): SearchPageView {
  return {
    query: 'build',
    terms: ['build'],
    triggers: { items: [], truncated: false },
    threads: { items: [], truncated: false },
    tickets: { items: [], truncated: false },
    ...overrides
  }
}

/** 一条 Thread 的详情：只写到画得出来（跳转要落到它上面）。 */
function threadDetailOf(key: string): ThreadDetailView {
  return {
    key,
    source: 'github',
    title: key,
    stage: 'subscribed',
    createdAt: AT_MS,
    lastAt: AT_MS,
    pending: 0,
    subscriptions: [],
    decisions: [],
    timeline: [],
    earlier: null
  }
}

/** 一张工单的详情：只写到画得出来。 */
function ticketDetailOf(ticketId: string): TicketDetailView {
  return {
    id: ticketId,
    title: 'Fix the login redirect',
    stage: 'working',
    at: AT_MS,
    mandate: {
      strength: 'explicit',
      actor: 'github:alice',
      policyVersion: 'v3',
      via: 'addressed',
      rules: []
    },
    waitingInputs: [],
    subscriptions: [],
    assignments: [],
    reports: [],
    canRetry: false
  }
}

let panel: Awaited<ReturnType<typeof mount>> | undefined

/** 挂载面板并停在 Search 页。 */
async function openSearchTab(requests: Requests): Promise<Awaited<ReturnType<typeof mount>>> {
  panel = await mount(panelModule, {
    host: mockHost({ requests: { state: () => snapshot(), ...requests } }),
    locale: 'en'
  })
  await openPage(panel, 'search')
  return panel
}

/** 面板发过的请求（按顺序）。 */
function requestNames(host: ReturnType<typeof mockHost>): string[] {
  return host.callsOf('plugin.request').map((params) => (params as { name?: string }).name ?? '')
}

/** 一次请求的最后一个入参（同一请求发了多次时看最后那次）。 */
function lastInput(
  host: ReturnType<typeof mockHost>,
  name: string
): Record<string, unknown> | undefined {
  const inputs = host
    .callsOf('plugin.request')
    .map((params) => params as { name?: string; input?: unknown })
    .filter((params) => params.name === name)
    .map((params) => params.input)
  return inputs.at(-1) as Record<string, unknown> | undefined
}

/** 在搜索框里打一条并提交（Search 页的主操作）。 */
async function search(mounted: Awaited<ReturnType<typeof mount>>, query: string): Promise<void> {
  await mounted.type({ type: 'Input', label: COPY['search.label'].en }, query, {
    replace: true,
    submit: true
  })
}

// ---------------------------------------------------------------------------
// 面板侧：查询与三组结果（§M.2 的 Search 行）
// ---------------------------------------------------------------------------

test('submitting a query asks the worker and shows the three groups', async () => {
  const mounted = await openSearchTab({
    search: () =>
      pageOf({
        triggers: { items: [triggerHit()], truncated: false },
        threads: { items: [threadHit()], truncated: false },
        tickets: { items: [ticketHit()], truncated: false }
      })
  })
  assert.deepEqual(
    requestNames(mounted.host).filter((name) => name === 'search'),
    [],
    'nothing is searched until a query is submitted'
  )

  await search(mounted, 'build')
  assert.deepEqual(lastInput(mounted.host, 'search'), { query: 'build' })
  for (const group of ['triggers', 'threads', 'tickets'] as const) {
    assert.ok(
      mounted.find({ text: new RegExp(translate('en', `search.group.${group}`)) }),
      `the ${group} group is shown`
    )
  }
  assert.ok(mounted.find({ text: /please fix the build/ }), 'the Trigger preview')
  assert.ok(mounted.find({ text: /owner\/widgets#12/ }), 'the Thread title')
  assert.ok(mounted.find({ text: /Fix the login redirect/ }), 'the Ticket title')
  assert.ok(mounted.find({ text: new RegExp(translate('en', 'search.terms', { terms: 'build' })) }))
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('a #12 reference and a link are sent verbatim and keep their groups', async () => {
  const mounted = await openSearchTab({
    search: (input) => {
      const query = (input as { query?: string } | null)?.query ?? ''
      if (query === '#12') {
        return pageOf({
          query,
          terms: ['#12'],
          threads: { items: [threadHit()], truncated: false },
          tickets: { items: [ticketHit()], truncated: false }
        })
      }
      return pageOf({
        query,
        terms: [query],
        threads: { items: [threadHit({ key: 'github:45', title: 'owner/widgets#45' })], truncated: false }
      })
    }
  })

  await search(mounted, '#12')
  assert.deepEqual(lastInput(mounted.host, 'search'), { query: '#12' }, 'the shorthand is not rewritten')
  assert.ok(mounted.find({ text: /owner\/widgets#12/ }))
  assert.ok(mounted.find({ text: /Fix the login redirect/ }), 'thread matches also name their tickets')

  const link = 'https://github.com/acme/widgets/pull/45#discussion_r7001'
  await search(mounted, link)
  assert.deepEqual(lastInput(mounted.host, 'search'), { query: link }, 'the link is not rewritten')
  assert.ok(mounted.find({ text: /owner\/widgets#45/ }))
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('a truncated group says how many hits it shows', async () => {
  const mounted = await openSearchTab({
    search: () =>
      pageOf({ triggers: { items: [triggerHit(), triggerHit({ id: 'trigger-b', text: 'and the tests' })], truncated: true } })
  })
  await search(mounted, 'build')
  assert.ok(
    mounted.find({ text: new RegExp(translate('en', 'search.truncated', { count: 2 })) }),
    'the page is honest about the cut'
  )
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

// ---------------------------------------------------------------------------
// 跳转：每类结果去拥有它的详情页（§M.2「点结果跳转」）
// ---------------------------------------------------------------------------

test('a Trigger hit opens the Thread that owns it', async () => {
  const mounted = await openSearchTab({
    search: () => pageOf({ triggers: { items: [triggerHit()], truncated: false } }),
    'thread.detail': () => threadDetailOf('github:12')
  })
  await search(mounted, 'build')
  await mounted.press({ text: /please fix the build/ })
  assert.equal(currentPage(mounted), 'trigger', 'the Trigger page owns a Trigger')
  assert.deepEqual(lastInput(mounted.host, 'thread.detail'), { threadKey: 'github:12', limit: 50 })
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('a Thread hit opens its detail', async () => {
  const mounted = await openSearchTab({
    search: () => pageOf({ threads: { items: [threadHit()], truncated: false } }),
    'thread.detail': () => threadDetailOf('github:12')
  })
  await search(mounted, 'build')
  await mounted.press({ text: /owner\/widgets#12/ })
  assert.equal(currentPage(mounted), 'trigger')
  assert.deepEqual(lastInput(mounted.host, 'thread.detail'), { threadKey: 'github:12', limit: 50 })
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('a Ticket hit opens its detail on the Execution page', async () => {
  const mounted = await openSearchTab({
    search: () => pageOf({ tickets: { items: [ticketHit()], truncated: false } }),
    'ticket.detail': () => ticketDetailOf('t1')
  })
  await search(mounted, 'login redirect')
  await mounted.press({ text: /Fix the login redirect/ })
  assert.equal(currentPage(mounted), 'execution', 'the Execution page owns a Ticket')
  assert.deepEqual(lastInput(mounted.host, 'ticket.detail'), { ticketId: 't1' })
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

// ---------------------------------------------------------------------------
// 三态：没有命中、搜索失败与重试（§M.2 的 Search 行）
// ---------------------------------------------------------------------------

test('no matches names the query, offers Clear search, and is not an error', async () => {
  const mounted = await openSearchTab({ search: () => pageOf({ query: 'nothing-matches-this' }) })
  await search(mounted, 'nothing-matches-this')
  const named = translate('en', 'search.noMatchesQuery', { query: 'nothing-matches-this' })
  assert.ok(mounted.find({ text: named }), 'the empty state names the query')
  assert.equal(mounted.find({ text: COPY['state.errorTitle'].en }), null, 'no error is claimed')
  assert.equal(mounted.find({ type: 'Button', text: COPY['state.retry'].en }), null, 'no retry either')
  // 一步出口：清除搜索，回到「输入一条查询」的空态提示。
  await mounted.press({ type: 'Button', text: COPY['search.clear'].en })
  assert.equal(mounted.find({ text: named }), null, 'the empty state closes')
  assert.ok(mounted.find({ text: COPY['search.idle'].en }), 'the page is back to its idle hint')
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('a failed search gives the reason and a retry', async () => {
  let attempts = 0
  const mounted = await openSearchTab({
    search: () => {
      attempts += 1
      if (attempts === 1) throw hostError('unavailable', 'the worker is not answering')
      return pageOf({ threads: { items: [threadHit()], truncated: false } })
    }
  })
  await search(mounted, 'build')
  assert.ok(
    mounted.find({ text: new RegExp(translate('en', 'state.errorHint', { reason: 'the worker is not answering' })) }),
    'the reason is shown'
  )
  await mounted.press({ type: 'Button', text: COPY['state.retry'].en })
  assert.ok(mounted.find({ text: /owner\/widgets#12/ }), 'retry reads the same query again')
  assert.equal(mounted.find({ text: /No matches for/ }), null)
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

// ---------------------------------------------------------------------------
// 术语表：页头覆盖层，可开可关，两种语言都在（§M.1、§M.5）
// ---------------------------------------------------------------------------

test('the glossary opens from the header in both languages and is not a navigation item', async () => {
  for (const locale of ['zh-CN', 'en-US'] as const) {
    const mounted = await mount(panelModule, {
      host: mockHost({ requests: { state: () => snapshot() } }),
      locale
    })
    // 导航是面板自有的可换行单选条（`RadioGroup`），不是宿主的 `Tabs`。
    const navCount = (): number => navOptions(mounted, locale).length
    assert.equal(navCount(), 7, `${locale}: seven navigation items`)
    assert.equal(
      mounted.find({ text: new RegExp(COPY['glossary.meaning.mandate'].zh) }),
      null,
      `${locale}: the glossary starts closed`
    )
    const opener = COPY['panel.glossaryOpen'][locale === 'zh-CN' ? 'zh' : 'en']
    assert.ok(mounted.find({ role: 'button', label: opener }), 'the header control is reachable by name')
    await mounted.press({ label: opener })
    const term = COPY['term.mandate'][locale === 'zh-CN' ? 'zh' : 'en']
    const meaning = COPY['glossary.meaning.mandate'][locale === 'zh-CN' ? 'zh' : 'en']
    assert.ok(mounted.find({ text: new RegExp(term) }), `${locale}: the term is listed`)
    assert.ok(mounted.find({ text: new RegExp(meaning) }), `${locale}: and what it means`)
    assert.equal(navCount(), 7, `${locale}: still no eighth page`)
    await mounted.press({ text: COPY['panel.glossaryClose'][locale === 'zh-CN' ? 'zh' : 'en'] })
    assert.equal(mounted.find({ text: new RegExp(meaning) }), null, `${locale}: close removes the overlay`)
    assert.deepEqual(mounted.refusals, [])
    await mounted.unmount()
  }
  panel = undefined
})

test('every glossary term carries both languages, and none is empty', () => {
  const missing = GLOSSARY_TERMS.flatMap((term) => {
    const name = COPY[`term.${term}` as keyof typeof COPY]
    const meaning = COPY[`glossary.meaning.${term}` as keyof typeof COPY]
    return [
      ...(name === undefined || name.zh.trim() === '' || name.en.trim() === ''
        ? [`term.${term}`]
        : []),
      ...(meaning === undefined || meaning.zh.trim() === '' || meaning.en.trim() === ''
        ? [`glossary.meaning.${term}`]
        : [])
    ]
  })
  assert.deepEqual(missing, [])
  // 设计点名的术语一个都不少。
  for (const term of [
    'source',
    'trigger',
    'thread',
    'correlation',
    'channel',
    'policy',
    'eval',
    'decision',
    'mandate',
    'ticket',
    'assignment',
    'subscription',
    'report',
    'attention',
    'input',
    'disposition',
    'strength'
  ]) {
    assert.ok(
      (GLOSSARY_TERMS as readonly string[]).includes(term),
      `${term} is in the glossary the overlay renders`
    )
  }
})

// ---------------------------------------------------------------------------
// worker 侧的接线（§M.6）：面板发的 `search` 由 worker 用两个 Source 的 `find` 回答
// ---------------------------------------------------------------------------

/** 一条 Thread（真库里由 `repo.threads.save` 落盘）。 */
function threadOf(key: string, overrides: Partial<Thread> = {}): Thread {
  const [source, ...rest] = key.split(':')
  return {
    key,
    ref: { source: source as string, id: rest.join(':') },
    createdAt: isoAfter(AT, -60_000),
    subscriptions: [],
    correlated: [],
    pending: [],
    meta: {},
    lastAt: AT,
    ...overrides
  }
}

/** 一条 Trigger，挂在 `ref` 指的那条 Thread 上。 */
function triggerOf(id: string, thread: Thread, overrides: Partial<Trigger> = {}): Trigger {
  return {
    id,
    source: thread.ref.source,
    threads: [thread.ref],
    actor: { source: thread.ref.source, id: 'alice' },
    human: true,
    at: AT,
    text: `message ${id}`,
    meta: {},
    ...overrides
  }
}

/** 一张工单：标题是用来搜的那个事实。 */
function ticketOf(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 't1',
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
    origin: { triggerId: 'trigger-build', triggerIds: ['trigger-build'] },
    ...overrides
  }
}

/**
 * 一个带数据的真库，然后由 worker 在同一个状态目录上启动：搜索经由它真实的 `search` handler
 * （`find` → 分组 → 面板形状）回答，测试不伪造命中的判定。
 */
function seededStateDir(): string {
  const { store, stateDir } = openTempStore({ keepDir: true })
  try {
    const repo = createRepositories(store)
    const issue = threadOf('github:12', {
      meta: { label: 'owner/widgets#12', url: 'https://github.com/acme/widgets/issues/12' }
    })
    const pull = threadOf('github:45', {
      meta: { label: 'owner/widgets#45', url: 'https://github.com/acme/widgets/pull/45' }
    })
    const chat = threadOf('feishu:oc_team:om_root', { meta: { label: 'Team chat' } })
    for (const thread of [issue, pull, chat]) repo.threads.save(thread)
    repo.triggers.save(
      triggerOf('trigger-build', issue, { text: 'please fix the build on the login page' })
    )
    repo.triggers.save(
      triggerOf('trigger-review', pull, {
        text: 'the diff looks fine',
        meta: { url: 'https://github.com/acme/widgets/pull/45#discussion_r7001' }
      })
    )
    repo.triggers.save(
      triggerOf('trigger-chat', chat, {
        text: 'unrelated words',
        meta: { messageId: 'om_source' }
      })
    )
    repo.tickets.save(ticketOf())
  } finally {
    // 关掉写者，交给 worker 打开：搜索读的就是它写下的那份。
    store.close()
  }
  return stateDir
}

test('the worker answers search: shorthand, links, comment links, message ids and titles', async () => {
  const stateDir = seededStateDir()
  const worker = await mountWorker(main, { host: mockHost({ settings: { stateDir, agent: 'pi' } }) })
  try {
    // `#12` → Thread 12（Ticket 跟随/来源的 Thread 命中，于是它也出现在 Ticket 组）。
    const byThread = (await worker.request('search', { query: '#12' })) as SearchPageView
    assert.deepEqual(byThread.query, '#12')
    assert.deepEqual(byThread.threads.items.map((item) => item.key), ['github:12'])
    assert.deepEqual(byThread.triggers.items, [], 'no trigger text contains #12')
    assert.deepEqual(byThread.tickets.items.map((item) => item.id), ['t1'])

    // Issue 链接与 `#12` 是同一件事。
    const byLink = (await worker.request('search', {
      query: 'https://github.com/acme/widgets/issues/12'
    })) as SearchPageView
    assert.deepEqual(byLink.threads.items.map((item) => item.key), ['github:12'])

    // 评论链接：Thread 仍是那个 PR，命中那条评论自己的正文/链接。
    const byComment = (await worker.request('search', {
      query: 'https://github.com/acme/widgets/pull/45#discussion_r7001'
    })) as SearchPageView
    assert.deepEqual(byComment.threads.items.map((item) => item.key), ['github:45'])
    assert.deepEqual(byComment.triggers.items.map((item) => item.id), ['trigger-review'])
    assert.equal(
      byComment.triggers.items[0]?.thread,
      'github:45',
      'a Trigger hit names the Thread it came from, so the panel can jump'
    )

    // Feishu 的消息 id：搜索词里带着它，命中的是存了它的那条财报。
    const byMessage = (await worker.request('search', { query: 'om_source' })) as SearchPageView
    assert.deepEqual(byMessage.triggers.items.map((item) => item.id), ['trigger-chat'])

    // 工单标题：Ticket 组自己命中，不需要经过 Thread。
    const byTitle = (await worker.request('search', { query: 'login redirect' })) as SearchPageView
    assert.deepEqual(byTitle.tickets.items.map((item) => item.id), ['t1'])
    assert.equal(byTitle.tickets.items[0]?.title, 'Fix the login redirect')

    // 无命中不是错误：三组为空、查询原样回。
    const none = (await worker.request('search', { query: 'nothing-matches-this' })) as SearchPageView
    assert.deepEqual(none.triggers.items, [])
    assert.deepEqual(none.threads.items, [])
    assert.deepEqual(none.tickets.items, [])
    assert.equal(none.query, 'nothing-matches-this')

    // 空查询是固定拒绝（面板也不会发）。
    await assert.rejects(worker.request('search', { query: '   ' }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'invalid_params')
      return true
    })
    await assert.rejects(worker.request('search', {}), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'invalid_params')
      return true
    })
    assert.deepEqual(worker.refusals, [])
  } finally {
    await worker.deactivate()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('the worker search leaves out a trigger that belongs to no thread but never invents one', async () => {
  const stateDir = tempStateDir()
  const worker = await mountWorker(main, { host: mockHost({ settings: { stateDir, agent: 'pi' } }) })
  try {
    // 空库：搜索回答空的三组，而不是拒绝或编造命中。
    const empty = (await worker.request('search', { query: 'anything' })) as SearchPageView
    assert.deepEqual(empty.triggers, { items: [], truncated: false })
    assert.deepEqual(empty.threads, { items: [], truncated: false })
    assert.deepEqual(empty.tickets, { items: [], truncated: false })
    assert.deepEqual(worker.refusals, [])
  } finally {
    await worker.deactivate()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

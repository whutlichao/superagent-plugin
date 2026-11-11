// Source 页（§M.2、§I.1–§I.3、§J.1）：每个配置过的 Source 一张卡——开关、字段、派生事实、
// health 条目、24 小时计数、被过滤的 Trigger（带原因码）、被 drop 的消息（带原因与链接），
// 以及内联的 setup 问题。动作是打开/关闭、立即同步、检查一次、刷新显示名；单个 Source 的
// 失败只留在它自己的卡上。
//
// 断言分两层：
// - 面板侧：挂载真面板模块，读 Source 页；卡片内容与四个动作都是 worker 的请求，断言发出去
//   的请求名、入参与反馈；
// - 读模型侧：`sourcePage` 把真库里的 Trigger、disposition 与 outbox 行变成面板面（24 h 窗口、
//   排序、链接）。
import { rmSync } from 'node:fs'
import { afterEach, assert, hostError, mockHost, mount, mountWorker, test } from 'orca/testing'
import { mock } from 'node:test'
import * as main from '../src/worker/main'
import type { HealthEntry, Thread, Ticket, Trigger } from '../src/worker/core/index'
import { createOutbox } from '../src/worker/app/outbox'
import type { OutboxRecord } from '../src/worker/app/records'
import { createRepositories } from '../src/worker/app/repositories'
import type { SetupIssue } from '../src/worker/app/setup-types'
import { sourcePage, type SourceKindView, type SourceViewHost } from '../src/worker/app/views/sources'
import { SourceRegistry, type SourceOverview } from '../src/worker/sources/registry'
import { object } from '../src/worker/infra/schema'
import type { Fact, SourceContext } from '../src/worker/sources/kind'
import { COPY, translate } from '../src/panel/copy'
import * as panelModule from '../src/panel/panel'
import type {
  PanelSource,
  PanelState,
  SourcePageView,
  TicketDetailView
} from '../src/panel/protocol'
import { AT, isoAfter, openTempStore, tempStateDir } from './support/state'
import { currentPage, openPage } from './support/panel-nav'

/** `mockHost` 的请求表类型（测试里只写用到的几个名字）。 */
type Requests = NonNullable<NonNullable<Parameters<typeof mockHost>[0]>['requests']>

/** 一份健康快照；Source 页自己读 `sources`，快照只决定全局三态。 */
function snapshot(): PanelState {
  return {
    revision: 1,
    booted: true,
    health: {
      error: false,
      paused: false,
      setupMissing: false,
      sources: { enabled: 2, problems: 0 },
      activity: { received: 12, evaluated: 9, accepted: 3, ignored: 6, ended: 1 },
      executor: { running: 0, maxWorkers: 4, humanSlot: 'free' }
    },
    attention: { answer: 0, review: 0, problems: 0, items: [] },
    problems: [],
    tickets: []
  }
}

/** 固定的 24 小时窗口起点（epoch ms）：测试不读真实时钟。 */
const NOW_MS = Date.parse(AT)

/** 一张 Source 卡；每个用例只写它关心的字段。 */
function card(overrides: Partial<PanelSource> & Pick<PanelSource, 'id'>): PanelSource {
  return {
    title: { zh: overrides.id, en: overrides.id },
    installed: true,
    enabled: true,
    state: 'ready',
    fields: [],
    facts: [],
    health: [],
    stats: { received: 0, filtered: 0 },
    filtered: { total: 0, items: [] },
    dropped: { total: 0, items: [] },
    canSync: false,
    canRefreshLabels: false,
    ...overrides
  }
}

/** 一份 Source 页读数。 */
function pageOf(items: readonly PanelSource[], elsewhere: SourcePageView['elsewhere'] = []): SourcePageView {
  return { items, elsewhere }
}

/** GitHub 的卡：两个字段、一条事实、一条 health 与 24 小时计数。 */
function githubCard(overrides: Partial<PanelSource> = {}): PanelSource {
  return card({
    id: 'github',
    title: { zh: 'GitHub', en: 'GitHub' },
    fields: [
      { key: 'repository', label: { zh: '监听的仓库', en: 'Repository' }, value: { type: 'text', text: 'acme/widgets' } },
      {
        key: 'observeComments',
        label: { zh: '监听新评论', en: 'Observe comments' },
        value: { type: 'flag', on: true }
      }
    ],
    facts: [{ key: 'account', label: { zh: '当前账号', en: 'Account' }, value: '@agent-bot' }],
    health: [{ name: 'github', state: 'ready', detail: 'polled 2 s ago' }],
    stats: { received: 12, filtered: 2, lastAt: NOW_MS - 60_000 },
    ...overrides
  })
}

/** Feishu 的卡：可同步、可刷新显示名。 */
function feishuCard(overrides: Partial<PanelSource> = {}): PanelSource {
  return card({
    id: 'feishu',
    title: { zh: '飞书', en: 'Feishu' },
    canSync: true,
    canRefreshLabels: true,
    fields: [
      {
        key: 'chats',
        label: { zh: '接收的群', en: 'Chats' },
        value: {
          type: 'rows',
          rows: [{ key: 'oc_team', cells: [{ zh: '团队群', en: 'Team chat' }, { zh: '仅 @', en: '@ only' }] }]
        }
      }
    ],
    facts: [{ key: 'bot', label: { zh: '当前机器人', en: 'Bot' }, value: { zh: 'Widgets Bot', en: 'Widgets Bot' } }],
    stats: { received: 3, filtered: 0 },
    ...overrides
  })
}

let panel: Awaited<ReturnType<typeof mount>> | undefined

afterEach(async () => {
  mock.timers.reset()
  await panel?.unmount()
  panel = undefined
})

/** 挂载面板并停在 Source 页。 */
async function openSourceTab(requests: Requests): Promise<Awaited<ReturnType<typeof mount>>> {
  panel = await mount(panelModule, {
    host: mockHost({ requests: { state: () => snapshot(), ...requests } }),
    locale: 'en'
  })
  await openPage(panel, 'source')
  // 页面打开后才发 `sources`：等它落地，交互针对的是加载完的那一棵树。
  await panel.settled()
  return panel
}

/** 面板发过的请求名（按顺序）。 */
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

/** 绘制树的一个节点（`tree()` 的形状）。 */
interface TreeNode {
  readonly type: string
  readonly props?: Readonly<Record<string, unknown>>
  readonly children?: readonly (TreeNode | string)[]
}

/** 全部某类型的节点（深度优先，按绘制顺序）。 */
function nodesOfType(mounted: Awaited<ReturnType<typeof mount>>, type: string): readonly TreeNode[] {
  const found: TreeNode[] = []
  const seek = (node: TreeNode): void => {
    if (node.type === type) found.push(node)
    for (const child of node.children ?? []) {
      if (typeof child === 'string') continue
      seek(child)
    }
  }
  seek(mounted.tree() as TreeNode)
  return found
}

/** 面板上有没有一段文字（`find` 对 props 与 children 都匹配）。 */
function thereIsText(
  mounted: Awaited<ReturnType<typeof mount>>,
  text: string | RegExp
): boolean {
  return mounted.find({ text }) !== null
}

/** 卡片里的文字（测试按卡片看内容，而不是整页）：children 与承载文字的 props 都算。 */
function cardText(drawn: TreeNode): string {
  const parts: string[] = []
  const keep = (value: unknown): void => {
    if (typeof value === 'string') parts.push(value)
    else if (typeof value === 'number') parts.push(String(value))
  }
  const seek = (node: TreeNode): void => {
    const props = node.props ?? {}
    for (const key of ['title', 'description', 'label', 'value', 'text']) keep(props[key])
    const items = props['items']
    if (Array.isArray(items)) {
      for (const item of items) {
        if (typeof item !== 'object' || item === null) continue
        keep((item as Record<string, unknown>)['label'])
        keep((item as Record<string, unknown>)['value'])
      }
    }
    for (const child of node.children ?? []) {
      if (typeof child === 'string') parts.push(child)
      else seek(child)
    }
  }
  seek(drawn)
  return parts.join(' ')
}

// ---------------------------------------------------------------------------
// 卡片内容：一个 Source 一张卡（§M.2 的 Source 行）
// ---------------------------------------------------------------------------

test('the Source page draws one card per configured Source, with its state and 24 h counts', async () => {
  const mounted = await openSourceTab({
    sources: () => pageOf([githubCard(), feishuCard()])
  })
  const cards = nodesOfType(mounted, 'Card')
  assert.equal(cards.length, 2, 'one card per configured Source')
  assert.deepEqual(
    cards.map((drawn) => drawn.props?.['title']),
    ['GitHub', 'Feishu'],
    'each card is named by its Source'
  )
  const [github, feishu] = cards.map(cardText)
  assert.ok(github?.includes(COPY['source.ready'].en), 'the state is spelled out, not only a dot')
  assert.ok(github?.includes(translate('en', 'source.received', { count: 12 })), 'triggers received in 24 h')
  assert.ok(github?.includes(translate('en', 'source.filtered', { count: 2 })), 'triggers filtered in 24 h')
  assert.ok(feishu?.includes(translate('en', 'source.received', { count: 3 })))
  assert.ok(github?.includes(COPY['source.fields'].en), 'the configured fields')
  assert.ok(github?.includes('acme/widgets'), 'a text field shows its saved value')
  assert.ok(github?.includes(COPY['field.on'].en), 'a switch field says on')
  assert.ok(feishu?.includes('oc_team'), 'a rows field lists its rows')
  assert.ok(github?.includes(COPY['source.facts'].en), 'the derived facts')
  assert.ok(github?.includes('@agent-bot'), 'the account is a fact')
  assert.ok(github?.includes(COPY['source.health'].en), 'the health entries')
  assert.ok(github?.includes('polled 2 s ago'), 'with their detail')
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('an empty deployment says so and points at Settings', async () => {
  const mounted = await openSourceTab({ sources: () => pageOf([]) })
  assert.equal(nodesOfType(mounted, 'Card').length, 0)
  assert.ok(
    nodesOfType(mounted, 'EmptyState').some((empty) => empty.props?.['title'] === COPY['source.empty'].en),
    'the empty state'
  )
  assert.ok(
    nodesOfType(mounted, 'Button').some((button) => cardText(button).includes(COPY['setup.openSettings'].en)),
    'and the way to Settings'
  )
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

// ---------------------------------------------------------------------------
// 读模型：24 h 计数、被过滤的 Trigger、被 drop 的消息（§I.1–§I.3、§J.1）
// ---------------------------------------------------------------------------

/** 一个 kind 的只读展示信息（注册表 `kind()` 的最小形状）。 */
function kindOf(id: string, overrides: Partial<SourceKindView> = {}): SourceKindView {
  return { kind: id, title: { zh: id, en: id }, description: { zh: id, en: id }, fields: [], ...overrides }
}

/** 注册表总览的一行（§I.1 的生命周期）。 */
function overviewOf(id: string, overrides: Partial<SourceOverview> = {}): SourceOverview {
  return {
    id,
    kind: id,
    title: { zh: id, en: id },
    installed: true,
    enabled: true,
    state: 'ready',
    entries: [id],
    ...overrides
  }
}

/** 一条存进真库的 Trigger（`threads[0]` 是 primary，写入 `trigger_thread`）。 */
function storedTrigger(input: {
  readonly id: string
  readonly at: string
  readonly source?: string
  readonly actor?: string
  readonly text?: string
  readonly threads?: readonly { readonly source: string; readonly id: string }[]
}): Trigger {
  return {
    id: input.id,
    source: input.source ?? 'github',
    threads: [...(input.threads ?? [{ source: input.source ?? 'github', id: '12' }])],
    actor: { source: input.source ?? 'github', id: input.actor ?? 'alice' },
    human: true,
    at: input.at,
    text: input.text ?? `message ${input.id}`,
    meta: {}
  }
}

/** 一条存进真库的 Thread（`label` 是给人看的名字）。 */
function storedThread(key: string, label?: string): Thread {
  const separator = key.indexOf(':')
  return {
    key,
    ref: { source: key.slice(0, separator), id: key.slice(separator + 1) },
    createdAt: AT,
    lastAt: AT,
    subscriptions: [],
    correlated: [],
    pending: [],
    meta: label === undefined ? {} : { label }
  }
}

/** 一张工单的详情读数（打开 drop 行的工单链接后 Execution 页要读的那一份）。 */
function ticketDetailOf(id: string, title: string): TicketDetailView {
  return {
    id,
    title,
    stage: 'working',
    at: NOW_MS,
    mandate: {
      strength: 'explicit',
      actor: 'github:alice',
      policyVersion: '1a2b3c4d5e6f',
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

/** 一条被 drop 的 outbox 行（消息本体 + 终态）。 */
function droppedRow(input: {
  readonly id: string
  readonly hoursAgo: number
  readonly source?: string
  readonly thread: string
  readonly address?: Readonly<Record<string, string>>
  readonly reason: 'channelIgnored' | 'channelGone' | 'withdrawn'
  readonly ticketId?: string
  readonly text?: string
}): OutboxRecord {
  const at = new Date(Date.parse(AT) - input.hoursAgo * 3_600_000).toISOString()
  const message = {
    id: input.id,
    channel: {
      source: input.source ?? 'feishu',
      thread: input.thread,
      address: input.address ?? {}
    },
    text: input.text ?? `Reply ${input.id}`,
    kind: 'reply' as const,
    ...(input.ticketId === undefined ? {} : { ticketId: input.ticketId })
  }
  return {
    id: input.id,
    ticketId: input.ticketId ?? null,
    channel: `${input.source ?? 'feishu'}:${input.thread}`,
    status: 'dropped',
    body: message,
    settledAt: at,
    droppedAt: at,
    droppedReason: input.reason
  }
}

/** 一张最小的 Ticket（drop 行的 Ticket 链接用它；`origin` 指向来源 Trigger）。 */
function storedTicket(id: string, title: string, triggerId: string): Ticket {
  return {
    id,
    title,
    decisionId: 'decision-1',
    mandate: {
      strength: 'explicit',
      policyVersion: '1a2b3c4d5e6f',
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
    origin: { triggerId, triggerIds: [triggerId] }
  }
}

/** 一个 Source 页读模型的宿主：真库读 Trigger/outbox/仓储，其余读数按用例给。 */
function sourceHost(
  store: ReturnType<typeof openTempStore>['store'],
  options: {
    readonly overview: readonly SourceOverview[]
    readonly kinds?: Readonly<Record<string, SourceKindView>>
    readonly config?: Readonly<Record<string, Record<string, unknown>>>
    readonly health?: Readonly<Record<string, HealthEntry | undefined>>
    readonly setup?: readonly SetupIssue[]
    readonly facts?: readonly { readonly kind: string; readonly facts: readonly Fact[] }[]
    readonly syncable?: readonly string[]
    readonly now?: string
  }
): SourceViewHost {
  const repo = createRepositories(store)
  const outbox = createOutbox({ store, effects: { enqueue: () => undefined }, now: () => AT })
  return {
    now: options.now ?? AT,
    overview: () => options.overview,
    health: () => options.health ?? {},
    setup: () => options.setup ?? [],
    kind: (id) => options.kinds?.[id],
    facts: () => options.facts ?? [],
    config: (id) => options.config?.[id] ?? {},
    syncable: () => options.syncable ?? [],
    reader: { sql: store.sql },
    dropped: (since) => outbox.droppedSince(since),
    ticket: (id) => repo.tickets.get(id),
    trigger: (id) => repo.triggers.get(id),
    thread: (key) => repo.threads.get(key)
  }
}

test('the read model counts the last 24 h of triggers and lists the filtered ones with their reasons', () => {
  const h = openTempStore()
  try {
    const repo = createRepositories(h.store)
    repo.triggers.save(storedTrigger({ id: 't-recent', at: isoAfter(AT, -3_600_000) }))
    repo.triggers.save(
      storedTrigger({ id: 't-filtered', at: isoAfter(AT, -2 * 3_600_000), text: 'please deploy it' })
    )
    repo.triggers.saveDisposition('t-filtered', {
      filtered: { code: 'noMention' },
      fanout: [],
      at: AT
    })
    repo.triggers.save(
      storedTrigger({
        id: 't-disabled',
        at: isoAfter(AT, -3 * 3_600_000),
        source: 'feishu',
        threads: [{ source: 'feishu', id: 'oc_team:om_root' }]
      })
    )
    repo.triggers.saveDisposition('t-disabled', {
      filtered: { code: 'source_disabled' },
      fanout: [],
      at: AT
    })
    // 窗口之外的一条：计数与列表都不该带上它。
    repo.triggers.save(
      storedTrigger({ id: 't-old', at: isoAfter(AT, -25 * 3_600_000) })
    )
    repo.triggers.saveDisposition('t-old', { filtered: { code: 'noMention' }, fanout: [], at: AT })

    const page = sourcePage(
      sourceHost(h.store, {
        overview: [overviewOf('github'), overviewOf('feishu', { enabled: false, state: 'off' })]
      })
    )
    const github = page.items.find((item) => item.id === 'github')
    assert.ok(github)
    assert.deepEqual(github.stats, {
      received: 2,
      filtered: 1,
      lastAt: Date.parse(isoAfter(AT, -3_600_000))
    })
    assert.equal(github.filtered.total, 1)
    assert.deepEqual(
      github.filtered.items.map((item) => [item.id, item.code, item.actor]),
      [['t-filtered', 'noMention', 'alice']],
      'the filtered trigger carries its reason code and sender'
    )
    assert.equal(github.filtered.items[0]?.threadKey, 'github:12', 'and the Thread it belongs to')
    const feishu = page.items.find((item) => item.id === 'feishu')
    assert.deepEqual(feishu?.stats, {
      received: 1,
      filtered: 1,
      lastAt: Date.parse(isoAfter(AT, -3 * 3_600_000))
    })
    assert.equal(feishu?.stats.received, 1, 'the 25 h old trigger is outside the window')
  } finally {
    h.cleanup()
  }
})

test('the read model lists the messages dropped in the last 24 h, newest first, with their links', () => {
  const h = openTempStore()
  try {
    const repo = createRepositories(h.store)
    // 工单的来源 Thread（飞书 Channel 只带群 id，链接要经工单的来源 Trigger 找回 Thread）。
    repo.triggers.save(
      storedTrigger({
        id: 't-origin',
        at: isoAfter(AT, -5 * 3_600_000),
        source: 'feishu',
        threads: [{ source: 'feishu', id: 'oc_team:om_root' }]
      })
    )
    repo.threads.save(storedThread('feishu:oc_team:om_root', '团队群 / 话题'))
    repo.threads.save(storedThread('feishu:oc_other:om_two', '另一个话题'))
    repo.tickets.save(storedTicket('ticket-1', '修复回归', 't-origin'))
    h.store.outbox.put(
      droppedRow({
        id: 'm3',
        hoursAgo: 1,
        thread: 'feishu:oc_team',
        address: { chatId: 'oc_team', messageId: 'om_root' },
        reason: 'channelGone',
        ticketId: 'ticket-1'
      })
    )
    h.store.outbox.put(
      droppedRow({
        id: 'm2',
        hoursAgo: 3,
        thread: 'feishu:oc_other:om_two',
        reason: 'channelIgnored'
      })
    )
    h.store.outbox.put(
      droppedRow({
        id: 'm1',
        hoursAgo: 4,
        thread: 'feishu:oc_team',
        address: { chatId: 'oc_team', messageId: 'om_missing' },
        reason: 'channelGone'
      })
    )
    // 30 小时前的一条与另一个来源的一条：前者在窗口外，后者只算 GitHub 的卡。
    h.store.outbox.put(droppedRow({ id: 'm0', hoursAgo: 30, thread: 'feishu:oc_team', reason: 'channelGone' }))
    h.store.outbox.put(
      droppedRow({
        id: 'g0',
        hoursAgo: 2,
        source: 'github',
        thread: 'github:12',
        address: { repo: 'acme/widgets', issue: '12' },
        reason: 'channelGone'
      })
    )

    const page = sourcePage(
      sourceHost(h.store, { overview: [overviewOf('github'), overviewOf('feishu')] })
    )
    const feishu = page.items.find((item) => item.id === 'feishu')
    assert.ok(feishu)
    assert.equal(feishu.dropped.total, 3, 'only the last 24 h are in the window')
    assert.deepEqual(
      feishu.dropped.items.map((item) => [item.id, item.reason]),
      [
        ['m3', 'channelGone'],
        ['m2', 'channelIgnored'],
        ['m1', 'channelGone']
      ],
      'newest first, with the drop reason'
    )
    const [m3, m2, m1] = feishu.dropped.items
    assert.deepEqual(m3?.ticket, { id: 'ticket-1', title: '修复回归' }, 'a message with a ticket links the ticket')
    assert.deepEqual(m3?.thread, { key: 'feishu:oc_team:om_root', title: '团队群 / 话题' })
    assert.deepEqual(m2?.thread, { key: 'feishu:oc_other:om_two', title: '另一个话题' })
    assert.equal(m1?.ticket, undefined)
    assert.equal(m1?.thread, undefined, 'nothing to link is no link, not a made-up one')
    const github = page.items.find((item) => item.id === 'github')
    assert.deepEqual(github?.dropped.items.map((item) => item.id), ['g0'])
    assert.equal(feishu.dropped.items[0]?.text, 'Reply m3', 'the row previews the message')
  } finally {
    h.cleanup()
  }
})

test('a Source-specific setup problem lands on its own card, and the rest stay as they are', () => {
  const h = openTempStore()
  try {
    const page = sourcePage(
      sourceHost(h.store, {
        overview: [overviewOf('github'), overviewOf('feishu')],
        setup: [
          {
            place: 'executor',
            code: 'base_repo_missing',
            kind: 'missing',
            detail: 'no base repository is set',
            fix: 'choose a Base repository',
            checkAgain: 'superagent setup check'
          },
          {
            place: 'github',
            code: 'repository_missing',
            kind: 'missing',
            detail: 'the GitHub Source has no repository',
            fix: 'set the repository',
            checkAgain: 'superagent setup check'
          }
        ]
      })
    )
    const github = page.items.find((item) => item.id === 'github')
    const feishu = page.items.find((item) => item.id === 'feishu')
    assert.equal(github?.state, 'setup', 'a setup problem is waiting-for-setup, not an error')
    assert.equal(github?.problem?.code, 'repository_missing')
    assert.equal(feishu?.state, 'ready', 'the other Source keeps its own state')
    assert.equal(feishu?.problem, undefined)
    assert.deepEqual(
      page.elsewhere.map((issue) => issue.code),
      ['base_repo_missing'],
      'problems that belong to no Source are kept apart'
    )
  } finally {
    h.cleanup()
  }
})

test('the read model renders the kind fields, the derived facts and the health entries', () => {
  const h = openTempStore()
  try {
    const page = sourcePage(
      sourceHost(h.store, {
        // 注册表已经把 health 折进生命周期：一条 error 条目让它的总览是 error（§I.1）。
        overview: [overviewOf('github', { state: 'error' })],
        kinds: {
          github: kindOf('github', {
            title: { zh: 'GitHub', en: 'GitHub' },
            description: { zh: '读仓库', en: 'Reads the repository' },
            fields: [
              { key: 'repository', type: 'text', label: { zh: '监听的仓库', en: 'Repository' } },
              { key: 'observeComments', type: 'switch', label: { zh: '监听新评论', en: 'Observe comments' } },
              {
                key: 'mode',
                type: 'select',
                label: { zh: '模式', en: 'Mode' },
                options: [{ value: 'all', label: { zh: '全部', en: 'All' } }]
              },
              {
                key: 'chats',
                type: 'rows',
                label: { zh: '接收的群', en: 'Chats' },
                columns: [
                  { key: 'chatId', type: 'text', label: { zh: '群', en: 'Chat' } },
                  {
                    key: 'listen',
                    type: 'select',
                    label: { zh: '接收', en: 'Receive' },
                    options: [{ value: 'all', label: { zh: '全部消息', en: 'All messages' } }]
                  }
                ]
              },
              { key: 'account', type: 'fact', label: { zh: '当前账号', en: 'Account' } }
            ]
          })
        },
        config: {
          github: {
            repository: 'acme/widgets',
            observeComments: true,
            mode: 'all',
            chats: [{ chatId: 'oc_team', listen: 'all' }]
          }
        },
        facts: [{ kind: 'github', facts: [{ key: 'account', value: '@agent-bot' }] }],
        health: {
          github: { state: 'error', detail: '3 consecutive failed polls' },
          'sync:github': { state: 'ready', detail: '0 allowed' }
        }
      })
    )
    const github = page.items[0]
    assert.ok(github)
    assert.deepEqual(github.fields.map((field) => field.key), ['repository', 'observeComments', 'mode', 'chats'])
    assert.deepEqual(github.fields[0]?.value, { type: 'text', text: 'acme/widgets' })
    assert.deepEqual(github.fields[1]?.value, { type: 'flag', on: true })
    assert.deepEqual(github.fields[2]?.value, { type: 'choice', label: { zh: '全部', en: 'All' } })
    assert.deepEqual(github.fields[3]?.value, {
      type: 'rows',
      rows: [{ key: 'oc_team', cells: [{ zh: '全部消息', en: 'All messages' }] }]
    })
    assert.deepEqual(github.facts, [
      { key: 'account', label: { zh: '当前账号', en: 'Account' }, value: '@agent-bot' }
    ])
    assert.deepEqual(
      github.health.map((entry) => [entry.name, entry.state, entry.detail]),
      [
        ['github', 'error', '3 consecutive failed polls'],
        ['sync:github', 'ready', '0 allowed']
      ],
      'the kind entries plus the list sync entry that belongs to this Source'
    )
    assert.equal(github.state, 'error', 'a health error is an error state')
  } finally {
    h.cleanup()
  }
})

test('a missing kind and an invalid configuration are named, not hidden', () => {
  const h = openTempStore()
  try {
    const page = sourcePage(
      sourceHost(h.store, {
        overview: [
          overviewOf('github', { configError: 'repository: is required', enabled: false, state: 'error' }),
          overviewOf('ghost', { kind: 'ghost', installed: false, state: 'missing' })
        ]
      })
    )
    const github = page.items.find((item) => item.id === 'github')
    assert.equal(github?.state, 'error')
    assert.equal(github?.configError, 'repository: is required')
    const ghost = page.items.find((item) => item.id === 'ghost')
    assert.equal(ghost?.installed, false)
    assert.equal(ghost?.state, 'missing')
  } finally {
    h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 面板侧：内联 setup 问题、过滤列表、drop 列表（§M.2 的三块内容）
// ---------------------------------------------------------------------------

test('a setup problem sits on its own card and leaves the other card alone', async () => {
  const mounted = await openSourceTab({
    sources: () =>
      pageOf([
        githubCard({
          state: 'setup',
          problem: {
            place: 'github',
            code: 'repository_missing',
            kind: 'missing',
            detail: 'the GitHub Source has no repository',
            fix: 'set the repository (owner/name) on the Source page',
            checkAgain: 'superagent setup check'
          }
        }),
        feishuCard()
      ])
  })
  const cards = nodesOfType(mounted, 'Card')
  const github = cards.map(cardText)[0] ?? ''
  const feishu = cards.map(cardText)[1] ?? ''
  assert.ok(github.includes('the GitHub Source has no repository'), 'the problem is inline on its card')
  assert.ok(github.includes(COPY['source.setup'].en), 'the card says it waits for setup')
  assert.ok(!feishu.includes('the GitHub Source has no repository'), 'the other card is not touched')
  assert.ok(feishu.includes(COPY['source.ready'].en), 'and keeps its own state')
  assert.ok(feishu.includes('oc_team'), 'and its own content')
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('an empty filtered or dropped list takes no space, and zero counts are quiet', async () => {
  const mounted = await openSourceTab({
    sources: () => pageOf([githubCard({ stats: { received: 0, filtered: 0 } })])
  })
  const github = cardText(nodesOfType(mounted, 'Card')[0] as TreeNode)
  assert.equal(github.includes(COPY['source.filteredTitle'].en), false)
  assert.equal(github.includes(COPY['source.droppedTitle'].en), false)
  assert.equal(
    github.includes(translate('en', 'source.received', { count: 0 })),
    false,
    'a zero count is not printed (§M.1: non-zero counts only)'
  )
  await mounted.unmount()
  panel = undefined
})

test('the filtered triggers list their reason code, and a row opens its thread', async () => {
  const mounted = await openSourceTab({
    sources: () =>
      pageOf([
        githubCard({
          stats: { received: 5, filtered: 2 },
          filtered: {
            total: 2,
            items: [
              {
                id: 't1',
                at: NOW_MS,
                actor: 'alice',
                code: 'noMention',
                text: 'please deploy it',
                threadKey: 'github:12'
              },
              { id: 't2', at: NOW_MS - 1000, actor: 'dependabot', code: 'source_disabled' }
            ]
          }
        })
      ])
  })
  const github = cardText(nodesOfType(mounted, 'Card')[0] as TreeNode)
  assert.ok(github.includes(COPY['source.filteredTitle'].en), 'the list has a title')
  assert.ok(github.includes(translate('en', 'source.filtered', { count: 2 })), 'with the 24 h count')
  assert.ok(github.includes(COPY['reason.noMention'].en), 'a known reason code is worded')
  assert.ok(github.includes('source_disabled'), 'a Source-owned literal code shows as it is')
  assert.ok(github.includes('please deploy it'), 'and the message itself')
  await mounted.press({ type: 'Button', text: COPY['term.thread'].en })
  assert.equal(currentPage(mounted), 'trigger', 'the row opens the Thread page')
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('the dropped messages list why, when, and the Ticket or Thread each belonged to', async () => {
  const mounted = await openSourceTab({
    sources: () =>
      pageOf([
        feishuCard({
          dropped: {
            total: 3,
            items: [
              {
                id: 'm3',
                at: NOW_MS,
                reason: 'channelGone',
                kind: 'reply',
                text: 'Reply m3',
                ticket: { id: 'ticket-1', title: 'Fix the regression' },
                thread: { key: 'feishu:oc_team:om_root', title: 'Team topic' }
              },
              {
                id: 'm2',
                at: NOW_MS - 1000,
                reason: 'channelIgnored',
                kind: 'reply',
                text: 'Reply m2',
                thread: { key: 'feishu:oc_other:om_two', title: 'Another topic' }
              },
              { id: 'm1', at: NOW_MS - 2000, reason: 'withdrawn', kind: 'reply', text: 'Reply m1' }
            ]
          }
        })
      ]),
    'ticket.detail': () => ticketDetailOf('ticket-1', 'Fix the regression')
  })
  const feishu = cardText(nodesOfType(mounted, 'Card')[0] as TreeNode)
  assert.ok(feishu.includes(COPY['source.droppedTitle'].en), 'the list has a title')
  assert.ok(feishu.includes(COPY['source.drop.channelGone'].en), 'the reason is worded')
  assert.ok(feishu.includes(COPY['source.drop.channelIgnored'].en))
  assert.ok(feishu.includes(COPY['source.drop.withdrawn'].en))
  assert.ok(feishu.includes('Reply m3'), 'the row previews the message')

  // 有工单就链接工单（更准），没有工单才链接 Thread。
  await mounted.press({ type: 'Button', text: 'Fix the regression' })
  assert.equal(currentPage(mounted), 'execution')
  assert.deepEqual(requestInput(mounted.host, 'ticket.detail'), { ticketId: 'ticket-1' })
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('a dropped message without a Ticket opens its Thread, and one with neither has no link', async () => {
  const mounted = await openSourceTab({
    sources: () =>
      pageOf([
        feishuCard({
          dropped: {
            total: 2,
            items: [
              {
                id: 'm2',
                at: NOW_MS,
                reason: 'channelIgnored',
                kind: 'reply',
                text: 'Reply m2',
                thread: { key: 'feishu:oc_other:om_two', title: 'Another topic' }
              },
              { id: 'm1', at: NOW_MS - 1000, reason: 'channelGone', kind: 'reply', text: 'Reply m1' }
            ]
          }
        })
      ])
  })
  await mounted.press({ type: 'Button', text: 'Another topic' })
  assert.equal(currentPage(mounted), 'trigger', 'the thread link opens the Thread page')
  const links = nodesOfType(mounted, 'Button').filter((button) => cardText(button).includes('Reply m1'))
  assert.deepEqual(links, [], 'a row with nothing to link offers no button')
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

// ---------------------------------------------------------------------------
// 动作：打开/关闭、立即同步、检查一次、刷新显示名（§M.2 的主操作、§I.3、§G.2）
// ---------------------------------------------------------------------------

/** 一张卡的文字（按 id 找；找不到就断言失败）。 */
function cardTextOf(mounted: Awaited<ReturnType<typeof mount>>, id: string): string {
  const card = nodesOfType(mounted, 'Card').find((drawn) => cardText(drawn).includes(id))
  assert.ok(card, `the card for ${id} is drawn`)
  return cardText(card as TreeNode)
}

test('the switch opens and closes a Source, and the card follows the answer', async () => {
  let enabled = true
  const mounted = await openSourceTab({
    sources: () => pageOf([githubCard({ enabled, state: enabled ? 'ready' : 'off' })]),
    'source.setEnabled': (input) => {
      const next = (input as { enabled?: boolean } | null)?.enabled === true
      enabled = next
      return pageOf([githubCard({ enabled: next, state: next ? 'ready' : 'off' })])
    }
  })
  const label = translate('en', 'source.enable', { name: 'GitHub' })
  assert.ok(mounted.find({ type: 'Switch', label }))
  await mounted.toggle({ type: 'Switch', label })
  assert.deepEqual(requestInput(mounted.host, 'source.setEnabled'), {
    sourceId: 'github',
    enabled: false
  })
  assert.ok(cardTextOf(mounted, 'GitHub').includes(COPY['source.off'].en), 'the card shows the saved state')
  await mounted.toggle({ type: 'Switch', label })
  assert.deepEqual(requestInput(mounted.host, 'source.setEnabled'), {
    sourceId: 'github',
    enabled: true
  })
  assert.ok(cardTextOf(mounted, 'GitHub').includes(COPY['source.ready'].en))
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('Sync now says how many are allowed, and only the Kind that can sync offers it', async () => {
  const mounted = await openSourceTab({
    sources: () => pageOf([feishuCard(), githubCard()]),
    'source.sync': () => ({ sourceId: 'feishu', allowed: 4 })
  })
  assert.equal(
    nodesOfType(mounted, 'Button').filter((button) => cardText(button).includes(COPY['source.sync'].en)).length,
    1,
    'only the Source whose Kind declares a list sync offers the button'
  )
  await mounted.press({ type: 'Button', text: COPY['source.sync'].en })
  assert.deepEqual(requestInput(mounted.host, 'source.sync'), { sourceId: 'feishu' })
  assert.ok(
    cardTextOf(mounted, 'Feishu').includes(translate('en', 'source.synced', { count: 4 })),
    'the result is said on the card'
  )
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('a failed label refresh stays on its own card and leaves the others alone', async () => {
  const mounted = await openSourceTab({
    sources: () => pageOf([feishuCard(), githubCard()]),
    'source.labels': () => {
      throw hostError('action_failed', 'lark-cli: token expired')
    }
  })
  await mounted.press({ type: 'Button', text: COPY['source.refreshLabels'].en })
  assert.deepEqual(requestInput(mounted.host, 'source.labels'), { sourceId: 'feishu' })
  assert.ok(
    cardTextOf(mounted, 'Feishu').includes(
      translate('en', 'error.retry', { reason: 'lark-cli: token expired' })
    ),
    'the failure is said on the card that failed'
  )
  const github = cardTextOf(mounted, 'GitHub')
  assert.ok(github.includes('acme/widgets'), 'the other card keeps its content')
  assert.equal(
    github.includes(translate('en', 'error.retry', { reason: 'lark-cli: token expired' })),
    false,
    'and carries no error of its own'
  )
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('Refresh labels reports what was added', async () => {
  const mounted = await openSourceTab({
    sources: () => pageOf([feishuCard()]),
    'source.labels': () => ({ sourceId: 'feishu', added: 2, total: 5 })
  })
  await mounted.press({ type: 'Button', text: COPY['source.refreshLabels'].en })
  assert.ok(
    cardTextOf(mounted, 'Feishu').includes(
      translate('en', 'source.labelsRefreshed', { added: 2, total: 5 })
    )
  )
  await mounted.unmount()
  panel = undefined
})

test('Check again re-runs the setup probes and re-reads the cards', async () => {
  let reads = 0
  let checked = true
  const mounted = await openSourceTab({
    sources: () => {
      reads += 1
      return pageOf([githubCard()])
    },
    setupCheck: () => ({ checked, problems: [] })
  })
  assert.equal(reads, 1)
  await mounted.press({ type: 'Button', text: COPY['deployment.checkAgain'].en })
  assert.equal(reads, 2, 'the cards are re-read after the probes ran')
  assert.ok(
    thereIsText(mounted, COPY['source.checkedAgain'].en),
    'a real check says it ran'
  )
  checked = false
  await mounted.press({ type: 'Button', text: COPY['deployment.checkAgain'].en })
  assert.ok(
    thereIsText(mounted, COPY['deployment.nothingToCheck'].en),
    'nothing to check is said as such, not as an error'
  )
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('the Source page reports a failed read with the reason and a retry', async () => {
  let attempts = 0
  const mounted = await openSourceTab({
    sources: () => {
      attempts += 1
      if (attempts === 1) throw hostError('unavailable', 'the worker is starting')
      return pageOf([githubCard()])
    }
  })
  assert.ok(thereIsText(mounted, /the worker is starting/), 'the reason is shown')
  await mounted.press({ type: 'Button', text: COPY['state.retry'].en })
  assert.equal(nodesOfType(mounted, 'Card').length, 1, 'retry reads the page again')
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

// ---------------------------------------------------------------------------
// worker 侧的接线（§M.6）：面板发的每一条 Source 请求都由 worker 应答
// ---------------------------------------------------------------------------

test('the worker serves the Source page, saves the switch, and refuses what it cannot do', async () => {
  const stateDir = tempStateDir()
  const worker = await mountWorker(main, {
    host: mockHost({ settings: { stateDir, agent: 'pi' } })
  })
  try {
    const page = (await worker.request('sources')) as SourcePageView
    const github = page.items.find((item) => item.id === 'github')
    assert.ok(github, 'the installed kinds are on the page')
    assert.equal(github.enabled, true)
    assert.equal(github.canRefreshLabels, false, 'the GitHub kind has no display names to refresh')

    // 打开/关闭：写 `source:<id>` 的 enabled，并立即作用到本进程的 Source 视图。
    const off = (await worker.request('source.setEnabled', {
      sourceId: 'github',
      enabled: false
    })) as SourcePageView
    assert.equal(off.items.find((item) => item.id === 'github')?.enabled, false)
    assert.equal(off.items.find((item) => item.id === 'github')?.state, 'off')
    const again = (await worker.request('sources')) as SourcePageView
    assert.equal(
      again.items.find((item) => item.id === 'github')?.enabled,
      false,
      'the switch is saved, not just echoed'
    )

    // 固定拒绝：未知 Source、没有刷新能力的 Kind、现在不能同步的 Source。
    await assert.rejects(
      worker.request('source.setEnabled', { sourceId: 'nope', enabled: false }),
      (error: unknown) => (error as { code?: string }).code === 'invalid_params'
    )
    await assert.rejects(
      worker.request('source.labels', { sourceId: 'github' }),
      (error: unknown) => (error as { code?: string }).code === 'invalid_params'
    )
    await assert.rejects(
      worker.request('source.sync', { sourceId: 'feishu' }),
      (error: unknown) => (error as { code?: string }).code === 'invalid_params'
    )
    assert.deepEqual(worker.refusals, [])
  } finally {
    await worker.deactivate()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a Kind that can refresh its display names does it through the registry; one that cannot refuses', async () => {
  const registry = new SourceRegistry({
    settings: () => ({
      sources: { demo: { enabled: true, config: {} } },
      policy: { sources: {} }
    })
  })
  const written: Record<string, unknown>[] = []
  const host = {
    state: {
      read: () => null,
      write: (_key: string, value: unknown) => written.push(value as Record<string, unknown>),
      delete: () => false
    }
  } as unknown as SourceContext
  registry.register({
    kind: 'demo',
    title: { zh: '演示', en: 'Demo' },
    description: { zh: '演示', en: 'Demo' },
    schema: object({}),
    fields: [],
    health: [],
    refreshLabels: async () => ({ oc_team: 'Team chat' })
  })
  const labels = await registry.refreshLabels('demo', host)
  assert.deepEqual(labels, { oc_team: 'Team chat' })
  assert.equal(registry.canRefreshLabels('demo'), true)
  assert.equal(registry.canRefreshLabels('github'), false)
  await assert.rejects(registry.refreshLabels('github', host), /cannot refresh its display names/)
})

test('a worker push re-reads the cards, and an older revision is ignored', async () => {
  let reads = 0
  const mounted = await openSourceTab({
    sources: () => {
      reads += 1
      return pageOf([githubCard()])
    }
  })
  assert.equal(requestNames(mounted.host).filter((name) => name === 'sources').length, 1)
  await mounted.post('state.changed', { revision: 2 })
  assert.equal(reads, 2, 'a newer revision re-reads the page it shows')
  await mounted.post('state.changed', { revision: 1 })
  assert.equal(reads, 2, 'an older revision is ignored')
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

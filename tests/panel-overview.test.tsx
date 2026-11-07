// Overview 页（§M.2 ①–④、§J.3、§E.6 末行）：四块内容按顺序回答「现在要不要我」。
// 断言分两层：
// - 面板侧：挂载真面板模块，读 Overview，断言顺序、行内动作、三态与文案；
// - 读模型侧：`readSystemProblems` / `createRefreshableStateSource` 把真读数变成面板的行。
import { afterEach, assert, hostError, mockHost, mount, test } from 'orca/testing'
import { mock } from 'node:test'
import { COPY, translate } from '../src/panel/copy'
import type {
  AttentionItem,
  HumanSlot,
  PanelState,
  PanelTicket,
  SystemProblem
} from '../src/panel/protocol'
import * as panelModule from '../src/panel/panel'
import { orderWaiting, problemPage } from '../src/panel/overview'
import { readSystemProblems } from '../src/worker/app/views/problems'
import { createRefreshableStateSource } from '../src/worker/app/state-source'
import check from '../src/panel/panel.check.ts'

/** `mockHost` 的请求表类型（测试里只写几个名字）。 */
type Requests = NonNullable<NonNullable<Parameters<typeof mockHost>[0]>['requests']>

/** 一份完整快照；只写关心的字段，其余按健康默认值补齐。 */
function snapshot(overrides: {
  revision?: number
  items?: readonly AttentionItem[]
  problems?: readonly SystemProblem[]
  tickets?: readonly PanelTicket[]
  paused?: boolean
  error?: boolean
  setupMissing?: boolean
  sources?: { readonly enabled: number; readonly problems: number }
  activity?: Partial<PanelState['health']['activity']>
  executor?: {
    readonly running?: number
    readonly maxWorkers?: number
    readonly humanSlot?: HumanSlot
  }
}): PanelState {
  const items = overrides.items ?? []
  const problems = overrides.problems ?? []
  return {
    revision: overrides.revision ?? 1,
    booted: true,
    health: {
      error: overrides.error ?? false,
      paused: overrides.paused ?? false,
      setupMissing: overrides.setupMissing ?? false,
      sources: overrides.sources ?? { enabled: 0, problems: 0 },
      activity: {
        received: 0,
        evaluated: 0,
        accepted: 0,
        ignored: 0,
        ended: 0,
        ...overrides.activity
      },
      executor: {
        running: overrides.executor?.running ?? 0,
        maxWorkers: overrides.executor?.maxWorkers ?? 4,
        humanSlot: overrides.executor?.humanSlot ?? 'free'
      }
    },
    attention: {
      answer: items.filter((entry) => entry.action === 'answer').length,
      review: items.filter((entry) => entry.action === 'review').length,
      problems: problems.length,
      items
    },
    problems,
    tickets: overrides.tickets ?? []
  }
}

/** 一名待人工的工单。 */
function item(id: string, action: AttentionItem['action'], at = 1_700_000_000_000): AttentionItem {
  return { id, title: `Ticket ${id}`, action, at }
}

/** 一条系统问题。 */
function problem(
  kind: SystemProblem['kind'],
  id: string,
  name: string,
  detail?: string
): SystemProblem {
  return { id, kind, name, ...(detail === undefined ? {} : { detail }) }
}

let panel: Awaited<ReturnType<typeof mount>> | undefined

afterEach(async () => {
  mock.timers.reset()
  await panel?.unmount()
  panel = undefined
})

/** 面板发过的请求名（按顺序，`state` 之外）。 */
const requestNames = (host: ReturnType<typeof mockHost>): string[] =>
  host
    .callsOf('plugin.request')
    .map((params) => (params as { name?: string }).name ?? '')
    .filter((name) => name !== 'state')

/** 一次请求的入参。 */
const requestInput = (
  host: ReturnType<typeof mockHost>,
  name: string
): Record<string, unknown> | undefined => {
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

/** 一个页面（Tab）之下的节点，按绘制顺序。 */
function nodesUnderTab(mounted: Awaited<ReturnType<typeof mount>>, page: string): TreeNode[] {
  const found: TreeNode[] = []
  const walk = (node: TreeNode): void => {
    found.push(node)
    for (const child of node.children ?? []) if (typeof child !== 'string') walk(child)
  }
  const tab = (function seek(node: TreeNode): TreeNode | undefined {
    if (node.type === 'Tab' && node.props?.['value'] === page) return node
    for (const child of node.children ?? []) {
      if (typeof child === 'string') continue
      const hit = seek(child)
      if (hit !== undefined) return hit
    }
    return undefined
  })(mounted.tree() as TreeNode)
  assert.ok(tab !== undefined, `the ${page} tab is drawn`)
  for (const child of tab.children ?? []) if (typeof child !== 'string') walk(child)
  return found
}

/** 一个页面上的行（`ListItem`）与其 props，按绘制顺序。 */
function rowsUnderTab(
  mounted: Awaited<ReturnType<typeof mount>>,
  page: string
): Readonly<Record<string, unknown>>[] {
  return nodesUnderTab(mounted, page)
    .filter((node) => node.type === 'ListItem')
    .map((node) => node.props ?? {})
}

/** 页面上可见的文字，按绘制顺序（只用可见元素；一个 Text 的整句话算一条）。 */
function drawnTexts(mounted: Awaited<ReturnType<typeof mount>>): string[] {
  return mounted
    .findAll({ type: 'Text' })
    .map((element) => element.text ?? '')
    .filter((text) => text !== '')
}

/** 挂载面板并停在 Overview。 */
async function openOverview(
  state: PanelState,
  requests: Requests = {}
): Promise<Awaited<ReturnType<typeof mount>>> {
  panel = await mount(panelModule, {
    host: mockHost({ requests: { state: () => state, ...requests } }),
    locale: 'en'
  })
  return panel
}

test('the overview answers in the designed order: needs you, system problems, 24 h flow, executor load', async () => {
  const mounted = await openOverview(
    snapshot({
      items: [item('t1', 'answer')],
      problems: [problem('health', 'h1', 'assessment', 'waiting 2, failed 1')],
      activity: { received: 4, evaluated: 3, accepted: 1, ignored: 2, ended: 0 },
      executor: { running: 1, maxWorkers: 2, humanSlot: 'free' }
    })
  )
  const texts = drawnTexts(mounted)
  // `Section` 的标题带计数（`Needs you · 1`），因此按前缀找位置。
  const order = [
    COPY['overview.awaitingYou'].en,
    COPY['overview.problems'].en,
    COPY['overview.flow'].en,
    COPY['overview.executor'].en
  ].map((title) => texts.findIndex((text) => text.startsWith(title)))
  assert.deepEqual(order.filter((index) => index < 0), [], 'all four sections are drawn')
  assert.deepEqual(
    order,
    [...order].sort((left, right) => left - right),
    'the four sections keep the design order'
  )
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('waiting tickets are ordered by stage, newest first inside one stage', async () => {
  const mounted = await openOverview(
    snapshot({
      items: [
        item('f1', 'failed', 1_700_000_000_900),
        item('r1', 'review', 1_700_000_000_100),
        item('a1', 'answer', 1_700_000_000_200),
        item('d1', 'delivery', 1_700_000_000_300),
        item('a2', 'answer', 1_700_000_000_800),
        item('b1', 'blocked', 1_700_000_000_400)
      ]
    })
  )
  assert.deepEqual(
    rowsUnderTab(mounted, 'overview').map((row) => row['title']),
    ['Ticket d1', 'Ticket a2', 'Ticket a1', 'Ticket r1', 'Ticket b1', 'Ticket f1']
  )
  // 纯函数同一份规则：排序不依赖 worker 送来的顺序。
  assert.deepEqual(
    orderWaiting([item('f1', 'failed'), item('r1', 'review'), item('a1', 'answer')]).map((one) => one.id),
    ['a1', 'r1', 'f1']
  )
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('Answer and Review open the ticket, Retry and Open terminal ask the worker', async () => {
  let retries = 0
  let focuses = 0
  const mounted = await openOverview(
    snapshot({
      items: [{ ...item('t1', 'answer'), terminalId: 'term_1' }, item('t2', 'failed')]
    }),
    {
      'ticket.retry': () => {
        retries += 1
        return snapshot({
          revision: 2,
          items: [{ ...item('t1', 'answer'), terminalId: 'term_1' }, item('t2', 'failed')]
        })
      },
      'terminal.focus': () => {
        focuses += 1
        return { focused: true }
      }
    }
  )
  const host = mounted.host

  await mounted.press({ text: COPY['overview.openTerminal'].en })
  assert.equal(focuses, 1, 'Open terminal goes through the worker')
  assert.deepEqual(requestInput(host, 'terminal.focus'), { terminalId: 'term_1' })

  await mounted.press({ text: COPY['action.retry'].en })
  assert.equal(retries, 1, 'Retry goes through the worker')
  assert.deepEqual(requestInput(host, 'ticket.retry'), { ticketId: 't2' })

  await mounted.press({ text: COPY['overview.answer'].en })
  assert.equal(mounted.valueOf({ type: 'Tabs' }), 'execution', 'Answer opens the ticket on Execution')
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('a waiting row opens that ticket detail on the Execution page', async () => {
  let asked: unknown
  const mounted = await openOverview(
    snapshot({
      items: [item('t1', 'review')],
      tickets: [{ id: 't1', title: 'Ticket t1', stage: 'review', at: 1_700_000_000_000 }]
    }),
    {
      'ticket.detail': (input) => {
        asked = input
        return {
          id: 't1',
          title: 'Ticket t1',
          stage: 'review',
          at: 1_700_000_000_000,
          mandate: {
            strength: 'explicit',
            actor: 'github:alice',
            policyVersion: 'v1',
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
    }
  )
  // 行内的第一个动作就是「点行」：Orca 不允许可点的 ListItem 里再放 Button，
  // 所以入口是行里的按钮（这里对评审档是 Review）。
  await mounted.press({ text: COPY['overview.review'].en })
  assert.equal(mounted.valueOf({ type: 'Tabs' }), 'execution')
  assert.deepEqual(asked, { ticketId: 't1' }, 'the detail asks the worker for that ticket')
  assert.ok(mounted.find({ text: /Ticket t1/ }), 'the detail names the ticket the person came for')
  assert.ok(mounted.find({ label: COPY['execution.mandate'].en }), 'and draws its blocks')
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('an empty overview says nothing needs you and carries the source summary', async () => {
  const mounted = await openOverview(
    snapshot({ sources: { enabled: 2, problems: 0 }, activity: { received: 2, evaluated: 1 } })
  )
  assert.ok(mounted.find({ text: COPY['overview.nothingNeedsYou'].en }))
  assert.ok(
    mounted.find({ text: translate('en', 'overview.sources', { enabled: 2, problems: 0 }) }),
    'the source summary line'
  )
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('system problems list the health errors, failing replies and unresolved decisions', async () => {
  const mounted = await openOverview(
    snapshot({
      problems: [
        problem('health', 'h1', 'assessment', 'waiting 2, failed 1'),
        problem('reply', 'r1', 'github:owner/repo#12'),
        problem('unavailable', 'u1', 'thread-7', 'The model could not judge this request')
      ]
    })
  )
  assert.ok(mounted.find({ text: /assessment/ }))
  assert.ok(mounted.find({ text: /waiting 2, failed 1/ }))
  assert.ok(mounted.find({ text: /github:owner\/repo#12/ }))
  assert.ok(
    mounted.find({ text: COPY['overview.replyFailed'].en }),
    'a reply problem says it is not delivered'
  )
  assert.ok(mounted.find({ text: /thread-7/ }))
  assert.ok(mounted.find({ text: /The model could not judge this request/ }))
  assert.ok(mounted.find({ text: COPY['overview.problemKind.health'].en }))
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('a problem row opens the page that owns it', async () => {
  // §M.2「点行→对应详情页」：health 在 Settings 的 Deployment 组，回复在 Source，unavailable 在 Eval。
  assert.equal(problemPage(problem('health', 'h', 'assessment')), 'settings')
  assert.equal(problemPage(problem('reply', 'r', 'github:a#1')), 'source')
  assert.equal(problemPage(problem('unavailable', 'u', 'thread-1')), 'eval')

  const mounted = await openOverview(
    snapshot({ problems: [problem('unavailable', 'u1', 'thread-7', 'no answer')] })
  )
  await mounted.press({ text: /thread-7/ })
  assert.equal(mounted.valueOf({ type: 'Tabs' }), 'eval')
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('Pause processing asks before it acts, and the request carries the change', async () => {
  let paused = false
  const host = mockHost({
    requests: {
      state: () => snapshot({ paused }),
      pause: (input) => {
        paused = (input as { paused: boolean }).paused
        return snapshot({ revision: 2, paused })
      }
    }
  })
  panel = await mount(panelModule, { host, locale: 'en' })
  await panel.press({ text: COPY['action.pause'].en })
  const question = COPY['confirm.bodyPlain'].en.replace('{action}', COPY['action.pause'].en)
  assert.ok(panel.find({ text: new RegExp(question) }), 'the page asks first')
  assert.deepEqual(requestNames(host), [], 'nothing is sent before Confirm')

  await panel.press({ text: COPY['action.cancel'].en })
  assert.deepEqual(requestNames(host), [], 'cancel sends nothing')

  await panel.press({ text: COPY['action.pause'].en })
  await panel.press({ text: COPY['action.confirm'].en })
  assert.deepEqual(requestNames(host), ['pause'])
  assert.deepEqual(requestInput(host, 'pause'), { paused: true })
  assert.ok(panel.find({ text: new RegExp(COPY['processing.paused'].en) }), 'the page follows the snapshot')
  assert.deepEqual(panel.refusals, [])
  await panel.unmount()
  panel = undefined
})

test('Check again reads once and reports what it found', async () => {
  let revisions = 1
  const mounted = await openOverview(snapshot({ revision: revisions }), {
    check: () => {
      revisions += 1
      return snapshot({
        revision: revisions,
        items: [item('t1', 'answer')],
        problems: [problem('health', 'h1', 'assessment', 'failed 3 times')]
      })
    }
  })
  await mounted.press({ text: COPY['action.refresh'].en })
  assert.deepEqual(requestNames(mounted.host), ['check'])
  assert.ok(
    mounted.find({ text: translate('en', 'overview.checked', { waiting: 1, problems: 1 }) }),
    'the check says what it found'
  )
  assert.ok(mounted.find({ text: /Ticket t1/ }), 'and the page follows the new snapshot')
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('a failed check keeps the last snapshot and names the reason', async () => {
  const mounted = await openOverview(snapshot({ items: [item('t1', 'answer')] }), {
    check: () => {
      throw hostError('unavailable', 'the worker is restarting')
    }
  })
  await mounted.press({ text: COPY['action.refresh'].en })
  assert.ok(mounted.find({ text: /the worker is restarting/ }), 'the reason is shown')
  assert.ok(mounted.find({ text: /Ticket t1/ }), 'the last good snapshot stays')
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('the loading state draws three skeletons and a progress bar', async () => {
  // 首屏在飞行中是骨架 + 进度：隐藏面板不发请求，因此这一段卡在加载态，可稳定断言。
  const host = mockHost({
    requests: { state: () => snapshot({ revision: 2, items: [item('t1', 'answer')] }) }
  })
  panel = await mount(panelModule, { host, visible: false, locale: 'en' })
  assert.equal(panel.findAll({ type: 'Skeleton' }).length, 3, 'three skeletons')
  assert.ok(panel.find({ type: 'Progress' }), 'and a progress bar')

  await panel.setVisible(true)
  await panel.post('state.changed', { revision: 2 })
  assert.equal(panel.findAll({ type: 'Skeleton' }).length, 0, 'the skeletons go away once the read lands')
  assert.ok(panel.find({ text: /Ticket t1/ }))
  await panel.unmount()
  panel = undefined
})

test('an unreadable snapshot shows a danger callout with the reason and a retry that works', async () => {
  let fail = true
  const host = mockHost({
    requests: {
      state: () => {
        if (fail) throw hostError('unavailable', 'worker not started')
        return snapshot({ items: [item('t1', 'answer')] })
      }
    }
  })
  // 虚拟时钟要在挂载前装好：setup 里的那次重试正是在 mount 期间排的。
  mock.timers.enable({ apis: ['setTimeout'] })
  panel = await mount(panelModule, { host, locale: 'en' })
  mock.timers.tick(2000)
  await panel.settled()
  assert.ok(panel.find({ text: new RegExp(COPY['boot.unavailable'].en) }), 'the danger callout names it')
  assert.ok(panel.find({ text: /worker not started/ }), 'with the reason')

  fail = false
  await panel.press({ text: COPY['state.retry'].en })
  assert.ok(panel.find({ text: /Ticket t1/ }), 'the retry reads again')
  assert.deepEqual(panel.errors, [])
  assert.deepEqual(panel.refusals, [])
  await panel.unmount()
  panel = undefined
})

test('the check scenarios name the four overview situations in their summaries', async () => {
  const expected: readonly (readonly [keyof typeof check, string])[] = [
    ['empty', `EmptyState ${JSON.stringify(COPY['overview.nothingNeedsYou'].en)}`],
    ['needs-person', `List ${JSON.stringify(COPY['overview.awaitingYou'].en)}: 2 item(s)`],
    ['problems', `List ${JSON.stringify(COPY['overview.problems'].en)}: 3 item(s)`],
    ['paused', `Callout warning ${JSON.stringify(COPY['processing.paused'].en)}`]
  ]
  for (const [scenario, line] of expected) {
    panel = await mount(panelModule, {
      host: mockHost({ requests: check[scenario].requests }),
      locale: 'en'
    })
    assert.ok(
      panel.summary().some((each) => each.startsWith(line)),
      `${scenario}: ${line} in ${JSON.stringify(panel.summary())}`
    )
    assert.deepEqual(panel.refusals, [], scenario)
    await panel.unmount()
    panel = undefined
  }
})

test('the needs-person check scenario is a real waiting ticket with its direct actions', async () => {
  panel = await mount(panelModule, {
    host: mockHost({ requests: check['needs-person'].requests }),
    locale: 'en'
  })
  assert.ok(panel.find({ text: /Fix the login redirect/ }), 'a real waiting ticket')
  assert.ok(panel.find({ text: COPY['overview.answer'].en }), 'with its direct action')
  assert.ok(panel.find({ text: COPY['overview.openTerminal'].en }), 'and the terminal it runs in')
  assert.deepEqual(panel.refusals, [])
  await panel.unmount()
  panel = undefined
})

test('the worker read model turns health errors, failing replies and unresolved decisions into rows', () => {
  const problems = readSystemProblems({
    health: {
      assessment: { state: 'error', detail: 'waiting 2, failed 1' },
      router: { state: 'ready', detail: 'session alive' },
      delivery: { state: 'paused' }
    },
    replies: [{ id: 'm1', target: 'github:owner/repo#12' }],
    unavailable: [
      {
        decisionId: 'd1',
        evalId: 'e1',
        threadKey: 'thread-7',
        at: '2026-11-07T03:26:00.000Z',
        reason: 'The model could not judge this request',
        triggerIds: ['trigger-1']
      }
    ]
  })
  assert.deepEqual(problems, [
    { id: 'health:assessment', kind: 'health', name: 'assessment', detail: 'waiting 2, failed 1' },
    { id: 'reply:m1', kind: 'reply', name: 'github:owner/repo#12' },
    {
      id: 'unavailable:d1',
      kind: 'unavailable',
      name: 'thread-7',
      detail: 'The model could not judge this request'
    }
  ])
  // 没有 detail 的健康条目也有一行：部件报 error 就是事实，不因缺说明而消失。
  assert.deepEqual(
    readSystemProblems({ health: { launch: { state: 'error' } }, replies: [], unavailable: [] }),
    [{ id: 'health:launch', kind: 'health', name: 'launch' }]
  )
  // 一个健康的世界没有系统问题。
  assert.deepEqual(readSystemProblems({ health: {}, replies: [], unavailable: [] }), [])
})

test('the worker read model carries the count, the source summary and the human slot', () => {
  const source = createRefreshableStateSource({
    tickets: () => [],
    activity: () => ({ received: 0, evaluated: 0, accepted: 0, ignored: 0, ended: 0 }),
    load: () => ({ running: 1, maxWorkers: 2, humanSlot: 'used' }),
    hasError: () => true,
    setupMissing: () => false,
    paused: () => false,
    sources: () => ({ enabled: 2, problems: 1 }),
    problems: () => [problem('health', 'health:assessment', 'assessment', 'waiting 2, failed 1')]
  })
  const state = source.snapshot()
  assert.equal(state.attention.problems, 1, 'the count is the rows, never a second number')
  assert.deepEqual(state.problems.map((row) => row.id), ['health:assessment'])
  assert.deepEqual(state.health.sources, { enabled: 2, problems: 1 })
  assert.deepEqual(state.health.executor, { running: 1, maxWorkers: 2, humanSlot: 'used' })

  // 不接读口时是零，不假装有系统问题或 Source。
  const bare = createRefreshableStateSource({
    tickets: () => [],
    activity: () => ({ received: 0, evaluated: 0, accepted: 0, ignored: 0, ended: 0 }),
    load: () => ({ running: 0, maxWorkers: 2, humanSlot: 'free' }),
    hasError: () => false,
    setupMissing: () => false,
    paused: () => false
  })
  assert.equal(bare.snapshot().attention.problems, 0)
  assert.deepEqual(bare.snapshot().problems, [])
  assert.deepEqual(bare.snapshot().health.sources, { enabled: 0, problems: 0 })
})

test('the worker read model gives a waiting row the terminal it runs in', () => {
  const at = '2026-11-07T03:26:00.000Z'
  const source = createRefreshableStateSource({
    tickets: () => [
      {
        id: 'ticket-1',
        title: 'Fix the login redirect',
        decisionId: 'decision-1',
        mandate: {
          strength: 'explicit',
          policyVersion: 'v1',
          basis: { via: 'addressed', addressed: 'mention' },
          actor: { source: 'github', id: 'alice' },
          scope: 'ticket'
        },
        channels: [],
        attention: { id: 'attention-1', question: 'Which branch?', at },
        assignments: [{ id: 'a-1', state: 'running', createdAt: at, startedAt: at, terminalId: 'term_1' }],
        inputs: [],
        undelivered: [],
        createdAt: at,
        updatedAt: at,
        origin: { triggerId: 'trigger-1', triggerIds: ['trigger-1'] }
      }
    ],
    activity: () => ({ received: 0, evaluated: 0, accepted: 0, ignored: 0, ended: 0 }),
    load: () => ({ running: 1, maxWorkers: 2, humanSlot: 'free' }),
    hasError: () => false,
    setupMissing: () => false,
    paused: () => false
  })
  const [waiting] = source.snapshot().attention.items
  assert.equal(waiting?.action, 'answer')
  assert.equal(waiting?.terminalId, 'term_1', 'the row can open the terminal it runs in')
})

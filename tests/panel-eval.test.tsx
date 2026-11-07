// Eval 页（§M.2 的 Eval 行、§K.7 的四条件）：Decision 列表（kind、reason、strength、
// policy version、at）、详情（种类、原因、到 Thread/Ticket 的链接）、只有 unavailable 才有
// 的 dismiss（行内二次确认）、24 h 未解决 unavailable 的条数，以及空态与错误态。
//
// 断言分两层：
// - 面板侧：挂载真面板模块，读 Eval 页；列表、详情与 dismiss 都是 worker 的请求
//   （`decisions` / `decision.detail` / `decision.dismiss`），断言发出去的请求名与入参；
// - 读模型侧：`decisionPage` / `decisionDetail` 把真库里的 Decision 变成面板面，待人工条数
//   与 Overview 的 System problems 用同一份 §K.7 判定（`readUnavailableProblems`）。
import { assert, mockHost, mount, mountWorker, test } from 'orca/testing'
import * as main from '../src/worker/main'
import type { Decision, Thread, Ticket } from '../src/worker/core/index'
import { createRepositories } from '../src/worker/app/repositories'
import { openStore } from '../src/worker/app/store'
import { readUnavailableProblems } from '../src/worker/app/views/attention'
import { decisionDetail, decisionPage } from '../src/worker/app/views/decisions.ts'
import { COPY, translate } from '../src/panel/copy'
import * as panelModule from '../src/panel/panel'
import type {
  DecisionDetailView,
  DecisionListInput,
  DecisionListPage,
  PanelDecision,
  PanelState,
  TicketDetailView
} from '../src/panel/protocol'
import { AT as ISO_AT, isoAfter, openTempStore, removeTree, tempStateDir } from './support/state'

/** `mockHost` 的请求表类型（测试里只写用到的几个名字）。 */
type Requests = NonNullable<NonNullable<Parameters<typeof mockHost>[0]>['requests']>

/** 一份健康快照；Eval 页自己读 `decisions`，快照只决定全局三态。 */
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
      executor: { running: 1, maxWorkers: 4, humanSlot: 'free' }
    },
    attention: { answer: 0, review: 0, problems: 0, items: [] },
    problems: [],
    tickets: []
  }
}

/** 固定的决定时刻（epoch ms）。 */
const AT = 1_700_000_000_000

/** 一条 Decision 行；每个用例只写它关心的字段。 */
function decision(overrides: Partial<PanelDecision> & Pick<PanelDecision, 'id'>): PanelDecision {
  return {
    kind: 'unavailable',
    reasons: [{ code: 'timeout', values: { attempts: '3' } }],
    strength: 'explicit',
    policyVersion: '1a2b3c4d5e6f',
    at: AT,
    ...overrides
  }
}

/** 一页 Decision；`unresolved` 是 worker 的 §K.7 判定结果（面板不自己算）。 */
function pageOf(items: readonly PanelDecision[], unresolved = 0): DecisionListPage {
  return { items, nextOffset: null, unresolved }
}

/** 一份详情读数；只写用例关心的字段。 */
function detailOf(overrides: Partial<DecisionDetailView> = {}): DecisionDetailView {
  return {
    id: 'd1',
    kind: 'unavailable',
    reasons: [{ code: 'timeout', values: { attempts: '3' } }],
    strength: 'explicit',
    policyVersion: '1a2b3c4d5e6f',
    at: AT,
    thread: { key: 'github:owner/widgets#12', title: 'owner/widgets#12' },
    triggerIds: ['trigger-1'],
    dismissed: false,
    unresolved: false,
    canDismiss: true,
    ...overrides
  }
}

let panel: Awaited<ReturnType<typeof mount>> | undefined

/** 挂载面板并停在 Eval 列表。 */
async function openEvalTab(requests: Requests): Promise<Awaited<ReturnType<typeof mount>>> {
  panel = await mount(panelModule, {
    host: mockHost({ requests: { state: () => snapshot(), ...requests } }),
    locale: 'en'
  })
  await panel.select({ type: 'Tabs' }, 'eval')
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

/** 表格一行的单元格。 */
function cellsOf(drawn: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const cells = drawn['cells']
  return typeof cells === 'object' && cells !== null ? (cells as Record<string, unknown>) : {}
}

// ---------------------------------------------------------------------------
// 列表：五个字段（§M.2 的 Eval 行）
// ---------------------------------------------------------------------------

test('the Eval table lists the kind, reason, strength, policy version and when', async () => {
  const mounted = await openEvalTab({
    decisions: () =>
      pageOf([
        decision({ id: 'd1', kind: 'unavailable', strength: 'explicit' }),
        decision({
          id: 'd2',
          kind: 'accept',
          strength: 'inferred',
          policyVersion: '9f8e7d6c5b4a',
          reasons: [{ code: 'explicitRouted' }]
        })
      ])
  })
  assert.deepEqual(
    mounted.columnsOf({ type: 'Table' }),
    ['kind', 'reason', 'strength', 'policyVersion', 'at'],
    'the columns are the five fields the design names'
  )
  const rows = tableRows(mounted)
  assert.equal(rows.length, 2)
  assert.deepEqual(
    rows.map((drawn) => cellsOf(drawn)['kind']),
    [COPY['decision.unavailable'].en, COPY['decision.accept'].en],
    'each row is marked with its decision kind'
  )
  assert.equal(
    cellsOf(rows[0]!)[ 'reason'],
    'Assessment timed out after 3 attempts',
    'the reason code is rendered in the panel language'
  )
  assert.equal(cellsOf(rows[0]!)[ 'strength'], COPY['strength.explicit'].en)
  assert.equal(cellsOf(rows[0]!)[ 'policyVersion'], '1a2b3c4d5e6f')
  assert.deepEqual(
    cellsOf(rows[0]!)[ 'at'],
    { type: 'relative', at: AT, format: 'short' },
    'the time is the host-relative cell, never a clock the panel runs'
  )
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

// ---------------------------------------------------------------------------
// 详情：字段、原因、到 Thread 与 Ticket 的链接（§M.2 的 Eval 详情）
// ---------------------------------------------------------------------------

/** 一张工单的详情读数（打开工单链接后 Execution 页要读的那一份）；只写关心的字段。 */
function ticketDetailOf(): TicketDetailView {
  return {
    id: 'ticket-1',
    title: 'Fix the login redirect',
    stage: 'working',
    at: AT,
    mandate: {
      strength: 'explicit',
      actor: 'github:alice',
      policyVersion: '1a2b3c4d5e6f',
      via: 'addressed',
      rules: ['rule-login']
    },
    waitingInputs: [],
    subscriptions: [],
    assignments: [],
    reports: [],
    canRetry: false
  }
}

test('a row opens the decision detail, which links to its thread and its ticket', async () => {
  const mounted = await openEvalTab({
    decisions: () => pageOf([decision({ id: 'd1', kind: 'accept' })]),
    'decision.detail': () =>
      detailOf({
        id: 'd1',
        kind: 'accept',
        strength: 'inferred',
        canDismiss: false,
        reasons: [{ code: 'explicitRouted' }],
        ticket: { id: 'ticket-1', title: 'Fix the login redirect' }
      }),
    tickets: () => ({ items: [], nextOffset: null }),
    'ticket.detail': () => ticketDetailOf()
  })
  await mounted.activateRow({ type: 'Table' }, 'd1')
  assert.deepEqual(requestInput(mounted.host, 'decision.detail'), { decisionId: 'd1' })

  // 字段与原因：种类、强度、policy version、线程与工单，以及原因本身。
  assert.ok(mounted.find({ text: COPY['decision.accept'].en }), 'the kind')
  assert.ok(mounted.find({ text: new RegExp(COPY['strength.inferred'].en) }), 'the strength')
  assert.ok(mounted.find({ text: /1a2b3c4d5e6f/ }), 'the policy version')
  assert.ok(mounted.find({ text: /owner\/widgets#12/ }), 'the thread it evaluated')
  assert.ok(mounted.find({ text: /Fix the login redirect/ }), 'the ticket it started')
  assert.ok(
    mounted.find({ text: 'Explicit request from an allowed sender routed by the Router' }),
    'the reason in the panel language'
  )

  // 到 Thread 的链接：Trigger 页（焦点是两页的共享契约）。
  await mounted.press({ text: COPY['eval.openThread'].en })
  assert.equal(mounted.valueOf({ type: 'Tabs' }), 'trigger')
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('the detail links to the ticket the decision accepted', async () => {
  const mounted = await openEvalTab({
    decisions: () => pageOf([decision({ id: 'd1', kind: 'accept' })]),
    'decision.detail': () =>
      detailOf({
        id: 'd1',
        kind: 'accept',
        canDismiss: false,
        reasons: [{ code: 'explicitRouted' }],
        ticket: { id: 'ticket-1', title: 'Fix the login redirect' }
      }),
    tickets: () => ({ items: [], nextOffset: null }),
    'ticket.detail': () => ticketDetailOf()
  })
  await mounted.activateRow({ type: 'Table' }, 'd1')
  await mounted.press({ text: COPY['eval.openTicket'].en })
  assert.equal(mounted.valueOf({ type: 'Tabs' }), 'execution', 'the ticket link opens Execution')
  assert.deepEqual(requestInput(mounted.host, 'ticket.detail'), { ticketId: 'ticket-1' })
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

// ---------------------------------------------------------------------------
// Dismiss：只有 unavailable 有入口，且先做行内二次确认（§M.2、§K.7）
// ---------------------------------------------------------------------------

test('only an unavailable decision offers Dismiss, and it asks before acting', async () => {
  let dismissed = false
  const mounted = await openEvalTab({
    decisions: () => pageOf([decision({ id: 'd1' }), decision({ id: 'd2', kind: 'accept' })]),
    'decision.detail': (input) => {
      const decisionId = (input as { decisionId?: string } | null)?.decisionId ?? 'd1'
      return decisionId === 'd1'
        ? detailOf({ id: 'd1', dismissed, canDismiss: !dismissed })
        : detailOf({ id: 'd2', kind: 'accept', canDismiss: false })
    },
    'decision.dismiss': () => {
      dismissed = true
      return snapshot()
    }
  })

  // 接单的决定没有 dismiss 入口（领域同一条规则：只有 unavailable 能被 dismiss）。
  await mounted.activateRow({ type: 'Table' }, 'd2')
  assert.equal(mounted.find({ text: COPY['eval.dismiss'].en }), null)

  await mounted.press({ text: COPY['action.back'].en })
  await mounted.activateRow({ type: 'Table' }, 'd1')
  await mounted.press({ text: COPY['eval.dismiss'].en })
  const question = translate('en', 'confirm.body', {
    action: COPY['eval.dismiss'].en,
    target: 'owner/widgets#12'
  })
  assert.ok(mounted.find({ text: new RegExp(question) }), 'the inline confirm names the thread')
  assert.equal(requestNames(mounted.host).includes('decision.dismiss'), false, 'nothing is sent yet')

  await mounted.press({ text: COPY['action.cancel'].en })
  assert.equal(
    requestNames(mounted.host).includes('decision.dismiss'),
    false,
    'cancel has no side effect'
  )

  await mounted.press({ text: COPY['eval.dismiss'].en })
  await mounted.press({ text: COPY['action.confirm'].en })
  assert.deepEqual(requestInput(mounted.host, 'decision.dismiss'), { decisionId: 'd1' })

  // 写后的详情重读：已 dismiss 的说明出现，入口消失（领域仍允许幂等重复，面板不重复问）。
  assert.ok(
    mounted.find({ text: new RegExp(COPY['eval.dismissed'].en) }),
    'the detail says it was dismissed'
  )
  assert.equal(mounted.find({ text: COPY['eval.dismiss'].en }), null)
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

// ---------------------------------------------------------------------------
// 三态与 §K.7 的待人工条数
// ---------------------------------------------------------------------------

test('no decisions says so instead of drawing a placeholder page', async () => {
  const mounted = await openEvalTab({ decisions: () => pageOf([]) })
  assert.ok(mounted.find({ text: COPY['eval.empty'].en }))
  assert.equal(
    mounted.find({ text: /A later ticket fills this page/ }),
    null,
    'the placeholder is gone'
  )
  // 没有未解决的决定时不出现「待人工」提示（安静，而不是一个 0）。
  assert.equal(
    mounted.find({ text: translate('en', 'eval.unresolved', { count: 0 }) }),
    null
  )
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('an unreadable list shows the reason and one retry that works', async () => {
  let fail = true
  const mounted = await openEvalTab({
    decisions: () => {
      if (fail) throw Object.assign(new Error('the read model is not ready'), { code: 'unavailable' })
      return pageOf([decision({ id: 'd1' })])
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

test('the page shows the unresolved count the worker judged, and the detail says why', async () => {
  const mounted = await openEvalTab({
    decisions: () => pageOf([decision({ id: 'd1' }), decision({ id: 'd2', kind: 'ignore' })], 1),
    'decision.detail': () => detailOf({ id: 'd1', unresolved: true })
  })
  assert.ok(
    mounted.find({ text: translate('en', 'eval.unresolved', { count: 1 }) }),
    'the 24 h unresolved count is visible on the list'
  )
  await mounted.activateRow({ type: 'Table' }, 'd1')
  assert.ok(
    mounted.find({ text: COPY['eval.needsPersonHint'].en }),
    'the detail states the four conditions that still make it need a person'
  )
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

// ---------------------------------------------------------------------------
// 读模型：列表/详情与 §K.7 的四条件（与 Overview 的 System problems 同一份判定）
// ---------------------------------------------------------------------------

/** 一份读模型测试的夹具：真库 + 仓储 + 同一份 §K.7 判定。 */
function evalHarness() {
  const opened = openTempStore()
  const repo = createRepositories(opened.store)
  const problems = (now: string) => readUnavailableProblems({ sql: opened.store.sql }, { now })
  return {
    repo,
    store: opened.store,
    cleanup: opened.cleanup,
    problems,
    page: (now: string, input: DecisionListInput = {}) =>
      decisionPage(repo.decisions.list(), input, problems(now)),
    detail: (id: string, now: string) => {
      const decision = repo.decisions.get(id)
      assert.notEqual(decision, undefined, `the stored decision ${id} is readable`)
      return decisionDetail(decision!, { threads: repo.threads, tickets: repo.tickets }, problems(now))
    }
  }
}

/** 一条存进真库的 Decision。 */
function storedDecision(overrides: Partial<Decision> & Pick<Decision, 'id' | 'threadKey' | 'at'>): Decision {
  return {
    evalId: `eval-${overrides.id}`,
    triggerIds: ['trigger-1'],
    policyVersion: '1a2b3c4d5e6f',
    kind: 'unavailable',
    reason: [{ code: 'timeout', values: { attempts: '3' } }],
    strength: 'explicit',
    ...overrides
  }
}

/** 一条存进真库的 Thread；`label` 是 Source 给人看的名字。 */
function storedThread(key: string, label?: string): Thread {
  const separator = key.indexOf(':')
  return {
    key,
    ref: { source: key.slice(0, separator), id: key.slice(separator + 1) },
    createdAt: ISO_AT,
    lastAt: ISO_AT,
    subscriptions: [],
    correlated: [],
    pending: [],
    meta: label === undefined ? {} : { label }
  }
}

/** 一张最小的 Ticket（detail 读模型的 Ticket 链接用它）。 */
function storedTicket(id: string, title: string): Ticket {
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
    createdAt: ISO_AT,
    updatedAt: ISO_AT,
    origin: { triggerId: 'trigger-1', triggerIds: ['trigger-1'] }
  }
}

test('the decision read model pages 60 decisions 50 at a time, newest first', () => {
  const h = evalHarness()
  try {
    for (let index = 0; index < 60; index += 1) {
      h.repo.decisions.save(
        storedDecision({
          id: `d${index}`,
          threadKey: 'chat:room',
          at: isoAfter(ISO_AT, index * 1000)
        })
      )
    }
    const first = h.page(ISO_AT)
    assert.equal(first.items.length, 50, 'the first page holds one page of rows')
    assert.equal(first.nextOffset, 50, 'and says where the next page starts')
    assert.equal(first.items[0]?.id, 'd59', 'the newest decision is first')
    const second = h.page(ISO_AT, { offset: 50 })
    assert.equal(second.items.length, 10)
    assert.equal(second.nextOffset, null, 'the last page has no next page')
    assert.equal(second.items.at(-1)?.id, 'd0')
  } finally {
    h.cleanup()
  }
})

test('the decision detail read model carries the reasons, the thread link and the ticket link', () => {
  const h = evalHarness()
  try {
    h.repo.threads.save(storedThread('github:owner/widgets#12', 'owner/widgets#12'))
    h.repo.tickets.save(storedTicket('ticket-1', 'Fix the login redirect'))
    h.repo.decisions.save(
      storedDecision({
        id: 'decision-1',
        threadKey: 'github:owner/widgets#12',
        at: ISO_AT,
        kind: 'accept',
        strength: 'inferred',
        ticketId: 'ticket-1',
        triggerIds: ['trigger-1', 'trigger-2'],
        reason: [{ code: 'explicitRouted' }]
      })
    )
    const detail = h.detail('decision-1', ISO_AT)
    assert.deepEqual(detail.reasons, [{ code: 'explicitRouted' }])
    assert.equal(detail.strength, 'inferred')
    assert.deepEqual(detail.thread, {
      key: 'github:owner/widgets#12',
      title: 'owner/widgets#12'
    })
    assert.deepEqual(detail.ticket, { id: 'ticket-1', title: 'Fix the login redirect' })
    assert.deepEqual(detail.triggerIds, ['trigger-1', 'trigger-2'])
    assert.equal(detail.dismissed, false)
    assert.equal(detail.canDismiss, false, 'only an unavailable decision may be dismissed')
  } finally {
    h.cleanup()
  }
})

test('the unresolved count follows the four conditions of §K.7', () => {
  // 1. 窗口内、该 Thread 最新、未 dismiss、Thread 空闲 → 待人工。
  const open = evalHarness()
  try {
    open.repo.threads.save(storedThread('chat:room', 'Team room'))
    open.repo.decisions.save(storedDecision({ id: 'decision-1', threadKey: 'chat:room', at: ISO_AT }))
    assert.equal(open.page(ISO_AT).unresolved, 1)
    assert.equal(open.detail('decision-1', ISO_AT).unresolved, true)
    assert.equal(open.detail('decision-1', ISO_AT).canDismiss, true)
    // 超过 24 h 就不再要人（但记录仍可 dismiss）。
    assert.equal(open.page(isoAfter(ISO_AT, 24 * 60 * 60 * 1000 + 1000)).unresolved, 0)
  } finally {
    open.cleanup()
  }

  // 2. 同一条 Thread 上后来有了决定：旧的那条不再是最新。
  const superseded = evalHarness()
  try {
    superseded.repo.threads.save(storedThread('chat:room'))
    superseded.repo.decisions.save(
      storedDecision({ id: 'decision-1', threadKey: 'chat:room', at: ISO_AT })
    )
    superseded.repo.decisions.save(
      storedDecision({
        id: 'decision-2',
        threadKey: 'chat:room',
        at: isoAfter(ISO_AT, 1000),
        kind: 'ignore',
        reason: [{ code: 'noMention' }]
      })
    )
    assert.equal(superseded.page(isoAfter(ISO_AT, 2000)).unresolved, 0)
    assert.equal(superseded.detail('decision-1', isoAfter(ISO_AT, 2000)).unresolved, false)
  } finally {
    superseded.cleanup()
  }

  // 3. 已 dismiss 的问题不再要人，也不再给 dismiss 入口。
  const dismissed = evalHarness()
  try {
    dismissed.repo.threads.save(storedThread('chat:room'))
    dismissed.repo.decisions.save(
      storedDecision({ id: 'decision-1', threadKey: 'chat:room', at: ISO_AT, dismissed: true })
    )
    assert.equal(dismissed.page(ISO_AT).unresolved, 0)
    assert.equal(dismissed.detail('decision-1', ISO_AT).dismissed, true)
    assert.equal(dismissed.detail('decision-1', ISO_AT).unresolved, false)
    assert.equal(dismissed.detail('decision-1', ISO_AT).canDismiss, false)
  } finally {
    dismissed.cleanup()
  }

  // 4. Thread 在排队或评估中：下一次评估会给出新答案，旧问题立刻不再要人。
  for (const busy of ['queued', 'evaluating'] as const) {
    const h = evalHarness()
    try {
      const thread = storedThread('chat:room')
      h.repo.threads.save(
        busy === 'queued'
          ? { ...thread, pending: ['trigger-1'] }
          : {
              ...thread,
              evaluating: {
                id: 'eval-1',
                threadKey: 'chat:room',
                triggerIds: ['trigger-1'],
                strength: 'explicit',
                actor: { source: 'chat', id: 'alice' },
                basis: { via: 'addressed', addressed: 'mention' },
                policyVersion: '1a2b3c4d5e6f',
                startedAt: ISO_AT,
                deadline: isoAfter(ISO_AT, 60_000)
              }
            }
      )
      h.repo.decisions.save(
        storedDecision({ id: 'decision-1', threadKey: 'chat:room', at: ISO_AT })
      )
      assert.equal(h.page(ISO_AT).unresolved, 0, `a ${busy} thread hides the old problem`)
    } finally {
      h.cleanup()
    }
  }
})

// ---------------------------------------------------------------------------
// worker 侧的接线（§M.6）：面板发的每一条 Eval 请求都由 worker 应答；dismiss 之后
// Overview 的系统问题列表与 Eval 的待人工条数一起变。
// ---------------------------------------------------------------------------

test('the worker answers the Eval requests, and dismiss feeds the Overview problem list', async () => {
  const stateDir = tempStateDir()
  const at = new Date().toISOString()
  // 用真库播种（不是内部替身）：worker 启动后读的是同一份 SQLite 文件。
  const seed = openStore({ stateDir })
  const repo = createRepositories(seed)
  repo.threads.save(storedThread('github:owner/widgets#12', 'owner/widgets#12'))
  repo.decisions.save(
    storedDecision({ id: 'decision-1', threadKey: 'github:owner/widgets#12', at })
  )
  repo.decisions.save(
    storedDecision({
      id: 'decision-2',
      threadKey: 'github:owner/widgets#99',
      at: isoAfter(at, 1000),
      kind: 'accept',
      reason: [{ code: 'explicitRouted' }],
      ticketId: 'ticket-1'
    })
  )
  seed.close()

  const worker = await mountWorker(main, { host: mockHost({ settings: { stateDir } }) })
  try {
    const page = (await worker.request('decisions', {})) as DecisionListPage
    assert.equal(page.items.length, 2, 'both decisions are listed')
    assert.equal(page.unresolved, 1, 'the unresolved unavailable decision is the one that needs a person')
    const unavailable = page.items.find((item) => item.id === 'decision-1')
    assert.notEqual(unavailable, undefined)
    assert.equal(unavailable?.kind, 'unavailable')
    assert.deepEqual(unavailable?.reasons, [{ code: 'timeout', values: { attempts: '3' } }])
    assert.equal(unavailable?.strength, 'explicit')
    assert.equal(unavailable?.policyVersion, '1a2b3c4d5e6f')

    const detail = (await worker.request('decision.detail', {
      decisionId: 'decision-1'
    })) as DecisionDetailView
    assert.deepEqual(detail.thread, {
      key: 'github:owner/widgets#12',
      title: 'owner/widgets#12'
    })
    assert.equal(detail.unresolved, true)
    assert.equal(detail.canDismiss, true)

    // 同一条问题出现在 Overview 的 System problems 里，带着能跳回来的 Decision id。
    const state = (await worker.request('state')) as PanelState
    const problem = state.problems.find((row) => row.kind === 'unavailable')
    assert.deepEqual(problem, {
      id: 'unavailable:decision-1',
      kind: 'unavailable',
      name: 'github:owner/widgets#12',
      detail: 'Assessment timed out after 3 attempts',
      decisionId: 'decision-1'
    })

    const after = (await worker.request('decision.dismiss', {
      decisionId: 'decision-1'
    })) as PanelState
    assert.deepEqual(
      after.problems.filter((row) => row.kind === 'unavailable'),
      [],
      'the Overview problem list drops the dismissed decision'
    )
    const pageAfter = (await worker.request('decisions', {})) as DecisionListPage
    assert.equal(pageAfter.unresolved, 0)
    const detailAfter = (await worker.request('decision.detail', {
      decisionId: 'decision-1'
    })) as DecisionDetailView
    assert.equal(detailAfter.dismissed, true)
    assert.equal(detailAfter.unresolved, false)
    assert.equal(detailAfter.canDismiss, false)

    // 固定拒绝：未知决定是 `unknownDecision`；非 unavailable 不能被 dismiss（`unknownProblem`）。
    await assert.rejects(worker.request('decision.detail', { decisionId: 'nope' }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'unknownDecision')
      return true
    })
    await assert.rejects(
      worker.request('decision.dismiss', { decisionId: 'decision-2' }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'unknownProblem')
        return true
      }
    )
    assert.deepEqual(worker.refusals, [])
  } finally {
    // `deactivate()` 是关停屏障（§N.1）：返回之后才删，删除有界重试且不吞非竞态错误。
    await worker.deactivate()
    await removeTree(stateDir)
  }
})

// ---------------------------------------------------------------------------
// 与 Overview 的接线：系统问题的 unavailable 行直接打开那条决定（§J.3、§K.7）
// ---------------------------------------------------------------------------

test('an Overview problem row opens its decision on the Eval page', async () => {
  const withProblem: PanelState = {
    ...snapshot(),
    attention: { answer: 0, review: 0, problems: 1, items: [] },
    problems: [
      {
        id: 'unavailable:decision-1',
        kind: 'unavailable',
        name: 'owner/widgets#12',
        detail: 'Assessment timed out after 3 attempts',
        decisionId: 'decision-1'
      }
    ]
  }
  panel = await mount(panelModule, {
    host: mockHost({
      requests: {
        state: () => withProblem,
        decisions: () => pageOf([decision({ id: 'decision-1' })], 1),
        'decision.detail': () => detailOf({ id: 'decision-1', unresolved: true })
      }
    }),
    locale: 'en'
  })
  await panel.press({ text: /owner\/widgets#12/ })
  assert.equal(panel.valueOf({ type: 'Tabs' }), 'eval', 'the row opens the page that owns it')
  assert.deepEqual(
    requestInput(panel.host, 'decision.detail'),
    { decisionId: 'decision-1' },
    'it opens the decision behind the problem, not the synthetic row id'
  )
  assert.ok(panel.find({ text: COPY['eval.needsPersonHint'].en }))
  assert.deepEqual(panel.refusals, [])
  await panel.unmount()
  panel = undefined
})

test('a worker push re-reads the Eval list, and an older revision is ignored', async () => {
  let reads = 0
  const mounted = await openEvalTab({
    decisions: () => {
      reads += 1
      return pageOf([decision({ id: `d${reads}` })])
    }
  })
  assert.equal(requestNames(mounted.host).filter((name) => name === 'decisions').length, 1)
  await mounted.post('state.changed', { revision: 2 })
  assert.equal(reads, 2, 'a newer revision re-reads the page it shows')
  await mounted.post('state.changed', { revision: 1 })
  assert.equal(reads, 2, 'an older revision is ignored')
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

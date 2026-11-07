// Execution 页（§M.2、§M.4、§M.7）：列表（五档筛选 + 分页 50 条）、行→详情、详情的七块与
// 七个动作（停止与移除 worktree 要二次确认，聚焦终端与打开工作区经 worker 代理）。
//
// 断言分两层：
// - 面板侧：挂载真面板模块，读 Execution 页；列表与详情都是 worker 的请求（`tickets` /
//   `ticket.detail`），动作断言发出去的请求名与入参，并断言面板没有直接调宿主方法；
// - 读模型侧：`panelTicketPage` / `ticketDetail` 把真 Ticket 变成 `PanelTicket` 与详情
//   （不是手写夹具），包括「没有 agentState 时按严格表落 Working」这一行。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mount, mountWorker, test } from 'orca/testing'
import * as main from '../src/worker/main'
import type { Thread, Ticket, Trigger } from '../src/worker/core/index'
import { createRefreshableStateSource, panelTicketPage } from '../src/worker/app/state-source'
import { ticketDetail } from '../src/worker/app/views'
import {
  EXECUTION_FILTERS,
  type PanelState,
  type PanelTicket,
  type TicketDetailView
} from '../src/panel/protocol'
import { COPY, translate } from '../src/panel/copy'
import * as panelModule from '../src/panel/panel'
import check from '../src/panel/panel.check.ts'

/** `mockHost` 的请求表类型（测试里只写用到的几个名字）。 */
type Requests = NonNullable<NonNullable<Parameters<typeof mockHost>[0]>['requests']>

/** 一份健康快照；Execution 页自己读 `tickets`，快照只决定全局三态。 */
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

/** 一个固定时刻的 Execution 行。 */
function row(
  id: string,
  title: string,
  stage: PanelTicket['stage'] = 'working',
  outcome?: PanelTicket['outcome']
): PanelTicket {
  return { id, title, stage, at: 1_700_000_000_000, ...(outcome === undefined ? {} : { outcome }) }
}

/** 一页行：按请求的窗口切（分页由 worker 的读模型定，面板只画回来的窗口）。 */
function paged(all: readonly PanelTicket[]): Requests['tickets'] {
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

/** 每一档筛选的固定回答（筛选判定在 worker 的读模型里，面板只把档位发过去）。 */
function byFilter(answers: Readonly<Record<string, readonly PanelTicket[]>>): Requests['tickets'] {
  return (input) => {
    const filter = ((input ?? {}) as { readonly filter?: string }).filter ?? 'open'
    return { items: answers[filter] ?? [], nextOffset: null }
  }
}

/** 一份详情读数；只写用例关心的字段。 */
function detailOf(overrides: Partial<TicketDetailView> = {}): TicketDetailView {
  return {
    id: 't1',
    title: 'Fix the login redirect',
    stage: 'working',
    at: 1_700_000_000_000,
    mandate: {
      strength: 'explicit',
      actor: 'github:alice',
      policyVersion: 'v3',
      via: 'addressed',
      rules: ['rule-login']
    },
    waitingInputs: [],
    subscriptions: [],
    assignments: [],
    reports: [],
    canRetry: false,
    ...overrides
  }
}

let panel: Awaited<ReturnType<typeof mount>> | undefined

/** 挂载面板并停在 Execution 列表。 */
async function openExecutionTab(requests: Requests): Promise<Awaited<ReturnType<typeof mount>>> {
  panel = await mount(panelModule, {
    host: mockHost({ requests: { state: () => snapshot(), ...requests } }),
    locale: 'en'
  })
  await panel.select({ type: 'Tabs' }, 'execution')
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
function cellsOf(drawn: Record<string, unknown>): Readonly<Record<string, string>> {
  const cells = drawn['cells']
  return typeof cells === 'object' && cells !== null ? (cells as Record<string, string>) : {}
}

// ---------------------------------------------------------------------------
// 列表：分页、筛选、行→详情、stage 标签
// ---------------------------------------------------------------------------

test('the Execution table asks for one page and loads the next on demand', async () => {
  const all = Array.from({ length: 60 }, (_, index) => row(`t${index}`, `Ticket ${index + 1}`))
  const mounted = await openExecutionTab({ tickets: paged(all) })
  assert.equal(mounted.rowsOf({ type: 'Table' }).length, 50, 'the first page holds fifty rows (§M.4)')
  assert.ok(
    mounted.summary().some((line) => line.startsWith('Table') && line.includes('50 row(s)')),
    'the summary says how many rows are drawn'
  )
  assert.deepEqual(requestInput(mounted.host, 'tickets'), { filter: 'open', offset: 0, limit: 50 })

  await mounted.loadMore({ type: 'Table' })
  assert.equal(mounted.rowsOf({ type: 'Table' }).length, 60, 'load more appends the rest')
  assert.deepEqual(requestInput(mounted.host, 'tickets'), { filter: 'open', offset: 50, limit: 50 })
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('the five filters ask the worker for their own window', async () => {
  const mounted = await openExecutionTab({
    tickets: byFilter({
      open: [row('a', 'Open one'), row('b', 'Open two')],
      pending: [row('c', 'Answer me', 'answer')],
      working: [row('d', 'Work in progress', 'working')],
      waiting: [row('e', 'Waiting for a trigger', 'idle')],
      ended: [row('f', 'Done', 'ended', 'completed')]
    })
  })
  assert.deepEqual(requestInput(mounted.host, 'tickets'), { filter: 'open', offset: 0, limit: 50 })
  assert.ok(mounted.find({ text: /Open one/ }))

  for (const filter of EXECUTION_FILTERS) {
    await mounted.select({ type: 'RadioGroup' }, filter)
    assert.deepEqual(
      requestInput(mounted.host, 'tickets'),
      { filter, offset: 0, limit: 50 },
      `${filter} asks for its own page`
    )
  }
  assert.ok(mounted.find({ text: /Done/ }), 'the rows are the answer for the chosen filter')
  assert.equal(mounted.find({ text: /Open one/ }), null, 'the previous filter rows are gone')
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('the stage column uses the core stage table labels, and a null agent state reads Working', async () => {
  const mounted = await openExecutionTab({
    tickets: byFilter({
      open: [
        row('t1', 'Undelivered', 'delivery'),
        row('t2', 'Awaiting answer', 'answer'),
        row('t3', 'Awaiting review', 'review'),
        row('t4', 'Blocked or failed', 'blockedFailed'),
        row('t5', 'Queued', 'queued'),
        row('t6', 'Idle', 'idle'),
        // 没有观察到 agent 状态时，§E.8 的严格表落到第 8 行：Working。
        row('t7', 'Working', 'working'),
        row('t8', 'Ended', 'ended', 'merged')
      ]
    })
  })
  const stages = tableRows(mounted).map((drawn) => cellsOf(drawn)['stage'])
  assert.deepEqual(stages, [
    COPY['stage.delivery'].en,
    COPY['stage.answer'].en,
    COPY['stage.review'].en,
    COPY['stage.blockedFailed'].en,
    COPY['stage.queued'].en,
    COPY['stage.idle'].en,
    COPY['stage.working'].en,
    COPY['outcome.merged'].en
  ])
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('no tickets says so instead of drawing a placeholder page', async () => {
  const mounted = await openExecutionTab({ tickets: () => ({ items: [], nextOffset: null }) })
  assert.ok(mounted.find({ text: COPY['execution.empty'].en }))
  assert.equal(mounted.find({ text: /A later ticket fills this page/ }), null, 'the placeholder is gone')
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('an unreadable list shows the reason and one retry that works', async () => {
  let fail = true
  const mounted = await openExecutionTab({
    tickets: () => {
      if (fail) throw Object.assign(new Error('the read model is not ready'), { code: 'unavailable' })
      return { items: [row('t1', 'Fix the login redirect')], nextOffset: null }
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

test('a row opens the ticket detail the worker answers with', async () => {
  const mounted = await openExecutionTab({
    tickets: () => ({ items: [row('t1', 'Fix the login redirect')], nextOffset: null }),
    'ticket.detail': () => detailOf()
  })
  await mounted.activateRow({ type: 'Table' }, 't1')
  assert.deepEqual(requestInput(mounted.host, 'ticket.detail'), { ticketId: 't1' })
  assert.ok(mounted.find({ text: /Fix the login redirect/ }), 'the detail names the ticket')
  assert.ok(mounted.find({ label: COPY['execution.mandate'].en }), 'the mandate block is drawn')
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

// ---------------------------------------------------------------------------
// 详情：七块内容、可折叠的派工、Attention 的终端摘要预览
// ---------------------------------------------------------------------------

test('the detail shows the mandate, the waiting inputs, the subscriptions, the assignments and the reports', async () => {
  const mounted = await openExecutionTab({
    tickets: () => ({ items: [row('t1', 'Fix the login redirect')], nextOffset: null }),
    'ticket.detail': () =>
      detailOf({
        mandate: {
          strength: 'inferred',
          actor: 'github:alice',
          policyVersion: 'v9',
          via: 'admission',
          cell: 'unlistedAddressed',
          rules: ['rule-login', 'rule-docs']
        },
        waitingInputs: [
          { id: 'i-1', kind: 'trigger', at: 1_700_000_000_000, text: 'also update the docs', human: true },
          { id: 'i-2', kind: 'note', at: 1_700_000_000_000, text: 'the schema lives in db/migrations' }
        ],
        subscriptions: [
          { key: 'github:owner/widgets#12', title: 'owner/widgets#12', lastAt: 1_700_000_000_000, context: false },
          { key: 'github:owner/widgets#13', title: 'owner/widgets#13', context: true }
        ],
        assignments: [
          { id: 'a-1', state: 'running', createdAt: 1_700_000_000_000, terminalId: 'term_1' }
        ],
        reports: [
          { state: 'progress', summary: 'reading the router', at: 1_700_000_000_000 }
        ]
      })
  })
  await mounted.activateRow({ type: 'Table' }, 't1')

  // 授权面（§M.2）：强度、发起人、policy version、准入依据与匹配规则。
  assert.ok(mounted.find({ label: COPY['execution.mandate'].en }))
  assert.ok(mounted.find({ text: new RegExp(COPY['strength.inferred'].en) }))
  assert.ok(mounted.find({ text: new RegExp('github:alice') }))
  assert.ok(mounted.find({ text: new RegExp('v9') }))
  assert.ok(mounted.find({ text: new RegExp(COPY['mandate.via.admission'].en) }), 'the gate basis')
  assert.ok(mounted.find({ text: new RegExp(COPY['mandate.cell.unlistedAddressed'].en) }))
  assert.ok(mounted.find({ text: /rule-login/ }), 'the matched rules')

  // 等待中的 Input、订阅、报告。
  assert.ok(mounted.find({ text: /Waiting inputs/ }))
  assert.ok(mounted.find({ text: /also update the docs/ }))
  assert.ok(mounted.find({ text: /the schema lives in db\/migrations/ }))
  assert.ok(mounted.find({ text: new RegExp(COPY['execution.human'].en) }), 'a human input says so')
  assert.ok(mounted.find({ text: /Subscriptions/ }))
  assert.ok(mounted.find({ text: /owner\/widgets#12/ }))
  assert.ok(mounted.find({ text: new RegExp(COPY['execution.contextOnly'].en) }), 'context-only says so')
  assert.ok(mounted.find({ text: /Reports/ }))
  assert.ok(mounted.find({ text: /reading the router/ }))
  assert.ok(mounted.find({ text: new RegExp(COPY['report.progress'].en) }))
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('the assignment list is folded until a person opens it', async () => {
  const mounted = await openExecutionTab({
    tickets: () => ({ items: [row('t1', 'Fix the login redirect')], nextOffset: null }),
    'ticket.detail': () =>
      detailOf({
        assignments: [
          {
            id: 'a-1',
            state: 'ended',
            createdAt: 1_700_000_000_000,
            endedAt: 1_700_000_000_000,
            endedReason: 'done',
            terminalId: 'term_1',
            report: { state: 'ready', summary: 'the redirect is fixed', at: 1_700_000_000_000 }
          }
        ]
      })
  })
  await mounted.activateRow({ type: 'Table' }, 't1')
  assert.ok(mounted.find({ type: 'Collapsible' }), 'the assignment list is one collapsible block')
  assert.equal(
    mounted.find({ type: 'ListItem' }),
    null,
    'the folded block draws none of its rows yet'
  )
  await mounted.toggle({ type: 'Collapsible' })
  assert.ok(mounted.find({ text: new RegExp(COPY['assignment.ended'].en) }), 'the assignment row')
  assert.ok(mounted.find({ text: /term_1/ }), 'and the terminal it ran in')
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('attention shows the last lines of the terminal as its preview', async () => {
  const mounted = await openExecutionTab({
    tickets: () => ({ items: [row('t1', 'Fix the login redirect', 'answer')], nextOffset: null }),
    'ticket.detail': () =>
      detailOf({
        stage: 'answer',
        attention: { question: 'Which branch should I target?', at: 1_700_000_000_000, via: 'terminal' },
        terminal: {
          terminalId: 'term_1',
          lines: ['older line', 'Do you want me to continue? [y/N]'],
          truncated: false
        }
      })
  })
  await mounted.activateRow({ type: 'Table' }, 't1')
  assert.ok(mounted.find({ text: /Which branch should I target\?/ }))
  assert.ok(mounted.find({ text: new RegExp(COPY['attention.fromTerminal'].en) }))
  assert.ok(mounted.find({ text: /Do you want me to continue\?/ }), 'the terminal tail is the preview')
  assert.ok(mounted.find({ text: new RegExp(COPY['execution.terminal'].en) }), 'and the full summary block')
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('an ended ticket shows its outcome and stops offering worktree actions when none is recorded', async () => {
  const mounted = await openExecutionTab({
    tickets: () => ({
      items: [row('t1', 'Fix the login redirect', 'ended', 'stopped')],
      nextOffset: null
    }),
    'ticket.detail': () =>
      detailOf({
        stage: 'ended',
        outcome: 'stopped',
        ended: { at: 1_700_000_000_000, by: 'human', outcome: 'stopped', reason: 'wrong direction' }
      })
  })
  await mounted.activateRow({ type: 'Table' }, 't1')
  assert.ok(mounted.find({ text: new RegExp(COPY['outcome.stopped'].en) }))
  assert.ok(mounted.find({ text: new RegExp(COPY['endBy.human'].en) }))
  assert.ok(mounted.find({ text: /wrong direction/ }))
  assert.equal(mounted.find({ text: COPY['execution.openWorktree'].en }), null)
  assert.equal(mounted.find({ text: COPY['execution.removeWorktree'].en }), null)
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('an unreadable detail shows the reason and one retry that works', async () => {
  let fail = true
  const mounted = await openExecutionTab({
    tickets: () => ({ items: [row('t1', 'Fix the login redirect')], nextOffset: null }),
    'ticket.detail': () => {
      if (fail) throw Object.assign(new Error('the worker is restarting'), { code: 'unavailable' })
      return detailOf()
    }
  })
  await mounted.activateRow({ type: 'Table' }, 't1')
  assert.ok(mounted.find({ text: new RegExp(COPY['state.errorTitle'].en) }))
  assert.ok(mounted.find({ text: /the worker is restarting/ }), 'the reason is shown')
  fail = false
  await mounted.press({ text: COPY['state.retry'].en })
  assert.ok(mounted.find({ text: /Fix the login redirect/ }))
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

// ---------------------------------------------------------------------------
// 动作：破坏性动作要二次确认；聚焦终端与打开工作区经 worker 代理
// ---------------------------------------------------------------------------

test('Stop asks before acting, and cancelling sends nothing', async () => {
  const mounted = await openExecutionTab({
    tickets: () => ({ items: [row('t1', 'Fix the login redirect')], nextOffset: null }),
    'ticket.detail': () => detailOf(),
    'ticket.stop': () => snapshot()
  })
  await mounted.activateRow({ type: 'Table' }, 't1')
  await mounted.press({ text: COPY['action.stop'].en })
  const question = translate('en', 'confirm.body', {
    action: COPY['action.stop'].en,
    target: 'Fix the login redirect'
  })
  assert.ok(mounted.find({ text: new RegExp(question) }), 'the inline confirm names the ticket')
  assert.equal(requestNames(mounted.host).includes('ticket.stop'), false, 'nothing is sent yet')

  await mounted.press({ text: COPY['action.cancel'].en })
  assert.equal(mounted.find({ text: new RegExp(question) }), null, 'cancel closes the confirmation')
  assert.equal(requestNames(mounted.host).includes('ticket.stop'), false, 'cancel has no side effect')

  await mounted.press({ text: COPY['action.stop'].en })
  await mounted.press({ text: COPY['action.confirm'].en })
  assert.deepEqual(requestInput(mounted.host, 'ticket.stop'), { ticketId: 't1' })
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('Remove worktree asks before acting, and confirming sends the request', async () => {
  const mounted = await openExecutionTab({
    tickets: () => ({ items: [row('t1', 'Fix the login redirect')], nextOffset: null }),
    'ticket.detail': () =>
      detailOf({
        worktree: { name: 'fix-login', directory: '/repos/widgets/superagent-fix-login' }
      }),
    'workspace.remove': () => ({ removed: true })
  })
  await mounted.activateRow({ type: 'Table' }, 't1')
  await mounted.press({ text: COPY['execution.removeWorktree'].en })
  const question = translate('en', 'confirm.body', {
    action: COPY['execution.removeWorktree'].en,
    target: '/repos/widgets/superagent-fix-login'
  })
  assert.ok(mounted.find({ text: new RegExp(question) }), 'the confirmation names the directory')
  assert.equal(requestNames(mounted.host).includes('workspace.remove'), false)

  await mounted.press({ text: COPY['action.cancel'].en })
  assert.equal(requestNames(mounted.host).includes('workspace.remove'), false, 'cancel has no side effect')

  await mounted.press({ text: COPY['execution.removeWorktree'].en })
  await mounted.press({ text: COPY['action.confirm'].en })
  assert.deepEqual(requestInput(mounted.host, 'workspace.remove'), { ticketId: 't1' })
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('Retry, Request status and Note go through the worker', async () => {
  let retryable = true
  let asked = true
  const mounted = await openExecutionTab({
    tickets: () => ({ items: [row('t1', 'Fix the login redirect')], nextOffset: null }),
    'ticket.detail': () => detailOf({ canRetry: retryable }),
    'ticket.retry': () => snapshot(),
    'ticket.note': () => snapshot(),
    'ticket.requestStatus': () => ({ asked })
  })
  await mounted.activateRow({ type: 'Table' }, 't1')

  await mounted.press({ text: COPY['action.retry'].en })
  assert.deepEqual(requestInput(mounted.host, 'ticket.retry'), { ticketId: 't1' })

  await mounted.press({ text: COPY['execution.requestStatus'].en })
  assert.deepEqual(requestInput(mounted.host, 'ticket.requestStatus'), { ticketId: 't1' })
  assert.ok(mounted.find({ text: COPY['execution.asked'].en }), 'the worker answered honestly')

  await mounted.type({ type: 'Textarea' }, 'the schema lives in db/migrations')
  await mounted.press({ text: COPY['execution.noteSend'].en })
  assert.deepEqual(requestInput(mounted.host, 'ticket.note'), {
    ticketId: 't1',
    text: 'the schema lives in db/migrations'
  })
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('Open terminal and Open worktree go through the worker, never the host', async () => {
  const mounted = await openExecutionTab({
    tickets: () => ({ items: [row('t1', 'Fix the login redirect')], nextOffset: null }),
    'ticket.detail': () =>
      detailOf({
        terminal: { terminalId: 'term_9', lines: ['working'], truncated: false },
        worktree: { name: 'fix-login', directory: '/repos/widgets/superagent-fix-login' }
      }),
    'terminal.focus': () => ({ focused: true }),
    'workspace.open': () => ({ opened: true })
  })
  await mounted.activateRow({ type: 'Table' }, 't1')

  await mounted.press({ text: COPY['overview.openTerminal'].en })
  assert.deepEqual(requestInput(mounted.host, 'terminal.focus'), { terminalId: 'term_9' })

  await mounted.press({ text: COPY['execution.openWorktree'].en })
  assert.deepEqual(requestInput(mounted.host, 'workspace.open'), { ticketId: 't1' })

  // 面板没有这两个宿主方法（§M.2）：它一次也不能直接调它们。
  const direct = mounted.host.calls
    .map((call) => call.method)
    .filter((method) => method === 'workspace.open' || method === 'terminal.focus')
  assert.deepEqual(direct, [], 'the panel proxies both actions through the worker')
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('the healthy check scenario shows the ticket row on Overview and the Execution list', async () => {
  panel = await mount(panelModule, { host: mockHost({ requests: check.healthy.requests }), locale: 'en' })
  assert.ok(panel.find({ text: /Fix the login redirect/ }), 'Overview shows it as another ticket')
  await panel.select({ type: 'Tabs' }, 'execution')
  assert.equal(panel.rowsOf({ type: 'Table' }).length, 1, 'Execution lists the same ticket')
  assert.deepEqual(panel.refusals, [])
  await panel.unmount()
  panel = undefined
})

test('the needs-person check scenario shows the ticket row it wants a person for', async () => {
  panel = await mount(panelModule, {
    host: mockHost({ requests: check['needs-person'].requests }),
    locale: 'en'
  })
  assert.ok(panel.find({ text: /Fix the login redirect/ }), 'the attention row names it')
  assert.ok(panel.find({ text: /Awaiting answer/ }))
  await panel.select({ type: 'Tabs' }, 'execution')
  assert.equal(panel.rowsOf({ type: 'Table' }).length, 2, 'both tickets are in the list')
  await panel.unmount()
  panel = undefined
})

// ---------------------------------------------------------------------------
// 列表读模型：五档筛选与分页（§M.2 的 Execution 列表、§M.4 的「分页 50 条」）
// ---------------------------------------------------------------------------

/** 固定时刻。 */
const AT = '2026-11-07T03:26:00.000Z'

/** 一张形状完整的工单；每个用例只写它关心的字段。 */
function ticketOf(overrides: Partial<Ticket> = {}): Ticket {
  return {
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
    assignments: [{ id: 'a-1', state: 'running', createdAt: AT, startedAt: AT, terminalId: 'term_1' }],
    inputs: [],
    undelivered: [],
    createdAt: AT,
    updatedAt: AT,
    origin: { triggerId: 'trigger-1', triggerIds: ['trigger-1'] },
    ...overrides
  }
}

test('the list read model pages 60 tickets 50 at a time and keeps the read model order', () => {
  const tickets = Array.from({ length: 60 }, (_, index) =>
    ticketOf({ id: `t${index}`, title: `Ticket ${index}` })
  )
  const first = panelTicketPage(tickets)
  assert.equal(first.items.length, 50, 'the first page holds one page of rows')
  assert.equal(first.nextOffset, 50, 'and says where the next page starts')
  const second = panelTicketPage(tickets, { offset: 50 })
  assert.equal(second.items.length, 10)
  assert.equal(second.nextOffset, null, 'the last page has no next page')
  assert.equal(second.items[0]?.title, 'Ticket 50', 'the order is the read model order')
})

test('the list read model maps the five design filters onto the domain filters', () => {
  const tickets = [
    ticketOf({ id: 'open', title: 'Open work' }),
    ticketOf({ id: 'answer', title: 'Answer me', attention: { id: 'q', question: '?', at: AT } }),
    ticketOf({
      id: 'review',
      title: 'Review me',
      assignments: [{ id: 'a', state: 'running', createdAt: AT, report: { state: 'ready', summary: '', at: AT } }]
    }),
    ticketOf({
      id: 'delivery',
      title: 'Delivery failed',
      delivery: { error: 'terminal gone', at: AT },
      assignments: [{ id: 'a', state: 'running', createdAt: AT }]
    }),
    ticketOf({ id: 'queued', title: 'Queued work', assignments: [] }),
    ticketOf({
      id: 'ended',
      title: 'Done work',
      ended: { at: AT, by: 'executor', outcome: 'completed' }
    })
  ]
  const ids = (filter: Parameters<typeof panelTicketPage>[1]) =>
    panelTicketPage(tickets, filter).items.map((ticket) => ticket.id)
  assert.deepEqual(ids({ filter: 'open' }), ['open', 'answer', 'review', 'delivery', 'queued'])
  assert.deepEqual(ids({ filter: 'pending' }), ['answer', 'review', 'delivery'], 'person rows')
  assert.deepEqual(ids({ filter: 'working' }), ['open', 'queued'], 'working and queued')
  assert.deepEqual(ids({ filter: 'waiting' }), [], 'idle needs an observed agent state')
  assert.deepEqual(ids({ filter: 'ended' }), ['ended'])
})

test('a report of waiting still reads Working when no agent state was observed', () => {
  // §E.8 第 7 行要求 `agentState ∈ {waiting, done}`；没有观察到状态（null）时不满足集合成员，
  // 落到第 8 行的 Working。列表读模型不带 agentState，因此这一行必须是严格的表结果。
  const waiting = ticketOf({
    assignments: [
      { id: 'a', state: 'running', createdAt: AT, report: { state: 'waiting', summary: '', at: AT } }
    ]
  })
  assert.equal(panelTicketPage([waiting]).items[0]?.stage, 'working')
})

// ---------------------------------------------------------------------------
// 详情读模型：§M.2 的五块（授权、等待中的 Input、订阅、派工、报告）+ 待人工 + 终端摘要
// ---------------------------------------------------------------------------

test('the detail read model carries the mandate, the waiting inputs, the subscriptions, the assignments and the reports', () => {
  const ticket = ticketOf({
    mandate: {
      strength: 'inferred',
      policyVersion: 'v7',
      basis: { via: 'admission', cell: 'unlistedAddressed', addressed: 'mention', rules: ['r1', 'r2'] },
      actor: { source: 'github', id: 'alice' },
      scope: 'small'
    },
    assignments: [
      {
        id: 'a-1',
        state: 'ended',
        createdAt: AT,
        startedAt: AT,
        endedAt: AT,
        endedReason: 'done',
        terminalId: 'term_1',
        report: { state: 'ready', summary: 'the redirect is fixed', at: AT }
      },
      { id: 'a-2', state: 'running', createdAt: AT, startedAt: AT, terminalId: 'term_2' }
    ],
    inputs: [
      { id: 'i-1', kind: 'trigger', triggerId: 'trigger-2', at: AT, human: true },
      { id: 'i-2', kind: 'note', text: 'the schema lives in db/migrations', at: AT }
    ],
    undelivered: ['i-1', 'i-2'],
    attention: { id: 'q', question: 'Which branch?', at: AT, via: 'terminal' },
    execution: { name: 'fix-login', directory: '/repos/widgets/superagent-fix-login', assignment: 'job' }
  })
  const threads: readonly Thread[] = [
    {
      key: 'github:owner/widgets#12',
      ref: { source: 'github', id: '12' },
      createdAt: AT,
      lastAt: AT,
      subscriptions: ['ticket-1'],
      correlated: [],
      pending: [],
      meta: { label: 'owner/widgets#12' }
    },
    {
      key: 'github:owner/widgets#13',
      ref: { source: 'github', id: '13' },
      createdAt: AT,
      subscriptions: ['ticket-1'],
      context: ['ticket-1'],
      correlated: [],
      pending: [],
      meta: {}
    }
  ]
  const triggers = new Map<string, Trigger>([
    [
      'trigger-2',
      {
        id: 'trigger-2',
        source: 'github',
        threads: [{ source: 'github', id: '12' }],
        actor: { source: 'github', id: 'alice' },
        human: true,
        at: AT,
        text: 'also update the docs while you are there',
        meta: {}
      }
    ]
  ])
  const detail = ticketDetail(
    ticket,
    { threads: { list: () => threads }, triggers: { get: (id) => triggers.get(id) } },
    { terminal: { terminalId: 'term_2', lines: ['one', 'two'], truncated: false } }
  )
  assert.deepEqual(detail.mandate, {
    strength: 'inferred',
    actor: 'github:alice',
    policyVersion: 'v7',
    via: 'admission',
    cell: 'unlistedAddressed',
    rules: ['r1', 'r2']
  })
  assert.deepEqual(
    detail.waitingInputs.map((input) => [input.kind, input.text]),
    [
      ['trigger', 'also update the docs while you are there'],
      ['note', 'the schema lives in db/migrations']
    ],
    'a waiting Trigger shows its own words; a note shows the fact it carries'
  )
  assert.equal(detail.waitingInputs[0]?.triggerId, 'trigger-2')
  assert.equal(detail.waitingInputs[0]?.human, true)
  assert.deepEqual(
    detail.subscriptions.map((subscription) => [subscription.key, subscription.title, subscription.context]),
    [
      ['github:owner/widgets#12', 'owner/widgets#12', false],
      ['github:owner/widgets#13', 'github:owner/widgets#13', true]
    ],
    'a context-only Thread says so instead of looking like a deciding subscription'
  )
  assert.deepEqual(
    detail.assignments.map((assignment) => [assignment.id, assignment.state, assignment.terminalId]),
    [
      ['a-1', 'ended', 'term_1'],
      ['a-2', 'running', 'term_2']
    ]
  )
  assert.deepEqual(
    detail.reports.map((report) => [report.state, report.summary]),
    [['ready', 'the redirect is fixed']]
  )
  assert.deepEqual(detail.attention, {
    question: 'Which branch?',
    at: Date.parse(AT),
    via: 'terminal'
  })
  assert.deepEqual(detail.terminal, { terminalId: 'term_2', lines: ['one', 'two'], truncated: false })
  assert.deepEqual(detail.worktree, {
    name: 'fix-login',
    directory: '/repos/widgets/superagent-fix-login'
  })
  assert.equal(detail.canRetry, false, 'a running ticket is not retryable')
})

test('the detail read model marks retryable and ended tickets without inventing either', () => {
  const blocked = ticketOf({
    assignments: [
      {
        id: 'a-1',
        state: 'ended',
        createdAt: AT,
        endedAt: AT,
        report: { state: 'blocked', summary: 'need the migration name', at: AT }
      }
    ]
  })
  const records = { threads: { list: () => [] }, triggers: { get: () => undefined } }
  assert.equal(ticketDetail(blocked, records).canRetry, true)
  assert.equal(
    ticketDetail(blocked, records).stage,
    'working',
    'blocked needs an observed agent state; without one the strict table says Working'
  )
  const ended = ticketOf({
    ended: { at: AT, by: 'human', outcome: 'stopped', reason: 'wrong direction' }
  })
  const detail = ticketDetail(ended, records)
  assert.equal(detail.stage, 'ended')
  assert.deepEqual(detail.ended, {
    at: Date.parse(AT),
    by: 'human',
    outcome: 'stopped',
    reason: 'wrong direction'
  })
  assert.equal(detail.canRetry, false)
  assert.equal(detail.worktree, undefined, 'no worktree recorded, so the page offers no worktree action')
  assert.equal(detail.terminal, undefined, 'no terminal read, so the page shows no summary')
})

test('the worker read model turns a real ticket into its Execution row', () => {
  const base = ticketOf()
  const source = createRefreshableStateSource({
    tickets: () => [
      base,
      {
        ...base,
        id: 'ticket-2',
        title: 'Ship the payroll export',
        ended: { at: AT, by: 'executor', outcome: 'completed' }
      }
    ],
    activity: () => ({ received: 1, evaluated: 1, accepted: 1, ignored: 0, ended: 1 }),
    load: () => ({ running: 1, maxWorkers: 2, humanSlot: 'free' }),
    hasError: () => false,
    setupMissing: () => false,
    paused: () => false
  })
  const state = source.refresh()
  assert.deepEqual(
    state.tickets?.map((ticket) => [ticket.title, ticket.stage, ticket.outcome]),
    [
      ['Fix the login redirect', 'working', undefined],
      ['Ship the payroll export', 'ended', 'completed']
    ]
  )
})

test('the worker read model carries the system problem count the panel must surface (§J.3)', () => {
  const source = createRefreshableStateSource({
    tickets: () => [],
    activity: () => ({ received: 0, evaluated: 0, accepted: 0, ignored: 0, ended: 0 }),
    load: () => ({ running: 0, maxWorkers: 2, humanSlot: 'free' }),
    hasError: () => false,
    setupMissing: () => false,
    paused: () => false,
    problems: () => [
      { id: 'health:assessment', kind: 'health', name: 'assessment', detail: 'waiting 2, failed 1' },
      { id: 'unavailable:d1', kind: 'unavailable', name: 'thread-7', detail: 'no answer' }
    ]
  })
  assert.equal(source.snapshot().attention.problems, 2, 'the snapshot carries the unresolved count')
  assert.equal(source.snapshot().problems.length, 2, 'the rows the panel draws')
  assert.deepEqual(
    source.snapshot().problems.map((problem) => problem.kind),
    ['health', 'unavailable'],
    'both sources are carried'
  )
  // 没有读口时保持 0：面板壳的夹具与桩不假装有系统问题。
  const stub = createRefreshableStateSource({
    tickets: () => [],
    activity: () => ({ received: 0, evaluated: 0, accepted: 0, ignored: 0, ended: 0 }),
    load: () => ({ running: 0, maxWorkers: 2, humanSlot: 'free' }),
    hasError: () => false,
    setupMissing: () => false,
    paused: () => false
  })
  assert.equal(stub.snapshot().attention.problems, 0)
})

// ---------------------------------------------------------------------------
// worker 侧的接线（§M.6）：面板发的每一条 Execution 请求都由 worker 应答；不存在的工单是
// 固定拒绝，而不是编一个空壳读数。
// ---------------------------------------------------------------------------

test('the worker answers the Execution requests the panel sends', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'superagent-execution-'))
  const worker = await mountWorker(main, { host: mockHost({ settings: { stateDir } }) })
  try {
    // 空库也是一页：列表回答 `{items: [], nextOffset: null}`，不是拒绝。
    assert.deepEqual(await worker.request('tickets', { filter: 'open', offset: 0, limit: 50 }), {
      items: [],
      nextOffset: null
    })
    // 详情与动作只对存在的工单成立：未知 id 一律按领域的 `unknownTicket` 拒绝。
    const unknown = (name: string, input?: Record<string, unknown>) =>
      assert.rejects(worker.request(name, input), (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'unknownTicket')
        return true
      })
    await unknown('ticket.detail', { ticketId: 'nope' })
    await unknown('ticket.stop', { ticketId: 'nope' })
    await unknown('ticket.note', { ticketId: 'nope', text: 'a fact' })
    await unknown('ticket.requestStatus', { ticketId: 'nope' })
    await unknown('workspace.open', { ticketId: 'nope' })
    await unknown('workspace.remove', { ticketId: 'nope' })
    assert.deepEqual(worker.refusals, [])
  } finally {
    await worker.deactivate()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

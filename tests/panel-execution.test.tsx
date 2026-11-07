// Execution 页（§M.2、§Q.1 的面板验收）：行来自 worker 快照的 `tickets`，与 Overview 用同
// 一个 `TicketRow`；`plugin check` 的 healthy / needs-person 情景必须带上那张工单。
//
// 断言分两层：
// - 面板侧：挂载真面板模块，读 Execution 页，断言行数与措辞；
// - 读模型侧：`createRefreshableStateSource` 把真 Ticket 变成 `PanelTicket`（不是手写夹具）。
import { assert, mockHost, mount, test } from 'orca/testing'
import type { Ticket } from '../src/worker/core/index'
import { createRefreshableStateSource } from '../src/worker/app/state-source'
import type { PanelState, PanelTicket } from '../src/panel/protocol'
import * as panelModule from '../src/panel/panel'
import check from '../src/panel/panel.check.ts'

/** 一份健康快照；`tickets` 是本页唯一的输入。 */
function snapshot(tickets?: readonly PanelTicket[]): PanelState {
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
    ...(tickets === undefined ? {} : { tickets })
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

let panel: Awaited<ReturnType<typeof mount>> | undefined

/** 挂载面板并停在 Execution 页。 */
async function openExecution(state: PanelState) {
  panel = await mount(panelModule, {
    host: mockHost({ requests: { state: () => state } }),
    locale: 'en'
  })
  await panel.select({ type: 'Tabs' }, 'execution')
  return panel
}

test('the Execution page lists the ticket rows the worker snapshot carries', async () => {
  const mounted = await openExecution(
    snapshot([
      row('t1', 'Fix the login redirect'),
      row('t2', 'Review the parser rewrite', 'blockedFailed'),
      row('t3', 'Ship the payroll export', 'ended', 'completed')
    ])
  )
  assert.ok(mounted.find({ text: /Fix the login redirect/ }))
  assert.ok(mounted.find({ text: /Review the parser rewrite/ }))
  assert.ok(mounted.find({ text: /Ship the payroll export/ }))
  assert.ok(mounted.find({ text: /Working/ }), 'the working stage')
  assert.ok(mounted.find({ text: /Blocked · Failed/ }), 'the blocked/failed stage')
  assert.ok(mounted.find({ text: /Completed/ }), 'the ended outcome')
  // 时间一律交给宿主组件，面板不自己格式化。
  assert.equal(mounted.findAll({ type: 'RelativeTime' }).length, 3)
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('no tickets says so instead of drawing a placeholder page', async () => {
  const mounted = await openExecution(snapshot([]))
  assert.ok(mounted.find({ text: 'No tickets.' }))
  assert.equal(mounted.find({ text: /A later ticket fills this page/ }), null, 'the placeholder is gone')
  await mounted.unmount()
  panel = undefined
})

test('the healthy check scenario shows the ticket row on Overview and Execution', async () => {
  panel = await mount(panelModule, { host: mockHost({ requests: check.healthy.requests }), locale: 'en' })
  assert.ok(panel.find({ text: /Fix the login redirect/ }), 'Overview shows it as another ticket')
  await panel.select({ type: 'Tabs' }, 'execution')
  assert.ok(panel.find({ text: /Fix the login redirect/ }), 'Execution shows the same row')
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
  assert.ok(panel.find({ text: /Fix the login redirect/ }))
  await panel.unmount()
  panel = undefined
})

test('the worker read model turns a real ticket into its Execution row', () => {
  const at = '2026-11-07T03:26:00.000Z'
  const base: Ticket = {
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
    assignments: [{ id: 'a-1', state: 'running', createdAt: at, startedAt: at, terminalId: 'term_1' }],
    inputs: [],
    undelivered: [],
    createdAt: at,
    updatedAt: at,
    origin: { triggerId: 'trigger-1', triggerIds: ['trigger-1'] }
  }
  const source = createRefreshableStateSource({
    tickets: () => [
      base,
      {
        ...base,
        id: 'ticket-2',
        title: 'Ship the payroll export',
        updatedAt: at,
        ended: { at, by: 'executor', outcome: 'completed' }
      }
    ],
    activity: () => ({ received: 1, evaluated: 1, accepted: 1, ignored: 0, ended: 1 }),
    load: () => ({ running: 1, maxWorkers: 2, humanSlot: 'free' }),
    hasError: () => false,
    setupMissing: () => false,
    paused: () => false
  })
  const state = source.refresh()
  assert.deepEqual(state.tickets?.map((ticket) => [ticket.title, ticket.stage, ticket.outcome]), [
    ['Fix the login redirect', 'working', undefined],
    ['Ship the payroll export', 'ended', 'completed']
  ])
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
    source.snapshot().problems.map((row) => row.kind),
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

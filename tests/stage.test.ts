// Ticket stage 表逐行（§E.8）：上游七行 + Orca 新增的 agent 状态维度。第一行命中即止。
//
// 表的三列来自设计文档 §E.8 的「Orca 条件」与「面板标签」两列；本文件按行断言 stage
// 与标签。agent 状态这一维只在它被写进条件的那两行（person/blocked·failed 与 idle）
// 起作用，且按 §E.8 的集合成员严格判定：`null`/未观察到不满足条件，落到下一行。
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { stageLabel, ticketStage } from '../src/worker/core/index.ts'
import type { AgentState, Assignment, ReportState, Ticket } from '../src/worker/core/index.ts'

/** 一个运行中的 Assignment。 */
const assignment = (overrides: Partial<Assignment> = {}): Assignment => ({
  id: 'a',
  state: 'running',
  createdAt: '2026-09-23T00:00:00.000Z',
  ...overrides
})
/** 带一份报告的 Assignment。 */
const reported = (state: ReportState, overrides: Partial<Assignment> = {}): Assignment =>
  assignment({ report: { state, summary: '', at: '2026-09-23T00:00:00.000Z' }, ...overrides })
/** 时刻较早的报告（人后来的消息要比它晚才解除阻塞）。 */
const reportedAt = (state: ReportState, at: string): Assignment =>
  assignment({ report: { state, summary: '', at } })

/** 一张最小 Ticket；每个用例只覆盖它关心的字段。 */
const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: 't',
  title: 'x',
  decisionId: 'd',
  mandate: {
    strength: 'explicit',
    policyVersion: 'v1',
    basis: { via: 'addressed', addressed: 'mention' },
    actor: { source: 'chat', id: 'alice' },
    scope: 'small'
  },
  channels: [],
  assignments: [assignment()],
  inputs: [],
  undelivered: [],
  createdAt: '2026-09-23T00:00:00.000Z',
  updatedAt: '2026-09-23T00:00:00.000Z',
  origin: { triggerId: 'x', triggerIds: ['x'] },
  ...overrides
})

/** 一条等人回答的 Attention。 */
const attention = { id: 'q', question: '?', at: '2026-09-23T00:00:00.000Z' }
/** 报告之后到达的一条人的消息（解除 blocked/failed 的等待）。 */
const answered = {
  inputs: [
    {
      id: 'i',
      kind: 'trigger' as const,
      triggerId: 'e',
      at: '2026-09-23T01:00:00.000Z',
      human: true as const
    }
  ]
}
/** 一个已结束的 Ticket。 */
const ended = {
  at: '2026-09-23T00:00:00.000Z',
  by: 'executor' as const,
  outcome: 'completed' as const
}

/** 表的一行：名字、Ticket、可选的 agent 状态（`null` = 尚未观察到）、期望的 stage 与面板标签。 */
interface Row {
  name: string
  ticket: Ticket
  agentState?: AgentState | null
  stage: ReturnType<typeof ticketStage>
  label: ReturnType<typeof stageLabel>
}

const ROWS: readonly Row[] = [
  // --- person / delivery：Input 投递失败 ---
  {
    name: 'an undelivered Input',
    ticket: ticket({ delivery: { error: 'offline', at: '' } }),
    stage: { stage: 'person', action: 'delivery' },
    label: 'delivery'
  },
  {
    name: 'delivery before answer and review',
    ticket: ticket({ delivery: { error: 'offline', at: '' }, attention, assignments: [reported('ready')] }),
    stage: { stage: 'person', action: 'delivery' },
    label: 'delivery'
  },
  // --- person / answer：有 Attention（含终端来源） ---
  { name: 'an Attention', ticket: ticket({ attention }), stage: { stage: 'person', action: 'answer' }, label: 'answer' },
  {
    name: 'a terminal Attention',
    ticket: ticket({ attention: { ...attention, via: 'terminal' } }),
    stage: { stage: 'person', action: 'answer' },
    label: 'answer'
  },
  {
    name: 'answer before review',
    ticket: ticket({ attention, assignments: [reported('ready')] }),
    stage: { stage: 'person', action: 'answer' },
    label: 'answer'
  },
  {
    name: 'answer before a failure',
    ticket: ticket({ attention, assignments: [reported('failed')] }),
    stage: { stage: 'person', action: 'answer' },
    label: 'answer'
  },
  // --- person / review：最近 Report 是 ready ---
  {
    name: 'a ready Report',
    ticket: ticket({ assignments: [reported('ready')] }),
    stage: { stage: 'person', action: 'review' },
    label: 'review'
  },
  {
    name: 'a ready Report of an ended Assignment',
    ticket: ticket({ assignments: [reported('ready', { state: 'ended' })] }),
    stage: { stage: 'person', action: 'review' },
    label: 'review'
  },
  {
    name: 'a ready Report while the agent still works',
    ticket: ticket({ assignments: [reported('ready')] }),
    agentState: 'working',
    stage: { stage: 'person', action: 'review' },
    label: 'review'
  },
  // --- person / blocked・failed：报告已停且 agentState ∈ {blocked, done} ---
  {
    name: 'a blocked Report with a null agent state',
    ticket: ticket({ assignments: [reported('blocked')] }),
    agentState: null,
    stage: { stage: 'working' },
    label: 'working'
  },
  {
    name: 'a failed Report with a null agent state',
    ticket: ticket({ assignments: [reported('failed')] }),
    agentState: null,
    stage: { stage: 'working' },
    label: 'working'
  },
  {
    name: 'a blocked Report while the agent is blocked',
    ticket: ticket({ assignments: [reported('blocked')] }),
    agentState: 'blocked',
    stage: { stage: 'person', action: 'blocked' },
    label: 'blocked'
  },
  {
    name: 'a blocked Report the agent already ended',
    ticket: ticket({ assignments: [reported('blocked')] }),
    agentState: 'done',
    stage: { stage: 'person', action: 'blocked' },
    label: 'blocked'
  },
  {
    name: 'a failed Report whose agent stopped',
    ticket: ticket({ assignments: [reported('failed')] }),
    agentState: 'done',
    stage: { stage: 'person', action: 'failed' },
    label: 'failed'
  },
  {
    name: 'a blocked Report while the agent works on the answer',
    ticket: ticket({ assignments: [reported('blocked')] }),
    agentState: 'working',
    stage: { stage: 'working' },
    label: 'working'
  },
  {
    name: 'a blocked Report while the agent waits with nothing to do',
    ticket: ticket({ assignments: [reported('blocked')] }),
    agentState: 'waiting',
    stage: { stage: 'working' },
    label: 'working'
  },
  {
    name: 'a blocked Report a person answered since',
    ticket: ticket({ ...answered, assignments: [reportedAt('blocked', '2026-09-23T00:30:00.000Z')] }),
    stage: { stage: 'working' },
    label: 'working'
  },
  // --- working / queued：无 Assignment 或 pending ---
  {
    name: 'no Assignment',
    ticket: ticket({ assignments: [] }),
    stage: { stage: 'working', action: 'queued' },
    label: 'queued'
  },
  {
    name: 'a pending Assignment',
    ticket: ticket({
      assignments: [reported('failed', { state: 'ended' }), assignment({ state: 'pending' })]
    }),
    stage: { stage: 'working', action: 'queued' },
    label: 'queued'
  },
  {
    name: 'a pending Assignment after an interruption',
    ticket: ticket({ assignments: [assignment({ state: 'ended', endedReason: 'hostRestarted' }), assignment({ state: 'pending' })] }),
    agentState: 'done',
    stage: { stage: 'working', action: 'queued' },
    label: 'queued'
  },
  // --- idle：Report 是 waiting 或 Assignment 已结束，且 agentState ∈ {waiting, done} ---
  {
    name: 'a waiting Report with a null agent state',
    ticket: ticket({ assignments: [reported('waiting')] }),
    agentState: null,
    stage: { stage: 'working' },
    label: 'working'
  },
  {
    name: 'an ended Assignment with a null agent state',
    ticket: ticket({ assignments: [assignment({ state: 'ended' })] }),
    agentState: null,
    stage: { stage: 'working' },
    label: 'working'
  },
  {
    name: 'a waiting Report while the agent waits',
    ticket: ticket({ assignments: [reported('waiting')] }),
    agentState: 'waiting',
    stage: { stage: 'idle' },
    label: 'idle'
  },
  {
    name: 'a waiting Report whose agent already ended',
    ticket: ticket({ assignments: [reported('waiting')] }),
    agentState: 'done',
    stage: { stage: 'idle' },
    label: 'idle'
  },
  {
    name: 'a waiting Report whose agent works again in the background',
    ticket: ticket({ assignments: [reported('waiting')] }),
    agentState: 'working',
    stage: { stage: 'working' },
    label: 'working'
  },
  {
    name: 'a waiting Report whose agent is blocked on its terminal',
    ticket: ticket({ assignments: [reported('waiting')] }),
    agentState: 'blocked',
    stage: { stage: 'working' },
    label: 'working'
  },
  // --- working：其余 ---
  {
    name: 'a running Assignment',
    ticket: ticket(),
    stage: { stage: 'working' },
    label: 'working'
  },
  {
    name: 'a progress Report',
    ticket: ticket({ assignments: [reported('progress')] }),
    stage: { stage: 'working' },
    label: 'working'
  },
  {
    name: 'a running Assignment whose agent is working',
    ticket: ticket(),
    agentState: 'working',
    stage: { stage: 'working' },
    label: 'working'
  },
  // --- ended：已结束的 Ticket 不参与 stage 标签 ---
  {
    name: 'an ended Ticket',
    ticket: ticket({ ended, attention, assignments: [reported('failed')] }),
    stage: { stage: 'ended' },
    label: undefined
  }
]

describe('ticketStage', () => {
  for (const row of ROWS) {
    test(row.name, () => {
      const stage = ticketStage(row.ticket, row.agentState)
      assert.deepEqual(stage, row.stage)
      assert.equal(stageLabel(stage), row.label)
    })
  }

  test('covers the eight panel labels of the stage table', () => {
    // 票面要求逐行覆盖八个标签（blocked 与 failed 各占一档）；少一个就说明表里漏了一行。
    const labels = new Set(ROWS.map((row) => row.label).filter((label) => label !== undefined))
    assert.deepEqual([...labels].sort(), [
      'answer',
      'blocked',
      'delivery',
      'failed',
      'idle',
      'queued',
      'review',
      'working'
    ])
  })

  test('an unobserved agent state never satisfies either set-membership condition', () => {
    // §E.8 写的是 `agentState ∈ {…}`：未观察到（省略或 null）不在集合里，那两行都不命中，
    // 按表落到 working——与 `working` 状态的走法一致。
    const blocked = ticket({ assignments: [reported('blocked')] })
    const waiting = ticket({ assignments: [reported('waiting')] })
    for (const state of [undefined, null] as const) {
      assert.deepEqual(ticketStage(blocked, state), { stage: 'working' })
      assert.deepEqual(ticketStage(waiting, state), { stage: 'working' })
    }
  })
})

// Router 的两条命令：`eval-decide`（评估 → Decision）与 `route`（1–20 条批量路由）。
//
// 接缝是 `app/assessment.ts` 的 `createRouterTools()`：它拿领域命令的端口（candidate / decide /
// attach / policy），返回 HTTP 与 CLI 共用的同一份行为。这里用真 `Engine` + 内存仓储驱动，
// 只看命令的返回值、Decision、Ticket 与执行器的启动请求（§P.1：不 mock 内部层）。
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  Engine,
  MemoryRepositories
} from '../src/worker/core/index.ts'
import type { AcceptMode, Candidate, Policy, Trigger } from '../src/worker/core/index.ts'
import { createRouterTools } from '../src/worker/app/assessment'
import type { RouterTools } from '../src/worker/app/assessment'

/** 固定的测试时刻。 */
const AT = '2026-11-07T00:00:00.000Z'

const RULES = [
  { id: 'copy', name: 'Copy fixes', instruction: { zh: '改错别字', en: 'Fix typos' }, enabled: true }
]

/** 一条测试 Trigger：`alice` 是显式，其他人都按推断候选（夹具的 Gate 如此）。 */
function trigger(id: string, overrides: Partial<Trigger> = {}): Trigger {
  return {
    id,
    source: 'chat',
    threads: [{ source: 'chat', id: 't1' }],
    actor: { source: 'chat', id: 'alice' },
    human: true,
    at: AT,
    text: `message ${id}`,
    channel: { source: 'chat', thread: 't1', address: { message: id } },
    meta: {},
    ...overrides
  }
}

/** 一份通过完整性检查的评估；用例只改它的一两处。 */
function assessment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decision: 'accept',
    direction: {
      implementation_requested: true,
      target_basis: 'specified',
      requires_design_decision: false,
      evidence: 'the message names the typo'
    },
    rule_assessments: [{ rule_id: 'copy', matched: true, reason: 'it is a typo' }],
    title: 'Fix the typo',
    scope: 'one typo',
    reason: 'asked for a typo fix',
    intent_evidence: 'please fix the typo',
    worktree_name: 'fix-typo',
    ...overrides
  }
}

/** 真引擎 + 内存仓储 + 本票的命令服务；`launches` 记录执行器收到的启动请求。 */
function harness(options: { acceptMode?: AcceptMode; version?: string } = {}) {
  const opened = new MemoryRepositories()
  const repo = opened.claimWriter()
  const requests: Candidate[] = []
  const launches: string[] = []
  let version = options.version ?? 'policy-1'
  let acceptMode = options.acceptMode ?? 'auto'
  const policy: Policy = {
    get version() {
      return version
    },
    get paused() {
      return false
    },
    evalTimeoutMs: 60_000,
    gate: (t) =>
      t.actor.id === 'alice'
        ? { admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'mention' } }
        : { admissible: true, strength: 'inferred', basis: { via: 'followup' } },
    revalidate: () => true,
    admitsInferred: (matched) => matched.length > 0
  }
  const engine = new Engine({
    repo,
    scope: { scope: () => ({ listened: true, observed: false }) },
    policy: () => policy,
    assessor: {
      request: (candidate: Candidate) => {
        requests.push(candidate)
      }
    },
    executor: {
      start: (ticket) => {
        launches.push(ticket.id)
      },
      deliver: () => undefined,
      stop: () => undefined
    },
    outbox: { send: () => undefined, status: () => undefined, withdraw: () => undefined },
    now: () => AT
  })
  const tools: RouterTools = createRouterTools({
    candidate: (triggerId) => engine.candidate(triggerId),
    policy: () => ({ acceptMode, rules: RULES }),
    policyVersion: () => version,
    decide: (triggerId, outcome) => engine.decide(triggerId, outcome),
    attach: (ticketId, triggerId, note) => engine.attach(ticketId, triggerId, note),
    ticketOf: (id) => repo.tickets.get(id)
  })
  return {
    engine,
    repo,
    requests,
    launches,
    tools,
    setVersion: (value: string) => {
      version = value
    },
    setMode: (value: AcceptMode) => {
      acceptMode = value
    }
  }
}

/** 收一条 Trigger 并跑到 Eval：返回候选。 */
function candidateOf(h: ReturnType<typeof harness>, id = '1', overrides: Partial<Trigger> = {}): Candidate {
  h.engine.receive(trigger(id, overrides))
  h.engine.evaluateDue()
  const candidate = h.requests.at(-1)
  assert.notEqual(candidate, undefined, 'the trigger reached an evaluation')
  return candidate as Candidate
}

describe('eval-decide', () => {
  test('an assessment decides the open evaluation, exactly once', () => {
    const h = harness({ acceptMode: 'auto' })
    candidateOf(h)
    const result = h.tools.decide('1', assessment())
    assert.equal(result.ok, true, JSON.stringify(result))
    if (result.ok) {
      assert.equal(result.decision, 'accept')
      assert.equal(result.ticket?.title, 'Fix the typo')
      assert.equal(typeof result.reason, 'string')
    }
    const [ticket] = h.repo.tickets.list()
    assert.notEqual(ticket, undefined)
    assert.deepEqual(ticket?.mandate.basis.rules, ['copy'])
    assert.deepEqual(h.launches, [ticket?.id], 'the accept enqueued one launch')

    // 同一条 Trigger 再评估：Eval 已结束，固定拒绝。
    const again = h.tools.decide('1', assessment())
    assert.equal(again.ok, false)
    if (!again.ok) assert.equal(again.code, 'too_late')
  })

  test('observe records would-accept for the open evaluation, without a ticket (R6)', () => {
    const h = harness({ acceptMode: 'observe' })
    // 推断候选才是 accept mode 的对象；显式候选不受 mode 约束。
    candidateOf(h, '1', { actor: { source: 'chat', id: 'guest' } })
    const result = h.tools.decide('1', assessment())
    assert.equal(result.ok, true, JSON.stringify(result))
    if (result.ok) assert.equal(result.decision, 'ignore')
    assert.deepEqual(h.repo.tickets.list(), [])
    assert.deepEqual(h.launches, [])
    const [decision] = h.repo.decisions.byThread('chat:t1')
    assert.equal(decision?.kind, 'ignore')
    assert.equal(decision?.audit?.['would_accept'], true)
  })

  test('a policy change during assessment is policy_changed and writes no Decision', () => {
    const h = harness({ acceptMode: 'auto', version: 'policy-1' })
    candidateOf(h)
    h.setVersion('policy-2')
    const result = h.tools.decide('1', assessment())
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, 'policy_changed')
    assert.deepEqual(h.repo.decisions.byThread('chat:t1'), [])
    assert.deepEqual(h.repo.tickets.list(), [])
  })

  test('an invalid or incomplete assessment refuses with a fixed code and writes no Decision', () => {
    const h = harness({ acceptMode: 'auto' })
    candidateOf(h)
    const invalid = h.tools.decide('1', assessment({ direction: { evidence: 'x' } }))
    assert.equal(invalid.ok, false)
    if (!invalid.ok) assert.equal(invalid.code, 'invalid_assessment')
    const incomplete = h.tools.decide('1', assessment({ rule_assessments: [] }))
    assert.equal(incomplete.ok, false)
    if (!incomplete.ok) assert.equal(incomplete.code, 'incomplete_rules')
    assert.deepEqual(h.repo.decisions.byThread('chat:t1'), [], 'no Decision for a refused assessment')
    // 拒绝不消耗 Eval：改正后同一次评估仍可决定。
    const fixed = h.tools.decide('1', assessment())
    assert.equal(fixed.ok, true, JSON.stringify(fixed))
  })

  test('a trigger no evaluation holds is too_late', () => {
    const h = harness()
    h.engine.receive(trigger('1'))
    // 还没跑 Eval：候选未产生。
    const result = h.tools.decide('1', assessment())
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, 'too_late')
  })
})

describe('route', () => {
  test('runs 1-20 items in input order and answers each on its own', () => {
    const h = harness({ acceptMode: 'auto' })
    candidateOf(h, '1')
    candidateOf(h, '2')
    const result = h.tools.route([
      { kind: 'accept', trigger_id: '1', title: 'Fix the typo', worktree_name: 'fix-typo', acknowledgement: 'On it' },
      // 中间一条被拒：缺 ignore 的 reason。
      { kind: 'ignore', trigger_id: '2' }
    ])
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok) return
    assert.deepEqual(result.results.map((item) => item.trigger_id), ['1', '2'])
    assert.equal(result.results[0]?.decision, 'accept')
    assert.equal(result.results[1]?.refused !== undefined, true)
    assert.deepEqual(h.repo.tickets.list().map((ticket) => ticket.title), ['Fix the typo'])
  })

  test('a refused item leaves the others alone', () => {
    const h = harness({ acceptMode: 'auto' })
    for (const id of ['1', '2', '3']) candidateOf(h, id)
    const result = h.tools.route([
      { kind: 'accept', trigger_id: '2', title: 'Second', worktree_name: 'second', acknowledgement: 'On it' },
      { kind: 'stop', trigger_id: '3' },
      { kind: 'accept', trigger_id: '99', title: 'Missing', worktree_name: 'missing', acknowledgement: 'On it' }
    ])
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok) return
    assert.deepEqual(result.results.map((item) => item.kind), ['accept', 'stop', 'accept'])
    assert.equal(result.results[0]?.decision, 'accept')
    assert.notEqual(result.results[1]?.refused, undefined, 'stop without a ticket is refused alone')
    assert.notEqual(result.results[2]?.refused, undefined, 'an unknown trigger is refused alone')
    assert.equal(h.repo.tickets.list().length, 1, 'the accepted item still created its ticket')
  })

  test('exactly 20 items is still allowed, and each is answered in order', () => {
    const h = harness()
    const items = Array.from({ length: 20 }, (_, index) => ({
      kind: 'ignore',
      trigger_id: `t-${index + 1}`,
      reason: 'chatter'
    }))
    const result = h.tools.route(items)
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok) return
    assert.equal(result.results.length, 20)
    assert.deepEqual(
      result.results.map((item) => item.trigger_id),
      items.map((item) => item.trigger_id)
    )
    // 20 条都指向不存在的 Trigger：逐条拒绝（refused_item），但不拖累同批的其余条目。
    assert.equal(result.results.every((item) => item.refused !== undefined), true)
  })

  test('more than 20 items is a fixed too_many_items, and nothing runs', () => {
    const h = harness()
    const items = Array.from({ length: 21 }, (_, index) => ({
      kind: 'ignore',
      trigger_id: `t-${index + 1}`,
      reason: 'chatter'
    }))
    const result = h.tools.route(items)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, 'too_many_items')
      assert.equal(result.values?.['limit'], '20')
    }
    assert.deepEqual(h.repo.decisions.byThread('chat:t1'), [])
  })

  test('the batch is refused when it is not an array or is empty', () => {
    const h = harness()
    for (const value of [undefined, {}, [], 'accept']) {
      const result = h.tools.route(value)
      assert.equal(result.ok, false, JSON.stringify(value))
      if (!result.ok) assert.equal(result.code, 'invalid_params')
    }
  })

  test('an inferred candidate cannot be accepted through route; the item is refused with the engine reason', () => {
    const h = harness({ acceptMode: 'auto' })
    candidateOf(h, '2', { actor: { source: 'chat', id: 'guest' } })
    const result = h.tools.route([
      { kind: 'accept', trigger_id: '2', title: 'Proactive', worktree_name: 'proactive', acknowledgement: 'On it' }
    ])
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok) return
    assert.equal(result.results[0]?.decision, undefined)
    assert.equal(result.results[0]?.refused?.includes('explicit'), true, result.results[0]?.refused)
    assert.equal(h.repo.tickets.list().length, 0)
  })

  test('a trigger an earlier item decided cannot be ignored again in the same call', () => {
    const h = harness({ acceptMode: 'auto' })
    candidateOf(h, '1')
    const result = h.tools.route([
      { kind: 'accept', trigger_id: '1', title: 'Fix', worktree_name: 'fix', acknowledgement: 'On it' },
      { kind: 'ignore', trigger_id: '1', reason: 'duplicate' }
    ])
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok) return
    assert.notEqual(result.results[1]?.refused, undefined)
    assert.equal(result.results[1]?.decision, undefined)
  })
})

describe('the route item shape', () => {
  test('each kind reads only its own fields and needs the documented ones', () => {
    const h = harness()
    const items = [
      { kind: 'nope', trigger_id: '1' },
      { trigger_id: '1' },
      { kind: 'accept', trigger_id: '1', title: 'Fix' },
      { kind: 'attach', trigger_id: '1' },
      { kind: 'stop', trigger_id: '1', ticket_id: 'ticket-9', reason: 'stop it' },
      { kind: 'ignore', trigger_id: '1', reason: 'chatter', surprise: true },
      'not an item'
    ]
    const result = h.tools.route(items)
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok) return
    assert.deepEqual(
      result.results.map((item) => item.refused !== undefined),
      [true, true, true, true, true, true, true]
    )
    // 形状错误也按输入顺序回填 kind/trigger_id（缺失时为空串），不丢项。
    assert.deepEqual(result.results.map((item) => item.kind), ['nope', '', 'accept', 'attach', 'stop', 'ignore', ''])
  })
})

describe('the engine still owns the mandate', () => {
  test('an attach to a ticket that does not exist is the engine refusal, not a crash', () => {
    const h = harness()
    candidateOf(h, '1')
    const result = h.tools.route([{ kind: 'attach', trigger_id: '1', ticket_id: 'ticket-404' }])
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok) return
    assert.ok((result.results[0]?.refused ?? '').length > 0)
    assert.equal(result.results[0]?.decision, undefined)
    assert.deepEqual(h.repo.tickets.list(), [])
  })
})

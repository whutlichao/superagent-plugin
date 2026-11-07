// 领域引擎的行为（§P.2 的 `core-engine` 套件）：收 Trigger、同 Trigger 只接一次、产生
// Decision、accept 建 Ticket 与 Mandate、Report 驱动状态迁移、已结束 Ticket 不再接。
//
// 全部跑在 `core/memory.ts` 的内存仓储上，不碰 SQLite、不碰 Orca（§P.1 其三、§P.6）。
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  Engine,
  key,
  MemoryRepositories,
  runningAssignment,
  ticketStage,
  UserError
} from '../src/worker/core/index.ts'
import { assessmentOutcome } from '../src/worker/policy/index.ts'
import type {
  Assignment,
  Candidate,
  Executor,
  Outbox,
  Policy,
  ReplyStatus,
  Ticket,
  Trigger
} from '../src/worker/core/index.ts'

/** 一个用于测试提示的浅比较：判断 `pattern` 的每个字段都与 `value` 相等（数组按长度与元素）。 */
function matches(value: unknown, pattern: unknown): boolean {
  if (pattern instanceof RegExp) return typeof value === 'string' && pattern.test(value)
  if (pattern === null || typeof pattern !== 'object') return Object.is(value, pattern)
  if (Array.isArray(pattern)) {
    return (
      Array.isArray(value) &&
      value.length === pattern.length &&
      pattern.every((item, index) => matches(value[index], item))
    )
  }
  if (value === null || typeof value !== 'object') return false
  return Object.entries(pattern).every(([name, item]) =>
    matches((value as Record<string, unknown>)[name], item)
  )
}

/** 断言 `value` 匹配 `pattern` 的字段（只比较给出的字段）。 */
function assertMatches(value: unknown, pattern: unknown, message?: string): void {
  assert.ok(matches(value, pattern), message ?? `expected ${JSON.stringify(value)} to match ${JSON.stringify(pattern)}`)
}

/** 一小段可读的已知真相：`trigger()` 生成的 id 与其时刻。 */
const member = { source: 'chat', id: 'alice' }
const guest = { source: 'chat', id: 'guest' }

/** 一条测试 Trigger：同一 id 即同一条；`at` 由 id 派生，保证时间序确定。 */
function trigger(id: string, overrides: Partial<Trigger> = {}): Trigger {
  return {
    id,
    source: 'chat',
    threads: [{ source: 'chat', id: 't1' }],
    actor: member,
    human: true,
    at: `2026-09-23T00:00:${id.padStart(2, '0')}Z`,
    text: `message ${id}`,
    channel: { source: 'chat', thread: 't1', address: { message: id } },
    meta: {},
    ...overrides
  }
}

/** 测试夹具：内存仓储 + 记录型端口 + 虚拟时钟。 */
function harness(policyOverrides: Partial<Policy> = {}) {
  const opened = new MemoryRepositories()
  const repo = opened.claimWriter()
  const outbox: Outbox['send'] extends (message: infer M) => void ? M[] : never = []
  const withdrawn: string[] = []
  const requests: Candidate[] = []
  const assessor = {
    request: (candidate: Candidate) => {
      requests.push(candidate)
    },
    release: (_evalId: string) => undefined
  }
  const launches: [Ticket, Assignment][] = []
  /** 执行器 start 的总调用数（`settle` 会消费 `launches`，计数另记）。 */
  let starts = 0
  const deliveries = new Set<string>()
  /** 执行器交给运行中 Assignment 的 Input，按 [ticket id, input id]。 */
  const delivered: [string, string][] = []
  const stopped: string[] = []
  const executor: Executor = {
    start: (ticket, assignment) => {
      starts += 1
      launches.push([ticket, assignment])
    },
    deliver: (ticket) => {
      deliveries.add(ticket.id)
    },
    stop: (_ticket, assignment) => {
      stopped.push(assignment.id)
    }
  }
  let version = 'v1'
  let paused = false
  const policy: Policy = {
    get version() {
      return version
    },
    get paused() {
      return paused
    },
    evalTimeoutMs: 60_000,
    gate: (t, thread) =>
      !t.human
        ? { admissible: false, reason: 'not human' }
        : t.actor.id === 'alice'
          ? { admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'mention' } }
          : thread.subscriptions.length
            ? { admissible: true, strength: 'inferred', basis: { via: 'followup' } }
            : { admissible: false, reason: 'not a member' },
    revalidate: () => version !== 'revoked',
    admitsInferred: (rules) => rules.length > 0,
    ...policyOverrides
  }
  let clock = 0
  const scope = {
    scope: (t: Trigger) =>
      t.meta.blocked ? { listened: false as const, reason: 'chat not allowed' } : { listened: true as const, observed: false }
  }
  const messages: { id: string; status: ReplyStatus }[] = []
  const queue: Outbox = {
    send: (message) => {
      if (!messages.some((item) => item.id === message.id)) messages.push({ id: message.id, status: 'pending' })
    },
    status: (id) => messages.find((item) => item.id === id)?.status,
    withdraw: (id) => {
      withdrawn.push(id)
    }
  }
  const engine = new Engine({
    repo,
    scope,
    policy: () => policy,
    assessor,
    executor,
    outbox: queue,
    now: () => new Date(Date.UTC(2026, 8, 23, 0, 0, clock)).toISOString()
  })
  /** 模拟执行器启动排队的 Assignment、投递等待中的 Input（`launch: false` 时都不做）。 */
  function settle({ launch = true } = {}): void {
    for (;;) {
      const next = launch ? launches.shift() : undefined
      if (next) {
        engine.assignmentStarted(next[0].id, next[1].id)
        continue
      }
      const first = deliveries.values().next()
      if (first.done) return
      const ticketId = first.value
      deliveries.delete(ticketId)
      const ticket = opened.tickets.get(ticketId)!
      const assignment = runningAssignment(ticket)
      if (ticket.ended || !assignment) continue
      for (const inputId of ticket.undelivered) {
        delivered.push([ticketId, inputId])
        engine.inputsDelivered(ticketId, assignment.id, [inputId])
      }
    }
  }
  const pump = (): void => {
    engine.evaluateDue()
    settle()
  }
  /** 模拟 worker 会话把已投递、还没读的 Trigger Input 取进某一步。 */
  const read = (ticketId: string): void => {
    engine.inputsRead(
      ticketId,
      opened.tickets.get(ticketId)!.inputs.flatMap((input) =>
        input.kind === 'trigger' && input.readAt === null ? [input.id] : []
      )
    )
  }
  const decide = (candidate: Candidate, outcome: Parameters<Engine['decide']>[1]) =>
    engine.decide(candidate.triggers[0]!.id, { ...outcome, evalId: candidate.evalId })
  return {
    opened,
    engine,
    messages,
    withdrawn,
    requests,
    assessor,
    executor,
    delivered,
    stopped,
    launches,
    get starts() {
      return starts
    },
    settle,
    pump,
    read,
    decide,
    setVersion: (value: string) => {
      version = value
    },
    setPaused: (value: boolean) => {
      paused = value
    },
    tick: (seconds: number) => {
      clock += seconds
    }
  }
}

/** 收一条 Trigger、跑一次 pass、accept、再跑一次投递。 */
function accepted(h: ReturnType<typeof harness>, id = '1', thread = 't1') {
  h.engine.receive(trigger(id, { threads: [{ source: 'chat', id: thread }] }))
  h.pump()
  const decision = h.decide(h.requests.at(-1)!, {
    kind: 'accept',
    title: 'Fix',
    scope: 'small',
    reason: 'requested',
    acknowledgement: 'ok'
  })
  h.settle()
  return decision
}

describe('intake', () => {
  test('stores a trigger once and records source filtering', () => {
    const h = harness()
    assert.equal(h.engine.receive(trigger('1')), 'stored')
    // 同一条只接一次：第一次就存下的 id 第二次是 duplicate（§D.1 幂等）。
    assert.equal(h.engine.receive(trigger('1')), 'duplicate')
    assert.equal(h.engine.receive(trigger('2', { meta: { blocked: true } })), 'filtered')
    assert.deepEqual(h.opened.triggers.disposition('2')?.filtered, { code: 'chat not allowed' })
    assert.deepEqual(h.opened.threads.get('chat:t1')?.pending, ['1'])
  })

  test('records correlation for a trigger on several threads and evaluates only on the primary one', () => {
    const h = harness()
    h.engine.receive(trigger('1', { threads: [{ source: 'gh', id: 'pr-7' }, { source: 'gh', id: 'run-9' }] }))
    assertMatches(h.opened.threads.get('gh:pr-7'), { pending: ['1'], correlated: ['gh:run-9'] })
    assertMatches(h.opened.threads.get('gh:run-9'), { pending: [], correlated: ['gh:pr-7'] })
    // Correlation 只加语境不改路由：Eval 只跑在 primary thread 上。
    h.pump()
    assert.deepEqual(h.requests.map((candidate) => candidate.thread.key), ['gh:pr-7'])
  })

  test('normalizes source timestamps so text comparison is time comparison', () => {
    const h = harness()
    h.engine.receive(trigger('1', { at: '2026-09-23T00:00:01Z' }))
    assert.equal(h.opened.triggers.get('1')?.at, '2026-09-23T00:00:01.000Z')
  })
})

describe('eval', () => {
  test('ignores at the gate without an assessor when nothing is admissible', () => {
    const h = harness()
    h.engine.receive(trigger('1', { human: false }))
    h.pump()
    assert.equal(h.requests.length, 0)
    assertMatches(h.opened.decisions.byThread('chat:t1'), [
      { kind: 'ignore', triggerIds: ['1'], reason: [{ code: 'not human', triggerId: '1' }] }
    ])
    assert.ok(h.opened.triggers.disposition('1')?.decisionId)
  })

  test('serializes evals per thread and debounces triggers that arrive meanwhile', () => {
    const h = harness()
    h.engine.receive(trigger('1'))
    h.pump()
    h.engine.receive(trigger('2'))
    h.engine.receive(trigger('3'))
    h.pump()
    // 一个 Thread 同时只有一次 Eval；期间到达的 Trigger 合成下一批。
    assert.equal(h.requests.length, 1)
    assert.deepEqual(h.opened.threads.get('chat:t1')?.pending, ['2', '3'])
    h.decide(h.requests[0]!, { kind: 'ignore', reason: 'chatter' })
    h.pump()
    assert.deepEqual(h.requests[1]!.triggers.map((item) => item.id), ['2', '3'])
    assert.equal(h.requests[1]!.strength, 'explicit')
  })

  test('accepts a proactive candidate once, with its matched rules in the mandate (§K.4)', () => {
    // 一个把名单外的人判成推断候选的 Gate：本用例只看「评估 → 接受」这一段，
    // 人与 Ticket 的归属（follow-up）由 `subscription fan-out` 套件覆盖。
    const h = harness({
      gate: (t) =>
        t.actor.id === 'alice'
          ? { admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'mention' } }
          : { admissible: true, strength: 'inferred', basis: { via: 'followup' } }
    })
    h.engine.receive(trigger('2', { actor: guest }))
    h.pump()
    const candidate = h.requests.at(-1)!
    assert.equal(candidate.strength, 'inferred')
    const rules = [
      { id: 'copy', name: 'Copy fixes', instruction: { zh: '改错别字', en: 'Fix typos' }, enabled: true }
    ]
    const result = assessmentOutcome(
      {
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
        reason: 'asked',
        intent_evidence: 'please fix the typo',
        worktree_name: 'fix-typo'
      },
      { acceptMode: 'auto', rules },
      candidate.strength
    )
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok) return
    const decision = h.decide(candidate, result.outcome)
    h.settle()
    assert.equal(decision.kind, 'accept')
    const proactive = h.opened.tickets.get(decision.ticketId!)!
    assert.deepEqual(proactive.mandate.basis.rules, ['copy'])
    assert.equal(proactive.mandate.strength, 'inferred')
    assert.equal(proactive.mandate.scope, 'one typo')
    assert.equal(h.opened.tickets.list().length, 1)
    assert.equal(h.starts, 1, 'the accepted ticket asked the executor for an assignment')

    // 同一条 Trigger 再决定一次：幂等，不建第二张 Ticket。
    const replay = h.engine.decide('2', result.outcome)
    assert.equal(replay.id, decision.id)
    assert.equal(h.opened.tickets.list().length, 1)
  })

  test('accept creates a ticket with a mandate, subscribes the thread, queues the acknowledgement and starts an assignment', () => {
    const h = harness()
    const decision = accepted(h)
    const ticket = h.opened.tickets.get(decision.ticketId!)!
    assertMatches(ticket, {
      title: 'Fix',
      mandate: {
        strength: 'explicit',
        policyVersion: 'v1',
        basis: { via: 'addressed', addressed: 'mention' },
        actor: member,
        scope: 'small'
      },
      origin: { triggerId: '1', triggerIds: ['1'] }
    })
    assert.equal(ticket.ended, undefined)
    assertMatches(ticket.assignments, [{ state: 'running' }])
    assert.deepEqual(h.opened.threads.get('chat:t1')?.subscriptions, [ticket.id])
    assert.deepEqual(h.messages, [{ id: key('ack', '1'), status: 'pending' }])
    assert.equal(h.starts, 1)
  })

  test('records an accept with its ticket, subscriptions and acknowledgement together, or none of them', async () => {
    const opened = new MemoryRepositories()
    const repo = opened.claimWriter()
    const requests: Candidate[] = []
    const messages: { id: string }[] = []
    const engine = new Engine({
      repo,
      scope: { scope: () => ({ listened: true, observed: false }) },
      policy: () => ({
        version: 'v1',
        paused: false,
        evalTimeoutMs: 60_000,
        gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'mention' } }),
        revalidate: () => true,
        admitsInferred: () => true
      }),
      assessor: { request: (candidate) => requests.push(candidate) },
      executor: { start: () => undefined, deliver: () => undefined, stop: () => undefined },
      outbox: {
        send: (message) => {
          messages.push({ id: message.id })
        },
        status: () => undefined,
        withdraw: () => undefined
      },
      // 执行器建目录失败时必须整体回滚：Decision、Ticket、确认一个都不留。
      prepareTicket: () => {
        throw new Error('No directory for the ticket')
      },
      now: () => '2026-09-23T00:00:00.000Z'
    })
    engine.receive(trigger('1'))
    engine.evaluateDue()
    const evalId = requests[0]!.evalId
    assert.throws(
      () =>
        engine.decide('1', {
          evalId,
          kind: 'accept',
          title: 'Fix',
          scope: 'small',
          reason: 'requested',
          acknowledgement: 'ok'
        }),
      /No directory/
    )
    assert.deepEqual(opened.decisions.byThread('chat:t1'), [])
    assert.deepEqual(opened.tickets.list(), [])
    assertMatches(opened.threads.get('chat:t1'), { evaluating: { id: evalId }, subscriptions: [] })
    assert.deepEqual(messages, [])
  })

  test('refuses to decide an eval that a later eval replaced, and decides the later one', () => {
    const h = harness()
    h.engine.receive(trigger('1'))
    h.pump()
    const first = h.requests[0]!
    h.setVersion('v2')
    h.engine.policyChanged('v1', 'v2')
    h.pump()
    const second = h.requests[1]!
    assert.throws(
      () => h.decide(first, { kind: 'ignore', reason: 'chatter' }),
      (error: unknown) => error instanceof UserError && error.code === 'evalFinished'
    )
    assert.equal(h.decide(second, { kind: 'ignore', reason: 'chatter' }).kind, 'ignore')
  })

  test('accepts the same trigger once: a replay returns the first Decision and starts no second ticket', () => {
    const h = harness()
    const decision = accepted(h)
    const tickets = h.opened.tickets.list().length
    const replay = h.engine.decide('1', {
      kind: 'accept',
      title: 'Again',
      scope: 'small',
      reason: 'replayed'
    })
    assert.equal(replay.id, decision.id)
    assert.equal(h.opened.tickets.list().length, tickets)
  })

  test('a mandate exists only on an accept: ignore, unavailable and stop carry none', () => {
    const h = harness()
    h.engine.receive(trigger('1'))
    h.pump()
    const ignored = h.decide(h.requests[0]!, { kind: 'ignore', reason: 'chatter' })
    assert.equal(ignored.mandate, undefined)
    assert.equal(ignored.ticketId, undefined)
    // stop 的 Decision 也不带 Mandate：它撤回而不是授予。
    const decision = accepted(h, '2', 't2')
    h.engine.receive(trigger('3', { threads: [{ source: 'chat', id: 't2' }] }))
    h.pump()
    const stopped = h.engine.decide('3', {
      kind: 'stop',
      ticketId: decision.ticketId!,
      reason: 'Human asked to stop'
    })
    assert.equal(stopped.kind, 'stop')
    assert.equal(stopped.mandate, undefined)
    assert.equal(stopped.ticketId, decision.ticketId)
  })

  test('records unavailable when the policy version changed during assessment', () => {
    const h = harness()
    h.engine.receive(trigger('1'))
    h.pump()
    h.setVersion('v2')
    const decision = h.decide(h.requests[0]!, { kind: 'accept', title: 'x', scope: 'x', reason: 'x' })
    assert.equal(decision.kind, 'unavailable')
    assertMatches(decision.reason, [{ code: 'policyChanged' }])
    assert.deepEqual(h.opened.tickets.list(), [])
  })

  test('counts an Eval deadline from its delivery and queues its triggers again twice before recording it unavailable', () => {
    const h = harness()
    h.engine.receive(trigger('1'))
    h.pump()
    // 候选还没送达 assessor 会话的 Eval 不会过期。
    h.tick(600)
    h.pump()
    assert.equal(h.engine.candidate('1')?.evalId, h.requests[0]!.evalId)
    const deliver = (): void => {
      h.engine.candidateDelivered(h.requests.at(-1)!.evalId)
    }
    deliver()
    h.tick(59)
    h.pump()
    assert.equal(h.requests.length, 1)
    // 过期不记 Decision，把 Trigger 重新排队，连续两次。
    h.tick(2)
    h.pump()
    assert.deepEqual(h.opened.decisions.byThread('chat:t1'), [])
    assert.deepEqual(
      h.requests.map((item) => item.triggers.map((each) => each.id)),
      [['1'], ['1']]
    )
    deliver()
    h.tick(61)
    h.pump()
    assert.equal(h.requests.length, 3)
    // 第三次过期记 unavailable。
    deliver()
    h.tick(61)
    h.pump()
    assertMatches(h.opened.decisions.byThread('chat:t1'), [
      { kind: 'unavailable', reason: [{ code: 'timeout' }] }
    ])
  })
})

describe('subscription fan-out', () => {
  test('delivers a person\'s later message on a subscribed thread to the live ticket as context, and not to Eval', () => {
    const h = harness()
    const decision = accepted(h)
    const requests = h.requests.length
    h.engine.receive(trigger('2', { actor: guest }))
    h.pump()
    const ticket = h.opened.tickets.get(decision.ticketId!)!
    assertMatches(ticket.inputs, [{ kind: 'trigger', triggerId: '2' }])
    assert.deepEqual(ticket.undelivered, [])
    assert.deepEqual(h.delivered, [[ticket.id, ticket.inputs[0]!.id]])
    assertMatches(h.opened.triggers.disposition('2'), { fanout: [ticket.id] })
    // 没有 Eval，所以没有 Decision、也没有超时，Thread 的队列留给新请求。
    assert.deepEqual([h.requests.length, h.opened.threads.get('chat:t1')!.pending, h.opened.decisions.byThread('chat:t1').length], [
      requests,
      [],
      1
    ])
    // bot 的消息在那里仍进 Eval，gate 不准入它。
    h.engine.receive(trigger('3', { human: false }))
    h.pump()
    const botDecision = h.opened.decisions
      .byThread('chat:t1')
      .find((item) => item.triggerIds.includes('3'))
    assertMatches(botDecision, { kind: 'ignore', triggerIds: ['3'] })
  })

  test('fans one message out to every live ticket on the thread, once per ticket', () => {
    const h = harness()
    const first = accepted(h).ticketId!
    // 第二张 Ticket 先从它自己的 Thread 开出来，再经 attach 订阅到 t1。
    const second = accepted(h, '2', 't2').ticketId!
    const routed = h.engine.attach(second, '1')
    assert.deepEqual(routed.inputs.filter((input) => input.kind === 'trigger').map((input) => input.kind), ['trigger'])
    assert.deepEqual(h.opened.threads.get('chat:t1')!.subscriptions, [first, second])
    h.tick(5)
    h.engine.receive(trigger('9', { actor: guest }))
    h.settle()
    for (const ticketId of [first, second]) {
      const ticket = h.opened.tickets.get(ticketId)!
      const inputs = ticket.inputs.filter((input) => input.kind === 'trigger' && input.triggerId === '9')
      assert.equal(inputs.length, 1, `${ticketId} receives it once`)
    }
  })

  test('fans a message out on every one of its threads, and a ticket subscribed to several of them still receives it once', () => {
    const h = harness()
    const first = accepted(h).ticketId!
    const second = accepted(h, '2', 't2').ticketId!
    const elsewhere = accepted(h, '3', 't3').ticketId!
    // 第二个 Ticket 也订阅 t1，第一个也订阅 t8：同一条消息经两个 Thread 到达第一个两次。
    h.engine.bindThread(second, { source: 'chat', id: 't1' }, false)
    h.engine.bindThread(first, { source: 'chat', id: 't8' }, false)
    h.tick(5)
    h.engine.receive(
      trigger('9', {
        actor: guest,
        threads: [
          { source: 'chat', id: 't1' },
          { source: 'chat', id: 't8' }
        ]
      })
    )
    h.settle()
    for (const ticketId of [first, second]) {
      const ticket = h.opened.tickets.get(ticketId)!
      assert.equal(
        ticket.inputs.filter((input) => input.kind === 'trigger' && input.triggerId === '9').length,
        1,
        `${ticketId} receives it once`
      )
      assert.equal(h.delivered.filter(([id]) => id === ticketId).length, 1)
    }
    // 去向里每个 Ticket 只出现一次；副 Thread 只加语境（correlated），不额外路由。
    assert.deepEqual(h.opened.triggers.disposition('9')?.fanout, [first, second])
    assert.equal(h.opened.triggers.disposition('9')?.context, undefined)
    assert.deepEqual(h.opened.threads.get('chat:t8')?.correlated, ['chat:t1'])
    assert.deepEqual(h.opened.tickets.get(elsewhere)!.inputs, [])
  })

  test('gives a message on a Thread a ticket follows only for context to that ticket as context, and routes it nowhere', () => {
    const h = harness()
    const owner = accepted(h).ticketId!
    const follower = accepted(h, '2', 't2').ticketId!
    assert.equal(h.engine.followForContext(follower, { source: 'chat', id: 't1' }), true)
    assert.equal(h.engine.followForContext(follower, { source: 'chat', id: 't1' }), false)
    const requests = h.requests.length
    const decisions = h.opened.decisions.byThread('chat:t1').length
    h.engine.receive(trigger('3', { actor: guest }))
    h.settle()
    // 只加语境：worker 的副本标 `context`，去向里也标出来——它不拥有这条消息。语境到达本身就是
    // 一条带 `context: true` 的 Input（§D.1、§K.3），不产生的是一条「路由给它」的 Input 与候选。
    assert.deepEqual(h.opened.triggers.disposition('3'), {
      fanout: [owner, follower],
      context: [follower],
      at: h.opened.triggers.disposition('3')!.at
    })
    assertMatches(h.opened.tickets.get(follower)!.inputs.at(-1), {
      kind: 'trigger',
      triggerId: '3',
      context: true
    })
    // 不路由：没有新候选、没有新 Decision、Thread 的队列空着，主 Session 也不能把它交给它。
    assert.equal(h.requests.length, requests)
    assert.equal(h.opened.decisions.byThread('chat:t1').length, decisions)
    assert.deepEqual(h.opened.threads.get('chat:t1')?.pending, [])
    assert.equal(h.engine.candidate('3'), undefined)
    assert.throws(
      () => h.engine.decide('3', { kind: 'accept', title: 'More', scope: 'small', reason: 'asked' }),
      (error: unknown) => error instanceof UserError && error.code === 'workerDecides'
    )
  })

  test('resumes no ticket from a Thread it follows only for context, so the message reaches Eval instead', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.followForContext(ticketId, { source: 'chat', id: 'issue' })
    h.engine.report(ticketId, { state: 'ready', summary: 'done' })
    assert.ok(h.opened.tickets.get(ticketId)!.ended)
    const decisions = h.opened.decisions.byThread('chat:issue').length
    h.engine.receive(trigger('2', { threads: [{ source: 'chat', id: 'issue' }] }))
    // 语境 Thread 不恢复已结束的 Ticket：没有第二条 Input，也没有投递。
    assert.ok(h.opened.tickets.get(ticketId)!.ended)
    assert.deepEqual(h.opened.tickets.get(ticketId)!.undelivered, [])
    assert.deepEqual(h.opened.triggers.disposition('2')?.fanout, [])
    assert.deepEqual(h.opened.triggers.disposition('2')?.context, undefined)
    // 没人决定它，于是它进 primary thread 的 Eval：候选只对着那条消息，Thread 还没被判。
    h.pump()
    assert.deepEqual(h.requests.at(-1)!.thread.key, 'chat:issue')
    assert.deepEqual(h.requests.at(-1)!.triggers.map((item) => item.id), ['2'])
    assert.equal(h.opened.decisions.byThread('chat:issue').length, decisions)
  })

  test('promotes a Thread a ticket follows only for context once the main Session attaches one of its messages', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.followForContext(ticketId, { source: 'chat', id: 'issue' })
    h.engine.report(ticketId, { state: 'ready', summary: 'done' })
    h.engine.receive(trigger('2', { threads: [{ source: 'chat', id: 'issue' }] }))
    h.pump()
    const mandate = h.opened.tickets.get(ticketId)!.mandate
    // 语境 Thread 上的消息先到 Eval；主 Session 可以把它交给这张 Ticket。
    const attached = h.engine.attach(ticketId, '2', 'It belongs here after all')
    // attach 把订阅变成它自己的：语境标记消失，已结束的 Ticket 在不变的 Mandate 下恢复。
    assert.deepEqual(h.opened.threads.get('chat:issue')?.context, [])
    assert.equal(attached.ended, undefined)
    assert.deepEqual(attached.mandate, mandate)
    h.settle()
    const requests = h.requests.length
    // 此后那条 Thread 上人的消息是它的 follow-up：直接到 worker，不再进 Eval。
    h.engine.receive(trigger('3', { actor: guest, threads: [{ source: 'chat', id: 'issue' }] }))
    h.settle()
    assertMatches(h.opened.tickets.get(ticketId)!.inputs.at(-1), { kind: 'trigger', triggerId: '3' })
    assert.equal('context' in h.opened.tickets.get(ticketId)!.inputs.at(-1)!, false)
    assert.equal(h.requests.length, requests)
    assert.deepEqual(h.opened.triggers.disposition('3'), {
      fanout: [ticketId],
      at: h.opened.triggers.disposition('3')!.at
    })
  })

  test('attaches a message from another Thread to a live ticket without opening a ticket or a new mandate', () => {
    const h = harness()
    const decision = accepted(h)
    const ticketId = decision.ticketId!
    const before = h.opened.tickets.get(ticketId)!
    h.engine.receive(trigger('2', { actor: guest, threads: [{ source: 'chat', id: 't9' }] }))
    h.pump()
    const decisions = h.opened.decisions.byThread('chat:t9').length
    assert.deepEqual(h.opened.triggers.disposition('2')?.fanout, [])
    const attached = h.engine.attach(ticketId, '2', 'It belongs to this fix')
    // 不新开 Ticket、不新开 Decision、不换 Mandate、不换 Assignment。
    assert.equal(h.opened.tickets.list().length, 1)
    assert.equal(h.opened.decisions.byThread('chat:t9').length, decisions)
    assert.deepEqual(attached.mandate, before.mandate)
    assert.equal(attached.assignments.length, before.assignments.length)
    assert.equal(attached.ended, undefined)
    // attach = 订阅那些 Thread + 一条带说明的 Input（人写的消息仍标 human）。
    assertMatches(attached.inputs.at(-1), {
      kind: 'trigger',
      triggerId: '2',
      note: 'It belongs to this fix',
      human: true
    })
    assert.deepEqual(h.opened.threads.get('chat:t9')?.subscriptions, [ticketId])
    assert.deepEqual(h.opened.triggers.disposition('2')?.fanout, [ticketId])
    h.settle()
    // 投递沿用既有投递路径：同一条 running Assignment。
    assert.deepEqual(h.delivered.at(-1), [ticketId, attached.inputs.at(-1)!.id])
    assert.equal(h.starts, 1)
  })

  test('leaves both sides as they were when the message still belongs to another worker, or came back from this one', () => {
    const h = harness()
    const first = accepted(h).ticketId!
    const second = accepted(h, '2', 't2').ticketId!
    h.engine.receive(trigger('3', { actor: guest, threads: [{ source: 'chat', id: 't2' }] }))
    h.settle()
    const before = h.opened.tickets.get(first)!
    const owned = h.opened.triggers.disposition('3')
    // 第二个 Ticket 的 worker 决定它：主 Session 不能把它抢给第一个，两边都不动。
    assert.throws(
      () => h.engine.attach(first, '3'),
      (error: unknown) => error instanceof UserError && error.code === 'workerDecides'
    )
    assert.deepEqual(h.opened.tickets.get(first), before)
    assert.deepEqual(h.opened.triggers.disposition('3'), owned)
    // 交回之后，同一条不能再被 attach 回交回它的那张 Ticket。
    assert.equal(h.engine.handback(second, '3', 'It is about the first fix'), true)
    const handed = h.opened.triggers.disposition('3')
    const returned = h.opened.tickets.get(second)
    assert.throws(
      () => h.engine.attach(second, '3'),
      (error: unknown) => error instanceof UserError && error.code === 'handedBackHere'
    )
    assert.deepEqual(h.opened.tickets.get(second), returned)
    assert.deepEqual(h.opened.triggers.disposition('3'), handed)
  })

  test('refuses an attach for a ticket a person stopped or whose mandate no longer passes, touching neither', () => {
    const h = harness()
    const stopped = accepted(h).ticketId!
    h.engine.stopTicket(stopped, 'not needed')
    const ended = accepted(h, '2', 't2').ticketId!
    h.engine.report(ended, { state: 'ready', summary: 'done' })
    h.engine.receive(trigger('3', { actor: guest, threads: [{ source: 'chat', id: 't9' }] }))
    h.pump()
    const owned = h.opened.triggers.disposition('3')
    const stoppedBefore = h.opened.tickets.get(stopped)
    assert.throws(
      () => h.engine.attach(stopped, '3'),
      (error: unknown) => error instanceof UserError && error.code === 'ticketStopped'
    )
    assert.deepEqual(h.opened.tickets.get(stopped), stoppedBefore)
    assert.deepEqual(h.opened.triggers.disposition('3'), owned)
    // 已结束的 Ticket 只有在其 Mandate 仍复验得过时才能 attach（§K.3）。
    h.setVersion('revoked')
    const endedBefore = h.opened.tickets.get(ended)
    assert.throws(
      () => h.engine.attach(ended, '3'),
      (error: unknown) => error instanceof UserError && error.code === 'mandateRevoked'
    )
    assert.deepEqual(h.opened.tickets.get(ended), endedBefore)
    assert.deepEqual(h.opened.triggers.disposition('3'), owned)
  })

  test('keeps inputs undelivered until an assignment is running, and asks to launch one whose launch failed again', () => {
    const h = harness()
    h.engine.receive(trigger('1'))
    h.pump()
    const decision = h.decide(h.requests[0]!, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested' })
    h.settle({ launch: false })
    h.engine.receive(trigger('2'))
    h.engine.evaluateDue()
    h.settle({ launch: false })
    const ticket = h.opened.tickets.get(decision.ticketId!)!
    assert.equal(ticket.undelivered.length, 1)
    assert.equal(h.delivered.length, 0)
    // 启动失败后到达的人的消息会再请执行器 launch 一次（§E.3 的回落），所以是两次。
    assert.equal(h.starts, 2)
    h.engine.assignmentStarted(ticket.id, ticket.assignments[0]!.id)
    h.settle()
    assert.equal(h.delivered.length > 0, true)
    assert.equal(h.delivered.every(([id]) => id === ticket.id), true)
  })

  test('does not hand a bot\'s message to an ended ticket, and still assesses it', () => {
    const h = harness()
    const decision = accepted(h)
    h.engine.report(decision.ticketId!, { state: 'ready', summary: 'done' })
    h.engine.receive(trigger('2', { human: false }))
    h.pump()
    assertMatches(h.opened.tickets.get(decision.ticketId!), { undelivered: [] })
    assert.ok(h.opened.tickets.get(decision.ticketId!)!.ended)
  })

  test('unsubscribing a thread stops fan-out until a new decision subscribes it', () => {
    const h = harness()
    const decision = accepted(h)
    assert.equal(h.engine.unsubscribe('chat:t1'), true)
    h.engine.receive(trigger('2'))
    h.pump()
    assert.deepEqual(h.opened.tickets.get(decision.ticketId!)!.inputs, [])
  })

  test('drops every subscription of a Thread at once, for every ticket on it, and stops following it', () => {
    const h = harness()
    const first = accepted(h).ticketId!
    const second = accepted(h, '2', 't2').ticketId!
    const context = accepted(h, '6', 't6').ticketId!
    h.engine.bindThread(second, { source: 'chat', id: 't1' }, false)
    h.engine.followForContext(context, { source: 'chat', id: 't1' })
    assert.deepEqual(h.opened.threads.get('chat:t1')?.subscriptions, [first, second, context])
    assert.deepEqual(h.opened.threads.get('chat:t1')?.context, [context])
    assert.equal(h.engine.unsubscribe('chat:t1'), true)
    // 多对多的每一条都丢掉，包括只当语境的那张；跟随也一起停（§I.5 第 6 条：关闭不再结束它）。
    assert.deepEqual(h.opened.threads.get('chat:t1')?.subscriptions, [])
    assert.deepEqual(h.opened.threads.get('chat:t1')?.context, [])
    assert.equal(h.opened.tickets.get(second)?.follows, undefined)
    h.engine.receive(trigger('3', { actor: guest }))
    h.settle()
    for (const ticketId of [first, second, context]) {
      const ticket = h.opened.tickets.get(ticketId)!
      assert.deepEqual(
        ticket.inputs.filter((input) => input.kind === 'trigger' && input.triggerId === '3'),
        []
      )
    }
    // 再取消一次什么都不丢：固定返回 false，不假装做了事。
    assert.equal(h.engine.unsubscribe('chat:t1'), false)
    // 新的 Decision 订阅它之后，扇出恢复，且只到新 Ticket。
    h.engine.receive(trigger('4'))
    h.pump()
    const subscribed = h.decide(h.requests.at(-1)!, {
      kind: 'accept',
      title: 'Again',
      scope: 'small',
      reason: 'asked',
      rules: ['copy']
    }).ticketId!
    h.settle()
    h.tick(5)
    h.engine.receive(trigger('5', { actor: guest }))
    h.settle()
    assert.equal(
      h.opened.tickets
        .get(subscribed)!
        .inputs.filter((input) => input.kind === 'trigger' && input.triggerId === '5').length,
      1
    )
    for (const ticketId of [first, second, context]) {
      assert.equal(
        h.opened.tickets
          .get(ticketId)!
          .inputs.some((input) => input.kind === 'trigger' && input.triggerId === '5'),
        false
      )
    }
  })

  test('lets an Executor drop a thread attached to its ticket, keeping the thread\'s other tickets, but not its own threads', () => {
    const h = harness()
    const first = accepted(h).ticketId!
    const second = accepted(h, '2', 't2').ticketId!
    h.engine.receive(trigger('3', { threads: [{ source: 'chat', id: 't2' }] }))
    // 第二个 Ticket 的 follow-up 只有在它的 worker 交回之后才去第一个。
    h.engine.handback(second, '3', 'It is about the first fix')
    h.engine.attach(first, '3')
    assert.deepEqual(h.opened.threads.get('chat:t2')!.subscriptions, [second, first])
    h.engine.markUnrelated(first, 'chat:t2', 'about another fix')
    assert.deepEqual(h.opened.threads.get('chat:t2')!.subscriptions, [second])
    assert.throws(
      () => h.engine.markUnrelated(first, 'chat:t2', 'again'),
      (error: unknown) => error instanceof UserError && error.code === 'notFollowing'
    )
    assert.throws(
      () => h.engine.markUnrelated(first, 'chat:t1', 'its own'),
      (error: unknown) => error instanceof UserError && error.code === 'sourceThread'
    )
    h.engine.bindThread(first, { source: 'gh', id: 'pr-9' }, true)
    assert.throws(
      () => h.engine.markUnrelated(first, 'gh:pr-9', 'its PR'),
      (error: unknown) => error instanceof UserError && error.code === 'followedThread'
    )
  })
})

describe('hand-back and release', () => {
  test('hands a message back once with its reason, and releases it to an Eval that may route it elsewhere', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.receive(trigger('2', { actor: guest }))
    h.settle()
    // 它的 worker 先判，但判断是「这超出本 Ticket」：交回一次，写下原因。
    assert.equal(h.engine.handback(ticketId, '2', 'It asks for another repository'), true)
    assert.deepEqual(h.opened.triggers.disposition('2')?.handbacks, [
      { ticketId, reason: 'It asks for another repository', at: h.opened.triggers.disposition('2')!.handbacks![0]!.at }
    ])
    // 第二次固定拒绝，无论原因；记录仍只有第一次那一条。
    assert.throws(
      () => h.engine.handback(ticketId, '2', 'again'),
      (error: unknown) => error instanceof UserError && error.code === 'handedBack'
    )
    assert.equal(h.opened.triggers.disposition('2')?.handbacks?.length, 1)
    // 释放：下一次 pass 把它交给新 Eval，可以开别处的活。
    h.pump()
    const candidate = h.requests.at(-1)!
    assert.deepEqual(candidate.triggers.map((item) => item.id), ['2'])
    assert.equal(h.engine.candidate('2')?.evalId, candidate.evalId)
    const elsewhere = h.decide(candidate, {
      kind: 'accept',
      title: 'Elsewhere',
      scope: 'small',
      reason: 'asked',
      rules: ['copy']
    })
    assert.notEqual(elsewhere.ticketId, ticketId)
    // 交回不动订阅：原 Ticket 仍跟随这个 Thread（人后续的话还会到它）。
    assert.deepEqual(h.opened.threads.get('chat:t1')?.subscriptions, [ticketId, elsewhere.ticketId])
    // 只有到过这张 Ticket 的消息能交回。
    assert.throws(
      () => h.engine.handback(ticketId, '9', 'never mine'),
      (error: unknown) => error instanceof UserError && error.code === 'notReached'
    )
  })

  test('records a hand-back without queueing again a message the ticket never decided, such as one it read for context', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.followForContext(ticketId, { source: 'chat', id: 'issue' })
    h.engine.receive(trigger('2', { threads: [{ source: 'chat', id: 'issue' }] }))
    const pending = h.opened.threads.get('chat:issue')?.pending
    // 它已经到了 Eval：交回只记原因，不再排一次。
    assert.equal(h.engine.handback(ticketId, '2', 'Not this ticket'), false)
    assert.deepEqual(h.opened.triggers.disposition('2')?.handbacks, [
      { ticketId, reason: 'Not this ticket', at: h.opened.triggers.disposition('2')!.handbacks![0]!.at }
    ])
    assert.deepEqual(h.opened.threads.get('chat:issue')?.pending, pending)
    // 已交回的消息不会被主 Session attach 回同一张 Ticket。
    assert.throws(
      () => h.engine.attach(ticketId, '2'),
      (error: unknown) => error instanceof UserError && error.code === 'handedBackHere'
    )
    // 一条根本没到过这张 Ticket 的消息不是它能交回的。
    h.engine.receive(trigger('3', { threads: [{ source: 'chat', id: 'elsewhere' }] }))
    assert.throws(
      () => h.engine.handback(ticketId, '3', 'Never mine'),
      (error: unknown) => error instanceof UserError && error.code === 'notReached'
    )
  })
})

describe('resume and stop', () => {
  function ended(h: ReturnType<typeof harness>, by: 'executor' | 'human'): string {
    const decision = accepted(h)
    if (by === 'executor') h.engine.report(decision.ticketId!, { state: 'ready', summary: 'done' })
    else h.engine.stopTicket(decision.ticketId!)
    return decision.ticketId!
  }

  test('resumes an ended ticket on any person\'s message on its thread, under the same mandate and without a Decision', () => {
    const h = harness()
    const ticketId = ended(h, 'executor')
    const decisions = h.opened.decisions.byThread('chat:t1').length
    // 它在消息到达时就恢复，早于对它的任何 Eval。
    h.engine.receive(trigger('2', { actor: guest }))
    assert.equal(h.opened.tickets.get(ticketId)!.ended, undefined)
    const ticket = h.opened.tickets.get(ticketId)!
    assert.equal(ticket.assignments.length, 2)
    assert.equal(ticket.mandate.policyVersion, 'v1')
    assert.deepEqual(ticket.inputs.map((input) => input.kind), ['trigger', 'resumed'])
    assert.equal(h.starts, 2)
    // 消息仍作为 follow-up 进 Eval，但不需要（也不可能）有 reopen Decision。
    assert.equal(
      h.opened.decisions.byThread('chat:t1').filter((decision) => decision.kind !== 'ignore').length,
      decisions
    )
  })

  test('keeps a ticket a person stopped ended: the stop withdrew its mandate', () => {
    const h = harness()
    const ticketId = ended(h, 'human')
    assert.equal(h.stopped.length, 1)
    h.engine.receive(trigger('2'))
    h.pump()
    assertMatches(h.opened.tickets.get(ticketId), { ended: { by: 'human' } })
    assert.equal(h.starts, 1)
  })

  test('keeps a ticket ended when its mandate no longer passes the current policy', () => {
    const h = harness()
    const ticketId = ended(h, 'executor')
    h.setVersion('revoked')
    h.engine.receive(trigger('2'))
    h.pump()
    assert.ok(h.opened.tickets.get(ticketId)!.ended)
    // 复验失败不吃消息：它不再挂在该 Ticket 上，回到 Eval 等新的授权。
    assert.deepEqual(h.opened.tickets.get(ticketId)!.undelivered, [])
    assert.ok(
      h.requests.some((candidate) => candidate.triggers.some((item) => item.id === '2')),
      'the message goes back to Eval'
    )
  })

  test('withdraws the mandate on a person\'s stop and ends the running assignment, keeping the worktree', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const assignment = h.opened.tickets.get(ticketId)!.assignments[0]!
    h.engine.assignmentStarted(ticketId, assignment.id, {
      terminalId: 'term_1',
      workspace: { short: 'fix-the-typo', directory: '/w/superagent-fix-the-typo', assignment: 'the brief' }
    })
    const execution = h.opened.tickets.get(ticketId)!.execution
    assert.ok(execution, 'the launch recorded the worktree')

    h.engine.stopTicket(ticketId, 'Not needed any more')

    // 撤回 Mandate 是 stop 自己的事实：Policy 仍立得住（`revalidate` 只答「今天的 Policy 还
    // 认不认这份授权」），但人的停止让这张 Ticket 再也不接东西（§K.3 末段）。
    const stopped = h.opened.tickets.get(ticketId)!
    assert.equal(stopped.ended?.by, 'human')
    assert.equal(stopped.ended?.outcome, 'stopped')
    assert.equal(stopped.mandate.policyVersion, 'v1', 'the mandate itself is immutable')
    assert.deepEqual(
      stopped.assignments.map((item) => [item.state, item.endedReason]),
      [['ended', 'stopped']],
      'the running assignment ends as stopped'
    )
    assert.deepEqual(h.stopped, [assignment.id], 'the executor is told to close its terminal')
    assert.deepEqual(stopped.execution, execution, 'the worktree is kept, never removed')
    assert.equal(
      h.messages.some((message) => message.id === key('stopped', ticketId)),
      true,
      'the closing message is queued with the ending'
    )

    // 此后什么都不接：人的消息不唤醒它，也 attach 不回来，Assignment 一个都不新起。
    h.engine.receive(trigger('2'))
    h.pump()
    assert.equal(h.opened.tickets.get(ticketId)!.ended?.outcome, 'stopped')
    assert.deepEqual(h.opened.tickets.get(ticketId)!.inputs, [])
    assert.equal(h.starts, 1)
    assert.throws(
      () => h.engine.attach(ticketId, '2'),
      (error: unknown) => error instanceof UserError && error.code === 'ticketStopped'
    )
  })

  test('retries onto the same ticket, worktree and pull request, with the mandate unchanged and a recovery note', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, true)
    const assignment = h.opened.tickets.get(ticketId)!.assignments[0]!
    h.engine.assignmentStarted(ticketId, assignment.id, {
      terminalId: 'term_1',
      workspace: { short: 'fix-the-typo', directory: '/w/superagent-fix-the-typo', assignment: 'the brief' }
    })
    const before = h.opened.tickets.get(ticketId)!
    h.engine.report(ticketId, { state: 'failed', summary: 'the build is broken' })

    h.engine.retryTicket(ticketId, 'Check the worktree, git history and GitHub first.')

    const retried = h.opened.tickets.get(ticketId)!
    assert.deepEqual(
      retried.assignments.map((item) => item.state),
      ['ended', 'pending'],
      'the stuck assignment ends and a new one is queued'
    )
    assert.equal(retried.assignments[0]?.endedReason, 'retried')
    assert.deepEqual(h.stopped, [assignment.id], 'the replaced terminal is closed')
    assert.deepEqual(retried.execution, before.execution, 'the same worktree and branch')
    assert.deepEqual(retried.follows, before.follows, 'the same pull request stays followed')
    assert.deepEqual(retried.mandate, before.mandate, 'the same mandate: no new authorization')
    assert.deepEqual(
      h.opened.tickets.list().map((ticket) => ticket.id),
      [ticketId],
      'a retry never opens a second ticket'
    )
    assert.equal(
      retried.inputs.some(
        (input) => input.kind === 'text' && input.text.includes('git history and GitHub')
      ),
      true,
      'the recovery note is an input of the new assignment'
    )
  })

  test('resumes the same work under the same mandate when a person comments after its pull request merged', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, true)
    h.engine.report(ticketId, { state: 'ready', summary: 'the redirect is fixed' })
    h.engine.threadClosed({ source: 'gh', id: 'pr-9' }, 'merged', '2026-09-23T00:01:00Z')
    const ended = h.opened.tickets.get(ticketId)!
    assert.equal(ended.ended?.outcome, 'merged')
    assert.deepEqual(
      h.opened.threads.get('gh:pr-9')?.subscriptions,
      [ticketId],
      'the subscription is kept, so a later comment can resume the ticket (§I.5 item 5)'
    )
    const mandate = ended.mandate

    // 人在合并后的 PR 上再说一句：同一个 Mandate，没有新的 Eval、没有新 Decision、没有新 Ticket。
    h.engine.receive(trigger('2', { threads: [{ source: 'gh', id: 'pr-9' }] }))
    const resumed = h.opened.tickets.get(ticketId)!
    assert.equal(resumed.ended, undefined, 'the ticket is open again')
    assert.deepEqual(resumed.mandate, mandate, 'the same authorization: no new mandate')
    assert.equal(resumed.assignments.length, 2, 'a new assignment on the same ticket')
    assert.deepEqual(resumed.inputs.map((input) => input.kind), ['trigger', 'resumed'])
    assert.equal(h.starts, 2, 'one new worker for the resumed work')
    assert.deepEqual(h.opened.decisions.byThread('gh:pr-9'), [], 'no accept reopened it')
    assert.deepEqual(h.opened.tickets.list().map((ticket) => ticket.id), [ticketId])

    // 恢复不改变 PR 的结束规则：下一次 ready 仍按那次合并结束。
    h.engine.report(ticketId, { state: 'ready', summary: 'the follow-up is in' })
    assert.equal(h.opened.tickets.get(ticketId)!.ended?.outcome, 'merged')
  })

  test('stops a live ticket only on an explicit instruction and ends it by the human', () => {
    const h = harness()
    const decision = accepted(h)
    // gate 判一条访客的 follow-up 为推断强度：stop 必须是显式请求。
    h.engine.receive(trigger('2', { actor: guest }))
    h.pump()
    assertMatches(
      h.engine.decide('2', { kind: 'stop', ticketId: decision.ticketId!, reason: 'x' }),
      { kind: 'ignore', strength: 'inferred', reason: [{ code: 'stopNotExplicit' }] }
    )
    // 显式请求可以停：它结束 Ticket，并按人结束记录。
    h.engine.receive(trigger('3'))
    h.pump()
    assert.equal(h.engine.decide('3', { kind: 'stop', ticketId: decision.ticketId!, reason: 'human said stop' }).kind, 'stop')
    assertMatches(h.opened.tickets.get(decision.ticketId!), { ended: { by: 'human' } })
  })
})

describe('worker reports', () => {
  test('asks, keeps, replaces and clears the question for a person, and says which question a report replaced', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const asked = h.engine.report(ticketId, {
      state: 'progress',
      summary: 'need a call',
      question: 'Which color?',
      askedBy: '1'
    })
    assertMatches(asked.attention, { question: 'Which color?', forTriggerId: '1' })
    const kept = h.engine.report(ticketId, { state: 'blocked', summary: 'still waiting' })
    assert.deepEqual(kept.attention, asked.attention)
    assert.deepEqual(h.withdrawn, [])
    const replaced = h.engine.report(ticketId, {
      state: 'progress',
      summary: 'other question',
      question: 'Which size?'
    })
    assertMatches(replaced.attention, { question: 'Which size?' })
    assert.equal(replaced.attention!.forTriggerId, undefined)
    // 被替换的问题从 outbox 撤回（如果它的消息还没发出）。
    assert.deepEqual(h.withdrawn, [key('attention-reply', asked.attention!.id)])
    const cleared = h.engine.report(ticketId, { state: 'progress', summary: 'answered', question: null })
    assert.equal(cleared.attention, undefined)
    assert.deepEqual(h.withdrawn, [
      key('attention-reply', asked.attention!.id),
      key('attention-reply', replaced.attention!.id)
    ])
  })

  test('a blocked report moves the ticket to person/blocked, and a person\'s message releases it', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const blocked = h.engine.report(ticketId, { state: 'blocked', summary: 'need permission' })
    // §E.8 要求 agentState ∈ {blocked, done}；这里显式给出 agent 已停在提示上这一维。
    assert.deepEqual(ticketStage(blocked, 'blocked'), { stage: 'person', action: 'blocked' })
    // 人 follow-up 的报告之后到达（时刻必须严格更晚）。
    h.tick(1)
    h.engine.receive(trigger('2', { actor: guest }))
    assert.deepEqual(ticketStage(h.opened.tickets.get(ticketId)!), { stage: 'working' })
  })

  test('ends the ticket on a final report: dropped drops it, ready completes it unless it follows a Source\'s Thread that is open', () => {
    const outcome = (state: 'ready' | 'dropped' | 'failed', follows: boolean, closed = false) => {
      const h = harness()
      const ticketId = accepted(h).ticketId!
      h.engine.report(ticketId, { state: 'progress', summary: 'asking', question: 'Merge it?' })
      if (follows) h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, false)
      if (follows) h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-10' }, true)
      if (closed) {
        h.engine.threadClosed({ source: 'gh', id: 'pr-9' }, 'closed', '2026-09-22T00:00:00Z')
        h.engine.threadClosed({ source: 'gh', id: 'pr-10' }, 'merged', '2026-09-22T00:00:01Z')
      }
      h.engine.report(ticketId, { state, summary: 'done' })
      return h.opened.tickets.get(ticketId)!
    }
    assertMatches(outcome('dropped', true), { ended: { by: 'executor', outcome: 'dropped' } })
    assert.equal(outcome('dropped', true).ended!.reason, undefined)
    assertMatches(outcome('ready', false), { ended: { outcome: 'completed' } })
    assert.equal(outcome('ready', false).attention, undefined)
    assertMatches(outcome('ready', true), {
      follows: [
        { thread: 'gh:pr-9', own: false },
        { thread: 'gh:pr-10', own: true }
      ]
    })
    assert.equal(outcome('ready', true).ended, undefined)
    assertMatches(outcome('ready', true, true), { ended: { outcome: 'merged' } })
    assertMatches(outcome('failed', false), { attention: { question: 'Merge it?' } })
    assert.equal(outcome('failed', false).ended, undefined)
  })

  test('refuses a report on an ended ticket', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.stopTicket(ticketId)
    assert.throws(
      () => h.engine.report(ticketId, { state: 'progress', summary: 'x' }),
      (error: unknown) => error instanceof UserError && error.code === 'ticketEnded'
    )
  })
})

describe('outcomes', () => {
  test('records how a ticket ended', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.stopTicket(ticketId, 'Human asked to stop')
    assertMatches(h.opened.tickets.get(ticketId)!.ended, {
      by: 'human',
      outcome: 'stopped',
      reason: 'Human asked to stop'
    })
  })
})

describe('interrupted assignments', () => {
  test('starts an Assignment interrupted mid-work again with a note, and hands one that waits what waits for it', () => {
    const h = harness()
    const interrupted = accepted(h).ticketId!
    const first = h.opened.tickets.get(interrupted)!.assignments[0]!
    const waiting = accepted(h, '2', 't2').ticketId!
    h.engine.report(waiting, { state: 'waiting', summary: 'done for now' })
    h.tick(1)
    h.engine.receive(trigger('3', { threads: [{ source: 'chat', id: 't2' }] }))
    const starts = h.starts
    const deliveries = h.delivered.length
    // 执行器报告每个当时在跑的 Assignment；不再运行的那个的事实被丢弃。
    for (const id of [interrupted, waiting]) {
      h.engine.assignmentInterrupted(id, runningAssignment(h.opened.tickets.get(id)!)!.id)
    }
    h.engine.assignmentInterrupted(interrupted, first.id)
    const ticket = h.opened.tickets.get(interrupted)!
    assertMatches(ticket.assignments, [
      { id: first.id, state: 'ended', endedReason: 'hostRestarted' },
      { state: 'pending' }
    ])
    assertMatches(ticket.inputs, [{ kind: 'text', text: /The host restarted/ }])
    assert.deepEqual(ticket.undelivered, [ticket.inputs[0]!.id])
    assert.equal(h.starts, starts + 1)
    // 在等待的 worker 保留它的会话（不新建 Assignment），只把等它的东西投出去。
    assert.equal(h.opened.tickets.get(waiting)!.assignments.length, 1)
    h.settle()
    assert.equal(h.delivered.length > deliveries, true)
  })

  test('starts again a worker that reported but then got a person\'s message, which it was working on', () => {
    const h = harness()
    const other = accepted(h, '2', 't2').ticketId!
    h.engine.report(other, { state: 'waiting', summary: 'done for now' })
    h.tick(1)
    h.engine.receive(trigger('3', { actor: guest, threads: [{ source: 'chat', id: 't2' }] }))
    h.settle()
    const running = runningAssignment(h.opened.tickets.get(other)!)!
    assert.ok(running.deliveredAt! > running.report!.at)
    h.engine.assignmentInterrupted(other, running.id)
    assert.deepEqual(
      h.opened.tickets.get(other)!.assignments.map((item) => item.state),
      ['ended', 'pending']
    )
  })
})

describe('pause', () => {
  test('lets no Eval expire while processing is paused, and moves its deadline on by the pause\'s length', () => {
    const h = harness()
    h.engine.receive(trigger('1'))
    h.pump()
    h.engine.candidateDelivered(h.requests[0]!.evalId)
    const deadline = Date.parse(h.opened.threads.get('chat:t1')!.evaluating!.deadline)
    h.tick(30)
    h.setPaused(true)
    h.pump()
    // 暂停超过截止时间，Eval 继续等。
    h.tick(300)
    h.pump()
    assert.ok(h.engine.candidate('1'))
    h.setPaused(false)
    h.pump()
    assert.equal(
      Date.parse(h.opened.threads.get('chat:t1')!.evaluating!.deadline),
      deadline + 300_000
    )
    h.tick(29)
    h.pump()
    assert.ok(h.engine.candidate('1'))
    // 到期后把 Trigger 重新排队给新 Eval。
    h.tick(1)
    h.pump()
    assert.notEqual(h.engine.candidate('1')?.evalId, h.requests[0]!.evalId)
    assert.deepEqual(h.opened.decisions.byThread('chat:t1'), [])
  })

  test('hands back a message beyond the ticket once, and gives it to work that stays on the ticket', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.receive(trigger('2', { actor: guest }))
    h.pump()
    // 这条消息到达了该 Ticket，所以先由它的 worker 判；交回一次之后才成为候选。
    assert.equal(h.engine.handback(ticketId, '2', 'It asks for another repository'), true)
    assert.throws(
      () => h.engine.handback(ticketId, '2', 'again'),
      (error: unknown) => error instanceof UserError && error.code === 'handedBack'
    )
    h.pump()
    assert.ok(h.requests.some((candidate) => candidate.triggers.some((item) => item.id === '2')))
    // 仍由某个 Ticket 的 worker 决定的消息不能 attach 给别的 Ticket：它先由那个 worker 判。
    const other = accepted(h, '3', 't3').ticketId!
    h.engine.receive(trigger('4', { threads: [{ source: 'chat', id: 't3' }] }))
    h.pump()
    assert.throws(
      () => h.engine.attach(other, '4'),
      (error: unknown) => error instanceof UserError && error.code === 'workerDecides'
    )
    // 没人决定的消息可以 attach：Ticket 收下它，并订阅它的 Thread。
    h.engine.receive(trigger('5', { actor: guest, threads: [{ source: 'chat', id: 't9' }] }))
    h.pump()
    const attached = h.engine.attach(other, '5')
    assert.ok(attached.inputs.some((input) => input.kind === 'trigger' && input.triggerId === '5'))
    assert.ok(h.opened.threads.get('chat:t9')!.subscriptions.includes(other))
  })

  test('records a note as an Input that grants nothing, and refuses one for an ended ticket', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const noted = h.engine.note(ticketId, 'Another ticket already fixed the helper')
    assertMatches(noted.inputs.at(-1), { kind: 'note', text: 'Another ticket already fixed the helper' })
    // note 不改授权面：Mandate 原样。
    assert.deepEqual(noted.mandate, h.opened.tickets.get(ticketId)!.mandate)
    h.engine.stopTicket(ticketId)
    assert.throws(
      () => h.engine.note(ticketId, 'too late'),
      (error: unknown) => error instanceof UserError && error.code === 'ticketEnded'
    )
  })

  test('stops a live ticket on an explicit stop Decision and rejects a stop that names no live ticket', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.receive(trigger('2'))
    h.pump()
    // 指名一张不存在（或已结束）的工单：记成 ignore，什么都不结束。
    assertMatches(h.engine.decide('2', { kind: 'stop', ticketId: 'nope', reason: 'x' }), {
      kind: 'ignore',
      reason: [{ code: 'stopUnknown' }]
    })
    h.engine.receive(trigger('3'))
    h.pump()
    assert.equal(h.engine.decide('3', { kind: 'stop', ticketId, reason: 'Human asked to stop' }).kind, 'stop')
    assertMatches(h.opened.tickets.get(ticketId)!.ended, {
      by: 'human',
      outcome: 'stopped',
      reason: 'Human asked to stop'
    })
  })

  test('does not start evals while paused', () => {
    const h = harness()
    h.setPaused(true)
    h.engine.receive(trigger('1'))
    h.pump()
    assert.equal(h.requests.length, 0)
  })
})

describe('policy change', () => {
  test('tells only the live tickets a change bears on how it does, and restarts in-flight evals under the new version', () => {
    const h = harness()
    const decision = accepted(h)
    const other = accepted(h, '3', 't3').ticketId!
    h.engine.receive(trigger('2', { threads: [{ source: 'chat', id: 't2' }] }))
    h.pump()
    const effect = {
      rules: [{ id: 'copy', name: 'Copy', change: 'changed' as const, instruction: 'Fix typos only.' }]
    }
    h.setVersion('v2')
    h.engine.policyChanged('v1', 'v2', new Map([[decision.ticketId!, effect]]))
    assertMatches(h.opened.tickets.get(decision.ticketId!)!.inputs, [
      { kind: 'policy-changed', from: 'v1', to: 'v2', effect }
    ])
    assert.deepEqual(
      h.opened.tickets.get(other)!.inputs.filter((input) => input.kind === 'policy-changed'),
      []
    )
    assertMatches(h.opened.decisions.byThread('chat:t2'), [
      { kind: 'unavailable', reason: [{ code: 'policyChanged' }] }
    ])
    assert.deepEqual(h.opened.threads.get('chat:t2')?.pending, ['2'])
    h.pump()
    assertMatches(h.requests.at(-1), {
      policyVersion: 'v2',
      triggers: [{ id: '2' }]
    })
    // 变更不吊销 Mandate：Ticket 仍 open。
    assert.equal(h.opened.tickets.get(decision.ticketId!)!.ended, undefined)
  })
})

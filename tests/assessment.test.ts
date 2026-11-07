// 主动候选的规则评估（§K.4）：票 #24 的评估面。
//
// 断言只在一个接缝上：`policy/assessment.ts` 的 `assessmentOutcome()`——它把「模型交来的
// 评估」按当前 Policy 块收成 `AssessmentOutcome`，或在评估本身不合法时给出固定错误码
// （`invalid_assessment` / `incomplete_rules`），且不产生任何结局。
//
// 夹具是一个两份启用规则、一份停用规则的 Policy 块；评估载荷用与上游一致的 snake_case
// 键（`rule_assessments` / `intent_evidence` / `target_basis`）。
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Engine } from '../src/worker/core/index.ts'
import type { Policy, Trigger } from '../src/worker/core/index.ts'
import { createDeterministicAssessor } from '../src/worker/app/assessor.ts'
import { registerAssessmentEffects, type RouterCard } from '../src/worker/app/notices.ts'
import { createRepositories } from '../src/worker/app/repositories.ts'
import { assessmentOutcome, directionAllowed } from '../src/worker/policy/index.ts'
import type { AssessmentPolicy } from '../src/worker/policy/index.ts'
import { openQueue } from './support/queue.ts'

/** 两份启用规则 + 一份停用规则：完整性只数启用的。 */
const RULES = [
  { id: 'copy', name: 'Copy fixes', instruction: { zh: '改错别字', en: 'Fix typos' }, enabled: true },
  {
    id: 'visual',
    name: 'Visual fixes',
    instruction: { zh: '修局部间距', en: 'Fix local spacing' },
    enabled: true
  },
  { id: 'legacy', name: 'Legacy fixes', instruction: { zh: '已停用', en: 'Disabled' }, enabled: false }
]

const policy = (acceptMode: AssessmentPolicy['acceptMode'] = 'auto'): AssessmentPolicy => ({
  acceptMode,
  rules: RULES
})

/** 一个 ignore 结局的原因码（`reason` 也可以是自由文本，这里只要结构化码）。 */
const reasonCode = (reason: string | { code: string }): string =>
  typeof reason === 'string' ? reason : reason.code

/** 一条已确定方向：请求实现、目标明确、无待定设计决策。 */
const direction = {
  implementation_requested: true,
  target_basis: 'specified',
  requires_design_decision: false,
  evidence: 'the report names the wrong redirect target'
}

/** 每条启用规则恰好一条判定；`matched` 缺省只匹配 copy。 */
const judged = (matched: readonly string[] = ['copy']) =>
  RULES.filter((rule) => rule.enabled).map((rule) => ({
    rule_id: rule.id,
    matched: matched.includes(rule.id),
    reason: `judged ${rule.id}`
  }))

/** 一份完整的 accept 评估；用例只覆盖它的一两个字段。 */
function assessment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decision: 'accept',
    direction,
    rule_assessments: judged(),
    title: 'Fix the login redirect',
    scope: 'one local fix',
    reason: 'the redirect target is wrong',
    intent_evidence: 'please fix the login redirect',
    worktree_name: 'fix-login-redirect',
    ...overrides
  }
}

describe('rule completeness (§K.4 item 1)', () => {
  test('judging every enabled rule exactly once is the minimum', () => {
    // 少一条：漏判。
    const missing = assessmentOutcome(
      assessment({ rule_assessments: judged().filter((item) => item.rule_id !== 'visual') }),
      policy(),
      'inferred'
    )
    assert.equal(missing.ok, false, JSON.stringify(missing))
    if (!missing.ok) assert.equal(missing.code, 'incomplete_rules')

    // 多判一条（同一条规则两次）：不是「恰好一次」。
    const twice = assessmentOutcome(
      assessment({ rule_assessments: [...judged(), { rule_id: 'copy', matched: false, reason: 'again' }] }),
      policy(),
      'inferred'
    )
    assert.equal(twice.ok, false, JSON.stringify(twice))
    if (!twice.ok) assert.equal(twice.code, 'incomplete_rules')

    // 判了停用或不存在的规则：无效评估。
    for (const ruleId of ['legacy', 'unknown-rule']) {
      const extra = assessmentOutcome(
        assessment({ rule_assessments: [...judged(), { rule_id: ruleId, matched: false, reason: 'x' }] }),
        policy(),
        'inferred'
      )
      assert.equal(extra.ok, false, ruleId)
      if (!extra.ok) assert.equal(extra.code, 'incomplete_rules')
    }

    // 恰好一次：通过。
    const ok = assessmentOutcome(assessment(), policy(), 'inferred')
    assert.equal(ok.ok, true, JSON.stringify(ok))
    if (ok.ok) {
      assert.equal(ok.outcome.kind, 'accept')
      if (ok.outcome.kind === 'accept') assert.deepEqual(ok.outcome.rules, ['copy'])
    }
  })
})

describe('the direction has four parts (§K.4 item 2)', () => {
  test('implementation intent, a settled target, no open design decision, evidence', () => {
    assert.equal(directionAllowed(direction), true)
    assert.equal(directionAllowed({ ...direction, implementation_requested: false }), false)
    assert.equal(directionAllowed({ ...direction, target_basis: 'undetermined' }), false)
    assert.equal(directionAllowed({ ...direction, requires_design_decision: true }), false)
    // 目标属于既有标准也算明确。
    assert.equal(directionAllowed({ ...direction, target_basis: 'existing-standard' }), true)
    // 四要素缺一（这里缺证据）不是合法方向，评估本身被拒。
    const { evidence: _evidence, ...noEvidence } = direction
    const refused = assessmentOutcome(assessment({ direction: noEvidence }), policy(), 'inferred')
    assert.equal(refused.ok, false)
    if (!refused.ok) assert.equal(refused.code, 'invalid_assessment')
  })
})

describe('the four accept conditions (§K.4 item 3)', () => {
  test('requests implementation, target settled, no design decision, one matched rule', () => {
    const accepted = assessmentOutcome(assessment(), policy(), 'inferred')
    assert.equal(accepted.ok, true, JSON.stringify(accepted))
    if (accepted.ok) assert.equal(accepted.outcome.kind, 'accept')

    // 规则一条都不匹配 → ignore，理由固定。
    const noRule = assessmentOutcome(assessment({ rule_assessments: judged([]) }), policy(), 'inferred')
    assert.equal(noRule.ok, true)
    if (noRule.ok) {
      assert.equal(noRule.outcome.kind, 'ignore')
      if (noRule.outcome.kind === 'ignore') assert.equal(reasonCode(noRule.outcome.reason), 'noRuleMatched')
    }

    // 方向未定 → ignore（即使有规则匹配）；含糊与冲突走同一条。
    const unsettled = assessmentOutcome(
      assessment({ direction: { ...direction, requires_design_decision: true } }),
      policy(),
      'inferred'
    )
    assert.equal(unsettled.ok, true)
    if (unsettled.ok) {
      assert.equal(unsettled.outcome.kind, 'ignore')
      if (unsettled.outcome.kind === 'ignore') {
        assert.equal(reasonCode(unsettled.outcome.reason), 'directionUnsettled')
      }
    }

    // 接受需要证据：缺了就是无效评估，不产生结局。
    const noEvidence = assessmentOutcome(assessment({ intent_evidence: undefined }), policy(), 'inferred')
    assert.equal(noEvidence.ok, false)
    if (!noEvidence.ok) assert.equal(noEvidence.code, 'invalid_assessment')
  })

  test('rules have no priority: every matched rule is recorded, in payload order', () => {
    const both = assessmentOutcome(assessment({ rule_assessments: judged(['copy', 'visual']) }), policy(), 'inferred')
    assert.equal(both.ok, true, JSON.stringify(both))
    if (both.ok && both.outcome.kind === 'accept') {
      assert.deepEqual(both.outcome.rules, ['copy', 'visual'])
      const audit = both.outcome.audit as { matches?: { rule_id: string }[] }
      assert.deepEqual(audit.matches?.map((match) => match.rule_id), ['copy', 'visual'])
    }
  })
})

describe('the audit payload the panel reads', () => {
  test('records every judgement, the matched subset, the direction and the evidence', () => {
    const result = assessmentOutcome(
      assessment({ rule_assessments: judged(['visual']), intent_evidence: 'the gap is 4px too wide' }),
      policy(),
      'inferred'
    )
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok || result.outcome.kind !== 'accept') return
    const audit = result.outcome.audit as Record<string, unknown>
    assert.deepEqual(audit['matches'], [{ rule_id: 'visual', reason: 'judged visual' }])
    assert.deepEqual(
      (audit['rule_assessments'] as { rule_id: string; matched: boolean }[]).map((item) => [
        item.rule_id,
        item.matched
      ]),
      [
        ['copy', false],
        ['visual', true]
      ]
    )
    assert.deepEqual(audit['direction'], direction)
    assert.equal(audit['intent_evidence'], 'the gap is 4px too wide')
  })
})

describe('accept mode (§K.4 item 4)', () => {
  test('auto accepts a proactive candidate once, with its matched rules in the mandate', () => {
    const result = assessmentOutcome(assessment(), policy('auto'), 'inferred')
    assert.equal(result.ok, true)
    if (result.ok && result.outcome.kind === 'accept') {
      assert.deepEqual(result.outcome.rules, ['copy'])
      assert.equal(result.outcome.name, 'fix-login-redirect')
      assert.equal(result.outcome.title, 'Fix the login redirect')
    }
  })

  test('observe records the would-accept decision without accepting it', () => {
    const result = assessmentOutcome(assessment(), policy('observe'), 'inferred')
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok) return
    assert.equal(result.outcome.kind, 'ignore')
    if (result.outcome.kind !== 'ignore') return
    assert.equal(reasonCode(result.outcome.reason), 'observed')
    const audit = result.outcome.audit as Record<string, unknown>
    assert.equal(audit['would_accept'], true)
    assert.deepEqual(audit['proposal'], {
      title: 'Fix the login redirect',
      scope: 'one local fix',
      worktree_name: 'fix-login-redirect'
    })
    // 观察模式不产生匹配规则、也不产生 Ticket：约束由 accept 才携带。
    assert.equal('rules' in result.outcome, false)
  })

  test('off has nothing actionable for an inferred candidate', () => {
    const result = assessmentOutcome(assessment(), policy('off'), 'inferred')
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok) return
    assert.equal(result.outcome.kind, 'ignore')
    if (result.outcome.kind !== 'ignore') return
    assert.equal(reasonCode(result.outcome.reason), 'admissionIgnored')
    assert.equal('would_accept' in ((result.outcome.audit ?? {}) as object), false)
  })

  test('an explicit candidate is accepted in every mode; the mode only governs proactive work', () => {
    for (const acceptMode of ['off', 'observe', 'auto'] as const) {
      const result = assessmentOutcome(assessment(), policy(acceptMode), 'explicit')
      assert.equal(result.ok, true, acceptMode)
      if (result.ok) assert.equal(result.outcome.kind, 'accept', acceptMode)
    }
  })
})

describe('the payload shape', () => {
  test('unknown keys, wrong enums and missing fields are invalid_assessment', () => {
    const cases: unknown[] = [
      assessment({ decision: 'accept-ish' }),
      assessment({ surprise: true }),
      assessment({ direction: { ...direction, target_basis: 'somewhere' } }),
      assessment({ rule_assessments: [{ rule_id: 'copy', matched: true }] }),
      assessment({ title: '' }),
      assessment({ worktree_name: 'Fix Login Redirect' }),
      null,
      'accept'
    ]
    for (const value of cases) {
      const result = assessmentOutcome(value, policy(), 'inferred')
      assert.equal(result.ok, false, JSON.stringify(value))
      if (!result.ok) assert.equal(result.code, 'invalid_assessment')
    }
  })

  test('an accept needs a title and a scope; an ignore does not', () => {
    const noTitle = assessmentOutcome(assessment({ title: undefined }), policy(), 'inferred')
    assert.equal(noTitle.ok, false)
    if (!noTitle.ok) assert.equal(noTitle.code, 'invalid_assessment')
    const ignore = assessmentOutcome(
      { decision: 'ignore', direction, rule_assessments: judged([]), reason: 'not ours' },
      policy(),
      'inferred'
    )
    assert.equal(ignore.ok, true, JSON.stringify(ignore))
    if (ignore.ok) assert.equal(ignore.outcome.kind, 'ignore')
  })
})

// ---------------------------------------------------------------- assessment effect (§J.2、§K.7)

/**
 * 候选卡怎么送到 Router、Eval 计时何时起算（§K.7：候选**送达 Router** 时才起算）。
 *
 * 接缝是 `registerAssessmentEffects()` 注册的 handler：真 SQLite 上的效果队列 + 真 `Engine`
 * （领域），只有「写 Router 终端」这一外部端口是记录型的（§P.1：执行器/Router 这类外部世界
 * 的替身允许，内部层不 mock）。
 */
describe('the assessment effect relays the candidate card (§J.2, §K.7)', () => {
  /** 一次评估的夹具：真库 + 真队列 + 真领域，Router 终端由 `cards` 记录。 */
  function harness(options: { deliver?: (card: RouterCard) => Promise<void> } = {}) {
    const h = openQueue()
    const repo = createRepositories(h.store)
    const cards: RouterCard[] = []
    const delivered: string[] = []
    const policy: Policy = {
      version: 'policy-1',
      paused: false,
      evalTimeoutMs: 60_000,
      gate: (item) =>
        item.actor.id === 'alice'
          ? { admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'mention' } }
          : { admissible: true, strength: 'inferred', basis: { via: 'followup' } },
      revalidate: () => true,
      admitsInferred: () => true
    }
    let engine: Engine | undefined
    const assessor = createDeterministicAssessor({
      decide: (triggerId, outcome) => engine!.decide(triggerId, outcome),
      // 这是 boot 里的那条接线：不是本票评估器决定的那类候选，走 `assessment` effect 交给 Router。
      relayCandidate: (candidate) => {
        h.effects.enqueue('assessment', candidate.evalId, { triggerId: candidate.triggers[0]!.id })
      }
    })
    engine = new Engine({
      repo,
      scope: { scope: () => ({ listened: true, observed: true }) },
      policy: () => policy,
      assessor,
      executor: {
        start: () => undefined,
        deliver: () => undefined,
        stop: () => undefined
      },
      outbox: {
        send: () => undefined,
        status: () => undefined,
        withdraw: () => undefined,
        withdrawTicket: () => undefined
      },
      now: () => h.clock.iso()
    })
    registerAssessmentEffects({
      effects: h.effects,
      candidate: (triggerId) => engine!.candidate(triggerId),
      delivered: (evalId) => {
        delivered.push(evalId)
        engine!.candidateDelivered(evalId)
      },
      deliver:
        options.deliver ??
        (async (card) => {
          cards.push(card)
        }),
      now: () => h.clock.now()
    })
    return { ...h, repo, engine, cards, delivered }
  }

  /** 一条来自非名单成员的 Trigger：Gate 判成 inferred，由 Router 评估（§K.2）。 */
  function incoming(id: string, actor = 'bob'): Trigger {
    return {
      id,
      source: 'chat',
      threads: [{ source: 'chat', id: 't1' }],
      actor: { source: 'chat', id: actor },
      human: true,
      at: `2026-11-07T03:26:0${id}Z`,
      text: `please change thing number ${id}`,
      channel: { source: 'chat', thread: 't1', address: { message: id } },
      meta: {}
    }
  }

  test('an inferred candidate is relayed as one card, and its Eval clock starts at delivery', async () => {
    const h = harness()
    try {
      h.engine.receive(incoming('1'))
      h.engine.evaluateDue()
      const evaluating = h.repo.threads.get('chat:t1')?.evaluating
      assert.ok(evaluating)
      // 行在领域事务里就写好了（先存后做），但还没人送：终端上没有卡、时钟没起算。
      assert.equal(h.effects.pending('assessment', evaluating.id), true)
      assert.deepEqual(h.cards, [])
      assert.equal(evaluating.delivered, undefined)

      // Router 忙了 30 秒之后才收下这张卡：截止时间从「送达」起算，不是从「入队」起算。
      h.clock.advance(30_000)
      await h.effects.idle()
      assert.equal(h.cards.length, 1)
      assert.deepEqual(h.delivered, [evaluating.id])
      assert.equal(h.effects.pending('assessment'), false)
      const card = h.cards[0]!
      assert.equal(card.name, `eval-${evaluating.id}`)
      assert.match(card.summary, /inferred/)
      // 正文带着 Router 评估要的编号：它是 `superagent eval <trigger_id>` 的入参。
      assert.match(card.body, /trigger: 1/)
      assert.match(card.body, /policy-1/)
      const after = h.repo.threads.get('chat:t1')!.evaluating!
      assert.equal(after.delivered, h.clock.iso())
      assert.equal(Date.parse(after.deadline), h.clock.now() + 60_000)
    } finally {
      h.cleanup()
    }
  })

  test('an explicit candidate is decided here, so the Router is not asked and no card is queued', async () => {
    const h = harness()
    try {
      h.engine.receive(incoming('1', 'alice'))
      h.engine.evaluateDue()
      assert.equal(h.effects.pending('assessment'), false)
      await h.effects.idle()
      assert.deepEqual(h.cards, [])
    } finally {
      h.cleanup()
    }
  })

  test('a candidate whose Eval ended before delivery is dropped: no card, no clock', async () => {
    const h = harness()
    try {
      h.engine.receive(incoming('1'))
      h.engine.evaluateDue()
      const evalId = h.repo.threads.get('chat:t1')!.evaluating!.id
      // 评估在送达之前就结束了（人从卡片上忽略、或 Policy 复评）：这张卡已经没有意义。
      h.engine.decide('1', { evalId, kind: 'ignore', reason: 'not ours' })
      await h.effects.idle()
      assert.deepEqual(h.cards, [])
      assert.deepEqual(h.delivered, [])
      assert.equal(h.effects.pending('assessment'), false)
    } finally {
      h.cleanup()
    }
  })

  test('a delivery that fails keeps the row, backs off two seconds and never starts the clock early', async () => {
    let failing = true
    const cards: RouterCard[] = []
    const h = harness({
      deliver: async (card) => {
        cards.push(card)
        if (failing) throw new Error('the router terminal is not available')
      }
    })
    try {
      h.engine.receive(incoming('1'))
      h.engine.evaluateDue()
      const evalId = h.repo.threads.get('chat:t1')!.evaluating!.id

      await h.effects.idle()
      // 终端没接：行留下，按 assessment 的 2 s 退避（§J.2），时钟仍然没起算。
      assert.equal(cards.length, 1)
      const row = h.store.effects.get('assessment', evalId)
      assert.equal(row?.attempts, 1)
      assert.equal(row?.dueAt, new Date(h.clock.now() + 2000).toISOString())
      assert.deepEqual(h.delivered, [])
      assert.equal(h.repo.threads.get('chat:t1')!.evaluating!.delivered, undefined)

      failing = false
      h.clock.advance(2000)
      await h.effects.idle()
      assert.equal(cards.length, 2)
      assert.deepEqual(h.delivered, [evalId])
      assert.equal(h.effects.pending('assessment'), false)
    } finally {
      h.cleanup()
    }
  })
})

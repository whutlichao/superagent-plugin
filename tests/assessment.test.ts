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
import { assessmentOutcome, directionAllowed } from '../src/worker/policy/index.ts'
import type { AssessmentPolicy } from '../src/worker/policy/index.ts'

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

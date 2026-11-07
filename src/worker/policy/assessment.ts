// 规则评估的结果规则（§K.4，与上游 `assessmentOutcome` 同形）：把模型交来的一次评估收成
// 领域能执行的 `AssessmentOutcome`，或在评估本身不合法时给出固定错误码。
//
// 三条硬规则：
// 1. 每条启用的规则**恰好判定一次**（匹配与否 + 一条事实理由）；漏判、重判、判了停用或不存在
//    的规则都是 `incomplete_rules`；
// 2. 方向四要素：是否请求实现、目标是否明确或属于既有标准、是否需要设计决策、证据；
// 3. 接受需同时满足：请求实现 + 目标明确或既有标准 + 无待定设计决策 + 至少一条规则匹配。
//
// accept mode 只约束**主动**（inferred）候选：`auto` 接受；`observe` 记下 would-accept 的
// 审计数据但不建 Ticket；`off` 在 Gate 层就不产生候选，若仍收到评估则记为不可执行。显式候选
// 不受 mode 约束。
//
// 规则之间没有优先级：匹配到的规则按载荷顺序全部记下，接受与否不由「哪条规则更强」决定；
// 方向含糊（含规则之间的范围冲突）就 ignore。
//
// 依赖纪律（§C.2）：本文件只 import 领域类型与 `infra/schema.ts`；不做 I/O、不读设置。
import type { AssessmentOutcome, Strength } from '../core/index.ts'
import { array, boolean, enumOf, object, string } from '../infra/schema.ts'
import type { SafeParse, SchemaIssue } from '../infra/schema.ts'
import type { Rule } from './schema.ts'
import type { PolicyBlock } from './schema.ts'

/** 方向四要素之一：目标依据只允许三种，`undetermined` 即方向未定（§K.4 第 2 条）。 */
export const TARGET_BASES = ['specified', 'existing-standard', 'undetermined'] as const
export type TargetBasis = (typeof TARGET_BASES)[number]

/** 评估里的方向（§K.4 第 2 条）：是否请求实现、目标依据、是否待设计决策、证据。 */
export interface AssessmentDirection {
  implementationRequested: boolean
  targetBasis: TargetBasis
  requiresDesignDecision: boolean
  evidence: string
}

/** 一条规则的判定：哪条规则、是否匹配、一条事实理由（不是结论）。 */
export interface RuleAssessment {
  ruleId: string
  matched: boolean
  reason: string
}

/** 一次评估的载荷（snake_case 的线形状见 `tests/assessment.test.ts`）。 */
export interface Assessment {
  decision: 'accept' | 'ignore' | 'unavailable'
  direction: AssessmentDirection
  ruleAssessments: RuleAssessment[]
  title?: string
  scope?: string
  reason: string
  intentEvidence?: string
  acknowledgement?: string
  worktreeName?: string
}

/** 评估只读 Policy 块的两件事：规则与 accept mode（版本由调用方核对，§K.5）。 */
export type AssessmentPolicy = Pick<PolicyBlock, 'rules' | 'acceptMode'>

/** 评估本身的固定拒绝码（§G.2 的 `eval-decide` 行）：都发生在写 Decision 之前。 */
export const ASSESSMENT_REFUSALS = ['invalid_assessment', 'incomplete_rules'] as const
export type AssessmentRefusalCode = (typeof ASSESSMENT_REFUSALS)[number]

/** 一次评估的结局：要么一个可执行的结果，要么一个固定拒绝（此时什么都不写）。 */
export type AssessmentResult =
  | { readonly ok: true; readonly outcome: AssessmentOutcome }
  | {
      readonly ok: false
      readonly code: AssessmentRefusalCode
      readonly message: string
      readonly values?: Readonly<Record<string, string>>
    }

/** 目标的三种依据。 */
const targetBasisSchema = enumOf(TARGET_BASES)

/** 方向载荷的严格形状（snake_case 线形状）。 */
const directionShape = object({
  implementation_requested: boolean(),
  target_basis: targetBasisSchema,
  requires_design_decision: boolean(),
  evidence: string().trim().min(1).max(700)
}).strict()

/** 一条规则判定：`rule_id` + `matched` + 事实理由。 */
const ruleAssessmentShape = object({
  rule_id: string().trim().min(1).max(80),
  matched: boolean(),
  reason: string().trim().min(1).max(500)
}).strict()

/** 一份评估载荷；标题/范围/证据/回执只在接受时被读，其余决策可不带。 */
const assessmentShape = object({
  decision: enumOf(['accept', 'ignore', 'unavailable'] as const),
  direction: directionShape,
  rule_assessments: array(ruleAssessmentShape),
  title: string().trim().min(1).max(200).optional(),
  scope: string().trim().min(1).max(1500).optional(),
  reason: string().trim().min(1).max(500),
  intent_evidence: string().trim().min(1).max(700).optional(),
  acknowledgement: string().trim().min(1).max(2000).optional(),
  worktree_name: string()
    .trim()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .min(3)
    .max(40)
    .optional()
}).strict()

/** 线形状（snake_case）→ 领域形状（camelCase）；只做改名，不改变值。 */
function directionOf(value: {
  implementation_requested: boolean
  target_basis: TargetBasis
  requires_design_decision: boolean
  evidence: string
}): AssessmentDirection {
  return {
    implementationRequested: value.implementation_requested,
    targetBasis: value.target_basis,
    requiresDesignDecision: value.requires_design_decision,
    evidence: value.evidence
  }
}

/** 领域形状的方向是否允许接受（§K.4 第 3 条的四要素之三）。 */
function directionPermits(direction: AssessmentDirection): boolean {
  return (
    direction.implementationRequested &&
    direction.targetBasis !== 'undetermined' &&
    !direction.requiresDesignDecision
  )
}

/**
 * 一条（线形状的）方向是否允许接受：请求实现、目标明确或既有标准、无待定设计决策。
 * 缺证据或形状不对都不是合法方向。
 */
export function directionAllowed(direction: unknown): direction is AssessmentDirection {
  const wire = directionShape.safeParse(direction)
  return wire.success && directionPermits(directionOf(wire.data))
}

/** 线形状（snake_case）→ 领域形状（camelCase）；只做改名，不改变值。 */
function assessmentOf(value: {
  decision: Assessment['decision']
  direction: {
    implementation_requested: boolean
    target_basis: TargetBasis
    requires_design_decision: boolean
    evidence: string
  }
  rule_assessments: { rule_id: string; matched: boolean; reason: string }[]
  title?: string
  scope?: string
  reason: string
  intent_evidence?: string
  acknowledgement?: string
  worktree_name?: string
}): Assessment {
  return {
    decision: value.decision,
    direction: directionOf(value.direction),
    ruleAssessments: value.rule_assessments.map((item) => ({
      ruleId: item.rule_id,
      matched: item.matched,
      reason: item.reason
    })),
    reason: value.reason,
    ...(value.title === undefined ? {} : { title: value.title }),
    ...(value.scope === undefined ? {} : { scope: value.scope }),
    ...(value.intent_evidence === undefined ? {} : { intentEvidence: value.intent_evidence }),
    ...(value.acknowledgement === undefined ? {} : { acknowledgement: value.acknowledgement }),
    ...(value.worktree_name === undefined ? {} : { worktreeName: value.worktree_name })
  }
}

/** 校验评估载荷的形状；失败时一次给出全部 issues（不是第一个）。 */
export function parseAssessment(value: unknown): SafeParse<Assessment> {
  const parsed = assessmentShape.safeParse(value)
  if (!parsed.success) return parsed
  return { success: true, data: assessmentOf(parsed.data) }
}

/** 把 issues 压成 `values` 的一个槽：固定错误码之外，只回字段路径与短句。 */
const issuesValue = (issues: readonly SchemaIssue[]): string =>
  issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')

/** 拒绝一份评估载荷的形状错误。 */
function invalid(value: unknown): Extract<AssessmentResult, { ok: false }> {
  const parsed = assessmentShape.safeParse(value)
  return {
    ok: false,
    code: 'invalid_assessment',
    message: 'The assessment is not the documented shape',
    ...(parsed.success ? {} : { values: { issues: issuesValue(parsed.issues) } })
  }
}

/** 拒绝一份规则判定不完整的评估；`values.rules` 列出问题所在。 */
function incomplete(problems: readonly string[]): Extract<AssessmentResult, { ok: false }> {
  return {
    ok: false,
    code: 'incomplete_rules',
    message: 'Exactly one assessment for every enabled rule is required',
    values: { rules: problems.join(', ') }
  }
}

/**
 * 完整性（§K.4 第 1 条）：每条启用规则恰好判定一次。返回问题列表，空表示通过。
 * 漏判、重判、判了停用或未知规则都算问题；顺序按启用规则表，便于人读。
 */
function completeness(
  judged: readonly RuleAssessment[],
  enabled: readonly Rule[]
): string[] {
  const problems: string[] = []
  const counts = new Map<string, number>()
  for (const item of judged) counts.set(item.ruleId, (counts.get(item.ruleId) ?? 0) + 1)
  const known = new Set(enabled.map((rule) => rule.id))
  for (const rule of enabled) {
    const count = counts.get(rule.id) ?? 0
    if (count === 0) problems.push(`${rule.id}: missing`)
    else if (count > 1) problems.push(`${rule.id}: judged ${count} times`)
  }
  for (const [id, count] of counts) {
    if (known.has(id)) continue
    problems.push(`${id}: not an enabled rule (${count} judgement${count === 1 ? '' : 's'})`)
  }
  return problems
}

/** 审计数据里的一条匹配：规则 id 与当时的事实理由。 */
interface Match {
  rule_id: string
  reason: string
}

/** 审计数据（面板与复盘读它）：每次判定、匹配子集、方向与证据。 */
function auditOf(
  assessment: Assessment,
  matches: readonly Match[]
): Record<string, unknown> {
  return {
    matches: [...matches],
    rule_assessments: assessment.ruleAssessments.map((item) => ({
      rule_id: item.ruleId,
      matched: item.matched,
      reason: item.reason
    })),
    direction: {
      implementation_requested: assessment.direction.implementationRequested,
      target_basis: assessment.direction.targetBasis,
      requires_design_decision: assessment.direction.requiresDesignDecision,
      evidence: assessment.direction.evidence
    },
    ...(assessment.intentEvidence === undefined
      ? {}
      : { intent_evidence: assessment.intentEvidence })
  }
}

/** 接受提案（观察模式的 would-accept 里给人看的那一份）。 */
function proposalOf(assessment: Assessment): Record<string, string> {
  return {
    title: assessment.title ?? '',
    scope: assessment.scope ?? '',
    ...(assessment.worktreeName === undefined ? {} : { worktree_name: assessment.worktreeName })
  }
}

/**
 * 把一份评估收成结局（§K.4）。`strength` 是候选的强度：显式请求不受 accept mode 约束，
 * 主动候选只在 `auto` 下接受，`observe` 记 would-accept，`off` 什么都不做。
 *
 * @returns `ok:false` 时是固定拒绝（`invalid_assessment` / `incomplete_rules`），调用方不得
 * 写任何 Decision；`ok:true` 时的 `outcome` 才交给 `Engine.decide`。
 */
export function assessmentOutcome(
  value: unknown,
  policy: AssessmentPolicy,
  strength: Strength
): AssessmentResult {
  const parsed = assessmentShape.safeParse(value)
  if (!parsed.success) return invalid(value)
  const assessment = assessmentOf(parsed.data)

  const enabled = policy.rules.filter((rule) => rule.enabled)
  const problems = completeness(assessment.ruleAssessments, enabled)
  if (problems.length) return incomplete(problems)

  const matches: Match[] = assessment.ruleAssessments
    .filter((item) => item.matched)
    .map((item) => ({ rule_id: item.ruleId, reason: item.reason }))
  const audit = auditOf(assessment, matches)

  // 非接受的决定不读方向与规则：ignore/unavailable 本身已经是结论。
  if (assessment.decision !== 'accept') {
    return { ok: true, outcome: { kind: assessment.decision, reason: assessment.reason, audit } }
  }
  // 方向未定（含糊或冲突）就先落 ignore：匹配到的规则不能替它成立。
  if (!directionPermits(assessment.direction)) {
    return {
      ok: true,
      outcome: { kind: 'ignore', reason: { code: 'directionUnsettled' }, audit }
    }
  }
  if (matches.length === 0) {
    return { ok: true, outcome: { kind: 'ignore', reason: { code: 'noRuleMatched' }, audit } }
  }
  // 接受还缺证据/标题/范围：是评估不合法，不是「忽略」。
  const { intentEvidence, title, scope } = assessment
  const missing = [
    ...(intentEvidence === undefined ? ['intent_evidence'] : []),
    ...(title === undefined ? ['title'] : []),
    ...(scope === undefined ? ['scope'] : [])
  ]
  if (missing.length || title === undefined || scope === undefined) {
    return {
      ok: false,
      code: 'invalid_assessment',
      message: 'An acceptance needs intent evidence, a title and a scope',
      values: { fields: missing.join(', ') }
    }
  }

  // 主动候选只在 auto 下接受；显式候选不受 accept mode 约束（§K.4 第 4 条）。
  if (strength === 'inferred' && policy.acceptMode !== 'auto') {
    if (policy.acceptMode === 'off') {
      return {
        ok: true,
        outcome: { kind: 'ignore', reason: { code: 'admissionIgnored' }, audit }
      }
    }
    return {
      ok: true,
      outcome: {
        kind: 'ignore',
        reason: { code: 'observed', values: { text: assessment.reason } },
        audit: { ...audit, would_accept: true, proposal: proposalOf(assessment) }
      }
    }
  }

  return {
    ok: true,
    outcome: {
      kind: 'accept',
      title,
      scope,
      reason: assessment.reason,
      ...(assessment.acknowledgement === undefined
        ? {}
        : { acknowledgement: assessment.acknowledgement }),
      rules: matches.map((match) => match.rule_id),
      audit,
      ...(assessment.worktreeName === undefined ? {} : { name: assessment.worktreeName })
    }
  }
}

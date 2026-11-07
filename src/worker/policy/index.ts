// Policy 模块的入口（§C.1 `policy/*`）：设置 schema、准入表、Gate、内容哈希版本、Mandate
// 复验与变更影响面。
//
// 依赖方向（§C.2）：`policy` 只 import `core`（领域类型）、`infra/schema.ts`（最小校验器）
// 与本目录；`sources` 可以 import 这里的类型（准入行），反向不允许。
export {
  ADMISSION_DEFAULTS,
  ADMISSION_OPTIONS,
  admissionCell,
  admissionOf
} from './admission.ts'
export type {
  Admission,
  AdmissionCellsConfig,
  AdmissionRow,
  AdmissionTableConfig,
  LocalizedText
} from './admission.ts'
export { DEFAULT_POLICY, validatePolicy } from './schema.ts'
export type {
  AllowedIdentity,
  BotIdentity,
  PolicyBlock,
  PolicyEval,
  PolicyKindView,
  PolicyValidationOptions,
  Rule,
  SourcePolicySection
} from './schema.ts'
export { createPolicy } from './gate.ts'
export { revalidateMandate } from './revalidate.ts'
export type { RevalidateContext } from './revalidate.ts'
export type { PolicyInputs } from './gate.ts'
export { POLICY_VERSION_LENGTH, policyContent, policyVersion } from './version.ts'
export { policyEffects } from './effects.ts'
export type { PolicyEffectsContext } from './effects.ts'
export { ASSESSMENT_REFUSALS, assessmentOutcome, directionAllowed, parseAssessment, TARGET_BASES } from './assessment.ts'
export type {
  Assessment,
  AssessmentDirection,
  AssessmentPolicy,
  AssessmentRefusalCode,
  AssessmentResult,
  RuleAssessment,
  TargetBasis
} from './assessment.ts'

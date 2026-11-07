// Policy 块（§K.1）的形状与严格校验（§K.8）：`{rules, acceptMode, sources, eval}`。
//
// 分工：
// - 本文件只回答「这份设置能不能存」：未知键、越界、类型错误都在写入前拒绝，错误以
//   `{issues:[{path,message}]}` 返回（`infra/schema.ts` 的 `SchemaIssue`），全有或全无；
// - 每个 Source 的部分里，`allowed` / `bots` / `admission` 是 Policy 自己的形状；其余键
//   （例如 Feishu 的 `syncChat`）属于该 kind，由它的 `policy.schema` 校验（`PolicyKindView.extras`）；
// - 跨块校验也在保存前做完（§K.8）：名单 id 去重（大小写不敏感）、`admission` 的行必须是该
//   kind 的 `policy.rows()` 声明过的接收 scope。`admission` 的键与 Feishu 的「已配置群 / other /
//   direct」是同一件事——行的来源就是 Source 的配置，所以它们由同一条检查覆盖。
//
// `version` 不在这里：它是内容哈希（§K.5，`version.ts`）；设置保存现算它并记进版本历史。
import { array, boolean, enumOf, number, object, record, string } from '../infra/schema.ts'
import type { SafeParse, SchemaIssue } from '../infra/schema.ts'
import type { AcceptMode } from '../core/index.ts'
import type { AdmissionRow, AdmissionTableConfig, LocalizedText } from './admission.ts'

/** 一条团队写的准入规则（§K.1 `Rule`）：id、名字、双语说明、是否启用。 */
export interface Rule {
  id: string
  name: string
  instruction: LocalizedText
  enabled: boolean
}

/** 名单上的一行：Source 自己的身份（GitHub login / Feishu open_id），可选显示名。 */
export interface AllowedIdentity {
  id: string
  name?: string
}

/** `bots` 名单的一行：可以提出推断候选的机器人身份。 */
export interface BotIdentity {
  id: string
}

/** 评估的设置（§K.1 `eval`）：模型可选，超时缺省 300 秒。 */
export interface PolicyEval {
  model?: string
  timeoutSeconds: number
}

/**
 * Policy 里属于一个 Source 的部分（§K.1）。kind 自有的键（Feishu 的 `syncChat` 这类）不在
 * 静态形状里：它们由该 kind 的 Policy schema 校验，读的时候按 `[key: string]` 取。
 */
export interface SourcePolicySection {
  allowed: AllowedIdentity[]
  bots: BotIdentity[]
  admission: AdmissionTableConfig
  [extra: string]: unknown
}

/** 一份完整的 Policy 块（不含内容哈希，见文件头）。 */
export interface PolicyBlock {
  rules: Rule[]
  acceptMode: AcceptMode
  sources: Record<string, SourcePolicySection>
  eval: PolicyEval
}

const localized = (maximum: number) =>
  object({
    zh: string().trim().min(1).max(maximum),
    en: string().trim().min(1).max(maximum)
  }).strict()

const ruleSchema = object({
  id: string().trim().regex(/^[A-Za-z0-9_-]{1,80}$/),
  name: string().trim().min(1).max(100),
  instruction: localized(2000),
  enabled: boolean()
}).strict()

const allowedSchema = object({
  id: string().trim().min(1).max(200),
  name: string().trim().min(1).max(100).optional()
}).strict()

const botSchema = object({ id: string().trim().min(1).max(200) }).strict()

/** 一格：取值集合与 `ADMISSION_OPTIONS` 同源（写在 `admission.ts`，这里只转成校验器）。 */
const admissionCellsSchema = object({
  listedUnaddressed: enumOf(['inferred', 'ignore'] as const).optional(),
  unlistedAddressed: enumOf(['explicit', 'inferred', 'ignore'] as const).optional(),
  unlistedUnaddressed: enumOf(['inferred', 'ignore'] as const).optional()
}).strict()

const sectionSchema = object({
  allowed: array(allowedSchema).default([]),
  bots: array(botSchema).default([]),
  admission: record(admissionCellsSchema).default({})
})

const evalSchema = object({
  model: string().trim().min(1).max(200).optional(),
  timeoutSeconds: number().int().min(30).max(600).default(300)
}).strict()

/**
 * 顶层块。`sources` 的每个值先按 Policy 自己的三个键校验；kind 自有的键在
 * `validatePolicy` 里交给该 kind（不做静默丢弃）。
 */
const blockSchema = object({
  rules: array(ruleSchema).default([]),
  acceptMode: enumOf(['off', 'observe', 'auto'] as const).default('observe'),
  sources: record(sectionSchema).default({}),
  eval: evalSchema.default({ model: undefined, timeoutSeconds: 300 })
}).strict()

/** 缺省 Policy：没有规则、observe 模式、没有 Source 部分、300 秒超时（§K.4 缺省 observe）。 */
export const DEFAULT_POLICY: PolicyBlock = blockSchema.parse({}) as PolicyBlock

/**
 * 一个已装 kind 能提供的东西：它的准入行（§I.1 `policy.rows()`）与它的 Policy 部分校验器。
 *
 * `extras` 的契约与 `sources/registry.ts` 的 `validatePolicy` 相同：拿到的是这个 kind 的 Policy
 * 部分去掉 `admission` 之后的值（`allowed` / `bots` 由 kind 的 schema 一并校验），返回该部分的
 * 其余字段。没有 `extras` 的 kind 不接受任何额外键。
 */
export interface PolicyKindView {
  rows(): readonly AdmissionRow[]
  extras?(section: Record<string, unknown>): SafeParse<Record<string, unknown>>
}

/** 校验时要问的 kind 表；未装的 kind 返回 undefined（它的部分原样保留）。 */
export interface PolicyValidationOptions {
  readonly kinds?: (source: string) => PolicyKindView | undefined
}

/** 一个值是不是普通对象（`null` 与数组不算）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 校验一份 Policy 块。成功返回带默认值的块；失败返回全部 issues（不是第一个错误），
 * 且**不返回**任何值——保存时因此可以「全有或全无」。
 */
export function validatePolicy(
  value: unknown,
  options: PolicyValidationOptions = {}
): SafeParse<PolicyBlock> {
  const base = blockSchema.safeParse(value)
  if (!base.success) return base
  const issues: SchemaIssue[] = []
  const rawSources = isRecord(value) && isRecord(value['sources']) ? value['sources'] : {}
  const sources: Record<string, SourcePolicySection> = {}

  // 规则 id 去重（§K.1 的规则列表按 id 引用）。
  const ruleIds = new Set<string>()
  base.data.rules.forEach((rule, index) => {
    if (ruleIds.has(rule.id)) {
      issues.push({ path: ['rules', index, 'id'], message: `duplicate id ${rule.id}` })
    }
    ruleIds.add(rule.id)
  })

  for (const [id, common] of Object.entries(base.data.sources)) {
    const kind = options.kinds?.(id)
    const raw = isRecord(rawSources[id]) ? rawSources[id] : {}
    let section: Record<string, unknown> = { ...common }

    if (kind !== undefined) {
      const { admission: _admission, ...rest } = raw
      const extras = kind.extras?.(rest)
      if (extras !== undefined) {
        if (extras.success) section = { ...section, ...extras.data }
        else {
          for (const issue of extras.issues) {
            issues.push({ path: ['sources', id, ...issue.path], message: issue.message })
          }
        }
      } else {
        // 没有自己的 schema：`allowed` / `bots` 是 Policy 自己的键，其余一律不收。
        for (const key of Object.keys(rest)) {
          if (key === 'allowed' || key === 'bots') continue
          issues.push({ path: ['sources', id, key], message: 'unknown key' })
        }
      }
      // 跨块（§K.8）：准入表的每一行必须是这个 kind 声明过的接收 scope。
      const rows = kind.rows()
      for (const row of Object.keys(common.admission)) {
        if (!rows.some((candidate) => candidate.id === row)) {
          issues.push({
            path: ['sources', id, 'admission', row],
            message: 'unknown receiving scope'
          })
        }
      }
    } else if (isRecord(rawSources[id])) {
      // 未装的 kind：它的部分原样保留（设置先行、kind 后装是正常状态）。
      const { admission: _admission, ...rest } = rawSources[id] as Record<string, unknown>
      section = { ...section, ...rest }
    }

    // 名单 id 去重：大小写不敏感（§K.8）。
    const seen = new Map<string, number>()
    const allowed = Array.isArray(section['allowed']) ? section['allowed'] : []
    allowed.forEach((entry, index) => {
      const identity = isRecord(entry) && typeof entry['id'] === 'string' ? entry['id'] : ''
      const wanted = identity.trim().toLowerCase()
      if (wanted.length === 0) return
      if (seen.has(wanted)) {
        issues.push({ path: ['sources', id, 'allowed', index, 'id'], message: `duplicate id ${identity}` })
      } else {
        seen.set(wanted, index)
      }
    })

    // SAFETY: `section` 起于已校验的三个公共键，之后只并入该 kind 自己的 strict schema 返回的
    // 键（Feishu 的 `syncChat` 这类）；必填键始终在，kind 自有键不在静态类型里，故只能断言。
    sources[id] = section as unknown as SourcePolicySection
  }

  if (issues.length) return { success: false, issues }
  return {
    success: true,
    data: {
      rules: base.data.rules,
      acceptMode: base.data.acceptMode,
      sources,
      eval: base.data.eval
    }
  }
}

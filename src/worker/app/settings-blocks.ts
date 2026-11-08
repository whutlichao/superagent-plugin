// 设置块的 schema 与校验（§K.8）：每个块一个 `strict()` 形状，未知键、越界、类型错误都拒绝，
// 错误以 `{issues:[{path,message}]}` 返回（400）。
//
// 这里的三个基块（`policy` / `eval` / `executor`）与 `source:<id>` 是 §G.2 的命令面写入口：
// `settings save --block <name>` 与面板的 Settings 页保存同一份值，所以形状只在这里定义一次。
// Policy 块与 Source 块的自有键由 Policy schema 与各 kind 的 schema 拥有（§I.1）——本模块只
// 把它们的 issues 接进同一份结果，绝不另写一份字段表。
//
// 依赖纪律（§C.2）：`app/` 可以 import `policy/`、`infra/schema.ts` 与 `core/` 的类型；
// 本模块不读存储、不跑子进程、不认识 HTTP。
import { array, boolean, enumOf, number, object, refine, string } from '../infra/schema.ts'
import type { SafeParse, SchemaIssue } from '../infra/schema.ts'
import { commitEmailShape } from './gitconfig-identity.ts'
import {
  ADMISSION_PAGE_LIMIT,
  ADMISSION_TIMEOUT_MAX_MS,
  ADMISSION_TIMEOUT_MIN_MS
} from '../sources/admission-context.ts'

/** 三个固定块的名字（`--block` 的候选，`source:<id>` 另算）。 */
export const BASE_SETTINGS_BLOCKS = ['policy', 'eval', 'executor', 'limits'] as const

/** 一个基块名。 */
export type SettingsBaseBlock = (typeof BASE_SETTINGS_BLOCKS)[number]

/** 机器限额块的名字（§M.3 Deployment 组）：唯一一处字面量，部署视图与写入器都读它。 */
export const MACHINE_LIMITS_BLOCK = 'limits' as const

/** 一个块名：策略块名，或 `source:<id>`。 */
export type SettingsBlockName = string

/**
 * `eval` 块（§K.7 的评估超时）：`timeoutSeconds` 是 §K.7 的 Eval 截止时间。全部可选——
 * 面板只提交改动的字段时其余保留。机器限额（语境页数与时限）不在这里：它们在 `limits` 块
 * （§M.3 Deployment 组），一个旋钮只有一个写者。
 */
export const EVAL_BLOCK_SCHEMA = object({
  timeoutSeconds: number().int().min(30).max(3_600).optional()
}).strict()

/**
 * 机器限额块（§M.3 Deployment 组、§H.12、§H.22、§L.6、§D.2 要点 5）：
 *
 * - `promptMaxChars`：保存的提示词配置总量上限（§L.6）；
 * - `admissionContextMaxPages` / `admissionContextTimeoutMs`：一次评估语境读取的页数与时限；
 * - `retention.days`：Trigger/Decision 等旧记录的保留天数。
 *
 * 四个都可选：面板只提交改动过的值，其余沿用缺省（200 000 / 10 / 15 000 / 90）。上下界就是
 * 运行时的上下界（`sources/admission-context.ts` 的常量），越界的值不能存进来。
 */
export const LIMITS_BLOCK_SCHEMA = object({
  promptMaxChars: number().int().min(1).max(2_000_000).optional(),
  admissionContextMaxPages: number().int().min(1).max(ADMISSION_PAGE_LIMIT).optional(),
  admissionContextTimeoutMs: number()
    .int()
    .min(ADMISSION_TIMEOUT_MIN_MS)
    .max(ADMISSION_TIMEOUT_MAX_MS)
    .optional(),
  retention: object({ days: number().int().min(1).max(3_650).optional() }).strict().optional()
}).strict()

/**
 * `executor` 块（§E.6、§E.11、§N.2）：worker 的模型、并发、命名、投递确认、准备命令与提交身份。
 * `baseRepo` 与 `githubCommitEmail` 是 setup 字段（§K.8）：只有面板与 operator 能改，值本身是
 * 一个选择器字符串 / 一个邮箱。邮箱允许空串（「还没配」，与 `repository` 同一口径），不允许
 * 把别的账号身份写进来——它是 agent 账号的 noreply 地址，不是人的邮箱。
 */
export const EXECUTOR_BLOCK_SCHEMA = object({
  agent: string().trim().min(1).max(200).optional(),
  model: string().trim().max(200).optional(),
  effort: string().trim().max(200).optional(),
  baseRepo: string().trim().max(500).optional(),
  baseBranch: string().trim().max(200).optional(),
  maxWorkers: number().int().min(1).max(16).optional(),
  branchPrefix: string().trim().max(100).optional(),
  inlineLimit: number().int().min(0).max(100_000).optional(),
  confirmDelivery: boolean().optional(),
  worktreeRetention: enumOf(['keep', 'on-end']).optional(),
  blockedCommands: array(string().trim().min(1).max(100)).optional(),
  prepare: string().max(4_000).optional(),
  // 形状与「保存之后现算」的那条 setup 结论共用一处判定：空串是「还没配」，其余必须像一个地址。
  githubCommitEmail: refine(
    string().trim().max(200),
    (value) => commitEmailShape(value) !== 'invalid',
    'expected an email address'
  ).optional()
}).strict()

/**
 * `executor` 块里**保存即生效**的字段（§N.2、§H.12）：提交邮箱由部署检查与部署事实现读，
 * 保存之后下一次检查就用新值。其余字段仍在启动时读一次（模型、并发、准备命令……），
 * 面板据 `executorRestartRequired()` 决定是否说「重启后生效」。
 */
export const EXECUTOR_LIVE_FIELDS: readonly string[] = ['githubCommitEmail']

/**
 * 这次 `executor` 块的保存是否还要重启才生效：比较两个块值里**除 `EXECUTOR_LIVE_FIELDS` 之外**
 * 的键（缺键按 `null` 算）。只改提交邮箱时是 `false`，改其余任一字段时是 `true`。
 */
export function executorRestartRequired(before: unknown, after: unknown): boolean {
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const left = record(before)
  const right = record(after)
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (EXECUTOR_LIVE_FIELDS.includes(key)) continue
    if (JSON.stringify(left[key] ?? null) !== JSON.stringify(right[key] ?? null)) return true
  }
  return false
}

/** 一个块的校验器：`SafeParse<unknown>`（与 `SettingsSaveInput.validate` 同形）。 */
export type BlockValidator = (value: unknown) => SafeParse<unknown>

/** 一个块名解析成「基块」或「Source 块」。 */
export type ParsedBlock =
  | { readonly kind: 'base'; readonly name: SettingsBaseBlock }
  | { readonly kind: 'source'; readonly id: string }

/** 把一个块名解析成基块或 `source:<id>`；认不出时 `undefined`（调用方按 `missing`/`invalid_value` 拒绝）。 */
export function parseSettingsBlock(name: string): ParsedBlock | undefined {
  if ((BASE_SETTINGS_BLOCKS as readonly string[]).includes(name)) {
    return { kind: 'base', name: name as SettingsBaseBlock }
  }
  const match = /^source:(.+)$/.exec(name)
  const id = match?.[1]?.trim()
  return id === undefined || id.length === 0 ? undefined : { kind: 'source', id }
}

/**
 * 一条 Source 设置块的形状：`{enabled, config}`。`config` 的键属于该 kind（§I.1），所以
 * 它的字段表由 kind 的 schema 拥有——这里只钉紧外层与路径前缀。
 */
function validateSourceBlock(
  value: unknown,
  validateConfig: BlockValidator | undefined
): SafeParse<{ readonly enabled: boolean; readonly config: Record<string, unknown> }> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { success: false, issues: [{ path: [], message: 'expected object' }] }
  }
  const input = value as Record<string, unknown>
  const issues: SchemaIssue[] = []
  for (const key of Object.keys(input)) {
    if (key !== 'enabled' && key !== 'config') issues.push({ path: [key], message: 'unknown key' })
  }
  const enabled = input['enabled'] === undefined ? true : input['enabled']
  if (typeof enabled !== 'boolean') issues.push({ path: ['enabled'], message: 'expected boolean' })
  const config = input['config'] === undefined ? {} : input['config']
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    issues.push({ path: ['config'], message: 'expected object' })
  }
  if (
    issues.length > 0 ||
    typeof enabled !== 'boolean' ||
    typeof config !== 'object' ||
    config === null ||
    Array.isArray(config)
  ) {
    return { success: false, issues }
  }
  const validated = validateConfig === undefined ? { success: true as const, data: config } : validateConfig(config)
  if (!validated.success) {
    return { success: false, issues: validated.issues.map((issue) => prefixed('config', issue)) }
  }
  if (typeof validated.data !== 'object' || validated.data === null || Array.isArray(validated.data)) {
    return { success: false, issues: [{ path: ['config'], message: 'expected object' }] }
  }
  return { success: true, data: { enabled, config: validated.data as Record<string, unknown> } }
}

/**
 * 校验一个设置块。`options.policy` 与 `options.sourceConfig` 由组合根给（Policy schema 与
 * kind 的 config schema，§I.1）：本模块不重复它们的字段表，只把 issues 拼进同一个结果。
 *
 * 返回 `undefined` 表示这个块名不存在——HTTP 层据此拒绝，不猜一个空形状。
 */
export function validateSettingsBlock(
  name: string,
  value: unknown,
  options: {
    readonly policy?: BlockValidator
    /** 一个 Source 的 config 校验器；Source 没注册或没有 schema 时按「任意 JSON 对象」收下。 */
    readonly sourceConfig?: (id: string) => BlockValidator | undefined
  } = {}
): SafeParse<unknown> | undefined {
  const block = parseSettingsBlock(name)
  if (block === undefined) return undefined
  if (block.kind === 'base') {
    if (block.name === 'policy') {
      // Policy 块的字段表与跨 Source 的 `extras` 在 `policy/schema.ts`；没有接线时按缺省块校验
      // （它仍然 strict，未知键照样拒绝）。
      return options.policy === undefined ? { success: true, data: value } : options.policy(value)
    }
    return block.name === 'eval'
      ? EVAL_BLOCK_SCHEMA.safeParse(value)
      : block.name === MACHINE_LIMITS_BLOCK
        ? LIMITS_BLOCK_SCHEMA.safeParse(value)
        : EXECUTOR_BLOCK_SCHEMA.safeParse(value)
  }
  const base = validateSourceBlock(value, options.sourceConfig?.(block.id))
  if (!base.success) return base
  return { success: true, data: base.data }
}

/** 把一条 issue 的路径放到 `prefix` 之下（Source 的 config 校验用）。 */
function prefixed(prefix: string, issue: SchemaIssue): SchemaIssue {
  return { path: [prefix, ...issue.path], message: issue.message }
}

/** 一个值里出现的账号类字段（`cli` / `repository`，§K.8）：写前要跑 #44 的 setup 检查。 */
export interface AccountCandidates {
  readonly cli?: string
  readonly repository?: string
}

/**
 * 递归找出一个设置块的值里出现的账号类字段（`cli`、`repository`；嵌在 `config` 里也算）。
 * 只取第一个出现的字符串值：一个块里不该出现两份相互矛盾的同名字段，而校验已经保证
 * 值是字符串（`source:<id>` 的 config 由 kind 的 strict schema 把关）。
 */
export function accountCandidatesIn(value: unknown): AccountCandidates {
  const found: { cli?: string; repository?: string } = {}
  const walk = (item: unknown): void => {
    if (Array.isArray(item)) {
      for (const entry of item) walk(entry)
      return
    }
    if (typeof item !== 'object' || item === null) return
    for (const [key, entry] of Object.entries(item)) {
      if ((key === 'cli' || key === 'repository') && typeof entry === 'string' && entry.trim() !== '') {
        if (found[key] === undefined) found[key] = entry.trim()
        continue
      }
      walk(entry)
    }
  }
  walk(value)
  return found
}

/** 一个块的值里有没有账号类字段（与 `accountCandidatesIn` 同一判定）。 */
export function hasAccountCandidates(value: unknown): boolean {
  const candidates = accountCandidatesIn(value)
  return candidates.cli !== undefined || candidates.repository !== undefined
}

/** 需要重启插件才生效的 setup 字段（§H.12）：只有 `stateDir` 一项。 */
export const RESTART_SETUP_FIELDS: readonly string[] = ['stateDir']

// 设置页的读模型（§M.3、§K.8）：把版本化块、Source kind 的字段表、准入行与部署事实拼成
// 面板的一份读数。面板不 import worker（§C.2 规则 3），所以形状只在 `panel/protocol.ts` 声明，
// 本文件只做映射——不读库、不跑子进程、不认识 HTTP。
//
// 三件事在这里只发生一次：
// - **字段表**：Source 的 `Field` 原样映射成面板的 `SettingsField`（Sources 组与 Eval 组的
//   「On each Source」共用同一套控件）；
// - **准入表**：行的三格可用性来自 `rows()`（只有 receive-all 的 scope 才有未点名的格子），
//   格子的值已按「配置 → 缺省」填好，面板不用再记一份缺省表；
// - **生效的设置快照**：宿主设置 + 保存过的 `limits` / `executor` 块（`withSavedSettings`）。
//   写面仍是 `app/settings.ts` 的唯一写入器，这里只决定「读的时候谁优先」。
import type {
  AdmissionCellView,
  AdmissionRowView,
  EvalGroupView,
  ExecutionGroupView,
  ExecutionValues,
  LimitsGroupView,
  PolicyRuleView,
  SettingsBlockSaved,
  SettingsFact,
  SettingsField,
  SettingsFieldColumn,
  SettingsHistoryRow,
  SettingsHistoryView,
  SettingsPageView,
  SettingsSourceState,
  SettingsText,
  SourcePolicyView,
  SourceSettingsCard,
  SourcesGroupView
} from '../../panel/protocol'
import { ADMISSION_DEFAULTS, ADMISSION_OPTIONS, admissionOf } from '../policy/admission.ts'
import type { AdmissionRow } from '../policy/admission.ts'
import type { PolicyBlock, Rule, SourcePolicySection } from '../policy/schema.ts'
import type { Fact, Field, FieldColumn, Localized } from '../sources/kind.ts'
import type { SourceOverview } from '../sources/registry.ts'
import { withMachineLimits } from './limits.ts'

/** 一段双语文本的映射（kind 的 `Localized` 与协议里的 `SettingsText` 同形）。 */
function words(value: Localized): SettingsText {
  return { zh: value.zh, en: value.en }
}

/** 事实的值：字符串原样，双语文本映射（`facts()` 的两种形态）。 */
function factValue(value: Localized | string): SettingsText | string {
  return typeof value === 'string' ? value : words(value)
}

/** 一列（`FieldColumn` → 面板的形状）。 */
function columnOf(column: FieldColumn): SettingsFieldColumn {
  if (column.type === 'select') {
    return {
      key: column.key,
      type: 'select',
      label: words(column.label),
      ...(column.hint === undefined ? {} : { hint: words(column.hint) }),
      options: column.options.map((option) => ({ value: option.value, label: words(option.label) }))
    }
  }
  return {
    key: column.key,
    type: 'text',
    label: words(column.label),
    ...(column.hint === undefined ? {} : { hint: words(column.hint) }),
    ...(column.pattern === undefined ? {} : { pattern: column.pattern }),
    ...(column.readonly === undefined ? {} : { readonly: column.readonly }),
    ...(column.optional === undefined ? {} : { optional: column.optional }),
    ...(column.choose === undefined ? {} : { choose: words(column.choose) }),
    ...(column.refresh === undefined ? {} : { refresh: words(column.refresh) })
  }
}

/** 一个字段（`Field` → 面板的形状）。 */
export function fieldOf(field: Field): SettingsField {
  const base = {
    key: field.key,
    label: words(field.label),
    ...(field.hint === undefined ? {} : { hint: words(field.hint) }),
    ...(field.advanced === undefined ? {} : { advanced: field.advanced })
  }
  switch (field.type) {
    case 'switch':
      return { ...base, type: 'switch' }
    case 'select':
      return {
        ...base,
        type: 'select',
        options: field.options.map((option) => ({ value: option.value, label: words(option.label) }))
      }
    case 'number':
      return { ...base, type: 'number', min: field.min, max: field.max }
    case 'text':
      return {
        ...base,
        type: 'text',
        ...(field.pattern === undefined ? {} : { pattern: field.pattern }),
        ...(field.readonly === undefined ? {} : { readonly: field.readonly }),
        ...(field.choose === undefined ? {} : { choose: words(field.choose) })
      }
    case 'fact':
      return { ...base, type: 'fact', ...(field.settings === undefined ? {} : { settings: field.settings }) }
    case 'rows':
      return { ...base, type: 'rows', columns: field.columns.map(columnOf) }
  }
}

/** 一条事实（`Fact` → 面板的形状）。 */
function factOf(fact: Fact): SettingsFact {
  return { key: fact.key, value: factValue(fact.value) }
}

/** 一个块的保存记录 → 面板的「已保存」读数（没存过是 `null`）。 */
export function savedBlockOf(
  record: { readonly revision: number; readonly at: string; readonly origin: string; readonly policyVersion: string | null } | undefined
): SettingsBlockSaved | null {
  if (record === undefined) return null
  return {
    revision: record.revision,
    at: record.at,
    origin: record.origin as SettingsBlockSaved['origin'],
    policyVersion: record.policyVersion
  }
}

/**
 * 生效的设置快照（读面）：宿主设置 + 保存过的块。
 * - `limits`（§M.3 Deployment 组的四个旋钮）叠在平铺键上；
 * - `executor`（Execution 组）按块合并——`agent` / `baseRepo` 因此可以只在块里写，也仍然
 *   尊重 Orca Settings 里那两项（`resolveExecutorSettings` 先读块、再回落顶层的宿主设置）。
 */
export function withSavedSettings(
  hostSettings: Readonly<Record<string, unknown>>,
  saved: { readonly limits?: unknown; readonly executor?: unknown }
): Readonly<Record<string, unknown>> {
  const withLimits = withMachineLimits(hostSettings, saved.limits)
  const executor =
    typeof saved.executor === 'object' && saved.executor !== null
      ? (saved.executor as Record<string, unknown>)
      : undefined
  if (executor === undefined || Object.keys(executor).length === 0) return withLimits
  const host = typeof withLimits['executor'] === 'object' && withLimits['executor'] !== null
    ? (withLimits['executor'] as Record<string, unknown>)
    : {}
  return { ...withLimits, executor: { ...host, ...executor } }
}

/** 一个 Source 实例的卡片输入：注册表的读数 + 它自己的块。 */
export interface SettingsSourceInput {
  readonly overview: SourceOverview
  readonly description: SettingsText
  readonly enabled: boolean
  readonly config: Record<string, unknown>
  readonly fields: readonly Field[]
  readonly facts: readonly Fact[]
  readonly syncable: boolean
  readonly revision: number
}

/** Eval 组「On each Source」的输入：Policy 的这部分 + kind 声明的准入行。 */
export interface SettingsPolicySourceInput {
  readonly source: string
  readonly title: SettingsText
  readonly section: SourcePolicySection
  readonly fields: readonly Field[]
  readonly rows: readonly AdmissionRow[]
  readonly syncable: boolean
}

/** 读模型的输入（组合根把值装配好；本文件不读库）。 */
export interface SettingsViewInput {
  /** 全局设置修订号（`settings-revision`）。 */
  readonly revision: number
  readonly sources: readonly SettingsSourceInput[]
  readonly eval: {
    readonly revision: number
    readonly saved: SettingsBlockSaved | null
    /** 生效的 Policy 内容哈希（§K.5）。 */
    readonly policyVersion: string
    readonly block: PolicyBlock
    readonly sources: readonly SettingsPolicySourceInput[]
  }
  readonly execution: {
    readonly revision: number
    readonly saved: SettingsBlockSaved | null
    readonly value: ExecutionValues
  }
  readonly repos: readonly { readonly value: string; readonly label: string }[]
  /** prepare 插入菜单的白名单变量（§E.11）。 */
  readonly variables: readonly string[]
  readonly limits: {
    readonly revision: number
    readonly saved: SettingsBlockSaved | null
    readonly value: LimitsGroupView['value']
  }
}

/** 一个实例的六档生命周期 → 面板的取值（两处同名，这里只是转出）。 */
function sourceState(overview: SourceOverview): SettingsSourceState {
  return overview.state
}

/** 一张 Source 卡（Sources 组）。 */
function sourceCard(input: SettingsSourceInput): SourceSettingsCard {
  return {
    block: `source:${input.overview.id}`,
    id: input.overview.id,
    kind: input.overview.kind,
    title: input.overview.title,
    description: input.description,
    state: sourceState(input.overview),
    enabled: input.enabled,
    ...(input.overview.configError === undefined ? {} : { configError: input.overview.configError }),
    config: input.config,
    fields: input.fields.map(fieldOf),
    facts: input.facts.map(factOf),
    syncable: input.syncable,
    revision: input.revision
  }
}

/** 一条规则（Policy → 面板）：顺序即存储顺序（规则没有优先级，§K.4）。 */
function ruleOf(rule: Rule): PolicyRuleView {
  return {
    id: rule.id,
    name: rule.name,
    instruction: words(rule.instruction),
    enabled: rule.enabled
  }
}

/** 准入表的一格：可用性来自该行，值已按「配置 → 缺省」把缺省填好。 */
function cellOf(input: {
  readonly cell: AdmissionCellView['cell']
  readonly row: AdmissionRow
  readonly table: SourcePolicySection['admission']
}): AdmissionCellView {
  const { cell, row, table } = input
  return {
    cell,
    available: row.cells[cell],
    value: admissionOf({ table, rows: [row], row: row.id, cell }),
    default: ADMISSION_DEFAULTS[cell],
    options: ADMISSION_OPTIONS[cell]
  }
}

/** 准入表的一行：标签、旁注与三格。 */
function admissionRowOf(row: AdmissionRow, table: SourcePolicySection['admission']): AdmissionRowView {
  const label: SettingsText = typeof row.label === 'string' ? { zh: row.label, en: row.label } : words(row.label)
  return {
    id: row.id,
    label,
    note: words(row.note),
    cells: (['listedUnaddressed', 'unlistedAddressed', 'unlistedUnaddressed'] as const).map((cell) =>
      cellOf({ cell, row, table })
    )
  }
}

/** 一个 Source 的 Policy 部分（Eval 组的「On each Source」）。 */
function policySourceOf(input: SettingsPolicySourceInput): SourcePolicyView {
  const { allowed, bots, admission, ...extras } = input.section
  // 字段表与值成对：`allowed` / `bots` 是行编辑器，自有键（`syncChat` 等）是标量控件；
  // 面板只用一套 `Fields` 渲染它们，不在页面里为某个 Source 写特例。
  const fields = input.fields
    .filter((field) => field.key === 'allowed' || field.key === 'bots' || field.key in extras)
    .map(fieldOf)
  return {
    source: input.source,
    title: input.title,
    fields,
    values: { allowed, bots, ...extras } as Record<string, unknown>,
    admission: input.rows.map((row) => admissionRowOf(row, admission)),
    syncable: input.syncable
  }
}

/** Sources 组。 */
export function sourcesGroupView(sources: readonly SettingsSourceInput[]): SourcesGroupView {
  return { instances: sources.map(sourceCard) }
}

/** Eval 组。 */
export function evalGroupView(input: SettingsViewInput['eval']): EvalGroupView {
  const { block } = input
  return {
    block: 'policy',
    revision: input.revision,
    saved: input.saved,
    policyVersion: input.policyVersion,
    acceptMode: block.acceptMode,
    model: block.eval.model ?? '',
    timeoutSeconds: block.eval.timeoutSeconds,
    rules: block.rules.map(ruleOf),
    sources: input.sources.map(policySourceOf)
  }
}

/** Execution 组。 */
export function executionGroupView(
  input: SettingsViewInput['execution'],
  repos: readonly { readonly value: string; readonly label: string }[],
  variables: readonly string[]
): ExecutionGroupView {
  return {
    block: 'executor',
    revision: input.revision,
    saved: input.saved,
    value: input.value,
    repos,
    variables
  }
}

/**
 * 一份设置页读数（§M.3）：四个可编辑组。`repos` 与变量表是组装的输入，分别落到 Execution 组
 * （base repo 选择与 prepare 的插入菜单）。
 */
export function settingsPageView(input: SettingsViewInput): SettingsPageView {
  return {
    revision: input.revision,
    sources: sourcesGroupView(input.sources),
    eval: evalGroupView(input.eval),
    execution: executionGroupView(input.execution, input.repos, input.variables),
    limits: {
      block: 'limits',
      revision: input.limits.revision,
      saved: input.limits.saved,
      value: input.limits.value
    }
  }
}

/** 历史读数（新→旧）：每一版的值与（Policy 块的）受影响 Ticket。 */
export function settingsHistoryView(
  revision: number,
  rows: readonly SettingsHistoryRow[]
): SettingsHistoryView {
  return { revision, history: rows }
}

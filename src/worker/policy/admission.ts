// 准入表（§K.1 `AdmissionCells`、§K.2 第 4 条）：每个接收 scope 一行，三个格子回答
// 「这个人在这个 scope、这样说话，能不能发起工作」。
//
// 三条纪律：
// - 格子只有三种取值：`explicit` / `inferred` / `ignore`。强度只有前两种；`ignore` 不是强度，
//   是**不产生候选**（§K.2 末段）；
// - 每格能取什么值是固定的（`ADMISSION_OPTIONS`）：未点名的消息不可能成为显式请求，所以
//   `listedUnaddressed` / `unlistedUnaddressed` 里没有 `explicit`；
// - 缺省值复现「有表之前」的行为（上游同名常量）：名单内未点名 = 推断，其余 = 不看。
//
// `AdmissionRow.cells` 是**行自己声明的可用性**（§I.1、§I.2 的准入行）：收全部的 Source 才
// 有未点名的格子；只收点名时，只有 addressed 那一格说话（票面验收「准入表只对 receive-all
// 可用」）。不可用的格子一律按 `ignore` 读，配置值留给以后打开 receive-all 时用。
import type { AdmissionCell } from '../core/index.ts'

/** 一张表能给出的三种判定。 */
export type Admission = 'explicit' | 'inferred' | 'ignore'

/** 每个格子允许的取值（顺序即面板里的选项顺序，§K.1）。 */
export const ADMISSION_OPTIONS: { readonly [C in AdmissionCell]: readonly Admission[] } = {
  listedUnaddressed: ['inferred', 'ignore'],
  unlistedAddressed: ['explicit', 'inferred', 'ignore'],
  unlistedUnaddressed: ['inferred', 'ignore']
}

/** 没有配置时的判定，与上游 `ADMISSION_DEFAULTS` 相同（有表之前的行为）。 */
export const ADMISSION_DEFAULTS: Readonly<Record<AdmissionCell, Admission>> = {
  listedUnaddressed: 'inferred',
  unlistedAddressed: 'ignore',
  unlistedUnaddressed: 'ignore'
}

/** 双语文案的最小形状（与 `sources/kind.ts` 的 `Localized` 结构相同；policy 不 import sources）。 */
export interface LocalizedText {
  zh: string
  en: string
}

/** 一行接收 scope：id（与 `SourceScope.scope().row` 对应）、标签、旁注与三个格子的可用性。 */
export interface AdmissionRow {
  readonly id: string
  readonly label: LocalizedText | string
  readonly note: LocalizedText
  readonly cells: { readonly [C in AdmissionCell]: boolean }
}

/** 一行已配置的格子：只写要偏离缺省值的那些。 */
export interface AdmissionCellsConfig {
  listedUnaddressed?: 'inferred' | 'ignore'
  unlistedAddressed?: Admission
  unlistedUnaddressed?: 'inferred' | 'ignore'
}

/** 一张准入表：行 id → 格子配置（行 id 必须由 kind 的 `rows()` 声明）。 */
export type AdmissionTableConfig = Record<string, AdmissionCellsConfig>

/**
 * 发送者落在哪个格子：名单内 + 已点名**没有**格子——那是显式请求（§K.2 第 2 条），表不参与。
 * 其余三种组合各一格。
 */
export function admissionCell(allowed: boolean, addressed: boolean): AdmissionCell | undefined {
  if (allowed) return addressed ? undefined : 'listedUnaddressed'
  return addressed ? 'unlistedAddressed' : 'unlistedUnaddressed'
}

/**
 * 读出某一格的判定：行的可用性优先（不可用即 `ignore`），其次配置值，最后缺省值。
 * `row` 是 `SourceScope.scope()` 给的行名；没有行时只用缺省值（与上游一致）。
 */
export function admissionOf(input: {
  readonly table?: AdmissionTableConfig | undefined
  readonly rows?: readonly AdmissionRow[] | undefined
  readonly row?: string | undefined
  readonly cell: AdmissionCell
}): Admission {
  const { table, rows, row, cell } = input
  if (row !== undefined) {
    const declared = rows?.find((candidate) => candidate.id === row)
    if (declared !== undefined && !declared.cells[cell]) return 'ignore'
  }
  return (row === undefined ? undefined : table?.[row]?.[cell]) ?? ADMISSION_DEFAULTS[cell]
}

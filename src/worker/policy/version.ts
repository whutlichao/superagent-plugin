// Policy 版本（§K.5）：内容哈希，不含 Source 的监听配置——配置决定「什么进入系统」，
// Policy 决定「谁能授权」。所以参与哈希的只有三样：规则、accept mode、每个 Source 的
// 允许名单 / bots / 准入表；`eval` 的模型与超时也不参与（它们改变评估多久算超时，
// 不改变谁能发起工作）。
//
// 为什么要规范化而不是直接 `JSON.stringify(block)`（逐条都是「同一套授权 → 同一个版本」）：
// - Source 的键序、名单的行序不是授权语义（§K.8 的名单比较大小写不敏感），先排序；
// - 名单 id 的大小写不是内容（`Alice` 与 `alice` 是同一个身份），统一成小写；显示名照原样；
// - 准入格里「写出来的缺省值」与「省略」是同一套判定（`ADMISSION_DEFAULTS`），先按缺省值
//   解析再入哈希。行/格的可用性来自 Source 的配置，不属于 Policy 块，故不解析。
//
// 版本因此是**可复现的**：同一份授权内容在任何一次保存、任何一个进程里都得到同一个串。
import { createHash } from 'node:crypto'
import { ADMISSION_DEFAULTS } from './admission.ts'
import type { AdmissionTableConfig } from './admission.ts'
import type { AdmissionCell } from '../core/index.ts'
import type { PolicyBlock, Rule, SourcePolicySection } from './schema.ts'

/** 版本串的长度：sha256 的前 12 位十六进制（§K.5）。 */
export const POLICY_VERSION_LENGTH = 12

/**
 * 哈希输入的 JSON 形状（受控的递归别名，与 `http/routes.ts` 的 `BodyValue` 同读法）：
 * `policyContent` 的返回值只由它组成，`JSON.stringify` 因此没有意外形态。
 */
type HashContent =
  | string
  | number
  | boolean
  | null
  | readonly HashContent[]
  | { readonly [key: string]: HashContent }

/** 三种格子的固定顺序（哈希里的键序也要固定，不能跟着写的顺序走）。 */
const CELLS: readonly AdmissionCell[] = ['listedUnaddressed', 'unlistedAddressed', 'unlistedUnaddressed']

/** 名字的比较键：去空白、小写（与 `§K.8` 的名单去重同一读法）。 */
const identityKey = (id: string): string => id.trim().toLowerCase()

/** 一条规则进哈希的形状（顺序由调用方按 id 排好）。 */
function ruleContent(rule: Rule): HashContent {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    instruction: { zh: rule.instruction.zh, en: rule.instruction.en }
  }
}

/** 一张准入表进哈希的形状：行按 id 排序，每行的三格按固定顺序并解析缺省值。 */
function admissionContent(table: AdmissionTableConfig): HashContent {
  return Object.keys(table)
    .sort((a, b) => a.localeCompare(b))
    .map((row): HashContent => {
      const cells = table[row] ?? {}
      return [row, CELLS.map((cell): HashContent => [cell, cells[cell] ?? ADMISSION_DEFAULTS[cell]])]
    })
}

/** 一个 Source 的 Policy 部分进哈希的形状：只取 Policy 自己的三个键（kind 自有的键不算）。 */
function sourceContent(section: SourcePolicySection): HashContent {
  return {
    allowed: section.allowed
      .map((entry): HashContent => ({ id: identityKey(entry.id), name: entry.name ?? null }))
      .sort((a, b) => String((a as { id: string }).id).localeCompare(String((b as { id: string }).id))),
    bots: section.bots
      .map((entry): HashContent => ({ id: identityKey(entry.id) }))
      .sort((a, b) => String((a as { id: string }).id).localeCompare(String((b as { id: string }).id))),
    admission: admissionContent(section.admission)
  }
}

/**
 * 参与版本哈希的内容（§K.5 的 `{rules, acceptMode, sources: {…}}`，规范化之后）。
 * 单独导出是给审计与测试读的：哈希输入不是秘密，隐藏它反而让「为什么版本变了」无从回答。
 */
export function policyContent(block: PolicyBlock): HashContent {
  return {
    rules: [...block.rules].sort((a, b) => a.id.localeCompare(b.id)).map(ruleContent),
    acceptMode: block.acceptMode,
    sources: Object.keys(block.sources)
      .sort((a, b) => a.localeCompare(b))
      .map((id): HashContent => [id, sourceContent(block.sources[id] as SourcePolicySection)])
  }
}

/**
 * 一份 Policy 块的版本：`sha256(JSON.stringify(policyContent(block)))` 的前 12 位（§K.5）。
 * 内容不变 → 版本不变；监听配置变化 → 版本不变；规则/名单/准入/accept mode 变化 → 版本必变。
 */
export function policyVersion(block: PolicyBlock): string {
  return createHash('sha256')
    .update(JSON.stringify(policyContent(block)))
    .digest('hex')
    .slice(0, POLICY_VERSION_LENGTH)
}

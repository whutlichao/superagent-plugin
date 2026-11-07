// 名单与规则的三处共用读法（§K.2、§K.3）：Gate、Mandate 复验与变更影响面都用它们，
// 免得同一件事（「这个人在名单上吗」「这条规则还启用吗」）在三处各写一遍、各有一套大小写
// 规则。本文件不依赖 Gate，也不做判定，只回答事实。
import type { PolicyBlock, SourcePolicySection } from './schema.ts'

/** 一个 Source 的 Policy 部分；没配时是空名单、空 bot 名单、空表。 */
export function sectionOf(block: PolicyBlock, source: string): SourcePolicySection {
  return block.sources[source] ?? { allowed: [], bots: [], admission: {} }
}

/** Source 自己的身份空间里的键：去空白、小写（与 GitHub login 一致，§K.8）。 */
export const identityKey = (id: string): string => id.trim().toLowerCase()

/** 在 Source 自己的身份空间里找名单项（大小写不敏感）。 */
export function allowedSender(
  section: SourcePolicySection,
  id: string
): SourcePolicySection['allowed'][number] | undefined {
  const wanted = identityKey(id)
  if (wanted.length === 0) return undefined
  return section.allowed.find((entry) => identityKey(entry.id) === wanted)
}

/** 在 `bots` 名单里找一行。 */
export function listedBot(
  section: SourcePolicySection,
  id: string
): SourcePolicySection['bots'][number] | undefined {
  const wanted = identityKey(id)
  if (wanted.length === 0) return undefined
  return section.bots.find((entry) => identityKey(entry.id) === wanted)
}

/** 名单项的显示名：没有 `name` 时用 id。 */
export function senderName(entry: { id: string; name?: string }): string {
  const name = entry.name ?? ''
  return name.length > 0 ? name : entry.id
}

/** 这些规则是否全部仍存在且启用（`enabled` 是唯一开关；未知 id 视为不再适用）。 */
export function rulesEnabled(block: PolicyBlock, rules: readonly string[]): boolean {
  return rules.every((id) => block.rules.some((rule) => rule.enabled && rule.id === id))
}

/**
 * 一条推断候选此刻还能不能被接受（§K.4）：auto 模式、至少一条匹配规则、且全部仍启用。
 * 与 `revalidate` 的推断检查同源，区别只在「至少一条」——accept 要求它，复验面对的是已经
 * 匹配过的 Mandate。
 */
export function admitsInferred(block: PolicyBlock, rules: readonly string[]): boolean {
  if (block.acceptMode !== 'auto' || rules.length === 0) return false
  return rulesEnabled(block, rules)
}

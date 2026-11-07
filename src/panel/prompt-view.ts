// Prompts 组的纯函数（§M.3、§L.3、§L.4、§L.6）：草稿与「已保存」的差异、技能路径、以及把
// worker 的固定拒绝码翻成一句可读的话。
//
// 面板不重算 worker 的规则：这里只回答面板自己的问题——「这一段与内置正文不同吗」「技能文件
// 在哪」「拒绝码对应哪句话」。占位符、技能名与体量上限的判定全在 worker（`app/prompts.ts`），
// 面板只显示 `issues[]`（与设置块保存被拒时同一口径）。
//
// 面板侧纯函数：不 import `orca`，不 import worker（§C.2 规则 3），不碰 I/O。
import { translate } from './copy'
import type {
  PanelPromptConfig,
  PanelPromptIssue,
  PanelPromptPart,
  PromptTeamSection,
  PanelPromptTexts
} from './protocol'

/** 技能目录名（与 worker 的 `SKILLS_DIR` 同一个约定；面板不写文件，只显示路径）。 */
const SKILLS_DIR = 'skills'

/** 技能文件名（§L.6：`<stateDir>/skills/<name>/SKILL.md`）。 */
const SKILL_FILE_NAME = 'SKILL.md'

/**
 * 一个技能文件的绝对路径。约定与 worker 的 `skillFilePath` 同一份（§L.6）——面板不能 import
 * worker（§C.2 规则 3），所以这条约定在两处各写一次，两边都只做字符串拼接、没有别的规则。
 */
export function skillPath(stateDir: string, name: string): string {
  return `${stateDir}/${SKILLS_DIR}/${name}/${SKILL_FILE_NAME}`
}

/** 一个分片当前的正文：override 优先，团队段其次，否则跟随内置正文。 */
export function partText(config: PanelPromptConfig, part: PanelPromptPart): string {
  const override = config.overrides?.[part.key]
  if (override !== undefined) return override.text
  if (part.kind === 'team') {
    const section = part.key.slice('team/'.length) as PromptTeamSection
    const text = config.team?.[section]
    if (text !== undefined) return text
  }
  return part.text
}

/** 这一段被改过吗（§M.3 的「已修改」标记：与内置正文逐字不同）。 */
export function partChanged(config: PanelPromptConfig, part: PanelPromptPart): boolean {
  return partText(config, part) !== part.text
}

/** 被改过的分片键，按注册表的顺序（面板的标记与计数都读它）。 */
export function changedParts(
  config: PanelPromptConfig,
  parts: readonly PanelPromptPart[]
): readonly string[] {
  return parts.filter((part) => partChanged(config, part)).map((part) => part.key)
}

/** 一份配置的团队三段（缺的补空串，渲染与 diff 都不用再判空）。 */
export function teamText(config: PanelPromptConfig, section: PromptTeamSection): string {
  return config.team?.[section] ?? ''
}

/**
 * 一份配置去掉一个字段。空字段必须真的**没有**这个键：`{ team: {} }` 与 `{}` 在保存时等价，
 * 但面板的「草稿」与保存载荷按逐字比较，留着空壳会让 `changed` 与 diff 都多一次假改动。
 */
function omit<K extends keyof PanelPromptConfig>(
  config: PanelPromptConfig,
  key: K
): PanelPromptConfig {
  const next: PanelPromptConfig = { ...config }
  delete next[key]
  return next
}

/** 改一段团队文本；写回空串等于「这一段没改」（保存时 worker 也不留空段）。 */
export function setTeamText(
  config: PanelPromptConfig,
  section: PromptTeamSection,
  text: string
): PanelPromptConfig {
  const team: Partial<Record<PromptTeamSection, string>> = { ...config.team }
  if (text.trim() === '') delete team[section]
  else team[section] = text
  return Object.keys(team).length === 0 ? omit(config, 'team') : { ...config, team }
}

/** 写一条 override（正文 + 它编辑自的内置键；键让「内置变了」可判，§L.4）。 */
export function setOverride(
  config: PanelPromptConfig,
  key: string,
  text: string,
  base: string
): PanelPromptConfig {
  const overrides = { ...config.overrides }
  if (text.trim() === '') delete overrides[key]
  else overrides[key] = { text, base }
  return Object.keys(overrides).length === 0 ? omit(config, 'overrides') : { ...config, overrides }
}

/** 去掉一段的 override（「用默认」）：之后这一段跟随内置文本与它的更新。 */
export function clearPart(config: PanelPromptConfig, part: PanelPromptPart): PanelPromptConfig {
  const overrides = { ...config.overrides }
  delete overrides[part.key]
  const next = Object.keys(overrides).length === 0 ? omit(config, 'overrides') : { ...config, overrides }
  if (part.kind !== 'team') return next
  const section = part.key.slice('team/'.length) as PromptTeamSection
  return setTeamText(next, section, '')
}

/** 新增或改写一个团队技能（保存时 worker 校验名字与正文，§L.6）。 */
export function setSkill(config: PanelPromptConfig, name: string, text: string): PanelPromptConfig {
  const skills: Record<string, string> = { ...config.skills }
  skills[name] = text
  return { ...config, skills }
}

/** 删掉一个团队技能（保存后 worker 会连同它的目录一起删，§L.6）。 */
export function removeSkill(config: PanelPromptConfig, name: string): PanelPromptConfig {
  const skills: Record<string, string> = { ...config.skills }
  delete skills[name]
  return Object.keys(skills).length === 0 ? omit(config, 'skills') : { ...config, skills }
}

/** ASCII 名的稳定顺序（技能名只允许 `[a-z0-9-]`，所以与语言无关）。 */
function byName(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}

/** 一份配置的团队技能名（稳定顺序：按名字）。 */
export function teamSkillNames(config: PanelPromptConfig): readonly string[] {
  return Object.keys(config.skills ?? {}).sort(byName)
}

/** 两份配置是否相同（草稿是否还值得保存；JSON 相等即可，键序不影响）。 */
export function sameConfig(a: PanelPromptConfig, b: PanelPromptConfig): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b))
}

function normalize(config: PanelPromptConfig): NormalizedPromptConfig {
  const team = config.team ?? {}
  const overrides = config.overrides ?? {}
  const skills = config.skills ?? {}
  return {
    team: Object.fromEntries(
      Object.keys(team)
        .sort(byName)
        .map((key) => [key, team[key as PromptTeamSection]] as const)
    ),
    overrides: Object.fromEntries(
      Object.keys(overrides)
        .sort(byName)
        .map((key) => [key, overrides[key]] as const)
    ),
    skills: Object.fromEntries(
      Object.keys(skills)
        .sort(byName)
        .map((key) => [key, skills[key]] as const)
    )
  }
}

/** 规范化后的形状（只为「两份配置是否相同」存在；键序固定，空字段仍在）。 */
interface NormalizedPromptConfig {
  readonly team: Readonly<Record<string, string | undefined>>
  readonly overrides: Readonly<Record<string, { readonly text: string; readonly base?: string } | undefined>>
  readonly skills: Readonly<Record<string, string | undefined>>
}

/** 一条被拒的原因，面板上的一行（`path` 是字段名，`message` 是那句话）。 */
export interface PromptIssueText {
  readonly path: string
  readonly message: string
}

/**
 * worker 的固定拒绝 → 面板上一句可读的话（§M.3：「失败显示 `issues[]`」）。
 * 只按 `code` 翻，不解析 message；面板不自己判一遍占位符或技能名。
 */
export function issueTexts(
  locale: string,
  issues: readonly PanelPromptIssue[]
): readonly PromptIssueText[] {
  return issues.map((issue) => ({
    path: issue.part ?? '',
    message: issueMessage(locale, issue)
  }))
}

/** 一条拒绝的文案（码 → 文案；未知码给一句带码的通用话，绝不吞掉）。 */
function issueMessage(locale: string, issue: PanelPromptIssue): string {
  const values = issue.values
  switch (issue.code) {
    case 'missing_placeholder':
      return translate(locale, 'prompt.error.missing_placeholder', {
        placeholders: values['placeholders'] ?? ''
      })
    case 'reserved_skill_name':
      return translate(locale, 'prompt.error.reserved_skill_name', { skill: issue.part ?? '' })
    case 'invalid_skill_name':
      return translate(locale, 'prompt.error.invalid_skill_name')
    case 'too_long':
      return translate(locale, 'prompt.error.too_long', {
        limit: values['limit'] ?? '',
        actual: values['actual'] ?? ''
      })
    case 'invalid_part':
      return translate(locale, 'prompt.error.invalid_part')
    case 'unknown_part':
      return translate(locale, 'prompt.error.unknown_part')
    case 'invalid_config':
      return translate(locale, 'prompt.error.invalid_config')
    default:
      return translate(locale, 'prompt.error.generic', { reason: issue.code })
  }
}

/** 一个错误的固定码（宿主错误带 `code`；没有就空串）。 */
export function errorCode(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  return typeof code === 'string' ? code : ''
}

/**
 * 宿主错误上挂的填槽值（`values`）。宿主只保证 `code`，所以这里按可选读：读不到时面板给
 * 码对应的通用话，而不是一句 `undefined`。
 */
export function errorValues(error: unknown): Readonly<Record<string, string>> {
  const values =
    typeof error === 'object' && error !== null
      ? (error as { values?: unknown }).values
      : undefined
  if (typeof values !== 'object' || values === null) return {}
  return Object.fromEntries(
    Object.entries(values as Record<string, unknown>)
      .filter(([, value]) => typeof value === 'string')
      .map(([key, value]) => [key, value as string])
  )
}

/** 一个角色的全文：草稿预览优先，否则已保存的那份（Full prompt 页唯一的取值处）。 */
export function textOf(
  texts: PanelPromptTexts,
  role: 'orchestrator' | 'worker'
): string {
  return role === 'orchestrator' ? texts.orchestrator : texts.worker
}

// Prompts 组的面板读/写面（§M.3 的四个子页、§L.3 的占位符、§L.4 的版本/历史/default-updated、
// §L.6 的技能文件）。
//
// 面板不重算任何规则：这一层把版本库、内置分片、default-updated、历史与技能文件拼成**一份**
// 读数，保存/恢复/预览都走同一条 `app/prompts.ts` 的校验。于是「面板上看到的」与
// 「`prompts get` 看到的」是同一份事实，只有渲染不同。
//
// 预览的拒绝是**读数**而不是异常：宿主把请求错误折成 `{code, message}` 返回面板，填槽值
// （哪一段、缺哪个占位符）会丢；所以预览把 `validatePromptConfig` 的固定码与填槽值原样做成
// `issues[]` 交给面板，面板按码翻译、按 `part` 定位字段（与设置块保存被拒时的 `issues[]`
// 同一个口径，§M.3 的「失败显示 issues」）。保存仍然是异常：那是对**已提交**状态的一次真实
// 写入拒绝（`stale_revision` 是冲突，不是字段问题）。
//
// 依赖纪律（§C.2）：`app → core` 允许；本文件只 import 同层的 `prompts.ts` 与面板协议类型
// （`panel/protocol.ts` 是两侧唯一的契约），不碰 HTTP、runtime 或时钟。
import {
  BUILT_IN_SKILLS,
  composePrompt,
  composeSkill,
  PROMPT_PARTS,
  PROMPT_PART_KEYS,
  PromptTextError,
  PromptVersionError,
  promptTextOf,
  skillFilePath,
  TEAM_SECTIONS,
  validatePromptConfig,
  type PromptConfig,
  type PromptEnvironment,
  type PromptOrigin,
  type PromptPolicy,
  type PromptRole,
  type PromptVersions
} from './prompts.ts'
import type {
  PanelPromptChange,
  PanelPromptConfig,
  PanelPromptIssue,
  PanelPromptPart,
  PanelPromptPreview,
  PanelPromptSkill,
  PanelPromptsView,
  PanelPromptTexts,
  PanelPromptVersion
} from '../../panel/protocol'

/** 历史一页的大小（与 CLI 的 `prompts get` 同一页大小）。 */
export const PROMPT_PANEL_HISTORY_PAGE = 20

/** 读/写面的接线：版本库 + 技能目录 + 两个部署事实的读者 + 写成功后的通知。 */
export interface PromptPanelOptions {
  readonly versions: PromptVersions
  /** `<stateDir>`：技能路径的根（§L.6），只用于拼路径与显示。 */
  readonly stateDir: string
  /** 一个角色的执行环境段（值由部署填，面板改不了，§L.3）。 */
  readonly environment: (role: PromptRole) => PromptEnvironment
  /** Router 的 Policy 段（同上：生成段的事实）。 */
  readonly policy: () => PromptPolicy
  /**
   * 真的产生了一个新版本之后的通知：把团队技能写进磁盘（§L.6）并告诉 Router 重读
   * （§F.4，不重启会话）。`changed: false` 时不调用。
   */
  readonly onSaved?: (revision: number) => void
}

/** 一个分片在面板上的读数：内置正文（生成段是模板）+ 角色 + 占位符 + 正文的键。 */
function partView(key: (typeof PROMPT_PART_KEYS)[number]): PanelPromptPart {
  const registered = PROMPT_PARTS[key]
  return {
    key,
    roles: [...registered.roles],
    kind: registered.kind,
    placement: registered.placement,
    text: registered.lines.join('\n'),
    placeholders: [...registered.placeholders],
    base: `b-${key}`
  }
}

/** 一个版本的摘要（历史与 `saved` 共用）。 */
function versionView(version: {
  readonly revision: number
  readonly predecessor: number | null
  readonly at: string
  readonly origin: PromptOrigin
}): PanelPromptVersion {
  return {
    revision: version.revision,
    predecessor: version.predecessor,
    at: version.at,
    origin: version.origin
  }
}

/** 一条 `default-updated` 的读数：旧默认、新默认；本版本已经没有这一段时 `next: null`。 */
function changeView(change: {
  readonly part: string
  readonly base?: string
  readonly previous?: string
  readonly removed?: true
}): PanelPromptChange {
  const removed = change.removed === true
  const part = change.part as (typeof PROMPT_PART_KEYS)[number]
  return {
    part: change.part,
    base: change.base ?? null,
    previous: change.previous ?? null,
    next: removed || PROMPT_PARTS[part] === undefined ? null : PROMPT_PARTS[part].lines.join('\n'),
    removed
  }
}

/**
 * 技能文件：两个内置（只读，正文随当前配置的 override 走）+ 当前配置里的团队技能。
 * 路径是稳定约定（`<stateDir>/skills/<name>/SKILL.md`），新建的团队技能由面板按同一约定
 * 拼出预览路径——面板不写文件，写盘永远在 worker（`app/skills.ts`）。
 */
function skillViews(options: PromptPanelOptions, config: PromptConfig): readonly PanelPromptSkill[] {
  const text = promptTextOf(config)
  const builtIn = BUILT_IN_SKILLS.map((skill) => ({
    name: skill.name,
    path: skillFilePath(options.stateDir, skill.name),
    text: composeSkill(skill.kind, text),
    readOnly: true
  }))
  const team = Object.keys(config.skills ?? {})
    .sort()
    .map((name) => ({
      name,
      path: skillFilePath(options.stateDir, name),
      text: (config.skills as Record<string, string>)[name] as string,
      readOnly: false
    }))
  return [...builtIn, ...team]
}

/** 两个角色的全文：生成段的值来自部署事实（面板只读它们）。 */
function composeTexts(options: PromptPanelOptions, config: PromptConfig): PanelPromptTexts {
  const text = promptTextOf(config)
  const maxChars = options.versions.maxChars()
  return {
    orchestrator: composePrompt({
      role: 'orchestrator',
      ...text,
      environment: options.environment('orchestrator'),
      policy: options.policy(),
      maxChars
    }),
    worker: composePrompt({
      role: 'worker',
      ...text,
      environment: options.environment('worker'),
      maxChars
    })
  }
}

/**
 * Prompts 组的一份读数：当前版本与配置、每个分片的内置正文、default-updated 的详情、
 * 历史、技能文件，以及「已保存 / 默认」两份全文。
 */
export function promptPanelView(options: PromptPanelOptions): PanelPromptsView {
  const { versions } = options
  const current = versions.current()
  const config = versions.config()
  // 历史读最新一页（面板只画这一页；CLI 的 `--offset` 才有下一页的概念）。
  const history = versions.history({ limit: PROMPT_PANEL_HISTORY_PAGE }).map(versionView)
  const changes = versions.defaultChanged(config).map(changeView)
  return {
    revision: versions.revision(),
    saved: current === undefined ? null : versionView(current),
    config: config as PanelPromptConfig,
    sections: [...TEAM_SECTIONS],
    parts: PROMPT_PART_KEYS.map(partView),
    defaultChanged: changes.filter((change) => !change.removed).map((change) => change.part),
    removedParts: changes.filter((change) => change.removed).map((change) => change.part),
    changes,
    history,
    skills: skillViews(options, config),
    stateDir: options.stateDir,
    maxChars: versions.maxChars(),
    texts: { saved: composeTexts(options, config), defaults: composeTexts(options, {}) }
  }
}

/** 一个固定拒绝的读面（`part` 是分片键或技能名；`too_long` 这类没有具体一段时为 null）。 */
function issueOf(error: PromptTextError | PromptVersionError): PanelPromptIssue {
  const values: Record<string, string> = { ...error.values }
  const part = values['part'] ?? values['skill'] ?? null
  return { code: error.code, part, values }
}

/**
 * 预览一份草稿：**与保存同一份校验**（占位符、技能名、体量上限），只是不写库。
 * 校验通过时回拼好的全文与「保存会写下的配置」（与默认逐字相同的 override 会被丢弃）；
 * 不通过时回 `issues[]`——面板按码翻译，不解析文案。
 */
export function previewPromptDraft(
  options: PromptPanelOptions,
  config: unknown
): PanelPromptPreview {
  let validated: { readonly config: PromptConfig; readonly dropped: readonly string[] }
  try {
    validated = validatePromptConfig(config, options.versions.config(), {
      maxChars: options.versions.maxChars()
    })
  } catch (error) {
    if (error instanceof PromptTextError || error instanceof PromptVersionError) {
      return { ok: false, issues: [issueOf(error)] }
    }
    throw error
  }
  return {
    ok: true,
    config: validated.config as PanelPromptConfig,
    dropped: [...validated.dropped],
    texts: composeTexts(options, validated.config)
  }
}

/**
 * 保存一份配置（§L.4）：`baseRevision` 不匹配就是 `stale_revision`（草稿不丢），成功后回整个
 * 读数（面板因此一次请求就把页面刷新到最新）。真的产生新版本时通知技能落盘与 Router。
 */
export function savePromptConfig(
  options: PromptPanelOptions,
  input: { readonly config: unknown; readonly baseRevision: number; readonly origin?: PromptOrigin }
): PanelPromptsView {
  const result = options.versions.save({
    config: input.config,
    baseRevision: input.baseRevision,
    origin: input.origin ?? 'panel'
  })
  if (result.changed) options.onSaved?.(result.revision)
  return promptPanelView(options)
}

/**
 * 恢复某个版本或默认（§L.4：读出来当配置**再存一个新版本**，单向追加，不改历史）。
 * `revision: 0` 是恢复默认。
 */
export function restorePromptVersion(
  options: PromptPanelOptions,
  input: { readonly revision: number; readonly baseRevision: number; readonly origin?: PromptOrigin }
): PanelPromptsView {
  const result = options.versions.restore({
    revision: input.revision,
    baseRevision: input.baseRevision,
    origin: input.origin ?? 'panel'
  })
  if (result.changed) options.onSaved?.(result.revision)
  return promptPanelView(options)
}

/** 这一份配置的体量上限（面板显示「上限 N 字符」时读它，与保存同一个数）。 */
export function promptCharLimit(options: PromptPanelOptions): number {
  return options.versions.maxChars()
}

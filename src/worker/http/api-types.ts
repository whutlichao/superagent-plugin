// worker API 的请求类型（§G.3 的路由 → §G.2 的命令形状）。
//
// CLI 与面板读同一份类型：每条命令的输入/输出在这里写一次，`http/ops.ts` 的 handler 与
// `cli/commands.ts` 的命令表都按它取参数，`cli-contract.test.ts` 按它断言形状。
// 依赖方向（§C.2）：`cli → http/handlers`；doctor 的四档类型在 `app/doctor-types.ts`，
// 由这里再导出，于是 CLI 只认这一个入口。
//
// 纪律：**没有 `any`**；跨边界的 JSON 值就写 `unknown`（读面在 handler 里按形状收窄，§C.2）。
// 所有时间字段是 ISO-8601 文本（与库一致，§D.2 要点 1）。
import type { HealthEntry, LoadView, SetupProblem, StateView } from './state.ts'
import type { SetupIssue } from '../app/setup-types.ts'
import type { PromptConfig } from '../app/prompts.ts'
export type {
  DoctorCheck,
  DoctorCheckName,
  DoctorResult,
  DoctorState
} from '../app/doctor-types.ts'

/** `GET state` 的读数（`status` 命令与面板首屏共用，§G.2 的 status 行）。 */
export type StatusResult = StateView

/** `health` 命令的读数：`{health}`（§N.4 的每条 health 条目）。 */
export interface HealthResult {
  readonly health: Readonly<Record<string, HealthEntry>>
}

/** `pause` / `resume` 的结果（`POST executor/pause` 的 body 是 `{paused}`，§G.3）。 */
export interface PauseResult {
  readonly paused: boolean
  readonly at: string
  readonly changed: boolean
}

/** `setup check` 的结果（§G.2、§N.1）：重跑后的第一条问题与全部具名问题。 */
export interface SetupCheckResult {
  readonly problem: SetupProblem | null
  readonly checked: boolean
  /** 是否有循环被重新武装（Source 轮询 / Router 监督）。 */
  readonly restarted: boolean
  /** 全部具名问题（面板一条条列，`problem` 只是最靠前的那条）。 */
  readonly issues: readonly SetupIssue[]
}

/** `source labels` 的结果：kind 与它刷新后的行键显示名。 */
export interface SourceLabelsResult {
  readonly source: string
  readonly labels: Readonly<Record<string, string>>
}

/** `admin backup` 的结果：备份文件与触发方式（§G.2 的 admin backup）。 */
export interface BackupResult {
  readonly path: string
  readonly at: string
  readonly bytes: number
}

/** `admin rotate-token` 的结果：写回的文件与旧 token 是否已作废（破坏性，需 `--yes`）。 */
export interface RotateTokenResult {
  readonly tokenFile: string
  /** 旧 token 立刻失效（主 token 由文件持有，重写文件即轮换）。 */
  readonly rotated: true
}

// ---------------------------------------------------------------- prompts（§L.4、§L.5）

/**
 * 一份保存下来的提示词配置的读/写形状（= `app/prompts.ts` 的 `PromptConfig`）：
 * 团队三段按字段给，override 按分片键给，每个 override 记着它编辑自的内置文本键 `base`。
 */
export type PromptConfigView = PromptConfig

/** 一个内置分片的读面：正文、读它的角色、必保留占位符，以及它当前正文的键。 */
export interface PromptPartView {
  readonly key: string
  readonly roles: readonly string[]
  readonly text: string
  readonly placeholders: readonly string[]
  /** 当前内置正文的键：override 的 `base` 等于它，表示已按当前默认审过（面板的 re-base）。 */
  readonly base: string
}

/** 一条 `default-updated`：旧默认与新默认都在这里，面板不需要自己拼。 */
export interface PromptDefaultChangeView {
  readonly part: string
  /** override 编辑自的内置文本键；没有记录时 `null`。 */
  readonly base: string | null
  /** 旧默认正文（本安装留下了它时）。 */
  readonly previous: string | null
  /** 新默认正文；本版本已没有这个分片时 `null`。 */
  readonly next: string | null
  /** 本版本已经没有这个分片：保存时丢弃并列出。 */
  readonly removed: boolean
}

/** 版本历史的一条（§L.4 的 `{revision, predecessor, at, origin}`）。 */
export interface PromptVersionSummary {
  readonly revision: number
  readonly predecessor: number | null
  readonly at: string
  readonly origin: 'panel' | 'tool'
}

/** `GET prompts` 的读数（`prompts get` 与面板 Prompts 页共用）。 */
export interface PromptConfigResult {
  /** 读到的配置的版本号；`--defaults` 与还没存过时是 0（= 内置默认）。 */
  readonly revision: number
  /** 这个版本保存的时刻与来源；版本 0 时 `null`。 */
  readonly saved: PromptVersionSummary | null
  readonly config: PromptConfigView
  /** 团队三段的名字（面板按它分组；正文在 `parts` 里）。 */
  readonly sections: readonly string[]
  /** 每个内置分片**当前**的正文（含团队三段的默认）与它正文的键。 */
  readonly parts: readonly PromptPartView[]
  /** 内置文本自编辑以来变过的分片键（等价上游 `default_changed`）。 */
  readonly default_changed: readonly string[]
  /** 本版本已没有、保存时会丢弃的分片键。 */
  readonly removed_parts: readonly string[]
  /** `default_changed` 的详情：旧默认 vs 新默认。 */
  readonly changes: readonly PromptDefaultChangeView[]
  /** 版本历史，新→旧。 */
  readonly history: readonly PromptVersionSummary[]
  readonly next_offset: number | null
}

/** 一个角色的拼装结果（`prompts get --text` 与预览共用）。 */
export interface PromptTexts {
  readonly orchestrator: string
  readonly worker: string
}

/** `prompts get --text` 的读数。 */
export interface PromptTextResult {
  readonly revision: number
  readonly texts: PromptTexts
}

/** `prompts save --preview`（`POST prompts/preview`）的读数：不写库。 */
export interface PromptPreviewResult extends PromptTextResult {
  /** 保存时会被丢弃的分片键（本版本已没有的 override）。 */
  readonly dropped: readonly string[]
  /** 校验后的配置（与保存会存下去的形状相同）。 */
  readonly config: PromptConfigView
}

/** 一次保存的读数（`prompts save`、`PUT prompts`）。 */
export interface PromptSaveView extends PromptVersionSummary {
  /** 内容与当前版本相同 → 没有写新版本。 */
  readonly changed: boolean
  /** 保存时被丢弃的 override 键（本版本已没有的分片）。 */
  readonly dropped: readonly string[]
}

// `eval-read --part` 的三种取值（§G.2、§I.1 的 `threadContext.read`）：CLI 的 `--part` 候选与
// HTTP handler 的校验读同一份；与 `sources/admission-context.ts` 的 `ContextPartName` 同值。
export const EVAL_READ_PARTS = ['root', 'parent', 'thread'] as const

/**
 * `read <resource>` 的分页默认与上限（§G.2 的 read 行：列表页默认 20、上限 50；文本页默认
 * 4000 字符、上限 8000）。定义在 `app/read.ts`（分页在那里判），这里只原样转出给 CLI。
 */
export {
  READ_DEFAULT_LIMIT,
  READ_MAX_LIMIT,
  READ_TEXT_DEFAULT_CHARS,
  READ_TEXT_MAX_CHARS
} from '../app/read.ts'

/**
 * Source 资源读面（§I.2 的「资源读取」行 + §I.3 的读法）的两种写法：一个判断（CLI 用它决定
 * 走 `read/:resource` 还是面板视图路由）与一份可用写法清单（未知资源的拒绝与 `--help` 用）。
 */
export { isSourceResource, READ_SOURCE_RESOURCES } from '../app/read.ts'

/** `read` 能读的资源（§F.6 的 Router 读面 + 面板视图）。 */
export const READ_RESOURCES: readonly string[] = [
  'overview',
  'sources',
  'search',
  'threads',
  'thread',
  'decisions',
  'tickets',
  'ticket',
  'settings',
  'prompts',
  'models',
  'triggers',
  'trigger'
]

/** 一页读结果（`next_offset` 为 `null` 表示没有下一页）。 */
export interface ReadPage {
  readonly items: readonly unknown[]
  readonly next_offset: number | null
}

/** 负载（`state.load`）的再导出：`status --text` 与面板都能直接用。 */
export type { LoadView }

// ---------------------------------------------------------------- settings / policy（§G.2、§K.8）

/** 设置历史的页大小（与 `read` 的缺省 20 不同：历史是审计面，一页 50）。 */
export const SETTINGS_HISTORY_LIMIT = 50

/** 一条设置版本摘要（面板 History 页与 `settings get --history` 共用）。 */
export interface SettingsVersionView {
  readonly revision: number
  readonly predecessor: number | null
  readonly at: string
  readonly origin: 'panel' | 'tool' | 'sync' | 'operator'
  readonly block: string
  /** Policy 块的内容哈希；其余块是 `null`（§K.5）。 */
  readonly policyVersion: string | null
}

/** 一个设置块的读数（`settings get`）：块修订号 + 当前生效的值 + 产生它的那版记录。 */
export interface SettingsBlockView {
  /** 块名（`policy` / `eval` / `executor` / `source:<id>`）。 */
  readonly block: string
  /**
   * 这个块的修订号（`settings-block-revision:<block>`）：`settings save --revision` 要带的
   * 就是它；没存过是 0。它是**块**的修订号，不是全局 `revision`（§K.8 的乐观并发按块）。
   */
  readonly revision: number
  /** 当前生效的值：保存过的用那一份，否则是运行时那份（§K.8）。 */
  readonly value: unknown
  /** 产生当前值的记录；没存过时 `null`。 */
  readonly saved: SettingsVersionView | null
}

/** `settings get` 的读数：全局修订号 + 一个或多个块。 */
export interface SettingsResult {
  /** 全局设置版本（`settings-revision`）。 */
  readonly revision: number
  readonly blocks: readonly SettingsBlockView[]
}

/** `settings get --history`（`GET policy/history`）的读数：版本摘要，新→旧。 */
export interface SettingsHistoryResult {
  readonly revision: number
  readonly history: readonly SettingsVersionView[]
}

/** 一次设置保存的读数（§G.2 的 `settings save`）。 */
export interface SettingsSaveView {
  readonly block: string
  /** 保存后的**块**修订号（下次保存的 `--revision`）。 */
  readonly revision: number
  /** 保存后的全局设置修订号（面板的总修订号）。 */
  readonly settings_revision: number
  /** Policy 块的内容哈希变了（其他块恒为 false）。 */
  readonly policy_changed: boolean
  /** 这次保存是否需要重启插件才生效（§H.12：`stateDir`）。 */
  readonly restarting: boolean
  /** 内容与当前版本相同：没有写新版本。 */
  readonly changed: boolean
  readonly origin: 'panel' | 'tool' | 'sync' | 'operator'
}

/** `policy sync <source>` 的读数（§G.2）：同步后的 Policy 版本与名单差异。 */
export interface PolicySyncResult {
  /** 同步之后的 Policy 块读数（revision 与内容哈希）。 */
  readonly policy: { readonly revision: number; readonly version: string | null }
  /** 同步读到的允许名单（原样，形状由 Source 决定）。 */
  readonly allowed: readonly unknown[]
  /** 新增的名单 id（大小写敏感的比较：id 是 Source 的原生标识）。 */
  readonly added: readonly string[]
  /** 消失的名单 id。 */
  readonly removed: readonly string[]
}

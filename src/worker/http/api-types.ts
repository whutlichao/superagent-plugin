// worker API 的请求类型（§G.3 的路由 → §G.2 的命令形状）。
//
// CLI 与面板读同一份类型：每条命令的输入/输出在这里写一次，`http/ops.ts` 的 handler 与
// `cli/commands.ts` 的命令表都按它取参数，`cli-contract.test.ts` 按它断言形状。
// 依赖方向（§C.2）：`cli → http/handlers`；doctor 的三档类型在 `app/doctor-types.ts`，
// 由这里再导出，于是 CLI 只认这一个入口。
//
// 纪律：**没有 `any`**；跨边界的 JSON 形状用 `unknown` 的受控别名 `JsonValue`（§C.2）。
// 所有时间字段是 ISO-8601 文本（与库一致，§D.2 要点 1）。
import type { HealthEntry, LoadView, SetupProblem, StateView } from './state.ts'
import type { SetupIssue } from '../app/setup-types.ts'
export type {
  DoctorCheck,
  DoctorCheckName,
  DoctorResult,
  DoctorState
} from '../app/doctor-types.ts'

/** 受控的 JSON 别名（这个模块里唯一的 `unknown` 逃逸点；与 core 的同名别名各自定义）。 */
export type JsonValue = unknown

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

/** `read <resource>` 的分页默认与上限（§G.2 的 read 行：默认 20、上限 50）。 */
export const READ_DEFAULT_LIMIT = 20
export const READ_MAX_LIMIT = 50

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
  readonly items: readonly JsonValue[]
  readonly next_offset: number | null
}

/** 负载（`state.load`）的再导出：`status --text` 与面板都能直接用。 */
export type { LoadView }

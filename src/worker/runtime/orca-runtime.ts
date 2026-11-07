// 运行缝骨架：插件里唯一允许接触 Orca 的接口面（§B）。本票只建立接口与错误类型，
// 不含实现；`host-runtime.ts` / `cli.ts` / `fake-runtime.ts` 由后续票补齐。
// 本文件不 import 任何 `orca` 类型，保持 seam 与宿主解耦。

/** 受控的 JSON 别名：类型面里唯一的 `unknown` 逃逸点，其余全部显式。 */
export type JsonValue = unknown

/** Host API 原样透出的错误码（references/host-api.md §Errors），逐条枚举。 */
export type HostErrorCode =
  | 'invalid_request'
  | 'invalid_params'
  | 'unknown_method'
  | 'capability_denied'
  | 'consent_required'
  | 'not_permitted'
  | 'rate_limited'
  | 'unavailable'
  | 'action_failed'
  | 'cancelled'
  | 'timeout'
  | 'conflict'
  | 'too_large'

/** seam 自己的错误码：Orca CLI 子进程、工作区、agent 生命周期与本地状态目录。 */
export type SeamErrorCode =
  | 'cli_missing'
  | 'cli_failed'
  | 'cli_timeout'
  | 'workspace_missing'
  | 'agent_gone'
  | 'state_dir_unwritable'
  | 'locked'

/**
 * 运行缝可能抛出的全部错误码：宿主 13 个 + seam 7 个 = 20 个。
 * 设计 §B.2 的注释写「宿主 12 个」，但它自己枚举的宿主错误码是 13 个，且与
 * references/host-api.md §Errors 的权威清单逐条一致——「12」是文档笔误，以枚举与
 * reference 为准（coordinator 裁决 2026-11-07）。
 */
export type RuntimeErrorCode = HostErrorCode | SeamErrorCode

/** 可按同一请求重试的错误码；其余错误重试也不会变好（§B.2）。 */
export const RETRYABLE_CODES: readonly RuntimeErrorCode[] = [
  'rate_limited',
  'unavailable',
  'timeout',
  'action_failed',
  'cli_timeout',
  'cli_failed'
]

/** 运行缝的唯一错误类型：调用方只按 `code` 分支，不解析文案。 */
export class OrcaRuntimeError extends Error {
  readonly code: RuntimeErrorCode
  readonly retryable: boolean
  readonly retryAfterMs?: number
  readonly values?: Readonly<Record<string, string>>

  constructor(
    code: RuntimeErrorCode,
    message: string,
    options: {
      readonly retryAfterMs?: number
      readonly values?: Readonly<Record<string, string>>
      readonly cause?: unknown
    } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'OrcaRuntimeError'
    this.code = code
    this.retryable = RETRYABLE_CODES.includes(code)
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs
    if (options.values !== undefined) this.values = options.values
  }
}

/** 判断任意抛出物是否为运行缝错误（跨实现、跨模块边界的类型守卫）。 */
export function isOrcaRuntimeError(value: unknown): value is OrcaRuntimeError {
  return value instanceof OrcaRuntimeError
}

/** 仓库选择器：路径 / 名字 / id 三选一，交给宿主解析。 */
export interface RepoSelector {
  readonly path?: string
  readonly name?: string
  readonly id?: string
}

/** 建工作区的规格：Ticket 与 Router 都是独立顶层 worktree。 */
export interface WorkspaceSpec {
  readonly name: string
  readonly repo?: RepoSelector
  readonly baseBranch?: string
  readonly branch?: string
  readonly setup?: 'skip' | 'run' | 'inherit'
  readonly parent?: 'none' | 'current'
  readonly activate?: boolean
}

/** 建好（或复用）的工作区句柄。 */
export interface WorkspaceHandle {
  readonly workspaceId: string
  readonly path: string
  readonly branch: string | null
  readonly created: boolean
}

/**
 * Orca 已登记的仓库（`orca repo list --json` 的一行，§E.1 base repo 行）。
 * 只取 setup 探针校验存在性要用的三项：id、路径与显示名。
 */
export interface RepoRow {
  readonly id: string
  readonly path: string
  readonly name: string
}

/** 宿主侧工作区行（`workspace.list` 的投影）。 */
export interface WorkspaceInfo {
  readonly workspaceId: string
  readonly kind: 'worktree' | 'folder'
  readonly name: string
  readonly path: string
  readonly branch: string | null
}

/**
 * 在一个工作区里跑一条一次性命令的规格（prepare，§E.3）。`command` 已经是插件替换完变量、
 * 单引号转义过的最终文本（§E.3 的变量替换归 #13）；seam 只负责执行与收集输出。
 */
export interface CommandSpec {
  readonly workspace: WorkspaceHandle
  readonly command: string
  /** 预算：prepare 是 10 分钟（§E.3），超时视为失败。 */
  readonly timeoutMs: number
  /** 终端标题（预留；实现可忽略）。 */
  readonly title?: string
}

/** 一条一次性命令的结果：退出码（拿不到时为 null）、输出行与承载它的终端句柄。 */
export interface CommandHandle {
  readonly terminalId: string
  readonly exitCode: number | null
  readonly output: readonly string[]
}

/** 启动 agent 的规格：插件恒要求 terminal 面，才有 terminalId 可发可停。 */
export interface AgentSpec {
  readonly workspace: WorkspaceHandle
  readonly agent: string
  readonly model?: string
  readonly effort?: string
  readonly prompt?: string
  readonly surface: 'terminal'
}

/** 启动成功后的 agent 句柄。 */
export interface AgentHandle {
  readonly terminalId: string
  readonly workspaceId: string
  readonly launchedAt: number
}

/** agent 的可观测状态；`agent.status.changed` 的四态。 */
export type AgentState = 'working' | 'blocked' | 'waiting' | 'done'

/** 当前聚焦 workspace 的 agent 行（`agents.list`，只作提示）。 */
export interface AgentRow {
  readonly terminalId: string | null
  readonly title: string | null
  readonly agent: string | null
  readonly state: AgentState
  readonly stateStartedAt: number
}

/** 全机终端行（`orca terminal list`）：判断 worker 终端是否还活着的唯一权威枚举。 */
export interface TerminalRow {
  readonly handle: string
  readonly worktreeId: string | null
  readonly worktreePath: string | null
  readonly title: string | null
  readonly connected: boolean
  readonly orphaned: boolean
}

/** agent 状态事件（`agent.status.changed` 的投影）。 */
export interface AgentStatusEvent {
  readonly workspaceId: string | null
  readonly paneKey: string
  readonly terminalId?: string
  readonly state: AgentState
  readonly receivedAt: number
}

/** 状态栏更新（`statusBar.update` 的参数子集）。 */
export interface StatusBarUpdate {
  readonly id: string
  readonly text?: string
  readonly icon?: string
  readonly tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
  readonly tooltip?: string
  readonly visible?: boolean
}

/** 插件自身的键值存储（`orca.storage`）。 */
export interface RuntimeStorage {
  get(key: string): Promise<JsonValue | null>
  set(key: string, value: JsonValue): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<readonly string[]>
}

/** 插件自身的设置（`orca.settings`，含清单声明项的默认值）。 */
export interface RuntimeSettings {
  get(): Promise<Readonly<Record<string, JsonValue>>>
  set(key: string, value: JsonValue): Promise<void>
}

/** 插件自身的加密密钥（`orca.secrets`）。 */
export interface RuntimeSecrets {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  protection(): Promise<'os-keyring' | 'unavailable'>
}

/** 运行缝：插件接触 Orca 的唯一接口。实现见 §B.4（本票不含实现）。 */
export interface OrcaRuntime {
  readonly api: { readonly major: number; readonly minor: number; readonly locale: string }
  supports(method: string): boolean

  /**
   * `orca repo list --json`：Orca 已登记的仓库（§E.1：base repo 必须在其中，setup 检查用它）。
   * 只读；CLI 缺失按 `cli_missing` 抛错，不返回空表（空表会被误读成「一个仓库都没有」）。
   */
  listRepos(): Promise<readonly RepoRow[]>
  /**
   * `orca repo search-refs --repo <selector> --query <ref> --json`：命中该查询的 ref 名。
   * 配了 base ref 时用它校验存在性；没配时调用方显式传 `HEAD`，不假装读得到 Orca 的默认值。
   */
  searchRefs(selector: RepoSelector, query: string): Promise<readonly string[]>

  // 1. 工作区
  ensureWorkspace(spec: WorkspaceSpec, signal?: AbortSignal): Promise<WorkspaceHandle>
  listWorkspaces(): Promise<readonly WorkspaceInfo[]>
  openWorkspace(workspaceId: string): Promise<void>

  // 2. Agent
  launchAgent(spec: AgentSpec, signal?: AbortSignal): Promise<AgentHandle>
  listAgents(): Promise<readonly AgentRow[]>
  /**
   * 在一个工作区里反查已启动的 agent 终端（§E.2 的兜底：回执缺句柄时按 `workspaceId` 反查）。
   * 单独的 seam 方法而不是复用 `listAgents()`：宿主 `agents.list` 只投影当前聚焦工作区、
   * 行里也没有 `workspaceId`（附录 C S2 实测），那条路做不到这件事。找不到返回 `null`。
   */
  findAgent(workspaceId: string): Promise<AgentHandle | null>
  listTerminals(): Promise<readonly TerminalRow[]>
  onAgentStatus(handler: (event: AgentStatusEvent) => void): () => void

  // 3. 终端
  sendText(
    terminalId: string,
    text: string,
    options?: { readonly enter?: boolean }
  ): Promise<{ readonly accepted: boolean }>
  readTerminal(
    terminalId: string,
    options?: { readonly maxLines?: number }
  ): Promise<{ readonly lines: readonly string[]; readonly truncated: boolean }>
  closeTerminal(terminalId: string): Promise<void>
  /**
   * 把一台终端切到前台（§M.2「面板不能直接做的两件事」之一）。面板没有这个宿主能力，
   * 实现走 `orca terminal focus --terminal <handle>`；找不到终端时抛 `agent_gone`。
   */
  focusTerminal(terminalId: string): Promise<void>
  /**
   * 在工作区里跑一条一次性命令并等它结束（prepare，§E.3）。宿主没有直接等价方法：实现用
   * `orca terminal create --command …` 起终端，再 `orca terminal read` 收尾（附录 C S1/S3 的
   * 实测 CLI 可用）。超时按 `timeoutMs` 交给 `cli_timeout`。
   */
  runCommand(spec: CommandSpec, signal?: AbortSignal): Promise<CommandHandle>

  // 4. Orca 侧副作用
  notify(input: { readonly title: string; readonly body?: string }): Promise<{
    readonly delivered: boolean
  }>
  setStatusBar(update: StatusBarUpdate): Promise<void>

  // 5. 插件自身数据
  readonly storage: RuntimeStorage
  readonly settings: RuntimeSettings
  readonly secrets: RuntimeSecrets
}

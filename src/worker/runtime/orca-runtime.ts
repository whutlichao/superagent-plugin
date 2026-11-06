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

/** 宿主侧工作区行（`workspace.list` 的投影）。 */
export interface WorkspaceInfo {
  readonly workspaceId: string
  readonly kind: 'worktree' | 'folder'
  readonly name: string
  readonly path: string
  readonly branch: string | null
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

  // 1. 工作区
  ensureWorkspace(spec: WorkspaceSpec, signal?: AbortSignal): Promise<WorkspaceHandle>
  listWorkspaces(): Promise<readonly WorkspaceInfo[]>
  openWorkspace(workspaceId: string): Promise<void>

  // 2. Agent
  launchAgent(spec: AgentSpec, signal?: AbortSignal): Promise<AgentHandle>
  listAgents(): Promise<readonly AgentRow[]>
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

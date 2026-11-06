// 手写的 `orca/worker` 最小声明：worker 侧宿主 API、事件、钩子、面板桥、日志（§N.3）。
//
// pinned to Orca 1.4.251 —— 来源 `orca skills get orca-plugin-authoring` 的
// references/host-api.md（Worker API）、references/events.md、references/testing.md。
// 只声明插件实际用到的成员；不写实现、不写 `any` 逃逸。

import type {
  AgentSummary,
  Disposable,
  HostApi,
  HostApiVersion,
  JsonValue,
  SettingsApi,
  StorageApi
} from 'orca'

export type {
  AgentSummary,
  Disposable,
  HostApi,
  HostApiVersion,
  JsonValue,
  SettingsApi,
  StorageApi
}

/** 插件声明的十个能力（清单 capabilities 的 kind）。 */
export type CapabilityKind =
  | 'workspace:read'
  | 'workspace:write'
  | 'agent:read'
  | 'agent:launch'
  | 'terminal:send'
  | 'terminal:read'
  | 'notifications:show'
  | 'storage:own'
  | 'secrets:own'
  | 'settings:own'

/** 插件加密密钥（`secrets:own`）。 */
export interface SecretsApi {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

/** 命令注册时 Orca 传入的上下文。 */
export interface CommandContext {
  readonly signal?: AbortSignal
}

/** 命令处理器：字符串结果原样显示，其余按 JSON 显示。 */
export type CommandHandler = (args: unknown, context: CommandContext) => unknown

/** worker 命令面：每个贡献命令都要 `register`。 */
export interface CommandsApi {
  register(commandId: string, handler: CommandHandler): Disposable
}

/** `contributes.events` 里可声明的事件名。 */
export type WorkerEventName = 'agent.status.changed' | 'workspace.created' | 'workspace.removed'

/** `agent.status.changed` 的负载（references/events.md）。 */
export interface AgentStatusChangedPayload {
  readonly workspaceId: string | null
  readonly paneKey: string
  readonly terminalId?: string
  readonly title?: string
  readonly state: 'working' | 'blocked' | 'waiting' | 'done'
  readonly receivedAt: number
}

/** `workspace.created` 的负载。 */
export interface WorkspaceCreatedPayload {
  readonly workspaceId: string
  readonly kind: 'worktree' | 'folder'
  readonly path: string
  readonly branch: string
}

/** `workspace.removed` 的负载。 */
export interface WorkspaceRemovedPayload {
  readonly workspaceId: string
  readonly kind: 'worktree' | 'folder'
  readonly path: string
}

/** 事件名 → 负载类型。 */
export interface WorkerEvents {
  'agent.status.changed': AgentStatusChangedPayload
  'workspace.created': WorkspaceCreatedPayload
  'workspace.removed': WorkspaceRemovedPayload
}

/** worker 事件面：只有清单声明的事件会到达。 */
export interface EventsApi {
  on<E extends keyof WorkerEvents>(
    event: E,
    handler: (payload: WorkerEvents[E]) => void | Promise<void>
  ): Disposable
}

/** `contributes.hooks` 里可声明的钩子名。 */
export type HookName =
  | 'terminal.send'
  | 'workspace.create.before'
  | 'workspace.create.after'
  | 'agent.launch.before'
  | 'agent.prompt.before'
  | 'agent.tool.before'
  | 'agent.tool.after'
  | 'editor.save.before'

/** `agent.launch.before` 的事件负载（references/host-api.md §Hooks）。 */
export interface AgentLaunchBeforeEvent {
  readonly agent: string
  readonly workspaceId: string | null
  readonly workspaceKind: 'worktree' | 'folder' | null
  readonly terminalId?: string
  readonly command: string
  readonly env: Readonly<Record<string, string>>
}

/** `next` 改写：只能改钩子允许的字段。 */
export type HookNext<E> = (event: E) => unknown

/** 钩子处理器：返回 `next(event)` 或什么都不返回来放行，返回 `{ deny }` 拒绝。 */
export type HookHandler<E> = (event: E, next: HookNext<E>) => unknown

/** 钩子面：只有清单声明的钩子会运行。 */
export interface HooksApi {
  on(event: 'agent.launch.before', handler: HookHandler<AgentLaunchBeforeEvent>): Disposable
}

/** 面板请求的处理器：input 是面板传来的 JSON，返回可序列化结果。 */
export type PanelRequestHandler<Input = JsonValue, Output = JsonValue> = (
  input: Input,
  context: { readonly panel?: string; readonly signal?: AbortSignal }
) => Output | Promise<Output>

/** 面板桥（worker 侧）：回答面板请求、向面板推送。 */
export interface PanelsApi {
  handle<Input = JsonValue, Output = JsonValue>(
    name: string,
    handler: PanelRequestHandler<Input, Output>
  ): Disposable
  post(event: string, payload?: JsonValue, options?: { readonly panel?: string }): void
}

/** `activate(orca)` 收到的 worker 宿主对象。 */
export interface OrcaWorkerApi {
  readonly api: HostApiVersion
  readonly host: HostApi
  readonly commands: CommandsApi
  readonly events: EventsApi
  readonly hooks: HooksApi
  readonly panels: PanelsApi
  readonly storage: StorageApi
  readonly settings: SettingsApi
  readonly secrets: SecretsApi
  readonly grantedCapabilities: readonly CapabilityKind[]
  log(message: string): void
}

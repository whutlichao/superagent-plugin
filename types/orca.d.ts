// 手写的最小 Orca 声明：面板组件、atom、宿主 API、事件与 JSX（§N.3）。
//
// pinned to Orca 1.4.251 —— 权威来源是 `orca skills get orca-plugin-authoring` 的
// references/components.md、references/host-api.md、references/events.md。
// 本文件只声明插件实际用到（或运行缝已承诺）的 API，不照抄整套宿主类型。
// 纪律：类型文件里不写实现、不写 `any` 逃逸；唯一受控的逃逸点是 `JsonValue = unknown`。

/** 受控的 JSON 别名：宿主 API 的任意 JSON 值；调用方自行收窄。 */
export type JsonValue = unknown

/** 可释放的订阅（`orca.on`、`events.on` 的返回值）。 */
export interface Disposable {
  dispose(): void
}

/** 组件树节点：元素、文本或它们的嵌套数组。 */
export type OrcaNode =
  | OrcaElement
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly OrcaNode[]

/** 组件函数返回的元素；Orca 据此绘制，不经过 DOM。 */
export interface OrcaElement {
  readonly type: string | ((props: never) => OrcaElement)
  readonly props: Readonly<Record<string, unknown>> | null
  readonly children: readonly OrcaNode[]
}

declare global {
  namespace JSX {
    type Element = OrcaElement
    interface ElementClass {
      render?: never
    }
    interface ElementAttributesProperty {
      props?: never
    }
    interface ElementChildrenAttribute {
      children?: never
    }
    interface IntrinsicElements {}
  }
}

/** 间距档位。 */
export type Gap = 'none' | 'xs' | 'sm' | 'md' | 'lg'

/** 语气色。 */
export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

/** 字号档位。 */
export type Size = 'xs' | 'sm' | 'md'

/** `Stack` 的 props。 */
export interface StackProps {
  readonly children?: OrcaNode
  readonly gap?: Gap
  readonly align?: 'start' | 'center' | 'end' | 'stretch'
}

/** `Heading` 的 props。 */
export interface HeadingProps {
  readonly children?: OrcaNode
  readonly level?: 1 | 2 | 3
}

/** `Text` 的 props。 */
export interface TextProps {
  readonly children?: OrcaNode
  readonly tone?: Tone
  readonly muted?: boolean
  readonly size?: Size
  readonly weight?: 'regular' | 'medium' | 'semibold'
  readonly truncate?: boolean
}

export declare function Stack(props: StackProps): OrcaElement
export declare function Heading(props: HeadingProps): OrcaElement
export declare function Text(props: TextProps): OrcaElement

// ---------------------------------------------------------------------------
// 宿主 API 方法面
// ---------------------------------------------------------------------------

/** `workspace.list` 的一行。 */
export interface WorkspaceSummary {
  readonly id: string
  readonly kind: 'worktree' | 'folder'
  readonly name: string
  readonly path: string
  readonly branch: string | null
  readonly hostId: string | null
}

/** `agents.list` 的一行（聚焦 workspace）。 */
export interface AgentSummary {
  readonly terminalId: string | null
  readonly title: string | null
  readonly agent: string | null
  readonly state: 'working' | 'blocked' | 'waiting' | 'done'
  readonly stateStartedAt: number
}

/** 状态栏项的图标名（与清单的 IconName 同一套）。 */
export type IconName =
  | 'activity'
  | 'bar-chart-3'
  | 'bell'
  | 'blocks'
  | 'book'
  | 'bot'
  | 'bug'
  | 'calendar'
  | 'cloud'
  | 'code'
  | 'database'
  | 'file-text'
  | 'flag'
  | 'folder'
  | 'gauge'
  | 'globe'
  | 'hammer'
  | 'layers'
  | 'lightbulb'
  | 'package'
  | 'plug'
  | 'puzzle'
  | 'rocket'
  | 'star'
  | 'terminal'
  | 'wrench'
  | 'zap'
  | 'add'
  | 'remove'
  | 'delete'
  | 'edit'
  | 'refresh'
  | 'search'
  | 'settings'
  | 'check'
  | 'close'
  | 'info'
  | 'warning'
  | 'error'
  | 'open-external'
  | 'copy'
  | 'download'
  | 'upload'
  | 'play'
  | 'pause'
  | 'stop'
  | 'more'
  | 'expand'
  | 'collapse'
  | 'next'
  | 'filter'
  | 'branch'
  | 'file'
  | 'agent'
  | 'link'

/**
 * 宿主方法表：方法名 → 参数与结果类型。
 * 方法名集合必须与 `src/worker/runtime/host-methods.ts` 的 `HOST_METHODS` 逐字一致
 * （`tests/types-surface.test.ts` 断言；宿主升级后先在这里炸，不静默漂移）。
 */
export interface HostMethods {
  // @host-methods:start —— 与 HOST_METHODS 对齐，顺序一致
  'workspace.list': {
    params: Record<string, never>
    result: { workspaces: readonly WorkspaceSummary[]; truncated: boolean }
  }
  'workspace.open': { params: { workspaceId: string }; result: { opened: true } }
  'agents.list': { params: Record<string, never>; result: { agents: readonly AgentSummary[] } }
  'agent.launch': {
    params: { workspaceId: string; agent: string; prompt?: string }
    result: { terminalId: string }
  }
  'terminal.sendText': {
    params: { terminalId: string; text: string; enter?: boolean }
    result: { accepted: boolean }
  }
  'terminal.read': {
    params: { terminalId: string; maxLines?: number }
    result: { lines: readonly string[]; truncated: boolean }
  }
  'notifications.show': {
    params: { title: string; body?: string }
    result: { delivered: boolean }
  }
  'statusBar.update': {
    params: {
      id: string
      text?: string
      icon?: IconName
      tone?: Tone
      tooltip?: string
      visible?: boolean
    }
    result: { ok: true }
  }
  'storage.get': { params: { key: string }; result: { value: JsonValue } }
  'storage.set': { params: { key: string; value: JsonValue }; result: { ok: true } }
  'storage.delete': { params: { key: string }; result: { ok: true } }
  'storage.keys': { params: Record<string, never>; result: { keys: readonly string[] } }
  'secrets.get': { params: { key: string }; result: { value: string | null } }
  'secrets.set': { params: { key: string; value: string }; result: { ok: true } }
  'secrets.delete': { params: { key: string }; result: { ok: true } }
  'secrets.protection': {
    params: Record<string, never>
    result: { status: 'os-keyring' | 'unavailable' }
  }
  'settings.get': {
    params: Record<string, never>
    result: { settings: Readonly<Record<string, JsonValue>> }
  }
  'settings.set': { params: { key: string; value: JsonValue }; result: { ok: true } }
  // @host-methods:end
}

/** 宿主方法名（从 HostMethods 的键推导，避免两处手写）。 */
export type HostMethodName = keyof HostMethods

/** 宿主调用面：参数与结果由方法名决定。 */
export interface HostApi {
  call<M extends HostMethodName>(method: M, params: HostMethods[M]['params']): Promise<
    HostMethods[M]['result']
  >
  has(method: string): boolean
}

/** 宿主 API 版本。 */
export interface HostApiVersion {
  readonly major: number
  readonly minor: number
}

/** 面板可用的宿主调用面。 */
export declare const host: HostApi
export declare const api: HostApiVersion
export declare const env: {
  readonly locale: string
  readonly theme: 'light' | 'dark'
  readonly client: 'desktop'
}

// ---------------------------------------------------------------------------
// 插件自身数据（与 worker 侧同名 API）
// ---------------------------------------------------------------------------

/** 插件私有 JSON 存储（`storage:own`）。 */
export interface StorageApi {
  get(key: string): Promise<JsonValue | null>
  set(key: string, value: JsonValue): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<readonly string[]>
}

/** 插件设置（`settings:own`）；声明项读默认值。 */
export interface SettingsApi {
  get(): Promise<Readonly<Record<string, JsonValue>>>
  get(key: string): Promise<JsonValue | undefined>
  set(key: string, value: JsonValue): Promise<void>
}

/** 插件加密密钥（`secrets:own`）。 */
export interface SecretsApi {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

declare const storage: StorageApi
declare const settings: SettingsApi
declare const secrets: SecretsApi
export { storage, settings, secrets }

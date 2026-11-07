// 手写的最小 Orca 声明：面板组件、atom、宿主 API、事件与 JSX（§N.3）。
//
// pinned to Orca 1.4.251 —— 权威来源是 `orca skills get orca-plugin-authoring` 的
// references/components.md、references/host-api.md、references/events.md、references/testing.md。
// 本文件只声明插件实际用到（或运行缝已承诺）的 API，不照抄整套宿主类型。
// 纪律：类型文件里不写实现、不写 `any` 逃逸；唯一受控的逃逸点是 `JsonValue = unknown`。
//
// 组件面（catalog 4，Orca 1.4.251）覆盖 §M.4 的组件选型表：面板只能用这些语义组件，
// 没有 `style`/`className`，也没有 Modal 与 Toast（§M.4 的已知限制）。

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
    /** 组件列表里的 `key`：宿主用它保持同一行在不同渲染间的身份。 */
    interface IntrinsicAttributes {
      key?: string
    }
    interface IntrinsicElements {}
  }
}

// ---------------------------------------------------------------------------
// 组件目录的取值档位
// ---------------------------------------------------------------------------

/** 间距档位。 */
export type Gap = 'none' | 'xs' | 'sm' | 'md' | 'lg'

/** 语气色；面板能表达「颜色」的唯一方式。 */
export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

/** 字号档位。 */
export type Size = 'xs' | 'sm' | 'md'

/** 按钮样式。 */
export type Variant = 'solid' | 'outline' | 'ghost'

/** 对齐。 */
export type Align = 'start' | 'center' | 'end' | 'stretch'

/** 按下回调；返回值被忽略。 */
export type Press = () => unknown

/** 表格列。 */
export interface TableColumn {
  readonly key: string
  readonly label: string
  readonly align?: 'start' | 'center' | 'end'
  readonly width?: 'auto' | 'xs' | 'sm' | 'md' | 'lg'
  readonly minWidth?: 'auto' | 'xs' | 'sm' | 'md'
  /** 面板窄于这个断点时该列消失（sm 360 px、md 480 px）。 */
  readonly hideBelow?: 'sm' | 'md'
  readonly sortable?: boolean
}

/** 表格单元格：文字、数字、布尔、空，或由宿主持续更新的相对时间。 */
export type TableCell =
  | string
  | number
  | boolean
  | null
  | { readonly type: 'relative'; readonly at: number; readonly format?: RelativeTimeFormat }

/** 表格行。 */
export interface TableRow {
  readonly key: string
  readonly cells: Readonly<Record<string, TableCell>>
  readonly disabled?: boolean
}

/** 排序状态。 */
export interface TableSort {
  readonly column: string
  readonly direction: 'asc' | 'desc'
}

/** 树的条目。 */
export interface TreeItem {
  readonly key: string
  readonly label: string
  readonly description?: string
  readonly icon?: IconName
  readonly disabled?: boolean
  readonly hasChildren?: boolean
  readonly children?: readonly TreeItem[]
}

/** 单选组的选项。 */
export interface RadioOption {
  readonly value: string
  readonly label: string
  readonly disabled?: boolean
}

/** 下拉选项。 */
export interface SelectOption {
  readonly value: string
  readonly label: string
  readonly disabled?: boolean
}

/** `KeyValue` 的一行。 */
export interface KeyValueItem {
  readonly label: string
  readonly value: string | number | boolean | null
  readonly tone?: Tone
  readonly code?: boolean
}

/** 相对时间的读法（宿主负责让它保持最新）。 */
export type RelativeTimeFormat = 'long' | 'short' | 'duration'

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

/** `Stack` 的 props。 */
export interface StackProps {
  readonly children?: OrcaNode
  readonly gap?: Gap
  readonly align?: Align
}

/** `Row` 的 props。 */
export interface RowProps {
  readonly children?: OrcaNode
  readonly gap?: Gap
  readonly align?: Align
  readonly justify?: 'start' | 'center' | 'end' | 'between'
  readonly wrap?: boolean
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

/** `Button` 的 props。 */
export interface ButtonProps {
  readonly children?: OrcaNode
  readonly variant?: Variant
  readonly tone?: Tone
  readonly size?: Size
  readonly icon?: IconName
  readonly tooltip?: string
  readonly disabled?: boolean
  readonly onPress?: Press
}

/** `IconButton` 的 props（没有子节点，`label` 是它的无障碍名）。 */
export interface IconButtonProps {
  readonly icon: IconName
  readonly label: string
  readonly tooltip?: string
  readonly variant?: Variant
  readonly tone?: Tone
  readonly size?: Size
  readonly disabled?: boolean
  readonly onPress?: Press
}

/** `Badge` 的 props。 */
export interface BadgeProps {
  readonly children?: OrcaNode
  readonly tone?: Tone
}

/** `Card` 的 props。 */
export interface CardProps {
  readonly children?: OrcaNode
  readonly title?: string
  readonly description?: string
}

/** `List` 的 props；子节点只能是 `ListItem`。 */
export interface ListProps {
  readonly children?: OrcaNode
  readonly label?: string
}

/** `ListItem` 的 props。 */
export interface ListItemProps {
  readonly children?: OrcaNode
  readonly title?: string
  readonly description?: string
  readonly icon?: IconName
  readonly current?: boolean
  readonly disabled?: boolean
  readonly onPress?: Press
}

/** `Input` 的 props。 */
export interface InputProps {
  readonly label: string
  readonly labelHidden?: boolean
  readonly value?: string
  readonly defaultValue?: string
  readonly placeholder?: string
  readonly type?: 'text' | 'search' | 'password'
  readonly maxLength?: number
  readonly invalid?: boolean
  readonly disabled?: boolean
  readonly onChange?: (value: string) => void
  readonly onSubmit?: (value: string) => void
}

/** `Textarea` 的 props。 */
export interface TextareaProps {
  readonly label: string
  readonly labelHidden?: boolean
  readonly value?: string
  readonly defaultValue?: string
  readonly placeholder?: string
  readonly rows?: number
  readonly maxLength?: number
  readonly invalid?: boolean
  readonly disabled?: boolean
  readonly onChange?: (value: string) => void
  readonly onSubmit?: (value: string) => void
}

/** `Switch` 的 props。 */
export interface SwitchProps {
  readonly label: string
  readonly checked?: boolean
  readonly defaultChecked?: boolean
  readonly disabled?: boolean
  readonly onChange?: (checked: boolean) => void
}

/** `Checkbox` 的 props。 */
export interface CheckboxProps {
  readonly label: string
  readonly description?: string
  readonly checked?: boolean
  readonly defaultChecked?: boolean
  readonly disabled?: boolean
  readonly onChange?: (checked: boolean) => void
}

/** `Select` 的 props。 */
export interface SelectProps {
  readonly label: string
  readonly labelHidden?: boolean
  readonly value?: string
  readonly defaultValue?: string
  readonly placeholder?: string
  readonly options: readonly SelectOption[]
  readonly disabled?: boolean
  readonly onChange?: (value: string) => void
}

/** `RadioGroup` 的 props。 */
export interface RadioGroupProps {
  readonly label: string
  readonly labelHidden?: boolean
  readonly value?: string
  readonly defaultValue?: string
  readonly options: readonly RadioOption[]
  readonly orientation?: 'vertical' | 'horizontal'
  readonly disabled?: boolean
  readonly onChange?: (value: string) => void
}

/** `Slider` 的 props。 */
export interface SliderProps {
  readonly label: string
  readonly labelHidden?: boolean
  readonly value?: number
  readonly defaultValue?: number
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly showValue?: boolean
  readonly disabled?: boolean
  readonly onChange?: (value: number) => void
}

/** `Field` 的 props：给一个控件套上标签、说明与错误。 */
export interface FieldProps {
  readonly children?: OrcaNode
  readonly label: string
  readonly description?: string
  readonly error?: string
  readonly required?: boolean
}

/** `Separator` 的 props。 */
export interface SeparatorProps {
  readonly orientation?: 'horizontal' | 'vertical'
}

/** `Progress` 的 props。 */
export interface ProgressProps {
  readonly label: string
  readonly labelHidden?: boolean
  readonly value?: number
}

/** `Spinner` 的 props。 */
export interface SpinnerProps {
  readonly label: string
  readonly labelHidden?: boolean
}

/** `EmptyState` 的 props。 */
export interface EmptyStateProps {
  readonly children?: OrcaNode
  readonly title: string
  readonly description?: string
  readonly icon?: IconName
}

/** `Link` 的 props。 */
export interface LinkProps {
  readonly children?: OrcaNode
  readonly href?: string
  readonly onPress?: Press
}

/** `Code` 的 props。 */
export interface CodeProps {
  readonly children?: OrcaNode
  readonly block?: boolean
}

/** `Tabs` 的 props；子节点只能是 `Tab`。 */
export interface TabsProps {
  readonly children?: OrcaNode
  readonly label: string
  readonly value?: string
  readonly defaultValue?: string
  readonly onChange?: (value: string) => void
}

/** `Tab` 的 props。 */
export interface TabProps {
  readonly children?: OrcaNode
  readonly value: string
  readonly label: string
  readonly icon?: IconName
  readonly disabled?: boolean
}

/** `Collapsible` 的 props。 */
export interface CollapsibleProps {
  readonly children?: OrcaNode
  readonly title: string
  readonly description?: string
  readonly open?: boolean
  readonly defaultOpen?: boolean
  readonly disabled?: boolean
  readonly onChange?: (open: boolean) => void
}

/** `Toolbar` 的 props。 */
export interface ToolbarProps {
  readonly children?: OrcaNode
  readonly label: string
  readonly gap?: Gap
}

/** `Grid` 的 props。 */
export interface GridProps {
  readonly children?: OrcaNode
  readonly columns?: 1 | 2 | 3 | 4 | 5 | 6
  readonly minItemWidth?: Size | 'lg'
  readonly gap?: Gap
}

/** `Table` 的 props。 */
export interface TableProps {
  readonly label: string
  readonly columns: readonly TableColumn[]
  readonly rows: readonly TableRow[]
  readonly sort?: TableSort
  readonly selectionMode?: 'none' | 'single' | 'multiple'
  readonly selected?: readonly string[]
  readonly defaultSelected?: readonly string[]
  readonly hasMore?: boolean
  readonly loading?: boolean
  readonly emptyText?: string
  readonly maxHeight?: 'sm' | 'md' | 'lg' | 'none'
  readonly onSortChange?: (sort: TableSort) => void
  readonly onSelectionChange?: (selection: { keys: string[] }) => void
  readonly onRowAction?: (row: { key: string }) => void
  readonly onLoadMore?: () => void
}

/** `Tree` 的 props。 */
export interface TreeProps {
  readonly label: string
  readonly items: readonly TreeItem[]
  readonly selected?: string
  readonly defaultSelected?: string
  readonly expanded?: readonly string[]
  readonly defaultExpanded?: readonly string[]
  readonly maxHeight?: 'sm' | 'md' | 'lg' | 'none'
  readonly onSelect?: (item: { key: string }) => void
  readonly onToggle?: (item: { key: string; expanded: boolean }) => void
  readonly onAction?: (item: { key: string }) => void
}

/** `Markdown` 的 props：只渲染核心子集（标题/段落/列表/代码块/链接）。 */
export interface MarkdownProps {
  readonly content: string
}

/** `CodeView` 的 props。 */
export interface CodeViewProps {
  readonly code: string
  readonly language?: string
  readonly label?: string
  readonly lineNumbers?: boolean
  readonly wrap?: boolean
  readonly maxHeight?: 'sm' | 'md' | 'lg' | 'none'
}

/** `Image` 的 props（只能是插件文件夹内的相对路径）。 */
export interface ImageProps {
  readonly src: string
  readonly alt: string
  readonly size?: Size | 'lg' | 'full'
  readonly fit?: 'contain' | 'cover'
  readonly rounded?: boolean
}

/** `KeyValue` 的 props。 */
export interface KeyValueProps {
  readonly label?: string
  readonly items: readonly KeyValueItem[]
}

/** `Callout` 的 props：警告、错误、确认与提示都用它。 */
export interface CalloutProps {
  readonly children?: OrcaNode
  readonly tone?: Tone
  readonly title?: string
  readonly icon?: IconName
}

/** `Skeleton` 的 props。 */
export interface SkeletonProps {
  readonly shape?: 'text' | 'block' | 'circle'
  readonly lines?: number
  readonly label?: string
}

/** `RelativeTime` 的 props：宿主负责让文字保持最新，面板绝不自己计时。 */
export interface RelativeTimeProps {
  readonly at: number
  readonly format?: RelativeTimeFormat
  readonly tone?: Tone
  readonly muted?: boolean
}

/** `Box` 的 props（带内边距、边框、底色与滚动的容器）。 */
export interface BoxProps {
  readonly children?: OrcaNode
  readonly direction?: 'row' | 'column'
  readonly gap?: Gap
  readonly padding?: Gap
  readonly paddingX?: Gap
  readonly paddingY?: Gap
  readonly margin?: Gap
  readonly align?: Align
  readonly justify?: 'start' | 'center' | 'end' | 'between'
  readonly wrap?: boolean
  readonly grow?: boolean
  readonly shrink?: boolean
  readonly width?: 'auto' | 'full'
  readonly height?: 'auto' | 'full'
  readonly minWidth?: 'auto' | 'full'
  readonly maxWidth?: 'auto' | 'full'
  readonly minHeight?: 'auto' | 'full'
  readonly maxHeight?: 'auto' | 'full'
  readonly columns?: 1 | 2 | 3 | 4 | 5 | 6
  readonly scroll?: 'x' | 'y' | 'both'
  readonly border?: boolean | Tone
  readonly radius?: 'none' | 'sm' | 'md' | 'lg' | 'full'
  readonly background?: 'none' | 'muted' | 'card' | Tone
}

export declare function Stack(props: StackProps): OrcaElement
export declare function Row(props: RowProps): OrcaElement
export declare function Heading(props: HeadingProps): OrcaElement
export declare function Text(props: TextProps): OrcaElement
export declare function Button(props: ButtonProps): OrcaElement
export declare function IconButton(props: IconButtonProps): OrcaElement
export declare function Badge(props: BadgeProps): OrcaElement
export declare function Card(props: CardProps): OrcaElement
export declare function List(props: ListProps): OrcaElement
export declare function ListItem(props: ListItemProps): OrcaElement
export declare function Input(props: InputProps): OrcaElement
export declare function Textarea(props: TextareaProps): OrcaElement
export declare function Switch(props: SwitchProps): OrcaElement
export declare function Checkbox(props: CheckboxProps): OrcaElement
export declare function Select(props: SelectProps): OrcaElement
export declare function RadioGroup(props: RadioGroupProps): OrcaElement
export declare function Slider(props: SliderProps): OrcaElement
export declare function Field(props: FieldProps): OrcaElement
export declare function Separator(props: SeparatorProps): OrcaElement
export declare function Progress(props: ProgressProps): OrcaElement
export declare function Spinner(props: SpinnerProps): OrcaElement
export declare function EmptyState(props: EmptyStateProps): OrcaElement
export declare function Link(props: LinkProps): OrcaElement
export declare function Code(props: CodeProps): OrcaElement
export declare function Tabs(props: TabsProps): OrcaElement
export declare function Tab(props: TabProps): OrcaElement
export declare function Collapsible(props: CollapsibleProps): OrcaElement
export declare function Toolbar(props: ToolbarProps): OrcaElement
export declare function Grid(props: GridProps): OrcaElement
export declare function Table(props: TableProps): OrcaElement
export declare function Tree(props: TreeProps): OrcaElement
export declare function Markdown(props: MarkdownProps): OrcaElement
export declare function CodeView(props: CodeViewProps): OrcaElement
export declare function Image(props: ImageProps): OrcaElement
export declare function KeyValue(props: KeyValueProps): OrcaElement
export declare function Callout(props: CalloutProps): OrcaElement
export declare function Skeleton(props: SkeletonProps): OrcaElement
export declare function RelativeTime(props: RelativeTimeProps): OrcaElement
export declare function Box(props: BoxProps): OrcaElement

// ---------------------------------------------------------------------------
// 运行时：atom、渲染、插件桥
// ---------------------------------------------------------------------------

/** 可读 atom。 */
export interface ReadonlyAtom<T> {
  readonly __atom?: T
}

/** 可写 atom。 */
export interface Atom<T> extends ReadonlyAtom<T> {}

/** keyed atom 的持久化范围。 */
export type PersistScope = 'memory' | 'plugin' | 'workspace' | 'storage'

/** keyed atom 的选项。 */
export interface AtomOptions<T> {
  readonly persist?: PersistScope
  readonly version?: number
  readonly migrate?: (stored: JsonValue, fromVersion: number) => T
}

/** 本面板运行期的状态。 */
export declare function atom<T>(initial: T): Atom<T>
/** 具名状态：同一插件内唯一，可跨面板运行持久化。 */
export declare function atom<T>(key: string, initial: T, options?: AtomOptions<T>): Atom<T>
/** 从其他 atom 派生；渲染时读它会订阅它读到的东西。 */
export declare function derived<T>(compute: () => T): ReadonlyAtom<T>
/** 渲染时读取（并订阅）。 */
export declare function read<T>(atom: ReadonlyAtom<T>): T
/** 赋值；批量生效。 */
export declare function set<T>(atom: Atom<T>, value: T): void
/** 用更新函数赋值；批量生效。 */
export declare function update<T>(atom: Atom<T>, updater: (previous: T) => T): void

/**
 * 面板 ↔ worker 的契约（§M.6）：由 `src/panel/protocol.ts` 用声明合并填充，
 * 因此两侧共用一份类型，名字写错在编译期就炸。
 */
export interface PluginRequests {}
/** worker 推给面板的事件，同样由 `src/panel/protocol.ts` 填充。 */
export interface PluginPanelEvents {}

/** 已声明请求的输入类型（没写 `input` 的请求不带参数）。 */
export type PluginRequestInput<K extends keyof PluginRequests> = PluginRequests[K] extends {
  input: infer I
}
  ? I
  : undefined

/** 已声明请求的输出类型。 */
export type PluginRequestOutput<K extends keyof PluginRequests> = PluginRequests[K] extends {
  output: infer O
}
  ? O
  : JsonValue

/** `plugin.request` 的选项。 */
export interface PluginRequestOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

/** 插件桥：请求自己的 worker，听它推送。 */
export interface PluginBridgeApi {
  request<K extends keyof PluginRequests>(
    name: K,
    ...args: PluginRequestInput<K> extends undefined ? [] : [input: PluginRequestInput<K>]
  ): Promise<PluginRequestOutput<K>>
  on<K extends keyof PluginPanelEvents>(
    event: K,
    handler: (payload: PluginPanelEvents[K]) => void
  ): Disposable
}

/** `setup(ctx)` 收到的上下文。 */
export interface PanelContext {
  readonly subscriptions: Disposable[]
  readonly signal: AbortSignal
  /** 面板是否可见；隐藏时不做任何请求（§M.6）。 */
  readonly visible: ReadonlyAtom<boolean>
  readonly panel: { readonly id: string }
}

/** 面板模块：默认导出的组件函数，可选 `setup`。 */
export type PanelSetup = (ctx: PanelContext) => void | (() => void)

/** 宿主错误：拒绝时带 `code`。 */
export interface HostError extends Error {
  readonly code: string
  readonly retryable: boolean
}

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

/**
 * 面板的运行环境。`theme` 是宿主给的 `{ colorScheme }`（读它会在浅/深切换时重渲染，
 * 见 references/components.md 的 `env.theme: Theme`），不是裸字符串。
 */
export declare const env: {
  readonly locale: string
  readonly theme: { readonly colorScheme: 'light' | 'dark' }
  readonly client: 'desktop'
}

/** 面板组件目录版本；随宿主增长，可用来做特性探测。 */
export declare const ui: {
  readonly catalog: number
  has(component: string, prop?: string): boolean
}

/** 插件桥（`plugin.request` / `plugin.on`）。 */
export declare const plugin: PluginBridgeApi

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

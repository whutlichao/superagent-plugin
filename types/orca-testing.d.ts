// 手写的 `orca/testing` 最小声明：测试挂载器、mock host 与 check 情景（§N.3）。
//
// pinned to Orca 1.4.251 —— 来源 `orca skills get orca-plugin-authoring` 的
// references/testing.md。只声明本仓库测试实际用到的成员；不写实现、不写 `any` 逃逸。

import type { JsonValue, OrcaNode, PanelContext } from 'orca'
import type { OrcaWorkerApi } from 'orca/worker'

/** 宿主错误（refusals 与注入的失败）。 */
export interface HostError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly retryAfterMs?: number
}

/** 测试查询：按类型、角色、文本、标签或 testId 找节点。 */
export interface TestQuery {
  readonly type?: string
  readonly role?: string
  readonly text?: string | RegExp
  readonly label?: string | RegExp
  readonly testId?: string
}

/** 一次被宿主拒绝的调用。 */
export interface MockHostRefusal {
  readonly method: string
  readonly code: string
  readonly message?: string
}

/** 面板或 worker 的检查问题（`file:line:col`）。 */
export interface PanelIssue {
  readonly file?: string
  readonly line?: number
  readonly column?: number
  readonly message: string
}

/** mockHost 的选项。 */
export interface MockHostOptions {
  readonly capabilities?: readonly string[]
  readonly results?: Readonly<Record<string, JsonValue>>
  readonly requests?: Readonly<Record<string, (input: JsonValue) => JsonValue>>
  readonly storage?: Readonly<Record<string, JsonValue>>
  readonly settings?: Readonly<Record<string, JsonValue>>
  readonly secrets?: Readonly<Record<string, string>>
}

/** mockHost 返回的替身宿主。 */
export interface MockHost {
  readonly calls: readonly { readonly method: string; readonly params: unknown }[]
  readonly refusals: readonly MockHostRefusal[]
  callsOf(method: string): readonly unknown[]
  respond(method: string, result: JsonValue): void
  data(): {
    readonly storage: Readonly<Record<string, JsonValue>>
    readonly settings: Readonly<Record<string, JsonValue>>
    readonly secrets: Readonly<Record<string, string>>
  }
}

/** `mount` 的选项。 */
export interface MountOptions {
  readonly host?: MockHost
  readonly theme?: 'light' | 'dark'
  readonly locale?: string
  readonly visible?: boolean
  readonly panelId?: string
  readonly persisted?: {
    readonly plugin?: Readonly<Record<string, JsonValue>>
    readonly workspace?: Readonly<Record<string, JsonValue>>
    /** `persist: 'storage'` 的 keyed atom 的种子值（写进插件私有存储）。 */
    readonly storage?: Readonly<Record<string, JsonValue>>
  }
}

/** 面板模块：默认导出的组件函数，可选 `setup`。 */
export interface PanelModule {
  readonly default: () => OrcaNode
  readonly setup?: (context: PanelContext) => void | (() => void)
}

/** 一个查到的元素（`find` / `findAll` 的结果）。 */
export interface TestElement {
  readonly type: string
  readonly role: string
  readonly label?: string
  readonly text?: string
  readonly disabled: boolean
  readonly path: string
}

/** 面板里已持久化的值：按作用域分。 */
export interface PersistedValues {
  readonly plugin: Readonly<Record<string, JsonValue>>
  readonly workspace: Readonly<Record<string, JsonValue>>
  readonly storage: Readonly<Record<string, JsonValue>>
}

/** `mount` 返回的测试面板。 */
export interface TestPanel {
  readonly host: MockHost
  /** 渲染或处理器抛出的错误，以及 Orca 会拒绝的渲染。 */
  readonly errors: readonly PanelIssue[]
  /** Orca 会丢弃的 props 与组件，附它自己的警告。 */
  readonly warnings: readonly string[]
  /** 即便面板接住了，Orca 也会拒绝的宿主调用。 */
  readonly refusals: readonly MockHostRefusal[]
  /** 面板此刻持久化的值。 */
  readonly persisted: PersistedValues
  find(query: TestQuery): TestElement | null
  findAll(query: TestQuery): readonly TestElement[]
  tree(): JsonValue
  summary(): readonly string[]
  press(target: TestQuery): Promise<void>
  type(target: TestQuery, text: string, options?: { replace?: boolean; submit?: boolean }): Promise<void>
  submit(target: TestQuery): Promise<void>
  toggle(target: TestQuery): Promise<void>
  /** A Table header click (`onSortChange`). */
  sort(target: TestQuery, column: string): Promise<void>
  /** Replaces a Table's selection with exactly these rows. */
  selectRows(target: TestQuery, keys: readonly string[]): Promise<void>
  /** Enter or a double click on a Table row (its `onRowAction`). */
  activateRow(target: TestQuery, key: string): Promise<void>
  /** Scrolls a Table to the end of its loaded rows (`hasMore` + `onLoadMore`). */
  loadMore(target: TestQuery): Promise<void>
  /** Expands a Tree item (one with children). */
  expand(target: TestQuery, key: string): Promise<void>
  /** Collapses a Tree item. */
  collapse(target: TestQuery, key: string): Promise<void>
  /** Selects a Tree item (`onSelect`). */
  selectItem(target: TestQuery, key: string): Promise<void>
  /** A Tree item's own action (`onAction`). */
  activateItem(target: TestQuery, key: string): Promise<void>
  /** The keys of a Tree's expanded items. */
  expandedOf(target: TestQuery): readonly string[]
  /** The keys of a Table's columns Orca shows at `width` px (wide when omitted). */
  columnsOf(target: TestQuery, view?: { readonly width?: number }): readonly string[]
  /** The keys of a Table's rows, in the order Orca draws them. */
  rowsOf(target: TestQuery): readonly string[]
  select(target: TestQuery, value: string): Promise<void>
  slide(target: TestQuery, value: number): Promise<void>
  valueOf(target: TestQuery): JsonValue
  emit(event: string, payload: JsonValue): Promise<void>
  post(event: string, payload?: JsonValue): Promise<void>
  /** 隐藏或显示面板，像切走侧边栏那样。 */
  setVisible(visible: boolean): Promise<void>
  rerender(): Promise<void>
  settled(): Promise<void>
  unmount(): Promise<void>
}

/** worker 模块：默认导出的 `activate(orca)`，可选 `deactivate`。 */
export interface WorkerModule {
  readonly default: (orca: OrcaWorkerApi) => void | Promise<void>
  readonly deactivate?: () => void | Promise<void>
}

/** `mountWorker` 的选项。 */
export interface MountWorkerOptions {
  readonly host?: MockHost
  readonly events?: readonly string[]
  readonly commands?: readonly string[]
  readonly hooks?: readonly (string | { readonly event: string; readonly onError?: 'pass' | 'deny' })[]
}

/** 一条面板推送。 */
export interface WorkerPost {
  readonly event: string
  readonly payload?: unknown
  readonly panel?: string
}

/** 钩子裁决。 */
export type HookDecision =
  | { readonly kind: 'continue'; readonly event: unknown }
  | { readonly kind: 'deny'; readonly reason: string }

/** `mountWorker` 返回的测试 worker。 */
export interface TestWorker {
  readonly host: MockHost
  readonly logs: readonly string[]
  readonly refusals: readonly MockHostRefusal[]
  readonly posts: readonly WorkerPost[]
  emit(event: string, payload: JsonValue): Promise<void>
  hooks: {
    fire(hook: string, event: JsonValue): Promise<HookDecision>
  }
  command(commandId: string, args?: JsonValue): Promise<JsonValue>
  request(name: string, input?: JsonValue, caller?: { readonly panel?: string }): Promise<JsonValue>
  deactivate(): Promise<void>
}

/** `defineCheck` 的一个情景：mockHost 选项 + 挂载与事件。 */
export interface CheckScenario extends MockHostOptions {
  readonly persisted?: MountOptions['persisted']
  readonly theme?: 'light' | 'dark'
  readonly events?: readonly { readonly event: string; readonly payload: JsonValue }[]
}

export declare function mockHost(options?: MockHostOptions): MockHost
export declare function hostError(code: string, message?: string, retryAfterMs?: number): HostError
export declare function mount(
  target: PanelModule | (() => OrcaNode),
  options?: MountOptions
): Promise<TestPanel>
export declare function mountWorker(
  module: WorkerModule,
  options?: MountWorkerOptions
): Promise<TestWorker>
export declare function defineCheck<S extends Record<string, CheckScenario>>(scenarios: S): S

/** `node:test` 的再导出，让测试不必依赖 Node 类型。 */
export declare function test(name: string, fn: () => unknown): Promise<void>
export declare function describe(name: string, fn: () => unknown): Promise<void>
export declare function beforeEach(fn: () => unknown): void
export declare function afterEach(fn: () => unknown): void

/** `node:assert` 的再导出子集。 */
export declare const assert: {
  (value: unknown, message?: string): asserts value
  equal(actual: unknown, expected: unknown, message?: string): void
  notEqual(actual: unknown, expected: unknown, message?: string): void
  deepEqual(actual: unknown, expected: unknown, message?: string): void
  ok(value: unknown, message?: string): asserts value
  strictEqual(actual: unknown, expected: unknown, message?: string): void
  throws(fn: () => unknown, expected?: unknown, message?: string): void
  rejects(promise: Promise<unknown>, expected?: unknown, message?: string): Promise<void>
}

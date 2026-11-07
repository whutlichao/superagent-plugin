// `GET state`（§G.2 的 `status` 读数、§N.4 的 health、§M.2 的 Overview 首屏）。
//
// 形状（CLI 与面板共用，字段名即契约）：
// {
//   process: { pid, startedAt, stateDir },
//   store:   { path, schemaVersion, journalMode },
//   http:    { host, port, requests },
//   loops:   [{ name, state }],
//   health:  { <entry>: { state, detail?, at } },
//   setup:   { problem: null | { place, code, detail? } },
//   paused:  boolean,
//   load:    { running, queued, maxWorkers }
// }
//
// 本票只有 `store` 是真读数（真库），其余从注入的端口取：进程与 HTTP 由 server 提供，
// health/setup/paused/loops/load 的写者在后续票（#45、#44、#6、#11），缺省值就是「还没接上」。
import type { Store } from '../app/store.ts'
import type { HealthState } from '../core/index.ts'

/**
 * health 条目的四档状态（§J.3、§N.4）：**就是**领域 `core/ports.ts` 的 `HEALTH_STATES`，
 * 这里原样转出，绝不另写一份——这张表曾经分叉过（`warning` 对 `starting/paused`）。
 */
export type { HealthState }

/** 一条 health 读数。 */
export interface HealthEntry {
  readonly state: HealthState
  readonly detail?: string
  readonly at: string
}

/** 一个 setup 问题（§N.4 / §G.2 的 `setup` 段）。 */
export interface SetupProblem {
  readonly place: string
  readonly code: string
  readonly detail?: string
}

/** 一个后台循环的读数（passes/effects/outbox/sources/router/statusbar）。 */
export interface LoopEntry {
  readonly name: string
  readonly state: HealthState
}

/** Executor 负载（§E.6：running / queued / maxWorkers，人类槽单列是 #11 的事）。 */
export interface LoadView {
  readonly running: number
  readonly queued: number
  readonly maxWorkers: number
}

/**
 * state 视图需要的宿主端口。全部有缺省实现，所以测试与接线可以只给关心的一项。
 * 真正的写者：health/setup → #45/#44，paused → 设置（#25），loops → #6，maxWorkers → #11。
 */
export interface HttpHost {
  readonly store: Store
  /** 状态目录（doctor 与 process 段用）。 */
  readonly stateDir: string
  /** 本进程 pid（缺省 `process.pid`）。 */
  readonly pid?: number
  /** 本进程启动时刻（ISO-8601；缺省「现在」）。 */
  readonly startedAt?: string
  /** health 条目（缺省只有 `runtime: ready`，由 server 自己填）。 */
  readonly health?: () => Readonly<Record<string, HealthEntry>>
  /** setup 问题（缺省 `{problem: null}`）。 */
  readonly setup?: () => { readonly problem: SetupProblem | null }
  /** 处理是否暂停（缺省 false）。 */
  readonly paused?: () => boolean
  /** 后台循环（缺省空：本票不起任何循环）。 */
  readonly loops?: () => readonly LoopEntry[]
  /** worker slots 上限（§E.6 缺省 2）。 */
  readonly maxWorkers?: () => number
  /**
   * CLI 绝对路径（#8 的 doctor「CLI 路径」项用）。缺省 `undefined`：doctor 报 warn，
   * 不猜一个可能不存在的路径。
   */
  readonly cliPath?: string
}

/** HTTP 段里由 server 自己填的两个读数。 */
export interface HttpSelfView {
  readonly host: string
  readonly port: number
  readonly requests: number
}

/** `GET state` 的完整形状。 */
export interface StateView {
  readonly process: { readonly pid: number; readonly startedAt: string; readonly stateDir: string }
  readonly store: { readonly path: string; readonly schemaVersion: number; readonly journalMode: string }
  readonly http: HttpSelfView
  readonly loops: readonly LoopEntry[]
  readonly health: Readonly<Record<string, HealthEntry>>
  readonly setup: { readonly problem: SetupProblem | null }
  readonly paused: boolean
  readonly load: LoadView
}

/** §E.6 的缺省并发：`settings.executor.maxWorkers` 缺省 2。 */
export const DEFAULT_MAX_WORKERS = 2

/**
 * 默认的 health：只有一个 `runtime: ready` 条目，detail 写实际监听的地址。
 * 真正的 HealthBoard 由 #45 接管（每部件一条、单一写者）。
 */
export function defaultHealth(http: HttpSelfView, at: string): Readonly<Record<string, HealthEntry>> {
  return {
    runtime: { state: 'ready', detail: `loopback api on ${http.host}:${http.port}`, at }
  }
}

/** 一条 health error 条目（Overview 的 System problems 与 `status` 的退出码读它）。 */
export interface HealthProblem {
  readonly name: string
  readonly state: 'error'
  readonly detail?: string
}

/**
 * 把 health 读数里所有 error 条目按条目名升序列出（§N.4）。面板的 System problems、状态栏的
 * problem 计数与 `status` 的 2/1 判定都从这一份推导，避免两边各判一次。
 */
export function healthProblems(
  health: Readonly<Record<string, HealthEntry | undefined>>
): readonly HealthProblem[] {
  return Object.entries(health)
    .filter(([, entry]) => entry?.state === 'error')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, entry]) => ({
      name,
      state: 'error',
      ...(entry?.detail === undefined ? {} : { detail: entry.detail })
    }))
}

/** 面板 health 摘要（`WorkerHealth.error`）与状态栏的 problem 计数。 */
export interface HealthSummary {
  readonly error: boolean
  readonly problems: number
}

/** 同一份 health 读数的两个派生值：有没有 error、有几条。 */
export function healthSummary(
  health: Readonly<Record<string, HealthEntry | undefined>>
): HealthSummary {
  const problems = healthProblems(health).length
  return { error: problems > 0, problems }
}

/** `status` 的四个退出码（§N.4）：0 正常、1 运行时问题、2 非运行时部件报错、3 未就绪。 */
export type StatusCode = 0 | 1 | 2 | 3

/**
 * `status` 的退出码（§N.4，与上游 `scripts/dsh-superagent status` 对齐；#8 补「暂停」一档）：
 *   1 runtime 不是 ready/paused —— 没跑 / 不响应 / 运行时错误（starting 也算「还没跑起来」，
 *     与上游 `runtime_up()` 的判定一致）；
 *   3 等 setup（`setup.problem` 非空）—— 重启不修，要人补配置；
 *   3 已暂停（`paused: true`）—— 不是故障，但「不在处理」，所以是未就绪；
 *   2 非 runtime 的 health 条目报错 —— 重启不修，要人看；
 *   0 其余。
 *
 * 顺序即优先级，与上游 `outcome()` 的骨架一致（runtime 先、setup 次、部件错误最后）：
 * 「人为停下来的两种状态」（等 setup、已暂停）排在部件错误之前——它们解释了「为什么现在
 * 什么都没有发生」，而部件错误是恢复处理之后才会被消费的事实。
 *
 * 这里**不是** CLI 专用的：`status` 与面板读同一个 `StateView`，所以判定放在读模型旁边，
 * CLI 只负责把 0/1/2/3 换成它自己的 `ExitCode`。
 */
export function statusCode(view: unknown): StatusCode {
  if (typeof view !== 'object' || view === null) return 1
  const state = view as {
    readonly health?: Readonly<Record<string, HealthEntry | undefined>>
    readonly setup?: { readonly problem?: unknown } | null
    readonly paused?: unknown
  }
  const health = state.health ?? {}
  const runtime = health['runtime']?.state
  if (runtime !== 'ready' && runtime !== 'paused') return 1
  const setupProblem = state.setup?.problem
  if (setupProblem !== null && setupProblem !== undefined) return 3
  if (state.paused === true) return 3
  return healthProblems(health).some((problem) => problem.name !== 'runtime') ? 2 : 0
}

/**
 * 组装 `GET state`。`http` 由调用方（server）给出实际监听读数——这样 CLI 看到的端口
 * 永远等于端口文件里的那个。
 */
export function stateView(host: HttpHost, http: HttpSelfView, at: string): StateView {
  const pragmas = host.store.pragmas()
  return {
    process: {
      pid: host.pid ?? process.pid,
      startedAt: host.startedAt ?? at,
      stateDir: host.stateDir
    },
    store: {
      path: host.store.path,
      schemaVersion: host.store.schemaVersion(),
      journalMode: pragmas.journalMode
    },
    http,
    loops: host.loops?.() ?? [],
    health: host.health?.() ?? defaultHealth(http, at),
    setup: host.setup?.() ?? { problem: null },
    paused: host.paused?.() ?? false,
    load: loadView(host.store, host.maxWorkers?.() ?? DEFAULT_MAX_WORKERS)
  }
}

/**
 * Executor 负载（§E.6 的计数口径）：`running` = 最新 Assignment 状态为 running 的未结束
 * Ticket 数；`queued` = 最新 Assignment 是 pending（或还没有 Assignment）的未结束 Ticket 数。
 * 查询与读法在 `app/store-read.ts` 的 `ASSIGNMENT_COUNT_SQL`（与 `latestAssignment()` 同义）。
 */
export function loadView(store: Store, maxWorkers: number): LoadView {
  const counts = store.assignmentCounts()
  return { running: counts.running, queued: counts.queued, maxWorkers }
}

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
import type { Store } from '../app/store'

/** health 条目的四档状态（§N.4）。 */
export type HealthState = 'starting' | 'ready' | 'paused' | 'error'

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

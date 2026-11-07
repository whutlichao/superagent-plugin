// 健康看板（§N.4）：每个条目只能有一个写者，重复 claim 直接抛。
//
// 这是「每个条目一个写者」（§D.4 写者表末行）的可执行形式。条目名是唯一的键：`runtime`、
// `passes`、`assessment`……`delivery` 也在这里占一行，但它自己不写错误（§J.3：投递失败写
// 在 Ticket 上），只由队列写计数。
//
// 纪律（与 `sources/registry.ts` 的默认实现同语义，但这里是权威实现）：
// - claim(name) 返回的句柄是唯一写入口；第二个 claim 同名条目抛错；
// - release() 之后旧句柄的 set 变成空操作（迟到的报告不能污染后来的写者）；
// - `all()` 按条目名升序给面板与 `GET state` 读数（顺序稳定，便于快照比对）。
//
// 依赖纪律（§C.2）：infra 只依赖 core 的类型，不 import app / sources / runtime。
import type { HealthEntry } from '../core/index.ts'

/**
 * §N.4 的固定条目名，顺序即设计表格顺序。唯一的前缀族是 `sync:<source id>`（写者是
 * settings）；其余条目名由这里一处给出，面板、测试与 doctor 都读它。
 *
 * 这张表是「条目恰好这些」的可执行形式：谁要是发明了第 18 个固定条目，`health.test.ts`
 * 会先把设计表格与代码摆在一起对不上。
 */
export const HEALTH_ENTRIES = [
  'runtime',
  'passes',
  'models',
  'evals',
  'assessment',
  'launch',
  'delivery',
  'relay',
  'notice',
  'reply',
  'return',
  'backup',
  'worker',
  'router',
  'github',
  'feishu',
  'history',
  'sources'
] as const

/** 一个固定条目名（`sync:<source id>` 不在其中，它是前缀族）。 */
export type HealthEntryName = (typeof HEALTH_ENTRIES)[number]

/** `sync:<source id>` 的前缀：名单同步由 settings 写，每个 Source 实例一条（§N.4）。 */
export const SYNC_HEALTH_PREFIX = 'sync:'

/** 拼出一个名单同步条目名；空 id 不是条目，直接拒绝。 */
export function syncHealthEntry(sourceId: string): string {
  if (sourceId.trim() === '') throw new Error('A sync health entry needs a Source id')
  return `${SYNC_HEALTH_PREFIX}${sourceId}`
}

/** 这个条目名是否是 §N.4 的固定条目或一个非空的 `sync:<id>`。 */
export function isHealthEntryName(name: string): boolean {
  return (
    (HEALTH_ENTRIES as readonly string[]).includes(name) ||
    (name.startsWith(SYNC_HEALTH_PREFIX) && name.length > SYNC_HEALTH_PREFIX.length)
  )
}

/** 连续失败多少次才把条目标成 error（§N.4「连续 3 次失败 → error」；effects/passes 共用）。 */
export const FAILURES_BEFORE_ERROR = 3

/** `models` 条目的 detail：模型由 Orca 负责，插件不做预算重试（§H.4）。 */
export const MODELS_HEALTH_DETAIL = 'handled by Orca'

/** 一个已 claim 的条目：读当前值、写新值、注销自己。 */
export interface HealthEntryHandle {
  get(): HealthEntry | undefined
  set(entry: HealthEntry): void
  /** 注销：之后本句柄的 `set` 是空操作，条目可以被别的部件重新 claim。 */
  release(): void
}

/** 健康板的唯一接口（组合根与测试注入这一个）。 */
export interface HealthBoardLike {
  claim(name: string, initial?: HealthEntry): HealthEntryHandle
  all(): Readonly<Record<string, HealthEntry>>
}

/**
 * 单一写者的健康板。条目按名字 claim；没有 claim 过的条目不出现在 `all()` 里，
 * 因此「谁没接上」在面板上表现为缺行，而不是一行假就绪。
 */
export class HealthBoard implements HealthBoardLike {
  readonly #entries = new Map<string, HealthEntry>()
  readonly #claimed = new Set<string>()

  /**
   * 占住一个条目名。`initial` 是占住时立刻生效的读数（缺省不写：还没接上的部件不该
   * 假装 ready）。
   * @throws 该条目已被别的部件 claim。
   */
  claim(name: string, initial?: HealthEntry): HealthEntryHandle {
    if (this.#claimed.has(name)) {
      throw new Error(`The health entry ${name} is already reported by another part`)
    }
    this.#claimed.add(name)
    if (initial !== undefined) this.#entries.set(name, initial)
    let held = true
    return {
      get: () => this.#entries.get(name),
      set: (entry: HealthEntry): void => {
        if (held) this.#entries.set(name, entry)
      },
      release: (): void => {
        if (!held) return
        held = false
        this.#claimed.delete(name)
        this.#entries.delete(name)
      }
    }
  }

  /** 当前读数，按条目名升序（面板与 `GET state` 共用）。 */
  all(): Readonly<Record<string, HealthEntry>> {
    const sorted: Record<string, HealthEntry> = {}
    for (const name of [...this.#entries.keys()].sort()) {
      sorted[name] = this.#entries.get(name) as HealthEntry
    }
    return sorted
  }

  /** 已被占住的条目名（升序）：`health.test.ts` 与 doctor 用它断言写者齐全。 */
  claimed(): readonly string[] {
    return [...this.#claimed].sort()
  }
}

/** 错误 → 一行可读文本（detail 用；与 effects/passes 同口径，截断到 200 字符）。 */
function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

/** 一个条目的失败计数与状态迁移面：成功清除、连续三次失败报 error。 */
export interface HealthTracker {
  /** 条目名（与 `claim` 时一致）。 */
  readonly name: string
  /** 当前读数；持有期间与健康板上的那一行同值。 */
  entry(): HealthEntry | undefined
  /** 一次成功：计数归零，状态 ready（§N.4「下一次成功即清除」）。 */
  ready(detail: string): void
  /** 一件「不在跑」的事实：状态 paused；暂停不是成功，不清零失败计数。 */
  paused(detail: string): void
  /** 一次失败：计数 +1，达到 `FAILURES_BEFORE_ERROR` 时状态变 error。 */
  fail(error: unknown): void
  /** 当前连续失败次数（测试与 doctor 用）。 */
  failures(): number
  /** 注销：之后的写是空操作（见 `HealthBoard.claim` 的 release 语义）。 */
  release(): void
}

/** 造一个计数器的依赖：健康板 + 条目名（+ 可选的 claim 初始读数）。 */
export interface HealthTrackerOptions {
  readonly board: HealthBoardLike
  readonly name: string
  /** claim 时立刻生效的读数；缺省 `starting` + `not reported yet`。 */
  readonly initial?: HealthEntry
}

/**
 * 一个条目写者的计数外壳：把 §N.4 的「连续 3 次失败 → error、下一次成功即清除」
 * 收在一处，而不是让每个部件各写一份计数器。
 *
 * 迁移规则：
 * - `ready(detail)`：清零计数，状态 ready（唯一的清除路径——`paused`/`fail` 都不清除）；
 * - `paused(detail)`：状态 paused，保留计数（暂停不是成功）；
 * - `fail(error)`：计数 +1；低于阈值时保持上一次的 starting/ready/paused，达到阈值时 error；
 *   error 之后再失败仍是 error（计数继续加，detail 是最后一次的错误）。
 */
export function createHealthTracker(options: HealthTrackerOptions): HealthTracker {
  const initial: HealthEntry = options.initial ?? { state: 'starting', detail: 'not reported yet' }
  const handle = options.board.claim(options.name, initial)
  // 初始读数若是 error（少见：重建一个已知坏掉的条目），第一次成功仍然能把它清掉。
  let state: HealthEntry['state'] = initial.state === 'error' ? 'starting' : initial.state
  let failures = 0
  const report = (detail: string): void => {
    handle.set({ state, detail })
  }
  return {
    name: options.name,
    entry: () => handle.get(),
    failures: () => failures,
    ready(detail: string): void {
      failures = 0
      state = 'ready'
      report(detail)
    },
    paused(detail: string): void {
      state = 'paused'
      report(detail)
    },
    fail(error: unknown): void {
      failures += 1
      if (failures >= FAILURES_BEFORE_ERROR) state = 'error'
      report(`failed ${failures} time${failures === 1 ? '' : 's'}: ${messageOf(error)}`)
    },
    release: () => handle.release()
  }
}

/**
 * `models` 条目（§N.4、§H.4）：恒 ready，detail 写「handled by Orca」。模型预算重试是
 * Orca agent 自己的事；插件只做 launch 重试，所以这一项没有失败路径——写者拿到句柄后
 * 不需要再改它，面板上也不会因为它出现假问题。
 */
export function claimModelsEntry(board: HealthBoardLike): HealthEntryHandle {
  return board.claim('models', { state: 'ready', detail: MODELS_HEALTH_DETAIL })
}

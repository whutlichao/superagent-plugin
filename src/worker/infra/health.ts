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

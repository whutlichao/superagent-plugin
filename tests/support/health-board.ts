// 健康板的测试用最小实现（`infra/health.ts` 的真身由 #45 交付）：语义与设计 §N.4 一致——
// 每个条目一个写者，重复 claim 直接抛；释放后 `set` 变成空操作。
import type { HealthEntry } from '../../src/worker/core/index.ts'
import type { HealthClaim, HealthClaims } from '../../src/worker/sources/registry.ts'

/** 一个可控的健康板：测试既能经 kind 的报告写，也能直接读最终值。 */
export class FakeHealthBoard implements HealthClaims {
  readonly entries: Record<string, HealthEntry> = {}
  readonly #claimed = new Set<string>()

  claim(name: string, initial?: HealthEntry): HealthClaim {
    if (this.#claimed.has(name)) {
      throw new Error(`The health entry ${name} is reported by another part`)
    }
    this.#claimed.add(name)
    if (initial !== undefined) this.entries[name] = initial
    let held = true
    return {
      get: () => this.entries[name],
      set: (entry) => {
        if (held) this.entries[name] = entry
      },
      release: () => {
        if (!held) return
        held = false
        this.#claimed.delete(name)
        delete this.entries[name]
      }
    }
  }

  /** 当前是否有人占着某个条目。 */
  held(name: string): boolean {
    return this.#claimed.has(name)
  }
}

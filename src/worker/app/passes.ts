// 单线程 pass 调度（§C.1 `app/passes.ts`、§N.4 的 `passes` 行）：先跑到期的副作用，
// 再做到期评估；pass 期间到来的请求合并成一次后续 pass，绝不并发开两个 pass；
// pass 失败上报 `passes` 健康条目，连续三次失败把该条目变成 error，一次成功即清除。
//
// 依赖全部注入（effects 的 `kick`/`idle`、engine 的 `evaluateDue`、健康板、定时器），
// 因此本模块不读环境时钟，也没有自己的 I/O（§P.1）。
import type { HealthBoardLike, HealthEntryHandle } from '../infra/health'

/** 周期 pass 的间隔（§N.1 的 2 s 巡检；设计 §C.1 的「单线程 pass」由它驱动）。 */
export const PASS_INTERVAL_MS = 2000

/** 连续多少次 pass 失败才把 `passes` 条目报成 error（§N.4 `passes` 行）。 */
export const PASS_FAILURES_BEFORE_ERROR = 3

/** 一个待执行的 pass：先踢一次 effect 派发，再让引擎处理到期的 Eval。 */
export interface PassPorts {
  readonly effects: {
    /** 请求一次 effect 派发（它自己合并重复调用）。 */
    kick(): void
    /** 等到「现在能跑的 effect 都跑完」：pass 里先做副作用，再做评估。 */
    idle(): Promise<void>
  }
  readonly engine: {
    /** 把逾期的 Eval 重新排队、启动待评的 Thread（§E.3 的时钟）。 */
    evaluateDue(): void
  }
}

/** pass 调度器的依赖：端口 + 健康板 + 定时器（后两者注入，测试不 sleep）。 */
export interface PassesOptions extends PassPorts {
  readonly health: HealthBoardLike
  /** 定时器与取消：返回不透明句柄，调度器只原样交回 `cancel`。 */
  readonly schedule: (run: () => void, milliseconds: number) => unknown
  readonly cancel: (handle: unknown) => void
  /** 关停判定：已关停时不再开新 pass（缺省从不关停）。 */
  readonly closing?: () => boolean
  /** 周期（缺省 2 s；测试可调小）。 */
  readonly intervalMs?: number
}

/** 一次 pass 的输入：调度器只关心「做完了没有」。 */
export interface PassesPort {
  /** 起周期 pass（幂等：重复调用不叠加定时器）。 */
  start(): void
  /** 请求一次 pass；pass 进行中的请求合并成一次后续 pass。 */
  request(): void
  /** 等到没有 pass 在跑、也没有已排队的后续 pass。 */
  idle(): Promise<void>
  /** 停下周期 pass 并等当前 pass 结束。 */
  stop(): Promise<void>
}

/** 一行可读的失败原因（健康 detail 用；截断到 200 字符，不把整段堆栈写进面板）。 */
function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

/**
 * 单线程 pass 调度器：任何时刻最多一个 pass 在跑；运行期间的 `request()` 只记「再来一轮」，
 * 当前 pass 结束后恰好补一次。失败不抛给调用方（调用方是定时器或命令），只写健康条目。
 */
export class Passes implements PassesPort {
  readonly #options: PassesOptions
  readonly #entry: HealthEntryHandle
  #timer: unknown = null
  #stopped = false
  #pumping: Promise<void> | null = null
  #pumpAgain: Promise<void> | null = null
  #failures = 0

  constructor(options: PassesOptions) {
    this.#options = options
    // `passes` 条目由本调度器独占写入（§N.4 写者表）。刚 claim、还没有跑过一轮时是
    // `starting`（§J.3 四档之一），第一轮成功后才说 ready。
    this.#entry = options.health.claim('passes', { state: 'starting', detail: 'not run yet' })
  }

  start(): void {
    if (this.#stopped || this.#timer !== null) return
    const interval = this.#options.intervalMs ?? PASS_INTERVAL_MS
    this.#timer = this.#options.schedule(() => {
      // 周期到点：前面的 pass 还没跑完就合并成一次后续 pass（不排队列）。
      this.request()
    }, interval)
  }

  request(): void {
    if (this.#stopped) return
    // 不把拒绝抛给调用方：失败已经写进健康条目。
    void this.pump().catch(() => undefined)
  }

  async idle(): Promise<void> {
    for (;;) {
      await Promise.allSettled([this.#pumping, this.#pumpAgain].filter(isPromise))
      if (this.#pumping === null && this.#pumpAgain === null) return
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true
    if (this.#timer !== null) {
      this.#options.cancel(this.#timer)
      this.#timer = null
    }
    await Promise.allSettled([this.#pumping, this.#pumpAgain].filter(isPromise))
  }

  /**
   * 跑一轮 pass。已有 pass 在跑时**不并发**，而是把这次请求记成一次后续 pass：
   * 多个请求共享同一个 `#pumpAgain`，因此 pass 期间来多少次都只补一轮。
   */
  private pump(): Promise<void> {
    if (this.#stopped) return Promise.resolve()
    const inFlight = this.#pumping
    if (inFlight === null) {
      const running = this.pumpOnce().finally(() => {
        this.#pumping = null
      })
      this.#pumping = running
      return running
    }
    if (this.#pumpAgain !== null) return this.#pumpAgain
    const again = inFlight.then(
      () => {
        this.#pumpAgain = null
        return this.pump()
      },
      () => {
        this.#pumpAgain = null
        return this.pump()
      }
    )
    this.#pumpAgain = again
    return again
  }

  /** 一轮 pass：先让到期的 effect 跑完，再做 `evaluateDue`；任何一步失败都算这轮失败。 */
  private async pumpOnce(): Promise<void> {
    try {
      this.#options.effects.kick()
      await this.#options.effects.idle()
      if (this.#options.closing?.() === true) {
        // 关停不是失败，但这一轮确实没做完：条目说 `paused`（「不在跑」）而不是 ready。
        this.#entry.set({ state: 'paused', detail: 'closing' })
        return
      }
      this.#options.engine.evaluateDue()
      this.succeeded()
    } catch (error) {
      this.failed(error)
    }
  }

  /** 成功：清零连续失败并回到 ready（§N.4：下一次成功即清除）。 */
  private succeeded(): void {
    this.#failures = 0
    this.#entry.set({ state: 'ready', detail: 'ready' })
  }

  /** 失败：计数 +1，达到阈值报 error，并留下最后一条错误。 */
  private failed(error: unknown): void {
    this.#failures += 1
    const detail = `pass failed after ${this.#failures} attempt${this.#failures === 1 ? '' : 's'}: ${messageOf(error)}`
    this.#entry.set({
      state: this.#failures >= PASS_FAILURES_BEFORE_ERROR ? 'error' : 'ready',
      detail
    })
  }
}

/** 判断「有东西可等」：`Promise.allSettled` 不接受 null。 */
function isPromise(value: Promise<void> | null): value is Promise<void> {
  return value !== null
}

/** 生产用的构造入口：组合根只依赖这个接口，不必知道类名。 */
export function createPasses(options: PassesOptions): PassesPort {
  return new Passes(options)
}

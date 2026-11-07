// 持久副作用队列（§J.2）：先存后做、按 (kind, key) 合并、按 `seq` 取、退避、`Later`、
// 并发上限、暂停与关停。
//
// 队列自己不做 I/O：它只碰三样东西——store 的 `effect` 仓储（行的唯一落点，§D.4 写者表）、
// `afterCommit`（提交后才执行）与注入的健康板。handler 由各部件注册（评估、执行器、Router、
// Outbox），队列不知道它们做什么，因此这里没有领域知识，也没有 `src/worker/` 之外的依赖。
//
// 时间只有一种形态（§D.2 要点 1）：库里的 `due_at` 是 ISO 文本；队列内部拿毫秒数比较与
// 计算退避，落库时才格式化。时钟是注入的，测试用虚拟时间推进，绝不 sleep（§P.1）。
import type { HealthBoardLike, HealthEntryHandle } from '../infra/health'
import { FAILURES_BEFORE_ERROR } from '../infra/health'
import type { EffectRecord } from './records'
import type { EffectRepository } from './store'

/**
 * handler 抛它表示「现在做不了」（无 worker slot、处理已暂停）：不算失败、不进健康计数，
 * 到期时刻推到 `now + LATER_DELAY_MS` 后重试（§J.2 `Later` 行）。
 */
export class Later extends Error {
  constructor(message = 'Not now') {
    super(message)
    this.name = 'Later'
  }
}

/** effect 全局并发上限（§J.2 并发行）。 */
export const GLOBAL_CONCURRENCY = 4

/** `Later` 的重试间隔：设计写死 5 s，不随 kind 的退避变化（§J.2 `Later` 行）。 */
export const LATER_DELAY_MS = 5000

/** `effect` 表的八种 kind（§J.2 的 kind 清单，逐行）。 */
export type EffectKind =
  | 'assessment'
  | 'launch'
  | 'delivery'
  | 'relay'
  | 'notice'
  | 'reply'
  | 'return'
  | 'backup'

/** kind 的稳定顺序（健康条目、`EFFECT_RULES` 与测试都按它读）。 */
export const EFFECT_KINDS: readonly EffectKind[] = [
  'assessment',
  'launch',
  'delivery',
  'relay',
  'notice',
  'reply',
  'return',
  'backup'
]

/** 每种 kind 的 payload 形状；key 的形状见下面的 `EFFECT_KEY_SHAPES`（§J.2 的 kind 表）。 */
export interface EffectPayloads {
  /** 把候选卡 relay 给 Router 并标记 delivered（启动 Eval 计时）。 */
  readonly assessment: { readonly triggerId: string }
  /** 建 worktree（如需）→ 起 agent → 投 assignment。 */
  readonly launch: { readonly ticketId: string; readonly assignmentId: string }
  /** 把待投 Input 依次交给 running 的 Assignment。 */
  readonly delivery: { readonly ticketId: string }
  /** 把 report/候选/follow-up 写给 Router（§F.2 的 payload 形状）。 */
  readonly relay: {
    readonly messageId: string
    readonly kind: string
    readonly summary: string
    readonly file?: string
  }
  /** 不唤醒语义的通知（结束、设置已存、prompt 更新）。 */
  readonly notice: { readonly summary: string; readonly value?: Readonly<Record<string, unknown>> }
  /** 经 Channel 发一条 outbox 消息。 */
  readonly reply: { readonly messageId: string }
  /** 人 follow-up 回到 Eval（handback 后）。 */
  readonly return: { readonly triggerKey: string }
  /**
   * 一次手工备份（§G.2 的 `admin backup`、§O「长活进 effect」）：`at` 是这次备份的时刻，文件名
   * 由它与库版本决定（`app/backup.ts` 的 `backupPath`），于是命令在入队时就知道它将要落到的路径。
   */
  readonly backup: { readonly at: string }
}

/** 一个 handler：拿到 payload 与 key；抛 `Later` 表示「现在做不了」，抛别的表示失败。 */
export type EffectHandler<K extends EffectKind> = (
  payload: EffectPayloads[K],
  key: string
) => void | Promise<void>

/** 计算并发上限时队列能看到的两个外部读数（暂停与空闲 worker slot）。 */
export interface EffectLimitContext {
  readonly paused: boolean
  /** 空闲 worker slot 数（§E.6）；只有 `launch` 用它。 */
  readonly slots: number
}

/** 一种 kind 的并发与退避规则（§J.2 的 kind 表逐行转写）。 */
export interface EffectKindRule {
  /** 当前允许同时跑几个；返回 0 就是「这个 kind 现在不启动」。 */
  readonly limit: (context: EffectLimitContext) => number
  /** 首次退避与上限（毫秒）：失败后 `retry[0] * 2^attempts`，封顶 `retry[1]`。 */
  readonly retry: readonly [number, number]
  /** 尝试多少次后放弃这一行（`Infinity` 表示一直重试）。 */
  readonly maxAttempts: number
  /** 串行保序：队头（最老一行）没跑完或没到期时，后面的行一律不启动。 */
  readonly ordered: boolean
  /** 失败不上报健康（§J.3：`delivery` 的失败写在 Ticket 上，由执行器负责）。 */
  readonly quiet: boolean
  /** 与其它 router kind 共用同一串行队列（relay/notice 都是 Router 终端，§J.2 末注）。 */
  readonly router: boolean
  /** 处理暂停时不启动（§J.2 暂停行：assessment/launch/delivery/reply）。 */
  readonly heldWhilePaused: boolean
}

/**
 * kind 表（§J.2 的七行）。这里是唯一真相：并发、退避、串行与暂停语义都从它读，
 * `queue.test.ts` 逐行断言它与设计一致。
 */
export const EFFECT_RULES: Readonly<Record<EffectKind, EffectKindRule>> = {
  assessment: {
    limit: (context) => (context.paused ? 0 : 4),
    retry: [2000, 60_000],
    maxAttempts: Number.POSITIVE_INFINITY,
    ordered: false,
    quiet: false,
    router: false,
    heldWhilePaused: true
  },
  launch: {
    // 受空闲 worker slot 限制（§E.6）；没有 slot 时 handler 也可能抛 Later，这里先不取行。
    limit: (context) => (context.paused ? 0 : Math.max(0, context.slots)),
    retry: [5000, 300_000],
    // 设计：launch 的 provider 类失败最多 3 次；其余失败由执行器自己判失败（§J.2）。
    maxAttempts: 3,
    ordered: false,
    quiet: false,
    router: false,
    heldWhilePaused: true
  },
  delivery: {
    limit: (context) => (context.paused ? 0 : 4),
    retry: [2000, 60_000],
    maxAttempts: Number.POSITIVE_INFINITY,
    ordered: false,
    // 失败写在 Ticket 上（§J.3），健康条目只留计数。
    quiet: true,
    router: false,
    heldWhilePaused: true
  },
  relay: {
    limit: () => 1,
    retry: [2000, 60_000],
    maxAttempts: Number.POSITIVE_INFINITY,
    ordered: true,
    quiet: false,
    router: true,
    heldWhilePaused: false
  },
  notice: {
    limit: () => 1,
    retry: [2000, 60_000],
    maxAttempts: Number.POSITIVE_INFINITY,
    ordered: true,
    quiet: false,
    router: true,
    heldWhilePaused: false
  },
  reply: {
    // 串行 1 条；但**不**全局保序：同一 (ticket, channel) 的顺序由 outbox 负责（§J.1），
    // 不同 Ticket 之间互不等待。
    limit: (context) => (context.paused ? 0 : 1),
    retry: [5000, 300_000],
    maxAttempts: Number.POSITIVE_INFINITY,
    ordered: false,
    quiet: false,
    router: false,
    heldWhilePaused: true
  },
  return: {
    limit: () => 1,
    retry: [2000, 60_000],
    maxAttempts: Number.POSITIVE_INFINITY,
    ordered: false,
    quiet: false,
    router: false,
    heldWhilePaused: false
  },
  backup: {
    // VACUUM 是整个库的串行活：一次只跑一份（两份同时写 backups/ 没有意义），失败退避重试。
    // 与暂停无关（它是运维动作，不是处理逻辑）：人要求的备份不该被 `paused` 挡住。
    limit: () => 1,
    retry: [2000, 60_000],
    maxAttempts: Number.POSITIVE_INFINITY,
    ordered: false,
    quiet: false,
    router: false,
    heldWhilePaused: false
  }
}

/**
 * 每种 kind 的 key 形状（§J.2 kind 表的 key 列）。`key` 是 (kind, key) 唯一性的一半，
 * 所以它的含义写在这里一次：调用方按这张表选 key，测试按它断言设计的表没被改歪。
 */
export const EFFECT_KEY_SHAPES: Readonly<Record<EffectKind, string>> = {
  /** evalId：一个 Eval 一张候选卡，重复请求合并成一次投递。 */
  assessment: 'evalId',
  /** ticketId：一个 Ticket 同时只有一次启动意图。 */
  launch: 'ticketId',
  /** ticketId：一个 Ticket 的待投 Input 合并成一次投递。 */
  delivery: 'ticketId',
  /** 恒为 `'router'`：Router 只有一台终端，单行 FIFO。 */
  relay: "'router'",
  /** 恒为 `'router'`：与 relay 共用同一串行队列。 */
  notice: "'router'",
  /** messageId：一条 outbox 消息一个 receipt，重复入队不重发。 */
  reply: 'messageId',
  /** triggerKey：一条人 follow-up 回到 Eval。 */
  return: 'triggerKey',
  /** at：一次手工备份（同一时刻只入队一份）。 */
  backup: 'at'
}

/** `relay` 与 `notice` 共用的那一行 key（§J.2 末注：都是 Router 终端）。 */
export const ROUTER_EFFECT_KEY = 'router'

/**
 * 队列需要的存储面：写事务、提交后回调与 `effect` 仓储。用结构化子集而不是整个 `Store`，
 * 测试与组合根都能只给这几样（§P.1 的接缝）。
 */
export interface EffectStore {
  transaction<T>(work: () => T): T
  /** 提交后才执行（回滚就丢弃）；见 `app/store.ts` 的同名方法。 */
  afterCommit(action: () => void): void
  readonly effects: EffectRepository
}

/** 队列的依赖：全部注入，队列自己不读时钟、不建定时器（§P.1）。 */
export interface EffectsOptions {
  readonly store: EffectStore
  readonly health: HealthBoardLike
  /** 毫秒时钟。 */
  readonly now: () => number
  /** 处理是否暂停（§J.2 暂停行）；缺省不暂停。 */
  readonly paused?: () => boolean
  /** 空闲 worker slot 数（§E.6）；缺省 1（没有执行器接线时的保守值）。 */
  readonly slots?: () => number
  /**
   * 某个 kind 已经丢弃的条数（§J.3：outbox 的 `dropped` 只计数、不算错误）。
   * 由 outbox 注入；缺省不显示这一项。
   */
  readonly dropped?: (kind: EffectKind) => number
}

/** 注册 handler 时可选的补充回调。 */
export interface EffectHandlerOptions {
  /**
   * 一行用尽 `maxAttempts` 后被放弃时调用（launch 的 provider 失败最多 3 次，§J.2）。
   * 执行器用它把 Ticket 标记为 failed；队列自己不知道 Ticket 是什么。
   */
  readonly exhausted?: (key: string, error: unknown) => void
}

/** 一次注册：handler 与它自己的放弃回调。 */
interface Registration {
  readonly run: (payload: unknown, key: string) => void | Promise<void>
  readonly exhausted?: (key: string, error: unknown) => void
}

/** 一个在跑的任务：`done` 在它结束（无论成败）后 settle。 */
interface Task {
  readonly kind: EffectKind
  readonly key: string
  done: Promise<void>
}

/** 行的内存版本号：运行期间同一 (kind, key) 被重新入队时，旧尝试不再改写新行。 */
const rowId = (kind: EffectKind, key: string): string => `${kind}\u0000${key}`

/** 毫秒 → 库里的 ISO 文本（§D.2 要点 1）。 */
const iso = (milliseconds: number): string => new Date(milliseconds).toISOString()

/** 错误 → 一行可读文本（健康 detail 与 `last_error` 用）。 */
const messageOf = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

/**
 * 持久副作用队列。每个 kind 一个 handler；`enqueue` 在调用方的事务里写行，提交后才调度。
 * 行以 (kind, key) 唯一：同 key 再入队替换 payload、立即到期，但保留 `seq`（保序、不重排）。
 */
export class Effects {
  readonly #store: EffectStore
  readonly #health: HealthBoardLike
  readonly #now: () => number
  readonly #paused: () => boolean
  readonly #slots: () => number
  readonly #dropped: ((kind: EffectKind) => number) | undefined

  readonly #handlers = new Map<EffectKind, Registration>()
  readonly #entries = new Map<EffectKind, HealthEntryHandle>()
  readonly #tasks = new Set<Task>()
  /** 行的内存版本（见 `rowId`）：只在提交后的再入队时自增。 */
  readonly #versions = new Map<string, number>()
  /** 每个 kind 的连续失败次数（§J.2「失败即问题」）。 */
  readonly #failures = new Map<EffectKind, number>()

  #seq: number
  #scheduled = false
  #started = false
  #draining = false

  constructor(options: EffectsOptions) {
    this.#store = options.store
    this.#health = options.health
    this.#now = options.now
    this.#paused = options.paused ?? (() => false)
    this.#slots = options.slots ?? (() => 1)
    this.#dropped = options.dropped
    // 重启后接着库里的最大 seq 往下发号，新行排在当时 pending 的行之后（§J.2、§E.10）。
    this.#seq = options.store.effects.maxSeq()
    // §J.3：每个 effect kind 一个健康条目，写者就是队列自己。构造时就占住全部七个，
    // 因此「还没接上 handler 的 kind」在面板上是一行 `starting`，而不是缺行；一次报告之后
    // 才变成 ready/paused/error。计数照写，即便还没接过 handler。
    for (const kind of EFFECT_KINDS) {
      this.#entries.set(
        kind,
        this.#health.claim(kind, { state: 'starting', detail: this.detail(kind) })
      )
    }
  }

  /**
   * 入队一条副作用：写进调用方的事务（`afterCommit` 之后才可能执行）。同 (kind, key)
   * 再入队替换 payload 并立即到期，`seq` 不变。
   */
  enqueue<K extends EffectKind>(kind: K, key: string, payload: EffectPayloads[K]): void {
    this.#store.transaction(() => {
      this.#store.effects.put({
        kind,
        key,
        payload,
        seq: ++this.#seq,
        dueAt: iso(this.#now()),
        attempts: 0,
        lastError: null
      })
    })
    const id = rowId(kind, key)
    this.#store.afterCommit(() => {
      // 版本自增放在提交之后：回滚掉的再入队不该让在跑的旧尝试放弃写回。
      this.#versions.set(id, (this.#versions.get(id) ?? 0) + 1)
      // 新的等待数立刻反映到健康 detail（§J.3：「detail 写计数」），即便这个 kind 还没有
      // handler、暂时不会有人来跑它。
      this.report(kind)
      this.kick()
    })
  }

  /** 注册一种 kind 的 handler；每种 kind 只能有一个。 */
  handle<K extends EffectKind>(
    kind: K,
    run: EffectHandler<K>,
    options: EffectHandlerOptions = {}
  ): void {
    if (this.#handlers.has(kind)) {
      throw new Error(`The ${kind} effects already have a handler`)
    }
    this.#handlers.set(kind, {
      run: run as (payload: unknown, key: string) => void | Promise<void>,
      exhausted: options.exhausted
    })
    // 条目在构造时已经占住（七个 kind 各一条，§J.3）；这里只刷新一次读数。
    this.report(kind)
    this.kick()
  }

  /** 是否还有这个 kind 的行（给了 key 就只看那一行）。 */
  pending(kind: EffectKind, key?: string): boolean {
    if (key !== undefined) return this.#store.effects.get(kind, key) !== null
    return this.#store.effects.oldestOfKind(kind) !== null
  }

  /** 开始取行。`start()` 之前入队的行会一直等（setup 未完成时就是这样，§N.1）。 */
  start(): void {
    this.#started = true
    this.kick()
  }

  /** 调度一次派发（微任务，重复调用合并）。 */
  kick(): void {
    if (this.#scheduled) return
    this.#scheduled = true
    queueMicrotask(() => {
      this.#scheduled = false
      this.dispatch()
    })
  }

  /**
   * 等到「现在能跑的 effect 都跑完」：没有在跑的任务、也没有到期的行可启动。
   * 未到期的行（退避中）不算「能跑」，所以它会立刻返回。
   */
  async idle(kind?: EffectKind): Promise<void> {
    for (;;) {
      this.dispatch()
      const running = [...this.#tasks]
        .filter((task) => kind === undefined || task.kind === kind)
        .map((task) => task.done)
      if (running.length === 0) return
      await Promise.allSettled(running)
    }
  }

  /**
   * 关停：停止取新行，等在跑的行结束；pending 行原样留在库里（不删、不改 payload），
   * 下次 `start`（新的队列实例）接着跑（§J.2 关停行、§E.10）。
   */
  async drain(): Promise<void> {
    this.#draining = true
    await Promise.allSettled([...this.#tasks].map((task) => task.done))
  }

  /** 一次派发：按 kind 表的并发上限与全局并发 4，从到期行里按 `seq` 升序取。 */
  private dispatch(): void {
    if (!this.#started || this.#draining) return
    const now = this.#now()
    const context: EffectLimitContext = { paused: this.#paused(), slots: this.#slots() }
    let running = this.#tasks.size
    let routerBusy = [...this.#tasks].some((task) => EFFECT_RULES[task.kind].router)

    for (const [kind, handler] of this.#handlers) {
      if (running >= GLOBAL_CONCURRENCY) return
      const rule = EFFECT_RULES[kind]
      if (rule.router && routerBusy) continue
      const runningKeys = new Set(
        [...this.#tasks].filter((task) => task.kind === kind).map((task) => task.key)
      )
      // 先问上限再取行：没有空位时 limit 不该被反复计算（上游同）。
      let room = Math.min(rule.limit(context) - runningKeys.size, GLOBAL_CONCURRENCY - running)
      if (room <= 0) continue
      if (rule.ordered && runningKeys.size > 0) continue

      const rows = rule.ordered
        ? onlyRow(this.#store.effects.oldestOfKind(kind))
        : this.#store.effects.dueOfKind(kind, iso(now))
      for (const row of rows) {
        if (room <= 0) break
        // 串行 kind：队头没到期时，后面的行也不启动（失败挡住后来的同种）。
        if (row.dueAt > iso(now)) break
        if (runningKeys.has(row.key)) continue
        this.run(kind, handler, row)
        room -= 1
        running += 1
        if (rule.router) routerBusy = true
        if (rule.ordered) break
      }
    }
  }

  /** 启动一次尝试；结束（无论成败）后清掉任务并再派发一次。 */
  private run(kind: EffectKind, handler: Registration, row: EffectRecord): void {
    const task: Task = { kind, key: row.key, done: Promise.resolve() }
    const version = this.#versions.get(rowId(kind, row.key)) ?? 0
    task.done = this.attempt(kind, handler, row, version)
      .catch((error: unknown) => {
        // 队列自己坏了（SQL 失败之类）：算该 kind 的一次失败，下一次成功清除。
        this.recordFailure(kind, error)
      })
      .finally(() => {
        this.#tasks.delete(task)
        this.kick()
      })
    this.#tasks.add(task)
  }

  /** 跑一次 handler 并把结果写回：成功删行、`Later` 推迟、失败退避或放弃。 */
  private async attempt(
    kind: EffectKind,
    handler: Registration,
    row: EffectRecord,
    version: number
  ): Promise<void> {
    const rule = EFFECT_RULES[kind]
    let failure: unknown
    let failed = false
    try {
      await handler.run(row.payload, row.key)
    } catch (error) {
      failure = error
      failed = true
    }

    const replaced = (this.#versions.get(rowId(kind, row.key)) ?? 0) !== version
    let exhausted = false
    this.#store.transaction(() => {
      // 运行期间被再入队替换的行：这次尝试的结果不写回（新 payload 会自己再跑一次）。
      if (replaced) return
      if (!failed) {
        this.#store.effects.remove(kind, row.key, row.seq, row.attempts)
        return
      }
      // 关停中失败：行原样留下（不改 attempts、不改 due），下次启动重试（§J.2 关停行）。
      if (this.#draining) return
      if (failure instanceof Later) {
        this.#store.effects.reschedule({ ...row, dueAt: iso(this.#now() + LATER_DELAY_MS) })
        return
      }
      const attempts = row.attempts + 1
      if (attempts >= rule.maxAttempts) {
        exhausted = true
        this.#store.effects.remove(kind, row.key, row.seq, row.attempts)
        return
      }
      // 2 s 起翻倍、封顶：`retry[0] * 2^attempts`，上限 `retry[1]`。
      const delay = Math.min(rule.retry[1], rule.retry[0] * 2 ** Math.min(row.attempts, 20))
      this.#store.effects.reschedule({
        ...row,
        attempts,
        dueAt: iso(this.#now() + delay),
        lastError: messageOf(failure)
      })
    })

    if (replaced) return
    if (!failed) {
      this.recordSuccess(kind)
    } else if (failure instanceof Later) {
      // 「现在做不了」不是失败：不计失败、也不清除已有的连续失败计数。
      this.report(kind)
    } else {
      this.recordFailure(kind, failure)
      if (exhausted) handler.exhausted?.(row.key, failure)
    }
  }

  /** 成功：清零连续失败并刷新健康（§J.2：一次成功即清除 error）。 */
  private recordSuccess(kind: EffectKind): void {
    this.#failures.set(kind, 0)
    this.report(kind)
  }

  /** 失败：连续失败计数 +1，到 `FAILURES_BEFORE_ERROR` 就把该 kind 报成 error。 */
  private recordFailure(kind: EffectKind, error: unknown): void {
    this.#failures.set(kind, (this.#failures.get(kind) ?? 0) + 1)
    this.report(kind, messageOf(error))
  }

  /**
   * 刷新一个 kind 的健康条目（§J.3 的四档）：detail 是计数；`error` 只在非 quiet 且连续
   * 失败够数时；暂停挡住的 kind 报 `paused`（「不在跑」）；还没接过 handler、也没报告过的
   * kind 保持 `starting`。
   */
  private report(kind: EffectKind, lastError?: string): void {
    const entry = this.#entries.get(kind)
    if (entry === undefined) return
    const broken = !EFFECT_RULES[kind].quiet && (this.#failures.get(kind) ?? 0) >= FAILURES_BEFORE_ERROR
    const detail = this.detail(kind, broken ? lastError : undefined)
    if (broken) {
      entry.set({ state: 'error', detail })
      return
    }
    if (!this.#handlers.has(kind)) {
      // 没有任何写者跑过它：`starting` 比 `ready` 诚实（§J.3「条目已 claim，还没报告过」）。
      entry.set({ state: 'starting', detail })
      return
    }
    const rule = EFFECT_RULES[kind]
    const paused = this.#paused() && rule.heldWhilePaused
    entry.set({ state: paused ? 'paused' : 'ready', detail })
  }

  /** 健康条目的 `waiting N, failed M[, dropped K][, last error: …]` 明细（§J.3）。 */
  private detail(kind: EffectKind, lastError?: string): string {
    const counts = this.#store.effects.kindCounts().find((row) => row.kind === kind)
    const parts = [`waiting ${counts?.waiting ?? 0}, failed ${counts?.failed ?? 0}`]
    // 只报非零的丢弃数：`dropped 0` 对每个 kind 都是噪音，而 §J.3 要的是「只计数」。
    const dropped = this.#dropped?.(kind)
    if (dropped !== undefined && dropped > 0) parts.push(`dropped ${dropped}`)
    if (lastError !== undefined) parts.push(`last error: ${lastError}`)
    return parts.join(', ')
  }
}

/** 把「可能没有」的一行包成数组，让串行与并行两条取行路径共用同一个循环。 */
function onlyRow(row: EffectRecord | null): readonly EffectRecord[] {
  return row === null ? [] : [row]
}

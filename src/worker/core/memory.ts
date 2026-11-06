// 内存仓储（§P.1 其三）：只给纯领域单测用，语义与真实仓储一致。
//
// 「每个状态一个写者」（§D.4）在这里是可执行的：仓储本体只暴露**读面**，写面必须经
// `claimWriter()` 领取，且只能领取一次；写方法在事务（`atomic`）之外调用直接抛
// `WriterError('outside_transaction')`。因此绕过引擎直接写会被拒绝，而不是悄悄成功。
//
// 与真实仓储一致的三条语义：
// 1. 读出的都是克隆，调用方改返回值不影响已存状态（真实仓储每次从 SQLite 行反序列化）；
// 2. `atomic` 是快照事务：抛错恢复快照，嵌套事务只回滚自己那层（真实仓储用 SAVEPOINT）；
// 3. 排序与唯一性：同 id 覆盖、不追加；列表按 `(at, id)` / `createdAt` 确定性排序。
//
// 克隆用 JSON 往返：领域记录全部是可存进 SQLite `body` 列的 JSON（§D.2），并且自包含
// 类型面里没有 `structuredClone` 的声明（§N.3 其二）。
//
// 写面的守卫只声明一次（`guard`），读面不经它；`Repositories` 的读写方法在这里各实现
// 一份，避免同一个 `save` 出现两套语义。
import { latestAssignment, type Decision, type Thread, type Ticket, type Trigger, type TriggerDisposition } from './model.ts'
import type { Repositories } from './ports.ts'

const clone = <T>(value: T): T =>
  value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)

/** 仓储的读面：测试与读模型用；没有任何写方法。 */
export interface MemoryReadView {
  readonly triggers: {
    get(id: string): Trigger | undefined
    byThread(threadKey: string): Trigger[]
    disposition(id: string): TriggerDisposition | undefined
  }
  readonly threads: {
    get(key: string): Thread | undefined
    list(): Thread[]
    active(): Thread[]
  }
  readonly tickets: {
    get(id: string): Ticket | undefined
    list(): Ticket[]
    open(): Ticket[]
    active(): Ticket[]
  }
  readonly decisions: {
    get(id: string): Decision | undefined
    byThread(key: string): Decision[]
  }
}

/** 写者纪律的错误：仓储已被领取，或写发生在事务之外。 */
export class WriterError extends Error {
  readonly code: 'writer_taken' | 'outside_transaction'

  constructor(code: 'writer_taken' | 'outside_transaction', message: string) {
    super(message)
    this.name = 'WriterError'
    this.code = code
  }
}

/** 按 `(at, id)` 升序：时间只有一种形态，文本比较即时间比较（§D.2 设计要点 1）。 */
const byAtThenId = (a: { at: string; id: string }, b: { at: string; id: string }): number =>
  a.at === b.at ? a.id.localeCompare(b.id) : a.at.localeCompare(b.at)
/** Ticket 最新在前：`createdAt` 降序，同刻按 id 降序，保证读序确定。 */
const newestFirst = (a: Ticket, b: Ticket): number =>
  a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt)

/**
 * `Repositories` 的内存实现：克隆隔离、快照回滚、确定性排序、按 id 唯一。
 * 测试拿它当读面（构造后直接读），引擎拿 `claimWriter()` 的返回值当写面。
 */
export class MemoryRepositories implements MemoryReadView {
  readonly #triggers = new Map<string, Trigger>()
  readonly #dispositions = new Map<string, TriggerDisposition>()
  readonly #threads = new Map<string, Thread>()
  readonly #tickets = new Map<string, Ticket>()
  readonly #decisions = new Map<string, Decision>()
  #claimed = false
  #depth = 0

  /** 全部记录表；事务快照与回滚按它们逐个处理。 */
  #maps(): Map<string, unknown>[] {
    return [this.#triggers, this.#dispositions, this.#threads, this.#tickets, this.#decisions]
  }

  readonly triggers: MemoryReadView['triggers'] = {
    get: (id) => clone(this.#triggers.get(id)),
    /** 某个 Thread 上的 Trigger，按 `(at, id)` 升序（Correlation 只加语境，所以跨 Thread 也读得到）。 */
    byThread: (threadKey) =>
      [...this.#triggers.values()]
        .filter((trigger) => trigger.threads.some((ref) => `${ref.source}:${ref.id}` === threadKey))
        .sort(byAtThenId)
        .map(clone),
    disposition: (id) => clone(this.#dispositions.get(id))
  }

  readonly threads: MemoryReadView['threads'] = {
    get: (key) => clone(this.#threads.get(key)),
    list: () => [...this.#threads.values()].sort((a, b) => a.key.localeCompare(b.key)).map(clone),
    active: () =>
      this.threads
        .list()
        .filter((thread) => thread.pending.length > 0 || thread.evaluating !== undefined)
  }

  readonly tickets: MemoryReadView['tickets'] = {
    get: (id) => clone(this.#tickets.get(id)),
    list: () => [...this.#tickets.values()].sort(newestFirst).map(clone),
    open: () => this.tickets.list().filter((ticket) => !ticket.ended),
    active: () =>
      this.tickets
        .list()
        .filter(
          (ticket) =>
            ticket.undelivered.length > 0 ||
            ['pending', 'running'].includes(latestAssignment(ticket)?.state ?? '')
        )
  }

  readonly decisions: MemoryReadView['decisions'] = {
    get: (id) => clone(this.#decisions.get(id)),
    byThread: (key) =>
      [...this.#decisions.values()]
        .filter((decision) => decision.threadKey === key)
        .sort(byAtThenId)
        .map(clone)
  }

  /**
   * 领取唯一的写者角色（引擎在组合根里领取一次）。第二次领取直接抛
   * `WriterError('writer_taken')`——两个写者同时改同一份状态是不可能被允许的。
   */
  claimWriter(): Repositories {
    if (this.#claimed) {
      throw new WriterError('writer_taken', 'the memory repositories already have a writer')
    }
    this.#claimed = true
    return this.#writer()
  }

  /** 写面：所有 save 都要求当前处在 `atomic` 之内。 */
  #writer(): Repositories {
    const guard = (): void => {
      if (this.#depth === 0) {
        throw new WriterError(
          'outside_transaction',
          'writes must happen inside a transaction opened by the engine'
        )
      }
    }
    return {
      atomic: <T>(work: () => T): T => this.#atomic(work),
      triggers: {
        get: (id) => clone(this.#triggers.get(id)),
        save: (trigger) => {
          guard()
          this.#triggers.set(trigger.id, clone(trigger))
        },
        byThread: this.triggers.byThread,
        disposition: (id) => clone(this.#dispositions.get(id)),
        saveDisposition: (id, value) => {
          guard()
          this.#dispositions.set(id, clone(value))
        }
      },
      threads: {
        get: (key) => clone(this.#threads.get(key)),
        save: (thread) => {
          guard()
          this.#threads.set(thread.key, clone(thread))
        },
        list: this.threads.list,
        active: this.threads.active
      },
      tickets: {
        get: (id) => clone(this.#tickets.get(id)),
        save: (ticket) => {
          guard()
          this.#tickets.set(ticket.id, clone(ticket))
        },
        list: this.tickets.list,
        open: this.tickets.open,
        active: this.tickets.active
      },
      decisions: {
        get: (id) => clone(this.#decisions.get(id)),
        save: (decision) => {
          guard()
          this.#decisions.set(decision.id, clone(decision))
        },
        byThread: this.decisions.byThread
      }
    }
  }

  /**
   * 快照事务：进入时快照全部记录表，抛错恢复；嵌套时每层各管自己那一段
   * （内层抛错只回滚内层写下的，外层可继续；外层抛错把内层已提交的也回滚）。
   */
  #atomic<T>(work: () => T): T {
    const maps = this.#maps()
    const snapshot = maps.map((map) => new Map(map))
    this.#depth += 1
    try {
      return work()
    } catch (error) {
      maps.forEach((map, index) => {
        map.clear()
        for (const [id, value] of snapshot[index]!) map.set(id, value)
      })
      throw error
    } finally {
      this.#depth -= 1
    }
  }
}

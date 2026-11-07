// 取消与截止期（§O「超时」行）：HTTP handler 内不做超过 10 s 的同步等待，长活进 effect；
// 短活（setup / doctor 的探针、名单同步与显示名读取）各有一条明确的线。
//
// 几件事只在这里做一次：
// - `DeadlineError`：到点或外部取消的**唯一**错误形态。调用方（`http/`）把它折成固定码
//   `unavailable` + 「稍后重试」；领域模块不自己编一个「超时」的结论（那会把没做完说成做完了）。
//   `ProbeTimeout` 是它的子类，只多一件信息：「这条探针自己的上限到点」，而不是整次调用被
//   取消——doctor 据此只把**这一项**标成 `timeout`，其余项照常（§O）。
// - `combineSignals`：多个取消信号取并集（命令端口与名单同步共用同一份，别再各写一遍）。
// - `withDeadline`：给一段异步工作装一个定时器，到点先取消再拒绝，并且**不留下未处理的
//   rejection**（输掉赛跑的那一边之后仍可能拒绝）。
// - `probeRunner` / `withinBudget`：把「探针上限 + 总预算」这两条线装到一段工作上。一处写好，
//   setup / doctor / `source labels` 都从这里取，不各装一遍。
//
// 取消要传到最底层：`signal` 交给 `Commands.run` 时会进 `execFile`，子进程被 SIGTERM 掐掉；
// 忽略信号的实现（宿主的 `listRepos` 这类没有 signal 参数）至少让 handler 立刻拿到拒绝，
// 而不是陪着它一起挂。这是「不许挂」与「不许吞」的两条边。

/** 一次到点或取消：`what` 是人读的名字（**不含 argv**，§O 的错误脱敏），`ms` 是当时的预算。 */
export class DeadlineError extends Error {
  readonly code = 'deadline_exceeded'
  readonly what: string
  readonly ms: number

  constructor(what: string, ms: number) {
    super(`${what} did not finish within ${ms} ms`)
    this.name = 'DeadlineError'
    this.what = what
    this.ms = ms
  }
}

/**
 * 探针自己的 `catch` 里先跑它：截止期错误**不**折成「缺什么」这条结论——它意味着这次检查
 * 没做完，调用方该看到 `unavailable` 与「稍后重试」，而不是一条编出来的 setup 问题。
 */
export function rethrowIfDeadline(error: unknown): void {
  if (error instanceof DeadlineError) throw error
}

/**
 * 一条**探针**的上限到点（§O）：`DeadlineError` 的子类，HTTP 侧照旧折成 `unavailable`；
 * 逐项给读数的调用方（doctor）据此只把这一项标成 `timeout`，不把整次检查说成没做完。
 * 整次调用被外部取消时抛的是普通 `DeadlineError`（见 `probeRunner`）。
 */
export class ProbeTimeout extends DeadlineError {
  constructor(what: string, ms: number) {
    super(what, ms)
    this.name = 'ProbeTimeout'
  }
}

/** 一次带预算的外部探针调用（§O）：`probeMs` 是单条探针的上限，`signal` 是外部取消。 */
export interface ProbeBudget {
  readonly probeMs?: number
  readonly signal?: AbortSignal
}

/**
 * 一次探针的选项：`signal` 到点会取消（并因此传到子进程），`timeoutMs` 是同一个上限——
 * 掐不掉信号的实现（或信号之外的慢路径）靠它兜。
 */
export interface ProbeOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

/** 一次探针的执行器（`probeRunner` 的产物）：`what` 是人读的名字，不是 argv。 */
export type Probe = <T>(what: string, work: (options: ProbeOptions) => Promise<T>) => Promise<T>

/**
 * 合并多个取消信号：任一个取消，返回的信号就取消；已经取消的信号立刻生效。
 * 自包含类型面里没有 `AbortSignal.any` 的声明（§N.3），所以用 `AbortController` 手动接线。
 */
export function combineSignals(signals: readonly AbortSignal[]): AbortSignal {
  const controller = new AbortController()
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort()
      break
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  return controller.signal
}

/** 一次 HTTP handler 的时间预算（§O：`totalMs` 必须低于 10 s 的天花板）。 */
export interface HandlerBudget {
  /** 整个 handler 的上限（毫秒）：到点返回固定码 `unavailable`。 */
  readonly totalMs: number
  /**
   * 单个外部调用（探针）的上限。省略表示这条路径只有一个外部调用、用总预算兜住；
   * setup check 这类「串行跑几个 CLI 探针」的路径必须给，否则一个探针就能吃掉全部预算。
   */
  readonly probeMs?: number
}

/** `withDeadline` 的输入。 */
export interface DeadlineOptions {
  /** 上限（毫秒）。 */
  readonly ms: number
  /** 人读的名字（进错误文案；不含 argv）。 */
  readonly what: string
  /** 外部取消（handler 的总预算、停机信号）；到点与取消走同一个错误形态。 */
  readonly signal?: AbortSignal
}

/**
 * 在截止期内跑一段工作：`work` 拿到的信号会在到点时取消（并因此传到子进程/网络读），
 * 到点或外部取消都拒绝 `DeadlineError`。工作正常返回时定时器被清掉，不留挂着的定时器。
 */
export async function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  options: DeadlineOptions
): Promise<T> {
  const controller = new AbortController()
  const outer = options.signal
  // 已经取消 / 预算非正：一发不可收拾地拒绝，连工作都不启动（别起一个注定要被杀的进程）。
  if (outer?.aborted === true || !(options.ms > 0)) {
    controller.abort()
    throw new DeadlineError(options.what, options.ms)
  }

  const expire = (): void => {
    controller.abort()
    reject(new DeadlineError(options.what, options.ms))
  }
  let reject: (error: unknown) => void = () => undefined
  let timer: TimerHandle | undefined
  const expired = new Promise<never>((_, fail) => {
    reject = fail
    timer = setTimeout(expire, options.ms)
    // 截止期定时器不该单独拖住进程退出（HTTP 服务器与测试的其余句柄才是活着的理由）。
    timer.unref()
    outer?.addEventListener('abort', expire, { once: true })
  })
  const running = Promise.resolve().then(() => work(controller.signal))
  // 输掉赛跑的那一边（被取消的探针）之后仍会拒绝：这里收下，别让它变成未处理的 rejection。
  running.catch(() => undefined)
  try {
    return await Promise.race([running, expired])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    outer?.removeEventListener('abort', expire)
  }
}

/**
 * 按预算造一个探针执行器（§O）：`probeMs` 给这条探针装运行时上限，同时把它交给实现
 * （`ProbeOptions.timeoutMs`，子进程靠它兜）；没有预算时原样跑（启动路径与 #64 之前一致）。
 *
 * 两种到点分得清：**这条探针**自己的上限到点抛 `ProbeTimeout`（逐项给读数的调用方据此只把
 * 这一项标成超时）；**整次调用**被外部取消时抛普通 `DeadlineError`——那不是这一项的结论。
 */
export function probeRunner(budget: ProbeBudget | undefined): Probe {
  const ms = budget?.probeMs
  const outer = budget?.signal
  return <T>(what: string, work: (options: ProbeOptions) => Promise<T>): Promise<T> => {
    if (ms === undefined) return work({})
    const options: ProbeOptions = { timeoutMs: ms }
    return withDeadline((signal) => work({ ...options, signal }), {
      ms,
      what,
      ...(outer === undefined ? {} : { signal: outer })
    }).catch((error: unknown) => {
      // 外部取消（handler 的总预算、停机）不是「这条探针慢」：原样抛出去，不制造一项结论。
      if (outer?.aborted === true) throw error
      if (error instanceof DeadlineError) throw new ProbeTimeout(what, ms)
      throw error
    })
  }
}

/**
 * 在「探针上限 + 总预算」两层截止期里跑一段工作（§O），两层都是**先取消再拒绝**。
 *
 * 一条路径只调一个外部命令时两层收敛成更紧的那一条（探针上限）；它仍然有意义：
 * `probeMs` 是「这一个调用该多快」，`totalMs` 是「这个 handler 无论如何不得超过」。
 * 调用链之后多一个外部读取时，总预算不再自动失效，探针上限也仍然只管单条。
 */
export function withinBudget<T>(
  work: (signal: AbortSignal) => Promise<T>,
  budget: HandlerBudget,
  what: string
): Promise<T> {
  const probeMs = budget.probeMs
  if (probeMs === undefined || probeMs >= budget.totalMs) {
    return withDeadline(work, { ms: budget.totalMs, what })
  }
  // 内层是探针，外层是总预算；外层取消会一路取消到内层的信号（子进程随之被 SIGTERM）。
  return withDeadline(
    (signal) => withDeadline(work, { ms: probeMs, what, signal }),
    { ms: budget.totalMs, what }
  )
}

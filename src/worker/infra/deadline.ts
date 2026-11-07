// 取消与截止期（§O「超时」行）：HTTP handler 内不做超过 10 s 的同步等待，长活进 effect；
// 短活（setup 探针、名单同步的一次多页读取）各有一条明确的线。
//
// 三件事只在这里做一次：
// - `DeadlineError`：到点或外部取消的**唯一**错误形态。调用方（`http/`）把它折成固定码
//   `unavailable` + 「稍后重试」；领域模块不自己编一个「超时」的结论（那会把没做完说成做完了）。
// - `combineSignals`：多个取消信号取并集（命令端口与名单同步共用同一份，别再各写一遍）。
// - `withDeadline`：给一段异步工作装一个定时器，到点先取消再拒绝，并且**不留下未处理的
//   rejection**（输掉赛跑的那一边之后仍可能拒绝）。
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

// fake CLI（§I.6）：测试里唯一的「CLI 出口」。脚本化返回值、脚本化失败、记录每次调用、
// 断言取消信号；任何没脚本化到的调用都要显式失败，避免测试悄悄跑网络或真 CLI。
//
// 用法（后续 GitHub / Feishu 票的共同写法）：
//   const cli = new FakeCommands()
//   cli.script('gh api notifications', () => fixture('cli/github/notifications.json'))
//   cli.fail('gh', ['api', 'repos/acme/widgets'], new CliError('gh exited with code 1: ...', 404, 1))
//   await poll(cli)
//   assert.deepEqual(cli.calls.map((call) => call.program), ['gh', 'gh'])
import {
  CliError,
  combineSignals,
  type CommandStream,
  type CommandsHost,
  type RunOptions,
  type StreamExit,
  type StreamOptions
} from '../../src/worker/sources/commands.ts'

/** 一次被记录的调用：程序、参数、选项与调用时收到的取消信号。 */
export interface FakeCall {
  readonly program: string
  readonly args: readonly string[]
  readonly options: RunOptions
  /** 调用时端口上绑定的信号（由 `withSignal` 合并进来）；测试据此断言「窗口取消后不再读」。 */
  readonly signal?: AbortSignal
}

/** 一次被记录的流式调用：程序、参数与调用时的流选项。 */
export interface FakeStreamCall {
  readonly program: string
  readonly args: readonly string[]
  readonly options: StreamOptions
}

/**
 * 测试里的一条流式子进程（§I.6）：测试自己推标准输出行、标准错误诊断与退出码。连接之前的
 * 推送先排队（脚本化的「一开始就退出」就靠它），连接之后立即交付。
 */
export class FakeStream {
  readonly program: string
  readonly args: readonly string[]
  /** 已交付的标准输出行（断言用）。 */
  readonly lines: string[] = []
  /** 已交付的标准错误行（断言用）。 */
  readonly diagnostics: string[] = []
  readonly #queued: (
    | { kind: 'line'; text: string }
    | { kind: 'diagnostic'; text: string }
    | { kind: 'exit'; code: number | null }
  )[] = []
  #options: StreamOptions | undefined
  #exited = false
  #stops = 0

  constructor(program: string, args: readonly string[]) {
    this.program = program
    this.args = [...args]
  }

  /** 子进程是否已经被 `stream()` 建立（测试等它再推行）。 */
  get attached(): boolean {
    return this.#options !== undefined
  }

  /** 测试是否要求过停机（与真端口的 `stop()` 同义）。 */
  get stopped(): boolean {
    return this.#stops > 0
  }

  get stopCount(): number {
    return this.#stops
  }

  /** 推一行标准输出。 */
  out(line: string): this {
    this.#deliver({ kind: 'line', text: line })
    return this
  }

  /** 推一行标准错误诊断（就绪行与失败信息走这里）。 */
  err(line: string): this {
    this.#deliver({ kind: 'diagnostic', text: line })
    return this
  }

  /** 结束子进程；连接之前调用就是「一启动就退出」。 */
  exit(code: number | null = 0): this {
    this.#deliver({ kind: 'exit', code })
    return this
  }

  /** `stream()` 建立了子进程：把排队的动作按顺序交付。 */
  attach(options: StreamOptions): void {
    this.#options = options
    for (const action of this.#queued.splice(0)) this.#apply(action)
  }

  /** 真端口 `stop()` 的替身：记一次停机，并像 SIGTERM 一样交付退出。 */
  stop(): void {
    this.#stops += 1
    if (!this.#exited) this.exit(null)
  }

  #deliver(action: { kind: 'line'; text: string } | { kind: 'diagnostic'; text: string } | { kind: 'exit'; code: number | null }): void {
    if (this.#options === undefined) {
      this.#queued.push(action)
      return
    }
    this.#apply(action)
  }

  #apply(action: { kind: 'line'; text: string } | { kind: 'diagnostic'; text: string } | { kind: 'exit'; code: number | null }): void {
    const options = this.#options
    if (options === undefined || this.#exited) return
    if (action.kind === 'line') {
      this.lines.push(action.text)
      options.onLine(action.text)
      return
    }
    if (action.kind === 'diagnostic') {
      this.diagnostics.push(action.text)
      options.onDiagnostic?.(action.text)
      return
    }
    this.#exited = true
    const outcome: StreamExit = { code: action.code, stderr: this.diagnostics.join('\n') }
    options.onExit(outcome)
  }
}

/** 一条流式脚本：匹配程序与参数前缀，交出预先造好的 `FakeStream`。 */
interface StreamScript {
  readonly matches: (program: string, args: readonly string[]) => boolean
  readonly stream: FakeStream
}

/** 一条脚本：匹配程序与参数前缀（或自定义判定），返回标准输出或抛错。 */
interface Script {
  readonly matches: (program: string, args: readonly string[]) => boolean
  readonly reply: (call: FakeCall) => string | Error
  /** 一次性脚本在命中后移除；持久脚本一直有效。 */
  readonly once: boolean
}

/** 把 `['api', 'notifications']` 或 `'gh api notifications'` 归一成程序 + 参数，供 `script` 使用。 */
function parse(matcher: string | readonly string[]): { program?: string; args: string[] } {
  if (typeof matcher !== 'string') return { args: [...matcher] }
  const parts = matcher.trim().split(/\s+/)
  // 形如 `gh api notifications`：第一个词就是程序；只有一个词时只按程序匹配。
  return { program: parts[0], args: parts.slice(1) }
}

/**
 * `CommandsHost` 的测试替身：脚本化、记录、断言信号。未命中脚本的调用抛错（并记在 `calls`
 * 里），让「测试偷偷跑了真 CLI」变成红灯而不是假绿。
 */
export class FakeCommands implements CommandsHost {
  readonly calls: FakeCall[] = []
  /** 流式调用与 `run` 分开记：事件消费的断言读这一份。 */
  readonly streams: FakeStreamCall[] = []
  readonly #scripts: Script[] = []
  readonly #streamScripts: StreamScript[] = []
  readonly #signals: AbortSignal[] = []

  /** 脚本化一次或多次成功返回：`script('gh api notifications', () => json)`。 */
  script(matcher: string | readonly string[], reply: string | (() => string), options: { once?: boolean } = {}): this {
    const target = parse(matcher)
    return this.#push(target, () => (typeof reply === 'function' ? reply() : reply), options.once ?? false)
  }

  /** 脚本化失败：`fail('gh', ['api', 'x'], new CliError(...))`。 */
  fail(program: string, args: readonly string[], error: Error, options: { once?: boolean } = {}): this {
    return this.#push({ program, args: [...args] }, () => error, options.once ?? false)
  }

  /** 一次调用的脚本化（成功或失败混用）：按顺序只命中一次。 */
  next(program: string, args: readonly string[], reply: string | Error): this {
    return this.#push({ program, args: [...args] }, () => reply, true)
  }

  /** 记录下来的程序序列（断言调用顺序用）。 */
  get programs(): string[] {
    return this.calls.map((call) => call.program)
  }

  /**
   * 脚本化一个流式子进程（一次性：每次 `stream()` 落一条，用完了就轮到下一条）。
   * 测试拿到 `FakeStream` 后自己推行、推诊断、结束它（§I.6：测试不 spawn）。
   */
  scriptStream(program: string, args: readonly string[] = []): FakeStream {
    const stream = new FakeStream(program, args)
    const matches = (candidate: string, received: readonly string[]): boolean => {
      if (candidate !== program) return false
      if (received.length < args.length) return false
      return args.every((value, index) => received[index] === value)
    }
    // 一次性：每次 `stream()` 启动的都是新的子进程，用完了就轮到下一条脚本。
    this.#streamScripts.push({ matches, stream })
    return stream
  }

  /** 起一个假的流式子进程：没有脚本就失败（测试绝不跑真 CLI）。 */
  stream(program: string, args: readonly string[], options: StreamOptions): CommandStream {
    this.streams.push({ program, args: [...args], options })
    const index = this.#streamScripts.findIndex((entry) => entry.matches(program, args))
    if (index < 0) {
      throw new Error(
        `FakeCommands has no stream script for ${program} ${args.join(' ')}; tests never run a real CLI`
      )
    }
    const entry = this.#streamScripts[index] as StreamScript
    this.#streamScripts.splice(index, 1)
    entry.stream.attach(options)
    return { stop: () => entry.stream.stop() }
  }

  /** 便于断言「参数数组没有把消息正文拼成 shell 片段」。 */
  get args(): string[][] {
    return this.calls.map((call) => [...call.args])
  }

  withSignal(signal?: AbortSignal): CommandsHost {
    if (signal === undefined) return this
    const view = new FakeCommandsView(this, signal)
    this.#signals.push(signal)
    return view
  }

  /** `withSignal` 绑过的一切信号（顺序即绑定顺序）。 */
  get signals(): readonly AbortSignal[] {
    return [...this.#signals]
  }

  async run(program: string, args: readonly string[], options: RunOptions = {}): Promise<string> {
    const call: FakeCall = { program, args: [...args], options, ...(options.signal ? { signal: options.signal } : {}) }
    this.calls.push(call)
    const index = this.#scripts.findIndex((entry) => entry.matches(program, args))
    if (index < 0) {
      throw new Error(
        `FakeCommands has no script for ${program} ${args.join(' ')}; tests never run a real CLI`
      )
    }
    const entry = this.#scripts[index] as Script
    if (entry.once) this.#scripts.splice(index, 1)
    const reply = entry.reply(call)
    if (reply instanceof Error) {
      // 与真端口一致的取消语义：信号已取消时抛 AbortError。
      if (options.signal?.aborted === true) throw abortError()
      throw reply
    }
    if (options.signal?.aborted === true) throw abortError()
    return reply
  }

  #push(
    target: { program?: string; args: string[] },
    reply: (call: FakeCall) => string | Error,
    once: boolean
  ): this {
    const matches = (program: string, args: readonly string[]): boolean => {
      if (target.program !== undefined && program !== target.program) return false
      if (args.length < target.args.length) return false
      return target.args.every((value, index) => args[index] === value)
    }
    this.#scripts.push({ matches, reply, once })
    return this
  }
}

/** `withSignal` 的视图：共享记录与脚本，把绑定的信号交给每次 `run`。 */
class FakeCommandsView implements CommandsHost {
  readonly #inner: FakeCommands
  readonly #signal: AbortSignal

  constructor(inner: FakeCommands, signal: AbortSignal) {
    this.#inner = inner
    this.#signal = signal
  }

  withSignal(signal?: AbortSignal): CommandsHost {
    return signal === undefined ? this : this.#inner.withSignal(combine(this.#signal, signal))
  }

  run(program: string, args: readonly string[], options: RunOptions = {}): Promise<string> {
    return this.#inner.run(program, args, {
      ...options,
      signal: options.signal === undefined ? this.#signal : combine(this.#signal, options.signal)
    })
  }

  stream(program: string, args: readonly string[], options: StreamOptions): CommandStream {
    return this.#inner.stream(program, args, {
      ...options,
      signal: options.signal === undefined ? this.#signal : combine(this.#signal, options.signal)
    })
  }
}

/** 合并两个信号（任一个取消都算取消）。 */
function combine(left: AbortSignal, right: AbortSignal): AbortSignal {
  return combineSignals([left, right])
}

/** 与真端口一致的取消错误：名字是 `AbortError`，调用方能与失败分开。 */
export function abortError(message = 'The operation was aborted'): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

/** 常用失败：把 CLI 的 stderr 形状合成 `CliError`（测试不必手写 message 拼接）。 */
export function cliFailure(
  program: string,
  options: { code?: number; exitCode?: number; stderr?: string } = {}
): CliError {
  const stderr = options.stderr ?? ''
  const head = `${program} exited with code ${options.exitCode ?? 1}`
  return new CliError(stderr ? `${head}: ${stderr}` : head, options.code, options.exitCode ?? 1)
}

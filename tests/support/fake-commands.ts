// fake CLI（§I.6）：测试里唯一的「CLI 出口」。脚本化返回值、脚本化失败、记录每次调用、
// 断言取消信号；任何没脚本化到的调用都要显式失败，避免测试悄悄跑网络或真 CLI。
//
// 用法（后续 GitHub / Feishu 票的共同写法）：
//   const cli = new FakeCommands()
//   cli.script('gh api notifications', () => fixture('cli/github/notifications.json'))
//   cli.fail('gh', ['api', 'repos/acme/widgets'], new CliError('gh exited with code 1: ...', 404, 1))
//   await poll(cli)
//   assert.deepEqual(cli.calls.map((call) => call.program), ['gh', 'gh'])
import { CliError, combineSignals, type CommandsHost, type RunOptions } from '../../src/worker/sources/commands.ts'

/** 一次被记录的调用：程序、参数、选项与调用时收到的取消信号。 */
export interface FakeCall {
  readonly program: string
  readonly args: readonly string[]
  readonly options: RunOptions
  /** 调用时端口上绑定的信号（由 `withSignal` 合并进来）；测试据此断言「窗口取消后不再读」。 */
  readonly signal?: AbortSignal
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
  readonly #scripts: Script[] = []
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

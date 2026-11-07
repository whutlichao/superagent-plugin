// 命令端口（§I.4、§O 命令注入）：所有 CLI 调用的唯一出口。
//
// 三条硬约束，测试在 `tests/commands.test.ts` 里逐条断言：
// - **argv 数组 + `shell: false`**：消息正文永远只是某个 argv 元素，绝不拼进 shell；
// - **白名单**：只允许 `gh` / `lark-cli` / `git` / `orca` / `sh`；程序名带路径时必须是绝对路径，
//   且等于或位于 `settings.*.cli` 配置的可执行文件之下；
// - **错误脱敏**：只暴露「程序名 + 结束方式 + 标准错误前 2000 字符」，绝不回显 argv（argv 里
//   有消息正文）；错误对象带 `CliError.code`（从 stderr 的 JSON `error.code` 或 `HTTP <nnn>`
//   提取），Channel 用它判定「永久收不到」。
//
// 本文件是 `src/worker/sources/` 里唯一允许 import `node:child_process` 的模块；`runtime/`
// 的 Orca CLI 包装是另一条（§B），由后续票实现，不经过这里。
import { execFile, spawn, type ExecFileError } from 'node:child_process'
import { basename, isAbsolute } from 'node:path'
import { withoutSecretEnvironment } from '../infra/env.ts'

/** 允许运行的程序（§I.4）。超出这个集合的一律拒绝，先于任何子进程创建。 */
export const ALLOWED_PROGRAMS = ['gh', 'lark-cli', 'git', 'orca', 'sh'] as const
export type AllowedProgram = (typeof ALLOWED_PROGRAMS)[number]

/** 默认超时：60 s（§I.4；`prepare` 的 10 min 与 `worktree create` 的 120 s 由调用方传 `timeoutMs`）。 */
export const DEFAULT_TIMEOUT_MS = 60_000
/** 输出上限：16 MiB（§I.4）。超出即终止子进程并按「输出过多」报错。 */
export const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
/** 错误里保留的标准错误长度（§I.4）。 */
export const STDERR_LIMIT = 2_000

/**
 * 每个子进程都注入的中性环境变量（§I.4）：关掉 gh 的交互提示、lark-cli 的升级提示与
 * git 的终端凭据提示，否则无人值守的插件会卡在提示上。
 */
export const NEUTRAL_ENVIRONMENT = Object.freeze({
  GH_PROMPT_DISABLED: '1',
  LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
  GIT_TERMINAL_PROMPT: '0'
})

/** 一次 `run` 的可选项；全部有默认值。 */
export interface RunOptions {
  readonly cwd?: string
  /** 这次调用的取消信号；与端口自带的信号合并（任一取消都终止子进程）。 */
  readonly signal?: AbortSignal
  /** 覆盖默认的 60 s。 */
  readonly timeoutMs?: number
}

/**
 * Source kind 能用到的命令端口（§I.1 `CommandsHost`）：`run`、流式 `stream` 与 `withSignal`。
 * Kind 拿不到环境变量、也拿不到底层的 `execFile` / `spawn`。
 */
export interface CommandsHost {
  run(program: string, args: readonly string[], options?: RunOptions): Promise<string>
  /**
   * 起一个**长驻**子进程并逐行交付标准输出（§I.3 的事件消费）：`stdout` 按行回调（不含行尾），
   * `stderr` 的诊断也按行给（脱敏后的尾巴留在退出读数里），退出时恰好回调一次 `onExit`。
   * 失败与 `run` 同规矩：程序名必须在白名单里，argv 数组不经 shell。
   */
  stream(program: string, args: readonly string[], options: StreamOptions): CommandStream
  /** 绑定一个取消信号（例如一次评估的窗口）；返回的视图共享配置。 */
  withSignal(signal?: AbortSignal): CommandsHost
}

/** 流式子进程的退出读数：结束方式 + 标准错误的尾巴（诊断用，不含 argv，§I.4 脱敏）。 */
export interface StreamExit {
  readonly code: number | null
  readonly stderr: string
}

/** 一次 `stream` 的选项：逐行回调 + 退出回调，另有与 `run` 相同的选项。 */
export interface StreamOptions extends RunOptions {
  readonly onLine: (line: string) => void
  readonly onDiagnostic?: (line: string) => void
  readonly onExit: (outcome: StreamExit) => void
}

/** 一个正在跑的子进程：`stop()` 关掉标准输入并发 SIGTERM（事件消费把它当停机信号）。 */
export interface CommandStream {
  stop(): void
}

/**
 * 逐行切分：`data` 给的是任意块的文本，行可能被切开。`\r\n` 与 `\n` 都当行尾（Windows 上的
 * CLI 输出）；退出时残留的不完整行由调用方用 `flush()` 交出去。
 */
function lineSplitter(emit: (line: string) => void): {
  push(chunk: string): void
  flush(): void
} {
  let buffer = ''
  return {
    push(chunk: string): void {
      buffer += chunk
      for (;;) {
        const index = buffer.indexOf('\n')
        if (index < 0) return
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        emit(line)
      }
    },
    flush(): void {
      if (buffer.length === 0) return
      const line = buffer.replace(/\r$/, '')
      buffer = ''
      emit(line)
    }
  }
}

/** `isGone` 的判定规则：`code` 必须命中；`message` 给出时，错误消息还要匹配它（如 403 仅在 locked 时）。 */
export interface GoneRule {
  readonly code: number
  readonly message?: RegExp
}

/**
 * CLI 失败的唯一错误形态：`code` 是 CLI 自己报的错误码（GitHub 的 HTTP 状态、Feishu 的
 * 业务码），`exitCode` 是进程退出码；两者都可能缺席。
 */
export class CliError extends Error {
  readonly code?: number
  readonly exitCode?: number

  constructor(message: string, code?: number, exitCode?: number) {
    super(message)
    this.name = 'CliError'
    this.code = code
    this.exitCode = exitCode
  }
}

/** 从标准错误里找 CLI 的错误码：JSON 的 `error.code` 优先，其次 `HTTP <nnn>`（§I.4）。 */
function errorCode(stderr: string): number | undefined {
  const start = stderr.indexOf('{')
  if (start >= 0) {
    try {
      const parsed: unknown = JSON.parse(stderr.slice(start))
      const candidate = (parsed as { error?: { code?: unknown } } | null)?.error?.code
      if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate
    } catch {
      // 非 JSON 的诊断文本走下面的 HTTP 匹配。
    }
  }
  const http = /\bHTTP (\d{3})\b/.exec(stderr)
  return http ? Number(http[1]) : undefined
}

/** 子进程是怎么结束的：只描述结束方式，绝不提参数（§I.4）。 */
function ended(error: ExecFileError, timeoutMs: number): string {
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'printed more output than it may'
  // execFile 超时会用 SIGTERM 终止子进程并置 `killed: true`。
  if (error.killed === true && error.signal === 'SIGTERM') return `timed out after ${timeoutMs} ms`
  if (typeof error.signal === 'string' && error.signal.length > 0) return `was stopped by ${error.signal}`
  if (typeof error.code === 'number') return `exited with code ${error.code}`
  if (typeof error.code === 'string') return `could not run: ${error.code}`
  return 'failed'
}

/**
 * 把一次子进程失败变成脱敏的 `CliError`：程序名 + 结束方式 + 标准错误前 2000 字符。
 * 取消（`AbortError`）原样抛出，调用方才能把「被取消」和「失败」分开。
 *
 * `stderr` 由调用方从 `execFile` 的回调里传进来：Node 只在回调里给完整的标准错误，
 * 错误对象上的 `stderr` 属性常常是 undefined。
 */
export function commandError(
  error: unknown,
  program: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  stderrText: string = ''
): Error {
  const failure = (error ?? {}) as ExecFileError
  if (failure.name === 'AbortError') return failure as Error
  const stderr = stderrText.trim().slice(0, STDERR_LIMIT)
  const exitCode = typeof failure.code === 'number' ? failure.code : undefined
  const head = `${basename(program)} ${ended(failure, timeoutMs)}`
  return new CliError(stderr ? `${head}: ${stderr}` : head, errorCode(stderr), exitCode)
}

/** `error` 是否是被判定为永久失败的那一类（`gone`）：只有命中规则才算，文本像不算（§I.2 / §I.3）。 */
export function isGone(error: unknown, rules: readonly GoneRule[]): boolean {
  if (!(error instanceof CliError) || error.code === undefined) return false
  return rules.some(
    (rule) => rule.code === error.code && (rule.message === undefined || rule.message.test(error.message))
  )
}

/** 程序名是否在白名单内（不带路径的形态）。 */
export function isAllowedProgram(program: string): program is AllowedProgram {
  return (ALLOWED_PROGRAMS as readonly string[]).includes(program)
}

/**
 * 合并多个取消信号：任一个取消，返回的信号就取消。已经取消的信号立刻生效。
 * 自包含类型面里没有 `AbortSignal.any` 的声明（§N.3 其五不允许值声明的 `any` 方法名），
 * 所以这里用 `AbortController` 手动接线。
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

/** 一个信号与可选信号的合并：都缺时返回 undefined（`execFile` 不需要 signal）。 */
function mergeSignals(
  base: AbortSignal | undefined,
  extra: AbortSignal | undefined
): AbortSignal | undefined {
  if (base === undefined) return extra
  if (extra === undefined) return base
  return combineSignals([base, extra])
}

/** `Commands` 的构造选项；全部可选，测试与组合根按需覆盖。 */
export interface CommandsOptions {
  /** `settings.*.cli` 当前值（GitHub / Feishu 各自的 CLI）；空值忽略。 */
  readonly configuredPrograms?: () => readonly (string | undefined)[]
  /** 子进程的额外环境（例如工作区隔离的 git 配置）；`undefined` 表示删除该变量。 */
  readonly environment?: Readonly<Record<string, string | undefined>>
  /** 默认超时，毫秒。 */
  readonly timeoutMs?: number
}

/** 路径是否等于或位于某个已配置的 CLI 之下（配置值既可以是一个文件，也可以是一个目录）。 */
function underConfigured(program: string, configured: readonly (string | undefined)[]): boolean {
  return configured.some((value) => {
    if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) return false
    if (program === value) return true
    const prefix = value.endsWith('/') ? value : `${value}/`
    return program.startsWith(prefix)
  })
}

/**
 * `gh` / `lark-cli` / `git` / `orca` / `sh` 的唯一出口（§I.4）。构造后不可变；`withSignal`
 * 返回共享配置的新视图。
 */
export class Commands implements CommandsHost {
  readonly #configuredPrograms: () => readonly (string | undefined)[]
  readonly #environment: Readonly<Record<string, string | undefined>>
  readonly #timeoutMs: number
  readonly #signal?: AbortSignal

  constructor(options: CommandsOptions = {}, signal?: AbortSignal) {
    this.#configuredPrograms = options.configuredPrograms ?? (() => [])
    this.#environment = options.environment ?? {}
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#signal = signal
  }

  /** 绑定取消信号；没有信号时返回自己（避免无意义的包装）。 */
  withSignal(signal?: AbortSignal): Commands {
    if (signal === undefined) return this
    const combined = this.#signal === undefined ? signal : combineSignals([this.#signal, signal])
    return new Commands(
      {
        configuredPrograms: this.#configuredPrograms,
        environment: this.#environment,
        timeoutMs: this.#timeoutMs
      },
      combined
    )
  }

  /** 运行一个白名单程序，返回标准输出；失败抛 `CliError`，取消抛 `AbortError`。 */
  async run(program: string, args: readonly string[], options: RunOptions = {}): Promise<string> {
    this.#assertAllowed(program)
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs
    const signal = mergeSignals(this.#signal, options.signal)
    return new Promise<string>((resolve, reject) => {
      execFile(
        program,
        args,
        {
          cwd: options.cwd,
          // 先合并再剥（§O）：哪怕调用方显式配置了一个秘密变量，子进程也拿不到它。
          env: withoutSecretEnvironment({ ...process.env, ...this.#environment, ...NEUTRAL_ENVIRONMENT }),
          signal,
          timeout: timeoutMs,
          maxBuffer: MAX_OUTPUT_BYTES,
          encoding: 'utf8',
          shell: false
        },
        (error, stdout, stderr) => {
          if (error) reject(commandError(error, program, timeoutMs, stderr))
          else resolve(stdout)
        }
      )
    })
  }

  /**
   * 起一个长驻子进程并逐行交付标准输出（§I.3 的事件消费）。与 `run` 同规矩：白名单、argv
   * 数组、`shell: false`、中性环境变量；`stop()` 先关标准输入（CLI 把它当优雅停机的信号）
   * 再 SIGTERM，所以禁用事件流不会留下孤儿进程。
   */
  stream(program: string, args: readonly string[], options: StreamOptions): CommandStream {
    this.#assertAllowed(program)
    const signal = mergeSignals(this.#signal, options.signal)
    const child = spawn(program, [...args], {
      cwd: options.cwd,
      env: { ...process.env, ...this.#environment, ...NEUTRAL_ENVIRONMENT },
      stdio: ['pipe', 'pipe', 'pipe'],
      signal,
      shell: false
    })
    let stderr = ''
    let ended = false
    // 退出只回调一次：`close` 与 `error` 都可能来（spawn 失败时只有 `error`）。
    const finish = (code: number | null): void => {
      if (ended) return
      ended = true
      out.flush()
      err.flush()
      options.onExit({ code, stderr: stderr.trim().slice(0, STDERR_LIMIT) })
    }
    const out = lineSplitter((line) => options.onLine(line))
    const err = lineSplitter((line) => {
      stderr = `${stderr}${line}\n`.slice(-STDERR_LIMIT)
      options.onDiagnostic?.(line)
    })
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => out.push(chunk))
    child.stderr?.on('data', (chunk) => err.push(chunk))
    child.on('close', (code) => finish(code))
    child.on('error', (error) => {
      // spawn 失败（找不到程序之类）：错误消息进标准错误的尾巴，按「没有退出码」结束。
      stderr = `${stderr}${error.message}\n`.slice(-STDERR_LIMIT)
      finish(null)
    })
    return {
      stop(): void {
        if (ended) return
        child.stdin?.end()
        child.kill('SIGTERM')
      }
    }
  }

  /** 白名单与路径规则（§I.4）；拒绝发生在创建子进程之前。 */
  #assertAllowed(program: string): void {
    if (program.length === 0) throw new Error('A program name is required')
    if (program.includes('/')) {
      if (!isAbsolute(program)) {
        throw new Error(`The program ${program} must be absolute or a bare name`)
      }
      if (!underConfigured(program, this.#configuredPrograms())) {
        throw new Error(
          `The program ${program} is not inside a configured CLI (settings.*.cli); a path is only allowed there`
        )
      }
      return
    }
    if (!isAllowedProgram(program)) {
      throw new Error(
        `The program ${program} is not one of the allowed programs: ${ALLOWED_PROGRAMS.join(', ')}`
      )
    }
  }
}

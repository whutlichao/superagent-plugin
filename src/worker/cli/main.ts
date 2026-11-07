// CLI 的入口逻辑（`src/bin/superagent.mjs` 的唯一依赖）。
//
// 三件事，按顺序：
//   1. 解析 argv（语法）→ 命令表（哪条命令、参数对不对）；
//   2. 解析目标（状态目录 → 端口 → token，§G.4）并把命令变成一次 HTTP 调用；
//   3. 把信封打到 stdout（`--text` 打人读文本）、错误同时打 stderr 一行、用退出码退出。
//
// `main` 接受注入的 `argv`/`env`/`home`/`stdout`/`stderr`/`stdin`/`sleep`：于是测试能在同一
// 进程里断言输出与退出码，不需要起子进程；`superagent.mjs` 只传真实值。
//
// 红线（票面「输出与错误绝不回显参数数组与 token」）：打印的任何一行都不含 token 值，
// 也不含整段 argv；错误信封只有固定 `code`/`message`/`values`（`values` 是填槽值）。
import type { CliTarget } from './target.ts'
import { resolveTarget } from './target.ts'
import { dispatch, outputText } from './commands.ts'
import { CLI_COMMANDS } from './commands.ts'
import { EXIT, parseArgs, render, type ExitCode } from './io.ts'

/** 一次 CLI 调用的输出通道（测试注入数组收集）。 */
export interface CliIo {
  readonly out: (text: string) => void
  readonly err: (text: string) => void
}

/** `main` 的输入：全部可选，缺省取进程环境。 */
export interface MainOptions {
  readonly argv: readonly string[]
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly home?: string | undefined
  readonly io?: CliIo
  /** 目标解析的覆盖（测试直接给一个指向临时服务器的目标）。 */
  readonly target?: CliTarget
  /** 重试前的等待（测试注入）。 */
  readonly sleep?: (milliseconds: number) => Promise<void>
  /** 读 stdin（`--decisions -` 等）；缺省不支持。 */
  readonly stdin?: () => Promise<string>
}

/** `main` 的结果：退出码（`superagent.mjs` 用它 `process.exitCode = code`）。 */
export interface MainResult {
  readonly exit: ExitCode
}

/**
 * 跑一次 CLI。永不抛错：解析/网络/信封的任何失败都收敛成「一行 stderr + 一个退出码」。
 * 成功时 stdout 是信封（或 `--text` 的人读文本）；失败时 stdout 仍是 JSON 信封（脚本要读它），
 * 同时 stderr 给一行 `error: <code>: <message>`（人一眼能看到）。
 */
export async function main(options: MainOptions): Promise<MainResult> {
  const io = options.io ?? {
    out: (text: string) => console.log(text),
    err: (text: string) => console.error(text)
  }

  // `--help` / `-h`：命令表生成的清单，任何命令前都能问（不解析目标、不连 worker）。
  if (options.argv.includes('--help') || options.argv.includes('-h')) {
    io.out(helpText(CLI_COMMANDS))
    return { exit: EXIT.ok }
  }

  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs(options.argv)
  } catch (error) {
    return reportFailure(io, error)
  }

  let target: CliTarget
  try {
    target = options.target ?? resolveTarget({
      stateDir: stringFlag(parsed.flags['state-dir']),
      token: stringFlag(parsed.flags['token']),
      tokenFile: stringFlag(parsed.flags['token-file']),
      env: options.env ?? process.env,
      home: options.home
    })
  } catch (error) {
    return reportFailure(io, error)
  }

  const result = await dispatch({
    parsed,
    target,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.stdin === undefined ? {} : { stdin: options.stdin })
  })
  const text = render(result.envelope, { text: outputText(parsed) })
  io.out(text)
  if (!result.envelope.ok) {
    io.err(`error: ${result.envelope.error.code}: ${result.envelope.error.message}`)
  }
  return { exit: result.exit }
}

/** `--state-dir` / `--token-file` 的字符串值。 */
function stringFlag(value: string | true | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** 解析阶段的失败（`invalid_params` 等）：一行 stderr + 退出码，stdout 给 JSON 信封。 */
function reportFailure(io: CliIo, error: unknown): MainResult {
  const code = error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'internal'
  const message = error instanceof Error ? (code === 'internal' ? 'Internal error' : error.message) : 'Internal error'
  io.out(JSON.stringify({ ok: false, error: { code, message } }, null, 2))
  io.err(`error: ${code}: ${message}`)
  return { exit: code === 'internal' ? EXIT.internal : EXIT.refused }
}

/** `--help` 的文本（命令表驱动的清单；不含任何环境值）。 */
export function helpText(commands: readonly { readonly name: readonly string[]; readonly summary: string }[]): string {
  const lines = [
    'superagent — the Superagent CLI (talks to the loopback worker over HTTP)',
    '',
    'usage: node <plugin>/src/bin/superagent.mjs <command> [arguments] [--flags]',
    '',
    'global flags: --json (default) | --text, --state-dir <dir>, --token-file <file>, --request-id <id>',
    'debug only: --token <value> (never logged; prefer --token-file)',
    '',
    'commands:'
  ]
  for (const command of commands) lines.push(`  ${command.name.join(' ').padEnd(24)} ${command.summary}`)
  return lines.join('\n')
}

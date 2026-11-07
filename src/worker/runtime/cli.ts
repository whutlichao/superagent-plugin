// `orca` CLI 的子进程包装（§B.4 `runtime/cli.ts`）：argv 数组、`shell:false`、超时、
// `maxBuffer` 16 MiB、统一的 JSON 信封与脱敏错误。
//
// 为什么必须走 CLI：Host API 没有建/删 worktree、关终端、起一次性命令这几件事（§B.1）。
// 本文件是 seam 目录里唯一允许起 `orca` 子进程的地方；`sources/commands.ts` 是 Source 的
// `gh`/`lark-cli` 出口，两者互不替代（§I.4）。
import { execFile, type ExecFileError } from 'node:child_process'
import { basename } from 'node:path'
import { OrcaRuntimeError, type JsonValue } from './orca-runtime.ts'

/** 默认超时（§E.1：worktree create 的 120 s 是调用方传的；这里给通用 60 s）。 */
export const CLI_TIMEOUT_MS = 60_000
/** 输出上限 16 MiB（与 Source 的命令端口同口径）。 */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
/** 错误里保留的标准错误长度。 */
const STDERR_LIMIT = 2_000

/** 一次 CLI 调用的选项。 */
export interface CliRunOptions {
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

/** `orca ... --json` 的包装接口（测试注入替身，不跑真 CLI）。 */
export interface OrcaCli {
  /** 跑一条命令并返回 `result`（信封已解开）；失败抛 `OrcaRuntimeError`。 */
  run(args: readonly string[], options?: CliRunOptions): Promise<JsonValue>
}

/** 子进程结束方式（只描述，不回显 argv：argv 里可能有 prompt 正文）。 */
function ended(error: ExecFileError): string {
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'printed more output than it may'
  if (error.killed === true && error.signal === 'SIGTERM') return 'timed out'
  if (typeof error.signal === 'string' && error.signal.length > 0) return `was stopped by ${error.signal}`
  if (typeof error.code === 'number') return `exited with code ${error.code}`
  return 'could not run'
}

/** 从 CLI 的 JSON 信封里取 `result`；`ok:false` 按码转成 seam 错误。 */
function unwrap(output: string, program: string): JsonValue {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    throw new OrcaRuntimeError('cli_failed', `${basename(program)} printed a response that is not JSON`)
  }
  if (typeof parsed !== 'object' || parsed === null) return parsed
  const envelope = parsed as { readonly ok?: unknown; readonly result?: unknown; readonly error?: { readonly code?: unknown; readonly message?: unknown } }
  if (envelope.ok === false) {
    const code = typeof envelope.error?.code === 'string' ? envelope.error.code : 'cli_failed'
    const message = typeof envelope.error?.message === 'string' ? envelope.error.message : 'the CLI refused'
    throw new OrcaRuntimeError(code === 'not_found' ? 'workspace_missing' : 'cli_failed', message.slice(0, 300))
  }
  return envelope.result ?? parsed
}

/** 造一个真的 `orca` CLI 包装（`--json` 由这里统一追加）。 */
export function createOrcaCli(program = 'orca'): OrcaCli {
  return {
    run(args: readonly string[], options: CliRunOptions = {}): Promise<JsonValue> {
      const timeoutMs = options.timeoutMs ?? CLI_TIMEOUT_MS
      const argv = [...args, '--json']
      return new Promise<JsonValue>((resolve, reject) => {
        execFile(
          program,
          argv,
          {
            timeout: timeoutMs,
            maxBuffer: MAX_OUTPUT_BYTES,
            encoding: 'utf8',
            shell: false,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            env: { ...process.env, GH_PROMPT_DISABLED: '1' }
          },
          (error, stdout, stderr) => {
            if (error) {
              if ((error as ExecFileError).name === 'AbortError') {
                reject(new OrcaRuntimeError('cancelled', 'the CLI call was cancelled'))
                return
              }
              const detail = String(stderr ?? '').trim().slice(0, STDERR_LIMIT)
              const timedOut = (error as ExecFileError).killed === true
              reject(
                new OrcaRuntimeError(
                  timedOut ? 'cli_timeout' : 'cli_failed',
                  `${basename(program)} ${ended(error as ExecFileError)}${detail === '' ? '' : `: ${detail}`}`
                )
              )
              return
            }
            try {
              resolve(unwrap(stdout, program))
            } catch (failure) {
              reject(failure)
            }
          }
        )
      })
    }
  }
}

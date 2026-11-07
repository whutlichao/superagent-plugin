// checkout 后置命令（§E.3 的 `prepare`）：worktree 建好、agent 启动之前跑一次。
//
// 上游的 `prepare` 是「建目录的命令」；Orca 里 worktree 已经由 `orca worktree create` 建好，
// 所以这里只剩「在 worktree 里执行一条命令」：10 分钟预算、输出落日志、非零退出让 Ticket
// 失败。命令文本的 `${DSH_SUPERAGENT_*}` 变量替换归 #13（§E.3、§E.11），本文件只执行
// 已经替换好的最终文本——绝不在插件内拼接未转义的 shell。
//
// 「一条 Ticket 只跑一次、重试或人的新消息会重跑」的记账在调用方（`orca-executor.ts`）：
// 一次 Assignment 一条命令，新 Assignment（retry / resume）自然重跑。
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { OrcaRuntime, WorkspaceHandle } from '../runtime/orca-runtime.ts'

/** prepare 的预算：10 分钟（§E.3）。 */
export const PREPARE_TIMEOUT_MS = 10 * 60 * 1000

/** 一次 prepare 的结果（`ran: false` 表示没有配置命令）。 */
export interface PrepareResult {
  readonly ran: boolean
  readonly exitCode: number | null
  readonly output: readonly string[]
  /** 输出日志的落点（成功与失败都写，便于复盘）。 */
  readonly logPath: string
}

/** prepare 失败：退出码与输出都在这里，调用方据此把 Ticket 标记失败。 */
export class PrepareError extends Error {
  readonly exitCode: number | null
  readonly output: readonly string[]
  readonly logPath: string

  constructor(logPath: string, exitCode: number | null, output: readonly string[], message: string) {
    super(message)
    this.name = 'PrepareError'
    this.logPath = logPath
    this.exitCode = exitCode
    this.output = output
  }
}

/** prepare 日志路径：`<stateDir>/logs/prepare-<ticket>-<assignment>.log`（§N.5 日志目录）。 */
export function prepareLogPath(stateDir: string, ticketId: string, assignmentId: string): string {
  return join(stateDir, 'logs', `prepare-${ticketId}-${assignmentId}.log`)
}

/** 写 prepare 日志（先建目录；命令输出按行写，失败的完整输出不会丢）。 */
function writeLog(path: string, ticketId: string, command: string, output: readonly string[]): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    [`# prepare for ${ticketId}`, '', `command: ${command}`, '', ...output, ''].join('\n'),
    'utf8'
  )
}

/** `runPrepare` 的输入。 */
export interface PrepareOptions {
  readonly runtime: OrcaRuntime
  readonly ticketId: string
  readonly assignmentId: string
  readonly workspace: WorkspaceHandle
  /** 已替换变量、可安全执行的最终命令文本；空串表示没有配置。 */
  readonly command: string | undefined
  /** `<stateDir>`：日志写在它下面。 */
  readonly stateDir: string
}

/**
 * 在 Ticket 的 worktree 里跑一次 prepare。非零退出 → `PrepareError`（带完整输出与日志路径）；
 * 超时（seam 的 `cli_timeout`）按同样方式上抛，由调用方把 Ticket 标记失败。
 */
export async function runPrepare(options: PrepareOptions): Promise<PrepareResult> {
  const command = options.command?.trim() ?? ''
  const logPath = prepareLogPath(options.stateDir, options.ticketId, options.assignmentId)
  if (command === '') return { ran: false, exitCode: null, output: [], logPath }

  const handle = await options.runtime.runCommand({
    workspace: options.workspace,
    command,
    timeoutMs: PREPARE_TIMEOUT_MS,
    title: `prepare ${options.ticketId}`
  })
  writeLog(logPath, options.ticketId, command, handle.output)
  if (handle.exitCode !== 0) {
    const last = handle.output.at(-1) ?? 'no output'
    throw new PrepareError(
      logPath,
      handle.exitCode,
      handle.output,
      `prepare exited with ${String(handle.exitCode)}: ${last}`
    )
  }
  return { ran: true, exitCode: handle.exitCode, output: handle.output, logPath }
}

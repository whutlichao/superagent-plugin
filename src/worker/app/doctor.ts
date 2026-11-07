// `doctor` 的检查实现（§G.2 的 doctor 行、§N.4、§O）。
//
// 七项逐条给 `ok | warn | fail`：
//   token        主 token 文件在不在、权限是否是 0600（**只 stat，不读值**）
//   port         端口文件是否指向一个活着的端口（能连上 → ok；文件在但连不上 → warn）
//   lock         `<stateDir>/lock`：有活实例 / 陈旧遗留 / 没有
//   database     库在不在、schema 版本与插件一致（只读打开，绝不迁移）
//   cli          CLI 入口（`src/bin/superagent.mjs`）是否存在
//   gh           `gh auth status`（§I.4：agent 账号的 CLI 能读到账号）
//   lark         `lark-cli auth status` 的 bot 身份（可选：没装 lark-cli 只是 warn）
//
// 红线（§O、§N.5）：输出**不含 token、不含密钥值**。每条 `detail` 都是这里拼出来的固定句子；
// 子进程的输出只用来判定，不原样回显（gh/lark 的输出里有账号名与 token 片段）。
//
// 依赖方向（§C.2）：本文件只 import `core/`、`infra/` 与 `app/` 的兄弟模块（类型在
// `doctor-types.ts`，HTTP 与 CLI 两侧都从那里再导出）。
// 需要跑子进程时经**注入的** `CommandsRunner`（组合根给 `sources/commands.ts` 的实现），
// 于是单测能用 fake 而不碰真 CLI，生产也不会多出第二个子进程出口。
import { existsSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { LOCK_FILE, lockAgeMs, readLock, STALE_AFTER_MS } from '../infra/lock.ts'
import { API_TOKEN_FILE, TOKEN_MODE } from '../infra/tokens.ts'
import { DEFAULT_PORT, PORT_FILE, readPortRecord } from '../http/port-file.ts'
import type { DatabaseInspection } from './store.ts'
import { doctorCheck, doctorResult } from './doctor-types.ts'
import type { DoctorCheck, DoctorResult } from './doctor-types.ts'

/**
 * 跑一个子进程并返回它的标准输出。实现由组合根注入（生产用 `sources/commands.ts`），
 * 于是 doctor 不新增子进程出口，测试也可以给一个只回固定文本的 fake。
 */
export type CommandsRunner = (program: string, args: readonly string[]) => Promise<string>

/** doctor 需要的接线。 */
export interface DoctorOptions {
  readonly stateDir: string
  /** 子进程出口；缺省「找不到程序」——于是 gh/lark 两项按「没装」处理，而不是抛错。 */
  readonly run?: CommandsRunner
  /** CLI 入口的绝对路径（`src/bin/superagent.mjs`）；缺省从本模块位置推。 */
  readonly cliPath?: string
  /** 时钟（测试注入固定时刻）。 */
  readonly now?: () => string
  /** 端口探测：缺省真连一次 `127.0.0.1:<port>`（200 ms 上限），测试注入假结果。 */
  readonly portOpen?: (port: number) => Promise<boolean>
  /**
   * 只看库的只读自检（`Store.inspect`）。缺省「没有库」——doctor 在没有 worker 时也能跑，
   * 结论是「还没建库」（warn），而不是抛错或替他建一个。
   */
  readonly inspectDatabase?: () => DatabaseInspection
}

/** 端口探测的上限（§O：HTTP handler 不做超过 10 s 的等待；doctor 更短）。 */
export const PORT_PROBE_TIMEOUT_MS = 200

/** 跑完全部七项检查。任何一项都不抛错：读不到就是读不到，结论如实写进条目。 */
export async function runDoctor(options: DoctorOptions): Promise<DoctorResult> {
  const stateDir = options.stateDir
  const now = options.now ?? (() => new Date().toISOString())
  const portOpen = options.portOpen ?? defaultPortProbe
  const run = options.run ?? missingRunner

  const checks: DoctorCheck[] = []
  checks.push(checkToken(stateDir))
  checks.push(await checkPort(stateDir, portOpen))
  checks.push(checkLock(stateDir))
  checks.push(checkDatabase(options.inspectDatabase))
  checks.push(checkCli(options.cliPath))
  checks.push(await checkGh(run))
  checks.push(await checkLark(run))

  return doctorResult(checks, { stateDir, at: now() })
}

// ---------------------------------------------------------------- token

/**
 * 主 token：文件在不在、权限对不对。**值绝不读出**——只 `statSync`，不 `readFileSync`。
 */
function checkToken(stateDir: string): DoctorCheck {
  const path = join(stateDir, API_TOKEN_FILE)
  if (!existsSync(path)) {
    return doctorCheck(
      'token',
      'fail',
      'the operator token file is missing',
      'start the plugin once (the worker generates it), or run `superagent admin rotate-token --yes`'
    )
  }
  const mode = statSync(path).mode & 0o777
  if (mode !== TOKEN_MODE) {
    return doctorCheck(
      'token',
      'warn',
      `the operator token file is readable by more than its owner (mode ${mode.toString(8)})`,
      `chmod 600 ${path}`
    )
  }
  return doctorCheck('token', 'ok', 'the operator token file exists with mode 0600')
}

// ---------------------------------------------------------------- port

/** 端口文件：没有文件 → fail（worker 没起来过）；有文件但连不上 → warn。 */
async function checkPort(
  stateDir: string,
  portOpen: (port: number) => Promise<boolean>
): Promise<DoctorCheck> {
  const record = readPortRecord(stateDir)
  if (record === null) {
    if (existsSync(join(stateDir, PORT_FILE))) {
      return doctorCheck(
        'port',
        'warn',
        'the port file is stale; its process is gone',
        'start the plugin again; the worker rewrites the port file on boot'
      )
    }
    return doctorCheck(
      'port',
      'fail',
      `no port file yet (the default port is ${DEFAULT_PORT})`,
      'enable the Superagent plugin in Orca so its worker starts'
    )
  }
  if (await portOpen(record.port)) {
    return doctorCheck('port', 'ok', `the worker answers on 127.0.0.1:${record.port}`)
  }
  return doctorCheck(
    'port',
    'warn',
    `the port file names ${record.port}, but nothing answers there`,
    'the worker may be starting; run `superagent doctor` again in a moment'
  )
}

/** 真连一次 loopback 端口（200 ms 上限；连上即关闭）。 */
export function defaultPortProbe(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.destroy()
      finish(true)
    })
    socket.on('error', () => finish(false))
    setTimeout(() => {
      socket.destroy()
      finish(false)
    }, PORT_PROBE_TIMEOUT_MS)
  })
}

// ---------------------------------------------------------------- lock

/** 锁：活实例（新鲜）→ ok；陈旧（崩溃遗留）→ warn；没有 → ok（插件没启用）。 */
function checkLock(stateDir: string): DoctorCheck {
  const path = join(stateDir, LOCK_FILE)
  if (!existsSync(path)) {
    return doctorCheck('lock', 'ok', 'no lock file: no worker has taken this state directory yet')
  }
  const holder = readLock(path)
  const ageMs = lockAgeMs(path)
  if (ageMs !== null && ageMs <= STALE_AFTER_MS) {
    return doctorCheck('lock', 'ok', `a live worker holds the state directory (pid ${holder?.pid ?? 'unknown'})`)
  }
  return doctorCheck(
    'lock',
    'warn',
    'the lock is stale: its worker is gone',
    'the next worker start reclaims it automatically; run `superagent doctor` again after it does'
  )
}

// ---------------------------------------------------------------- database

/** 库：没有库 → warn（还没启动过）；版本一致 → ok；更高/更低 → fail/warn（§N.6）。 */
function checkDatabase(inspect: (() => DatabaseInspection) | undefined): DoctorCheck {
  if (inspect === undefined) {
    return doctorCheck(
      'database',
      'warn',
      'no database yet: the worker creates it on first boot',
      'enable the plugin once; a fresh database is created at <stateDir>/superagent.sqlite'
    )
  }
  let inspection: DatabaseInspection
  try {
    inspection = inspect()
  } catch (error) {
    return doctorCheck(
      'database',
      'fail',
      `the database could not be read (${error instanceof Error ? error.name : 'unknown'})`,
      'restore the newest backup in <stateDir>/backups, or check the worker log'
    )
  }
  if (inspection.schemaVersion > inspection.pluginVersion) {
    return doctorCheck(
      'database',
      'fail',
      `the database schema (${inspection.schemaVersion}) is newer than this plugin (${inspection.pluginVersion})`,
      'downgrade the plugin or restore a backup made before the upgrade'
    )
  }
  if (inspection.schemaVersion < inspection.pluginVersion) {
    return doctorCheck(
      'database',
      'warn',
      `the database schema (${inspection.schemaVersion}) is older than this plugin (${inspection.pluginVersion})`,
      'the next worker start migrates it, after writing a backup to <stateDir>/backups'
    )
  }
  return doctorCheck(
    'database',
    'ok',
    `the database is readable at schema ${inspection.schemaVersion} (${inspection.tables} tables, ${inspection.bytes} bytes)`
  )
}

// ---------------------------------------------------------------- cli

/** CLI 入口：文件在不在（路径不是秘密，照实报，§N.5）。 */
function checkCli(cliPath: string | undefined): DoctorCheck {
  if (cliPath === undefined) {
    return doctorCheck(
      'cli',
      'warn',
      'the CLI entry path was not given',
      'call the CLI by its absolute path from the plugin directory: <plugin>/src/bin/superagent.mjs'
    )
  }
  if (!existsSync(cliPath)) {
    return doctorCheck('cli', 'fail', `the CLI entry is missing: ${cliPath}`, 'reinstall the plugin')
  }
  return doctorCheck('cli', 'ok', `the CLI entry exists: ${cliPath}`)
}

// ---------------------------------------------------------------- gh / lark-cli

/** `gh auth status`：退出码 0 即已登录（输出不回显：里面有账号名）。 */
async function checkGh(run: CommandsRunner): Promise<DoctorCheck> {
  try {
    await run('gh', ['auth', 'status'])
    return doctorCheck('gh', 'ok', 'the GitHub CLI reports a signed-in account')
  } catch (error) {
    if (isMissingProgram(error)) {
      return doctorCheck(
        'gh',
        'warn',
        'the GitHub CLI is not on PATH',
        'install gh 2.48 or later, or set the agent CLI path in Settings'
      )
    }
    return doctorCheck('gh', 'fail', 'the GitHub CLI is not signed in', 'sign in as the agent account: gh auth login')
  }
}

/** `lark-cli auth status` 的 bot 身份（Feishu 是可选的：没装只是 warn）。 */
async function checkLark(run: CommandsRunner): Promise<DoctorCheck> {
  let text: string
  try {
    text = await run('lark-cli', ['auth', 'status'])
  } catch (error) {
    if (isMissingProgram(error)) {
      return doctorCheck(
        'lark',
        'warn',
        'lark-cli is not on PATH; Feishu is optional',
        'install lark-cli only if this deployment reads Feishu'
      )
    }
    return doctorCheck('lark', 'warn', 'lark-cli did not report its auth status', 'run `lark-cli auth status` yourself to see why')
  }
  switch (botStatus(text)) {
    case 'ready':
      return doctorCheck('lark', 'ok', 'the bot identity of lark-cli is ready')
    case 'missing':
      return doctorCheck('lark', 'warn', 'lark-cli has no bot identity', 'configure the bot app with lark-cli (strict mode bot)')
    default:
      return doctorCheck('lark', 'warn', 'lark-cli reported an unexpected bot status', 'run `lark-cli auth status` yourself to see why')
  }
}

/**
 * 从 `lark-cli auth status` 的 JSON 里只取 `identities.bot.status`（不抄其余字段：
 * 输出里有 appId、openId 与 scope 列表，都不该进 doctor）。
 */
export function botStatus(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return 'unknown'
    const identities = (parsed as { identities?: unknown }).identities
    if (typeof identities !== 'object' || identities === null) return 'unknown'
    const bot = (identities as { bot?: unknown }).bot
    if (typeof bot !== 'object' || bot === null) return 'missing'
    const status = (bot as { status?: unknown }).status
    return typeof status === 'string' ? status : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** 「程序不在」的错误：`ENOENT`（execFile）或我们自己的 missingRunner。 */
function isMissingProgram(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as { code?: unknown }).code
  return code === 'ENOENT' || code === 'missing_program' || error.message.includes('ENOENT')
}

/** 没有注入 runner 时的缺省：每项都按「程序没装」处理（warn），而不是抛错。 */
const missingRunner: CommandsRunner = async (program) => {
  const error = new Error(`${program} is not available`)
  Object.assign(error, { code: 'missing_program' })
  throw error
}

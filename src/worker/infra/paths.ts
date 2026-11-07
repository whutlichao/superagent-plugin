// 状态目录的解析（§G.4 第 1 条、§D.5）：`--state-dir` ＞ `$ORCA_SUPERAGENT_STATE_DIR`
// ＞ `${XDG_STATE_HOME:-$HOME/.local/state}/orca-superagent`。
//
// CLI 不在插件进程里，读不到 `orca.settings`，所以设置里的 `stateDir` 由 worker 写进默认
// 目录下的 `state-dir-pointer`（0600，内容是目标绝对路径）；CLI 只在**使用默认路径**时
// 读它——显式参数与环境变量永远优先，一次误写不能让显式选择失效。
//
// 纯函数 + 注入的 `home`/`env`：测试与 doctor 都不会碰到这台机器真实的 `~/.local/state`。
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { STATE_DIR_ENV, STATE_DIR_NAME, STATE_DIR_POINTER } from '../app/kv.ts'

export { STATE_DIR_ENV, STATE_DIR_NAME, STATE_DIR_POINTER }

/** 状态目录的来源（doctor 与 `status` 的 `process` 段说明「这个路径是怎么来的」）。 */
export type StateDirSource = 'argument' | 'environment' | 'pointer' | 'default'

/** 一次解析的结果。 */
export interface StateDirResolution {
  readonly stateDir: string
  readonly source: StateDirSource
}

/** 解析所需的输入；`home`/`env` 缺省取进程环境（测试一律注入）。 */
export interface StateDirInput {
  /** `--state-dir` 的值；空串视同未给。 */
  readonly argument?: string | undefined
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly home?: string | undefined
}

/** 非空字符串才算「给了」。 */
function given(value: string | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

/** 默认状态目录：`${XDG_STATE_HOME:-$HOME/.local/state}/orca-superagent`（§D.5）。 */
export function defaultStateDir(input: Omit<StateDirInput, 'argument'> = {}): string {
  const env = input.env ?? process.env
  const home = input.home ?? homedir()
  const base = given(env['XDG_STATE_HOME']) ?? join(home, '.local', 'state')
  return join(base, STATE_DIR_NAME)
}

/**
 * 读默认目录下的指针文件：只有「一行绝对路径」才算数。
 * 文件不存在、内容为空、相对路径、`~/` 开头的路径、或本身是个目录，一律 `null`
 * （读者于是留在默认目录上，而不是跳到一个猜出来的地方）。
 */
export function readStateDirPointer(defaultDir: string): string | null {
  let text: string
  try {
    text = readFileSync(join(defaultDir, STATE_DIR_POINTER), 'utf8')
  } catch {
    return null
  }
  const target = text.trim()
  if (target.length === 0) return null
  if (!isAbsolute(target)) return null
  return target
}

/**
 * 三重解析（§G.4 第 1 条）。只在落到默认路径时才读指针文件，返回它实际用的目录与来源。
 */
export function resolveStateDir(input: StateDirInput = {}): StateDirResolution {
  const flag = given(input.argument)
  if (flag !== null) return { stateDir: flag, source: 'argument' }

  const env = input.env ?? process.env
  const fromEnv = given(env[STATE_DIR_ENV])
  if (fromEnv !== null) return { stateDir: fromEnv, source: 'environment' }

  const fallback = defaultStateDir({ env, home: input.home })
  const pointer = readStateDirPointer(fallback)
  if (pointer !== null) return { stateDir: pointer, source: 'pointer' }
  return { stateDir: fallback, source: 'default' }
}

/**
 * 写指针文件（0600）：worker 在设置里的 `stateDir` 与默认路径不同时调用它（§G.4 第 1 条），
 * 于是 CLI 在默认路径上也能找到实际目录。
 *
 * 只写一行绝对路径；目标不是绝对路径就抛错（与 `readStateDirPointer` 的判定对称——
 * 写进去一个读不出来的值等于没写）。返回写下的路径。
 */
export function writeStateDirPointer(defaultDir: string, target: string): string {
  if (!isAbsolute(target)) throw new Error('the state directory pointer needs an absolute path')
  const path = join(defaultDir, STATE_DIR_POINTER)
  mkdirSync(defaultDir, { recursive: true })
  // 先删后建：已存在文件的权限不会被 `writeFileSync` 收紧（与 token 文件同一条纪律，§D.6）。
  try {
    unlinkSync(path)
  } catch {
    // 不存在就是我们要的结果。
  }
  writeFileSync(path, `${target}\n`, { encoding: 'utf8', mode: 0o600 })
  return path
}

/** 删掉指针文件（设置改回默认目录时）；返回是否真的删了。 */
export function removeStateDirPointer(defaultDir: string): boolean {
  try {
    unlinkSync(join(defaultDir, STATE_DIR_POINTER))
    return true
  } catch {
    return false
  }
}

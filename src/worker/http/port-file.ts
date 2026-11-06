// 端口文件（§D.5 `<stateDir>/api-port`、§N.1 端口选择、附录 C 的 S6）。
//
// 文件内容是「实际监听端口 + pid + 启动时间」的 JSON（0600）。设计 §D.5 只写「`"3847"`」，
// 但 S6 的回落要求「端口文件带 pid 与启动时间，读者校验发现失效则重新探测」——所以记录
// 形态取 JSON；同时**兼容**纯数字的旧形态（读作 `{port, pid: null, startedAt: null}`），
// 因为 §D.5 的读者（CLI、面板）可能先于本票的实现存在。
//
// 读侧规则：端口号越界或内容坏 → 当作没有端口文件；记录带 pid 且该进程已不在 → 也当作
// 没有（S6：Orca 应用重启后旧 worker 的端口文件必须失效，读者重新探测）。
//
// 文件名来自 `app/kv.ts` 的维护族键（§D.3 的上线约束：键字面量只在 kv.ts 与 migration.ts）。
import { closeSync, readFileSync, unlinkSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { API_PORT_KEY } from '../app/kv'

/** 端口文件名（§D.5；值取自 `API_PORT_KEY`，`api-port` 的字面量只活在 `app/kv.ts`）。 */
export const PORT_FILE = API_PORT_KEY

/** 默认端口（§G.4 第 2 条、§N.1）。 */
export const DEFAULT_PORT = 3847

/** 端口被占用时最多往后试几个（§N.1：+1 试到 +20，仍失败用临时端口）。 */
export const PORT_ATTEMPTS = 20

/** 端口文件的记录形状（S6 的回落）。 */
export interface PortRecord {
  readonly port: number
  /** 写文件的进程（纯数字旧形态下为 null）。 */
  readonly pid: number | null
  /** 该进程的启动时刻（ISO-8601 文本；纯数字旧形态下为 null）。 */
  readonly startedAt: string | null
}

/**
 * 候选端口序列：默认端口起，往后 `PORT_ATTEMPTS` 个（含默认端口共 21 个）。
 * 顺序即尝试顺序；全被占用时由调用方退到临时端口（`port: 0`）。
 */
export function portCandidates(preferred: number = DEFAULT_PORT): readonly number[] {
  const ports: number[] = []
  for (let offset = 0; offset <= PORT_ATTEMPTS; offset += 1) ports.push(preferred + offset)
  return ports
}

/** 端口号是否是可监听的用户端口（1–65535；0 留给「临时端口」）。 */
export function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65_535
}

/**
 * 写端口记录（0600）。先写临时文件再 `rename` 不必要：读者把坏内容当作「没有文件」，
 * 而 `openSync(path, 'w', 0o600)` 在已存在文件上不保证收紧权限——所以先删后建。
 */
export function writePortRecord(stateDir: string, record: PortRecord): string {
  const path = join(stateDir, PORT_FILE)
  try {
    unlinkSync(path)
  } catch {
    // 不存在就是我们要的结果。
  }
  const fd = openSync(path, 'w', 0o600)
  try {
    writeSync(fd, JSON.stringify(record), 'utf8')
  } finally {
    closeSync(fd)
  }
  return path
}

/**
 * 读端口记录。以下情形一律 `null`（读者于是回退默认端口或重新探测）：
 * 文件不存在、内容不是 JSON 也不是纯数字、端口越界、记录里的进程已经不在。
 */
export function readPortRecord(stateDir: string): PortRecord | null {
  const path = join(stateDir, PORT_FILE)
  let text: string
  try {
    text = readFileSync(path, 'utf8').trim()
  } catch {
    return null
  }
  if (text.length === 0) return null

  // 纯数字旧形态（§D.5 的字面写法）。
  if (/^\d+$/.test(text)) {
    const port = Number(text)
    return isValidPort(port) ? { port, pid: null, startedAt: null } : null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  const port = record['port']
  if (typeof port !== 'number' || !isValidPort(port)) return null
  const pid = typeof record['pid'] === 'number' ? record['pid'] : null
  const startedAt = typeof record['startedAt'] === 'string' ? record['startedAt'] : null
  // S6 的回落：写文件的进程不在了，这个文件就过期了。
  if (pid !== null && !processAlive(pid)) return null
  return { port, pid, startedAt }
}

/** 删端口记录；只有当前文件确实是 `owned` 这一份时才删（返回是否删了）。 */
export function removePortRecord(stateDir: string, owned: PortRecord): boolean {
  const current = readPortRecord(stateDir)
  if (current === null) return false
  if (current.port !== owned.port || current.pid !== owned.pid || current.startedAt !== owned.startedAt) {
    return false
  }
  try {
    unlinkSync(join(stateDir, PORT_FILE))
    return true
  } catch {
    return false
  }
}

/**
 * 进程是否还活着：`kill(pid, 0)` 只探测不改动。
 * ESRCH（没有这个进程）→ false；EPERM（存在但不属于我们）→ true，因为端口仍可能被它占着。
 */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'EPERM'
  }
}

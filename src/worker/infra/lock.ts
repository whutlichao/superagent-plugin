// 单实例锁（§N.1、§D.5）：`<stateDir>/lock` 用「独占创建 + pid + 每五秒触碰」表达。
//
// - 取锁：`open(path, 'wx')` 独占创建，写入 `{pid, startedAt}`，之后每 5 s 触碰一次
//   mtime（心跳）。同目录再取锁会 EEXIST——这就是「第二个实例被拒」的物理依据。
// - 活锁：mtime 在 30 s 内 → 本进程进入跟随模式（不启循环、不开 HTTP、只记日志）。
// - 陈旧锁：mtime 超过 30 s 未触碰 → 视作崩溃遗留，删除后重新取锁（回收）。
// - 释放：只删自己持有的锁（pid 对得上），不误删别人的。
import { closeSync, openSync, readFileSync, statSync, unlinkSync, utimesSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { SILENT_LOG, type LogSink } from './log-line.ts'

/** 锁文件名（§D.5 的 stateDir 布局）。 */
export const LOCK_FILE = 'lock'

/** 心跳间隔：每 5 s 触碰 mtime（§N.1）。 */
export const HEARTBEAT_MS = 5000

/** 陈旧阈值：超过 30 s 未触碰即视作崩溃遗留（§N.1）。 */
export const STALE_AFTER_MS = 30_000

/** 锁文件内容（§D.5：pid + startedAt）。 */
export interface LockContent {
  readonly pid: number
  readonly startedAt: string
}

/** 取锁的输入。 */
export interface LockOptions {
  /** 状态目录（`<stateDir>/lock`）。 */
  readonly stateDir: string
  /** 本进程 pid（测试注入）。 */
  readonly pid?: number
  /** 时钟（测试注入，避免 sleep）。 */
  readonly now?: () => Date
  /** 日志出口（跟随模式与陈旧回收都要留一行）。 */
  readonly log?: LogSink
  /** 心跳间隔（缺省 5 s；测试注入短间隔或手动驱动）。 */
  readonly heartbeatMs?: number
  /** 陈旧阈值（缺省 30 s；测试注入小值）。 */
  readonly staleAfterMs?: number
}

/** 一次取锁的结果：拿到锁就是 `leader`，被活实例占着就是 `follower`。 */
export type LockOutcome =
  | {
      readonly mode: 'leader'
      readonly lock: Lock
      /** 上一次的锁是陈旧遗留、被回收了吗。 */
      readonly reclaimed: boolean
    }
  | {
      readonly mode: 'follower'
      /** 当前持有者（读到什么算什么，pid 可能是崩溃前的）。 */
      readonly holder: LockContent | null
      /** 锁文件的新鲜度（ms），便于日志与 doctor。 */
      readonly ageMs: number
    }

/** 持有中的锁句柄。 */
export interface Lock {
  readonly path: string
  readonly content: LockContent
  /** 手动触碰一次 mtime（心跳 tick；`startHeartbeat` 会自动调它）。 */
  touch(): void
  /** 启动心跳（每 `heartbeatMs` 一次）；返回停止函数。重复调用返回同一个停止函数。 */
  startHeartbeat(): () => void
  /** 释放：删掉自己的锁文件并停心跳。返回是否真的删了。 */
  release(): boolean
}

/**
 * 尝试取锁。拿到 → `leader`（含回收陈旧锁的情形）；活实例占着 → `follower`。
 * 抛错只在状态目录不可写之类的情况下发生（由调用方转成 `state_dir_unwritable`）。
 */
export function acquireLock(options: LockOptions): LockOutcome {
  const path = join(options.stateDir, LOCK_FILE)
  const pid = options.pid ?? process.pid
  const now = options.now ?? (() => new Date())
  const log = options.log ?? SILENT_LOG
  const staleAfter = options.staleAfterMs ?? STALE_AFTER_MS
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS

  const create = (): LockContent | null => {
    const content: LockContent = { pid, startedAt: now().toISOString() }
    let fd: number
    try {
      fd = openSync(path, 'wx', 0o600)
    } catch (error) {
      if (isAlreadyExists(error)) return null
      throw error
    }
    try {
      writeSync(fd, JSON.stringify(content), 'utf8')
    } finally {
      closeSync(fd)
    }
    return content
  }

  let reclaimed = false
  let content = create()
  if (content === null) {
    const holder = readLock(path)
    const ageMs = lockAgeMs(path, now)
    if (ageMs !== null && ageMs <= staleAfter) {
      log({
        ts: now().toISOString(),
        level: 'warn',
        msg: 'another instance holds the state directory; following it',
        fields: { pid: holder?.pid ?? 0, ageMs }
      })
      return { mode: 'follower', holder, ageMs }
    }
    // 陈旧锁：崩溃遗留，回收后重新取锁。
    log({
      ts: now().toISOString(),
      level: 'warn',
      msg: 'reclaiming a stale lock',
      fields: { pid: holder?.pid ?? 0, ageMs: ageMs ?? -1 }
    })
    removeIfPresent(path)
    content = create()
    if (content === null) {
      // 极窄竞态：另一个进程刚好抢先。按活实例处理，不硬闯。
      const winner = readLock(path)
      return { mode: 'follower', holder: winner, ageMs: lockAgeMs(path, now) ?? 0 }
    }
    reclaimed = true
  }

  let timer: TimerHandle | null = null
  const stop = (): void => {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
  const start = (): (() => void) => {
    if (timer !== null) return stop
    timer = setInterval(() => {
      try {
        touch()
      } catch {
        // 触碰失败说明锁被别人收走了；下一次 release/doctor 会看到。
      }
    }, heartbeatMs)
    // 心跳不该拖住进程退出。
    timer.unref()
    return stop
  }
  const touch = (): void => {
    const at = now()
    utimesSync(path, at, at)
  }
  const lock: Lock = {
    path,
    content,
    touch,
    startHeartbeat: start,
    release(): boolean {
      stop()
      const current = readLock(path)
      if (current === null || current.pid !== pid) return false
      return removeIfPresent(path)
    }
  }
  return { mode: 'leader', lock, reclaimed }
}

/** 读锁文件内容；文件不存在或内容坏了都给 `null`。 */
export function readLock(path: string): LockContent | null {
  try {
    const text = readFileSync(path, 'utf8')
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    const pid = record['pid']
    const startedAt = record['startedAt']
    if (typeof pid !== 'number' || typeof startedAt !== 'string') return null
    return { pid, startedAt }
  } catch {
    return null
  }
}

/**
 * 锁文件的新鲜度（ms）：`now - mtime`；文件不存在则为 `null`。
 * 刚创建的锁在假时钟下可能是「未来」的（mtime 是真实墙上时间），因此负数按 0 处理：
 * 负年龄只表示「比现在更新」，不该被当成陈旧。
 */
export function lockAgeMs(path: string, now: () => Date = () => new Date()): number | null {
  try {
    return Math.max(0, now().getTime() - statSync(path).mtimeMs)
  } catch {
    return null
  }
}

/** 删文件，不存在就当成功。 */
function removeIfPresent(path: string): boolean {
  try {
    unlinkSync(path)
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

/** EEXIST：锁文件已经存在。 */
function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'EEXIST'
}

/** ENOENT：锁文件已经不在了。 */
function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
}

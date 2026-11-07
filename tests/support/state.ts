// 状态目录夹具：每个测试一个真实临时目录（§P.1「真库」），测试结束由调用方删除。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type Store } from '../../src/worker/app/store.ts'

/** 新建一个空的状态目录（`mkdtemp`，调用方负责删除）。 */
export function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'superagent-test-'))
}

/** 在临时状态目录上打开真库；`close()` 后可选删除目录。 */
export function openTempStore(
  options: { readonly keepDir?: boolean } = {}
): { readonly store: Store; readonly stateDir: string; readonly cleanup: () => void } {
  const stateDir = tempStateDir()
  const store = openStore({ stateDir })
  const cleanup = (): void => {
    try {
      store.close()
    } finally {
      if (options.keepDir !== true) rmSync(stateDir, { recursive: true, force: true })
    }
  }
  return { store, stateDir, cleanup }
}

/**
 * 删掉一个状态目录（或任意临时目录树）：**有界重试**，只把「本来就不在」当成功。
 *
 * 为什么不是一次 `rmSync`：`handle.shutdown()` 承诺不再有写者，但目录树很大时删除本身是
 * 多步操作；这里再给一次余量（重试只针对「目录非空/忙」这两个竞态码），并把其它错误原样
 * 抛出——吞错误会让一个真正的权限/挂载问题变成安静的假绿。
 *
 * `remove` 只是给测试的注入点（证明重试与「不吞」的行为），生产路径用的就是 `rmSync`。
 */
export async function removeTree(path: string, options: RemoveTreeOptions = {}): Promise<void> {
  const attempts = options.attempts ?? 10
  const delayMs = options.delayMs ?? 10
  const remove = options.remove ?? ((target: string) => rmSync(target, { recursive: true, force: true }))
  for (let attempt = 1; ; attempt += 1) {
    try {
      remove(path)
      return
    } catch (error) {
      const code = codeOf(error)
      // 已经删掉（或从来没建出来）：删除是幂等的。
      if (code === 'ENOENT') return
      // 只对「目录非空 / 忙」重试；别的错误（权限、挂载、只读盘）第一次就抛。
      if (code !== 'ENOTEMPTY' && code !== 'EBUSY') throw error
      if (attempt >= attempts) throw error
      if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
    }
  }
}

/** `removeTree` 的选项：重试次数、退避毫秒与测试用的删除注入点。 */
export interface RemoveTreeOptions {
  readonly attempts?: number
  readonly delayMs?: number
  readonly remove?: (path: string) => void
}

/** 一个错误的 Node 错误码（不是 Node 错误时给空串）。 */
function codeOf(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  return typeof code === 'string' ? code : ''
}

/** 固定的测试时刻（ISO-8601 文本，与线上同形）。 */
export const AT = '2026-11-07T03:26:00.000Z'

/** 相对某个 ISO 时刻偏移若干毫秒后的 ISO 文本。 */
export function isoAfter(base: string, milliseconds: number): string {
  return new Date(new Date(base).getTime() + milliseconds).toISOString()
}

/** 相对某个 ISO 时刻偏移若干天后的 ISO 文本。 */
export function isoDaysAfter(base: string, days: number): string {
  return isoAfter(base, days * 24 * 60 * 60 * 1000)
}

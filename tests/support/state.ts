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

// 立即备份（§G.2 的 `admin backup`、§N.6 的「升级前备份」、§D.5 的 `backups/`）。
//
// 与迁移前备份同一条 SQL（`VACUUM INTO`）、同一个命名规则、同一个保留份数（5 份）：
// 手工备份与自动备份放在一起，恢复时只需看一个目录。区别只有触发者——一个在
// `migration.ts` 里随迁移跑，一个由人（或 CLI）显式调用。
//
// 不新建 SQLite 连接：备份走 `store.sql.run('VACUUM INTO ?')`（参数绑定，路径里的引号
// 不参与 SQL 拼接），于是「插件只有一个写驱动」这条纪律不变。
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { pruneBackups } from './migration.ts'
import type { Store } from './store.ts'

/** 备份保留份数（§N.6：五份）。 */
export const KEEP_BACKUPS = 5

/** 一次手工备份的结果（`admin backup` 的 `result`）。 */
export interface ManualBackup {
  readonly path: string
  readonly at: string
  /** 备份文件大小（字节）。 */
  readonly bytes: number
  /** 清理后仍然保留的备份（从旧到新）。 */
  readonly kept: readonly string[]
}

/**
 * 一次手工备份将落到哪个文件（§G.2 的 `admin backup`、§D.5 的 `backups/`）：文件名只由库版本
 * 与这次备份的时刻决定，所以把 VACUUM 交给 effect 之后，命令仍能立刻告诉人它将要落到哪里。
 * 与迁移前备份同形（`superagent-<version>-<timestamp>`），`pruneBackups` 一并管理。
 */
export function backupPath(store: Store, at: string): string {
  const schema = store.schemaVersion()
  return join(store.backupDir, `superagent-${schema}-${at.replaceAll(':', '-')}.sqlite`)
}

/**
 * 立刻把当前库复制到 `<stateDir>/backups/superagent-<schema>-<ts>.sqlite`，并保留最近五份。
 * 文件名与迁移前备份同形（`superagent-<version>-<timestamp>`），`pruneBackups` 一并管理。
 *
 * 失败抛 `Error`（`VACUUM INTO` 的失败原因只留错误名）：调用方是 CLI 的 `admin backup`，
 * 它把失败报成 `internal`，不把 SQL 细节回给调用者（§N.5）。
 *
 * VACUUM 是**同步**的（§O「长活进 effect」）：HTTP handler 不直接调它，而是入队一行 `backup`
 * effect（`boot.ts` 的 handler）；本函数由那个 handler 与迁移路径调用。
 */
export function backupNow(store: Store, at: string): ManualBackup {
  const path = backupPath(store, at)
  // 参数绑定：路径不参与 SQL 拼接（§O 命令注入的同一条纪律，只是这里是 SQL 不是 shell）。
  store.sql.run('VACUUM INTO ?', [path])
  const kept = pruneBackups(store.backupDir, KEEP_BACKUPS)
  return { path, at, bytes: sizeOf(path), kept }
}

/** 文件大小；刚写完读不到就当 0（备份本身已经成功）。 */
function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

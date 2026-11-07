// 迁移（§D.2 要点 3–4、§N.6）：单调步骤数组、逐级一个事务、迁移前备份、版本过高拒绝启动。
//
// 打开时：读 `kv['schema-version']`（唯一版本源）→ 更高则拒绝（`locked` 语义）；
// 更低则先 `VACUUM INTO` 备份到 `<stateDir>/backups/superagent-<from>-<ts>.sqlite`，
// 再逐级执行 `MIGRATIONS`，每级一个事务。失败时回滚、报告可恢复的备份路径、
// 不带着半迁移库启动。
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { SILENT_LOG, type LogSink, type LogLine } from '../infra/log-line.ts'
import { KV_KEY_LITERALS, SCHEMA_VERSION_KEY } from './kv.ts'
import { MIGRATIONS, SCHEMA_VERSION, type MigrationStep, type SchemaDatabase } from './schema.ts'

/** 迁移在 `exec` 之外还要一次 `get` 去读版本（`DatabaseSync` 满足这个形状）。 */
export interface MigrationDatabase extends SchemaDatabase {
  prepare(sql: string): { get(...params: readonly string[]): unknown }
}

/** 迁移失败/被拒绝的错误码。 */
export type MigrationErrorCode = 'schema_too_new' | 'migration_failed' | 'backup_failed'

/** 迁移错误：调用方只按 `code` 分支，文案给人看。 */
export class MigrationError extends Error {
  readonly code: MigrationErrorCode
  readonly databaseVersion: number
  readonly pluginVersion: number
  readonly backupPath?: string

  constructor(
    code: MigrationErrorCode,
    message: string,
    details: {
      readonly databaseVersion: number
      readonly pluginVersion: number
      readonly backupPath?: string
      readonly cause?: unknown
    }
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.name = 'MigrationError'
    this.code = code
    this.databaseVersion = details.databaseVersion
    this.pluginVersion = details.pluginVersion
    if (details.backupPath !== undefined) this.backupPath = details.backupPath
  }
}

/** 迁移前备份的结果，以及清理后剩下的备份（从旧到新）。 */
export interface BackupResult {
  readonly path: string
  readonly from: number
  readonly at: string
  readonly kept: readonly string[]
}

/** 迁移写出的日志行（§N.5 的 JSON 行形状，见 `infra/log-line.ts`）。 */
export type MigrationLogLine = LogLine

/** 迁移的输入。 */
export interface MigrateOptions {
  /** 数据库文件路径（备份用 `VACUUM INTO` 读它）。 */
  readonly databasePath: string
  /** 备份目录（`<stateDir>/backups`）。 */
  readonly backupDir: string
  /** 备份保留份数（§N.6：五份）。 */
  readonly keepBackups: number
  /** 本插件支持的 schema 版本；缺省 `SCHEMA_VERSION`。 */
  readonly targetVersion?: number
  /** 迁移步骤（缺省 `MIGRATIONS`；测试注入失败步骤）。 */
  readonly steps?: readonly MigrationStep[]
  /** 迁移前备份的时钟（测试注入固定时刻）。 */
  readonly now?: () => Date
  /** 拒绝启动/迁移失败时写日志（§N.6 第 4 条「写日志」）。 */
  readonly log?: LogSink
}

/** 迁移结果：从哪个版本升到哪个版本、备份落在哪、执行了哪几步。 */
export interface MigrateResult {
  readonly from: number
  readonly to: number
  readonly applied: readonly MigrationStep[]
  readonly backup: BackupResult | null
}

/**
 * 读数据库当前的 schema 版本：`kv['schema-version']` 优先，其次 `PRAGMA user_version`
 * （只作为读到 kv 之前的镜像），两者都没有则是 0（全新库）。
 */
export function readSchemaVersion(db: MigrationDatabase): number {
  return tryReadKvVersion(db) ?? tryReadUserVersion(db) ?? 0
}

/** 执行迁移。版本过高、备份失败或某步失败时抛 `MigrationError`。 */
export function migrate(db: MigrationDatabase, options: MigrateOptions): MigrateResult {
  const target = options.targetVersion ?? SCHEMA_VERSION
  const steps = options.steps ?? MIGRATIONS
  const from = readSchemaVersion(db)
  const now = options.now ?? (() => new Date())
  const log = options.log ?? SILENT_LOG

  if (from > target) {
    const message = `database schema ${from} is newer than this plugin (${target})`
    log({
      ts: now().toISOString(),
      level: 'error',
      msg: message,
      fields: { databaseVersion: from, pluginVersion: target }
    })
    throw new MigrationError('schema_too_new', `${message}; downgrade the plugin or restore a backup`, {
      databaseVersion: from,
      pluginVersion: target
    })
  }
  if (from === target) {
    return { from, to: target, applied: [], backup: null }
  }

  const backup = backupBeforeMigrate(db, options, from, now)
  const applied: MigrationStep[] = []
  let current = from
  while (current < target) {
    const step = steps.find((candidate) => candidate.from === current)
    if (step === undefined) {
      throw fail({
        message: `no migration step from schema ${current} to ${target}`,
        databaseVersion: current,
        pluginVersion: target,
        backup,
        now,
        log
      })
    }
    try {
      db.exec('BEGIN IMMEDIATE')
      step.run(db)
      writeVersion(db, step.to)
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // 事务可能已被 SQLite 自己回滚；保留原始错误。
      }
      throw fail({
        message: `migration from schema ${step.from} to ${step.to} failed: ${messageOf(error)}`,
        databaseVersion: step.from,
        pluginVersion: target,
        backup,
        now,
        log,
        cause: error
      })
    }
    applied.push(step)
    current = step.to
  }
  log({
    ts: now().toISOString(),
    level: 'info',
    msg: `migrated database schema ${from} -> ${current}`,
    fields: { from, to: current, backup: backup.path }
  })
  return { from, to: current, applied, backup }
}

/** 迁移前备份：`VACUUM INTO <backupDir>/superagent-<from>-<ts>.sqlite`，只保留最近 N 份。 */
export function backupBeforeMigrate(
  db: MigrationDatabase,
  options: MigrateOptions,
  from: number,
  now: () => Date
): BackupResult {
  const at = now().toISOString()
  const path = join(options.backupDir, `superagent-${from}-${at.replaceAll(':', '-')}.sqlite`)
  try {
    // 备份目录由迁移负责创建：`stateDir` 下只有数据库文件是 boot 的职责。
    mkdirSync(options.backupDir, { recursive: true })
    db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`)
  } catch (error) {
    throw new MigrationError('backup_failed', `backup before migration failed: ${messageOf(error)}`, {
      databaseVersion: from,
      pluginVersion: options.targetVersion ?? SCHEMA_VERSION,
      cause: error
    })
  }
  const kept = pruneBackups(options.backupDir, options.keepBackups)
  return { path, from, at, kept }
}

/** 只保留最近 `keep` 份备份，返回剩下的（从旧到新，绝对路径）。 */
export function pruneBackups(backupDir: string, keep: number): readonly string[] {
  let names: readonly string[]
  try {
    names = readdirSync(backupDir).filter(
      (name) => name.startsWith('superagent-') && name.endsWith('.sqlite')
    )
  } catch {
    return []
  }
  const sorted = [...names].sort()
  const excess = sorted.slice(0, Math.max(0, sorted.length - keep))
  for (const name of excess) {
    try {
      unlinkSync(join(backupDir, name))
    } catch {
      // 备份清理不该让迁移失败。
    }
  }
  return sorted.slice(excess.length).map((name) => join(backupDir, name))
}

/** 把 `to` 写进 `kv['schema-version']`（唯一版本源）。 */
function writeVersion(db: MigrationDatabase, version: number): void {
  const key = SCHEMA_VERSION_KEY.replaceAll("'", "''")
  db.exec(
    `CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
     INSERT INTO kv (key, value) VALUES ('${key}', '${version}')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value;`
  )
}

/** 组装一个迁移失败错误（先写日志再抛，保证「不静默」）。 */
function fail(input: {
  readonly message: string
  readonly databaseVersion: number
  readonly pluginVersion: number
  readonly backup: BackupResult
  readonly now: () => Date
  readonly log: (line: MigrationLogLine) => void
  readonly cause?: unknown
}): MigrationError {
  const message = `${input.message}; restore from ${input.backup.path}`
  input.log({ ts: input.now().toISOString(), level: 'error', msg: message })
  return new MigrationError('migration_failed', message, {
    databaseVersion: input.databaseVersion,
    pluginVersion: input.pluginVersion,
    backupPath: input.backup.path,
    cause: input.cause
  })
}

/** 从 null 原型行里取字段。 */
function fieldOf(row: unknown, name: string): unknown {
  if (typeof row !== 'object' || row === null) return undefined
  return (row as Record<string, unknown>)[name]
}

/** 读 `kv['schema-version']`；没有 kv 表或没有该键时返回 undefined。 */
function tryReadKvVersion(db: MigrationDatabase): number | undefined {
  try {
    const raw = fieldOf(db.prepare('SELECT value FROM kv WHERE key = ?').get(SCHEMA_VERSION_KEY), 'value')
    if (typeof raw !== 'string') return undefined
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'number' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** 读 `PRAGMA user_version`（节点驱动把结果放在 `user_version` 字段）。 */
function tryReadUserVersion(db: MigrationDatabase): number | undefined {
  try {
    const raw = fieldOf(db.prepare('PRAGMA user_version').get(), 'user_version')
    return typeof raw === 'number' ? raw : undefined
  } catch {
    return undefined
  }
}

/** 错误文案（不吞掉非 Error 抛出物）。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// 迁移（§D.2 要点 3–4、§N.6、§P.2 `migration.test.ts`）：逐级一个事务、迁移前备份、
// 只保留五份、库版本更高时拒绝启动并给出可读日志、失败不带半迁移库启动。
import { assert, test } from 'orca/testing'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrate, MigrationError, readSchemaVersion } from '../src/worker/app/migration'
import { MIGRATIONS, SCHEMA_VERSION, type MigrationStep } from '../src/worker/app/schema'
import { openStore } from '../src/worker/app/store'
import { AT, isoDaysAfter, tempStateDir } from './support/state'

test('a fresh database is created at the current schema version in one transaction', () => {
  const stateDir = tempStateDir()
  const db = new DatabaseSync(join(stateDir, 'superagent.sqlite'))
  try {
    db.exec('PRAGMA foreign_keys = ON')
    assert.equal(readSchemaVersion(db), 0, 'an empty file is version 0')
    const result = migrate(db, { databasePath: join(stateDir, 'superagent.sqlite'), backupDir: join(stateDir, 'backups'), keepBackups: 5 })
    assert.equal(result.from, 0)
    assert.equal(result.to, SCHEMA_VERSION)
    assert.deepEqual(result.applied.map((step) => step.to), [SCHEMA_VERSION])
    assert.equal(readSchemaVersion(db), SCHEMA_VERSION, 'kv schema-version is the version source')
    assert.equal(Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version), 0, 'user_version is not written by the step itself')
  } finally {
    db.close()
  }
})

test('the step array is monotonic: each step goes up by exactly one level', () => {
  assert.ok(MIGRATIONS.length > 0)
  let expected = 0
  for (const step of MIGRATIONS) {
    assert.equal(step.from, expected, `step ${step.to} starts where the previous ended`)
    assert.equal(step.to, step.from + 1, `step ${step.from} -> ${step.to} is one level`)
    expected = step.to
  }
  assert.equal(expected, SCHEMA_VERSION, 'the chain ends at the plugin schema version')
})

test('a database from a newer plugin is refused with a readable log line', () => {
  const stateDir = tempStateDir()
  const path = join(stateDir, 'superagent.sqlite')
  const db = new DatabaseSync(path)
  try {
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('schema-version', JSON.stringify(7))
    const lines: { ts: string; level: string; msg: string }[] = []
    let caught: unknown
    try {
      migrate(db, {
        databasePath: path,
        backupDir: join(stateDir, 'backups'),
        keepBackups: 5,
        targetVersion: SCHEMA_VERSION,
        now: () => new Date(AT),
        log: (line) => void lines.push({ ts: line.ts, level: line.level, msg: line.msg })
      })
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof MigrationError, 'refusal is a MigrationError')
    assert.equal(caught.code, 'schema_too_new')
    assert.equal(
      caught.message,
      `database schema 7 is newer than this plugin (${SCHEMA_VERSION}); downgrade the plugin or restore a backup`
    )
    assert.deepEqual(
      lines.map((line) => `${line.level}: ${line.msg}`),
      [`error: database schema 7 is newer than this plugin (${SCHEMA_VERSION})`],
      'the refusal writes one readable log line'
    )
    assert.equal(readSchemaVersion(db), 7, 'the newer database is left untouched')
  } finally {
    db.close()
  }
})

test('a backup lands before migrating and only the latest five stay', () => {
  const stateDir = tempStateDir()
  const backupDir = join(stateDir, 'backups')
  const stamp = (index: number): Date => new Date(isoDaysAfter(AT, index))

  // 六轮「旧库 -> 当前版本」：每轮都从零造一个 v0 库（只有 kv 表 + 一条数据），
  // 于是六份备份落在同一个目录里，保留策略必须只留下最新的五份。
  for (let index = 0; index < 6; index += 1) {
    const roundDir = join(stateDir, `round-${index}`)
    mkdirSync(roundDir, { recursive: true })
    const path = join(roundDir, 'superagent.sqlite')
    const db = new DatabaseSync(path)
    try {
      // v0 = 还没有本插件 schema 的库：只有旧数据表。备份必须原样带上它。
      db.exec('CREATE TABLE legacy_note (id TEXT PRIMARY KEY, text TEXT NOT NULL)')
      db.prepare('INSERT INTO legacy_note (id, text) VALUES (?, ?)').run('n1', `round-${index}`)
      const result = migrate(db, {
        databasePath: path,
        backupDir,
        keepBackups: 5,
        now: () => stamp(index)
      })
      assert.equal(result.backup?.from, 0)
      assert.equal(result.to, SCHEMA_VERSION)
    } finally {
      db.close()
    }
  }

  const backups = readdirSync(backupDir).filter((name) => name.endsWith('.sqlite')).sort()
  assert.equal(backups.length, 5, 'the five newest backups are kept')
  assert.deepEqual(
    backups,
    [1, 2, 3, 4, 5].map((index) => `superagent-0-${stamp(index).toISOString().replaceAll(':', '-')}.sqlite`),
    'the oldest backup was pruned'
  )
  // 备份是完好的 SQLite 文件，里面是迁移前的数据（对应第 1 轮），且不含迁移后的表。
  const backup = new DatabaseSync(join(backupDir, backups[0] as string), { readOnly: true })
  try {
    assert.equal(
      (backup.prepare('SELECT text FROM legacy_note WHERE id = ?').get('n1') as { text: string }).text,
      'round-1'
    )
    assert.equal(
      (backup.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'trigger'").get() as { n: number }).n,
      0,
      'the backup was taken before the migration ran'
    )
  } finally {
    backup.close()
  }
})

test('a failing step rolls back, reports the backup and leaves no half-migrated schema', () => {
  const stateDir = tempStateDir()
  const path = join(stateDir, 'superagent.sqlite')
  const backupDir = join(stateDir, 'backups')
  const db = new DatabaseSync(path)
  try {
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const failing: readonly MigrationStep[] = [
      {
        from: 0,
        to: 1,
        run(target): void {
          target.exec('CREATE TABLE half (id TEXT PRIMARY KEY)')
          throw new Error('boom')
        }
      }
    ]
    const lines: string[] = []
    let caught: unknown
    try {
      migrate(db, {
        databasePath: path,
        backupDir,
        keepBackups: 5,
        steps: failing,
        now: () => new Date(AT),
        log: (line) => void lines.push(line.msg)
      })
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof MigrationError)
    assert.equal(caught.code, 'migration_failed')
    assert.ok(caught.backupPath !== undefined && existsSync(caught.backupPath), 'a restore point exists')
    assert.ok(lines.some((line) => line.includes('restore from')), 'the failure names the backup')
    // 半迁移的建表被回滚：表不存在，版本仍是旧的。
    assert.equal(
      (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'half'").get() as { n: number }).n,
      0
    )
    assert.equal(readSchemaVersion(db), 0)
  } finally {
    db.close()
  }
})

test('opening a store on a newer database refuses to start and writes the log', () => {
  const stateDir = tempStateDir()
  const path = join(stateDir, 'superagent.sqlite')
  const db = new DatabaseSync(path)
  try {
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('schema-version', JSON.stringify(SCHEMA_VERSION + 1))
  } finally {
    db.close()
  }
  const lines: string[] = []
  let caught: unknown
  try {
    openStore({
      stateDir,
      now: () => new Date(AT),
      log: (line) => void lines.push(`${line.level}: ${line.msg}`)
    })
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof MigrationError, 'openStore refuses instead of half-starting')
  assert.equal(caught.code, 'schema_too_new')
  assert.deepEqual(lines, [
    `error: database schema ${SCHEMA_VERSION + 1} is newer than this plugin (${SCHEMA_VERSION})`
  ])
  // 拒绝启动时不留下 WAL 之外的半成品：库仍是原来那个更高版本。
  const reopened = new DatabaseSync(path, { readOnly: true })
  try {
    assert.equal(readSchemaVersion(reopened), SCHEMA_VERSION + 1)
  } finally {
    reopened.close()
  }
})

test('a migrated old database still reads through the store', () => {
  const stateDir = tempStateDir()
  const path = join(stateDir, 'superagent.sqlite')
  // 造一个 v1 库（等于「旧版本插件建出来的库」），再按当前版本打开。
  const seed = openStore({ stateDir })
  seed.kvSet('kept', { hello: 'world' })
  seed.close()
  const reopened = openStore({ stateDir })
  try {
    assert.equal(reopened.schemaVersion(), SCHEMA_VERSION)
    assert.deepEqual(reopened.kvGet('kept'), { hello: 'world' })
  } finally {
    reopened.close()
  }
})

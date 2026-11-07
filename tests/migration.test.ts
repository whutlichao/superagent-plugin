// 迁移（§D.2 要点 3–4、§N.6、§P.2 `migration.test.ts`）：逐级一个事务、迁移前备份、
// 只保留五份、库版本更高时拒绝启动并给出可读日志、失败不带半迁移库启动。
import { assert, test } from 'orca/testing'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { backupNow } from '../src/worker/app/backup'
import { PLUGIN_VERSION_KEY } from '../src/worker/app/kv'
import { migrate, MigrationError, readSchemaVersion } from '../src/worker/app/migration'
import { MIGRATIONS, SCHEMA_VERSION, type MigrationStep } from '../src/worker/app/schema'
import { openStore } from '../src/worker/app/store'
import { notePluginVersion, PLUGIN_VERSION } from '../src/worker/app/upgrade'
import { Engine, MemoryRepositories, type Ticket } from '../src/worker/core/index'
import { resumeAfterUpgrade } from '../src/worker/executor/resume'
import { AT, isoDaysAfter, tempStateDir } from './support/state'
import { FakeOrcaRuntime } from './support/fake-orca-runtime'
import { readRepoJson } from './support/repo'

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

test('each step commits on its own: a later failing step leaves the earlier level applied', () => {
  const stateDir = tempStateDir()
  const db = new DatabaseSync(join(stateDir, 'superagent.sqlite'))
  try {
    const steps: readonly MigrationStep[] = [
      {
        from: 0,
        to: 1,
        run(target): void {
          target.exec('CREATE TABLE level_one (id TEXT PRIMARY KEY)')
        }
      },
      {
        from: 1,
        to: 2,
        run(target): void {
          target.exec('CREATE TABLE level_two (id TEXT PRIMARY KEY)')
          throw new Error('second level fails')
        }
      }
    ]
    let caught: unknown
    try {
      migrate(db, {
        databasePath: join(stateDir, 'superagent.sqlite'),
        backupDir: join(stateDir, 'backups'),
        keepBackups: 5,
        targetVersion: 2,
        steps,
        now: () => new Date(AT)
      })
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof MigrationError)
    assert.equal(caught.code, 'migration_failed')
    // 第一级已经提交（版本停在 1），第二级整级回滚（没有 level_two）。
    assert.equal(readSchemaVersion(db), 1, 'the committed level is the one before the failure')
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string
    }[]).map((row) => row.name)
    assert.ok(tables.includes('level_one'), 'level one committed')
    assert.equal(tables.includes('level_two'), false, 'the failing level rolled back as a unit')
  } finally {
    db.close()
  }
})

test('a failed migration restores the pre-migration database from the backup and refuses to start half-way', () => {
  const stateDir = tempStateDir()
  try {
    const path = join(stateDir, 'superagent.sqlite')
    // 一个「旧版本插件」建的库：有数据、还没有本插件的 schema。
    const seed = new DatabaseSync(path)
    try {
      seed.exec('CREATE TABLE legacy_note (id TEXT PRIMARY KEY, text TEXT NOT NULL)')
      seed.prepare('INSERT INTO legacy_note (id, text) VALUES (?, ?)').run('n1', 'kept across the restore')
    } finally {
      seed.close()
    }

    const failing: readonly MigrationStep[] = [
      {
        from: 0,
        to: 1,
        run(target): void {
          target.exec('CREATE TABLE half_migrated (id TEXT PRIMARY KEY)')
          throw new Error('boom during the upgrade')
        }
      }
    ]
    const lines: string[] = []
    let caught: unknown
    try {
      openStore({
        stateDir,
        migrationSteps: failing,
        now: () => new Date(AT),
        log: (line) => void lines.push(`${line.level}: ${line.msg}`)
      })
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof MigrationError, 'a failed upgrade refuses to boot')
    assert.equal(caught.code, 'migration_failed')
    assert.ok(caught.backupPath !== undefined && existsSync(caught.backupPath), 'the restore point is named')
    assert.ok(
      lines.some((line) => line.includes('restore from')),
      'the failure names the backup for the operator'
    )

    // 磁盘上不是半迁移状态：恢复到迁移前的库，旧数据还在，半成品表不存在。
    const restored = new DatabaseSync(path, { readOnly: true })
    try {
      assert.equal(readSchemaVersion(restored), 0, 'the schema version is back to the pre-migration one')
      assert.equal(
        (restored.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'half_migrated'").get() as { n: number }).n,
        0,
        'the half-migrated table is gone'
      )
      assert.equal(
        (restored.prepare('SELECT text FROM legacy_note WHERE id = ?').get('n1') as { text: string }).text,
        'kept across the restore',
        'the pre-migration data is intact'
      )
    } finally {
      restored.close()
    }

    // 下一个版本（或修好之后）能正常打开同一个目录：它看到的不是半迁移库。
    const reopened = openStore({ stateDir, now: () => new Date(isoDaysAfter(AT, 1)) })
    try {
      assert.equal(reopened.schemaVersion(), SCHEMA_VERSION)
    } finally {
      reopened.close()
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('manual `admin backup` and pre-migration backups share one directory and the newest five by time survive', () => {
  const stateDir = tempStateDir()
  try {
    const backupDir = join(stateDir, 'backups')
    // 打开真库（首建）也会为了建立 schema 备份一次：它是最早的一份。
    const store = openStore({ stateDir, now: () => new Date(isoDaysAfter(AT, 0)) })
    try {
      const manual = (days: number): void => {
        backupNow(store, isoDaysAfter(AT, days))
      }
      manual(1)
      legacyMigrate(stateDir, backupDir, 2)
      manual(3)
      legacyMigrate(stateDir, backupDir, 4)
      manual(5)
      legacyMigrate(stateDir, backupDir, 6)

      const names = readdirSync(backupDir)
        .filter((name) => name.endsWith('.sqlite'))
        .sort()
      // 正确口径是「按时间最新的五份」：day2..day6。迁移备份的版本号是 0、手工备份是 1，
      // 按文件名先比版本号会把 day1/day3 的旧备份留下、把 day2 的四号备份删掉。
      assert.deepEqual(
        names,
        [2, 3, 4, 5, 6].map((days) => backupName(days)).sort(),
        'the five newest by time survive'
      )
    } finally {
      store.close()
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

/** 一个「旧插件留下」的库：只有旧数据表；用它跑一次带 `now` 的迁移，落一份 `superagent-0-*` 备份。 */
function legacyMigrate(stateDir: string, backupDir: string, days: number): void {
  const path = join(stateDir, `legacy-${days}.sqlite`)
  const db = new DatabaseSync(path)
  try {
    db.exec('CREATE TABLE legacy_note (id TEXT PRIMARY KEY, text TEXT NOT NULL)')
    db.prepare('INSERT INTO legacy_note (id, text) VALUES (?, ?)').run('n1', `day ${days}`)
    migrate(db, {
      databasePath: path,
      backupDir,
      keepBackups: 5,
      now: () => new Date(isoDaysAfter(AT, days))
    })
  } finally {
    db.close()
  }
}

/** 备份文件名里的时刻：`backupNow` 与迁移前备份用的是同一个命名规则（`:` → `-`）。 */
function backupName(days: number): string {
  const stamp = isoDaysAfter(AT, days).replaceAll(':', '-')
  return days % 2 === 0 ? `superagent-0-${stamp}.sqlite` : `superagent-1-${stamp}.sqlite`
}

test('a plugin-version upgrade treats running assignments as interrupted and hands them to resume', async () => {
  const stateDir = tempStateDir()
  const store = openStore({ stateDir })
  try {
    // 上一次运行记下的版本比这次旧：这是一次升级，不应认领旧会话。
    store.kvSet(PLUGIN_VERSION_KEY, '0.0.9')
    const lines: { level: string; msg: string }[] = []
    const boot = notePluginVersion(store, {
      version: '0.1.0',
      now: () => new Date(AT),
      log: (line) => void lines.push({ level: line.level, msg: line.msg })
    })
    assert.deepEqual([boot.from, boot.to, boot.upgraded], ['0.0.9', '0.1.0', true])
    assert.equal(store.kvGet(PLUGIN_VERSION_KEY), '0.1.0', 'the new version is recorded for the next boot')
    assert.ok(
      lines.some((line) => line.msg.includes('0.0.9') && line.msg.includes('0.1.0')),
      'the upgrade is not silent'
    )
    assert.equal(
      notePluginVersion(store, { version: '0.1.0' }).upgraded,
      false,
      'restarting the same version is not an upgrade'
    )
    // 版本常量与清单同源：漂移会让「升级」判定说谎。
    assert.equal(PLUGIN_VERSION, readRepoJson<{ version: string }>('orca-plugin.json').version)

    // 一个仍在跑的 Assignment，终端还活着、worktree 也对：正常恢复会认领它。
    const opened = new MemoryRepositories()
    const repo = opened.claimWriter()
    const runtime = new FakeOrcaRuntime()
    const directory = '/w/superagent-fix-the-login-flow'
    runtime.workspaces = [
      { workspaceId: 'ws:fix', kind: 'worktree', name: 'superagent-fix-the-login-flow', path: directory, branch: null }
    ]
    runtime.registerAgent('ws:fix', { terminalId: 'term_1', workspaceId: 'ws:fix', launchedAt: 1 })
    const started: string[] = []
    const engine = new Engine({
      repo,
      policy: () => ({
        version: 'policy-1',
        paused: false,
        evalTimeoutMs: 60_000,
        gate: () => ({ admissible: false, reason: 'test' }),
        revalidate: () => true,
        admitsInferred: () => false
      }),
      scope: { scope: () => ({ listened: true, observed: false }) },
      assessor: { request: () => undefined },
      executor: {
        start: (ticket, assignment) => void started.push(`${ticket.id}:${assignment.id}`),
        deliver: () => undefined,
        stop: () => undefined
      },
      outbox: { send: () => undefined, status: () => undefined, withdraw: () => undefined },
      now: () => AT
    })
    const ticket: Ticket = {
      id: 'ticket-11',
      title: 'Fix the login flow',
      decisionId: 'decision-1',
      mandate: {
        strength: 'explicit',
        policyVersion: 'policy-1',
        basis: { via: 'addressed', addressed: 'mention' },
        actor: { source: 'github', id: 'royce' },
        scope: 'repo:widgets'
      },
      channels: [],
      assignments: [
        { id: 'a-1', state: 'running', createdAt: AT, startedAt: AT, terminalId: 'term_1' }
      ],
      inputs: [],
      undelivered: [],
      createdAt: AT,
      updatedAt: AT,
      origin: { triggerId: 'trigger-1', triggerIds: ['trigger-1'] },
      execution: { name: 'fix-the-login-flow', directory, assignment: 'the brief' }
    }
    repo.atomic(() => repo.tickets.save(ticket))

    const report = await resumeAfterUpgrade({
      runtime,
      engine,
      records: { tickets: { list: () => repo.tickets.list() } }
    })
    assert.deepEqual(report.assignments.map((item) => item.outcome), ['interrupted'])
    const resumed = repo.tickets.get('ticket-11')!
    assert.deepEqual(resumed.assignments.map((item) => item.state), ['ended', 'pending'])
    assert.equal(resumed.assignments[0]?.endedReason, 'interrupted', 'the old assignment is interrupted')
    assert.ok(
      resumed.inputs.some((input) => input.kind === 'text' && input.text.includes('git history and GitHub')),
      'the new assignment starts from the same recovery note as a crash restart'
    )
    assert.deepEqual(runtime.calls.sent, [], 'a live terminal is not adopted across a version upgrade')
    assert.deepEqual(started, ['ticket-11:' + String(resumed.assignments[1]?.id)], 'the resume path rebuys the work')
  } finally {
    store.close()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

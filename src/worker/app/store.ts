// 存储内核：`<stateDir>/superagent.sqlite` 的唯一打开处（§D.2、§D.5）。
//
// 只有本模块 import `node:sqlite`。所有时间字段一律 ISO-8601 文本（`Date#toISOString()`），
// 于是文本比较就是时间比较；Thread 时间线用 `(at, id)` 复合游标。
//
// 仓储按 §D.4 的写者表分组：本票只提供「写者会用到的持久化操作」，不判断业务规则；
// 谁能调哪一组由写者表与后续票的引擎决定。Source 的读位置与 Thread meta 走
// `state` / `threads` 两个端口（§D.4 第二行），不直接写表。
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { LogLine, LogSink } from '../infra/log-line.ts'
import { SILENT_LOG } from '../infra/log-line.ts'
import { migrate, MigrationError, readSchemaVersion, restoreFromBackup } from './migration.ts'
import { SCHEMA_VERSION, type MigrationStep } from './schema.ts'
import {
  readAssignmentCounts,
  readTimeline,
  readWorkingSet,
  workingSetPlan,
  type AssignmentCounts,
  type TimelineOptions,
  type WorkingSetName
} from './store-read.ts'
import type {
  DecisionRecord,
  DispositionRecord,
  EffectKindCount,
  EffectRecord,
  OutboxRecord,
  OutboxWaitingRow,
  PromptVersionRecord,
  SettingsVersionRecord,
  ThreadMeta,
  ThreadRecord,
  ThreadRow,
  TicketRecord,
  TicketRow,
  TimelinePage,
  TriggerRecord,
  TriggerThreadRecord,
  WorkingSet
} from './records.ts'

/** 数据库文件名（§D.2：只有一个库）。 */
export const DATABASE_FILE = 'superagent.sqlite'

/** 打开数据库后立即生效的四条 PRAGMA（§D.2 逐条）。 */
export const PRAGMAS = {
  journalMode: 'wal',
  synchronous: 'normal',
  foreignKeys: 'on',
  busyTimeout: 5000
} as const

/** 数据库实际生效的 pragma 读数（`synchronous` / `foreign_keys` 是整数）。 */
export interface PragmaState {
  readonly journalMode: string
  readonly synchronous: number
  readonly foreignKeys: number
  readonly busyTimeout: number
}

/** 打开一个状态目录所需的全部输入。 */
export interface StoreOptions {
  /** 状态目录的绝对路径（§D.5）；不存在时创建。 */
  readonly stateDir: string
  /** 备份目录（§D.5 / §N.6）；缺省 `<stateDir>/backups`。 */
  readonly backupDir?: string
  /** 备份保留份数（§N.6：五份）。 */
  readonly keepBackups?: number
  /** 迁移前备份的时钟（测试注入固定时刻）。 */
  readonly now?: () => Date
  /**
   * 迁移步骤（缺省 `MIGRATIONS`）。只为「迁移失败演练」注入失败步骤（§P.2 的 R12）；
   * 生产路径永远用内置的那一条链。
   */
  readonly migrationSteps?: readonly MigrationStep[]
  /** 迁移/拒绝启动的日志出口（§N.6：拒绝启动时要留下可读日志）。 */
  readonly log?: LogSink
}

/** 存储层写出的日志行（§N.5 的 JSON 行形状）。 */
export type StoreLogLine = LogLine

/** Trigger 仓储（§D.4 写者：`core/engine.ts`）。 */
export interface TriggerRepository {
  insert(record: TriggerRecord): void
  get(id: string): TriggerRecord | null
  /** 按时间升序（文本比较即时间比较）。 */
  byTime(options?: { readonly limit?: number }): readonly TriggerRecord[]
}

/** Disposition 仓储（§D.4 写者：`core/engine.ts`）。 */
export interface DispositionRepository {
  put(record: DispositionRecord): void
  get(triggerId: string): DispositionRecord | null
}

/** Trigger–Thread 关联仓储（§D.4 写者：`core/engine.ts`）。 */
export interface TriggerThreadRepository {
  link(record: TriggerThreadRecord): void
  unlink(threadKey: string, at: string, triggerId: string): boolean
  /** Thread 时间线：`(at, id)` 复合游标分页（§D.2 要点 1）。 */
  timeline(threadKey: string, options?: TimelineOptions): TimelinePage
}

/** Thread 仓储。§D.4：body 由引擎写；meta 只由该 Source 经端口写。 */
export interface ThreadRepository {
  /** 整行写入（引擎用：body 是它的写者）。 */
  put(record: ThreadRecord): void
  get(key: string): ThreadRow | null
  /** Source 端口：只改 meta（§D.4「Source 读位置与 Thread meta」）。 */
  describe(key: string, meta: ThreadMeta): void
  /** 该 Thread 的 meta（Source 端口读回）。 */
  meta(key: string): ThreadMeta | null
  /** 生成列读数（`active` / `subscribed`），用于断言非活跃行不进工作集。 */
  flags(key: string): { readonly active: boolean; readonly subscribed: boolean } | null
}

/** Ticket 仓储（§D.4 写者：`core/engine.ts`）。 */
export interface TicketRepository {
  put(record: TicketRecord): void
  get(id: string): TicketRow | null
}

/** Decision 仓储（§D.4 写者：`core/engine.ts`）。 */
export interface DecisionRepository {
  put(record: DecisionRecord): void
  get(id: string): DecisionRecord | null
  byThread(threadKey: string): readonly DecisionRecord[]
}

/**
 * Effect 仓储（§D.4 写者：`app/effects.ts`）。队列还需要三件落库动作，`effect` 表的
 * 写者仍是 `app/effects.ts`（本仓储只是它的 SQL 出口，不做业务判断）：
 * `dueOfKind` 取一个 kind 的到期行，`bySeqOfKind` 取一个 kind 的最老一行（串行 kind 的
 * 队头即使未到期也挡着后面，§J.2），`remove`/`reschedule` 是「跑完了」与「再等等」。
 */
export interface EffectRepository {
  put(record: EffectRecord): void
  get(kind: string, key: string): EffectRecord | null
  due(at: string): readonly EffectRecord[]
  /** 一个 kind 的到期行，按 `seq` 升序（§J.2「按 seq 升序取 due 行」）。 */
  dueOfKind(kind: string, at: string, limit?: number): readonly EffectRecord[]
  /** 一个 kind 的最老一行（含未到期）：串行 kind 用它判「队头还挡着」。 */
  oldestOfKind(kind: string): EffectRecord | null
  /** 当前最大 `seq`：新的队列实例从它继续，重启不重排（§J.2）。 */
  maxSeq(): number
  /** 队列里所有 kind 的计数与最大尝试数：健康条目的 detail 用它（§J.3）。 */
  kindCounts(): readonly EffectKindCount[]
  /** 删掉一行（跑成功）。`seq` 与 `attempts` 一起匹配，防止删掉运行期间被替换的新行。 */
  remove(kind: string, key: string, seq: number, attempts: number): boolean
  /** 改一行的到期时刻与尝试数（失败退避 / `Later` / 再入队）。 */
  reschedule(record: EffectRecord): void
}

/** Outbox 仓储（§D.4 写者：`app/outbox.ts`，唯一写者）。 */
export interface OutboxRepository {
  put(record: OutboxRecord): void
  get(id: string): OutboxRecord | null
  /**
   * 一个分组（`ticket:<id>|<channel>` 或 channel 地址）里仍待发的行，按 `reply` effect 的
   * `seq` 升序：**顺序**只看这一组（§J.1：不同 Ticket、无 Ticket 的消息互不等待）。
   */
  waiting(channel: string): readonly OutboxWaitingRow[]
  /** 一张 Ticket 仍待发的消息（撤回用，§J.1）。 */
  pendingOfTicket(ticketId: string): readonly OutboxRecord[]
  /** `at` 之后被 drop 的行，最新在前（面板 Source 页的 24 h 窗口，§J.1）。 */
  droppedSince(at: string): readonly OutboxRecord[]
  /** 连续失败达到 `minAttempts` 的待发行，最老在前（§J.3 system problems）。 */
  failing(minAttempts: number): readonly OutboxWaitingRow[]
  /** 不可达而 drop 的条数（撤回不算；health 只计数、不算错误，§J.3）。 */
  countDropped(): number
}

/** 设置版本仓储（§D.4 写者：`app/settings.ts`）。 */
export interface SettingsVersionRepository {
  put(record: SettingsVersionRecord): void
  byRevision(revision: number): SettingsVersionRecord | null
  latest(): SettingsVersionRecord | null
}

/** Prompt 版本仓储（§D.4 写者：`app/prompts.ts`）。 */
export interface PromptVersionRepository {
  put(record: PromptVersionRecord): void
  byRevision(revision: number): PromptVersionRecord | null
  latest(): PromptVersionRecord | null
}

/** 仓库句柄：打开/关闭、事务、KV、工作集与各表仓储。 */
export interface Store {
  /** `<stateDir>/superagent.sqlite` 的绝对路径。 */
  readonly path: string
  /** 迁移前备份的落点（doctor 读取）。 */
  readonly backupDir: string
  /** 当前库的 schema 版本（`kv['schema-version']` 是唯一版本源，§D.2 要点 3）。 */
  schemaVersion(): number
  /** 四条 PRAGMA 的实际读数（doctor 与测试用）。 */
  pragmas(): PragmaState
  /** 用户表名，按字母序（§D.2 的表族清单）。 */
  tables(): readonly string[]
  /**
   * 只读自检视图（`doctor` 用）：版本、表数、文件大小。**不迁移、不写库**——doctor 在
   * 「库比插件新」时也要能读，否则它会因为一次检查而把库升级或拒绝打开。
   */
  inspect(): DatabaseInspection
  /** 读一个 KV 值（JSON 反序列化）；缺失时为 `null`。 */
  kvGet<T>(key: string): T | null
  /** 写一个 KV 值（JSON 序列化）。 */
  kvSet(key: string, value: unknown): void
  /** 删一个 KV 键；返回是否真的删了一行。 */
  kvDelete(key: string): boolean
  /** 当前 KV 键（按字母序）。 */
  kvKeys(): readonly string[]
  /** 一个写事务；抛错即整体回滚。嵌套调用复用外层事务（savepoint）。 */
  transaction<T>(work: () => T): T
  /**
   * 提交后才执行（§J.2 执行行）：在事务里排队、最外层事务提交后才跑；事务回滚则丢弃。
   * 不在事务里调用就立即执行。回调抛错不影响已提交的事务（记一行日志）。
   */
  afterCommit(action: () => void): void
  /** 工作集：pass 只扫这四组活行。 */
  workingSet(): WorkingSet
  /**
   * Executor 负载的计数（§E.6）：未结束 Ticket 里最新 Assignment 是 running 与 pending
   * 的数量。`GET state` 的 `load` 用它，口径与领域侧 `latestAssignment()` 一致。
   */
  assignmentCounts(): AssignmentCounts
  /** 工作集查询的 `EXPLAIN QUERY PLAN` detail 行（断言只走部分索引）。 */
  workingSetPlan(): Readonly<Record<WorkingSetName, readonly string[]>>
  /**
   * 受控 SQL 出口：只给 `app/` 的维护类模块（保留策略这种「跨表按时间删」）用。
   * 业务写者仍走上面的仓储（§D.4 写者表）；这里不做业务判断。
   */
  readonly sql: {
    all(sql: string, params?: readonly SQLInputValue[]): readonly unknown[]
    run(sql: string, params?: readonly SQLInputValue[]): number
  }
  readonly triggers: TriggerRepository
  readonly dispositions: DispositionRepository
  readonly triggerThreads: TriggerThreadRepository
  readonly threads: ThreadRepository
  readonly tickets: TicketRepository
  readonly decisions: DecisionRepository
  readonly effects: EffectRepository
  readonly outbox: OutboxRepository
  readonly settingsVersions: SettingsVersionRepository
  readonly promptVersions: PromptVersionRepository
  close(): void
}

/** 打开真库：设四条 PRAGMA、跑迁移、建好各表仓储。`stateDir` 必须已存在。 */
export function openStore(options: StoreOptions): Store {
  const path = join(options.stateDir, DATABASE_FILE)
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA journal_mode = ${PRAGMAS.journalMode}`)
  db.exec(`PRAGMA synchronous = ${PRAGMAS.synchronous}`)
  db.exec(`PRAGMA foreign_keys = ${PRAGMAS.foreignKeys}`)
  db.exec(`PRAGMA busy_timeout = ${PRAGMAS.busyTimeout}`)

  const backupDir = options.backupDir ?? join(options.stateDir, 'backups')
  if (readSchemaVersion(db) !== SCHEMA_VERSION) {
    try {
      migrate(db, {
        databasePath: path,
        backupDir,
        keepBackups: options.keepBackups ?? 5,
        targetVersion: SCHEMA_VERSION,
        ...(options.migrationSteps === undefined ? {} : { steps: options.migrationSteps }),
        now: options.now ?? (() => new Date()),
        log: options.log
      })
    } catch (error) {
      // §N.6 第 2 条：失败就从备份恢复，**不带着半迁移库启动**。
      // 恢复要先把句柄关掉再整文件复制（`-wal`/`-shm` 一并清掉），然后照原样把失败报给调用方。
      if (
        error instanceof MigrationError &&
        error.code === 'migration_failed' &&
        error.backupPath !== undefined
      ) {
        db.close()
        try {
          restoreFromBackup({
            databasePath: path,
            backupPath: error.backupPath,
            now: options.now ?? (() => new Date()),
            log: options.log ?? SILENT_LOG
          })
        } catch (restoreError) {
          const reason = restoreError instanceof Error ? restoreError.message : String(restoreError)
          throw new MigrationError('migration_failed', `${error.message}; restoring from ${error.backupPath} failed: ${reason}`, {
            databaseVersion: error.databaseVersion,
            pluginVersion: error.pluginVersion,
            backupPath: error.backupPath,
            cause: restoreError
          })
        }
      }
      throw error
    }
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)

  let depth = 0
  /** 每层事务的「提交后回调」；最外层提交时才真正执行（§J.2 执行行、§D.4）。 */
  const committed: (() => void)[][] = []
  const log = options.log ?? SILENT_LOG
  const sql = createSqlAccess(db)

  const store: Store = {
    path,
    backupDir,
    schemaVersion(): number {
      return readSchemaVersion(db)
    },
    pragmas(): PragmaState {
      return readPragmas(sql)
    },
    tables(): readonly string[] {
      return sql
        .all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .map((row) => String(field(row, 'name')))
    },
    inspect(): DatabaseInspection {
      return inspectOpenDatabase(db, path)
    },
    kvGet<T>(key: string): T | null {
      const row = sql.one('SELECT value FROM kv WHERE key = ?', [key])
      if (row === undefined) return null
      return JSON.parse(String(field(row, 'value'))) as T
    },
    kvSet(key: string, value: unknown): void {
      sql.run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
        key,
        JSON.stringify(value)
      ])
    },
    kvDelete(key: string): boolean {
      return sql.run('DELETE FROM kv WHERE key = ?', [key]) > 0
    },
    kvKeys(): readonly string[] {
      return sql.all('SELECT key FROM kv ORDER BY key').map((row) => String(field(row, 'key')))
    },
    transaction<T>(work: () => T): T {
      const level = depth
      depth += 1
      committed[level] = []
      db.exec(level === 0 ? 'BEGIN IMMEDIATE' : 'SAVEPOINT nested')
      let result: T
      try {
        result = work()
        db.exec(level === 0 ? 'COMMIT' : 'RELEASE nested')
      } catch (error) {
        db.exec(level === 0 ? 'ROLLBACK' : 'ROLLBACK TO nested')
        if (level > 0) db.exec('RELEASE nested')
        // 回滚掉的层级，提交后回调一并丢弃：没写成的行不该有后续动作。
        committed[level] = []
        depth -= 1
        throw error
      }
      const actions = committed[level]
      committed[level] = []
      depth -= 1
      if (level > 0) {
        // 内层只是保存点：回调交给外层，最外层提交后才真正执行。
        committed[level - 1].push(...actions)
      } else {
        for (const action of actions) {
          try {
            action()
          } catch (error) {
            // 已提交的事务不能被回调的失败推翻；留一行日志（§N.5 不静默）。
            log({
              ts: new Date().toISOString(),
              level: 'error',
              msg: 'an afterCommit callback failed',
              fields: { error: error instanceof Error ? error.message : String(error) }
            })
          }
        }
      }
      return result
    },
    afterCommit(action: () => void): void {
      // 不在事务里：立即执行（调用方已经提交过了）。
      if (depth === 0) {
        action()
        return
      }
      committed[depth - 1].push(action)
    },
    workingSet(): WorkingSet {
      return readWorkingSet(sql.reader)
    },
    assignmentCounts(): AssignmentCounts {
      return readAssignmentCounts(sql.reader)
    },
    workingSetPlan() {
      return workingSetPlan(sql.reader)
    },
    sql: { all: sql.all, run: sql.run },
    triggers: createTriggerRepository(sql),
    dispositions: createDispositionRepository(sql),
    triggerThreads: createTriggerThreadRepository(sql),
    threads: createThreadRepository(sql),
    tickets: createTicketRepository(sql),
    decisions: createDecisionRepository(sql),
    effects: createEffectRepository(sql),
    outbox: createOutboxRepository(sql),
    settingsVersions: createSettingsVersionRepository(sql),
    promptVersions: createPromptVersionRepository(sql),
    close(): void {
      db.close()
    }
  }
  return store
}

/** 一层薄薄的 SQL 访问器：参数绑定、查询计划、`changes` 计数都收在这里。 */
interface SqlAccess {
  all(sql: string, params?: readonly SQLInputValue[]): readonly unknown[]
  one(sql: string, params?: readonly SQLInputValue[]): unknown
  run(sql: string, params?: readonly SQLInputValue[]): number
  readonly reader: {
    all(sql: string, params?: readonly SQLInputValue[]): readonly unknown[]
    plan(sql: string, params?: readonly SQLInputValue[]): readonly string[]
  }
}

/** 在真库上构造 SQL 访问器。 */
function createSqlAccess(db: DatabaseSync): SqlAccess {
  const all = (sql: string, params: readonly SQLInputValue[] = []): readonly unknown[] =>
    db.prepare(sql).all(...params)
  return {
    all,
    one: (sql: string, params: readonly SQLInputValue[] = []) => db.prepare(sql).get(...params),
    run: (sql: string, params: readonly SQLInputValue[] = []) => Number(db.prepare(sql).run(...params).changes),
    reader: {
      all,
      plan(sql: string, params: readonly SQLInputValue[] = []): readonly string[] {
        return all(`EXPLAIN QUERY PLAN ${sql}`, params).map((row) => String(field(row, 'detail')))
      }
    }
  }
}

/** 四条 PRAGMA 的实际读数。 */
function readPragmas(sql: SqlAccess): PragmaState {
  const read = (pragma: string): unknown => sql.one(`PRAGMA ${pragma}`)
  return {
    journalMode: String(field(read('journal_mode'), 'journal_mode')),
    synchronous: Number(field(read('synchronous'), 'synchronous')),
    foreignKeys: Number(field(read('foreign_keys'), 'foreign_keys')),
    busyTimeout: Number(field(read('busy_timeout'), 'timeout'))
  }
}

/** Trigger 仓储（§D.4 写者：`core/engine.ts`）。 */
function createTriggerRepository(sql: SqlAccess): TriggerRepository {
  return {
    insert(record: TriggerRecord): void {
      sql.run(
        `INSERT INTO trigger (id, source, at, actor, human, addressed, text, url, body)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          record.source,
          record.at,
          JSON.stringify(record.actor),
          record.human ? 1 : 0,
          record.addressed,
          record.text,
          record.url,
          JSON.stringify(record.body)
        ]
      )
    },
    get(id: string): TriggerRecord | null {
      const row = sql.one('SELECT * FROM trigger WHERE id = ?', [id])
      return row === undefined ? null : triggerFrom(row)
    },
    byTime(options: { readonly limit?: number } = {}): readonly TriggerRecord[] {
      return sql.all('SELECT * FROM trigger ORDER BY at, id LIMIT ?', [options.limit ?? 100]).map(triggerFrom)
    }
  }
}

/** Disposition 仓储。 */
function createDispositionRepository(sql: SqlAccess): DispositionRepository {
  return {
    put(record: DispositionRecord): void {
      sql.run(
        `INSERT INTO disposition (trigger_id, filtered, eval_id, decision_id, requeued_at, body)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(trigger_id) DO UPDATE SET
           filtered = excluded.filtered, eval_id = excluded.eval_id,
           decision_id = excluded.decision_id, requeued_at = excluded.requeued_at,
           body = excluded.body`,
        [
          record.triggerId,
          record.filtered,
          record.evalId,
          record.decisionId,
          record.requeuedAt,
          JSON.stringify(record.body)
        ]
      )
    },
    get(triggerId: string): DispositionRecord | null {
      const row = sql.one('SELECT * FROM disposition WHERE trigger_id = ?', [triggerId])
      if (row === undefined) return null
      return {
        triggerId: String(field(row, 'trigger_id')),
        filtered: nullableText(field(row, 'filtered')),
        evalId: nullableText(field(row, 'eval_id')),
        decisionId: nullableText(field(row, 'decision_id')),
        requeuedAt: nullableText(field(row, 'requeued_at')),
        body: parseJson(field(row, 'body'))
      }
    }
  }
}

/** Trigger–Thread 关联仓储。 */
function createTriggerThreadRepository(sql: SqlAccess): TriggerThreadRepository {
  return {
    link(record: TriggerThreadRecord): void {
      sql.run(
        `INSERT INTO trigger_thread (thread_key, at, trigger_id, human, primary_thread)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(thread_key, at, trigger_id) DO UPDATE SET
           human = excluded.human, primary_thread = excluded.primary_thread`,
        [record.threadKey, record.at, record.triggerId, record.human ? 1 : 0, record.primaryThread ? 1 : 0]
      )
    },
    unlink(threadKey: string, at: string, triggerId: string): boolean {
      return (
        sql.run('DELETE FROM trigger_thread WHERE thread_key = ? AND at = ? AND trigger_id = ?', [
          threadKey,
          at,
          triggerId
        ]) > 0
      )
    },
    timeline(threadKey: string, options: TimelineOptions = {}): TimelinePage {
      return readTimeline(sql.reader, threadKey, options)
    }
  }
}

/** Thread 仓储（body 由引擎写、meta 由 Source 端口写）。 */
function createThreadRepository(sql: SqlAccess): ThreadRepository {
  return {
    put(record: ThreadRecord): void {
      sql.run(
        `INSERT INTO thread (key, source, meta, body) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           source = excluded.source, meta = excluded.meta, body = excluded.body`,
        [record.key, record.source, JSON.stringify(record.meta), JSON.stringify(record.body)]
      )
    },
    get(key: string): ThreadRow | null {
      const row = sql.one('SELECT * FROM thread WHERE key = ?', [key])
      return row === undefined ? null : threadFrom(row)
    },
    describe(key: string, meta: ThreadMeta): void {
      sql.run('UPDATE thread SET meta = ? WHERE key = ?', [JSON.stringify(meta), key])
    },
    meta(key: string): ThreadMeta | null {
      const row = sql.one('SELECT meta FROM thread WHERE key = ?', [key])
      return row === undefined ? null : (parseJson(field(row, 'meta')) as ThreadMeta)
    },
    flags(key: string): { readonly active: boolean; readonly subscribed: boolean } | null {
      const row = sql.one('SELECT active, subscribed FROM thread WHERE key = ?', [key])
      if (row === undefined) return null
      return {
        active: Number(field(row, 'active')) === 1,
        subscribed: Number(field(row, 'subscribed')) === 1
      }
    }
  }
}

/** Ticket 仓储。 */
function createTicketRepository(sql: SqlAccess): TicketRepository {
  return {
    put(record: TicketRecord): void {
      sql.run(
        `INSERT INTO ticket (id, at, body) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET at = excluded.at, body = excluded.body`,
        [record.id, record.at, JSON.stringify(record.body)]
      )
    },
    get(id: string): TicketRow | null {
      const row = sql.one('SELECT * FROM ticket WHERE id = ?', [id])
      if (row === undefined) return null
      return {
        id: String(field(row, 'id')),
        at: String(field(row, 'at')),
        body: parseJson(field(row, 'body')),
        open: Number(field(row, 'open')) === 1,
        active: Number(field(row, 'active')) === 1
      }
    }
  }
}

/** Decision 仓储。 */
function createDecisionRepository(sql: SqlAccess): DecisionRepository {
  return {
    put(record: DecisionRecord): void {
      sql.run(
        `INSERT INTO decision (id, thread_key, at, kind, body) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           thread_key = excluded.thread_key, at = excluded.at,
           kind = excluded.kind, body = excluded.body`,
        [record.id, record.threadKey, record.at, record.kind, JSON.stringify(record.body)]
      )
    },
    get(id: string): DecisionRecord | null {
      const row = sql.one('SELECT * FROM decision WHERE id = ?', [id])
      return row === undefined ? null : decisionFrom(row)
    },
    byThread(threadKey: string): readonly DecisionRecord[] {
      return sql.all('SELECT * FROM decision WHERE thread_key = ? ORDER BY at, id', [threadKey]).map(decisionFrom)
    }
  }
}

/**
 * Effect 仓储（§J.2 的 due 行按 `seq` 升序取）。它是 `app/effects.ts` 的 SQL 出口：
 * 队列负责规则（退避、`Later`、并发），这里只负责行。
 */
function createEffectRepository(sql: SqlAccess): EffectRepository {
  return {
    put(record: EffectRecord): void {
      sql.run(
        `INSERT INTO effect (kind, key, payload, seq, due_at, attempts, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(kind, key) DO UPDATE SET
           payload = excluded.payload, due_at = excluded.due_at,
           attempts = excluded.attempts, last_error = excluded.last_error`,
        [
          record.kind,
          record.key,
          JSON.stringify(record.payload),
          record.seq,
          record.dueAt,
          record.attempts,
          record.lastError
        ]
      )
    },
    get(kind: string, key: string): EffectRecord | null {
      const row = sql.one('SELECT * FROM effect WHERE kind = ? AND key = ?', [kind, key])
      return row === undefined ? null : effectFrom(row)
    },
    due(at: string): readonly EffectRecord[] {
      return sql.all('SELECT * FROM effect WHERE due_at <= ? ORDER BY seq LIMIT 100', [at]).map(effectFrom)
    },
    /**
     * 一个 kind 的到期行。`effect_due` 索引让 `due_at <= ?` 先缩小范围，再按 `seq` 取前
     * `limit` 行；队列按需多取一些，避免运行中的行占满一页。
     */
    dueOfKind(kind: string, at: string, limit = 64): readonly EffectRecord[] {
      return sql
        .all('SELECT * FROM effect WHERE kind = ? AND due_at <= ? ORDER BY seq LIMIT ?', [kind, at, limit])
        .map(effectFrom)
    },
    oldestOfKind(kind: string): EffectRecord | null {
      const row = sql.one('SELECT * FROM effect WHERE kind = ? ORDER BY seq LIMIT 1', [kind])
      return row === undefined ? null : effectFrom(row)
    },
    maxSeq(): number {
      return Number(field(sql.one('SELECT COALESCE(MAX(seq), 0) AS seq FROM effect'), 'seq'))
    },
    kindCounts(): readonly EffectKindCount[] {
      return sql
        .all(
          `SELECT kind, COUNT(*) AS waiting, SUM(CASE WHEN attempts > 0 THEN 1 ELSE 0 END) AS failed
             FROM effect GROUP BY kind ORDER BY kind`
        )
        .map((row) => ({
          kind: String(field(row, 'kind')),
          waiting: Number(field(row, 'waiting')),
          failed: Number(field(row, 'failed'))
        }))
    },
    remove(kind: string, key: string, seq: number, attempts: number): boolean {
      return (
        sql.run('DELETE FROM effect WHERE kind = ? AND key = ? AND seq = ? AND attempts = ?', [
          kind,
          key,
          seq,
          attempts
        ]) > 0
      )
    },
    reschedule(record: EffectRecord): void {
      sql.run(
        `UPDATE effect SET due_at = ?, attempts = ?, last_error = ?
          WHERE kind = ? AND key = ? AND seq = ?`,
        [record.dueAt, record.attempts, record.lastError, record.kind, record.key, record.seq]
      )
    }
  }
}

/** Outbox 仓储（§D.4：`app/outbox.ts` 是唯一写者）。 */
function createOutboxRepository(sql: SqlAccess): OutboxRepository {
  return {
    put(record: OutboxRecord): void {
      sql.run(
        `INSERT INTO outbox (id, ticket_id, channel, status, body, settled_at, dropped_at, dropped_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status, body = excluded.body, settled_at = excluded.settled_at,
           dropped_at = excluded.dropped_at, dropped_reason = excluded.dropped_reason`,
        [
          record.id,
          record.ticketId,
          record.channel,
          record.status,
          JSON.stringify(record.body),
          record.settledAt,
          record.droppedAt,
          record.droppedReason
        ]
      )
    },
    get(id: string): OutboxRecord | null {
      const row = sql.one('SELECT * FROM outbox WHERE id = ?', [id])
      return row === undefined ? null : outboxFrom(row)
    },
    waiting(channel: string): readonly OutboxWaitingRow[] {
      // `reply` effect 的 seq 就是入队序（§J.1）；没有 effect 行（不该发生）按 null 读，
      // 排序时忽略它，避免一条坏行永久挡住同组。
      return sql
        .all(
          `SELECT o.*, e.seq AS effect_seq, COALESCE(e.attempts, 0) AS attempts
             FROM outbox o
             LEFT JOIN effect e ON e.kind = 'reply' AND e.key = o.id
            WHERE o.status = 'pending' AND o.channel = ?`,
          [channel]
        )
        .map(outboxWaitingFrom)
        .sort(byEffectSeq)
    },
    pendingOfTicket(ticketId: string): readonly OutboxRecord[] {
      return sql
        .all("SELECT * FROM outbox WHERE ticket_id = ? AND status = 'pending' ORDER BY id", [ticketId])
        .map(outboxFrom)
    },
    droppedSince(at: string): readonly OutboxRecord[] {
      return sql
        .all(
          "SELECT * FROM outbox WHERE status = 'dropped' AND dropped_at >= ? ORDER BY dropped_at DESC, id",
          [at]
        )
        .map(outboxFrom)
    },
    failing(minAttempts: number): readonly OutboxWaitingRow[] {
      return sql
        .all(
          `SELECT o.*, e.seq AS effect_seq, e.attempts AS attempts
             FROM outbox o
             JOIN effect e ON e.kind = 'reply' AND e.key = o.id
            WHERE o.status = 'pending' AND e.attempts >= ?`,
          [minAttempts]
        )
        .map(outboxWaitingFrom)
        .sort(byEffectSeq)
    },
    countDropped(): number {
      return Number(
        field(
          sql.one("SELECT COUNT(*) AS n FROM outbox WHERE status = 'dropped' AND dropped_reason <> 'withdrawn'"),
          'n'
        )
      )
    }
  }
}

/** 设置版本仓储（§D.4 写者：`app/settings.ts`）。 */
function createSettingsVersionRepository(sql: SqlAccess): SettingsVersionRepository {
  return {
    put(record: SettingsVersionRecord): void {
      sql.run(
        `INSERT INTO settings_version (revision, predecessor, at, origin, block, config, policy_version)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(revision) DO UPDATE SET
           predecessor = excluded.predecessor, at = excluded.at, origin = excluded.origin,
           block = excluded.block, config = excluded.config, policy_version = excluded.policy_version`,
        [
          record.revision,
          record.predecessor,
          record.at,
          record.origin,
          record.block,
          JSON.stringify(record.config),
          record.policyVersion
        ]
      )
    },
    byRevision(revision: number): SettingsVersionRecord | null {
      const row = sql.one('SELECT * FROM settings_version WHERE revision = ?', [revision])
      return row === undefined ? null : settingsVersionFrom(row)
    },
    latest(): SettingsVersionRecord | null {
      const row = sql.one('SELECT * FROM settings_version ORDER BY revision DESC LIMIT 1')
      return row === undefined ? null : settingsVersionFrom(row)
    }
  }
}

/** Prompt 版本仓储（§D.4 写者：`app/prompts.ts`）。 */
function createPromptVersionRepository(sql: SqlAccess): PromptVersionRepository {
  return {
    put(record: PromptVersionRecord): void {
      sql.run(
        `INSERT INTO prompt_version (revision, predecessor, at, origin, config)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(revision) DO UPDATE SET
           predecessor = excluded.predecessor, at = excluded.at,
           origin = excluded.origin, config = excluded.config`,
        [record.revision, record.predecessor, record.at, record.origin, JSON.stringify(record.config)]
      )
    },
    byRevision(revision: number): PromptVersionRecord | null {
      const row = sql.one('SELECT * FROM prompt_version WHERE revision = ?', [revision])
      return row === undefined ? null : promptVersionFrom(row)
    },
    latest(): PromptVersionRecord | null {
      const row = sql.one('SELECT * FROM prompt_version ORDER BY revision DESC LIMIT 1')
      return row === undefined ? null : promptVersionFrom(row)
    }
  }
}

/** 从 `trigger` 行读出记录。 */
function triggerFrom(row: unknown): TriggerRecord {
  return {
    id: String(field(row, 'id')),
    source: String(field(row, 'source')),
    at: String(field(row, 'at')),
    actor: parseJson(field(row, 'actor')) as { source: string; id: string },
    human: Number(field(row, 'human')) === 1,
    addressed: nullableText(field(row, 'addressed')) as 'mention' | 'direct' | null,
    text: String(field(row, 'text')),
    url: nullableText(field(row, 'url')),
    body: parseJson(field(row, 'body'))
  }
}

/** 从 `thread` 行读出记录（含生成列）。 */
function threadFrom(row: unknown): ThreadRow {
  return {
    key: String(field(row, 'key')),
    source: String(field(row, 'source')),
    meta: parseJson(field(row, 'meta')) as ThreadMeta,
    body: parseJson(field(row, 'body')),
    active: Number(field(row, 'active')) === 1,
    subscribed: Number(field(row, 'subscribed')) === 1
  }
}

/** 从 `decision` 行读出记录。 */
function decisionFrom(row: unknown): DecisionRecord {
  return {
    id: String(field(row, 'id')),
    threadKey: String(field(row, 'thread_key')),
    at: String(field(row, 'at')),
    kind: String(field(row, 'kind')) as DecisionRecord['kind'],
    body: parseJson(field(row, 'body'))
  }
}

/** 从 `effect` 行读出记录。 */
function effectFrom(row: unknown): EffectRecord {
  return {
    kind: String(field(row, 'kind')),
    key: String(field(row, 'key')),
    payload: parseJson(field(row, 'payload')),
    seq: Number(field(row, 'seq')),
    dueAt: String(field(row, 'due_at')),
    attempts: Number(field(row, 'attempts')),
    lastError: nullableText(field(row, 'last_error'))
  }
}

/** 从 `outbox` 行读出记录。 */
function outboxFrom(row: unknown): OutboxRecord {
  return {
    id: String(field(row, 'id')),
    ticketId: nullableText(field(row, 'ticket_id')),
    channel: String(field(row, 'channel')),
    status: String(field(row, 'status')) as OutboxRecord['status'],
    body: parseJson(field(row, 'body')),
    settledAt: nullableText(field(row, 'settled_at')),
    droppedAt: nullableText(field(row, 'dropped_at')),
    droppedReason: nullableText(field(row, 'dropped_reason'))
  }
}

/** 从 `outbox` + `effect` 的连接行读出待发行（§J.1 顺序：`seq` 是入队序）。 */
function outboxWaitingFrom(row: unknown): OutboxWaitingRow {
  return {
    record: outboxFrom(row),
    seq: nullableNumber(field(row, 'effect_seq')),
    attempts: Number(field(row, 'attempts'))
  }
}

/** 按 `reply` effect 的 `seq` 升序；没有 `seq` 的行排在最后（不参与「更早」的判断）。 */
function byEffectSeq(left: OutboxWaitingRow, right: OutboxWaitingRow): number {
  if (left.seq === null) return 1
  if (right.seq === null) return -1
  return left.seq - right.seq
}

/** 从 `settings_version` 行读出记录。 */
function settingsVersionFrom(row: unknown): SettingsVersionRecord {
  return {
    revision: Number(field(row, 'revision')),
    predecessor: nullableNumber(field(row, 'predecessor')),
    at: String(field(row, 'at')),
    origin: String(field(row, 'origin')) as SettingsVersionRecord['origin'],
    block: String(field(row, 'block')),
    config: parseJson(field(row, 'config')),
    policyVersion: nullableText(field(row, 'policy_version'))
  }
}

/** 从 `prompt_version` 行读出记录。 */
function promptVersionFrom(row: unknown): PromptVersionRecord {
  return {
    revision: Number(field(row, 'revision')),
    predecessor: nullableNumber(field(row, 'predecessor')),
    at: String(field(row, 'at')),
    origin: String(field(row, 'origin')) as PromptVersionRecord['origin'],
    config: parseJson(field(row, 'config'))
  }
}

/** 从 PRAGMA/查询的 null 原型行里取一个字段。 */
function field(row: unknown, name: string): unknown {
  if (typeof row !== 'object' || row === null) return undefined
  return (row as Record<string, unknown>)[name]
}

/** SQLite 的 NULL → `null`，其余转文本。 */
function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

/** SQLite 的 NULL → `null`，其余转数字。 */
function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

/** 解析 JSON 列（写者保证它合法；schema 上有 `json_valid` 约束兜底）。 */
function parseJson(value: unknown): unknown {
  return typeof value === 'string' ? (JSON.parse(value) as unknown) : null
}


/**
 * 只读自检视图（`doctor` 用）。它**不打开第二个连接**：拿已经打开的那个句柄读版本与表数，
 * 于是「插件只有一个写驱动」这条纪律不变，doctor 也不会因为并发打开而卡在 busy 上。
 */
export interface DatabaseInspection {
  /** `<stateDir>/superagent.sqlite` 的绝对路径。 */
  readonly path: string
  /** 库里的 schema 版本（`kv['schema-version']`，退到 `PRAGMA user_version`）。 */
  readonly schemaVersion: number
  /** 插件支持的版本（`SCHEMA_VERSION`）。 */
  readonly pluginVersion: number
  /** 用户表数量（不含 `sqlite_*`）。 */
  readonly tables: number
  /** 文件大小（字节）。 */
  readonly bytes: number
}

/** 在已打开的库上取自检读数；任何一条读不到都退到保守值（doctor 只报「有没有」）。 */
export function inspectOpenDatabase(db: DatabaseSync, path: string): DatabaseInspection {
  const tables = Number(
    field(
      db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get(),
      'n'
    )
  )
  let bytes = 0
  try {
    bytes = statSync(path).size
  } catch {
    bytes = 0
  }
  return {
    path,
    schemaVersion: readSchemaVersion(db),
    pluginVersion: SCHEMA_VERSION,
    tables: Number.isFinite(tables) ? tables : 0,
    bytes
  }
}

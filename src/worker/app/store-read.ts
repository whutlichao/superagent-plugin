// 读查询（§D.2「生成列 + 部分索引」、§C.1 `app/store-read.ts`）。
//
// 工作集（活跃 Thread、开放 Ticket、活跃 Ticket、待发 Outbox）一律走生成列 + 部分索引：
// 非活跃行根本不进索引，所以一次 pass 只扫活行。这里的 SQL 是唯一副本，`store.ts`
// 负责执行，测试用 `plan()` 断言查询计划（§P.1 的可核验行为）。
import type { TimelineCursor, TimelinePage, WorkingSet } from './records'

/** 可绑定到 SQLite 参数的标量（与 `store.ts` 的驱动类型结构相同；type-only 依赖）。 */
export type ReadParam = null | number | bigint | string | Uint8Array

/** 读查询只需要「全部行」与「查询计划」两种能力（`store.ts` 用真库实现）。 */
export interface SqlReader {
  all(sql: string, params?: readonly ReadParam[]): readonly unknown[]
  /** `EXPLAIN QUERY PLAN` 的 detail 行（按出现顺序）。 */
  plan(sql: string, params?: readonly ReadParam[]): readonly string[]
}

/** 工作集的名字，与 `WorkingSet` 的字段一一对应。 */
export type WorkingSetName = keyof WorkingSet

/**
 * 四个工作集查询。每条都只碰生成列上的部分索引：
 * - `activeThreads`   → `thread_active`（`active = 1` 的部分索引）
 * - `openTickets`     → `ticket_open`
 * - `activeTickets`   → `ticket_active`
 * - `pendingOutbox`   → `outbox_waiting`（`pending = 1` 的部分索引）
 */
export const WORKING_SET_SQL: Readonly<Record<WorkingSetName, string>> = {
  activeThreads: 'SELECT key FROM thread WHERE active = 1 ORDER BY key',
  openTickets: 'SELECT id FROM ticket WHERE open = 1 ORDER BY id',
  activeTickets: 'SELECT id FROM ticket WHERE active = 1 ORDER BY id',
  pendingOutbox: 'SELECT id FROM outbox WHERE pending = 1 ORDER BY channel, id'
}

/** 工作集查询对应的部分索引名（测试与 doctor 用）。 */
export const WORKING_SET_INDEX: Readonly<Record<WorkingSetName, string>> = {
  activeThreads: 'thread_active',
  openTickets: 'ticket_open',
  activeTickets: 'ticket_active',
  pendingOutbox: 'outbox_waiting'
}

/** 读取全部工作集；每个查询只返回活行。 */
export function readWorkingSet(reader: SqlReader): WorkingSet {
  return {
    activeThreads: column(reader.all(WORKING_SET_SQL.activeThreads), 'key'),
    openTickets: column(reader.all(WORKING_SET_SQL.openTickets), 'id'),
    activeTickets: column(reader.all(WORKING_SET_SQL.activeTickets), 'id'),
    pendingOutbox: column(reader.all(WORKING_SET_SQL.pendingOutbox), 'id')
  }
}

/** 四个工作集查询的查询计划（`doctor` 与测试断言「没有全表扫描」）。 */
export function workingSetPlan(reader: SqlReader): Readonly<Record<WorkingSetName, readonly string[]>> {
  return {
    activeThreads: reader.plan(WORKING_SET_SQL.activeThreads),
    openTickets: reader.plan(WORKING_SET_SQL.openTickets),
    activeTickets: reader.plan(WORKING_SET_SQL.activeTickets),
    pendingOutbox: reader.plan(WORKING_SET_SQL.pendingOutbox)
  }
}

/** 时间线分页的输入。 */
export interface TimelineOptions {
  /** 每页行数（默认 50，面板一次最多 50 行，§M.4）。 */
  readonly limit?: number
  /** 上一页返回的游标；未给则从最早一行开始。 */
  readonly after?: TimelineCursor | null
}

/**
 * Thread 时间线：按 `(at, trigger_id)` 升序，游标是同形的复合值。
 * 用行值比较 `(at, trigger_id) > (?, ?)`，同一时刻的多条记录既不丢也不重。
 */
export function readTimeline(
  reader: SqlReader,
  threadKey: string,
  options: TimelineOptions = {}
): TimelinePage {
  const limit = Math.max(1, options.limit ?? 50)
  const after = options.after ?? null
  const rows =
    after === null
      ? reader.all(
          `SELECT at, trigger_id, human, primary_thread
             FROM trigger_thread
            WHERE thread_key = ?
            ORDER BY at, trigger_id
            LIMIT ?`,
          [threadKey, limit + 1]
        )
      : reader.all(
          `SELECT at, trigger_id, human, primary_thread
             FROM trigger_thread
            WHERE thread_key = ? AND (at, trigger_id) > (?, ?)
            ORDER BY at, trigger_id
            LIMIT ?`,
          [threadKey, after.at, after.triggerId, limit + 1]
        )
  const items = rows.slice(0, limit).map((row) => ({
    at: String(field(row, 'at')),
    triggerId: String(field(row, 'trigger_id')),
    human: Number(field(row, 'human')) === 1,
    primaryThread: Number(field(row, 'primary_thread')) === 1
  }))
  const last = items.at(-1)
  const next = rows.length > limit && last !== undefined
    ? { at: last.at, triggerId: last.triggerId }
    : null
  return { items, next }
}

/** 取一列（`node:sqlite` 返回 null 原型对象）。 */
function column(rows: readonly unknown[], name: string): readonly string[] {
  return rows.map((row) => String(field(row, name)))
}

/** 从 null 原型行里取字段。 */
function field(row: unknown, name: string): unknown {
  if (typeof row !== 'object' || row === null) return undefined
  return (row as Record<string, unknown>)[name]
}

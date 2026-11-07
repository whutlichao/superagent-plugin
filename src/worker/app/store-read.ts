// 读查询（§D.2「生成列 + 部分索引」、§C.1 `app/store-read.ts`）。
//
// 工作集（活跃 Thread、开放 Ticket、活跃 Ticket、待发 Outbox）一律走生成列 + 部分索引：
// 非活跃行根本不进索引，所以一次 pass 只扫活行。这里的 SQL 是唯一副本，`store.ts`
// 负责执行，测试用 `plan()` 断言查询计划（§P.1 的可核验行为）。
import type { TimelineCursor, TimelineItem, TimelinePage, WorkingSet } from './records.ts'

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

/**
 * Executor 负载的计数口径（§E.6、§M.2 的 Overview「Executor load」）：
 * `running` = 未结束 Ticket 里**最新** Assignment 状态为 `running` 的数量；
 * `queued`   = 未结束 Ticket 里还没有 Assignment、或最新一个仍是 `pending` 的数量。
 *
 * 「最新」取 `ticket.body.assignments` 的最后一项（SQLite 的 `[#-1]` JSON 路径），
 * 与领域侧 `latestAssignment()`（`core/model.ts`）同义。生成列 `open = 1` 走
 * `ticket_open` 部分索引，不扫已结束的 Ticket。
 */
export const ASSIGNMENT_COUNT_SQL =
  `SELECT COALESCE(json_extract(body, '$.assignments[#-1].state'), '') AS last, COUNT(*) AS n
     FROM ticket
    WHERE open = 1
    GROUP BY last`

/** 一份负载计数（未结束 Ticket 的最新 Assignment 状态汇总）。 */
export interface AssignmentCounts {
  readonly running: number
  readonly queued: number
}

/** 读出负载计数。 */
export function readAssignmentCounts(reader: SqlReader): AssignmentCounts {
  let running = 0
  let queued = 0
  for (const row of reader.all(ASSIGNMENT_COUNT_SQL)) {
    const last = String(field(row, 'last'))
    const count = Number(field(row, 'n'))
    if (last === 'running') running += count
    else if (last === '' || last === 'pending') queued += count
  }
  return { running, queued }
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

/** 一页往**更早**方向的时间线（`before` 读）或最新一页（`tail` 读）。 */
export interface TimelineBackPage {
  readonly items: readonly TimelineItem[]
  /** 更早还有行时，把 `before` 传给下一次读的游标；读完是 `null`。 */
  readonly before: TimelineCursor | null
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
  const items = rows.slice(0, limit).map(timelineItemOf)
  const last = items.at(-1)
  const next = rows.length > limit && last !== undefined
    ? { at: last.at, triggerId: last.triggerId }
    : null
  return { items, next }
}

/**
 * Thread 时间线的**最新**一页：按 `(at, trigger_id)` 降序取 `limit + 1` 行再翻成升序，
 * `before` 是这一页最早一行的游标（更早还有行时；与 `readTimeline` 的 `next` 对称）。
 * 面板与 `read thread/<key>` 从最近的消息往回走。
 */
export function readTimelineTail(
  reader: SqlReader,
  threadKey: string,
  limit = 50
): TimelineBackPage {
  return backPage(
    reader.all(
      `SELECT at, trigger_id, human, primary_thread
         FROM trigger_thread
        WHERE thread_key = ?
        ORDER BY at DESC, trigger_id DESC
        LIMIT ?`,
      [threadKey, Math.max(1, limit) + 1]
    ),
    limit
  )
}

/**
 * 游标**之前**（更早）的一页：`(at, trigger_id) < (?, ?)`，升序返回，`before` 指向更早还有页的
 * 游标。与 `readTimeline` 的 `after` 是同一张行值比较的两个方向，同一时刻的多条既不丢也不重。
 */
export function readTimelineBefore(
  reader: SqlReader,
  threadKey: string,
  before: TimelineCursor,
  limit = 50
): TimelineBackPage {
  return backPage(
    reader.all(
      `SELECT at, trigger_id, human, primary_thread
         FROM trigger_thread
        WHERE thread_key = ? AND (at, trigger_id) < (?, ?)
        ORDER BY at DESC, trigger_id DESC
        LIMIT ?`,
      [threadKey, before.at, before.triggerId, Math.max(1, limit) + 1]
    ),
    limit
  )
}

/** 时间线上恰好落在游标处的一行（`around` 的锚点）；不在就是 `undefined`。 */
export function readTimelineItem(
  reader: SqlReader,
  threadKey: string,
  cursor: TimelineCursor
): TimelineItem | undefined {
  const row = reader.all(
    `SELECT at, trigger_id, human, primary_thread
       FROM trigger_thread
      WHERE thread_key = ? AND at = ? AND trigger_id = ?`,
    [threadKey, cursor.at, cursor.triggerId]
  )[0]
  return row === undefined ? undefined : timelineItemOf(row)
}

/** 降序取回的 `limit + 1` 行 → 升序的一页 + 更早还有页的游标。 */
function backPage(rows: readonly unknown[], limit: number): TimelineBackPage {
  const size = Math.max(1, limit)
  const more = rows.length > size
  const items = rows.slice(0, size).map(timelineItemOf).reverse()
  const first = items[0]
  return {
    items,
    before: more && first !== undefined ? { at: first.at, triggerId: first.triggerId } : null
  }
}

/** 一行 `trigger_thread` → 时间线项（列名只在上面几条查询里出现）。 */
function timelineItemOf(row: unknown): TimelineItem {
  return {
    at: String(field(row, 'at')),
    triggerId: String(field(row, 'trigger_id')),
    human: Number(field(row, 'human')) === 1,
    primaryThread: Number(field(row, 'primary_thread')) === 1
  }
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

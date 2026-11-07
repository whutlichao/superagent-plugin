// `Repositories`（`core/ports.ts`）的 SQLite 实现：组合根把 `Store` 包成领域仓储（§D.2、§D.4）。
//
// 职责边界：
// - 领域对象 ↔ 表行的映射只在这里：`trigger` 的标量列 + `body`（threads/channel/meta/url）；
//   `thread` 的 `meta` 列与 `body`；`ticket` / `decision` 整对象进 `body`；`disposition`
//   的标量列 + `body`（fanout/handbacks/acked/at）；
// - 生成列（§D.2）读的是**存储形态**而不是领域形态：`thread.body` 因此额外投影
//   `eval`（= evaluating）与 `queued`（= pending）；`ticket.body` 直接是领域对象，
//   `assignments[#-1].state` 正好是 `assignmentCounts` 需要的最新 Assignment 状态；
// - `trigger_thread` 时间线在 `triggers.save` 时按 `trigger.threads` 写入（`threads[0]` 是
//   primary）：领域的写入口只有 `save`，读模型（`store.triggerThreads.timeline`）由它填。
//
// 读出的都是克隆：`node:sqlite` 每次返回新对象，JSON 列已解析，调用方改返回值不影响已存行。
import type { Decision, Thread, Ticket, Trigger, TriggerDisposition } from '../core/index.ts'
import { latestAssignment } from '../core/index.ts'
import type { Repositories } from '../core/index.ts'
import type { Store } from './store.ts'

/** 一行 JSON 列的解析（存储层保证 `json_valid`，这里只做类型收敛）。 */
function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return (value as T) ?? fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

/** 从 null 原型行里取字段（`node:sqlite` 的行没有原型）。 */
function field(row: unknown, name: string): unknown {
  if (typeof row !== 'object' || row === null) return undefined
  return (row as Record<string, unknown>)[name]
}

/** 文本或 null。 */
const nullable = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** `body` 里的 Thread 存储投影：领域数组 + 生成列需要的两个别名（§D.2 生成列）。 */
function threadBody(thread: Thread): Record<string, unknown> {
  return {
    ...thread,
    // `thread_active` 的部分索引读这两个键；它们不是领域字段，`threadFrom` 会剥掉。
    eval: thread.evaluating,
    queued: thread.pending
  }
}

/** 行 → Thread：剥掉生成列投影，补上缺失字段（手工写入的行也能读）。 */
function threadFrom(row: unknown): Thread {
  const key = String(field(row, 'key'))
  const source = String(field(row, 'source'))
  const body = json<Record<string, unknown>>(field(row, 'body'), {})
  const { eval: _evaluating, queued, ...rest } = body
  const id = key.startsWith(`${source}:`) ? key.slice(source.length + 1) : key
  const subscriptions = Array.isArray(rest['subscriptions'])
    ? (rest['subscriptions'] as unknown[]).flatMap((item) => {
        if (typeof item === 'string') return [item]
        const ticketId = (item as { ticketId?: unknown } | null)?.ticketId
        return typeof ticketId === 'string' ? [ticketId] : []
      })
    : []
  const pending = Array.isArray(rest['pending'])
    ? (rest['pending'] as string[])
    : Array.isArray(queued)
      ? (queued as string[])
      : []
  return {
    ...(rest as unknown as Thread),
    key,
    ref: { source, id },
    createdAt: typeof rest['createdAt'] === 'string' ? rest['createdAt'] : '',
    subscriptions,
    correlated: Array.isArray(rest['correlated']) ? (rest['correlated'] as string[]) : [],
    pending,
    meta: json<Record<string, unknown>>(field(row, 'meta'), {})
  }
}

/** 行 → Trigger：标量列 + `body` 的其余字段。 */
function triggerFrom(row: unknown): Trigger {
  const body = json<Record<string, unknown>>(field(row, 'body'), {})
  const addressed = nullable(field(row, 'addressed'))
  const threads = Array.isArray(body['threads']) ? (body['threads'] as Trigger['threads']) : []
  const url = nullable(field(row, 'url'))
  return {
    id: String(field(row, 'id')),
    source: String(field(row, 'source')),
    threads,
    actor: json<Trigger['actor']>(field(row, 'actor'), { source: '', id: '' }),
    human: Number(field(row, 'human')) === 1,
    ...(addressed === 'mention' || addressed === 'direct' ? { addressed } : {}),
    at: String(field(row, 'at')),
    text: String(field(row, 'text')),
    ...(body['channel'] === undefined ? {} : { channel: body['channel'] as Trigger['channel'] }),
    ...(url === null ? {} : { url }),
    meta: json<Record<string, unknown>>(body['meta'], {})
  }
}

/** 行 → Disposition：标量列与 `body` 合回领域对象。 */
function dispositionFrom(row: unknown): TriggerDisposition {
  const body = json<Record<string, unknown>>(field(row, 'body'), {})
  const filtered = nullable(field(row, 'filtered'))
  const evalId = nullable(field(row, 'eval_id'))
  const decisionId = nullable(field(row, 'decision_id'))
  return {
    ...(filtered === null ? {} : { filtered: { code: filtered } }),
    ...(evalId === null ? {} : { evalId }),
    ...(decisionId === null ? {} : { decisionId }),
    fanout: Array.isArray(body['fanout']) ? (body['fanout'] as string[]) : [],
    ...(body['context'] === undefined ? {} : { context: body['context'] as string[] }),
    ...(body['requeued'] === true ? { requeued: true as const } : {}),
    ...(body['handbacks'] === undefined ? {} : { handbacks: body['handbacks'] as TriggerDisposition['handbacks'] }),
    ...(body['acked'] === undefined ? {} : { acked: body['acked'] as string[] }),
    at: typeof body['at'] === 'string' ? body['at'] : ''
  }
}

/** Ticket 的新旧序：创建时间降序，同刻按 id 降序（与 `MemoryRepositories` 一致）。 */
const newestFirst = (a: Ticket, b: Ticket): number =>
  a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt)

/**
 * 在真库上实现领域仓储。所有写方法都只应在 `atomic`（`store.transaction`）里被调用；
 * 引擎是唯一调用方（§D.4 写者表），这里不重复守卫。
 */
export function createRepositories(store: Store): Repositories {
  const listTriggers = (sql: string, params: readonly string[]): Trigger[] =>
    store.sql.all(sql, params).map(triggerFrom)

  const tickets = (): Ticket[] =>
    store.sql.all('SELECT * FROM ticket ORDER BY at DESC, id DESC').map((row) => ({
      ...json<Ticket>(field(row, 'body'), {} as Ticket),
      id: String(field(row, 'id')),
      createdAt: (json<Record<string, unknown>>(field(row, 'body'), {})['createdAt'] as string | undefined) ??
        String(field(row, 'at'))
    }))

  return {
    atomic<T>(work: () => T): T {
      return store.transaction(work)
    },
    triggers: {
      get(id: string): Trigger | undefined {
        const row = store.sql.all('SELECT * FROM trigger WHERE id = ?', [id])[0]
        return row === undefined ? undefined : triggerFrom(row)
      },
      save(trigger: Trigger): void {
        store.sql.run(
          `INSERT INTO trigger (id, source, at, actor, human, addressed, text, url, body)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             source = excluded.source, at = excluded.at, actor = excluded.actor,
             human = excluded.human, addressed = excluded.addressed, text = excluded.text,
             url = excluded.url, body = excluded.body`,
          [
            trigger.id,
            trigger.source,
            trigger.at,
            JSON.stringify(trigger.actor),
            trigger.human ? 1 : 0,
            trigger.addressed ?? null,
            trigger.text,
            trigger.url ?? null,
            JSON.stringify({
              threads: trigger.threads,
              ...(trigger.channel === undefined ? {} : { channel: trigger.channel }),
              meta: trigger.meta
            })
          ]
        )
        trigger.threads.forEach((ref, index) => {
          const key = `${ref.source}:${ref.id}`
          store.triggerThreads.link({
            threadKey: key,
            at: trigger.at,
            triggerId: trigger.id,
            human: trigger.human,
            primaryThread: index === 0
          })
        })
      },
      byThread(threadKey: string): Trigger[] {
        return listTriggers(
          `SELECT trigger.* FROM trigger
             JOIN trigger_thread ON trigger_thread.trigger_id = trigger.id
            WHERE trigger_thread.thread_key = ?
            ORDER BY trigger.at, trigger.id`,
          [threadKey]
        )
      },
      disposition(id: string): TriggerDisposition | undefined {
        const row = store.sql.all('SELECT * FROM disposition WHERE trigger_id = ?', [id])[0]
        return row === undefined ? undefined : dispositionFrom(row)
      },
      saveDisposition(id: string, value: TriggerDisposition): void {
        store.sql.run(
          `INSERT INTO disposition (trigger_id, filtered, eval_id, decision_id, requeued_at, body)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(trigger_id) DO UPDATE SET
             filtered = excluded.filtered, eval_id = excluded.eval_id,
             decision_id = excluded.decision_id, requeued_at = excluded.requeued_at,
             body = excluded.body`,
          [
            id,
            value.filtered?.code ?? null,
            value.evalId ?? null,
            value.decisionId ?? null,
            value.requeued === true ? value.at : null,
            JSON.stringify(value)
          ]
        )
      }
    },
    threads: {
      get(key: string): Thread | undefined {
        const row = store.sql.all('SELECT * FROM thread WHERE key = ?', [key])[0]
        return row === undefined ? undefined : threadFrom(row)
      },
      save(thread: Thread): void {
        store.threads.put({
          key: thread.key,
          source: thread.ref.source,
          meta: thread.meta,
          body: threadBody(thread)
        })
      },
      list(): Thread[] {
        return store.sql
          .all('SELECT * FROM thread ORDER BY key')
          .map(threadFrom)
      },
      active(): Thread[] {
        return this.list().filter(
          (thread) => thread.pending.length > 0 || thread.evaluating !== undefined
        )
      }
    },
    tickets: {
      get(id: string): Ticket | undefined {
        return tickets().find((ticket) => ticket.id === id)
      },
      save(ticket: Ticket): void {
        store.tickets.put({ id: ticket.id, at: ticket.createdAt, body: ticket })
      },
      list(): Ticket[] {
        return tickets().sort(newestFirst)
      },
      open(): Ticket[] {
        return this.list().filter((ticket) => ticket.ended === undefined)
      },
      active(): Ticket[] {
        return this.list().filter(
          (ticket) =>
            ticket.undelivered.length > 0 ||
            ['pending', 'running'].includes(latestAssignment(ticket)?.state ?? '')
        )
      }
    },
    decisions: {
      get(id: string): Decision | undefined {
        const row = store.sql.all('SELECT * FROM decision WHERE id = ?', [id])[0]
        return row === undefined ? undefined : { ...json<Decision>(field(row, 'body'), {} as Decision), id }
      },
      save(decision: Decision): void {
        store.decisions.put({
          id: decision.id,
          threadKey: decision.threadKey,
          at: decision.at,
          kind: decision.kind,
          body: decision
        })
      },
      byThread(key: string): Decision[] {
        return store.sql
          .all('SELECT * FROM decision WHERE thread_key = ? ORDER BY at, id', [key])
          .map((row) => ({ ...json<Decision>(field(row, 'body'), {} as Decision), id: String(field(row, 'id')) }))
      },
      list(): Decision[] {
        return store.sql
          .all('SELECT * FROM decision ORDER BY at DESC, id DESC')
          .map((row) => ({ ...json<Decision>(field(row, 'body'), {} as Decision), id: String(field(row, 'id')) }))
      }
    }
  }
}

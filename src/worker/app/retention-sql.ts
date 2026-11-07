// 保留策略的 SQL（§D.2 要点 5）。与 `store-read.ts` 一样，把 SQL 文本集中一处，
// 让 `retention.ts` 只管顺序与明细，测试只需断言「删了什么」。
//
// 三条不删规则在 SQL 里就成立：
// - Trigger/Disposition/Decision 只删 `at` 早于阈值、且**不落在未结束 Ticket 视野里**的行
//   （§D.2 要点 6、#63：未结束的 Ticket 与其 Thread 永不自动清理，所以它的 Trigger→Ticket
//   历史也不能被时间阈值抹掉）；
// - Outbox 只删「已结算」（sent/dropped）且结算时间早于 30 天的行；
// - 版本快照族只删早于阈值的 `settings-version:*` / `prompt-version:*`（当前版本由调用方排除）。
import { VERSION_SNAPSHOT_PREFIXES } from './kv'

/**
 * 「这条 Thread 的订阅集合里还有未结束的 Ticket」——豁免谓词的两个用法共用它。
 * 订阅集合是权威（§D.1：`thread.subscriptions[]`，`Tickets.subscribe` 写），元素形态与
 * 读模型 `threadFrom`（`app/repositories.ts`）一致：Ticket id 文本，或 `{ticketId}` 投影。
 * 未结束就是生成列 `ticket.open = 1`（领域侧同义谓词是 `core/model.ts` 的 `liveTicket`）。
 * 走 `trigger_thread_by_trigger` / `thread` / `ticket` 的主键，只在到期的行上求值。
 */
const openTicketSubscriber = (thread: string): string => `EXISTS (
        SELECT 1 FROM json_each(${thread}.body, '$.subscriptions') AS s
         WHERE EXISTS (
           SELECT 1 FROM ticket t
            WHERE t.open = 1
              AND t.id = COALESCE(
                json_extract(CASE WHEN s.type = 'object' THEN s.value END, '$.ticketId'),
                s.value)))`

/**
 * 一条 Trigger 是否落在未结束 Ticket 的视野里（两条腿，都只用既有状态）：
 * - 它关联的某条 Thread 仍被未结束 Ticket 订阅（`trigger_thread` → `thread`）；
 * - 它是某个未结束 Ticket 的起源 Trigger，或作为一条 Trigger Input 到达过它
 *   （Ticket 页展示的 Trigger→Ticket 历史，用户故事 32；人取消订阅后这条腿仍然成立）。
 */
const keptTrigger = `(
      EXISTS (
        SELECT 1 FROM trigger_thread tt JOIN thread th ON th.key = tt.thread_key
         WHERE tt.trigger_id = trigger.id AND ${openTicketSubscriber('th')})
      OR EXISTS (
        SELECT 1 FROM ticket t
         WHERE t.open = 1
           AND (json_extract(t.body, '$.origin.triggerId') = trigger.id
                OR EXISTS (SELECT 1 FROM json_each(t.body, '$.inputs') AS i
                            WHERE json_extract(i.value, '$.triggerId') = trigger.id))))`

/**
 * 一次保留 pass 要删的 Trigger：到期的（`at < ?`），且不落在未结束 Ticket 的视野里。
 * 下面三条语句共用它——删除集合只有一个定义，关联行与 disposition 不会跟 Trigger 走散。
 */
const expiredTriggers = `SELECT id FROM trigger WHERE at < ? AND NOT ${keptTrigger}`

/** Trigger（到期的、不受豁免的那些）。 */
export const trigger = {
  deleteBefore: `DELETE FROM trigger WHERE id IN (${expiredTriggers})`
} as const

/**
 * Trigger–Thread 关联行：只有同样「到期且不受豁免」的 Trigger 的关联行跟着走（表上没有
 * 外键，这里显式级联）；豁免 Trigger 的关联行一并保留。谓词走 `trigger_thread_by_trigger`。
 *
 * 顺序：先删关联行、再删 Trigger。这一步只动不受豁免的那些，而豁免只看**该 Trigger 自己**
 * 的关联行与 Ticket，所以第二步重算谓词时判定不变。
 */
export const triggerThread = {
  deleteForOldTriggers: `DELETE FROM trigger_thread WHERE trigger_id IN (${expiredTriggers})`
} as const

/**
 * Disposition 不单独删：它靠 `ON DELETE CASCADE` 跟着 Trigger 走（豁免的 Trigger 被保留，
 * 它的 disposition 也就在）。这里只数一下「即将被级联删掉多少行」，让 health 明细说实话。
 */
export const disposition = {
  countBefore: `SELECT count(*) AS n FROM disposition WHERE trigger_id IN (${expiredTriggers})`
} as const

/**
 * 一条 Decision 是否属于仍 open 的 Thread/Ticket：它的 Thread 的订阅集合里还有未结束的
 * Ticket（与 Trigger 豁免同一条谓词，不新造状态）。
 */
const keptDecision = `EXISTS (
    SELECT 1 FROM thread th WHERE th.key = decision.thread_key AND ${openTicketSubscriber('th')})`

/** Decision：按决策时刻删，未结束 Ticket 的 Thread 上的不删。 */
export const decision = {
  deleteBefore: `DELETE FROM decision WHERE at < ? AND NOT ${keptDecision}`
} as const

/**
 * 已结算 Outbox：只删 `sent`/`dropped` 且 `settled_at` 早于阈值的行。
 * 谓词写成 `status <> 'pending'` 是为了让 `outbox_settled` 这个部分索引接得住
 * （`IN (...)` 在 SQLite 里不走该索引，§D.2 要点 2 的「只扫活行」同样适用于删除）。
 */
export const outboxSettled = {
  deleteBefore: "DELETE FROM outbox WHERE status <> 'pending' AND settled_at IS NOT NULL AND settled_at < ?"
} as const

/** 版本快照族：KV 里 `settings-version:<n>` / `prompt-version:<n>` 的旧快照。 */
export const versionSnapshots = {
  settingsPrefix: VERSION_SNAPSHOT_PREFIXES.settings,
  promptPrefix: VERSION_SNAPSHOT_PREFIXES.prompt,
  /** 全部版本快照：键、版本号、快照自带时刻（由调用方按阈值与「是否当前」过滤）。 */
  selectSnapshots:
    "SELECT key, CAST(substr(key, instr(key, ':') + 1) AS INTEGER) AS version, " +
    "json_extract(value, '$.at') AS at FROM kv " +
    `WHERE key LIKE '${VERSION_SNAPSHOT_PREFIXES.settings}%' ` +
    `OR key LIKE '${VERSION_SNAPSHOT_PREFIXES.prompt}%'`,
  deleteOne: 'DELETE FROM kv WHERE key = ?'
} as const

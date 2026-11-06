// 保留策略的 SQL（§D.2 要点 5）。与 `store-read.ts` 一样，把 SQL 文本集中一处，
// 让 `retention.ts` 只管顺序与明细，测试只需断言「删了什么」。
//
// 三条不删规则在 SQL 里就成立：
// - Trigger/Disposition/Decision 只按 `at` 早于阈值删，不碰 Ticket/Thread 表；
// - Outbox 只删「已结算」（sent/dropped）且结算时间早于 30 天的行；
// - 版本快照族只删早于阈值的 `settings-version:*` / `prompt-version:*`（当前版本由调用方排除）。
import { VERSION_SNAPSHOT_PREFIXES } from './kv'

/** Trigger 与它的关联行（`trigger_thread` 无外键，按时间显式删）。 */
export const trigger = {
  deleteBefore: 'DELETE FROM trigger WHERE at < ?'
} as const

/**
 * Trigger–Thread 关联行：Trigger 被删时它的关联行必须一起走（表上没有外键，
 * 这里显式级联）。谓词走 `trigger_thread_by_trigger`，不扫关联表。
 */
export const triggerThread = {
  deleteForOldTriggers:
    'DELETE FROM trigger_thread WHERE trigger_id IN (SELECT id FROM trigger WHERE at < ?)'
} as const

/**
 * Disposition 不单独删：它靠 `ON DELETE CASCADE` 跟着 Trigger 走。
 * 这里只数一下「即将被级联删掉多少行」，让 health 明细说实话。
 */
export const disposition = {
  countBefore: 'SELECT count(*) AS n FROM disposition WHERE trigger_id IN (SELECT id FROM trigger WHERE at < ?)'
} as const

/** Decision：按决策时刻删。 */
export const decision = {
  deleteBefore: 'DELETE FROM decision WHERE at < ?'
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

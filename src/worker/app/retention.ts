// 保留策略基线（§D.2 要点 5–6）：按阈值删旧记录；未结束 Ticket 与其 Thread 永不清理；
// 删除前写一条健康明细（`pruned: …`），不静默。
//
// 阈值：Trigger / Disposition / Decision 默认 90 天；已结算（sent/dropped）Outbox 30 天。
// 版本快照族只删「非当前」的旧快照（当前 = `settings-revision` / `prompt-revision` 指向的版本）。
//
// `trigger_thread` 没有外键（关联表两侧都可先出现），所以清理 Trigger 时显式删它的关联行；
// Disposition 靠 `ON DELETE CASCADE` 跟着走，明细里的数量是「级联会带走多少」的预读数。
// 哪些行算「到期」由 `retention-sql.ts` 的豁免谓词决定：未结束 Ticket 的 Thread 上的
// Trigger/Decision（及其关联行）不删，见 #63。
import { SILENT_LOG, type LogSink } from '../infra/log-line'
import { LAST_PRUNE_KEY, PROMPT_REVISION_KEY, SETTINGS_REVISION_KEY } from './kv'
import {
  decision,
  disposition,
  outboxSettled,
  trigger,
  triggerThread,
  versionSnapshots
} from './retention-sql'
import type { Store } from './store'

/** 保留阈值（天）。§D.2 要点 5：`retention.days` 默认 90；已结算 Outbox 30 天。 */
export interface RetentionPolicy {
  readonly days: number
  readonly outboxDays: number
}

/** 设计基线（设置项接上之前，这就是默认值）。 */
export const DEFAULT_RETENTION: RetentionPolicy = { days: 90, outboxDays: 30 }

/** 维护 pass 每天一次（§D.2 要点 5）。 */
export const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000

/** 各表实际删掉的行数（Disposition 是级联预读数）。 */
export interface PrunedCounts {
  readonly triggers: number
  readonly dispositions: number
  readonly triggerThreads: number
  readonly decisions: number
  readonly outbox: number
  readonly versionSnapshots: number
}

/** 一次保留 pass 的结果。 */
export interface PruneResult {
  readonly at: string
  readonly cutoff: string
  readonly outboxCutoff: string
  readonly pruned: PrunedCounts
  /** 写进 health detail 的那一行（`pruned: …`）。 */
  readonly detail: string
  readonly total: number
}

/** 保留 pass 的输入。 */
export interface PruneOptions {
  readonly policy?: RetentionPolicy
  readonly now?: () => Date
  readonly log?: LogSink
}

/**
 * 执行一次保留 pass（单事务）：删旧行 → 写 health 明细 → 记 `last-prune`。
 * `detail` 同时交给 health 看板（§N.4 的明细行）。
 */
export function prune(store: Store, options: PruneOptions = {}): PruneResult {
  const policy = options.policy ?? DEFAULT_RETENTION
  const now = options.now ?? (() => new Date())
  const log = options.log ?? SILENT_LOG
  const at = now().toISOString()
  const cutoff = isoDaysBefore(at, policy.days)
  const outboxCutoff = isoDaysBefore(at, policy.outboxDays)

  const result = store.transaction((): PruneResult => {
    const dispositions = Number(field(store.sql.all(disposition.countBefore, [cutoff])[0], 'n'))
    const triggerThreads = store.sql.run(triggerThread.deleteForOldTriggers, [cutoff])
    const triggers = store.sql.run(trigger.deleteBefore, [cutoff])
    const decisions = store.sql.run(decision.deleteBefore, [cutoff])
    const outbox = store.sql.run(outboxSettled.deleteBefore, [outboxCutoff])
    const versionSnapshots = pruneVersionSnapshots(store, cutoff)

    const pruned: PrunedCounts = {
      triggers,
      dispositions,
      triggerThreads,
      decisions,
      outbox,
      versionSnapshots
    }
    const total = Object.values(pruned).reduce((sum, count) => sum + count, 0)
    const detail = formatPruneDetail(pruned, policy, cutoff)
    store.kvSet(LAST_PRUNE_KEY, { at, cutoff, outboxCutoff, pruned, detail })
    return { at, cutoff, outboxCutoff, pruned, detail, total }
  })

  // 不静默：明细同时进日志（§N.5）与 `last-prune`（面板健康明细读它）。
  log({ ts: at, level: 'info', msg: result.detail, fields: { pruned: result.total } })
  return result
}

/** 是否到了下一次维护 pass（每天一次；`last-prune` 缺失即到期）。 */
export function pruneDue(store: Store, now: () => Date = () => new Date()): boolean {
  const last = store.kvGet<{ at?: string }>(LAST_PRUNE_KEY)
  if (last === null || typeof last.at !== 'string') return true
  return now().getTime() - new Date(last.at).getTime() >= PRUNE_INTERVAL_MS
}

/** 版本快照族里删掉「非当前」的旧快照，返回删除条数。 */
function pruneVersionSnapshots(store: Store, cutoff: string): number {
  const currentSettings = store.kvGet<number>(SETTINGS_REVISION_KEY)
  const currentPrompt = store.kvGet<number>(PROMPT_REVISION_KEY)
  let removed = 0
  for (const row of store.sql.all(versionSnapshots.selectSnapshots, [])) {
    const key = String(field(row, 'key'))
    const version = Number(field(row, 'version'))
    const at = String(field(row, 'at') ?? '')
    // 判不出年龄的快照不删：宁可留，也不误删。
    if (at === '' || at >= cutoff) continue
    const isCurrent =
      (key.startsWith(versionSnapshots.settingsPrefix) && version === currentSettings) ||
      (key.startsWith(versionSnapshots.promptPrefix) && version === currentPrompt)
    if (isCurrent) continue
    store.sql.run(versionSnapshots.deleteOne, [key])
    removed += 1
  }
  return removed
}

/** health 明细行的固定形态（面板与日志都读它）。 */
function formatPruneDetail(pruned: PrunedCounts, policy: RetentionPolicy, cutoff: string): string {
  return (
    `pruned: triggers ${pruned.triggers}, dispositions ${pruned.dispositions}, ` +
    `trigger_threads ${pruned.triggerThreads}, decisions ${pruned.decisions}, ` +
    `outbox ${pruned.outbox}, versions ${pruned.versionSnapshots} ` +
    `(retention ${policy.days}d, outbox ${policy.outboxDays}d, before ${cutoff})`
  )
}

/** `at` 往前 `days` 天的 ISO 文本（文本比较即时间比较）。 */
export function isoDaysBefore(at: string, days: number): string {
  return new Date(new Date(at).getTime() - days * 24 * 60 * 60 * 1000).toISOString()
}

/** 从 null 原型行里取字段。 */
function field(row: unknown, name: string): unknown {
  if (typeof row !== 'object' || row === null) return undefined
  return (row as Record<string, unknown>)[name]
}

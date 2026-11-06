// 请求幂等（§G.1 幂等行）：所有写命令可带一个 `--request-id <id>`；同 id 一小时内重试
// 返回首次结果。对应上游「transport retries reuse the same trigger_id」。
//
// 存在 `kv` 里：`request-id:<tokenHash>:<requestId>` → `{at, result}`。键里带 token 的哈希，
// 于是两个调用者用同一个 id 不会互相顶掉；值里的 `at` 是首次执行的时刻，用来判一小时窗口。
//
// 纪律：**失败不缓存**——一次拒绝或内部错误在重试时应该有机会成功，否则「重试」这个动作
// 本身就没有意义（HTTP 层的 429/超时重试尤其如此）。
import { REQUEST_ID_PREFIX, requestIdKey } from '../app/kv'
import type { Store } from '../app/store'

/** 幂等窗口：一小时（§G.1 幂等行）。 */
export const IDEMPOTENCY_WINDOW_MS = 60 * 60 * 1000

/** 请求头（HTTP 侧）；CLI 侧对应 `--request-id`。 */
export const REQUEST_ID_HEADER = 'x-superagent-request-id'

/** 从请求头里取 request id；空串与缺失等价（都是「没有 id」）。 */
export function requestIdOf(headers: Readonly<Record<string, string | readonly string[] | undefined>>): string | null {
  const value = headers[REQUEST_ID_HEADER]
  if (value === undefined) return null
  const text = Array.isArray(value) ? (value[0] ?? '') : (value as string)
  return text.trim().length === 0 ? null : text
}

/** 一次幂等执行的结果：真的执行了，还是命中了首次结果。 */
export type IdempotentOutcome =
  | { readonly kind: 'ran'; readonly result: unknown }
  | { readonly kind: 'replayed'; readonly result: unknown }

/** `runIdempotent` 的返回值：`outcome` 给调用点，`recorded` 说明是否写了新记录。 */
export interface IdempotentRun {
  readonly outcome: IdempotentOutcome
  readonly requestId: string | null
}

/** 存在 kv 里的记录。 */
interface IdempotentRecord {
  readonly at: string
  readonly result: unknown
}

/** `runIdempotent` 的输入。 */
export interface IdempotentOptions<T> {
  readonly store: Store
  /** 调用者标识（token 的哈希，不是 token 原文）。 */
  readonly caller: string
  readonly requestId: string | null
  /** 本次请求的时刻（ISO-8601）。 */
  readonly at: string
  /** 真正的工作；**不要**在里面再开事务（调用方负责事务边界）。 */
  readonly run: () => T
}

/**
 * 幂等地跑一次写操作。
 *
 * - 没有 request id → 直接跑（`kind: 'ran'`）。
 * - 有 id 且一小时内已有记录 → 返回首次结果（`kind: 'replayed'`），不调用 `run`。
 * - 有 id 但记录过期/不存在 → 跑并把结果写进 kv。
 * - `run` 抛错 → 不写记录，错误原样上抛。
 *
 * 顺带清理过期记录：一次写入会把超过窗口的 `request-id:*` 行删掉，避免无界增长。
 */
export function runIdempotent<T>(options: IdempotentOptions<T>): IdempotentRun {
  const { store, caller, requestId, at, run } = options
  if (requestId === null) {
    return { outcome: { kind: 'ran', result: run() }, requestId: null }
  }

  const key = requestIdKey(caller, requestId)
  const existing = store.kvGet<IdempotentRecord>(key)
  if (existing !== null && withinWindow(existing.at, at)) {
    return { outcome: { kind: 'replayed', result: existing.result }, requestId }
  }

  const result = run()
  store.kvSet(key, { at, result } satisfies IdempotentRecord)
  pruneExpired(store, at)
  return { outcome: { kind: 'ran', result }, requestId }
}

/** 首次执行时刻是否还在窗口内。 */
function withinWindow(recordedAt: string, at: string): boolean {
  const elapsed = new Date(at).getTime() - new Date(recordedAt).getTime()
  // 时钟回拨（elapsed < 0）按「还在窗口内」处理：宁可返回首次结果，也不重放一次写。
  return elapsed <= IDEMPOTENCY_WINDOW_MS
}

/** 删掉超过窗口的幂等记录（只扫 `request-id:` 族；别的键不动）。 */
function pruneExpired(store: Store, at: string): void {
  const now = new Date(at).getTime()
  for (const key of store.kvKeys()) {
    if (!key.startsWith(REQUEST_ID_PREFIX)) continue
    const record = store.kvGet<IdempotentRecord>(key)
    if (record === null) continue
    if (now - new Date(record.at).getTime() > IDEMPOTENCY_WINDOW_MS) store.kvDelete(key)
  }
}

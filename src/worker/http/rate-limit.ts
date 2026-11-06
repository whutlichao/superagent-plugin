// 每 token 限流（§G.3 第 7 条）：60 req/min、burst 20；超限给 429 + `Retry-After`。
//
// 令牌桶：容量 20，速率 1 个/秒（60/min）。桶按 token 的**哈希**分（不把 token 原文当键，
// 免得它在内存 dump 里以明文出现，§O「secret 不落日志」）。时钟注入，测试不 sleep。
import { createHash } from 'node:crypto'

/** 每分钟允许的请求数（§G.1 限额行）。 */
export const RATE_LIMIT_PER_MINUTE = 60

/** 允许的突发量（§G.1 限额行）。 */
export const RATE_LIMIT_BURST = 20

/** 一次限流判定的结果。 */
export type RateLimitDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterMs: number }

/** 限流器：`take(key)` 消费一个令牌，`reset()` 清空所有桶（测试与重启用）。 */
export interface RateLimiter {
  take(key: string): RateLimitDecision
  reset(): void
}

/** 限流器的输入。 */
export interface RateLimiterOptions {
  /** 单调时钟（毫秒）；缺省用 `performance` 无关的 `Date.now` 语义由调用方注入。 */
  readonly now?: () => number
  readonly perMinute?: number
  readonly burst?: number
}

/** 一个桶的当前状态与最后一次被看到的时间（用于回收空闲桶，避免无界增长）。 */
interface Bucket {
  tokens: number
  updatedAt: number
}

/** 空闲超过这么久的桶直接丢弃：再被用到时必然是满桶，语义不变。 */
const IDLE_EVICTION_MS = 10 * 60 * 1000

/** 建一个令牌桶限流器。 */
export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const now = options.now ?? (() => Date.now())
  const perMinute = options.perMinute ?? RATE_LIMIT_PER_MINUTE
  const burst = options.burst ?? RATE_LIMIT_BURST
  const refillPerMs = perMinute / 60_000
  const buckets = new Map<string, Bucket>()

  const bucketFor = (key: string): Bucket => {
    const hashed = createHash('sha256').update(key).digest('hex').slice(0, 16)
    const at = now()
    const existing = buckets.get(hashed)
    if (existing === undefined) {
      const fresh: Bucket = { tokens: burst, updatedAt: at }
      buckets.set(hashed, fresh)
      return fresh
    }
    // 顺带回收：只在扫到自己时判断，成本 O(1)。
    if (at - existing.updatedAt > IDLE_EVICTION_MS) {
      existing.tokens = burst
      existing.updatedAt = at
      return existing
    }
    const refilled = Math.min(burst, existing.tokens + (at - existing.updatedAt) * refillPerMs)
    existing.tokens = refilled
    existing.updatedAt = at
    return existing
  }

  return {
    take(key: string): RateLimitDecision {
      const bucket = bucketFor(key)
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1
        return { allowed: true }
      }
      // 还差多少才攒够一个令牌：向上取整到毫秒，至少 1 ms（不让调用方忙等）。
      const missing = 1 - bucket.tokens
      return { allowed: false, retryAfterMs: Math.max(1, Math.ceil(missing / refillPerMs)) }
    },
    reset(): void {
      buckets.clear()
    }
  }
}

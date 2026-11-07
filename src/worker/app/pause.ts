// 处理暂停（§K.6、§N.1「暂停」行、§G.2 的 `pause` / `resume`）。
//
// `paused` 是独立设置（不是 Policy 字段，不改变 Policy version）：暂停期间 Source 继续记录
// Trigger，但派发、新 Eval、Input 投递与 reply 都停下（各自由自己的写者读这个值）。
//
// 本模块是它的**唯一读写处**（kv 的单键 `pause-state`，键字面量在 `app/kv.ts` 命名）：
// - 写：`setPaused(paused, at)` 记 `{paused, at, origin}`；origin 目前恒为 `operator`
//   （面板的暂停按钮与 CLI 的 `pause`/`resume` 都算人）；
// - 读：`paused()` 与 `pausedAt()`（§K.6：恢复时 Eval deadline 要后移「暂停时长」）。
//
// 设置的版本化块（§K.8、#25/#42）落地后，这里换成写那个块即可；调用方只看到
// `PausedState` 端口，接线不变。
import { PAUSE_STATE_KEY } from './kv.ts'
import type { Store } from './store.ts'

/** 暂停状态的写者（谁改的）。§K.8 的 origin：目前只有人（面板/CLI）。 */
export type PauseOrigin = 'operator'

/** 落库的记录形状。 */
export interface PauseRecord {
  readonly paused: boolean
  /** 最近一次改动时刻（ISO-8601）；也是 §K.6 的 `pausedAt`。 */
  readonly at: string
  readonly origin: PauseOrigin
}

/** 一次暂停/恢复的结果：改后的记录，以及这次是否真的变了（幂等：重复设置同值不改 `at`）。 */
export interface PauseOutcome {
  readonly record: PauseRecord
  readonly changed: boolean
}

/** 暂停状态端口（HTTP 的 `paused()`、`pause`/`resume` 命令与后续的 Eval 计时都读它）。 */
export interface PausedState {
  paused(): boolean
  /** 进入暂停的时刻；从未暂停或已恢复时为 `null`（§K.6 的「暂停时长」）。 */
  pausedAt(): string | null
  /** 当前记录（含 origin 与时刻）；从未写过时为「未暂停」的缺省记录。 */
  record(): PauseRecord
  /** 设置暂停；同值重复设置不改变 `at`（幂等，返回值里的 `changed` 为 false）。 */
  setPaused(paused: boolean, at: string, origin?: PauseOrigin): PauseOutcome
}

/** 未暂停的缺省记录（`at` 用调用方给的时刻，保持「时间字段总有值」）。 */
export function notPaused(at: string): PauseRecord {
  return { paused: false, at, origin: 'operator' }
}

/**
 * 在真库上实现暂停状态。每次读写都过 kv（不缓存）：于是同一个进程里多个部件看到的
 * 永远是同一份值，重启后也还在。
 */
export function createPausedState(
  store: Store,
  now: () => string = () => new Date().toISOString()
): PausedState {
  const read = (): PauseRecord => {
    try {
      const stored = store.kvGet<PauseRecord>(PAUSE_STATE_KEY)
      if (stored !== null && typeof stored.paused === 'boolean' && typeof stored.at === 'string') {
        return { paused: stored.paused, at: stored.at, origin: 'operator' }
      }
    } catch {
      // 库刚打开/正在关闭：当作「未暂停」，不让状态栏因为一次读失败而挂掉。
    }
    return notPaused(now())
  }
  return {
    paused: () => read().paused,
    pausedAt: () => {
      const record = read()
      return record.paused ? record.at : null
    },
    record: read,
    setPaused(paused: boolean, at: string, origin: PauseOrigin = 'operator'): PauseOutcome {
      const current = read()
      if (current.paused === paused) return { record: current, changed: false }
      const record: PauseRecord = { paused, at, origin }
      store.kvSet(PAUSE_STATE_KEY, record)
      return { record, changed: true }
    }
  }
}

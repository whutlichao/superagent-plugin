// worker 侧的读模型端口：面板壳只经 `src/panel/protocol.ts` 的 `state` 请求读它。
// 本票交付一个桩实现（计数恒为 0、`booted: true`），真实读数由领域与执行器票
// （#9、#11、#28）接上同一个形状；因此面板、状态栏与 Overview 说的是同一件事。
//
// 依赖纪律（§C.2）：这里只依赖面板的协议类型，不 import `orca`、不 host.call、不做 I/O。
import type { PanelState } from '../../panel/protocol'

/** 一份快照的来源：读当前值，改暂停状态。每改一次，修订号加一（§M.6 的单调计数）。 */
export interface PanelStateSource {
  snapshot(): PanelState
  /** 设置 `paused` 并返回改后的快照（修订号已加一）。 */
  setPaused(paused: boolean): PanelState
  /** 订阅「状态变了」：调用方据此向面板推送并更新状态栏。 */
  onChange(listener: () => void): () => void
}

/** 空快照：没有待人工、没有错误、没有暂停、流水与负载都是零。 */
export function emptyState(revision = 1): PanelState {
  return {
    revision,
    booted: true,
    health: {
      error: false,
      paused: false,
      setupMissing: false,
      activity: { received: 0, evaluated: 0, accepted: 0, ignored: 0, ended: 0 },
      executor: { running: 0, maxWorkers: 4 }
    },
    attention: { answer: 0, review: 0, problems: 0, items: [] }
  }
}

/**
 * 本票的桩：一个恒定的空快照，只有 `paused` 会变。它让「面板问得到快照、状态栏按快照更新、
 * 暂停后推送 `state.changed`」这三条线现在就能跑通，而不是等真实计数到位才接。
 */
export function createStubStateSource(initial: PanelState = emptyState()): PanelStateSource {
  let current = initial
  const listeners = new Set<() => void>()
  const changed = (next: PanelState): PanelState => {
    current = next
    for (const listener of listeners) listener()
    return current
  }
  return {
    snapshot: () => current,
    setPaused(paused: boolean): PanelState {
      if (current.health.paused === paused) return current
      return changed({
        ...current,
        revision: current.revision + 1,
        health: { ...current.health, paused }
      })
    },
    onChange(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

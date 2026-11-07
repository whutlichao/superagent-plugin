// Overview 页的纯逻辑（§M.2 ①–④）：待人工行的阶段顺序、系统问题归谁管。
//
// 纯函数：不 import `orca`，也不碰 worker（§C.2 规则 3）。排序与归属判定在测试里单独钉，
// 页面只负责把结果画出来。
import type { AttentionItem, NavPage, SystemProblem } from './protocol'

/**
 * §E.8 的 person 档顺序（表里自上而下）：投递失败 → 待回答 → 待评审 → 阻塞 → 失败。
 * 「按 stage 排序」就是这个顺序；同一档里新的在前（`at` 降序），`id` 兜底保证顺序稳定。
 */
const STAGE_ORDER = ['delivery', 'answer', 'review', 'blocked', 'failed'] as const

/** 一个待人工动作在阶段顺序里的位置（0 最靠前）。 */
export function stageRank(action: AttentionItem['action']): number {
  const rank = (STAGE_ORDER as readonly string[]).indexOf(action)
  return rank === -1 ? STAGE_ORDER.length : rank
}

/** 待人工按阶段排序（同阶段内 `at` 降序、`id` 升序）。 */
export function orderWaiting(items: readonly AttentionItem[]): readonly AttentionItem[] {
  return [...items].sort(
    (left, right) =>
      stageRank(left.action) - stageRank(right.action) ||
      right.at - left.at ||
      left.id.localeCompare(right.id)
  )
}

/**
 * 系统问题归属的页面（§M.2「点行→对应详情页」）：
 * `health` 的条目在 Settings 的 Deployment 组（§M.3 的 health 明细），
 * `reply` 的去处在 Source 页（§J.1 的 outbox 按 Source/Channel 分组），
 * `unavailable` 的决定在 Eval 页（§K.7 的 dismiss 与重试都在那里）。
 */
export function problemPage(problem: SystemProblem): NavPage {
  switch (problem.kind) {
    case 'health':
      return 'settings'
    case 'reply':
      return 'source'
    default:
      return 'eval'
  }
}

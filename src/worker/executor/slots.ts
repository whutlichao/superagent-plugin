// worker slots（§E.6）：普通槽按 `maxWorkers` 计，另有一个只能由人的唤醒占用的人类槽。
//
// 计数口径是设计原文：`pending` + `running` 的 Assignment 数量（已结束的 Ticket 与已结束的
// Assignment 不算）。为什么需要人类槽：人的一次唤醒（人的消息触发的 wake，或 CLI
// `ticket request-status`）不该被两个跑着的 worker 挡住；而新的自动 launch 不该挤进来。
//
// 本文件是纯函数：只读 Ticket 聚合，不写、不 I/O（§C.2：executor → core）。
import { latestAssignment } from '../core/model.ts'
import type { Ticket } from '../core/model.ts'

/** `executor.maxWorkers` 的缺省值（§E.6：两个普通槽）。 */
export const DEFAULT_MAX_WORKERS = 2

/** 人类槽的数量：固定一个（§E.6「另有一个人类槽」）。 */
export const HUMAN_SLOTS = 1

/** 当前占用的槽：`occupied = pending + running`。 */
export interface SlotCounts {
  readonly running: number
  readonly pending: number
  readonly occupied: number
}

/** 人类槽是否已被占用（面板单列它，§E.6 末行）。 */
export type HumanSlot = 'free' | 'used'

/** 一次完整的槽读数：计数 + 上限 + 人类槽。 */
export interface SlotState extends SlotCounts {
  readonly maxWorkers: number
  readonly humanSlot: HumanSlot
}

/** 面板负载读数的形状（`running / maxWorkers`，人类槽单列）。 */
export interface LoadReadout {
  readonly running: number
  readonly maxWorkers: number
  readonly humanSlot: HumanSlot
}

/** 按最新 Assignment 的状态统计占用的槽（§E.6 计数口径）。 */
export function countSlots(tickets: readonly Ticket[]): SlotCounts {
  let running = 0
  let pending = 0
  for (const ticket of tickets) {
    if (ticket.ended) continue
    const assignment = latestAssignment(ticket)
    if (assignment?.state === 'running') running += 1
    else if (assignment?.state === 'pending') pending += 1
  }
  return { running, pending, occupied: running + pending }
}

/** 槽读数：人类槽在 `occupied > maxWorkers` 时算已占用（那多出来的一个就是它）。 */
export function slotState(tickets: readonly Ticket[], maxWorkers: number): SlotState {
  const counts = countSlots(tickets)
  const capacity = maxWorkers + HUMAN_SLOTS
  return {
    ...counts,
    maxWorkers,
    humanSlot: counts.occupied >= capacity ? 'used' : 'free'
  }
}

/**
 * 能不能起一个新的 worker：普通 launch 只看普通槽；人的唤醒可以占人类槽。
 * 没有槽时调用方抛 `Later`（§J.2：不算失败、到期再来）。
 */
export function mayLaunch(
  tickets: readonly Ticket[],
  maxWorkers: number,
  human: boolean
): boolean {
  const { occupied } = countSlots(tickets)
  return human ? occupied < maxWorkers + HUMAN_SLOTS : occupied < maxWorkers
}

/**
 * 能不能把一条 Input 唤醒给已经在跑的 worker（`occupied` 是当前占用数，含这张 Ticket）。
 * 唤醒**不新增**槽——它自己就是已占用的那一个；这里只守住「普通 + 人类」的绝对容量，
 * 超过说明账已经不平，先等（§E.6「deliver 唤醒也要占槽」的执行形式）。
 */
export function mayWake(occupied: number, maxWorkers: number): boolean {
  return occupied <= maxWorkers + HUMAN_SLOTS
}

/** 面板 Overview 的「Executor load」：运行数/上限，人类槽单列（§E.6 末行、§M.2）。 */
export function loadReadout(tickets: readonly Ticket[], maxWorkers: number): LoadReadout {
  const state = slotState(tickets, maxWorkers)
  return { running: state.running, maxWorkers, humanSlot: state.humanSlot }
}

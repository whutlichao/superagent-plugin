// 效果队列的测试夹具（§P.1「真库 + 注入的虚拟时钟」）：每个用例一个临时状态目录、
// 一个真 `HealthBoard`、一个由测试推进的虚拟时钟，绝不 sleep。
import { HealthBoard } from '../../src/worker/infra/health'
import { Effects } from '../../src/worker/app/effects'
import { openTempStore } from './state'

/** 虚拟时钟的起点（与 `tests/support/state.ts` 的 `AT` 同一时刻）。 */
export const CLOCK_START = Date.parse('2026-11-07T03:26:00.000Z')

/** 测试推进的时钟：`now()` 给毫秒，`advance()` 前进，`iso()` 给库里用的 ISO 文本。 */
export interface VirtualClock {
  now(): number
  advance(milliseconds: number): void
  iso(): string
}

/** 造一个从固定时刻起步的虚拟时钟。 */
export function createClock(start = CLOCK_START): VirtualClock {
  let at = start
  return {
    now: () => at,
    advance: (milliseconds: number) => {
      at += milliseconds
    },
    iso: () => new Date(at).toISOString()
  }
}

/** 一套可用的队列夹具：真库、真看板、虚拟时钟、队列本体、可翻转的开关，以及清理函数。 */
export interface QueueHarness {
  readonly store: ReturnType<typeof openTempStore>['store']
  readonly stateDir: string
  readonly board: HealthBoard
  readonly clock: VirtualClock
  readonly effects: Effects
  readonly controls: QueueControls
  cleanup(): void
}

/**
 * 夹具的可调开关：暂停、空闲 worker slot 数（`launch` 的并发上限，§E.6）。
 * 都是可改写的读数，测试在途中翻转取值，观察队列的下一轮派发。
 */
export interface QueueOptions {
  readonly paused?: boolean
  readonly slots?: number
}

/** 在临时状态目录上打开真库并装好效果队列（队列已 `start()`）。 */
export function openQueue(options: QueueOptions = {}): QueueHarness {
  const opened = openTempStore()
  const board = new HealthBoard()
  const clock = createClock()
  const state = { paused: options.paused ?? false, slots: options.slots ?? 4 }
  const effects = new Effects({
    store: opened.store,
    health: board,
    now: () => clock.now(),
    paused: () => state.paused,
    slots: () => state.slots
  })
  effects.start()
  return {
    ...opened,
    board,
    clock,
    effects,
    controls: {
      pause: (paused: boolean) => {
        state.paused = paused
      },
      setSlots: (slots: number) => {
        state.slots = slots
      }
    },
    cleanup: opened.cleanup
  }
}

/** 让测试翻转夹具的开关（暂停、slot 数）。 */
export interface QueueControls {
  pause(paused: boolean): void
  setSlots(slots: number): void
}

/** 一个可以手动放行的闸门：让 handler 停在中间，测试据此观察「运行中」的行为。 */
export interface Gate {
  readonly opened: Promise<void>
  open(): void
}

/** 造一个默认关着、`open()` 后放行的闸门。 */
export function createGate(): Gate {
  let release: (() => void) | undefined
  const opened = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    opened,
    open: () => {
      release?.()
    }
  }
}

/**
 * 轮询到条件成立（§P.1 第 4 条：不 sleep，轮询带上限）。用于「等队列派发起步」这种
 * 需要让出微任务、但不该等 `idle()`（它要等所有任务结束）的观察点。
 */
export async function until(check: () => boolean, turns = 200): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (check()) return
    await Promise.resolve()
  }
  if (!check()) throw new Error(`condition did not hold within ${turns} microtask turns`)
}


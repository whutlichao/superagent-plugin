// 30 分钟后台工作（§E.9 的近似）：Orca 插件看不到 agent 内部还在跑什么，所以只做三件事——
// 记一个起点、到点发一条收尾指令、在 Ticket 上标一个「后台工作超过 30 分钟」的标记。
// 永不杀进程（做不到），也不假装知道 job 的细节。
//
// 时序（§E.9 逐条）：
// 1. `report(progress)` 或 `report(ready)` 之后 agent 又 `working` → 记 `since = now`；
// 2. 到 30 分钟：`sendText` 一条收尾指令（报告还在跑什么、停掉可停的、用 `report waiting`
//    结束本轮），并标记 `expired = true`；
// 3. 人写的消息，或 agent 回到 `waiting` → 清标记。
//
// 标记是执行器的读模型（面板经 `state()` 读），不是领域状态：设计里它是 `backgroundSince`
// / `backgroundExpired` 两个执行器变量，Ticket 自己的状态仍由 §E.8 的 stage 表决定。
import type { AgentState, Ticket } from '../core/model.ts'
import { latestAssignment, liveTicket, runningAssignment } from '../core/model.ts'
import type { OrcaRuntime } from '../runtime/orca-runtime.ts'

/** 后台工作的预算：30 分钟（§E.9）。 */
export const BACKGROUND_LIMIT_MS = 30 * 60 * 1000

/** 到点发给 worker 的收尾指令（§E.9 第 2 步 a 的原文，单行）。 */
export const WRAP_UP_INSTRUCTION =
  'Background work has run past 30 minutes. Wrap up: report what is still running, stop what can be stopped, and end this turn with `report waiting`.'

/** 一个 Ticket 上的后台工作标记（面板读它）。 */
export interface BackgroundState {
  readonly since: number
  readonly expired: boolean
}

/** 后台计时要看的两样东西：Ticket 的最近报告，以及终端（发收尾指令）。 */
export interface BackgroundRecords {
  readonly tickets: {
    get(id: string): Ticket | undefined
  }
}

/** 后台计时的依赖：仓储读口、seam、注入的时钟与日志。 */
export interface BackgroundOptions {
  readonly records: BackgroundRecords
  readonly runtime: OrcaRuntime
  readonly now: () => number
  readonly log?: (message: string) => void
}

/** 面板与状态处理器看到的接口。 */
export interface BackgroundTracker {
  /** agent 状态事件：`working` 记起点，`waiting`/`done` 清标记。 */
  observed(ticketId: string, state: AgentState): void
  /** 到期检查：到点发一条收尾指令并标记过期；不杀进程。 */
  poll(): Promise<void>
  /** 一个 Ticket 现在的标记；没有、已清或 Ticket 已结束时是 `undefined`。 */
  state(ticketId: string): BackgroundState | undefined
  /** 关停：清掉所有标记，之后 `poll` 什么都不发。 */
  stop(): void
}

/** 一行失败说明（日志用）。 */
function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

/**
 * 人在 `since`（含同一毫秒）之后写过消息没有：写了就说明这一轮是人的，不再是后台工作。
 * 同一毫秒算「之后」：人的消息与 `working` 事件的时刻精度都只到毫秒，按事件顺序推断更诚实。
 */
function personSpokeSince(ticket: Ticket, since: number): boolean {
  return ticket.inputs.some((input) => {
    if (input.kind === 'resumed') return Date.parse(input.at) >= since
    return input.kind === 'trigger' && input.human === true && Date.parse(input.at) >= since
  })
}

/**
 * 建后台计时器。起点只在「progress/ready 报告之后 agent 又 working」时记；重复的 `working`
 * 事件保留原来的起点（同一段后台工作只计一次 30 分钟）。
 */
export function createBackgroundTracker(options: BackgroundOptions): BackgroundTracker {
  const log = options.log ?? (() => undefined)
  const marks = new Map<string, BackgroundState>()
  let stopped = false

  /** 标记还成立吗：Ticket 还开着，且此后没有人写过消息。 */
  const current = (ticketId: string): BackgroundState | undefined => {
    const entry = marks.get(ticketId)
    if (entry === undefined) return undefined
    const ticket = options.records.tickets.get(ticketId)
    if (ticket === undefined || !liveTicket(ticket) || personSpokeSince(ticket, entry.since)) {
      marks.delete(ticketId)
      return undefined
    }
    return entry
  }

  const clear = (ticketId: string): void => {
    marks.delete(ticketId)
  }

  return {
    observed(ticketId: string, state: AgentState): void {
      if (stopped) return
      const ticket = options.records.tickets.get(ticketId)
      if (ticket === undefined || !liveTicket(ticket)) {
        clear(ticketId)
        return
      }
      // 人回来、或 agent 自己停下来：这一段后台工作结束了（§E.9 第 3 步）。
      if (state === 'waiting' || state === 'done') {
        clear(ticketId)
        return
      }
      const existing = current(ticketId)
      if (existing !== undefined) return
      // 只有 `progress`/`ready` 之后又 `working` 才是后台工作（§E.9 第 1 步）。
      if (state !== 'working') return
      const report = latestAssignment(ticket)?.report?.state
      if (report !== 'progress' && report !== 'ready') return
      marks.set(ticketId, { since: options.now(), expired: false })
    },

    async poll(): Promise<void> {
      if (stopped) return
      const now = options.now()
      for (const ticketId of [...marks.keys()]) {
        const mark = current(ticketId)
        if (mark === undefined || mark.expired) continue
        if (now - mark.since < BACKGROUND_LIMIT_MS) continue
        // 先标记再发：发送失败也不在下一轮重复催，面板仍如实显示「超过 30 分钟」。
        marks.set(ticketId, { since: mark.since, expired: true })
        const ticket = options.records.tickets.get(ticketId)
        const terminalId = ticket === undefined ? undefined : runningAssignment(ticket)?.terminalId
        if (terminalId === undefined) {
          log(`background work on ${ticketId} expired with no terminal to tell`)
          continue
        }
        try {
          await options.runtime.sendText(terminalId, WRAP_UP_INSTRUCTION, { enter: true })
          log(`background work on ${ticketId} passed 30 minutes; wrap-up sent to ${terminalId}`)
        } catch (error) {
          log(`could not send the wrap-up to ${terminalId}: ${messageOf(error)}`)
        }
      }
    },

    state(ticketId: string): BackgroundState | undefined {
      if (stopped) return undefined
      return current(ticketId)
    },

    stop(): void {
      stopped = true
      marks.clear()
    }
  }
}

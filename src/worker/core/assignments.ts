// Assignments：执行器与 worker 报告上来的 Assignment 事实——启动、Input 送达或失败、会话
// 取走 Input、一轮结束、主机重启打断，以及 worker 的报告与它给人的问题（§E.3、§E.8）。
import { UserError } from './errors.ts'
import { key } from './ids.ts'
import { latestAssignment, liveTicket, runningAssignment } from './model.ts'
import type { ReportState, Ticket } from './model.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import type { Replies } from './replies.ts'
import { automatic, type Tickets } from './tickets.ts'

/** 一个 Assignment 报告的内容：worker 的报告，或执行器自己的（空闲一轮后 `waiting`、出错后 `failed`）。 */
export interface WorkerReport {
  state: ReportState
  summary: string
  /** 给人提的问题：字符串提问，`null` 清掉当前问题，`undefined` 保留当前问题。 */
  question?: string | null
  /** 提出该问题的人的消息；把问题送回它被写下的会话。 */
  askedBy?: string
  /** 这份报告回答的人的问题；worker 由此接手它，并授权主 Session 发送回答。 */
  answers?: string
  /** 这份报告来自终端而非 worker 自己：Orca agent 的 `blocked` 状态转成的 Attention（§E.7）。 */
  via?: 'terminal'
}

/**
 * 执行器在「启动成功」时一并报上来的执行事实（§E.1–§E.3）。终端句柄是 Assignment 的外部
 * 身份（§D.1），worktree 的目录、短名与作业文本是 `ticket.execution` 的三项。分开是因为
 * 内核（#9）先落地了状态迁移、把执行事实留给执行器票（#11）补齐；缺哪一项就不写哪一项，
 * 不拿空串假装已知。
 */
export interface AssignmentLaunch {
  /** Orca agent 终端句柄（`term_…`）。 */
  readonly terminalId?: string
  /** 建好（或复用）的 worktree 与交给 worker 的作业文本。 */
  readonly workspace?: {
    readonly short: string
    readonly directory: string
    readonly assignment: string
  }
}

/**
 * 重建 Assignment 时投递的恢复说明里的核心指令（§E.5 retry、§E.10 restart）：先看现场，
 * 别重复已做的外部动作。原因由调用方拼在最前面，指令只写一次。
 */
export const RECOVERY_INSTRUCTION =
  'Inspect the current worktree, git history and GitHub state before continuing. Do not repeat an already completed external operation. Finish the original assignment and report its status.'

/** 主机重启打断 Assignment 时投递的恢复说明。 */
const RECOVERY_NOTE = `The host restarted during this ticket. ${RECOVERY_INSTRUCTION}`

/**
 * Assignments 记录执行器与 worker 对运行 Ticket 的 Assignment 说过的话：一个启动了、Input
 * 到达或失败、会话取走了 Input、一轮结束、主机重启打断、以及 worker 的报告与它给人的问题。
 * 它依赖 Tickets 重启或结束 Ticket、依赖 Replies 撤回被替换的问题。
 */
export class Assignments extends EnginePart {
  private readonly tickets: Tickets
  private readonly replies: Replies

  constructor(options: EngineOptions, tickets: Tickets, replies: Replies) {
    super(options)
    this.tickets = tickets
    this.replies = replies
  }

  /**
   * 把一个未结束的 Assignment 标为 running，并给未结束的 Ticket 排队投递等待中的 Input，
   * 然后发出 `assignment.started`。
   */
  started(ticketId: string, assignmentId: string, launch?: AssignmentLaunch): void {
    const ticket = this.require(ticketId)
    const assignment = ticket.assignments.find((item) => item.id === assignmentId)
    if (!assignment || assignment.state === 'ended') return
    assignment.state = 'running'
    assignment.startedAt ??= this.now()
    if (launch?.terminalId !== undefined) assignment.terminalId = launch.terminalId
    if (launch?.workspace !== undefined) {
      ticket.execution = {
        name: launch.workspace.short,
        directory: launch.workspace.directory,
        assignment: launch.workspace.assignment
      }
    }
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
    if (liveTicket(ticket) && ticket.undelivered.length) {
      this.options.executor.deliver(ticket, assignment)
    }
    this.emit('assignment.started', { ticketId, assignmentId })
  }

  /**
   * 记下 `inputIds` 已送达该 Ticket 运行中的 Assignment，并清掉此前的投递失败；已不再运行
   * 时忽略。
   */
  delivered(ticketId: string, assignmentId: string, inputIds: string[]): void {
    const ticket = this.running(ticketId, assignmentId)
    if (!ticket) return
    ticket.undelivered = ticket.undelivered.filter((id) => !inputIds.includes(id))
    ticket.updatedAt = this.now()
    runningAssignment(ticket)!.deliveredAt = ticket.updatedAt
    for (const input of ticket.inputs) {
      if (input.kind === 'trigger' && inputIds.includes(input.id)) {
        input.readAt ??= null
        input.deliveredTo = assignmentId
      }
    }
    delete ticket.delivery
    this.repo.tickets.save(ticket)
  }

  /** 记下未结束 Ticket 的 worker 会话把 `inputIds` 取进了某一步，从那一刻起它的模型读到它们。 */
  read(ticketId: string, inputIds: string[]): void {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) return
    for (const input of ticket.inputs) {
      if (input.kind === 'trigger' && inputIds.includes(input.id)) input.readAt ||= this.now()
    }
    this.repo.tickets.save(ticket)
  }

  /** worker 的一轮结束了（报告之后也算）。 */
  turnEnded(ticketId: string, assignmentId: string): void {
    const ticket = this.running(ticketId, assignmentId)
    if (!ticket) return
    runningAssignment(ticket)!.idleAt = this.now()
    this.repo.tickets.save(ticket)
  }

  /** 把 Input 投递给运行中的 Assignment 失败了；Ticket 一直显示它，直到一次投递成功。 */
  deliveryFailed(ticketId: string, assignmentId: string, error: string): void {
    const ticket = this.running(ticketId, assignmentId)
    if (!ticket) return
    ticket.delivery = { error: error.slice(0, 300), at: this.now() }
    this.repo.tickets.save(ticket)
  }

  /**
   * 执行器报告：运行中的 Assignment 结束了（agent 的 `waiting`/`done`），Ticket 仍然开着。
   * 只认当前正在跑的那个，重复的事件是幂等的；`reason` 是 `waiting` / `done` 这类结局码。
   */
  ended(ticketId: string, assignmentId: string, reason: string): void {
    const ticket = this.running(ticketId, assignmentId)
    if (!ticket) return
    const assignment = runningAssignment(ticket)!
    assignment.state = 'ended'
    assignment.endedAt = this.now()
    assignment.endedReason = reason
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
    this.emit('assignment.ended', { ticketId, assignmentId, reason })
  }

  /**
   * 执行器报告：这个 Assignment 的终端已经不在（插件或应用重启、人被关掉终端）。会话无法
   * 再认领，所以**无条件**结束它并按恢复说明重建（§E.10）；与 `interrupted` 的区别是后者
   * 认为宿主的会话还在，`waiting`/`ready` 之类的报告可以保留。
   */
  lost(ticketId: string, assignmentId: string): void {
    const ticket = this.running(ticketId, assignmentId)
    if (!ticket) return
    this.tickets.restart(ticket, runningAssignment(ticket)!, 'interrupted', RECOVERY_NOTE)
  }

  /**
   * 处理被主机重启打断的运行中 Assignment：用一个恢复说明重启它，除非它最新报告是
   * `waiting`/`ready`/`blocked`/`failed` 且此后没有 Input 送达——那时候保留它的会话与状态，
   * 只把等着的 Input 投出去（§E.10）。
   */
  interrupted(ticketId: string, assignmentId: string): void {
    const ticket = this.running(ticketId, assignmentId)
    const running = ticket && runningAssignment(ticket)
    if (!ticket || !running) return
    const report = running.report
    const busy = !!running.deliveredAt && !!report && running.deliveredAt >= report.at
    const settled =
      !!report && ['waiting', 'ready', 'blocked', 'failed'].includes(report.state) && !busy
    if (!settled) {
      this.tickets.restart(ticket, running, 'hostRestarted', RECOVERY_NOTE)
    } else if (ticket.undelivered.length) {
      this.options.executor.deliver(ticket, running)
    }
  }

  /**
   * 记下未结束 Ticket 当前 Assignment 上的一份 worker 状态报告，更新 `attention`、`answers`、
   * 被压住的自动 Input，并在 `dropped`、或 `ready` 且不再等跟随的 Thread 时结束 Ticket。
   * @throws UserError Ticket 未知或已结束；Assignment 已结束；问题与 ready 结果或回答同时
   * 出现；问题/回答指向的不是人的消息、或没到达该 Ticket。
   */
  report(ticketId: string, report: WorkerReport): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    if (report.question && (report.state === 'ready' || report.answers)) {
      throw new UserError('questionWithResult')
    }
    if (report.askedBy && !report.question) throw new UserError('askerWithoutQuestion')
    const person = (id: string, channel: boolean): boolean => {
      const trigger = this.repo.triggers.get(id)
      return !!trigger?.human && (!channel || !!trigger.channel) && this.reaches(ticket, trigger, false)
    }
    if (report.askedBy && !person(report.askedBy, true)) throw new UserError('notAsker')
    if (report.answers && !person(report.answers, false)) throw new UserError('notAnswerable')
    const assignment = runningAssignment(ticket) ?? latestAssignment(ticket)
    if (!assignment) throw new UserError('unknownAssignment')
    if (assignment.state === 'ended') throw new UserError('assignmentEnded')
    const at = this.now()
    const previous = ticket.attention
    const ask = (question: string) => ({
      id: key('attention', ticketId, question, at),
      question,
      at,
      ...(report.askedBy ? { forTriggerId: report.askedBy } : {}),
      ...(report.via === 'terminal' ? { via: 'terminal' as const } : {})
    })
    const asked = report.question && report.question !== previous?.question ? ask(report.question) : previous
    const attention = report.question === null || report.state === 'ready' ? undefined : asked
    if (attention) ticket.attention = attention
    else delete ticket.attention
    // 被替换或清掉的问题，把 outbox 里还没发出的对应消息撤回。
    if (previous && previous.id !== attention?.id) this.replies.withdrawAttention(previous.id)
    assignment.report = { state: report.state, summary: report.summary, at }
    ticket.updatedAt = at
    if (report.answers && !ticket.answers?.includes(report.answers)) {
      ticket.answers = [...(ticket.answers ?? []), report.answers]
    }
    if (report.answers) this.takeUp(ticketId, report.answers)
    if (report.state === 'blocked' || report.state === 'failed') {
      ticket.undelivered = ticket.undelivered.filter(
        (id) => !automatic(ticket.inputs.find((input) => input.id === id))
      )
    }
    this.repo.tickets.save(ticket)
    // 跟随 Thread 的 Ticket 随它们结束：ready 报告要等 followsDone 成立，结局取那次关闭。
    const ready = !ticket.follows?.length ? 'completed' : this.tickets.followsDone(ticket)?.outcome
    const outcome =
      report.state === 'dropped'
        ? (this.tickets.followsDone(ticket)?.outcome ?? 'dropped')
        : report.state === 'ready'
          ? ready
          : undefined
    if (outcome) this.tickets.end(ticketId, 'executor', outcome, at)
    return this.require(ticketId)
  }

  /** 未结束、且正由 `assignmentId` 运行的 Ticket。 */
  private running(ticketId: string, assignmentId: string): Ticket | undefined {
    const ticket = this.require(ticketId)
    return liveTicket(ticket) && runningAssignment(ticket)?.id === assignmentId ? ticket : undefined
  }
}

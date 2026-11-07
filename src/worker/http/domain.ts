// 领域命令的 HTTP handler（§G.2 的 `report` / `reply` / `ack` / `ticket stop` / `ticket retry` /
// `ticket list` / `trigger requeue` / `thread *` 行、§G.3 的读面）：CLI 与面板共用同一份实现，
// 路由表只负责方法与角色。
//
// 三件事只在这里发生一次：
// - 参数形状（worker 的 `--state`/`--summary`、回复的三个 purpose、确认的 trigger、停止的
//   确认与理由）与上限；
// - 角色：`report` 只属于 assignment（Ticket 来自它的 token，不是参数）；`ack` 同；
// - 读面：`read tickets` 与 `read ticket/<id>` 走同一个读模型（`app/views.ts`）。
//
// **停止与重试也在这里**：面板经 `plugin.request` 进来时直接调这几个 handler（不走 HTTP，
// §B），于是命令行与面板的语义、拒绝码与事务边界只有一份（#29）。
//
// 依赖纪律（§C.2）：本文件在 `http/`，只 import core 的类型、`app/views` 与同目录的
// `ApiError`；领域写入经注入的 Engine 端口，存储经注入的读口。
import { ApiError, ERROR_CODES } from './errors.ts'
import { IM_WORDS, wordCount } from '../infra/text.ts'
import { REPORT_STATES, threadKey } from '../core/index.ts'
import type {
  EngineForExecutor,
  EngineForMainSession,
  EngineForPeople,
  Thread,
  Ticket,
  Trigger,
  WorkerReport
} from '../core/index.ts'
import type { RouteDefinition, RouteHandler, RouteInput } from './routes.ts'
import { TICKET_FILTERS, ticketsPage, ticketView, type TicketFilter } from '../app/views.ts'
import type { TicketFollowup, TicketView } from '../app/views.ts'

/** `reply` 的三种用途（§G.2）。 */
export const REPLY_PURPOSES = ['answer', 'result', 'attention'] as const
/** 一条回复/确认的词数上限（§G.2：100 词；计数规则只有 `infra/text.ts` 一份）。 */
export const REPLY_WORD_LIMIT = IM_WORDS
/** `report --summary` 的字符上限（§G.2：600 字符）。 */
export const SUMMARY_LIMIT = 600

/** 写命令的幂等端口（§G.1 幂等行）：拿到请求（token/requestId/at）与要跑的工作。 */
export type WriteIdempotency = (
  input: { readonly token?: string; readonly requestId?: string | null; readonly at: string },
  work: () => unknown | Promise<unknown>
) => Promise<unknown>

/** handler 的接线：领域写入（engine）与读口（records）。 */
export interface DomainHandlerOptions {
  /** `Engine.report`（执行器侧）。 */
  readonly report: EngineForExecutor['report']
  /** `Engine.reply`（回复与确认）。 */
  readonly reply: EngineForMainSession['reply']
  /** `Engine.note`（主 Session 给 worker 的一条事实，§G.2 的 `ticket note`）。 */
  readonly note: EngineForMainSession['note']
  /** `Engine.requestStatus`（向等待中的 worker 要一次状态，§G.2 的 `ticket request-status`）。 */
  readonly requestStatus: EngineForMainSession['requestStatus']
  /** `Engine.handback`（worker 把它超出范围的消息交回 Eval，§G.2 的 `trigger handback`）。 */
  readonly handback: EngineForExecutor['handback']
  /**
   * 人停止一张 Ticket（§G.2 的 `ticket stop`、§E.5）：撤回 Mandate、排进收尾消息、关终端、
   * 保留 worktree，此后它不接任何 Input。组合根传 `Engine.stopTicket`。
   */
  readonly stop: EngineForPeople['stopTicket']
  /**
   * `Engine.retryTicket` 是 `EngineForPeople` 的一条，但本票新增的
   * `trigger requeue` 走 `reevaluate`（同一族的另一条）。
   */
  readonly retry: EngineForPeople['retryTicket']
  /**
   * `Engine.reevaluate`（§G.2 的 `trigger requeue`）：把一条 Trigger 重新排进 Eval。
   * 返回 false 表示已有 Eval 持有它（此时不动它，如实回 `queued: false`）。
   */
  readonly reevaluate: EngineForPeople['reevaluate']
  /**
   * `Engine.unsubscribe`（§G.2 的 `thread unsubscribe`）：丢弃一个 Thread 上所有 Ticket 的
   * Subscription；返回是否真的丢了什么。
   */
  readonly unsubscribe: EngineForPeople['unsubscribe']
  /**
   * `Engine.markUnrelated`（§G.2 的 `thread unrelated`）：丢自己的订阅、把这条 Thread 上
   * 自己决定的人消息交回 Eval；返回交回了几条。
   */
  readonly markUnrelated: EngineForExecutor['markUnrelated']
  /**
   * `Engine.followForContext`（§G.2 的 `thread follow`）：把 Ticket 订阅到一条只作语境的
   * Thread；已跟随过时返回 false。
   */
  readonly followForContext: (ticketId: string, ref: Thread['ref'], reason?: string) => boolean
  /** 读一条 Thread（follow / unsubscribe 的存在性判定）。 */
  readonly threadOf: (key: string) => Thread | undefined
  /** 读一条 Trigger（`trigger requeue` 的存在性判定）。 */
  readonly triggerOf: (id: string) => Trigger | undefined
  /**
   * 一条 Trigger 仍被哪些 Ticket 的 worker 拥有（`followupOwners`，§K.2 第 3 条）。
   * `trigger requeue` 用它判 `not_requeueable`：执行器仍拥有的人消息不能被重排绕过。
   */
  readonly owners: (trigger: Trigger) => readonly string[]
  /** 读一条 Ticket（详情与写入的返回）。 */
  readonly ticketOf: (id: string) => Ticket | undefined
  /** 全部 Ticket（列表读模型）。 */
  readonly tickets: () => readonly Ticket[]
  /**
   * 一张 Ticket 仍拥有的人 follow-up（读模型里的「已投递到该 Ticket」标记）。缺省不标：
   * 只有组合根知道归属（`app/views.ts` 的 `deliveredFollowups`）。
   */
  readonly followups?: (ticket: Ticket) => readonly TicketFollowup[]
  /** 一次写成功后的推推送/刷新钩子（面板 `state.changed` 与状态栏）。 */
  readonly afterWrite?: () => void
  /**
   * `report --pr-number` 的绑定（§I.2 的「PR 规则」行、§G.2 的 `pr_mismatch`）：组合根读那条
   * PR、判它是不是这张 Ticket 的、并把它绑给 Ticket；返回拒绝原因时这条报告不写，信封里落成
   * `pr_mismatch`。缺省不绑（没有 GitHub Source 的接线与单元测试都不读网络）。
   */
  readonly claimPull?: (
    ticketId: string,
    pull: { readonly number: number }
  ) => Promise<string | undefined> | string | undefined
  /**
   * 写命令的幂等端口（组合根用真库实现 `runWrite`）；缺省直接执行一次。`--request-id`
   * 一小时内重试返回首次结果（§G.1）：本票接线的四条写命令都过这一个口。
   */
  readonly idempotent?: WriteIdempotency
}

/** 一个 body 对象；不是对象就按 `invalid_params` 拒绝。 */
function bodyObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) {
    throw new ApiError(ERROR_CODES.invalidParams, 'The request body must be a JSON object')
  }
  return body as Record<string, unknown>
}

/** 可省略的 body：没有 body 就是空对象（只有 `--yes` 这类开关的动作可以不带字段）。 */
function bodyFields(body: unknown): Record<string, unknown> {
  return body === undefined || body === null ? {} : bodyObject(body)
}

/** `{confirm: true}` 才算确认了破坏性动作（与 `admin rotate-token` 同一口径，§O）。 */
function confirmed(body: Record<string, unknown>): boolean {
  return body['confirm'] === true
}

/** 一个可选字符串字段：缺省 undefined；给了非字符串就拒绝。 */
function optionalText(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new ApiError(ERROR_CODES.invalidParams, `${key} must be a string`, { field: key })
  }
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** 一个必填字符串字段。 */
function requiredText(body: Record<string, unknown>, key: string): string {
  const value = optionalText(body, key)
  if (value === undefined) {
    throw new ApiError(ERROR_CODES.invalidParams, `${key} is required`, { field: key })
  }
  return value
}

// 词数只有一份实现（`infra/text.ts`，中文按词段、英文按空白）：命令面与 Channel 的
// 发送前校验因此不会出现两种口径。这里转出，历史调用方不必改 import。
export { wordCount } from '../infra/text.ts'

/** 一条正文是否超过词数上限。 */
function assertWords(text: string): void {
  const count = wordCount(text)
  if (count > REPLY_WORD_LIMIT) {
    throw new ApiError(ERROR_CODES.tooLong, `The text is ${count} words; the limit is ${REPLY_WORD_LIMIT}`, {
      limit: String(REPLY_WORD_LIMIT)
    })
  }
}

/** 一个 assignment 调用者必须带 Ticket；没有就是角色越权（report/ack 只属于 worker）。 */
function callerTicket(input: RouteInput, body: Record<string, unknown>): string {
  const fromToken = input.caller.ticketId
  if (fromToken !== undefined) return fromToken
  const explicit = optionalText(body, 'ticketId')
  if (explicit !== undefined) return explicit
  throw new ApiError(
    ERROR_CODES.notPermittedRole,
    'This command belongs to an assignment; its token names the ticket',
    { role: input.caller.role }
  )
}

/** `report` 的 body → WorkerReport（§G.2 的 report 行）。 */
export function workerReportOf(body: Record<string, unknown>): WorkerReport {
  const state = requiredText(body, 'state')
  if (!(REPORT_STATES as readonly string[]).includes(state)) {
    throw new ApiError(ERROR_CODES.invalidValue, `state must be one of: ${REPORT_STATES.join(', ')}`, {
      flag: 'state',
      choices: REPORT_STATES.join(',')
    })
  }
  const summary = optionalText(body, 'summary') ?? ''
  if (summary.length > SUMMARY_LIMIT) {
    throw new ApiError(ERROR_CODES.tooLong, `The summary is ${summary.length} characters; the limit is ${SUMMARY_LIMIT}`, {
      limit: String(SUMMARY_LIMIT)
    })
  }
  const question = optionalText(body, 'humanAction')
  const askedBy = optionalText(body, 'questionForTrigger')
  const answers = optionalText(body, 'replyToTrigger')
  if (askedBy !== undefined && question === undefined) {
    throw new ApiError(ERROR_CODES.invalidParams, 'question-for-trigger needs --human-action', {
      field: 'questionForTrigger'
    })
  }
  return {
    state: state as WorkerReport['state'],
    summary,
    ...(question === undefined ? {} : { question }),
    ...(askedBy === undefined ? {} : { askedBy }),
    ...(answers === undefined ? {} : { answers })
  }
}

/** `report --pr-number`：正整数（`#9` 这种写法不接受，避免命令层猜语义）。 */
function pullNumberOf(body: Record<string, unknown>): number | undefined {
  const value = optionalText(body, 'prNumber')
  if (value === undefined) return undefined
  if (!/^\d+$/u.test(value) || Number(value) <= 0) {
    throw new ApiError(ERROR_CODES.invalidValue, 'prNumber must be a positive integer', {
      flag: 'pr-number'
    })
  }
  return Number(value)
}

/** 读面的响应形状（`read tickets`）。 */
export interface TicketsResult {
  readonly items: readonly TicketView[]
  readonly next_offset: number | null
}

/**
 * 组装领域命令的 handler。返回 `{method path → handler}` 的表，由组合根叠加到路由表上
 * （与 `withOpsHandlers` 同一模式，替换只改 handler 字段）。
 */
export function createDomainHandlers(options: DomainHandlerOptions): ReadonlyMap<string, RouteHandler> {
  const handlers = new Map<string, RouteHandler>()
  /** 写命令的幂等（§G.1）：组合根给端口时同 id 一小时内返回首次结果，否则照常跑一次。 */
  const write = options.idempotent ?? ((_input, work) => Promise.resolve(work()))
  /** 一条 Ticket 的读模型（列表与详情同一份，含仍归它的人 follow-up 标记）。 */
  const viewOf = (ticket: Ticket): TicketView =>
    ticketView(ticket, options.followups === undefined ? [] : options.followups(ticket))

  handlers.set('GET tickets', ({ query }) => {
    const filter = query['state'] === undefined ? undefined : ticketFilterOf(query['state'])
    const result: TicketsResult = ticketsPage(options.tickets(), {
      limit: numberParam(query['limit'], 20),
      offset: numberParam(query['offset'], 0),
      ...(filter === undefined ? {} : { filter }),
      ...(options.followups === undefined ? {} : { followups: options.followups })
    })
    return result
  })

  handlers.set('GET tickets/:id', ({ params }) => {
    const ticket = options.ticketOf(params['id'] ?? '')
    if (ticket === undefined) {
      throw new ApiError(ERROR_CODES.missing, 'No such ticket', { ticket: params['id'] ?? '' })
    }
    return viewOf(ticket)
  })

  handlers.set('POST tickets/:id/note', (input) => {
    // `ticket note` 只带一个事实：100 词上限是固定拒绝（§G.2），领域只加一条 `note` Input。
    const body = bodyObject(input.body)
    const text = requiredText(body, 'text')
    assertWords(text)
    options.note(input.params['id'] ?? '', text)
    options.afterWrite?.()
    return { sent: true }
  })

  handlers.set('POST tickets/:id/request-status', (input) => {
    // 人的一次唤醒，不是新工作：只问已经在跑的 worker（§E.6）；没有在跑的就如实回 `asked:false`。
    const ticketId = input.params['id'] ?? ''
    const ticket = options.ticketOf(ticketId)
    if (ticket === undefined) {
      throw new ApiError(ERROR_CODES.missing, 'No such ticket', { ticket: ticketId })
    }
    const asked = options.requestStatus(ticketId)
    options.afterWrite?.()
    return { asked, ticket: viewOf(options.ticketOf(ticketId) ?? ticket) }
  })

  handlers.set('POST tickets/:id/stop', (input) => {
    // 停止是三条改变 Mandate 的操作之一（§K.3）：撤回只能由人的 stop 发起，复验撤销走
    // Policy（§K.5）。半个状态不允许：先判完所有拒绝条件，再一次事务性地结束。
    const ticketId = input.params['id'] ?? ''
    const ticket = options.ticketOf(ticketId)
    if (ticket === undefined) {
      throw new ApiError(ERROR_CODES.missing, 'No such ticket', { ticket: ticketId })
    }
    if (ticket.ended !== undefined) {
      throw new ApiError(ERROR_CODES.alreadyEnded, 'Ticket has already ended', { ticket: ticketId })
    }
    const body = bodyFields(input.body)
    // 破坏性动作：面板的行内二次确认与 CLI 的 `--yes` 都落成这一个 `confirm`（§O）。
    if (!confirmed(body)) {
      throw new ApiError(
        ERROR_CODES.refused,
        'stop withdraws the mandate and closes the assignment terminal; pass --yes to confirm',
        { reason: 'confirmation_required' }
      )
    }
    options.stop(ticketId, optionalText(body, 'reason'))
    options.afterWrite?.()
    return { stopped: true }
  })

  handlers.set('POST tickets/:id/retry', (input) => {
    // 能不能重试由领域判定（`canRetry` → `notRetryable`），信封里固定落成 `not_retryable`。
    // 重试的措辞（恢复说明）由执行器拼，HTTP 层不重写它：同一个入口只有一个说法。
    const ticket = options.retry(input.params['id'] ?? '')
    options.afterWrite?.()
    return { retried: true, assignment: ticket.assignments.at(-1) ?? null }
  })

  handlers.set('POST report', async (input) => {
    const body = bodyObject(input.body)
    const ticketId = callerTicket(input, body)
    const report = workerReportOf(body)
    // PR 号只当作**绑定**的输入（§I.2）：先读 PR、判归属，再写报告——拒绝时整条命令不写任何东西。
    const pull = pullNumberOf(body)
    if (pull !== undefined && options.claimPull !== undefined) {
      const refused = await options.claimPull(ticketId, { number: pull })
      if (refused !== undefined) {
        throw new ApiError(ERROR_CODES.prMismatch, refused, {
          ticket: ticketId,
          pr: String(pull)
        })
      }
    }
    const ticket = options.report(ticketId, report)
    options.afterWrite?.()
    return {
      ticket: viewOf(ticket),
      assignment: ticket.assignments.at(-1) ?? null,
      ...(ticket.attention === undefined ? {} : { attention: ticket.attention })
    }
  })

  handlers.set('POST reply', (input) => {
    const body = bodyObject(input.body)
    const purpose = requiredText(body, 'purpose')
    if (!(REPLY_PURPOSES as readonly string[]).includes(purpose)) {
      throw new ApiError(ERROR_CODES.invalidValue, `purpose must be one of: ${REPLY_PURPOSES.join(', ')}`, {
        flag: 'purpose',
        choices: REPLY_PURPOSES.join(',')
      })
    }
    const text = requiredText(body, 'text')
    assertWords(text)
    const triggerId = optionalText(body, 'triggerId')
    const ticketId = optionalText(body, 'ticketId') ?? input.caller.ticketId
    const question = optionalText(body, 'question')
    if (purpose === 'answer' && triggerId === undefined) {
      throw new ApiError(ERROR_CODES.invalidParams, 'an answer needs --trigger', { field: 'triggerId' })
    }
    if (purpose === 'attention' && question === undefined) {
      throw new ApiError(ERROR_CODES.invalidParams, 'attention needs --human-action', { field: 'question' })
    }
    const reply = options.reply({
      purpose: purpose as 'answer' | 'result' | 'attention',
      text,
      ...(ticketId === undefined ? {} : { ticketId }),
      ...(triggerId === undefined ? {} : { triggerId }),
      ...(question === undefined ? {} : { question })
    })
    options.afterWrite?.()
    return { id: reply.id, status: reply.status, reused: reply.reused }
  })

  handlers.set('POST triggers/:id/handback', (input) => {
    // worker 交回一条到达过它、但超出它的消息：每次一条，Ticket 来自它的 token（§G.2）。
    const body = bodyObject(input.body)
    const ticketId = callerTicket(input, body)
    const reason = requiredText(body, 'reason')
    const queued = options.handback(ticketId, input.params['id'] ?? '', reason)
    options.afterWrite?.()
    return { queued }
  })

  handlers.set('POST triggers/:id/requeue', (input) =>
    write(input, () => {
      // `trigger requeue`（§G.2）：把一条 Trigger 放回 Eval。执行器仍拥有的人消息不能被绕过
      // ——那会绕开决定它的 worker（§K.2 第 3 条）；已有 Eval 持有它时如实回 `queued:false`。
      const triggerId = input.params['id'] ?? ''
      const trigger = options.triggerOf(triggerId)
      if (trigger === undefined) {
        throw new ApiError(ERROR_CODES.missing, 'No such trigger', { trigger: triggerId })
      }
      const owners = options.owners(trigger)
      if (owners.length > 0) {
        throw new ApiError(
          ERROR_CODES.notRequeueable,
          "A ticket's worker still owns this message; its worker decides it or hands it back",
          { trigger: triggerId, tickets: owners.join(',') }
        )
      }
      const queued = options.reevaluate(triggerId)
      options.afterWrite?.()
      return { queued }
    })
  )

  handlers.set('POST threads/:key/unsubscribe', (input) =>
    write(input, () => {
      // `thread unsubscribe`（§G.2）：丢一个 Thread 上所有 Ticket 的订阅。没有订阅可丢、或
      // Thread 不存在，都是固定的 `missing`——不是「成功了但什么也没做」。
      const key = input.params['key'] ?? ''
      if (options.threadOf(key) === undefined) {
        throw new ApiError(ERROR_CODES.missing, 'No such thread', { thread: key })
      }
      if (!options.unsubscribe(key)) {
        throw new ApiError(ERROR_CODES.missing, 'No ticket subscribes to that thread', { thread: key })
      }
      options.afterWrite?.()
      return { removed: true, thread: key }
    })
  )

  handlers.set('POST threads/:key/follow', (input) =>
    write(input, () => {
      // `thread follow`（§G.2）：worker 按理由跟随一条它不拥有的 Thread，只作语境。
      // - `own_thread`：那是它自己的 Thread（来源 Thread 或它跟随的 PR/Issue Thread），
      //   本来就把消息交给它；
      // - `unrelated_required`：它仍决定这条 Thread 上的消息（被 attach 的订阅者），要只留语境
      //   就得先用 `thread unrelated` 声明无关。
      const body = bodyFields(input.body)
      const ticketId = callerTicket(input, body)
      const key = input.params['key'] ?? ''
      const thread = options.threadOf(key)
      if (thread === undefined) {
        throw new ApiError(ERROR_CODES.missing, 'No such thread', { thread: key })
      }
      const ticket = options.ticketOf(ticketId)
      if (ticket === undefined) {
        throw new ApiError(ERROR_CODES.missing, 'No such ticket', { ticket: ticketId })
      }
      const origin = options.triggerOf(ticket.origin.triggerId)
      const owns =
        origin?.threads.some((ref) => threadKey(ref) === key) === true ||
        ticket.follows?.some((item) => item.thread === key) === true
      if (owns) {
        throw new ApiError(
          ERROR_CODES.ownThread,
          "This thread is the ticket's own; its messages already reach the ticket",
          { thread: key }
        )
      }
      if (thread.subscriptions.includes(ticketId) && thread.context?.includes(ticketId) !== true) {
        throw new ApiError(
          ERROR_CODES.unrelatedRequired,
          'This thread still decides for the ticket; declare it unrelated before following it as context',
          { thread: key }
        )
      }
      const followed = options.followForContext(ticketId, thread.ref, optionalText(body, 'reason'))
      options.afterWrite?.()
      return { followed }
    })
  )

  handlers.set('POST threads/:key/unrelated', (input) =>
    write(input, () => {
      // `thread unrelated`（§G.2）：丢自己的订阅，并把这条 Thread 上自己决定的人消息交回 Eval。
      // 领域判自己的 Thread（`own_thread`）与没跟随（`not_followed`）两种固定拒绝。
      const body = bodyFields(input.body)
      const ticketId = callerTicket(input, body)
      const key = input.params['key'] ?? ''
      const reason = requiredText(body, 'reason')
      const handedBack = options.markUnrelated(ticketId, key, reason)
      options.afterWrite?.()
      return { dropped: true, handedBack }
    })
  )

  handlers.set('POST ack', (input) => {
    const body = bodyObject(input.body)
    const ticketId = callerTicket(input, body)
    const triggerId = requiredText(body, 'trigger')
    const text = requiredText(body, 'text')
    assertWords(text)
    const reply = options.reply({ purpose: 'acknowledgement', ticketId, triggerId, text })
    options.afterWrite?.()
    return { id: reply.id, status: reply.status, reused: reply.reused }
  })

  return handlers
}

/** 一个 Ticket 筛选参数（`--state`）；未知值按 `invalid_state` 拒绝（§G.2 的 ticket list 行）。 */
function ticketFilterOf(value: string): TicketFilter {
  if (!(TICKET_FILTERS as readonly string[]).includes(value)) {
    throw new ApiError(ERROR_CODES.invalidState, `state must be one of: ${TICKET_FILTERS.join(', ')}`, {
      flag: 'state',
      choices: TICKET_FILTERS.join(',')
    })
  }
  return value as TicketFilter
}

/** 一个非负整数查询参数（缺省给 `fallback`）。 */
function numberParam(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ApiError(ERROR_CODES.invalidValue, 'The parameter must be a non-negative integer', { value })
  }
  return parsed
}

/** 把领域 handler 叠加到路由表上（与 `withOpsHandlers` 同义：替换 handler，不改名字）。 */
export function withDomainHandlers(
  routes: readonly RouteDefinition[],
  handlers: ReadonlyMap<string, RouteHandler>
): readonly RouteDefinition[] {
  return routes.map((route) => {
    const handler = handlers.get(`${route.method} ${route.path}`)
    return handler === undefined ? route : { ...route, handler }
  })
}

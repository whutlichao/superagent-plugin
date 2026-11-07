// Thread 读模型（§M.2 的 Trigger 页、§D.2 的 thread 行）：列表的四组筛选与行、详情的时间线。
//
// 一处定义：行与详情的每个字段都从注入的读口来——列表的筛选判定、状态标记、最近触发、
// 订阅数，以及详情的时间线（用 `(at, id)` 复合游标分页，§D.2 要点 1）。面板只画回来的窗口，
// 不自己发明「谁在等人」或「哪条最新」的第二套规则。
//
// 依赖纪律（§C.2）：app → core 是允许的方向；这里只依赖领域类型、面板契约与注入的读口，
// 不 import runtime / sources / executor，也不 import `orca`。
import { followupOwners, settled, type Decision, type Repositories, type Thread, type Ticket, type Trigger } from '../../core/index.ts'
import type {
  PanelDecision,
  PanelThread,
  PanelThreadTicket,
  PanelTriggerCard,
  ThreadDetailView,
  ThreadFilter,
  ThreadListInput,
  ThreadListPage
} from '../../../panel/protocol'
import type { TimelineBackPage } from '../store-read.ts'
import type { TimelineCursor, TimelineItem } from '../records.ts'
import type { Store } from '../store.ts'

/** 一页最多几行（§M.4：无虚拟列表，长列表靠分页 50 条）。 */
export const THREAD_PAGE_MAX = 50

/** 行里「最近触发」的预览长度（一句话；详情才给整段原文）。 */
export const LATEST_CHARS = 120

/** 「新触发」的窗口（§M.2 的 New in 24 h）。 */
export const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000

/** 一条 Trigger 的去向里详情要读的几件事：扇出到谁、谁确认过、谁交回了它（及原因）。 */
export interface ThreadDisposition {
  readonly fanout: readonly string[]
  readonly acked?: readonly string[]
  readonly handbacks?: readonly {
    readonly ticketId: string
    readonly reason: string
    readonly at: string
  }[]
  readonly filtered?: { readonly code: string }
}

/**
 * Thread 读模型要读的记录：Thread、Ticket（订阅数与「订阅者还有没有活的」）、Trigger（最近
 * 一条与时间线上的卡片）、Decision（详情里每个 Thread 的决定）、时间线与归属判定。
 * 组合根把它们接到真库（`threadRecordsOf`），测试可以只给关心的一项。
 */
export interface ThreadReadRecords {
  readonly threads: {
    get(key: string): Thread | undefined
    list(): readonly Thread[]
  }
  readonly tickets: {
    get(id: string): Ticket | undefined
    list(): readonly Ticket[]
  }
  readonly triggers: {
    get(id: string): Trigger | undefined
    /** 一条 Trigger 的去向（扇出、交回、确认）；没有记录时省略。 */
    disposition(id: string): ThreadDisposition | undefined
  }
  readonly decisions: { byThread(threadKey: string): readonly Decision[] }
  /**
   * Thread 时间线：最新一页与「更早一页」（§D.2 要点 1 的 `(at, id)` 复合游标）。
   * 两页都按升序给行——面板从最新一条往下画，方向在面板侧翻。
   */
  readonly timeline: {
    tail(threadKey: string, limit?: number): TimelineBackPage
    before(threadKey: string, cursor: TimelineCursor, limit?: number): TimelineBackPage
  }
  /** 执行器仍拥有的人 follow-up（`followupOwners`，§K.2 第 3 条）。 */
  readonly owners: (trigger: Trigger) => readonly string[]
}

/**
 * 组合根与测试共用的接线：真库上的 Thread 读模型。时间线读的是 `trigger_thread`（由
 * `triggers.save` 按 `trigger.threads` 填），归属判定就是 `followupOwners` 本身。
 */
export function threadRecordsOf(
  repo: Repositories,
  store: Pick<Store, 'triggerThreads'>
): ThreadReadRecords {
  return {
    threads: repo.threads,
    tickets: repo.tickets,
    triggers: repo.triggers,
    decisions: repo.decisions,
    timeline: {
      tail: (threadKey, limit) => store.triggerThreads.tail(threadKey, limit),
      before: (threadKey, cursor, limit) => store.triggerThreads.before(threadKey, cursor, limit)
    },
    owners: (trigger) => followupOwners(trigger, repo)
  }
}

/** 一段文本的摘要：空白折成单空格，过长截断（与 Execution 详情的 `preview` 同一口径）。 */
function preview(text: string, limit: number = LATEST_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

/** ISO 文本 → epoch ms（面板的时间一律交给 `RelativeTime`）。解不开就是 0。 */
function epoch(at: string): number {
  const parsed = Date.parse(at)
  return Number.isFinite(parsed) ? parsed : 0
}

/** 一个非空字符串字段（`meta` 是 Source 自有数据，认不出就当没有）。 */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Thread 的最后动静：最新的触发时刻，没有触发时是它的创建时刻。 */
function lastAtOf(thread: Thread): string {
  return thread.lastAt ?? thread.createdAt
}

/**
 * 还在等 Eval 的触发数：`pending` 里没有执行器拥有的那些。执行器拥有的人消息由它的 worker
 * 决定（§K.2 第 3 条），因此不再算「等评估」。
 */
export function awaitingEval(thread: Thread, records: ThreadReadRecords): number {
  return thread.pending.filter((id) => {
    const trigger = records.triggers.get(id)
    return trigger === undefined || records.owners(trigger).length === 0
  }).length
}

/**
 * 一条 Thread 的展示阶段，按优先级取第一档（与上游 `threadStage` 同一顺序）：轮询失败、
 * 评估中、排队、有活着的订阅者、订阅者都结束了、没人订阅。
 */
function stageOf(
  thread: Thread,
  pending: number,
  open: ReadonlySet<string>
): PanelThread['stage'] {
  if (textOf(thread.meta['pollError']) !== undefined) return 'error'
  if (thread.evaluating !== undefined) return 'evaluating'
  if (pending > 0) return 'queued'
  if (thread.subscriptions.some((id) => open.has(id))) return 'subscribed'
  return thread.subscriptions.length > 0 ? 'dormant' : 'unsubscribed'
}

/** 一条 Thread → 列表的一行（最新触发与 url 都从时间线的同一次读里取）。 */
function threadRow(
  thread: Thread,
  open: ReadonlySet<string>,
  records: ThreadReadRecords
): PanelThread {
  // `tail` 给的是升序的一页：取一行时它就是最新的一条。
  const newest = records.timeline.tail(thread.key, 1).items[0]
  const trigger = newest === undefined ? undefined : records.triggers.get(newest.triggerId)
  const url = textOf(thread.meta['url']) ?? textOf(trigger?.url)
  const label = textOf(thread.meta['label'])
  const pending = awaitingEval(thread, records)
  const pollError = textOf(thread.meta['pollError'])
  return {
    key: thread.key,
    source: thread.ref.source,
    title: label ?? url ?? thread.key,
    ...(url === undefined ? {} : { url }),
    stage: stageOf(thread, pending, open),
    pending,
    subscriptions: thread.subscriptions.length,
    lastAt: epoch(lastAtOf(thread)),
    createdAt: epoch(thread.createdAt),
    ...(trigger === undefined || newest === undefined
      ? {}
      : {
          latest: {
            actor: `${trigger.actor.source}:${trigger.actor.id}`,
            human: trigger.human,
            at: epoch(newest.at),
            preview: preview(trigger.text)
          }
        }),
    ...(pollError === undefined ? {} : { pollError })
  }
}

/** 一条 Thread 是否符合某一档筛选。 */
function matchesFilter(
  thread: Thread,
  filter: ThreadFilter,
  open: ReadonlySet<string>,
  records: ThreadReadRecords,
  cutoff: string
): boolean {
  switch (filter) {
    case 'subscribed':
      return thread.subscriptions.some((id) => open.has(id))
    case 'evaluating':
      return thread.evaluating !== undefined || awaitingEval(thread, records) > 0
    case 'recent':
      return lastAtOf(thread) >= cutoff
    default:
      return true
  }
}

/** 列表请求 + 读模型需要的时钟（「24 小时内」由调用方给，读模型自己不读钟）。 */
export interface ThreadListQuery extends ThreadListInput {
  /** 现在（ISO-8601）：唯一用途是算「新触发」的窗口。 */
  readonly now: string
}

/**
 * Trigger 页的一页 Thread（§M.2 的四档筛选 + §M.4 的分页）：筛选与分页都在这里判定，
 * 面板只画回来的窗口。
 */
export function threadListPage(
  records: ThreadReadRecords,
  query: ThreadListQuery
): ThreadListPage {
  const filter = query.filter ?? 'all'
  const offset = Math.max(0, query.offset ?? 0)
  const limit = Math.max(1, Math.min(THREAD_PAGE_MAX, query.limit ?? THREAD_PAGE_MAX))
  const cutoff = new Date(Date.parse(query.now) - RECENT_WINDOW_MS).toISOString()
  const open = new Set(
    records.tickets
      .list()
      .filter((ticket) => ticket.ended === undefined)
      .map((ticket) => ticket.id)
  )
  const matched = records.threads
    .list()
    .filter((thread) => matchesFilter(thread, filter, open, records, cutoff))
    .sort(
      (left, right) =>
        lastAtOf(right).localeCompare(lastAtOf(left)) || left.key.localeCompare(right.key)
    )
  return {
    items: matched.slice(offset, offset + limit).map((thread) => threadRow(thread, open, records)),
    nextOffset: offset + limit < matched.length ? offset + limit : null
  }
}

/** 详情里一条 Trigger 的原话最多几个字符（列表是几百行，原文按面板的渲染上限截断，§M.4）。 */
export const CARD_CHARS = 600

/** 一条 Decision → 面板面（§M.2：决定、原因、强度、policy version 与它开的工单）。 */
export function panelDecision(decision: Decision): PanelDecision {
  return {
    id: decision.id,
    kind: decision.kind,
    reasons: decision.reason,
    strength: decision.strength,
    policyVersion: decision.policyVersion,
    at: epoch(decision.at),
    ...(decision.ticketId === undefined ? {} : { ticketId: decision.ticketId })
  }
}

/**
 * 时间线的一行 → 触发卡（§M.2）：谁在什么时候说了什么、它现在归谁（排队 / 评估中 / 已投递 /
 * 已扇出到哪几张工单）、消费它的 Decision，以及有没有被交回、为什么。
 */
function triggerCard(
  row: TimelineItem,
  thread: Thread,
  records: ThreadReadRecords,
  decision: Decision | undefined,
  tickets: ReadonlyMap<string, Ticket>
): PanelTriggerCard {
  const trigger = records.triggers.get(row.triggerId)
  const disposition = records.triggers.disposition(row.triggerId)
  // 执行器仍拥有的人 follow-up 由它的 worker 决定（§K.2 第 3 条）：它不算「等评估」也不算「被交回」。
  const delivered = trigger !== undefined && records.owners(trigger).length > 0
  const queued = thread.pending.includes(row.triggerId) && !delivered
  const evaluating = thread.evaluating?.triggerIds.includes(row.triggerId) === true
  const decided =
    (disposition?.acked?.length ?? 0) > 0 || (decision !== undefined && settled(decision))
  // 没有人给它下过结论：被 Source 过滤、评估没做成、执行器还拥有它，或到了工单却没有决定。
  const unjudged =
    disposition?.filtered !== undefined ||
    decision?.kind === 'unavailable' ||
    delivered ||
    ((disposition?.fanout.length ?? 0) > 0 && !decided) ||
    (decision !== undefined && !decided)
  const url = textOf(trigger?.url)
  return {
    id: row.triggerId,
    source: trigger?.source ?? thread.ref.source,
    actor: trigger === undefined ? '' : `${trigger.actor.source}:${trigger.actor.id}`,
    human: trigger?.human ?? row.human,
    at: epoch(row.at),
    ...(url === undefined ? {} : { url }),
    text: preview(trigger?.text ?? '', CARD_CHARS),
    queued,
    evaluating,
    delivered,
    fanout: disposition?.fanout ?? [],
    handbacks: (disposition?.handbacks ?? []).map((handback) => ({
      ticketId: handback.ticketId,
      ticketTitle: tickets.get(handback.ticketId)?.title ?? handback.ticketId,
      reason: handback.reason,
      at: epoch(handback.at)
    })),
    ...(decision === undefined ? {} : { decision: panelDecision(decision) }),
    canRequeue: row.human && !queued && !evaluating && unjudged
  }
}

/** 一条 Thread 的订阅 → 面板面（§M.2 的订阅块）：哪张工单、还是不是活的、是否只当语境。 */
function threadTicketOf(
  id: string,
  thread: Thread,
  tickets: ReadonlyMap<string, Ticket>
): PanelThreadTicket {
  const ticket = tickets.get(id)
  return {
    id,
    title: ticket?.title ?? id,
    state: ticket === undefined ? 'unknown' : ticket.ended === undefined ? 'open' : 'ended',
    context: thread.context?.includes(id) === true
  }
}

/** 一次详情请求：`before` 是上一页的 `earlier`，不给就从最新一页开始（§D.2 的复合游标）。 */
export interface ThreadDetailQuery {
  readonly before?: TimelineCursor | null
  readonly limit?: number
}

/**
 * 一条 Thread 的详情（§M.2）：时间线（最新在前，`(at, id)` 游标往回翻）、决定、订阅、
 * handback 原因与正在进行的 Eval。未知的 Thread 返回 `undefined`（调用方按缺失拒绝）。
 */
export function threadDetailView(
  records: ThreadReadRecords,
  key: string,
  query: ThreadDetailQuery = {}
): ThreadDetailView | undefined {
  const thread = records.threads.get(key)
  if (thread === undefined) return undefined
  const tickets = new Map(records.tickets.list().map((ticket) => [ticket.id, ticket] as const))
  const open = new Set(
    [...tickets.values()].filter((ticket) => ticket.ended === undefined).map((ticket) => ticket.id)
  )
  const limit = Math.max(1, Math.min(THREAD_PAGE_MAX, query.limit ?? THREAD_PAGE_MAX))
  const page =
    query.before === undefined || query.before === null
      ? records.timeline.tail(key, limit)
      : records.timeline.before(key, query.before, limit)
  const decisions = records.decisions.byThread(key)
  // 每条 Trigger 消费它的那个 Decision：一批里它出现在哪些 triggerIds 里就归哪条，取最新。
  const byTrigger = new Map<string, Decision>()
  for (const decision of decisions) {
    for (const triggerId of decision.triggerIds) byTrigger.set(triggerId, decision)
  }
  const pending = awaitingEval(thread, records)
  const url = textOf(thread.meta['url'])
  const pollError = textOf(thread.meta['pollError'])
  const evaluating = thread.evaluating
  return {
    key: thread.key,
    source: thread.ref.source,
    title: textOf(thread.meta['label']) ?? url ?? thread.key,
    ...(url === undefined ? {} : { url }),
    stage: stageOf(thread, pending, open),
    createdAt: epoch(thread.createdAt),
    lastAt: epoch(lastAtOf(thread)),
    ...(pollError === undefined ? {} : { pollError }),
    pending,
    ...(evaluating === undefined
      ? {}
      : {
          evaluating: {
            id: evaluating.id,
            strength: evaluating.strength,
            triggers: evaluating.triggerIds.length,
            startedAt: epoch(evaluating.startedAt),
            deadline: epoch(evaluating.deadline)
          }
        }),
    subscriptions: thread.subscriptions.map((id) => threadTicketOf(id, thread, tickets)),
    decisions: [...decisions].reverse().map(panelDecision),
    // 库里的两页都是升序：面板从最新一条往下画（§M.2 的时间线最新在前）。
    timeline: [...page.items].reverse().map((row) =>
      triggerCard(row, thread, records, byTrigger.get(row.triggerId), tickets)
    ),
    earlier: page.before
  }
}

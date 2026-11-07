// 视图读面（§G.3 的 `GET overview/sources/search/threads/thread/decisions/models`、§G.2 的
// `read <resource>` 分页与固定拒绝、§M.2 的 Overview / Search、§O 的 assignment 边界）。
//
// 一件事只在这里做一次：**把「一页视图」的形状、分页、窗口与拒绝收成同一个形状**。
// CLI 的 `read <resource>` 与 HTTP 的视图路由共用它——`http/read.ts` 只把查询串/角色搬进来、
// 把拒绝换成 `ApiError`；面板经同一批 §G.3 路由读同一份读模型。
//
// 三条纪律（与 `app/read.ts`、`app/eval.ts` 同）：
// - **复用既有读模型，不做第二套查询**：Overview 取面板快照（`app/state-source.ts`），
//   Tickets 取 `app/views.ts` 的 `ticketsPage`，Decision 取仓储的 `decisions.list()`（面板 Eval
//   页同一份读），Thread 时间线取 `store-read.ts` 的 `(at, triggerId)` 游标，Models 取
//   `app/roles.ts` 的角色解析，Search 取 Source kind 自己的 `find` 语义；
// - **状态是状态**：没有内容时 `items` 为空并把原因写清楚；不知道的行不编（坏行跳过）；
// - **无权限如实说**：assignment 只读自己 Ticket 相关的 Thread（`mayReadThread`），
//   角色不满足的整个面由路由表拒绝（§O）。
//
// 分页（§G.2 的 read 行）：列表页默认 20、上限 50；Thread 的游标是 `(at, triggerId)` 复合值，
// 编码成 `"<at>|<triggerId>"`（CLI 与面板原样交回 `before`/`around`）。
//
// 依赖纪律（§C.2）：本文件在 `app/`，import 领域类型、既有读模型与注入的读口；不 import
// `http/`、不 import `cli/`、不读存储、不 spawn、不读时钟（`now` 由宿主给）。
import type { Decision, Thread, Ticket, Trigger, TriggerDisposition } from '../../core/index.ts'
import type { Reason } from '../../core/reasons.ts'
import { reasonText } from '../../core/reasons.ts'
import type { PanelState, SystemProblem, WorkerHealth } from '../../../panel/protocol'
import type { SourceOverview } from '../../sources/registry.ts'
import {
  READ_DEFAULT_LIMIT,
  READ_MAX_LIMIT,
  ticketThreads,
  type ReadRefusal
} from '../read.ts'
import type { Roles } from '../roles.ts'
import type { TimelineCursor, TimelineItem } from '../records.ts'
import { ticketView, type TicketView } from '../views.ts'
import type { ReadParam } from '../store-read.ts'

/** Thread 列表的筛选（§M.1 的 Trigger 页：Subscribed / Evaluating / New in 24 h / All）。 */
export const THREAD_FILTERS = ['all', 'subscribed', 'evaluating', 'new'] as const
export type ThreadFilter = (typeof THREAD_FILTERS)[number]

/** Decision 的四种结局（与 `core/model.ts` 的 `DecisionKind` 同值，拒绝里原样列出）。 */
export const DECISION_KINDS = ['accept', 'stop', 'ignore', 'unavailable'] as const

/** 「New in 24 h」的窗口（§M.1）。 */
export const THREAD_NEW_WINDOW_MS = 24 * 60 * 60 * 1000

/** Thread 时间线里一条 Trigger 的正文上限（列表页的 `limit` 是条数，不是字符数）。 */
export const THREAD_PREVIEW_CHARS = 400

/** 复合游标的分隔符：`<at>|<triggerId>`（ISO 文本里没有它；Trigger id 可以含 `/`、`:`）。 */
export const CURSOR_SEPARATOR = '|'

/** 视图读模型需要的 SQL 出口（`Store.sql` 结构上满足；与 `views/attention.ts` 同一模式）。 */
export interface ViewReader {
  readonly sql: {
    all(sql: string, params?: readonly ReadParam[]): readonly unknown[]
  }
}

/** 一页列表的形状（`next_offset` 为 `null` 表示没有下一页）。 */
export interface ViewPage<T> {
  readonly items: readonly T[]
  readonly next_offset: number | null
}

/** Thread 列表的一行：足够画表格（名字、来源、最近消息、订阅与状态），不是整条时间线。 */
export interface ThreadSummary {
  readonly key: string
  readonly source: string
  /** 人读的名字（Source 的 `meta.label`）；没有就是 key。 */
  readonly title: string
  readonly url?: string
  readonly createdAt: string
  readonly lastAt?: string
  /** 订阅者数量（含只当语境的）。 */
  readonly subscriptions: number
  /** 只当语境的订阅者数量。 */
  readonly context: number
  /** 等下一次 Eval 的 Trigger 数量。 */
  readonly pending: number
  readonly evaluating: boolean
}

/** Thread 详情里的 Thread 头（键、来源、订阅、元数据与进行中的 Eval）。 */
export interface ThreadHeader {
  readonly key: string
  readonly source: string
  readonly ref: { readonly source: string; readonly id: string }
  readonly title: string
  readonly url?: string
  readonly createdAt: string
  readonly lastAt?: string
  readonly subscriptions: readonly string[]
  readonly context: readonly string[]
  readonly correlated: readonly string[]
  readonly pending: readonly string[]
  readonly evaluating?: Thread['evaluating']
  readonly expired?: number
  readonly meta: Readonly<Record<string, unknown>>
}

/** 时间线上的一条 Trigger：正文按 `THREAD_PREVIEW_CHARS` 截断，并说明全文长度。 */
export interface TimelineEntry {
  readonly id: string
  readonly at: string
  readonly from: string
  readonly human: boolean
  readonly primaryThread: boolean
  readonly text: string
  readonly chars?: number
  readonly truncated?: true
  readonly url?: string
  /** 这条 Trigger 已落库的 Decision（没有就是还没决定）。 */
  readonly decisionId?: string
  /** 被 Source 过滤时的原因码（§I.1）。 */
  readonly filtered?: string
}

/** 一条 Decision 的读模型（§M.2 的 Eval 页：kind、reason、strength、policy version、at）。 */
export interface DecisionView {
  readonly id: string
  readonly at: string
  readonly kind: string
  readonly threadKey: string
  readonly triggerIds: readonly string[]
  readonly policyVersion: string
  readonly strength: string
  readonly reason: readonly Reason[]
  /** 原因的一句话（`reasonText()` 的同一个格式，agent 直接读）。 */
  readonly reason_text: string
  readonly ticketId?: string
  readonly dismissed?: true
  /** 评估匹配到的规则（`audit.matches`，没有就不给）。 */
  readonly rules?: readonly { readonly rule_id: string; readonly reason: string }[]
}

/** Thread 详情：Thread 头 + 一页时间线 + 这条 Thread 的 Decision（新的在前）。 */
export interface ThreadDetail {
  readonly thread: ThreadHeader
  readonly items: readonly TimelineEntry[]
  /** 把 `before` 传回即可读更早一页；没有更早的行时是 `null`。 */
  readonly before: string | null
  /** 这一页最新一行的游标（把它交给 `around` 就能从这一页往后走）；空页是 `null`。 */
  readonly next: string | null
  readonly decisions: readonly DecisionView[]
}

/** Overview 的一行待人工：时间用 ISO-8601（§G.1 的时间行），不是面板的 epoch。 */
export interface OverviewAttentionItem {
  readonly id: string
  readonly title: string
  readonly action: string
  readonly at: string
  readonly terminalId?: string
}

/** `read overview`：面板首屏的同一份读数（待人工、系统问题、24 h 流水、负载、Source 概况）。 */
export interface OverviewView {
  readonly revision: number
  readonly health: { readonly error: boolean; readonly paused: boolean; readonly setupMissing: boolean }
  readonly attention: {
    readonly answer: number
    readonly review: number
    readonly problems: number
    readonly items: readonly OverviewAttentionItem[]
  }
  readonly problems: readonly SystemProblem[]
  readonly activity: WorkerHealth['activity']
  readonly executor: WorkerHealth['executor']
  readonly sources: WorkerHealth['sources']
}

/** `read sources`：注册表的总览（每个实例的可用性与生命周期），面板 Source 页的同一份。 */
export interface SourcesView {
  readonly items: readonly SourceOverview[]
}

/** 一个角色启动时用的模型条目。 */
export interface ModelEntry {
  readonly role: 'router' | 'worker'
  readonly id: string
}

/** `read models`：两个角色配的模型 id + 一句「目录在 Orca」的说明（§H.16）。 */
export interface ModelsView {
  readonly roles: Roles
  readonly models: readonly ModelEntry[]
  readonly catalog: readonly string[]
  readonly note: string
}

/** 一条命中的 Trigger（Search 的 Trigger 分组）。 */
export interface SearchTriggerView {
  readonly id: string
  readonly source: string
  readonly at: string
  readonly from: string
  readonly human: boolean
  readonly text: string
  readonly chars?: number
  readonly truncated?: true
  readonly url?: string
}

/** 一条命中的 Thread（Search 的 Thread 分组）。 */
export interface SearchThreadView {
  readonly key: string
  readonly source: string
  readonly title: string
  readonly url?: string
  readonly lastAt?: string
}

/** 一个结果分组：命中被 `limit` 截断时 `truncated` 为真（如实说明，不假装是全部）。 */
export interface SearchGroup<T> {
  readonly items: readonly T[]
  readonly truncated: boolean
}

/** `read search`：按 Source 的 `find` 语义分三组（§M.1 的 Search）。 */
export interface SearchView {
  readonly query: string
  /** kind 给出的搜索词（原样，用于解释为什么命中）。 */
  readonly terms: readonly string[]
  readonly threads: SearchGroup<SearchThreadView>
  readonly triggers: SearchGroup<SearchTriggerView>
  readonly tickets: SearchGroup<TicketView>
}

/** 一次分页：`offset` 非负、`limit` 在 1–50 内（§G.2 的 read 行）。 */
export interface ViewPaging {
  readonly offset?: number
  readonly limit?: number
}

/** 视图读工具需要的宿主端口（组合根注入真仓储/注册表/状态源；测试用真库或替身）。 */
export interface ViewReadHost {
  /** 受控 SQL 出口（Search 的 Trigger 匹配：正文 / id / 链接 / 存的 JSON）。 */
  readonly reader: ViewReader
  /** 当前时刻（ISO-8601）：`window` 与「New in 24 h」由服务端换算。 */
  readonly now: () => string
  /** 面板快照（`read overview` 的直接来源，与首屏同一份读数）。 */
  readonly panel: () => PanelState
  /** Source 总览（`registry.overview()`，与 Source 页、`sources` 健康条目同一份）。 */
  readonly sources: () => readonly SourceOverview[]
  /** 两个角色的启动设置（`resolveRoles()`）。 */
  readonly roles: () => Roles
  /** Source kind 自己的 `find`（§M.2 Search 的既有语义）。 */
  readonly find: (query: string) => { readonly threads: readonly string[]; readonly terms: readonly string[] }
  readonly threads: () => readonly Thread[]
  readonly thread: (key: string) => Thread | undefined
  /** Thread 时间线（`store.triggerThreads` 的四个读法）。 */
  readonly timeline: {
    tail(threadKey: string, limit: number): { readonly items: readonly TimelineItem[]; readonly before: TimelineCursor | null }
    before(
      threadKey: string,
      cursor: TimelineCursor,
      limit: number
    ): { readonly items: readonly TimelineItem[]; readonly before: TimelineCursor | null }
    after(
      threadKey: string,
      cursor: TimelineCursor,
      limit: number
    ): { readonly items: readonly TimelineItem[]; readonly next: TimelineCursor | null }
    item(threadKey: string, cursor: TimelineCursor): TimelineItem | undefined
  }
  readonly trigger: (id: string) => Trigger | undefined
  readonly disposition: (id: string) => TriggerDisposition | undefined
  /** 一条 Thread 的 Decision（仓储的 `byThread`，旧的在前）。 */
  readonly threadDecisions: (threadKey: string) => readonly Decision[]
  /** 全部 Decision（仓储的 `list()`，最新的在前）：`read decisions` 的同一份读。 */
  readonly allDecisions: () => readonly Decision[]
  readonly tickets: () => readonly Ticket[]
  readonly ticket: (id: string) => Ticket | undefined
}

/** CLI 与 HTTP 共用的视图读命令（分页/窗口/固定拒绝都在这一个形状里）。 */
export interface ViewReadTools {
  overview(): OverviewView
  sources(): SourcesView
  models(): ModelsView
  threads(options?: ViewPaging & { readonly filter?: string }): ViewPage<ThreadSummary> | ReadRefusal
  thread(
    key: string,
    options?: { readonly before?: string; readonly around?: string; readonly limit?: number }
  ): ThreadDetail | ReadRefusal
  decisions(
    options?: ViewPaging & { readonly kind?: string; readonly window?: string }
  ): ViewPage<DecisionView> | ReadRefusal
  search(options: { readonly query: string; readonly limit?: number }): SearchView | ReadRefusal
  /** assignment 能否读这条 Thread（§O）：自己 Ticket 的来源/跟随/订阅之一。 */
  mayReadThread(ticketId: string, key: string): boolean
}

/** 一次固定拒绝（与 `app/read.ts` 同形：`values` 只放填槽值）。 */
function refuse(
  code: ReadRefusal['code'],
  message: string,
  values?: Readonly<Record<string, string>>
): ReadRefusal {
  return values === undefined ? { ok: false, code, message } : { ok: false, code, message, values }
}

/** 一页的大小：默认 20、上限 50；`offset` 非负整数（§G.2 的 read 行）。 */
function pagingOf(request: ViewPaging): { readonly offset: number; readonly limit: number } | ReadRefusal {
  const offset = request.offset ?? 0
  if (!Number.isInteger(offset) || offset < 0) {
    return refuse('invalid_value', 'offset must be a non-negative integer', { flag: 'offset' })
  }
  const limit = request.limit ?? READ_DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > READ_MAX_LIMIT) {
    return refuse('invalid_value', `limit must be an integer between 1 and ${READ_MAX_LIMIT}`, {
      flag: 'limit',
      max: String(READ_MAX_LIMIT)
    })
  }
  return { offset, limit }
}

/** 一个列表页的切片（与 `app/views.ts` 的 `next_offset` 同义）。 */
function pageOf<T>(items: readonly T[], paging: { readonly offset: number; readonly limit: number }): ViewPage<T> {
  const slice = items.slice(paging.offset, paging.offset + paging.limit)
  const end = paging.offset + slice.length
  return { items: slice, next_offset: end < items.length ? end : null }
}

/** `window` 的相对时长（`24h`、`1h`、`30m`、`7d`）→ 截止时刻；形状不对是 undefined。 */
export function windowStart(now: string, window: string): string | undefined {
  const match = /^([1-9]\d*)(s|m|h|d)$/.exec(window.trim())
  if (match === null) return undefined
  const amount = Number(match[1])
  const unit = match[2]
  const milliseconds =
    amount * (unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000)
  const nowMs = Date.parse(now)
  if (!Number.isFinite(nowMs)) return undefined
  return new Date(nowMs - milliseconds).toISOString()
}

/** 一个 `(at, triggerId)` 游标 → 字符串（原样交给 `before`/`around`）。 */
export function encodeCursor(cursor: TimelineCursor): string {
  return `${cursor.at}${CURSOR_SEPARATOR}${cursor.triggerId}`
}

/** `"<at>|<triggerId>"` → 游标；坏形状是 undefined（调用方落 `invalid_value`）。 */
export function parseCursor(value: string): TimelineCursor | undefined {
  const separator = value.indexOf(CURSOR_SEPARATOR)
  if (separator <= 0) return undefined
  const at = value.slice(0, separator)
  const triggerId = value.slice(separator + 1)
  if (triggerId.length === 0 || !Number.isFinite(Date.parse(at))) return undefined
  return { at, triggerId }
}

/** 一段正文的预览（列表页的条数不是字符数：正文按固定上限截断并说明全文长度）。 */
function previewOf(text: string): { text: string; chars?: number; truncated?: true } {
  return text.length <= THREAD_PREVIEW_CHARS
    ? { text }
    : { text: text.slice(0, THREAD_PREVIEW_CHARS), chars: text.length, truncated: true }
}

/** 一行里的一个文本列（取不到就是空串：坏行不抛）。 */
function textOf(row: unknown, column: string): string {
  if (typeof row !== 'object' || row === null) return ''
  const value = (row as Record<string, unknown>)[column]
  return typeof value === 'string' ? value : ''
}

/** 库里的 JSON 文本 → 普通对象；解不开就不是对象（坏行不抛）。 */
function jsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null) return value as Record<string, unknown>
  if (typeof value !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** 一条结构化原因（`{code, values?, triggerId?}`）；只认带 code 的对象。 */
function isReason(value: unknown): value is Reason {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { code?: unknown }).code === 'string'
  )
}

/** 一个 Decision 的原因：数组就逐条保留；不是数组就是没有。 */
function reasonsOf(value: unknown): readonly Reason[] {
  return Array.isArray(value) ? value.filter(isReason) : []
}

/** 一个字符串数组（取不到就是空数组）。 */
function stringsOf(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** 评估匹配到的规则（`audit.matches` 的 `{rule_id, reason}`），没有就是空数组。 */
function rulesOf(audit: unknown): readonly { readonly rule_id: string; readonly reason: string }[] {
  const matches = jsonObject(audit)?.['matches']
  if (!Array.isArray(matches)) return []
  return matches.flatMap((item) => {
    const entry = jsonObject(item)
    const ruleId = typeof entry?.['rule_id'] === 'string' ? entry['rule_id'] : ''
    if (ruleId.length === 0) return []
    return [{ rule_id: ruleId, reason: typeof entry?.['reason'] === 'string' ? entry['reason'] : '' }]
  })
}

/** 一条完整的 Decision → 读模型。 */
function decisionView(decision: Decision): DecisionView {
  const rules = rulesOf(decision.audit)
  return {
    id: decision.id,
    at: decision.at,
    kind: decision.kind,
    threadKey: decision.threadKey,
    triggerIds: [...decision.triggerIds],
    policyVersion: decision.policyVersion,
    strength: decision.strength,
    reason: [...decision.reason],
    reason_text: reasonText(decision.reason),
    ...(decision.ticketId === undefined ? {} : { ticketId: decision.ticketId }),
    ...(decision.dismissed === true ? { dismissed: true as const } : {}),
    ...(rules.length === 0 ? {} : { rules })
  }
}

/** 一条 Thread 的人读名字（Source 的 `meta.label`）；没有就是 key。 */
function titleOf(thread: Thread): string {
  const label = thread.meta['label']
  return typeof label === 'string' && label.trim().length > 0 ? label : thread.key
}

/** 一条 Thread 的 url（Source 存进 meta 的链接）；没有就不给。 */
function urlOf(thread: Thread): string | undefined {
  const url = thread.meta['url']
  return typeof url === 'string' && url.length > 0 ? url : undefined
}

/** Thread 列表的一行。 */
function summaryOf(thread: Thread): ThreadSummary {
  const url = urlOf(thread)
  return {
    key: thread.key,
    source: thread.ref.source,
    title: titleOf(thread),
    ...(url === undefined ? {} : { url }),
    createdAt: thread.createdAt,
    ...(thread.lastAt === undefined ? {} : { lastAt: thread.lastAt }),
    subscriptions: thread.subscriptions.length,
    context: thread.context?.length ?? 0,
    pending: thread.pending.length,
    evaluating: thread.evaluating !== undefined
  }
}

/** Thread 列表的排序键：最近一条消息在前，同刻按 key（与库里的 `key` 序一致）。 */
function lastTimeOf(thread: Thread): number {
  const parsed = Date.parse(thread.lastAt ?? thread.createdAt)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Thread 列表的筛选（§M.1：Subscribed / Evaluating / New in 24 h / All）。 */
function matchesThreadFilter(thread: Thread, filter: ThreadFilter, cutoff: string): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'subscribed':
      return thread.subscriptions.length > 0
    case 'evaluating':
      return thread.evaluating !== undefined
    case 'new':
      return thread.lastAt !== undefined && thread.lastAt >= cutoff
  }
}

/** Thread 详情里的 Thread 头。 */
function headerOf(thread: Thread): ThreadHeader {
  const url = urlOf(thread)
  return {
    key: thread.key,
    source: thread.ref.source,
    ref: { source: thread.ref.source, id: thread.ref.id },
    title: titleOf(thread),
    ...(url === undefined ? {} : { url }),
    createdAt: thread.createdAt,
    ...(thread.lastAt === undefined ? {} : { lastAt: thread.lastAt }),
    subscriptions: [...thread.subscriptions],
    context: [...(thread.context ?? [])],
    correlated: [...thread.correlated],
    pending: [...thread.pending],
    ...(thread.evaluating === undefined ? {} : { evaluating: thread.evaluating }),
    ...(thread.expired === undefined ? {} : { expired: thread.expired }),
    meta: thread.meta
  }
}

/** 时间线上的一行：Trigger 的正文按预览截断，已决定的带上 decisionId。 */
function entryOf(host: ViewReadHost, item: TimelineItem): TimelineEntry {
  const trigger = host.trigger(item.triggerId)
  const disposition = host.disposition(item.triggerId)
  const preview = previewOf(trigger?.text ?? '')
  return {
    id: item.triggerId,
    at: item.at,
    from: trigger?.actor.id ?? '',
    human: item.human,
    primaryThread: item.primaryThread,
    text: preview.text,
    ...(preview.chars === undefined ? {} : { chars: preview.chars }),
    ...(preview.truncated === true ? { truncated: true as const } : {}),
    ...(trigger?.url === undefined ? {} : { url: trigger.url }),
    ...(disposition?.decisionId === undefined ? {} : { decisionId: disposition.decisionId }),
    ...(disposition?.filtered === undefined ? {} : { filtered: disposition.filtered.code })
  }
}

/** 一页时间线（`before`/`next` 都是给下一次读的游标；没有就是 `null`）。 */
function timelinePageOf(
  host: ViewReadHost,
  items: readonly TimelineItem[],
  before: string | null
): { readonly items: readonly TimelineEntry[]; readonly before: string | null; readonly next: string | null } {
  const last = items.at(-1)
  return {
    items: items.map((item) => entryOf(host, item)),
    before,
    next: last === undefined ? null : encodeCursor({ at: last.at, triggerId: last.triggerId })
  }
}

/** `around` 的一页：锚点 + 前后各半页（`limit - 1` 的一半）；锚点不存在是 `missing`。 */
function aroundPage(
  host: ViewReadHost,
  key: string,
  cursor: TimelineCursor,
  limit: number
): { readonly items: readonly TimelineEntry[]; readonly before: string | null; readonly next: string | null } | ReadRefusal {
  const anchor = host.timeline.item(key, cursor)
  if (anchor === undefined) {
    return refuse('missing', 'No trigger at that cursor on this thread', {
      thread: key,
      cursor: encodeCursor(cursor)
    })
  }
  const half = Math.floor((limit - 1) / 2)
  const older = host.timeline.before(key, cursor, half + 1)
  const newer = host.timeline.after(key, cursor, half + 1)
  const olderItems = half === 0 ? [] : older.items.slice(-half)
  const newerItems = newer.items.slice(0, half)
  const items = [...olderItems, anchor, ...newerItems]
  const moreOlder = older.items.length > half
  const moreNewer = newer.items.length > half
  const first = items[0]
  const last = items.at(-1)
  return {
    items: items.map((item) => entryOf(host, item)),
    before: moreOlder && first !== undefined ? encodeCursor({ at: first.at, triggerId: first.triggerId }) : null,
    next: moreNewer && last !== undefined ? encodeCursor({ at: last.at, triggerId: last.triggerId }) : null
  }
}

/** Search 的 Trigger 匹配（文本 / id / 链接 / 存的 JSON，大小写不敏感；按时间新的在前）。 */
function searchTriggers(
  reader: ViewReader,
  terms: readonly string[],
  limit: number
): { readonly items: readonly SearchTriggerView[]; readonly truncated: boolean } {
  if (terms.length === 0) return { items: [], truncated: false }
  const clauses: string[] = []
  const params: string[] = []
  for (const term of terms) {
    const like = `%${term.toLowerCase()}%`
    clauses.push(
      "lower(id) LIKE ?",
      "lower(text) LIKE ?",
      "lower(COALESCE(url, '')) LIKE ?",
      'lower(body) LIKE ?'
    )
    params.push(like, like, like, like)
  }
  const rows = reader.sql.all(
    `SELECT id, source, at, human, text, url, actor
       FROM trigger
      WHERE ${clauses.join(' OR ')}
      ORDER BY at DESC, id DESC
      LIMIT ?`,
    [...params, limit + 1]
  )
  const items = rows.slice(0, limit).flatMap((row): SearchTriggerView[] => {
    const id = textOf(row, 'id')
    if (id.length === 0) return []
    const preview = previewOf(textOf(row, 'text'))
    const actor = jsonObject(
      typeof row === 'object' && row !== null ? (row as Record<string, unknown>)['actor'] : undefined
    )
    const url = textOf(row, 'url')
    return [
      {
        id,
        source: textOf(row, 'source'),
        at: textOf(row, 'at'),
        from: typeof actor?.['id'] === 'string' ? actor['id'] : '',
        human: Number((row as Record<string, unknown>)['human']) === 1,
        text: preview.text,
        ...(preview.chars === undefined ? {} : { chars: preview.chars }),
        ...(preview.truncated === true ? { truncated: true as const } : {}),
        ...(url.length === 0 ? {} : { url })
      }
    ]
  })
  return { items, truncated: rows.length > limit }
}

/**
 * 造视图读命令（§G.3 的七个视图路由）。每个方法先判参数（分页/筛选/窗口/游标），再读注入的
 * 读口；**不猜内容**：坏行跳过，空结果是空结果，错误是固定拒绝。
 */
export function createViewReadTools(host: ViewReadHost): ViewReadTools {
  const threadsOf = (
    options: ViewPaging & { readonly filter?: string } = {}
  ): ViewPage<ThreadSummary> | ReadRefusal => {
    const paging = pagingOf(options)
    if ('ok' in paging) return paging
    const filter = options.filter ?? 'all'
    if (!(THREAD_FILTERS as readonly string[]).includes(filter)) {
      return refuse('invalid_value', `filter must be one of: ${THREAD_FILTERS.join(', ')}`, {
        flag: 'filter',
        choices: THREAD_FILTERS.join(',')
      })
    }
    const cutoff = new Date(Date.parse(host.now()) - THREAD_NEW_WINDOW_MS).toISOString()
    const matched = host
      .threads()
      .filter((thread) => matchesThreadFilter(thread, filter as ThreadFilter, cutoff))
      .sort((left, right) => {
        const difference = lastTimeOf(right) - lastTimeOf(left)
        return difference !== 0 ? difference : left.key.localeCompare(right.key)
      })
    return pageOf(matched.map((thread) => summaryOf(thread)), paging)
  }

  const threadOf = (
    key: string,
    options: { readonly before?: string; readonly around?: string; readonly limit?: number } = {}
  ): ThreadDetail | ReadRefusal => {
    const thread = host.thread(key)
    if (thread === undefined) return refuse('missing', 'No such thread', { thread: key })
    const limit = options.limit ?? READ_DEFAULT_LIMIT
    if (!Number.isInteger(limit) || limit < 1 || limit > READ_MAX_LIMIT) {
      return refuse('invalid_value', `limit must be an integer between 1 and ${READ_MAX_LIMIT}`, {
        flag: 'limit',
        max: String(READ_MAX_LIMIT)
      })
    }
    if (options.before !== undefined && options.around !== undefined) {
      return refuse('invalid_value', 'before and around are mutually exclusive', { flag: 'before' })
    }
    let page: { readonly items: readonly TimelineEntry[]; readonly before: string | null; readonly next: string | null }
    if (options.around !== undefined) {
      const cursor = parseCursor(options.around)
      if (cursor === undefined) {
        return refuse('invalid_value', 'around must be "<at>|<triggerId>"', { flag: 'around' })
      }
      const centered = aroundPage(host, key, cursor, limit)
      if ('ok' in centered) return centered
      page = centered
    } else if (options.before !== undefined) {
      const cursor = parseCursor(options.before)
      if (cursor === undefined) {
        return refuse('invalid_value', 'before must be "<at>|<triggerId>"', { flag: 'before' })
      }
      const older = host.timeline.before(key, cursor, limit)
      page = timelinePageOf(host, older.items, older.before === null ? null : encodeCursor(older.before))
    } else {
      const tail = host.timeline.tail(key, limit)
      page = timelinePageOf(host, tail.items, tail.before === null ? null : encodeCursor(tail.before))
    }
    const decisions = [...host.threadDecisions(key)].reverse().slice(0, limit).map(decisionView)
    return { thread: headerOf(thread), ...page, decisions }
  }

  const decisionsOf = (
    options: ViewPaging & { readonly kind?: string; readonly window?: string } = {}
  ): ViewPage<DecisionView> | ReadRefusal => {
    const paging = pagingOf(options)
    if ('ok' in paging) return paging
    const kind = options.kind
    if (kind !== undefined && !(DECISION_KINDS as readonly string[]).includes(kind)) {
      return refuse('invalid_value', `kind must be one of: ${DECISION_KINDS.join(', ')}`, {
        flag: 'kind',
        choices: DECISION_KINDS.join(',')
      })
    }
    let cutoff: string | undefined
    if (options.window !== undefined) {
      cutoff = windowStart(host.now(), options.window)
      if (cutoff === undefined) {
        return refuse('invalid_value', 'window must look like 24h, 1h, 30m or 7d', {
          flag: 'window',
          value: options.window
        })
      }
    }
    // 同一个读模型也服务面板的 Eval 页（`views/decisions.ts` 的 `decisionPage`）：这里只按
    // kind/window 过滤后走同一条「最新在前」的序，再分页，不另写一条查询。
    const matched = host
      .allDecisions()
      .filter((decision) => kind === undefined || decision.kind === kind)
      .filter((decision) => cutoff === undefined || decision.at >= cutoff)
      .sort((left, right) =>
        left.at === right.at ? right.id.localeCompare(left.id) : right.at.localeCompare(left.at)
      )
    return pageOf(matched.map((decision) => decisionView(decision)), paging)
  }

  const searchOf = (options: { readonly query: string; readonly limit?: number }): SearchView | ReadRefusal => {
    const query = options.query.trim()
    if (query.length === 0) {
      return refuse('invalid_value', 'search needs q: text, a message id, a thread reference or a link', {
        flag: 'q'
      })
    }
    const paging = pagingOf({ limit: options.limit })
    if ('ok' in paging) return paging
    const found = host.find(query)
    const terms = found.terms.filter((term) => term.trim().length > 0).slice(0, 8)
    const lowered = terms.map((term) => term.toLowerCase())
    const matches = (text: string): boolean => lowered.some((term) => text.toLowerCase().includes(term))
    const pinned = new Set(found.threads)
    const threads = host.threads()
    const matchedThreads = threads.filter((thread) => {
      if (pinned.has(thread.key)) return true
      const label = typeof thread.meta['label'] === 'string' ? thread.meta['label'] : ''
      const url = typeof thread.meta['url'] === 'string' ? thread.meta['url'] : ''
      return matches(thread.key) || matches(label) || matches(url)
    })
    const matchedKeys = new Set(matchedThreads.map((thread) => thread.key))
    const tickets = host.tickets()
    const matchedTickets = tickets.filter((ticket) => {
      if (matches(ticket.title)) return true
      const related = ticketThreads(ticket, host.trigger)
      for (const key of related) {
        if (matchedKeys.has(key) || matches(key)) return true
      }
      return false
    })
    return {
      query,
      terms,
      threads: {
        items: matchedThreads.slice(0, paging.limit).map((thread) => {
          const url = urlOf(thread)
          return {
            key: thread.key,
            source: thread.ref.source,
            title: titleOf(thread),
            ...(url === undefined ? {} : { url }),
            ...(thread.lastAt === undefined ? {} : { lastAt: thread.lastAt })
          }
        }),
        truncated: matchedThreads.length > paging.limit
      },
      triggers: searchTriggers(host.reader, terms, paging.limit),
      tickets: {
        items: matchedTickets.slice(0, paging.limit).map((ticket) => ticketView(ticket)),
        truncated: matchedTickets.length > paging.limit
      }
    }
  }

  return {
    overview(): OverviewView {
      const panel = host.panel()
      return {
        revision: panel.revision,
        health: {
          error: panel.health.error,
          paused: panel.health.paused,
          setupMissing: panel.health.setupMissing
        },
        attention: {
          answer: panel.attention.answer,
          review: panel.attention.review,
          problems: panel.attention.problems,
          items: panel.attention.items.map((item) => ({
            id: item.id,
            title: item.title,
            action: item.action,
            at: Number.isFinite(item.at) ? new Date(item.at).toISOString() : '',
            ...(item.terminalId === undefined ? {} : { terminalId: item.terminalId })
          }))
        },
        problems: panel.problems,
        activity: panel.health.activity,
        executor: panel.health.executor,
        sources: panel.health.sources
      }
    },
    sources(): SourcesView {
      return { items: host.sources() }
    },
    models(): ModelsView {
      const roles = host.roles()
      const models: ModelEntry[] = []
      if (roles.router.model !== undefined) models.push({ role: 'router', id: roles.router.model })
      if (roles.worker.model !== undefined) models.push({ role: 'worker', id: roles.worker.model })
      return {
        roles,
        models,
        catalog: [],
        note:
          'Orca owns the model catalog: this lists the model ids this deployment passes to its agents ' +
          '(Orca settings), and a model id is free text that only fails at launch.'
      }
    },
    threads: threadsOf,
    thread: threadOf,
    decisions: decisionsOf,
    search: searchOf,
    mayReadThread(ticketId: string, key: string): boolean {
      const ticket = host.ticket(ticketId)
      if (ticket === undefined) return false
      const thread = host.thread(key)
      if (
        thread !== undefined &&
        (thread.subscriptions.includes(ticketId) || (thread.context ?? []).includes(ticketId))
      ) {
        return true
      }
      if ((ticket.follows ?? []).some((follow) => follow.thread === key)) return true
      return ticketThreads(ticket, host.trigger).has(key)
    }
  }
}

// 读模型：Source 页（§M.2 的 Source 行、§I.1 kind 的字段与事实、§I.2/I.3 的过滤、§J.1 的 drop）。
//
// 一处定义：面板的 Source 页只读这一份形状。每张卡回答四件事——它现在是什么状态（注册表
// 的生命周期 + 这个 Source 自己的 setup 问题）、它配置成什么样（kind 的字段与 facts）、
// 它最近做了什么（24 h 计数：收到的 Trigger、被过滤的 Trigger、被 drop 的消息），以及
// 哪里要人（内联的 setup 问题、health error 条目）。
//
// 窗口与排序是硬规则（票面验收）：
// - 「被过滤」「被 drop」都只看最近 24 h，且各自有一个预览上限；`total` 是窗口里的真实条数，
//   面板据此说明「只列了最近几条」，绝不把截断当成全部；
// - 两个列表都按时间降序（同一时刻按 id 降序），因此同一份读数每次都得到同样的顺序；
// - 每条 drop 消息带它所属的 Ticket（更准）或 Thread，面板据此给链接；两者都没有就不给链接。
//
// 依赖纪律（§C.2）：本文件在 `app/`，只 import core 的类型、Source 的**类型**与注入的读数；
// 读库只经 `Store.sql.all` 这条受控出口（与 `views/attention.ts` 同一条纪律），不 import
// store / runtime / sources 的实现，也不读时钟（`now` 由组合根给）。
import type { HealthEntry, Thread, Ticket, Trigger } from '../../core/index.ts'
import type { Fact, Field, Localized, SourceKind } from '../../sources/kind.ts'
import type { SourceOverview } from '../../sources/registry.ts'
import type { ReadParam } from '../store-read.ts'
import type { SetupIssue } from '../setup-types.ts'
// 容错读取与预览只有 `views/values.ts` 一份（#64）：本文件只引用，不再各写一遍。
import { jsonObject, previewOf, textOf } from './values.ts'
import type { OutboxEntry, OutboxDropReason } from '../outbox.ts'
import type {
  DeploymentSetupIssue,
  HealthDetail,
  PanelDroppedMessage,
  PanelFilteredTrigger,
  PanelSource,
  PanelSourceFact,
  PanelSourceField,
  PanelSourceRow,
  PanelSourceState,
  PanelSourceStats,
  SourcePageView
} from '../../../panel/protocol'

/** 24 h 窗口（§M.2 的「24 h 计数」、§J.1 的「按 24 h 窗口列出」）。 */
export const SOURCE_WINDOW_MS = 24 * 60 * 60 * 1000

/** 每张卡最多列几条被过滤的 Trigger（与上游面板同一上限；`total` 仍是窗口里的真实条数）。 */
export const FILTERED_PREVIEW = 5

/** 每张卡最多列几条被 drop 的消息（§M.4：长列表靠一页 50 条，面板给「只列了最近几条」）。 */
export const DROPPED_PREVIEW = 50

/** 一行摘要的字符上限（被过滤的 Trigger 与被 drop 的消息共用；超出截断并加省略号）。 */
export const SOURCE_PREVIEW_CHARS = 160

/** 读模型需要的受控 SQL 出口（`Store.sql` 结构上满足它；与 `views/attention.ts` 同一条）。 */
export interface SourceReader {
  readonly sql: {
    all(sql: string, params?: readonly ReadParam[]): readonly unknown[]
  }
}

/** 一个 kind 的只读展示信息：字段、事实、标题与声明（注册表的 `kind()` 结构上满足它）。 */
export type SourceKindView = Pick<
  SourceKind,
  'kind' | 'title' | 'description' | 'fields' | 'facts' | 'refreshLabels'
>

/** Source 页读模型要的注入端口（组合根接真库与注册表；测试接固定值）。 */
export interface SourceViewHost {
  /** 一次读数共用的时刻（ISO-8601）：24 h 窗口从这里算。 */
  readonly now: string
  /** 注册表的总览（每个实例的生命周期，§I.1）。 */
  readonly overview: () => readonly SourceOverview[]
  /** 健康板的全部条目（按条目名）。 */
  readonly health: () => Readonly<Record<string, HealthEntry | undefined>>
  /** 当前的 setup 结论（§I.4；逐条有 `place`）。 */
  readonly setup: () => readonly SetupIssue[]
  /** 一个 kind 的只读展示信息；kind 未安装时 undefined。 */
  readonly kind: (id: string) => SourceKindView | undefined
  /** 部署派生的事实，按 kind（`registry.facts(deployment)`）。 */
  readonly facts: () => readonly { readonly kind: string; readonly facts: readonly Fact[] }[]
  /** 一个实例已校验的配置（字段的已保存值从这里取；未安装时 undefined）。 */
  readonly config: (id: string) => Readonly<Record<string, unknown>> | undefined
  /** 现在能同步名单的 Source（`policy.sync` 驱动器的 `syncable()`）。 */
  readonly syncable: () => readonly string[]
  /** 受控 SQL 出口（24 h 计数与被过滤的 Trigger）。 */
  readonly reader: SourceReader
  /** 24 h 内被 drop 的消息（`outbox.droppedSince`）。 */
  readonly dropped: (since: string) => readonly OutboxEntry[]
  readonly ticket: (id: string) => Ticket | undefined
  readonly trigger: (id: string) => Trigger | undefined
  readonly thread: (key: string) => Thread | undefined
}

/** 一个 Source 在 24 h 窗口里的计数（SQL 的一行）。 */
interface StatRow {
  readonly source: string
  readonly received: number
  readonly filtered: number
  readonly lastAt?: string
}

/**
 * 每个 Source 的 24 h 计数：收到的 Trigger、被过滤的 Trigger（disposition 行有 `filtered`）、
 * 最近一条的时刻。一次查询，`GROUP BY source`；不需要面板再数一遍。
 */
export const SOURCE_STATS_SQL = `
  SELECT t.source AS source,
         COUNT(*) AS received,
         MAX(t.at) AS last_at,
         SUM(CASE WHEN d.filtered IS NOT NULL AND d.filtered <> '' THEN 1 ELSE 0 END) AS filtered
    FROM trigger t
    LEFT JOIN disposition d ON d.trigger_id = t.id
   WHERE t.at >= ?
   GROUP BY t.source`

/**
 * 一个 Source 在 24 h 窗口里被过滤的 Trigger，最新在前；`COUNT(*) OVER ()` 同时给出窗口里的
 * 真实条数（`total`），因此面板能区分「窗口里就这几条」与「预览只列了前几条」。
 */
export const SOURCE_FILTERED_SQL = `
  SELECT t.id AS id, t.at AS at, t.actor AS actor, t.text AS text, d.filtered AS code,
         (SELECT tt.thread_key FROM trigger_thread tt
           WHERE tt.trigger_id = t.id AND tt.primary_thread = 1 LIMIT 1) AS thread_key,
         COUNT(*) OVER () AS total
    FROM trigger t
    JOIN disposition d ON d.trigger_id = t.id
   WHERE t.source = ? AND t.at >= ? AND d.filtered IS NOT NULL AND d.filtered <> ''
   ORDER BY t.at DESC, t.id DESC
   LIMIT ?`

/** ISO 文本 → epoch ms（面板的时间一律交给 `RelativeTime`）。解不开就是 0。 */
function epoch(at: string): number {
  const parsed = Date.parse(at)
  return Number.isFinite(parsed) ? parsed : 0
}

/** 窗口起点：`now` 往前 `SOURCE_WINDOW_MS`（`Date#toISOString()` 的形态，文本比较即时间比较）。 */
export function windowStart(now: string): string {
  const nowMs = Date.parse(now)
  if (!Number.isFinite(nowMs)) return now
  return new Date(nowMs - SOURCE_WINDOW_MS).toISOString()
}

/** 一行里的一个数字列（取不到或解不开就是 0）。 */
function numberOf(row: unknown, column: string): number {
  if (typeof row !== 'object' || row === null) return 0
  const value = (row as Record<string, unknown>)[column]
  return typeof value === 'number' && Number.isFinite(value) ? value : Number(value ?? 0) || 0
}

/** 按来源分组的 24 h 计数。 */
function statRows(reader: SourceReader, since: string): ReadonlyMap<string, StatRow> {
  const rows = reader.sql.all(SOURCE_STATS_SQL, [since])
  const found = new Map<string, StatRow>()
  for (const row of rows) {
    const source = textOf(row, 'source')
    if (source === '') continue
    const lastAt = textOf(row, 'last_at')
    found.set(source, {
      source,
      received: numberOf(row, 'received'),
      filtered: numberOf(row, 'filtered'),
      ...(lastAt === '' ? {} : { lastAt })
    })
  }
  return found
}

/** 一个 Source 在 24 h 窗口里被过滤的 Trigger（最多 `FILTERED_PREVIEW` 条）与窗口总数。 */
function filteredOf(
  reader: SourceReader,
  source: string,
  since: string
): { readonly total: number; readonly items: readonly PanelFilteredTrigger[] } {
  const rows = reader.sql.all(SOURCE_FILTERED_SQL, [source, since, FILTERED_PREVIEW])
  const items = rows.flatMap((row): PanelFilteredTrigger[] => {
    const id = textOf(row, 'id')
    if (id === '') return []
    const actor = jsonObject(
      typeof row === 'object' && row !== null ? (row as Record<string, unknown>)['actor'] : undefined
    )
    const threadKey = textOf(row, 'thread_key')
    // 一行摘要：折叠空白、超出就截断并加省略号（面板只放得下一行）。
    const preview = previewOf(textOf(row, 'text'), {
      limit: SOURCE_PREVIEW_CHARS,
      flatten: true,
      ellipsis: true
    })
    return [
      {
        id,
        at: epoch(textOf(row, 'at')),
        actor: typeof actor?.['id'] === 'string' ? actor['id'] : '',
        code: textOf(row, 'code'),
        ...(preview.text === '' ? {} : { text: preview.text }),
        ...(threadKey === '' ? {} : { threadKey })
      }
    ]
  })
  const total = rows.length === 0 ? 0 : Math.max(numberOf(rows[0], 'total'), items.length)
  return { total, items }
}

/** 一条 Thread 给人看的名字（Source 给的 `meta.label`）；没有就是 key。 */
function threadTitle(thread: Thread | undefined, key: string): string {
  const label = thread?.meta['label']
  return typeof label === 'string' && label.trim() !== '' ? label : key
}

/**
 * 一条 drop 消息所属的 Thread：先看 Channel 的 `thread` 是不是一条真 Thread 的键
 * （GitHub 的 Channel 直接就是 `github:<number>`）；不是时退回产生这条回复的 Ticket 的
 * 来源 Thread（飞书的 Channel 只带群 id）。找不到就省略——不编一个链接。
 */
function droppedThread(
  host: SourceViewHost,
  message: { readonly channel: { readonly thread: string }; readonly ticketId?: string }
): Thread | undefined {
  const direct = host.thread(message.channel.thread)
  if (direct !== undefined) return direct
  if (message.ticketId === undefined) return undefined
  const ticket = host.ticket(message.ticketId)
  const origin = ticket === undefined ? undefined : host.trigger(ticket.origin.triggerId)
  const ref = origin?.threads[0]
  return ref === undefined ? undefined : host.thread(`${ref.source}:${ref.id}`)
}

/** 一条 outbox 消息 → 卡上的 drop 行（原因、时刻、预览，以及 Ticket 或 Thread 链接）。 */
function droppedMessageOf(host: SourceViewHost, entry: OutboxEntry): PanelDroppedMessage | undefined {
  const reason = entry.record.droppedReason
  if (reason === null) return undefined
  const at = entry.record.droppedAt
  if (at === null) return undefined
  const ticket = entry.message.ticketId === undefined ? undefined : host.ticket(entry.message.ticketId)
  const thread = droppedThread(host, entry.message)
  // 与「被过滤的 Trigger」同一条摘要规则：折叠空白、超出截断（详情不重放整段原文）。
  const preview = previewOf(entry.message.text, {
    limit: SOURCE_PREVIEW_CHARS,
    flatten: true,
    ellipsis: true
  })
  return {
    id: entry.record.id,
    at: epoch(at),
    reason: reason as OutboxDropReason,
    kind: entry.message.kind,
    ...(preview.text === '' ? {} : { text: preview.text }),
    ...(ticket === undefined ? {} : { ticket: { id: ticket.id, title: ticket.title } }),
    ...(thread === undefined ? {} : { thread: { key: thread.key, title: threadTitle(thread, thread.key) } })
  }
}

/** 一个 Source 在窗口里被 drop 的消息（来源按 Channel 的 `source` 归）；最新在前。 */
function droppedOf(
  host: SourceViewHost,
  source: string,
  since: string
): { readonly total: number; readonly items: readonly PanelDroppedMessage[] } {
  const all = host
    .dropped(since)
    .filter((entry) => entry.message.channel.source === source)
    .flatMap((entry) => {
      const message = droppedMessageOf(host, entry)
      return message === undefined ? [] : [message]
    })
    .sort((left, right) => right.at - left.at || right.id.localeCompare(left.id))
  return { total: all.length, items: all.slice(0, DROPPED_PREVIEW) }
}

/** 一个 kind 字段的已保存值 → 面板可渲染的形状（只读展示，编辑在 Settings 的 Sources 组）。 */
function fieldValueOf(field: Field, config: Readonly<Record<string, unknown>>): PanelSourceField['value'] {
  const value = config[field.key]
  switch (field.type) {
    case 'switch':
      return { type: 'flag', on: value === true }
    case 'select': {
      const option = field.options.find((choice) => choice.value === value)
      return { type: 'choice', label: option?.label ?? (typeof value === 'string' ? value : '') }
    }
    case 'rows':
      return { type: 'rows', rows: rowsOf(field, value) }
    case 'number':
      return { type: 'text', text: typeof value === 'number' ? String(value) : '' }
    case 'fact':
      // facts 从 `facts()` 单独来（它由部署派生），字段本身不展示配置值。
      return { type: 'text', text: '' }
    default:
      return { type: 'text', text: typeof value === 'string' ? value : '' }
  }
}

/** 一个 `rows` 字段的已保存行：第一列作键，其余列按列序（下拉列用选项文案）。 */
function rowsOf(field: Extract<Field, { type: 'rows' }>, value: unknown): readonly PanelSourceRow[] {
  if (!Array.isArray(value)) return []
  const [first, ...rest] = field.columns
  if (first === undefined) return []
  return value.flatMap((entry): PanelSourceRow[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const record = entry as Record<string, unknown>
    const key = typeof record[first.key] === 'string' ? (record[first.key] as string) : ''
    const cells = rest.map((column): Localized | string => {
      const cell = record[column.key]
      if (column.type === 'select') {
        const option = column.options.find((choice) => choice.value === cell)
        if (option !== undefined) return option.label
      }
      return typeof cell === 'string' ? cell : ''
    })
    return [{ key, cells }]
  })
}

/** 一个 kind 的字段表（跳过 `fact`：它们由 `facts()` 单独给出）。 */
function fieldsOf(kind: SourceKindView | undefined, config: Readonly<Record<string, unknown>>): readonly PanelSourceField[] {
  if (kind === undefined) return []
  return kind.fields
    .filter((field) => field.type !== 'fact')
    .map((field) => ({ key: field.key, label: field.label, value: fieldValueOf(field, config) }))
}

/** 一个 kind 的部署派生事实；标签取同名字段的标签，没有就用键。 */
function factsOf(kind: SourceKindView | undefined, facts: readonly Fact[] | undefined): readonly PanelSourceFact[] {
  if (kind === undefined || facts === undefined) return []
  return facts.map((fact) => {
    const field = kind.fields.find((item) => item.key === fact.key)
    return { key: fact.key, label: field?.label ?? fact.key, value: fact.value }
  })
}

/** 一个 Source 声明的 health 条目（含 `sync:<id>` 这条归属它的设置条目）。 */
function healthOf(
  overview: SourceOverview,
  health: Readonly<Record<string, HealthEntry | undefined>>
): readonly HealthDetail[] {
  const names = [...overview.entries, `sync:${overview.id}`]
  return names.flatMap((name): HealthDetail[] => {
    const entry = health[name]
    if (entry === undefined) return []
    return [{ name, state: entry.state, ...(entry.detail === undefined ? {} : { detail: entry.detail }) }]
  })
}

/**
 * 面板的生命周期（§I.1）：注册表已经给出 `missing/off/starting/paused/error/ready`，这里只加
 * 面板自己的两件事——配置无效仍是 error（它不是人主动关的），以及 setup 问题让这个 Source
 * 「等待部署检查」（不是 error：setup 问题绝不写成 health error，§I.4）。
 */
export function sourceStateOf(overview: SourceOverview, hasProblem: boolean): PanelSourceState {
  if (!overview.installed) return 'missing'
  if (overview.configError !== undefined || overview.state === 'error') return 'error'
  if (!overview.enabled || overview.state === 'off') return 'off'
  if (hasProblem) return 'setup'
  if (overview.state === 'paused') return 'paused'
  if (overview.state === 'starting') return 'starting'
  return 'ready'
}

/** setup 问题 → 面板的一条结论（字段逐字相同；`checkAgain` 由构造处统一填）。 */
function setupIssueOf(issue: SetupIssue): DeploymentSetupIssue {
  return {
    place: issue.place,
    code: issue.code,
    kind: issue.kind,
    detail: issue.detail,
    fix: issue.fix,
    checkAgain: issue.checkAgain
  }
}

/** 一次读数的一份输入：全部来源已按本次时刻取好（窗口起点只算一次）。 */
function cardOf(
  host: SourceViewHost,
  overview: SourceOverview,
  since: string,
  problems: readonly SetupIssue[],
  stats: ReadonlyMap<string, StatRow>,
  factsByKind: ReadonlyMap<string, readonly Fact[]>
): PanelSource {
  const kind = host.kind(overview.id)
  const config = host.config(overview.id) ?? {}
  const problem = problems.find((issue) => issue.place === overview.id)
  const row = stats.get(overview.id)
  const statsOf: PanelSourceStats = {
    received: row?.received ?? 0,
    filtered: row?.filtered ?? 0,
    ...(row?.lastAt === undefined ? {} : { lastAt: epoch(row.lastAt) })
  }
  return {
    id: overview.id,
    title: kind?.title ?? overview.title,
    ...(kind?.description === undefined ? {} : { description: kind.description }),
    installed: overview.installed,
    enabled: overview.enabled,
    state: sourceStateOf(overview, problem !== undefined),
    ...(overview.configError === undefined ? {} : { configError: overview.configError }),
    ...(problem === undefined ? {} : { problem: setupIssueOf(problem) }),
    fields: fieldsOf(kind, config),
    facts: factsOf(kind, factsByKind.get(overview.id)),
    health: healthOf(overview, host.health()),
    stats: statsOf,
    filtered: filteredOf(host.reader, overview.id, since),
    dropped: droppedOf(host, overview.id, since),
    canSync: host.syncable().includes(overview.id),
    canRefreshLabels: kind?.refreshLabels !== undefined
  }
}

/**
 * 读一份 Source 页：每个配置过的实例一张卡。setup 问题按 `place` 归到对应的 Source；
 * 不归属任何 Source 的那些（状态目录、Orca CLI）放在 `elsewhere`，由页首单独提示——
 * 一张卡的问题绝不遮住另一张卡。
 */
export function sourcePage(host: SourceViewHost): SourcePageView {
  const since = windowStart(host.now)
  const overviews = host.overview()
  const problems = host.setup()
  const factsByKind = new Map(host.facts().map((item) => [item.kind, item.facts]))
  const stats = statRows(host.reader, since)
  const ids = new Set(overviews.map((overview) => overview.id))
  return {
    items: overviews.map((overview) =>
      cardOf(host, overview, since, problems, stats, factsByKind)
    ),
    elsewhere: problems
      .filter((issue) => !ids.has(issue.place))
      .map(setupIssueOf)
  }
}

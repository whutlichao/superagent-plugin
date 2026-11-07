// Trigger 页的纯逻辑（§M.2 的四列、§M.4 的 `Table` 列）：与页面拆开，单元格与列的顺序单独钉。
//
// 纯数据：不 import `orca` 的运行时值，也不碰 worker（§C.2 规则 3）。筛选的判定本身在 worker
// 的读模型里（`app/views/threads.ts`），面板只把档位原样发过去——两处各写一套「谁在等人」的
// 规则就一定会分叉。
import type { TableCell } from 'orca'
import { translate, type CopyKey } from './copy'
import { markLabel, threadMark } from './marks'
import type { PanelThread, ThreadFilter } from './protocol'

/** 四列的列键（§M.2：Thread 的 label/url、订阅数、最近触发、状态标记）。 */
export type ThreadColumnKey = 'thread' | 'subscriptions' | 'latest' | 'state'

/** 一条 Thread 行的四个单元格（`Table` 的 `rows[].cells`）。 */
export type ThreadCells = Readonly<Record<ThreadColumnKey, TableCell>>

/** 表格的一列（与 Orca `TableColumn` 结构相同；这里只写本页用到的档位）。 */
export interface ThreadColumn {
  readonly key: ThreadColumnKey
  readonly label: string
  readonly align?: 'start' | 'center' | 'end'
  readonly width?: 'auto' | 'xs' | 'sm' | 'md' | 'lg'
  readonly hideBelow?: 'sm' | 'md'
}

/** 四档筛选的文案键（§M.2：Subscribed / Evaluating / New in 24 h / All）。 */
export function filterLabelKey(filter: ThreadFilter): CopyKey {
  return `thread.filter.${filter}` as CopyKey
}

/** 四列，顺序即 §M.2 的列序；宽列（最近触发）在窄面板上让位（§M.4 的 `hideBelow`）。 */
export function threadColumns(locale: string): readonly ThreadColumn[] {
  return [
    { key: 'thread', label: translate(locale, 'thread.columnThread') },
    { key: 'subscriptions', label: translate(locale, 'thread.columnSubscriptions'), align: 'end', width: 'xs' },
    { key: 'latest', label: translate(locale, 'thread.columnLatest'), hideBelow: 'sm' },
    { key: 'state', label: translate(locale, 'thread.columnState'), align: 'end', width: 'sm' }
  ]
}

/** 「最近触发」一列：谁说的 + 一句话；没有触发时说明它，而不是留一个空单元格。 */
export function latestCell(locale: string, thread: PanelThread): string {
  const latest = thread.latest
  if (latest === undefined) return translate(locale, 'thread.noLatest')
  return latest.preview === '' ? latest.actor : `${latest.actor} · ${latest.preview}`
}

/**
 * 状态一列：`threadMark` 的标记 + 语气；Source 轮询失败时把原因接在同一格里
 * （行内错误：一条坏行不遮住其他行，也不值得换一整页）。
 */
export function stateCell(locale: string, thread: PanelThread): string {
  const mark = threadMark({ stage: thread.stage, pending: thread.pending })
  const label = markLabel(locale, mark, { count: thread.pending })
  return thread.pollError === undefined ? label : `${label} · ${thread.pollError}`
}

/** 一条 Thread 行 → 四个单元格（列键与 `threadColumns` 一一对应）。 */
export function threadCells(locale: string, thread: PanelThread): ThreadCells {
  return {
    thread: thread.title,
    subscriptions: String(thread.subscriptions),
    latest: latestCell(locale, thread),
    state: stateCell(locale, thread)
  }
}

// 读模型：Eval 页（§M.2 的 Eval 行、§K.7 的待人工四条件）。
//
// 一处定义：面板的 Eval 列表与详情都从这里取同一份形状；「24 h 内未解决」不在这里重新判定，
// 而是收 `views/attention.ts` 的 `readUnavailableProblems` 读数——与 Overview 的 System
// problems、健康项 `evals` 永远说同一件事。
//
// 依赖纪律（§C.2）：app → core；本文件只收注入的读数与仓储读面，不 import store / sources /
// runtime，也不做 I/O。
import type { Decision, Thread, Ticket } from '../../core/index.ts'
import type { Reason } from '../../core/reasons.ts'
import type {
  DecisionDetailView,
  DecisionListInput,
  DecisionListPage,
  PanelDecision,
  PanelReason
} from '../../../panel/protocol'
import type { UnavailableProblem } from './attention.ts'

/** Eval 列表一页最多几行（§M.4：无虚拟列表，长列表靠分页 50 条）。 */
export const DECISION_PAGE_MAX = 50

/** 详情读模型要读的记录（§C.2：只读的仓储读面）。 */
export interface DecisionRecords {
  readonly threads: { get(key: string): Thread | undefined }
  readonly tickets: { get(id: string): Ticket | undefined }
}

/** 一条原因 → 面板面：码 + 占位符 + 所属 Trigger（文案由面板按 `reason.<code>` 翻译）。 */
function panelReasonOf(reason: Reason): PanelReason {
  return {
    code: reason.code,
    ...(reason.values === undefined ? {} : { values: reason.values }),
    ...(reason.triggerId === undefined ? {} : { triggerId: reason.triggerId })
  }
}

/** ISO 文本 → epoch ms（面板的时间一律交给 `RelativeTime`）。解不开就是 0。 */
function epoch(at: string): number {
  const parsed = Date.parse(at)
  return Number.isFinite(parsed) ? parsed : 0
}

/** 最新在前：`(at, id)` 降序，与 `readUnavailableProblems` 判「最新决定」的读序同一个。 */
function newestFirst(left: Decision, right: Decision): number {
  return left.at === right.at ? right.id.localeCompare(left.id) : right.at.localeCompare(left.at)
}

/** 一条 Decision → Eval 列表的一行（§M.2 的五个字段）。 */
export function decisionRow(decision: Decision): PanelDecision {
  return {
    id: decision.id,
    kind: decision.kind,
    reasons: decision.reason.map(panelReasonOf),
    strength: decision.strength,
    policyVersion: decision.policyVersion,
    at: epoch(decision.at)
  }
}

/**
 * Eval 列表的一页：最新在前，分页 50 条。`unresolved` 是同一份 `UnavailableProblem` 读数的
 * 条数（§K.7 的四条件已在 `readUnavailableProblems` 判完），面板不自己数 24 h。
 */
export function decisionPage(
  decisions: readonly Decision[],
  input: DecisionListInput,
  problems: readonly UnavailableProblem[]
): DecisionListPage {
  const limit = Math.max(1, Math.min(DECISION_PAGE_MAX, input.limit ?? DECISION_PAGE_MAX))
  const offset = Math.max(0, input.offset ?? 0)
  const ordered = [...decisions].sort(newestFirst)
  return {
    items: ordered.slice(offset, offset + limit).map(decisionRow),
    nextOffset: offset + limit < ordered.length ? offset + limit : null,
    unresolved: problems.length
  }
}

/** 一条 Thread 给人看的名字：Source 给的 label，没有就是 key（与订阅行同一口径）。 */
function threadTitle(thread: Thread | undefined, key: string): string {
  const label = thread?.meta['label']
  return typeof label === 'string' && label !== '' ? label : key
}

/**
 * 一条 Decision 的详情（§M.2 的 Eval 详情）：字段、原因、到 Thread/Ticket 的链接，以及
 * 现在是否仍要人（§K.7 的判定就是 `readUnavailableProblems` 里有没有它）。
 *
 * `canDismiss` 是**可用性**：只有 unavailable 能被 dismiss（领域规则），且已经 dismiss 的
 * 不再给入口——领域仍允许幂等重复，但面板不重复问同一件事。
 */
export function decisionDetail(
  decision: Decision,
  records: DecisionRecords,
  problems: readonly UnavailableProblem[]
): DecisionDetailView {
  const thread = records.threads.get(decision.threadKey)
  const ticket = decision.ticketId === undefined ? undefined : records.tickets.get(decision.ticketId)
  const dismissed = decision.dismissed === true
  return {
    id: decision.id,
    kind: decision.kind,
    reasons: decision.reason.map(panelReasonOf),
    strength: decision.strength,
    policyVersion: decision.policyVersion,
    at: epoch(decision.at),
    thread: { key: decision.threadKey, title: threadTitle(thread, decision.threadKey) },
    ...(decision.ticketId === undefined
      ? {}
      : { ticket: { id: decision.ticketId, title: ticket?.title ?? decision.ticketId } }),
    triggerIds: decision.triggerIds,
    dismissed,
    unresolved: problems.some((problem) => problem.decisionId === decision.id),
    canDismiss: decision.kind === 'unavailable' && !dismissed
  }
}

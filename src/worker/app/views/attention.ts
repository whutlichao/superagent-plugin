// 待人工计数（§N.7）：状态栏的 `Superagent <n>` 与 tooltip 的 answer/review 分项读它。
//
// 分类交给领域自己的 `ticketStage()`（§E.8），而不是在 SQL 里重写一套「谁在等人」的规则：
// 状态栏、Overview 与状态退出码必须说的是同一件事。这里读的是**真库里的 Ticket 行**，
// 不是面板壳的常量零——#45 之前状态栏的计数一直是 stub 的 0。
//
// 本文件还落 §K.7 的面板待人工四条件（`readUnavailableProblems`）与健康项 `evals` 的读数
// （`readEvalsHealth`，§N.4）：两者共用同一个判定，只差窗口（面板 24 h、健康项 1 h）。
// 面板、状态栏与健康看板因此永远说的是同一件事。
//
// 依赖纪律（§C.2）：app → core 是允许的方向；这里只经 `Store.sql.all` 这条受控出口读库，
// 不 import runtime / sources / executor。
import type { HealthEntry, JsonValue } from '../../core/ports.ts'
import { reasonText } from '../../core/reasons.ts'
import type { Ticket } from '../../core/model.ts'
import { ticketStage } from '../../core/stage.ts'
import type { ReadParam } from '../store-read.ts'
// 容错读取只有 `views/values.ts` 一份（#64）：本文件只引用，不再各写一遍。
import { bodyOf, jsonObject, reasonsOf, stringsOf, textOf } from './values.ts'

/** 读模型需要的最小 SQL 出口（`Store.sql.all` 结构上满足它）。 */
export interface AttentionReader {
  readonly sql: {
    all(sql: string, params?: readonly ReadParam[]): readonly unknown[]
  }
}

/** 状态栏要的两个计数（回答 + 评审）；风格上的「问题」不算「需要你动手」的工单。 */
export interface AttentionCounts {
  readonly answer: number
  readonly review: number
}

/**
 * 读出待人工计数：只数未结束的 Ticket，按 `ticketStage()` 的 person/answer 与 person/review
 * 归桶。blocked/failed/delivery 也是「要人」，但状态栏的文本与 tooltip 只数回答与评审两桶；
 * 其余等待由 Overview 的行去表达（§M.2）。
 */
export function readAttentionCounts(reader: AttentionReader): AttentionCounts {
  let answer = 0
  let review = 0
  for (const row of reader.sql.all('SELECT body FROM ticket WHERE open = 1')) {
    const partial = parseBody(bodyOf(row))
    if (partial === undefined) continue
    // 老库与夹具可能没带这两个数组；缺了就不能假装「有人等人」。
    const ticket = {
      ...partial,
      assignments: partial.assignments ?? [],
      inputs: partial.inputs ?? []
    } as Ticket
    const stage = ticketStage(ticket)
    if (stage.stage !== 'person') continue
    if (stage.action === 'answer') answer += 1
    else if (stage.action === 'review') review += 1
  }
  return { answer, review }
}

/** 库里的 `body` 是 JSON 文本；解不开就当没有（读模型不因为一行坏数据抛错）。 */
function parseBody(value: JsonValue): Partial<Ticket> | undefined {
  if (typeof value === 'object' && value !== null) return value as Partial<Ticket>
  if (typeof value !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Partial<Ticket>) : undefined
  } catch {
    return undefined
  }
}

/** 面板待人工的窗口（§K.7：24 小时内未解决的 unavailable）。 */
export const PROBLEM_WINDOW_MS = 24 * 60 * 60 * 1000

/** 健康项 `evals` 的窗口（§N.4：1 小时内未解决的 unavailable）。 */
export const EVALS_WINDOW_MS = 60 * 60 * 1000

/**
 * 一条仍未解决的 unavailable Decision（§K.7 的面板待人工行）：只带「把它当成系统问题展示」
 * 所需的最小事实，不是 Decision 的全部内容。
 */
export interface UnavailableProblem {
  readonly decisionId: string
  readonly evalId: string
  readonly threadKey: string
  /** Decision 落库的时刻（§D.2 的时间形态：ISO 文本）。 */
  readonly at: string
  /** 原因的一句话（面板与状态栏 tooltip 直接显示）。 */
  readonly reason: string
  readonly triggerIds: readonly string[]
}

/**
 * 待人工的 unavailable：同时满足 §K.7 的四个条件——窗口内、是该 Thread 的最新决定、
 * 没被 dismiss、该 Thread 不在排队或评估中。
 *
 * 健康项 `evals` 用同一个判定、窗口收窄到 1 h（§N.4）：「一小时未解决」与「面板现在要人看」
 * 必须是同一件事，否则两处会各说一套。
 */
export function readUnavailableProblems(
  reader: AttentionReader,
  options: { readonly now: string; readonly windowMs?: number }
): readonly UnavailableProblem[] {
  const now = options.now
  const windowMs = options.windowMs ?? PROBLEM_WINDOW_MS
  const cutoff = new Date(Date.parse(now) - windowMs).toISOString()
  const problems: UnavailableProblem[] = []
  // 先按窗口与 kind 取行；dismiss、最新与否、Thread 是否在忙都在行上判，不猜。
  const rows = reader.sql.all(
    'SELECT id, thread_key, at, body FROM decision WHERE kind = ? AND at >= ? ORDER BY at, id',
    ['unavailable', cutoff]
  )
  for (const row of rows) {
    const decisionId = textOf(row, 'id')
    const threadKey = textOf(row, 'thread_key')
    const at = textOf(row, 'at')
    if (decisionId === '' || threadKey === '' || at < cutoff || at > now) continue
    const body = jsonObject(bodyOf(row))
    // 已被 dismiss 的决定不再是问题（§K.7：dismiss 对该决定永久有效）。
    if (body === undefined || body['dismissed'] === true) continue
    // 不是该 Thread 的最新决定：后来的决定已经回答了同一条 Thread 的问题。
    if (latestDecision(reader, threadKey) !== decisionId) continue
    // Thread 正在排队或评估中：下一次评估会给出新的答案，旧问题不再要人。
    if (threadIsBusy(reader, threadKey)) continue
    problems.push({
      decisionId,
      evalId: typeof body['evalId'] === 'string' ? body['evalId'] : '',
      threadKey,
      at,
      reason: reasonText(reasonsOf(body['reason'])),
      triggerIds: stringsOf(body['triggerIds'])
    })
  }
  return problems
}

/**
 * `evals` 健康条目的读数（§N.4）：1 h 内未解决的 unavailable 数量。
 * 只报计数，不报错误——一条失败的评估是「要人看的事实」，不是部件坏了（§J.3）。
 */
export function readEvalsHealth(reader: AttentionReader, now: string): HealthEntry {
  const count = readUnavailableProblems(reader, { now, windowMs: EVALS_WINDOW_MS }).length
  return { state: 'ready', detail: `unavailable ${count} in the last hour` }
}

/** 一个 Thread 的最新 Decision（`(at, id)` 序的最后一个；与仓储读序同一条）。 */
function latestDecision(reader: AttentionReader, threadKey: string): string {
  const row = reader.sql.all(
    'SELECT id FROM decision WHERE thread_key = ? ORDER BY at DESC, id DESC LIMIT 1',
    [threadKey]
  )[0]
  return textOf(row, 'id')
}

/** 一个 Thread 是否在排队或评估中（`thread` 行的 `queued` / `eval`，与生成列同一份投影）。 */
function threadIsBusy(reader: AttentionReader, threadKey: string): boolean {
  const row = reader.sql.all('SELECT body FROM thread WHERE key = ?', [threadKey])[0]
  const body = row === undefined ? undefined : jsonObject(bodyOf(row))
  if (body === undefined) return false
  if (body['eval'] !== undefined && body['eval'] !== null) return true
  for (const name of ['queued', 'pending']) {
    const value = body[name]
    if (Array.isArray(value) && value.length > 0) return true
  }
  return false
}


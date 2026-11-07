// 待人工计数（§N.7）：状态栏的 `Superagent <n>` 与 tooltip 的 answer/review 分项读它。
//
// 分类交给领域自己的 `ticketStage()`（§E.8），而不是在 SQL 里重写一套「谁在等人」的规则：
// 状态栏、Overview 与状态退出码必须说的是同一件事。这里读的是**真库里的 Ticket 行**，
// 不是面板壳的常量零——#45 之前状态栏的计数一直是 stub 的 0。
//
// 依赖纪律（§C.2）：app → core 是允许的方向；这里只经 `Store.sql.all` 这条受控出口读库，
// 不 import runtime / sources / executor。
import type { Ticket } from '../../core/model.ts'
import type { JsonValue } from '../../core/ports.ts'
import { ticketStage } from '../../core/stage.ts'

/** 读模型需要的最小 SQL 出口（`Store.sql.all` 结构上满足它）。 */
export interface AttentionReader {
  readonly sql: {
    all(sql: string): readonly unknown[]
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

/** 一行里的 `body` 列（null 原型对象；取不到就是 undefined）。 */
function bodyOf(row: unknown): JsonValue {
  if (typeof row !== 'object' || row === null) return undefined
  return (row as Record<string, JsonValue>)['body']
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

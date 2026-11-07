// 视图读面的小工具（§G.3 的视图路由、§M.2 的列表页）：`views/*` 里**每个**泛型读取只在这里
// 实现一次，别再各写一份同名函数。
//
// 这些都是「读一行库里的记录」的容错读取：坏行不抛、缺列给空值、解不开的 JSON 当没有。
// 纪律（与 `views/read.ts` 同）：
// - **坏行不抛**：一行坏数据不该让整个面板 500；拿不到就说没有（调用方按 `status` 说明原因）；
// - **不猜内容**：`jsonObject` 只承诺「解出来是对象」，字段类型仍由调用方逐个判；
// - **不 import 上层**：本文件只 import 领域类型，不 import `http/`、不读存储、不读时钟。
import type { JsonValue } from '../../core/ports.ts'
import type { Reason } from '../../core/reasons.ts'

/** 一行里的一个文本列（取不到就是空串：坏行不抛）。 */
export function textOf(row: unknown, column: string): string {
  if (typeof row !== 'object' || row === null) return ''
  const value = (row as Record<string, unknown>)[column]
  return typeof value === 'string' ? value : ''
}

/** 库里的 JSON 文本 → 普通对象；解不开就不是对象（坏行不抛）。 */
export function jsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null) return value as Record<string, unknown>
  if (typeof value !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** 一行里的 `body` 列（null 原型对象；取不到就是 undefined）。 */
export function bodyOf(row: unknown): JsonValue {
  if (typeof row !== 'object' || row === null) return undefined
  return (row as Record<string, JsonValue>)['body']
}

/** 一条结构化原因（`{code, values?, triggerId?}`）；只认带 code 的对象。 */
export function isReason(value: unknown): value is Reason {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { code?: unknown }).code === 'string'
  )
}

/** 一个 Decision 的原因：数组就逐条保留；不是数组就是没有。 */
export function reasonsOf(value: unknown): readonly Reason[] {
  return Array.isArray(value) ? value.filter(isReason) : []
}

/** 一个字符串数组（取不到就是空数组）。 */
export function stringsOf(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** 一段正文的预览选项。 */
export interface PreviewOptions {
  /** 上限（字符）：超过就截断。 */
  readonly limit: number
  /** 先把空白折成一个空格（面板的一行摘要用；时间线保留原文的换行）。 */
  readonly flatten?: boolean
  /** 截断时补一个 `…`（它占上限里的一个字符）。 */
  readonly ellipsis?: boolean
}

/** 一段正文的预览：文本本身，以及被截断时的全文长度与标记。 */
export interface Preview {
  readonly text: string
  /** 被截断时的全文长度（字符）。 */
  readonly chars?: number
  readonly truncated?: true
}

/**
 * 一段正文的预览：两种列表页共用的**唯一**实现。
 *
 * - Thread 时间线（`views/read.ts`）：不折叠空白、不加省略号，截断时给全文长度
 *   （`chars` 让面板说「只显示了前 400 字」）；
 * - Source 页的一行摘要（`views/sources.ts`）：折叠空白、加省略号（一行放不下）。
 *
 * 两者是同一个返回形状：调用方要么用 `text`，要么把 `chars`/`truncated` 一起交给面板。
 */
export function previewOf(text: string, options: PreviewOptions): Preview {
  const full = options.flatten === true ? text.replace(/\s+/g, ' ').trim() : text
  if (full.length <= options.limit) return { text: full }
  const keep = options.ellipsis === true ? Math.max(0, options.limit - 1) : options.limit
  const clipped = full.slice(0, keep)
  return {
    text: options.ellipsis === true ? `${clipped}…` : clipped,
    chars: full.length,
    truncated: true
  }
}

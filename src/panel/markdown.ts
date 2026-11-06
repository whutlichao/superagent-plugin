// Markdown 的核心子集（§M.4：`Markdown` 只渲染标题 / 段落 / 列表 / 代码块 / 链接）与
// 提示词全文 diff 的文本形态。
//
// 面板侧纯函数：把 worker 给的文本切成块（页面票可以直接把它交给 `<Markdown content>`，
// 或按块自己排版），以及把 `diff.ts` 的 `DiffLine[]` 折成 `<CodeView>` 可显示的行。
// 不 import `orca`，不做 HTML：原文里的标签一律当文字（面板没有 DOM，也不该解释 HTML）。
import { translate } from './copy'
import type { DiffLine } from './diff'

/** 一块 Markdown：标题、段落、列表或代码块。 */
export type MarkdownBlock =
  | { readonly kind: 'heading'; readonly level: 1 | 2 | 3; readonly text: string }
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly string[] }
  | { readonly kind: 'code'; readonly text: string }

/** 列表项：`- x` / `* x` 是无序，`1. x` / `1) x` 是有序。 */
const LIST_ITEM = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/
/** 无序项：以 `-`/`*` 开头（与上面的正则分开，避免重复回溯）。 */
const UNORDERED = /^\s*[-*]\s+/
/** 标题：`#` 到 `###`（面板只有三级标题）。 */
const HEADING = /^(#{1,3})\s+(.*)$/
/** 代码围栏。 */
const FENCE = /^\s*```/

/** 把文本切成块；空行分隔块，代码围栏内的空行保留。 */
export function toMarkdown(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  let list: { kind: 'list'; ordered: boolean; items: string[] } | undefined
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string
    if (FENCE.test(line)) {
      list = undefined
      const body: string[] = []
      index += 1
      while (index < lines.length && !FENCE.test(lines[index] as string)) {
        body.push(lines[index] as string)
        index += 1
      }
      blocks.push({ kind: 'code', text: body.join('\n') })
      continue
    }
    if (line.trim() === '') {
      list = undefined
      continue
    }
    const heading = HEADING.exec(line)
    if (heading !== null) {
      list = undefined
      blocks.push({
        kind: 'heading',
        level: (heading[1] as string).length as 1 | 2 | 3,
        text: (heading[2] as string).trim()
      })
      continue
    }
    const item = LIST_ITEM.exec(line)
    if (item !== null) {
      const ordered = !UNORDERED.test(line)
      if (list === undefined || list.ordered !== ordered) {
        list = { kind: 'list', ordered, items: [] }
        blocks.push(list)
      }
      list.items.push((item[1] as string).trim())
      continue
    }
    list = undefined
    blocks.push({ kind: 'paragraph', text: line })
  }
  return blocks
}

/** 行首标记：未改动两个空格、删除 `-`、插入 `+`，折叠一行说明。 */
const MARKER = { same: '  ', del: '- ', ins: '+ ' } as const

/** 把行级 diff 折成 `<CodeView>` 能显示的文本；折叠行按面板语言说明。 */
export function diffText(lines: readonly DiffLine[], locale = 'en'): string {
  return lines
    .map((line) =>
      line.kind === 'fold'
        ? `  ${translate(locale, 'diff.folded', { count: line.count })}`
        : `${MARKER[line.kind]}${line.text}`
    )
    .join('\n')
}

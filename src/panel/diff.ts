// 全文提示词的行级 diff（纯函数，§C.1 `panel/diff.ts`、§M.3 Prompts 的 Full prompt）。
// 与上游 `prompt-config.ts` 的 `lineDiff` 同语义：LCS 回溯得到 same/del/ins，
// 超过 4 行的连续未改动行折叠成「首行 + 计数 + 末行」。
// 面板侧纯函数：不 import `orca`，不碰 worker（§C.2 规则 3）。

/** 一行 diff：未改动、删除、插入，或一段被折叠的未改动行。 */
export type DiffLine =
  | { readonly kind: 'same'; readonly text: string }
  | { readonly kind: 'del'; readonly text: string }
  | { readonly kind: 'ins'; readonly text: string }
  | { readonly kind: 'fold'; readonly count: number }

/** 折叠阈值之上才折叠；折叠后保留首尾两行（上游同）。 */
const FOLD_ABOVE = 4

/** 把文本切成行；空文本是零行，而不是一行空行。 */
function lines(text: string): string[] {
  return text === '' ? [] : text.split('\n')
}

/** 两个文本的行级 diff，按阅读顺序；长段未改动行折叠。 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = lines(before)
  const b = lines(after)
  // 从末尾填 LCS 表，正向回溯即可按顺序输出。
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }
  const raw: DiffLine[] = []
  for (let i = 0, j = 0; i < a.length || j < b.length; ) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      raw.push({ kind: 'same', text: a[i]! })
      i += 1
      j += 1
    } else if (j < b.length && (i === a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      raw.push({ kind: 'ins', text: b[j]! })
      j += 1
    } else {
      raw.push({ kind: 'del', text: a[i]! })
      i += 1
    }
  }
  const folded: DiffLine[] = []
  for (let k = 0; k < raw.length; ) {
    let end = k
    while (end < raw.length && raw[end]!.kind === 'same') end += 1
    if (end - k > FOLD_ABOVE) {
      folded.push(raw[k]!, { kind: 'fold', count: end - k - 2 }, raw[end - 1]!)
    } else {
      folded.push(...raw.slice(k, Math.max(end, k + 1)))
    }
    k = Math.max(end, k + 1)
  }
  return folded
}

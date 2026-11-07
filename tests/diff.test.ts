// 行级 diff（纯函数）：全文提示词与「已保存 / 默认」的对比（§M.3 Prompts、§C.1 `panel/diff.ts`）。
// 语义与上游 `prompt-config.ts` 的 `lineDiff` 一致：LCS 回溯给出 same/del/ins，
// 超过 4 行的连续未改动行折叠成「首行 + 计数 + 末行」，计数不含首尾两行。
import { assert, test } from 'orca/testing'
import { lineDiff } from '../src/panel/diff'

/** 便于断言的紧凑写法：`' a'` 未改动、`'-a'` 删除、`'+a'` 插入、`'~n'` 折叠 n 行。 */
const short = (before: string, after: string): string[] =>
  lineDiff(before, after).map((line) =>
    line.kind === 'fold' ? `~${line.count}` : `${line.kind === 'same' ? ' ' : line.kind === 'del' ? '-' : '+'}${line.text}`
  )

test('identical text is all unchanged', () => {
  assert.deepEqual(short('a\nb', 'a\nb'), [' a', ' b'])
})

test('reads an insertion and a deletion in place', () => {
  assert.deepEqual(short('a\nb', 'a\nx\nb'), [' a', '+x', ' b'])
  assert.deepEqual(short('a\nb\nc', 'a\nc'), [' a', '-b', ' c'])
})

test('reads a replacement as the LCS walk orders it: the new line first, then the old one', () => {
  // 上游 `lineDiff` 的回溯在平手时先取插入，所以同一位置是 `+` 后 `-`；测试按事实钉住这个顺序。
  assert.deepEqual(short('a\nb\nc', 'a\nx\nc'), [' a', '+x', '-b', ' c'])
  assert.deepEqual(short('a\n\nb', 'a\n\nB'), [' a', ' ', '+B', '-b'])
})

test('folds a run of more than four unchanged lines to its first line, a count and its last line', () => {
  const before = ['a', 'b', 'c', 'd', 'e', 'f', 'old'].join('\n')
  const after = ['a', 'b', 'c', 'd', 'e', 'f', 'new'].join('\n')
  // 6 行未改动 → 首行 + 折叠 4 行 + 末行（与上游测试逐字同）。
  assert.deepEqual(short(before, after), [' a', '~4', ' f', '+new', '-old'])
})

test('keeps four unchanged lines unfolded', () => {
  assert.deepEqual(short('a\nb\nc\nd\nold', 'a\nb\nc\nd\nnew'), [' a', ' b', ' c', ' d', '+new', '-old'])
})

test('treats empty text as no lines, not one empty line', () => {
  assert.deepEqual(short('', ''), [])
  assert.deepEqual(short('', 'a'), ['+a'])
  assert.deepEqual(short('a', ''), ['-a'])
})

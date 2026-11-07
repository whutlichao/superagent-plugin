// Markdown 的核心子集（§M.4：`Markdown` 只渲染标题/段落/列表/代码块/链接）与
// 提示词全文的 diff 展示。面板侧的纯函数：把 worker 给的文本切成块交给 `<Markdown>`，
// 或把 `diff.ts` 的 `DiffLine[]` 折成 `<CodeView>` 可显示的文本（行首标 + / -）。
//
// 不 import `orca`：这里只产出字符串与数据结构。
import { assert, test } from 'orca/testing'
import { toMarkdown } from '../src/panel/markdown'
import { diffText } from '../src/panel/markdown'

test('keeps headings, paragraphs and lists in order', () => {
  const text = ['# Plan', 'First line', '- a', '- b', '', '1. c', '```', 'npm test', '```'].join('\n')
  assert.deepEqual(toMarkdown(text), [
    { kind: 'heading', level: 1, text: 'Plan' },
    { kind: 'paragraph', text: 'First line' },
    { kind: 'list', ordered: false, items: ['a', 'b'] },
    { kind: 'list', ordered: true, items: ['c'] },
    { kind: 'code', text: 'npm test' }
  ])
})

test('reads headings of every level the panel draws', () => {
  assert.deepEqual(toMarkdown('## Two\n### Three'), [
    { kind: 'heading', level: 2, text: 'Two' },
    { kind: 'heading', level: 3, text: 'Three' }
  ])
})

test('keeps a link and leaves raw HTML as text', () => {
  assert.deepEqual(toMarkdown('See [the PR](https://example.com/pr/1) for details'), [
    { kind: 'paragraph', text: 'See [the PR](https://example.com/pr/1) for details' }
  ])
  assert.deepEqual(toMarkdown('<b>not html</b>'), [{ kind: 'paragraph', text: '<b>not html</b>' }])
})

test('ignores blank lines between blocks but keeps them inside a code block', () => {
  assert.deepEqual(toMarkdown('one\n\n\ntwo'), [
    { kind: 'paragraph', text: 'one' },
    { kind: 'paragraph', text: 'two' }
  ])
  assert.deepEqual(toMarkdown('```\na\n\nb\n```'), [{ kind: 'code', text: 'a\n\nb' }])
})

test('returns nothing for empty or whitespace-only text', () => {
  assert.deepEqual(toMarkdown(''), [])
  assert.deepEqual(toMarkdown('   \n\n '), [])
})

test('a diff renders with a marker per line and folds as the diff says', () => {
  const text = diffText([
    { kind: 'same', text: 'a' },
    { kind: 'del', text: 'old' },
    { kind: 'ins', text: 'new' },
    { kind: 'fold', count: 4 },
    { kind: 'same', text: 'z' }
  ])
  assert.equal(text, ['  a', '- old', '+ new', '  … 4 unchanged lines', '  z'].join('\n'))
})

test('the fold line follows the panel language', () => {
  const text = diffText([{ kind: 'fold', count: 2 }], 'zh-CN')
  assert.equal(text, '  … 2 行未改动')
})

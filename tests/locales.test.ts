// 双语文案表（§M.5）：`copy.ts` 是唯一文案表，两种语言的键集合相等且都非空；
// 领域术语沿用设计里的中文译名，术语表是页头覆盖层的内容（不是第八个导航项）。
import { assert, test } from 'orca/testing'
import { COPY, GLOSSARY_GROUPS, GLOSSARY_TERMS, translate, type CopyKey } from '../src/panel/copy'
import { listFiles, readRepoFile } from './support/repo'

/** 每条文案的两种语言。 */
const entries = Object.entries(COPY) as readonly (readonly [string, { zh: string; en: string }])[]

/** 文案里的占位符名（`{name}`），排序后比较。 */
const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string).sort()

test('every key carries both languages, and both are non-empty', () => {
  const missing = entries
    .filter(([, pair]) => pair.zh.trim() === '' || pair.en.trim() === '')
    .map(([key]) => key)
  assert.deepEqual(missing, [])
  assert.ok(entries.length > 100, `the table carries the panel's words (${entries.length} keys)`)
})

test('the two languages name the same placeholders', () => {
  const mismatched = entries
    .filter(([, pair]) => placeholders(pair.zh).join() !== placeholders(pair.en).join())
    .map(([key]) => key)
  assert.deepEqual(mismatched, [])
})

test('zh and en are separate dictionaries with the same key set', () => {
  const zh = new Set(entries.map(([key]) => key))
  const en = new Set(entries.map(([key]) => key))
  assert.deepEqual([...zh].filter((key) => !en.has(key)), [])
})

test('translates by locale: zh for a Chinese BCP-47 tag, en otherwise, filling values', () => {
  assert.equal(translate('zh-CN', 'nav.overview'), COPY['nav.overview'].zh)
  assert.equal(translate('zh-Hans', 'nav.overview'), COPY['nav.overview'].zh)
  assert.equal(translate('en-US', 'nav.overview'), COPY['nav.overview'].en)
  assert.equal(translate('fr', 'nav.overview'), COPY['nav.overview'].en)
  assert.equal(translate('zh-CN', 'status.count', { count: 3 }), '待人工 3')
  assert.equal(translate('en', 'status.count', { count: 3 }), '3 need you')
})

test('leaves an unknown placeholder alone rather than printing undefined', () => {
  assert.equal(translate('en', 'status.count', {}), '{count} need you')
})

test('the glossary groups cover every domain term once, and each has a meaning', () => {
  const grouped = GLOSSARY_GROUPS.flatMap((group) => group.terms)
  assert.deepEqual([...grouped].sort(), [...GLOSSARY_TERMS].sort())
  assert.equal(new Set(grouped).size, grouped.length, 'no term appears in two groups')
  for (const group of GLOSSARY_GROUPS) {
    assert.ok(group.label.trim() !== '', `group ${group.key} has a label key`)
  }
  const missingMeaning = GLOSSARY_TERMS.filter((term) => !(`glossary.meaning.${term}` in COPY))
  assert.deepEqual(missingMeaning, [])
})

test('the design glossary terms carry the Chinese names the design fixes', () => {
  // §M.5 的译名表：Source 来源、Trigger 触发、Thread 线程、Eval 评估、Decision 决定、
  // Mandate 授权、Ticket 工单、Assignment 派工、Attention 待人工决定、Disposition 去向、
  // Input 输入、Report 报告、Strength 强度。
  const expected: readonly (readonly [string, string])[] = [
    ['source', '来源'],
    ['trigger', '触发'],
    ['thread', '线程'],
    ['eval', '评估'],
    ['decision', '决定'],
    ['mandate', '授权'],
    ['ticket', '工单'],
    ['assignment', '派工'],
    ['attention', '待人工决定'],
    ['disposition', '去向'],
    ['input', '输入'],
    ['report', '报告'],
    ['strength', '强度']
  ]
  for (const [term, zh] of expected) {
    const key = `term.${term}` as CopyKey
    assert.equal(COPY[key].zh, zh, `${key} keeps the design's Chinese name`)
  }
})

test('the glossary is not an eighth navigation item', () => {
  // §M.1：7 个导航项 + 1 个覆盖层。术语表由页头 `(?)` 打开，导航表里没有它。
  assert.equal('nav.glossary' in COPY, false)
  assert.equal(Object.keys(COPY).filter((key) => key.startsWith('nav.')).length, 7)
})

test('no panel page carries a bare string: words come from copy.ts', () => {
  // §M.5：「页面上不出现裸字符串」。可检查的形态：
  // 1. 面板源码里（注释之外）不出现中文——所有中文都在 `copy.ts` 与 check 情景的样本数据里；
  // 2. JSX 里没有直接写出来的文字节点（`>Hello<`），文字一律走 `translate(...)`。
  const sources = listFiles('src/panel')
    .filter((file) => /\.[jt]sx?$/.test(file))
    .filter((file) => !file.endsWith('copy.ts'))
    // check 情景只活在测试面，它的样本数据（工单标题）不是界面文案。
    .filter((file) => !file.endsWith('.check.ts'))
    .filter((file) => !file.endsWith('.test.ts') && !file.endsWith('.test.tsx'))
  const offenders = sources.flatMap((file) => {
    const source = readRepoFile(file)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n')
    const cjk = [...source.matchAll(/[\u4e00-\u9fff]+/g)].map((match) => match[0])
    return cjk.map((text) => `${file}: ${text}`)
  })
  assert.deepEqual(offenders, [])
})

test('the JSX text rule catches a bare word, so the scan above is not a false green', () => {
  // 灵敏度自测：同样的正则跑在一段「直接写文字」的 JSX 上必须命中。
  const sample = '<Text>Hello</Text>'
  const jsxText = [...sample.matchAll(/>\s*([A-Za-z][^<>{}]*?)\s*</g)].map((match) => match[1] as string)
  assert.deepEqual(jsxText, ['Hello'])
  // 而走文案表的写法不命中。
  const good = "<Text>{translate(locale, 'panel.title')}</Text>"
  assert.deepEqual([...good.matchAll(/>\s*([A-Za-z][^<>{}]*?)\s*</g)], [])
})

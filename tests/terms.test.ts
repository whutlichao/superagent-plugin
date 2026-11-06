// 术语表：原因码、状态码、强度码、结局码与面板文案表的键集合必须一一对应（票面验收第三条）。
//
// 本票只建立**领域侧的码表**（`REASONS`、`REPORT_STATES`...）与**面板文案表的领域部分**
// （`src/panel/copy.ts` 的 `terms` 段）。完整的双语文案表由面板壳票（#14）接管：它会在这个
// 文件之上加页面文案，`locales.test.ts` 断言两种语言的键集合相等且非空（§M.5）。
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ASSIGNMENT_STATES,
  DECISION_KINDS,
  REASONS,
  REPORT_STATES,
  STRENGTHS,
  TICKET_END_BY,
  TICKET_OUTCOMES,
  USER_ERRORS
} from '../src/worker/core/index.ts'
import {
  COPY_GROUPS,
  LOCALIZED_GROUPS,
  TERMS
} from '../src/panel/copy.ts'
import type { CopyKey } from '../src/panel/copy.ts'

/** 码表 → 它需要的术语键（`terms.ts` 的键由 `copy.ts` 导出）。 */
const TERM_KEYS: Readonly<Record<string, readonly string[]>> = {
  reason: Object.keys(REASONS),
  report: [...REPORT_STATES],
  assignment: [...ASSIGNMENT_STATES],
  decision: [...DECISION_KINDS],
  strength: [...STRENGTHS],
  outcome: [...TICKET_OUTCOMES],
  endBy: [...TICKET_END_BY],
  stage: [...COPY_GROUPS.stage],
  userError: Object.keys(USER_ERRORS)
}

/** 术语键在文案表里的全名：`reason.timeout`、`report.ready`…… */
const copyKey = (group: string, code: string): CopyKey => `${group}.${code}` as CopyKey

describe('terms tables', () => {
  for (const [group, codes] of Object.entries(TERM_KEYS)) {
    test(`${group}: every code has a two-language term`, () => {
      const missing = codes.filter((code) => TERMS[copyKey(group, code)] === undefined)
      assert.deepEqual(missing, [], `${group} codes without a term`)
    })

    test(`${group}: the term table has no key the codes do not produce`, () => {
      const prefix = `${group}.`
      const extra = Object.keys(TERMS)
        .filter((key) => key.startsWith(prefix))
        .filter((key) => !codes.includes(key.slice(prefix.length)))
      assert.deepEqual(extra, [], `${group} terms without a code`)
    })

    test(`${group}: both languages are non-empty`, () => {
      const empty = codes
        .map((code) => [copyKey(group, code), TERMS[copyKey(group, code)]] as const)
        .filter(([, text]) => !text || !text.zh.trim() || !text.en.trim())
        .map(([key]) => key)
      assert.deepEqual(empty, [])
    })
  }

  test('a placeholdered reason keeps the same placeholders in both languages', () => {
    const placeholders = (text: string): string[] =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string).sort()
    const mismatched = Object.entries(TERMS)
      .filter(([, text]) => placeholders(text.zh).join() !== placeholders(text.en).join())
      .map(([key]) => key)
    assert.deepEqual(mismatched, [])
  })

  test('the localized groups cover every term group', () => {
    assert.deepEqual([...LOCALIZED_GROUPS].sort(), Object.keys(TERM_KEYS).sort())
  })
})

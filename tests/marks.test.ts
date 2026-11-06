// 状态标记（§M.4 `marks.ts`、§M.5 的 `terms` 段）：领域状态 → 图标 / 语气 / 文案键。
// 纯函数，不 import `orca`：图标与语气是字符串字面量，文案键指向 `copy.ts`。
import { assert, test } from 'orca/testing'
import { COPY, translate } from '../src/panel/copy'
import {
  decisionMark,
  markLabel,
  reportMark,
  sourceMark,
  threadMark,
  ticketMark,
  type Mark
} from '../src/panel/marks'

/** Orca 的 Tone 档位（组件目录的五个值）。 */
const TONES = ['neutral', 'accent', 'success', 'warning', 'danger']

/** Orca 的 IconName 档位里本壳用到的那些（名称取自 references/components.md）。 */
const ICONS = [
  'info',
  'check',
  'warning',
  'error',
  'download',
  'layers',
  'bell',
  'play',
  'stop',
  'refresh',
  'pause',
  'close'
]

const marks: readonly Mark[] = [
  ticketMark({ stage: 'person', action: 'answer' }),
  ticketMark({ stage: 'person', action: 'review' }),
  ticketMark({ stage: 'person', action: 'blocked' }),
  ticketMark({ stage: 'person', action: 'failed' }),
  ticketMark({ stage: 'person', action: 'delivery' }),
  ticketMark({ stage: 'working', action: 'queued' }),
  ticketMark({ stage: 'working' }),
  ticketMark({ stage: 'idle' }),
  ticketMark({ stage: 'ended', outcome: 'completed' }),
  threadMark({ stage: 'subscribed', pending: 0 }),
  threadMark({ stage: 'evaluating', pending: 0 }),
  threadMark({ stage: 'queued', pending: 3 }),
  threadMark({ stage: 'error', pending: 0 }),
  threadMark({ stage: 'dormant', pending: 0 }),
  threadMark({ stage: 'unsubscribed', pending: 0 }),
  sourceMark('ready'),
  sourceMark('starting'),
  sourceMark('paused'),
  sourceMark('error'),
  sourceMark('setup'),
  sourceMark('off'),
  sourceMark('missing'),
  decisionMark('accept'),
  decisionMark('stop'),
  decisionMark('ignore'),
  decisionMark('unavailable'),
  decisionMark('wouldAccept'),
  reportMark('progress'),
  reportMark('waiting'),
  reportMark('ready'),
  reportMark('blocked'),
  reportMark('failed'),
  reportMark('dropped')
]

test('a Ticket waits for the person who must act, or reports how it ended', () => {
  assert.deepEqual(
    [
      ticketMark({ stage: 'person', action: 'answer' }),
      ticketMark({ stage: 'person', action: 'review' }),
      ticketMark({ stage: 'person', action: 'blocked' }),
      ticketMark({ stage: 'person', action: 'failed' }),
      ticketMark({ stage: 'person', action: 'delivery' }),
      ticketMark({ stage: 'working', action: 'queued' }),
      ticketMark({ stage: 'working' }),
      ticketMark({ stage: 'idle' }),
      ticketMark({ stage: 'ended', outcome: 'completed' })
    ].map((mark) => [mark.labelKey, mark.tone, mark.icon]),
    [
      ['stage.answer', 'warning', 'info'],
      ['stage.review', 'warning', 'check'],
      ['stage.blockedFailed', 'warning', 'warning'],
      ['stage.blockedFailed', 'danger', 'error'],
      ['stage.delivery', 'warning', 'download'],
      ['stage.queued', 'neutral', 'layers'],
      ['stage.working', 'accent', 'play'],
      ['stage.idle', 'neutral', 'bell'],
      ['outcome.completed', 'neutral', 'stop']
    ]
  )
})

test('an ended Ticket says how it ended, not just "ended"', () => {
  assert.equal(ticketMark({ stage: 'ended', outcome: 'merged' }).labelKey, 'outcome.merged')
  assert.equal(ticketMark({ stage: 'ended', outcome: 'merged' }).detail, 'merged')
  // 没有结局的已结束工单退回「无需处理」，而不是印一个空标签。
  assert.equal(ticketMark({ stage: 'ended' }).labelKey, 'report.dropped')
})

test('a Thread names the stage the person sees, and a queued one counts what waits', () => {
  assert.deepEqual(
    (['subscribed', 'evaluating', 'queued', 'error', 'dormant', 'unsubscribed'] as const).map((stage) => {
      const mark = threadMark({ stage, pending: 2 })
      return [mark.labelKey, mark.tone, mark.icon]
    }),
    [
      ['thread.subscribed', 'success', 'check'],
      ['thread.evaluating', 'accent', 'refresh'],
      ['thread.queued', 'warning', 'layers'],
      ['thread.error', 'danger', 'error'],
      ['thread.dormant', 'neutral', 'stop'],
      ['thread.unsubscribed', 'neutral', 'close']
    ]
  )
  assert.equal(markLabel('en', threadMark({ stage: 'queued', pending: 2 }), { count: 2 }), 'Queued 2')
  assert.equal(markLabel('zh-CN', threadMark({ stage: 'queued', pending: 2 }), { count: 2 }), '排队 2')
})

test('a Source state reads as what the person can do about it', () => {
  assert.deepEqual(
    (['ready', 'starting', 'paused', 'error', 'setup', 'off', 'missing'] as const).map((state) => {
      const mark = sourceMark(state)
      return [mark.labelKey, mark.tone]
    }),
    [
      ['source.ready', 'success'],
      ['source.starting', 'accent'],
      ['source.paused', 'warning'],
      ['source.error', 'danger'],
      ['source.setup', 'neutral'],
      ['source.off', 'neutral'],
      ['source.missing', 'neutral']
    ]
  )
})

test('a Decision mark tells accept from stop, and an observe-only acceptance apart', () => {
  assert.deepEqual(
    (['accept', 'stop', 'ignore', 'unavailable', 'wouldAccept'] as const).map((kind) => {
      const mark = decisionMark(kind)
      return [mark.labelKey, mark.tone, mark.icon]
    }),
    [
      ['decision.accept', 'success', 'check'],
      ['decision.stop', 'danger', 'stop'],
      ['decision.ignore', 'neutral', 'close'],
      ['decision.unavailable', 'warning', 'warning'],
      ['decision.ignore', 'warning', 'close']
    ]
  )
})

test('a Report mark ranks failure over waiting over progress', () => {
  assert.deepEqual(
    (['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped'] as const).map((report) => [
      reportMark(report).labelKey,
      reportMark(report).tone
    ]),
    [
      ['report.progress', 'accent'],
      ['report.waiting', 'neutral'],
      ['report.ready', 'success'],
      ['report.blocked', 'warning'],
      ['report.failed', 'danger'],
      ['report.dropped', 'neutral']
    ]
  )
})

test('every mark uses a tone Orca has and an icon Orca draws', () => {
  for (const mark of marks) {
    assert.ok(TONES.includes(mark.tone), `${mark.labelKey} tone ${mark.tone}`)
    assert.ok(ICONS.includes(mark.icon), `${mark.labelKey} icon ${mark.icon}`)
  }
})

test('every mark label exists in both languages', () => {
  const missing = marks
    .map((mark) => mark.labelKey)
    .filter((key) => !(key in COPY) || COPY[key].zh.trim() === '' || COPY[key].en.trim() === '')
  assert.deepEqual(missing, [])
})

test('labels render in the active locale through the one copy table', () => {
  assert.equal(markLabel('zh-CN', ticketMark({ stage: 'person', action: 'answer' })), '待回答')
  assert.equal(markLabel('en', ticketMark({ stage: 'person', action: 'answer' })), 'Awaiting answer')
  assert.equal(translate('en', 'outcome.merged'), 'Pull request merged')
})

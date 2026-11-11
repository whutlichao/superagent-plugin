// 面板壳（§M.1–M.7）：七个导航项 + 术语表覆盖层、导航记忆、三态、推送而非轮询、
// 冷启动只重试一次、隐藏时不发请求、破坏性操作行内二次确认、双语。
import { afterEach, assert, hostError, mockHost, mount, test } from 'orca/testing'
import { mock } from 'node:test'
import { COPY, translate } from '../src/panel/copy'
import {
  currentPage,
  navControl,
  navLabels as navTexts,
  navOptions,
  openPage,
  selectedNavPage
} from './support/panel-nav'
import type { PanelState } from '../src/panel/protocol'
import * as panelModule from '../src/panel/panel'

/** 一份健康的 worker 快照：没有待人工、没有错误、没有暂停。 */
export function healthyState(overrides: Partial<PanelState> = {}): PanelState {
  return {
    revision: 1,
    booted: true,
    health: {
      error: false,
      paused: false,
      setupMissing: false,
      sources: { enabled: 0, problems: 0 },
      activity: { received: 4, evaluated: 3, accepted: 1, ignored: 2, ended: 0 },
      executor: { running: 0, maxWorkers: 4, humanSlot: 'free' }
    },
    attention: {
      answer: 0,
      review: 0,
      problems: 0,
      items: []
    },
    problems: [],
    ...overrides
  }
}

/** 一名待人工的工单。 */
export function attentionItem(id: string, title: string, action: 'answer' | 'review' = 'answer') {
  return { id, title, stage: 'person' as const, action, at: 1_700_000_000_000 }
}

let panel: Awaited<ReturnType<typeof mount>> | undefined

afterEach(async () => {
  mock.timers.reset()
  await panel?.unmount()
  panel = undefined
})

/** 面板向 worker 发了几次 `pause`。 */
const pauseCalls = (host: ReturnType<typeof mockHost>): number =>
  host.callsOf('plugin.request').filter((params) => (params as { name?: string }).name === 'pause').length

/** 七项的文案，按语言（与面板导航同一份文案表）。 */
const navLabels = (locale: string): readonly string[] => navTexts(locale)

test('shows the seven navigation items of the design, in order, in both languages', async () => {
  for (const locale of ['zh-CN', 'en-US']) {
    panel = await mount(panelModule, {
      host: mockHost({ requests: { state: () => healthyState() } }),
      locale
    })
    // 七项是面板自有的可换行单选条（`RadioGroup`），顺序即 §M.1 的顺序。
    assert.deepEqual(
      navOptions(panel, locale).map((option) => option.label),
      navLabels(locale),
      locale
    )
    assert.deepEqual(
      navOptions(panel, locale).map((option) => option.value),
      ['overview', 'source', 'trigger', 'eval', 'execution', 'settings', 'search'],
      `${locale}: the page order does not change`
    )
    await panel.unmount()
    panel = undefined
  }
})

test('the current page is the control’s selected option, not a colour', async () => {
  // 行为门禁：当前页要能被读屏播报。导航是 `RadioGroup`，当前页 = 选中的那一项；
  // 控件本身带无障碍名（页头标题），选项名是七页的文案。
  panel = await mount(panelModule, {
    host: mockHost({ requests: { state: () => healthyState() } }),
    locale: 'en'
  })
  assert.equal(selectedNavPage(panel), 'overview', 'the selected option is the current page')
  await openPage(panel, 'execution')
  assert.equal(selectedNavPage(panel), 'execution', 'selecting a page moves the selection')
  const control = panel.find(navControl('en'))
  assert.ok(control, 'the navigation is one named control')
  assert.equal(control.role, 'radiogroup', 'with radio-group semantics')
  assert.equal(control.label, COPY['panel.title'].en, 'reachable by the panel title')
})

test('the glossary is a header overlay, not an eighth navigation item', async () => {
  panel = await mount(panelModule, {
    host: mockHost({ requests: { state: () => healthyState() } }),
    locale: 'zh-CN'
  })
  const navCount = (): number => (panel === undefined ? 0 : navOptions(panel, 'zh-CN').length)
  assert.equal(navCount(), 7)
  assert.equal(panel.find({ text: COPY['term.mandate'].zh }), null, 'the glossary starts closed')

  await panel.press({ label: COPY['panel.glossaryOpen'].zh })
  assert.ok(panel.find({ text: new RegExp(COPY['term.mandate'].zh) }), 'the overlay lists the terms')
  assert.ok(panel.find({ text: new RegExp(COPY['glossary.meaning.mandate'].zh) }), 'and what each means')
  assert.equal(navCount(), 7, 'the glossary adds no navigation item')

  await panel.press({ text: COPY['panel.glossaryClose'].zh })
  assert.equal(panel.find({ text: new RegExp(COPY['glossary.meaning.mandate'].zh) }), null)
  assert.deepEqual(panel.errors, [])
  assert.deepEqual(panel.refusals, [])
})

test('remembers the page it was left on, and goes back to it when reopened', async () => {
  // `persist: 'storage'` 的 atom 落在插件私有存储里（`storage:own`），因此用 mockHost 的
  // storage 播种，与 worker 看到的完全是同一份。
  panel = await mount(panelModule, {
    host: mockHost({ requests: { state: () => healthyState() }, storage: { 'panel.page': 'settings' } }),
    locale: 'en'
  })
  assert.equal(currentPage(panel), 'settings', 'reopens the remembered page')

  await openPage(panel, 'search')
  assert.equal(currentPage(panel), 'search')
  assert.equal(panel.persisted.storage['panel.page'], 'search', 'the page is mirrored in plugin storage')

  const remembered = panel.persisted
  await panel.unmount()
  panel = await mount(panelModule, {
    host: mockHost({ requests: { state: () => healthyState() }, storage: remembered.storage }),
    locale: 'en'
  })
  assert.equal(currentPage(panel), 'search')
  assert.deepEqual(panel.refusals, [])
})

test('an unreadable remembered page falls back to Overview', async () => {
  panel = await mount(panelModule, {
    host: mockHost({ requests: { state: () => healthyState() }, storage: { 'panel.page': 'policy' } }),
    locale: 'en'
  })
  assert.equal(currentPage(panel), 'overview')
})

test('a hidden panel asks the worker nothing', async () => {
  const host = mockHost({ requests: { state: () => healthyState() } })
  panel = await mount(panelModule, { host, visible: false })
  assert.deepEqual(host.callsOf('plugin.request'), [])
  // 隐藏时没有读数可画：显示的是加载态（骨架 + 进度），而不是假装已经读到了什么。
  assert.equal(panel.findAll({ type: 'Skeleton' }).length, 3, 'it shows the loading placeholders')
  assert.ok(panel.find({ type: 'Progress' }))
})

test('a cold start asks once, retries once after two seconds, and does not keep polling', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const host = mockHost({
    requests: {
      state: () => {
        throw hostError('unavailable', 'worker not started')
      }
    }
  })
  panel = await mount(panelModule, { host, locale: 'en' })
  assert.equal(host.callsOf('plugin.request').length, 1, 'one ask on setup')
  assert.ok(panel.find({ text: COPY['boot.retrying'].en }), 'it says it is retrying')

  mock.timers.tick(1999)
  await panel.settled()
  assert.equal(host.callsOf('plugin.request').length, 1, 'nothing before two seconds')

  mock.timers.tick(1)
  await panel.settled()
  assert.equal(host.callsOf('plugin.request').length, 2, 'exactly one retry')

  mock.timers.tick(60_000)
  await panel.settled()
  assert.equal(host.callsOf('plugin.request').length, 2, 'no further polling')
  assert.ok(panel.find({ text: new RegExp(COPY['boot.unavailable'].en) }), 'the error state names it')
})

test('the worker push asks for a fresh snapshot; an older revision is ignored', async () => {
  let revision = 1
  let answer = 0
  const host = mockHost({
    requests: {
      state: () => healthyState({ revision, attention: { ...healthyState().attention, answer, review: 0, problems: 0 } })
    }
  })
  panel = await mount(panelModule, { host, locale: 'en' })
  assert.equal(host.callsOf('plugin.request').length, 1)

  revision = 2
  answer = 2
  await panel.post('state.changed', { revision: 2 })
  assert.equal(host.callsOf('plugin.request').length, 2, 'a push asks for the new snapshot')
  assert.ok(panel.find({ text: COPY['status.count'].en.replace('{count}', '2') }))

  await panel.post('state.changed', { revision: 1 })
  assert.equal(host.callsOf('plugin.request').length, 2, 'a stale push asks nothing')
  assert.deepEqual(panel.refusals, [])
})

test('a page in flight shows the loading state, then the empty state', async () => {
  panel = await mount(panelModule, {
    host: mockHost({ requests: { state: () => healthyState() } }),
    locale: 'en'
  })
  // 首屏：加载期间是 Skeleton；读完后是空态。
  assert.ok(
    panel.summary().some((line) => line.startsWith('EmptyState')) ||
      panel.summary().some((line) => line.startsWith('Skeleton')),
    'the shell draws one of the two states'
  )
  assert.ok(panel.find({ text: COPY['overview.nothingNeedsYou'].en }), 'a healthy worker says nothing needs you')
  assert.ok(
    panel.find({ text: new RegExp(COPY['overview.flowReceived'].en) }),
    'the 24 h flow is on the overview'
  )
})

test('an error state names the reason and offers a retry that works', async () => {
  let fail = true
  const host = mockHost({
    requests: {
      state: () => {
        if (fail) throw hostError('unavailable', 'worker not started')
        return healthyState()
      }
    }
  })
  // 虚拟时钟要在挂载前装好：setup 里的那次重试正是在 mount 期间排的。
  mock.timers.enable({ apis: ['setTimeout'] })
  panel = await mount(panelModule, { host, locale: 'en' })
  // 冷启动的第一次失败显示「正在启动」，重试也失败后给出原因与重试入口。
  mock.timers.tick(2000)
  await panel.settled()
  assert.ok(panel.find({ text: new RegExp(COPY['boot.unavailable'].en) }), 'the error state names it')
  assert.ok(panel.find({ text: /worker not started/ }), 'the reason is shown')

  fail = false
  await panel.press({ text: COPY['state.retry'].en })
  assert.ok(panel.find({ text: COPY['overview.nothingNeedsYou'].en }), 'the retry reads again')
  assert.deepEqual(panel.errors, [])
})

test('tickets needing a person are listed with the stage the person acts on', async () => {
  const state = healthyState({
    attention: {
      answer: 1,
      review: 1,
      problems: 0,
      items: [attentionItem('t1', 'Fix the login redirect'), attentionItem('t2', 'Review the parser', 'review')]
    }
  })
  panel = await mount(panelModule, { host: mockHost({ requests: { state: () => state } }), locale: 'en' })
  const list = panel.findAll({ type: 'ListItem' })
  assert.equal(list.length, 2)
  assert.ok(panel.find({ text: new RegExp(COPY['stage.answer'].en) }), 'the answer stage')
  assert.ok(panel.find({ text: new RegExp(COPY['stage.review'].en) }), 'the review stage')
  assert.ok(panel.find({ text: /Fix the login redirect/ }))
})

test('long lists page at fifty rows instead of drawing everything', async () => {
  const items = Array.from({ length: 60 }, (_, index) => attentionItem(`t${index}`, `Ticket ${index}`))
  const state = healthyState({
    attention: { answer: 60, review: 0, problems: 0, items }
  })
  panel = await mount(panelModule, { host: mockHost({ requests: { state: () => state } }), locale: 'en' })
  assert.equal(panel.findAll({ type: 'ListItem' }).length, 50)
  await panel.press({ text: COPY['state.loadMore'].en })
  assert.equal(panel.findAll({ type: 'ListItem' }).length, 60)
})

test('a paused worker says so, and offers resuming behind an inline confirmation', async () => {
  const paused = healthyState({
    health: { ...healthyState().health, paused: true }
  })
  const host = mockHost({
    requests: {
      state: () => paused,
      pause: () => ({ ...paused, health: { ...paused.health, paused: false } })
    }
  })
  panel = await mount(panelModule, { host, locale: 'en' })
  assert.ok(panel.find({ text: new RegExp(COPY['processing.paused'].en) }), 'paused is stated plainly')

  await panel.press({ text: COPY['action.resume'].en })
  assert.ok(panel.find({ text: COPY['confirm.body.resume'].en }), 'the row states the consequence before acting')
  assert.equal(pauseCalls(host), 0)

  await panel.press({ text: COPY['action.cancel'].en })
  assert.equal(panel.find({ text: COPY['confirm.body.resume'].en }), null, 'cancel closes the confirmation')
  assert.equal(pauseCalls(host), 0)

  await panel.press({ text: COPY['action.resume'].en })
  await panel.press({ text: COPY['action.resume'].en })
  assert.equal(pauseCalls(host), 1)
  assert.equal(panel.find({ text: new RegExp(COPY['processing.paused'].en) }), null, 'the page follows the new snapshot')
  assert.deepEqual(panel.errors, [])
  assert.deepEqual(panel.refusals, [])
})

test('a setup problem points at Settings, and Settings is one press away', async () => {
  const setupMissing = healthyState({
    health: { ...healthyState().health, setupMissing: true }
  })
  panel = await mount(panelModule, { host: mockHost({ requests: { state: () => setupMissing } }), locale: 'en' })
  assert.ok(panel.find({ text: new RegExp(COPY['setup.missing'].en) }))
  await panel.press({ text: COPY['setup.openSettings'].en })
  assert.equal(currentPage(panel), 'settings')
})

test('the worker-reported problems are visible on the overview', async () => {
  // #37 把占位的一行数字换成了真行：#J.3 的三类来源各一行，点行去归属页。
  const problems = healthyState({
    health: { ...healthyState().health, error: true },
    attention: { answer: 0, review: 0, problems: 2, items: [] },
    problems: [
      { id: 'health:assessment', kind: 'health', name: 'assessment', detail: 'waiting 2, failed 1' },
      { id: 'unavailable:d1', kind: 'unavailable', name: 'thread-7', detail: 'no answer' }
    ]
  })
  panel = await mount(panelModule, { host: mockHost({ requests: { state: () => problems } }), locale: 'zh-CN' })
  assert.ok(panel.find({ text: /assessment/ }), 'the health entry that broke')
  assert.ok(panel.find({ text: /thread-7/ }), 'the decision that needs a person')
  assert.ok(
    panel.summary().some((line) => line.includes(translate('zh-CN', 'overview.problems'))),
    'the section is titled in the panel language'
  )
})

test('both languages say the same things on the same page', async () => {
  for (const locale of ['zh-CN', 'en']) {
    panel = await mount(panelModule, {
      host: mockHost({ requests: { state: () => healthyState() } }),
      locale
    })
    assert.ok(panel.find({ text: COPY['overview.nothingNeedsYou'][locale === 'en' ? 'en' : 'zh'] }))
    assert.ok(panel.find({ label: COPY['panel.glossaryOpen'][locale === 'en' ? 'en' : 'zh'] }))
    await panel.unmount()
    panel = undefined
  }
})

test('a hidden panel hears a push but asks nothing until it is shown again', async () => {
  const host = mockHost({ requests: { state: () => healthyState({ revision: 2 }) } })
  panel = await mount(panelModule, { host, locale: 'en' })
  assert.equal(host.callsOf('plugin.request').length, 1)

  await panel.setVisible(false)
  await panel.post('state.changed', { revision: 2 })
  assert.equal(host.callsOf('plugin.request').length, 1, 'hidden: the push asks nothing')

  await panel.setVisible(true)
  await panel.post('state.changed', { revision: 3 })
  assert.equal(host.callsOf('plugin.request').length, 2, 'visible again: the next push reads')
})

test('the panel never draws a clock of its own: every time is a RelativeTime', async () => {
  const state = healthyState({
    attention: {
      answer: 1,
      review: 0,
      problems: 0,
      items: [attentionItem('t1', 'Fix the login redirect')]
    }
  })
  panel = await mount(panelModule, { host: mockHost({ requests: { state: () => state } }), locale: 'en' })
  // 待人工的行带时间，而时间只由宿主组件画（面板不 setInterval，也不格式化日期）。
  assert.equal(panel.findAll({ type: 'RelativeTime' }).length, 1)
  assert.equal(panel.find({ type: 'RelativeTime' })?.role, 'time')
  assert.ok(panel.find({ text: /Fix the login redirect/ }))
})

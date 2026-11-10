// 页面壳的公共零件与行组件（§M.2、§M.4）：三态、行内二次确认、Markdown、四种行。
// 页面票（#37–#48）直接用它们，因此每个页面的加载/空/错误与确认对话长得一样，
// 而且都只用 Orca 的语义组件（没有 Modal、没有浏览器 confirm、没有 style/className）。
import { afterEach, assert, mockHost, mount, test } from 'orca/testing'
import { Badge, Button, List, Stack, Text } from 'orca'
import type { PanelState } from '../src/panel/protocol'
import { DecisionRow, SourceRow, ThreadRow, TicketRow } from '../src/panel/rows'
import {
  BootingState,
  ConfirmAction,
  EmptyStateBlock,
  ErrorState,
  Hint,
  InlineError,
  MarkBadge,
  PageHeader,
  Section
} from '../src/panel/widgets'

let panel: Awaited<ReturnType<typeof mount>> | undefined

afterEach(async () => {
  await panel?.unmount()
  panel = undefined
})

/** 每页都要有的三态（§M.2）：加载、空、错误。 */
function States() {
  return (
    <Stack gap="sm">
      <BootingState text="Starting…" />
      <EmptyStateBlock title="Nothing needs you." description="All quiet." icon="check" />
      <ErrorState
        title="Could not read this page"
        reason="worker not started"
        locale="en"
        onRetry={() => undefined}
      />
      <Hint text="One sentence." />
    </Stack>
  )
}

test('the three states draw a startup note, an empty state, and an error with its reason and retry', async () => {
  panel = await mount(States, { host: mockHost(), locale: 'en' })
  const summary = panel.summary()
  assert.ok(summary.some((line) => line.startsWith('Callout neutral "Starting…"')), 'the startup note')
  assert.ok(summary.some((line) => line.startsWith('EmptyState "Nothing needs you."')), 'the empty state')
  assert.ok(summary.some((line) => line.startsWith('Callout danger "Could not read this page"')), 'the error state')
  assert.ok(panel.find({ text: /worker not started/ }), 'the error names its reason')
  assert.ok(panel.find({ text: 'Retry' }), 'and offers a retry')
  assert.deepEqual(panel.errors, [])
  assert.deepEqual(panel.refusals, [])
})

test('the error retry calls back exactly once per press', async () => {
  let retries = 0
  panel = await mount(
    function Retry() {
      return (
        <ErrorState
          title="Could not read this page"
          reason="worker not started"
          locale="en"
          onRetry={() => {
            retries += 1
          }}
        />
      )
    },
    { host: mockHost(), locale: 'en' }
  )
  await panel.press({ text: 'Retry' })
  assert.equal(retries, 1)
})

test('a destructive action asks inline first, and only acts after Confirm', async () => {
  let stopped = 0
  function Confirm() {
    return (
      <ConfirmAction
        id="stop-t1"
        label="Stop"
        action="Stop ticket"
        target="Fix the login redirect"
        confirmLabel="Stop ticket"
        consequence="Stopping withdraws the mandate and stops the worker; it cannot be undone."
        locale="en"
        onConfirm={() => {
          stopped += 1
        }}
      />
    )
  }
  panel = await mount(Confirm, { host: mockHost(), locale: 'en' })
  assert.ok(panel.find({ text: 'Stop' }), 'the action is offered')
  assert.equal(panel.find({ type: 'Callout' }), null, 'no confirmation before the press')

  await panel.press({ text: 'Stop' })
  assert.ok(panel.find({ type: 'Callout' }), 'a warning callout replaces the action')
  assert.ok(panel.find({ text: /Stop ticket “Fix the login redirect”\?/ }), 'the title names the action and the target')
  assert.ok(panel.find({ text: /cannot be undone/ }), 'the body states the consequence')
  assert.equal(stopped, 0, 'nothing happened yet')

  await panel.press({ text: 'Cancel' })
  assert.equal(stopped, 0, 'cancel leaves it alone')
  assert.equal(panel.find({ type: 'Callout' }), null)

  await panel.press({ text: 'Stop' })
  await panel.press({ text: 'Stop ticket' })
  assert.equal(stopped, 1, 'confirm acts once')
  assert.equal(panel.find({ type: 'Callout' }), null, 'and closes the confirmation')
})

test('only one confirmation is open at a time', async () => {
  function Two() {
    return (
      <Stack gap="sm">
        <ConfirmAction id="a" label="Stop A" action="Stop ticket" target="A" consequence="It stops." locale="en" onConfirm={() => undefined} />
        <ConfirmAction id="b" label="Stop B" action="Stop ticket" target="B" consequence="It stops." locale="en" onConfirm={() => undefined} />
      </Stack>
    )
  }
  panel = await mount(Two, { host: mockHost(), locale: 'en' })
  await panel.press({ text: 'Stop A' })
  assert.ok(panel.find({ text: /Stop ticket “A”\?/ }))
  await panel.press({ text: 'Stop B' })
  assert.equal(panel.find({ text: /Stop ticket “A”\?/ }), null, 'the first closes')
  assert.ok(panel.find({ text: /Stop ticket “B”\?/ }), 'the second opens')
})

test('a page header carries the title, subtitle and its right-hand actions', async () => {
  function Head() {
    return <PageHeader title="Superagent" subtitle="Supervises a proactive coding agent." actions={<Button>Check again</Button>} />
  }
  panel = await mount(Head, { host: mockHost(), locale: 'en' })
  assert.ok(panel.find({ text: /Superagent/ }))
  assert.ok(panel.find({ text: /Supervises a proactive coding agent\./ }))
  assert.ok(panel.find({ text: 'Check again' }))
})

/**
 * 页头标题的字号档不能变（LOW-14：「不得改变现有字号与视觉层次」）。基线的页头标题是
 * `<Text weight="semibold">`，宿主 `Text` 的缺省 size 就是 `text-sm`（14px）；把它换成
 * `Heading level={1}` 会变成 16px。这条断言钉住「是 Text、semibold、没有显式 size」。
 */
test('the page header title keeps the base type node and its default (14px) size', async () => {
  function Head() {
    return <PageHeader title="Superagent" subtitle="Supervises a proactive coding agent." />
  }
  panel = await mount(Head, { host: mockHost(), locale: 'en' })

  interface Node {
    readonly type?: string
    readonly props?: { readonly weight?: string; readonly size?: string }
    readonly children?: readonly (Node | string)[]
  }
  const findTitle = (node: Node): Node | undefined => {
    if (node.type !== undefined && node.children !== undefined) {
      if ((node.children as readonly unknown[]).includes('Superagent')) return node
    }
    for (const child of node.children ?? []) {
      if (typeof child === 'string') continue
      const hit = findTitle(child)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  const title = findTitle(panel.tree() as Node)
  assert.ok(title, 'the title is drawn')
  assert.equal(title.type, 'Text', 'the title stays a Text node (Heading level=1 would be 16px)')
  assert.equal(title.props?.weight, 'semibold')
  assert.equal(title.props?.size, undefined, 'no explicit size: the host default (text-sm, 14px) applies')
})

test('a section names its count when it has one', async () => {
  function Groups() {
    return (
      <Stack gap="sm">
        <Section title="Needs you" count={3}>
          <Text>rows</Text>
        </Section>
        <Section title="Executor load">
          <Text>0 / 4 running</Text>
        </Section>
      </Stack>
    )
  }
  panel = await mount(Groups, { host: mockHost(), locale: 'en' })
  assert.ok(panel.find({ text: /Needs you · 3/ }))
  assert.ok(panel.find({ text: /Executor load/ }))
})

test('a mark badge uses the tone the marks table decided', async () => {
  function Marks() {
    return (
      <Stack gap="xs">
        <MarkBadge label="Awaiting review" tone="warning" />
        <MarkBadge label="Working" tone="accent" />
      </Stack>
    )
  }
  panel = await mount(Marks, { host: mockHost(), locale: 'en' })
  assert.deepEqual(
    panel.findAll({ type: 'Badge' }).map((badge) => badge.text),
    ['Awaiting review', 'Working']
  )
  const tone = (panel.tree() as { children: readonly { props?: { tone?: string } }[] }).children.map(
    (child) => child.props?.tone
  )
  assert.deepEqual(tone, ['warning', 'accent'])
})

test('a Ticket row says what the person must do, with a relative time and its stage icon', async () => {
  function Rows() {
    return (
      <List label="Needs you">
        <TicketRow
          locale="en"
          ticket={{ id: 't1', title: 'Fix the login redirect', action: 'answer', at: 1_700_000_000_000 }}
        />
        <TicketRow
          locale="en"
          ticket={{ id: 't2', title: 'Review the parser', action: 'review', at: 1_700_000_000_000 }}
        />
      </List>
    )
  }
  panel = await mount(Rows, { host: mockHost(), locale: 'en' })
  const items = panel.findAll({ type: 'ListItem' })
  assert.equal(items.length, 2)
  assert.ok(panel.find({ text: /Fix the login redirect/ }))
  assert.ok(panel.find({ text: /Awaiting answer/ }))
  assert.ok(panel.find({ text: /Awaiting review/ }))
  // 时间由宿主组件画，行里不自己格式化。
  assert.equal(panel.findAll({ type: 'RelativeTime' }).length, 2)
})

test('a Thread row counts what waits behind a queued thread', async () => {
  function Rows() {
    return (
      <List label="Threads">
        <ThreadRow
          locale="en"
          thread={{
            key: 'github:1',
            title: 'Payroll export',
            source: 'GitHub',
            stage: 'queued',
            pending: 2,
            lastAt: 1_700_000_000_000
          }}
        />
      </List>
    )
  }
  panel = await mount(Rows, { host: mockHost(), locale: 'en' })
  assert.ok(panel.find({ text: /Queued 2/ }))
})

test('a Decision row names its kind, reason, strength and policy version', async () => {
  function Rows() {
    return (
      <List label="Decisions">
        <DecisionRow
          locale="en"
          decision={{
            id: 'd1',
            kind: 'accept',
            reason: 'A person on the allowed list asked for it',
            strength: 'explicit',
            policyVersion: 7,
            at: 1_700_000_000_000
          }}
        />
      </List>
    )
  }
  panel = await mount(Rows, { host: mockHost(), locale: 'en' })
  assert.ok(panel.find({ text: /Accept/ }))
  assert.ok(panel.find({ text: /A person on the allowed list asked for it/ }))
  assert.ok(panel.find({ text: /Strength · Explicit/ }))
  assert.ok(panel.find({ text: /Policy version · 7/ }))
})

test('a Source row keeps its setup problem inline, next to the action that opens the Source page', async () => {
  function Rows() {
    return (
      <List label="Sources">
        <SourceRow
          locale="en"
          source={{ id: 'github', title: 'GitHub', state: 'error', problem: 'gh is not signed in' }}
        />
      </List>
    )
  }
  panel = await mount(Rows, { host: mockHost(), locale: 'en' })
  assert.ok(panel.find({ text: /gh is not signed in/ }))
  assert.ok(panel.find({ text: /Error/ }))
  // 按钮只打开 Source 页（`onOpen`），不重跑检查，所以它不能写「Check again」。
  assert.ok(panel.find({ text: 'Open Source' }), 'the label names what the press does')
  assert.equal(panel.find({ text: 'Check again' }), null, 'nothing claims to re-run the check')
})

test('the rows keep the same shapes in Chinese', async () => {
  function Rows() {
    return (
      <List label="待人工">
        <TicketRow locale="zh-CN" ticket={{ id: 't1', title: '修复登录跳转', action: 'answer', at: 1 }} />
        <DecisionRow
          locale="zh-CN"
          decision={{ id: 'd1', kind: 'stop', reason: '不属于本工单', strength: 'inferred', policyVersion: 3, at: 1 }}
        />
      </List>
    )
  }
  panel = await mount(Rows, { host: mockHost(), locale: 'zh-CN' })
  assert.ok(panel.find({ text: /待回答/ }))
  assert.ok(panel.find({ text: /停止/ }))
  assert.ok(panel.find({ text: /强度 · 推断/ }))
  assert.deepEqual(panel.refusals, [])
})

test('the shell never draws a Badge with a tone Orca does not have', async () => {
  function Marks() {
    return (
      <Stack gap="xs">
        <Badge tone="success">Ready</Badge>
      </Stack>
    )
  }
  panel = await mount(Marks, { host: mockHost(), locale: 'en' })
  assert.deepEqual(panel.warnings, [])
})

test('a state snapshot type keeps the panel and the worker honest', () => {
  const state: PanelState = {
    revision: 1,
    booted: true,
    health: {
      error: false,
      paused: false,
      setupMissing: false,
      sources: { enabled: 0, problems: 0 },
      activity: { received: 0, evaluated: 0, accepted: 0, ignored: 0, ended: 0 },
      executor: { running: 0, maxWorkers: 4, humanSlot: 'free' }
    },
    attention: { answer: 0, review: 0, problems: 0, items: [] },
    problems: []
  }
  assert.equal(state.booted, true)
})

test('a confirmation is neutral unless the caller says the action destroys something', async () => {
  function Pair() {
    return (
      <Stack gap="sm">
        <ConfirmAction
          id="resume"
          label="Resume processing"
          action="Resume processing"
          confirmLabel="Resume processing"
          consequence="Sources keep recording Triggers, and dispatch, Evals and replies resume."
          locale="en"
          onConfirm={() => undefined}
        />
        <ConfirmAction
          id="stop"
          label="Stop"
          action="Stop ticket"
          target="Fix the login redirect"
          confirmLabel="Stop ticket"
          consequence="Stopping withdraws the mandate and stops the worker; it cannot be undone."
          tone="danger"
          locale="en"
          onConfirm={() => undefined}
        />
      </Stack>
    )
  }
  panel = await mount(Pair, { host: mockHost(), locale: 'en' })
  await panel.press({ text: 'Resume processing' })
  assert.ok(panel.find({ type: 'Button', text: 'Resume processing' }), 'the confirm button is named after the action')
  assert.equal(
    (JSON.stringify(panel.tree()).match(/"tone":"danger"/g) ?? []).length,
    0,
    'a neutral confirmation carries no danger tone'
  )

  await panel.press({ text: 'Stop' })
  assert.equal(
    (JSON.stringify(panel.tree()).match(/"tone":"danger"/g) ?? []).length,
    1,
    'the destructive confirmation is the only danger button'
  )
  assert.ok(panel.find({ text: 'Stop ticket' }), 'and its button is verb + object')
})

test('an inline error names the next step and can offer a retry', async () => {
  let retries = 0
  function Errors() {
    return (
      <Stack gap="sm">
        <InlineError
          text="Reason: worker not started. Try again; if it still fails, read that entry in the health detail on the Deployment page."
          locale="en"
          onRetry={() => {
            retries += 1
          }}
        />
      </Stack>
    )
  }
  panel = await mount(Errors, { host: mockHost(), locale: 'en' })
  assert.ok(panel.find({ text: /read that entry in the health detail/ }), 'the next step is named')
  await panel.press({ text: 'Retry' })
  assert.equal(retries, 1)
})

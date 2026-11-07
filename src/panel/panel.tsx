// 面板入口（§M.1–M.7）：渲染当前导航页。
//
// 数据只来自 worker 推送（`state.changed` 带单调修订号），面板不轮询、不自带时钟
// （时间一律交给宿主的 `RelativeTime`），隐藏时不发请求；冷启动只重试一次。
// 页面票（#37–#48）填 Overview 以外的页面；本票交付壳与 Overview 的骨架读数。
import {
  atom,
  Badge,
  Button,
  Callout,
  env,
  IconButton,
  List,
  ListItem,
  plugin,
  read,
  RelativeTime,
  Row,
  set,
  type OrcaElement,
  Stack,
  Tab,
  Tabs,
  Text,
  type PanelContext
} from 'orca'
import { GLOSSARY_GROUPS, translate, type CopyKey } from './copy'
import { markLabel, ticketMark, type MarkTone } from './marks'
import {
  isNavPage,
  NAV_PAGES,
  type AttentionItem,
  type NavPage,
  type PanelState,
  type PanelTicket
} from './protocol'
import { TicketRow, type TicketRowData } from './rows'
import {
  BootingState,
  ConfirmAction,
  EmptyStateBlock,
  ErrorState,
  Hint,
  PageHeader,
  Section
} from './widgets'

/** 冷启动的唯一一次重试间隔（§M.6：2 秒后重试一次，避免与「不轮询」冲突）。 */
const RETRY_MS = 2000

/** 长列表的首页行数（§M.4：无虚拟列表，长列表靠分页 50 条）。 */
const PAGE_ROWS = 50

/** 导航记忆（§M.1）：`persist: 'storage'` 写进插件私有存储，重开面板回到上次停留页。 */
const page = atom('panel.page', 'overview', { persist: 'storage' })

/** 术语表覆盖层是否打开（页头 `(?)`；不是第八个导航项）。 */
const glossary = atom('panel.glossary', false)

/** 最近一份快照；`null` 表示还没读到。 */
const snapshot = atom<PanelState | null>(null)

/** 读取阶段：`starting` 还没问 / `retrying` 已失败一次 / `error` 重试用尽。 */
type Phase = 'starting' | 'retrying' | 'error' | 'ready'
const phase = atom<Phase>('starting')

/** 已采纳的最高修订号：更旧的推送与响应都不生效（§M.6 的单调计数）。 */
const revision = atom(0)

/** 最近一次读取失败的原因（错误态要给出原因）。 */
const reason = atom('')

/** 当前页展开到第几行（分页）。 */
const rows = atom(PAGE_ROWS)

/** 动作失败的原因（暂停/恢复）。 */
const actionError = atom('')

/** 面板是否已被卸载：晚到的响应不再改状态。 */
let disposed = false

/** 唯一一次冷启动重试的定时器。 */
let retryTimer: ReturnType<typeof setTimeout> | null = null

/** 是否已经用掉那次重试。 */
let retried = false

/** 错误对象的可读原因（`HostError.message`；没有就 String）。 */
function reasonOf(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  return String(error)
}

/**
 * 读一份快照并落地。修订号更旧的响应被丢弃；失败时第一次记下「重试中」并安排唯一一次重试，
 * 之后进入错误态（给出原因与重试入口）。所有状态写入都在异步回调里，不在渲染里。
 */
async function load(): Promise<void> {
  try {
    const next = await plugin.request('state')
    if (disposed) return
    if (next.revision >= read(revision)) {
      set(snapshot, next)
      set(revision, next.revision)
      set(rows, PAGE_ROWS)
    }
    set(phase, 'ready')
    set(reason, '')
    retried = false
  } catch (error) {
    if (disposed) return
    const why = reasonOf(error)
    set(reason, why)
    if (!retried) {
      retried = true
      set(phase, 'retrying')
      if (retryTimer !== null) clearTimeout(retryTimer)
      retryTimer = setTimeout(() => {
        retryTimer = null
        void load()
      }, RETRY_MS)
      return
    }
    set(phase, 'error')
  }
}

/**
 * 面板的 setup（§M.6）：订阅 worker 推送；可见时问一次首屏快照；隐藏时什么都不问。
 * 推送只按修订号触发一次读取，因此这里没有轮询，也没有自己计时的数据来源。
 */
export function setup(ctx: PanelContext): () => void {
  disposed = false
  // 导航记忆里的脏值（旧版本留下的页面名）在第一次渲染前改回 Overview。
  if (!isNavPage(read(page))) set(page, 'overview')
  ctx.subscriptions.push(
    plugin.on('state.changed', (payload) => {
      // 更旧的推送不触发读取；隐藏时也不发请求（下次可见后的第一次推送会补上）。
      if (payload.revision <= read(revision)) return
      if (!read(ctx.visible)) return
      void load()
    })
  )
  if (read(ctx.visible)) void load()
  else set(phase, 'starting')
  return () => {
    disposed = true
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }
}

/** 每个文件一份：页面读的文案键与语言，渲染时不出现裸字符串。 */
function words(locale: string, key: CopyKey): string {
  return translate(locale, key)
}

/** 术语表覆盖层（§M.1）：页头 `(?)` 打开，内容来自 `copy.ts` 的 `glossary` 段。 */
function GlossaryOverlay(props: { readonly locale: string; readonly onClose: () => void }): OrcaElement {
  const locale = props.locale
  return (
    <Callout tone="neutral" title={words(locale, 'panel.glossaryOpen')} icon="book">
      <Stack gap="md">
        <Text muted size="xs">
          {words(locale, 'panel.glossaryIntro')}
        </Text>
        {GLOSSARY_GROUPS.map((group) => (
          <Stack key={group.key} gap="xs">
            <Text weight="medium" size="sm">
              {translate(locale, group.label)}
            </Text>
            <List label={translate(locale, group.label)}>
              {group.terms.map((term) => (
                <ListItem
                  key={term}
                  title={translate(locale, `term.${term}` as CopyKey)}
                  description={translate(locale, `glossary.meaning.${term}` as CopyKey)}
                />
              ))}
            </List>
          </Stack>
        ))}
        <Row justify="end">
          <Button variant="ghost" size="sm" onPress={props.onClose}>
            {words(locale, 'panel.glossaryClose')}
          </Button>
        </Row>
      </Stack>
    </Callout>
  )
}

/** 一条 Execution 行（`PanelTicket`）→ 共享的 Ticket 行（§M.2 Execution；详情归 #38）。 */
function executionRow(ticket: PanelTicket): TicketRowData {
  if (ticket.stage === 'ended') {
    return {
      id: ticket.id,
      title: ticket.title,
      at: ticket.at,
      stage: 'ended',
      ...(ticket.outcome === undefined ? {} : { outcome: ticket.outcome })
    }
  }
  if (ticket.stage === 'working' || ticket.stage === 'idle') {
    return { id: ticket.id, title: ticket.title, at: ticket.at, stage: ticket.stage }
  }
  if (ticket.stage === 'queued') {
    return { id: ticket.id, title: ticket.title, at: ticket.at, action: 'queued' }
  }
  if (ticket.stage === 'blockedFailed') {
    return { id: ticket.id, title: ticket.title, at: ticket.at, action: 'failed' }
  }
  return { id: ticket.id, title: ticket.title, at: ticket.at, action: ticket.stage }
}

/** 一名待人工 Ticket 的行（§M.2 Overview ①）：阶段标记 + 标题 + 相对时间。 */
function AttentionRow(props: { readonly locale: string; readonly item: AttentionItem }): OrcaElement {
  const mark = ticketMark({ stage: 'person', action: props.item.action })
  return (
    <ListItem
      key={props.item.id}
      title={props.item.title}
      description={markLabel(props.locale, mark)}
      icon={mark.icon}
    >
      <Row gap="xs" align="center">
        <Text muted size="xs">
          {markLabel(props.locale, mark)}
        </Text>
        <RelativeTime at={props.item.at} format="short" muted />
      </Row>
    </ListItem>
  )
}

/** 一个读数：标签 + 值。 */
function Stat(props: { readonly label: string; readonly value: string; readonly tone?: MarkTone }): OrcaElement {
  return (
    <Stack gap="none">
      <Text muted size="xs">
        {props.label}
      </Text>
      <Text size="sm" {...(props.tone === undefined ? {} : { tone: props.tone })}>
        {props.value}
      </Text>
    </Stack>
  )
}

/** Overview 的骨架读数（§M.2 ①–④）：页面票 #37 会补齐行的动作与来源明细。 */
function Overview(props: { readonly locale: string; readonly state: PanelState }): OrcaElement {
  const locale = props.locale
  const state = props.state
  const pending = state.attention.items
  const paused = state.health.paused
  const flow = state.health.activity
  const executor = state.health.executor
  // 「待人工」已经按动作列出的工单，不在下面重复一遍；其余（工作中/闲置/已结束）在这里
  // 以同一种行展示（§M.2 Overview 的数据面：Ticket 行来自同一份快照）。
  const shown = new Set(pending.map((item) => item.id))
  const otherTickets = (state.tickets ?? []).filter((ticket) => !shown.has(ticket.id))
  return (
    <Stack gap="md">
      {state.health.setupMissing ? (
        <Callout tone="warning" title={words(locale, 'setup.missing')} icon="warning">
          <Row gap="xs">
            <Button variant="outline" size="sm" icon="settings" onPress={() => set(page, 'settings')}>
              {words(locale, 'setup.openSettings')}
            </Button>
          </Row>
        </Callout>
      ) : null}

      {paused ? (
        <Callout tone="warning" title={words(locale, 'processing.paused')} icon="pause">
          <Stack gap="sm">
            <ConfirmAction
              id="pause"
              label={words(locale, 'action.resume')}
              action={words(locale, 'action.resume')}
              locale={locale}
              onConfirm={() => void setPaused(false)}
            />
            {read(actionError) === '' ? null : (
              <Text tone="danger" size="xs">
                {read(actionError)}
              </Text>
            )}
          </Stack>
        </Callout>
      ) : null}

      <Section title={words(locale, 'overview.awaitingYou')} count={pending.length}>
        {pending.length === 0 ? (
          <EmptyStateBlock title={words(locale, 'overview.nothingNeedsYou')} icon="check" />
        ) : (
          <List label={words(locale, 'overview.awaitingYou')}>
            {pending.slice(0, read(rows)).map((item) => (
              <AttentionRow key={item.id} locale={locale} item={item} />
            ))}
          </List>
        )}
        {pending.length > read(rows) ? (
          <Row>
            <Button variant="outline" size="sm" onPress={() => set(rows, read(rows) + PAGE_ROWS)}>
              {words(locale, 'state.loadMore')}
            </Button>
          </Row>
        ) : null}
      </Section>

      {otherTickets.length > 0 ? (
        <Section title={words(locale, 'overview.otherTickets')} count={otherTickets.length}>
          <List label={words(locale, 'overview.otherTickets')}>
            {otherTickets.slice(0, read(rows)).map((ticket) => (
              <TicketRow key={ticket.id} locale={locale} ticket={executionRow(ticket)} />
            ))}
          </List>
        </Section>
      ) : null}

      {state.attention.problems > 0 ? (
        <Section title={words(locale, 'overview.problems')}>
          <Text tone="warning" size="sm">
            {translate(locale, 'overview.problemCount', { count: state.attention.problems })}
          </Text>
        </Section>
      ) : null}

      <Section title={words(locale, 'overview.flow')}>
        <Row gap="md" wrap>
          <Stat label={words(locale, 'overview.flowReceived')} value={String(flow.received)} />
          <Stat label={words(locale, 'overview.flowEvaluated')} value={String(flow.evaluated)} />
          <Stat label={words(locale, 'overview.flowAccepted')} value={String(flow.accepted)} />
          <Stat label={words(locale, 'overview.flowIgnored')} value={String(flow.ignored)} />
          <Stat label={words(locale, 'overview.flowEnded')} value={String(flow.ended)} />
        </Row>
      </Section>

      <Section title={words(locale, 'overview.executor')}>
        <Text size="sm">
          {translate(locale, 'overview.executorLoad', {
            running: executor.running,
            maxWorkers: executor.maxWorkers
          })}
        </Text>
      </Section>
    </Stack>
  )
}

/** 暂停或恢复处理（§M.2 的主操作；破坏性，行内二次确认后再发请求）。 */
async function setPaused(paused: boolean): Promise<void> {
  set(actionError, '')
  try {
    const next = await plugin.request('pause', { paused })
    if (disposed) return
    if (next.revision >= read(revision)) {
      set(snapshot, next)
      set(revision, next.revision)
    }
    set(phase, 'ready')
  } catch (error) {
    if (disposed) return
    set(actionError, reasonOf(error))
  }
}

/**
 * Execution 页（§M.2 的 Ticket 列表；详情归 #38）：行来自 worker 快照的 `tickets`，
 * 与 Overview 用同一个 `TicketRow`，因此同一张工单在三个页面上的标记与措辞一致。
 */
function Execution(props: { readonly locale: string; readonly state: PanelState }): OrcaElement {
  const locale = props.locale
  const tickets = props.state.tickets ?? []
  return (
    <Stack gap="md">
      <Section title={translate(locale, 'nav.execution')} count={tickets.length}>
        {tickets.length === 0 ? (
          <EmptyStateBlock title={words(locale, 'execution.empty')} icon="layers" />
        ) : (
          <List label={translate(locale, 'nav.execution')}>
            {tickets.slice(0, read(rows)).map((ticket) => (
              <TicketRow key={ticket.id} locale={locale} ticket={executionRow(ticket)} />
            ))}
          </List>
        )}
        {tickets.length > read(rows) ? (
          <Row>
            <Button variant="outline" size="sm" onPress={() => set(rows, read(rows) + PAGE_ROWS)}>
              {words(locale, 'state.loadMore')}
            </Button>
          </Row>
        ) : null}
      </Section>
    </Stack>
  )
}

/** 一页：Overview 与 Execution 有真实读数，其余页面在页面票里填充（本票只交付壳）。 */
function PageBody(props: { readonly locale: string; readonly current: NavPage }): OrcaElement {
  const locale = props.locale
  const state = read(snapshot)
  const stage = read(phase)
  if (props.current === 'overview' || props.current === 'execution') {
    if (stage === 'error') {
      return <ErrorStateView locale={locale} />
    }
    if (state === null) {
      return stage === 'starting' ? (
        <BootingState text={words(locale, 'boot.starting')} />
      ) : (
        <BootingState text={words(locale, 'boot.retrying')} />
      )
    }
    return props.current === 'overview' ? (
      <Overview locale={locale} state={state} />
    ) : (
      <Execution locale={locale} state={state} />
    )
  }
  return (
    <Stack gap="sm">
      <Section title={translate(locale, `nav.${props.current}` as CopyKey)}>
        <Hint text={words(locale, 'page.placeholder')} />
      </Section>
    </Stack>
  )
}

/** 错误态：给出原因与重试入口（重试只再问一次）。 */
function ErrorStateView(props: { readonly locale: string }): OrcaElement {
  return (
    <ErrorState
      title={words(props.locale, 'boot.unavailable')}
      reason={read(reason)}
      locale={props.locale}
      onRetry={() => {
        retried = false
        set(phase, 'starting')
        void load()
      }}
    />
  )
}

/** 页头：标题、待人工计数、术语表与「重新检查」。 */
function Header(props: { readonly locale: string; readonly state: PanelState | null }): OrcaElement {
  const locale = props.locale
  const total = props.state === null ? 0 : props.state.attention.answer + props.state.attention.review
  return (
    <PageHeader
      title={words(locale, 'panel.title')}
      subtitle={words(locale, 'panel.subtitle')}
      actions={
        <Row gap="xs" align="center">
          {total > 0 ? (
            <Badge tone="warning">{translate(locale, 'status.count', { count: total })}</Badge>
          ) : null}
          <IconButton
            icon="book"
            label={words(locale, 'panel.glossaryOpen')}
            variant="ghost"
            size="sm"
            onPress={() => set(glossary, !read(glossary))}
          />
          <IconButton
            icon="refresh"
            label={words(locale, 'action.refresh')}
            variant="ghost"
            size="sm"
            onPress={() => void load()}
          />
        </Row>
      }
    />
  )
}

/** 面板入口：渲染当前导航页。 */
export default function Panel(): OrcaElement {
  const locale = envLocale()
  // §M.1 的导航记忆：存储里可能是旧版本留下的页面名（例如已删掉的 policy）。
  // 不认识的页面按 Overview 渲染；把存储改回干净值在 `setup` 里做（渲染中不能写 atom）。
  const remembered = read(page)
  const current: NavPage = isNavPage(remembered) ? remembered : 'overview'
  return (
    <Stack gap="md">
      <Header locale={locale} state={read(snapshot)} />
      {read(glossary) ? (
        <GlossaryOverlay locale={locale} onClose={() => set(glossary, false)} />
      ) : null}
      <Tabs
        label={words(locale, 'panel.title')}
        value={current}
        onChange={(next) => {
          if (isNavPage(next)) set(page, next)
        }}
      >
        {NAV_PAGES.map((item) => (
          <Tab key={item} value={item} label={translate(locale, `nav.${item}` as CopyKey)}>
            <PageBody locale={locale} current={item} />
          </Tab>
        ))}
      </Tabs>
    </Stack>
  )
}

/** 面板语言：Orca 的 UI 语言（BCP-47），在渲染里读，切换语言会重渲染（§M.5）。 */
function envLocale(): string {
  return env.locale
}

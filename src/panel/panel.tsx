// 面板入口（§M.1–M.7）：渲染当前导航页。
//
// 数据只来自 worker 推送（`state.changed` 带单调修订号），面板不轮询、不自带时钟
// （时间一律交给宿主的 `RelativeTime`），隐藏时不发请求；冷启动只重试一次。
// Overview（§M.2 的四块）在本票填实；其余页面由页面票（#38–#48）填充。
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
  Toolbar,
  type PanelContext
} from 'orca'
import { GLOSSARY_GROUPS, translate, type CopyKey } from './copy'
import { Deployment, loadDeployment, openDeployment, resetDeployment } from './deployment'
import { markLabel, problemMark, ticketMark, type MarkTone } from './marks'
import { orderWaiting, problemPage } from './overview'
import {
  isNavPage,
  NAV_PAGES,
  type AttentionItem,
  type HumanSlot,
  type NavPage,
  type PanelState,
  type PanelTicket,
  type SystemProblem
} from './protocol'
import { TicketRow, type TicketRowData } from './rows'
import {
  BootingState,
  ConfirmAction,
  EmptyStateBlock,
  ErrorState,
  Hint,
  LoadingState,
  MarkBadge,
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

/** 动作失败的原因（暂停/恢复、检查、重试、聚焦终端）。 */
const actionError = atom('')

/** 「检查一次」的读数：检查完给一行结果反馈（不自己计时，不显示时刻）。 */
const checkResult = atom<{ readonly waiting: number; readonly problems: number } | null>(null)

/** 正在检查（按钮在飞行中不可再按）。 */
const checking = atom(false)

/**
 * 从别的页面点过来的对象（§M.2「点行→对应详情页」）：归属页面与要看的那一条。
 * 详情页（#38–#41）读它来打开对应的那条；本票负责把它写对并切页。
 */
const focus = atom<{ readonly page: NavPage; readonly id: string } | null>(null)

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
 * 采纳一份快照：修订号更旧的响应被丢弃（§M.6 的单调计数），新的一页从第一行开始。
 * 所有写入都在异步回调里，不在渲染里。
 */
function adopt(next: PanelState): void {
  if (next.revision < read(revision)) return
  set(snapshot, next)
  set(revision, next.revision)
  set(rows, PAGE_ROWS)
  set(phase, 'ready')
}

/**
 * 读一份快照并落地。修订号更旧的响应被丢弃；失败时第一次记下「重试中」并安排唯一一次重试，
 * 之后进入错误态（给出原因与重试入口）。所有状态写入都在异步回调里，不在渲染里。
 */
async function load(): Promise<void> {
  try {
    const next = await plugin.request('state')
    if (disposed) return
    adopt(next)
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
      // 部署页读的是另一份读数（限额、health、Router）：停留在这页时跟着推送刷新，但不重跑
      // doctor（那是人要的时候才跑的 `gh`/`lark-cli` 诊断）。
      if (read(page) === 'settings') void loadDeployment()
    })
  )
  const startPage = read(page)
  if (read(ctx.visible)) {
    void load()
    // 重开面板时停在 Deployment 组：这一页的读数也要读一次（渲染里不发请求）。
    if (startPage === 'settings') void openDeployment()
  } else set(phase, 'starting')
  return () => {
    disposed = true
    resetDeployment()
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

/**
 * 一名待人工 Ticket 的行（§M.2 Overview ①）：阶段标记 + 标题 + 相对时间 + 直接动作。
 *
 * 直接动作与阶段一一对应：「回答」「评审」要人去看那条消息/报告，因此切到详情页；
 * 「重试」只给卡住或投递失败的工单（与领域 `canRetry` 同一口径，这类工单的进详情页动作
 * 写作「查看全部」）；「打开终端」只在该 Ticket 有正在跑的终端时出现（面板不能直接聚焦
 * 终端，请求交给 worker）。
 *
 * 为什么是行内按钮而不是「整行可点」：Orca 的组件面拒绝「可点的 ListItem 里再放 Button」
 * （`a ListItem with onPress cannot contain a Button`），两者只能保一个。这里保直接动作
 * ——行里的第一个按钮就是原来点行的那个动作。
 */
function WaitingRow(props: { readonly locale: string; readonly item: AttentionItem }): OrcaElement {
  const locale = props.locale
  const item = props.item
  const mark = ticketMark({ stage: 'person', action: item.action })
  const label = markLabel(locale, mark)
  const retryable = item.action === 'delivery' || item.action === 'blocked' || item.action === 'failed'
  const terminalId = item.terminalId
  const openWords = retryable
    ? words(locale, 'action.details')
    : words(locale, item.action === 'review' ? 'overview.review' : 'overview.answer')
  return (
    <ListItem key={item.id} title={item.title} description={label} icon={mark.icon}>
      <Row gap="xs" align="center" wrap>
        <MarkBadge label={label} tone={mark.tone} />
        <RelativeTime at={item.at} format="short" muted />
        <Button variant="ghost" size="sm" icon="info" onPress={() => openTicket(item.id)}>
          {openWords}
        </Button>
        {retryable ? (
          <Button variant="ghost" size="sm" icon="refresh" onPress={() => void retryTicket(item.id)}>
            {words(locale, 'action.retry')}
          </Button>
        ) : null}
        {terminalId === undefined ? null : (
          <Button variant="ghost" size="sm" icon="play" onPress={() => void focusTerminal(terminalId)}>
            {words(locale, 'overview.openTerminal')}
          </Button>
        )}
      </Row>
    </ListItem>
  )
}

/**
 * 一条系统问题（§M.2 Overview ②）：种类标记 + 出问题的对象 + 原因，点行去归属页。
 * 回复类没有原因（“发不出去”本身就是事实），用固定措辞说明。
 */
function ProblemRow(props: { locale: string; problem: SystemProblem }): OrcaElement {
  const locale = props.locale
  const problem = props.problem
  const mark = problemMark(problem.kind)
  const label = markLabel(locale, mark)
  const detail = problem.detail ?? (problem.kind === 'reply' ? words(locale, 'overview.replyFailed') : '')
  return (
    <ListItem
      key={problem.id}
      title={problem.name}
      description={detail === '' ? label : detail}
      icon={mark.icon}
      onPress={() => openProblem(problem)}
    >
      <Row gap="xs" align="center" wrap>
        <MarkBadge label={label} tone={mark.tone} />
        {detail === '' ? null : (
          <Text muted size="xs">
            {detail}
          </Text>
        )}
      </Row>
    </ListItem>
  )
}

/** 人类槽的一句措辞（`free` / `used`）。 */
function humanSlotWords(locale: string, slot: HumanSlot): string {
  return translate(locale, `overview.humanSlot.${slot}` as CopyKey)
}

/**
 * Overview（§M.2 的四块，按顺序回答）：①待人工 Ticket（按阶段排序，每行带直接动作）
 * ②系统问题（health error、反复失败的回复、未解决的 unavailable）③24 h 流水 ④执行器负载。
 * 三态在 `PageBody` 里分：加载是骨架，读失败是 danger callout，没有待人工是空态 + Source 概况。
 */
function Overview(props: { locale: string; state: PanelState }): OrcaElement {
  const locale = props.locale
  const state = props.state
  const pending = orderWaiting(state.attention.items)
  const paused = state.health.paused
  const flow = state.health.activity
  const executor = state.health.executor
  const sources = state.health.sources
  const checked = read(checkResult)
  const failure = read(actionError)
  // 「待人工」已经列出的工单不在下面重复一遍；其余（工作中/闲置/已结束）在同一份快照里。
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
          </Stack>
        </Callout>
      ) : null}

      <Toolbar label={words(locale, 'overview.actions')}>
        {paused ? null : (
          <ConfirmAction
            id="pause"
            label={words(locale, 'action.pause')}
            action={words(locale, 'action.pause')}
            locale={locale}
            onConfirm={() => void setPaused(true)}
          />
        )}
        <Button
          variant="outline"
          size="sm"
          icon="refresh"
          disabled={read(checking)}
          onPress={() => void checkNow()}
        >
          {words(locale, 'action.refresh')}
        </Button>
      </Toolbar>

      {checked === null ? null : <Hint text={translate(locale, 'overview.checked', checked)} />}
      {failure === '' ? null : (
        <Text tone="danger" size="xs">
          {failure}
        </Text>
      )}

      <Section title={words(locale, 'overview.awaitingYou')} count={pending.length}>
        {pending.length === 0 ? (
          <Stack gap="sm">
            <EmptyStateBlock title={words(locale, 'overview.nothingNeedsYou')} icon="check" />
            <Hint
              text={translate(locale, 'overview.sources', {
                enabled: sources.enabled,
                problems: sources.problems
              })}
            />
          </Stack>
        ) : (
          <List label={words(locale, 'overview.awaitingYou')}>
            {pending.slice(0, read(rows)).map((item) => (
              <WaitingRow key={item.id} locale={locale} item={item} />
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

      <Section title={words(locale, 'overview.problems')} count={state.problems.length}>
        {state.problems.length === 0 ? (
          <Hint text={words(locale, 'overview.problemsEmpty')} />
        ) : (
          <List label={words(locale, 'overview.problems')}>
            {state.problems.map((problem) => (
              <ProblemRow key={problem.id} locale={locale} problem={problem} />
            ))}
          </List>
        )}
      </Section>

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
        <Row gap="md" wrap>
          <Text size="sm">
            {translate(locale, 'overview.executorLoad', {
              running: executor.running,
              maxWorkers: executor.maxWorkers
            })}
          </Text>
          <Text size="sm">
            {translate(locale, 'overview.executorHuman', {
              slot: humanSlotWords(locale, executor.humanSlot)
            })}
          </Text>
        </Row>
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
    </Stack>
  )
}

/**
 * 从 Overview 打开一张工单：记下要看的那一条，再切到 Execution（详情页读 `focus`）。
 * 「回答」「评审」与点行都是这一个动作——人去看的那条东西就在详情页上。
 */
function openTicket(ticketId: string): void {
  set(focus, { page: 'execution', id: ticketId })
  set(page, 'execution')
}

/** 从 Overview 打开一条系统问题的归属页（§M.2「点行→对应详情页」）。 */
function openProblem(problem: SystemProblem): void {
  const target = problemPage(problem)
  set(focus, { page: target, id: problem.id })
  set(page, target)
}

/** 暂停或恢复处理（§M.2 的主操作；破坏性，行内二次确认后再发请求）。 */
async function setPaused(paused: boolean): Promise<void> {
  set(actionError, '')
  try {
    const next = await plugin.request('pause', { paused })
    if (disposed) return
    adopt(next)
  } catch (error) {
    if (disposed) return
    set(actionError, reasonOf(error))
  }
}

/**
 * 「检查一次」（§M.2 的 Overview 主操作）：让 worker 重跑一遍读模型再回答，
 * 然后把结果说成一句话（几个待人工、几个系统问题）——不自己计时，也不假装检查了本地缓存。
 */
async function checkNow(): Promise<void> {
  set(actionError, '')
  set(checking, true)
  try {
    const next = await plugin.request('check')
    if (disposed) return
    adopt(next)
    set(checkResult, { waiting: next.attention.items.length, problems: next.problems.length })
  } catch (error) {
    if (disposed) return
    set(actionError, reasonOf(error))
  } finally {
    if (!disposed) set(checking, false)
  }
}

/** 人的重试（§E.5）：结束卡住的 Assignment，在同一个 worktree 上再起一个。 */
async function retryTicket(ticketId: string): Promise<void> {
  set(actionError, '')
  try {
    const next = await plugin.request('ticket.retry', { ticketId })
    if (disposed) return
    adopt(next)
  } catch (error) {
    if (disposed) return
    set(actionError, reasonOf(error))
  }
}

/** 聚焦一台终端（§M.2：面板不能直接做，请求交给 worker 跑 `orca terminal focus`）。 */
async function focusTerminal(terminalId: string): Promise<void> {
  set(actionError, '')
  try {
    await plugin.request('terminal.focus', { terminalId })
  } catch (error) {
    if (disposed) return
    set(actionError, reasonOf(error))
  }
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


/**
 * Execution 页（§M.2 的 Ticket 列表；详情归 #38）：行来自 worker 快照的 `tickets`，
 * 与 Overview 用同一个 `TicketRow`，因此同一张工单在三个页面上的标记与措辞一致。
 * 从 Overview 点过来的那一张标成 `current`：人去的那一行就是看得见的那一行。
 */
function Execution(props: { readonly locale: string; readonly state: PanelState }): OrcaElement {
  const locale = props.locale
  const tickets = props.state.tickets ?? []
  const focused = read(focus)
  return (
    <Stack gap="md">
      <Section title={translate(locale, 'nav.execution')} count={tickets.length}>
        {tickets.length === 0 ? (
          <EmptyStateBlock title={words(locale, 'execution.empty')} icon="layers" />
        ) : (
          <List label={translate(locale, 'nav.execution')}>
            {tickets.slice(0, read(rows)).map((ticket) => (
              <TicketRow
                key={ticket.id}
                locale={locale}
                ticket={{
                  ...executionRow(ticket),
                  ...(focused?.page === 'execution' && focused.id === ticket.id ? { current: true } : {})
                }}
              />
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

/** 一页：Overview 与 Execution 有真实读数，Settings 现在是 Deployment 组；其余页面在页面票里填充。 */
function PageBody(props: { readonly locale: string; readonly current: NavPage }): OrcaElement {
  const locale = props.locale
  const state = read(snapshot)
  const stage = read(phase)
  if (props.current === 'settings') {
    // Settings 页的其余四组（Sources/Eval/Execution/Prompts）由 #42/#43 填进同一页；
    // 本票交付的是 Deployment 组，它自己管读取、错误态与动作。
    return <Deployment locale={locale} />
  }
  if (props.current === 'overview' || props.current === 'execution') {
    if (stage === 'error') {
      return <ErrorStateView locale={locale} />
    }
    if (state === null) {
      // 首屏在飞行中是骨架 + 进度（§M.2 的加载态）；「正在启动…」只用于失败后的唯一一次重试。
      return stage === 'retrying' ? (
        <BootingState text={words(locale, 'boot.retrying')} />
      ) : (
        <LoadingState label={words(locale, 'state.loading')} />
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
          if (!isNavPage(next)) return
          set(page, next)
          // Deployment 组打开时才读（隐藏与未打开的页面不发请求，§M.6）。
          if (next === 'settings') void openDeployment()
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

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
  CodeView,
  Collapsible,
  env,
  Field,
  IconButton,
  KeyValue,
  List,
  ListItem,
  plugin,
  RadioGroup,
  read,
  RelativeTime,
  Row,
  set,
  type KeyValueItem,
  type OrcaElement,
  Stack,
  Tab,
  Table,
  type TableRow,
  Tabs,
  Text,
  Textarea,
  Toolbar,
  type PanelContext
} from 'orca'
import { GLOSSARY_GROUPS, translate, type CopyKey } from './copy'
import { Deployment, loadDeployment, openDeployment, resetDeployment } from './deployment'
import { problemDecisionId, reasonText, reasonsText } from './eval'
import { executionMark, executionRow } from './execution'
import { decisionMark, markLabel, problemMark, reportMark, ticketMark, type MarkTone } from './marks'
import { orderWaiting, problemPage } from './overview'
import {
  EXECUTION_FILTERS,
  isExecutionFilter,
  isNavPage,
  NAV_PAGES,
  type AttentionItem,
  type DecisionDetailView,
  type DecisionListPage,
  type ExecutionFilter,
  type HumanSlot,
  type NavPage,
  type PanelMandate,
  type PanelState,
  type PanelSubscription,
  type PanelTicket,
  type PanelDecision,
  type SystemProblem,
  type TicketDetailView,
  type TicketListPage
} from './protocol'
import { TicketRow } from './rows'
import { loadSources, openSources, resetSources, SourcePage } from './source-page'
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

/** Execution 列表的筛选（§M.2 的五档）；写进插件存储，重开面板还停在那一档。 */
const executionFilter = atom<ExecutionFilter>('panel.executionFilter', 'open', { persist: 'storage' })

/** 列表已读到的行与下一页的位置；`null` 表示这一档还没读过。 */
const executionList = atom<{
  readonly items: readonly PanelTicket[]
  readonly nextOffset: number | null
} | null>(null)

/** 列表在读（首屏给 `Table` 的 loading，再读只靠按钮的状态）。 */
const executionLoading = atom(false)

/** 列表的读取失败原因。 */
const executionError = atom('')

/** 详情读数与它的三态（读失败要有原因与重试入口）。 */
const detail = atom<TicketDetailView | null>(null)
const detailError = atom('')

/** 「请求状态」的读数：`asked` 是 worker 的如实回答（没有在等的 worker 就是 false）。 */
const statusAsked = atom<boolean | null>(null)

/** 一条 fact note 的草稿（只活在面板里，发送后清空）。 */
const noteDraft = atom('')

/** 详情页的动作在飞行中：确认与发送不可重复按。 */
const acting = atom(false)

/** Eval 列表已读到的窗口；`null` 表示还没读过。 */
const decisionList = atom<DecisionListPage | null>(null)

/** Eval 列表在读（首屏给 `Table` 的 loading，再读只靠按钮的状态）。 */
const decisionLoading = atom(false)

/** Eval 列表的读取失败原因。 */
const decisionError = atom('')

/** 一条决定详情的读数与它的错误态。 */
const decisionDetail = atom<DecisionDetailView | null>(null)
const decisionDetailError = atom('')

/** 详情页的动作在飞行中（dismiss 不可重复按）。 */
const decisionActing = atom(false)

/** 列表请求的代号：只有最后一次请求的答案落地。`set` 是批量生效的（同一个事件里连着
 * `set` + 读，读到的可能是上一批的值），所以「筛选在飞行中变了」用同步计数器判断，
 * 不用在 await 之后重读 atom。
 */
let listRequest = 0

/** Eval 列表请求的代号：与 Execution 同一条理由（旧的答案不能画进新的一页）。 */
let decisionRequest = 0

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
  // Execution 的 atom 是模块级的：上一次挂载留下的列表、详情与草稿不带进这一次。
  if (!isExecutionFilter(read(executionFilter))) set(executionFilter, 'open')
  set(executionList, null)
  set(executionLoading, false)
  set(executionError, '')
  set(detail, null)
  set(detailError, '')
  set(statusAsked, null)
  set(noteDraft, '')
  set(acting, false)
  // Eval 页的 atom 同样是模块级的：上一次挂载留下的列表、详情与错误不带进这一次。
  set(decisionList, null)
  set(decisionLoading, false)
  set(decisionError, '')
  set(decisionDetail, null)
  set(decisionDetailError, '')
  set(decisionActing, false)
  // Source 页同理：上一份读数与各卡的动作状态都不带进这一次。
  resetSources()
  // 上一次挂载还在飞行的列表/详情请求作废（它们的答案不该画进这一次）。
  listRequest += 1
  decisionRequest += 1
  ctx.subscriptions.push(
    plugin.on('state.changed', (payload) => {
      // 更旧的推送不触发读取；隐藏时也不发请求（下次可见后的第一次推送会补上）。
      if (payload.revision <= read(revision)) return
      if (!read(ctx.visible)) return
      void load()
      // 部署页读的是另一份读数（限额、health、Router）：停留在这页时跟着推送刷新，但不重跑
      // doctor（那是人要的时候才跑的 `gh`/`lark-cli` 诊断）。
      if (read(page) === 'settings') void loadDeployment()
      // Execution 页读的是自己的那条请求：详情重读那一张，列表重读已经读到的那几页。
      if (read(page) === 'execution') {
        const focused = read(focus)
        if (focused?.page === 'execution') void loadTicketDetail(focused.id)
        else void refreshExecutionList()
      }
      // Eval 页同理：详情重读那一条决定（dismiss 与新的决定都会改变它），否则重读列表。
      if (read(page) === 'eval') {
        const focused = read(focus)
        if (focused?.page === 'eval') void loadDecisionDetail(focused.id)
        else void refreshDecisions()
      }
      // Source 页读的是它自己的读数（新的 Trigger、drop 与 health 都会改变卡片）。
      if (read(page) === 'source') void loadSources()
    })
  )
  const startPage = read(page)
  if (read(ctx.visible)) {
    void load()
    // 重开面板时停在 Deployment 组：这一页的读数也要读一次（渲染里不发请求）。
    if (startPage === 'settings') void openDeployment()
    // 停在 Execution：焦点指向一张工单就是详情，否则是列表。
    if (startPage === 'execution') enterExecution()
    // 停在 Eval：同理（焦点指向一条决定就是详情，否则是列表）。
    if (startPage === 'eval') enterEval()
    // 停在 Source：读一次卡片（推送之后会各自重读）。
    if (startPage === 'source') void openSources()
  } else set(phase, 'starting')
  return () => {
    disposed = true
    resetDeployment()
    resetSources()
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
 * 从 Overview 打开一张工单：记下要看的那一条，再切到 Execution，并读它的详情（`focus` 是
 * 详情页的入参；请求不在渲染里发）。「回答」「评审」「查看全部」与点行都是这一个动作。
 */
function openTicket(ticketId: string): void {
  set(page, 'execution')
  openTicketDetail(ticketId)
}

/** 打开一张工单的详情（§M.2「点行→详情」）：列表的行动作与 Overview 共用它。 */
function openTicketDetail(ticketId: string): void {
  set(focus, { page: 'execution', id: ticketId })
  set(statusAsked, null)
  set(noteDraft, '')
  void loadTicketDetail(ticketId)
}

/**
 * 进入 Execution 页时读它要的那一份：`focus` 指向一张工单就是详情，否则是当前筛选的列表。
 * 已经读过的不重读（推送与动作会各自触发它们那一次）。
 */
function enterExecution(): void {
  const focused = read(focus)
  if (focused?.page === 'execution') {
    if (read(detail)?.id !== focused.id) void loadTicketDetail(focused.id)
    return
  }
  if (read(executionList) === null) void loadExecutionList()
}

/** 回到列表（清掉「从别处点进来的那一张」）；还没读过列表就当场读一次。 */
function backToExecution(): void {
  set(focus, null)
  set(detail, null)
  set(statusAsked, null)
  if (read(executionList) === null) void loadExecutionList()
}

/** 从 Overview 打开一条系统问题的归属页（§M.2「点行→对应详情页」）。 */
function openProblem(problem: SystemProblem): void {
  const target = problemPage(problem)
  // unavailable 行带着背后的 Decision id：Eval 页要打开的是那条决定，不是合成的问题 id。
  if (target === 'eval') {
    set(page, 'eval')
    openDecisionDetail(problemDecisionId(problem))
    return
  }
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

// ---------------------------------------------------------------------------
// Execution 页的读数与动作（§M.2）：列表、详情、停止/重试/请求状态/note/工作区，全部经
// worker 的同一批 handler；面板没有聚焦终端与打开工作区的宿主方法（§M.2 末段）。
// ---------------------------------------------------------------------------

/** 读一页 Execution 列表：`more` 是「加载更多」，否则从第一行重读。 */
async function loadExecutionList(options: { readonly more?: boolean } = {}): Promise<void> {
  const filter = read(executionFilter)
  const current = read(executionList)
  if (options.more === true && (current === null || current.nextOffset === null)) return
  const offset = options.more === true && current !== null ? (current.nextOffset ?? 0) : 0
  const seq = ++listRequest
  set(executionLoading, true)
  set(executionError, '')
  try {
    const next: TicketListPage = await plugin.request('tickets', { filter, offset, limit: PAGE_ROWS })
    // 又发了一次请求（换档或再点一次）：这一次的答案作废，否则两档的行会混在一起。
    if (disposed || seq !== listRequest) return
    set(executionList, {
      items: offset === 0 ? next.items : [...(read(executionList)?.items ?? []), ...next.items],
      nextOffset: next.nextOffset
    })
  } catch (error) {
    if (disposed) return
    set(executionError, reasonOf(error))
  } finally {
    if (!disposed) set(executionLoading, false)
  }
}

/**
 * 推送后重读已经读到的那些页（不轮询：推送本身就是变化的信号）。重读失败不覆盖已读到的行
 * ——一次读失败不该把页面清空；下一次推送或动作会再试。
 */
async function refreshExecutionList(): Promise<void> {
  const loaded = read(executionList)?.items.length ?? 0
  if (loaded === 0) return
  const filter = read(executionFilter)
  const seq = ++listRequest
  const items: PanelTicket[] = []
  let offset: number | null = 0
  try {
    while (offset !== null && items.length < loaded) {
      const next: TicketListPage = await plugin.request('tickets', {
        filter,
        offset,
        limit: PAGE_ROWS
      })
      if (disposed || seq !== listRequest) return
      if (next.items.length === 0) break
      items.push(...next.items)
      offset = next.nextOffset
    }
    set(executionList, { items, nextOffset: offset })
  } catch {
    // 静默：已读到的行仍然是真的，下一次推送会再读。
  }
}

// ---------------------------------------------------------------------------
// Eval 页的读数与动作（§M.2 的 Eval 行、§K.7 的四条件）：列表、详情与 dismiss 都经 worker
// 的同一批 handler；「24 h 内未解决」是 worker 读模型的判定（面板没有时钟，§M.6）。
// ---------------------------------------------------------------------------

/** 读一页 Eval 列表：`more` 是「加载更多」，否则从第一行重读。 */
async function loadDecisions(options: { readonly more?: boolean } = {}): Promise<void> {
  const current = read(decisionList)
  if (options.more === true && (current === null || current.nextOffset === null)) return
  const offset = options.more === true && current !== null ? (current.nextOffset ?? 0) : 0
  const seq = ++decisionRequest
  set(decisionLoading, true)
  set(decisionError, '')
  try {
    const next: DecisionListPage = await plugin.request('decisions', { offset, limit: PAGE_ROWS })
    if (disposed || seq !== decisionRequest) return
    set(decisionList, {
      items: offset === 0 ? next.items : [...(read(decisionList)?.items ?? []), ...next.items],
      nextOffset: next.nextOffset,
      unresolved: next.unresolved
    })
  } catch (error) {
    if (disposed) return
    set(decisionError, reasonOf(error))
  } finally {
    if (!disposed) set(decisionLoading, false)
  }
}

/**
 * 推送后重读已经读到的那些页（与 Execution 同一条理由：推送本身就是变化的信号）。重读失败
 * 不覆盖已读到的行；待人工条数取最后一次回答——它与 Overview 的 System problems 同源。
 */
async function refreshDecisions(): Promise<void> {
  const current = read(decisionList)
  if (current === null) return
  // 读过但是空的：新的决定可能刚出现，重读第一页（否则页面会一直停在旧空态）。
  if (current.items.length === 0) {
    await loadDecisions()
    return
  }
  const loaded = current.items.length
  const seq = ++decisionRequest
  const items: PanelDecision[] = []
  let offset: number | null = 0
  let unresolved = read(decisionList)?.unresolved ?? 0
  try {
    while (offset !== null && items.length < loaded) {
      const next: DecisionListPage = await plugin.request('decisions', {
        offset,
        limit: PAGE_ROWS
      })
      if (disposed || seq !== decisionRequest) return
      if (next.items.length === 0) break
      items.push(...next.items)
      unresolved = next.unresolved
      offset = next.nextOffset
    }
    set(decisionList, { items, nextOffset: offset, unresolved })
  } catch {
    // 静默：已读到的行仍然是真的，下一次推送会再读。
  }
}

/** 读一条决定的详情（§M.2 的 Eval 详情）。 */
async function loadDecisionDetail(decisionId: string): Promise<void> {
  set(decisionDetailError, '')
  try {
    const next = await plugin.request('decision.detail', { decisionId })
    if (disposed) return
    set(decisionDetail, next)
  } catch (error) {
    if (disposed) return
    set(decisionDetailError, reasonOf(error))
  }
}

/** 进入 Eval 页时读它要的那一份：`focus` 指向一条决定就是详情，否则是列表。 */
function enterEval(): void {
  const focused = read(focus)
  if (focused?.page === 'eval') {
    if (read(decisionDetail)?.id !== focused.id) void loadDecisionDetail(focused.id)
    return
  }
  if (read(decisionList) === null) void loadDecisions()
}

/** 打开一条决定的详情（§M.2「点行→详情」）：列表的行与 Overview 的系统问题共用它。 */
function openDecisionDetail(decisionId: string): void {
  set(focus, { page: 'eval', id: decisionId })
  set(decisionDetail, null)
  void loadDecisionDetail(decisionId)
}

/** 回到列表（清掉「从别处点进来的那一条」）；还没读过列表就当场读一次。 */
function backToEval(): void {
  set(focus, null)
  set(decisionDetail, null)
  set(decisionDetailError, '')
  // 回到列表时按最新读数重读（详情期间的推送只刷新了详情；待人工条数也在这份读数里）。
  if (read(decisionList) === null) void loadDecisions()
  else void refreshDecisions()
}

/** 打开一条 Thread（Trigger 页的焦点）：Source 页的过滤行与 Eval 页的 Thread 链接共用它。 */
function openThread(threadKey: string): void {
  set(focus, { page: 'trigger', id: threadKey })
  set(page, 'trigger')
}

/** 打开设置页并读一次 Deployment 组（Source 页的空态与 setup 提示指向那里）。 */
function openSettings(): void {
  set(page, 'settings')
  void openDeployment()
}

/** 打开决定开的工单（Execution 详情）：与 Overview 的行同一个动作。 */
function openDecisionTicket(ticketId: string): void {
  set(page, 'execution')
  openTicketDetail(ticketId)
}

/**
 * Dismiss 一条 unavailable 决定暴露的问题（§K.7；破坏性已由行内二次确认收下）：采纳写后的
 * 快照，再重读列表与详情——不猜写后的样子。
 */
async function dismissDecision(decisionId: string): Promise<void> {
  set(actionError, '')
  set(decisionActing, true)
  try {
    const next = await plugin.request('decision.dismiss', { decisionId })
    if (disposed) return
    adopt(next)
    if (read(decisionList) === null) await loadDecisions()
    else await refreshDecisions()
    await loadDecisionDetail(decisionId)
  } catch (error) {
    if (!disposed) set(actionError, reasonOf(error))
  } finally {
    if (!disposed) set(decisionActing, false)
  }
}

/** 读一张工单的详情（§M.2 的七块）。 */
async function loadTicketDetail(ticketId: string): Promise<void> {
  set(detailError, '')
  try {
    const next = await plugin.request('ticket.detail', { ticketId })
    if (disposed) return
    set(detail, next)
  } catch (error) {
    if (disposed) return
    set(detailError, reasonOf(error))
  }
}

/** 详情页的动作收尾：采纳写后的快照，再重读详情（同一份读模型，不猜写后的样子）。 */
async function afterDetailAction(action: () => Promise<PanelState>, ticketId: string): Promise<void> {
  set(actionError, '')
  set(acting, true)
  try {
    const next = await action()
    if (disposed) return
    adopt(next)
    await loadTicketDetail(ticketId)
  } catch (error) {
    if (!disposed) set(actionError, reasonOf(error))
  } finally {
    if (!disposed) set(acting, false)
  }
}

/** 人的重试（§E.5）：详情页与 Overview 的行都走这一个请求。 */
async function retryTicket(ticketId: string): Promise<void> {
  await afterDetailAction(() => plugin.request('ticket.retry', { ticketId }), ticketId)
}

/** 停止（§E.5、§K.3：撤回 Mandate）：破坏性，已经过行内二次确认才到这里。 */
async function stopTicket(ticketId: string): Promise<void> {
  await afterDetailAction(() => plugin.request('ticket.stop', { ticketId }), ticketId)
}

/** 发一条 fact note（§G.2 的 `ticket note`）：只加语境，不要求也不授权任何事。 */
async function sendTicketNote(ticketId: string): Promise<void> {
  const text = read(noteDraft).trim()
  if (text === '') return
  set(actionError, '')
  set(acting, true)
  try {
    const next = await plugin.request('ticket.note', { ticketId, text })
    if (disposed) return
    set(noteDraft, '')
    adopt(next)
    await loadTicketDetail(ticketId)
  } catch (error) {
    if (!disposed) set(actionError, reasonOf(error))
  } finally {
    if (!disposed) set(acting, false)
  }
}

/** 请求状态（§G.2 的 `ticket request-status`）：只问正在等 trigger 的 worker。 */
async function requestTicketStatus(ticketId: string): Promise<void> {
  set(actionError, '')
  set(acting, true)
  try {
    const outcome = await plugin.request('ticket.requestStatus', { ticketId })
    if (disposed) return
    set(statusAsked, outcome.asked)
    await loadTicketDetail(ticketId)
  } catch (error) {
    if (!disposed) set(actionError, reasonOf(error))
  } finally {
    if (!disposed) set(acting, false)
  }
}

/** 打开这张工单的 worktree（§M.2：面板没有这个宿主方法，由 worker 代理）。 */
async function openTicketWorktree(ticketId: string): Promise<void> {
  set(actionError, '')
  try {
    await plugin.request('workspace.open', { ticketId })
  } catch (error) {
    if (disposed) return
    set(actionError, reasonOf(error))
  }
}

/** 移除这张工单的 worktree（§E.1 清理）：破坏性，已经过行内二次确认才到这里。 */
async function removeTicketWorktree(ticketId: string): Promise<void> {
  set(actionError, '')
  set(acting, true)
  try {
    await plugin.request('workspace.remove', { ticketId })
    if (disposed) return
    await loadTicketDetail(ticketId)
  } catch (error) {
    if (!disposed) set(actionError, reasonOf(error))
  } finally {
    if (!disposed) set(acting, false)
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
 * 授权面（§M.2 的 Mandate 块）：强度、发起人、policy version、Gate 依据与匹配到的规则。
 * 规则是 Mandate 记录的 id：面板照抄，不替它编名字。
 */
function mandateItems(locale: string, mandate: PanelMandate): readonly KeyValueItem[] {
  const basis = translate(locale, `mandate.via.${mandate.via}` as CopyKey)
  const cell =
    mandate.cell === undefined
      ? ''
      : ` · ${translate(locale, `mandate.cell.${mandate.cell}` as CopyKey)}`
  return [
    {
      label: translate(locale, 'term.strength' as CopyKey),
      value: translate(locale, `strength.${mandate.strength}` as CopyKey)
    },
    { label: words(locale, 'execution.actor'), value: mandate.actor, code: true },
    { label: translate(locale, 'term.policyVersion' as CopyKey), value: mandate.policyVersion },
    { label: words(locale, 'execution.basis'), value: `${basis}${cell}` },
    {
      label: words(locale, 'execution.rules'),
      value:
        mandate.rules.length === 0 ? words(locale, 'execution.noRules') : mandate.rules.join(', '),
      ...(mandate.rules.length === 0 ? {} : { code: true })
    }
  ]
}

/** 终端摘要的预览：Attention 里只看最后几行，完整摘要另有终端块。 */
const TERMINAL_PREVIEW_LINES = 3

/** 一个订阅的行：人读的名字 + 「仅语境」与最后一条的时刻。 */
function SubscriptionRow(props: {
  readonly locale: string
  readonly subscription: PanelSubscription
}): OrcaElement {
  const locale = props.locale
  const subscription = props.subscription
  return (
    <ListItem
      key={subscription.key}
      title={subscription.title}
      description={subscription.context ? words(locale, 'execution.contextOnly') : subscription.key}
      icon={subscription.context ? 'info' : 'layers'}
    >
      <Row gap="xs" align="center" wrap>
        {subscription.context ? (
          <MarkBadge label={words(locale, 'execution.contextOnly')} tone="neutral" />
        ) : null}
        {subscription.lastAt === undefined ? null : (
          <RelativeTime at={subscription.lastAt} format="short" muted />
        )}
      </Row>
    </ListItem>
  )
}

/**
 * 一张工单的详情（§M.2 的 Execution 详情）：授权、等待中的 Input、订阅、派工（可折叠）、
 * Report、Attention（带终端摘要预览）、终端摘要与结局；动作在末尾的工具栏里。
 *
 * 读数来自 `ticket.detail` 这一条请求；写动作全部经 worker 的 handler，成功后重读详情。
 */
function TicketDetailPage(props: { readonly locale: string; readonly ticketId: string }): OrcaElement {
  const locale = props.locale
  const ticket = read(detail)
  const failure = read(detailError)
  const busy = read(acting)
  const asked = read(statusAsked)
  const draft = read(noteDraft)
  const back = (
    <Button variant="ghost" size="sm" icon="next" onPress={backToExecution}>
      {words(locale, 'execution.back')}
    </Button>
  )
  const shown = ticket !== null && ticket.id === props.ticketId ? ticket : null
  if (shown === null) {
    return (
      <Stack gap="md">
        <PageHeader title={translate(locale, 'nav.execution')} actions={back} />
        {failure === '' ? (
          <LoadingState label={words(locale, 'state.loading')} />
        ) : (
          <ErrorState
            title={words(locale, 'state.errorTitle')}
            reason={failure}
            locale={locale}
            onRetry={() => void loadTicketDetail(props.ticketId)}
          />
        )}
      </Stack>
    )
  }
  const mark = executionMark(shown)
  const terminal = shown.terminal
  const lines = terminal?.lines ?? []
  return (
    <Stack gap="md">
      <PageHeader
        title={shown.title}
        subtitle={translate(locale, 'nav.execution')}
        actions={
          <Row gap="xs" align="center" wrap>
            <MarkBadge label={markLabel(locale, mark)} tone={mark.tone} />
            <RelativeTime at={shown.at} format="short" muted />
            {back}
          </Row>
        }
      />
      {failure === '' ? null : (
        <Text tone="danger" size="xs">
          {failure}
        </Text>
      )}

      <KeyValue label={words(locale, 'execution.mandate')} items={mandateItems(locale, shown.mandate)} />

      <Section title={words(locale, 'execution.inputs')} count={shown.waitingInputs.length}>
        {shown.waitingInputs.length === 0 ? (
          <Hint text={words(locale, 'execution.noInputs')} />
        ) : (
          <List label={words(locale, 'execution.inputs')}>
            {shown.waitingInputs.map((input) => (
              <ListItem
                key={input.id}
                title={translate(locale, `execution.input.${input.kind}` as CopyKey)}
                description={input.text ?? input.triggerId ?? input.id}
              >
                <Row gap="xs" align="center" wrap>
                  {input.human === true ? (
                    <MarkBadge label={words(locale, 'execution.human')} tone="accent" />
                  ) : null}
                  <RelativeTime at={input.at} format="short" muted />
                </Row>
              </ListItem>
            ))}
          </List>
        )}
      </Section>

      <Section title={words(locale, 'execution.subscriptions')} count={shown.subscriptions.length}>
        {shown.subscriptions.length === 0 ? (
          <Hint text={words(locale, 'execution.noSubscriptions')} />
        ) : (
          <List label={words(locale, 'execution.subscriptions')}>
            {shown.subscriptions.map((subscription) => (
              <SubscriptionRow key={subscription.key} locale={locale} subscription={subscription} />
            ))}
          </List>
        )}
      </Section>

      <Collapsible
        title={`${words(locale, 'execution.assignments')} · ${shown.assignments.length}`}
        defaultOpen={false}
      >
        {shown.assignments.length === 0 ? (
          <Hint text={words(locale, 'execution.noAssignments')} />
        ) : (
          <List label={words(locale, 'execution.assignments')}>
            {shown.assignments.map((assignment) => (
              <ListItem
                key={assignment.id}
                title={translate(locale, `assignment.${assignment.state}` as CopyKey)}
                description={assignment.report?.summary ?? assignment.terminalId ?? assignment.id}
                icon="layers"
              >
                <Row gap="xs" align="center" wrap>
                  {assignment.terminalId === undefined ? null : (
                    <Text muted size="xs">
                      {assignment.terminalId}
                    </Text>
                  )}
                  <RelativeTime
                    at={assignment.startedAt ?? assignment.createdAt}
                    format="short"
                    muted
                  />
                </Row>
              </ListItem>
            ))}
          </List>
        )}
      </Collapsible>

      <Section title={words(locale, 'execution.reports')} count={shown.reports.length}>
        {shown.reports.length === 0 ? (
          <Hint text={words(locale, 'execution.noReports')} />
        ) : (
          <List label={words(locale, 'execution.reports')}>
            {shown.reports.map((report, index) => (
              <ListItem
                key={`${report.at}:${index}`}
                title={translate(locale, `report.${report.state}` as CopyKey)}
                description={report.summary}
                icon="download"
              >
                <Row gap="xs" align="center">
                  <MarkBadge
                    label={translate(locale, `report.${report.state}` as CopyKey)}
                    tone={reportMark(report.state).tone}
                  />
                  <RelativeTime at={report.at} format="short" muted />
                </Row>
              </ListItem>
            ))}
          </List>
        )}
      </Section>

      <Section title={words(locale, 'execution.attention')}>
        {shown.attention === undefined ? (
          <Hint text={words(locale, 'execution.noAttention')} />
        ) : (
          <Callout tone="warning" title={words(locale, 'execution.attention')} icon="info">
            <Stack gap="xs">
              <Text size="sm">{shown.attention.question}</Text>
              <Row gap="xs" align="center" wrap>
                <RelativeTime at={shown.attention.at} format="short" muted />
                {shown.attention.via === 'terminal' ? (
                  <Text muted size="xs">
                    {words(locale, 'attention.fromTerminal')}
                  </Text>
                ) : null}
              </Row>
              {terminal === undefined ? null : (
                <Stack gap="xs">
                  <Text muted size="xs">
                    {words(locale, 'execution.terminalPreview')}
                  </Text>
                  <CodeView
                    code={lines.slice(-TERMINAL_PREVIEW_LINES).join('\n')}
                    label={words(locale, 'execution.terminalPreview')}
                    wrap
                    maxHeight="sm"
                  />
                </Stack>
              )}
            </Stack>
          </Callout>
        )}
      </Section>

      <Section title={words(locale, 'execution.terminal')}>
        {terminal === undefined ? (
          <Hint text={words(locale, 'execution.noTerminal')} />
        ) : (
          <CodeView
            code={lines.join('\n')}
            label={words(locale, 'execution.terminal')}
            wrap
            maxHeight="md"
          />
        )}
      </Section>

      {shown.ended === undefined ? null : (
        <Section title={translate(locale, 'term.ended' as CopyKey)}>
          <Row gap="xs" align="center" wrap>
            <MarkBadge
              label={translate(locale, `outcome.${shown.ended.outcome}` as CopyKey)}
              tone="neutral"
            />
            <Text muted size="xs">
              {translate(locale, `endBy.${shown.ended.by}` as CopyKey)}
            </Text>
            <RelativeTime at={shown.ended.at} format="short" muted />
            {shown.ended.reason === undefined ? null : (
              <Text size="xs" muted>
                {shown.ended.reason}
              </Text>
            )}
          </Row>
        </Section>
      )}

      <Toolbar label={words(locale, 'execution.actions')}>
        {shown.canRetry ? (
          <Button
            variant="outline"
            size="sm"
            icon="refresh"
            disabled={busy}
            onPress={() => void retryTicket(shown.id)}
          >
            {words(locale, 'action.retry')}
          </Button>
        ) : null}
        {shown.ended === undefined ? (
          <ConfirmAction
            id={`stop:${shown.id}`}
            label={words(locale, 'action.stop')}
            action={words(locale, 'action.stop')}
            target={shown.title}
            locale={locale}
            icon="stop"
            onConfirm={() => void stopTicket(shown.id)}
          />
        ) : null}
        <Button
          variant="outline"
          size="sm"
          icon="info"
          disabled={busy}
          onPress={() => void requestTicketStatus(shown.id)}
        >
          {words(locale, 'execution.requestStatus')}
        </Button>
        {terminal === undefined ? null : (
          <Button
            variant="outline"
            size="sm"
            icon="play"
            onPress={() => void focusTerminal(terminal.terminalId)}
          >
            {words(locale, 'overview.openTerminal')}
          </Button>
        )}
        {shown.worktree === undefined ? null : (
          <Button
            variant="outline"
            size="sm"
            icon="folder"
            onPress={() => void openTicketWorktree(shown.id)}
          >
            {words(locale, 'execution.openWorktree')}
          </Button>
        )}
        {shown.worktree === undefined ? null : (
          <ConfirmAction
            id={`remove:${shown.id}`}
            label={words(locale, 'execution.removeWorktree')}
            action={words(locale, 'execution.removeWorktree')}
            target={shown.worktree.directory}
            locale={locale}
            icon="delete"
            onConfirm={() => void removeTicketWorktree(shown.id)}
          />
        )}
      </Toolbar>

      {asked === null ? null : (
        <Hint text={words(locale, asked ? 'execution.asked' : 'execution.notAsked')} />
      )}

      {shown.ended === undefined ? (
        <Stack gap="xs">
          <Field label={words(locale, 'execution.note')}>
            <Textarea
              label={words(locale, 'execution.note')}
              labelHidden
              value={draft}
              placeholder={words(locale, 'execution.notePlaceholder')}
              rows={2}
              onChange={(next) => set(noteDraft, next)}
            />
          </Field>
          <Row justify="end">
            <Button
              variant="outline"
              size="sm"
              icon="download"
              disabled={busy || draft.trim() === ''}
              onPress={() => void sendTicketNote(shown.id)}
            >
              {words(locale, 'execution.noteSend')}
            </Button>
          </Row>
        </Stack>
      ) : null}
    </Stack>
  )
}

/**
 * Execution 的列表（§M.2）：五档筛选 + 分页 50 条（§M.4 的 `Table`）。行、筛选与分页都由
 * worker 的读模型回答；点行打开详情。
 */
function ExecutionListPage(props: { readonly locale: string }): OrcaElement {
  const locale = props.locale
  const filter = read(executionFilter)
  const page = read(executionList)
  const loading = read(executionLoading)
  const failure = read(executionError)
  const items = page?.items ?? []
  const rows: TableRow[] = items.map((ticket) => ({
    key: ticket.id,
    cells: {
      ticket: ticket.title,
      stage: markLabel(locale, executionMark(ticket)),
      at: { type: 'relative', at: ticket.at, format: 'short' }
    }
  }))
  return (
    <Stack gap="md">
      <RadioGroup
        label={words(locale, 'execution.filters')}
        orientation="horizontal"
        value={filter}
        options={EXECUTION_FILTERS.map((value) => ({
          value,
          label: translate(locale, `execution.filter.${value}` as CopyKey)
        }))}
        onChange={(next) => {
          if (!isExecutionFilter(next) || next === filter) return
          set(executionFilter, next)
          set(executionList, null)
          void loadExecutionList()
        }}
      />
      {failure === '' ? null : (
        <Callout tone="danger" title={words(locale, 'state.errorTitle')} icon="error">
          <Stack gap="sm">
            <Text size="sm">{failure}</Text>
            <Row gap="xs">
              <Button variant="outline" size="sm" icon="refresh" onPress={() => void loadExecutionList()}>
                {words(locale, 'state.retry')}
              </Button>
            </Row>
          </Stack>
        </Callout>
      )}
      {page !== null && items.length === 0 && failure === '' ? (
        <EmptyStateBlock title={words(locale, 'execution.empty')} icon="layers" />
      ) : null}
      {page === null && failure !== '' ? null : (
        <Table
          label={translate(locale, 'nav.execution')}
          columns={[
            { key: 'ticket', label: words(locale, 'execution.columnTicket') },
            { key: 'stage', label: words(locale, 'execution.columnStage'), width: 'sm' },
            {
              key: 'at',
              label: words(locale, 'execution.columnUpdated'),
              align: 'end',
              width: 'xs',
              hideBelow: 'sm'
            }
          ]}
          rows={rows}
          loading={loading && page === null}
          hasMore={page !== null && page.nextOffset !== null}
          onRowAction={(row) => openTicketDetail(row.key)}
          onLoadMore={() => void loadExecutionList({ more: true })}
        />
      )}
    </Stack>
  )
}

/** Execution 页：`focus` 指向一张工单时是详情，否则是当前筛选的列表（§M.2）。 */
function ExecutionPage(props: { readonly locale: string }): OrcaElement {
  const focused = read(focus)
  return focused?.page === 'execution' ? (
    <TicketDetailPage locale={props.locale} ticketId={focused.id} />
  ) : (
    <ExecutionListPage locale={props.locale} />
  )
}

// ---------------------------------------------------------------------------
// Eval 页（§M.2）：列表（五列 + 待人工条数）、详情（原因 + 到 Thread/Ticket 的链接 + dismiss）
// ---------------------------------------------------------------------------

/**
 * Eval 列表：kind、reason、strength、policy version、at 五列，分页 50 条。上面的提示是
 * worker 的 §K.7 判定（24 h 内、最新、未 dismiss、Thread 不忙），不在面板里重算。
 */
function EvalListPage(props: { readonly locale: string }): OrcaElement {
  const locale = props.locale
  const page = read(decisionList)
  const loading = read(decisionLoading)
  const failure = read(decisionError)
  const items = page?.items ?? []
  const rows: TableRow[] = items.map((decision) => ({
    key: decision.id,
    cells: {
      kind: markLabel(locale, decisionMark(decision.kind)),
      reason: reasonsText(locale, decision.reasons),
      strength: translate(locale, `strength.${decision.strength}` as CopyKey),
      policyVersion: decision.policyVersion,
      at: { type: 'relative', at: decision.at, format: 'short' }
    }
  }))
  return (
    <Stack gap="md">
      {page !== null && page.unresolved > 0 ? (
        <Callout tone="warning" title={words(locale, 'eval.needsPerson')} icon="info">
          <Text size="sm">{translate(locale, 'eval.unresolved', { count: page.unresolved })}</Text>
        </Callout>
      ) : null}
      {failure === '' ? null : (
        <Callout tone="danger" title={words(locale, 'state.errorTitle')} icon="error">
          <Stack gap="sm">
            <Text size="sm">{failure}</Text>
            <Row gap="xs">
              <Button variant="outline" size="sm" icon="refresh" onPress={() => void loadDecisions()}>
                {words(locale, 'state.retry')}
              </Button>
            </Row>
          </Stack>
        </Callout>
      )}
      {page !== null && items.length === 0 && failure === '' ? (
        <EmptyStateBlock title={words(locale, 'eval.empty')} icon="check" />
      ) : null}
      {page === null && failure !== '' ? null : (
        <Table
          label={translate(locale, 'nav.eval')}
          columns={[
            { key: 'kind', label: words(locale, 'column.kind'), width: 'sm' },
            { key: 'reason', label: words(locale, 'column.reason') },
            {
              key: 'strength',
              label: words(locale, 'column.strength'),
              width: 'xs',
              hideBelow: 'sm'
            },
            {
              key: 'policyVersion',
              label: words(locale, 'column.policyVersion'),
              width: 'xs',
              hideBelow: 'md'
            },
            {
              key: 'at',
              label: words(locale, 'column.at'),
              align: 'end',
              width: 'xs',
              hideBelow: 'sm'
            }
          ]}
          rows={rows}
          loading={loading && page === null}
          hasMore={page !== null && page.nextOffset !== null}
          onRowAction={(row) => openDecisionDetail(row.key)}
          onLoadMore={() => void loadDecisions({ more: true })}
        />
      )}
    </Stack>
  )
}

/** 一条决定的字段（KeyValue）：种类、强度、policy version、Thread、可选的 Ticket 与触发。 */
function decisionItems(locale: string, decision: DecisionDetailView): readonly KeyValueItem[] {
  const items: KeyValueItem[] = [
    { label: words(locale, 'column.kind'), value: markLabel(locale, decisionMark(decision.kind)) },
    {
      label: words(locale, 'column.strength'),
      value: translate(locale, `strength.${decision.strength}` as CopyKey)
    },
    { label: translate(locale, 'term.policyVersion'), value: decision.policyVersion },
    { label: translate(locale, 'term.thread'), value: decision.thread.title, code: true }
  ]
  if (decision.ticket !== undefined) {
    items.push({ label: translate(locale, 'term.ticket'), value: decision.ticket.title })
  }
  items.push({
    label: translate(locale, 'term.trigger'),
    value:
      decision.triggerIds.length === 0 ? words(locale, 'state.empty') : decision.triggerIds.join(', '),
    ...(decision.triggerIds.length === 0 ? {} : { code: true })
  })
  return items
}

/**
 * 一条决定的详情（§M.2）：上下文（种类、强度、policy version、Thread/Ticket、触发）、原因列表、
 * 现在是否仍要人（§K.7 的四条件）与动作（打开 Thread/Ticket、只有 unavailable 才有的 dismiss）。
 */
function DecisionDetailPage(props: {
  readonly locale: string
  readonly decisionId: string
}): OrcaElement {
  const locale = props.locale
  const decision = read(decisionDetail)
  const failure = read(decisionDetailError)
  const busy = read(decisionActing)
  const actionFailure = read(actionError)
  const back = (
    <Button variant="ghost" size="sm" icon="next" onPress={backToEval}>
      {words(locale, 'action.back')}
    </Button>
  )
  const shown = decision !== null && decision.id === props.decisionId ? decision : null
  if (shown === null) {
    return (
      <Stack gap="md">
        <PageHeader title={translate(locale, 'nav.eval')} actions={back} />
        {failure === '' ? (
          <LoadingState label={words(locale, 'state.loading')} />
        ) : (
          <ErrorState
            title={words(locale, 'state.errorTitle')}
            reason={failure}
            locale={locale}
            onRetry={() => void loadDecisionDetail(props.decisionId)}
          />
        )}
      </Stack>
    )
  }
  const mark = decisionMark(shown.kind)
  return (
    <Stack gap="md">
      <PageHeader
        title={markLabel(locale, mark)}
        subtitle={translate(locale, 'term.decision')}
        actions={
          <Row gap="xs" align="center" wrap>
            <MarkBadge label={markLabel(locale, mark)} tone={mark.tone} />
            <RelativeTime at={shown.at} format="short" muted />
            {back}
          </Row>
        }
      />
      {failure === '' ? null : (
        <Text tone="danger" size="xs">
          {failure}
        </Text>
      )}
      {shown.unresolved ? (
        <Callout tone="warning" title={words(locale, 'eval.needsPerson')} icon="info">
          <Text size="sm">{words(locale, 'eval.needsPersonHint')}</Text>
        </Callout>
      ) : null}
      {shown.dismissed ? (
        <Callout tone="neutral" title={words(locale, 'eval.dismissed')} icon="check">
          <Text size="sm">{words(locale, 'eval.dismissedHint')}</Text>
        </Callout>
      ) : null}

      <KeyValue
        label={translate(locale, 'term.decision')}
        items={decisionItems(locale, shown)}
      />

      <Section title={translate(locale, 'column.reason')} count={shown.reasons.length}>
        {shown.reasons.length === 0 ? (
          <Hint text={words(locale, 'eval.noReasons')} />
        ) : (
          <List label={translate(locale, 'column.reason')}>
            {shown.reasons.map((reason, index) => (
              <ListItem
                key={`${reason.code}:${reason.triggerId ?? ''}:${index}`}
                title={reasonText(locale, reason)}
                icon="info"
              />
            ))}
          </List>
        )}
      </Section>

      <Toolbar label={words(locale, 'eval.actions')}>
        <Button
          variant="outline"
          size="sm"
          icon="next"
          onPress={() => openThread(shown.thread.key)}
        >
          {words(locale, 'eval.openThread')}
        </Button>
        {shown.ticket === undefined ? null : (
          <Button
            variant="outline"
            size="sm"
            icon="layers"
            onPress={() => openDecisionTicket(shown.ticket?.id ?? '')}
          >
            {words(locale, 'eval.openTicket')}
          </Button>
        )}
        {shown.canDismiss ? (
          <ConfirmAction
            id={`dismiss:${shown.id}`}
            label={words(locale, 'eval.dismiss')}
            action={words(locale, 'eval.dismiss')}
            target={shown.thread.title}
            locale={locale}
            icon="close"
            onConfirm={() => void dismissDecision(shown.id)}
          />
        ) : null}
      </Toolbar>

      {busy ? <Hint text={translate(locale, 'confirm.pending')} /> : null}
      {actionFailure === '' ? null : (
        <Text tone="danger" size="xs">
          {actionFailure}
        </Text>
      )}
    </Stack>
  )
}

/** Eval 页：`focus` 指向一条决定时是详情，否则是列表（§M.2）。 */
function EvalPage(props: { readonly locale: string }): OrcaElement {
  const focused = read(focus)
  return focused?.page === 'eval' ? (
    <DecisionDetailPage locale={props.locale} decisionId={focused.id} />
  ) : (
    <EvalListPage locale={props.locale} />
  )
}

/** 一页：Overview、Eval 与 Execution 有真实读数，Settings 现在是 Deployment 组；其余页面在页面票里填充。 */
function PageBody(props: { readonly locale: string; readonly current: NavPage }): OrcaElement {
  const locale = props.locale
  const state = read(snapshot)
  const stage = read(phase)
  if (props.current === 'settings') {
    // Settings 页的其余四组（Sources/Eval/Execution/Prompts）由 #42/#43 填进同一页；
    // 本票交付的是 Deployment 组，它自己管读取、错误态与动作。
    return <Deployment locale={locale} />
  }
  if (props.current === 'source') {
    // Source 页自己管读取、错误态与动作（一张卡的失败不把整页换成错误态）。
    return (
      <SourcePage
        locale={locale}
        onOpenSettings={() => openSettings()}
        onOpenTicket={(ticketId) => openTicket(ticketId)}
        onOpenThread={(threadKey) => openThread(threadKey)}
      />
    )
  }
  if (props.current === 'overview' || props.current === 'eval' || props.current === 'execution') {
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
    ) : props.current === 'execution' ? (
      <ExecutionPage locale={locale} />
    ) : (
      <EvalPage locale={locale} />
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
          // Deployment 组、Execution 列表与 Eval 列表打开时才读（隐藏与未打开的页面不发请求，§M.6）。
          if (next === 'settings') void openDeployment()
          if (next === 'execution') enterExecution()
          if (next === 'eval') enterEval()
          if (next === 'source') void openSources()
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

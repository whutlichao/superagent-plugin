// Search 页（§M.1 的第 7 项、§M.2 的 Search 行）：一个搜索框 + 三组结果（Triggers / Threads /
// Tickets）。查询原文交给 worker 的 `search` 请求——`#12`、Issue/PR 与评论链接、Feishu 消息
// id、普通文字都在 worker 的 `find`/搜索处理里解释，面板不自己猜、也不重写查询。
//
// 点结果跳到拥有它的详情页：Trigger 与 Thread 去 Trigger 页的那条 Thread，Ticket 去 Execution
// 页的那一张工单。跳转由面板壳给（`onOpenThread` / `onOpenTicket`），页面只报告「点了谁」。
//
// 三态：还没搜过是一句提示；查询中给结果骨架；没有命中是 `No matches`（不是错误）；读不到
// 给原因与重试。面板不轮询——只有提交查询时才发请求，且只采纳最后一次查询的答案。
//
// 本文件只管「怎么读、怎么画」：分组与命中是 worker 的读模型，面板不 import worker（§C.2 规则 3）。
import {
  atom,
  Button,
  Input,
  List,
  ListItem,
  plugin,
  read,
  RelativeTime,
  Row,
  set,
  Stack,
  type OrcaElement
} from 'orca'
import { translate, type CopyKey } from './copy'
import { executionRow } from './execution'
import type { PanelSearchThread, PanelSearchTrigger, SearchPageView } from './protocol'
import { TicketRow } from './rows'
import { EmptyStateBlock, ErrorState, Hint, LoadingState, Section, word } from './widgets'

/** 搜索框里正在打的内容（还没提交）。 */
const draft = atom('')

/** 上一次提交的查询（重试时原样再发一次，不重新读输入框）。 */
const submitted = atom('')

/** 最近一份搜索结果；`null` 表示还没读到（或正在读）。 */
const page = atom<SearchPageView | null>(null)

/** 读取阶段：`idle` 还没搜过 / `loading` 正在问 / `ready` 有结果 / `error` 读不到。 */
type Phase = 'idle' | 'loading' | 'ready' | 'error'
const phase = atom<Phase>('idle')

/** 读不到时的原因（错误态要给出原因）。 */
const reason = atom('')

/** 这一页是否还在面板上：晚到的响应不再改状态。 */
let active = false

/** 查询的代号：只有最后一次查询的答案落地（连着提交两次时旧答案不能盖新的）。 */
let loadRequest = 0

/** 错误对象的可读原因（`HostError.message`；没有就 String）。 */
function reasonOf(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : String(error)
}

/** 打开这一页：只记下「在面板上」，不读数据（Search 只在人提交查询时读，§M.6）。 */
export function openSearch(): void {
  active = true
}

/** 面板卸载或重新挂载时清掉上一次的查询、结果与错误。 */
export function resetSearch(): void {
  active = false
  loadRequest += 1
  set(draft, '')
  set(submitted, '')
  set(page, null)
  set(phase, 'idle')
  set(reason, '')
}

/**
 * 提交一次查询（输入框的 Enter 与「搜索」按钮都走它）。空查询什么都不做——不发一个注定被
 * 拒绝的请求；查询原文原样交给 worker，面板不解释 `#12` 或链接。
 */
async function runSearch(query: string): Promise<void> {
  const trimmed = query.trim()
  if (trimmed.length === 0) return
  const request = ++loadRequest
  set(submitted, trimmed)
  set(draft, trimmed)
  // 旧结果不能挂在新查询下面（会像是这次查到的）：先清掉，再画骨架。
  set(page, null)
  set(phase, 'loading')
  set(reason, '')
  try {
    const next = await plugin.request('search', { query: trimmed })
    if (!active || request !== loadRequest) return
    set(page, next)
    set(phase, 'ready')
  } catch (error) {
    if (!active || request !== loadRequest) return
    set(reason, reasonOf(error))
    set(phase, 'error')
  }
}

/** 一条命中的 Trigger：原话预览、来源者与时刻；点它去所属 Thread。 */
function TriggerRows(props: {
  readonly locale: string
  readonly items: readonly PanelSearchTrigger[]
  readonly onOpenThread: (threadKey: string) => void
}): OrcaElement {
  const locale = props.locale
  return (
    <List label={word(locale, 'search.group.triggers')}>
      {props.items.map((hit) => {
        const thread = hit.thread
        const from = translate(locale, 'search.triggerFrom', { actor: hit.from })
        return (
          <ListItem
            key={hit.id}
            title={hit.text}
            description={`${from} · ${hit.source}`}
            icon="activity"
            {...(thread === undefined ? {} : { onPress: () => props.onOpenThread(thread) })}
          >
            <Row gap="xs" align="center" wrap>
              <RelativeTime at={hit.at} format="short" muted />
            </Row>
          </ListItem>
        )
      })}
    </List>
  )
}

/** 一条命中的 Thread：标题、来源与最近一条触发的时刻。 */
function ThreadRows(props: {
  readonly locale: string
  readonly items: readonly PanelSearchThread[]
  readonly onOpenThread: (threadKey: string) => void
}): OrcaElement {
  const locale = props.locale
  const source = translate(locale, 'term.source' as CopyKey)
  return (
    <List label={word(locale, 'search.group.threads')}>
      {props.items.map((hit) => (
        <ListItem
          key={hit.key}
          title={hit.title}
          description={`${source} · ${hit.source}`}
          icon="layers"
          onPress={() => props.onOpenThread(hit.key)}
        >
          {hit.lastAt === undefined ? null : <RelativeTime at={hit.lastAt} format="short" muted />}
        </ListItem>
      ))}
    </List>
  )
}

/** 一组结果：标题 + 条数 + 内容；被截断时如实说只给了前几条。 */
function Group(props: {
  readonly title: string
  readonly count: number
  readonly truncated: boolean
  readonly locale: string
  readonly children: OrcaElement
}): OrcaElement {
  return (
    <Section title={props.title} count={props.count}>
      <Stack gap="xs">
        {props.children}
        {props.truncated ? (
          <Hint text={translate(props.locale, 'search.truncated', { count: props.count })} />
        ) : null}
      </Stack>
    </Section>
  )
}

/** Search 页：输入框 + 三组结果 + 三态。 */
export function SearchPage(props: {
  readonly locale: string
  readonly onOpenThread: (threadKey: string) => void
  readonly onOpenTicket: (ticketId: string) => void
}): OrcaElement {
  const locale = props.locale
  const view = read(page)
  const failure = read(reason)
  const loading = read(phase) === 'loading'
  const hits =
    view === null
      ? 0
      : view.triggers.items.length + view.threads.items.length + view.tickets.items.length
  return (
    <Stack gap="md">
      <Row gap="xs" align="end" wrap>
        <Input
          label={word(locale, 'search.label')}
          labelHidden
          type="search"
          value={read(draft)}
          placeholder={word(locale, 'search.placeholder')}
          onChange={(value) => set(draft, value)}
          onSubmit={(value) => void runSearch(value)}
        />
        <Button
          variant="solid"
          size="sm"
          icon="search"
          disabled={read(draft).trim().length === 0}
          onPress={() => void runSearch(read(draft))}
        >
          {word(locale, 'search.submit')}
        </Button>
      </Row>
      <Hint text={word(locale, 'search.idle')} />

      {failure === '' ? null : (
        <ErrorState
          title={word(locale, 'state.errorTitle')}
          reason={failure}
          locale={locale}
          onRetry={() => void runSearch(read(submitted))}
        />
      )}
      {loading && view === null ? <LoadingState label={word(locale, 'search.searching')} /> : null}
      {view !== null && hits === 0 ? (
        // 没有命中时点名查询词，并给一步出口（清除搜索回到空态提示）。
        <EmptyStateBlock
          title={translate(locale, 'search.noMatchesQuery', { query: view.query })}
          icon="search"
          action={
            <Row gap="xs">
              <Button
                variant="outline"
                size="sm"
                onPress={() => {
                  set(draft, '')
                  set(submitted, '')
                  set(page, null)
                  set(phase, 'idle')
                  set(reason, '')
                }}
              >
                {word(locale, 'search.clear')}
              </Button>
            </Row>
          }
        />
      ) : null}

      {view !== null && hits > 0 ? (
        <Stack gap="lg">
          <Hint text={translate(locale, 'search.terms', { terms: view.terms.join(', ') })} />
          {view.triggers.items.length === 0 ? null : (
            <Group
              title={word(locale, 'search.group.triggers')}
              count={view.triggers.items.length}
              truncated={view.triggers.truncated}
              locale={locale}
            >
              <TriggerRows
                locale={locale}
                items={view.triggers.items}
                onOpenThread={props.onOpenThread}
              />
            </Group>
          )}
          {view.threads.items.length === 0 ? null : (
            <Group
              title={word(locale, 'search.group.threads')}
              count={view.threads.items.length}
              truncated={view.threads.truncated}
              locale={locale}
            >
              <ThreadRows
                locale={locale}
                items={view.threads.items}
                onOpenThread={props.onOpenThread}
              />
            </Group>
          )}
          {view.tickets.items.length === 0 ? null : (
            <Group
              title={word(locale, 'search.group.tickets')}
              count={view.tickets.items.length}
              truncated={view.tickets.truncated}
              locale={locale}
            >
              <List label={word(locale, 'search.group.tickets')}>
                {view.tickets.items.map((ticket) => (
                  <TicketRow
                    key={ticket.id}
                    locale={locale}
                    ticket={{
                      ...executionRow(ticket),
                      onOpen: () => props.onOpenTicket(ticket.id)
                    }}
                  />
                ))}
              </List>
            </Group>
          )}
        </Stack>
      ) : null}
    </Stack>
  )
}

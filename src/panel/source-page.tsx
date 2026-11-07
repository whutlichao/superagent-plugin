// Source 页（§M.2 的 Source 行、§I.1 kind 的字段与事实、§I.2/I.3 的过滤、§J.1 的 drop）。
//
// 每个配置过的 Source 一张卡：开关、只读的配置字段、部署派生的 facts、health 条目、24 小时
// 计数、被过滤的 Trigger（带原因码）、被 drop 的消息（带原因与链接），以及只属于它的 setup
// 问题（内联；不归属任何 Source 的问题在页首，一张卡的问题绝不遮住另一张卡）。
//
// 动作：打开/关闭、立即同步（§I.3 的允许名单纯）、检查一次（§G.2 的 `setup check`）、
// 刷新显示名（§G.2 的 `source labels`）。动作的反馈留在它自己的卡上；一个 Source 刷新失败
// 不会把整页换成错误态。
//
// 数据走面板协议（`protocol.ts` 的 `sources` 与 `source.*`）：页面打开时读一次，之后由
// worker 的 `state.changed` 推送触发重读——面板不轮询、不自带时钟（时间交给 `RelativeTime`）。
//
// 本文件只管「怎么读、怎么画」：卡片的内容由 worker 的 `app/views/sources.ts` 拼好，面板不
// import worker（§C.2 规则 3）。
import {
  atom,
  Badge,
  Button,
  Callout,
  Card,
  Code,
  KeyValue,
  List,
  ListItem,
  plugin,
  read,
  RelativeTime,
  Row,
  set,
  Stack,
  Switch,
  Text,
  type KeyValueItem,
  type OrcaElement
} from 'orca'
import { translate } from './copy'
import { SetupProblemRow } from './deployment'
import { reasonText } from './eval'
import { healthMark, markLabel, sourceMark } from './marks'
import type {
  PanelDroppedMessage,
  PanelFilteredTrigger,
  PanelSource,
  PanelSourceField,
  SourcePageView
} from './protocol'
import { dropReasonText, fieldValueText, localizedText, rowText } from './source-text'
import { EmptyStateBlock, ErrorState, Hint, LoadingState, MarkBadge, Section, word } from './widgets'

/** 最近一份 Source 页读数；`null` 表示还没读到。 */
const page = atom<SourcePageView | null>(null)

/** 读取阶段：`idle` 还没问 / `loading` 正在问 / `ready` 有读数 / `error` 读不到。 */
type Phase = 'idle' | 'loading' | 'ready' | 'error'
const phase = atom<Phase>('idle')

/** 读不到时的原因（错误态要给出原因）。 */
const reason = atom('')

/** 一个 Source 上的动作正在跑；同一时刻只标那一张卡。 */
type ActionName = 'toggle' | 'sync' | 'labels'

/** 一次动作的结果：`note` 是成功要说的一句话（按语言在渲染时取词），`error` 是失败原因。 */
type Note = { readonly kind: 'synced'; readonly count: number } | { readonly kind: 'labels'; readonly added: number; readonly total: number }

/** 每张卡自己的动作状态：一个 Source 的失败只留在它的卡上。 */
interface ActionState {
  readonly busy?: ActionName
  readonly error?: string
  readonly note?: Note
}
const actions = atom<Readonly<Record<string, ActionState>>>({})

/** 「检查一次」是否在跑（页面级动作，破坏性不涉及写入，不改变处理状态）。 */
const checking = atom(false)

/** 「检查一次」的结论：重跑过、或本来就没有可重跑的问题。 */
const checkNote = atom<'' | 'checked' | 'nothing'>('')

/** 「检查一次」失败的原因（不替换整页）。 */
const checkError = atom('')

/** 这一页是否还在面板上：晚到的响应不再改状态。 */
let active = false

/** 列表请求的代号：只有最后一次请求的答案落地（同一事件里连着 `set` 时读到的是上一批）。 */
let loadRequest = 0

/** 错误对象的可读原因（`HostError.message`；没有就 String）。 */
function reasonOf(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : String(error)
}

/** 一张卡的动作状态换成新的（其余卡原样保留）。 */
function setCard(sourceId: string, next: ActionState): void {
  set(actions, { ...read(actions), [sourceId]: next })
}

/** 读一份 Source 页。失败给出原因；成功清掉原因。重读时保留上一份读数，不把整页闪成骨架。 */
export async function loadSources(): Promise<void> {
  if (!active) return
  const request = ++loadRequest
  if (read(page) === null) set(phase, 'loading')
  try {
    const next = await plugin.request('sources')
    if (!active || request !== loadRequest) return
    set(page, next)
    set(phase, 'ready')
    set(reason, '')
  } catch (error) {
    if (!active || request !== loadRequest) return
    set(reason, reasonOf(error))
    set(phase, 'error')
  }
}

/** 打开这一页：读一次（由面板的导航与 setup 调用——渲染里不发请求）。 */
export async function openSources(): Promise<void> {
  active = true
  await loadSources()
}

/** 卸载面板时调用：之后的响应不再写状态，上一份读数也不带给下一次挂载。 */
export function resetSources(): void {
  active = false
  loadRequest += 1
  set(page, null)
  set(phase, 'idle')
  set(reason, '')
  set(actions, {})
  set(checking, false)
  set(checkNote, '')
  set(checkError, '')
}

/** 打开/关闭一个 Source（§M.2 的主操作）：返回的是写后的读数，不必再问一次。 */
async function toggleSource(sourceId: string, enabled: boolean): Promise<void> {
  setCard(sourceId, { busy: 'toggle' })
  try {
    const next = await plugin.request('source.setEnabled', { sourceId, enabled })
    if (!active) return
    set(page, next)
    set(phase, 'ready')
    set(reason, '')
    setCard(sourceId, {})
  } catch (error) {
    if (active) setCard(sourceId, { error: reasonOf(error) })
  }
}

/** 「立即同步」：允许名单重读（§I.3），成功后重读卡片（`sync:<id>` 的健康也变了）。 */
async function syncSource(sourceId: string): Promise<void> {
  setCard(sourceId, { busy: 'sync' })
  try {
    const outcome = await plugin.request('source.sync', { sourceId })
    if (!active) return
    setCard(sourceId, { note: { kind: 'synced', count: outcome.allowed } })
    await loadSources()
  } catch (error) {
    if (active) setCard(sourceId, { error: reasonOf(error) })
  }
}

/** 「刷新显示名」（§G.2 的 `source labels`）：只改行键的显示名，不动配置。 */
async function refreshLabels(sourceId: string): Promise<void> {
  setCard(sourceId, { busy: 'labels' })
  try {
    const outcome = await plugin.request('source.labels', { sourceId })
    if (!active) return
    setCard(sourceId, { note: { kind: 'labels', added: outcome.added, total: outcome.total } })
  } catch (error) {
    if (active) setCard(sourceId, { error: reasonOf(error) })
  }
}

/** 「检查一次」（§G.2 的 `setup check`）：重跑探针，再读一次卡片。 */
async function checkAgain(): Promise<void> {
  set(checking, true)
  set(checkError, '')
  set(checkNote, '')
  try {
    const outcome = await plugin.request('setupCheck')
    if (!active) return
    set(checkNote, outcome.checked ? 'checked' : 'nothing')
    await loadSources()
  } catch (error) {
    if (active) set(checkError, reasonOf(error))
  } finally {
    if (active) set(checking, false)
  }
}

/** 一张卡上的一次动作结果（成功一句话或失败原因；按语言在渲染时取词）。 */
function ActionFeedback(props: { readonly locale: string; readonly state: ActionState | undefined }): OrcaElement | null {
  const state = props.state
  if (state === undefined) return null
  if (state.error !== undefined) {
    return (
      <Text tone="danger" size="xs">
        {translate(props.locale, 'source.actionFailed', { reason: state.error })}
      </Text>
    )
  }
  if (state.note === undefined) return null
  const text =
    state.note.kind === 'synced'
      ? translate(props.locale, 'source.synced', { count: state.note.count })
      : translate(props.locale, 'source.labelsRefreshed', {
          added: state.note.added,
          total: state.note.total
        })
  return (
    <Text size="xs" tone="success">
      {text}
    </Text>
  )
}

/** 标量字段（text / flag / choice）走 `KeyValue`；`rows` 字段逐行画（一行一条记录）。 */
function Configuration(props: { readonly locale: string; readonly source: PanelSource }): OrcaElement | null {
  const locale = props.locale
  const fields = props.source.fields
  if (fields.length === 0) return null
  const scalar: KeyValueItem[] = fields
    .filter((field) => field.value.type !== 'rows')
    .map((field) => ({
      label: localizedText(locale, field.label),
      value: fieldValueText(locale, field.value)
    }))
  const rows = fields.filter(
    (field): field is PanelSourceField & { readonly value: Extract<PanelSourceField['value'], { type: 'rows' }> } =>
      field.value.type === 'rows'
  )
  return (
    <Section title={translate(locale, 'source.fields')}>
      <Stack gap="sm">
        {scalar.length === 0 ? null : <KeyValue items={scalar} />}
        {rows.map((field) => (
          <Stack key={field.key} gap="none">
            <Text muted size="xs">
              {localizedText(locale, field.label)}
            </Text>
            {field.value.rows.length === 0 ? (
              <Text size="sm">{translate(locale, 'deployment.empty')}</Text>
            ) : (
              field.value.rows.map((item, index) => (
                <Text key={`${field.key}:${index}`} size="sm">
                  {rowText(locale, item)}
                </Text>
              ))
            )}
          </Stack>
        ))}
      </Stack>
    </Section>
  )
}

/** setup 派生的事实（账号、仓库）：只读，值来自部署而不是配置。 */
function Facts(props: { readonly locale: string; readonly source: PanelSource }): OrcaElement | null {
  if (props.source.facts.length === 0) return null
  return (
    <Section title={translate(props.locale, 'source.facts')}>
      <KeyValue
        items={props.source.facts.map((fact) => ({
          label: localizedText(props.locale, fact.label),
          value: localizedText(props.locale, fact.value),
          code: true
        }))}
      />
    </Section>
  )
}

/** 这个 Source 声明的 health 条目：名字、四档状态与明细（带计数）。 */
function HealthEntries(props: { readonly locale: string; readonly source: PanelSource }): OrcaElement | null {
  if (props.source.health.length === 0) return null
  return (
    <Section title={translate(props.locale, 'source.health')} count={props.source.health.length}>
      <Stack gap="xs">
        {props.source.health.map((entry) => {
          const mark = healthMark(entry.state)
          return (
            <Row key={entry.name} gap="xs" align="center" wrap>
              <Code>{entry.name}</Code>
              <MarkBadge label={markLabel(props.locale, mark)} tone={mark.tone} />
              <Text muted size="xs">
                {entry.detail ?? translate(props.locale, 'state.empty')}
              </Text>
            </Row>
          )
        })}
      </Stack>
    </Section>
  )
}

/** 24 小时计数（§M.1：只画非零计数）：收到的、被过滤的与最近一条的时刻。 */
function Stats(props: { readonly locale: string; readonly source: PanelSource }): OrcaElement | null {
  const locale = props.locale
  const stats = props.source.stats
  if (stats.received === 0 && stats.filtered === 0 && stats.lastAt === undefined) return null
  return (
    <Row gap="md" align="center" wrap>
      {stats.received === 0 ? null : (
        <Text size="xs">{translate(locale, 'source.received', { count: stats.received })}</Text>
      )}
      {stats.filtered === 0 ? null : (
        <Text size="xs">{translate(locale, 'source.filtered', { count: stats.filtered })}</Text>
      )}
      {stats.lastAt === undefined ? null : (
        <Row gap="xs" align="center">
          <Text muted size="xs">
            {translate(locale, 'source.latest')}
          </Text>
          <RelativeTime at={stats.lastAt} format="short" muted />
        </Row>
      )}
    </Row>
  )
}

/** 被过滤的 Trigger（§I.1 的原因码）：原因原样显示，Thread 可点开。 */
function FilteredList(props: {
  readonly locale: string
  readonly source: PanelSource
  readonly onOpenThread: (threadKey: string) => void
}): OrcaElement | null {
  const locale = props.locale
  const filtered = props.source.filtered
  if (filtered.total === 0) return null
  return (
    <Section title={translate(locale, 'source.filteredTitle')} count={filtered.total}>
      <Stack gap="xs">
        <Hint text={translate(locale, 'source.filteredHint')} />
        <List label={translate(locale, 'source.filteredTitle')}>
          {filtered.items.map((item) => (
            <FilteredRow
              key={item.id}
              locale={locale}
              item={item}
              onOpenThread={props.onOpenThread}
            />
          ))}
        </List>
        {filtered.total > filtered.items.length ? (
          <Hint
            text={translate(locale, 'source.showingLatest', {
              shown: filtered.items.length,
              total: filtered.total
            })}
          />
        ) : null}
      </Stack>
    </Section>
  )
}

/** 一条被过滤的 Trigger：发送者与一句话正文，原因码、时刻与它所属的 Thread。 */
function FilteredRow(props: {
  readonly locale: string
  readonly item: PanelFilteredTrigger
  readonly onOpenThread: (threadKey: string) => void
}): OrcaElement {
  const locale = props.locale
  const item = props.item
  return (
    <ListItem
      title={item.actor === '' ? translate(locale, 'state.empty') : item.actor}
      {...(item.text === undefined ? {} : { description: item.text })}
    >
      <Row gap="xs" align="center" wrap>
        <Badge tone="neutral">{reasonText(locale, { code: item.code })}</Badge>
        <RelativeTime at={item.at} format="short" muted />
        {item.threadKey === undefined ? null : (
          <Button
            variant="ghost"
            size="sm"
            onPress={() => props.onOpenThread(item.threadKey as string)}
          >
            {translate(locale, 'term.thread')}
          </Button>
        )}
      </Row>
    </ListItem>
  )
}

/** 被 drop 的消息（§J.1）：原因、时刻，以及它所属的 Ticket（更准）或 Thread。 */
function DroppedList(props: {
  readonly locale: string
  readonly source: PanelSource
  readonly onOpenTicket: (ticketId: string) => void
  readonly onOpenThread: (threadKey: string) => void
}): OrcaElement | null {
  const locale = props.locale
  const dropped = props.source.dropped
  if (dropped.total === 0) return null
  return (
    <Section title={translate(locale, 'source.droppedTitle')} count={dropped.total}>
      <Stack gap="xs">
        <Hint text={translate(locale, 'source.droppedHint')} />
        <List label={translate(locale, 'source.droppedTitle')}>
          {dropped.items.map((item) => (
            <DroppedRow
              key={item.id}
              locale={locale}
              item={item}
              onOpenTicket={props.onOpenTicket}
              onOpenThread={props.onOpenThread}
            />
          ))}
        </List>
        {dropped.total > dropped.items.length ? (
          <Hint
            text={translate(locale, 'source.showingLatest', {
              shown: dropped.items.length,
              total: dropped.total
            })}
          />
        ) : null}
      </Stack>
    </Section>
  )
}

/** 一条被 drop 的消息：预览、原因、时刻，以及到 Ticket 或 Thread 的链接。 */
function DroppedRow(props: {
  readonly locale: string
  readonly item: PanelDroppedMessage
  readonly onOpenTicket: (ticketId: string) => void
  readonly onOpenThread: (threadKey: string) => void
}): OrcaElement {
  const locale = props.locale
  const item = props.item
  const ticket = item.ticket
  const thread = item.thread
  return (
    <ListItem
      title={item.text ?? dropReasonText(locale, item.reason)}
      description={dropReasonText(locale, item.reason)}
    >
      <Row gap="xs" align="center" wrap>
        <RelativeTime at={item.at} format="short" muted />
        {ticket === undefined ? null : (
          <Button variant="ghost" size="sm" onPress={() => props.onOpenTicket(ticket.id)}>
            {ticket.title}
          </Button>
        )}
        {ticket === undefined && thread !== undefined ? (
          <Button variant="ghost" size="sm" onPress={() => props.onOpenThread(thread.key)}>
            {thread.title}
          </Button>
        ) : null}
      </Row>
    </ListItem>
  )
}

/** 一张 Source 卡：标题、状态、开关、内联问题、配置、事实、健康、计数、两个列表与动作。 */
function SourceCard(props: {
  readonly locale: string
  readonly source: PanelSource
  readonly action: ActionState | undefined
  readonly onOpenTicket: (ticketId: string) => void
  readonly onOpenThread: (threadKey: string) => void
}): OrcaElement {
  const locale = props.locale
  const source = props.source
  const mark = sourceMark(source.state)
  const name = localizedText(locale, source.title)
  const busy = props.action?.busy
  return (
    <Card
      title={name}
      {...(source.description === undefined
        ? {}
        : { description: localizedText(locale, source.description) })}
    >
      <Stack gap="sm">
        <Row gap="sm" align="center" wrap>
          <MarkBadge label={markLabel(locale, mark)} tone={mark.tone} />
          {source.installed ? (
            <Switch
              label={translate(locale, 'source.enable', { name })}
              checked={source.enabled}
              disabled={busy === 'toggle'}
              onChange={(checked) => void toggleSource(source.id, checked)}
            />
          ) : null}
        </Row>
        {source.installed ? null : <Hint text={translate(locale, 'source.notInstalled')} />}
        {source.configError === undefined ? null : (
          <Callout
            tone="danger"
            icon="error"
            title={translate(locale, 'source.configInvalid', { detail: source.configError })}
          />
        )}
        {source.problem === undefined ? null : (
          <SetupProblemRow locale={locale} issue={source.problem} />
        )}
        <Stats locale={locale} source={source} />
        <Configuration locale={locale} source={source} />
        <Facts locale={locale} source={source} />
        <HealthEntries locale={locale} source={source} />
        <FilteredList locale={locale} source={source} onOpenThread={props.onOpenThread} />
        <DroppedList
          locale={locale}
          source={source}
          onOpenTicket={props.onOpenTicket}
          onOpenThread={props.onOpenThread}
        />
        {source.canSync || source.canRefreshLabels ? (
          <Row gap="xs" wrap>
            {source.canSync ? (
              <Button
                variant="outline"
                size="sm"
                icon="refresh"
                disabled={busy !== undefined}
                onPress={() => void syncSource(source.id)}
              >
                {busy === 'sync'
                  ? translate(locale, 'source.syncing')
                  : translate(locale, 'source.sync')}
              </Button>
            ) : null}
            {source.canRefreshLabels ? (
              <Button
                variant="outline"
                size="sm"
                icon="refresh"
                disabled={busy !== undefined}
                onPress={() => void refreshLabels(source.id)}
              >
                {busy === 'labels'
                  ? translate(locale, 'source.refreshingLabels')
                  : translate(locale, 'source.refreshLabels')}
              </Button>
            ) : null}
          </Row>
        ) : null}
        <ActionFeedback locale={locale} state={props.action} />
      </Stack>
    </Card>
  )
}

/** Source 页：页首「检查一次」，之后每个 Source 一张卡；空态指向 Settings。 */
export function SourcePage(props: {
  readonly locale: string
  readonly onOpenSettings: () => void
  readonly onOpenTicket: (ticketId: string) => void
  readonly onOpenThread: (threadKey: string) => void
}): OrcaElement {
  const locale = props.locale
  const view = read(page)
  const stage = read(phase)
  if (stage === 'error' && view === null) {
    return (
      <ErrorState
        title={translate(locale, 'boot.unavailable')}
        reason={read(reason)}
        locale={locale}
        onRetry={() => void openSources()}
      />
    )
  }
  if (view === null) {
    return stage === 'loading' ? (
      <LoadingState label={translate(locale, 'state.loading')} />
    ) : (
      <LoadingState label={word(locale, 'boot.starting')} />
    )
  }
  const note = read(checkNote)
  return (
    <Stack gap="md">
      <Row justify="between" align="start" gap="sm">
        <Hint text={translate(locale, 'source.intro')} />
        <Button
          variant="outline"
          size="sm"
          icon="refresh"
          disabled={read(checking)}
          onPress={() => void checkAgain()}
        >
          {read(checking)
            ? translate(locale, 'deployment.checking')
            : translate(locale, 'deployment.checkAgain')}
        </Button>
      </Row>
      {note === '' ? null : (
        <Hint
          text={
            note === 'checked'
              ? translate(locale, 'source.checkedAgain')
              : translate(locale, 'deployment.nothingToCheck')
          }
        />
      )}
      {read(checkError) === '' ? null : (
        <Text tone="danger" size="xs">
          {read(checkError)}
        </Text>
      )}
      {stage === 'error' ? (
        <Callout tone="danger" icon="error" title={translate(locale, 'state.errorTitle')}>
          <Stack gap="sm">
            <Text size="sm">{translate(locale, 'state.errorHint', { reason: read(reason) })}</Text>
            <Row gap="xs">
              <Button variant="outline" size="sm" icon="refresh" onPress={() => void loadSources()}>
                {translate(locale, 'state.retry')}
              </Button>
            </Row>
          </Stack>
        </Callout>
      ) : null}
      {view.elsewhere.map((issue) => (
        <SetupProblemRow key={`${issue.place}:${issue.code}`} locale={locale} issue={issue} />
      ))}
      {view.items.length === 0 ? (
        <EmptyStateBlock
          title={translate(locale, 'source.empty')}
          description={translate(locale, 'source.emptyHint')}
          icon="bot"
          action={
            <Row gap="xs">
              <Button variant="outline" size="sm" onPress={props.onOpenSettings}>
                {translate(locale, 'setup.openSettings')}
              </Button>
            </Row>
          }
        />
      ) : (
        view.items.map((source) => (
          <SourceCard
            key={source.id}
            locale={locale}
            source={source}
            action={read(actions)[source.id]}
            onOpenTicket={props.onOpenTicket}
            onOpenThread={props.onOpenThread}
          />
        ))
      )}
    </Stack>
  )
}

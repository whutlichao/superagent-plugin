// Settings 页（§M.3）：五个组的框架 + Sources / Eval / Execution 的完整实现 + Deployment 组的
// 机器限额编辑。每组一个保存栏：草稿为空时不占空间；有改动显示「N changes · Save / Discard」；
// 保存中显示进度；失败显示字段级 issues；冲突（409）问「这一段在别处被改过，要重新载入吗」。
//
// 分工：
// - 读面只来自 `plugin.request('settings.read' / 'settings.history')`（worker 侧 `app/settings-view.ts`；
//   Prompts 组读它自己的 `prompts`，本文件不代读）；
// - 写面只有一条：`plugin.request('settings.save')`，worker 里走与 HTTP/CLI 同一个
//   `PUT settings/:block` handler（来源恒为 panel，账号类字段先跑 #44 的探针）；
// - 草稿状态机在 `draft.ts`（纯的），本文件只把组、块与控件接起来；
// - Prompts 组的内容归 #43，在 `prompts.tsx`：本文件是唯一的组表，把那个组件注册成
//   `SETTINGS_GROUP_BODIES.prompts`（组框架、保存栏语义与顺序都不用改）。
import {
  atom,
  Button,
  Callout,
  Code,
  env,
  Field,
  IconButton,
  Input,
  plugin,
  RadioGroup,
  read,
  RelativeTime,
  Row,
  Select,
  set,
  Spinner,
  Stack,
  Switch,
  Tab,
  Tabs,
  Text,
  Textarea,
  update,
  type OrcaElement,
  type SelectOption
} from 'orca'
import { translate, type CopyKey } from './copy'
import {
  changedLeafCount,
  draftReducer,
  groupSaveBar,
  initialDraft,
  type DraftNotice,
  type DraftState,
  type SaveBar
} from './draft'
import { Deployment, openDeployment, resetDeployment } from './deployment'
import { openPrompts, Prompts, resetPrompts } from './prompts.tsx'
import { markLabel, sourceMark } from './marks'
import type {
  AdmissionRowView,
  EvalGroupView,
  ExecutionGroupView,
  LimitsGroupView,
  SettingsFact,
  SettingsField,
  SettingsFieldColumn,
  SettingsGroupId,
  SettingsHistoryRow,
  SettingsHistoryView,
  SettingsPageView,
  SettingsSaveOutcome,
  SettingsText,
  SourcePolicyView,
  SourceSettingsCard
} from './protocol'
import { SETTINGS_GROUPS } from './protocol'
import { ErrorState, Hint, LoadingState, MarkBadge, Section } from './widgets'

// ---------------------------------------------------------------------------
// 状态（模块级 atom；面板重挂载时由 `resetSettings` 清掉）
// ---------------------------------------------------------------------------

/** 最近一份设置读数；`null` 表示还没读到。 */
const view = atom<SettingsPageView | null>(null)

/** 读取阶段：`idle` 还没问 / `loading` 正在问 / `ready` / `error`。 */
type Phase = 'idle' | 'loading' | 'ready' | 'error'
const phase = atom<Phase>('idle')
const reason = atom('')

/** 当前打开的组（§M.3 的顺序，写进插件存储，重开面板还停在那一组）。 */
const group = atom<SettingsGroupId>('settings.group', 'sources', { persist: 'storage' })

/** 每个设置块一份草稿（`source:<id>` 各自一份；Policy / executor / limits 各一份）。 */
const drafts = atom<Readonly<Record<string, DraftState<unknown>>>>({})

/** 版本历史与它的错误。 */
const history = atom<SettingsHistoryView | null>(null)
const historyError = atom('')

/** 一行结果提示（已保存 / 已恢复 / 已同步）；失败进 `actionError`。 */
const note = atom('')

/** 正在同步/恢复（按钮在飞行中不可再按）。 */
const busy = atom(false)

/** 动作失败的原因（不替换整页）。 */
const actionError = atom('')

/** 这一页是否还在面板上：晚到的响应不再改状态。 */
let active = false

/** 请求序号：重挂载后旧响应作废。 */
let request = 0

/** 错误对象的可读原因。 */
function reasonOf(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  return String(error)
}

/** 按面板语言取一段 worker 传来的双语文本（kind 的字段标签、准入行旁注）。 */
function localized(locale: string, text: SettingsText): string {
  return /^zh(?:[-_]|$)/i.test(locale) ? text.zh : text.en
}

/** 事实的值：字符串原样，双语文本按语言取。 */
function factText(locale: string, value: SettingsText | string): string {
  return typeof value === 'string' ? value : localized(locale, value)
}

/** 一个组里的块（按读面给出的顺序）。 */
function blocksOf(target: SettingsPageView, groupId: SettingsGroupId): readonly string[] {
  if (groupId === 'sources') return target.sources.instances.map((card) => card.block)
  if (groupId === 'eval') return ['policy']
  if (groupId === 'execution') return ['executor']
  if (groupId === 'deployment') return ['limits']
  return []
}

/** 一个块在草稿里的形状：保存时所提交的 `value`。 */
function savedValueOf(target: SettingsPageView, block: string): unknown {
  const card = target.sources.instances.find((candidate) => candidate.block === block)
  if (card !== undefined) return { enabled: card.enabled, config: card.config }
  if (block === 'policy') return policyValueOf(target.eval)
  if (block === 'executor') return executionValueOf(target.execution)
  if (block === 'limits') return limitsValueOf(target.limits)
  return undefined
}

/** 一个块的当前修订号（面板提交的基版本）。 */
function revisionOf(target: SettingsPageView, block: string): number {
  const card = target.sources.instances.find((candidate) => candidate.block === block)
  if (card !== undefined) return card.revision
  if (block === 'policy') return target.eval.revision
  if (block === 'executor') return target.execution.revision
  if (block === 'limits') return target.limits.revision
  return 0
}

/** 一个块的草稿（没有就是干净的初始态）。 */
function draftOf(block: string): DraftState<unknown> {
  return read(drafts)[block] ?? initialDraft()
}

/** 写一条草稿动作。 */
function applyDraft(block: string, action: Parameters<typeof draftReducer>[1]): void {
  update(drafts, (previous) => ({
    ...previous,
    [block]: draftReducer(previous[block] ?? initialDraft(), action)
  }))
}

/** 编辑一个块：`saved` 与 `revision` 是它的基线（每次从最新读面取）。 */
function editBlock(block: string, next: unknown): void {
  const target = read(view)
  if (target === null) return
  applyDraft(block, {
    type: 'edit',
    value: next,
    saved: savedValueOf(target, block),
    revision: revisionOf(target, block)
  })
}

/** 一个组当前的保存栏（多块的组把各块的草稿合起来）。 */
function barOf(locale: string, groupId: SettingsGroupId): SaveBar {
  const target = read(view)
  if (target === null) return { visible: false }
  const blocks = blocksOf(target, groupId)
  return groupSaveBar(
    locale,
    blocks.map((block) => ({
      state: read(drafts)[block] ?? initialDraft(),
      saved: savedValueOf(target, block)
    }))
  )
}

/** 一个组的字段级问题路径（`block.field`）：用来把 `invalid` 落到具体控件上。 */
function invalidPathsOf(groupId: SettingsGroupId): readonly string[] {
  const target = read(view)
  if (target === null) return []
  for (const block of blocksOf(target, groupId)) {
    const notice = (read(drafts)[block] ?? initialDraft()).notice
    if (notice?.kind === 'invalid') {
      return notice.issues.map((issue) => (issue.path.includes('.') ? issue.path : `${block}.${issue.path}`))
    }
  }
  return []
}

// ---------------------------------------------------------------------------
// 读写（渲染里不发请求）
// ---------------------------------------------------------------------------

/**
 * 打开 Settings：读一次设置读数与历史，并把 Deployment 组的读数读进来（它自己管错误态与动作）。
 * 停在 Prompts 组时连它那一份读数一起读（那组自带读取、草稿与保存栏）。
 * 由面板的导航调用——渲染里发请求会在写 atom 时抛。
 */
export async function openSettings(): Promise<void> {
  active = true
  const shown = read(group)
  await Promise.all([
    loadSettings(),
    loadHistory(),
    openDeployment(),
    shown === 'prompts' ? openPrompts() : Promise.resolve()
  ])
}

/** 读一份设置读数；这是设置页唯一的读请求。 */
export async function loadSettings(): Promise<void> {
  if (!active) return
  const token = (request += 1)
  set(phase, 'loading')
  try {
    const next = await plugin.request('settings.read')
    if (!active || token !== request) return
    adopt(next)
    set(phase, 'ready')
    set(reason, '')
  } catch (error) {
    if (!active || token !== request) return
    set(reason, reasonOf(error))
    set(phase, 'error')
  }
}

/** 采纳一份新读数：已保存值变了就通知草稿（`revisionArrived`），草稿本身不丢。 */
function adopt(next: SettingsPageView): void {
  set(view, next)
  update(drafts, (previous) => {
    const updated: Record<string, DraftState<unknown>> = { ...previous }
    const blocks = [
      ...next.sources.instances.map((card) => card.block),
      'policy',
      'executor',
      'limits'
    ]
    for (const block of blocks) {
      updated[block] = draftReducer(previous[block] ?? initialDraft(), {
        type: 'revisionArrived',
        saved: savedValueOf(next, block),
        revision: revisionOf(next, block)
      })
    }
    return updated
  })
}

/** 读版本历史（§K.5）。 */
export async function loadHistory(): Promise<void> {
  if (!active) return
  try {
    const next = await plugin.request('settings.history')
    if (!active) return
    set(history, next)
    set(historyError, '')
  } catch (error) {
    if (!active) return
    set(historyError, reasonOf(error))
  }
}

/** 卸载面板时调用：之后的响应不再写状态，草稿清空。 */
export function resetSettings(): void {
  active = false
  request += 1
  set(phase, 'idle')
  set(view, null)
  set(reason, '')
  set(drafts, {})
  set(history, null)
  set(historyError, '')
  set(note, '')
  set(busy, false)
  set(actionError, '')
  resetDeployment()
  resetPrompts()
}

/** 把一个保存结果折成保存栏要的 notice（字段路径带上块名，能落到具体控件）。 */
function noticeOf(block: string, outcome: SettingsSaveOutcome): DraftNotice | null {
  if (outcome.ok) return null
  if (outcome.reason === 'invalid') {
    return {
      kind: 'invalid',
      issues: outcome.issues.map((issue) => ({
        path: issue.path === '(root)' ? block : `${block}.${issue.path}`,
        message: issue.message
      }))
    }
  }
  if (outcome.reason === 'conflict') return { kind: 'conflict', revision: outcome.revision }
  // `failed` 原样保留 worker 的那句话（§O 的「… did not finish within N ms; retry later」也走
  // 这里）：面板不另编一条超时文案，也不把到点折成第二种 reason。
  return { kind: 'failed', error: outcome.error }
}

/** 保存一个组：改了几个块就按顺序各存一次（每块自己的基线修订号）。 */
async function saveGroup(groupId: SettingsGroupId): Promise<void> {
  const target = read(view)
  if (target === null) return
  const blocks = blocksOf(target, groupId)
  set(note, '')
  set(actionError, '')
  let saved = false
  for (const block of blocks) {
    const state = read(drafts)[block] ?? initialDraft()
    if (state.phase !== 'editing') continue
    const draft = state.draft
    if (draft === undefined) continue
    if (changedLeafCount(savedValueOf(target, block), draft.value) === 0) {
      applyDraft(block, { type: 'discard' })
      continue
    }
    applyDraft(block, { type: 'submit' })
    let outcome: SettingsSaveOutcome
    try {
      outcome = await plugin.request('settings.save', {
        block,
        revision: draft.revision,
        value: draft.value
      })
    } catch (error) {
      applyDraft(block, { type: 'refused', notice: { kind: 'failed', error: reasonOf(error) } })
      break
    }
    if (!outcome.ok) {
      applyDraft(block, { type: 'refused', notice: noticeOf(block, outcome) ?? { kind: 'failed', error: '' } })
      break
    }
    applyDraft(block, {
      type: 'saved',
      revision: outcome.revision,
      restarting: outcome.restarting
    })
    saved = true
    if (outcome.restarting) set(note, translate(handlerLocale(), 'settings.saveRestart'))
  }
  // 读回服务端那一份：`revisionArrived` 让保存过的块收尾，没保存的块保留草稿。
  await loadSettings()
  if (saved) await loadHistory()
}

/**
 * 异步处理器（保存/恢复/同步）里的语言：`env.locale` 是面板环境给的 BCP-47，
 * 不在渲染里也能读；渲染里仍用 props.locale（两者同源）。
 */
function handlerLocale(): string {
  return env.locale
}

/** 放弃一个组的草稿。 */
function discardGroup(groupId: SettingsGroupId): void {
  const target = read(view)
  if (target === null) return
  for (const block of blocksOf(target, groupId)) applyDraft(block, { type: 'discard' })
  set(note, '')
  set(actionError, '')
}

/** 冲突后重新载入：采纳服务端的已保存值，草稿结束（人明确选了「重新载入」）。 */
async function reloadGroup(groupId: SettingsGroupId): Promise<void> {
  const target = read(view)
  if (target !== null) {
    for (const block of blocksOf(target, groupId)) {
      applyDraft(block, { type: 'reloaded', saved: savedValueOf(target, block), revision: revisionOf(target, block) })
    }
  }
  set(actionError, '')
  await loadSettings()
}

// ---------------------------------------------------------------------------
// 组的值（保存时提交的形状）
// ---------------------------------------------------------------------------

/** 一条规则的值（与 §K.1 的 `Rule` 同形）。 */
interface RuleValue {
  id: string
  name: string
  instruction: { zh: string; en: string }
  enabled: boolean
}

/** Policy 里一个 Source 部分的值。 */
interface SourceSectionValue {
  allowed: { id: string; name?: string }[]
  bots: { id: string }[]
  admission: Record<string, Record<string, string>>
  [key: string]: unknown
}

/** Policy 块的值。 */
interface PolicyValue {
  rules: RuleValue[]
  acceptMode: 'off' | 'observe' | 'auto'
  eval: { model?: string; timeoutSeconds: number }
  sources: Record<string, SourceSectionValue>
}

/** 读面 → Policy 块的值（保存时提交的就是它）。 */
function policyValueOf(groupValue: EvalGroupView): PolicyValue {
  const sources: Record<string, SourceSectionValue> = {}
  for (const section of groupValue.sources) {
    const allowed = Array.isArray(section.values['allowed'])
      ? (section.values['allowed'] as { id?: unknown; name?: unknown }[]).flatMap((row) => {
          const id = typeof row.id === 'string' ? row.id : ''
          return id === '' ? [] : [{ id, ...(typeof row.name === 'string' && row.name !== '' ? { name: row.name } : {}) }]
        })
      : []
    const bots = Array.isArray(section.values['bots'])
      ? (section.values['bots'] as { id?: unknown }[]).flatMap((row) =>
          typeof row.id === 'string' && row.id !== '' ? [{ id: row.id }] : []
        )
      : []
    const admission: Record<string, Record<string, string>> = {}
    for (const row of section.admission) {
      const cells: Record<string, string> = {}
      for (const cell of row.cells) {
        // 只写偏离缺省值的格子：未来缺省变了，没配过的行会自动跟上。
        if (cell.value !== cell.default) cells[cell.cell] = cell.value
      }
      if (Object.keys(cells).length > 0) admission[row.id] = cells
    }
    const extras: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(section.values)) {
      if (key !== 'allowed' && key !== 'bots' && value !== undefined) extras[key] = value
    }
    sources[section.source] = { allowed, bots, admission, ...extras }
  }
  return {
    rules: groupValue.rules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      instruction: { zh: rule.instruction.zh, en: rule.instruction.en },
      enabled: rule.enabled
    })),
    acceptMode: groupValue.acceptMode,
    eval: {
      ...(groupValue.model === '' ? {} : { model: groupValue.model }),
      timeoutSeconds: groupValue.timeoutSeconds
    },
    sources
  }
}

/** 读面 → executor 块的值。空串在 schema 里合法（agent 除外：它必填）。 */
function executionValueOf(groupValue: ExecutionGroupView): Record<string, unknown> {
  const value = groupValue.value
  return {
    agent: value.agent,
    model: value.model,
    effort: value.effort,
    maxWorkers: value.maxWorkers,
    baseRepo: value.baseRepo,
    baseBranch: value.baseBranch,
    branchPrefix: value.branchPrefix,
    prepare: value.prepare,
    blockedCommands: [...value.blockedCommands],
    inlineLimit: value.inlineLimit,
    worktreeRetention: value.worktreeRetention,
    confirmDelivery: value.confirmDelivery,
    githubCommitEmail: value.githubCommitEmail
  }
}

/** 读面 → limits 块的值（`retention.days` 嵌一层，与 §D.2 的设置键同名）。 */
function limitsValueOf(groupValue: LimitsGroupView): Record<string, unknown> {
  return {
    promptMaxChars: groupValue.value.promptMaxChars,
    admissionContextMaxPages: groupValue.value.admissionContextMaxPages,
    admissionContextTimeoutMs: groupValue.value.admissionContextTimeoutMs,
    retention: { days: groupValue.value.retentionDays }
  }
}

// ---------------------------------------------------------------------------
// 保存栏（§M.3 的四态）
// ---------------------------------------------------------------------------

/** 一个组的保存栏：Spinner / 字段级 danger / 冲突重载 / 「N changes · Save / Discard」。 */
function SaveBarView(props: {
  readonly locale: string
  readonly bar: SaveBar
  readonly onSave: () => void
  readonly onDiscard: () => void
  readonly onReload: () => void
}): OrcaElement | null {
  const bar = props.bar
  if (!bar.visible) return null
  const locale = props.locale
  return (
    <Stack gap="xs">
      {bar.busy ? (
        <Row gap="xs" align="center">
          <Spinner label={bar.status ?? translate(locale, 'draft.saving')} labelHidden />
          <Text size="sm">{bar.status ?? translate(locale, 'draft.saving')}</Text>
        </Row>
      ) : null}
      {bar.error === undefined ? null : (
        <Callout
          tone="danger"
          icon="error"
          title={translate(locale, 'draft.saveBarTitle')}
        >
          <Stack gap="xs">
            <Text size="sm">{bar.error}</Text>
            {bar.reload === true ? (
              <Row gap="xs">
                <Button variant="outline" size="sm" icon="refresh" onPress={props.onReload}>
                  {translate(locale, 'draft.reload')}
                </Button>
              </Row>
            ) : null}
          </Stack>
        </Callout>
      )}
      {bar.busy ? null : (
        <Row gap="sm" align="center" wrap>
          {bar.status === undefined ? null : <Text size="sm">{bar.status}</Text>}
          <Button variant="solid" size="sm" disabled={!bar.canSave} onPress={props.onSave}>
            {translate(locale, 'action.save')}
          </Button>
          <Button variant="ghost" size="sm" onPress={props.onDiscard}>
            {translate(locale, 'action.discard')}
          </Button>
        </Row>
      )}
    </Stack>
  )
}

/** 一个组的栏 + 三个动作（每个组的尾巴都是它）。 */
function GroupFooter(props: {
  readonly locale: string
  readonly groupId: SettingsGroupId
}): OrcaElement {
  const bar = barOf(props.locale, props.groupId)
  return (
    <SaveBarView
      locale={props.locale}
      bar={bar}
      onSave={() => void saveGroup(props.groupId)}
      onDiscard={() => discardGroup(props.groupId)}
      onReload={() => void reloadGroup(props.groupId)}
    />
  )
}

// ---------------------------------------------------------------------------
// 通用控件：kind 的字段表 → 面板控件（Sources 与 Eval 的「On each Source」共用）
// ---------------------------------------------------------------------------

/** 一行行编辑器的值：文本列按需省略空的可选列。 */
function rowOf(columns: readonly SettingsFieldColumn[], row: Record<string, unknown>): Record<string, unknown> {
  const value: Record<string, unknown> = {}
  for (const column of columns) {
    const current = row[column.key]
    if (column.type === 'text' && column.optional === true && (current === undefined || current === '')) continue
    value[column.key] = current ?? ''
  }
  return value
}

/** 行编辑器：按列生成输入框；增删一行就是数组的一次改动。 */
function RowsEditor(props: {
  readonly locale: string
  readonly label: string
  readonly hint?: string
  readonly columns: readonly SettingsFieldColumn[]
  readonly rows: readonly Record<string, unknown>[]
  readonly onChange: (rows: readonly Record<string, unknown>[]) => void
}): OrcaElement {
  const locale = props.locale
  const change = (index: number, key: string, value: unknown): void => {
    const next = props.rows.map((row, at) =>
      at === index ? rowOf(props.columns, { ...row, [key]: value }) : rowRow(columnsSafe(props.columns), row)
    )
    props.onChange(next)
  }
  return (
    <Stack gap="xs">
      <Text weight="medium" size="sm">
        {props.label}
      </Text>
      {props.hint === undefined ? null : <Hint text={props.hint} />}
      {props.rows.length === 0 ? <Hint text={translate(locale, 'settings.rows.empty')} /> : null}
      {props.rows.map((row, index) => (
        <Row key={`${props.label}:${index}`} gap="xs" align="end" wrap>
          {props.columns.map((column) => (
            <Stack key={column.key} gap="none">
              <Input
                label={localized(locale, column.label)}
                value={typeof row[column.key] === 'string' ? (row[column.key] as string) : ''}
                disabled={column.type === 'text' && column.readonly === true}
                onChange={(text) => change(index, column.key, text)}
              />
            </Stack>
          ))}
          <IconButton
            icon="close"
            label={translate(locale, 'settings.rows.remove')}
            variant="ghost"
            size="sm"
            onPress={() => props.onChange(props.rows.filter((_, at) => at !== index).map((entry) => rowRow(columnsSafe(props.columns), entry)))}
          />
        </Row>
      ))}
      <Row gap="xs">
        <Button
          variant="outline"
          size="sm"
          icon="add"
          onPress={() => props.onChange([...props.rows.map((entry) => rowRow(columnsSafe(props.columns), entry)), rowOf(props.columns, {})])}
        >
          {translate(locale, 'settings.rows.add')}
        </Button>
      </Row>
    </Stack>
  )
}

/** 列的安全取值（`Row` 的删除分支只需要把已有行原样保留）。 */
function columnsSafe(columns: readonly SettingsFieldColumn[]): readonly SettingsFieldColumn[] {
  return columns
}

/** 保留一行（删除别的行时，其余行原样不动）。 */
function rowRow(columns: readonly SettingsFieldColumn[], row: Record<string, unknown>): Record<string, unknown> {
  return rowOf(columns, row)
}

/** 一个字段的控件；`prefix` 是字段级 issues 的路径前缀（`block` 或 `block.rules.0`）。 */
function FieldControl(props: {
  readonly locale: string
  readonly field: SettingsField
  readonly values: Record<string, unknown>
  readonly facts: readonly SettingsFact[]
  readonly invalid: readonly string[]
  readonly prefix: string
  readonly onChange: (key: string, value: unknown) => void
}): OrcaElement {
  const locale = props.locale
  const field = props.field
  const label = localized(locale, field.label)
  const hint = field.hint === undefined ? undefined : localized(locale, field.hint)
  const broken = props.invalid.includes(`${props.prefix}.${field.key}`)
  const error = broken ? translate(locale, 'settings.fieldInvalid') : undefined
  const current = props.values[field.key]
  if (field.type === 'fact') {
    const fact = props.facts.find((candidate) => candidate.key === field.key)
    return (
      <Field label={label} {...(hint === undefined ? {} : { description: hint })}>
        <Text size="sm" muted={fact === undefined}>
          {fact === undefined ? translate(locale, 'settings.fact.empty') : factText(locale, fact.value)}
        </Text>
      </Field>
    )
  }
  if (field.type === 'switch') {
    return (
      <Switch
        label={label}
        checked={current === true}
        onChange={(checked) => props.onChange(field.key, checked)}
      />
    )
  }
  if (field.type === 'select') {
    const options = field.options.map((option) => ({
      value: option.value,
      label: localized(locale, option.label)
    }))
    return (
      <Field label={label} {...(hint === undefined ? {} : { description: hint })} {...(error === undefined ? {} : { error })}>
        <Select
          label={label}
          labelHidden
          value={typeof current === 'string' ? current : ''}
          options={withCurrent(options, typeof current === 'string' ? current : '')}
          onChange={(value) => props.onChange(field.key, value)}
        />
      </Field>
    )
  }
  if (field.type === 'rows') {
    const rows = Array.isArray(current) ? (current as Record<string, unknown>[]) : []
    return (
      <RowsEditor
        locale={locale}
        label={label}
        {...(hint === undefined ? {} : { hint })}
        columns={field.columns}
        rows={rows}
        onChange={(next) => props.onChange(field.key, next)}
      />
    )
  }
  if (field.type === 'number') {
    return (
      <Field label={label} {...(hint === undefined ? {} : { description: hint })} {...(error === undefined ? {} : { error })}>
        <Input
          label={label}
          labelHidden
          type="text"
          value={typeof current === 'number' ? String(current) : ''}
          {...(broken ? { invalid: true } : {})}
          onChange={(text) => {
            const parsed = Number(text)
            props.onChange(field.key, text.trim() !== '' && Number.isFinite(parsed) ? parsed : text)
          }}
        />
      </Field>
    )
  }
  return (
    <Field label={label} {...(hint === undefined ? {} : { description: hint })} {...(error === undefined ? {} : { error })}>
      <Input
        label={label}
        labelHidden
        type="text"
        value={typeof current === 'string' ? current : ''}
        disabled={field.readonly === true}
        {...(broken ? { invalid: true } : {})}
        onChange={(text) => props.onChange(field.key, text)}
      />
    </Field>
  )
}

/** 下拉选项里补上当前值（kind 的选项表可能不含它，例如新的模型 id）。 */
function withCurrent(options: readonly SelectOption[], current: string): readonly SelectOption[] {
  if (current === '' || options.some((option) => option.value === current)) return options
  return [{ value: current, label: current }, ...options]
}

/** 一组字段：全部控件都在这里生成，不在页面里为某个 Source 写特例。 */
function Fields(props: {
  readonly locale: string
  readonly fields: readonly SettingsField[]
  readonly values: Record<string, unknown>
  readonly facts?: readonly SettingsFact[]
  readonly invalid?: readonly string[]
  readonly prefix: string
  readonly onChange: (key: string, value: unknown) => void
}): OrcaElement {
  return (
    <Stack gap="sm">
      {props.fields.map((field) => (
        <FieldControl
          key={field.key}
          locale={props.locale}
          field={field}
          values={props.values}
          facts={props.facts ?? []}
          invalid={props.invalid ?? []}
          prefix={props.prefix}
          onChange={props.onChange}
        />
      ))}
    </Stack>
  )
}

// ---------------------------------------------------------------------------
// Sources 组
// ---------------------------------------------------------------------------

/** 同步一个 Source 的名单（§I.3）：成功给一行差异提示并重读设置。 */
async function syncSource(card: SourceSettingsCard): Promise<void> {
  set(busy, true)
  set(note, '')
  set(actionError, '')
  try {
    // #41 的面板面就是这一个请求（与 `policy sync` 命令同一个驱动器）：只回报名单条数。
    const result = await plugin.request('source.sync', { sourceId: card.id })
    set(note, translate(handlerLocale(), 'settings.sources.syncDone', { count: result.allowed }))
    await loadSettings()
    await loadHistory()
  } catch (error) {
    set(actionError, reasonOf(error))
  } finally {
    set(busy, false)
  }
}

/** 一张 Source 卡：状态、开关、kind 的字段表与只读事实。 */
function SourceCard(props: {
  readonly card: SourceSettingsCard
  readonly locale: string
  readonly value: { enabled: boolean; config: Record<string, unknown> }
  readonly invalid: readonly string[]
  readonly onEdit: (next: { enabled: boolean; config: Record<string, unknown> }) => void
}): OrcaElement {
  const locale = props.locale
  const card = props.card
  const mark = sourceMark(card.state)
  return (
    <Section title={localized(locale, card.title)}>
      <Stack gap="sm">
        <Row gap="xs" align="center" wrap>
          <MarkBadge label={markLabel(locale, mark)} tone={mark.tone} />
          <Text muted size="xs">
            {localized(locale, card.description)}
          </Text>
        </Row>
        {card.configError === undefined ? null : (
          <Callout tone="danger" icon="error" title={translate(locale, 'settings.sources.configInvalid', { reason: card.configError })}>
            <Text size="sm">{card.block}</Text>
          </Callout>
        )}
        <Switch
          label={translate(locale, 'settings.sources.enabled')}
          checked={props.value.enabled}
          onChange={(enabled) => props.onEdit({ enabled, config: props.value.config })}
        />
        <Fields
          locale={locale}
          fields={card.fields}
          values={props.value.config}
          facts={card.facts}
          invalid={props.invalid}
          prefix={`${card.block}.config`}
          onChange={(key, next) =>
            props.onEdit({ enabled: props.value.enabled, config: { ...props.value.config, [key]: next } })
          }
        />
        {card.syncable ? (
          <Row gap="xs" align="center" wrap>
            <Button variant="outline" size="sm" icon="refresh" disabled={read(busy)} onPress={() => void syncSource(card)}>
              {read(busy) ? translate(locale, 'settings.sources.syncing') : translate(locale, 'settings.sources.sync')}
            </Button>
            <Hint text={translate(locale, 'settings.sources.syncHint')} />
          </Row>
        ) : null}
      </Stack>
    </Section>
  )
}

/** Sources 组：每个实例一张卡 + 组保存栏。 */
function SourcesGroup(props: { readonly locale: string; readonly data: SettingsPageView }): OrcaElement {
  const locale = props.locale
  const invalid = invalidPathsOf('sources')
  return (
    <Stack gap="md">
      <Hint text={translate(locale, 'settings.sources.intro')} />
      {props.data.sources.instances.map((card) => {
        const draft = draftOf(card.block)
        const value = (draft.draft?.value ?? { enabled: card.enabled, config: card.config }) as {
          enabled: boolean
          config: Record<string, unknown>
        }
        return (
          <SourceCard
            key={card.block}
            card={card}
            locale={locale}
            value={value}
            invalid={invalid}
            onEdit={(next) => editBlock(card.block, next)}
          />
        )
      })}
      <GroupFooter locale={locale} groupId="sources" />
    </Stack>
  )
}

// ---------------------------------------------------------------------------
// Eval 组
// ---------------------------------------------------------------------------

/** 一条规则的编辑器：id、名称、双语说明与启用开关。 */
function RuleEditor(props: {
  readonly locale: string
  readonly rules: readonly RuleValue[]
  readonly invalid: readonly string[]
  readonly onChange: (rules: readonly RuleValue[]) => void
}): OrcaElement {
  const locale = props.locale
  const change = (index: number, patch: Partial<RuleValue>): void => {
    props.onChange(props.rules.map((rule, at) => (at === index ? { ...rule, ...patch } : rule)))
  }
  return (
    <Stack gap="sm">
      <Text weight="medium" size="sm">
        {translate(locale, 'settings.eval.rules')}
      </Text>
      <Hint text={translate(locale, 'settings.eval.rulesHint')} />
      {props.rules.map((rule, index) => {
        const prefix = `policy.rules.${index}`
        return (
          <Stack key={`rule:${index}`} gap="xs">
            <Row gap="xs" align="end" wrap>
              <Field label={translate(locale, 'settings.eval.ruleId')} {...(props.invalid.includes(`${prefix}.id`) ? { error: translate(locale, 'settings.fieldInvalid') } : {})}>
                <Input
                  label={translate(locale, 'settings.eval.ruleId')}
                  labelHidden
                  value={rule.id}
                  invalid={props.invalid.includes(`${prefix}.id`)}
                  onChange={(id) => change(index, { id })}
                />
              </Field>
              <Field label={translate(locale, 'settings.eval.ruleName')}>
                <Input
                  label={translate(locale, 'settings.eval.ruleName')}
                  labelHidden
                  value={rule.name}
                  onChange={(name) => change(index, { name })}
                />
              </Field>
              <Switch
                label={translate(locale, 'settings.eval.enabled')}
                checked={rule.enabled}
                onChange={(enabled) => change(index, { enabled })}
              />
              <IconButton
                icon="close"
                label={translate(locale, 'settings.eval.removeRule', { id: rule.id || String(index) })}
                variant="ghost"
                size="sm"
                onPress={() => props.onChange(props.rules.filter((_, at) => at !== index))}
              />
            </Row>
            <Field label={translate(locale, 'settings.eval.ruleZh')}>
              <Input
                label={translate(locale, 'settings.eval.ruleZh')}
                labelHidden
                value={rule.instruction.zh}
                onChange={(text) => change(index, { instruction: { ...rule.instruction, zh: text } })}
              />
            </Field>
            <Field label={translate(locale, 'settings.eval.ruleEn')}>
              <Input
                label={translate(locale, 'settings.eval.ruleEn')}
                labelHidden
                value={rule.instruction.en}
                onChange={(text) => change(index, { instruction: { ...rule.instruction, en: text } })}
              />
            </Field>
          </Stack>
        )
      })}
      <Row gap="xs">
        <Button
          variant="outline"
          size="sm"
          icon="add"
          onPress={() =>
            props.onChange([
              ...props.rules,
              {
                id: `rule-${props.rules.length + 1}`,
                name: translate(props.locale, 'settings.eval.newRule'),
                instruction: {
                  zh: translate(props.locale, 'settings.eval.newRule'),
                  en: translate(props.locale, 'settings.eval.newRule')
                },
                enabled: true
              }
            ])
          }
        >
          {translate(locale, 'settings.eval.addRule')}
        </Button>
      </Row>
    </Stack>
  )
}

/** 准入表的一行：三个格子，可用性由该行是否 observe 决定。 */
function AdmissionRowEditor(props: {
  readonly locale: string
  readonly row: AdmissionRowView
  readonly onChange: (cell: string, value: string) => void
}): OrcaElement {
  const locale = props.locale
  return (
    <Stack gap="xs">
      <Text weight="medium" size="sm">
        {localized(locale, props.row.label)}
      </Text>
      <Hint text={localized(locale, props.row.note)} />
      <Row gap="sm" wrap>
        {props.row.cells.map((cell) => {
          const label = translate(locale, `settings.admission.${cell.cell}` as CopyKey)
          const options: SelectOption[] = cell.options.map((option) => ({
            value: option,
            label: translate(locale, `settings.admission.${option}` as CopyKey)
          }))
          return (
            <Field key={cell.cell} label={label} {...(cell.available ? {} : { description: translate(locale, 'settings.eval.admissionUnavailable') })}>
              <Select
                label={label}
                labelHidden
                value={cell.value}
                options={options}
                disabled={!cell.available}
                onChange={(value) => props.onChange(cell.cell, value)}
              />
            </Field>
          )
        })}
      </Row>
    </Stack>
  )
}

/** 一个 Source 的 Policy 部分（字段 + 准入表 + 同步）。 */
function PolicySource(props: {
  readonly locale: string
  readonly source: SourcePolicyView
  readonly policy: PolicyValue
  readonly invalid: readonly string[]
  readonly onChange: (value: PolicyValue) => void
}): OrcaElement {
  const locale = props.locale
  const section = props.policy.sources[props.source.source] ?? { allowed: [], bots: [], admission: {} }
  const card = props.source
  return (
    <Stack gap="sm">
      <Text weight="medium" size="sm">
        {localized(locale, card.title)}
      </Text>
      <Fields
        locale={locale}
        fields={card.fields}
        values={card.values}
        invalid={props.invalid}
        prefix={`policy.sources.${card.source}`}
        onChange={(key, next) =>
          props.onChange({
            ...props.policy,
            sources: {
              ...props.policy.sources,
              [card.source]: { ...section, [key]: next } as SourceSectionValue
            }
          })
        }
      />
      <Text weight="medium" size="sm">
        {translate(locale, 'settings.eval.admission')}
      </Text>
      <Hint text={translate(locale, 'settings.eval.admissionHint')} />
      {card.admission.map((row) => (
        <AdmissionRowEditor
          key={row.id}
          locale={locale}
          row={row}
          onChange={(cell, value) => {
            const cells = { ...(section.admission[row.id] ?? {}) }
            const target = row.cells.find((candidate) => candidate.cell === cell)
            if (target !== undefined && value === target.default) delete cells[cell]
            else cells[cell] = value
            props.onChange({
              ...props.policy,
              sources: {
                ...props.policy.sources,
                [card.source]: { ...section, admission: { ...section.admission, [row.id]: cells } }
              }
            })
          }}
        />
      ))}
    </Stack>
  )
}

/** Eval 组：Policy 版本、模式、模型、超时、规则与每个 Source 的部分。 */
function EvalGroup(props: { readonly locale: string; readonly data: SettingsPageView }): OrcaElement {
  const locale = props.locale
  const invalid = invalidPathsOf('eval')
  const draft = draftOf('policy')
  const value = (draft.draft?.value ?? policyValueOf(props.data.eval)) as PolicyValue
  const edit = (next: PolicyValue): void => editBlock('policy', next)
  const saved = props.data.eval.saved
  return (
    <Stack gap="md">
      <Hint text={translate(locale, 'settings.eval.intro')} />
      <Row gap="md" wrap>
        <Field label={translate(locale, 'settings.eval.policyVersion')}>
          <Code>{props.data.eval.policyVersion}</Code>
        </Field>
        {saved === null ? null : (
          <Field label={translate(locale, 'settings.history.at')}>
            <RelativeTime at={Date.parse(saved.at)} format="short" />
          </Field>
        )}
      </Row>
      <Field label={translate(locale, 'settings.eval.acceptMode')}>
        <RadioGroup
          label={translate(locale, 'settings.eval.acceptMode')}
          labelHidden
          value={value.acceptMode}
          orientation="vertical"
          options={(['off', 'observe', 'auto'] as const).map((mode) => ({
            value: mode,
            label: translate(locale, `settings.eval.acceptMode.${mode}` as CopyKey)
          }))}
          onChange={(mode) => edit({ ...value, acceptMode: mode as PolicyValue['acceptMode'] })}
        />
      </Field>
      <Field label={translate(locale, 'settings.eval.model')} description={translate(locale, 'settings.eval.modelHint')}>
        <Input
          label={translate(locale, 'settings.eval.model')}
          labelHidden
          value={value.eval.model ?? ''}
          onChange={(model) =>
            edit({ ...value, eval: { ...value.eval, ...(model === '' ? { model: undefined } : { model }) } })
          }
        />
      </Field>
      <Field label={translate(locale, 'settings.eval.timeout')} {...(invalid.includes('policy.eval.timeoutSeconds') ? { error: translate(locale, 'settings.fieldInvalid') } : {})}>
        <Input
          label={translate(locale, 'settings.eval.timeout')}
          labelHidden
          value={String(value.eval.timeoutSeconds)}
          invalid={invalid.includes('policy.eval.timeoutSeconds')}
          onChange={(text) => {
            const parsed = Number(text)
            edit({
              ...value,
              eval: {
                ...value.eval,
                timeoutSeconds: text.trim() !== '' && Number.isFinite(parsed) ? parsed : ('' as unknown as number)
              }
            })
          }}
        />
      </Field>
      <RuleEditor
        locale={locale}
        rules={value.rules}
        invalid={invalid}
        onChange={(rules) => edit({ ...value, rules: [...rules] })}
      />
      <Section title={translate(locale, 'settings.eval.perSource')} count={props.data.eval.sources.length}>
        <Stack gap="md">
          {props.data.eval.sources.map((source) => (
            <PolicySource
              key={source.source}
              locale={locale}
              source={source}
              policy={value}
              invalid={invalid}
              onChange={edit}
            />
          ))}
        </Stack>
      </Section>
      <GroupFooter locale={locale} groupId="eval" />
    </Stack>
  )
}

// ---------------------------------------------------------------------------
// Execution 组
// ---------------------------------------------------------------------------

/** 被禁命令：一个名字一行的编辑器（数组按整体算一处改动）。 */
function CommandList(props: {
  readonly locale: string
  readonly commands: readonly string[]
  readonly onChange: (commands: readonly string[]) => void
}): OrcaElement {
  const locale = props.locale
  return (
    <Stack gap="xs">
      <Text weight="medium" size="sm">
        {translate(locale, 'settings.execution.blockedCommands')}
      </Text>
      <Hint text={translate(locale, 'settings.execution.blockedHint')} />
      {props.commands.map((command, index) => (
        <Row key={`command:${index}`} gap="xs" align="end">
          <Input
            label={translate(locale, 'settings.execution.blockedCommands')}
            labelHidden
            value={command}
            onChange={(text) => props.onChange(props.commands.map((entry, at) => (at === index ? text : entry)))}
          />
          <IconButton
            icon="close"
            label={translate(locale, 'settings.rows.remove')}
            variant="ghost"
            size="sm"
            onPress={() => props.onChange(props.commands.filter((_, at) => at !== index))}
          />
        </Row>
      ))}
      <Row gap="xs">
        <Button variant="outline" size="sm" icon="add" onPress={() => props.onChange([...props.commands, ''])}>
          {translate(locale, 'settings.execution.addCommand')}
        </Button>
      </Row>
    </Stack>
  )
}

/** Execution 组：agent、模型、并发、base repo、prepare（带变量插入）、被禁命令与保留策略。 */
function ExecutionGroup(props: { readonly locale: string; readonly data: SettingsPageView }): OrcaElement {
  const locale = props.locale
  const invalid = invalidPathsOf('execution')
  const draft = draftOf('executor')
  const value = (draft.draft?.value ?? executionValueOf(props.data.execution)) as Record<string, unknown> & {
    agent: string
    model: string
    effort: string
    maxWorkers: number
    baseRepo: string
    baseBranch: string
    branchPrefix: string
    prepare: string
    blockedCommands: readonly string[]
    inlineLimit: number
    worktreeRetention: 'keep' | 'on-end'
    confirmDelivery: boolean
    githubCommitEmail: string
  }
  const group = props.data.execution
  const edit = (patch: Record<string, unknown>): void => editBlock('executor', { ...value, ...patch })
  const variable = read(variableChoice) === '' ? (group.variables[0] ?? '') : read(variableChoice)
  const text = (key: string): string => (typeof value[key] === 'string' ? (value[key] as string) : '')
  const number = (key: string): string => (typeof value[key] === 'number' ? String(value[key]) : '')
  const broken = (key: string): boolean => invalid.includes(`executor.${key}`)
  const textField = (key: string, label: CopyKey, hint?: CopyKey): OrcaElement => (
    <Field
      label={translate(locale, label)}
      {...(hint === undefined ? {} : { description: translate(locale, hint) })}
      {...(broken(key) ? { error: translate(locale, 'settings.fieldInvalid') } : {})}
    >
      <Input
        label={translate(locale, label)}
        labelHidden
        value={text(key)}
        invalid={broken(key)}
        onChange={(next) => edit({ [key]: next })}
      />
    </Field>
  )
  return (
    <Stack gap="md">
      <Hint text={translate(locale, 'settings.execution.intro')} />
      {textField('agent', 'settings.execution.agent')}
      {textField('model', 'settings.execution.model', 'settings.execution.modelHint')}
      {textField('githubCommitEmail', 'settings.execution.githubCommitEmail', 'settings.execution.githubCommitEmailHint')}
      {textField('effort', 'settings.execution.effort', 'settings.execution.effortHint')}
      <Field label={translate(locale, 'settings.execution.maxWorkers')} {...(broken('maxWorkers') ? { error: translate(locale, 'settings.fieldInvalid') } : {})}>
        <Input
          label={translate(locale, 'settings.execution.maxWorkers')}
          labelHidden
          value={number('maxWorkers')}
          invalid={broken('maxWorkers')}
          onChange={(next) => {
            const parsed = Number(next)
            edit({ maxWorkers: next.trim() !== '' && Number.isFinite(parsed) ? parsed : next })
          }}
        />
      </Field>
      <Field
        label={translate(locale, 'settings.execution.baseRepo')}
        description={translate(
          locale,
          group.repos.length === 0 ? 'settings.execution.baseRepoManual' : 'settings.execution.baseRepoHint'
        )}
      >
        {group.repos.length === 0 ? (
          <Input
            label={translate(locale, 'settings.execution.baseRepo')}
            labelHidden
            value={text('baseRepo')}
            onChange={(next) => edit({ baseRepo: next })}
          />
        ) : (
          <Select
            label={translate(locale, 'settings.execution.baseRepo')}
            labelHidden
            value={text('baseRepo')}
            options={withCurrent(group.repos, text('baseRepo'))}
            onChange={(next) => edit({ baseRepo: next })}
          />
        )}
      </Field>
      {textField('baseBranch', 'settings.execution.baseBranch')}
      {textField('branchPrefix', 'settings.execution.branchPrefix')}
      <Field label={translate(locale, 'settings.execution.prepare')} description={translate(locale, 'settings.execution.prepareHint')}>
        <Textarea
          label={translate(locale, 'settings.execution.prepare')}
          labelHidden
          rows={5}
          value={text('prepare')}
          onChange={(next) => edit({ prepare: next })}
        />
      </Field>
      <Row gap="xs" align="end" wrap>
        <Field label={translate(locale, 'settings.execution.variable')}>
          <Select
            label={translate(locale, 'settings.execution.variable')}
            labelHidden
            value={variable}
            options={group.variables.map((name) => ({ value: name, label: name }))}
            onChange={(next) => setVariableChoice(next)}
          />
        </Field>
        <Button
          variant="outline"
          size="sm"
          icon="add"
          disabled={group.variables.length === 0}
          onPress={() => {
            // 只插入变量名本身（`${DSH_SUPERAGENT_…}`）：不在这里拼任何值，替换发生在运行时。
            const token = `\${${variable}}`
            const current = text('prepare')
            edit({ prepare: current === '' || current.endsWith(' ') ? `${current}${token}` : `${current} ${token}` })
          }}
        >
          {translate(locale, 'settings.execution.insertVariable')}
        </Button>
      </Row>
      <CommandList
        locale={locale}
        commands={value.blockedCommands}
        onChange={(commands) => edit({ blockedCommands: [...commands] })}
      />
      <Field label={translate(locale, 'settings.execution.inlineLimit')} {...(broken('inlineLimit') ? { error: translate(locale, 'settings.fieldInvalid') } : {})}>
        <Input
          label={translate(locale, 'settings.execution.inlineLimit')}
          labelHidden
          value={number('inlineLimit')}
          invalid={broken('inlineLimit')}
          onChange={(next) => {
            const parsed = Number(next)
            edit({ inlineLimit: next.trim() !== '' && Number.isFinite(parsed) ? parsed : next })
          }}
        />
      </Field>
      <Field label={translate(locale, 'settings.execution.worktreeRetention')}>
        <Select
          label={translate(locale, 'settings.execution.worktreeRetention')}
          labelHidden
          value={value.worktreeRetention}
          options={[
            { value: 'keep', label: translate(locale, 'settings.execution.retentionKeep') },
            { value: 'on-end', label: translate(locale, 'settings.execution.retentionOnEnd') }
          ]}
          onChange={(next) => edit({ worktreeRetention: next })}
        />
      </Field>
      <Switch
        label={translate(locale, 'settings.execution.confirmDelivery')}
        checked={value.confirmDelivery === true}
        onChange={(checked) => edit({ confirmDelivery: checked })}
      />
      <GroupFooter locale={locale} groupId="execution" />
    </Stack>
  )
}

/** prepare 的变量菜单选择（模块级 atom：重开面板回到第一个变量）。 */
const variableChoice = atom('')
const setVariableChoice = (next: string): void => set(variableChoice, next)

// ---------------------------------------------------------------------------
// Deployment 组的机器限额（#47 留下的四个旋钮，从只读改为可编辑）
// ---------------------------------------------------------------------------

/** 机器限额编辑器：四个数值 + 同一套保存栏（保存/修订/历史与其他组一致）。 */
function LimitsEditor(props: { readonly locale: string; readonly data: LimitsGroupView }): OrcaElement {
  const locale = props.locale
  const draft = draftOf('limits')
  const invalid = invalidPathsOf('deployment')
  const value = (draft.draft?.value ?? limitsValueOf(props.data)) as {
    promptMaxChars: number
    admissionContextMaxPages: number
    admissionContextTimeoutMs: number
    retention: { days: number }
  }
  const edit = (next: Record<string, unknown>): void => editBlock('limits', next)
  const integer = (path: string, label: CopyKey, current: number, write: (parsed: number) => void): OrcaElement => (
    <Field label={translate(locale, label)} {...(invalid.includes(`limits.${path}`) ? { error: translate(locale, 'settings.fieldInvalid') } : {})}>
      <Input
        label={translate(locale, label)}
        labelHidden
        value={String(current)}
        invalid={invalid.includes(`limits.${path}`)}
        onChange={(text) => {
          const parsed = Number(text)
          write(text.trim() !== '' && Number.isFinite(parsed) ? parsed : ('' as unknown as number))
        }}
      />
    </Field>
  )
  return (
    <Section title={translate(locale, 'settings.limits.title')}>
      <Stack gap="sm">
        <Hint text={translate(locale, 'settings.limits.intro')} />
        {integer('promptMaxChars', 'settings.limits.promptMaxChars', value.promptMaxChars, (parsed) =>
          edit({ ...value, promptMaxChars: parsed })
        )}
        {integer('admissionContextMaxPages', 'settings.limits.pages', value.admissionContextMaxPages, (parsed) =>
          edit({ ...value, admissionContextMaxPages: parsed })
        )}
        {integer('admissionContextTimeoutMs', 'settings.limits.timeoutMs', value.admissionContextTimeoutMs, (parsed) =>
          edit({ ...value, admissionContextTimeoutMs: parsed })
        )}
        {integer('retention.days', 'settings.limits.retentionDays', value.retention.days, (parsed) =>
          edit({ ...value, retention: { days: parsed } })
        )}
        <GroupFooter locale={locale} groupId="deployment" />
      </Stack>
    </Section>
  )
}

/** Deployment 组：保留 #47 的内容，只把机器限额换成可编辑的那一份。 */
function DeploymentGroup(props: { readonly locale: string; readonly data: SettingsPageView }): OrcaElement {
  return (
    <Stack gap="md">
      <Deployment locale={props.locale} limitsEditor={<LimitsEditor locale={props.locale} data={props.data.limits} />} />
    </Stack>
  )
}

// ---------------------------------------------------------------------------
// Prompts 组（#43：团队文本、override、full-text diff、历史与技能；组件自带读取与保存栏）
// ---------------------------------------------------------------------------

/**
 * Prompts 组的组体。#43 的 `Prompts` 自己管读数、草稿、保存栏与四个子页，所以这里只给它
 * 组位（`data` 是框架给其他组的 `settings.read` 读数，Prompts 不读它）。
 */
function PromptsGroup(props: { readonly locale: string; readonly data: SettingsPageView }): OrcaElement {
  void props.data
  return <Prompts locale={props.locale} />
}

/** 五组的内容表：只有这一张（组 id → 组体），新增一组就加一行。 */
export const SETTINGS_GROUP_BODIES: Readonly<
  Record<SettingsGroupId, (props: { readonly locale: string; readonly data: SettingsPageView }) => OrcaElement>
> = {
  sources: SourcesGroup,
  eval: EvalGroup,
  execution: ExecutionGroup,
  prompts: PromptsGroup,
  deployment: DeploymentGroup
}

// ---------------------------------------------------------------------------
// 历史（每次保存的来源、版本与受影响 Ticket；恢复走同一条保存路径）
// ---------------------------------------------------------------------------

/** 恢复一版：以当前块修订号为基线再存一次（同一条 `settings.save` 路径）。 */
async function restore(row: SettingsHistoryRow): Promise<void> {
  const target = read(view)
  if (target === null) {
    set(actionError, reasonOf(new Error('the settings are not loaded')))
    return
  }
  set(busy, true)
  set(note, '')
  set(actionError, '')
  try {
    const outcome = await plugin.request('settings.save', {
      block: row.block,
      revision: revisionOf(target, row.block),
      value: row.value
    })
    if (!outcome.ok) {
      set(
        actionError,
        noticeOf(row.block, outcome) === null
          ? row.block
          : outcome.reason === 'invalid'
            ? outcome.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
            : outcome.reason === 'conflict'
              ? translate(handlerLocale(), 'draft.conflict', { revision: outcome.revision })
              : outcome.error
      )
      return
    }
    set(note, translate(handlerLocale(), 'settings.history.restored', { revision: row.revision }))
    await loadSettings()
    await loadHistory()
  } catch (error) {
    set(actionError, reasonOf(error))
  } finally {
    set(busy, false)
  }
}

/** 历史一行：版本、块、来源、时间、Policy 版本与受影响工单，以及恢复入口。 */
function HistoryRow(props: { readonly locale: string; readonly row: SettingsHistoryRow }): OrcaElement {
  const locale = props.locale
  const row = props.row
  const at = Date.parse(row.at)
  return (
    <Stack gap="xs">
      <Row gap="xs" align="center" wrap>
        <Code>{`#${row.revision}`}</Code>
        <Code>{row.block}</Code>
        <Text size="sm">{translate(locale, `settings.origin.${row.origin}` as CopyKey)}</Text>
        {Number.isFinite(at) ? <RelativeTime at={at} format="short" /> : <Text size="sm">{row.at}</Text>}
        {row.policyVersion === null ? null : <Code>{row.policyVersion}</Code>}
        <ConfirmRestore locale={locale} row={row} />
      </Row>
      {row.affectedTickets.length === 0 ? null : (
        <Hint
          text={translate(locale, 'settings.history.affectedTickets', { tickets: row.affectedTickets.join(', ') })}
        />
      )}
    </Stack>
  )
}

/** 恢复是破坏性动作：先问，确认后走同一条保存路径。 */
function ConfirmRestore(props: { readonly locale: string; readonly row: SettingsHistoryRow }): OrcaElement {
  const locale = props.locale
  const key = `restore:${props.row.revision}`
  const open = read(confirmingRestore) === key
  if (!open) {
    return (
      <IconButton
        icon="refresh"
        label={translate(locale, 'settings.history.restore')}
        variant="ghost"
        size="sm"
        disabled={read(busy)}
        onPress={() => set(confirmingRestore, key)}
      />
    )
  }
  return (
    <Row gap="xs" align="center">
      <Text size="xs">{translate(locale, 'settings.history.confirmRestore', { revision: props.row.revision })}</Text>
      <Button
        variant="solid"
        tone="danger"
        size="sm"
        onPress={() => {
          set(confirmingRestore, null)
          void restore(props.row)
        }}
      >
        {translate(locale, 'action.confirm')}
      </Button>
      <Button variant="ghost" size="sm" onPress={() => set(confirmingRestore, null)}>
        {translate(locale, 'action.cancel')}
      </Button>
    </Row>
  )
}

/** 历史里正在确认的那一行（同一时刻只有一处）。 */
const confirmingRestore = atom<string | null>(null)

/** 历史区：最近若干次保存与恢复入口。 */
function HistorySection(props: { readonly locale: string }): OrcaElement {
  const locale = props.locale
  const rows = read(history)
  const failure = read(historyError)
  return (
    <Section title={translate(locale, 'settings.history.title')} count={rows?.history.length}>
      <Stack gap="sm">
        <Hint text={translate(locale, 'settings.history.intro')} />
        {failure === '' ? null : (
          <Callout tone="danger" icon="error" title={translate(locale, 'settings.history.loadFailed', { reason: failure })}>
            <Button variant="outline" size="sm" icon="refresh" onPress={() => void loadHistory()}>
              {translate(locale, 'settings.retry')}
            </Button>
          </Callout>
        )}
        {rows === null || failure !== '' ? null : rows.history.length === 0 ? (
          <Hint text={translate(locale, 'settings.history.empty')} />
        ) : (
          <Stack gap="xs">
            {rows.history.map((row) => (
              <HistoryRow key={`history:${row.revision}`} locale={locale} row={row} />
            ))}
          </Stack>
        )}
      </Stack>
    </Section>
  )
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

/** 一个组的内容（未知组按空处理，不让脏的存储值破坏整页）。 */
function GroupBody(props: {
  readonly locale: string
  readonly groupId: SettingsGroupId
  readonly data: SettingsPageView
}): OrcaElement {
  const body = SETTINGS_GROUP_BODIES[props.groupId]
  return body({ locale: props.locale, data: props.data })
}

/** Settings 页：五组的框架 + 每个组自己的内容与保存栏 + 历史。 */
export function Settings(props: { readonly locale: string }): OrcaElement {
  const locale = props.locale
  const data = read(view)
  const stage = read(phase)
  const noteText = read(note)
  const failure = read(actionError)
  if (stage === 'error') {
    return (
      <ErrorState
        title={translate(locale, 'boot.unavailable')}
        reason={translate(locale, 'settings.loadFailed', { reason: read(reason) })}
        locale={locale}
        onRetry={() => void loadSettings()}
      />
    )
  }
  if (data === null) return <LoadingState label={translate(locale, 'state.loading')} />
  const selected = SETTINGS_GROUPS.includes(read(group)) ? read(group) : 'sources'
  return (
    <Stack gap="md">
      <Hint text={translate(locale, 'settings.intro')} />
      <Tabs
        label={translate(locale, 'nav.settings')}
        value={selected}
        onChange={(next) => {
          if (!SETTINGS_GROUPS.includes(next as SettingsGroupId)) return
          set(group, next as SettingsGroupId)
          // Prompts 组自带读数：切过去时读一次（其余组的读数由 `openSettings` 读过）。
          if (next === 'prompts') void openPrompts()
        }}
      >
        {SETTINGS_GROUPS.map((groupId) => (
          <Tab
            key={groupId}
            value={groupId}
            label={translate(locale, `settings.group.${groupId}` as CopyKey)}
          >
            <GroupBody locale={locale} groupId={groupId} data={data} />
          </Tab>
        ))}
      </Tabs>
      {noteText === '' ? null : (
        <Text size="sm" tone="success">
          {noteText}
        </Text>
      )}
      {failure === '' ? null : (
        <Text tone="danger" size="xs">
          {failure}
        </Text>
      )}
      <HistorySection locale={locale} />
    </Stack>
  )
}

/** 供测试断言：本页用的组顺序（顺序即 §M.3 的语义）。 */
export const SETTINGS_GROUP_ORDER = SETTINGS_GROUPS

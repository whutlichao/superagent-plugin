// Prompts 组（§M.3 的四个子页、§L.3 的占位符、§L.4 的版本/历史/default-updated、§L.6 的技能）。
//
// 四个子页：编辑（三段团队文本 + 每个分片一个 override，被改的标「已修改」，模板处展示必保留
// 占位符）、全文（`CodeView` 的组装文本 + 与「已保存」或「默认」的行级 diff）、历史（版本
// 列表 + 恢复到某个版本）、技能（内置只读 + 团队技能增删改，各带稳定路径）。
//
// 面板只画 worker 的读数（`prompts`）与草稿：占位符、技能名与体量上限全部由 worker 校验，
// 保存前先过一次 `prompts.preview`（同一份校验，不写库），被拒时把 `issues[]` 翻成一句话
// 显示在组内 `Callout` 与保存栏上——面板不自己判一遍规则。
//
// 破坏性/立即生效的动作（恢复某个版本、default-updated 的两个选择）走一次真实保存，成功后
// 用返回的读数刷新整页；草稿因此要么随保存一起提交，要么在重新载入后按新修订重挂 base。
import {
  atom,
  Button,
  Callout,
  CodeView,
  Collapsible,
  Input,
  plugin,
  RadioGroup,
  read,
  Row,
  set,
  Spinner,
  Stack,
  Tab,
  Table,
  Tabs,
  Text,
  Textarea,
  Toolbar,
  type OrcaElement,
  type TableRow
} from 'orca'
import { translate, type CopyKey } from './copy'
import { lineDiff } from './diff'
import {
  barShown,
  draftReducer,
  initialDraft,
  saveBar,
  type DraftState,
  type DraftNotice
} from './draft'
import { diffText } from './markdown'
import {
  clearPart,
  changedParts,
  errorCode,
  errorValues,
  issueTexts,
  partText,
  removeSkill,
  sameConfig,
  setOverride,
  setSkill,
  setTeamText,
  skillPath,
  teamSkillNames,
  teamText,
  textOf,
  type PromptIssueText
} from './prompt-view.ts'
import {
  isPromptDiffBase,
  isPromptTab,
  PROMPT_DIFF_BASES,
  PROMPT_TABS,
  type PanelPromptChange,
  type PanelPromptConfig,
  type PanelPromptIssue,
  type PanelPromptPart,
  type PanelPromptPreview,
  type PanelPromptsView,
  type PanelPromptTexts,
  type PanelPromptVersion,
  type PromptDiffBase,
  type PromptTab
} from './protocol'
import {
  BootingState,
  ErrorState,
  Hint,
  LoadingState,
  MarkBadge,
  Section,
  word
} from './widgets'

/** 哪个全文角色看一份（一次只画一个：整份全文可以有 96 K 字符，两个都画没必要）。 */
type PromptRoleView = 'orchestrator' | 'worker'

/** 最近一份读数；`null` 表示还没读到。 */
const view = atom<PanelPromptsView | null>(null)

/** 读取阶段：`idle` 还没问 / `loading` 正在问 / `ready` 有读数 / `error` 读不到。 */
type Phase = 'idle' | 'loading' | 'ready' | 'error'
const phase = atom<Phase>('idle')

/** 读不到时的原因。 */
const reason = atom('')

/** 当前子页（§M.3 的四个；存储里的旧值按「编辑」渲染）。 */
const tab = atom<string>('panel.promptTab', 'edit', { persist: 'storage' })

/** Full prompt 的对比基准（已保存 / 默认）。 */
const baseline = atom<string>('panel.promptBaseline', 'saved', { persist: 'storage' })

/** 全文看哪个角色。 */
const role = atom<string>('panel.promptRole', 'orchestrator', { persist: 'storage' })

/** 草稿（团队三段 + override + 团队技能）。 */
const draft = atom<DraftState<PanelPromptConfig>>(initialDraft())

/** 最近一次草稿预览；`null` 表示还没有或草稿是干净的。 */
const preview = atom<PanelPromptPreview | null>(null)

/** 预览对应的草稿（JSON）：同一份草稿不重复问。 */
const previewKey = atom('')

/** 最近一次被拒的原因（组内 `Callout` 用它，保存栏用字段名）。 */
const draftIssues = atom<readonly PanelPromptIssue[]>([])

/** 新建团队技能时输入的名字。 */
const newSkillName = atom('')

/** 历史里选中的版本号（选中后才给「恢复」）。 */
const chosen = atom<number | null>(null)

/** 立即动作（恢复、采纳/保留）的失败原因；不替换整页。 */
const actionError = atom('')

/** 最近一次恢复得到的版本号（成功提示）。 */
const restoredRevision = atom<number | null>(null)

/** 这一页是否还在面板上：晚到的响应不再改状态。 */
let active = false

/** 草稿与已保存配置的镜像：异步动作要读它们，而渲染之外的 `read` 不该读 atom。 */
let draftValue: PanelPromptConfig = {}
let savedValue: PanelPromptConfig = {}

/** 错误对象的可读原因。 */
function reasonOf(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  return String(error)
}

/** 当前子页（存储里的旧值 / 未来的新值都收敛到四个之一）。 */
function currentTab(): PromptTab {
  const stored = read(tab)
  return isPromptTab(stored) ? stored : 'edit'
}

/** 当前基准。 */
function currentBaseline(): PromptDiffBase {
  const stored = read(baseline)
  return isPromptDiffBase(stored) ? stored : 'saved'
}

/** 当前角色。 */
function currentRole(): PromptRoleView {
  return read(role) === 'worker' ? 'worker' : 'orchestrator'
}

/** 草稿当前的值（干净时就是已保存的那份）。 */
function currentConfig(): PanelPromptConfig {
  return read(draft).draft?.value ?? read(view)?.config ?? {}
}

/** 采纳一份读数：草稿结束，镜像同步。 */
function applyView(next: PanelPromptsView): void {
  set(view, next)
  savedValue = next.config
  draftValue = next.config
  set(draft, initialDraft())
  set(preview, null)
  set(previewKey, '')
  set(draftIssues, [])
}

/** 读一次读数（打开这一页、重开面板、失败后重试都走它）。 */
export async function loadPrompts(): Promise<void> {
  if (!active) return
  set(phase, 'loading')
  try {
    const next = await plugin.request('prompts')
    if (!active) return
    applyView(next)
    set(phase, 'ready')
    set(reason, '')
  } catch (error) {
    if (!active) return
    set(reason, reasonOf(error))
    set(phase, 'error')
  }
}

/** 打开这一页：读一次读数（渲染里不发请求）。 */
export async function openPrompts(): Promise<void> {
  active = true
  await loadPrompts()
}

/** 卸载面板时调用：之后的响应不再写状态。 */
export function resetPrompts(): void {
  active = false
  set(phase, 'idle')
  set(view, null)
  set(reason, '')
  set(draft, initialDraft())
  set(preview, null)
  set(previewKey, '')
  set(draftIssues, [])
  set(newSkillName, '')
  set(chosen, null)
  set(actionError, '')
  set(restoredRevision, null)
  draftValue = {}
  savedValue = {}
}

/** 改一次草稿：保存栏的计数、字段与「已修改」标记都从 `draft.ts` 的状态机来。 */
function edit(next: PanelPromptConfig): void {
  draftValue = next
  const state = read(draft)
  set(
    draft,
    draftReducer(state, {
      type: 'edit',
      value: next,
      saved: savedValue,
      revision: read(view)?.revision ?? 0
    })
  )
  set(draftIssues, [])
}

/** 一次预览：宿主把错误折成码，所以这里也把异常折成同一形状的 `issues[]`。 */
async function previewDraft(config: PanelPromptConfig): Promise<PanelPromptPreview> {
  try {
    return await plugin.request('prompts.preview', { config })
  } catch (error) {
    const values = errorValues(error)
    return {
      ok: false,
      issues: [{ code: errorCode(error), part: values['part'] ?? values['skill'] ?? null, values }]
    }
  }
}

/**
 * 保存草稿（§L.4）：先预览（与保存同一份校验，不写库），合法才真的发一次保存。
 * 被拒时保存栏与组内 `Callout` 同时说明原因，草稿留在原处。
 */
async function save(): Promise<void> {
  const state = read(draft)
  const current = read(view)
  if (state.phase !== 'editing' || current === null) return
  set(draft, draftReducer(state, { type: 'submit' }))
  set(draftIssues, [])
  set(actionError, '')
  const checked = await previewDraft(draftValue)
  if (!active) return
  if (!checked.ok) {
    set(draftIssues, checked.issues)
    refuseSave(checked.issues)
    return
  }
  try {
    const next = await plugin.request('prompts.save', {
      config: draftValue,
      baseRevision: current.revision
    })
    if (!active) return
    applyView(next)
  } catch (error) {
    if (!active) return
    refuseWithError(error)
  }
}

/** 保存被拒（预览发现的字段问题）：保存栏列字段名，组内说清每一条。 */
function refuseSave(issues: readonly PanelPromptIssue[]): void {
  const notice: DraftNotice = {
    kind: 'invalid',
    issues: issues.map((issue) => ({ path: issue.part ?? issue.code, message: issue.code }))
  }
  set(draft, draftReducer(read(draft), { type: 'refused', notice }))
}

/**
 * 保存被拒（真的一次写入拒绝）：`stale_revision` 是冲突（给出「重新载入」并保留草稿），
 * 其余是一句话的失败——两种都不丢草稿（§L.4 第二条）。
 */
function refuseWithError(error: unknown): void {
  const values = errorValues(error)
  const currentRevision = values['currentRevision']
  const notice: DraftNotice =
    errorCode(error) === 'stale_revision' && currentRevision !== undefined
      ? { kind: 'conflict', revision: Number(currentRevision) }
      : { kind: 'failed', error: reasonOf(error) }
  set(draft, draftReducer(read(draft), { type: 'refused', notice }))
}

/** 「重新载入」：读最新读数并按新修订重挂草稿的 base（草稿本身不丢）。 */
async function reloadLatest(): Promise<void> {
  const current = read(view)
  if (current === null) return
  try {
    const next = await plugin.request('prompts')
    if (!active) return
    set(view, next)
    savedValue = next.config
    set(
      draft,
      draftReducer(read(draft), {
        type: 'revisionArrived',
        saved: next.config,
        revision: next.revision
      })
    )
    set(draftIssues, [])
  } catch (error) {
    if (active) set(actionError, reasonOf(error))
  }
}

/** 一次立即写入（恢复、default-updated 的两个选择都只是「保存一份配置」）。 */
async function writeConfig(next: PanelPromptConfig): Promise<void> {
  const current = read(view)
  if (current === null) return
  set(actionError, '')
  try {
    const result = await plugin.request('prompts.save', {
      config: next,
      baseRevision: current.revision
    })
    if (!active) return
    applyView(result)
  } catch (error) {
    if (!active) return
    set(actionError, reasonOf(error))
    refuseWithError(error)
  }
}

/** 恢复一个版本（或默认，`revision: 0`）：产生新版本并回到编辑页（§L.4）。 */
async function restore(revision: number): Promise<void> {
  const current = read(view)
  if (current === null) return
  set(actionError, '')
  set(restoredRevision, null)
  try {
    const next = await plugin.request('prompts.restore', {
      revision,
      baseRevision: current.revision
    })
    if (!active) return
    applyView(next)
    set(chosen, null)
    set(restoredRevision, next.revision)
    set(tab, 'edit')
  } catch (error) {
    if (!active) return
    set(actionError, reasonOf(error))
    refuseWithError(error)
  }
}

/** 「用新默认」：丢掉这一段 override，之后它跟随内置文本（§L.4）。 */
async function adoptDefault(change: PanelPromptChange): Promise<void> {
  const part = read(view)?.parts.find((each) => each.key === change.part)
  if (part === undefined) return
  await writeConfig(clearPart(draftValue, part))
}

/** 「保留我的文本」：把 override 的 base 改成当前默认的键，于是它不再算 `default-updated`。 */
async function keepMine(change: PanelPromptChange): Promise<void> {
  const part = read(view)?.parts.find((each) => each.key === change.part)
  const override = draftValue.overrides?.[change.part]
  if (part === undefined || override === undefined) return
  await writeConfig(setOverride(draftValue, change.part, override.text, part.base))
}

/** 切到全文页时拉一次预览（草稿干净就不用问：已保存的那份就在读数里）。 */
async function showTab(next: string): Promise<void> {
  const value: PromptTab = isPromptTab(next) ? next : 'edit'
  set(tab, value)
  if (value === 'full') await refreshPreview()
}

/** 预览草稿的全文；同一份草稿只问一次（面板不轮询，§M.6）。 */
async function refreshPreview(): Promise<void> {
  const current = read(view)
  if (current === null) return
  if (sameConfig(draftValue, savedValue)) {
    set(preview, null)
    set(previewKey, '')
    return
  }
  const key = JSON.stringify(draftValue)
  if (key === read(previewKey)) return
  const result = await previewDraft(draftValue)
  if (!active) return
  set(preview, result)
  set(previewKey, key)
}

/** 新建一个团队技能（名字先按原样进草稿：名字合不合规由保存时的 worker 判，§L.6）。 */
function addSkill(): void {
  const name = read(newSkillName).trim()
  if (name === '') return
  edit(setSkill(draftValue, name, draftValue.skills?.[name] ?? ''))
  set(newSkillName, '')
}

/** 一个分片在编辑页上的一行：正文、标记、还原本段与两条提示。 */
function PartField(props: {
  readonly locale: string
  readonly part: PanelPromptPart
  readonly config: PanelPromptConfig
}): OrcaElement {
  const { locale, part, config } = props
  const text = partText(config, part)
  const changed = text !== part.text
  return (
    <Stack gap="xs">
      <Row gap="xs" align="center">
        <Text weight="medium" size="sm">
          {part.key}
        </Text>
        {changed ? <MarkBadge label={translate(locale, 'prompt.changed')} tone="accent" /> : null}
      </Row>
      <Textarea
        label={part.key}
        labelHidden
        value={text}
        rows={Math.min(12, Math.max(4, text.split('\n').length + 1))}
        onChange={(next) => edit(setOverride(config, part.key, next, part.base))}
      />
      {changed ? (
        <Row gap="xs">
          <Button variant="ghost" size="sm" onPress={() => edit(clearPart(draftValue, part))}>
            {translate(locale, 'prompt.useDefault', { part: part.key })}
          </Button>
        </Row>
      ) : null}
      {part.placeholders.length === 0 ? null : (
        <Hint text={translate(locale, 'prompt.placeholders', { list: part.placeholders.join(' ') })} />
      )}
      <Hint text={translate(locale, 'prompt.roles', { list: part.roles.join(', ') })} />
      {part.placement === 'skill' ? (
        <Hint text={translate(locale, 'prompt.skillPlacement')} />
      ) : null}
    </Stack>
  )
}

/** 一段团队文本：与内置正文相同就不算改动（保存时 worker 也会这么看）。 */
function TeamField(props: {
  readonly locale: string
  readonly section: 'communication' | 'scope' | 'delivery'
  readonly part: PanelPromptPart | undefined
  readonly config: PanelPromptConfig
}): OrcaElement {
  const { locale, section, part, config } = props
  const text = part === undefined ? teamText(config, section) : partText(config, part)
  const changed = part !== undefined && text !== part.text
  return (
    <Stack gap="xs">
      <Row gap="xs" align="center">
        <Text weight="medium" size="sm">
          {translate(locale, `prompt.section.${section}` as CopyKey)}
        </Text>
        {changed ? <MarkBadge label={translate(locale, 'prompt.changed')} tone="accent" /> : null}
      </Row>
      <Textarea
        label={translate(locale, `prompt.section.${section}` as CopyKey)}
        labelHidden
        value={text}
        rows={4}
        onChange={(next) => edit(setTeamText(config, section, next))}
      />
    </Stack>
  )
}

/** default-updated 的一段：旧默认与新默认都在，两个选择各发一次保存（§L.4）。 */
function DefaultUpdated(props: {
  readonly locale: string
  readonly change: PanelPromptChange
}): OrcaElement {
  const { locale, change } = props
  const removed = change.next === null
  return (
    <Stack gap="xs">
      <Text weight="medium" size="sm">
        {change.part}
      </Text>
      {removed ? <Hint text={translate(locale, 'prompt.removedPart')} /> : null}
      <CodeView
        label={translate(locale, 'prompt.previous')}
        code={change.previous ?? ''}
        maxHeight="sm"
        wrap
      />
      {removed ? null : (
        <CodeView
          label={translate(locale, 'prompt.next')}
          code={change.next ?? ''}
          maxHeight="sm"
          wrap
        />
      )}
      {removed ? null : (
        <Row gap="xs">
          <Button variant="outline" size="sm" onPress={() => void keepMine(change)}>
            {translate(locale, 'prompt.keepMine', { part: change.part })}
          </Button>
          <Button variant="outline" size="sm" onPress={() => void adoptDefault(change)}>
            {translate(locale, 'prompt.adoptDefault', { part: change.part })}
          </Button>
        </Row>
      )}
    </Stack>
  )
}

/** 一条版本的措辞（`修订 N · 来源 · 相对时间`）。 */
function VersionLine(props: {
  readonly locale: string
  readonly version: PanelPromptVersion
}): OrcaElement {
  const { locale, version } = props
  return (
    <Hint
      text={translate(locale, 'prompt.versionLine', {
        revision: version.revision,
        at: version.at,
        origin: translate(locale, `prompt.origin.${version.origin}` as CopyKey)
      })}
    />
  )
}

/** 组内被拒的原因（每行「字段：原因」；面板不解析 worker 的文案）。 */
function IssueCallout(props: {
  readonly locale: string
  readonly issues: readonly PromptIssueText[]
}): OrcaElement | null {
  if (props.issues.length === 0) return null
  return (
    <Callout tone="danger" icon="error" title={translate(props.locale, 'action.save')}>
      <Stack gap="xs">
        {props.issues.map((issue) => (
          <Text key={`${issue.path}:${issue.message}`} size="sm">
            {issue.path === '' ? issue.message : `${issue.path} · ${issue.message}`}
          </Text>
        ))}
      </Stack>
    </Callout>
  )
}

/** 保存栏（§M.3）：草稿为空时不占空间；有改动显示「N changes · Save / Discard」。 */
function SaveBar(props: {
  readonly locale: string
  readonly state: DraftState<PanelPromptConfig>
  readonly limit: number
}): OrcaElement | null {
  const { locale, state } = props
  const bar = saveBar(locale, state, savedValue)
  if (!barShown(bar)) return null
  return (
    <Stack gap="xs">
      <Toolbar label={translate(locale, 'prompt.tab.edit')}>
        <Row gap="xs" align="center">
          {bar.status === undefined ? null : (
            <Text size="sm">{bar.status}</Text>
          )}
          {bar.error === undefined ? null : (
            <Text size="sm" tone="danger">
              {bar.error}
            </Text>
          )}
          {bar.busy ? <Spinner label={translate(locale, 'draft.saving')} labelHidden /> : null}
          <Button
            variant="solid"
            size="sm"
            disabled={!bar.canSave}
            onPress={() => void save()}
          >
            {translate(locale, 'action.save')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={bar.busy}
            onPress={() => set(draft, draftReducer(read(draft), { type: 'discard' }))}
          >
            {translate(locale, 'action.discard')}
          </Button>
          {bar.reload === true ? (
            <Button variant="outline" size="sm" onPress={() => void reloadLatest()}>
              {translate(locale, 'draft.reload')}
            </Button>
          ) : null}
        </Row>
      </Toolbar>
      <Hint text={translate(locale, 'prompt.saveHint', { limit: String(props.limit) })} />
    </Stack>
  )
}

/** 编辑子页：三段团队文本 + 每个分片的 override + 保存栏。 */
function EditTab(props: { readonly locale: string; readonly current: PanelPromptsView }): OrcaElement {
  const { locale, current } = props
  const state = read(draft)
  const config = currentConfig()
  const teamParts = current.sections.map((section) =>
    current.parts.find((part) => part.key === `team/${section}`)
  )
  const parts = current.parts.filter((part) => part.kind !== 'team')
  const issues = issueTexts(locale, read(draftIssues))
  const changed = changedParts(config, current.parts)
  return (
    <Stack gap="md">
      <Stack gap="xs">
        <Hint text={translate(locale, 'prompt.intro')} />
        {current.saved === null ? (
          <Hint text={translate(locale, 'prompt.versionNone')} />
        ) : (
          <VersionLine locale={locale} version={current.saved} />
        )}
        {changed.length === 0 ? null : (
          <Text size="xs" muted>
            {translate(locale, 'prompt.changed')} · {changed.join(', ')}
          </Text>
        )}
      </Stack>
      {current.changes.length === 0 ? null : (
        <Section title={translate(locale, 'prompt.defaultUpdated')} count={current.changes.length}>
          <Stack gap="sm">
            <Hint text={translate(locale, 'prompt.defaultUpdatedIntro')} />
            {current.changes.map((change) => (
              <DefaultUpdated key={change.part} locale={locale} change={change} />
            ))}
          </Stack>
        </Section>
      )}
      <Section title={translate(locale, 'prompt.team')}>
        <Stack gap="sm">
          <Hint text={translate(locale, 'prompt.teamIntro')} />
          {current.sections.map((section, index) => (
            <TeamField
              key={section}
              locale={locale}
              section={section}
              part={teamParts[index]}
              config={config}
            />
          ))}
        </Stack>
      </Section>
      <Section title={translate(locale, 'prompt.parts')} count={parts.length}>
        <Stack gap="md">
          <Hint text={translate(locale, 'prompt.partsIntro')} />
          {parts.map((part) => (
            <PartField key={part.key} locale={locale} part={part} config={config} />
          ))}
        </Stack>
      </Section>
      <IssueCallout locale={locale} issues={issues} />
      <SaveBar locale={locale} state={state} limit={current.maxChars} />
      {read(actionError) === '' ? null : (
        <Text size="xs" tone="danger">
          {read(actionError)}
        </Text>
      )}
      {read(restoredRevision) === null ? null : (
        <Text size="xs" tone="success">
          {translate(locale, 'prompt.restored', { revision: read(restoredRevision) ?? 0 })}
        </Text>
      )}
    </Stack>
  )
}

/** 全文子页：`CodeView` 的全文 + 与两个基准之一的 diff（§M.3）。 */
function FullTab(props: { readonly locale: string; readonly current: PanelPromptsView }): OrcaElement {
  const { locale, current } = props
  const draftPreview = read(preview)
  const chosenRole = currentRole()
  const base = currentBaseline()
  const draftTexts: PanelPromptTexts | null =
    draftPreview !== null && draftPreview.ok ? draftPreview.texts : null
  const texts = draftTexts ?? current.texts.saved
  const baseTexts = base === 'default' ? current.texts.defaults : current.texts.saved
  const text = textOf(texts, chosenRole)
  const baseText = textOf(baseTexts, chosenRole)
  const roleLabel = translate(locale, `prompt.role.${chosenRole}` as CopyKey)
  const baseLabel = translate(locale, `prompt.base.${base}` as CopyKey)
  return (
    <Stack gap="md">
      <Hint text={translate(locale, 'prompt.full.intro')} />
      <RadioGroup
        label={translate(locale, 'prompt.full.baseline')}
        value={base}
        orientation="horizontal"
        options={PROMPT_DIFF_BASES.map((value) => ({
          value,
          label: translate(locale, `prompt.base.${value}` as CopyKey)
        }))}
        onChange={(next) => {
          if (isPromptDiffBase(next)) {
            set(baseline, next)
            void refreshPreview()
          }
        }}
      />
      <RadioGroup
        label={translate(locale, 'prompt.full.role')}
        value={chosenRole}
        orientation="horizontal"
        options={[
          { value: 'orchestrator', label: translate(locale, 'prompt.role.orchestrator') },
          { value: 'worker', label: translate(locale, 'prompt.role.worker') }
        ]}
        onChange={(next) => set(role, next === 'worker' ? 'worker' : 'orchestrator')}
      />
      {draftPreview !== null && !draftPreview.ok ? (
        <IssueCallout locale={locale} issues={issueTexts(locale, draftPreview.issues)} />
      ) : null}
      <CodeView
        label={translate(locale, 'prompt.full.text', { role: roleLabel })}
        code={text}
        language="markdown"
        lineNumbers
        maxHeight="lg"
      />
      <CodeView
        label={translate(locale, 'prompt.diffAgainst', { base: baseLabel })}
        code={diffText(lineDiff(baseText, text), locale)}
        lineNumbers
        maxHeight="lg"
      />
      {text === baseText ? <Hint text={translate(locale, 'prompt.sameAsSaved')} /> : null}
    </Stack>
  )
}

/** 历史子页：版本列表 + 恢复某个版本（§L.4：再存一个新版本，回到编辑页）。 */
function HistoryTab(props: { readonly locale: string; readonly current: PanelPromptsView }): OrcaElement {
  const { locale, current } = props
  const selected = read(chosen)
  const rows: readonly TableRow[] = current.history.map((version) => ({
    key: String(version.revision),
    cells: {
      revision: version.revision,
      origin: translate(locale, `prompt.origin.${version.origin}` as CopyKey),
      at: { type: 'relative', at: Date.parse(version.at) }
    }
  }))
  return (
    <Stack gap="md">
      <Hint text={translate(locale, 'prompt.history.intro')} />
      <Table
        label={translate(locale, 'prompt.tab.history')}
        columns={[
          { key: 'revision', label: translate(locale, 'column.revision'), width: 'sm' },
          { key: 'origin', label: translate(locale, 'column.origin'), width: 'sm' },
          { key: 'at', label: translate(locale, 'column.at') }
        ]}
        rows={rows}
        emptyText={translate(locale, 'prompt.history.empty')}
        onRowAction={(row) => set(chosen, Number(row.key))}
      />
      {selected === null ? null : (
        <Stack gap="xs">
          <Text size="sm">
            {translate(locale, 'column.revision')} {selected}
          </Text>
          <Hint text={translate(locale, 'prompt.restoreHint')} />
          <Row gap="xs">
            <Button variant="outline" size="sm" icon="refresh" onPress={() => void restore(selected)}>
              {translate(locale, 'prompt.restore')}
            </Button>
          </Row>
        </Stack>
      )}
      {read(actionError) === '' ? null : (
        <Text size="xs" tone="danger">
          {read(actionError)}
        </Text>
      )}
    </Stack>
  )
}

/** 一个技能的路径行（稳定约定：`<stateDir>/skills/<name>/SKILL.md`）。 */
function SkillPath(props: { readonly locale: string; readonly path: string }): OrcaElement {
  return <Hint text={translate(props.locale, 'prompt.skills.path', { path: props.path })} />
}

/** 技能子页：内置只读 + 团队技能增删改（每次改动都是同一份配置的草稿）。 */
function SkillsTab(props: { readonly locale: string; readonly current: PanelPromptsView }): OrcaElement {
  const { locale, current } = props
  const config = currentConfig()
  const builtIn = current.skills.filter((skill) => skill.readOnly)
  const team = teamSkillNames(config)
  const state = read(draft)
  return (
    <Stack gap="md">
      <Hint text={translate(locale, 'prompt.skills.intro')} />
      <Section title={translate(locale, 'prompt.skills.builtIn')} count={builtIn.length}>
        <Stack gap="sm">
          {builtIn.map((skill) => (
            <Stack key={skill.name} gap="xs">
              <Text weight="medium" size="sm">
                {skill.name}
              </Text>
              <SkillPath locale={locale} path={skill.path} />
              <Collapsible title={translate(locale, 'prompt.skills.text', { name: skill.name })}>
                <CodeView code={skill.text} language="markdown" wrap maxHeight="sm" />
              </Collapsible>
            </Stack>
          ))}
        </Stack>
      </Section>
      <Section title={translate(locale, 'prompt.skills.team')} count={team.length}>
        <Stack gap="sm">
          {team.length === 0 ? <Hint text={translate(locale, 'prompt.skills.empty')} /> : null}
          {team.map((name) => (
            <Stack key={name} gap="xs">
              <Text weight="medium" size="sm">
                {name}
              </Text>
              <SkillPath
                locale={locale}
                path={
                  current.skills.find((skill) => skill.name === name)?.path ?? skillPath(current.stateDir, name)
                }
              />
              <Textarea
                label={name}
                labelHidden
                value={config.skills?.[name] ?? ''}
                rows={6}
                onChange={(next) => edit(setSkill(draftValue, name, next))}
              />
              <Row gap="xs">
                <Button variant="ghost" size="sm" onPress={() => edit(removeSkill(draftValue, name))}>
                  {translate(locale, 'prompt.skills.remove', { name })}
                </Button>
              </Row>
            </Stack>
          ))}
          <Row gap="xs" align="end">
            <Input
              label={translate(locale, 'prompt.skills.name')}
              value={read(newSkillName)}
              onChange={(next) => set(newSkillName, next)}
            />
            <Button variant="outline" size="sm" icon="add" onPress={addSkill}>
              {translate(locale, 'prompt.skills.add')}
            </Button>
          </Row>
          <Hint text={translate(locale, 'prompt.skills.nameHint')} />
        </Stack>
      </Section>
      <IssueCallout locale={locale} issues={issueTexts(locale, read(draftIssues))} />
      <SaveBar locale={locale} state={state} limit={current.maxChars} />
      {read(actionError) === '' ? null : (
        <Text size="xs" tone="danger">
          {read(actionError)}
        </Text>
      )}
    </Stack>
  )
}

/** 组内正文：四个子页各一段（只有当前子页画内容，隐藏页不占位置）。 */
function TabBody(props: {
  readonly locale: string
  readonly current: PromptTab
  readonly shown: PromptTab
  readonly view: PanelPromptsView
}): OrcaElement {
  if (props.current !== props.shown) return <Stack gap="sm" />
  if (props.shown === 'full') return <FullTab locale={props.locale} current={props.view} />
  if (props.shown === 'history') return <HistoryTab locale={props.locale} current={props.view} />
  if (props.shown === 'skills') return <SkillsTab locale={props.locale} current={props.view} />
  return <EditTab locale={props.locale} current={props.view} />
}

/** Prompts 组：读不到时是错误态，读到之前是加载态；读到之后是四个子页。 */
export function Prompts(props: { readonly locale: string }): OrcaElement {
  const locale = props.locale
  const current = read(view)
  const stage = read(phase)
  if (stage === 'error') {
    return (
      <ErrorState
        title={translate(locale, 'boot.unavailable')}
        reason={read(reason)}
        locale={locale}
        onRetry={() => void openPrompts()}
      />
    )
  }
  if (current === null) {
    return stage === 'loading' ? (
      <LoadingState label={translate(locale, 'state.loading')} />
    ) : (
      <BootingState text={word(locale, 'boot.starting')} />
    )
  }
  const shown = currentTab()
  return (
    <Tabs
      label={translate(locale, 'prompt.tabs')}
      value={shown}
      onChange={(next) => void showTab(next)}
    >
      {PROMPT_TABS.map((value) => (
        <Tab
          key={value}
          value={value}
          label={translate(locale, `prompt.tab.${value}` as CopyKey)}
        >
          <TabBody locale={locale} current={shown} shown={value} view={current} />
        </Tab>
      ))}
    </Tabs>
  )
}

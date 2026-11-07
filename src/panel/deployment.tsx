// Deployment 组（§M.3 Deployment、§N.4 health 明细、§G.2 的 doctor、§H 的已知限制）。
//
// 数据走面板协议（`src/panel/protocol.ts` 的 `deployment`/`doctor`/`setupCheck`/`rotateToken`/
// `restartRouter` 与已有的 `pause`）：面板不轮询，打开这一页时读一次，动作后再读一次。
// 破坏性动作一律走 `widgets.tsx` 的行内二次确认（§M.2；没有 Modal，也不调浏览器 confirm）。
//
// 本文件只管「怎么读、怎么画」：摘要行由 worker 的 `deploymentView` 拼好，健康分组是
// `health-groups.ts` 的纯函数；页面不 import worker（§C.2 规则 3）。
import {
  atom,
  Button,
  Callout,
  Code,
  KeyValue,
  plugin,
  read,
  RelativeTime,
  Row,
  set,
  Stack,
  Switch,
  Table,
  Text,
  type KeyValueItem,
  type OrcaElement,
  type OrcaNode
} from 'orca'
import { COPY, translate, type CopyKey } from './copy'
import { groupHealth } from './health-groups'
import { LIMITATIONS } from './limitations'
import { healthMark, markLabel } from './marks'
import type { DeploymentSetupIssue, DeploymentView, DoctorView } from './protocol'
import {
  BootingState,
  ConfirmAction,
  ErrorState,
  Hint,
  LoadingState,
  MarkBadge,
  Section,
  word
} from './widgets'

/** 最近一份部署读数；`null` 表示还没读到。 */
const deployment = atom<DeploymentView | null>(null)

/** 读取阶段：`idle` 还没问 / `loading` 正在问 / `ready` 有读数 / `error` 读不到。 */
type Phase = 'idle' | 'loading' | 'ready' | 'error'
const phase = atom<Phase>('idle')

/** 读不到时的原因（错误态要给出原因）。 */
const reason = atom('')

/** 暂停开关这一处的结果：失败时把原因放在开关下面（不替换整页）。 */
const actionError = atom('')

/** 「检查一次」是否正在跑。 */
const checking = atom(false)

/** 「检查一次」被拒绝的结论：本来就没有可重跑的问题（`checked: false`）。 */
const setupNote = atom<'' | 'nothing'>('')

/** 「检查一次」失败的原因（不替换整页）。 */
const setupError = atom('')

/** 重启 Router 的结论（一行提示；失败进 `actionError`）。 */
const routerNote = atom('')

/** 最近一份 doctor 结果；`null` 表示还没跑。 */
const doctor = atom<DoctorView | null>(null)

/** doctor 的读取阶段（它与部署读数是两条请求：诊断真的会跑子进程）。 */
const doctorPhase = atom<Phase>('idle')

/** doctor 读不到时的原因。 */
const doctorReason = atom('')

/** 轮换后得到的 token 文件路径（不给值）。 */
const tokenFile = atom('')

/** 这一页是否还在面板上：晚到的响应不再改状态。 */
let active = false

/** 错误对象的可读原因。 */
function reasonOf(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  return String(error)
}

/** 读一份部署读数。失败给出原因；成功清掉原因。 */
export async function loadDeployment(): Promise<void> {
  if (!active) return
  set(phase, 'loading')
  try {
    const next = await plugin.request('deployment')
    if (!active) return
    set(deployment, next)
    set(phase, 'ready')
    set(reason, '')
  } catch (error) {
    if (!active) return
    set(reason, reasonOf(error))
    set(phase, 'error')
  }
}

/** 跑一次 doctor（§G.2）：它会真的跑 `gh`/`lark-cli`，所以只在人打开这页或按按钮时跑。 */
export async function loadDoctor(): Promise<void> {
  if (!active) return
  set(doctorPhase, 'loading')
  try {
    const next = await plugin.request('doctor')
    if (!active) return
    set(doctor, next)
    set(doctorPhase, 'ready')
    set(doctorReason, '')
  } catch (error) {
    if (!active) return
    set(doctorReason, reasonOf(error))
    set(doctorPhase, 'error')
  }
}

/**
 * 打开这一页：读一次部署读数，再跑一次诊断。
 * 由面板的页头与导航调用——渲染里不发请求（写 atom 在渲染中会抛）。
 */
export async function openDeployment(): Promise<void> {
  active = true
  await loadDeployment()
  await loadDoctor()
}

/** 卸载面板时调用：之后的响应不再写状态。 */
export function resetDeployment(): void {
  active = false
  set(phase, 'idle')
  set(deployment, null)
  set(reason, '')
  set(actionError, '')
  set(checking, false)
  set(setupNote, '')
  set(setupError, '')
  set(routerNote, '')
  set(doctor, null)
  set(doctorPhase, 'idle')
  set(doctorReason, '')
  set(tokenFile, '')
}

/** 「检查一次」（§G.2 的 `setup check`）：重跑探针，再读一份部署读数。 */
async function checkAgain(): Promise<void> {
  set(checking, true)
  set(setupError, '')
  set(setupNote, '')
  try {
    const outcome = await plugin.request('setupCheck')
    if (!active) return
    if (!outcome.checked) set(setupNote, 'nothing')
    await loadDeployment()
  } catch (error) {
    if (!active) return
    set(setupError, reasonOf(error))
  } finally {
    if (active) set(checking, false)
  }
}

/** 写暂停状态；失败只在这一处说（不把整页换成错误态）。 */
async function writePaused(paused: boolean): Promise<void> {
  set(actionError, '')
  try {
    await plugin.request('pause', { paused })
    await loadDeployment()
  } catch (error) {
    set(actionError, reasonOf(error))
  }
}

/** 一串限额 → `KeyValue` 的行（数值按原样显示，不做本地化数字格式）。 */
function limitItems(locale: string, view: DeploymentView): readonly KeyValueItem[] {
  const limits = view.limits
  return [
    { label: translate(locale, 'deployment.limit.promptMaxChars'), value: String(limits.promptMaxChars) },
    {
      label: translate(locale, 'deployment.limit.admissionContextMaxPages'),
      value: String(limits.admissionContextMaxPages)
    },
    {
      label: translate(locale, 'deployment.limit.admissionContextTimeoutMs'),
      value: String(limits.admissionContextTimeoutMs)
    },
    { label: translate(locale, 'deployment.limit.retentionDays'), value: String(limits.retentionDays) }
  ]
}

/** 一条 setup 问题的所属部件（面板按地方说事，技术码原样显示）。 */
function placeLabel(locale: string, place: string): string {
  const key = `deployment.place.${place}` as CopyKey
  return key in COPY ? translate(locale, key) : place
}

/** 一条 setup 问题：现状 + 修法 + 重跑入口，全部在人能照做的那一面上。 */
function SetupProblemRow(props: {
  readonly locale: string
  readonly issue: DeploymentSetupIssue
}): OrcaElement {
  const locale = props.locale
  const issue = props.issue
  return (
    <Callout
      tone={issue.kind === 'broken' ? 'danger' : 'warning'}
      icon={issue.kind === 'broken' ? 'error' : 'warning'}
      title={`${placeLabel(locale, issue.place)} · ${issue.code}`}
    >
      <Stack gap="xs">
        <Text size="sm">{issue.detail}</Text>
        <Text size="sm">{translate(locale, 'deployment.fix', { fix: issue.fix })}</Text>
        <Row gap="xs" align="center" wrap>
          <Text muted size="xs">
            {translate(locale, 'deployment.checkAgainCommand')}
          </Text>
          <Code>{issue.checkAgain}</Code>
        </Row>
      </Stack>
    </Callout>
  )
}

/** 部署检查：逐条问题 + 「检查一次」；没有问题就说通过（不画一个无用的按钮）。 */
function SetupSection(props: { readonly locale: string; readonly view: DeploymentView }): OrcaElement {
  const locale = props.locale
  const view = props.view
  const note = read(setupNote)
  return (
    <Section title={translate(locale, 'deployment.setup')} count={view.setup.length}>
      <Stack gap="sm">
        <Hint text={translate(locale, 'deployment.setupIntro')} />
        {view.setup.length === 0 ? (
          <Text size="sm" tone="success">
            {translate(locale, 'deployment.setupPassed')}
          </Text>
        ) : (
          <Stack gap="xs">
            {view.setup.map((issue) => (
              <SetupProblemRow key={`${issue.place}:${issue.code}`} locale={locale} issue={issue} />
            ))}
            <Row gap="xs">
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
          </Stack>
        )}
        {note === 'nothing' ? <Hint text={translate(locale, 'deployment.nothingToCheck')} /> : null}
        {read(setupError) === '' ? null : (
          <Text tone="danger" size="xs">
            {read(setupError)}
          </Text>
        )}
      </Stack>
    </Section>
  )
}

/** 健康明细：按部件分组，每条给名字、四档状态与明细（明细里带计数）。 */
function HealthSection(props: { readonly locale: string; readonly view: DeploymentView }): OrcaElement {
  const locale = props.locale
  const groups = groupHealth(props.view.health)
  return (
    <Section title={translate(locale, 'deployment.health')} count={props.view.health.length}>
      <Stack gap="sm">
        <Hint text={translate(locale, 'deployment.healthIntro')} />
        {groups.map((group) => (
          <Stack key={group.key} gap="xs">
            <Text weight="medium" size="sm">
              {translate(locale, group.labelKey)} · {group.entries.length}
            </Text>
            {group.entries.map((entry) => {
              const mark = healthMark(entry.state)
              return (
                <Row key={entry.name} gap="xs" align="center" wrap>
                  <Code>{entry.name}</Code>
                  <MarkBadge label={markLabel(locale, mark)} tone={mark.tone} />
                  <Text muted size="xs">
                    {entry.detail ?? translate(locale, 'state.empty')}
                  </Text>
                </Row>
              )
            })}
          </Stack>
        ))}
      </Stack>
    </Section>
  )
}

/** 状态目录：只读展示（可选中复制的文本）+ 修改入口与重启说明。 */
function StateDirectory(props: { readonly locale: string; readonly view: DeploymentView }): OrcaElement {
  const locale = props.locale
  return (
    <Section title={translate(locale, 'deployment.stateDir')}>
      <Stack gap="xs">
        {/* 路径是可选中的一段代码：宿主没有剪贴板 API，选中即复制（不需要一颗假按钮）。 */}
        <Code block>{props.view.stateDir}</Code>
        <Hint text={translate(locale, 'deployment.stateDirReadOnly')} />
        <Hint text={translate(locale, 'deployment.stateDirChange')} />
      </Stack>
    </Section>
  )
}

/** 重启 Router（§F.1、§F.5）：破坏性，面板先做行内二次确认；重启后重读读数。 */
async function restartRouter(): Promise<void> {
  set(actionError, '')
  set(routerNote, '')
  try {
    await plugin.request('restartRouter')
    if (!active) return
    set(routerNote, 'restarted')
    await loadDeployment()
  } catch (error) {
    if (!active) return
    set(actionError, reasonOf(error))
  }
}

/** 一条事实：小标签 + 一个值（值可以是 Code、RelativeTime 或 Text）。 */
function Fact(props: { readonly label: string; readonly children: OrcaNode }): OrcaElement {
  return (
    <Stack gap="none">
      <Text muted size="xs">
        {props.label}
      </Text>
      {props.children}
    </Stack>
  )
}

/** Router 状态（§F.1）：状态、终端、起始时间、重启次数与一个需确认的重启。 */
function RouterSection(props: { readonly locale: string; readonly view: DeploymentView }): OrcaElement {
  const locale = props.locale
  const router = props.view.router
  const mark = healthMark(router.state)
  const startedAt = router.startedAt === null ? null : Date.parse(router.startedAt)
  return (
    <Section title={translate(locale, 'deployment.router')}>
      <Stack gap="sm">
        <Hint text={translate(locale, 'deployment.routerIntro')} />
        <Row gap="xs" align="center" wrap>
          <MarkBadge label={markLabel(locale, mark)} tone={mark.tone} />
          <Text muted size="xs">
            {router.detail}
          </Text>
        </Row>
        <Row gap="md" wrap>
          <Fact label={translate(locale, 'deployment.routerTerminal')}>
            <Code>{router.terminalId ?? translate(locale, 'deployment.empty')}</Code>
          </Fact>
          <Fact label={translate(locale, 'deployment.routerSince')}>
            {startedAt === null || !Number.isFinite(startedAt) ? (
              <Text size="sm">{translate(locale, 'deployment.empty')}</Text>
            ) : (
              <RelativeTime at={startedAt} format="short" />
            )}
          </Fact>
          <Fact label={translate(locale, 'deployment.routerRestarts')}>
            <Text size="sm">{router.restarts}</Text>
          </Fact>
        </Row>
        {router.lastError === null ? null : (
          <Text tone="danger" size="xs">
            {translate(locale, 'deployment.routerLastError')} · {router.lastError}
          </Text>
        )}
        {read(routerNote) === '' ? null : (
          <Text size="xs" tone="success">
            {translate(locale, 'deployment.routerRestarted')}
          </Text>
        )}
        <ConfirmAction
          id="restart-router"
          label={translate(locale, 'deployment.routerRestart')}
          action={translate(locale, 'deployment.routerRestart')}
          locale={locale}
          icon="refresh"
          onConfirm={() => void restartRouter()}
        />
      </Stack>
    </Section>
  )
}

/** doctor 的三档计数（一句话）。 */
function doctorSummary(locale: string, view: DoctorView): string {
  return translate(locale, 'deployment.doctorSummary', {
    ok: view.summary.ok,
    warn: view.summary.warn,
    fail: view.summary.fail
  })
}

/// 诊断结果（§G.2）：三档计数 + 每个检查项一行（结论与下一步都写在同一格里）。
function DoctorSection(props: { readonly locale: string; readonly view: DeploymentView }): OrcaElement {
  const locale = props.locale
  const result = read(doctor)
  const stage = read(doctorPhase)
  const running = stage === 'loading'
  const rows =
    result === null
      ? []
      : result.checks.map((check) => ({
          key: check.name,
          cells: {
            check: check.name,
            state: translate(locale, `deployment.doctorState.${check.state}` as CopyKey),
            detail: check.hint === undefined ? check.detail : `${check.detail} — ${check.hint}`
          }
        }))
  return (
    <Section title={translate(locale, 'deployment.doctor')}>
      <Stack gap="sm">
        <Hint text={translate(locale, 'deployment.doctorIntro')} />
        {stage === 'error' ? (
          <Callout tone="danger" icon="error" title={translate(locale, 'deployment.doctor')}>
            <Stack gap="sm">
              <Text size="sm">
                {translate(locale, 'deployment.doctorFailed', { reason: read(doctorReason) })}
              </Text>
              <Row gap="xs">
                <Button variant="outline" size="sm" icon="refresh" onPress={() => void loadDoctor()}>
                  {translate(locale, 'deployment.doctorRun')}
                </Button>
              </Row>
            </Stack>
          </Callout>
        ) : null}
        {result === null ? null : (
          <Stack gap="sm">
            <Text size="sm">{doctorSummary(locale, result)}</Text>
            <Table
              label={translate(locale, 'deployment.doctor')}
              columns={[
                { key: 'check', label: translate(locale, 'deployment.doctorCheck') },
                { key: 'state', label: translate(locale, 'column.state'), width: 'sm' },
                { key: 'detail', label: translate(locale, 'deployment.doctorDetail') }
              ]}
              rows={rows}
              loading={running}
              emptyText={translate(locale, 'state.empty')}
            />
            <Hint text={result.note} />
          </Stack>
        )}
        <Row gap="xs">
          <Button
            variant="outline"
            size="sm"
            icon="refresh"
            disabled={running}
            onPress={() => void loadDoctor()}
          >
            {running
              ? translate(locale, 'deployment.doctorRunning')
              : translate(locale, 'deployment.doctorRun')}
          </Button>
        </Row>
      </Stack>
    </Section>
  )
}

/** 机器限额：四个数值（本机设置；这里只读）。 */
function Limits(props: { readonly locale: string; readonly view: DeploymentView }): OrcaElement {
  const locale = props.locale
  return (
    <Section title={translate(locale, 'deployment.limits')}>
      <Stack gap="xs">
        <KeyValue label={translate(locale, 'deployment.limits')} items={limitItems(locale, props.view)} />
        <Hint text={translate(locale, 'deployment.limitsIntro')} />
      </Stack>
    </Section>
  )
}

/** 暂停开关（§K.6：与 Overview 的暂停是同一个写者）。 */
function PausedSwitch(props: { readonly locale: string; readonly view: DeploymentView }): OrcaElement {
  const locale = props.locale
  return (
    <Section title={translate(locale, 'deployment.paused')}>
      <Stack gap="xs">
        <Row gap="sm" align="center">
          <Switch
            label={translate(locale, 'deployment.paused')}
            checked={props.view.paused}
            onChange={(checked) => void writePaused(checked)}
          />
          {props.view.paused ? (
            <MarkBadge label={translate(locale, 'processing.paused')} tone="warning" />
          ) : null}
        </Row>
        <Hint text={translate(locale, 'deployment.pausedHint')} />
        {read(actionError) === '' ? null : (
          <Text tone="danger" size="xs">
            {read(actionError)}
          </Text>
        )}
      </Stack>
    </Section>
  )
}

/** 轮换主 token（§D.6、§O）：破坏性，面板先做行内二次确认；只显示文件路径。 */
async function rotateToken(): Promise<void> {
  set(actionError, '')
  set(tokenFile, '')
  try {
    const result = await plugin.request('rotateToken')
    if (!active) return
    set(tokenFile, result.tokenFile)
  } catch (error) {
    if (!active) return
    set(actionError, reasonOf(error))
  }
}

/** 主 token（§D.6）：它保护 loopback API；轮换是破坏性动作，只报告文件、不报告值。 */
function TokenSection(props: { readonly locale: string }): OrcaElement {
  const locale = props.locale
  const file = read(tokenFile)
  return (
    <Section title={translate(locale, 'deployment.token')}>
      <Stack gap="sm">
        <Hint text={translate(locale, 'deployment.tokenIntro')} />
        {file === '' ? null : (
          <Text size="sm" tone="success">
            {translate(locale, 'deployment.rotated', { file })}
          </Text>
        )}
        <Hint text={translate(locale, 'deployment.tokenValueHidden')} />
        <ConfirmAction
          id="rotate-token"
          label={translate(locale, 'deployment.rotateToken')}
          action={translate(locale, 'deployment.rotateToken')}
          locale={locale}
          icon="refresh"
          onConfirm={() => void rotateToken()}
        />
      </Stack>
    </Section>
  )
}

/** 已知限制（§A.3）：十一项只能近似的能力，逐条给影响与差异表的行号。 */
function LimitationsSection(props: { readonly locale: string }): OrcaElement {
  const locale = props.locale
  return (
    <Section title={translate(locale, 'deployment.limitations')} count={LIMITATIONS.length}>
      <Stack gap="sm">
        <Hint text={translate(locale, 'limitation.intro')} />
        {LIMITATIONS.map((item, index) => (
          <Stack key={item.id} gap="xs">
            <Text weight="medium" size="sm">
              {index + 1}. {translate(locale, item.titleKey)}
            </Text>
            <Text size="sm">{translate(locale, item.impactKey)}</Text>
            <Text muted size="xs">
              {item.refs.join(' · ')}
            </Text>
          </Stack>
        ))}
      </Stack>
    </Section>
  )
}

/**
 * Deployment 组：读不到时是错误态，读到之前是加载态；读到之后按块渲染。
 * `limitsEditor` 由 Settings 页传入（#42 起机器限额可编辑，走同一套保存栏）；
 * 不传时保留 #47 的只读事实表（直接挂载这一组的测试仍读同一份读数）。
 */
export function Deployment(props: {
  readonly locale: string
  readonly limitsEditor?: OrcaNode
}): OrcaElement {
  const locale = props.locale
  const view = read(deployment)
  const stage = read(phase)
  if (stage === 'error') {
    return (
      <ErrorState
        title={translate(locale, 'boot.unavailable')}
        reason={read(reason)}
        locale={locale}
        onRetry={() => void openDeployment()}
      />
    )
  }
  if (view === null) {
    return stage === 'loading' ? (
      <LoadingState label={translate(locale, 'state.loading')} />
    ) : (
      <BootingState text={word(locale, 'boot.starting')} />
    )
  }
  return (
    <Stack gap="md">
      <Section title={translate(locale, 'deployment.title')}>
        <Hint text={translate(locale, 'deployment.intro')} />
      </Section>
      <SetupSection locale={locale} view={view} />
      <StateDirectory locale={locale} view={view} />
      {props.limitsEditor ?? <Limits locale={locale} view={view} />}
      <PausedSwitch locale={locale} view={view} />
      <HealthSection locale={locale} view={view} />
      <RouterSection locale={locale} view={view} />
      <DoctorSection locale={locale} view={view} />
      <TokenSection locale={locale} />
      <LimitationsSection locale={locale} />
    </Stack>
  )
}

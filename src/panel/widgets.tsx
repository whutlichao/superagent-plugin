// 页面壳的公共零件（§M.2 的三态、§M.4 的组件选型、§M.2 的行内二次确认）。
// 只用 Orca 的语义组件；没有 Modal、没有浏览器 confirm（面板无 DOM）。
// 组件返回 JSX，页面票直接组合它们。
import {
  atom,
  Badge,
  Button,
  Callout,
  EmptyState,
  Heading,
  Progress,
  read,
  RelativeTime,
  Row,
  set,
  Skeleton,
  Stack,
  Text,
  type IconName,
  type OrcaElement,
  type OrcaNode
} from 'orca'
import { translate, type CopyKey, type CopyValues } from './copy'
import type { MarkTone } from './marks'

/** 当前打开的确认态（§M.2 的 `confirming: <key|null>`）；同一时刻只有一处。 */
const confirming = atom<string | null>(null)

/** 把文案表里的键渲染成文字（页面代码读起来像文案表，不出现裸字符串）。 */
export function word(locale: string, key: CopyKey, values?: CopyValues): string {
  return translate(locale, key, values)
}

/**
 * 页头：标题 + 副标题 + 右侧动作。标题是文档的一级标题（宿主 `Heading level=1`）。
 * 行允许换行：320–370px 的面板上，副标题与右侧动作挤不进一行时换行，而不是把整页撑出
 * 横向滚动条。
 */
export function PageHeader(props: {
  readonly title: string
  readonly subtitle?: string
  readonly actions?: OrcaNode
}): OrcaElement {
  return (
    <Row justify="between" align="start" gap="sm" wrap>
      <Stack gap="xs">
        <Heading level={1}>{props.title}</Heading>
        {props.subtitle === undefined ? null : (
          <Text muted size="xs">
            {props.subtitle}
          </Text>
        )}
      </Stack>
      {props.actions === undefined ? null : props.actions}
    </Row>
  )
}

/**
 * 加载态（§M.2 每页的 Skeleton×3 + Progress）：三个骨架块加一条进度条，
 * 让人知道「正在读」而不是「没有东西」。
 */
export function LoadingState(props: { readonly label: string }): OrcaElement {
  return (
    <Stack gap="sm">
      <Skeleton lines={1} label={props.label} />
      <Skeleton lines={1} />
      <Skeleton lines={1} />
      <Progress label={props.label} labelHidden />
    </Stack>
  )
}

/** 空态：一句「没什么」加可选的下一步。 */
export function EmptyStateBlock(props: {
  readonly title: string
  readonly description?: string
  readonly icon?: IconName
  readonly action?: OrcaNode
}): OrcaElement {
  return (
    <Stack gap="sm">
      <EmptyState
        title={props.title}
        {...(props.description === undefined ? {} : { description: props.description })}
        {...(props.icon === undefined ? {} : { icon: props.icon })}
      />
      {props.action === undefined ? null : props.action}
    </Stack>
  )
}

/**
 * 错误态（§M.2）：给出原因与重试入口。重试只再问一次，不重启 worker
 * （§M.6 的「只重试一次」说的是冷启动）。
 */
export function ErrorState(props: {
  readonly title: string
  readonly reason: string
  readonly locale: string
  readonly onRetry: () => void
}): OrcaElement {
  return (
    <Callout tone="danger" title={props.title} icon="error">
      <Stack gap="sm">
        <Text size="sm">{translate(props.locale, 'state.errorHint', { reason: props.reason })}</Text>
        <Row gap="xs">
          <Button variant="outline" size="sm" icon="refresh" onPress={props.onRetry}>
            {translate(props.locale, 'state.retry')}
          </Button>
        </Row>
      </Stack>
    </Callout>
  )
}

/** 启动中：worker 还没应答时的安静提示（不是错误）。 */
export function BootingState(props: { readonly text: string; readonly detail?: string }): OrcaElement {
  return (
    <Callout tone="neutral" icon="info" title={props.text}>
      {props.detail === undefined ? null : (
        <Text size="sm" muted>
          {props.detail}
        </Text>
      )}
    </Callout>
  )
}

/** 一张「组」：二级标题 + 可选计数 + 内容（Overview 的四个区块都用它）。 */
export function Section(props: {
  readonly title: string
  readonly count?: number
  readonly children?: OrcaNode
}) {
  const title = props.count === undefined ? props.title : `${props.title} · ${props.count}`
  return (
    <Stack gap="xs">
      {/* 宿主的 level 2 就是 `text-sm font-semibold`：换成语义标题不改变字号与层次。 */}
      <Heading level={2}>{title}</Heading>
      {props.children}
    </Stack>
  )
}

/** 一行提示（§M.4：页面说明一句话）。 */
export function Hint(props: { readonly text: string }): OrcaElement {
  return (
    <Text muted size="xs">
      {props.text}
    </Text>
  )
}

/**
 * 一次动作或一处读数的行内失败（§M.2 的行内错误）：图标 + 一句话 + 可选的重试。
 *
 * 全站只有这一种失败形态：整页读不到用 `ErrorState`（Callout），页内某处失败用这里。
 * 文案要求指出下一步（重试 / 去设置 / 查看终端）——面板不猜原因，也不把「下一步」留给
 * 人去想。
 */
export function InlineError(props: {
  readonly text: string
  readonly locale: string
  readonly onRetry?: () => void
}): OrcaElement {
  return (
    // 组件面没有独立的 `Icon`：`Callout` 的 `icon` 是宿主唯一能画图标的通道。
    <Callout tone="danger" icon="error">
      <Row gap="xs" align="center" wrap>
        <Text size="sm">{props.text}</Text>
        {props.onRetry === undefined ? null : (
          <Button variant="ghost" size="sm" icon="refresh" onPress={props.onRetry}>
            {translate(props.locale, 'state.retry')}
          </Button>
        )}
      </Row>
    </Callout>
  )
}

/** 相对时间：绝不自己计时，交给宿主的 `RelativeTime`（§M.6）。 */
export function At(props: { readonly at: number; readonly format?: 'long' | 'short' | 'duration' }) {
  return <RelativeTime at={props.at} format={props.format ?? 'short'} />
}

/** 一个状态的标记：图标 + 文案，语气由 `marks.ts` 决定（`<Badge tone>`）。 */
export function MarkBadge(props: { readonly label: string; readonly tone: MarkTone }) {
  return <Badge tone={props.tone}>{props.label}</Badge>
}

/**
 * 行内二次确认（§M.2）：点动作后该处换成 `Callout tone="warning"` + 确认 / 取消，
 * **没有模态框**，也不调用浏览器 `confirm()`（面板无 DOM）。状态是面板级 atom
 * （`confirming: key | null`），因此同一时刻只有一处确认态。
 *
 * 确认对话必须携带信息（§M.2 的确认约定）：标题点名动作与对象，正文写一句可判断的后果，
 * 确认按钮是动词 + 对象（「停止工单」「移除 worktree」），不再是「确定」。
 * 语气由调用方给：只有停止工单、移除 worktree、取消订阅、不再提示这四类破坏性动作传
 * `tone="danger"`；恢复处理、暂停处理、重启 Router、轮换 token 保持中性的实心按钮。
 */
export function ConfirmAction(props: {
  /** 该确认态的键；同一时刻只有一处确认（§M.2 的 `confirming: <key|null>`）。 */
  readonly id: string
  readonly label: string
  /** 动作的名称，点进确认态后成为标题的一部分（「停止工单『…』？」）。 */
  readonly action: string
  /** 动作的对象（工单标题之类），可选；有它标题与正文就点出对象。 */
  readonly target?: string
  /**
   * 一句话的后果（已经本地化）：确认态正文就是它。必填——确认对话必须写道具判断的后果，
   * 没有后果可写的动作不该有确认态。
   */
  readonly consequence: string
  /** 确认按钮的文字：动词 + 对象（「停止工单」「移除 worktree」）。缺省用 `action`。 */
  readonly confirmLabel?: string
  readonly locale: string
  readonly onConfirm: () => void
  readonly variant?: 'solid' | 'outline' | 'ghost'
  readonly icon?: IconName
  /** 确认按钮的语气；只有真正破坏性的四类动作传 `danger`。 */
  readonly tone?: 'neutral' | 'danger'
}) {
  const open = read(confirming) === props.id
  if (!open) {
    return (
      <Row gap="xs">
        <Button
          variant={props.variant ?? 'outline'}
          size="sm"
          {...(props.icon === undefined ? {} : { icon: props.icon })}
          onPress={() => set(confirming, props.id)}
        >
          {props.label}
        </Button>
      </Row>
    )
  }
  const title =
    props.target === undefined
      ? translate(props.locale, 'confirm.titlePlain', { action: props.action })
      : translate(props.locale, 'confirm.title', { action: props.action, target: props.target })
  const body = props.consequence
  return (
    <Callout tone="warning" title={title} icon="warning">
      <Stack gap="sm">
        <Text size="sm">{body}</Text>
        <Row gap="xs">
          <Button
            variant="solid"
            {...(props.tone === 'danger' ? { tone: 'danger' } : {})}
            size="sm"
            onPress={() => {
              set(confirming, null)
              props.onConfirm()
            }}
          >
            {props.confirmLabel ?? props.action}
          </Button>
          <Button variant="ghost" size="sm" onPress={() => set(confirming, null)}>
            {translate(props.locale, 'action.cancel')}
          </Button>
        </Row>
      </Stack>
    </Callout>
  )
}

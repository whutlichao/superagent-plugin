// 页面壳的公共零件（§M.2 的三态、§M.4 的组件选型、§M.2 的行内二次确认）。
// 只用 Orca 的语义组件；没有 Modal、没有浏览器 confirm（面板无 DOM）。
// 组件返回 JSX，页面票直接组合它们。
import {
  atom,
  Badge,
  Button,
  Callout,
  EmptyState,
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

/** 页头：标题 + 副标题 + 右侧动作。 */
export function PageHeader(props: {
  readonly title: string
  readonly subtitle?: string
  readonly actions?: OrcaNode
}): OrcaElement {
  return (
    <Row justify="between" align="start" gap="sm">
      <Stack gap="xs">
        <Text weight="semibold">{props.title}</Text>
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

/** 一张「组」：标题 + 可选计数 + 内容（Overview 的四个区块都用它）。 */
export function Section(props: {
  readonly title: string
  readonly count?: number
  readonly children?: OrcaNode
}) {
  const title = props.count === undefined ? props.title : `${props.title} · ${props.count}`
  return (
    <Stack gap="xs">
      <Text weight="medium" size="sm">
        {title}
      </Text>
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

/** 相对时间：绝不自己计时，交给宿主的 `RelativeTime`（§M.6）。 */
export function At(props: { readonly at: number; readonly format?: 'long' | 'short' | 'duration' }) {
  return <RelativeTime at={props.at} format={props.format ?? 'short'} />
}

/** 一个状态的标记：图标 + 文案，语气由 `marks.ts` 决定（`<Badge tone>`）。 */
export function MarkBadge(props: { readonly label: string; readonly tone: MarkTone }) {
  return <Badge tone={props.tone}>{props.label}</Badge>
}

/**
 * 行内二次确认（§M.2）：点动作后该处换成 `Callout tone="warning"` + Confirm / Cancel，
 * **没有模态框**，也不调用浏览器 `confirm()`（面板无 DOM）。状态是面板级 atom
 * （`confirming: key | null`），因此同一时刻只有一处确认态。
 */
export function ConfirmAction(props: {
  /** 该确认态的键；同一时刻只有一处确认（§M.2 的 `confirming: <key|null>`）。 */
  readonly id: string
  readonly label: string
  /** 动作的名称，填进「确定要{action}吗？」。 */
  readonly action: string
  /** 动作的对象（工单标题之类），可选。 */
  readonly target?: string
  readonly locale: string
  readonly onConfirm: () => void
  readonly variant?: 'solid' | 'outline' | 'ghost'
  readonly icon?: IconName
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
  const body =
    props.target === undefined
      ? translate(props.locale, 'confirm.bodyPlain', { action: props.action })
      : translate(props.locale, 'confirm.body', { action: props.action, target: props.target })
  return (
    <Callout tone="warning" title={translate(props.locale, 'confirm.title', { action: props.action })} icon="warning">
      <Stack gap="sm">
        <Text size="sm">{body}</Text>
        <Row gap="xs">
          <Button
            variant="solid"
            tone="danger"
            size="sm"
            onPress={() => {
              set(confirming, null)
              props.onConfirm()
            }}
          >
            {translate(props.locale, 'action.confirm')}
          </Button>
          <Button variant="ghost" size="sm" onPress={() => set(confirming, null)}>
            {translate(props.locale, 'action.cancel')}
          </Button>
        </Row>
      </Stack>
    </Callout>
  )
}

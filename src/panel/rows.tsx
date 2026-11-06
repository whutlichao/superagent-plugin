// 行组件（§C.1 `panel/rows.tsx`、§M.2 的列表）：Ticket / Thread / Decision / Source 各一行。
// 页面票（#37–#48）直接用这些行，因此同一份数据在 Overview、Trigger、Eval、Execution 上看
// 起来一样（§M.1 的一致控件原则）。标记一律来自 `marks.ts`，这里不再自带一份映射。
//
// 只用 Orca 的语义组件；行上的动作入口留给页面票（它们知道该发什么请求）。
import { Button, ListItem, RelativeTime, Row, Text } from 'orca'
import { translate, type CopyKey } from './copy'
import {
  decisionMark,
  markLabel,
  sourceMark,
  threadMark,
  ticketMark,
  type DecisionKind,
  type SourceState,
  type ThreadStage,
  type TicketAction
} from './marks'
import { MarkBadge } from './widgets'

/** 一条 Ticket 行需要的最小数据（详情页由 #38 填充）。 */
export interface TicketRowData {
  readonly id: string
  readonly title: string
  /** 行的阶段：`queued` 在 working 阶段，其余五个在 person 阶段。 */
  readonly action: TicketAction
  /** 最后更新时间（epoch ms）；时间一律交给 `RelativeTime`。 */
  readonly at: number
  /** 行上直接可做的动作；缺省表示只读。 */
  readonly onOpen?: () => void
}

/** Ticket 行：阶段标记 + 标题 + 相对时间（§M.2 Overview ①：「每行给直接动作」）。 */
export function TicketRow(props: { readonly locale: string; readonly ticket: TicketRowData }) {
  const { ticket } = props
  const mark =
    ticket.action === 'queued'
      ? ticketMark({ stage: 'working', action: 'queued' })
      : ticketMark({ stage: 'person', action: ticket.action })
  const label = markLabel(props.locale, mark)
  return (
    <ListItem
      title={ticket.title}
      description={label}
      icon={mark.icon}
      {...(ticket.onOpen === undefined ? {} : { onPress: ticket.onOpen })}
    >
      <Row gap="xs" align="center">
        <MarkBadge label={label} tone={mark.tone} />
        <RelativeTime at={ticket.at} format="short" muted />
      </Row>
    </ListItem>
  )
}

/** 一条 Thread 行需要的最小数据。 */
export interface ThreadRowData {
  readonly key: string
  readonly title: string
  readonly source: string
  readonly stage: ThreadStage
  /** 排队中的触发数（`stage === 'queued'` 时显示）。 */
  readonly pending: number
  readonly lastAt: number
  readonly onOpen?: () => void
}

/** Thread 行：阶段标记 + 标题 + 来源 + 相对时间。 */
export function ThreadRow(props: { readonly locale: string; readonly thread: ThreadRowData }) {
  const { thread } = props
  const mark = threadMark({ stage: thread.stage, pending: thread.pending })
  const label = markLabel(props.locale, mark, { count: thread.pending })
  return (
    <ListItem
      title={thread.title}
      description={`${translate(props.locale, 'term.source' as CopyKey)} · ${thread.source}`}
      icon={mark.icon}
      {...(thread.onOpen === undefined ? {} : { onPress: thread.onOpen })}
    >
      <Row gap="xs" align="center">
        <MarkBadge label={label} tone={mark.tone} />
        <RelativeTime at={thread.lastAt} format="short" muted />
      </Row>
    </ListItem>
  )
}

/** 一条 Decision 行需要的最小数据（§M.2 Eval：kind、reason、strength、policy version、at）。 */
export interface DecisionRowData {
  readonly id: string
  readonly kind: DecisionKind
  /** 已本地化的原因（页面票从 worker 的 `reason` 码翻好再传进来）。 */
  readonly reason: string
  readonly strength: 'explicit' | 'inferred'
  readonly policyVersion: number
  readonly at: number
  readonly onOpen?: () => void
}

/** Decision 行：决定标记 + 原因 + 强度 + 策略版本 + 相对时间。 */
export function DecisionRow(props: { readonly locale: string; readonly decision: DecisionRowData }) {
  const { decision } = props
  const mark = decisionMark(decision.kind)
  const label = markLabel(props.locale, mark)
  const strength = translate(props.locale, `strength.${decision.strength}` as CopyKey)
  return (
    <ListItem
      title={label}
      description={decision.reason}
      icon={mark.icon}
      {...(decision.onOpen === undefined ? {} : { onPress: decision.onOpen })}
    >
      <Row gap="xs" align="center" wrap>
        <MarkBadge label={label} tone={mark.tone} />
        <Text muted size="xs">
          {translate(props.locale, 'term.strength' as CopyKey)} · {strength}
        </Text>
        <Text muted size="xs">
          {translate(props.locale, 'term.policyVersion' as CopyKey)} · {decision.policyVersion}
        </Text>
        <RelativeTime at={decision.at} format="short" muted />
      </Row>
    </ListItem>
  )
}

/** 一条 Source 行需要的最小数据（§M.2 Source：状态、setup 问题、非零计数）。 */
export interface SourceRowData {
  readonly id: string
  readonly title: string
  readonly state: SourceState
  /** setup 问题或最后错误的一句话；没有问题时不传。 */
  readonly problem?: string
  readonly onOpen?: () => void
}

/** Source 行：状态标记 + 标题 + 内联的 setup 问题（不遮住其他 Source）。 */
export function SourceRow(props: { readonly locale: string; readonly source: SourceRowData }) {
  const { source } = props
  const mark = sourceMark(source.state)
  const label = markLabel(props.locale, mark)
  return (
    <ListItem
      title={source.title}
      {...(source.problem === undefined ? {} : { description: source.problem })}
      icon={mark.icon}
      {...(source.onOpen === undefined ? {} : { onPress: source.onOpen })}
    >
      <Row gap="xs" align="center" wrap>
        <MarkBadge label={label} tone={mark.tone} />
        {source.problem === undefined ? null : (
          <Button variant="ghost" size="sm" onPress={source.onOpen}>
            {translate(props.locale, 'action.refresh')}
          </Button>
        )}
      </Row>
    </ListItem>
  )
}

// 状态标记（§M.4 `marks.ts`、§M.5 的 `terms` 段）：领域状态 → 图标 / 语气 / 文案键。
// 纯函数，不 import `orca`：图标与语气用字符串字面量（与组件目录的枚举同值），
// 文案键指向 `copy.ts`，因此同一个状态在面板任何地方看起来都一样。
import { translate, type CopyKey, type CopyValues } from './copy'

/** Orca 的 Tone 档位。 */
export type MarkTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

/** 本壳用到的 Orca 图标名（`IconName` 的子集，取值与组件目录逐字一致）。 */
export type MarkIcon =
  | 'info'
  | 'check'
  | 'warning'
  | 'error'
  | 'download'
  | 'layers'
  | 'bell'
  | 'play'
  | 'stop'
  | 'refresh'
  | 'pause'
  | 'close'

/** 一个状态的视觉标记：文案键 + 语气 + 图标；`detail` 放不进文案键的结局原文。 */
export interface Mark {
  readonly labelKey: CopyKey
  readonly tone: MarkTone
  readonly icon: MarkIcon
  /** 结局之类的自由文本（工单的 `outcome`），由调用方决定是否展示。 */
  readonly detail?: string
}

/** Ticket 的阶段（§E.8 的面板标签）。 */
export type TicketStage = 'person' | 'working' | 'idle' | 'ended'

/** Ticket 在人等待时等人做什么；`delivery` 是投递失败。 */
export type TicketAction = 'answer' | 'review' | 'blocked' | 'failed' | 'delivery' | 'queued'

/** Ticket 结束的结局（§E.8：completed / merged / closed / dropped / stopped）。 */
export type TicketOutcome = 'completed' | 'merged' | 'closed' | 'dropped' | 'stopped'

/** Thread 的展示阶段。 */
export type ThreadStage =
  | 'subscribed'
  | 'evaluating'
  | 'queued'
  | 'error'
  | 'dormant'
  | 'unsubscribed'

/**
 * Source 实例的状态：注册表的生命周期（`sources/registry.ts` 的 `SourceState`，前四档与健康
 * 状态同值）外加 `setup`（§I.1 的 setup 问题：配置缺东西，轮询没启动）。`setup` 是面板自己
 * 的展示档，不是健康状态。
 */
export type SourceState = 'ready' | 'starting' | 'paused' | 'error' | 'setup' | 'off' | 'missing'

/** Decision 的类型（`core/model.ts` 的 `DECISION_KINDS`，外加 observe 模式下「本可接单」的忽略）。 */
export type DecisionKind = 'accept' | 'stop' | 'ignore' | 'unavailable' | 'wouldAccept'

/** Report 的状态。 */
export type ReportState = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'

/** Ticket 的阶段标记：按「在等谁、等什么」措辞；结束的工单按结局措辞。 */
export function ticketMark(ticket: {
  readonly stage: TicketStage
  readonly action?: TicketAction
  readonly outcome?: TicketOutcome
}): Mark {
  if (ticket.stage === 'ended') {
    return {
      labelKey: ticket.outcome ? (`outcome.${ticket.outcome}` as CopyKey) : 'report.dropped',
      tone: 'neutral',
      icon: 'stop',
      ...(ticket.outcome ? { detail: ticket.outcome } : {})
    }
  }
  if (ticket.stage === 'person') {
    switch (ticket.action) {
      case 'review':
        return { labelKey: 'stage.review', tone: 'warning', icon: 'check' }
      case 'blocked':
        return { labelKey: 'stage.blockedFailed', tone: 'warning', icon: 'warning' }
      case 'failed':
        return { labelKey: 'stage.blockedFailed', tone: 'danger', icon: 'error' }
      case 'delivery':
        return { labelKey: 'stage.delivery', tone: 'warning', icon: 'download' }
      default:
        return { labelKey: 'stage.answer', tone: 'warning', icon: 'info' }
    }
  }
  if (ticket.stage === 'working') {
    return ticket.action === 'queued'
      ? { labelKey: 'stage.queued', tone: 'neutral', icon: 'layers' }
      : { labelKey: 'stage.working', tone: 'accent', icon: 'play' }
  }
  return { labelKey: 'stage.idle', tone: 'neutral', icon: 'bell' }
}

/** Thread 的阶段标记；`queued` 的文案带 `{count}`（排队数）。 */
export function threadMark(thread: { readonly stage: ThreadStage; readonly pending: number }): Mark {
  switch (thread.stage) {
    case 'evaluating':
      return { labelKey: 'thread.evaluating', tone: 'accent', icon: 'refresh' }
    case 'queued':
      return { labelKey: 'thread.queued', tone: 'warning', icon: 'layers' }
    case 'error':
      return { labelKey: 'thread.error', tone: 'danger', icon: 'error' }
    case 'dormant':
      return { labelKey: 'thread.dormant', tone: 'neutral', icon: 'stop' }
    case 'unsubscribed':
      return { labelKey: 'thread.unsubscribed', tone: 'neutral', icon: 'close' }
    default:
      return { labelKey: 'thread.subscribed', tone: 'success', icon: 'check' }
  }
}

/** Source 状态标记：错误最重，其次暂停，其余是安静的中性/成功。 */
export function sourceMark(state: SourceState): Mark {
  switch (state) {
    case 'ready':
      return { labelKey: 'source.ready', tone: 'success', icon: 'check' }
    case 'starting':
      return { labelKey: 'source.starting', tone: 'accent', icon: 'refresh' }
    case 'paused':
      return { labelKey: 'source.paused', tone: 'warning', icon: 'pause' }
    case 'error':
      return { labelKey: 'source.error', tone: 'danger', icon: 'error' }
    case 'setup':
      return { labelKey: 'source.setup', tone: 'neutral', icon: 'info' }
    case 'off':
      return { labelKey: 'source.off', tone: 'neutral', icon: 'close' }
    default:
      return { labelKey: 'source.missing', tone: 'neutral', icon: 'close' }
  }
}

/** Decision 的标记：接单/续做是成功，停止是危险，未完成是警告，观察模式的「本可接单」单独措辞。 */
export function decisionMark(kind: DecisionKind): Mark {
  switch (kind) {
    case 'accept':
      return { labelKey: 'decision.accept', tone: 'success', icon: 'check' }
    case 'stop':
      return { labelKey: 'decision.stop', tone: 'danger', icon: 'stop' }
    case 'unavailable':
      return { labelKey: 'decision.unavailable', tone: 'warning', icon: 'warning' }
    case 'wouldAccept':
      // observe 模式下的「本可接单」没有独立码；它按忽略措辞，语气提醒。
      return { labelKey: 'decision.ignore', tone: 'warning', icon: 'close', detail: 'wouldAccept' }
    default:
      return { labelKey: 'decision.ignore', tone: 'neutral', icon: 'close' }
  }
}

/** Report 的标记：失败 > 受阻 > 等待 > 进行中 > 可评审/无需处理。 */
export function reportMark(state: ReportState): Mark {
  switch (state) {
    case 'ready':
      return { labelKey: 'report.ready', tone: 'success', icon: 'check' }
    case 'blocked':
      return { labelKey: 'report.blocked', tone: 'warning', icon: 'warning' }
    case 'failed':
      return { labelKey: 'report.failed', tone: 'danger', icon: 'error' }
    case 'dropped':
      return { labelKey: 'report.dropped', tone: 'neutral', icon: 'close' }
    case 'waiting':
      return { labelKey: 'report.waiting', tone: 'neutral', icon: 'bell' }
    default:
      return { labelKey: 'report.progress', tone: 'accent', icon: 'play' }
  }
}

/** 健康条目的四档状态（§N.4：启动中 / 就绪 / 暂停 / 错误）；措辞在 `deployment.state.*`。 */
export type HealthState = 'starting' | 'ready' | 'paused' | 'error'

/** 健康条目的标记：错误最重，其次启动中（还没接上），就绪是成功，暂停是安静。 */
export function healthMark(state: HealthState): Mark {
  switch (state) {
    case 'ready':
      return { labelKey: 'deployment.state.ready', tone: 'success', icon: 'check' }
    case 'error':
      return { labelKey: 'deployment.state.error', tone: 'danger', icon: 'error' }
    case 'paused':
      return { labelKey: 'deployment.state.paused', tone: 'neutral', icon: 'pause' }
    default:
      return { labelKey: 'deployment.state.starting', tone: 'neutral', icon: 'info' }
  }
}

/** doctor 的三档（§G.2、§N.4）：只报有没有。 */
export type DoctorState = 'ok' | 'warn' | 'fail'

/** doctor 结论的标记：失败最重，警告提醒，就绪是成功。 */
export function doctorMark(state: DoctorState): Mark {
  switch (state) {
    case 'ok':
      return { labelKey: 'deployment.doctorState.ok', tone: 'success', icon: 'check' }
    case 'warn':
      return { labelKey: 'deployment.doctorState.warn', tone: 'warning', icon: 'warning' }
    default:
      return { labelKey: 'deployment.doctorState.fail', tone: 'danger', icon: 'error' }
  }
}

/** 把标记渲染成某语言的文字；`values` 填 `{count}` 之类的占位符。 */
export function markLabel(locale: string, mark: Mark, values: CopyValues = {}): string {
  return translate(locale, mark.labelKey, values)
}

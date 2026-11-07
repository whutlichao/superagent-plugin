// Router 的两条命令（§G.2 的 `eval-decide` / `route` 行、§F.6）：把「模型交来的评估」变成领域
// 的 Decision，以及一次收 1–20 条路由决定。
//
// 为什么在 `app/`：`policy/assessment.ts` 是纯规则（不碰 Engine），`http/` 只做信封与错误码；
// 这里把它们和领域命令接起来，HTTP 与 CLI 共用同一份实现（§G 的「同一份 handler」）。
//
// 两条命令的固定拒绝语义：
// - `eval-decide`：没有开着的 Eval → `too_late`；评估期间 Policy 变了 → `policy_changed`；
//   载荷形状/完整性不对 → `invalid_assessment` / `incomplete_rules`。四种都**不写 Decision**。
// - `route`：超过 20 条 → `too_many_items`（整批不跑）；0 条或不是数组 → `invalid_params`；
//   单条的任何拒绝都内嵌在按输入顺序的 `results` 里（`refused`），不影响其余条目。
//
// 依赖纪律（§C.2）：本文件在 `app/`，import 领域类型、`policy/assessment.ts` 与同目录的
// `views.ts`；不 import `http/`、不碰存储、不做 I/O。
import type { Candidate, Decision, DecisionKind, Ticket } from '../core/index.ts'
import { UserError } from '../core/index.ts'
import { reasonText } from '../core/index.ts'
import type { Outcome } from '../core/engine.ts'
import { assessmentOutcome } from '../policy/index.ts'
import type { AssessmentPolicy, AssessmentRefusalCode } from '../policy/index.ts'
import { ticketView } from './views.ts'
import type { TicketView } from './views.ts'

/** `route` 一次最多几条（§G.1 限额行、§G.2 的 `too_many_items`）。 */
export const ROUTE_ITEM_LIMIT = 20

/** `route` 的四种 kind（与上游 `orchestrator_route` 一致）。 */
export const ROUTE_KINDS = ['accept', 'attach', 'ignore', 'stop'] as const
export type RouteKind = (typeof ROUTE_KINDS)[number]

/** `eval-decide` 的四种固定拒绝（§G.2 的 eval-decide 行）。 */
export type EvalRefusalCode = AssessmentRefusalCode | 'policy_changed' | 'too_late'

/** 一次评估命令的结果。 */
export type AssessResult =
  | {
      readonly ok: true
      readonly decision: DecisionKind
      readonly reason: string
      readonly ticket?: TicketView
    }
  | {
      readonly ok: false
      readonly code: EvalRefusalCode
      readonly message: string
      readonly values?: Readonly<Record<string, string>>
    }

/** `route` 里一条决定的结果：与输入同序，`refused` 是单条拒绝。 */
export interface RouteItemResult {
  readonly trigger_id: string
  readonly kind: string
  readonly decision?: DecisionKind
  readonly reason?: string
  readonly ticket?: TicketView
  readonly triggerIds?: readonly string[]
  /** 单条被拒（§G.2 的 `refused_item`）：原因文字，其余条目照常执行。 */
  readonly refused?: string
}

/** 一次批量路由的结果；整批拒绝时 `ok:false` 并带固定码。 */
export type RouteBatchResult =
  | { readonly ok: true; readonly results: readonly RouteItemResult[] }
  | {
      readonly ok: false
      readonly code: 'invalid_params' | 'too_many_items'
      readonly message: string
      readonly values?: Readonly<Record<string, string>>
    }

/** `route` 一条决定（上游同名 wire 形状）。 */
interface RouteItem {
  readonly kind: RouteKind
  readonly triggerId: string
  readonly ticketId?: string
  readonly title?: string
  readonly worktreeName?: string
  readonly acknowledgement?: string
  readonly note?: string
  readonly reason?: string
}

/** 一条字段的规则：哪些 kind 读它、哪些 kind 必要它、字符串上限。 */
interface FieldRule {
  readonly reads: readonly RouteKind[]
  readonly needs: readonly RouteKind[]
  readonly max: number
}

/** 决定里与 kind 相关的字段名（领域侧 camelCase）。 */
type FieldKey = 'ticketId' | 'title' | 'worktreeName' | 'acknowledgement' | 'note' | 'reason'

/** 决定中与 kind 相关的字段（与上游 `FIELDS` 同表：读什么、必要什么）。 */
const ITEM_FIELDS: Readonly<Record<FieldKey, FieldRule>> = {
  ticketId: { reads: ['attach', 'stop'], needs: ['attach', 'stop'], max: 200 },
  title: { reads: ['accept'], needs: ['accept'], max: 200 },
  worktreeName: { reads: ['accept'], needs: ['accept'], max: 40 },
  acknowledgement: { reads: ['accept'], needs: ['accept'], max: 2000 },
  note: { reads: ['accept', 'attach'], needs: [], max: 2000 },
  reason: { reads: ['ignore', 'stop'], needs: ['ignore'], max: 500 }
}

/** 字段名 → wire 键名（结果只回填入参的 echo，不改名）。 */
const ITEM_KEYS: Readonly<Record<FieldKey, string>> = {
  ticketId: 'ticket_id',
  title: 'title',
  worktreeName: 'worktree_name',
  acknowledgement: 'acknowledgement',
  note: 'note',
  reason: 'reason'
}

/** Router 命令的宿主端口：全部是领域命令，参数校验在这之上。 */
export interface RouterToolHost {
  /** 持有这条 Trigger 的那次 Eval 的候选；没有时 undefined（评估已结束/从未开始）。 */
  readonly candidate: (triggerId: string) => Candidate | undefined
  /** 当前的 Policy 块（规则与 accept mode 是内容真相，§K.4）。 */
  readonly policy: () => AssessmentPolicy
  /** 当前的 Policy 版本（§K.5；#25 之前是占位串）。 */
  readonly policyVersion: () => string
  /** `Engine.decide`。 */
  readonly decide: (triggerId: string, outcome: Outcome) => Decision
  /** `Engine.attach`。 */
  readonly attach: (ticketId: string, triggerId: string, note?: string) => Ticket
  /** 读一条 Ticket（结果里的 card）。 */
  readonly ticketOf: (ticketId: string) => Ticket | undefined
  /** 一条非 UserError 的失败（内部错误）经它记日志，结果里只给可重试的说明。 */
  readonly log?: (message: string) => void
}

/** HTTP 与 CLI 共用的两条命令。 */
export interface RouterTools {
  /** 记录一次评估；四种固定拒绝都不写 Decision。 */
  decide(triggerId: string, assessment: unknown): AssessResult
  /** 批量路由；逐条独立，顺序与入参一致。 */
  route(decisions: unknown): RouteBatchResult
}

/** 一个字符串字段（`null`/空白也算缺席，与上游 route 的 `nullish` 同读法）。 */
function textField(item: Record<string, unknown>, key: string): string | undefined {
  const value = item[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** 一个对象形状的单条决定；不是对象时 undefined。 */
function itemOf(value: unknown): { wire: Record<string, unknown>; kind: string; triggerId: string } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const wire = value as Record<string, unknown>
  return {
    wire,
    kind: typeof wire['kind'] === 'string' ? wire['kind'] : '',
    triggerId: typeof wire['trigger_id'] === 'string' ? wire['trigger_id'].trim() : ''
  }
}

/**
 * 一条决定的校验：每种 kind 只读自己的字段，必要的缺席或越界的值给出原因。
 * 未知键也拒绝（上游 route 的 schema 是 strict）。
 */
function invalidItem(item: RouteItem, wire: Record<string, unknown>): string | undefined {
  const known = new Set<string>(['kind', 'trigger_id'])
  for (const field of Object.values(ITEM_KEYS)) known.add(field)
  const unknown = Object.keys(wire).filter((key) => !known.has(key))
  if (unknown.length) return `unknown field: ${unknown.join(', ')}`
  for (const [field, rule] of Object.entries(ITEM_FIELDS) as [FieldKey, FieldRule][]) {
    if (!rule.reads.includes(item.kind)) continue
    const value = item[field]
    if (value === undefined) {
      if (rule.needs.includes(item.kind)) return `${item.kind} needs ${ITEM_KEYS[field]}`
      continue
    }
    if (value.length > rule.max) {
      return `${ITEM_KEYS[field]} is longer than ${rule.max} characters`
    }
  }
  return undefined
}

/** wire 对象 → 已校形的一条决定（kind 已确认属于四种）。 */
function routeItem(item: RouteItem, wire: Record<string, unknown>): RouteItem {
  const title = textField(wire, 'title')
  const worktreeName = textField(wire, 'worktree_name')
  const acknowledgement = textField(wire, 'acknowledgement')
  const note = textField(wire, 'note')
  const reason = textField(wire, 'reason')
  const ticketId = textField(wire, 'ticket_id')
  return {
    ...item,
    ...(title === undefined ? {} : { title }),
    ...(worktreeName === undefined ? {} : { worktreeName }),
    ...(acknowledgement === undefined ? {} : { acknowledgement }),
    ...(note === undefined ? {} : { note }),
    ...(reason === undefined ? {} : { reason }),
    ...(ticketId === undefined ? {} : { ticketId })
  }
}

/** 结果的头部：即使形状不对也回填 kind/trigger_id，保证顺序与入参一一对应。 */
const headOf = (kind: string, triggerId: string): { kind: string; trigger_id: string } => ({
  kind,
  trigger_id: triggerId
})

/** 一条 Trigger 的候选与它的一致性：用于 `route` 的候选事实（结果里的 triggerIds）。 */
function cardOf(host: RouterToolHost, ticketId: string | undefined): TicketView | undefined {
  if (ticketId === undefined) return undefined
  const ticket = host.ticketOf(ticketId)
  return ticket === undefined ? undefined : ticketView(ticket)
}

/** 把一次成功的领域结局收成 route 的一条结果。 */
function decided(
  host: RouterToolHost,
  head: { kind: string; trigger_id: string },
  decision: Decision
): RouteItemResult {
  const ticket = cardOf(host, decision.ticketId)
  return {
    ...head,
    decision: decision.kind,
    reason: reasonText(decision.reason),
    ...(ticket === undefined ? {} : { ticket }),
    triggerIds: decision.triggerIds
  }
}

/** 一条决定执行的失败说明：UserError 用它的固定文案，其余只给可重试的说明（不回显内部细节）。 */
function refusalOf(host: RouterToolHost, error: unknown, triggerId: string): string {
  if (error instanceof UserError) return error.message
  host.log?.(`routing ${triggerId} failed: ${String(error)}`)
  return `Not recorded: this item failed internally; retry it`
}

/** 执行一条已校形的决定；返回 `refused` 表示单条被拒。 */
function runItem(
  host: RouterToolHost,
  item: RouteItem,
  decidedEarlier: ReadonlyMap<string, string>
): RouteItemResult | { readonly refused: string } {
  const head = headOf(item.kind, item.triggerId)
  switch (item.kind) {
    case 'accept': {
      const decision = host.decide(item.triggerId, {
        kind: 'accept',
        title: item.title as string,
        // route 没有 scope 字段；与上游一致，用标题作这条授权的范围说明。
        scope: item.title as string,
        reason: { code: 'explicitRouted' },
        acknowledgement: item.acknowledgement as string,
        name: item.worktreeName as string,
        ...(item.note === undefined ? {} : { note: item.note })
      })
      if (decision.kind !== 'accept' || decision.ticketId === undefined) {
        return { refused: `Ticket was not created: ${reasonText(decision.reason)}` }
      }
      return decided(host, head, decision)
    }
    case 'attach': {
      const ticket = host.attach(item.ticketId as string, item.triggerId, item.note)
      return {
        ...head,
        reason: "Attached: the ticket follows the trigger's thread and receives the trigger",
        ticket: ticketView(ticket)
      }
    }
    case 'stop': {
      const decision = host.decide(item.triggerId, {
        kind: 'stop',
        ticketId: item.ticketId as string,
        reason: item.reason ?? { code: 'humanStop' }
      })
      return decided(host, head, decision)
    }
    case 'ignore': {
      // 同一次调用里已被前一条决定带走的 Trigger 不再忽略一次：它的批次已经随那条 Decision。
      const earlier = decidedEarlier.get(item.triggerId)
      if (earlier !== undefined) {
        return { refused: `Decided in this call with ${earlier}, whose Decision took its batch` }
      }
      return decided(host, head, host.decide(item.triggerId, { kind: 'ignore', reason: item.reason as string }))
    }
  }
}

/**
 * 造两条 Router 命令。`decide` 先核对候选与 Policy 版本，再校验评估并交给 `Engine.decide`；
 * `route` 先整批校验（1–20 条），再逐条执行、逐条拒绝。
 */
export function createRouterTools(host: RouterToolHost): RouterTools {
  return {
    decide(triggerId: string, assessment: unknown): AssessResult {
      const candidate = host.candidate(triggerId)
      if (candidate === undefined) {
        return {
          ok: false,
          code: 'too_late',
          message: 'This assessment has finished: it was decided, timed out or restarted'
        }
      }
      if (candidate.policyVersion !== host.policyVersion()) {
        return {
          ok: false,
          code: 'policy_changed',
          message: 'The policy changed during this assessment; the candidate will be assessed again',
          values: { from: candidate.policyVersion, to: host.policyVersion() }
        }
      }
      const result = assessmentOutcome(assessment, host.policy(), candidate.strength)
      if (!result.ok) {
        return { ok: false, code: result.code, message: result.message, ...(result.values === undefined ? {} : { values: result.values }) }
      }
      let decision: Decision
      try {
        decision = host.decide(triggerId, { ...result.outcome, evalId: candidate.evalId })
      } catch (error) {
        // 读候选到写 Decision 之间没有 await，但同一进程的另一次命令仍可能先结束了这次 Eval。
        if (error instanceof UserError && error.code === 'evalFinished') {
          return {
            ok: false,
            code: 'too_late',
            message: 'This assessment has finished: it was decided, timed out or restarted'
          }
        }
        throw error
      }
      const ticket = cardOf(host, decision.ticketId)
      return {
        ok: true,
        decision: decision.kind,
        reason: reasonText(decision.reason),
        ...(ticket === undefined ? {} : { ticket })
      }
    },

    route(decisions: unknown): RouteBatchResult {
      if (!Array.isArray(decisions) || decisions.length === 0) {
        return {
          ok: false,
          code: 'invalid_params',
          message: 'route needs 1–20 decisions',
          values: { limit: String(ROUTE_ITEM_LIMIT) }
        }
      }
      if (decisions.length > ROUTE_ITEM_LIMIT) {
        return {
          ok: false,
          code: 'too_many_items',
          message: `route takes at most ${ROUTE_ITEM_LIMIT} decisions`,
          values: { limit: String(ROUTE_ITEM_LIMIT) }
        }
      }
      const results: RouteItemResult[] = []
      const decidedEarlier = new Map<string, string>()
      for (const value of decisions) {
        const parsed = itemOf(value)
        if (parsed === undefined) {
          results.push({ ...headOf('', ''), refused: 'Every decision must be a JSON object' })
          continue
        }
        const head = headOf(parsed.kind, parsed.triggerId)
        if (!(ROUTE_KINDS as readonly string[]).includes(parsed.kind)) {
          results.push({ ...head, refused: `kind must be one of: ${ROUTE_KINDS.join(', ')}` })
          continue
        }
        if (parsed.triggerId.length === 0) {
          results.push({ ...head, refused: 'trigger_id is required' })
          continue
        }
        const item = routeItem({ kind: parsed.kind as RouteKind, triggerId: parsed.triggerId }, parsed.wire)
        const problem = invalidItem(item, parsed.wire)
        if (problem !== undefined) {
          results.push({ ...head, refused: problem })
          continue
        }
        try {
          const result = runItem(host, item, decidedEarlier)
          if ('refused' in result) {
            results.push({ ...head, refused: result.refused })
            continue
          }
          for (const id of result.triggerIds ?? []) {
            if (!decidedEarlier.has(id)) decidedEarlier.set(id, item.triggerId)
          }
          results.push(result)
        } catch (error) {
          results.push({ ...head, refused: refusalOf(host, error, item.triggerId) })
        }
      }
      return { ok: true, results }
    }
  }
}

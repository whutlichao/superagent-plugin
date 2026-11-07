// 确定性 Gate（§K.2）：谁可以发起工作。这是政策的第一层，没有模型、没有时序依赖。
//
// 七条（顺序即优先级）：
//   1. 是否寻址由 Source 记录（`trigger.addressed`），插件不推断；
//   2. 人在允许名单 && 寻址 → explicit, via=addressed；
//   3. 人 && 该 Thread 上有 Ticket（含 ended 未被人停） → explicit, via=followup；
//   4. 否则按准入格：explicit → explicit；inferred → inferred；ignore → 不产生候选；
//   5. bot：在 bots 名单 && (寻址 || 被观察) → 最多 inferred, via=bot；其他 bot 拒绝；
//   6. CI（没有发送者，`actor.id` 为空）→ 用该行最后一格（`unlistedUnaddressed`）；
//   7. acceptMode='off' 时所有 inferred 都不成为候选，explicit 不受影响。
//
// 强度只有 `explicit` / `inferred`；「未被准入」不是强度，是 `{admissible:false, reason}`——
// 调用方据此落一条被过滤记录（原因码），不产生候选。
//
// 行与格子的可用性来自该 Source 的 `policy.rows()`（§I.1）：未点名的格子只有 receive-all
// 的 scope 才有；不可用的格子一律按 `ignore` 读。
import type {
  GateResult,
  Mandate,
  MandateBasis,
  Policy,
  ScopeResult,
  SourceScope,
  Thread,
  Ticket,
  Trigger
} from '../core/index.ts'
import type { AcceptMode } from '../core/index.ts'
import { admissionCell, admissionOf } from './admission.ts'
import type { AdmissionRow } from './admission.ts'
import type { AllowedIdentity, PolicyBlock, SourcePolicySection } from './schema.ts'

/**
 * 没有内容哈希时 `Policy.version` 的占位值。#25 用 §K.5 的 sha256 前 12 位替换它；
 * 在替换之前，每个 Mandate 仍然记着一个稳定的、可读的版本串。
 */
export const UNVERSIONED_POLICY = 'policy-unversioned'

/** 构造 Policy 的输入。读设置用 getter，所以设置变了不必重建对象（§K.5）。 */
export interface PolicyInputs {
  /** 已校验的 Policy 块。 */
  readonly block: () => PolicyBlock
  /** Source 的监听判定（注册表实现，§I.1 `scope`）。 */
  readonly sources: SourceScope
  /** 一个 Source 的准入行（kind 的 `policy.rows()`，§I.1）；没装时为空。 */
  readonly rows: (source: string) => readonly AdmissionRow[]
  /** Policy 版本；#25 之前是 `UNVERSIONED_POLICY`。 */
  readonly version: () => string
  /** 处理是否暂停（§K.6；与 Policy 版本无关）。 */
  readonly paused?: () => boolean
  /** 评估超时（毫秒）；缺省取块里的 `eval.timeoutSeconds`。 */
  readonly evalTimeoutMs?: () => number
}

/** 一个 Source 的 Policy 部分；没配时是空名单、空 bot 名单、空表。 */
function sectionOf(block: PolicyBlock, source: string): SourcePolicySection {
  return block.sources[source] ?? { allowed: [], bots: [], admission: {} }
}

/** 在 Source 自己的身份空间里找名单项（大小写不敏感，与 GitHub login 一致）。 */
function allowedSender(section: SourcePolicySection, id: string): AllowedIdentity | undefined {
  const wanted = id.trim().toLowerCase()
  if (wanted.length === 0) return undefined
  return section.allowed.find((entry) => entry.id.trim().toLowerCase() === wanted)
}

/** 在 `bots` 名单里找一行。 */
function listedBot(section: SourcePolicySection, id: string): { id: string } | undefined {
  const wanted = id.trim().toLowerCase()
  if (wanted.length === 0) return undefined
  return section.bots.find((entry) => entry.id.trim().toLowerCase() === wanted)
}

/** 名单项的显示名：没有 `name` 时用 id。 */
const senderName = (entry: AllowedIdentity | { id: string }): string =>
  'name' in entry && typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : entry.id

/** Thread 上有「自己的」Ticket（排除只当语境的订阅，排除被人停掉的，§K.2 第 3 条）。 */
function participating(thread: Thread, tickets: readonly Ticket[]): boolean {
  const stopped = new Set(tickets.filter((item) => item.ended?.by === 'human').map((item) => item.id))
  const candidates = new Set([...thread.subscriptions, ...tickets.map((item) => item.id)])
  for (const id of candidates) {
    if (thread.context?.includes(id) === true) continue
    if (stopped.has(id)) continue
    return true
  }
  return false
}

/** 一条候选在推断强度上是否可用：auto 模式，且至少一条匹配规则、全部仍启用（§K.4）。 */
function admitsInferred(block: PolicyBlock, rules: readonly string[]): boolean {
  if (block.acceptMode !== 'auto' || rules.length === 0) return false
  return rules.every((id) => block.rules.some((rule) => rule.enabled && rule.id === id))
}

/** Gate 一次判定（见文件头的七条）。 */
function gate(
  block: PolicyBlock,
  inputs: PolicyInputs,
  trigger: Trigger,
  thread: Thread,
  tickets: readonly Ticket[]
): GateResult {
  const mode: AcceptMode = block.acceptMode
  const scope = inputs.sources.scope(trigger)
  const row = scope.listened ? scope.row : undefined
  const section = sectionOf(block, trigger.source)
  const recorded = { source: trigger.source, scope: trigger.meta, ...(row === undefined ? {} : { row }) }
  const addressed = trigger.addressed === undefined ? {} : { addressed: trigger.addressed }

  if (!trigger.human) return machineGate(block, section, inputs, trigger, scope, recorded, addressed)

  const allowed = allowedSender(section, trigger.actor.id)
  const listed = allowed === undefined ? {} : { sender: senderName(allowed) }

  if (allowed !== undefined && trigger.addressed !== undefined) {
    return {
      admissible: true,
      strength: 'explicit',
      basis: { ...recorded, ...listed, via: 'addressed', addressed: trigger.addressed }
    }
  }

  const cell = admissionCell(allowed !== undefined, trigger.addressed !== undefined)
  const receivable = trigger.addressed !== undefined || (scope.listened && scope.observed)
  const admission =
    receivable && cell !== undefined
      ? admissionOf({
          table: section.admission,
          rows: inputs.rows(trigger.source),
          row,
          cell
        })
      : 'ignore'
  // 名单内且已寻址在上面就返回了，所以这里一定有格子。
  if (cell === undefined) return { admissible: false, reason: 'noMention' }
  const basis: MandateBasis = {
    ...recorded,
    ...listed,
    via: 'admission',
    cell,
    ...addressed
  }

  // 显式格先于 follow-up：Thread 上有 Ticket 不能把一条显式请求降级成 follow-up（§K.2 第 3 条）。
  if (admission === 'explicit') return { admissible: true, strength: 'explicit', basis }

  // 私聊 Topics 属于一个人：名单外的人在私聊里没有 follow-up；推断 follow-up 还需要 assess 模式。
  const follows =
    !(trigger.addressed === 'direct' && allowed === undefined) &&
    (allowed !== undefined || mode !== 'off') &&
    participating(thread, tickets)
  if (follows) {
    return {
      admissible: true,
      strength: allowed === undefined ? 'inferred' : 'explicit',
      basis: { ...recorded, ...listed, via: 'followup' }
    }
  }

  if (admission === 'inferred' && mode !== 'off') {
    return { admissible: true, strength: 'inferred', basis: { ...basis, observation: { mode } } }
  }

  const reason =
    allowed === undefined
      ? 'senderNotMember'
      : receivable && admission === 'ignore'
        ? 'admissionIgnored'
        : 'noMention'
  return { admissible: false, reason }
}

/**
 * 非人发送者（§K.2 第 5、6 条）：
 * - 有发送者：必须在 `bots` 名单里，且被寻址或被观察；最多 inferred（`via=bot`），永远不是显式；
 * - 没有发送者（CI / 系统事件）：用该行最后一个格子（`unlistedUnaddressed`），同样最多 inferred。
 * 两者在 accept mode 为 off 时都不产生候选。
 */
function machineGate(
  block: PolicyBlock,
  section: SourcePolicySection,
  inputs: PolicyInputs,
  trigger: Trigger,
  scope: ScopeResult,
  recorded: Record<string, unknown>,
  addressed: Record<string, unknown>
): GateResult {
  const mode = block.acceptMode
  const bot = listedBot(section, trigger.actor.id)
  if (trigger.actor.id.length > 0 && bot === undefined) {
    return { admissible: false, reason: 'notHuman' }
  }
  if (!scope.listened || (trigger.addressed === undefined && !scope.observed)) {
    return { admissible: false, reason: 'notHuman' }
  }
  if (bot !== undefined) {
    if (mode === 'off') return { admissible: false, reason: 'admissionIgnored' }
    return {
      admissible: true,
      strength: 'inferred',
      basis: {
        ...recorded,
        ...addressed,
        via: 'bot',
        sender: senderName(bot),
        observation: { mode }
      }
    }
  }
  const cell = 'unlistedUnaddressed'
  const admission = admissionOf({
    table: section.admission,
    rows: inputs.rows(trigger.source),
    ...(scope.listened && scope.row !== undefined ? { row: scope.row } : {}),
    cell
  })
  if (admission !== 'inferred' || mode === 'off') {
    return { admissible: false, reason: 'admissionIgnored' }
  }
  return {
    admissible: true,
    strength: 'inferred',
    basis: { ...recorded, via: 'admission', cell, observation: { mode } }
  }
}

/**
 * 造一个 Policy（领域端口，§C.1）：Gate 按块判定，`admitsInferred` 按模式与规则，
 * `revalidate` 只复核 gate 层的依据（完整的复验表是 #25）。
 */
export function createPolicy(inputs: PolicyInputs): Policy {
  return {
    get version(): string {
      return inputs.version()
    },
    get paused(): boolean {
      return inputs.paused?.() ?? false
    },
    get evalTimeoutMs(): number {
      return inputs.evalTimeoutMs?.() ?? inputs.block().eval.timeoutSeconds * 1000
    },
    gate(trigger: Trigger, thread: Thread, tickets: readonly Ticket[]): GateResult {
      return gate(inputs.block(), inputs, trigger, thread, tickets)
    },
    revalidate(mandate: Mandate): boolean {
      const block = inputs.block()
      const section = sectionOf(block, mandate.actor.source)
      if (mandate.basis.via === 'addressed' || mandate.basis.via === 'followup') {
        if (allowedSender(section, mandate.actor.id) === undefined) return false
      }
      if (mandate.basis.via === 'bot' && listedBot(section, mandate.actor.id) === undefined) {
        return false
      }
      return (
        mandate.strength === 'explicit' || admitsInferred(block, mandate.basis.rules ?? [])
      )
    },
    admitsInferred(rules: readonly string[]): boolean {
      return admitsInferred(inputs.block(), rules)
    }
  }
}

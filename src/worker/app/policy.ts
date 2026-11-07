// 最小确定性 Gate（§K.2 的第一层，本票的垂直切片）：**允许名单 + 寻址**。
//
// 这不是完整的 Policy 引擎（#20/#24 用设置 schema、准入表、accept mode 与规则判定替换它），
// 但它实现的是同一条端口（`core/ports.ts` 的 `Policy`），因此替换只改组合根的一行。
//
// 规则（顺序即优先级，全部确定、无模型参与）：
//   1. 不是人写的（bot / CI）→ 不准入，原因 `botNotAllowed`（bot 永远不能成为显式请求）；
//   2. 发送者不在该 Source 的允许名单（`policy.sources.<source>.allowed`）→ `senderNotMember`；
//   3. 消息没有点名 agent（`addressed` 缺失）→ `notAddressed`；
//   4. 其余 → 显式强度，依据 `addressed`（Mandate 复验只看名单与同一条依据）。
//
// 暂停语义不在这里：`Engine.evaluateDue` 在 `paused` 时根本不开新 Eval（§K.6）。
import type { GateResult, Mandate, Policy, Thread, Ticket, Trigger } from '../core/index.ts'

/** 一个 Source 的 Policy 部分里本票会读的字段（完整形状见 `sources/kind.ts`）。 */
export interface MinimalPolicyPart {
  readonly allowed?: readonly string[]
}

/** 构造最小 Policy 的输入。 */
export interface MinimalPolicyInput {
  /** 某个 Source 的 Policy 部分；没配时返回空（不允许任何人）。 */
  readonly part: (source: string) => MinimalPolicyPart | undefined
  /** Policy 版本（写进每个 Mandate；缺省 `v1`）。 */
  readonly version?: () => string
  /** 处理是否暂停（缺省不暂停）。 */
  readonly paused?: () => boolean
  /** Eval 的超时窗口（§K.7 缺省 60 s）。 */
  readonly evalTimeoutMs?: number
}

/** 一条 Trigger 的发送者是否在该 Source 的允许名单上（大小写不敏感，与 GitHub login 一致）。 */
export function senderAllowed(part: MinimalPolicyPart | undefined, actorId: string): boolean {
  const allowed = part?.allowed ?? []
  const wanted = actorId.trim().toLowerCase()
  return wanted.length > 0 && allowed.some((item) => item.trim().toLowerCase() === wanted)
}

/**
 * 最小 Policy：只回答「谁可以发起工作」。`admitsInferred` 恒为 false——推断候选属于
 * #24 的 accept mode 与规则判定，本票不假装支持。
 */
export function createMinimalPolicy(input: MinimalPolicyInput): Policy {
  return {
    get version(): string {
      return input.version?.() ?? 'v1'
    },
    get paused(): boolean {
      return input.paused?.() ?? false
    },
    evalTimeoutMs: input.evalTimeoutMs ?? 60_000,
    gate(trigger: Trigger, _thread: Thread, _tickets: Ticket[]): GateResult {
      if (!trigger.human) return { admissible: false, reason: 'botNotAllowed' }
      if (!senderAllowed(input.part(trigger.source), trigger.actor.id)) {
        return { admissible: false, reason: 'senderNotMember' }
      }
      if (trigger.addressed === undefined) return { admissible: false, reason: 'notAddressed' }
      return {
        admissible: true,
        strength: 'explicit',
        basis: { via: 'addressed', addressed: trigger.addressed, sender: trigger.actor.id }
      }
    },
    /** Mandate 的复验：同一条依据仍然成立（人仍在名单上，且它仍是一条被点名的请求）。 */
    revalidate(mandate: Mandate): boolean {
      const basis = mandate.basis
      const source = basis.source ?? mandate.actor.source
      if (!senderAllowed(input.part(source), mandate.actor.id)) return false
      return basis.via === 'addressed' || basis.via === 'followup'
    },
    admitsInferred(): boolean {
      return false
    }
  }
}

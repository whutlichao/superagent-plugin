// 变更影响面（§K.5 第 2 条）：一份新的 Policy 会碰到哪些正在跑的 Ticket，以及碰到哪里。
//
// 影响面不是「谁会被吊销」——变更**从不**立刻吊销（§K.5 第 3 条）；它只是让受影响的 Ticket
// 收到一条「policy 已变更」的输入，并在下一次醒来时按新 Policy 复验（§K.3）。所以这里只做
// 两件事：说出影响，且不受影响的一个字都不说。
//
// 三类影响（与 `PolicyEffect` 一一对应）：
// - `rules`：Mandate 里匹配到的规则被停用、删除或改写了（规则是主动工作的范围，改一个字都
//   要告诉 worker）；
// - `proactive`：推断强度的工作不再被接受（accept mode 离开 auto）；
// - `requesterAllowed`：发起它的人/bot 不再能在那里发起工作（离开名单、格子收窄、bot 被移出）。
//
// 「是不是 requesterAllowed 而不是 proactive」的判法沿用上游：把新块的规则与 accept mode
// 换回旧的再复验一次——还过不去，就是名单/格子的问题；过得去，就只剩模式降低这一种可能。
import type { PolicyEffect, Ticket } from '../core/index.ts'
import type { AdmissionRow } from './admission.ts'
import { revalidateMandate } from './revalidate.ts'
import type { PolicyBlock, Rule } from './schema.ts'

/** 影响面需要的读面：这个 Source 今天声明的准入行（复验「今天的格子」要它）。 */
export interface PolicyEffectsContext {
  readonly rows: (source: string) => readonly AdmissionRow[]
}

/** 一条匹配规则的差异；没变就是空数组。 */
function ruleEffects(previous: PolicyBlock, next: PolicyBlock, id: string): NonNullable<PolicyEffect['rules']> {
  const was: Rule | undefined = previous.rules.find((rule) => rule.id === id)
  const is: Rule | undefined = next.rules.find((rule) => rule.id === id)
  if (is === undefined || !is.enabled) {
    return was !== undefined && was.enabled ? [{ id, name: was.name, change: 'disabled' }] : []
  }
  const same =
    was !== undefined &&
    was.name === is.name &&
    was.enabled === is.enabled &&
    was.instruction.zh === is.instruction.zh &&
    was.instruction.en === is.instruction.en
  return same
    ? []
    : [{ id, name: is.name, change: 'changed', instruction: is.instruction.en }]
}

/**
 * 每个受影响的未结束 Ticket 一条影响说明；不受影响的不在结果里（§K.5 第 4 条）。
 * `previous` 是变更前的有效块（从未保存过时是组合根启动时那份），`next` 是刚保存的块。
 */
export function policyEffects(
  previous: PolicyBlock,
  next: PolicyBlock,
  tickets: readonly Ticket[],
  context: PolicyEffectsContext
): ReadonlyMap<string, PolicyEffect> {
  const holds = (block: PolicyBlock, mandate: Ticket['mandate']): boolean =>
    revalidateMandate(mandate, { block, rows: context.rows(mandate.actor.source) })
  const effects = new Map<string, PolicyEffect>()
  for (const ticket of tickets) {
    // 已结束的 Ticket 不再接受通知：它们在下一次醒来时按新 Policy 复验（§K.3）。
    if (ticket.ended !== undefined) continue
    const mandate = ticket.mandate
    const rules = (mandate.basis.rules ?? []).flatMap((id) => ruleEffects(previous, next, id))
    const effect: PolicyEffect = rules.length === 0 ? {} : { rules }
    if (holds(previous, mandate) && !holds(next, mandate)) {
      // 规则与模式换回旧的还能复验通过，说明变的是模式（推断工作不再被接受）；否则是
      // 名单/格子：发起它的人或 bot 已经不能在那里发起工作了。
      const withOldAuthority: PolicyBlock = {
        ...next,
        rules: previous.rules,
        acceptMode: previous.acceptMode
      }
      if (!holds(withOldAuthority, mandate)) {
        effect.requesterAllowed = false
        effect.requester = mandate.actor
      } else if (
        mandate.strength === 'inferred' &&
        previous.acceptMode === 'auto' &&
        next.acceptMode !== 'auto'
      ) {
        effect.proactive = false
      }
    }
    if (Object.keys(effect).length > 0) effects.set(ticket.id, effect)
  }
  return effects
}

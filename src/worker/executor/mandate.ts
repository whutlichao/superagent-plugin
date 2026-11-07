// 主动接受的收窄指令（§K.3、§K.4 第 5 条）：把 Mandate 的强度与匹配规则写成 worker 能照做的
// 一句话，追加进开播正文与之后每一条 Input。
//
// 为什么放在执行器：授权是领域事实（`ticket.mandate`），但「怎么对 worker 说」是执行侧措辞；
// 领域内核（`core/`）保持零 I/O、零文案。上游同名函数在 `executor/dsh.ts`，这里同样是纯函数，
// 两个渲染点（`renderAssignmentBrief` / `renderInputMarkdown`）共用它，措辞只写一次。
import type { Mandate } from '../core/model.ts'

/** 主动票的固定收窄句（下游按它断言「worker 知道只做规则允许的本地小改动」）。 */
export const LOCAL_ONLY = 'only the local small change these matched rules allow'

/**
 * Mandate → worker 的限制说明。显式授权返回空串：它的范围由那条消息与人自己承担，
 * 不需要再收窄；只有主动（inferred）接受才带这段。
 */
export function mandateInstructions(mandate: Pick<Mandate, 'strength' | 'basis'>): string {
  if (mandate.strength !== 'inferred') return ''
  const rules = mandate.basis.rules ?? []
  const under = rules.length === 0 ? '' : ` under ${rules.join(', ')}`
  return (
    `Proactively accepted${under}: make ${LOCAL_ONLY}. ` +
    'If it needs a public-interface or behaviour change, a new interaction, a product decision or a clarification, ' +
    'stop and report dropped; do not expand scope.'
  )
}

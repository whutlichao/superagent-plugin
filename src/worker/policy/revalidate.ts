// Mandate 复验（§K.3）：一个已结束的 Ticket 在恢复之前，按**今天**的 Policy 复核它的授权
// 还成立不成立。授权永不改写，所以复验只回答「这一份 Mandate 今天还立得住吗」——立不住就
// 撤销（Ticket 保持结束），立得住才恢复。
//
// 逐来源的表（§K.3）：
// - `followup`：Thread 上已有工作这件事不随名单改变；显式强度直接通过，推断强度还要 auto
//   与匹配规则仍启用。Thread 是否仍在监听是 Source 的配置（不属于 Policy），到达这里的消息
//   本来就来自被监听的 scope（§K.2 第 1 条）。
// - `addressed`：发送者仍在允许名单。
// - `admission`：今天的格子至少给出原强度（列在名单内的人被移出名单会让格子变成
//   「未名单、未点名」，那就是收窄），且原来在名单内的人仍在名单内。
// - `bot`：该 bot 仍在 bots 名单。
// - 任何推断强度：accept mode 仍是 auto，且匹配的规则全部仍启用。
//
// 「不低于原强度」用格子判定比较：`explicit > inferred > ignore`。`ignore` 不是强度，是
// 不产生候选（§K.2 末段），所以它低于任何已授予的强度。
import { admissionOf } from './admission.ts'
import type { Admission, AdmissionRow } from './admission.ts'
import type { Mandate } from '../core/index.ts'
import { allowedSender, listedBot, rulesEnabled, sectionOf } from './lists.ts'
import type { PolicyBlock } from './schema.ts'

/** 强度与格子的偏序（只用于「不低于原强度」这一件事）。 */
const STRENGTH: Readonly<Record<Admission, number>> = { ignore: 0, inferred: 1, explicit: 2 }

/** 复验需要的东西：今天的 Policy 块与这个 Source 今天声明的准入行。 */
export interface RevalidateContext {
  readonly block: PolicyBlock
  /** 该 Mandate 的 Source 的准入行（`kind.policy.rows()`）；不可用的格子按 `ignore` 读。 */
  readonly rows: readonly AdmissionRow[]
}

/**
 * 一份 Mandate 在今天是否仍立得住。`false` 就是撤销：Ticket 保持结束，等它的消息回到
 * 评估（§K.3 末段）；`true` 才允许恢复、attach 与继续工作。
 */
export function revalidateMandate(mandate: Mandate, context: RevalidateContext): boolean {
  const { block } = context
  const section = sectionOf(block, mandate.actor.source)
  const listed = allowedSender(section, mandate.actor.id) !== undefined
  const inferredHolds = (): boolean =>
    mandate.strength !== 'inferred' ||
    (block.acceptMode === 'auto' && rulesEnabled(block, mandate.basis.rules ?? []))

  switch (mandate.basis.via) {
    case 'followup':
      // 显式 follow-up 的权威来自 Thread 上已有工作，不来自名单。
      return mandate.strength === 'explicit' ? true : inferredHolds()
    case 'addressed':
      return listed && inferredHolds()
    case 'bot':
      return listedBot(section, mandate.actor.id) !== undefined && inferredHolds()
    case 'admission': {
      const { basis } = mandate
      // 今天名单内 + 已点名的人不再经过格子：那是显式请求（§K.2 第 2 条），原强度一定满足。
      if (basis.cell === 'unlistedAddressed' && listed) return true
      // 名单里的人在 accept 之后进了名单外：格子名字随之改变（未名单 + 未点名）。
      const cell = basis.cell === 'unlistedUnaddressed' && listed ? 'listedUnaddressed' : basis.cell
      if (cell === 'listedUnaddressed' && !listed) return false
      const admission = admissionOf({
        table: section.admission,
        rows: context.rows,
        row: basis.row,
        cell
      })
      if (STRENGTH[admission] < STRENGTH[mandate.strength]) return false
      return mandate.strength === 'explicit' ? true : inferredHolds()
    }
    default:
      // 闭联合（`MandateBasis`）不会有别的来源；真出现了就不是一份可复验的授权。
      return false
  }
}

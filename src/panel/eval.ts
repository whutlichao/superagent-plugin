// Eval 页的纯逻辑（§M.2 的 Eval 行、§K.7 的四条件）：Decision 原因的本地化，以及 Overview
// 的系统问题行要打开哪一条决定。
//
// 纯函数：不 import `orca`，也不碰 worker（§C.2 规则 3）。原因码的文案表在 `copy.ts`
// （`reason.<code>`），Source/Policy 自有的字面量码没有对应键时原样显示——它们是数据，
// 不是待翻译的界面文案（§M.5）。
import { COPY, translate, type CopyKey } from './copy'
import type { PanelReason, SystemProblem } from './protocol'

/** 一条原因的文案：已知码走文案表，未知码原样；带了 `triggerId` 就前置（与 worker 同序）。 */
export function reasonText(locale: string, reason: PanelReason): string {
  const key = `reason.${reason.code}`
  const text = key in COPY ? translate(locale, key as CopyKey, reason.values ?? {}) : reason.code
  return reason.triggerId === undefined ? text : `${reason.triggerId}: ${text}`
}

/** 一组原因：逐条本地化后以 `; ` 连接（与 worker 的 `reasonText` 同序、同分隔）。 */
export function reasonsText(locale: string, reasons: readonly PanelReason[]): string {
  return reasons.map((reason) => reasonText(locale, reason)).join('; ')
}

/**
 * 一条系统问题要打开的 Eval 对象：留存下来的 unavailable 行带着 Decision id；旧快照没有
 * 它时退回行自己的 id（合成 id 只可能是旧数据，页面按未知决定报错，而不是乱开一条）。
 */
export function problemDecisionId(problem: SystemProblem): string {
  return problem.decisionId ?? problem.id
}

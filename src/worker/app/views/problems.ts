// Overview「System problems」的读模型（§J.3）：把设计点名的三处来源折成同一组行。
//
// 三处来源（设计原话）：
// - health 里 `state === 'error'` 的条目（每个部件一条）；
// - 连续失败 3 次的 `reply`（`outbox.failing(3)` 的待发消息，§J.1）；
// - 24 h 内未解决且未 dismiss 的 `unavailable` Decision（`views/attention.ts` 的
//   `readUnavailableProblems`，与健康项 `evals` 共用同一个判定）。
//
// 前两处由组合根读出（健康板与 outbox 都是它的接线对象），第三处用同一个读函数——
// 这里只做「折成面板的行 + 定序」，不另立第二套「什么算问题」。
//
// 依赖纪律（§C.2）：app → core；本文件只收注入的读数，不 import store / sources / runtime。
import type { HealthEntry } from '../../core/ports.ts'
import type { SystemProblem } from '../../../panel/protocol'
import type { UnavailableProblem } from './attention.ts'

/** 一条连续失败、还没发出的回复（`outbox.failing(3)` 的一行）。 */
export interface FailingReply {
  readonly id: string
  /** 消息的去处：`source:thread`（§J.1 的分组地址里人能看到的部分）。 */
  readonly target: string
}

/** 一次系统问题读数的三个来源。 */
export interface SystemProblemInput {
  readonly health: Readonly<Record<string, HealthEntry>>
  readonly replies: readonly FailingReply[]
  readonly unavailable: readonly UnavailableProblem[]
}

/** 一条失败消息的去处（`source:thread`）：面板的行要说清「发到哪里失败了」（§J.1 的分组地址）。 */
export function replyTarget(channel: { readonly source: string; readonly thread: string }): string {
  return `${channel.source}:${channel.thread}`
}

/**
 * 读出全部系统问题行。顺序是先按来源（见 `KIND_ORDER`），再按名字——同一份读数每次都
 * 得到同一个顺序，面板不会因为对象的键序而跳动。
 */
export function readSystemProblems(input: SystemProblemInput): readonly SystemProblem[] {
  const health: SystemProblem[] = Object.keys(input.health)
    .sort()
    .flatMap((name) => {
      const entry = input.health[name]
      if (entry?.state !== 'error') return []
      return [
        {
          id: `health:${name}`,
          kind: 'health',
          name,
          ...(entry.detail === undefined ? {} : { detail: entry.detail })
        }
      ]
    })
  const replies: SystemProblem[] = [...input.replies]
    .sort((left, right) => left.target.localeCompare(right.target) || left.id.localeCompare(right.id))
    .map((reply) => ({ id: `reply:${reply.id}`, kind: 'reply', name: reply.target }))
  const unavailable: SystemProblem[] = [...input.unavailable]
    .sort(
      (left, right) =>
        left.threadKey.localeCompare(right.threadKey) || left.decisionId.localeCompare(right.decisionId)
    )
    .map((problem) => ({
      id: `unavailable:${problem.decisionId}`,
      kind: 'unavailable',
      name: problem.threadKey,
      detail: problem.reason
    }))
  return [...health, ...replies, ...unavailable]
}

// 本票的评估器（§K.4 的模型判断位）：**确定性**地把一次 Eval 收成 accept 或 ignore。
//
// 完整实现会把候选卡 relay 给 Router、由模型给出方向与规则判定（#24/#16/#32）。本票的
// 垂直切片只需要一条真实链路，因此这条评估器只做两件事：
// - 显式强度的候选（Gate 已经判定「名单上的人点名了 agent」）→ accept；
// - 其它强度 → ignore（推断候选要 accept mode 与规则，本票不假装支持）。
//
// 它仍然走同一个端口（`core/ports.ts` 的 `Assessor`）：`request` 排队、`release` 丢弃、
// `drain` 在 pass 里逐条交给 `Engine.decide`。把决定放到 pass 里而不是在 `request` 里
// 立刻调用，是为了让 decide 落在自己的事务里，不嵌进 `evaluateDue` 的那一次。
import type { Assessor, Candidate, Outcome, Reason } from '../core/index.ts'

/** accept 后的作业标题上限（面板与 worktree 短名都用它，别把整段评论当标题）。 */
export const TITLE_LIMIT = 80

/** 一条排队的决定：显式 accept 或 ignore。 */
interface Queued {
  readonly evalId: string
  readonly triggerId: string
  readonly outcome: Outcome
}

/** 评估器的依赖：`Engine.decide` 的延迟绑定（Engine 构造时需要 assessor）。 */
export interface DeterministicAssessorOptions {
  /** 交给 `Engine.decide`；实现里捕获异常并记日志，不要让一条坏候选挡住整批。 */
  readonly decide: (triggerId: string, outcome: Outcome) => void
  /** 一条决定失败时的日志（缺省静默；组合根接插件日志）。 */
  readonly onError?: (error: unknown, evalId: string) => void
}

/** 评估器 + 它在 pass 里的排空口。 */
export interface DeterministicAssessor extends Assessor {
  /** 跑完排队的决定（由 pass 在 `evaluateDue` 之后调用）。 */
  drain(): void
  /** 排队中的决定数（测试与健康明细用）。 */
  pending(): number
}

/** 一条评论正文 → 一行标题：去掉 @mention、压缩空白、截断。 */
export function titleFrom(text: string, fallback: string): string {
  const cleaned = text
    .replace(/@[\w-]+(?:\[bot\])?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length === 0) return fallback
  const line = cleaned.split(/(?<=[.!?。！？])\s/)[0] ?? cleaned
  return (line.length > TITLE_LIMIT ? `${line.slice(0, TITLE_LIMIT - 1)}…` : line).trim()
}

/** 标题 → worktree 短名（`[a-z0-9-]{3,40}`；生成不出来时由执行器按 Ticket id 兜底）。 */
export function shortNameFrom(title: string): string | undefined {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
  if (slug.length < 3) return undefined
  const cut = slug.slice(0, 40).replace(/-+$/, '')
  return cut.length >= 3 ? cut : undefined
}

/** 一条候选的 accept：标题、短名、范围、原因与自动确认（对人的回执）。 */
function acceptOutcome(candidate: Candidate, at: string): Outcome {
  const trigger = candidate.triggers[0]
  const fallback = `Request from ${trigger?.actor.id ?? 'a person'}`
  const title = titleFrom(trigger?.text ?? '', fallback)
  const name = shortNameFrom(title)
  return {
    evalId: candidate.evalId,
    kind: 'accept',
    title,
    scope: 'ticket',
    reason: { code: 'said', values: { text: trigger?.text.slice(0, 400) ?? title } },
    acknowledgement: `On it: ${title}`,
    ...(name === undefined ? {} : { name }),
    audit: { at, via: 'gate-explicit' }
  }
}

/** 推断候选不在这条链路里（要 accept mode 与规则判定）：给一条可读的固定原因。 */
const noRule: Reason = { code: 'noRuleMatched' }

/**
 * 造一个确定性评估器。`request` 只排队（可以是 `evaluateDue` 的事务内部），`drain` 才
 * 调用 `decide`；`release` 丢掉某个 Eval 的排队项（它在别处结束了）。
 */
export function createDeterministicAssessor(
  options: DeterministicAssessorOptions
): DeterministicAssessor {
  const queue: Queued[] = []
  const pendingByEval = new Map<string, Queued>()

  const remember = (item: Queued): void => {
    const existing = pendingByEval.get(item.evalId)
    if (existing !== undefined) {
      // 同一个 Eval 只留最新一条：`request` 不该为它排两次决定。
      queue.splice(queue.indexOf(existing), 1, item)
    } else {
      queue.push(item)
    }
    pendingByEval.set(item.evalId, item)
  }

  return {
    request(candidate: Candidate): void {
      const trigger = candidate.triggers[0]
      if (trigger === undefined) return
      if (candidate.strength !== 'explicit') {
        remember({
          evalId: candidate.evalId,
          triggerId: trigger.id,
          outcome: { evalId: candidate.evalId, kind: 'ignore', reason: noRule }
        })
        return
      }
      remember({
        evalId: candidate.evalId,
        triggerId: trigger.id,
        outcome: acceptOutcome(candidate, new Date().toISOString())
      })
    },
    release(evalId: string): void {
      const queued = pendingByEval.get(evalId)
      if (queued === undefined) return
      pendingByEval.delete(evalId)
      const index = queue.indexOf(queued)
      if (index >= 0) queue.splice(index, 1)
    },
    drain(): void {
      while (queue.length > 0) {
        const item = queue.shift() as Queued
        pendingByEval.delete(item.evalId)
        try {
          options.decide(item.triggerId, item.outcome)
        } catch (error) {
          options.onError?.(error, item.evalId)
        }
      }
    },
    pending(): number {
      return queue.length
    }
  }
}

// 本票的评估器（§K.4 的模型判断位）：**确定性**地处理它在进程内唯一能负责的那一种候选。
//
// 显式候选（Gate 已经判定「名单上的人点名了 agent」）→ accept；主动（inferred）候选**不在**
// 这里决定：它们要按 accept mode 与启用规则评估，由 Router 的 `eval-decide` 完成
// （`policy/assessment.ts` + `app/assessment.ts`，#24）。这里不假装判规则，也不提前把候选
// 收掉，否则 observe 模式的「本该接受」与 auto 的规则判定都没机会发生。
//
// 它仍然走同一个端口（`core/ports.ts` 的 `Assessor`）：`request` 排队、`release` 丢弃、
// `drain` 在 pass 里逐条交给 `Engine.decide`。把决定放到 pass 里而不是在 `request` 里
// 立刻调用，是为了让 decide 落在自己的事务里，不嵌进 `evaluateDue` 的那一次。
import type { Assessor, Candidate, Outcome } from '../core/index.ts'

/** accept 后的作业标题上限（面板与 worktree 短名都用它，别把整段评论当标题）。 */
export const TITLE_LIMIT = 80

/** 一条排队的决定：显式的 accept。 */
interface Queued {
  readonly evalId: string
  readonly triggerId: string
  readonly outcome: Outcome
}

/** 评估器的依赖：`Engine.decide` 的延迟绑定（Engine 构造时需要 assessor）。 */
export interface DeterministicAssessorOptions {
  /** 交给 `Engine.decide`；实现里捕获异常并记日志，不要让一条坏候选挡住整批。 */
  readonly decide: (triggerId: string, outcome: Outcome) => void
  /**
   * 本评估器**不**决定的候选（主动候选，§K.4 的 accept mode 与规则判定）：交给它把候选卡
   * 排给 Router。缺省不排（测试与不需要 Router 的接线里就是空的）。
   */
  readonly relayCandidate?: (candidate: Candidate) => void
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
      // 主动候选留给 Router 的 `eval-decide`（accept mode 与规则判定，§K.4）：候选卡经
      // `assessment` effect 送到 Router，送达之后才开始算 Eval 的截止时间（§K.7）。
      if (candidate.strength !== 'explicit') {
        options.relayCandidate?.(candidate)
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

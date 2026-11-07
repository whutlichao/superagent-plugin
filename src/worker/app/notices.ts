// 交给 Router 的候选卡与 `assessment` effect 的接线（§C.1 `app/notices.ts`、§F.2 的候选行、
// §J.2 的 assessment 行、§K.7 的计时起算）。
//
// 三件事只在这里做：
// 1. **投影**：把一次 Eval 的候选收成一张卡（触发者、来源、强度、政策版本、同批 Trigger、
//    相关 Ticket、下一步动作）。长文本进卡片正文，终端只收一行摘要——终端吞长文本会断行、
//    重复提交（附录 C S1），所以「一行 + 文件指针」是纪律，不是风格。
// 2. **送达**：卡片经注入的端口送到 Router；送不到就抛错，交给 effect 队列按 2 s→60 s 退避
//    重试（§J.2），绝不静默丢弃。
// 3. **计时**：`candidateDelivered` 只在卡片真的送达之后调用——§K.7 的截止时间从「送达
//    Router」起算，不是从「进入队列」起算。
//
// 投递端口由 `router/relay.ts` 实现：那张卡与 relay/notice 共用同一个串行写手（§J.2 末注），
// 因此并发送达的卡片不会把 Router 终端的写入搅在一起。
//
// 依赖纪律（§C.2）：本文件只 import core 的类型与 `app/effects` 的队列形状；不 import
// `router/` 的实现，也不做 I/O（写文件与写终端都是注入的端口）。
import { threadKey } from '../core/index.ts'
import type { Candidate, Strength, Trigger } from '../core/index.ts'
import type { EffectKind, EffectPayloads } from './effects.ts'

/** 终端摘要里正文预览的字符数：完整正文在文件里。 */
export const CANDIDATE_PREVIEW_CHARS = 160

/** 卡片里同批 Trigger 的上限（`route` 一次最多 20 条，§G.1）。 */
export const CANDIDATE_BATCH_LIMIT = 20

/** 卡片里相关 Ticket 的上限（与上游 `relatedTickets` 的 8 条一致）。 */
export const CANDIDATE_TICKETS_LIMIT = 8

/** 一张要写进 Router 终端的卡片：正文落盘，终端只收一行摘要与文件指针（§F.2）。 */
export interface RouterCard {
  /** 文件与编号用的稳定名（`eval-<evalId>`）。 */
  readonly name: string
  /** 终端那一行里的摘要（一行、短的）。 */
  readonly summary: string
  /** 落盘的正文（Markdown）。 */
  readonly body: string
}

/** 卡片里一条同批 Trigger 的投影。 */
export interface CandidateCardTrigger {
  readonly trigger_id: string
  readonly actor: string
  readonly at: string
  readonly preview: string
  readonly chars: number
}

/** 卡片里一条相关 Ticket 的投影。 */
export interface CandidateTicketLine {
  readonly ticket_id: string
  readonly title: string
  /** `open`，或结束时的结局（completed / merged / closed / dropped / stopped，§E.8）。 */
  readonly state: string
}

/**
 * 一张候选卡：Router 评估窗口里的事实（§F.2「长文一律文件」）。
 * 键名用 snake_case，与 Router 读到的其他卡片、以及上游的候选卡同形。
 */
export interface CandidateCard {
  readonly kind: 'candidate'
  readonly eval_id: string
  readonly trigger_id: string
  readonly source: string
  readonly actor: string
  readonly human: boolean
  readonly at: string
  readonly thread: string
  readonly strength: Strength
  readonly policy_version: string
  readonly preview: string
  readonly chars: number
  /** 与主 Trigger 同批评估的其余 Trigger；没有同批时为 `[]`。 */
  readonly batch: readonly CandidateCardTrigger[]
  /** 这条 Thread 上的 Ticket（含已结束的），供判重；最多 `CANDIDATE_TICKETS_LIMIT` 条。 */
  readonly related_tickets: readonly CandidateTicketLine[]
  readonly tickets_total: number
  /** 卡片上写着下一步该做什么，免得 Router 从设计文档里猜（§F.6）。 */
  readonly next_action: string
}

/** 一行预览：压缩空白、截断；保留原文的长度。 */
function preview(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= CANDIDATE_PREVIEW_CHARS
    ? line
    : `${line.slice(0, CANDIDATE_PREVIEW_CHARS - 1)}…`
}

/** 一条 Trigger 的简短投影（同批 Trigger 用）。 */
function triggerLine(trigger: Trigger): CandidateCardTrigger {
  return {
    trigger_id: trigger.id,
    actor: trigger.actor.id,
    at: trigger.at,
    preview: preview(trigger.text),
    chars: trigger.text.length
  }
}

/** 卡片上写的下一步：显式候选去路由，主动候选去评估（与上游候选卡的 `next_action` 同义）。 */
function nextAction(strength: Strength): string {
  return strength === 'explicit'
    ? 'Route it with `superagent route`: accept, attach, stop or ignore.'
    : 'Assess it: `superagent eval <trigger_id>`, read more with `eval-read`, then record the answer with `superagent eval-decide <trigger_id>`.'
}

/**
 * 把一次 Eval 的候选投影成卡片。纯函数：只读传入的候选，不读时钟、不读盘。
 * 主 Trigger 是候选里的第一条（与上游候选卡一致；它的顺序就是 Eval 的 `triggerIds`）。
 */
export function candidateCard(candidate: Candidate): CandidateCard {
  const primary = candidate.triggers[0]
  if (primary === undefined) {
    throw new Error('a candidate card needs at least one trigger')
  }
  const others = candidate.triggers.filter((trigger) => trigger.id !== primary.id)
  return {
    kind: 'candidate',
    eval_id: candidate.evalId,
    trigger_id: primary.id,
    source: primary.source,
    actor: primary.actor.id,
    human: primary.human,
    at: primary.at,
    thread: candidate.thread.key,
    strength: candidate.strength,
    policy_version: candidate.policyVersion,
    preview: preview(primary.text),
    chars: primary.text.length,
    batch: others.slice(0, CANDIDATE_BATCH_LIMIT).map(triggerLine),
    related_tickets: candidate.tickets.slice(0, CANDIDATE_TICKETS_LIMIT).map((ticket) => ({
      ticket_id: ticket.id,
      title: ticket.title,
      state: ticket.ended?.outcome ?? 'open'
    })),
    tickets_total: candidate.tickets.length,
    next_action: nextAction(candidate.strength)
  }
}

/** 终端那一行的摘要：强度 + 触发者 + 预览（完整事实在正文里）。 */
export function candidateSummary(card: CandidateCard): string {
  return `${card.strength} candidate from ${card.actor}: ${card.preview}`
}

/** 卡片正文：头部事实 + 原样的 Trigger 文本 + 卡片的 JSON（Router 读它，或直接读这个文件）。 */
export function candidateBody(card: CandidateCard, triggerText: string, at: number): string {
  return [
    `# Candidate ${card.eval_id}`,
    '',
    `- trigger: ${card.trigger_id}`,
    `- source: ${card.source}`,
    `- actor: ${card.actor} (${card.human ? 'human' : 'bot or CI'})`,
    `- at: ${card.at}`,
    `- thread: ${card.thread}`,
    `- strength: ${card.strength}`,
    `- policy version: ${card.policy_version}`,
    `- batch: ${card.batch.length} other trigger(s)`,
    `- related tickets: ${card.related_tickets.length} of ${card.tickets_total}`,
    `- relayed at: ${new Date(at).toISOString()}`,
    '',
    '## Trigger text',
    '',
    triggerText === '' ? '(empty)' : triggerText,
    '',
    '## Card',
    '',
    '```json',
    JSON.stringify(card, null, 2),
    '```',
    ''
  ].join('\n')
}

/** 队列只需要「注册一种 kind 的 handler」（`Effects` 结构上满足它）。 */
export interface AssessmentQueue {
  handle<K extends EffectKind>(
    kind: K,
    run: (payload: EffectPayloads[K], key: string) => void | Promise<void>
  ): void
}

/** 一次候选卡送达：由 `router/relay.ts` 的串行写手实现（与 relay/notice 共用同一条链）。 */
export type RouterCardDelivery = (card: RouterCard) => Promise<void>

/** `assessment` effect 的接线：领域读口（候选与送达标记）+ 送达端口 + 时钟。 */
export interface AssessmentEffectsOptions {
  readonly effects: AssessmentQueue
  /** 持有 `triggerId` 的那次 Eval 的候选；没有时 undefined（Eval 已结束/被替换）。 */
  readonly candidate: (triggerId: string) => Candidate | undefined
  /** 候选送达 Router：启动这次 Eval 的计时（§K.7）。 */
  readonly delivered: (evalId: string) => void
  readonly deliver: RouterCardDelivery
  /** 毫秒时钟：写进正文的送达时刻。 */
  readonly now: () => number
  readonly log?: (message: string) => void
}

/**
 * 注册 `assessment` 的 handler（§J.2 的 kind 表：并发 4、暂停时 0、2 s→60 s 退避）。
 *
 * 幂等与过期：`key` 是 evalId，payload 指向主 Trigger。运行到一半时 Eval 可能已经结束
 * （被决定、超时或 Policy 复评）——那时 `candidate` 不再是同一个 evalId，卡片没有意义，
 * 这一行正常结束（删掉），不送卡、也不起算时钟。
 */
export function registerAssessmentEffects(options: AssessmentEffectsOptions): void {
  options.effects.handle('assessment', async (payload, evalId) => {
    const candidate = options.candidate(payload.triggerId)
    if (candidate === undefined || candidate.evalId !== evalId) {
      options.log?.(`the assessment ${evalId} is no longer waiting; no card was relayed`)
      return
    }
    const card = candidateCard(candidate)
    await options.deliver({
      name: `eval-${evalId}`,
      summary: candidateSummary(card),
      body: candidateBody(card, candidate.triggers[0]?.text ?? '', options.now())
    })
    // §K.7：候选**送达 Router** 之后才起算 Eval 的截止时间。
    options.delivered(evalId)
  })
}

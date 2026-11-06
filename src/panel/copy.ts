// 面板文案表的**领域术语段**（§M.5）：`terms` 段只给状态/原因/强度/结局的措辞，键与
// `core` 的码表由 `terms.test.ts` 逐组核对。
//
// 为什么在领域票里就有它：票面要求「原因码、状态码、强度码集中成表，面板文案表与它一一
// 对应」。完整的双语文案表（页面文案、`glossary`、`problem.*`）由面板壳票（#14）在
// `copy.ts` 里继续扩写；本文件只声明它现在拥有的那几个组，并给出「加一个码就必须加一行
// 文案」的机械检查所需的最小导出。面板壳票扩写时保持这些导出的形状即可。

/** 一段两种语言的文案；两段都必填（不留「翻译未完成」占位，§M.5）。 */
export interface Bilingual {
  readonly zh: string
  readonly en: string
}

/** `stage` 组的码：§E.8「面板标签」一列，`blocked` 与 `failed` 共用一个标签。 */
export const STAGE_TERMS = ['delivery', 'answer', 'review', 'blockedFailed', 'queued', 'idle', 'working'] as const
export type StageTerm = (typeof STAGE_TERMS)[number]

/**
 * 术语键的联合：`<组>.<码>`。组与码都来自 `core` 的码表（外加 `stage` 组本身），
 * `terms.test.ts` 断言两个方向的集合相等。
 */
export type CopyKey =
  | `reason.${string}`
  | `report.${string}`
  | `assignment.${string}`
  | `decision.${string}`
  | `strength.${string}`
  | `outcome.${string}`
  | `endBy.${string}`
  | `stage.${StageTerm}`
  | `userError.${string}`

/** 取值用的词组；面板壳票扩写页面文案时把它们一起用。 */
export const COPY_GROUPS = {
  stage: STAGE_TERMS
} as const

/** 有双语的组：`terms` 段里的每一组都必须两种语言齐备。 */
export const LOCALIZED_GROUPS = [
  'reason',
  'report',
  'assignment',
  'decision',
  'strength',
  'outcome',
  'endBy',
  'stage',
  'userError'
] as const

/**
 * 领域术语的双语措辞。中文沿用上游 §001 术语表的译名（Ticket 工单、Assignment 派工、
 * Report 报告、Attention 待人工决定……）。`reason.said` 是「某人原话」，面板直接显示
 * `{text}` 而不翻译（与上游 `reason.said` 同）。
 */
export const TERMS: Readonly<Record<CopyKey, Bilingual>> = {
  // --- Report 状态（§E.8 的 Report 映射表） ---
  'report.progress': { zh: '进展', en: 'Progress' },
  'report.waiting': { zh: '等待', en: 'Waiting' },
  'report.ready': { zh: '就绪', en: 'Ready' },
  'report.blocked': { zh: '受阻', en: 'Blocked' },
  'report.failed': { zh: '失败', en: 'Failed' },
  'report.dropped': { zh: '无需处理', en: 'Nothing to do' },

  // --- Assignment 状态（§E.3） ---
  'assignment.pending': { zh: '待启动', en: 'Pending' },
  'assignment.running': { zh: '执行中', en: 'Running' },
  'assignment.ended': { zh: '已结束', en: 'Ended' },

  // --- Decision（§D.2） ---
  'decision.accept': { zh: '接单', en: 'Accept' },
  'decision.stop': { zh: '停止', en: 'Stop' },
  'decision.ignore': { zh: '忽略', en: 'Ignore' },
  'decision.unavailable': { zh: '未完成', en: 'Unavailable' },

  // --- 强度（§K.2） ---
  'strength.explicit': { zh: '明确', en: 'Explicit' },
  'strength.inferred': { zh: '推断', en: 'Inferred' },

  // --- 结局（§E.8 / §I.5） ---
  'outcome.completed': { zh: '已完成', en: 'Completed' },
  'outcome.merged': { zh: 'PR 已合并', en: 'Pull request merged' },
  'outcome.closed': { zh: 'PR 已关闭（未合并）', en: 'Pull request closed unmerged' },
  'outcome.dropped': { zh: '无需处理', en: 'Nothing to do' },
  'outcome.stopped': { zh: '人工停止', en: 'Stopped by a person' },

  // --- 谁结束的 ---
  'endBy.executor': { zh: '执行器', en: 'Executor' },
  'endBy.human': { zh: '人', en: 'A person' },

  // --- 面板的七个 stage 标签（§E.8「面板标签」列） ---
  'stage.delivery': { zh: '待投递', en: 'Input undelivered' },
  'stage.answer': { zh: '待回答', en: 'Awaiting answer' },
  'stage.review': { zh: '待评审', en: 'Awaiting review' },
  'stage.blockedFailed': { zh: '阻塞或失败', en: 'Blocked · Failed' },
  'stage.queued': { zh: '排队', en: 'Queued' },
  'stage.idle': { zh: '闲置', en: 'Waiting for a Trigger' },
  'stage.working': { zh: '工作中', en: 'Working' },

  // --- 原因码（`core/reasons.ts` 的 REASONS；`said` 显示原话） ---
  'reason.said': { zh: '{text}', en: '{text}' },
  'reason.timeout': { zh: '评估超时未决定', en: 'Assessment timed out' },
  'reason.policyChanged': { zh: '评估期间策略已变更', en: 'Policy changed during assessment' },
  'reason.noAdmissible': { zh: '没有可准入的触发', en: 'No admissible trigger' },
  'reason.startedTicket': { zh: '已经开过工单 {ticket}', en: 'Already started ticket {ticket}' },
  'reason.acceptedBefore': { zh: '触发 {trigger} 之前已接单', en: 'Trigger {trigger} was accepted before' },
  'reason.routed': { zh: '已转给工单 {ticket}', en: 'Routed to ticket {ticket}' },
  'reason.forwarded': {
    zh: '已扇出给该线程的工单',
    en: 'Forwarded to the worker of the Ticket already on this Thread'
  },
  'reason.senderNotMember': {
    zh: '发送者不在这个来源的名单里',
    en: "The sender is not on the Source's list"
  },
  'reason.retried': { zh: '人工重试', en: 'Retried by a person' },
  'reason.hostRestarted': { zh: '主机已重启', en: 'The host restarted' },
  'reason.stopUnknown': { zh: '要停止的工单不存在或已结束', en: 'Stop target is unknown or already ended' },
  'reason.stopNotExplicit': {
    zh: '停止需要名单里的人明确要求',
    en: 'A stop needs an explicit request from a sender on the list'
  },
  'reason.directionUnsettled': {
    zh: '实现意图或目标未确定，或还要产品或设计决定',
    en: 'Implementation intent or target direction is not established, or a product/design decision is still required'
  },
  'reason.noRuleMatched': { zh: '没有启用的准入规则匹配', en: 'No enabled admission rule matched' },
  'reason.ignoredFromCard': {
    zh: '仅凭候选卡片忽略，未经规则研判',
    en: 'Ignored from its card, without a rule assessment'
  },
  'reason.observed': { zh: '观察模式：本会接单（{text}）', en: 'Observe mode: would accept ({text})' },
  'reason.reportMissing': {
    zh: 'worker 结束却没有最终报告',
    en: 'The worker ended without a final report'
  },
  'reason.worktreeRemoved': {
    zh: '工单 worktree 在插件之外被删除',
    en: 'The ticket worktree was removed outside the plugin'
  },
  'reason.interrupted': { zh: '主机在派工期间重启', en: 'The host restarted during the assignment' },

  // --- 用户可见的固定错误码（`core/errors.ts` 的 USER_ERRORS） ---
  'userError.unknownTicket': { zh: '未知的工单', en: 'Unknown ticket' },
  'userError.unknownTrigger': { zh: '未知的触发', en: 'Unknown trigger' },
  'userError.unknownAssignment': { zh: '未知的派工', en: 'Unknown assignment' },
  'userError.unknownProblem': { zh: '找不到这条未完成的评估', en: 'Unavailable Eval not found' },
  'userError.ticketEnded': { zh: '工单已结束', en: 'Ticket has ended' },
  'userError.assignmentEnded': {
    zh: '派工已结束；该工单属于更新的派工',
    en: 'Assignment has ended; a newer assignment owns this ticket'
  },
  'userError.evalFinished': {
    zh: '评估 {eval} 已结束或被更晚的评估替换；请决定该触发当前的评估',
    en: "Eval {eval} has finished or a later eval replaced it; decide the trigger's current eval"
  },
  'userError.notAdmissible': { zh: '触发不可准入：{reason}', en: 'Trigger is not admissible: {reason}' },
  'userError.notExplicit': {
    zh: '主 Session 的接单只用于名单里的人的明确请求；主动候选只在 auto 模式且有启用匹配规则时被接受',
    en: 'An accept through the main Session is for explicit requests from allowed senders; proactive candidates are accepted only in auto mode with enabled matching rules'
  },
  'userError.ticketStopped': {
    zh: '有人停了这个工单；新工作需要经主 Session 接单',
    en: 'A person stopped this ticket; new work needs an accept through the main Session'
  },
  'userError.mandateRevoked': {
    zh: '当前策略不再持有该工单的授权；新工作需要经主 Session 接单',
    en: "The current policy no longer holds this ticket's mandate; new work needs an accept through the main Session"
  },
  'userError.notRetryable': {
    zh: '只有未结束、且 worker 最近报告失败或受阻（此后无人发消息）或输入投递失败的工单可以重试',
    en: 'Only an open ticket can be retried, and only when its worker last reported failed or blocked and no person has sent a message since, or when delivering an Input to its worker failed'
  },
  'userError.sourceThread': {
    zh: '这是该工单开始的线程，它保持订阅',
    en: 'This is the thread the ticket started on; it stays subscribed'
  },
  'userError.followedThread': {
    zh: '这是该工单自己的线程（例如它的 PR），它保持订阅',
    en: "This thread is the ticket's own, such as its pull request's; it stays subscribed"
  },
  'userError.notFollowing': { zh: '该工单没有跟随那个线程', en: 'This ticket does not follow that thread' },
  'userError.questionWithResult': {
    zh: '给人的问题不能同时是 ready 结果或回答；请分开报告',
    en: 'A question for a person cannot also be a ready result or an answer; report it separately'
  },
  'userError.askerWithoutQuestion': {
    zh: '提出问题的消息必须带上它提出的问题',
    en: 'The message that raised a question needs the question it raised'
  },
  'userError.notAsker': {
    zh: '问题必须指名提出它的人的消息，且那条消息到达过该工单',
    en: "A question must name the person's message that raised it, which reached this ticket"
  },
  'userError.notAnswerable': {
    zh: '回答必须指名它所回答的人的问题，且那条消息到达过该工单',
    en: "An answer must name the person's question it answers, which reached this ticket"
  },
  'userError.ackEnded': {
    zh: '工单已结束；不要确认历史请求',
    en: 'Ticket ended; do not acknowledge historical requests'
  },
  'userError.notReached': { zh: '触发不属于这个 worker', en: 'Trigger does not belong to this worker' },
  'userError.handedBack': { zh: '该工单已经交回过那条触发', en: 'This ticket handed that trigger back already' },
  'userError.handedBackHere': {
    zh: '该工单的 worker 把那条触发当作超出范围交回了：请作为新工作接单、attach 给别的工单，或忽略',
    en: 'The worker of this ticket handed that trigger back as beyond it: accept it as new work, attach it to another ticket, or ignore it'
  },
  'userError.workerDecides': {
    zh: '这条消息在它的线程上到达了工单 {tickets}：由那个 worker 判断是否属于它，超出范围的会交回并成为候选。只有 stop 经主 Session，用 kind stop',
    en: 'This message reached ticket {tickets} on its thread: its worker decides whether it belongs there and hands back what does not, which then arrives as a candidate. Only a stop goes through the main Session, with kind stop'
  },
  'userError.ackNoChannel': {
    zh: '确认需要一条已分配的人的消息',
    en: 'Acknowledgement requires an assigned human source message'
  },
  'userError.ackNotPerson': {
    zh: '用原始的人的消息，不要用 bot、CI 或 worker 的报告',
    en: 'Use the original human trigger, not a bot, CI or worker report'
  },
  'userError.notReady': {
    zh: '工单还没到可交付的状态。把进展留在内部，等一次经验证的 ready 报告；不要把进展改标成回答或走别的渠道。',
    en: 'Ticket is not ready for delivery. Keep progress internal and wait for a verified ready report; do not relabel progress as an answer or send it through another channel.'
  },
  'userError.notAttention': {
    zh: '待人工需要该工单当前的问题原文（human_action）。日常未完成的工作留在内部。',
    en: "Attention requires the ticket's current attention question in human_action. Routine unfinished work stays internal."
  },
  'userError.notQuestion': {
    zh: '回答必须针对原始的人的问题，而不是 worker 的报告或自动触发',
    en: 'An answer must target the original human question, not a worker report or automated trigger'
  },
  'userError.noAnswer': {
    zh: '这条人的触发还没有可用的 worker 回答。等 worker 报告，或向报告了 waiting 的 worker 要一次状态；普通进展不能被改标成回答。',
    en: "No worker answer is ready for this human trigger. Wait for the worker's report, or request one with the ticket status command, which acts only on a worker that reported waiting; ordinary progress cannot be relabelled as an answer."
  },
  'userError.noChannel': { zh: '该工单或触发没有可回复的渠道', en: 'No reply channel for this ticket or trigger' }
}

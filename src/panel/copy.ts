// 面板唯一的文案表（§M.5）：`{ key: { zh, en } }`，页面上不出现裸字符串。
// 领域术语沿用设计里的中文译名（Source 来源、Trigger 触发、Thread 线程、Eval 评估、
// Decision 决定、Mandate 授权、Ticket 工单、Assignment 派工、Attention 待人工决定、
// Disposition 去向、Input 输入、Report 报告、Strength 强度）。
// 术语表内容也在这里（`glossary.*`），它由页头 `(?)` 覆盖层渲染，不是第八个导航项。
//
// 面板侧纯数据模块：不 import `orca`，不碰 worker（§C.2 规则 3）。

/** 一条文案的两种语言。 */
export interface CopyPair {
  readonly zh: string
  readonly en: string
}

/** 全部文案。键名即页面上的位置；`terms` 段放状态/原因/强度的措辞（§M.5）。 */
export const COPY = {
  // ---- 面板本身 ----
  'panel.title': { zh: 'Superagent', en: 'Superagent' },
  'panel.subtitle': {
    zh: '监督一个主动工作的编码智能体：来源、触发、工单与报告。',
    en: 'Supervises a proactive coding agent: sources, triggers, tickets and reports.'
  },
  'panel.glossaryOpen': { zh: '术语表', en: 'Glossary' },
  'panel.glossaryClose': { zh: '关闭术语表', en: 'Close the glossary' },
  'panel.glossaryIntro': {
    zh: '界面只显示一种语言；文档、代码和工具使用英文术语。',
    en: 'The interface shows one language; documents, code and tools use the English terms.'
  },
  'panel.termColumn': { zh: '术语', en: 'Term' },
  'panel.meaningColumn': { zh: '含义', en: 'Meaning' },

  // ---- 七个导航项（§M.1）----
  'nav.overview': { zh: '概览', en: 'Overview' },
  'nav.source': { zh: '来源', en: 'Source' },
  'nav.trigger': { zh: '触发', en: 'Trigger' },
  'nav.eval': { zh: '评估', en: 'Eval' },
  'nav.execution': { zh: '执行', en: 'Execution' },
  'nav.settings': { zh: '设置', en: 'Settings' },
  'nav.search': { zh: '搜索', en: 'Search' },

  // ---- 冷启动与三态（§M.6、§M.2）----
  'boot.starting': {
    zh: 'Superagent worker 正在启动…',
    en: 'Superagent worker is starting…'
  },
  'boot.retrying': {
    zh: 'Superagent worker 还未应答，正在重试一次…',
    en: 'The Superagent worker has not answered; retrying once…'
  },
  'boot.unavailable': {
    zh: 'Superagent worker 没有应答。',
    en: 'The Superagent worker did not answer.'
  },
  'state.loading': { zh: '正在读取…', en: 'Loading…' },
  'state.empty': { zh: '暂无。', en: 'None.' },
  'state.retry': { zh: '重试', en: 'Retry' },
  'state.errorTitle': { zh: '读取失败', en: 'Could not read this page' },
  'state.errorHint': {
    zh: '原因：{reason}。重试不会重启 worker，只会再问一次。',
    en: 'Reason: {reason}. Retrying asks again; it does not restart the worker.'
  },
  'state.loadMore': { zh: '加载更多', en: 'Load more' },

  // ---- Overview 页（本票只交付壳；读数由 #37 填实）----
  'overview.nothingNeedsYou': { zh: '没有需要你处理的事。', en: 'Nothing needs you.' },
  'overview.awaitingYou': { zh: '待人工', en: 'Needs you' },
  'overview.problems': { zh: '系统问题', en: 'System problems' },
  'overview.problemCount': { zh: '系统问题：{count}', en: 'System problems: {count}' },
  'overview.flow': { zh: '24 小时流水', en: 'Last 24 hours' },
  'overview.flowReceived': { zh: '收到 {count}', en: '{count} received' },
  'overview.flowEvaluated': { zh: '评估 {count}', en: '{count} evaluated' },
  'overview.flowAccepted': { zh: '接单 {count}', en: '{count} accepted' },
  'overview.flowIgnored': { zh: '忽略 {count}', en: '{count} ignored' },
  'overview.flowEnded': { zh: '结束 {count}', en: '{count} ended' },
  'overview.executor': { zh: '执行器负载', en: 'Executor load' },
  'overview.executorLoad': { zh: '运行中 {running} / {maxWorkers}', en: '{running} / {maxWorkers} running' },
  'processing.paused': { zh: '处理已暂停。', en: 'Processing is paused.' },
  'setup.missing': {
    zh: '部署检查还没通过，Superagent 不能开始工作。',
    en: 'Setup has not passed, so Superagent cannot start working.'
  },
  'setup.openSettings': { zh: '去设置', en: 'Open Settings' },

  // ---- 状态栏项（§N.7）----
  'status.idle': { zh: 'Superagent', en: 'Superagent' },
  'status.count': { zh: '待人工 {count}', en: '{count} need you' },
  'status.paused': { zh: 'Superagent 已暂停', en: 'Superagent paused' },
  'status.error': { zh: 'Superagent 出错', en: 'Superagent error' },
  'status.tooltip': {
    zh: '{answer} 待回答 · {review} 待评审 · {problems} 问题',
    en: '{answer} awaiting answer · {review} awaiting review · {problems} problem'
  },

  // ---- 页头与通用操作 ----
  'action.refresh': { zh: '重新检查', en: 'Check again' },
  'action.open': { zh: '打开', en: 'Open' },
  'action.details': { zh: '查看全部', en: 'See all' },
  'action.save': { zh: '保存', en: 'Save' },
  'action.discard': { zh: '放弃修改', en: 'Discard' },
  'action.confirm': { zh: '确定', en: 'Confirm' },
  'action.cancel': { zh: '取消', en: 'Cancel' },
  'action.close': { zh: '关闭', en: 'Close' },
  'action.copy': { zh: '复制', en: 'Copy' },
  'action.pause': { zh: '暂停处理', en: 'Pause processing' },
  'action.resume': { zh: '恢复处理', en: 'Resume processing' },
  'action.stop': { zh: '停止', en: 'Stop' },
  'action.retry': { zh: '重试', en: 'Retry' },
  'action.follow': { zh: '关注', en: 'Follow' },
  'action.unfollow': { zh: '取消关注', en: 'Unfollow' },
  'page.placeholder': {
    zh: '这一页由后续票据填充；本票只交付面板壳。',
    en: 'A later ticket fills this page; this ticket ships the shell.'
  },
  'page.notFound': { zh: '没有这一页。', en: 'No such page.' },

  // ---- 确认对话（§M.2：行内二次确认，无模态框）----
  'confirm.title': { zh: '确认{action}', en: 'Confirm {action}' },
  'confirm.body': { zh: '确定要{action}吗？「{target}」', en: 'Really {action} “{target}”?' },
  'confirm.bodyPlain': { zh: '确定要{action}吗？', en: 'Really {action}?' },
  'confirm.pending': { zh: '正在执行…', en: 'Working…' },

  // ---- 设置草稿与保存栏（§M.3）----
  'draft.changes': { zh: '{count} 处改动', en: '{count} changes' },
  'draft.changeOne': { zh: '{count} 处改动', en: '{count} change' },
  'draft.saving': { zh: '正在保存…', en: 'Saving…' },
  'draft.saved': { zh: '已保存', en: 'Saved' },
  'draft.failed': { zh: '保存失败：{error}', en: 'Save failed: {error}' },
  'draft.invalid': { zh: '这些字段不合法：{fields}', en: 'These fields are invalid: {fields}' },
  'draft.conflict': {
    zh: '这一段在别处被改过（现在是修订 {revision}）。要重新载入最新内容吗？',
    en: 'This block changed elsewhere (now at revision {revision}). Reload the latest?'
  },
  'draft.reload': { zh: '重新载入', en: 'Reload' },
  'draft.listSeparator': { zh: '、', en: ', ' },

  // ---- 提示词全文的 diff（§M.3 Prompts 的 Full prompt）----
  'diff.folded': { zh: '… {count} 行未改动', en: '… {count} unchanged lines' },
  'prompt.sameAsSaved': { zh: '与已保存内容相同。', en: 'Same as the saved text.' },

  // ---- 表格列与分组 ----
  'column.name': { zh: '名称', en: 'Name' },
  'column.state': { zh: '状态', en: 'State' },
  'column.stage': { zh: '阶段', en: 'Stage' },
  'column.title': { zh: '标题', en: 'Title' },
  'column.kind': { zh: '类型', en: 'Kind' },
  'column.reason': { zh: '原因', en: 'Reason' },
  'column.strength': { zh: '强度', en: 'Strength' },
  'column.policyVersion': { zh: '策略版本', en: 'Policy version' },
  'column.updated': { zh: '更新于', en: 'Updated' },
  'column.count': { zh: '数量', en: 'Count' },
  'column.at': { zh: '时间', en: 'When' },
  'column.source': { zh: '来源', en: 'Source' },
  'column.rule': { zh: '规则', en: 'Rule' },

  // ---- 术语（§M.5 的译名）----
  'term.source': { zh: '来源', en: 'Source' },
  'term.trigger': { zh: '触发', en: 'Trigger' },
  'term.thread': { zh: '线程', en: 'Thread' },
  'term.correlation': { zh: '关联', en: 'Correlation' },
  'term.channel': { zh: '渠道', en: 'Channel' },
  'term.policy': { zh: '策略', en: 'Policy' },
  'term.eval': { zh: '评估', en: 'Eval' },
  'term.gate': { zh: '准入', en: 'Gate' },
  'term.assessment': { zh: '研判', en: 'Assessment' },
  'term.decision': { zh: '决定', en: 'Decision' },
  'term.mandate': { zh: '授权', en: 'Mandate' },
  'term.ticket': { zh: '工单', en: 'Ticket' },
  'term.assignment': { zh: '派工', en: 'Assignment' },
  'term.subscription': { zh: '订阅', en: 'Subscription' },
  'term.fanout': { zh: '扇出', en: 'Fan-out' },
  'term.executor': { zh: '执行器', en: 'Executor' },
  'term.report': { zh: '报告', en: 'Report' },
  'term.attention': { zh: '待人工决定', en: 'Attention' },
  'term.disposition': { zh: '去向', en: 'Disposition' },
  'term.input': { zh: '输入', en: 'Input' },
  'term.scope': { zh: '范围', en: 'Scope' },
  'term.strength': { zh: '强度', en: 'Strength' },
  'term.agent': { zh: '智能体', en: 'Agent' },
  'term.mainSession': { zh: '主 Session', en: 'Main Session' },
  'term.executorSession': { zh: '执行器 Session', en: 'Executor Session' },
  'term.policyVersion': { zh: '策略版本', en: 'Policy version' },
  'term.environment': { zh: '执行环境', en: 'Execution environment' },

  // ---- 术语表含义（覆盖层的内容，§M.1）----
  'glossary.group.roles': { zh: '角色', en: 'Roles' },
  'glossary.group.source': { zh: '来源与渠道', en: 'Sources and channels' },
  'glossary.group.trigger': { zh: '触发与线程', en: 'Triggers and threads' },
  'glossary.group.eval': { zh: '评估与授权', en: 'Eval and mandate' },
  'glossary.group.execution': { zh: '执行', en: 'Execution' },
  'glossary.meaning.agent': {
    zh: '以 Superagent 身份工作的虚拟同事：通过 GitHub 账号、飞书机器人等身份在来源上行动',
    en: 'The virtual colleague Superagent runs: it acts on the Sources through its identities, such as a GitHub account or a Feishu bot'
  },
  'glossary.meaning.mainSession': {
    zh: '评估触发、接单派工并回复的会话；提示词里称 orchestrator',
    en: 'The session that evaluates Triggers, accepts and dispatches work and replies; prompts call it the orchestrator'
  },
  'glossary.meaning.executorSession': {
    zh: '执行器为一个工单运行的会话；提示词里称 worker',
    en: 'The session the Executor runs for one Ticket; prompts call it the worker'
  },
  'glossary.meaning.policyVersion': {
    zh: '接单规则、各来源上的策略和接单模式的一个组合的标识；每个工单记下接单时的版本',
    en: 'Identifier of one combination of rules, each Source’s Policy and the accept mode; each Ticket records the version it was accepted under'
  },
  'glossary.meaning.source': {
    zh: '产生触发的事件流；由插件提供的类型加一份配置（是否运行、监听什么）',
    en: 'An event stream that produces Triggers; a plugin-provided kind plus one configuration (whether it runs, what it listens to)'
  },
  'glossary.meaning.channel': {
    zh: '线程的只写端，用于回复',
    en: 'The write-only side of a Thread, for replies'
  },
  'glossary.meaning.trigger': { zh: '来源产生的单个不可变事件', en: 'One immutable event produced by a Source' },
  'glossary.meaning.thread': { zh: '按时间排列的触发；同一时间只有一个评估', en: 'Triggers in time order; one Eval at a time' },
  'glossary.meaning.correlation': {
    zh: '一个触发同属多个线程时线程之间的关系，只用来补充上下文',
    en: 'Relation between Threads that share a Trigger; context only'
  },
  'glossary.meaning.subscription': {
    zh: '工单与线程的关系；线程上的触发作为上下文送达工单',
    en: 'Relation between a Ticket and a Thread; Triggers on it reach the Ticket as context'
  },
  'glossary.meaning.fanout': {
    zh: '订阅线程上的触发作为上下文送达工单，不带授权',
    en: 'Triggers on a subscribed Thread reach the Ticket as context, without authority'
  },
  'glossary.meaning.disposition': {
    zh: '一个触发被过滤、评估、扇出的记录',
    en: 'Where a Trigger went: filtered, evaluated, fanned out'
  },
  'glossary.meaning.policy': {
    zh: '版本化的接单规则和各来源上的名单；决定谁能发起工作、接什么',
    en: 'Versioned rules and each Source’s list; decides who may originate work and what is accepted'
  },
  'glossary.meaning.eval': {
    zh: '对一批触发做出决定的过程',
    en: 'The process that turns a batch of Triggers into a Decision'
  },
  'glossary.meaning.gate': {
    zh: '评估的第一层：谁能发起工作、强度多少',
    en: 'First Eval layer: who may originate work, and how strongly'
  },
  'glossary.meaning.assessment': {
    zh: '评估中的模型语义判断',
    en: 'Eval step where the model judges meaning'
  },
  'glossary.meaning.decision': { zh: '评估的结果', en: 'The result of an Eval' },
  'glossary.meaning.mandate': {
    zh: '接单时产出的授权：强度、范围、依据的策略版本',
    en: 'Authorization produced by accept: strength, scope and Policy version'
  },
  'glossary.meaning.scope': { zh: '授权允许的工作范围', en: 'The work a Mandate allows' },
  'glossary.meaning.strength': {
    zh: '授权与评估的依据强度',
    en: 'How strong the grounds of a Mandate or Eval are'
  },
  'glossary.meaning.executor': {
    zh: '执行派工的一方：每个工单一个 worktree 和一个 worker agent',
    en: 'What runs Assignments: one worktree and one worker agent per Ticket'
  },
  'glossary.meaning.environment': {
    zh: '每个工单的 worker agent 与准备命令运行的环境：执行器和各来源登记的变量',
    en: 'Where a Ticket’s worker agent and prepare command run: the variables the Executor and the Sources register'
  },
  'glossary.meaning.ticket': { zh: '被授权的工作单位', en: 'An authorized unit of work' },
  'glossary.meaning.assignment': {
    zh: '工单与一个 worker agent 终端的绑定',
    en: 'Binding of a Ticket to one worker agent terminal'
  },
  'glossary.meaning.input': {
    zh: '送达工单的上下文（扇出的触发、策略变更、恢复、文本）',
    en: 'Context delivered to a Ticket (fanned-out Triggers, Policy changes, resumes, text)'
  },
  'glossary.meaning.report': {
    zh: '派工向工单回报的状态',
    en: 'State an Assignment reports to its Ticket'
  },
  'glossary.meaning.attention': {
    zh: '工单上等待人回答的问题',
    en: 'A question on a Ticket waiting for a human'
  },
  'term.ended': { zh: '已结束', en: 'Ended' },

  // ---- 状态标记的措辞（`marks.ts`；§M.5 的 `terms` 段）----
  'stage.answer': { zh: '待回答', en: 'Awaiting answer' },
  'stage.review': { zh: '待验收', en: 'Awaiting review' },
  'stage.blocked': { zh: '待处理受阻', en: 'Blocked' },
  'stage.failed': { zh: '待处理失败', en: 'Failed' },
  'stage.delivery': { zh: '输入未送达', en: 'Input undelivered' },
  'stage.queued': { zh: '排队中', en: 'Queued' },
  'stage.working': { zh: '执行中', en: 'Working' },
  'stage.idle': { zh: '等待新触发', en: 'Waiting for a Trigger' },
  'stage.ended': { zh: '已结束', en: 'Ended' },
  'kind.accept': { zh: '接单', en: 'Accept' },
  'kind.reopen': { zh: '续做', en: 'Reopen' },
  'kind.stop': { zh: '停止', en: 'Stop' },
  'kind.ignore': { zh: '忽略', en: 'Ignore' },
  'kind.unavailable': { zh: '未完成', en: 'Unavailable' },
  'kind.wouldAccept': { zh: '忽略（可接单，仅观察）', en: 'Ignore (would accept; observe only)' },
  'strength.explicit': { zh: '明确', en: 'Explicit' },
  'strength.inferred': { zh: '推断', en: 'Inferred' },
  'thread.subscribed': { zh: '已订阅', en: 'Subscribed' },
  'thread.evaluating': { zh: '评估进行中', en: 'Evaluating' },
  'thread.queued': { zh: '排队 {count}', en: 'Queued {count}' },
  'thread.error': { zh: '轮询失败', en: 'Polling failed' },
  'thread.dormant': { zh: '工单已结束', en: 'Ticket ended' },
  'thread.unsubscribed': { zh: '未订阅', en: 'Unsubscribed' },
  'source.ready': { zh: '运行中', en: 'Ready' },
  'source.starting': { zh: '启动中', en: 'Starting' },
  'source.paused': { zh: '待处理', en: 'Paused' },
  'source.error': { zh: '出错', en: 'Error' },
  'source.setup': { zh: '等待部署检查', en: 'Waiting for setup' },
  'source.off': { zh: '已关闭', en: 'Off' },
  'source.missing': { zh: '插件未安装', en: 'Not installed' },
  'report.progress': { zh: '进行中', en: 'Progress' },
  'report.waiting': { zh: '等待中', en: 'Waiting' },
  'report.ready': { zh: '可评审', en: 'Ready' },
  'report.blocked': { zh: '受阻', en: 'Blocked' },
  'report.failed': { zh: '失败', en: 'Failed' },
  'report.dropped': { zh: '无需处理', en: 'Dropped' }
} as const satisfies Readonly<Record<string, CopyPair>>

/** 文案键。 */
export type CopyKey = keyof typeof COPY

/** 设计 §M.5 固定的领域术语顺序（术语表按这个顺序分组）。 */
export const TERMS = [
  'agent',
  'mainSession',
  'executorSession',
  'source',
  'channel',
  'trigger',
  'thread',
  'correlation',
  'subscription',
  'fanout',
  'disposition',
  'policy',
  'policyVersion',
  'eval',
  'gate',
  'assessment',
  'decision',
  'mandate',
  'scope',
  'strength',
  'executor',
  'environment',
  'ticket',
  'assignment',
  'input',
  'report',
  'attention'
] as const

/** 术语表的一项分组：标题的文案键 + 该组的术语（术语的文案键是 `term.<name>`）。 */
export interface GlossaryGroup {
  readonly key: string
  readonly label: CopyKey
  readonly terms: readonly (typeof TERMS)[number][]
}

/** 术语表的五个分组，顺序即覆盖层的阅读顺序（角色 → 来源 → 触发 → 评估 → 执行）。 */
export const GLOSSARY_GROUPS: readonly GlossaryGroup[] = [
  { key: 'roles', label: 'glossary.group.roles', terms: ['agent', 'mainSession', 'executorSession'] },
  { key: 'source', label: 'glossary.group.source', terms: ['source', 'channel'] },
  {
    key: 'trigger',
    label: 'glossary.group.trigger',
    terms: ['trigger', 'thread', 'correlation', 'subscription', 'fanout', 'disposition']
  },
  {
    key: 'eval',
    label: 'glossary.group.eval',
    terms: ['policy', 'policyVersion', 'eval', 'gate', 'assessment', 'decision', 'mandate', 'scope', 'strength']
  },
  {
    key: 'execution',
    label: 'glossary.group.execution',
    terms: ['executor', 'environment', 'ticket', 'assignment', 'input', 'report', 'attention']
  }
]

/** 占位符的填入值。 */
export type CopyValues = Readonly<Record<string, string | number>>

/** 该语言是否是中文（BCP-47 的 `zh`、`zh-CN`、`zh-Hans` 都算）。 */
function isChinese(locale: string): boolean {
  return /^zh(?:[-_]|$)/i.test(locale)
}

/** 按 locale 取一条文案；`{name}` 用 `values` 填入，缺值保留原样而不是印出 undefined。 */
export function translate(locale: string, key: CopyKey, values: CopyValues = {}): string {
  const template = isChinese(locale) ? COPY[key].zh : COPY[key].en
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match
  )
}

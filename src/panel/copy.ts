// 面板唯一的文案表（§M.5）：`{ key: { zh, en } }`，页面上不出现裸字符串。
// 领域术语沿用设计里的中文译名（Source 来源、Trigger 触发、Thread 线程、Eval 评估、
// Decision 决定、Mandate 授权、Ticket 工单、Assignment 派工、Attention 待人工决定、
// Disposition 去向、Input 输入、Report 报告、Strength 强度）。
// 术语表内容也在这里（`glossary.*`），它由页头 `(?)` 覆盖层渲染，不是第八个导航项。
//
// 本文件同时是领域码表的文案面（F5 建立、本票扩写）：`reason.*` / `report.*` /
// `assignment.*` / `decision.*` / `strength.*` / `outcome.*` / `endBy.*` / `stage.*` /
// `userError.*` 的键必须与 `src/worker/core` 的码表逐键相等，`tests/terms.test.ts` 双向核对；
// 页面文案（`nav.*` / `panel.*` / `overview.*` / `glossary.*` …）由本票追加。
//
// 面板侧纯数据模块：不 import `orca`，不碰 worker（§C.2 规则 3）。

/** 一条文案的两种语言。 */
export interface CopyPair {
  readonly zh: string
  readonly en: string
}

/** F5 的同一形状的类型别名（领域票的 `TERMS` 用它）。 */
export type Bilingual = CopyPair

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

  // ---- Overview 页（§M.2 ①–④；本票的四块内容）----
  'overview.nothingNeedsYou': { zh: '没有需要你处理的事。', en: 'Nothing needs you.' },
  'overview.awaitingYou': { zh: '待人工', en: 'Needs you' },
  'overview.otherTickets': { zh: '其他工单', en: 'Other tickets' },
  'overview.sources': {
    zh: '来源：{enabled} 个启用，{problems} 个有问题',
    en: 'Sources: {enabled} enabled, {problems} problems'
  },
  'overview.actions': { zh: '本页操作', en: 'Overview actions' },
  'overview.answer': { zh: '回答', en: 'Answer' },
  'overview.review': { zh: '评审', en: 'Review' },
  'overview.openTerminal': { zh: '打开终端', en: 'Open terminal' },
  'overview.checked': {
    zh: '已检查：{waiting} 个待人工，{problems} 个系统问题。',
    en: 'Checked: {waiting} waiting, {problems} problems.'
  },
  'execution.empty': { zh: '没有工单。', en: 'No tickets.' },

  // ---- Execution 页（§M.2）：五档筛选、表格列、详情七块与动作 ----
  'execution.filters': { zh: '筛选', en: 'Filter' },
  'execution.filter.open': { zh: '开放', en: 'Open' },
  'execution.filter.pending': { zh: '待办', en: 'Pending' },
  'execution.filter.working': { zh: '工作中', en: 'Working' },
  'execution.filter.waiting': { zh: '等待', en: 'Waiting' },
  'execution.filter.ended': { zh: '已结束', en: 'Ended' },
  'execution.columnTicket': { zh: '工单', en: 'Ticket' },
  'execution.columnStage': { zh: '阶段', en: 'Stage' },
  'execution.columnUpdated': { zh: '最近更新', en: 'Updated' },
  'execution.back': { zh: '返回列表', en: 'Back to the list' },
  'execution.mandate': { zh: '授权', en: 'Mandate' },
  'execution.basis': { zh: '准入依据', en: 'Admitted by' },
  'execution.rules': { zh: '匹配规则', en: 'Matched rules' },
  'execution.noRules': { zh: '没有匹配的规则', en: 'No matched rule' },
  'execution.inputs': { zh: '等待中的输入', en: 'Waiting inputs' },
  'execution.noInputs': { zh: '没有等待投递的输入。', en: 'No input is waiting.' },
  'execution.subscriptions': { zh: '订阅的线程', en: 'Subscriptions' },
  'execution.noSubscriptions': { zh: '没有订阅任何线程。', en: 'No threads subscribed.' },
  'execution.contextOnly': { zh: '仅语境', en: 'Context only' },
  'execution.assignments': { zh: '派工', en: 'Assignments' },
  'execution.noAssignments': { zh: '还没有派工。', en: 'No assignment yet.' },
  'execution.reports': { zh: '报告', en: 'Reports' },
  'execution.noReports': { zh: '还没有报告。', en: 'No report yet.' },
  'execution.attention': { zh: '待人工决定', en: 'Attention' },
  'execution.noAttention': { zh: '现在没有等人回答的问题。', en: 'Nothing waits for an answer.' },
  'execution.terminal': { zh: '终端摘要', en: 'Terminal summary' },
  'execution.noTerminal': { zh: '没有终端摘要。', en: 'No terminal summary.' },
  'execution.terminalPreview': { zh: '终端最后几行', en: 'Last lines of the terminal' },
  'execution.actions': { zh: '工单动作', en: 'Ticket actions' },
  'execution.actor': { zh: '发起人', en: 'Actor' },
  'execution.human': { zh: '人写的', en: 'From a person' },
  'execution.input.trigger': { zh: '触发', en: 'Trigger' },
  'execution.input.text': { zh: '文本', en: 'Text' },
  'execution.input.note': { zh: 'fact note', en: 'Fact note' },
  'execution.input.policy-changed': { zh: '策略变更', en: 'Policy change' },
  'execution.input.resumed': { zh: '恢复', en: 'Resumed' },
  'attention.fromTerminal': {
    zh: '来自终端：agent 停在一个提问上',
    en: 'From the terminal: the agent stopped on a question'
  },

  'execution.requestStatus': { zh: '请求状态', en: 'Request status' },
  'execution.openWorktree': { zh: '打开工作区', en: 'Open worktree' },
  'execution.removeWorktree': { zh: '移除 worktree', en: 'Remove worktree' },
  'execution.note': { zh: '发一条 fact note', en: 'Send a fact note' },
  'execution.notePlaceholder': { zh: '只作语境，不授权任何事', en: 'Context only; it grants no authority' },
  'execution.noteSend': { zh: '发送', en: 'Send' },
  'execution.asked': {
    zh: '已向正在等待的 worker 请求状态。',
    en: 'Asked the waiting worker for a status.'
  },
  'execution.notAsked': {
    zh: '现在没有在等 trigger 的 worker，未发出请求。',
    en: 'No worker is waiting for a trigger, so nothing was asked.'
  },
  'execution.endedBy': { zh: '结束于', en: 'Ended by' },

  // ---- Trigger 页（§M.2）：Thread 列表的四档筛选、四列与三态 ----
  'thread.filters': { zh: '筛选', en: 'Filter' },
  'thread.filter.subscribed': { zh: '已订阅', en: 'Subscribed' },
  'thread.filter.evaluating': { zh: '评估中', en: 'Evaluating' },
  'thread.filter.recent': { zh: '24 小时内新增', en: 'New in 24 h' },
  'thread.filter.all': { zh: '全部', en: 'All' },
  'thread.columnThread': { zh: '线程', en: 'Thread' },
  'thread.columnSubscriptions': { zh: '订阅数', en: 'Subscriptions' },
  'thread.columnLatest': { zh: '最近触发', en: 'Latest trigger' },
  'thread.columnState': { zh: '状态', en: 'State' },
  'thread.noLatest': { zh: '还没有触发', en: 'No trigger yet' },
  'thread.empty': { zh: '还没有线程。', en: 'No threads yet' },
  'thread.back': { zh: '返回列表', en: 'Back to the list' },
  'thread.source': { zh: '来源：{source}', en: 'Source: {source}' },
  'thread.created': { zh: '创建于', en: 'Created' },
  'thread.latestAt': { zh: '最近触发', en: 'Latest trigger' },
  'thread.openOriginal': { zh: '打开原始链接', en: 'Open original' },
  'thread.timeline': { zh: '时间线', en: 'Timeline' },
  'thread.noTriggers': { zh: '这条线程还没有触发。', en: 'No Trigger on this Thread yet.' },
  'thread.loadEarlier': { zh: '加载更早的触发', en: 'Load earlier Triggers' },
  'thread.decisions': { zh: '这条线程的决定', en: 'Decisions in this Thread' },
  'thread.noDecisions': { zh: '这条线程还没有决定。', en: 'No Decision on this Thread yet.' },
  'thread.subscribedTickets': { zh: '订阅的工单', en: 'Subscribed tickets' },
  'thread.noSubscribedTickets': {
    zh: '没有工单订阅这条线程。',
    en: 'No ticket subscribes to this Thread.'
  },
  'thread.contextOnly': { zh: '仅语境', en: 'Context only' },
  'thread.ticket.open': { zh: '进行中', en: 'Open' },
  'thread.ticket.ended': { zh: '已结束', en: 'Ended' },
  'thread.ticket.unknown': { zh: '未知工单', en: 'Unknown ticket' },
  'thread.evaluatingBanner': {
    zh: '正在评估 {count} 条触发（强度：{strength}）',
    en: 'Evaluating {count} Triggers (strength: {strength})'
  },
  'thread.evaluatingDeadline': { zh: '截止', en: 'Deadline' },
  'thread.pollFailed': { zh: '轮询失败：{error}', en: 'Polling failed: {error}' },
  'thread.disposition.queued': { zh: '等待评估', en: 'Waiting for Eval' },
  'thread.delivered': { zh: '已交给工单的执行器', en: 'Its worker decides it' },
  'thread.fanout': { zh: '扇出给 {count} 个工单', en: 'Fanned out to {count} tickets' },
  'thread.handedBack': {
    zh: '“{ticket}”的执行器把这条触发交回评估：{reason}',
    en: 'The Executor of “{ticket}” handed it back for an Eval: {reason}'
  },
  'thread.requeue': { zh: '再评估一次', en: 'Evaluate again' },
  'thread.requeued': { zh: '已重新排进评估。', en: 'Queued for a new Eval.' },
  'thread.requeueHeld': {
    zh: '已有评估持有这条触发，没有重复排队。',
    en: 'An Eval already holds this Trigger; nothing was queued.'
  },
  'thread.unsubscribe': { zh: '取消订阅', en: 'Unsubscribe' },
  'thread.unsubscribeDone': { zh: '已取消订阅这条线程。', en: 'Unsubscribed from this Thread.' },
  'thread.notSubscribed': {
    zh: '这条线程上已经没有订阅了。',
    en: 'No ticket subscribes to this Thread any more.'
  },
  'thread.unsubscribeHint': {
    zh: '取消订阅会丢掉这条线程上全部工单的订阅。',
    en: 'Unsubscribing drops every Ticket’s subscription on this Thread.'
  },
  'thread.actions': { zh: '线程动作', en: 'Thread actions' },
  'thread.openTicket': { zh: '打开工单', en: 'Open ticket' },
  'mandate.via.addressed': { zh: '点名', en: 'Addressed' },
  'mandate.via.followup': { zh: '线程上的后续消息', en: 'Follow-up' },
  'mandate.via.admission': { zh: '准入表', en: 'Admission' },
  'mandate.via.bot': { zh: '机器人候选', en: 'Bot candidate' },
  'mandate.cell.listedUnaddressed': { zh: '名单内、未点名', en: 'Listed, not addressed' },
  'mandate.cell.unlistedAddressed': { zh: '名单外、点名', en: 'Unlisted, addressed' },
  'mandate.cell.unlistedUnaddressed': { zh: '名单外、未点名', en: 'Unlisted, not addressed' },
  // ---- Eval 页（§M.2 的 Eval 行、§K.7 的四条件）----
  'eval.empty': { zh: '没有决定。', en: 'No decisions.' },
  'eval.openThread': { zh: '打开线程', en: 'Open thread' },
  'eval.openTicket': { zh: '打开工单', en: 'Open ticket' },
  'eval.dismiss': { zh: '不再提示', en: 'Dismiss' },
  'eval.dismissed': { zh: '已不再提示', en: 'Dismissed' },
  'eval.dismissedHint': {
    zh: '这条问题已经 dismiss，不再计入待人工；记录仍在，可以随时回看。',
    en: 'This problem was dismissed, so it no longer counts as needing a person; the record stays for review.'
  },
  'eval.needsPerson': { zh: '待人工', en: 'Needs a person' },
  'eval.unresolved': {
    zh: '24 小时内有 {count} 条未完成的评估仍要人看。',
    en: '{count} unresolved unavailable decision(s) in the last 24 h still need a person.'
  },
  'eval.needsPersonHint': {
    zh: '它仍是该线程最新的决定、未 dismiss，且线程不在排队或评估中，所以现在算待人工。',
    en: "It is still its Thread's latest decision, not dismissed, and the Thread is not queued or evaluating, so it counts as needing a person now."
  },
  'eval.actions': { zh: '决定动作', en: 'Decision actions' },
  'eval.noReasons': { zh: '这条决定没有记原因。', en: 'This decision recorded no reason.' },
  'overview.problems': { zh: '系统问题', en: 'System problems' },
  'overview.problemsEmpty': { zh: '没有系统问题。', en: 'No system problems.' },
  'overview.problemKind.health': { zh: '健康错误', en: 'Health error' },
  'overview.problemKind.reply': { zh: '回复失败', en: 'Reply failing' },
  'overview.problemKind.unavailable': { zh: '未完成的评估', en: 'Unavailable' },
  'overview.replyFailed': { zh: '反复尝试后仍未发出', en: 'Not delivered after repeated attempts' },
  'overview.flow': { zh: '24 小时流水', en: 'Last 24 hours' },
  'overview.flowReceived': { zh: '收到', en: 'Received' },
  'overview.flowEvaluated': { zh: '评估', en: 'Evaluated' },
  'overview.flowAccepted': { zh: '接单', en: 'Accepted' },
  'overview.flowIgnored': { zh: '忽略', en: 'Ignored' },
  'overview.flowEnded': { zh: '结束', en: 'Ended' },
  'overview.executor': { zh: '执行器负载', en: 'Executor load' },
  'overview.executorLoad': { zh: '运行中 {running} / {maxWorkers}', en: '{running} / {maxWorkers} running' },
  'overview.executorHuman': { zh: '人类槽：{slot}', en: 'Human slot: {slot}' },
  'overview.humanSlot.free': { zh: '空闲', en: 'free' },
  'overview.humanSlot.used': { zh: '占用', en: 'in use' },
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
  'action.back': { zh: '返回列表', en: 'Back to the list' },
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

  // ---- Settings 的分组（§M.3：五组 + Prompts 的四个子页）----
  'settings.groups': { zh: '设置分组', en: 'Settings groups' },
  'settings.group.deployment': { zh: '部署', en: 'Deployment' },
  'settings.group.prompts': { zh: '提示词', en: 'Prompts' },

  // ---- Deployment 组（§M.3 Deployment）：部署读数、限额与诊断 ----
  'deployment.title': { zh: '部署', en: 'Deployment' },
  'deployment.intro': {
    zh: '这台机器的部署读数：缺什么、在用的限额、各部件健康、Router 与诊断。',
    en: "This machine's deployment: what is missing, the limits in force, each part's health, the router and its diagnosis."
  },
  'deployment.stateDir': { zh: '状态目录', en: 'State directory' },
  'deployment.stateDirReadOnly': {
    zh: '只读：数据库、日志与 token 都在这个目录里。请选中路径复制。',
    en: 'Read-only: the database, logs and tokens live here. Select the path to copy it.'
  },
  'deployment.stateDirChange': {
    zh: '改它要去 Orca 设置 → Superagent → State directory；改完重启插件才生效。',
    en: 'Change it in Orca Settings → Superagent → State directory; a new path takes effect after the plugin restarts.'
  },
  'deployment.limits': { zh: '机器限额', en: 'Machine limits' },
  'deployment.limitsIntro': {
    zh: '本机设置；这里只读。改限额是部署变更，改完要重启插件（没有热重载）。',
    en: "This machine's settings, read-only here. Changing a limit is a deployment change: it needs a plugin restart (there is no hot reload)."
  },
  'deployment.limit.promptMaxChars': { zh: '提示词上限（字符）', en: 'Prompt limit (characters)' },
  'deployment.limit.admissionContextMaxPages': { zh: '一次评估的语境页数', en: 'Context pages per Eval' },
  'deployment.limit.admissionContextTimeoutMs': {
    zh: '一次语境读取的时限（毫秒）',
    en: 'Context timeout (ms)'
  },
  'deployment.limit.retentionDays': { zh: '保留天数', en: 'Retention (days)' },
  'deployment.paused': { zh: '暂停处理', en: 'Pause processing' },
  'deployment.pausedHint': {
    zh: '暂停期间来源继续记录触发，但派发、新评估与回复都停下。',
    en: 'While paused the Sources keep recording Triggers, but dispatch, new Evals and replies stop.'
  },
  'deployment.setup': { zh: '部署检查', en: 'Setup' },
  'deployment.setupIntro': {
    zh: '每条问题只报缺什么，并给出修法与重跑入口。修好外部条件后按「检查一次」，不必重启 Orca。',
    en: 'Each problem names only what is missing, with how to fix it and where to re-run the check. Fix it, then press Check again; Orca need not restart.'
  },
  'deployment.setupPassed': {
    zh: '部署检查通过，没有缺什么。',
    en: 'Setup passed; nothing is missing.'
  },
  'deployment.checkAgain': { zh: '检查一次', en: 'Check again' },
  'deployment.checking': { zh: '正在检查…', en: 'Checking…' },
  'deployment.nothingToCheck': {
    zh: '现在没有 setup 问题，没有可重跑的东西。',
    en: 'Setup has no problems left; there is nothing to check again.'
  },
  'deployment.fix': { zh: '修法：{fix}', en: 'Fix: {fix}' },
  'deployment.checkAgainCommand': { zh: '也可以自己跑：', en: 'Or run it yourself:' },
  'deployment.place.orca': { zh: 'Orca', en: 'Orca' },
  'deployment.place.state': { zh: '状态目录', en: 'State directory' },
  'deployment.place.executor': { zh: '执行器', en: 'Executor' },
  'deployment.place.github': { zh: 'GitHub 来源', en: 'GitHub Source' },
  'deployment.place.feishu': { zh: '飞书来源', en: 'Feishu Source' },
  'deployment.kind.missing': { zh: '缺配置', en: 'Missing' },
  'deployment.kind.broken': { zh: '读不通', en: 'Broken' },
  'deployment.health': { zh: '健康明细', en: 'Health' },
  'deployment.healthIntro': {
    zh: '每个部件一条：状态与明细（明细里带计数）。下一次成功即清除，连续失败三次才报错。',
    en: 'One entry per part: its state and detail (the detail carries the counts). The next success clears it; three failures in a row report an error.'
  },
  'deployment.group.runtime': { zh: '运行时', en: 'Runtime' },
  'deployment.group.passes': { zh: '轮次与模型', en: 'Passes' },
  'deployment.group.effects': { zh: '副作用', en: 'Effects' },
  'deployment.group.executor': { zh: '执行器', en: 'Executor' },
  'deployment.group.router': { zh: 'Router', en: 'Router' },
  'deployment.group.sources': { zh: '来源与同步', en: 'Sources' },
  'deployment.group.other': { zh: '其他', en: 'Other' },
  'deployment.state.starting': { zh: '启动中', en: 'Starting' },
  'deployment.state.ready': { zh: '就绪', en: 'Ready' },
  'deployment.state.paused': { zh: '已暂停', en: 'Paused' },
  'deployment.state.error': { zh: '出错', en: 'Error' },
  'deployment.router': { zh: 'Router', en: 'Router' },
  'deployment.routerIntro': {
    zh: '每三秒探活一次；重启会关掉旧会话、换一个新会话并轮换 Router 的 token。',
    en: 'Liveness is checked every three seconds; a restart closes the old session, starts a new one and rotates the router token.'
  },
  'deployment.routerTerminal': { zh: '终端', en: 'Terminal' },
  'deployment.routerSince': { zh: '起始时间', en: 'Since' },
  'deployment.routerRestarts': { zh: '十分钟内重启次数', en: 'Restarts in 10 min' },
  'deployment.routerLastError': { zh: '最后错误', en: 'Last error' },
  'deployment.routerRestart': { zh: '重启 Router', en: 'Restart the router' },
  'deployment.routerRestarted': { zh: '已请求重启 Router。', en: 'Router restart requested.' },
  'deployment.empty': { zh: '—', en: '—' },
  'deployment.doctor': { zh: '诊断（doctor）', en: 'Doctor' },
  'deployment.doctorIntro': {
    zh: '本机诊断：只报有没有，不报值。它判断的是这台机器；能不能开工由上面的部署检查决定。',
    en: 'Machine diagnosis: present or missing, never a value. It judges this machine; whether work may start is what Setup above decides.'
  },
  'deployment.doctorRun': { zh: '运行诊断', en: 'Run doctor' },
  'deployment.doctorRunning': { zh: '正在诊断…', en: 'Running doctor…' },
  'deployment.doctorSummary': {
    zh: '{ok} 就绪 · {warn} 警告 · {fail} 失败',
    en: '{ok} ok · {warn} warn · {fail} fail'
  },
  'deployment.doctorState.ok': { zh: '就绪', en: 'Ok' },
  'deployment.doctorState.warn': { zh: '警告', en: 'Warning' },
  'deployment.doctorState.fail': { zh: '失败', en: 'Failed' },
  'deployment.doctorCheck': { zh: '检查项', en: 'Check' },
  'deployment.doctorDetail': { zh: '结论', en: 'Detail' },
  'deployment.doctorFailed': { zh: '诊断没有跑成：{reason}', en: 'The diagnosis did not run: {reason}' },
  'deployment.token': { zh: '主 token', en: 'Operator token' },
  'deployment.tokenIntro': {
    zh: 'CLI 与面板用一个主 token 访问 loopback API（文件权限 0600）。轮换后旧 token 立即失效；客户端每次都读同一个文件。',
    en: 'The CLI and the panel use one operator token for the loopback API (file mode 0600). After a rotation the old token stops working at once; clients read that same file every time.'
  },
  'deployment.rotateToken': { zh: '轮换主 token', en: 'Rotate the operator token' },
  'deployment.rotated': {
    zh: '已轮换；新的 token 文件：{file}',
    en: 'Rotated; the new token file: {file}'
  },
  'deployment.tokenValueHidden': {
    zh: 'token 的值不显示在这里，也不进日志。',
    en: 'The token value is never shown here, and never logged.'
  },

  // ---- Source 页（§M.2）：每 Source 一张卡、24 h 计数、被过滤与被 drop 的列表、四个动作 ----
  'source.intro': {
    zh: '每个来源一张卡：开关、配置、派生事实、健康、24 小时计数，以及最近被过滤的触发与被丢弃的消息。',
    en: 'One card per Source: its switch, configuration, derived facts, health, 24-hour counts, and the Triggers it filtered or the messages it dropped recently.'
  },
  'source.empty': { zh: '还没有配置任何来源。', en: 'No Source is configured yet.' },
  'source.emptyHint': {
    zh: '去设置页添加 GitHub 或飞书来源；每加一个，这里就多一张卡。',
    en: 'Add a GitHub or Feishu Source on the Settings page; each one appears here as its own card.'
  },
  'source.checkedAgain': { zh: '已重跑部署检查。', en: 'Setup was checked again.' },
  'source.received': { zh: '24 小时到达 {count}', en: '{count} received in 24 h' },
  'source.filtered': { zh: '被过滤 {count}', en: '{count} filtered' },
  'source.latest': { zh: '最近', en: 'Latest' },
  'source.fields': { zh: '配置', en: 'Configuration' },
  'source.facts': { zh: '派生事实', en: 'Derived facts' },
  'source.health': { zh: '健康', en: 'Health' },
  'source.notInstalled': {
    zh: '这个来源的 kind 没有安装；存过的配置原样保留。',
    en: "This Source's kind is not installed; its saved configuration is kept as it is."
  },
  'source.configInvalid': {
    zh: '配置无效，已禁用：{detail}',
    en: 'The configuration is invalid, so the Source is disabled: {detail}'
  },
  'source.filteredTitle': { zh: '被过滤的触发', en: 'Filtered triggers' },
  'source.filteredHint': {
    zh: '最近 24 小时内被来源或准入过滤的触发，每行给原因码。',
    en: 'Triggers filtered by the Source or the admission in the last 24 hours; each row names its reason code.'
  },
  'source.droppedTitle': { zh: '被丢弃的消息', en: 'Dropped messages' },
  'source.droppedHint': {
    zh: '最近 24 小时内没能送达的消息：原因，以及它所属的工单或线程。',
    en: 'Messages that could not be delivered in the last 24 hours: why, and the Ticket or Thread they belonged to.'
  },
  'source.showingLatest': {
    zh: '只列最近 {shown} 条，窗口内共 {total} 条。',
    en: 'Showing the latest {shown} of {total} in this window.'
  },
  'source.sync': { zh: '立即同步', en: 'Sync now' },
  'source.syncing': { zh: '正在同步…', en: 'Syncing…' },
  'source.synced': { zh: '已同步：允许名单 {count} 人。', en: 'Synced: {count} allowed.' },
  'source.refreshLabels': { zh: '刷新显示名', en: 'Refresh labels' },
  'source.refreshingLabels': { zh: '正在刷新…', en: 'Refreshing…' },
  'source.labelsRefreshed': {
    zh: '显示名已更新：新增 {added}，共 {total}。',
    en: 'Labels refreshed: {added} added, {total} total.'
  },
  'source.checked': { zh: '检查完成。', en: 'The check finished.' },
  'source.actionFailed': { zh: '动作没有成功：{reason}', en: 'The action did not succeed: {reason}' },
  'source.enable': { zh: '运行来源：{name}', en: 'Run Source: {name}' },
  'source.openThread': { zh: '打开线程', en: 'Open the Thread' },
  'source.drop.channelIgnored': {
    zh: '来源已不再监听这个对话',
    en: 'The Source no longer listens to this conversation'
  },
  'source.drop.channelGone': {
    zh: '对话已无法接收消息',
    en: 'The conversation can no longer receive messages'
  },
  'source.drop.withdrawn': {
    zh: '工单已停止，消息被撤回',
    en: 'The Ticket was stopped, so the message was withdrawn'
  },
  'field.on': { zh: '开', en: 'On' },
  'field.off': { zh: '关', en: 'Off' },
  'field.queueJoiner': { zh: '、', en: ', ' },

  // ---- 已知限制（§A.3 的十一项近似；面板 Limitations 段与 README 同源同措辞）----
  'deployment.limitations': { zh: '已知限制', en: 'Limitations' },
  'limitation.intro': {
    zh: '以下十一项只能近似；每一条都在设计的 §H 差异表里注明影响。',
    en: 'These eleven capabilities can only be approximated; each names its impact in the design §H table.'
  },
  'limitation.preset.title': { zh: 'Session preset 的工具裁剪', en: 'Session preset tool trimming' },
  'limitation.preset.impact': {
    zh: 'Worker 与 Router 都是普通 Orca agent 会话，工具集不可裁剪：「Router 不读代码」只由提示词约束，Router 理论上仍能改代码；worker 可用的工具也与上游的 WORK_TOOLS 不完全相同（H.1、H.19）。',
    en: 'Worker and Router are ordinary Orca agent sessions whose tool sets cannot be trimmed: "the Router does not read code" rests on the prompt alone, so the Router could still edit code, and a worker\'s tools differ from the upstream WORK_TOOLS (H.1, H.19).'
  },
  'limitation.systemPrompt.title': {
    zh: '系统提示词在 launch 时一次性注入',
    en: 'The system prompt is injected once, at launch'
  },
  'limitation.systemPrompt.impact': {
    zh: '运行中的会话不会自动看到新的 Policy 段；变更只用消息告知 revision 与读法，全文对新会话才完整生效（H.2）。',
    en: 'A running session never sees a new Policy section by itself; a change only sends a message naming the revision and how to re-read it, and the full text takes effect for new sessions (H.2).'
  },
  'limitation.background.title': {
    zh: '看不到 agent 内部的后台工作与 30 分钟预算',
    en: 'Background work inside the agent and the 30-minute budget are not observable'
  },
  'limitation.background.impact': {
    zh: '30 分钟规则退化为「发收尾指令并标记过期」，不杀进程：长任务可能继续占着 slot，也可能被误判为过期（H.3）。',
    en: 'The 30-minute rule degrades to "send a wrap-up instruction and mark it stale" without killing anything: a long task may keep its slot, and a healthy task may be marked stale (H.3).'
  },
  'limitation.modelRetry.title': { zh: '模型预算重试由 Orca 负责', en: 'Model budget retries belong to Orca' },
  'limitation.modelRetry.impact': {
    zh: '插件只做三次 launch 重试；看不到预算重试状态，provider 抖动时工单可能直接失败；models 健康项恒为就绪并写明「由 Orca 负责」（H.4）。',
    en: 'The plugin only retries a launch three times; budget retries are invisible, a Ticket may fail outright while a provider wobbles, and the models health entry is always ready and says "handled by Orca" (H.4).'
  },
  'limitation.pluginManager.title': { zh: '没有 DSH Plugin Manager 页面', en: 'There is no DSH Plugin Manager page' },
  'limitation.pluginManager.impact': {
    zh: '少量项在 Orca 设置里改，其余在面板的 Settings → Deployment 组；两处不重复（H.5）。',
    en: 'A few settings are changed in Orca Settings and the rest in the panel under Settings → Deployment; the two lists never overlap (H.5).'
  },
  'limitation.webPanel.title': { zh: '没有 DSH 的 Web 面板与端口', en: 'There is no DSH web panel or port' },
  'limitation.webPanel.impact': {
    zh: '面板只在 Orca 客户端里打开，没有可跨设备访问的 URL（H.6；视为改进）。',
    en: 'The panel opens inside the Orca client only; there is no URL to reach it from another device (H.6; counted as an improvement).'
  },
  'limitation.serviceScript.title': {
    zh: '生命周期归 Orca，没有服务脚本与 tmux',
    en: 'Lifecycle belongs to Orca; no service script or tmux'
  },
  'limitation.serviceScript.impact': {
    zh: '没有 start/stop 命令，也没有 tmux 会话；「停」用 paused 表达，读数用 superagent status 的 0/1/2/3 退出码（H.7）。',
    en: 'There is no start/stop command and no tmux session; "stopped" is expressed as paused, and readings come from superagent status with exit codes 0/1/2/3 (H.7).'
  },
  'limitation.skills.title': { zh: 'Skills 不是宿主注册表', en: 'Skills are not a host registry' },
  'limitation.skills.impact': {
    zh: '内置 skills 写到 <stateDir>/skills/<name>/SKILL.md，提示词只给绝对路径；agent 可能不读（H.8）。',
    en: 'Built-in skills are written to <stateDir>/skills/<name>/SKILL.md and the prompt only gives their absolute paths; the agent may not read them (H.8).'
  },
  'limitation.dshCli.title': { zh: '没有 dsh CLI 与 profile', en: 'There is no dsh CLI or profile' },
  'limitation.dshCli.impact': {
    zh: '用 superagent CLI 与 orca CLI 顶上；没有 profile、没有 --from-default-profile，安装步骤与上游完全不同（H.9）。',
    en: 'The superagent CLI and the orca CLI stand in; there is no profile and no --from-default-profile, and installation differs from upstream entirely (H.9).'
  },
  'limitation.questions.title': {
    zh: '无法移除 worker 的提问工具',
    en: "The worker's question tools cannot be removed"
  },
  'limitation.questions.impact': {
    zh: 'worker 可能在自己的终端里等人，而不是用 report --human-action；插件把 blocked 状态当作 Attention 兜住，但问题文本只是终端摘要（H.10）。',
    en: 'A worker may ask in its own terminal instead of reporting --human-action; the plugin catches the blocked state as Attention, but the question text is only a terminal summary (H.10).'
  },
  'limitation.environment.title': {
    zh: '进程隔离与执行环境注入只是近似',
    en: 'Process isolation and execution-environment injection are approximations'
  },
  'limitation.environment.impact': {
    zh: 'blocked commands 与账号 shim 依赖 agent.launch.before 钩子（2 秒、失败即放行），不是安全边界；worker 的 git 配置是最小副本（凭据 helper、SSH→HTTPS、提交身份），http.*、LFS 等其余全局项只剩系统级配置；插件不做进程隔离，建议专用 OS 账号（H.11、H.20）。',
    en: 'Blocked commands and the account shim rely on the agent.launch.before hook (2 s, fail-open) and are not a security boundary; the worker git config is a minimal copy (credential helper, SSH→HTTPS, commit identity), so http.*, LFS and other global entries fall back to system configuration only; the plugin adds no process isolation and recommends a dedicated OS account (H.11, H.20).'
  },

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

  // ---- Prompts 组（§M.3 的四个子页、§L.3 占位符、§L.4 版本与 default-updated、§L.6 技能）----
  'prompt.tabs': { zh: '提示词子页', en: 'Prompt pages' },
  'prompt.tab.edit': { zh: '编辑', en: 'Edit' },
  'prompt.tab.full': { zh: '全文', en: 'Full prompt' },
  'prompt.tab.history': { zh: '历史', en: 'History' },
  'prompt.tab.skills': { zh: '技能', en: 'Skills' },
  'prompt.intro': {
    zh: '团队可改的文本在这里；保存会生成一个新版本，正在跑的会话不会被改写（下一条消息带新修订号）。',
    en: 'The text the team owns lives here. Saving makes a new version; running sessions are not rewritten (their next message carries the new revision).'
  },
  'prompt.versionLine': { zh: '修订 {revision} · {at} · {origin}', en: 'Revision {revision} · {at} · {origin}' },
  'prompt.versionNone': { zh: '还没保存过：全部跟随内置文本。', en: 'Never saved: every part follows the built-in text.' },
  'prompt.origin.panel': { zh: '面板', en: 'panel' },
  'prompt.origin.tool': { zh: '命令行', en: 'CLI' },
  'prompt.team': { zh: '团队文本', en: 'Team text' },
  'prompt.teamIntro': {
    zh: '三段团队文本拼在角色分片之后、订阅与回复之前。留空即跟随内置文本。',
    en: 'The three team sections sit after the role parts, before subscriptions and replies. Empty means the built-in text.'
  },
  'prompt.section.communication': { zh: '沟通', en: 'Communication' },
  'prompt.section.scope': { zh: '工单范围', en: 'Ticket scope' },
  'prompt.section.delivery': { zh: '交付要求', en: 'Delivery requirements' },
  'prompt.parts': { zh: '内置分片', en: 'Built-in parts' },
  'prompt.partsIntro': {
    zh: '每个分片都可以覆盖；覆盖后内置更新不再自动进来，除非你改回默认。',
    en: 'Every part can be overridden. An override stops following built-in updates until you go back to the default.'
  },
  'prompt.changed': { zh: '已修改', en: 'Changed' },
  'prompt.useDefault': { zh: '还原本段：{part}', en: 'Use the default: {part}' },
  'prompt.placeholders': { zh: '必保留占位符：{list}', en: 'Required placeholders: {list}' },
  'prompt.roles': { zh: '读它的角色：{list}', en: 'Read by: {list}' },
  'prompt.role.orchestrator': { zh: '主会话', en: 'orchestrator' },
  'prompt.role.worker': { zh: '执行器', en: 'worker' },
  'prompt.saveHint': {
    zh: '保存会校验占位符、技能名与体量上限（{limit} 字符）；任何一条不合格都整单拒绝，没有部分保存。',
    en: 'Saving checks the placeholders, the skill names and the {limit}-character cap; any failure refuses the whole save.'
  },
  'prompt.skillPlacement': {
    zh: '这一段写进技能文件，不拼进提示词正文。',
    en: 'This part is written to a skill file, not into the prompt itself.'
  },
  'prompt.full.baseline': { zh: '对比基准', en: 'Compare with' },
  'prompt.base.saved': { zh: '已保存', en: 'the saved text' },
  'prompt.base.default': { zh: '默认', en: 'the default' },
  'prompt.diffAgainst': { zh: '与{base}的行级对比', en: 'Line diff against {base}' },
  'prompt.full.role': { zh: '角色', en: 'Role' },
  'prompt.full.text': { zh: '组装后的全文 · {role}', en: 'Assembled text · {role}' },
  'prompt.full.intro': {
    zh: '全文由分片、团队文本与部署事实拼成；生成段的值由系统填，改不了。',
    en: 'The text is assembled from the parts, the team text and the deployment facts; the generated values are filled by the system and cannot be edited.'
  },
  'prompt.full.previewFailed': { zh: '草稿预览失败：{reason}', en: 'The draft could not be previewed: {reason}' },
  'prompt.history.intro': {
    zh: '每个版本都只能读；恢复某个版本是再存一个新版本，历史不改写。',
    en: 'Every version is read-only; restoring one saves a new version, it never rewrites history.'
  },
  'prompt.history.empty': { zh: '还没有版本。', en: 'No version yet.' },
  'prompt.restore': { zh: '恢复这个版本', en: 'Restore this version' },
  'prompt.restoreHint': {
    zh: '恢复会生成新版本并回到编辑页；正在跑的会话不被重启。',
    en: 'Restoring makes a new version and returns to the edit page; running sessions are not restarted.'
  },
  'prompt.restored': { zh: '已恢复为修订 {revision}。', en: 'Restored as revision {revision}.' },
  'prompt.defaultUpdated': { zh: '有分片的内置文本已更新', en: 'Built-in text changed under an override' },
  'prompt.defaultUpdatedIntro': {
    zh: '这些分片被覆盖过，之后内置文本又变了。旧默认与新默认都在下面：保留你的文本（按新默认重新记账），或用新默认。',
    en: 'These parts were overridden, then the built-in text changed. Both defaults are below: keep your text (re-based on the new default) or take the new default.'
  },
  'prompt.previous': { zh: '旧默认', en: 'Old default' },
  'prompt.next': { zh: '新默认', en: 'New default' },
  'prompt.adoptDefault': { zh: '用新默认：{part}', en: 'Use the new default: {part}' },
  'prompt.keepMine': { zh: '保留我的文本：{part}', en: 'Keep my text: {part}' },
  'prompt.removedPart': { zh: '这一段在本版本里已不存在，保存时会被丢弃。', en: 'This part no longer exists in this version; saving drops it.' },
  'prompt.skills.team': { zh: '团队技能', en: 'Team skills' },
  'prompt.skills.builtIn': { zh: '内置技能（只读）', en: 'Built-in skills (read-only)' },
  'prompt.skills.intro': {
    zh: '技能是文件：<stateDir>/skills/<name>/SKILL.md。提示词只写路径与「开工前读它」，所以改技能不用改提示词版本。',
    en: 'Skills are files: <stateDir>/skills/<name>/SKILL.md. The prompt only carries the path and the instruction to read it first, so editing a skill does not touch the prompt version.'
  },
  'prompt.skills.name': { zh: '技能名', en: 'Skill name' },
  'prompt.skills.add': { zh: '新建技能', en: 'New skill' },
  'prompt.skills.remove': { zh: '删除技能：{name}', en: 'Delete skill: {name}' },
  'prompt.skills.path': { zh: '路径：{path}', en: 'Path: {path}' },
  'prompt.skills.empty': { zh: '还没有团队技能。', en: 'No team skill yet.' },
  'prompt.skills.text': { zh: '技能正文：{name}', en: 'Skill text: {name}' },
  'prompt.skills.nameHint': {
    zh: '1–64 个 a-z、0-9 与 -，不能与内置技能重名；名字不合规时保存会被拒绝并说明原因。',
    en: '1-64 characters of a-z, 0-9 and -; a built-in name is reserved. A bad name is refused at save time with the reason.'
  },
  'prompt.error.missing_placeholder': {
    zh: '这段模板必须保留 {placeholders}：那是系统要填的值。',
    en: 'This template must keep {placeholders}: the system fills those in.'
  },
  'prompt.error.reserved_skill_name': {
    zh: '{skill} 是内置技能的名字，内置技能只读；换一个技能名。',
    en: '{skill} is a built-in skill and built-in skills are read-only; use another skill name.'
  },
  'prompt.error.invalid_skill_name': {
    zh: '技能名只能是 1–64 个 a-z、0-9 与 -。',
    en: 'A skill name is 1-64 characters of a-z, 0-9 and -.'
  },
  'prompt.error.too_long': {
    zh: '合计 {actual} 个字符，超过上限 {limit}；缩短一段团队文本、覆盖或团队技能后重试。',
    en: 'The text is {actual} characters, over the {limit}-character limit; shorten a team section, an override or a team skill.'
  },
  'prompt.error.invalid_part': { zh: '这一段不能为空。', en: 'This part cannot be empty.' },
  'prompt.error.unknown_part': { zh: '这一段在本版本里不存在。', en: 'This part does not exist in this version.' },
  'prompt.error.invalid_config': { zh: '这份配置的形状不对，无法保存。', en: 'This configuration has the wrong shape and cannot be saved.' },
  'prompt.error.generic': { zh: '保存被拒绝：{reason}', en: 'The save was refused: {reason}' },

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
  'column.revision': { zh: '修订', en: 'Revision' },
  'column.origin': { zh: '来源', en: 'Origin' },

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
  'thread.subscribed': { zh: '已订阅', en: 'Subscribed' },
  'thread.evaluating': { zh: '评估进行中', en: 'Evaluating' },
  'thread.queued': { zh: '排队 {count}', en: 'Queued {count}' },
  'thread.error': { zh: '轮询失败', en: 'Polling failed' },
  'thread.dormant': { zh: '工单已结束', en: 'Ticket ended' },
  'thread.unsubscribed': { zh: '未订阅', en: 'Unsubscribed' },
  'source.ready': { zh: '运行中', en: 'Ready' },
  'source.starting': { zh: '启动中', en: 'Starting' },
  'source.paused': { zh: '已暂停', en: 'Paused' },
  'source.error': { zh: '出错', en: 'Error' },
  'source.setup': { zh: '等待部署检查', en: 'Waiting for setup' },
  'source.off': { zh: '已关闭', en: 'Off' },
  'source.missing': { zh: '插件未安装', en: 'Not installed' },
  'report.progress': { zh: '进行中', en: 'Progress' },
  'report.waiting': { zh: '等待中', en: 'Waiting' },
  'report.ready': { zh: '可评审', en: 'Ready' },
  'report.blocked': { zh: '受阻', en: 'Blocked' },
  'report.failed': { zh: '失败', en: 'Failed' },
  'report.dropped': { zh: '无需处理', en: 'Dropped' },

  // ---- 领域术语（§E.8、§K.2、§D.2、§E.3 的码表；键与 `core` 的码表一一对应，`tests/terms.test.ts` 核对）----

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
  'reason.timeout': { zh: '评估超时未决定（{attempts} 次尝试）', en: 'Assessment timed out after {attempts} attempts' },
  'reason.policyChanged': { zh: '评估期间策略已变更', en: 'Policy changed during assessment' },
  'reason.noAdmissible': { zh: '没有可准入的触发', en: 'No admissible trigger' },
  'reason.startedTicket': { zh: '已经开过工单 {ticket}', en: 'Already started ticket {ticket}' },
  'reason.acceptedBefore': { zh: '触发 {trigger} 之前已接单', en: 'Trigger {trigger} was accepted before' },
  'reason.routed': { zh: '已转给工单 {ticket}', en: 'Routed to ticket {ticket}' },
  'reason.explicitRouted': {
    zh: '名单里的人明确请求，由 Router 接单',
    en: 'Explicit request from an allowed sender routed by the Router'
  },
  'reason.humanStop': { zh: '有人要求停止', en: 'A person asked to stop' },
  'reason.forwarded': {
    zh: '已扇出给该线程的工单',
    en: 'Forwarded to the worker of the Ticket already on this Thread'
  },
  'reason.senderNotMember': {
    zh: '发送者不在这个来源的名单里',
    en: "The sender is not on the Source's list"
  },
  'reason.notHuman': {
    zh: '发送者不是人，也不在这个来源的机器人名单里',
    en: "The sender is not a person and is not on the Source's bots list"
  },
  'reason.noMention': {
    zh: '消息没有点名 agent',
    en: 'The message does not address the agent'
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
  'reason.admissionIgnored': {
    zh: '这个接收 scope 的准入表没有准入它',
    en: 'The admission table for this receiving scope does not admit it'
  },
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
  'userError.unknownDecision': { zh: '未知的决定', en: 'Unknown decision' },
  'userError.unknownProblem': { zh: '找不到这条未完成的评估', en: 'Unavailable Eval not found' },
  'userError.unknownThread': { zh: '未知的线程', en: 'Unknown thread' },
  'userError.notRequeueable': {
    zh: '这张工单的 worker 仍拥有这条消息；由它决定或交回',
    en: "A ticket's worker still owns this message; its worker decides it or hands it back"
  },
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

} as const satisfies Readonly<Record<string, CopyPair>>

/** 文案键。 */
export type CopyKey = keyof typeof COPY

// ---------------------------------------------------------------------------
// 术语表（覆盖层的内容；`GLOSSARY_TERMS` 是术语名清单，不是领域码表）
// ---------------------------------------------------------------------------

/** 设计 §M.5 固定的领域术语顺序（术语表按这个顺序分组；不是领域码表，见文件末的 `TERMS`）。 */
export const GLOSSARY_TERMS = [
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
  readonly terms: readonly (typeof GLOSSARY_TERMS)[number][]
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
export function isChinese(locale: string): boolean {
  return /^zh(?:[-_]|$)/i.test(locale)
}

/** 按 locale 取一条文案；`{name}` 用 `values` 填入，缺值保留原样而不是印出 undefined。 */
export function translate(locale: string, key: CopyKey, values: CopyValues = {}): string {
  const template = isChinese(locale) ? COPY[key].zh : COPY[key].en
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match
  )
}

// ---------------------------------------------------------------------------
// 领域码表的文案面（F5 的契约；`tests/terms.test.ts` 双向核对）
// ---------------------------------------------------------------------------

/** `stage` 组的码：§E.8「面板标签」一列，`blocked` 与 `failed` 共用一个标签。 */
export const STAGE_TERMS = ['delivery', 'answer', 'review', 'blockedFailed', 'queued', 'idle', 'working'] as const
export type StageTerm = (typeof STAGE_TERMS)[number]

/**
 * 领域术语键的联合：`<组>.<码>`。组与码都来自 `core` 的码表（外加 `stage` 组本身），
 * `terms.test.ts` 断言两个方向的集合相等。
 */
export type TermKey =
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
 * 领域术语的双语措辞（值与 `COPY` 同一份，不复制第二遍）。中文沿用上游 §001 术语表的译名。
 * `reason.said` 是「某人原话」，面板直接显示 `{text}` 而不翻译（与上游 `reason.said` 同）。
 */
export const TERMS: Readonly<Record<TermKey, Bilingual>> = Object.fromEntries(
  LOCALIZED_GROUPS.flatMap((group) =>
    Object.entries(COPY)
      .filter(([key]) => key.startsWith(`${group}.`))
      .map(([key, pair]) => [key, pair])
  )
) as Readonly<Record<TermKey, Bilingual>>

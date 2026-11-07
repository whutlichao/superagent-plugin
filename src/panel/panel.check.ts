// `orca plugin check` 的情景集（§M.7）：每个值得看的状态一个场景；check 逐情景渲染面板，
// 并把 worker 挂到同一个替身宿主上，所以面板的 `plugin.request` 真的会走到 worker 的处理器。
//
// 情景名单（§M.7）：booting、empty、healthy、needs-person、problems、paused、setup-missing、
// long-lists、execution、trigger、deployment、prompts、zh、en、danger-confirm。
//
// Overview（§M.2 的四块）由四个情景表达：empty（空态 + Source 概况）、needs-person（待人工行
// 与它的直接动作）、problems（三类系统问题）、paused（暂停 + 恢复的二次确认）。
//
// 已知边界（Orca 1.4.251）：`defineCheck` 的情景只吃 `mockHost` 的选项 + `persisted` / `theme` /
// `events`，**没有 `locale`**（check 的挂载固定用 `'en'`）。所以 `zh` / `en` 两个情景实际区分的
// 是浅色/深色主题；中英双语的键集合与页面文案由 `tests/locales.test.ts` 与
// `tests/panel-navigation.test.tsx` 覆盖（它们能传 `locale`）。这条边界在票的回报里记明。
import { defineCheck } from 'orca/testing'
import { HealthBoard } from '../worker/infra/health'
import { DEFAULT_MACHINE_LIMITS } from '../worker/app/limits'
import { deploymentView } from '../worker/app/deployment-view'
import {
  BUILT_IN_SKILLS,
  composeSkill,
  PROMPT_PARTS,
  PROMPT_PART_KEYS,
  skillFilePath,
  TEAM_SECTIONS
} from '../worker/app/prompts'
import type {
  AttentionItem,
  DeploymentView,
  DoctorView,
  ExecutionFilter,
  HumanSlot,
  PanelPromptsView,
  PanelPromptPart,
  PanelState,
  PanelThread,
  PanelTicket,
  SystemProblem,
  ThreadDetailView,
  ThreadFilter,
  ThreadListPage,
  TicketDetailView,
  TicketListPage
} from './protocol'

/** 一份快照；只写关心的字段，其余按健康默认值补齐。 */
function snapshot(overrides: {
  revision?: number
  booted?: boolean
  items?: readonly AttentionItem[]
  problems?: readonly SystemProblem[]
  paused?: boolean
  error?: boolean
  setupMissing?: boolean
  sources?: { readonly enabled: number; readonly problems: number }
  tickets?: readonly PanelTicket[]
  activity?: Partial<PanelState['health']['activity']>
  executor?: {
    readonly running?: number
    readonly maxWorkers?: number
    readonly humanSlot?: HumanSlot
  }
}): PanelState {
  const items = overrides.items ?? []
  const problems = overrides.problems ?? []
  return {
    revision: overrides.revision ?? 1,
    booted: overrides.booted ?? true,
    health: {
      error: overrides.error ?? false,
      paused: overrides.paused ?? false,
      setupMissing: overrides.setupMissing ?? false,
      sources: overrides.sources ?? { enabled: 0, problems: 0 },
      activity: {
        received: 0,
        evaluated: 0,
        accepted: 0,
        ignored: 0,
        ended: 0,
        ...overrides.activity
      },
      executor: {
        running: overrides.executor?.running ?? 0,
        maxWorkers: overrides.executor?.maxWorkers ?? 4,
        humanSlot: overrides.executor?.humanSlot ?? 'free'
      }
    },
    attention: {
      answer: items.filter((item) => item.action === 'answer').length,
      review: items.filter((item) => item.action === 'review').length,
      problems: problems.length,
      items
    },
    problems,
    tickets: overrides.tickets ?? []
  }
}

/** 一名待人工的工单；`at` 是固定时刻（check 不看真实时钟）。 */
function ticket(
  id: string,
  title: string,
  action: AttentionItem['action'] = 'answer',
  terminalId?: string
): AttentionItem {
  return {
    id,
    title,
    action,
    at: 1_700_000_000_000,
    ...(terminalId === undefined ? {} : { terminalId })
  }
}

/** Execution 页的一行：同一个 Ticket 的读数（§Q.1 的验收面：两个情景都要有它）。 */
function ticketRow(
  id: string,
  title: string,
  stage: PanelTicket['stage'] = 'working',
  outcome?: PanelTicket['outcome']
): PanelTicket {
  return { id, title, stage, at: 1_700_000_000_000, ...(outcome === undefined ? {} : { outcome }) }
}

/** 一条系统问题（§J.3 的三类来源）。 */
function problem(
  kind: SystemProblem['kind'],
  id: string,
  name: string,
  detail?: string
): SystemProblem {
  return { id, kind, name, ...(detail === undefined ? {} : { detail }) }
}

/** 长列表：60 行，超过一页（50）。 */
const manyTickets = Array.from({ length: 60 }, (_, index) =>
  ticket(`t${index}`, `Ticket ${index + 1}: keep the payroll export stable`)
)

/** Execution 列表的长列表：60 张工单（§M.4 的「分页 50 条」）。 */
const manyRows = Array.from({ length: 60 }, (_, index) =>
  ticketRow(`t${index}`, `Ticket ${index + 1}: keep the payroll export stable`)
)

/** 同一份读数，只把修订号加一（动作后的快照；板面的单调计数）。 */
function nextRevision(state: PanelState, paused = state.health.paused): PanelState {
  return snapshot({
    revision: state.revision + 1,
    items: state.attention.items,
    problems: state.problems,
    paused,
    error: state.health.error,
    setupMissing: state.health.setupMissing,
    sources: state.health.sources,
    tickets: state.tickets
  })
}

/** 五档筛选在夹具上的判定（档位与 worker 的读模型同一口径，只是把 `PanelTicket` 切片）。 */
const FILTER_STAGES: Readonly<Record<ExecutionFilter, readonly PanelTicket['stage'][]>> = {
  open: ['delivery', 'answer', 'review', 'blockedFailed', 'queued', 'idle', 'working'],
  pending: ['delivery', 'answer', 'review', 'blockedFailed'],
  working: ['working', 'queued'],
  waiting: ['idle'],
  ended: ['ended']
}

/** `tickets` 请求的答案（§M.2 的筛选 + §M.4 的分页 50 条）。 */
function executionPage(state: PanelState, input: unknown): TicketListPage {
  const window = (input ?? {}) as {
    readonly filter?: ExecutionFilter
    readonly offset?: number
    readonly limit?: number
  }
  const filter = window.filter ?? 'open'
  const offset = Math.max(0, window.offset ?? 0)
  const limit = Math.max(1, Math.min(50, window.limit ?? 50))
  const matching = (state.tickets ?? []).filter((ticket) =>
    FILTER_STAGES[filter].includes(ticket.stage)
  )
  return {
    items: matching.slice(offset, offset + limit),
    nextOffset: offset + limit < matching.length ? offset + limit : null
  }
}

/** Trigger 页的一行：与读模型同一形状（§M.2 的 label/订阅数/最近触发/状态标记）。 */
function threadRow(
  key: string,
  title: string,
  stage: PanelThread['stage'] = 'subscribed',
  overrides: Partial<PanelThread> = {}
): PanelThread {
  return {
    key,
    source: 'github',
    title,
    stage,
    pending: 0,
    subscriptions: 1,
    lastAt: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
    latest: {
      actor: 'github:alice',
      human: true,
      at: 1_700_000_000_000,
      preview: 'please fix the login redirect'
    },
    ...overrides
  }
}

/** 情景里的 Thread：四档筛选各有一条可看的行。 */
const THREAD_ROWS: readonly PanelThread[] = [
  threadRow('github:owner/widgets#12', 'owner/widgets#12'),
  threadRow('github:owner/widgets#13', 'owner/widgets#13', 'evaluating'),
  threadRow('github:owner/widgets#14', 'owner/widgets#14', 'queued', { pending: 2 }),
  threadRow('github:owner/widgets#15', 'owner/widgets#15', 'error', {
    pollError: 'graphql: 502 Bad Gateway'
  }),
  threadRow('github:owner/widgets#16', 'owner/widgets#16', 'dormant')
]

/** Trigger 列表的长列表：60 条订阅的线程（§M.4 的「分页 50 条」）。 */
const MANY_THREADS: readonly PanelThread[] = Array.from({ length: 60 }, (_, index) =>
  threadRow(
    `github:owner/widgets#${index}`,
    `owner/widgets#${index}`,
    'subscribed',
    { subscriptions: index % 3 }
  )
)

/** 四档筛选在夹具上的判定（档位与 worker 的读模型同一口径，只是把 `PanelThread` 切片）。 */
const THREAD_STAGES: Readonly<Record<ThreadFilter, readonly PanelThread['stage'][]>> = {
  subscribed: ['subscribed'],
  evaluating: ['evaluating', 'queued'],
  recent: ['subscribed', 'evaluating', 'queued', 'error', 'dormant'],
  all: ['subscribed', 'evaluating', 'queued', 'error', 'dormant', 'unsubscribed']
}

/** `threads` 请求的答案（§M.2 的四档筛选 + §M.4 的分页 50 条）。 */
function threadsPage(rows: readonly PanelThread[], input: unknown): ThreadListPage {
  const window = (input ?? {}) as {
    readonly filter?: ThreadFilter
    readonly offset?: number
    readonly limit?: number
  }
  const filter = window.filter ?? 'subscribed'
  const offset = Math.max(0, window.offset ?? 0)
  const limit = Math.max(1, Math.min(50, window.limit ?? 50))
  const matching = rows.filter((row) => THREAD_STAGES[filter].includes(row.stage))
  return {
    items: matching.slice(offset, offset + limit),
    nextOffset: offset + limit < matching.length ? offset + limit : null
  }
}

/** 一条 Thread 的详情：一条被交回的触发、一条被接单的触发、订阅与决定都在。 */
function threadDetailFixture(rows: readonly PanelThread[], key: string): ThreadDetailView {
  const thread = rows.find((row) => row.key === key)
  return {
    key,
    source: 'github',
    title: thread?.title ?? 'owner/widgets#12',
    url: 'https://github.test/owner/widgets/pull/12',
    stage: thread?.stage ?? 'subscribed',
    createdAt: 1_700_000_000_000,
    lastAt: 1_700_000_060_000,
    pending: thread?.pending ?? 0,
    subscriptions: [
      { id: 't1', title: 'Fix the login redirect', state: 'open', context: false },
      { id: 't2', title: 'Review the parser rewrite', state: 'ended', context: true }
    ],
    decisions: [
      {
        id: 'decision-1',
        kind: 'accept',
        reasons: [{ code: 'explicitRouted' }],
        strength: 'explicit',
        policyVersion: 'v3',
        at: 1_700_000_000_000,
        ticketId: 't1'
      }
    ],
    timeline: [
      {
        id: 'trigger-2',
        source: 'github',
        actor: 'github:bob',
        human: true,
        at: 1_700_000_060_000,
        text: 'also update the docs',
        queued: false,
        evaluating: false,
        delivered: false,
        fanout: ['t1'],
        handbacks: [
          {
            ticketId: 't1',
            ticketTitle: 'Fix the login redirect',
            reason: 'Asks for a new page',
            at: 1_700_000_120_000
          }
        ],
        canRequeue: true
      },
      {
        id: 'trigger-1',
        source: 'github',
        actor: 'github:alice',
        human: true,
        at: 1_700_000_000_000,
        text: 'please fix the login redirect',
        queued: false,
        evaluating: false,
        delivered: false,
        fanout: ['t1'],
        handbacks: [],
        decision: {
          id: 'decision-1',
          kind: 'accept',
          reasons: [{ code: 'explicitRouted' }],
          strength: 'explicit',
          policyVersion: 'v3',
          at: 1_700_000_000_000,
          ticketId: 't1'
        },
        canRequeue: false
      }
    ],
    earlier: null
  }
}

/** 详情的读数：一张可以直接看的工单（授权、等待中的输入、订阅、派工、报告、待人工、终端）。 */
function detailFixture(state: PanelState, ticketId: string): TicketDetailView {
  const ticket = (state.tickets ?? []).find((row) => row.id === ticketId)
  const title = ticket?.title ?? 'Fix the login redirect'
  return {
    id: ticketId,
    title,
    stage: ticket?.stage ?? 'working',
    ...(ticket?.outcome === undefined ? {} : { outcome: ticket.outcome }),
    at: 1_700_000_000_000,
    mandate: {
      strength: 'explicit',
      actor: 'github:alice',
      policyVersion: 'v3',
      via: 'addressed',
      rules: ['rule-login']
    },
    waitingInputs: [
      { id: 'i-1', kind: 'trigger', at: 1_700_000_000_000, text: 'also update the docs', human: true }
    ],
    subscriptions: [
      { key: 'github:owner/widgets#12', title: 'owner/widgets#12', lastAt: 1_700_000_000_000, context: false }
    ],
    assignments: [
      {
        id: 'a-1',
        state: 'running',
        createdAt: 1_700_000_000_000,
        startedAt: 1_700_000_000_000,
        terminalId: 'term_3',
        report: { state: 'progress', summary: 'reading the router', at: 1_700_000_000_000 }
      }
    ],
    reports: [{ state: 'progress', summary: 'reading the router', at: 1_700_000_000_000 }],
    ...(ticket?.stage === 'answer'
      ? {
          attention: {
            question: 'Which branch should I target?',
            at: 1_700_000_000_000,
            via: 'terminal' as const
          }
        }
      : {}),
    terminal: {
      terminalId: 'term_3',
      lines: ['reading the router', 'Do you want me to continue? [y/N]'],
      truncated: false
    },
    worktree: { name: 'fix-login', directory: '/repos/widgets/superagent-fix-login' },
    canRetry: false
  }
}

/** 一个情景的宿主选项：`state` 的答案 + Execution 列表/详情 + 动作的答案（同一份快照的变体）。 */
function hostFor(state: PanelState, threadRows: readonly PanelThread[] = THREAD_ROWS) {
  return {
    requests: {
      state: () => state,
      pause: (input: unknown) => {
        const paused = (input as { paused?: boolean } | null)?.paused === true
        return nextRevision(state, paused)
      },
      // 「检查一次」只重读读模型：check 不做写入，回的就是同一份读数的新修订。
      check: () => nextRevision(state),
      // Execution 列表与详情（§M.2）：check 的 `execution` 情景真的走这两条请求。
      tickets: (input: unknown) => executionPage(state, input),
      'ticket.detail': (input: unknown) =>
        detailFixture(state, (input as { ticketId?: string } | null)?.ticketId ?? 't1'),
      'ticket.retry': () => nextRevision(state),
      'ticket.stop': () => nextRevision(state),
      'ticket.note': () => nextRevision(state),
      'ticket.requestStatus': () => ({ asked: true }),
      'terminal.focus': () => ({ focused: true }),
      'workspace.open': () => ({ opened: true }),
      'workspace.remove': () => ({ removed: true }),
      // Trigger 页（§M.2）：列表、详情与两条动作（check 的 `trigger` 情景真的走这四条）。
      threads: (input: unknown) => threadsPage(threadRows, input),
      'thread.detail': (input: unknown) =>
        threadDetailFixture(threadRows, (input as { threadKey?: string } | null)?.threadKey ?? ''),
      'trigger.requeue': () => ({ queued: true }),
      'thread.unsubscribe': () => ({ removed: true })
    }
  }
}

/** 部署页的一份读数：健康板是真的（三个条目由不同的写者 claim，与 #45 同一份形状）。 */
function deploymentFixture(): DeploymentView {
  const board = new HealthBoard()
  board.claim('runtime', { state: 'ready', detail: 'loopback api on 127.0.0.1:3847' })
  board.claim('passes', { state: 'starting', detail: 'not run yet' })
  board.claim('router', { state: 'error', detail: 'restarts 5 in 10 min, last error: launch timed out' })
  board.claim('sync:github', { state: 'paused', detail: 'not synced yet' })
  return deploymentView({
    stateDir: '/var/lib/superagent',
    setup: [
      {
        place: 'executor',
        code: 'base_repo_missing',
        kind: 'missing',
        detail: 'the base repository path:/repos/widgets is not registered in Orca',
        fix: 'pick a repository Orca already has (`orca repo list`), or add it to Orca first',
        checkAgain: 'superagent setup check'
      }
    ],
    limits: DEFAULT_MACHINE_LIMITS,
    paused: false,
    health: board.all(),
    router: {
      state: 'error',
      detail: 'restarts 5 in 10 min',
      terminalId: 'term_router',
      startedAt: '2026-11-07T03:00:00.000Z',
      restarts: 5,
      lastError: 'launch timed out'
    }
  })
}

/**
 * Prompts 组的读数（§M.3 的四个子页）：分片正文、角色与必保留占位符来自**真注册表**，
 * 版本、历史、技能与两份全文是固定值——check 只看渲染，不读库、不拼真全文。
 */
function promptsFixture(): PanelPromptsView {
  const stateDir = '/var/lib/superagent'
  const textOf = (key: (typeof PROMPT_PART_KEYS)[number]): string => PROMPT_PARTS[key].lines.join('\n')
  const parts: PanelPromptPart[] = PROMPT_PART_KEYS.map((key) => ({
    key,
    roles: [...PROMPT_PARTS[key].roles],
    kind: PROMPT_PARTS[key].kind,
    placement: PROMPT_PARTS[key].placement,
    text: textOf(key),
    placeholders: [...PROMPT_PARTS[key].placeholders],
    base: `b-${key}`
  }))
  const config = {
    team: { communication: 'Answer this team in short sentences, and in Chinese.' },
    overrides: {
      'runtime/replies': {
        text: `${textOf('runtime/replies')}\nKeep every acknowledgement under twenty words.`,
        base: 'b-runtime/replies'
      }
    },
    skills: { 'team-review': 'Read the diff of every file you touched before you report.' }
  }
  return {
    revision: 3,
    saved: { revision: 3, predecessor: 2, at: '2026-11-07T03:20:00.000Z', origin: 'panel' },
    config,
    sections: [...TEAM_SECTIONS],
    parts,
    defaultChanged: ['runtime/replies'],
    removedParts: [],
    changes: [
      {
        part: 'runtime/replies',
        base: 'b-old',
        previous: 'Reply in one short paragraph.',
        next: textOf('runtime/replies'),
        removed: false
      }
    ],
    history: [
      { revision: 3, predecessor: 2, at: '2026-11-07T03:20:00.000Z', origin: 'panel' },
      { revision: 2, predecessor: 1, at: '2026-11-06T09:10:00.000Z', origin: 'tool' },
      { revision: 1, predecessor: null, at: '2026-11-05T18:00:00.000Z', origin: 'panel' }
    ],
    skills: [
      ...BUILT_IN_SKILLS.map((skill) => ({
        name: skill.name,
        path: skillFilePath(stateDir, skill.name),
        text: composeSkill(skill.kind),
        readOnly: true
      })),
      {
        name: 'team-review',
        path: skillFilePath(stateDir, 'team-review'),
        text: 'Read the diff of every file you touched before you report.',
        readOnly: false
      }
    ],
    stateDir,
    maxChars: DEFAULT_MACHINE_LIMITS.promptMaxChars,
    texts: {
      saved: {
        orchestrator: '# Superagent orchestrator\n\nAnswer this team in short sentences, and in Chinese.',
        worker: '# Superagent worker\n\nAnswer this team in short sentences, and in Chinese.'
      },
      defaults: {
        orchestrator: '# Superagent orchestrator\n\nBe concise and concrete.',
        worker: '# Superagent worker\n\nBe concise and concrete.'
      }
    }
  }
}

/** Prompts 组的情景：读数 + 预览/保存/恢复的确定答案（打开就停在 Prompts 的编辑页）。 */
function promptsHost(state: PanelState) {
  const view = promptsFixture()
  return {
    ...hostFor(state),
    requests: {
      ...hostFor(state).requests,
      prompts: () => view,
      'prompts.preview': (input: unknown) => {
        const config = ((input ?? {}) as { config?: unknown }).config ?? {}
        return { ok: true, config, dropped: [], texts: view.texts.saved }
      },
      'prompts.save': () => view,
      'prompts.restore': () => view
    },
    storage: { 'panel.page': 'settings', 'panel.settingsGroup': 'prompts' }
  }
}

/** doctor 的三档都出现一次（check 只看渲染，不真跑子进程）。 */
const DOCTOR_FIXTURE: DoctorView = {
  checks: [
    { name: 'token', state: 'ok', detail: 'the operator token file is present (0600)' },
    { name: 'lark', state: 'warn', detail: 'lark-cli is not installed', hint: 'install lark-cli when you use Feishu' },
    { name: 'port', state: 'fail', detail: 'nothing answers on the recorded port' }
  ],
  summary: { ok: 1, warn: 1, fail: 1 },
  at: '2026-11-07T03:20:00.000Z',
  note: 'doctor diagnoses this machine (present or missing, never a value); the setup check decides whether the plugin may start: superagent setup check'
}

/** Deployment 组的情景：读数 + doctor + 三条动作的确定答案。 */
function deploymentHost(state: PanelState) {
  return {
    ...hostFor(state),
    requests: {
      ...hostFor(state).requests,
      deployment: () => deploymentFixture(),
      doctor: () => DOCTOR_FIXTURE,
      setupCheck: () => ({ checked: true, problems: [] }),
      rotateToken: () => ({ rotated: true, tokenFile: '/var/lib/superagent/api-token' }),
      restartRouter: () => deploymentFixture().router
    },
    // 打开面板就停在 Settings：check 渲染的是 Deployment 组本身（keyed atom 读插件存储，
    // 所以用 mockHost 的 `storage` 播种；`persisted` 不喂 `persist: 'storage'` 的 atom）。
    storage: { 'panel.page': 'settings' }
  }
}

export default defineCheck({
  /** 冷启动：worker 还没应答，面板说「正在启动」并只重试一次。 */
  booting: {
    requests: {
      state: () => {
        throw Object.assign(new Error('worker not started'), { code: 'unavailable' })
      }
    }
  },
  /** 健康且没什么要做：空态 + Source 概况 + 24 h 流水。 */
  empty: hostFor(
    snapshot({
      sources: { enabled: 2, problems: 0 },
      activity: { received: 2, evaluated: 1, accepted: 0, ignored: 1 }
    })
  ),
  /** 健康且有流水与负载；Execution 页有一张真实形状的工单行。 */
  healthy: hostFor(
    snapshot({
      sources: { enabled: 1, problems: 0 },
      activity: { received: 12, evaluated: 9, accepted: 3, ignored: 6, ended: 1 },
      executor: { running: 1, maxWorkers: 4, humanSlot: 'free' },
      tickets: [ticketRow('t1', 'Fix the login redirect')]
    })
  ),
  /** 有待人工：两个阶段各一行，各自带直接动作（回答 + 打开终端 / 评审）。 */
  'needs-person': hostFor(
    snapshot({
      sources: { enabled: 1, problems: 0 },
      activity: { received: 6, evaluated: 5, accepted: 2, ignored: 3 },
      items: [
        ticket('t1', 'Fix the login redirect', 'answer', 'term_3'),
        ticket('t2', 'Review the parser rewrite', 'review')
      ],
      tickets: [
        ticketRow('t1', 'Fix the login redirect', 'answer'),
        ticketRow('t2', 'Review the parser rewrite', 'review')
      ]
    })
  ),
  /** 有系统问题：三类来源各来一条（health error、发不出去的回复、未解决的评估）。 */
  problems: hostFor(
    snapshot({
      sources: { enabled: 1, problems: 1 },
      error: true,
      activity: { received: 3, evaluated: 3, accepted: 0, ignored: 3 },
      problems: [
        problem('health', 'health:assessment', 'assessment', 'waiting 2, failed 1'),
        problem('reply', 'reply:m1', 'github:owner/widgets#12'),
        problem('unavailable', 'unavailable:d1', 'thread-7', 'The model could not judge this request')
      ]
    })
  ),
  /** 处理已暂停：页面给「恢复处理」的入口（危险操作，按下后行内二次确认）。 */
  paused: hostFor(
    snapshot({
      paused: true,
      sources: { enabled: 1, problems: 0 },
      activity: { received: 1, evaluated: 0, accepted: 0, ignored: 0 }
    })
  ),
  /** setup 缺失：指向 Settings 的提示。 */
  'setup-missing': hostFor(snapshot({ setupMissing: true })),
  /** Deployment 组：setup 问题、状态目录、限额、暂停、health、Router、doctor 与已知限制。 */
  deployment: deploymentHost(
    snapshot({
      setupMissing: true,
      error: true,
      problems: [problem('health', 'health:router', 'router', 'restarts 5 in 10 min')],
      activity: { received: 5, evaluated: 4, accepted: 1, ignored: 3 }
    })
  ),
  /** Prompts 组：三个团队段、每个分片一个字段、可读的占位符、历史与技能各自都在。 */
  prompts: promptsHost(
    snapshot({
      sources: { enabled: 1, problems: 0 },
      activity: { received: 5, evaluated: 4, accepted: 1, ignored: 3 }
    })
  ),
  /** 长列表：60 行，首页 50 行 + 「加载更多」（Overview 的待人工与 Execution 的工单都带着）。 */
  'long-lists': hostFor(
    snapshot({
      sources: { enabled: 1, problems: 0 },
      activity: { received: 60, evaluated: 60, accepted: 60, ignored: 0 },
      items: manyTickets,
      tickets: manyRows
    })
  ),
  /** Execution 列表本身：打开就停在这一页，60 张工单、五档筛选、首页 50 行 + 「加载更多」。 */
  execution: {
    ...hostFor(
      snapshot({
        sources: { enabled: 1, problems: 0 },
        activity: { received: 60, evaluated: 60, accepted: 60, ignored: 0 },
        tickets: manyRows
      })
    ),
    storage: { 'panel.page': 'execution', 'panel.executionFilter': 'open' }
  },
  /** Trigger 列表本身：打开就停在这一页，60 条线程、四档筛选、首页 50 行 + 「加载更多」。 */
  trigger: {
    ...hostFor(
      snapshot({
        sources: { enabled: 1, problems: 0 },
        activity: { received: 60, evaluated: 60, accepted: 0, ignored: 60 }
      }),
      MANY_THREADS
    ),
    storage: { 'panel.page': 'trigger', 'panel.threadFilter': 'subscribed' }
  },
  /** 浅色主题下的待人工页面（`theme` 是 check 能区分的维度；`locale` 见文件头）。 */
  zh: {
    ...hostFor(
      snapshot({
        items: [ticket('t1', '修复登录跳转', 'answer', 'term_4')],
        tickets: [ticketRow('t1', '修复登录跳转', 'answer')]
      })
    ),
    theme: 'light' as const
  },
  /** 深色主题下的同一页面。 */
  en: {
    ...hostFor(
      snapshot({
        items: [ticket('t1', 'Fix the login redirect', 'answer', 'term_5')],
        tickets: [ticketRow('t1', 'Fix the login redirect', 'answer')]
      })
    ),
    theme: 'dark' as const
  },
  /** 危险操作入口：暂停态 + 待人工，页面上同时有「恢复处理」（需二次确认）与待办行。 */
  'danger-confirm': hostFor(
    snapshot({
      paused: true,
      items: [ticket('t1', 'Stop or keep the nightly import')]
    })
  )
})

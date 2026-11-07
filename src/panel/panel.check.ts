// `orca plugin check` 的情景集（§M.7）：每个值得看的状态一个场景；check 逐情景渲染面板，
// 并把 worker 挂到同一个替身宿主上，所以面板的 `plugin.request` 真的会走到 worker 的处理器。
//
// 情景名单（§M.7）：booting、empty、healthy、needs-person、problems、paused、setup-missing、
// long-lists、deployment、zh、en、danger-confirm。
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
import type {
  AttentionItem,
  DeploymentView,
  DoctorView,
  HumanSlot,
  PanelState,
  PanelTicket,
  SystemProblem
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

/** 一个情景的宿主选项：`state` 的答案 + 四个动作的答案（同一份快照的变体）。 */
function hostFor(state: PanelState) {
  return {
    requests: {
      state: () => state,
      pause: (input: unknown) => {
        const paused = (input as { paused?: boolean } | null)?.paused === true
        return nextRevision(state, paused)
      },
      // 「检查一次」只重读读模型：check 不做写入，回的就是同一份读数的新修订。
      check: () => nextRevision(state),
      'ticket.retry': () => nextRevision(state),
      'terminal.focus': () => ({ focused: true })
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
  /** 长列表：60 行，首页 50 行 + 「加载更多」。 */
  'long-lists': hostFor(
    snapshot({
      sources: { enabled: 1, problems: 0 },
      activity: { received: 60, evaluated: 60, accepted: 60, ignored: 0 },
      items: manyTickets
    })
  ),
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

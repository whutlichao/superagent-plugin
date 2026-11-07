// 组合根（§C.1 `worker/boot.ts`、§N.1）：把锁、库、迁移、setup、HTTP、loops、状态栏与
// 启动恢复按固定顺序接起来；`deactivate()` 按相反顺序收尾。
//
// 顺序（§N.1 的启动行 + §E.5 的停止行）：
//   取锁 → 开库（含迁移）→ setup 探针 → 注册 kind → 引擎/执行器/outbox/effects → passes
//   → HTTP → 启动恢复（升级走 `resumeAfterUpgrade`）→ 轮询与状态栏 → 对外可用
// 停止：停定时器 → 等 pass → 排空 effects（保留 pending 行）→ 关 HTTP → 关库 → 放锁
//   （worker 终端不杀：它们属于 Orca，重启后由 resume 认领，§E.5）。
//
// 依赖纪律（§C.2）：本文件不 import `orca`、不 host.call、不 spawn；宿主形状只经注入的
// `OrcaRuntime` 与端口进入。
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { PanelState } from '../panel/protocol'
import { Engine } from './core/index.ts'
import type { Store } from './app/store.ts'
import { openStore } from './app/store.ts'
import { acquireLock } from './infra/lock.ts'
import { createLogger, type Logger } from './infra/log.ts'
import { HealthBoard, claimModelsEntry } from './infra/health.ts'
import { defaultStateDir, resolveStateDir, writeStateDirPointer } from './infra/paths.ts'
import { ensureApiToken, issueAssignmentToken, issueRouterToken } from './infra/tokens.ts'
import { createRepositories } from './app/repositories.ts'
import {
  createPolicy,
  DEFAULT_POLICY,
  UNVERSIONED_POLICY,
  validatePolicy
} from './policy/index.ts'
import type { PolicyKindView } from './policy/index.ts'
import { resolveRoles } from './app/roles.ts'
import { ROUTER_RESTARTS_KEY, ROUTER_TERMINAL_KEY, ROUTER_WORKSPACE_KEY, PROMPT_REVISION_KEY } from './app/kv.ts'
import { createDeterministicAssessor } from './app/assessor.ts'
import { createOutbox, registerReplyEffects } from './app/outbox.ts'
import { createPausedState } from './app/pause.ts'
import {
  feishuChatsKey,
  feishuCursorKey,
  feishuTopicsKey,
  githubCursorKey,
  sourceLabelsKey,
  threadSeenKey
} from './app/kv.ts'
import { createRefreshableStateSource, type RefreshableStateSource } from './app/state-source.ts'
import { statusBarView } from './app/status-bar.ts'
import type { StatusBarView } from './app/status-bar.ts'
import { Effects, ROUTER_EFFECT_KEY } from './app/effects.ts'
import { createPasses } from './app/passes.ts'
import { notePluginVersion } from './app/upgrade.ts'
import { createSourceContext } from './app/source-context.ts'
import { createSetupState, issuesOf, runSetupChecks } from './app/setup.ts'
import type { SetupCheckInput, SetupIssue, SetupProblem, SetupReport } from './app/setup.ts'
import { SourceRegistry, type SourceSettingsView } from './sources/registry.ts'
import { Commands, type CommandsHost } from './sources/commands.ts'
import {
  createGithubApi,
  createGithubKind,
  createGithubPoller,
  subscribedThreads,
  GITHUB_KIND
} from './sources/github/index.ts'
import type { GithubPollResult, GithubPoller } from './sources/github/index.ts'
import {
  FEISHU_KIND,
  createFeishuApi,
  createFeishuBackfill,
  createFeishuKind,
  createFeishuStream,
  feishuConfigSchema,
  refreshChatNames,
  type FeishuBackfill,
  type FeishuConfig,
  type FeishuKeys,
  type FeishuRoundResult,
  type FeishuStream
} from './sources/feishu/index.ts'
import type { Deployment } from './sources/kind.ts'
import { OrcaExecutor, registerExecutorEffects, registerExecutorLifecycle, resolveExecutorSettings } from './executor/orca-executor.ts'
import { resumeAfterUpgrade, type ResumeReport } from './executor/resume.ts'
import { DEFAULT_MAX_WORKERS } from './http/state.ts'
import { createDomainHandlers, withDomainHandlers } from './http/domain.ts'
import { ROUTE_TABLE, type RouteDefinition } from './http/routes.ts'
import type { LoopEntry } from './http/state.ts'
import { startHttpServer, type HttpServerHandle } from './http/server.ts'
import type { AgentStatusEvent, OrcaRuntime } from './runtime/orca-runtime.ts'
import { createRouterRelay } from './router/relay.ts'
import {
  createRouterSupervision,
  type RouterRestartState,
  type RouterSnapshot,
  type RouterStateStore,
  type RouterTerminalState,
  type RouterWorkspaceState
} from './router/supervision.ts'

/** worker 侧一轮 pass 的周期（§N.1 的 2 s 巡检）。 */
export const PASS_INTERVAL_MS = 2000

/** 历史回填、话题轮询与群名刷新的周期（§I.3：群名一分钟内刷新）。 */
export const FEISHU_ROUND_MS = 60_000

/** 组合根的输入：宿主、设置与三件输出端口全部注入（测试不碰 Orca、不 sleep）。 */
export interface BootOptions {
  readonly runtime: OrcaRuntime
  /** 读一次宿主设置（`orca.settings.get()` 的形状）。 */
  readonly readSettings: () => Promise<Readonly<Record<string, unknown>>>
  /** 命令端口（Source 的 `gh` 出口）；缺省按设置建一个。 */
  readonly commands?: CommandsHost
  /** `superagent` CLI 的绝对路径；缺省由模块位置推出 `src/bin/superagent.mjs`。 */
  readonly cliPath?: string
  readonly stateDir?: string
  readonly now?: () => string
  readonly nowMs?: () => number
  /** 日志镜像（`orca.log`）；落盘由 `infra/log.ts` 负责。 */
  readonly log?: (message: string) => void
  /** 状态栏发布器（节流在 `app/status-bar.ts`；缺省不发）。 */
  readonly statusBar?: { publish(view: StatusBarView): void; dispose(): void }
  /** 面板推送（`state.changed`）；缺省不发。 */
  readonly panels?: { post(event: string, payload: unknown): void }
  /** Orca 通知。 */
  readonly notify?: (input: { readonly title: string; readonly body?: string }) => void
  /** 测试关闭定时器，用 `passOnce`/`pollOnce` 手动推进。 */
  readonly disableTimers?: boolean
  readonly passIntervalMs?: number
  /** 覆盖 Source 的 `pollSeconds`（测试用；生产读配置）。 */
  readonly pollIntervalMs?: number
  readonly preferredPort?: number
}

/** 组合根交给 `main.ts` 的句柄。 */
export interface BootHandle {
  readonly mode: 'leader' | 'follower'
  readonly stateDir: string
  /** 首屏就绪：设置读完、HTTP 已监听、恢复已做完。 */
  readonly ready: Promise<void>
  snapshot(): PanelState
  /** 一轮通知轮询（定时器与测试共用）。 */
  pollOnce(): Promise<GithubPollResult>
  /** 一轮 Feishu 回填（含话题轮询与群名刷新）；没有可用实例时 `null`。 */
  feishuOnce(): Promise<FeishuRoundResult | null>
  /** 一轮 pass（先到期的 effect，再到期评估与评估决定）。 */
  passOnce(): Promise<void>
  /** 实际监听的端口；follower/未监听时 `null`。 */
  port(): number | null
  /** 启动恢复做了什么（`resume`/`resumeAfterUpgrade` 的读数）。 */
  resumeReport(): ResumeReport | null
  /** `agent.status.changed` 的四态映射（main 把宿主事件转进来）；Router 的终端的 done 也走它。 */
  onAgentStatus(event: AgentStatusEvent): Promise<void>
  /** 一轮 Router 监督（3 s 定时器与测试共用）。 */
  routerTick(): Promise<void>
  /** Router 的读数：终端、起始时刻、重启次数、疑似空转与未决候选（§D.4、§F.3）。 */
  routerStatus(): RouterSnapshot
  /** 人显式要求重启 Router（命令 / 面板按钮，§F.1）。 */
  restartRouter(): Promise<void>
  /** prompt 版本变化 → 一条 notice（不重启、不注入，§F.4）。 */
  notifyPromptRevision(revision: number): void
  /** 暂停写后的快照刷新（面板 `pause` 请求用）。 */
  refresh(): PanelState
  /** 写暂停状态（唯一写者是 `app/pause.ts`）并刷新快照。 */
  setPaused(paused: boolean): PanelState
  /**
   * `superagent setup check`（§G.2）：重跑探针、把结论应用到各部分并重新武装挂起的循环，
   * **不重启 Orca**。`checked: false` 表示检查时本来就没有问题——没有可检查的东西。
   */
  checkSetup(): Promise<SetupCheckOutcome>
  shutdown(): Promise<void>
}

/** `setup check` 的读数（HTTP handler 与面板共用）。 */
export interface SetupCheckOutcome {
  /** 是否真的重跑了一次（本来就没有问题时为 false：`setup check` 拒绝空跑）。 */
  readonly checked: boolean
  /** 现在的第一条 setup 问题（`SETUP_PLACES` 顺序）。 */
  readonly problem: SetupProblem | null
  readonly issues: readonly SetupIssue[]
  /** 挂起的循环是否被重新武装（Source 轮询与 Router 监督）。 */
  readonly restarted: boolean
}

/** 模块位置推出的 CLI 绝对路径（`src/worker/boot.ts` → `src/bin/superagent.mjs`）。 */
export function defaultCliPath(): string {
  return join(import.meta.dirname, '..', 'bin', 'superagent.mjs')
}

/** 设置里的字符串（去空白；非字符串/空串当没有）。 */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** 设置里的布尔（缺省值由调用方给）。 */
function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** 一个设置块；不是对象就当空。 */
function block(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/** 把设置解析成注册表要的视图（`sources.<id>` 与 `policy.sources.<id>`）。 */
function settingsView(
  raw: Readonly<Record<string, unknown>>,
  github: { enabled: boolean; config: Record<string, unknown> },
  feishu: { enabled: boolean; config: Record<string, unknown> }
): SourceSettingsView {
  const policy = block(raw['policy'])
  const sources = block(policy['sources'])
  return {
    sources: {
      [GITHUB_KIND]: { enabled: github.enabled, config: github.config },
      [FEISHU_KIND]: { enabled: feishu.enabled, config: feishu.config }
    },
    policy: {
      sources: {
        [GITHUB_KIND]: block(sources[GITHUB_KIND]),
        [FEISHU_KIND]: block(sources[FEISHU_KIND])
      }
    }
  }
}

/** 一个 Source 实例的配置与 setup 问题（缺 repository/cli 时不轮询，§I.2）。 */
interface GithubSetup {
  readonly enabled: boolean
  readonly config: Record<string, unknown>
  /** setup 探针读到的 agent 账号（读不到时回落设置；§I.2 的 `@mention` 与自身消息都要它）。 */
  readonly login: string
  readonly problem?: { readonly place: string; readonly code: string; readonly detail?: string }
}

/**
 * 组合根。拿到 leader 锁后返回一个已监听 HTTP 的句柄；follower 模式只记日志、不启 loops、
 * 不开 HTTP（§N.1），句柄的 `ready` 立刻完成，`mode` 说明它是什么。
 */
export async function bootPlugin(options: BootOptions): Promise<BootHandle> {
  const now = options.now ?? (() => new Date().toISOString())
  const nowMs = options.nowMs ?? (() => Date.now())
  const log = options.log ?? (() => undefined)
  const settings = await options.readSettings()
  const resolved = options.stateDir ?? text(settings['stateDir']) ?? resolveStateDir({}).stateDir
  mkdirSync(resolved, { recursive: true })
  // CLI 在默认目录上找得到设置的 stateDir（§G.4 第 1 条）。
  if (resolved !== defaultStateDir()) {
    try {
      writeStateDirPointer(defaultStateDir(), resolved)
    } catch {
      // 指针写不进去不挡启动：显式参数与环境变量仍然有效。
    }
  }

  const lockOutcome = acquireLock({ stateDir: resolved, now: () => new Date(nowMs()) })
  if (lockOutcome.mode === 'follower') {
    log(`another instance owns ${resolved}; this process follows it`)
    const follower: BootHandle = {
      mode: 'follower',
      stateDir: resolved,
      ready: Promise.resolve(),
      snapshot: () => emptySnapshot(),
      pollOnce: async () => ({ notifications: 0, triggers: 0, skipped: 0 }),
      feishuOnce: async () => null,
      passOnce: async () => undefined,
      port: () => null,
      resumeReport: () => null,
      onAgentStatus: async () => undefined,
      routerTick: async () => undefined,
      routerStatus: () => emptyRouterSnapshot(),
      restartRouter: async () => undefined,
      notifyPromptRevision: () => undefined,
      refresh: () => emptySnapshot(),
      setPaused: () => emptySnapshot(),
      // follower 不读库、不跑探针：它没有可以做检查的东西。
      checkSetup: async () => ({ checked: false, problem: null, issues: [], restarted: false }),
      shutdown: async () => undefined
    }
    return follower
  }

  const lock = lockOutcome.lock
  const logger: Logger = createLogger({ stateDir: resolved, now: () => new Date(nowMs()), mirror: log })
  const store: Store = openStore({ stateDir: resolved, log: logger.sink })
  const board = new HealthBoard()
  const runtimeHealth = board.claim('runtime', { state: 'ready', detail: 'booted' })
  // §N.4、§H.4：`models` 条目恒 ready、明细写「handled by Orca」——模型预算重试是 Orca 的事。
  claimModelsEntry(board)
  const paused = createPausedState(store, now)
  const repo = createRepositories(store)

  // ---- 设置与 setup 探针（§N.1、§I.4）：一次只告诉人缺什么，不把「没配置」写成 error
  const executorSettings = resolveExecutorSettings(settings)
  const rawSources = block(settings['sources'])
  const githubStored = block(rawSources[GITHUB_KIND])
  const commandPort: CommandsHost =
    options.commands ?? new Commands({ configuredPrograms: () => [text(settings['githubCli'])] })
  const githubInstance = githubInstanceOf({ raw: settings, stored: githubStored })
  const feishuCli = feishuCliOf(rawSources)
  const setupInput = (): SetupCheckInput => ({
    stateDir: resolved,
    agent: executorSettings.agent,
    ...(executorSettings.model === undefined ? {} : { model: executorSettings.model }),
    ...(executorSettings.baseRepo === undefined ? {} : { baseRepo: executorSettings.baseRepo }),
    ...(executorSettings.baseBranch === undefined ? {} : { baseRef: executorSettings.baseBranch }),
    repository: githubInstance.repository,
    githubCli: githubInstance.cli,
    githubEnabled: githubInstance.enabled,
    ...(feishuCli === undefined ? {} : { feishuCli }),
    ports: {
      run: (program, args) => commandPort.run(program, args),
      repos: () => options.runtime.listRepos(),
      searchRefs: (selector, query) => options.runtime.searchRefs(selector, query)
    }
  })
  // 读不到的账号回落到设置里的值（§I.2：自身消息的判定要一个账号）。
  const fallbackLogin = text(settings['githubLogin']) ?? ''
  const githubSetup: GithubSetup = {
    enabled: githubInstance.enabled,
    config: githubInstance.config,
    login: fallbackLogin
  }
  const feishuStored = block(rawSources[FEISHU_KIND])
  const feishuSetup = await setupFeishu({
    raw: settings,
    stored: feishuStored,
    commands:
      options.commands ??
      new Commands({ configuredPrograms: () => [text(settings['feishuCli'])] }),
    log: (message) => logger.info(message)
  })
  const setup = createSetupState(await runSetupChecks(setupInput()))
  const sourceSettings: SourceSettingsView = settingsView(settings, githubSetup, feishuSetup)

  // ---- 注册表与 kind
  const registry = new SourceRegistry({ health: board, settings: () => sourceSettings })
  registry.register(createGithubKind(String(githubSetup.config['cli'] ?? 'gh')))
  registry.register(createFeishuKind())
  const githubHealth = registry.healthEntries(['github']).get('github')
  const feishuHealth = registry.healthEntries(['feishu', 'history'])
  /**
   * 把 setup 结论落到各部分：Source 的 setup 问题写 `starting`（**不是** error，§N.4），
   * `orca` CLI 缺失才是 runtime error（§I.4：其余 setup 问题都不该让插件看起来「坏了」）。
   */
  function applySetup(report: SetupReport): void {
    setup.apply(report)
    const githubIssues = issuesOf(report.issues, 'github')
    if (githubIssues.length > 0) {
      githubHealth?.set({ state: 'starting', detail: githubIssues[0]?.code ?? 'setup' })
    } else if (!githubSetup.enabled) {
      githubHealth?.set({ state: 'paused', detail: 'disabled' })
    }
    const feishuIssues = issuesOf(report.issues, 'feishu')
    if (feishuIssues.length > 0) {
      for (const entry of feishuHealth.values()) {
        entry.set({ state: 'starting', detail: feishuIssues[0]?.code ?? 'setup' })
      }
    } else if (!feishuSetup.enabled) {
      for (const entry of feishuHealth.values()) entry.set({ state: 'paused', detail: 'disabled' })
    }
    if (issuesOf(report.issues, 'orca').length > 0) {
      runtimeHealth.set({ state: 'error', detail: 'cli_missing' })
    } else if (runtimeHealth.get()?.state === 'error') {
      runtimeHealth.set({ state: 'ready', detail: 'booted' })
    }
  }
  applySetup(setup.report())
  const githubLogin = (): string => setup.report().githubLogin || fallbackLogin
  const githubBlocked = (): boolean => setup.blocked('github')
  const githubProblem = (): GithubSetup['problem'] => {
    const found = issuesOf(setup.issues(), 'github')[0]
    if (found === undefined) return undefined
    return { place: found.place, code: found.code, detail: found.detail }
  }
  /**
   * Feishu 的 setup 问题：setup 报告是「缺什么」的唯一权威（含 bot-only 规则），
   * `setupFeishu` 读机器人的那次调用若失败（`bot_unreadable`）也一并算进来。
   */
  const feishuProblem = (): FeishuSetup['problem'] => {
    const found = issuesOf(setup.issues(), 'feishu')[0]
    if (found !== undefined) return { place: found.place, code: found.code, detail: found.detail }
    return feishuSetup.problem
  }

  // ---- 领域与执行器
  const health = board
  const effects = new Effects({
    store,
    health,
    now: nowMs,
    paused: () => paused.paused(),
    slots: () => {
      const counts = store.assignmentCounts()
      return Math.max(0, executorSettings.maxWorkers - counts.running)
    }
  })
  const outbox = createOutbox({ store, effects, now })
  // ---- Policy（§K.1、§K.2）：块从宿主设置里解析；Source 的 Policy 部分与准入行由 kind 认领。
  // 校验失败时回落缺省块并记日志——授权面 fail closed（谁都不准入），错误由面板的设置页显示。
  const policyKind = (source: string): PolicyKindView | undefined => {
    const part = registry.kind(source)?.policy
    if (part === undefined) return undefined
    const config = registry.instance(source, sourceSettings)?.config ?? {}
    return {
      rows: () => part.rows?.(config) ?? [],
      extras: (section) => part.schema.safeParse(section)
    }
  }
  const policyRaw = block(settings['policy'])
  const parsedPolicy = validatePolicy(policyRaw, { kinds: policyKind })
  if (!parsedPolicy.success) {
    logger.warn('the stored policy block is invalid; refusing every candidate until it is fixed', {
      issues: parsedPolicy.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    })
  }
  const policyBlock = parsedPolicy.success ? parsedPolicy.data : DEFAULT_POLICY
  const policy = createPolicy({
    block: () => policyBlock,
    sources: registry,
    rows: (source) => policyKind(source)?.rows() ?? [],
    version: () => UNVERSIONED_POLICY,
    paused: () => paused.paused()
  })

  // ---- Router（§F.1–§F.5）：专用 worktree、terminal 面的常驻会话、relay 与保活监督
  const roles = resolveRoles(settings)
  const deploymentFacts = deployment(settings, { ...githubSetup, login: githubLogin() }, feishuSetup)
  // setup 未完成（或没选 base repo）时 Router 保持 paused；`setup check` 之后会重新问这个函数。
  const routerEnabled = (): boolean => !setup.blocked('executor') && executorSettings.baseRepo !== undefined
  const relayDays = relayRetentionDays(settings)
  const routerSupervision = createRouterSupervision({
    runtime: options.runtime,
    health: board,
    state: routerStateStore(store),
    notice: {
      // `notice` 与 relay 共用 Router 终端与同一条 FIFO 队列（§J.2 末注）。
      enqueue: (summary) => effects.enqueue('notice', ROUTER_EFFECT_KEY, { summary })
    },
    settings: {
      agent: roles.router.agent,
      ...(roles.router.model === undefined ? {} : { model: roles.router.model }),
      ...(roles.router.effort === undefined ? {} : { effort: roles.router.effort }),
      ...(executorSettings.baseRepo === undefined ? {} : { baseRepo: executorSettings.baseRepo }),
      ...(executorSettings.baseBranch === undefined ? {} : { baseBranch: executorSettings.baseBranch }),
      repository: deploymentFacts.repository,
      acceptMode: acceptModeOf(settings),
      policyVersion: policy.version
    },
    cliPath: options.cliPath ?? defaultCliPath(),
    stateDir: resolved,
    rotateToken: () => issueRouterToken({ store, stateDir: resolved }).path,
    promptRevision: promptRevisionOf(store),
    enabled: routerEnabled,
    // §F.3 的可观测事实：疑似空转时给出「N 个未决候选」（待评的 Thread）。
    undecidedCandidates: () => repo.threads.list().filter((thread) => thread.pending.length > 0).length,
    now: nowMs,
    ...(options.disableTimers === true
      ? {}
      : {
          schedule: (run: () => void, milliseconds: number) => setTimeout(run, milliseconds),
          cancel: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)
        }),
    log: (message) => logger.info(message)
  })
  const routerRelay = createRouterRelay({
    runtime: options.runtime,
    stateDir: resolved,
    terminal: () => routerSupervision.terminalId(),
    // 队列行的 `seq` 是持久的单调序号：正文文件名与消息编号都用它，重启不重号（§F.2）。
    sequence: (kind) => store.effects.get(kind, ROUTER_EFFECT_KEY)?.seq ?? null,
    now: nowMs,
    retentionDays: relayDays,
    log: (message) => logger.info(message)
  })
  const relayHandlers = routerRelay.handlers()
  effects.handle('relay', relayHandlers.relay)
  effects.handle('notice', relayHandlers.notice)
  routerRelay.prune()

  const assessor = createDeterministicAssessor({
    decide: (triggerId, outcome) => engine.decide(triggerId, outcome),
    onError: (error, evalId) => logger.warn(`the assessment of ${evalId} could not be decided`, { error: stringOf(error) })
  })
  const executor = new OrcaExecutor({ effects, runtime: options.runtime, log: (message) => logger.info(message) })
  const engine = new Engine({
    repo,
    scope: registry,
    policy: () => policy,
    assessor,
    executor,
    outbox,
    now,
    prepareTicket: (ticket, outcome) => {
      const name = outcome.name
      return name === undefined
        ? ticket
        : { ...ticket, execution: { name, directory: '', assignment: '' } }
    },
    emit: (event) => {
      if (event.type === 'assignment.started') {
        scheduleRefresh()
      }
      // 新 Decision 落库即「不再疑似空转」（§F.3 的可观测事实，不是拦截）。
      if (event.type === 'decision.recorded') routerSupervision.noteDecision()
    }
  })
  let refreshQueued = false
  const scheduleRefresh = (): void => {
    if (refreshQueued) return
    refreshQueued = true
    queueMicrotask(() => {
      refreshQueued = false
      refresh()
    })
  }

  const deliveryWait = async (milliseconds: number): Promise<void> => {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
  }
  const lifecycle = registerExecutorLifecycle({
    runtime: options.runtime,
    engine,
    records: repo,
    now: nowMs,
    log: (message) => logger.info(message)
  })
  registerExecutorEffects({
    runtime: options.runtime,
    effects,
    engine,
    records: repo,
    settings: executorSettings,
    stateDir: resolved,
    cliPath: options.cliPath ?? defaultCliPath(),
    tokenFile: (assignmentId) => assignmentTokenFile(store, resolved, assignmentId),
    apiBase: '',
    wait: deliveryWait,
    log: (message) => logger.info(message)
  })
  registerReplyEffects({
    effects,
    outbox,
    channel: {
      send: (message) => registry.send(message, (options.commands ?? new Commands()).withSignal())
    },
    now,
    log: (message) => logger.info(message)
  })

  // ---- 读模型 / 状态栏 / 面板
  const stateSource: RefreshableStateSource = createRefreshableStateSource({
    tickets: () => repo.tickets.list(),
    activity: () => activityCounts(store, nowMs()),
    load: () => {
      const counts = store.assignmentCounts()
      return { running: counts.running, maxWorkers: executorSettings.maxWorkers }
    },
    hasError: () => Object.values(board.all()).some((entry) => entry.state === 'error'),
    setupMissing: () => setup.missing(),
    paused: () => paused.paused()
  })

  function refresh(): PanelState {
    const next = stateSource.refresh()
    options.panels?.post('state.changed', { revision: next.revision })
    options.statusBar?.publish(statusBarView(next))
    return next
  }
  options.statusBar?.publish(statusBarView(stateSource.snapshot()))

  /**
   * `superagent setup check`（§G.2）：重跑探针、把新结论应用到各部分，并重新武装被挂起的循环。
   * 不重启 Orca、不重建库、不动 worker 终端（§N.1）。本来就没有问题时拒绝空跑（返回
   * `checked: false`，由 HTTP handler 折成固定拒绝）。
   *
   * 用的是本进程启动时读到的设置：Orca Settings 里的改动仍要重启 worker 才生效（§N.2 只对
   * 面板里的设置承诺即时生效）；人修好的外部条件（`gh auth login`、在 Orca 里加仓库）当场可见。
   */
  const checkSetup = async (): Promise<SetupCheckOutcome> => {
    if (!setup.missing()) {
      return { checked: false, problem: null, issues: [], restarted: false }
    }
    const githubWasBlocked = githubBlocked()
    const routerWasEnabled = routerEnabled()
    const report = await runSetupChecks(setupInput())
    applySetup(report)
    refresh()
    // 刚解锁的循环从现在开始干活：Source 轮询下一轮就发请求，Router 监督真的建会话。
    const routerArmed = !routerWasEnabled && routerEnabled()
    if (routerArmed) await routerSupervision.start()
    // 轮询器只在配置完整时才存在；配置缺项不是探针重跑能修的（设置是启动时读的），
    // 所以这里的「重新武装」只看 gate 是否打开。
    const githubArmed = githubWasBlocked && !githubBlocked()
    return {
      checked: true,
      problem: setup.problem(),
      issues: report.issues,
      restarted: routerArmed || githubArmed
    }
  }

  // ---- 命令面（HTTP + CLI 共用同一份 handler）
  const domain = createDomainHandlers({
    report: (ticketId, report) => engine.report(ticketId, report),
    reply: (request) => engine.reply(request),
    ticketOf: (id) => repo.tickets.get(id),
    tickets: () => repo.tickets.list(),
    afterWrite: () => {
      refresh()
    }
  })
  const routes: readonly RouteDefinition[] = withDomainHandlers(ROUTE_TABLE, domain)

  ensureApiToken(resolved)
  const http: HttpServerHandle = await startHttpServer({
    stateDir: resolved,
    routes,
    preferredPort: options.preferredPort ?? 0,
    host: {
      store,
      stateDir: resolved,
      startedAt: now(),
      health: () =>
        Object.fromEntries(
          Object.entries(board.all()).map(([name, entry]) => [name, { ...entry, at: now() }])
        ),
      setup: () => ({ problem: setup.problem() }),
      paused: () => paused.paused(),
      loops: () =>
        loopEntries(
          board,
          (githubSetup.enabled && !githubBlocked()) ||
            (feishuSetup.enabled && feishuProblem() === undefined)
        ),
      maxWorkers: () => executorSettings.maxWorkers,
      cliPath: options.cliPath ?? defaultCliPath()
    },
    // doctor 与 `setup check` 走同一份 handler（§G.2「同一批 handler」）。
    ops: {
      run: (program, args) => commandPort.run(program, args),
      cliPath: options.cliPath ?? defaultCliPath(),
      setupCheck: () => checkSetup()
    },
    log: (line) => logger.info('http request', { method: line.method, path: line.path, status: line.status, ms: line.ms })
  })

  // ---- 启动恢复（§E.10）：版本升级不认领旧会话，走同一条重建路径（§N.6）。
  const version = notePluginVersion(store, { now: () => new Date(nowMs()), log: logger.sink })
  let resumeReport: ResumeReport | null = null
  try {
    resumeReport = version.upgraded
      ? await resumeAfterUpgrade({ runtime: options.runtime, engine, records: repo, log: (message) => logger.info(message) })
      : await lifecycle.resume()
    logger.key(`resumed ${resumeReport.assignments.length} assignment(s)`, {
      upgraded: version.upgraded ? 1 : 0
    })
  } catch (error) {
    logger.error('startup resume failed', { error: stringOf(error) })
  }

  // ---- Router：认回活着的会话，否则建 worktree 并 launch（不等它的一轮，§F.3）
  try {
    await routerSupervision.start()
  } catch (error) {
    logger.error('the router supervision could not start', { error: stringOf(error) })
  }

  // ---- Source 轮询（§I.2）：只有 setup 完成且实例启用时才启动
  // 轮询器只要**配置**完整就建：setup 问题（账号读不到等）由 `pollOnce` 的门挡住，
  // 于是 `setup check` 把它们修好之后，下一轮轮询就真的开始了——不必重启 Orca（§N.1）。
  const poller: GithubPoller | null =
    githubSetup.enabled && githubInstance.repository !== '' && githubInstance.cli !== ''
      ? createGithubPoller({
          api: createGithubApi(
            (options.commands ?? new Commands()).withSignal(),
            String(githubSetup.config['cli'] ?? 'gh')
          ),
          config: {
            repository: String(githubSetup.config['repository'] ?? ''),
            cli: String(githubSetup.config['cli'] ?? 'gh'),
            pollSeconds: Number(githubSetup.config['pollSeconds'] ?? 60),
            observeIssues: githubSetup.config['observeIssues'] === true,
            observePulls: githubSetup.config['observePulls'] === true,
            observeComments: githubSetup.config['observeComments'] === true,
            observeCi: githubSetup.config['observeCi'] === true
          },
          login: deployment(settings, { ...githubSetup, login: githubLogin() }, feishuSetup).githubLogin,
          // 订阅 Thread 由组合根从 Thread/Ticket 行算出（轮询器自己不读库，§C.2）。
          subscribed: () => subscribedThreads(repo.threads.list(), repo.tickets.list()),
          now: nowMs,
          // 游标键的命名留在 `app/kv.ts`（§D.3）：Source 只拿到构造函数。
          cursorKey: githubCursorKey,
          host: createSourceContext({
            engine,
            store,
            commands: (options.commands ?? new Commands()).withSignal(),
            instance: {
              id: GITHUB_KIND,
              enabled: githubSetup.enabled,
              config: githubSetup.config,
              health: Object.fromEntries(registry.healthEntries(['github'])),
              ...(githubProblem() === undefined ? {} : { problem: githubProblem() })
            },
            configured: () => !githubBlocked(),
            triggerOf: (id) => repo.triggers.get(id),
            notify: (input) => options.notify?.(input)
          }),
          log: (message) => logger.info(message)
        })
      : null

  // ---- Feishu 读侧（§I.3）：事件流长驻，回填/话题/群名每 60 s 一轮（测试手动推）
  const feishuInstance = registry.instance(FEISHU_KIND)
  const feishuDeployment = deployment(settings, githubSetup, feishuSetup)
  const feishuCommands = (options.commands ?? new Commands()).withSignal()
  const feishuKeys: FeishuKeys = {
    chats: feishuChatsKey,
    labels: sourceLabelsKey(FEISHU_KIND),
    cursor: feishuCursorKey,
    topics: feishuTopicsKey,
    seen: threadSeenKey
  }
  // 配置由注册表校验过；这里再按 schema 解一次，只为拿到带默认值的类型化值。
  const feishuConfig: FeishuConfig = feishuConfigSchema.parse(
    feishuInstance === undefined || feishuInstance.configError !== undefined
      ? {}
      : feishuInstance.config
  )
  const feishuApi = createFeishuApi(feishuCommands, feishuConfig.cli)
  // setup 完成、实例启用、配置有效、机器人身份读到了：四件齐了才读（§I.3 配置行）。
  const feishuReady =
    feishuProblem() === undefined &&
    feishuSetup.enabled &&
    feishuInstance !== undefined &&
    feishuInstance.enabled &&
    feishuInstance.configError === undefined &&
    feishuDeployment.feishuBotId.length > 0
  const feishuHost = createSourceContext({
    engine,
    store,
    commands: feishuCommands,
    instance: {
      id: FEISHU_KIND,
      enabled: feishuReady,
      config: feishuConfig,
      health: Object.fromEntries(registry.healthEntries(['feishu', 'history']))
    },
    // 每个 Source 只看自己的 setup 问题（Feishu 缺配置不代表 GitHub 不能用）。
    configured: () => feishuProblem() === undefined,
    triggerOf: (id) => repo.triggers.get(id),
    notify: (input) => options.notify?.(input)
  })
  const feishuAbort = new AbortController()
  const feishuBot = { botId: feishuDeployment.feishuBotId, appId: feishuDeployment.feishuAppId }
  // 事件流：禁用（关停）后看门狗 5 s 内停掉子进程（§I.3）。
  const feishuStream: FeishuStream | null = feishuReady
    ? createFeishuStream({
        commands: feishuCommands,
        cli: feishuConfig.cli,
        bot: feishuBot,
        host: feishuHost,
        keys: feishuKeys,
        enabled: () => !closing,
        signal: feishuAbort.signal,
        now: nowMs,
        schedule: (run, milliseconds) => {
          const timer = setTimeout(run, milliseconds)
          return () => clearTimeout(timer)
        },
        log: (message) => logger.info(message)
      })
    : null
  const feishuBackfill: FeishuBackfill | null =
    feishuStream === null
      ? null
      : createFeishuBackfill({
          api: feishuApi,
          bot: feishuBot,
          config: feishuConfig,
          host: feishuHost,
          keys: feishuKeys,
          now: nowMs,
          signal: feishuAbort.signal,
          log: (message) => logger.info(message),
          // 水位线要的两个只读面：订阅了 Feishu 的 Thread 与 Ticket 的结束时刻（§I.3 话题轮询）。
          subscribed: () =>
            repo.threads
              .list()
              .filter((thread) => thread.ref.source === FEISHU_KIND)
              .map((thread) => ({
                ref: thread.ref,
                ...(thread.lastAt === undefined ? {} : { lastAt: thread.lastAt }),
                subscriptions: thread.subscriptions,
                meta: thread.meta
              })),
          ticket: (id) => repo.tickets.get(id)
        })

  // ---- passes：先做 effect，再评估，再把确定性评估的决定落库
  const passes = createPasses({
    effects,
    engine: {
      evaluateDue: () => {
        engine.evaluateDue()
        assessor.drain()
      }
    },
    health: board,
    schedule: (run, milliseconds) => setTimeout(run, milliseconds),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    closing: () => closing,
    ...(options.passIntervalMs === undefined ? {} : { intervalMs: options.passIntervalMs })
  })
  effects.start()

  const pollOnce = async (): Promise<GithubPollResult> => {
    // setup 未完成：循环在跑，但一轮都不读（Source 停在 setup/starting，不是 error）。
    if (poller === null || githubBlocked()) return { notifications: 0, triggers: 0, skipped: 0 }
    const result = await poller.poll()
    refresh()
    return result
  }
  /** 群名刷新失败不挡回填：上一次的名单原样保留（§I.3 群名刷新行）。 */
  const refreshFeishuNames = async (): Promise<void> => {
    if (feishuBackfill === null) return
    try {
      await refreshChatNames({ api: feishuApi, host: feishuHost, keys: feishuKeys, signal: feishuAbort.signal })
    } catch (error) {
      logger.warn(`the Feishu chat names could not be read: ${stringOf(error)}`)
    }
  }
  const feishuOnce = async (): Promise<FeishuRoundResult | null> => {
    if (feishuBackfill === null) return null
    await refreshFeishuNames()
    const result = await feishuBackfill.round()
    refresh()
    return result
  }
  const passOnce = async (): Promise<void> => {
    passes.request()
    await passes.idle()
    await lifecycle.background.poll()
    refresh()
  }

  // ---- 定时器（§N.1 的 2 s pass 与 pollSeconds 轮询）：关停时一并清掉
  let closing = false
  const timers: ReturnType<typeof setInterval>[] = []
  if (options.disableTimers !== true) {
    const passTimer = setInterval(() => {
      void passOnce()
    }, options.passIntervalMs ?? PASS_INTERVAL_MS)
    timers.push(passTimer)
    const pollMs =
      options.pollIntervalMs ?? Math.max(10_000, Number(githubSetup.config['pollSeconds'] ?? 60) * 1000)
    if (poller !== null) {
      const pollTimer = setInterval(() => {
        void pollOnce()
      }, pollMs)
      timers.push(pollTimer)
    }
    if (feishuBackfill !== null) {
      // 第一轮立刻跑一次（安装完就能补上安装前一刻之后的），之后每分钟一轮。
      void feishuOnce()
      const feishuTimer = setInterval(() => {
        void feishuOnce()
      }, FEISHU_ROUND_MS)
      timers.push(feishuTimer)
    }
    for (const timer of timers) timer.unref?.()
  }
  // 事件流不靠定时器：配置好了就长驻监听（§I.3 实时事件）。
  const streaming = feishuStream === null ? null : feishuStream.run()
  refresh()

  let closed = false
  const shutdown = async (): Promise<void> => {
    if (closed) return
    closed = true
    closing = true
    // 监督先停：关停期间不再发现「终端没了」并去 launch 新会话。
    routerSupervision.stop()
    for (const timer of timers) clearInterval(timer)
    // 先关事件流：看门狗与 abort 都会停子进程，再等循环真的收尾（§I.3「5 s 内停」）。
    feishuAbort.abort()
    if (streaming !== null) await streaming
    options.statusBar?.dispose()
    await passes.stop()
    await effects.drain()
    http.close()
    store.close()
    lock.release()
    logger.key('superagent worker stopped')
    runtimeHealth.set({ state: 'paused', detail: 'stopped' })
  }

  const ready = Promise.resolve()
  return {
    mode: 'leader',
    stateDir: resolved,
    ready,
    snapshot: () => stateSource.snapshot(),
    pollOnce,
    feishuOnce,
    passOnce,
    port: () => http.port,
    resumeReport: () => resumeReport,
    // Router 的事件先过监督（空转观测），再由执行器映射到 Ticket（两者各认各的终端）。
    onAgentStatus: async (event) => {
      await routerSupervision.onAgentStatus(event)
      await lifecycle.status(event)
    },
    routerTick: () => routerSupervision.tick(),
    routerStatus: () => routerSupervision.snapshot(),
    restartRouter: () => routerSupervision.restart('requested by the operator'),
    notifyPromptRevision: (revision: number) => routerSupervision.notifyPromptRevision(revision),
    refresh,
    setPaused: (value: boolean): PanelState => {
      paused.setPaused(value, now(), 'operator')
      return refresh()
    },
    checkSetup,
    shutdown
  }
}

/** 空快照（follower 模式：本进程不读库，也不假装有读数）。 */
function emptySnapshot(): PanelState {
  return {
    revision: 0,
    booted: false,
    health: {
      error: false,
      paused: false,
      setupMissing: true,
      activity: { received: 0, evaluated: 0, accepted: 0, ignored: 0, ended: 0 },
      executor: { running: 0, maxWorkers: DEFAULT_MAX_WORKERS }
    },
    attention: { answer: 0, review: 0, problems: 0, items: [] },
    tickets: []
  }
}

/** follower 模式的 Router 快照：本进程不监督，也不假装有读数。 */
function emptyRouterSnapshot(): RouterSnapshot {
  return {
    state: 'paused',
    detail: 'this process follows another instance',
    terminalId: null,
    workspaceId: null,
    directory: null,
    startedAt: null,
    promptRevision: null,
    currentRevision: 0,
    restarts: 0,
    lastError: null,
    nextAttemptAt: null,
    idle: { suspected: false, waits: 0, since: null },
    undecidedCandidates: 0,
    orphaned: null,
    agentState: null
  }
}

/** `kv` 上的 Router 快照读写（键的命名只在 `app/kv.ts`，§D.3）。 */
function routerStateStore(store: Store): RouterStateStore {
  return {
    terminal: () => store.kvGet<RouterTerminalState>(ROUTER_TERMINAL_KEY),
    saveTerminal: (value) => {
      if (value === null) store.kvDelete(ROUTER_TERMINAL_KEY)
      else store.kvSet(ROUTER_TERMINAL_KEY, value)
    },
    workspace: () => store.kvGet<RouterWorkspaceState>(ROUTER_WORKSPACE_KEY),
    saveWorkspace: (value) => store.kvSet(ROUTER_WORKSPACE_KEY, value),
    restarts: () => store.kvGet<RouterRestartState>(ROUTER_RESTARTS_KEY),
    saveRestarts: (value) => store.kvSet(ROUTER_RESTARTS_KEY, value)
  }
}

/** `policy.acceptMode` 的三档；缺省 observe（§K.4、规格 000 的缺省）。 */
function acceptModeOf(settings: Readonly<Record<string, unknown>>): 'off' | 'observe' | 'auto' {
  const mode = block(settings['policy'])['acceptMode']
  return mode === 'off' || mode === 'auto' ? mode : 'observe'
}

/** `retention.relayDays`（§F.2 缺省 7 天）：正整数才生效。 */
function relayRetentionDays(settings: Readonly<Record<string, unknown>>): number {
  const days = block(settings['retention'])['relayDays']
  return typeof days === 'number' && Number.isInteger(days) && days > 0 ? days : 7
}

/** 当前的 prompt revision（`kv['prompt-revision']`；#32/#33 才写它，之前是 0）。 */
function promptRevisionOf(store: Store): number {
  const revision = store.kvGet<unknown>(PROMPT_REVISION_KEY)
  return typeof revision === 'number' && Number.isInteger(revision) && revision >= 0 ? revision : 0
}

/** 一条错误的一行文本。 */
function stringOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 24 h 流水（§M.2 ③）：四条计数都在读模型里，不另写一套「什么算收到」。 */
function activityCounts(
  store: Store,
  nowMs: number
): { received: number; evaluated: number; accepted: number; ignored: number; ended: number } {
  const cutoff = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString()
  const count = (sql: string, params: readonly string[]): number => {
    const row = store.sql.all(sql, params)[0]
    if (typeof row !== 'object' || row === null) return 0
    return Number((row as Record<string, unknown>)['n'] ?? 0)
  }
  return {
    received: count('SELECT COUNT(*) AS n FROM trigger WHERE at >= ?', [cutoff]),
    evaluated: count('SELECT COUNT(*) AS n FROM decision WHERE at >= ?', [cutoff]),
    accepted: count("SELECT COUNT(*) AS n FROM decision WHERE kind = 'accept' AND at >= ?", [cutoff]),
    ignored: count("SELECT COUNT(*) AS n FROM decision WHERE kind = 'ignore' AND at >= ?", [cutoff]),
    ended: count("SELECT COUNT(*) AS n FROM ticket WHERE json_extract(body, '$.ended.at') >= ?", [cutoff])
  }
}

/** 状态视图的 `loops` 段：passes/effects 的 health 条目各占一行 + Source 与状态栏。 */
function loopEntries(board: HealthBoard, polling: boolean): LoopEntry[] {
  const entries = board.all()
  const rows: LoopEntry[] = []
  for (const [name, entry] of Object.entries(entries)) {
    if (['runtime', 'github'].includes(name)) continue
    rows.push({ name, state: entry.state })
  }
  rows.push({ name: 'sources', state: polling ? 'ready' : 'paused' })
  rows.push({ name: 'statusbar', state: 'ready' })
  return rows
}

/** 一个 Assignment 的 token 文件：首次调用时签发（`tokens/<assignmentId>`，0600）。 */
function assignmentTokenFile(store: Store, stateDir: string, assignmentId: string): string {
  const ticket = store.sql
    .all('SELECT id, body FROM ticket')
    .find((row) => {
      if (typeof row !== 'object' || row === null) return false
      const body = (row as Record<string, unknown>)['body']
      if (typeof body !== 'string') return false
      try {
        const parsed: unknown = JSON.parse(body)
        if (typeof parsed !== 'object' || parsed === null) return false
        const assignments = (parsed as { assignments?: unknown }).assignments
        return (
          Array.isArray(assignments) &&
          assignments.some((item) => (item as { id?: unknown } | null)?.id === assignmentId)
        )
      } catch {
        return false
      }
    })
  const ticketId = typeof ticket === 'object' && ticket !== null ? String((ticket as { id?: unknown }).id) : ''
  const issued = issueAssignmentToken({
    store,
    stateDir,
    ticketId,
    assignmentId,
    expiresAt: '2099-01-01T00:00:00.000Z'
  })
  return issued.path
}


/** GitHub 实例的配置（§I.2 配置行）：只解析，不碰子进程。 */
interface GithubInstance {
  readonly enabled: boolean
  readonly repository: string
  readonly cli: string
  readonly config: Record<string, unknown>
}

/**
 * 解析 GitHub 实例的配置（§I.2）。两处回落是刻意的：
 * - `repository`：Source 配置优先，其次是清单级的同名设置；
 * - `cli`：**只有完全没写**才回落到 `gh`；显式写成空串是「没配」，不能静默换回默认值。
 */
function githubInstanceOf(input: {
  readonly raw: Readonly<Record<string, unknown>>
  readonly stored: Record<string, unknown>
}): GithubInstance {
  const config = block(input.stored['config'])
  const enabled = flag(input.stored['enabled'], true)
  const repository = text(config['repository']) ?? text(input.raw['repository']) ?? ''
  const storedCli = config['cli']
  const cli =
    storedCli === undefined
      ? text(input.raw['githubCli']) ?? 'gh'
      : typeof storedCli === 'string' && storedCli.trim() === ''
        ? ''
        : text(storedCli) ?? ''
  return { enabled, repository, cli, config: { ...config, repository, cli } }
}

/**
 * 配置了 Feishu 时的 CLI（§I.3）：没配这个 Source 就是 `undefined`（不查 lark-cli）；
 * 启用了但 CLI 空着是空串——那是一条 setup 问题（「配置了但缺 CLI」），不是「没配置」。
 */
function feishuCliOf(rawSources: Record<string, unknown>): string | undefined {
  const stored = block(rawSources['feishu'])
  if (flag(stored['enabled'], false) === false) return undefined
  return text(block(stored['config'])['cli']) ?? ''
}

/**
 * Feishu 实例的配置与 setup 问题（§I.3 配置行）：`cli` 或机器人身份缺失就不读也不听。
 * `botId` 是 open_id（自己消息的丢弃与「点名了机器人」都靠它）；未就绪时是空串。
 */
interface FeishuSetup {
  readonly enabled: boolean
  readonly config: Record<string, unknown>
  readonly cli: string
  readonly botId: string
  readonly appId: string
  readonly problem?: { readonly place: string; readonly code: string; readonly detail?: string }
}

/** 部署派生的事实（§E.11 的变量源）：仓库与账号来自设置与 setup 探针。 */
function deployment(
  settings: Readonly<Record<string, unknown>>,
  github: GithubSetup,
  feishu: FeishuSetup
): Deployment {
  return {
    repository: String(github.config['repository'] ?? ''),
    githubCli: String(github.config['cli'] ?? 'gh'),
    githubLogin: github.login || text(settings['githubLogin']) || '',
    githubCommitEmail: text(settings['githubCommitEmail']) ?? '',
    feishuCli: feishu.cli,
    feishuBotId: feishu.botId,
    feishuAppId: feishu.appId
  }
}
/** 一段文本里的 JSON 对象（`lark-cli` 会在 JSON 前打提示行，从第一个 `{` 开始解析）。 */
function jsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  try {
    const parsed: unknown = JSON.parse(text.slice(start))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Feishu 的 setup 探针（§I.3 配置行、§I.4）：缺 `cli` → `cli_missing`；`auth status` 说机器人
 * 身份没就绪 → `bot_not_ready`；`bot/v3/info` 读不到 open_id → `bot_unreadable`。任一都让
 * Source 进 setup 态：不读回填、不消费事件（§I.3）。
 *
 * 没存过实例时 `enabled` 是 false（与 GitHub 的默认相反）：Feishu 是可选的，没配置它就不该
 * 把整个插件标成「等 setup」。拒绝可充当用户身份的配置（strict-mode）归 setup 票 #44。
 */
async function setupFeishu(input: {
  readonly raw: Readonly<Record<string, unknown>>
  readonly stored: Record<string, unknown>
  readonly commands: CommandsHost
  readonly log: (message: string) => void
}): Promise<FeishuSetup> {
  const config = block(input.stored['config'])
  const enabled = flag(input.stored['enabled'], false)
  const cli = text(config['cli']) ?? text(input.raw['feishuCli']) ?? ''
  const merged = { ...config, cli }
  if (cli === '') {
    return {
      enabled,
      config: merged,
      cli,
      botId: '',
      appId: '',
      ...(enabled ? { problem: { place: FEISHU_KIND, code: 'cli_missing' } } : {})
    }
  }
  if (!enabled) return { enabled, config: merged, cli, botId: '', appId: '' }
  try {
    const status = jsonObject(await input.commands.run(cli, ['auth', 'status']))
    const appId = typeof status?.['appId'] === 'string' ? status['appId'] : ''
    const identities = status?.['identities']
    const bot =
      typeof identities === 'object' && identities !== null
        ? (identities as Record<string, unknown>)['bot']
        : undefined
    const botStatus =
      typeof bot === 'object' && bot !== null
        ? (bot as Record<string, unknown>)['status']
        : undefined
    if (!/^cli_[A-Za-z0-9]+$/.test(appId) || botStatus !== 'ready') {
      return {
        enabled,
        config: merged,
        cli,
        botId: '',
        appId,
        problem: { place: FEISHU_KIND, code: 'bot_not_ready' }
      }
    }
    const info = jsonObject(
      await input.commands.run(cli, ['api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot'])
    )
    const botRow = info?.['bot']
    const botId =
      typeof botRow === 'object' && botRow !== null
        ? (botRow as Record<string, unknown>)['open_id']
        : undefined
    if (typeof botId !== 'string' || !/^ou_[A-Za-z0-9]+$/.test(botId)) {
      return {
        enabled,
        config: merged,
        cli,
        botId: '',
        appId,
        problem: { place: FEISHU_KIND, code: 'bot_unreadable' }
      }
    }
    return { enabled, config: merged, cli, botId, appId }
  } catch (error) {
    input.log(`the Feishu CLI could not read its bot identity: ${stringOf(error)}`)
    return {
      enabled,
      config: merged,
      cli,
      botId: '',
      appId: '',
      problem: { place: FEISHU_KIND, code: 'bot_unreadable', detail: stringOf(error) }
    }
  }
}

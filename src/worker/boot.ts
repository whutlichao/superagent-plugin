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
import { HealthBoard } from './infra/health.ts'
import { defaultStateDir, resolveStateDir, writeStateDirPointer } from './infra/paths.ts'
import { ensureApiToken, issueAssignmentToken } from './infra/tokens.ts'
import { createRepositories } from './app/repositories.ts'
import { createMinimalPolicy } from './app/policy.ts'
import { createDeterministicAssessor } from './app/assessor.ts'
import { createOutbox, registerReplyEffects } from './app/outbox.ts'
import { createPausedState } from './app/pause.ts'
import { githubCursorKey } from './app/kv.ts'
import { createRefreshableStateSource, type RefreshableStateSource } from './app/state-source.ts'
import { statusBarView } from './app/status-bar.ts'
import type { StatusBarView } from './app/status-bar.ts'
import { Effects } from './app/effects.ts'
import { createPasses } from './app/passes.ts'
import { notePluginVersion } from './app/upgrade.ts'
import { createSourceContext } from './app/source-context.ts'
import { SourceRegistry, type SourceSettingsView } from './sources/registry.ts'
import { Commands, type CommandsHost } from './sources/commands.ts'
import { createGithubApi, createGithubKind, createGithubPoller, GITHUB_KIND } from './sources/github/index.ts'
import type { GithubPollResult, GithubPoller } from './sources/github/index.ts'
import type { Deployment } from './sources/kind.ts'
import { OrcaExecutor, registerExecutorEffects, registerExecutorLifecycle, resolveExecutorSettings } from './executor/orca-executor.ts'
import { resumeAfterUpgrade, type ResumeReport } from './executor/resume.ts'
import { DEFAULT_MAX_WORKERS } from './http/state.ts'
import { createDomainHandlers, withDomainHandlers } from './http/domain.ts'
import { ROUTE_TABLE, type RouteDefinition } from './http/routes.ts'
import type { LoopEntry } from './http/state.ts'
import { startHttpServer, type HttpServerHandle } from './http/server.ts'
import type { AgentStatusEvent, OrcaRuntime } from './runtime/orca-runtime.ts'

/** worker 侧一轮 pass 的周期（§N.1 的 2 s 巡检）。 */
export const PASS_INTERVAL_MS = 2000

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
  /** 一轮 pass（先到期的 effect，再到期评估与评估决定）。 */
  passOnce(): Promise<void>
  /** 实际监听的端口；follower/未监听时 `null`。 */
  port(): number | null
  /** 启动恢复做了什么（`resume`/`resumeAfterUpgrade` 的读数）。 */
  resumeReport(): ResumeReport | null
  /** `agent.status.changed` 的四态映射（main 把宿主事件转进来）。 */
  onAgentStatus(event: AgentStatusEvent): Promise<void>
  /** 暂停写后的快照刷新（面板 `pause` 请求用）。 */
  refresh(): PanelState
  /** 写暂停状态（唯一写者是 `app/pause.ts`）并刷新快照。 */
  setPaused(paused: boolean): PanelState
  shutdown(): Promise<void>
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
function settingsView(raw: Readonly<Record<string, unknown>>, enabled: boolean, config: Record<string, unknown>): SourceSettingsView {
  const policy = block(raw['policy'])
  return {
    sources: { [GITHUB_KIND]: { enabled, config } },
    policy: { sources: { [GITHUB_KIND]: block(block(policy['sources'])[GITHUB_KIND]) } }
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
      pollOnce: async () => ({ notifications: 0, triggers: 0 }),
      passOnce: async () => undefined,
      port: () => null,
      resumeReport: () => null,
      onAgentStatus: async () => undefined,
      refresh: () => emptySnapshot(),
      setPaused: () => emptySnapshot(),
      shutdown: async () => undefined
    }
    return follower
  }

  const lock = lockOutcome.lock
  const logger: Logger = createLogger({ stateDir: resolved, now: () => new Date(nowMs()), mirror: log })
  const store: Store = openStore({ stateDir: resolved, log: logger.sink })
  const board = new HealthBoard()
  const runtimeHealth = board.claim('runtime', { state: 'ready', detail: 'booted' })
  const paused = createPausedState(store, now)
  const repo = createRepositories(store)

  // ---- 设置与 setup 探针
  const executorSettings = resolveExecutorSettings(settings)
  const rawSources = block(settings['sources'])
  const githubStored = block(rawSources[GITHUB_KIND])
  const githubSetup = await setupGithub({
    raw: settings,
    stored: githubStored,
    commands: options.commands ?? new Commands({ configuredPrograms: () => [text(settings['githubCli'])] }),
    log: (message) => logger.info(message)
  })
  const sourceSettings: SourceSettingsView = settingsView(settings, githubSetup.enabled, githubSetup.config)
  const setupProblem = githubSetup.problem ?? undefined

  // ---- 注册表与 kind
  const registry = new SourceRegistry({ health: board, settings: () => sourceSettings })
  registry.register(createGithubKind(String(githubSetup.config['cli'] ?? 'gh')))
  if (githubSetup.problem !== undefined || !githubSetup.enabled) {
    registry.healthEntries(['github']).get('github')?.set({
      state: 'paused',
      detail: githubSetup.problem?.code ?? 'disabled'
    })
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
  const policy = createMinimalPolicy({
    part: (source) => {
      const part = registry.policyPart(source, sourceSettings)
      const allowed = part?.['allowed']
      return { allowed: Array.isArray(allowed) ? allowed.filter((item): item is string => typeof item === 'string') : [] }
    },
    paused: () => paused.paused()
  })
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
    setupMissing: () => setupProblem !== undefined,
    paused: () => paused.paused()
  })

  function refresh(): PanelState {
    const next = stateSource.refresh()
    options.panels?.post('state.changed', { revision: next.revision })
    options.statusBar?.publish(statusBarView(next))
    return next
  }
  options.statusBar?.publish(statusBarView(stateSource.snapshot()))

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
      setup: () => ({ problem: setupProblem ?? null }),
      paused: () => paused.paused(),
      loops: () => loopEntries(board, githubSetup.enabled && setupProblem === undefined),
      maxWorkers: () => executorSettings.maxWorkers,
      cliPath: options.cliPath ?? defaultCliPath()
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

  // ---- Source 轮询（§I.2）：只有 setup 完成且实例启用时才启动
  const poller: GithubPoller | null =
    setupProblem === undefined && githubSetup.enabled
      ? createGithubPoller({
          api: createGithubApi(
            (options.commands ?? new Commands()).withSignal(),
            String(githubSetup.config['cli'] ?? 'gh')
          ),
          config: {
            repository: String(githubSetup.config['repository'] ?? ''),
            cli: String(githubSetup.config['cli'] ?? 'gh'),
            pollSeconds: Number(githubSetup.config['pollSeconds'] ?? 60),
            observeComments: githubSetup.config['observeComments'] === true
          },
          login: deployment(settings, githubSetup).githubLogin,
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
              ...(githubSetup.problem === undefined ? {} : { problem: githubSetup.problem })
            },
            configured: () => setupProblem === undefined,
            triggerOf: (id) => repo.triggers.get(id),
            notify: (input) => options.notify?.(input)
          }),
          log: (message) => logger.info(message)
        })
      : null

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
    if (poller === null) return { notifications: 0, triggers: 0 }
    const result = await poller.poll()
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
    for (const timer of timers) timer.unref?.()
  }
  refresh()

  let closed = false
  const shutdown = async (): Promise<void> => {
    if (closed) return
    closed = true
    closing = true
    for (const timer of timers) clearInterval(timer)
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
    passOnce,
    port: () => http.port,
    resumeReport: () => resumeReport,
    onAgentStatus: (event) => lifecycle.status(event),
    refresh,
    setPaused: (value: boolean): PanelState => {
      paused.setPaused(value, now(), 'operator')
      return refresh()
    },
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

/** 部署派生的事实（§E.11 的变量源）：仓库与账号来自设置与 setup 探针。 */
function deployment(
  settings: Readonly<Record<string, unknown>>,
  github: GithubSetup
): Deployment {
  return {
    repository: String(github.config['repository'] ?? ''),
    githubCli: String(github.config['cli'] ?? 'gh'),
    githubLogin: github.login || text(settings['githubLogin']) || '',
    githubCommitEmail: text(settings['githubCommitEmail']) ?? '',
    feishuCli: '',
    feishuBotId: '',
    feishuAppId: ''
  }
}

/** GitHub 的 setup 探针（§I.4）：缺 repository/cli 就不轮询；`gh` 读不到账号也不轮询。 */
async function setupGithub(input: {
  readonly raw: Readonly<Record<string, unknown>>
  readonly stored: Record<string, unknown>
  readonly commands: CommandsHost
  readonly log: (message: string) => void
}): Promise<GithubSetup> {
  const config = block(input.stored['config'])
  const enabled = flag(input.stored['enabled'], true)
  const repository = text(config['repository']) ?? text(input.raw['repository']) ?? ''
  const cli = text(config['cli']) ?? text(input.raw['githubCli']) ?? 'gh'
  const merged = { ...config, repository, cli }
  if (repository === '') {
    return {
      enabled,
      config: merged,
      login: text(input.raw['githubLogin']) ?? '',
      problem: { place: GITHUB_KIND, code: 'repository_missing' }
    }
  }
  if (!enabled) return { enabled, config: merged, login: text(input.raw['githubLogin']) ?? '' }
  try {
    const login = (
      await input.commands.run(cli, ['api', 'user', '--jq', '.login'])
    ).trim()
    return { enabled, config: merged, login }
  } catch (error) {
    input.log(`the GitHub CLI could not read its account: ${stringOf(error)}`)
    return {
      enabled,
      config: merged,
      login: text(input.raw['githubLogin']) ?? '',
      problem: { place: GITHUB_KIND, code: 'account_unreadable', detail: stringOf(error) }
    }
  }
}


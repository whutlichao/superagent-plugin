// Router 的保活与重启（§F.1、§F.4、§F.5）：3 s 一跳的监督、退避 5 s→300 s、十分钟内五次
// 重启把 `router` 健康项标成 error、成功后十分钟清零，以及「prompt 版本变化只通知、不注入」。
//
// 判活只有一个真源：`listTerminals()` 的全机枚举（`agents.list()` 只投影当前聚焦工作区，
// 附录 C S2）。**终端不在或 `connected=false` 才算没了**；
// - `orphaned=true` 只表示「这个 pty 没有挂载到可见的 pane」，不是死亡。附录 C 的 #16 实测：
//   `orca agent launch --surface terminal` 起在没打开的 worktree 里的 agent 终端，
//   `connected=true, orphaned=true`，进程与 TUI 都活着。把 orphaned 当死亡会让 Router 每 3 s
//   重启一次（后台会话永远没有 pane）。
// - `agent.status.changed` 不判生死：同一份实测与 #12 的 S7 记录都说明 `done` 是**一轮结束**
//   （启动也会到达一条），不是进程结束。这里只用它做「疑似空转」的观测（working→waiting）。
//
// 本文件同时是 Router 快照（terminal/workspace/restarts）的唯一写者（§D.4 写者表）：快照经
// 注入的 `RouterStateStore` 落进 `kv`（键的命名在组合根的 `app/kv.ts`），重启插件时先按快照
// 认回仍在跑的会话，绝不因为一次插件重载就开出第二个 Router。
//
// 不等待：tick 只做一次 `listTerminals()` 与（必要时）一次 launch，从不等待 Router 的轮次、
// 不读终端输出、不轮询 agent 状态（§F.3）。
//
// 依赖纪律（§C.2）：本文件只 import `OrcaRuntime` 接口、领域健康类型与 `infra/health` 的
// 阈值常量；不 import `app/`、不 spawn、不 `host.call`。
import type {
  AgentHandle,
  AgentState,
  AgentStatusEvent,
  OrcaRuntime,
  RepoSelector,
  WorkspaceHandle
} from '../runtime/orca-runtime.ts'
import type { HealthEntry } from '../core/index.ts'
import { FAILURES_BEFORE_ERROR, type HealthBoardLike, type HealthEntryHandle } from '../infra/health.ts'
import { routerPrompt } from './prompt.ts'
import { ensureRouterWorkspace, launchRouter, type RouterLaunchSettings } from './router.ts'

/** 监督周期（§F.1 的 3 s tick）。 */
export const ROUTER_TICK_MS = 3000

/** 重启退避的起点与上限（§F.1、§F.5：5 s → 翻倍 → 300 s）。 */
export const RESTART_BACKOFF_START_MS = 5000
export const RESTART_BACKOFF_MAX_MS = 300_000

/** 十分钟内五次重启 → `router` 健康项报 error（§F.1）。 */
export const RESTART_ERROR_THRESHOLD = 5
export const RESTART_ERROR_WINDOW_MS = 10 * 60 * 1000

/** 「疑似空转」的窗口与次数（§F.3：5 分钟内反复 working→waiting）。 */
export const IDLE_WINDOW_MS = 5 * 60 * 1000
export const IDLE_TRANSITIONS = 3

/** 落进 `kv['router-terminal']` 的会话快照。 */
export interface RouterTerminalState {
  readonly terminalId: string
  readonly workspaceId: string
  /** 启动时刻（毫秒）。 */
  readonly launchedAt: number
  /** 这个会话的 prompt 里写着的 revision。 */
  readonly promptRevision: number
}

/** 落进 `kv['router-workspace']` 的工作区快照（重启后按路径认回）。 */
export interface RouterWorkspaceState {
  readonly workspaceId: string
  readonly path: string
}

/** 落进 `kv['router-restarts']` 的重启历史（ISO 时刻 + 最后一次错误）。 */
export interface RouterRestartState {
  readonly at: readonly string[]
  readonly lastError: string | null
}

/** Router 快照的持久化端口：组合根用 `app/kv.ts` 的四个键实现它。 */
export interface RouterStateStore {
  terminal(): RouterTerminalState | null
  saveTerminal(value: RouterTerminalState | null): void
  workspace(): RouterWorkspaceState | null
  saveWorkspace(value: RouterWorkspaceState): void
  restarts(): RouterRestartState | null
  saveRestarts(value: RouterRestartState): void
}

/** 通知端口：`notice` 与 relay 共用 Router 终端与同一条 FIFO 队列（§F.4）。 */
export interface RouterNoticePort {
  enqueue(summary: string): void
}

/** 监督需要的设置（Router 的角色设置 + 部署事实）。 */
export interface RouterSupervisionSettings extends RouterLaunchSettings {
  readonly baseRepo?: RepoSelector
  readonly baseBranch?: string
  readonly repository: string
  readonly acceptMode: 'off' | 'observe' | 'auto'
  readonly policyVersion: string
}

/** 监督的依赖：全部注入，监督自己不读时钟、不建定时器（§P.1）。 */
export interface RouterSupervisionOptions {
  readonly runtime: OrcaRuntime
  readonly health: HealthBoardLike
  readonly state: RouterStateStore
  readonly notice: RouterNoticePort
  readonly settings: RouterSupervisionSettings
  /** `superagent` CLI 的绝对路径（写进 launch prompt，§G.5）。 */
  readonly cliPath: string
  readonly stateDir: string
  /** 轮换并返回 Router token 文件路径（重启即轮换，§D.6）。 */
  readonly rotateToken: () => string
  /** 当前 prompt revision（launch prompt 里写明）。 */
  readonly promptRevision: number
  /** setup 是否就绪：未就绪时保持 paused，不建 worktree、不 launch（§N.1 同一口径）。 */
  readonly enabled: boolean
  /** 未决候选数（`thread.pending` 非空的 Thread 数）；缺省 0。 */
  readonly undecidedCandidates?: () => number
  readonly now?: () => number
  readonly schedule?: (run: () => void, milliseconds: number) => unknown
  readonly cancel?: (handle: unknown) => void
  readonly tickMs?: number
  readonly log?: (message: string) => void
}

/** 面板与 `status` 读的那份快照（§D.4「router 快照」；#47 的 Deployment 页用）。 */
export interface RouterSnapshot {
  readonly state: HealthEntry['state']
  readonly detail: string
  readonly terminalId: string | null
  readonly workspaceId: string | null
  readonly directory: string | null
  readonly startedAt: string | null
  /** 运行中的会话写进 prompt 的 revision；没有会话时是 `null`。 */
  readonly promptRevision: number | null
  /** 当前配置的 revision（角色层要重启才换上，§F.4）。 */
  readonly currentRevision: number
  /** 十分钟窗口内的自动重启次数。 */
  readonly restarts: number
  readonly lastError: string | null
  /** 下一次重试的时刻（ISO）；没有待重试时为 `null`。 */
  readonly nextAttemptAt: string | null
  readonly idle: {
    readonly suspected: boolean
    readonly waits: number
    readonly since: string | null
  }
  readonly undecidedCandidates: number
  /** 最近一次探活读到的 `orphaned`（pty 没有可见 pane）；没探过是 `null`。 */
  readonly orphaned: boolean | null
  /** 最近一条 `agent.status.changed` 的状态（`done` 是回合结束，§S7）。 */
  readonly agentState: AgentState | null
}

/** 保活器：启动/监督/重启，以及 prompt revision 的通知。 */
export interface RouterSupervision {
  /** 首次启动：认回活着的会话，否则建 worktree 并 launch；然后开始 3 s tick。 */
  start(): Promise<void>
  /** 一轮监督（定时器与测试共用）。 */
  tick(): Promise<void>
  /** 事件入口：只做观测（`working→waiting` 的疑似空转）；生死由 `listTerminals()` 判定。 */
  onAgentStatus(event: AgentStatusEvent): Promise<void>
  /** prompt 版本变化 → 一条 notice（不重启、不注入）。 */
  notifyPromptRevision(revision: number): void
  /** 一条新 Decision 落库：清掉「疑似空转」的证据（观测，不是拦截，§F.3）。 */
  noteDecision(): void
  /** 人显式要求重启（面板/命令）：关掉旧会话、清空重启窗口、立即换新会话。 */
  restart(reason: string): Promise<void>
  /** 当前终端句柄；没有可用会话时 `null`（relay 据此失败并重试）。 */
  terminalId(): string | null
  snapshot(): RouterSnapshot
  stop(): void
}

/** 一行可读的错误（健康 detail 用；截断到 200 字符）。 */
function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

/** 毫秒 → ISO（快照里给面板与日志读，不用 `new Date()` 的隐式本地时区）。 */
const iso = (milliseconds: number): string => new Date(milliseconds).toISOString()

/** prompt revision 变化的那一条通知（§F.4 的原文语义；relay/notice 共用一条队列）。 */
export function revisionNotice(revision: number): string {
  return `prompts updated to r${revision}; re-read with superagent prompts get --text`
}

/**
 * 建一个 Router 保活器。构造时只 claim 健康条目，不做任何 I/O；第一次 I/O 在 `start()`。
 */
export function createRouterSupervision(options: RouterSupervisionOptions): RouterSupervision {
  const now = options.now ?? (() => Date.now())
  const log = options.log ?? (() => undefined)
  const tickMs = options.tickMs ?? ROUTER_TICK_MS
  const entry: HealthEntryHandle = options.health.claim('router', {
    state: options.enabled ? 'starting' : 'paused',
    detail: options.enabled ? 'not started yet' : 'setup not ready'
  })

  let terminal: RouterTerminalState | null = null
  let workspaceHandle: WorkspaceHandle | null = null
  // 插件重启后先读回上一次的工作区快照：认回会话时面板仍能看到目录。
  let workspace: RouterWorkspaceState | null = options.state.workspace()
  let restartTimes = (options.state.restarts()?.at ?? []).map((at) => Date.parse(at)).filter((at) => Number.isFinite(at))
  let lastError: string | null = options.state.restarts()?.lastError ?? null
  let currentRevision = options.promptRevision
  const waits: number[] = []
  let agentState: AgentState | null = null
  /** 最近一次探活读到的 `orphaned`（事实，不参与生死判定）；没探过是 `null`。 */
  let orphaned: boolean | null = null
  let failures = 0
  let nextAttemptAt = 0
  let started = false
  let running = false
  let stopped = false
  let timer: unknown = null
  let detail = options.enabled ? 'not started yet' : 'setup not ready'

  /** 写一次健康条目：error 只在「连续 3 次失败」或「十分钟内五次重启」时（§N.4、§F.1）。 */
  const report = (): void => {
    const restarts = restartTimes.length
    const parts = [`restarts ${restarts} in 10 min`]
    if (terminal !== null) parts.push(`terminal ${terminal.terminalId}`)
    if (lastError !== null) parts.push(`last error: ${lastError}`)
    detail = parts.join(', ')
    let state: HealthEntry['state']
    if (!options.enabled) state = 'paused'
    else if (restarts >= RESTART_ERROR_THRESHOLD || failures >= FAILURES_BEFORE_ERROR) state = 'error'
    else if (terminal !== null) state = 'ready'
    else state = 'starting'
    entry.set({ state, detail })
  }

  /** 持久化重启历史（快照的唯一写者）。 */
  const saveRestarts = (): void => {
    options.state.saveRestarts({ at: restartTimes.map(iso), lastError })
  }

  /** 丢掉窗口外的事实：重启、等待转移、以及「成功后十分钟清零重启计数」。 */
  const prune = (at: number): void => {
    const kept = restartTimes.filter((time) => at - time < RESTART_ERROR_WINDOW_MS)
    const resetByIdle =
      terminal !== null && at - terminal.launchedAt >= RESTART_ERROR_WINDOW_MS && kept.length === 0
    if (kept.length !== restartTimes.length) {
      restartTimes = kept
      saveRestarts()
    } else if (resetByIdle) {
      restartTimes = []
      saveRestarts()
    }
    while (waits.length > 0 && at - (waits[0] as number) >= IDLE_WINDOW_MS) waits.shift()
  }

  /** 终端还活着吗：全机枚举里有它且 `connected`；枚举本身失败时按「未知 ≠ 没了」处理。 */
  const alive = async (terminalId: string): Promise<boolean> => {
    try {
      const rows = await options.runtime.listTerminals()
      const row = rows.find((candidate) => candidate.handle === terminalId)
      orphaned = row?.orphaned ?? null
      return row !== undefined && row.connected
    } catch (error) {
      log(`the router terminal could not be verified: ${messageOf(error)}`)
      return true
    }
  }

  /** 建 worktree（如需）→ 轮换 token → launch；成功即 ready，失败按 5 s→300 s 退避。 */
  const launch = async (at: number, countsAsRestart: boolean): Promise<void> => {
    try {
      if (workspaceHandle === null) {
        const ensured = await ensureRouterWorkspace(options.runtime, options.settings)
        workspaceHandle = ensured.handle
      }
      const handle = workspaceHandle
      workspace = { workspaceId: handle.workspaceId, path: handle.path }
      options.state.saveWorkspace(workspace)
      const tokenFile = options.rotateToken()
      const prompt = routerPrompt({
        cliPath: options.cliPath,
        tokenFile,
        stateDir: options.stateDir,
        directory: handle.path,
        repository: options.settings.repository,
        acceptMode: options.settings.acceptMode,
        policyVersion: options.settings.policyVersion,
        promptRevision: currentRevision
      })
      const launched: AgentHandle = await launchRouter(options.runtime, {
        workspace: handle,
        settings: options.settings,
        prompt
      })
      terminal = {
        terminalId: launched.terminalId,
        workspaceId: launched.workspaceId,
        launchedAt: at,
        promptRevision: currentRevision
      }
      options.state.saveTerminal(terminal)
      agentState = null
      failures = 0
      lastError = null
      nextAttemptAt = 0
      if (countsAsRestart) {
        restartTimes.push(at)
        saveRestarts()
      }
      report()
      log(`router session ${launched.terminalId} is up in ${handle.path}`)
    } catch (error) {
      terminal = null
      options.state.saveTerminal(null)
      failures += 1
      lastError = messageOf(error)
      nextAttemptAt = at + Math.min(RESTART_BACKOFF_MAX_MS, RESTART_BACKOFF_START_MS * 2 ** (failures - 1))
      saveRestarts()
      report()
      log(`the router could not be started: ${lastError}`)
    }
  }

  const tick = async (): Promise<void> => {
    if (!options.enabled || stopped || running) return
    running = true
    try {
      const at = now()
      prune(at)
      const known = terminal ?? options.state.terminal()
      if (known !== null && (await alive(known.terminalId))) {
        terminal = known
        report()
        return
      }
      if (known !== null) {
        // 会话没了：先把快照清掉，避免下一次 tick 又把它当成「活着的」；工作区也重新查一次，
        // 因为 §F.5 的第三个触发条件是「worktree 消失」（消失就先重建，再 launch）。
        log('the router terminal is gone; restarting')
        terminal = null
        workspaceHandle = null
        agentState = null
        waits.length = 0
        options.state.saveTerminal(null)
      }
      if (at < nextAttemptAt) {
        report()
        return
      }
      await launch(at, known !== null)
    } finally {
      running = false
    }
  }

  return {
    async start(): Promise<void> {
      if (started) return
      started = true
      if (!options.enabled) {
        report()
        return
      }
      await tick()
      // 认回的是旧会话、而配置里的 revision 已经变过：补一条通知（角色层仍要重启才换，§F.4）。
      if (terminal !== null && terminal.promptRevision < currentRevision) {
        options.notice.enqueue(revisionNotice(currentRevision))
      }
      if (options.schedule !== undefined) {
        timer = options.schedule(() => {
          void tick()
        }, tickMs)
      }
      report()
    },
    tick,
    async onAgentStatus(event: AgentStatusEvent): Promise<void> {
      const current = terminal
      if (current === null || event.terminalId !== current.terminalId) return
      const at = now()
      prune(at)
      // `done` 是回合结束（S7 实测），不是死亡：只记录状态，不重启。终端真的没了时下一次
      // tick 的 `listTerminals()` 会发现它。
      const previous = agentState
      agentState = event.state
      if (previous === 'working' && event.state === 'waiting') {
        waits.push(at)
        prune(at)
      }
    },
    notifyPromptRevision(revision: number): void {
      if (revision === currentRevision) return
      currentRevision = revision
      // 只告知：角色层要新会话才换，团队段/Policy 段由 Router 自己重读（§F.4、§L.5）。
      options.notice.enqueue(revisionNotice(revision))
    },
    noteDecision(): void {
      waits.length = 0
    },
    async restart(reason: string): Promise<void> {
      if (!options.enabled || stopped) return
      const current = terminal ?? options.state.terminal()
      if (current !== null) {
        try {
          await options.runtime.closeTerminal(current.terminalId)
        } catch (error) {
          log(`the old router terminal could not be closed: ${messageOf(error)}`)
        }
      }
      terminal = null
      workspaceHandle = null
      agentState = null
      orphaned = null
      waits.length = 0
      options.state.saveTerminal(null)
      // 显式动作：清掉崩溃循环的证据与退避，立刻换新会话。
      restartTimes = []
      failures = 0
      lastError = null
      nextAttemptAt = 0
      saveRestarts()
      log(`restarting the router on purpose: ${reason}`)
      await launch(now(), false)
    },
    terminalId(): string | null {
      return terminal?.terminalId ?? null
    },
    snapshot(): RouterSnapshot {
      const at = now()
      prune(at)
      return {
        state: entry.get()?.state ?? 'starting',
        detail,
        terminalId: terminal?.terminalId ?? null,
        workspaceId: terminal?.workspaceId ?? workspace?.workspaceId ?? null,
        directory: workspace?.path ?? null,
        startedAt: terminal === null ? null : iso(terminal.launchedAt),
        promptRevision: terminal?.promptRevision ?? null,
        currentRevision,
        restarts: restartTimes.length,
        lastError,
        nextAttemptAt: nextAttemptAt === 0 ? null : iso(nextAttemptAt),
        idle: {
          suspected: waits.length >= IDLE_TRANSITIONS,
          waits: waits.length,
          since: waits.length === 0 ? null : iso(waits[0] as number)
        },
        undecidedCandidates: options.undecidedCandidates?.() ?? 0,
        orphaned,
        agentState
      }
    },
    stop(): void {
      stopped = true
      if (timer !== null && options.cancel !== undefined) {
        options.cancel(timer)
        timer = null
      }
    }
  }
}

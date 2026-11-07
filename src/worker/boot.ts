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
import type {
  DecisionDetailView,
  DecisionListInput,
  DecisionListPage,
  DeploymentView,
  PanelState,
  PanelTerminal,
  SourcePageView,
  ThreadDetailInput,
  ThreadDetailView,
  ThreadListInput,
  ThreadListPage,
  TicketDetailView,
  TicketListInput,
  TicketListPage
} from '../panel/protocol'
import { Engine } from './core/index.ts'
import type { Store } from './app/store.ts'
import { openStore } from './app/store.ts'
import { acquireLock } from './infra/lock.ts'
import { createLogger, type Logger } from './infra/log.ts'
import { HealthBoard, claimModelsEntry, FAILURES_BEFORE_ERROR } from './infra/health.ts'
import { defaultStateDir, resolveStateDir, writeStateDirPointer } from './infra/paths.ts'
import {
  API_TOKEN_FILE,
  ROUTER_TOKEN_FILE,
  TOKENS_DIR,
  ensureApiToken,
  issueAssignmentToken,
  issueRouterToken,
  rotateApiToken
} from './infra/tokens.ts'
import { deploymentView } from './app/deployment-view.ts'
import { machineLimits } from './app/limits.ts'
import { runDoctor } from './app/doctor.ts'
import type { DoctorOptions } from './app/doctor.ts'
import type { DoctorResult } from './app/doctor-types.ts'
import { createRepositories } from './app/repositories.ts'
import {
  createPolicy,
  DEFAULT_POLICY,
  validatePolicy
} from './policy/index.ts'
import type { PolicyBlock, PolicyKindView } from './policy/index.ts'
import { resolveRoles } from './app/roles.ts'
import { ROUTER_RESTARTS_KEY, ROUTER_TERMINAL_KEY, ROUTER_WORKSPACE_KEY, PROMPT_REVISION_KEY } from './app/kv.ts'
import { createDeterministicAssessor } from './app/assessor.ts'
import { registerAssessmentEffects } from './app/notices.ts'
import { createRouterTools } from './app/assessment.ts'
import { createOutbox, registerReplyEffects } from './app/outbox.ts'
import { createPausedState } from './app/pause.ts'
import {
  createPolicySettingsPort,
  createSettings,
  savedSettingsVersion
} from './app/settings.ts'
import { createPolicySync, type PolicySync } from './app/policy-sync.ts'
import {
  feishuChatsKey,
  feishuCursorKey,
  feishuTopicsKey,
  githubBodyKey,
  githubBranchCiKey,
  githubCiKey,
  githubCursorKey,
  githubStreamKey,
  sourceLabelsKey,
  threadSeenKey
} from './app/kv.ts'
import {
  createRefreshableStateSource,
  panelTicketPage,
  type RefreshableStateSource
} from './app/state-source.ts'
import { deliveredFollowups, ticketDetail } from './app/views.ts'
import { sourcePage, type SourceViewHost } from './app/views/sources.ts'
import { decisionDetail, decisionPage } from './app/views/decisions.ts'
import { threadDetailView, threadListPage, threadRecordsOf } from './app/views/threads.ts'
import {
  followupOwners,
  latestAssignment,
  runningAssignment,
  UserError,
  type Ticket
} from './core/index.ts'
import { readEvalsHealth, readUnavailableProblems } from './app/views/attention.ts'
import { readSystemProblems, replyTarget } from './app/views/problems.ts'
import { statusBarView } from './app/status-bar.ts'
import type { StatusBarView } from './app/status-bar.ts'
import { Effects, ROUTER_EFFECT_KEY } from './app/effects.ts'
import { createPasses } from './app/passes.ts'
import { notePluginVersion } from './app/upgrade.ts'
import { createSourceContext } from './app/source-context.ts'
import { createSetupState, issuesOf, runSetupChecks } from './app/setup.ts'
import type { SetupCheckInput, SetupIssue, SetupProblem, SetupReport } from './app/setup.ts'
import {
  SourceRegistry,
  type ResolvedSourceInstance,
  type SourceSettingsView
} from './sources/registry.ts'
import { Commands, type CommandsHost } from './sources/commands.ts'
import {
  claimReportedPull,
  createGithubApi,
  createGithubKind,
  createGithubPoller,
  observePull,
  pullEndNotices,
  subscribedThreads,
  GITHUB_KIND
} from './sources/github/index.ts'
import type { GithubPollResult, GithubPoller, GithubPullHost } from './sources/github/index.ts'
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
import { launchCapacity, loadReadout } from './executor/slots.ts'
import { retryTicket } from './executor/retry.ts'
import { WORKTREE_PREFIX } from './executor/workspace.ts'
import { resumeAfterUpgrade, type ResumeReport } from './executor/resume.ts'
import { DEFAULT_MAX_WORKERS } from './http/state.ts'
import { createDomainHandlers, withDomainHandlers } from './http/domain.ts'
import { createSettingsHandlers, withSettingsHandlers } from './http/settings.ts'
import { runWrite } from './http/idempotency.ts'
import { parseSettingsBlock, validateSettingsBlock } from './app/settings-blocks.ts'
import { createAssessmentHandlers, withAssessmentHandlers } from './http/assessment.ts'
import { createEvalHandlers, withEvalHandlers } from './http/eval.ts'
import { createEvalTools } from './app/eval.ts'
import { createReadHandlers, withReadHandlers } from './http/read.ts'
import { createReadTools } from './app/read.ts'
import { createViewReadTools } from './app/views/read.ts'
import { admissionSettingsOf } from './sources/admission-context.ts'
import { createDecisionHandlers, withDecisionHandlers } from './http/decisions.ts'
import { createPromptHandlers, withPromptHandlers } from './http/prompts.ts'
import { createPromptVersions } from './app/prompts.ts'
import {
  previewPromptDraft,
  promptPanelView,
  restorePromptVersion,
  savePromptConfig,
  type PromptPanelOptions
} from './app/prompt-view.ts'
import type { PanelPromptPreview, PanelPromptsView } from '../panel/protocol'
import { syncSkillFiles } from './app/skills.ts'
import type { PromptEnvironment, PromptPolicy } from './app/prompts.ts'
import { assembleLaunchPrompt } from './app/launch-prompt.ts'
import { ENVIRONMENT_VARIABLES } from './executor/environment.ts'
import type { RouteCaller } from './http/routes.ts'
import { ROUTE_TABLE, type RouteDefinition } from './http/routes.ts'
import type { LoopEntry } from './http/state.ts'
import { startHttpServer, type HttpServerHandle } from './http/server.ts'
import { OrcaRuntimeError, type AgentStatusEvent, type OrcaRuntime, type WorkspaceInfo } from './runtime/orca-runtime.ts'
import { createRouterRelay } from './router/relay.ts'
import {
  createRouterSupervision,
  type RouterRestartState,
  type RouterSnapshot,
  type RouterStateStore,
  type RouterTerminalState,
  type RouterWorkspaceState
} from './router/supervision.ts'
import { routerPrompt } from './router/prompt.ts'

/** worker 侧一轮 pass 的周期（§N.1 的 2 s 巡检）。 */
export const PASS_INTERVAL_MS = 2000

/** 详情页的终端摘要读最后几行（§E.7 的取证口径：面板预览 3 行、完整摘要这一档）。 */
export const TERMINAL_SUMMARY_LINES = 20

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
  /** 启动时那一轮名单同步的 promise（生产不等它；测试与诊断等它）。 */
  policySync(): Promise<void>
  /** 手动「立即同步」：跑一次某个 Source 的名单同步（面板按钮与 `policy sync` 命令共用）。 */
  syncPolicy(id: string): Promise<Record<string, unknown>>
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
   * 人的重试（§E.5，面板 `ticket.retry` 请求用）：结束卡住的 Assignment，在同一个 worktree、
   * 分支与 PR 上再起一个，带恢复说明；返回写后的快照。不可重试时抛领域的 `notRetryable`。
   */
  retryTicket(ticketId: string): PanelState
  /** 聚焦一台终端（§M.2：面板没有这个宿主能力，由 worker 代跑 CLI）。 */
  focusTerminal(terminalId: string): Promise<void>
  /** Execution 列表的一页（§M.2 的筛选 + §M.4 的分页）；档位 → 领域筛选只有一处映射。 */
  tickets(input: TicketListInput): TicketListPage
  /**
   * 一张工单的详情（§M.2 的七块）。终端摘要是现读的一次 `terminal.read`；读不到就省略，
   * 不让整个详情失败。未知工单抛 `unknownTicket`。
   */
  ticketDetail(ticketId: string): Promise<TicketDetailView>
  /** Trigger 列表的一页（§M.2 的四档筛选 + §M.4 的分页）：筛选与分页都在读模型里。 */
  threads(input: ThreadListInput): ThreadListPage
  /**
   * 一条 Thread 的详情（§M.2）：时间线（`(at, id)` 游标分页）、决定、订阅与 handback 原因。
   * 未知的 Thread 抛 `unknownThread`。
   */
  threadDetail(
    threadKey: string,
    input: Omit<ThreadDetailInput, 'threadKey'>
  ): ThreadDetailView
  /** 再评估一次（§G.2 的 `trigger requeue`）：返回它是否排进了 Eval（已有 Eval 持有时是 false）。 */
  requeueTrigger(triggerId: string): boolean
  /** 取消订阅一条 Thread（§G.2 的 `thread unsubscribe`）：返回是否真的丢了订阅。 */
  unsubscribeThread(threadKey: string): boolean
  /** 人的停止（§E.5、§K.3：撤回 Mandate）；面板先做行内二次确认。 */
  stopTicket(ticketId: string): PanelState
  /** 发一条 fact note（§G.2 的 `ticket note`）：只加语境，不授权任何事。 */
  noteTicket(ticketId: string, text: string): PanelState
  /** 请求状态（§G.2 的 `ticket request-status`）：返回是否真的问了一条。 */
  requestStatus(ticketId: string): boolean
  /** Eval 列表的一页（§M.2 的 Decision 列表）：最新在前，分页 50 条，带 §K.7 的待人工条数。 */
  decisions(input: DecisionListInput): DecisionListPage
  /**
   * 一条 Decision 的详情（§M.2 的 Eval 详情）：字段、原因、到 Thread/Ticket 的链接，
   * 以及它现在是否仍要人（§K.7）。未知决定抛 `unknownDecision`。
   */
  decisionDetail(decisionId: string): DecisionDetailView
  /** 把一条 unavailable 决定暴露的问题 dismiss（§K.7）：面板先做行内二次确认。 */
  dismissDecision(decisionId: string): PanelState
  /** 打开一张工单的 worktree（§M.2：面板没有 `workspace.open` 这个宿主方法）。 */
  openTicketWorkspace(ticketId: string): Promise<void>
  /** 移除一张工单的 worktree（§E.1「清理」，破坏性；面板先要人确认）。 */
  removeTicketWorkspace(ticketId: string): Promise<void>
  /**
   * `superagent setup check`（§G.2）：重跑探针、把结论应用到各部分并重新武装挂起的循环，
   * **不重启 Orca**。`checked: false` 表示检查时本来就没有问题——没有可检查的东西。
   */
  checkSetup(): Promise<SetupCheckOutcome>
  /** Deployment 页的读数（§M.3）：setup 问题、状态目录、机器限额、暂停、health 与 Router。 */
  deployment(): DeploymentView
  /**
   * Source 页的读数（§M.2）：每个配置过的 Source 一张卡——开关、字段、facts、health、
   * 24 h 计数、被过滤的 Trigger 与被 drop 的消息。
   */
  sources(): SourcePageView
  /** 打开/关闭一个 Source（写 `source:<id>` 的 `enabled` 并立即生效），返回写后的读数。 */
  setSourceEnabled(sourceId: string, enabled: boolean): SourcePageView
  /** 「立即同步」一个 Source 的允许名单（§I.3）；不能同步时拒绝。 */
  syncSource(sourceId: string): Promise<{ readonly allowed: number }>
  /** 重读一个 Source 的行键显示名（§G.2 的 `source labels`）；Kind 没有这个能力时拒绝。 */
  refreshSourceLabels(sourceId: string): Promise<{ readonly added: number; readonly total: number }>
  /** doctor 的八项诊断（§G.2、§N.4）：与 HTTP 的 `POST doctor` 同一份接线。 */
  doctor(): Promise<DoctorResult>
  /**
   * Prompts 组的一次读数（§M.3）：当前版本与配置、每个分片的内置正文与占位符、
   * default-updated 的详情、历史、技能文件，以及「已保存 / 默认」两份全文。
   */
  promptPanel(): PanelPromptsView
  /**
   * 预览一份草稿（与保存同一份校验，不写库）：合法时给拼好的全文，不合法时给 `issues[]`
   * （填槽值还在，面板因此能说清哪一段、缺什么）。
   */
  previewPrompts(config: unknown): PanelPromptPreview
  /** 保存一份配置（§L.4）：`baseRevision` 不匹配抛 `stale_revision`；成功回整个读数。 */
  savePrompts(input: { readonly config: unknown; readonly baseRevision: number }): PanelPromptsView
  /** 恢复某个版本或默认（§L.4）：再存一个新版本，成功回整个读数。 */
  restorePrompts(input: {
    readonly revision: number
    readonly baseRevision: number
  }): PanelPromptsView
  /** 轮换主 token（§D.6、§O）：只回 token 文件路径，绝不回 token 值。 */
  rotateToken(): { readonly rotated: boolean; readonly tokenFile: string }
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
  /** 面板的开关会改它（§M.2「打开/关闭」）：其余字段仍是启动时读到的设置。 */
  enabled: boolean
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
      policySync: async () => undefined,
      syncPolicy: async () => {
        throw new Error('another instance owns the state directory; it does the list sync')
      },
      passOnce: async () => undefined,
      port: () => null,
      resumeReport: () => null,
      onAgentStatus: async () => undefined,
      routerTick: async () => undefined,
      routerStatus: () => emptyRouterSnapshot(),
      restartRouter: async () => undefined,
      notifyPromptRevision: () => undefined,
      // follower 不读库：Prompts 组的读数与写入都属于拥有者（固定拒绝，不假装成功）。
      promptPanel: () => {
        throw Object.assign(new Error('another Superagent instance owns this state directory'), {
          code: 'unavailable'
        })
      },
      previewPrompts: () => {
        throw Object.assign(new Error('another Superagent instance owns this state directory'), {
          code: 'unavailable'
        })
      },
      savePrompts: () => {
        throw Object.assign(new Error('another Superagent instance owns this state directory'), {
          code: 'action_failed'
        })
      },
      restorePrompts: () => {
        throw Object.assign(new Error('another Superagent instance owns this state directory'), {
          code: 'action_failed'
        })
      },
      refresh: () => emptySnapshot(),
      setPaused: () => emptySnapshot(),
      // follower 不写库：重试属于拥有者，跟着它去面板里做（固定拒绝，不假装成功）。
      retryTicket: () => {
        throw Object.assign(new Error('another Superagent instance owns this state directory'), {
          code: 'action_failed'
        })
      },
      // 聚焦终端不读写库，只是宿主的一句调用：follower 也能做。
      focusTerminal: (terminalId: string): Promise<void> => options.runtime.focusTerminal(terminalId),
      // follower 不读库：Execution 的读数与写入都属于拥有者（固定拒绝，不假装成功）。
      tickets: () => ({ items: [], nextOffset: null }),
      ticketDetail: async () => {
        throw Object.assign(new Error('another Superagent instance owns this state directory'), {
          code: 'unavailable'
        })
      },
      // follower 不读库：Trigger 页的读数与两条动作都属于拥有者（固定拒绝，不假装成功）。
      threads: () => ({ items: [], nextOffset: null }),
      threadDetail: () => {
        throw Object.assign(new Error('another Superagent instance owns this state directory'), {
          code: 'unavailable'
        })
      },
      requeueTrigger: () => {
        throw Object.assign(new Error('another Superagent instance owns this state directory'), {
          code: 'action_failed'
        })
      },
      unsubscribeThread: () => {
        throw Object.assign(new Error('another Superagent instance owns this state directory'), {
          code: 'action_failed'
        })
      },
      stopTicket: () => {
        throw Object.assign(new Error('another Superagent instance owns this state directory'), {
          code: 'action_failed'
        })
      },
      noteTicket: () => {
        throw Object.assign(new Error('another Superagent instance owns this state directory'), {
          code: 'action_failed'
        })
      },
      requestStatus: () => {
        throw Object.assign(new Error('another Superagent instance owns this state directory'), {
          code: 'action_failed'
        })
      },
      // follower 不读库：Eval 的读数与 dismiss 都属于拥有者（固定拒绝，不假装成功）。
      decisions: () => ({ items: [], nextOffset: null, unresolved: 0 }),
      decisionDetail: () => {
        throw Object.assign(new Error('another Superagent instance owns this state directory'), {
          code: 'unavailable'
        })
      },
      dismissDecision: () => {
        throw Object.assign(new Error('another Superagent instance owns this state directory'), {
          code: 'action_failed'
        })
      },
      openTicketWorkspace: async () => {
        throw Object.assign(new Error('another Superagent instance owns this state directory'), {
          code: 'unavailable'
        })
      },
      removeTicketWorkspace: async () => {
        throw Object.assign(new Error('another Superagent instance owns this state directory'), {
          code: 'action_failed'
        })
      },
      // follower 不读库、不跑探针：它没有可以做检查的东西。
      checkSetup: async () => ({ checked: false, problem: null, issues: [], restarted: false }),
      // follower 不读库：Source 页的读数与动作都属于拥有者（固定拒绝，不假装成功）。
      sources: () => ({ items: [], elsewhere: [] }),
      setSourceEnabled: () => {
        throw Object.assign(new Error('another Superagent instance owns this state directory'), {
          code: 'action_failed'
        })
      },
      syncSource: async () => {
        throw Object.assign(new Error('another Superagent instance owns this state directory'), {
          code: 'action_failed'
        })
      },
      refreshSourceLabels: async () => {
        throw Object.assign(new Error('another Superagent instance owns this state directory'), {
          code: 'action_failed'
        })
      },
      // 部署页读到的是「这一进程只跟着另一个实例」：没有自己的 health，也不假装在跑。
      deployment: () =>
        deploymentView({
          stateDir: resolved,
          setup: [],
          limits: machineLimits(settings),
          paused: true,
          health: {},
          router: emptyRouterSnapshot()
        }),
      // 诊断与轮换由那个真正持有 stateDir 的实例做。
      doctor: async () => {
        throw Object.assign(new Error('another instance owns the state directory; run doctor through it'), {
          code: 'refused'
        })
      },
      rotateToken: () => {
        throw Object.assign(new Error('another instance owns the state directory; it owns the token'), {
          code: 'refused'
        })
      },
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
  // Trigger 页的读模型：真库上的时间线 + 真仓储的归属判定（组合根与测试同一处构造）。
  const threadRecords = threadRecordsOf(repo, store)

  // ---- 设置与 setup 探针（§N.1、§I.4）：一次只告诉人缺什么，不把「没配置」写成 error
  const executorSettings = resolveExecutorSettings(settings)
  const rawSources = block(settings['sources'])
  /**
   * 存过的 `source:<id>` 块里有效的 `enabled`（§N.2：面板保存的设置存库即生效）。
   * 只读这一项：`cli`/`repository` 这类 setup 字段仍取启动时读到的设置，改它们要重启。
   */
  const savedSourceEnabled = (id: string): boolean | undefined => {
    const saved = savedSettingsVersion(store, `source:${id}`)?.config
    if (typeof saved !== 'object' || saved === null) return undefined
    const enabled = (saved as { enabled?: unknown }).enabled
    return typeof enabled === 'boolean' ? enabled : undefined
  }
  /** 一个 Source 的存储形态：安装时的设置，加上面板保存过的 `enabled`（若有）。 */
  const storedSource = (id: string): Record<string, unknown> => {
    const base = block(rawSources[id])
    const enabled = savedSourceEnabled(id)
    return enabled === undefined ? base : { ...base, enabled }
  }
  const githubStored = storedSource(GITHUB_KIND)
  const commandPort: CommandsHost =
    options.commands ?? new Commands({ configuredPrograms: () => [text(settings['githubCli'])] })
  // 机器限额（§H.12、§H.22）：设置里写了的用写的，没写的用缺省值；启动时读一次。
  const limits = machineLimits(settings)
  /**
   * `doctor` 的接线（§G.2、§N.4）：HTTP 的 `POST doctor` 与面板的 `doctor` 请求走**同一份**选项，
   * 于是两处读数永远一致。只 stat 文件、不读 secret（§O）。
   */
  const doctorOptions: DoctorOptions = {
    stateDir: resolved,
    run: (program, args) => commandPort.run(program, args),
    cliPath: options.cliPath ?? defaultCliPath(),
    now,
    inspectDatabase: () => store.inspect()
  }
  const doctorNow = (): Promise<DoctorResult> => runDoctor(doctorOptions)
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
    // worker 的提交身份（§H.11）：账号以探针读到的 `gh` 为准，邮箱来自设置（§E.11 同源）。
    gitConfig: {
      email: text(settings['githubCommitEmail']) ?? '',
      account: text(settings['githubLogin']) ?? ''
    },
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
  const feishuStored = storedSource(FEISHU_KIND)
  const feishuSetup = await setupFeishu({
    raw: settings,
    stored: feishuStored,
    commands:
      options.commands ??
      new Commands({ configuredPrograms: () => [text(settings['feishuCli'])] }),
    log: (message) => logger.info(message)
  })
  const setup = createSetupState(await runSetupChecks(setupInput()))
  let sourceSettings: SourceSettingsView = settingsView(settings, githubSetup, feishuSetup)

  // ---- 注册表与 kind
  const registry = new SourceRegistry({ health: board, settings: () => sourceSettings })
  registry.register(createGithubKind(String(githubSetup.config['cli'] ?? 'gh')))
  // Feishu 的 kind 绑定配置的 CLI 与 stateDir：语境读/图片下载要它们（§I.3、§H.17）。
  registry.register(
    createFeishuKind(feishuSetup.cli === '' ? 'lark-cli' : feishuSetup.cli, {
      stateDir: resolved,
      labelsKey: sourceLabelsKey(FEISHU_KIND)
    })
  )
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
    // §E.6：`launch` 的取行上限 = 普通槽空位 + 「有人的唤醒在等」时那一个人人类槽。
    // 人/自动的精确判定仍在执行器里（拿不到槽抛 `Later`，不算失败）。
    slots: () => launchCapacity(repo.tickets.list(), executorSettings.maxWorkers),
    // §J.3：单条 dropped 不算错误、只计数；撤回是人的动作，不计入 drop 计数。
    dropped: (kind) => (kind === 'reply' ? store.outbox.countDropped() : 0)
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
  /**
   * 生效的 Policy 块：保存过就以存下来的那份为准，否则是启动时读到的那份。Policy 的保存
   * （§K.5）因此立刻改变 Gate、复验与版本——不必等重启，也不需要第二个真相源。
   */
  const effectivePolicy = (): PolicyBlock => {
    const stored = savedSettingsVersion(store, 'policy')?.config
    if (stored === undefined) return policyBlock
    const parsed = validatePolicy(stored, { kinds: policyKind })
    if (!parsed.success) return policyBlock
    return parsed.data
  }
  /**
   * 设置块的保存器（§K.8、§K.5）：Policy 块的内容哈希与变更投递走 `policy/*` 与引擎。
   * 名单同步（§I.3）以 origin=`sync` 写 Policy 块，因此和面板保存共用这一条写路径。
   */
  const settingsWriter = createSettings({
    store,
    now,
    policy: createPolicySettingsPort({
      kinds: policyKind,
      rows: (source) => policyKind(source)?.rows() ?? [],
      openTickets: () => repo.tickets.list(),
      changed: (from, to, effects) => engine.policyChanged(from, to, effects),
      current: effectivePolicy
    })
  })
  const policy = createPolicy({
    block: effectivePolicy,
    sources: registry,
    rows: (source) => policyKind(source)?.rows() ?? [],
    paused: () => paused.paused()
  })

  // ---- Router（§F.1–§F.5）：专用 worktree、terminal 面的常驻会话、relay 与保活监督
  const roles = resolveRoles(settings)
  const deploymentFacts = deployment(settings, { ...githubSetup, login: githubLogin() }, feishuSetup)
  const cliPath = options.cliPath ?? defaultCliPath()
  // Prompt 配置与版本的唯一读写面（§L.4、§L.5）：两个 launch 与 `prompts get --text` 都从这里读；
  // 每次 launch 现读，所以保存过的团队段与 revision 在下一次 launch 就生效。体量上限来自设置
  // （§L.6 的 `promptMaxChars`）：保存配置与拼全文读同一个数。
  const promptVersions = createPromptVersions({ store, now, maxChars: limits.promptMaxChars })
  /**
   * 技能文件（§L.6、§H.8）：把内置 skills 与团队技能写到 `<stateDir>/skills/`。启动时一次，
   * 每次保存提示词配置后再一次（新建/编辑/删除都在那里生效）。写失败只记警告：技能文件缺失
   * 是「agent 读不到」而不是「插件坏了」，但绝不假装写成功。
   */
  const syncSkills = (): void => {
    try {
      syncSkillFiles({ stateDir: resolved, config: promptVersions.config() })
    } catch (error) {
      logger.warn(`the skill files could not be written: ${stringOf(error)}`)
    }
  }
  syncSkills()
  /** 一次会话或一次请求的部署环境段（§G.5）：只给路径，绝不写 token 值（§D.6）。 */
  const promptEnvironment = (tokenFile: string): PromptEnvironment => ({
    variables: [...ENVIRONMENT_VARIABLES],
    cliPath,
    tokenFile,
    stateDir: resolved,
    repository: deploymentFacts.repository,
    account: deploymentFacts.githubLogin
  })
  /** Router 的 Policy 段（§L.3 第 11 步）：跟**生效**的块走，与 Gate、复验同一个真相源。 */
  const promptPolicy = (): PromptPolicy => {
    const block = effectivePolicy()
    return {
      version: policy.version,
      mode: block.acceptMode,
      rules: block.rules
        .filter((rule) => rule.enabled)
        .map((rule) => ({ id: rule.id, name: rule.name, instruction: rule.instruction.en }))
    }
  }
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
      ...(executorSettings.baseBranch === undefined ? {} : { baseBranch: executorSettings.baseBranch })
    },
    rotateToken: () => issueRouterToken({ store, stateDir: resolved }).path,
    promptRevision: promptRevisionOf(store),
    /**
     * 组装 Router 的 launch prompt（§L.3、§L.5）：每次 launch 现读配置、当时的 Policy 与
     * 部署事实，拼好后交出全文；监督只拿回文本与长度，不自己拼、也不缓存旧版本。
     */
    prompt: {
      compose: ({ tokenFile, directory, revision }) => {
        const assembled = assembleLaunchPrompt({
          role: 'orchestrator',
          revision,
          config: promptVersions.config(),
          environment: promptEnvironment(tokenFile),
          policy: promptPolicy(),
          maxChars: promptVersions.maxChars()
        })
        const text = routerPrompt({ text: assembled.text, cliPath, tokenFile, directory })
        return { text, length: text.length }
      }
    },
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
    // 本评估器不决定的主动候选：排一条 `assessment`，由 Router 读卡并评估（§K.4、§J.2）。
    relayCandidate: (candidate) => {
      const primary = candidate.triggers[0]
      if (primary !== undefined) {
        effects.enqueue('assessment', candidate.evalId, { triggerId: primary.id })
      }
    },
    onError: (error, evalId) => logger.warn(`the assessment of ${evalId} could not be decided`, { error: stringOf(error) })
  })
  // ---- GitHub 的 PR 规则（§I.2「PR 规则」行、§I.5）：读一条 PR、绑定与结束判定。宿主把
  // Engine 的两条命令与仓储的读面拼成 Source 端口（§C.2 规则 2：sources 不 import app），
  // 报告路径与轮询路径共用同一份，语义因此只有一处。
  const githubRepository = String(githubSetup.config['repository'] ?? '')
  const githubCli = String(githubSetup.config['cli'] ?? 'gh')
  /** GitHub 的读端口：setup 完成（仓库与 CLI 都在）才读，否则 PR 绑定与通知都不接线。 */
  const githubReady = githubSetup.enabled && githubRepository !== '' && githubCli !== ''
  const githubApi = createGithubApi(
    (options.commands ?? new Commands({ configuredPrograms: () => [text(settings['githubCli'])] })).withSignal(),
    githubCli
  )
  const pullHost: GithubPullHost = {
    api: githubApi,
    tickets: {
      get: (ticketId) => repo.tickets.get(ticketId),
      open: () => repo.tickets.open()
    },
    trigger: (triggerId) => repo.triggers.get(triggerId),
    bind: (ticketId, thread, own) => {
      engine.bindThread(ticketId, thread, own)
    },
    close: (thread, outcome, at) => {
      engine.threadClosed(thread, outcome, at)
    },
    // agent 的账号与配置仓库判「这条 PR 是不是它的」（§I.2 PR 规则行）。
    login: deploymentFacts.githubLogin,
    repository: githubRepository,
    now
  }
  const executor = new OrcaExecutor({ effects, runtime: options.runtime, log: (message) => logger.info(message) })
  const engine = new Engine({
    repo,
    scope: registry,
    policy: () => policy,
    assessor,
    executor,
    outbox,
    // §J.2 的 `return`：把人的消息交回 Eval 是持久意图——领域事务里只写 disposition 与一行
    // effect，提交后才由下面的 handler 经 `Engine.returnToEval` 重排（候选因此出现在下一次
    // pass，而不是命令返回时）。
    returns: { enqueue: (triggerId) => effects.enqueue('return', triggerId, { triggerKey: triggerId }) },
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
      // 因 PR 结束的 Ticket 给 chat 发**一条**稳定通知（§I.2「结束通知」行）：键由 PR 号、
      // Channel 与结局派生，同一结束重复算也只排一条（§J.1 幂等）。GitHub 自己的时间线已经
      // 显示合并/关闭，所以通知只发往别的 Channel。
      if (event.type === 'ticket.ended' && githubReady) {
        const ended = repo.tickets.get(event.data.ticketId)
        if (ended !== undefined) {
          const request = repo.triggers.get(ended.origin.triggerId)?.text ?? ''
          for (const notice of pullEndNotices(ended, request, githubRepository)) outbox.send(notice)
        }
      }
    }
  })
  // 候选卡送到 Router 之后才起算 Eval 的截止时间（§K.7）；送达与 relay/notice 共用同一条
  // 串行写手，失败按 assessment 的退避重试（§J.2）。
  registerAssessmentEffects({
    effects,
    candidate: (triggerId) => engine.candidate(triggerId),
    delivered: (evalId) => engine.candidateDelivered(evalId),
    deliver: relayHandlers.card,
    now: nowMs,
    log: (message) => logger.info(message)
  })
  // `return`（§J.2）：人的消息交回 Eval 的持久意图。handler 只经 Engine 的幂等方法重排，
  // 于是 Thread 的写者仍然只有 Engine（§D.4），core 也不 import app（§C.2）。
  effects.handle('return', async (payload) => {
    if (!engine.returnToEval(payload.triggerKey)) {
      logger.info(`the returned follow-up ${payload.triggerKey} needs no new Eval`)
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
    cliPath,
    tokenFile: (assignmentId) => assignmentTokenFile(store, resolved, assignmentId),
    apiBase: '',
    // Worker 的 launch 也是在启动那一刻现读配置与 revision（§L.5）。
    prompts: promptVersions,
    wait: deliveryWait,
    log: (message) => logger.info(message)
  })
  registerReplyEffects({
    effects,
    outbox,
    channel: {
      // Source 关闭（或未安装）时等待（§J.1 暂停行）；不再监听该地址时 drop（§J.1 原因 a）。
      enabled: (source) => registry.instance(source)?.enabled ?? false,
      allowed: (message) => registry.channelAllowed(message.channel),
      send: (message) => registry.send(message, (options.commands ?? new Commands()).withSignal())
    },
    now,
    log: (message) => logger.info(message)
  })

  // ---- 读模型 / 状态栏 / 面板
  /** health 里报 error 的条目数（面板的 `health.error` 与 §J.3 的系统问题共用这一条读法）。 */
  const healthErrors = (): number =>
    Object.values(board.all()).filter((entry) => entry.state === 'error').length
  /** Source 概况（Overview 空态那一行）：与 Source 页、`sources` 健康条目同一份读数。 */
  const sourceSummary = (): { enabled: number; problems: number } => {
    const rows = registry.overview().filter((row) => row.installed)
    return {
      enabled: rows.filter((row) => row.enabled).length,
      problems: rows.filter((row) => row.state === 'error').length
    }
  }
  const stateSource: RefreshableStateSource = createRefreshableStateSource({
    tickets: () => repo.tickets.list(),
    activity: () => activityCounts(store, nowMs()),
    // §E.6 的槽读数：运行数/上限 + 单列的人类槽（执行器自己判定占用，面板不重算一遍）。
    load: () => loadReadout(repo.tickets.list(), executorSettings.maxWorkers),
    hasError: () => healthErrors() > 0,
    setupMissing: () => setup.missing(),
    paused: () => paused.paused(),
    sources: sourceSummary,
    // §J.3 的系统问题 = health error 条目 + 连续失败 3 次的回复（outbox）+ §K.7 判过四条件的
    // unavailable（窗口、最新决定、dismiss 与 Thread 是否在忙都在读模型里判）。
    problems: () =>
      readSystemProblems({
        health: board.all(),
        replies: outbox.failing(FAILURES_BEFORE_ERROR).map((entry) => ({
          id: entry.record.id,
          target: replyTarget(entry.message.channel)
        })),
        unavailable: readUnavailableProblems({ sql: store.sql }, { now: now() })
      })
  })

  /**
   * 一张工单当前（或最近一次）派工终端的最后若干行（§E.7 的取证读数）。读不到就省略：
   * 终端可能已经关了，摘要不该因此让整个详情失败。
   */
  const terminalSummary = async (ticket: Ticket): Promise<PanelTerminal | undefined> => {
    const assignment = runningAssignment(ticket) ?? latestAssignment(ticket)
    const terminalId = assignment?.terminalId
    if (terminalId === undefined) return undefined
    try {
      const read = await options.runtime.readTerminal(terminalId, { maxLines: TERMINAL_SUMMARY_LINES })
      return { terminalId, lines: read.lines, truncated: read.truncated }
    } catch {
      return undefined
    }
  }

  /** 一张工单的 worktree（§E.1：`ticket.execution.directory` 是唯一复用键）；找不到就是固定拒绝。 */
  const ticketWorkspaceOf = async (ticketId: string): Promise<WorkspaceInfo> => {
    const ticket = repo.tickets.get(ticketId)
    if (ticket === undefined) throw new UserError('unknownTicket', { ticket: ticketId })
    if (ticket.execution === undefined) {
      throw new OrcaRuntimeError('workspace_missing', 'the ticket has no worktree yet', {
        values: { ticket: ticketId }
      })
    }
    const workspaces = await options.runtime.listWorkspaces()
    const found = workspaces.find(
      (workspace) =>
        workspace.path === ticket.execution?.directory ||
        workspace.name === `${WORKTREE_PREFIX}${ticket.execution?.name ?? ''}`
    )
    if (found === undefined) {
      throw new OrcaRuntimeError('workspace_missing', 'the ticket worktree is not in Orca', {
        values: { ticket: ticketId, path: ticket.execution.directory }
      })
    }
    return found
  }

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
  /** 写命令的幂等（§G.1 幂等行）：窗口/键/清理只有 `http/idempotency.ts` 一份。 */
  const idempotent = (
    input: { readonly token?: string; readonly requestId?: string | null; readonly at: string },
    work: () => unknown | Promise<unknown>
  ): Promise<unknown> =>
    runWrite({ store, token: input.token, requestId: input.requestId ?? null, at: input.at }, work)
  const domain = createDomainHandlers({
    report: (ticketId, report) => engine.report(ticketId, report),
    reply: (request) => engine.reply(request),
    note: (ticketId, text) => engine.note(ticketId, text),
    requestStatus: (ticketId) => engine.requestStatus(ticketId),
    handback: (ticketId, triggerId, reason) => engine.handback(ticketId, triggerId, reason),
    // 停止与重试是三条改变 Mandate 的操作里的两条（§E.5、§K.3）。重试的恢复说明由执行器
    // 拼一次（`executor/retry.ts`），这里只把 Ticket 交给它——避免第二个说法。
    stop: (ticketId, reason) => engine.stopTicket(ticketId, reason),
    retry: (ticketId) => retryTicket(engine, ticketId),
    // 本票的四条领域命令（§G.2 的 trigger requeue / thread follow / thread unrelated /
    // thread unsubscribe）：语义全在 Engine，HTTP 层只判固定码。
    reevaluate: (triggerId) => engine.reevaluate(triggerId),
    unsubscribe: (thread) => engine.unsubscribe(thread),
    markUnrelated: (ticketId, thread, reason) => engine.markUnrelated(ticketId, thread, reason),
    followForContext: (ticketId, ref, reason) => engine.followForContext(ticketId, ref, reason),
    threadOf: (key) => repo.threads.get(key),
    triggerOf: (id) => repo.triggers.get(id),
    owners: (trigger) => followupOwners(trigger, repo),
    ticketOf: (id) => repo.tickets.get(id),
    tickets: () => repo.tickets.list(),
    // 读模型里的「已投递到该 Ticket」：归属判定与扇出/交回同一份记录（`followupOwners`）。
    followups: (ticket) => deliveredFollowups(ticket, repo),
    // `report --pr-number` 的绑定（§I.2「PR 规则」行）：读那条 PR、判归属并绑给这张 Ticket；
    // 拒绝时整条命令落成固定码 `pr_mismatch`。没有 GitHub Source 时无从判归属，不接线。
    ...(githubReady
      ? {
          claimPull: (ticketId: string, pull: { readonly number: number }) =>
            claimReportedPull(pullHost, ticketId, pull.number)
        }
      : {}),
    idempotent,
    afterWrite: () => {
      refresh()
    }
  })
  // Router 的两条命令（§G.2 的 `route` / `eval-decide`）：策略判断在 `policy/assessment.ts`，
  // 领域写入经 Engine；版本是块的内容哈希（§K.5），块从设置里读（保存立刻生效）。
  const routerTools = createRouterTools({
    candidate: (triggerId) => engine.candidate(triggerId),
    policy: () => {
      const block = effectivePolicy()
      return { acceptMode: block.acceptMode, rules: block.rules }
    },
    policyVersion: () => policy.version,
    decide: (triggerId, outcome) => engine.decide(triggerId, outcome),
    attach: (ticketId, triggerId, note) => engine.attach(ticketId, triggerId, note),
    ticketOf: (id) => repo.tickets.get(id),
    log: (message) => logger.warn(message)
  })
  // Router 的两条评估读命令（§G.2 的 `eval` / `eval-read`）：窗口页数与超时来自部署设置
  // （§H.22），语境经 kind 的 `threadContext`（§I.1），`--path` 只允许 base repo 与 Ticket
  // worktree（§O）。候选、Trigger 与 worktree 都现读，重启后不必重建。
  const evalAdmission = admissionSettingsOf(settings)
  // base repo 的选择器可能只给了 name/id（§E.1）：能解析成路径就解析一次，解析不了就只认
  // Ticket worktree——`--path` 因此仍然 fail closed（§O），而不是猜一个目录。
  const baseRepoPath = await baseRepoPathOf(options.runtime, executorSettings.baseRepo)
  const evalRoots = (): readonly string[] => [
    ...(baseRepoPath === undefined ? [] : [baseRepoPath]),
    ...repo.tickets
      .list()
      .flatMap((ticket) => (ticket.execution === undefined ? [] : [ticket.execution.directory]))
  ]
  const evalTools = createEvalTools({
    candidate: (triggerId) => engine.candidate(triggerId),
    trigger: (triggerId) => repo.triggers.get(triggerId),
    threadContext: (trigger) => registry.threadContext(trigger, sourceSettings),
    commands: commandPort,
    admission: () => evalAdmission,
    roots: evalRoots,
    log: (message) => logger.info(message)
  })
  // `read <resource>` 的 Source 读面（§G.2 的 read 行、§I.2 的「资源读取」行、§I.3 的读法）：
  // 资源名路由到 kind 自己的读模块；Source 配置与 Trigger 现读（设置改了不必重建工具），
  // Ticket 现读（assignment 只能读自己 Ticket 相关的资源，§O）。
  const readTools = createReadTools({
    commands: commandPort,
    sourceConfig: (kind) => {
      const instance = registry.instance(kind, sourceSettings)
      return instance === undefined || !instance.enabled ? undefined : instance.config
    },
    trigger: (id) => repo.triggers.get(id),
    tickets: () => repo.tickets.list(),
    log: (message) => logger.info(message)
  })
  // §G.3 的视图读面（`read overview/sources/search/threads/thread/decisions/models`）：数据来自
  // 既有读模型（面板快照、注册表总览、角色解析、`find`、Ticket/Thread 仓储与时间线游标），
  // 视图本身不另建查询。`now` 由组合根给，`window=24h` 与「New in 24 h」在服务端换算。
  const viewReadTools = createViewReadTools({
    reader: { sql: store.sql },
    now,
    panel: () => stateSource.snapshot(),
    sources: () => registry.overview(),
    roles: () => roles,
    find: (query) => registry.find(query),
    threads: () => repo.threads.list(),
    thread: (key) => repo.threads.get(key),
    timeline: {
      tail: (key, limit) => store.triggerThreads.tail(key, limit),
      before: (key, cursor, limit) => store.triggerThreads.before(key, cursor, limit),
      after: (key, cursor, limit) => store.triggerThreads.timeline(key, { after: cursor, limit }),
      item: (key, cursor) => store.triggerThreads.item(key, cursor)
    },
    trigger: (id) => repo.triggers.get(id),
    disposition: (id) => repo.triggers.disposition(id),
    threadDecisions: (key) => repo.decisions.byThread(key),
    allDecisions: () => repo.decisions.list(),
    tickets: () => repo.tickets.list(),
    ticket: (id) => repo.tickets.get(id)
  })
  // Prompt 配置的读/写面（§L.4、§L.5）：版本库、部署事实与「保存后通知 Router」都在这里接线。
  // 部署事实给的是**路径**（CLI 的绝对路径、调用者自己的 token 文件），绝不写 token 值（§D.6）；
  // 保存产生新版本时，Router 保活器把 revision 换成一条短消息排队——不重启会话（§F.4）。
  const prompts = createPromptHandlers({
    versions: promptVersions,
    deployment: {
      // 一个请求自己的 token 文件：与它实际会用的那个会话一致（§G.4、§G.5）。
      environment: ({ caller }) => promptEnvironment(callerTokenFile(caller, resolved)),
      policy: promptPolicy
    },
    onSaved: (revision) => {
      // 新版本可能改了团队技能（新建/编辑/删除），先在磁盘上落地，再通知 Router 重读（§F.4）。
      syncSkills()
      routerSupervision.notifyPromptRevision(revision)
    },
    afterWrite: () => {
      refresh()
    }
  })
  /**
   * Prompts 组的面板读/写面的接线（§M.3）：与上面三条 HTTP 路由共用同一个版本库、同一份
   * 部署事实与同一个「保存后」钩子——面板上保存与 `prompts save` 的后果只有一套。
   * 环境段给的是操作者的 token **文件**（面板没有角色的概念，读的是主会话的那份）；
   * 每次调用现拼，所以设置与 Policy 改了之后一次读数就跟着变（§H.12）。
   */
  const operatorTokenFile = join(resolved, TOKENS_DIR, API_TOKEN_FILE)
  const promptPanelOptions = (): PromptPanelOptions => ({
    versions: promptVersions,
    stateDir: resolved,
    environment: () => promptEnvironment(operatorTokenFile),
    policy: promptPolicy,
    onSaved: (revision) => {
      syncSkills()
      routerSupervision.notifyPromptRevision(revision)
      refresh()
    }
  })
  // ---- 设置与名单同步的写面（§G.2 的 settings get/save 与 policy sync、§K.8）：写入器是
  // #20 的 `settingsWriter`，块的 strict schema 由 Policy（含各 Source 的 extras）与各 kind 的
  // config schema 提供，账号类字段（`cli`/`repository`）的写前检查是 #44 的探针，名单同步是
  // #23 的驱动器（`policySync` 在下面创建：端口用晚绑定的 holder，请求只会在启动之后到达）。
  let policySyncDriver: PolicySync | null = null
  const settingsHandlers = createSettingsHandlers({
    settings: settingsWriter,
    validate: (name) => {
      if (parseSettingsBlock(name) === undefined) return undefined
      return (value: unknown) =>
        validateSettingsBlock(name, value, {
          // Policy 块的字段表与跨 Source 的 extras 在 `policy/schema.ts`（§K.1）。
          policy: (candidate) => validatePolicy(candidate, { kinds: policyKind }),
          // Source 块的 config 键属于该 kind（§I.1）：只把它的 issues 接进同一份结果。
          sourceConfig: (id) => {
            const schema = registry.kind(id)?.schema
            return schema === undefined ? undefined : (config: unknown) => schema.safeParse(config)
          }
        }) ?? { success: true as const, data: value }
    },
    blocks: () => [
      'policy',
      'eval',
      'executor',
      ...Object.keys(sourceSettings.sources).map((id) => `source:${id}`)
    ],
    effective: (name) => {
      if (name === 'policy') return effectivePolicy()
      if (name === 'eval') return block(settings['eval'])
      if (name === 'executor') return block(settings['executor'])
      const parsed = parseSettingsBlock(name)
      return parsed?.kind === 'source'
        ? (sourceSettings.sources[parsed.id] ?? { enabled: false, config: {} })
        : null
    },
    // 账号类字段的写前 setup 检查（§K.8）：按候选值跑 #44 的探针，只回 github 那一组问题
    // （repository / CLI 账号）；不写 gitconfig、不改任何设置。
    checkAccount: async (candidate) => {
      const report = await runSetupChecks({
        ...setupInput(),
        ...(candidate.repository === undefined ? {} : { repository: candidate.repository }),
        ...(candidate.cli === undefined ? {} : { githubCli: candidate.cli }),
        gitConfig: undefined
      })
      return issuesOf(report.issues, 'github')
    },
    idempotent,
    policySync: {
      syncable: () => policySyncDriver?.syncable() ?? [],
      sync: (id) => {
        if (policySyncDriver === null) {
          throw new Error('the policy sync driver is not wired yet')
        }
        return policySyncDriver.sync(id)
      },
      // 同步前的名单：影响面从「现在生效的那份 Policy」算起（保存过就以存下来的为准）。
      allowed: (id) => effectivePolicy().sources[id]?.allowed ?? [],
      policy: () => ({
        revision: settingsWriter.blockRevision('policy'),
        version: savedSettingsVersion(store, 'policy')?.policyVersion ?? null
      })
    },
    afterWrite: () => {
      refresh()
    }
  })
  const routes: readonly RouteDefinition[] = withSettingsHandlers(
    withDecisionHandlers(
        withPromptHandlers(
          withReadHandlers(
            withEvalHandlers(
              withAssessmentHandlers(
                withDomainHandlers(ROUTE_TABLE, domain),
                createAssessmentHandlers({
                  tools: routerTools,
                  afterWrite: () => {
                    refresh()
                  }
                })
              ),
              createEvalHandlers({ tools: evalTools })
            ),
            createReadHandlers({ tools: readTools, views: viewReadTools })
          ),
          prompts
        ),
        createDecisionHandlers({
          // 面板的 dismiss（§K.7）：领域只接受 unavailable 的 Decision，其余给固定拒绝。
          dismiss: (decisionId) => engine.dismiss(decisionId),
          afterWrite: () => {
            refresh()
          }
        })
      ),
      settingsHandlers
    )

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
      setupCheck: () => checkSetup(),
      doctor: doctorNow
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
          api: githubApi,
          config: {
            repository: githubRepository,
            cli: githubCli,
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
          // Issue/PR 正文指纹也在这里命名（#18；#36 的 receive-all 复用同一个键）。
          bodyKey: githubBodyKey,
          // 一个 PR head 提交的 CI 指纹键也在这里命名（#19）。
          ciKey: githubCiKey,
          // receive-all 的仓库流与默认分支 CI 基线也在这里命名（#36）。
          streamKey: githubStreamKey,
          branchCiKey: githubBranchCiKey,
          // 读到 PR 就对账（§I.2「PR 规则」行）：绑定与结束都经领域命令，轮询器自己不写库。
          observePull: (pull) => {
            observePull(pullHost, pull)
          },
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

  // ---- 名单同步（§I.3「同步」行、§N.4 的 `sync:<id>` 健康条目）：启动时一次、手动
  // 「立即同步」、失败按 1 min→1 h 退避。能同步的条件：setup 完成、实例启用、part 点名了
  // 同步来源群。保存走 `settingsWriter`（origin=`sync`），所以策略版本与变更投递同一条路。
  const lifetimeAbort = new AbortController()
  const policySyncable = (): string[] => {
    if (!feishuSetup.enabled || feishuProblem() !== undefined) return []
    const instance = registry.instance(FEISHU_KIND)
    const sync = registry.kind(FEISHU_KIND)?.policy?.sync
    if (
      instance === undefined ||
      !instance.enabled ||
      instance.configError !== undefined ||
      sync === undefined
    ) {
      return []
    }
    const part = effectivePolicy().sources[FEISHU_KIND]
    return part !== undefined && sync.ready(part) ? [FEISHU_KIND] : []
  }
  const policySync: PolicySync = createPolicySync({
    current: effectivePolicy,
    revision: () => settingsWriter.blockRevision('policy'),
    save: (policy, expectedRevision) => {
      settingsWriter.save({
        block: 'policy',
        value: policy,
        origin: 'sync',
        expectedRevision,
        validate: (value) => validatePolicy(value, { kinds: policyKind })
      })
    },
    syncable: policySyncable,
    run: (id, part, signal) => {
      const sync = registry.kind(id)?.policy?.sync
      return sync === undefined
        ? Promise.reject(new Error(`The ${id} Source does not sync`))
        : sync.run(feishuHost, part, signal)
    },
    health: board,
    now,
    schedule: (run, milliseconds) => {
      // 测试关闭定时器：失败照记健康，但不在测试进程里排真实的重试。
      if (options.disableTimers === true) return () => undefined
      const timer = setTimeout(run, milliseconds)
      return () => clearTimeout(timer)
    },
    signal: lifetimeAbort.signal,
    log: (message) => logger.info(message)
  })
  policySyncDriver = policySync

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
    // `evals` 条目（§N.4）：1 h 内未解决的 unavailable 数量，写者就是 pass（与设计写者表一致）。
    evals: () => readEvalsHealth({ sql: store.sql }, now()),
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
  /**
   * 定时器驱动的轮（pass / poll / Feishu / 名单同步）。`shutdown()` 是关停屏障（#60）：
   * 它返回时这些轮必须已经结束，否则它们的写（inbox、日志、库）会落在关停之后。
   */
  const rounds = new Set<Promise<void>>()
  const trackRound = (work: Promise<unknown>): void => {
    const settled: Promise<void> = work.then(
      () => undefined,
      (error: unknown) => {
        logger.warn('a background round ended with an error', { error: stringOf(error) })
      }
    )
    rounds.add(settled)
    void settled.then(() => rounds.delete(settled))
  }
  if (options.disableTimers !== true) {
    const passTimer = setInterval(() => {
      trackRound(passOnce())
    }, options.passIntervalMs ?? PASS_INTERVAL_MS)
    timers.push(passTimer)
    const pollMs =
      options.pollIntervalMs ?? Math.max(10_000, Number(githubSetup.config['pollSeconds'] ?? 60) * 1000)
    if (poller !== null) {
      const pollTimer = setInterval(() => {
        trackRound(pollOnce())
      }, pollMs)
      timers.push(pollTimer)
    }
    if (feishuBackfill !== null) {
      // 第一轮立刻跑一次（安装完就能补上安装前一刻之后的），之后每分钟一轮。
      trackRound(feishuOnce())
      const feishuTimer = setInterval(() => {
        trackRound(feishuOnce())
      }, FEISHU_ROUND_MS)
      timers.push(feishuTimer)
    }
    for (const timer of timers) timer.unref?.()
  }
  // 事件流不靠定时器：配置好了就长驻监听（§I.3 实时事件）。
  const streaming = feishuStream === null ? null : feishuStream.run()
  // 名单同步的「启动时一次」：不等它（一次 CLI 读最多 60 s，不该挡住首屏），失败只写健康与日志。
  const startupSync = policySync.start()
  trackRound(startupSync)
  refresh()

  let closed = false
  /**
   * Source 页的读数（§M.2）：卡片要的输入全部经这个宿主取——注册表的总览、健康板、setup
   * 结论、kind 的字段与事实、outbox 的 drop 行与三个仓储的读面。面板不自己查库。
   */
  const sourceViewHost = (): SourceViewHost => ({
    now: now(),
    overview: () => registry.overview(),
    health: () => board.all(),
    setup: () => setup.issues(),
    kind: (id) => registry.kind(id),
    facts: () =>
      registry.facts(deployment(settings, { ...githubSetup, login: githubLogin() }, feishuSetup)),
    config: (id) => registry.instance(id)?.config,
    syncable: () => policySyncDriver?.syncable() ?? [],
    reader: { sql: store.sql },
    dropped: (since) => outbox.droppedSince(since),
    ticket: (id) => repo.tickets.get(id),
    trigger: (id) => repo.triggers.get(id),
    thread: (key) => repo.threads.get(key)
  })

  /**
   * 面板的「打开/关闭」（§M.2 的主操作）：写 `source:<id>` 的 `enabled`（下一个作业周期起按新
   * 状态判定监听与回复），并把本进程的 Source 视图换成新状态——注册表、Channel 与环境都读它。
   * 其余配置原样写回，这个动作不改 setup 字段。
   */
  const applySourceEnabled = (id: string, enabled: boolean): void => {
    if (id === GITHUB_KIND) githubSetup.enabled = enabled
    else if (id === FEISHU_KIND) feishuSetup.enabled = enabled
    sourceSettings = settingsView(settings, githubSetup, feishuSetup)
  }

  /** 一个 Source 必须已安装（面板只对已装的实例给开关）。 */
  const requireSource = (id: string): ResolvedSourceInstance => {
    const instance = registry.instance(id)
    if (instance === undefined) {
      throw Object.assign(new Error(`The ${id} Source is not installed`), { code: 'invalid_params' })
    }
    return instance
  }

  /** `source:<id>` 设置块的校验器（与 `PUT settings/:block` 同一份 §K.8 形状）。 */
  const sourceValidator = (id: string) => (value: unknown) =>
    validateSettingsBlock(`source:${id}`, value, {
      sourceConfig: () => {
        const schema = registry.kind(id)?.schema
        return schema === undefined ? undefined : (config: unknown) => schema.safeParse(config)
      }
    }) ?? { success: true as const, data: value }

  const setSourceEnabled = (id: string, enabled: boolean): SourcePageView => {
    const instance = requireSource(id)
    const name = `source:${id}`
    settingsWriter.save({
      block: name,
      value: { enabled, config: instance.config },
      origin: 'panel',
      expectedRevision: settingsWriter.blockRevision(name),
      validate: sourceValidator(id)
    })
    applySourceEnabled(id, enabled)
    refresh()
    return sourcePage(sourceViewHost())
  }

  /** 「立即同步」（§I.3）：与 `superagent policy sync` 同一个驱动器；不能同步时它自己拒绝。 */
  const syncSource = async (id: string): Promise<{ readonly allowed: number }> => {
    requireSource(id)
    if (policySyncDriver === null) {
      throw Object.assign(new Error('the list sync driver is not wired yet'), {
        code: 'invalid_params'
      })
    }
    const part = await policySyncDriver.sync(id)
    const allowed = Array.isArray(part['allowed']) ? part['allowed'].length : 0
    refresh()
    return { allowed }
  }

  /**
   * 「刷新显示名」（§G.2 的 `source labels`）：kind 自己重读行键显示名并写进它的 kv；
   * 这里只数新增了几条（同步前那份名单来自同一个键）。Kind 没有这个能力时拒绝。
   */
  const refreshSourceLabels = async (
    id: string
  ): Promise<{ readonly added: number; readonly total: number }> => {
    const instance = requireSource(id)
    if (!registry.canRefreshLabels(id)) {
      throw Object.assign(new Error(`The ${id} Source has no display names to refresh`), {
        code: 'invalid_params'
      })
    }
    const before = store.kvGet<Record<string, string>>(sourceLabelsKey(id)) ?? {}
    const labels = await registry.refreshLabels(
      id,
      createSourceContext({
        engine,
        store,
        commands: (options.commands ?? new Commands()).withSignal(),
        instance: { id, enabled: instance.enabled, config: instance.config, health: {} },
        configured: () => true,
        triggerOf: (triggerId) => repo.triggers.get(triggerId),
        notify: (input) => options.notify?.(input)
      })
    )
    const added = Object.keys(labels).filter((key) => !(key in before)).length
    refresh()
    return { added, total: Object.keys(labels).length }
  }

  const shutdown = async (): Promise<void> => {
    if (closed) return
    closed = true
    closing = true
    // 监督先停：关停期间不再发现「终端没了」并去 launch 新会话；还在跑的那一次 tick/restart
    // 先收尾（它会轮换 token、launch 会话），之后才拆后面的部件。
    await routerSupervision.stop()
    for (const timer of timers) clearInterval(timer)
    // 名单同步的待重试先取消；再关事件流（看门狗与 abort 都会停子进程）。
    lifetimeAbort.abort()
    policySync.stop()
    feishuAbort.abort()
    if (streaming !== null) await streaming
    options.statusBar?.dispose()
    await passes.stop()
    await effects.drain()
    // 定时器驱动的轮（poll / Feishu / 名单同步）也在写状态目录与库：等它们结束再拆 HTTP 与库。
    while (rounds.size > 0) await Promise.allSettled([...rounds])
    // 已经进到 handler 的请求同样要跑完（它们会写设置、技能文件与 token），再关库与日志。
    await http.close()
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
    policySync: () => startupSync,
    syncPolicy: (id) => policySync.sync(id),
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
    // 面板的「Retry」（§E.5）：同一个 handler 也是 `ticket retry` 的语义（§G.2），
    // 可重试与否由领域判定（不可重试时抛 `notRetryable`，main 把它折成固定拒绝）。
    retryTicket: (ticketId: string): PanelState => {
      retryTicket(engine, ticketId)
      return refresh()
    },
    // 面板不能直接聚焦终端（§M.2）：worker 跑 `orca terminal focus --terminal <handle>`。
    focusTerminal: (terminalId: string): Promise<void> => options.runtime.focusTerminal(terminalId),
    // Execution 页（§M.2）：列表与详情都是同一个读模型（`app/views.ts`），面板不自己筛。
    tickets: (input: TicketListInput): TicketListPage => panelTicketPage(repo.tickets.list(), input),
    ticketDetail: async (ticketId: string): Promise<TicketDetailView> => {
      const ticket = repo.tickets.get(ticketId)
      if (ticket === undefined) throw new UserError('unknownTicket', { ticket: ticketId })
      const terminal = await terminalSummary(ticket)
      return ticketDetail(
        ticket,
        { threads: repo.threads, triggers: repo.triggers },
        terminal === undefined ? {} : { terminal }
      )
    },
    // Trigger 页（§M.2）：列表、详情与两条动作都读/写同一份记录——时间线由 `trigger_thread`
    // 供（`(at, id)` 复合游标），归属判定就是 `followupOwners`。
    threads: (input: ThreadListInput): ThreadListPage =>
      threadListPage(threadRecords, { ...input, now: now() }),
    threadDetail: (threadKey: string, input: Omit<ThreadDetailInput, 'threadKey'>): ThreadDetailView => {
      const detail = threadDetailView(threadRecords, threadKey, input)
      if (detail === undefined) throw new UserError('unknownThread', { thread: threadKey })
      return detail
    },
    // `trigger requeue`（§G.2）：执行器仍拥有的人消息不能被绕过——那会绕开决定它的 worker
    // （§K.2 第 3 条）。已有 Eval 持有时如实回 false，不当成成功。
    requeueTrigger: (triggerId: string): boolean => {
      const trigger = repo.triggers.get(triggerId)
      if (trigger === undefined) throw new UserError('unknownTrigger')
      const owners = followupOwners(trigger, repo)
      if (owners.length > 0) throw new UserError('notRequeueable', { tickets: owners.join(',') })
      const queued = engine.reevaluate(triggerId)
      refresh()
      return queued
    },
    // `thread unsubscribe`（§G.2）：丢这条 Thread 上全部 Ticket 的订阅。没有订阅可丢时回
    // false（面板照实说，不当成「取消了」）。
    unsubscribeThread: (threadKey: string): boolean => {
      if (repo.threads.get(threadKey) === undefined) {
        throw new UserError('unknownThread', { thread: threadKey })
      }
      const removed = engine.unsubscribe(threadKey)
      refresh()
      return removed
    },
    // §E.5、§G.2：停止（撤回 Mandate）与重试是同一个领域写入面；note 只加一条语境，
    // request-status 只问已经在等的 worker（返回它是否真的发了一条问题）。
    stopTicket: (ticketId: string): PanelState => {
      engine.stopTicket(ticketId)
      return refresh()
    },
    noteTicket: (ticketId: string, text: string): PanelState => {
      engine.note(ticketId, text)
      return refresh()
    },
    requestStatus: (ticketId: string): boolean => {
      if (repo.tickets.get(ticketId) === undefined) {
        throw new UserError('unknownTicket', { ticket: ticketId })
      }
      const asked = engine.requestStatus(ticketId)
      refresh()
      return asked
    },
    // Eval 页（§M.2、§K.7）：列表/详情的待人工判定与 Overview 的 System problems 同一份读数。
    decisions: (input: DecisionListInput): DecisionListPage =>
      decisionPage(
        repo.decisions.list(),
        input,
        readUnavailableProblems({ sql: store.sql }, { now: now() })
      ),
    decisionDetail: (decisionId: string): DecisionDetailView => {
      const decision = repo.decisions.get(decisionId)
      if (decision === undefined) throw new UserError('unknownDecision', { decision: decisionId })
      return decisionDetail(
        decision,
        { threads: repo.threads, tickets: repo.tickets },
        readUnavailableProblems({ sql: store.sql }, { now: now() })
      )
    },
    // §K.7：只有 unavailable 能被 dismiss（领域同一条规则）；写后刷新快照与面板推送。
    dismissDecision: (decisionId: string): PanelState => {
      engine.dismiss(decisionId)
      return refresh()
    },
    // §M.2：面板没有打开/移除 worktree 的宿主方法，两者都由 worker 按 Ticket 记录的目录代理。
    openTicketWorkspace: async (ticketId: string): Promise<void> => {
      const workspace = await ticketWorkspaceOf(ticketId)
      await options.runtime.openWorkspace(workspace.workspaceId)
    },
    removeTicketWorkspace: async (ticketId: string): Promise<void> => {
      const workspace = await ticketWorkspaceOf(ticketId)
      await options.runtime.removeWorkspace(workspace)
    },
    checkSetup,
    // Source 页（§M.2）：每个配置过的 Source 一张卡，读数来自注册表、健康板与 outbox。
    sources: () => sourcePage(sourceViewHost()),
    setSourceEnabled,
    syncSource,
    refreshSourceLabels,
    // Deployment 页的三条读数（§M.3）：状态目录与限额只读；health 是健康板；Router 只读快照。
    deployment: () =>
      deploymentView({
        stateDir: resolved,
        setup: setup.issues(),
        limits,
        paused: paused.paused(),
        health: board.all(),
        router: routerSupervision.snapshot()
      }),
    doctor: doctorNow,
    // Prompts 组（§M.3）：读一份、预览草稿、保存、恢复——全部走 `app/prompt-view.ts` 的
    // 同一份校验，面板不重算任何规则。
    promptPanel: (): PanelPromptsView => promptPanelView(promptPanelOptions()),
    previewPrompts: (config: unknown): PanelPromptPreview =>
      previewPromptDraft(promptPanelOptions(), config),
    savePrompts: (input: { readonly config: unknown; readonly baseRevision: number }): PanelPromptsView =>
      savePromptConfig(promptPanelOptions(), input),
    restorePrompts: (input: {
      readonly revision: number
      readonly baseRevision: number
    }): PanelPromptsView => restorePromptVersion(promptPanelOptions(), input),
    rotateToken: () => {
      // §D.6、§O：只回文件路径；值不出现在任何读数里。
      const rotated = rotateApiToken(resolved)
      return { rotated: true, tokenFile: rotated.path }
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
      sources: { enabled: 0, problems: 0 },
      activity: { received: 0, evaluated: 0, accepted: 0, ignored: 0, ended: 0 },
      executor: { running: 0, maxWorkers: DEFAULT_MAX_WORKERS, humanSlot: 'free' }
    },
    attention: { answer: 0, review: 0, problems: 0, items: [] },
    problems: [],
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

/**
 * 调用者的 token **文件**路径（写进 prompt 的部署环境段，§G.5）：operator 用主 token 文件，
 * router 用 `tokens/router`，assignment 用 `tokens/<assignmentId>`。只写路径，不写值（§D.6）。
 */
function callerTokenFile(caller: RouteCaller, stateDir: string): string {
  if (caller.role === 'router') return join(stateDir, TOKENS_DIR, ROUTER_TOKEN_FILE)
  if (caller.role === 'assignment' && caller.assignmentId !== undefined) {
    return join(stateDir, TOKENS_DIR, caller.assignmentId)
  }
  return join(stateDir, API_TOKEN_FILE)
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
  /** 面板的开关会改它（§M.2「打开/关闭」）：其余字段仍是启动时读到的设置。 */
  enabled: boolean
  readonly config: Record<string, unknown>
  readonly cli: string
  readonly botId: string
  readonly appId: string
  readonly problem?: { readonly place: string; readonly code: string; readonly detail?: string }
}

/**
 * `executor.baseRepo` 的本地路径（`eval-read --path` 的根，§O）：`path:` 选择器直接用；
 * `name:`/`id:` 去 `orca repo list` 里找一次。找不到或 CLI 不可用就返回 undefined——
 * 根的缺失只会让 `--path` 拒绝，不会让 worker 启动失败。
 */
async function baseRepoPathOf(
  runtime: Pick<OrcaRuntime, 'listRepos'>,
  selector: { readonly path?: string; readonly name?: string; readonly id?: string } | undefined
): Promise<string | undefined> {
  if (selector === undefined) return undefined
  if (selector.path !== undefined) return selector.path
  try {
    const repos = await runtime.listRepos()
    return repos.find(
      (repo) =>
        (selector.id !== undefined && repo.id === selector.id) ||
        (selector.name !== undefined && repo.name === selector.name)
    )?.path
  } catch {
    return undefined
  }
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

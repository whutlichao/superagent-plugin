// 执行器的接线（§E.1–§E.4、§E.6、§J.2）：实现 `Executor` 端口（只排队），并把 `launch` /
// `delivery` 两个 effect handler 接到真实副作用队列上。
//
// 分工：
// - `Executor.start` / `deliver` 在领域事务内部被调用，只允许入队（先存后做，§J.2）；
// - `launch` handler：槽位 → worktree → 作业文本 `inbox/0.md` → 启动 agent → 记 running；
//   用尽重试时把 Ticket 标记 failed（队列的 `exhausted` 回调）；
// - `delivery` handler：把待投 Input 逐条落文件、发送、回读确认，成功一条记一条；
//   失败写在 Ticket 上（`quiet` 语义，§J.3），不动健康看板。
//
// 依赖纪律（§C.2）：本文件只 import core 的领域类型、`OrcaRuntime` 接口与 `app/effects` 的
// 队列形状；不 spawn、不 `host.call`（§B.1）。
import { join } from 'node:path'
import type { Assignment, Ticket, TicketInput, Trigger } from '../core/model.ts'
import type { Executor } from '../core/ports.ts'
import type { EngineForExecutor } from '../core/engine.ts'
import { Later, type EffectHandlerOptions, type EffectKind, type EffectPayloads } from '../app/effects.ts'
import type { OrcaRuntime, RepoSelector } from '../runtime/orca-runtime.ts'
import {
  deliverPendingInputs,
  DEFAULT_CONFIRM_DELIVERY,
  DEFAULT_INLINE_LIMIT,
  inboxPath,
  writeInboxFile,
  type DeliverySettings
} from './deliver.ts'
import { createBackgroundTracker, type BackgroundTracker } from './background.ts'
import { launchTicketAgent, type LaunchSettings } from './launch.ts'
import {
  EMPTY_DEPLOYMENT,
  environmentOf,
  type EnvironmentDeployment,
  type EnvironmentTable,
  type SourceEnvironmentContribution
} from './environment.ts'
import { ensureExcluded, writeEnvFile } from './env-file.ts'
import { launchEnvironment, launchHook as defaultLaunchHook, type LaunchHook } from './launch-hook.ts'
import { runPrepare } from './prepare.ts'
import { resumeAssignments, type ResumeReport } from './resume.ts'
import { writeCommandShims } from './shims.ts'
import { countSlots, DEFAULT_MAX_WORKERS, mayLaunch, mayWake, type SlotCounts } from './slots.ts'
import { createStatusHandler, type AgentStatusHandler } from './status.ts'
import { closeAssignmentTerminal } from './stop.ts'
import { ensureTicketWorkspace, type WorkspaceSettings } from './workspace.ts'
import { resolveAgentSetting } from '../app/agent-defaults.ts'

/** 作业文本（`inbox/0.md`）里正文的上限；更长的请求留在 Trigger/URL 里，不塞满文件。 */
export const BRIEF_TEXT_LIMIT = 4000

/** 执行器设置（§E.1–§E.4 的 `executor.*` 与清单里的 `agent`/`baseRepo`）。 */
export interface ExecutorSettings {
  /** `executor.agent`（缺省 `pi`，来自唯一的代码回落处 `app/agent-defaults.ts`）。 */
  readonly agent: string
  readonly model?: string
  readonly effort?: string
  /** `executor.maxWorkers`（缺省 2，§E.6）。 */
  readonly maxWorkers: number
  /** `executor.baseRepo`：必须显式选定的已存在 repo（§E.1）。 */
  readonly baseRepo?: RepoSelector
  readonly baseBranch?: string
  /** `executor.branchPrefix`（缺省 `agent/`）。 */
  readonly branchPrefix: string
  /** `executor.inlineLimit`（缺省 1000，附录 C S1）。 */
  readonly inlineLimit: number
  /** `executor.confirmDelivery`（缺省开，§E.4 第 4 步）。 */
  readonly confirmDelivery: boolean
  /** `executor.worktreeRetention`：缺省 `keep`，永不自动删（§E.1 清理行）。 */
  readonly worktreeRetention: 'keep' | 'on-end'
  /** `executor.prepare`：checkout 后置命令（§E.3），本票只读入并保留。 */
  readonly prepare?: string
  /** `executor.blockedCommands`：不可运行的个人 CLI 名单（§E.11；shim 与变量都用它）。 */
  readonly blockedCommands: readonly string[]
}

/** 队列只需要这两件事：入队与注册 handler（`Effects` 结构上满足它）。 */
export interface ExecutorEffectQueue {
  enqueue<K extends EffectKind>(kind: K, key: string, payload: EffectPayloads[K]): void
  handle<K extends EffectKind>(
    kind: K,
    run: (payload: EffectPayloads[K], key: string) => void | Promise<void>,
    options?: EffectHandlerOptions
  ): void
}

/** 执行器要读的仓储子集（组合根传 `Repositories`，测试传内存仓储）。 */
export interface ExecutorRecords {
  readonly tickets: {
    get(id: string): Ticket | undefined
    list(): readonly Ticket[]
  }
  readonly triggers: {
    get(id: string): Trigger | undefined
  }
}

/** 注册 effect handler 的依赖：全部注入，没有环境读取。 */
export interface RegisterExecutorOptions {
  readonly runtime: OrcaRuntime
  readonly effects: ExecutorEffectQueue
  readonly engine: EngineForExecutor
  readonly records: ExecutorRecords
  readonly settings: ExecutorSettings
  /** `<stateDir>`：inbox 与 token 文件都在它下面（§D.5）。 */
  readonly stateDir: string
  /** `superagent` CLI 的绝对路径（写进开播语与作业文本，§G.5）。 */
  readonly cliPath: string
  /** 每个 Assignment 的 token 文件路径（§D.6；本票只取路径，不签发）。 */
  readonly tokenFile: (assignmentId: string) => string
  /** 部署派生的事实（§E.11 的变量源）；缺省全空串，等 setup（#44）填。 */
  readonly deployment?: EnvironmentDeployment
  /** loopback API 基址（`SUPERAGENT_API`）；缺省空串。 */
  readonly apiBase?: string
  /** Source kind 对执行环境的额外贡献（§I.1；#17/#21 之后由组合根传入）。 */
  readonly sourceEnvironments?: readonly SourceEnvironmentContribution[]
  /** launch 钩子：`main.ts` 注册的是同一个实例，执行器在 launch 之前往里登记环境（§H.11）。 */
  readonly launchHook?: LaunchHook
  /** PATH 的底座（钩子载荷里拿不到宿主环境）；缺省取插件进程的 PATH。 */
  readonly path?: string
  /** 注入的等待（投递回读用）；测试不 sleep。 */
  readonly wait?: (milliseconds: number) => Promise<void>
  readonly log?: (message: string) => void
}

/** 生命周期（§E.5、§E.7–§E.10）要的依赖：seam、领域写入、仓储与注入的时钟。 */
export interface RegisterLifecycleOptions {
  readonly runtime: OrcaRuntime
  readonly engine: EngineForExecutor
  readonly records: ExecutorRecords
  /** 毫秒时钟（后台计时的起点与 30 分钟判定）。 */
  readonly now: () => number
  readonly log?: (message: string) => void
}

/** 启动时接上的一件事：resume 的结局（日志与面板用）。 */
export interface ExecutorLifecycle {
  /** 30 分钟后台工作（§E.9）：`poll()` 由 pass 定时调用，`state()` 给面板读。 */
  readonly background: BackgroundTracker
  /** `agent.status.changed` 的四态映射（§E.7）。 */
  readonly status: AgentStatusHandler
  /** 启动时认领或重建仍在跑的 Assignment（§E.10）。 */
  resume(): Promise<ResumeReport>
}

/** 一个设置项的字符串读法：去空白、空串当没有。 */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** 一个设置项的正整数读法（worker 数）：其余当没有。 */
function positive(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return undefined
  return value
}

/** 一个设置项的非负整数读法（`inlineLimit` 可以是 0：永远走指针）。 */
function nonNegative(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return undefined
  return value
}

/** 一个设置项的布尔读法。 */
function flag(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/**
 * 一个设置项的命令名单读法（`executor.blockedCommands`）：数组，或逗号/空白分隔的字符串。
 * 去空项、去重，保留顺序；其余形态当没有。
 */
function commandNames(value: unknown): readonly string[] {
  const raw: readonly unknown[] = Array.isArray(value)
    ? (value as readonly unknown[])
    : typeof value === 'string'
      ? value.split(/[\s,]+/)
      : []
  const names = raw
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item !== '')
  return [...new Set(names)]
}

/** 读取一个嵌套设置块；不是对象就当没有。 */
function block(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null ? (value as Readonly<Record<string, unknown>>) : {}
}

/**
 * 解析 `executor.baseRepo` 的选择器（§E.1 base repo 行）。写法与清单描述一致：
 * `path:<p>` / `name:<n>` / `id:<id>`；无前缀时绝对路径按 `path`、其余按 `name`。
 */
export function parseRepoSelector(value: string): RepoSelector | undefined {
  const text = value.trim()
  if (text === '') return undefined
  const prefixed = /^(path|name|id):(.*)$/.exec(text)
  if (prefixed) {
    const selector = (prefixed[2] ?? '').trim()
    if (selector === '') return undefined
    const kind = prefixed[1] as 'path' | 'name' | 'id'
    return { [kind]: selector }
  }
  return text.startsWith('/') ? { path: text } : { name: text }
}

/**
 * 把设置快照解析成执行器设置（§N.2）：缺项、空串、类型不对都回落设计缺省值，不猜测。
 * 形状是宿主 `orca.settings.get()` 的扁平表：`{ agent, baseRepo, executor: { … } }`。
 */
export function resolveExecutorSettings(raw: Readonly<Record<string, unknown>>): ExecutorSettings {
  const executor = block(raw['executor'])
  const model = text(executor['model'])
  const effort = text(executor['effort'])
  const baseRepo = parseRepoSelector(text(raw['baseRepo']) ?? '')
  const baseBranch = text(executor['baseBranch'])
  const prepare = text(executor['prepare'])
  return {
    agent: resolveAgentSetting(raw, 'agent'),
    maxWorkers: positive(executor['maxWorkers']) ?? DEFAULT_MAX_WORKERS,
    branchPrefix: text(executor['branchPrefix']) ?? 'agent/',
    inlineLimit: nonNegative(executor['inlineLimit']) ?? DEFAULT_INLINE_LIMIT,
    confirmDelivery: flag(executor['confirmDelivery']) ?? DEFAULT_CONFIRM_DELIVERY,
    worktreeRetention: text(executor['worktreeRetention']) === 'on-end' ? 'on-end' : 'keep',
    blockedCommands: commandNames(executor['blockedCommands']),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(baseRepo === undefined ? {} : { baseRepo }),
    ...(baseBranch === undefined ? {} : { baseBranch }),
    ...(prepare === undefined ? {} : { prepare })
  }
}

/** 一条错误的一行文本（日志与 Ticket 上的失败摘要）。 */
function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}

/**
 * 这次 launch 是不是人的唤醒：待投 Input 里有 `resumed`（人的消息恢复已结束 Ticket，§E.3）
 * 或人的 Trigger。它决定能不能用那一个人类槽（§E.6）。
 */
function isHumanWake(ticket: Ticket): boolean {
  return ticket.undelivered.some((id) => {
    const input = ticket.inputs.find((item: TicketInput) => item.id === id)
    return input?.kind === 'resumed' || (input?.kind === 'trigger' && input.human === true)
  })
}

/** 作业文本里正文的裁剪：超出上限就留一行说明，原文在 URL / Trigger 里。 */
function briefBody(text: string, original: string): string {
  if (text.length <= BRIEF_TEXT_LIMIT) return text
  return `${text.slice(0, BRIEF_TEXT_LIMIT)}\n\n… (truncated: ${
    text.length - BRIEF_TEXT_LIMIT
  } more characters; original: ${original})`
}

/** 开播后写进终端的一行指针：作业文本在文件里，终端的写入与回执都可观察（§E.4、§Q.1）。 */
export function assignmentPointer(path: string): string {
  return `[superagent] assignment ready: read ${path}`
}

/** 开播前写好的作业文本（`inbox/0.md`）：Ticket 卡 + 原始请求 + 环境 + 工作方式。 */
export function renderAssignmentBrief(options: {
  readonly ticket: Ticket
  readonly trigger: Trigger | undefined
  readonly short: string
  readonly directory: string
  readonly cliPath: string
  readonly tokenFile: string
  /** §E.11 的变量表：值写进正文，同时说明「不要把它们写进提交」。 */
  readonly environment: Readonly<Record<string, string>>
}): string {
  const { ticket, trigger } = options
  const request = trigger === undefined ? '(the originating message is not stored any more)' : briefBody(trigger.text, trigger.url ?? trigger.id)
  return [
    '# Assignment',
    '',
    `- ticket: ${ticket.id} "${ticket.title}"`,
    `- short: ${options.short}`,
    `- directory: ${options.directory}`,
    `- mandate: ${ticket.mandate.strength} · policy ${ticket.mandate.policyVersion} · scope ${ticket.mandate.scope}`,
    `- requested by: ${ticket.mandate.actor.source}:${ticket.mandate.actor.id}`,
    `- origin: ${trigger?.url ?? ticket.origin.triggerId}`,
    '',
    '## Request',
    '',
    request,
    '',
    '## Environment',
    '',
    `These variables are set for you and written to ${options.directory}/.superagent/env.sh (source it if you need them in a shell):`,
    '',
    ...Object.keys(options.environment).map((key) => `- ${key} = ${options.environment[key] ?? ''}`),
    '',
    'Never write these values, the state directory or the token file into a commit.',
    '',
    '## Working here',
    '',
    `- Every later input is written to this ticket's inbox and announced as \`[superagent] #<n>\`; read the named file before acting.`,
    `- Report with the CLI: node "${options.cliPath}" --token-file "${options.tokenFile}"`
  ].join('\n')
}

/**
 * 把执行器生命周期接到一处：状态事件交给 §E.7 的映射，并同时喂给 §E.9 的后台计时；启动时
 * 用同一个 seam 做 §E.10 的恢复。组合根只调这一个函数，三个行为因此共享同一份仓储读口。
 */
export function registerExecutorLifecycle(options: RegisterLifecycleOptions): ExecutorLifecycle {
  const background = createBackgroundTracker({
    records: options.records,
    runtime: options.runtime,
    now: options.now,
    ...(options.log === undefined ? {} : { log: options.log })
  })
  const status = createStatusHandler({
    engine: options.engine,
    records: options.records,
    runtime: options.runtime,
    background,
    ...(options.log === undefined ? {} : { log: options.log })
  })
  return {
    background,
    status,
    resume: () =>
      resumeAssignments({
        runtime: options.runtime,
        engine: options.engine,
        records: options.records,
        ...(options.log === undefined ? {} : { log: options.log })
      })
  }
}

/** `Executor` 端口：只把启动/投递意图排进效果队列，真正的 I/O 在 handler 里（§J.2）。 */
export class OrcaExecutor implements Executor {
  readonly #effects: ExecutorEffectQueue
  readonly #runtime: OrcaRuntime
  readonly #log: (message: string) => void

  constructor(options: {
    readonly effects: ExecutorEffectQueue
    readonly runtime: OrcaRuntime
    readonly log?: (message: string) => void
  }) {
    this.#effects = options.effects
    this.#runtime = options.runtime
    this.#log = options.log ?? (() => undefined)
  }

  /** 排队启动一个 pending Assignment（经 `launch` effect，§E.3）。 */
  start(ticket: Ticket, assignment: Assignment): void {
    this.#effects.enqueue('launch', ticket.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }

  /** 排队把等待中的 Input 投给运行中的 Assignment（经 `delivery` effect，§E.4）。 */
  deliver(ticket: Ticket, _assignment: Assignment): void {
    this.#effects.enqueue('delivery', ticket.id, { ticketId: ticket.id })
  }

  /**
   * 结束 Assignment 时关闭终端，worktree 保留（§E.5 stop/retry）。本方法是领域事务里的同步
   * 调用，所以只发起关闭、不等待：关闭失败（终端已消失）记日志即算完成，绝不打断事务。
   */
  stop(ticket: Ticket, assignment: Assignment, _reason?: string): void {
    if (assignment.terminalId === undefined) return
    // 事务已经提交（Assignment 已 ended）；终端关闭只是它的外部副作用，失败只记日志。
    void closeAssignmentTerminal(
      { ticket, assignment },
      { runtime: this.#runtime, log: this.#log }
    )
  }
}

/**
 * 把 `launch` 与 `delivery` 两种 effect 接到实现上（§E.3、§E.4）。
 * - `launch` 用尽 3 次重试后走 `exhausted`：Ticket 标记 failed，健康看板的 `launch` 行由队列
 *   自己报 error（§E.1 失败行）；
 * - `delivery` 是 `quiet`：失败只写在 Ticket 的 `delivery` 字段上，再由下一次成功清除（§J.3）。
 */
export function registerExecutorEffects(options: RegisterExecutorOptions): void {
  const { runtime, effects, engine, records, settings, stateDir, cliPath } = options
  const log = options.log ?? (() => undefined)
  const workspaceSettings: WorkspaceSettings = {
    branchPrefix: settings.branchPrefix,
    ...(settings.baseRepo === undefined ? {} : { baseRepo: settings.baseRepo }),
    ...(settings.baseBranch === undefined ? {} : { baseBranch: settings.baseBranch })
  }
  const launchSettings: LaunchSettings = {
    agent: settings.agent,
    ...(settings.model === undefined ? {} : { model: settings.model }),
    ...(settings.effort === undefined ? {} : { effort: settings.effort })
  }
  const deliverySettings: DeliverySettings = {
    inlineLimit: settings.inlineLimit,
    confirmDelivery: settings.confirmDelivery
  }
  /** 已经跑过 prepare 的 Assignment：同一条 launch effect 重放时不再跑第二遍（§E.3）。 */
  const prepared = new Set<string>()

  const launch = async (payload: EffectPayloads['launch']): Promise<void> => {
    const ticket = records.tickets.get(payload.ticketId)
    // 已结束的 Ticket、已结束或已跑起来的 Assignment：这条 effect 过期了，幂等地什么都不做。
    if (ticket === undefined || ticket.ended !== undefined) return
    const assignment = ticket.assignments.find((item) => item.id === payload.assignmentId)
    if (assignment === undefined || assignment.state === 'ended' || assignment.state === 'running') {
      return
    }
    // 自己这张 Ticket 的 pending 不算「占着槽」：要判的是它能不能占用下一个槽。
    const others = records.tickets.list().filter((item) => item.id !== ticket.id)
    if (!mayLaunch(others, settings.maxWorkers, isHumanWake(ticket))) {
      // 没有槽不是失败：到期再看（§E.6 末行、§J.2 `Later`）。
      throw new Later(`all ${settings.maxWorkers} worker slots are taken`)
    }
    const workspace = await ensureTicketWorkspace(runtime, { ticket, settings: workspaceSettings })
    const trigger = records.triggers.get(ticket.origin.triggerId)
    const tokenFile = options.tokenFile(assignment.id)
    // 执行环境先落盘：env.sh、它的 git 排除与被禁命令的 shim 都在 launch 之前就位（§E.11、§H.11）。
    const environment: EnvironmentTable = environmentOf({
      deployment: options.deployment ?? EMPTY_DEPLOYMENT,
      ticket: { id: ticket.id, name: workspace.short, directory: workspace.handle.path },
      plugin: {
        cliPath,
        tokenFile,
        ...(options.apiBase === undefined ? {} : { apiBase: options.apiBase })
      },
      blockedCommands: settings.blockedCommands,
      ...(trigger === undefined ? {} : { trigger }),
      ...(options.sourceEnvironments === undefined ? {} : { sources: options.sourceEnvironments })
    })
    try {
      const envPath = writeEnvFile({
        directory: workspace.handle.path,
        environment,
        ticketId: ticket.id
      })
      const excluded = ensureExcluded(workspace.handle.path)
      const shims = writeCommandShims({
        binDirectory: join(stateDir, 'bin'),
        blockedCommands: settings.blockedCommands
      })
      log(
        `environment for ${ticket.id}: ${envPath}` +
          (excluded?.added === true ? `, ignored in ${excluded.path}` : '') +
          (shims.written.length === 0 ? '' : `, shims ${shims.written.join(', ')}`)
      )
    } catch (error) {
      // 环境写不下去，这个 worktree 就不是一个可用的执行环境：直接记 failed，不重试（§E.3 同理）。
      markFailed(ticket.id, `execution environment failed: ${messageOf(error)}`)
      return
    }
    if (!prepared.has(assignment.id)) {
      try {
        const result = await runPrepare({
          runtime,
          ticketId: ticket.id,
          assignmentId: assignment.id,
          workspace: workspace.handle,
          command: settings.prepare,
          stateDir,
          environment
        })
        prepared.add(assignment.id)
        if (result.ran) log(`prepare ran for ${ticket.id} (${result.logPath})`)
      } catch (error) {
        // prepare 失败不是 launch 失败：重试同一条命令不会变好，Ticket 直接记 failed（§E.3）。
        markFailed(ticket.id, `prepare failed: ${messageOf(error)}`)
        return
      }
    }
    const briefPath = inboxPath(stateDir, ticket.id, 0)
    const brief = renderAssignmentBrief({
      ticket,
      trigger,
      short: workspace.short,
      directory: workspace.handle.path,
      cliPath,
      tokenFile,
      environment
    })
    writeInboxFile({ stateDir, ticketId: ticket.id, seq: 0, markdown: brief })
    const handle = await launchTicketAgent(runtime, {
      ticket,
      short: workspace.short,
      workspace: workspace.handle,
      settings: launchSettings,
      cliPath,
      tokenFile,
      inboxPath: briefPath,
      // 钩子只给这次 launch 追加环境：变量表 + PATH 前置 shim 目录 + worker 的 git 配置（§H.11）。
      environment: launchEnvironment({
        environment,
        binDirectory: join(stateDir, 'bin'),
        gitConfig: join(stateDir, 'worker-gitconfig'),
        basePath: options.path ?? process.env['PATH'] ?? ''
      }),
      launches: options.launchHook ?? defaultLaunchHook,
      ...(options.wait === undefined ? {} : { wait: options.wait })
    })
    // 作业文本已落盘（`inbox/0.md`），开播语也指向它；这里再往终端写一行指针（§E.4 的
    // sendText 形态、§Q.1 的「worktree → launch → sendText」顺序）。写不进去不把 launch
    // 判成失败：agent 已经跑起来，终端写入由下一次投递重试。
    try {
      const receipt = await runtime.sendText(handle.terminalId, assignmentPointer(briefPath), {
        enter: true
      })
      if (!receipt.accepted) log(`the assignment pointer for ${ticket.id} was not accepted`)
    } catch (error) {
      log(`could not write the assignment pointer for ${ticket.id}: ${messageOf(error)}`)
    }
    engine.assignmentStarted(ticket.id, assignment.id, {
      terminalId: handle.terminalId,
      workspace: { short: workspace.short, directory: workspace.handle.path, assignment: brief }
    })
    log(`launched ${ticket.id} in ${workspace.handle.path} as ${handle.terminalId}`)
  }

  const deliver = async (payload: EffectPayloads['delivery']): Promise<void> => {
    const ticket = records.tickets.get(payload.ticketId)
    if (ticket === undefined || ticket.ended !== undefined) return
    const running = ticket.assignments.find((item) => item.state === 'running')
    // 还没有终端（launch 未完成）：launch 成功后的 `assignmentStarted` 会再排一次投递。
    if (running?.terminalId === undefined) return
    if (ticket.undelivered.length === 0) return
    // 唤醒一个已经在跑的 worker 不新增槽；只有账已经超过「普通 + 人类」容量时才等。
    const counts: SlotCounts = countSlots(records.tickets.list())
    if (!mayWake(counts.occupied, settings.maxWorkers)) {
      throw new Later('the executor is over its worker capacity')
    }
    try {
      await deliverPendingInputs(runtime, {
        ticket,
        terminalId: running.terminalId,
        stateDir,
        settings: deliverySettings,
        triggerOf: (triggerId) => records.triggers.get(triggerId),
        // 成功一条记一条：重试不会重复投已经送达的 Input。
        onDelivered: (inputId) => engine.inputsDelivered(ticket.id, running.id, [inputId]),
        ...(options.wait === undefined ? {} : { wait: options.wait })
      })
    } catch (error) {
      // `delivery` 是 quiet kind：失败写在 Ticket 上，健康看板只留计数（§J.3）。
      engine.deliveryFailed(ticket.id, running.id, messageOf(error))
      throw error
    }
  }

  /** 把 Ticket 标记 failed（执行器自己的报告；Assignment 已结束/已换人时只记日志）。 */
  const markFailed = (ticketId: string, summary: string): void => {
    const ticket = records.tickets.get(ticketId)
    if (ticket === undefined || ticket.ended !== undefined) return
    try {
      engine.report(ticketId, { state: 'failed', summary })
      log(`failed ${ticketId}: ${summary}`)
    } catch (reportError) {
      // Assignment 在此期间结束（例如人 retry/stop）：不再写报告，留日志即可。
      log(`could not mark ${ticketId} failed: ${messageOf(reportError)}`)
    }
  }

  const exhausted = (key: string, error: unknown): void => {
    markFailed(key, `launch failed: ${messageOf(error)}`)
  }

  effects.handle('launch', launch, { exhausted })
  effects.handle('delivery', deliver)
}

// worker agent 的启动（§E.2）：terminal 面的 launch、短开播语、回执缺句柄时的反查、
// 一次重试。所有动作都经 `OrcaRuntime`（§B.1）：本文件不 spawn、不 `host.call`，
// 所以 CLI 与 Host API 的差别留在 seam 的实现里（§B.3）。
//
// 回执字段（附录 C S2 实测，Orca 1.4.251）：
//   CLI  `orca agent launch --json` → `result.launch.outcome.handle`（旧宿主 `result.agentTerminalHandle`）
//   Host `agent.launch`            → `{ terminalId }`
// seam 的 `launchAgent` 把两者收敛成一个 `AgentHandle`；拿不到句柄时抛 `agent_gone`，
// 由这里按 `workspaceId` 反查（§E.2 回执行）。
import { isOrcaRuntimeError } from '../runtime/orca-runtime.ts'
import type { AgentHandle, AgentSpec, OrcaRuntime, WorkspaceHandle } from '../runtime/orca-runtime.ts'
import type { Ticket } from '../core/model.ts'
import type { LaunchHook } from './launch-hook.ts'

/** 开播语上限（§E.2：≤ 400 字符，长正文一律写文件）。 */
export const SEED_PROMPT_MAX = 400

/** 回执缺句柄后的反查窗口与间隔（§E.2 回执行：最多 10 s、200 ms）。 */
export const LOOKUP_WINDOW_MS = 10_000
export const LOOKUP_INTERVAL_MS = 200

/** 启动 worker 需要的设置（§E.2 的 `executor.*` 项）。 */
export interface LaunchSettings {
  /** Orca agent id（不猜测；缺省由设置层给 `pi`）。 */
  readonly agent: string
  /** 透传给 CLI 的 model id；缺省即不传（让宿主的默认模型生效）。 */
  readonly model?: string
  /** 透传给 CLI 的 reasoning effort；缺省即不传。 */
  readonly effort?: string
}

/** 开播语要用到的执行事实（§E.2、§G.5：只给路径，不给 token 值）。 */
export interface SeedPromptInput {
  readonly ticketId: string
  readonly short: string
  /** worktree 绝对路径。 */
  readonly directory: string
  /** `superagent` CLI 的绝对路径（`node "<cli>"` 的形式在 prompt 里给出）。 */
  readonly cliPath: string
  /** 本次 Assignment 的 token 文件绝对路径。 */
  readonly tokenFile: string
  /** 第一份输入的绝对路径（`inbox/0.md`）。 */
  readonly inboxPath: string
}

/** 反查的节奏（测试可缩短；缺省即 §E.2 的 10 s / 200 ms）。 */
export interface LookupOptions {
  readonly windowMs?: number
  readonly intervalMs?: number
}

/** `launchTicketAgent` 的输入。 */
export interface LaunchAgentOptions {
  readonly ticket: Pick<Ticket, 'id' | 'title'>
  readonly short: string
  readonly workspace: WorkspaceHandle
  readonly settings: LaunchSettings
  readonly cliPath: string
  readonly tokenFile: string
  readonly inboxPath: string
  /**
   * 这次 launch 要注入的环境（§E.11 + PATH/GIT_CONFIG_GLOBAL）：启动之前在钩子上登记，
   * 由 `agent.launch.before` 在宿主真正起进程时合并（§H.11）。
   */
  readonly environment?: Readonly<Record<string, string>>
  /** 钩子注册表：与 `main.ts` 注册的那个是同一个实例；缺省不登记（不注入）。 */
  readonly launches?: LaunchHook
  /** 等待实现的注入点：测试用即时返回并记录间隔的等待，绝不 sleep（§P.1）。 */
  readonly wait?: (milliseconds: number) => Promise<void>
  readonly lookup?: LookupOptions
}

/** 默认等待：真定时器，只在生产路径上用；测试一律注入。 */
const realWait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

/**
 * 开播语：角色声明 + Ticket id/短名 + 目录 + CLI 绝对路径与 token 文件 + 「先读第一份输入」。
 * 只写路径不写 token 值（§D.6）；**单行**且 ≤ 400 字符——终端不吞长文本，多行会被当成多次
 * 提交（附录 C S1）。
 */
export function seedPrompt(input: SeedPromptInput): string {
  const role = `You are the superagent worker for ticket ${input.ticketId} (${input.short}).`
  const where = `Work only inside ${input.directory}.`
  const cli = `CLI: node "${input.cliPath}" --token-file "${input.tokenFile}".`
  const task = `Read ${input.inboxPath} first and follow it.`
  // 长部署路径下依次丢掉最不重要的部分：最后留下的必须是「先读哪份文件」这条指令。
  const candidates = [
    [role, where, cli, task].join(' '),
    [where, cli, task].join(' '),
    [cli, task].join(' '),
    [task, cli].join(' '),
    task
  ]
  const line = candidates.find((candidate) => candidate.length <= SEED_PROMPT_MAX) ?? task
  // 只剩这一条也超限（极端路径）：截断它，任务正文在 inbox 文件里、不靠这一行携带。
  return line.length <= SEED_PROMPT_MAX ? line : `${line.slice(0, SEED_PROMPT_MAX - 1)}…`
}

/** 只把配置过的 model/effort 放进 spec：不配置就是「不传」，而不是传空串。 */
function agentSpec(
  base: Omit<AgentSpec, 'model' | 'effort'>,
  model: string | undefined,
  effort: string | undefined
): AgentSpec {
  if (model !== undefined && effort !== undefined) return { ...base, model, effort }
  if (model !== undefined) return { ...base, model }
  if (effort !== undefined) return { ...base, effort }
  return base
}

/** 一次启动尝试：成功返回句柄；`agent_gone` 时先反查，反查不到才把错误交回调用方。 */
async function attempt(
  runtime: OrcaRuntime,
  spec: AgentSpec,
  options: LaunchAgentOptions
): Promise<AgentHandle> {
  // 只把「本插件发起的这次 launch」告诉钩子；无论成功、失败还是钩子根本没来，都要释放。
  const release = options.launches?.expect({
    workspaceId: spec.workspace.workspaceId,
    environment: options.environment ?? {}
  })
  try {
    return await runtime.launchAgent(spec)
  } catch (error) {
    if (!isOrcaRuntimeError(error) || error.code !== 'agent_gone') throw error
    const found = await lookup(runtime, spec.workspace.workspaceId, options)
    if (found) return found
    throw error
  } finally {
    release?.()
  }
}

/**
 * 回执缺终端句柄时按 `workspaceId` 反查已启动的 agent：`windowMs` 内每 `intervalMs` 一次，
 * 命中即用。它替代「重新 launch」——重发会开出第二个 agent 终端（§E.2 回执行）。
 */
async function lookup(
  runtime: OrcaRuntime,
  workspaceId: string,
  options: LaunchAgentOptions
): Promise<AgentHandle | null> {
  const intervalMs = options.lookup?.intervalMs ?? LOOKUP_INTERVAL_MS
  const windowMs = options.lookup?.windowMs ?? LOOKUP_WINDOW_MS
  const wait = options.wait ?? realWait
  const polls = Math.max(1, Math.ceil(windowMs / intervalMs))
  for (let poll = 0; poll <= polls; poll += 1) {
    const found = await runtime.findAgent(workspaceId)
    if (found) return found
    if (poll < polls) await wait(intervalMs)
  }
  return null
}

/**
 * 启动一个 Ticket 的 worker agent。必须 terminal 面（插件要 terminalId 才能投递与停止）；
 * `agent`/`model`/`effort` 全部来自设置且不猜测；回执缺句柄 → 反查 → 仍无 → 重试一次 →
 * `agent_gone` 交给 effect 的 `exhausted` 让 Ticket failed（§E.1 失败行、§E.2 回执行）。
 */
export async function launchTicketAgent(
  runtime: OrcaRuntime,
  options: LaunchAgentOptions
): Promise<AgentHandle> {
  const prompt = seedPrompt({
    ticketId: options.ticket.id,
    short: options.short,
    directory: options.workspace.path,
    cliPath: options.cliPath,
    tokenFile: options.tokenFile,
    inboxPath: options.inboxPath
  })
  const base = {
    workspace: options.workspace,
    agent: options.settings.agent,
    surface: 'terminal' as const,
    prompt
  }
  const spec = agentSpec(base, options.settings.model, options.settings.effort)

  try {
    return await attempt(runtime, spec, options)
  } catch (error) {
    // 「重试一次」：只有 agent_gone 值得再来一次；其余错误（cli_failed 等）交给 effect 退避。
    if (!isOrcaRuntimeError(error) || error.code !== 'agent_gone') throw error
    return await attempt(runtime, spec, options)
  }
}

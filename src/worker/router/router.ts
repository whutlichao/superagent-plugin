// 常驻 Router 的启动件（§F.1）：专用 worktree 的建/复用 + terminal 面的 launch。
//
// 两件事分开写，因为它们各自失败的方式不同：worktree 失败由监督的退避重试；launch 的
// 回执行缺终端句柄时先按 `workspaceId` 反查（与 worker 同一条 §E.2 兜底），反查不到才
// 算失败。两次 launch 不在这一层重试——那会开出第二个 Router 终端；重试归监督（§F.5）。
//
// 依赖纪律（§C.2）：只 import core 的仓储设置类型、`OrcaRuntime` 接口与 prompt 组装；
// 不 spawn、不 `host.call`，也不 import executor（规则 5：两者互不引用）。
import { basename } from 'node:path'
import { isOrcaRuntimeError } from '../runtime/orca-runtime.ts'
import type {
  AgentHandle,
  AgentSpec,
  OrcaRuntime,
  RepoSelector,
  WorkspaceHandle,
  WorkspaceInfo
} from '../runtime/orca-runtime.ts'

/** 专用 worktree 的名字（固定，已存在即复用；§F.1）。 */
export const ROUTER_WORKSPACE_NAME = 'superagent-router'

/** 建/复用 Router worktree 需要的设置（与执行器同一份 `executor.*` 设置，§F.1）。 */
export interface RouterWorkspaceSettings {
  /** `executor.baseRepo`：必须显式选定的已存在 repo。 */
  readonly baseRepo?: RepoSelector
  /** `executor.baseBranch`；未配置时传 `HEAD`（与 Ticket worktree 同一口径）。 */
  readonly baseBranch?: string
}

/** 复用或新建之后的工作区。 */
export interface RouterWorkspace {
  readonly handle: WorkspaceHandle
  /** 这次是否新建（`false`＝复用了已有 checkout 或用户手工开的工作区）。 */
  readonly created: boolean
}

/** Router 会话的启动设置（`settings.router.*` + 清单里的 `routerAgent`）。 */
export interface RouterLaunchSettings {
  readonly agent: string
  readonly model?: string
  readonly effort?: string
}

/** 一次 launch 的输入：工作区、角色设置与已经拼好的 prompt。 */
export interface LaunchRouterOptions {
  readonly workspace: WorkspaceHandle
  readonly settings: RouterLaunchSettings
  readonly prompt: string
}

/** 一个工作区是不是 Router 那个目录：路径的最后一段或 display name 命中固定名字。 */
function isRouterWorkspace(workspace: WorkspaceInfo): boolean {
  return workspace.name === ROUTER_WORKSPACE_NAME || basename(workspace.path) === ROUTER_WORKSPACE_NAME
}

/**
 * 建或复用 Router 的专用 worktree。顺序与设计一致（§F.1）：
 * 1. `workspace.list()` 里已有路径命中 `superagent-router`（含用户手工开的同名 folder
 *    workspace）→ 按路径采用，不再建；
 * 2. 否则用固定名字建一个（`--setup skip --no-parent`，与 Ticket worktree 同一组参数）。
 *
 * 先自己查路径而不是只靠 `ensureWorkspace`：seam 的复用判据是 display name / 分支（§B.3），
 * 而设计要的是**路径**——用户把 folder workspace 起成别的名字时，只有按路径才认得回来。
 */
export async function ensureRouterWorkspace(
  runtime: OrcaRuntime,
  settings: RouterWorkspaceSettings
): Promise<RouterWorkspace> {
  const workspaces = await runtime.listWorkspaces()
  const reused = workspaces.find(isRouterWorkspace)
  if (reused !== undefined) {
    return {
      handle: {
        workspaceId: reused.workspaceId,
        path: reused.path,
        branch: reused.branch,
        created: false
      },
      created: false
    }
  }
  const args = {
    name: ROUTER_WORKSPACE_NAME,
    baseBranch: settings.baseBranch ?? 'HEAD',
    setup: 'skip' as const,
    parent: 'none' as const,
    activate: false
  }
  const handle = await runtime.ensureWorkspace(
    settings.baseRepo === undefined ? args : { ...args, repo: settings.baseRepo }
  )
  return { handle, created: handle.created }
}

/** 只把配置过的 model/effort 放进 spec：不配置就是「不传」，不是传空串。 */
function agentSpec(options: LaunchRouterOptions): AgentSpec {
  const base: Omit<AgentSpec, 'model' | 'effort'> = {
    workspace: options.workspace,
    agent: options.settings.agent,
    surface: 'terminal',
    prompt: options.prompt
  }
  const { model, effort } = options.settings
  if (model !== undefined && effort !== undefined) return { ...base, model, effort }
  if (model !== undefined) return { ...base, model }
  if (effort !== undefined) return { ...base, effort }
  return base
}

/**
 * 启动 Router 会话：与 worker 同一条 `launchAgent` 路径，`surface: 'terminal'` 恒定（插件要
 * `terminalId` 才能 relay、探活与关闭）。回执缺句柄时按 `workspaceId` 反查一次（§E.2 的兜底），
 * 仍拿不到才把错误交回调用方——重试归监督，因为「再 launch 一次」会开出第二个会话。
 */
export async function launchRouter(
  runtime: OrcaRuntime,
  options: LaunchRouterOptions
): Promise<AgentHandle> {
  try {
    return await runtime.launchAgent(agentSpec(options))
  } catch (error) {
    if (!isOrcaRuntimeError(error) || error.code !== 'agent_gone') throw error
    const found = await runtime.findAgent(options.workspace.workspaceId)
    if (found !== null) return found
    throw error
  }
}

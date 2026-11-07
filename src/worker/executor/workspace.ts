// 每个 Ticket 的 worktree（§E.1）：短名派生、复用已有的 checkout、按文档的创建参数建新的。
//
// 这一层只把「一个 Ticket」翻译成 `WorkspaceSpec`（seam 的唯一输入）与复用判断；真正跑
// `orca worktree create` 的是 `OrcaRuntime.ensureWorkspace` 的实现（§B.3）。所以本文件里
// 没有子进程、没有 Orca 类型——它只依赖 seam 接口与领域类型（§C.2）。
//
// 设计里的创建命令与 `WorkspaceSpec` 的对应（测试逐字段断言这个映射）：
//   orca worktree create --name <name> --repo path:<baseRepoPath> --base-branch <ref>
//     --branch <branch> --setup skip --no-parent --json
//   → { name, repo, baseBranch, branch, setup: 'skip', parent: 'none', activate: false }
import type { Ticket } from '../core/model.ts'
import type {
  OrcaRuntime,
  RepoSelector,
  WorkspaceHandle,
  WorkspaceInfo,
  WorkspaceSpec
} from '../runtime/orca-runtime.ts'

/** 短名只允许小写字母、数字与连字符，长度 3–40（§E.1 命名行）。 */
export const SHORT_NAME_PATTERN = /^[a-z0-9-]{3,40}$/

/** 短名长度上限：命令行、分支名与目录名都要短。 */
export const SHORT_NAME_MAX = 40

/** 短名冲突时追加的序号上限：超过就说明有人在滥用，报错比无限加号好。 */
export const SHORT_NAME_ATTEMPTS = 50

/** worktree 名字的前缀；`superagent-<short>`（§E.1）。 */
export const WORKTREE_PREFIX = 'superagent-'

/** Ticket 的 worktree 规划（§E.1）：seam 的句柄 + 派生出的短名 + 是否新建。 */
export interface TicketWorkspace {
  /** seam 返回（或复用命中）的工作区句柄。 */
  readonly handle: WorkspaceHandle
  /** 派生出的短名（`superagent-` 之后那一段）。 */
  readonly short: string
  /** 是否这次新建（`false`＝复用了已有 checkout）。 */
  readonly created: boolean
}

/** 建/复用 worktree 需要的设置（§E.1 的 `executor.*` 项）。 */
export interface WorkspaceSettings {
  /** `executor.baseRepo`：必须显式选定的已存在 repo。 */
  readonly baseRepo?: RepoSelector
  /** `executor.baseBranch`；未配置时传 `HEAD`（§E.1 base ref 行）。 */
  readonly baseBranch?: string
  /** `executor.branchPrefix`，缺省 `agent/`。 */
  readonly branchPrefix: string
}

/** `ensureTicketWorkspace` 的输入：Ticket 只管短名来源，设置管仓库与分支。 */
export interface EnsureWorkspaceOptions {
  readonly ticket: Ticket
  readonly settings: WorkspaceSettings
}

/** 把任意文本规范成短名字符：小写、非字母数字变 `-`、折叠、去首尾、截到上限。 */
export function sanitizeShort(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SHORT_NAME_MAX)
    .replace(/-+$/g, '')
}

/**
 * 派生短名：accept 带来的 `worktree_name` 优先（已经是合法短名就原样用），否则把标题
 * 规范成短名；标题也产不出 3 个字符时用 ticket id 的稳定后缀兜底（确定性：同一张 Ticket
 * 每次得到同一个短名，崩溃恢复因此能认回同一个 worktree）。
 */
export function shortName(requested: string | undefined, title: string, ticketId: string): string {
  if (requested !== undefined && SHORT_NAME_PATTERN.test(requested)) return requested
  const fromRequested = requested === undefined ? '' : sanitizeShort(requested)
  if (SHORT_NAME_PATTERN.test(fromRequested)) return fromRequested
  const fromTitle = sanitizeShort(title)
  if (SHORT_NAME_PATTERN.test(fromTitle)) return fromTitle
  // 标题全是非 ASCII 或太短：用 id 的前 8 个十六进制字符，前缀 `t` 保证字母开头。
  return `t${ticketId.replace(/[^a-z0-9]/g, '').slice(0, 8)}`
}

/** 已存在的工作区名字里占用的短名（`superagent-<short>` 之后那一段）。 */
export function takenShorts(workspaces: readonly WorkspaceInfo[], branchPrefix: string): Set<string> {
  const taken = new Set<string>()
  for (const workspace of workspaces) {
    if (workspace.name.startsWith(WORKTREE_PREFIX)) {
      taken.add(workspace.name.slice(WORKTREE_PREFIX.length))
    }
    if (workspace.branch?.startsWith(branchPrefix)) {
      taken.add(workspace.branch.slice(branchPrefix.length))
    }
  }
  return taken
}

/** 冲突时追加 `-2`、`-3` …（§E.1 命名行）。 */
export function uniqueShort(short: string, taken: ReadonlySet<string>): string {
  if (!taken.has(short)) return short
  for (let attempt = 2; attempt < SHORT_NAME_ATTEMPTS + 2; attempt += 1) {
    const suffix = `-${attempt}`
    const candidate = `${short.slice(0, SHORT_NAME_MAX - suffix.length)}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
  throw new Error(`No free worktree name for ${short}`)
}

/** Ticket 的 worktree 名与分支名（§E.1 命名行）。 */
export function workspaceNames(
  short: string,
  branchPrefix: string
): { readonly name: string; readonly branch: string } {
  return { name: `${WORKTREE_PREFIX}${short}`, branch: `${branchPrefix}${short}` }
}

/** 按路径、分支或名字找已有的 worktree（§E.1 复用行：崩溃恢复不重建）。 */
function existing(
  workspaces: readonly WorkspaceInfo[],
  names: { readonly name: string; readonly branch: string },
  directory: string | undefined
): WorkspaceInfo | undefined {
  // 只认「记录的目录」与「我们自己的分支」：name 是 Orca 的 displayName，重名时 Orca 会给
  // **路径**加 `-2` 而不改 displayName（附录 C S3），拿它当复用键会认错别人的 checkout。
  return workspaces.find(
    (workspace) =>
      (directory !== undefined && workspace.path === directory) || workspace.branch === names.branch
  )
}

/** 复用的工作区实际占用的短名（Orca 可能自己加过 `-2`，以它为准）。 */
function shortOf(
  workspace: WorkspaceInfo,
  base: string,
  branchPrefix: string
): string {
  if (workspace.name.startsWith(WORKTREE_PREFIX)) {
    return workspace.name.slice(WORKTREE_PREFIX.length)
  }
  if (workspace.branch?.startsWith(branchPrefix)) {
    return workspace.branch.slice(branchPrefix.length)
  }
  return base
}

/**
 * 为一个 Ticket 建或复用 worktree。顺序是「先看已有的，再建」：
 * 1. `listWorkspaces()` 按记录的目录、分支或名字命中 → 直接复用（`created: false`）；
 * 2. 否则用文档的创建参数建一个新的（`--setup skip`、`--no-parent`，§E.1）；
 * 3. 短名冲突时追加 `-2` …；Orca 自己也会加后缀，所以创建后以回执为准。
 */
export async function ensureTicketWorkspace(
  runtime: OrcaRuntime,
  options: EnsureWorkspaceOptions
): Promise<TicketWorkspace> {
  const { ticket, settings } = options
  const workspaces = await runtime.listWorkspaces()
  const base = shortName(ticket.execution?.name, ticket.title, ticket.id)
  // 先按「本 Ticket 的短名」找已有的：命中就复用，不因为名字被自己占用而加 `-2`。
  const reuse = existing(
    workspaces,
    workspaceNames(base, settings.branchPrefix),
    ticket.execution?.directory
  )
  if (reuse) {
    return {
      handle: {
        workspaceId: reuse.workspaceId,
        path: reuse.path,
        branch: reuse.branch,
        created: false
      },
      short: shortOf(reuse, base, settings.branchPrefix),
      created: false
    }
  }
  // 没有可复用的：短名若被别的工作区占用就追加 `-2` …，再按最终名字建。
  const short = uniqueShort(base, takenShorts(workspaces, settings.branchPrefix))
  const names = workspaceNames(short, settings.branchPrefix)
  const args = {
    name: names.name,
    branch: names.branch,
    baseBranch: settings.baseBranch ?? 'HEAD',
    setup: 'skip' as const,
    parent: 'none' as const,
    activate: false
  }
  const spec: WorkspaceSpec =
    settings.baseRepo === undefined ? args : { ...args, repo: settings.baseRepo }
  const handle = await runtime.ensureWorkspace(spec)
  return { handle, short, created: handle.created }
}

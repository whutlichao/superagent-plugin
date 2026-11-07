// setup 探针的结论类型与纯函数（§I.4、§N.1、§N.2、§O）。
//
// 与 `doctor`（`doctor-types.ts`）分工不同：doctor 回答「本机各处是有还是没有、坏了没有」，
// 是诊断；setup 回答「插件现在能不能开工」，是启动条件。一个 setup 问题**只挡住受影响的那
// 部分**（Source 停在 setup/starting，不是 error），并给一条修法与「检查一次」的入口。
//
// 红线（§O、§N.5）：结论只写「有没有 / 缺什么」，绝不出现 token、密钥或消息正文。

/** setup 问题归属的部件（决定谁被挡住，也决定面板放在哪张卡上）。 */
export type SetupPlace = 'orca' | 'state' | 'executor' | 'github' | 'feishu'

/** 结论按这个顺序取第一条（Orca 自身不可用 > 状态目录 > 执行器 > 各 Source）。 */
export const SETUP_PLACES: readonly SetupPlace[] = ['orca', 'state', 'executor', 'github', 'feishu']

/**
 * 「没配置」与「坏了」是两件事（票面原话）：`missing` 是人还没填；`broken` 是填了但读不通。
 * 面板据此说「去设置里补」还是「这条配置有问题」，两者都不写成 health `error`。
 */
export type SetupKind = 'missing' | 'broken'

/** 一条 setup 问题的固定码（面板按码取文案，不解析 detail）。 */
export type SetupCode =
  | 'cli_missing'
  | 'cli_failed'
  | 'state_dir_relative'
  | 'state_dir_unwritable'
  | 'agent_missing'
  | 'model_missing'
  | 'git_missing'
  | 'base_repo_missing'
  | 'base_ref_missing'
  | 'base_ref_unverified'
  | 'repository_missing'
  | 'account_unreadable'
  | 'bot_missing'
  | 'user_identity'

/** 「检查一次」的入口：面板按钮与 CLI 命令是同一条（§G.2 的 `setup check`）。 */
export const SETUP_CHECK_AGAIN = 'superagent setup check'

/** 一条 setup 问题：**只报缺什么**，附一句修法与重跑入口。 */
export interface SetupIssue {
  readonly place: SetupPlace
  readonly code: SetupCode
  readonly kind: SetupKind
  /** 一句话说清现状（可含路径与选择器：路径不是秘密，§N.5）。 */
  readonly detail: string
  /** 一句话说清怎么修（面板就显示这一行）。 */
  readonly fix: string
  /** 修完从哪重跑（恒为 `superagent setup check`）。 */
  readonly checkAgain: string
}

/** `state` / `status` 里的 `setup.problem`（§N.4；HTTP 与 CLI 共用这一份形状）。 */
export interface SetupProblem {
  readonly place: string
  readonly code: string
  readonly detail?: string
  /** 一句修法（面板的「Check again」旁边显示）。 */
  readonly fix?: string
  readonly checkAgain?: string
}

/** `orca repo list --json` 的一行（seam 的 `RepoRow` 结构上满足它）。 */
export interface RepoRow {
  readonly id: string
  readonly path: string
  readonly name: string
}

/** 仓库选择器（`executor.baseRepo` 的三种写法；与 seam 的 `RepoSelector` 结构相同）。 */
export interface RepoSelectorLike {
  readonly path?: string
  readonly name?: string
  readonly id?: string
}

/** 外部世界的注入点；缺省的实现要么安全（不跑子进程）、要么如实失败。 */
export interface SetupPorts {
  /** 一个路径是否绝对（缺省 `node:path` 的同名判定）。 */
  readonly isAbsolute?: (path: string) => boolean
  /** 目录是否可写（缺省 `fs.accessSync(path, W_OK)`；不可写时抛错）。 */
  readonly writable?: (path: string) => void
  /** 跑一个子进程并返回标准输出；缺省「程序不在」（绝不在测试里偷偷跑真 CLI）。 */
  readonly run?: (program: string, args: readonly string[]) => Promise<string>
  /** `orca repo list` 的只读行（base repo 存在性）。 */
  readonly repos?: () => Promise<readonly RepoRow[]>
  /** `orca repo search-refs` 的命中 ref（base ref 存在性）。 */
  readonly searchRefs?: (selector: RepoSelectorLike, query: string) => Promise<readonly string[]>
}

/** `runSetupChecks` 的输入：一份设置快照 + 注入的外部世界。 */
export interface SetupCheckInput {
  readonly stateDir: string
  /** `executor.agent`（已解析的角色 id）。 */
  readonly agent: string
  /** `executor.model`：`undefined` 是没配（允许），空白串是配错了。 */
  readonly model?: string
  readonly baseRepo?: RepoSelectorLike
  /** `executor.baseBranch`：没配就用 `HEAD`，**不假装**读得到 Orca 的默认 base ref。 */
  readonly baseRef?: string
  readonly repository: string
  readonly githubCli: string
  /** GitHub Source 是否启用；禁用时只查配置，不查账号。 */
  readonly githubEnabled?: boolean
  /** 配置了 Feishu 时的 CLI；没配就没有这一项（不查 lark-cli）。 */
  readonly feishuCli?: string
  readonly ports?: SetupPorts
}

/** 一次 setup 检查的结论。 */
export interface SetupReport {
  readonly issues: readonly SetupIssue[]
  /** GitHub CLI 读到的 agent 账号；读不到是空串（调用方回落到设置里的值）。 */
  readonly githubLogin: string
}

/** 当前的 setup 结论（boot 持有；`setup check` 重新算一份再 `apply`）。 */
export interface SetupState {
  report(): SetupReport
  issues(): readonly SetupIssue[]
  /** `state.setup.problem`（最靠前的一条，`SETUP_PLACES` 顺序）。 */
  problem(): SetupProblem | null
  /** 是否还有任何 setup 问题（状态栏与面板的「等 setup」读数）。 */
  missing(): boolean
  /** 某个部件是否被 setup 挡住（Source 停在 `starting`，不轮询、不启动）。 */
  blocked(place: SetupPlace): boolean
  /** 用一次新结论替换当前状态，并把新结论返回给调用方。 */
  apply(report: SetupReport): SetupReport
}

/** 一个部件是否有 setup 问题。 */
export function issuesOf(issues: readonly SetupIssue[], place: SetupPlace): readonly SetupIssue[] {
  return issues.filter((issue) => issue.place === place)
}

/**
 * 取「最靠前」的一条问题（`SETUP_PLACES` 的顺序）：`state.setup.problem` 只放一条，
 * 面板点进去看全部。没有问题就是 `null`。
 */
export function setupProblemOf(issues: readonly SetupIssue[]): SetupProblem | null {
  for (const place of SETUP_PLACES) {
    const found = issues.find((issue) => issue.place === place)
    if (found !== undefined) {
      return {
        place: found.place,
        code: found.code,
        detail: found.detail,
        fix: found.fix,
        checkAgain: found.checkAgain
      }
    }
  }
  return null
}

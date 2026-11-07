// setup 探针（§N.1、§N.2、§I.4、§H.11、§O）：一次只告诉人**缺什么**。
//
// 与 `doctor`（`app/doctor.ts`）的分工是硬的：
// - `doctor` 是本机诊断：token 在不在、端口通不通、锁、库版本、CLI 路径、两个登录——只报有没有；
// - 本模块决定插件**现在能不能开工**：状态目录可写、base repo 在 Orca 里存在、base ref 存在、
//   agent id 非空、GitHub CLI 能读自己的账号、配置了 Feishu 时 lark-cli 必须是 bot-only、
//   `orca` CLI 与 `git` 可用。
// 一个 setup 问题只挡住受影响的部分（Source 停在 `starting`/`setup`），绝不写成 health `error`。
//
// 依赖纪律（§C.2）：本文件只 import 类型与 Node 内建；所有外部世界（CLI、Orca 仓库列表、
// ref 搜索、文件系统）都经注入的端口进入，于是启动路径与单测用同一份实现。
import { accessSync, constants } from 'node:fs'
import { isAbsolute } from 'node:path'
import { writeWorkerGitConfig, type WorkerGitConfigWrite } from '../infra/gitconfig.ts'
import { rethrowIfDeadline, withDeadline } from '../infra/deadline.ts'
import type {
  RepoRow,
  RepoSelectorLike,
  SetupBudget,
  SetupCheckInput,
  SetupGitConfigIdentity,
  SetupIssue,
  SetupPlace,
  SetupPorts,
  SetupProbeOptions,
  SetupReport,
  SetupState
} from './setup-types.ts'
import { SETUP_CHECK_AGAIN, issuesOf, setupProblemOf } from './setup-types.ts'

export type {
  RepoRow,
  RepoSelectorLike,
  SetupBudget,
  SetupCheckInput,
  SetupCode,
  SetupGitConfigIdentity,
  SetupIssue,
  SetupKind,
  SetupPlace,
  SetupPorts,
  SetupProbeOptions,
  SetupProblem,
  SetupReport,
  SetupState
} from './setup-types.ts'
export { SETUP_CHECK_AGAIN, SETUP_PLACES, issuesOf, setupProblemOf } from './setup-types.ts'

/** 一条结论的字段（`checkAgain` 由构造处统一填）。 */
interface IssueInput {
  readonly place: SetupPlace
  readonly code: SetupIssue['code']
  readonly kind: SetupIssue['kind']
  readonly detail: string
  readonly fix: string
}

/** 一条 setup 结论：修法与重跑入口恒在，面板不用自己想文案。 */
function issue(input: IssueInput): SetupIssue {
  return {
    place: input.place,
    code: input.code,
    kind: input.kind,
    detail: input.detail,
    fix: input.fix,
    checkAgain: SETUP_CHECK_AGAIN
  }
}

/** 「程序不在」：`ENOENT`（execFile）、我们自己的缺省 runner，或 seam 的 `cli_missing`。 */
function isMissingProgram(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return error instanceof Error && error.message.includes('ENOENT')
  }
  const code = (error as { code?: unknown }).code
  if (code === 'ENOENT' || code === 'missing_program' || code === 'cli_missing') return true
  return error instanceof Error && error.message.includes('ENOENT')
}

/** 一条错误的一行文本（进 detail；调用方保证不含 argv）。 */
function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

/**
 * 一次探针的出口：有预算时套上截止期（到点先取消再拒绝，§O），没预算时原样跑。
 * `what` 是人读的名字，**不是** argv（错误文案可能进日志与面板，§O 的命令注入面）。
 */
type Probe = <T>(what: string, work: (options: SetupProbeOptions) => Promise<T>) => Promise<T>

/**
 * 按预算造一个 `Probe`。探针的上限同时交给实现（`timeoutMs`）：信号掐不掉的子进程靠它兜。
 * 外部取消（handler 的总预算）与探针上限走同一个 `DeadlineError`。
 */
function probeOf(budget: SetupBudget | undefined): Probe {
  const ms = budget?.probeMs
  const outer = budget?.signal
  return <T>(what: string, work: (options: SetupProbeOptions) => Promise<T>): Promise<T> => {
    if (ms === undefined) return work({})
    const options: SetupProbeOptions = { timeoutMs: ms }
    return withDeadline((signal) => work({ ...options, signal }), {
      ms,
      what,
      ...(outer === undefined ? {} : { signal: outer })
    })
  }
}

/** 缺省的子进程出口：一切都按「程序不在」处理，而不是去碰操作者的机器。 */
const missingRunner = async (program: string): Promise<string> => {
  const error = new Error(`${program} is not available`)
  Object.assign(error, { code: 'missing_program' })
  throw error
}

// ---------------------------------------------------------------- 各探针

/** 状态目录必须是绝对路径且可写（§O「路径」行）。 */
function probeStateDir(
  stateDir: string,
  options: { readonly absolute: boolean; readonly writable: (path: string) => void }
): SetupIssue | undefined {
  if (!options.absolute) {
    return issue({
      place: 'state',
      code: 'state_dir_relative',
      kind: 'broken',
      detail: `the state directory ${stateDir} is not an absolute path`,
      fix: 'set an absolute path in Orca Settings → Superagent → State directory'
    })
  }
  try {
    options.writable(stateDir)
    return undefined
  } catch {
    return issue({
      place: 'state',
      code: 'state_dir_unwritable',
      kind: 'broken',
      detail: `the state directory ${stateDir} is not writable`,
      fix: `create it and make it writable by your account (mkdir -p ${stateDir})`
    })
  }
}

/** `executor.agent` 非空（§N.2：不猜测，缺省值由设置层给）。 */
function probeAgent(agent: string): SetupIssue | undefined {
  if (agent.trim() !== '') return undefined
  return issue({
    place: 'executor',
    code: 'agent_missing',
    kind: 'missing',
    detail: 'no worker agent id is set',
    fix: 'set the worker agent to an installed Orca agent id (for example pi)'
  })
}

/** 模型字段「有值」：填空格等于没填，提示人清掉或写对（§N.2）。 */
function probeModel(model: string | undefined): SetupIssue | undefined {
  if (model === undefined || model.trim() !== '') return undefined
  return issue({
    place: 'executor',
    code: 'model_missing',
    kind: 'missing',
    detail: 'the model field is blank',
    fix: 'clear the model field, or name a model the worker agent has'
  })
}

/** `git` 可用：只影响 worker，不影响插件自己（§I.4）。 */
async function probeGit(
  probe: Probe,
  run: (program: string, args: readonly string[], options?: SetupProbeOptions) => Promise<string>
): Promise<SetupIssue | undefined> {
  try {
    await probe('the git probe', (options) => run('git', ['--version'], options))
    return undefined
  } catch (error) {
    // 截止期不是「缺什么」：它意味着这次检查没做完（§O），原样交给调用方折成 `unavailable`。
    rethrowIfDeadline(error)
    const missing = isMissingProgram(error)
    return issue({
      place: 'executor',
      code: 'git_missing',
      kind: missing ? 'missing' : 'broken',
      detail: missing ? 'git is not on PATH' : `git could not run: ${messageOf(error)}`,
      fix: 'install git 2.32 or newer on the machine that runs the workers'
    })
  }
}

/** 选择器是否命中一行仓库（id / path / name 三种写法，§E.1 base repo 行）。 */
function matchesRepo(repo: RepoRow, selector: RepoSelectorLike): boolean {
  if (selector.id !== undefined) return repo.id === selector.id
  if (selector.path !== undefined) return repo.path === selector.path
  if (selector.name !== undefined) return repo.name === selector.name
  return false
}

/** 选择器的人读写法（进 detail：选择器不是秘密）。 */
function describeSelector(selector: RepoSelectorLike): string {
  if (selector.id !== undefined) return `id:${selector.id}`
  if (selector.path !== undefined) return `path:${selector.path}`
  return `name:${selector.name ?? ''}`
}

/** `probeBaseRepo` 的输入。 */
interface BaseRepoInput {
  readonly baseRepo?: RepoSelectorLike
  readonly baseRef?: string
}
/**
 * base repo 与 base ref：`orca repo list` 校验存在性；配了 base ref 才用
 * `orca repo search-refs` 校验它存在（§E.1：不假装读得到 Orca 的默认 base ref）。
 */
async function probeBaseRepo(
  input: BaseRepoInput,
  probe: Probe,
  ports: { readonly repos: () => Promise<readonly RepoRow[]>; readonly searchRefs: NonNullable<SetupPorts['searchRefs']> }
): Promise<readonly SetupIssue[]> {
  const selector = input.baseRepo
  if (selector === undefined) {
    return [
      issue({
        place: 'executor',
        code: 'base_repo_missing',
        kind: 'missing',
        detail: 'no base repository is set, so no ticket worktree can be created',
        fix: 'choose a Base repository in Orca Settings (path:<p>, name:<n> or id:<id>)'
      })
    ]
  }
  let repos: readonly RepoRow[]
  try {
    // `orca repo list` 是宿主调用（没有 signal 参数）：截止期至少让 handler 立刻拿到拒绝。
    repos = await probe('the orca repository probe', () => ports.repos())
  } catch (error) {
    rethrowIfDeadline(error)
    const missing = isMissingProgram(error)
    return [
      issue({
        place: 'orca',
        code: missing ? 'cli_missing' : 'cli_failed',
        kind: 'broken',
        detail: missing ? 'the orca CLI is not available' : `the orca CLI could not list its repositories: ${messageOf(error)}`,
        fix: missing
          ? 'install Orca 1.4.250 or newer and keep `orca` on PATH'
          : 'run `orca repo list` yourself to see why it fails'
      })
    ]
  }
  if (!repos.some((repo) => matchesRepo(repo, selector))) {
    return [
      issue({
        place: 'executor',
        code: 'base_repo_missing',
        kind: 'missing',
        detail: `the base repository ${describeSelector(selector)} is not registered in Orca`,
        fix: 'pick a repository Orca already has (`orca repo list`), or add it to Orca first'
      })
    ]
  }
  const ref = input.baseRef
  if (ref === undefined) return []
  let refs: readonly string[]
  try {
    refs = await probe('the base ref probe', () => ports.searchRefs(selector, ref))
  } catch (error) {
    rethrowIfDeadline(error)
    return [
      issue({
        place: 'executor',
        code: 'base_ref_unverified',
        kind: 'broken',
        detail: `the base ref ${ref} could not be checked: ${messageOf(error)}`,
        fix: 'run `orca repo search-refs` yourself to see why it fails, or clear the base branch'
      })
    ]
  }
  if (refs.includes(ref)) return []
  return [
    issue({
      place: 'executor',
      code: 'base_ref_missing',
      kind: 'missing',
      detail: `the base ref ${ref} does not exist in ${describeSelector(selector)}`,
      fix: 'choose an existing branch or tag, or clear the base branch to use HEAD'
    })
  ]
}

/** GitHub：配置两项 + agent 账号能读（§I.4；被禁用的实例只查配置）。 */
async function probeGithub(
  input: SetupCheckInput,
  probe: Probe,
  run: (program: string, args: readonly string[], options?: SetupProbeOptions) => Promise<string>
): Promise<{ readonly issues: readonly SetupIssue[]; readonly login: string }> {
  const issues: SetupIssue[] = []
  if (input.repository.trim() === '') {
    issues.push(
      issue({
        place: 'github',
        code: 'repository_missing',
        kind: 'missing',
        detail: 'the GitHub Source has no repository',
        fix: 'set the repository (owner/name) on the Source page'
      })
    )
  }
  if (input.githubCli.trim() === '') {
    issues.push(
      issue({
        place: 'github',
        code: 'cli_missing',
        kind: 'missing',
        detail: 'the GitHub Source has no CLI',
        fix: 'set the GitHub CLI (gh or an agent wrapper script) on the Source page'
      })
    )
  }
  if (issues.length > 0) return { issues, login: '' }
  if (input.githubEnabled === false) return { issues, login: '' }
  try {
    const output = await probe('the GitHub CLI probe', (options) =>
      run(input.githubCli, ['api', 'user', '--jq', '.login'], options)
    )
    const login = output.trim()
    if (login !== '') return { issues, login }
    return {
      issues: [
        issue({
          place: 'github',
          code: 'account_unreadable',
          kind: 'missing',
          detail: 'the GitHub CLI reported no account',
          fix: 'sign in as the agent account: gh auth login'
        })
      ],
      login: ''
    }
  } catch (error) {
    rethrowIfDeadline(error)
    const missing = isMissingProgram(error)
    return {
      issues: [
        issue({
          place: 'github',
          code: 'account_unreadable',
          kind: missing ? 'missing' : 'broken',
          detail: missing
            ? `the agent GitHub CLI (${input.githubCli}) is not on PATH`
            : `the agent GitHub CLI cannot read its account: ${messageOf(error)}`,
          fix: 'sign in as the agent account (gh auth login), or point the Source at the agent wrapper script'
        })
      ],
      login: ''
    }
  }
}

// ---------------------------------------------------------------- worker git config

/**
 * `<stateDir>/worker-gitconfig`（§H.11）：在部署就绪时写，身份不完整就不写。
 *
 * 两条不变量：
 * - 身份不全（账号或 noreply 邮箱为空）时**不写**：留一份没有 `user.email` 的配置会把
 *   操作者环境整体切断（#52 的缺陷），这比回落坏得多；
 * - GitHub 探针本身有问题时不再加一条同因的结论：根因（`account_unreadable`）该先被人看到。
 *
 * 写失败也只变成一条具名问题（`gitconfig_unwritable`），不抛错。
 */
function probeGitConfig(
  input: SetupCheckInput,
  config: SetupGitConfigIdentity,
  github: { readonly issues: readonly SetupIssue[]; readonly login: string },
  write: NonNullable<SetupPorts['writeGitConfig']>
): SetupIssue | undefined {
  if (github.issues.length > 0) return undefined
  const account = (github.login || config.account || '').trim()
  const email = config.email.trim()
  /** 身份不全：同一条修法（没写与写不成身份都走它）。 */
  const missingIdentity = (): SetupIssue =>
    issue({
      place: 'executor',
      code: 'gitconfig_missing',
      kind: 'missing',
      detail: 'the worker git config has no commit identity yet: the agent account or its noreply email is empty',
      fix: 'set the agent noreply commit email (githubCommitEmail) in the Superagent settings, then run the check again'
    })
  if (account === '' || email === '') return missingIdentity()
  const outcome: WorkerGitConfigWrite = write({ stateDir: input.stateDir, account, email })
  if (outcome.state === 'written') return undefined
  if (outcome.state === 'missing_identity') return missingIdentity()
  return issue({
    place: 'executor',
    code: 'gitconfig_unwritable',
    kind: 'broken',
    detail: `the worker git config ${outcome.path} could not be written: ${outcome.detail}`,
    fix: `fix the permissions of the state directory or of ${outcome.path}, then run the check again`
  })
}

/** `lark-cli auth status` 里身份面的两个字段（其余字段不读：输出里有 appId、openId、scope）。 */
export interface LarkIdentities {
  readonly botStatus?: string
  readonly userStatus?: string
}

/** 只取 `identities.bot.status` 与 `identities.user.status`。 */
export function larkIdentities(text: string): LarkIdentities {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}
  const identities = (parsed as { identities?: unknown }).identities
  if (typeof identities !== 'object' || identities === null) return {}
  const statusOf = (key: string): string | undefined => {
    const value = (identities as Record<string, unknown>)[key]
    if (typeof value !== 'object' || value === null) return undefined
    const status = (value as { status?: unknown }).status
    return typeof status === 'string' ? status : undefined
  }
  const result: { botStatus?: string; userStatus?: string } = {}
  const bot = statusOf('bot')
  const user = statusOf('user')
  if (bot !== undefined) result.botStatus = bot
  if (user !== undefined) result.userStatus = user
  return result
}

/**
 * Feishu：配置了才查，而且必须是 bot-only（§I.3、§I.4）。
 * 「可充当用户身份」的配置一律拒绝——本插件只用 bot 身份读写。
 */
async function probeFeishu(
  input: SetupCheckInput,
  probe: Probe,
  run: (program: string, args: readonly string[], options?: SetupProbeOptions) => Promise<string>
): Promise<readonly SetupIssue[]> {
  const cli = input.feishuCli
  // `undefined`：这个 Source 没配置（不查）。空串：配置了但没填 CLI——一条 setup 问题。
  if (cli === undefined) return []
  if (cli.trim() === '') {
    return [
      issue({
        place: 'feishu',
        code: 'cli_missing',
        kind: 'missing',
        detail: 'the Feishu Source has no CLI',
        fix: 'set the Feishu CLI (lark-cli or its absolute path) on the Source page'
      })
    ]
  }
  let text: string
  try {
    text = await probe('the Feishu CLI probe', (options) => run(cli, ['auth', 'status'], options))
  } catch (error) {
    rethrowIfDeadline(error)
    const missing = isMissingProgram(error)
    return [
      issue({
        place: 'feishu',
        code: 'cli_missing',
        kind: missing ? 'missing' : 'broken',
        detail: missing ? 'lark-cli is not on PATH' : `lark-cli did not report its auth status: ${messageOf(error)}`,
        fix: missing ? 'install lark-cli and keep it on PATH' : 'run `lark-cli auth status` yourself to see why'
      })
    ]
  }
  const identities = larkIdentities(text)
  const issues: SetupIssue[] = []
  const userStatus = identities.userStatus
  if (userStatus !== undefined && !['missing', 'signed-out', 'signed_out'].includes(userStatus)) {
    issues.push(
      issue({
        place: 'feishu',
        code: 'user_identity',
        kind: 'broken',
        detail: 'lark-cli has a user identity configured; this plugin only acts as a bot',
        fix: 'remove the user login from that lark-cli profile (strict bot-only configuration)'
      })
    )
  }
  if (identities.botStatus === undefined || identities.botStatus === 'missing') {
    issues.push(
      issue({
        place: 'feishu',
        code: 'bot_missing',
        kind: 'missing',
        detail: 'lark-cli has no bot identity',
        fix: 'configure the bot app with lark-cli (see §I.3) and run `lark-cli auth status` again'
      })
    )
  } else if (identities.botStatus !== 'ready') {
    issues.push(
      issue({
        place: 'feishu',
        code: 'account_unreadable',
        kind: 'broken',
        detail: `lark-cli reported bot status ${identities.botStatus}`,
        fix: 'run `lark-cli auth status` yourself to see why the bot is not ready'
      })
    )
  }
  return issues
}

// ---------------------------------------------------------------- 汇总

/**
 * 跑全部探针。任何一个探针失败都只变成一条具名问题，绝不抛错——setup 检查本身不能因为
 * 「查不了」而让插件崩掉。结论按 `SETUP_PLACES` 的顺序由 `setupProblemOf` 取第一条。
 */
export async function runSetupChecks(input: SetupCheckInput): Promise<SetupReport> {
  const ports: SetupPorts = input.ports ?? {}
  const absolute = ports.isAbsolute ?? isAbsolute
  const writable = ports.writable ?? ((path: string) => accessSync(path, constants.W_OK))
  const run = ports.run ?? missingRunner
  const probe = probeOf(input.budget)
  const repos = ports.repos ?? (async () => [])
  const searchRefs: NonNullable<SetupPorts['searchRefs']> =
    ports.searchRefs ??
    (async () => {
      throw new Error('search-refs is not available')
    })

  const issues: SetupIssue[] = []
  const state = probeStateDir(input.stateDir, { absolute: absolute(input.stateDir), writable })
  if (state !== undefined) issues.push(state)
  const agent = probeAgent(input.agent)
  if (agent !== undefined) issues.push(agent)
  const model = probeModel(input.model)
  if (model !== undefined) issues.push(model)
  const git = await probeGit(probe, run)
  if (git !== undefined) issues.push(git)
  const baseInput: { baseRepo?: RepoSelectorLike; baseRef?: string } = {}
  if (input.baseRepo !== undefined) baseInput.baseRepo = input.baseRepo
  if (input.baseRef !== undefined) baseInput.baseRef = input.baseRef
  issues.push(...(await probeBaseRepo(baseInput, probe, { repos, searchRefs })))
  const github = await probeGithub(input, probe, run)
  issues.push(...github.issues)
  if (input.gitConfig !== undefined) {
    const written = probeGitConfig(
      input,
      input.gitConfig,
      github,
      ports.writeGitConfig ?? writeWorkerGitConfig
    )
    if (written !== undefined) issues.push(written)
  }
  issues.push(...(await probeFeishu(input, probe, run)))

  return { issues, githubLogin: github.login }
}

// ---------------------------------------------------------------- 当前状态

/** 造一个可替换的 setup 状态。构造后只经 `apply` 变化（单写者，§D.4）。 */
export function createSetupState(initial: SetupReport): SetupState {
  let current = initial
  return {
    report: () => current,
    issues: () => current.issues,
    problem: () => setupProblemOf(current.issues),
    missing: () => current.issues.length > 0,
    blocked: (place) => issuesOf(current.issues, place).length > 0,
    apply(report) {
      current = report
      return current
    }
  }
}

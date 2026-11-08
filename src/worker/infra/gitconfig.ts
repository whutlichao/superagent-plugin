// `worker-gitconfig`（§H.11）：`<stateDir>/worker-gitconfig` 就是 worker 的**全局** git 配置。
//
// 为什么需要它：launch 钩子把 `GIT_CONFIG_GLOBAL` 指向这个文件（§H.11 第 a 条）。git 一旦
// 看到这个变量就**只**读这份文件——文件不存在时用户级配置（`user.name`/`user.email`、凭据
// helper、`http.*`）全部不再加载，只剩系统级配置，于是 ticket worktree 里的 `git commit` 会
// 因为缺身份失败、推送可能找不到凭据（#52 的缺陷）。因此这里必须真的写文件，而且**只有在
// 文件存在时才允许注入**（`launch-hook.ts` 的 `launchEnvironment` 用 `existsSync` 判）。
//
// 内容只有三类键，都来自部署事实（与 `DSH_SUPERAGENT_GITHUB_ACCOUNT` / `_COMMIT_EMAIL` 同源）：
//   credential."https://github.com".helper = !gh auth git-credential   （agent 账号的 gh）
//   url."https://github.com/".insteadOf   = git@github.com:            （SSH → HTTPS）
//   user.name / user.email                                             （worker 提交身份）
// 不写任何 token、secret 或操作者个人身份：凭据仍由机器上的 `gh` 持有（§O「CLI 凭证」行）。
//
// 权限与 token 文件同口径：0600（`TOKEN_MODE` 的兄弟；doctor 只 stat 它，绝不读内容）。
// 身份不完整（账号或 noreply 邮箱为空）时**不写**：留一行残缺的 `user.name` 比不上「回落到
// 操作者环境」，而且会把用户配置整体切断——这正是本票要修的缺陷。
import { existsSync, renameSync, statSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'

/** 文件名（`<stateDir>/worker-gitconfig`）。 */
export const WORKER_GITCONFIG_FILE = 'worker-gitconfig'

/** 文件权限：只有属主可读写（与 token 文件同口径，§O「路径」行）。 */
export const GITCONFIG_MODE = 0o600

/** GitHub 凭据 helper：用 agent 账号的 `gh` 取凭据，而不是把 token 写进文件（§O）。 */
export const GITCONFIG_HELPER = '!gh auth git-credential'

/** SSH → HTTPS 重写：worker 的推送不依赖 SSH key（上游 `worker-gitconfig` 的同一条）。 */
export const GITCONFIG_INSTEAD_OF = 'git@github.com:'

/** 写文件用的临时名字（先写临时文件再 rename：读者永远看不到半份配置）。 */
const TEMPORARY_SUFFIX = '.tmp'

/** worker 提交身份：部署里的 agent 账号与其 noreply 邮箱（§E.11 的变量源）。 */
export interface WorkerGitConfigIdentity {
  readonly account: string
  readonly email: string
}

/** 一次写入的读数：调用方据此决定是否给一条 setup 问题（不吞掉原因）。 */
export type WorkerGitConfigWrite =
  | { readonly state: 'written'; readonly path: string; readonly mode: number }
  | { readonly state: 'missing_identity'; readonly path: string }
  | { readonly state: 'failed'; readonly path: string; readonly detail: string }

/** `<stateDir>/worker-gitconfig` 的绝对路径。 */
export function workerGitConfigPath(stateDir: string): string {
  return join(stateDir, WORKER_GITCONFIG_FILE)
}

/**
 * git 配置文件里一个值的写法：双引号包裹并转义 `\`、`"` 与换行/制表。
 * 值只来自部署事实，但也不让一个奇怪的名字把文件写成多行（防注入，§O）。
 */
function quoted(value: string): string {
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t')
  return `"${escaped}"`
}

/**
 * 渲染文件文本：只有 helper、SSH→HTTPS 重写与身份这三组键（顺序固定，便于审阅与 diff）。
 * 身份不完整时抛错——调用方应先看 `writeWorkerGitConfig` 的 `missing_identity`。
 */
export function renderWorkerGitConfig(identity: WorkerGitConfigIdentity): string {
  const account = identity.account.trim()
  const email = identity.email.trim()
  if (account === '' || email === '') {
    throw new Error('the worker git config needs both the agent account and its noreply email')
  }
  return (
    [
      '[credential "https://github.com"]',
      `\thelper = ${quoted(GITCONFIG_HELPER)}`,
      '[url "https://github.com/"]',
      `\tinsteadOf = ${quoted(GITCONFIG_INSTEAD_OF)}`,
      '[user]',
      `\tname = ${quoted(account)}`,
      `\temail = ${quoted(email)}`,
      ''
    ].join('\n')
  )
}

/** 一条错误的短文本（进 setup 问题的 detail；不带堆栈）。 */
function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

/**
 * 写（覆盖）`<stateDir>/worker-gitconfig`。幂等：内容只由身份决定，重复写不会留下旧键；
 * 权限每次都收紧到 0600（`writeFileSync` 的 `mode` 会被 umask 削弱，所以再 `chmodSync`）。
 * 任何失败都变成读数里的 `failed` 与原因，不抛错——调用方把它折成一条 setup 问题。
 */
export function writeWorkerGitConfig(options: {
  readonly stateDir: string
  readonly account: string
  readonly email: string
}): WorkerGitConfigWrite {
  const path = workerGitConfigPath(options.stateDir)
  const account = options.account.trim()
  const email = options.email.trim()
  if (account === '' || email === '') return { state: 'missing_identity', path }
  const temporary = `${path}${TEMPORARY_SUFFIX}`
  try {
    writeFileSync(temporary, renderWorkerGitConfig({ account, email }), {
      encoding: 'utf8',
      mode: GITCONFIG_MODE
    })
    chmodSync(temporary, GITCONFIG_MODE)
    renameSync(temporary, path)
    chmodSync(path, GITCONFIG_MODE)
    return { state: 'written', path, mode: GITCONFIG_MODE }
  } catch (error) {
    // 临时文件不留给下一次（它不在任何读取路径里，但也不该堆垃圾）。
    try {
      if (existsSync(temporary)) unlinkSync(temporary)
    } catch {
      // 清不掉就算了：真正的原因已经记在 detail 里。
    }
    return { state: 'failed', path, detail: messageOf(error) }
  }
}

/**
 * 删掉 `<stateDir>/worker-gitconfig`（幂等）：身份变得不完整时用它。文件不存在就什么也不做。
 *
 * 为什么必须删：`launch-hook.ts` 只按「文件存在」注入 `GIT_CONFIG_GLOBAL`（§H.11 第 d 条）。
 * 留下上一份身份，worker 会继续用旧邮箱提交，而部署检查同时报 `gitconfig_missing`——两处
 * 说的是不同的事实。删掉之后注入停止、回落到操作者环境，与「身份不全就不注入」一致。
 */
export function clearWorkerGitConfig(stateDir: string): boolean {
  const path = workerGitConfigPath(stateDir)
  if (!existsSync(path)) return false
  const info = statSync(path)
  if (!info.isFile()) return false
  unlinkSync(path)
  return true
}

/** 现有文件的读数：只 stat，不读内容（doctor 的红线，§O「secret 不落日志」）。 */
export type WorkerGitConfigInspection =
  | { readonly state: 'missing'; readonly path: string }
  | { readonly state: 'present'; readonly path: string; readonly mode: number }

/** 看 `<stateDir>/worker-gitconfig` 在不在、权限是多少；**不打开它**。 */
export function inspectWorkerGitConfig(stateDir: string): WorkerGitConfigInspection {
  const path = workerGitConfigPath(stateDir)
  if (!existsSync(path)) return { state: 'missing', path }
  const info = statSync(path)
  // 同名目录不是「我们的文件」：按缺失报，别把目录的权限当成配置的权限。
  if (!info.isFile()) return { state: 'missing', path }
  return { state: 'present', path, mode: info.mode & 0o777 }
}

// 执行环境的文件面（§E.11）：写 `<ticketDir>/.superagent/env.sh`，并把它挡在 git 之外。
//
// env.sh 的形态固定为 `export K='v'`，值逐值单引号转义（`shellSingleQuote`，§O）——shell
// source 它得到的就是变量的原值，不需要调用方再拼一次引号。
//
// 排除文件的实测事实（git 2.56，2026-11-07）：linked worktree 的 `.git` 是一个文本文件
// （`gitdir: <repo>/.git/worktrees/<name>`），而 git 的忽略规则只读 **common dir** 的
// `info/exclude`；`<worktreeGitDir>/info/exclude` 不会被读取（即使开 `extensions.worktreeConfig`）。
// 因此 `gitExcludePath` 解析 `.git` → `commondir`，写的是该仓库的 `info/exclude`：只增加一行
// `.superagent/`，不碰索引、不碰工作树（`tests/execution-environment.test.ts` 断言 base repo 的
// 索引条目与索引文件都不变）。这是 §E.11「在 worktree 内写，不影响 base repo 的 index」在
// Orca 的 linked worktree 上的落地方式。
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { ENVIRONMENT_VARIABLES, shellSingleQuote } from './environment.ts'

/** env 文件所在的目录名（相对 worktree 根）。 */
export const ENV_FILE_DIRECTORY = '.superagent'

/** env 文件名。 */
export const ENV_FILE_NAME = 'env.sh'

/** 写进 git 排除文件的那一行：整个目录，不只 env.sh（以后同目录的其它文件也不进索引）。 */
export const ENV_FILE_EXCLUDE_ENTRY = `${ENV_FILE_DIRECTORY}/`

/** `<ticketDir>/.superagent/env.sh` 的绝对路径。 */
export function envFilePath(directory: string): string {
  return join(directory, ENV_FILE_DIRECTORY, ENV_FILE_NAME)
}

/** 变量名的字节序比较：额外变量的顺序因此只由名字决定，不受 locale 影响。 */
function byName(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/**
 * 渲染 env.sh 的文本：变量表顺序在前（`ENVIRONMENT_VARIABLES`），Source kind 贡献的额外变量
 * 按名字排序跟在后面。两份头部说明它由插件生成、不进提交——worker 读到的就是这句话。
 */
export function renderEnvFile(
  environment: Readonly<Record<string, string>>,
  options: { readonly ticketId?: string } = {}
): string {
  const known = new Set<string>(ENVIRONMENT_VARIABLES)
  const extra = Object.keys(environment)
    .filter((key) => !known.has(key))
    .sort(byName)
  const order = [...ENVIRONMENT_VARIABLES, ...extra]
  const header = [
    `# Superagent execution environment${options.ticketId === undefined ? '' : ` for ${options.ticketId}`} (generated; do not commit).`,
    '# Source it (`source .superagent/env.sh`); these values identify this ticket only.'
  ]
  const lines = order.map((key) => `export ${key}=${shellSingleQuote(environment[key] ?? '')}`)
  return `${[...header, ...lines].join('\n')}\n`
}

/**
 * 写 env.sh 并返回落点。目录不存在就建（`.superagent/`）；重复写覆盖（内容只由变量表决定，
 * 因此是幂等的）。
 */
export function writeEnvFile(options: {
  readonly directory: string
  readonly environment: Readonly<Record<string, string>>
  readonly ticketId?: string
}): string {
  const path = envFilePath(options.directory)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    renderEnvFile(
      options.environment,
      options.ticketId === undefined ? {} : { ticketId: options.ticketId }
    ),
    'utf8'
  )
  return path
}

/** `.git` 文件里 `gitdir: <路径>` 的那一行（linked worktree 的形态）。 */
const GITDIR_PATTERN = /^gitdir:\s*(.+?)\s*$/m

/** 把 `.git` 文件/目录解析成该仓库真正的 git 目录（工作树共享的那个 common dir）。 */
function commonGitDir(directory: string): string | null {
  const dotGit = join(directory, '.git')
  if (!existsSync(dotGit)) return null
  const info = statSync(dotGit)
  // 普通 checkout：`.git` 就是目录，info/exclude 在它下面。
  if (info.isDirectory()) return dotGit
  // linked worktree：`.git` 是文件，指向 `<repo>/.git/worktrees/<name>`；忽略规则在 common dir。
  const match = GITDIR_PATTERN.exec(readFileSync(dotGit, 'utf8'))
  const worktreeGitDir = match?.[1]
  if (worktreeGitDir === undefined) return null
  const gitDir = isAbsolute(worktreeGitDir) ? worktreeGitDir : resolve(directory, worktreeGitDir)
  const commonFile = join(gitDir, 'commondir')
  if (!existsSync(commonFile)) return gitDir
  const common = readFileSync(commonFile, 'utf8').trim()
  return isAbsolute(common) ? common : resolve(gitDir, common)
}

/**
 * 这个 worktree 的 git 排除文件（`info/exclude`）；不是 git 工作区时 `null`。
 * 注意：linked worktree 与它的 base repo 共用同一个文件——git 没有 per-worktree 的 exclude。
 */
export function gitExcludePath(directory: string): string | null {
  const gitDir = commonGitDir(directory)
  return gitDir === null ? null : join(gitDir, 'info', 'exclude')
}

/**
 * 把 `.superagent/` 加进这个 worktree 的排除文件（幂等：已有就不再写）。
 * 返回落点与「这次是否真的加了一行」；不是 git 工作区时返回 `null`（不阻断 launch）。
 */
export function ensureExcluded(
  directory: string,
  entry: string = ENV_FILE_EXCLUDE_ENTRY
): { readonly path: string; readonly added: boolean } | null {
  const path = gitExcludePath(directory)
  if (path === null) return null
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const lines = existing.split('\n').map((line) => line.trim())
  if (lines.includes(entry)) return { path, added: false }
  mkdirSync(dirname(path), { recursive: true })
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n'
  writeFileSync(path, `${existing}${separator}${entry}\n`, 'utf8')
  return { path, added: true }
}

// GitHub 的读取端口（§I.2 的「通知轮询」与「订阅读取」两行）：只读这些面——
// 通知列表、Issue/PR 本体、Issue 评论、评审与评审评论——而且只经 `CommandsHost` 调 `gh`（§I.4）。
//
// 解析是**容忍**的：GitHub 的 JSON 会多字段、少字段；这里只取要用的那些，畸形条目记进
// `skipped` 由调用方跳过（§I.2「畸形条目跳过并计数」）。传输层失败（不是 JSON）与形状不符
// 分开：前者抛错让这一轮失败、游标不动；后者只计数。
import type { JsonValue } from '../../core/index.ts'
import { CliError } from '../commands.ts'
import type { CommandsHost } from '../commands.ts'

/** 一次读取的读数：解析出来的条目，以及被跳过的畸形条目数（不是失败）。 */
export interface GithubRead<T> {
  readonly items: readonly T[]
  readonly skipped: number
}

/** 一条通知（`gh api notifications` 的一项，只取本轮用到的字段）。 */
export interface GithubNotification {
  readonly id: string
  readonly updatedAt: string
  readonly lastReadAt: string | null
  readonly type: string
  readonly title: string
  readonly apiUrl: string
  readonly repository: string
}

/** 一条 Issue 或 PR 的 issues 视图（`/repos/:o/:r/issues/:n`）；`isPull` 是 PR 的唯一判据。 */
export interface GithubIssue {
  readonly number: number
  readonly isPull: boolean
  readonly title: string
  readonly url: string
  readonly state: string
  readonly updatedAt: string
  readonly body: string
  readonly login: string
  readonly bot: boolean
  readonly createdAt: string
}

/** 一个 PR（`/repos/:o/:r/pulls/:n`）；`merged` 与两个时刻供 §I.5 的结束判定。 */
export interface GithubPull {
  readonly number: number
  readonly title: string
  readonly url: string
  readonly state: string
  readonly merged: boolean
  /** 合并与关闭的时刻（GitHub 原值；没发生时为 null）：结束规则取「一次关闭」的时刻。 */
  readonly mergedAt: string | null
  readonly closedAt: string | null
  /** PR 的 head 提交：CI 读这个提交的检查与状态（§I.2 CI 行）。 */
  readonly headSha: string
  /**
   * PR 的 head 分支与它所在的仓库（`head.repo.full_name`；fork 被删时 GitHub 给 `null`，
   * 这里如实是空串）。PR 规则靠这两项判「这条 PR 是不是该 Ticket 开的」（§I.2 PR 规则行）。
   */
  readonly headRef: string
  readonly headRepo: string
  readonly updatedAt: string
  readonly body: string
  readonly login: string
  readonly bot: boolean
  readonly createdAt: string
}

/** 一条 Issue 评论（`/issues/:n/comments`）或评审评论（`/pulls/:n/comments`）的一项。 */
export interface GithubComment {
  readonly id: number
  readonly login: string
  readonly bot: boolean
  readonly body: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly url: string
  /** 评审评论所属评审线程的根评论 id；不是评审评论时为 null。 */
  readonly inReplyTo: number | null
  /** 评审评论的文件路径；会话评论为空串。 */
  readonly path: string
  /** 评审评论的行号；拿不到时为 null。 */
  readonly line: number | null
}

/** 一条评审（`/pulls/:n/reviews` 的一项）。 */
export interface GithubReview {
  readonly id: number
  readonly state: string
  readonly login: string
  readonly bot: boolean
  readonly body: string
  readonly submittedAt: string
  /** 评审针对的提交；决策文本用它说明评的是哪一版。 */
  readonly commitId: string
  readonly url: string
}

/** 一条检查运行（`/commits/<sha>/check-runs` 的一项，只取结果面）。 */
export interface GithubCheckRun {
  readonly name: string
  /** `queued` | `in_progress` | `completed`（GitHub 原值）。 */
  readonly status: string
  /** 完成后的结论；还在跑时为 null。 */
  readonly conclusion: string | null
}

/** 一条提交状态（`/commits/<sha>/statuses` 的一项，只取结果面）。 */
export interface GithubCommitStatus {
  readonly context: string
  /** `pending` | `success` | `failure` | `error`（GitHub 原值）。 */
  readonly state: string
}

/**
 * 一个提交的 CI 读数（§I.2 CI 行）：检查运行 + 提交状态。两组都按名字排序：轮询据此算
 * 稳定指纹，顺序变化不算变化；状态按 context 只留最新一条（GitHub 新的在前）。
 */
export interface GithubChecks {
  readonly headSha: string
  readonly checks: readonly GithubCheckRun[]
  readonly statuses: readonly GithubCommitStatus[]
}

/** GitHub 的读取面（测试用 FakeCommands 实现同一个契约）。 */
export interface GithubApi {
  /** 未读通知；`gh api notifications --paginate`（§I.2）。 */
  notifications(): Promise<GithubRead<GithubNotification>>
  /** 一条 Issue 或 PR 的 issues 视图；`pull_request` 存在即为 PR。 */
  issue(repository: string, issue: number): Promise<GithubRead<GithubIssue>>
  /** 一条 Issue/PR 的会话评论；`since` 只回它之后的那些。 */
  issueComments(
    repository: string,
    issue: number,
    since: string | null
  ): Promise<GithubRead<GithubComment>>
  /** 一个 PR 的本体（`/pulls/:n`）。 */
  pull(repository: string, issue: number): Promise<GithubRead<GithubPull>>
  /** 一个 PR 的评审页（`/pulls/:n/reviews`）。 */
  pullReviews(repository: string, issue: number): Promise<GithubRead<GithubReview>>
  /** 一个 PR 的评审评论页（`/pulls/:n/comments`，行内讨论）。 */
  pullComments(repository: string, issue: number): Promise<GithubRead<GithubComment>>
  /**
   * 一个提交的 CI 读数（§I.2 CI 行）：检查运行 + 提交状态。畸形页/条目进 `skipped`，
   * 与其它读一致。
   */
  checks(repository: string, sha: string): Promise<GithubRead<GithubChecks>>
}

/** 从任意值里取字符串字段（缺失 → 空串）。 */
function text(value: unknown, key: string): string {
  if (typeof value !== 'object' || value === null) return ''
  const found = (value as Record<string, unknown>)[key]
  return typeof found === 'string' ? found : ''
}

/** 从任意值里取数字字段（缺失 → 0）。 */
function count(value: unknown, key: string): number {
  if (typeof value !== 'object' || value === null) return 0
  const found = (value as Record<string, unknown>)[key]
  return typeof found === 'number' && Number.isFinite(found) ? found : 0
}

/** 从任意值里取布尔字段（只认 `true`）。 */
function flag(value: unknown, key: string): boolean {
  if (typeof value !== 'object' || value === null) return false
  return (value as Record<string, unknown>)[key] === true
}

/** 一个可选数字字段：缺失、非数字或 0 都当没有。 */
function optionalCount(value: unknown, key: string): number | null {
  const found = count(value, key)
  return found > 0 ? found : null
}

/** 一条记录的作者：login + 是否 bot（`type: 'Bot'` 或 `[bot]` 后缀，§I.2 Actor 行）。 */
function authorOf(value: Record<string, unknown>): { login: string; bot: boolean } {
  const user = isRecord(value['user']) ? value['user'] : {}
  const login = text(user, 'login')
  return { login, bot: text(user, 'type') === 'Bot' || /\[bot\]$/i.test(login) }
}

/** 一个对象是否像 `{...}`（null 与数组都不算）。 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 解析一行 JSON；不是 JSON 时抛错（让这一轮失败、游标不动）。 */
function parseJson(output: string): JsonValue {
  try {
    return JSON.parse(output)
  } catch {
    throw new Error('GitHub returned a response that is not JSON')
  }
}

/** 解析一个数组响应；不是数组时抛错（传输/契约失败，不是单条畸形）。 */
function parseArray(output: string): readonly unknown[] {
  const parsed = parseJson(output)
  if (!Array.isArray(parsed)) throw new Error('GitHub returned a non-array response')
  return parsed
}

/** 一条通知 → 端口形状；缺 id 或时刻的条目返回 undefined（跳过）。 */
export function notificationOf(value: unknown): GithubNotification | undefined {
  if (!isRecord(value)) return undefined
  const id = text(value, 'id') || String(count(value, 'id'))
  if (id === '0' || id.length === 0) return undefined
  const updatedAt = text(value, 'updated_at')
  if (updatedAt.length === 0) return undefined
  const subject = isRecord(value['subject']) ? value['subject'] : {}
  const repository = isRecord(value['repository']) ? value['repository'] : {}
  const lastReadAt = text(value, 'last_read_at')
  return {
    id,
    updatedAt,
    lastReadAt: lastReadAt.length === 0 ? null : lastReadAt,
    type: text(subject, 'type'),
    title: text(subject, 'title'),
    apiUrl: text(subject, 'url'),
    repository: text(repository, 'full_name')
  }
}

/** 一条 Issue/PR 的 issues 视图 → 端口形状；缺编号的条目返回 undefined（跳过）。 */
export function issueOf(value: unknown): GithubIssue | undefined {
  if (!isRecord(value)) return undefined
  const number = count(value, 'number')
  if (number <= 0) return undefined
  // `pull_request` 只在 PR 上出现；它是「这是 PR」的唯一判据（上游同）。
  const isPull = isRecord(value['pull_request'])
  const author = authorOf(value)
  return {
    number,
    isPull,
    title: text(value, 'title'),
    url: text(value, 'html_url'),
    state: text(value, 'state'),
    updatedAt: text(value, 'updated_at'),
    body: text(value, 'body'),
    login: author.login,
    bot: author.bot,
    createdAt: text(value, 'created_at')
  }
}

/** 一个可选时刻：缺失或空串都当没有。 */
function optionalTime(value: unknown, key: string): string | null {
  const found = text(value, key)
  return found.length === 0 ? null : found
}

/** 一个 PR → 端口形状；缺编号的条目返回 undefined（跳过）。 */
export function pullOf(value: unknown): GithubPull | undefined {
  if (!isRecord(value)) return undefined
  const number = count(value, 'number')
  if (number <= 0) return undefined
  const author = authorOf(value)
  const head = isRecord(value['head']) ? value['head'] : {}
  const headRepo = isRecord(head['repo']) ? head['repo'] : {}
  return {
    number,
    title: text(value, 'title'),
    url: text(value, 'html_url'),
    state: text(value, 'state'),
    merged: flag(value, 'merged'),
    mergedAt: optionalTime(value, 'merged_at'),
    closedAt: optionalTime(value, 'closed_at'),
    headSha: text(head, 'sha'),
    headRef: text(head, 'ref'),
    headRepo: text(headRepo, 'full_name'),
    updatedAt: text(value, 'updated_at'),
    body: text(value, 'body'),
    login: author.login,
    bot: author.bot,
    createdAt: text(value, 'created_at')
  }
}

/** 一条评论 → 端口形状；缺 id 的条目返回 undefined。 */
export function commentOf(value: unknown): GithubComment | undefined {
  if (!isRecord(value)) return undefined
  const id = count(value, 'id')
  if (id <= 0) return undefined
  const author = authorOf(value)
  const updatedAt = text(value, 'updated_at') || text(value, 'created_at')
  return {
    id,
    login: author.login,
    bot: author.bot,
    body: text(value, 'body'),
    createdAt: text(value, 'created_at'),
    updatedAt,
    url: text(value, 'html_url'),
    inReplyTo: optionalCount(value, 'in_reply_to_id'),
    path: text(value, 'path'),
    line: optionalCount(value, 'line') ?? optionalCount(value, 'original_line')
  }
}

/** 解析一组检查运行页：每页是 `{check_runs: [...]}`（`--slurp` 包成数组）。 */
function checkRunsOf(pages: readonly unknown[]): { checks: GithubCheckRun[]; skipped: number } {
  const checks: GithubCheckRun[] = []
  let skipped = 0
  for (const page of pages) {
    const runs = isRecord(page) ? page['check_runs'] : undefined
    if (!Array.isArray(runs)) {
      skipped += 1
      continue
    }
    for (const value of runs) {
      const parsed = checkRunOf(value)
      if (parsed === undefined) skipped += 1
      else checks.push(parsed)
    }
  }
  return { checks, skipped }
}

/** 检查按名字、状态、结论排序：GitHub 的返回顺序不参与指纹。 */
function sortedChecks(checks: readonly GithubCheckRun[]): GithubCheckRun[] {
  return [...checks].sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.status.localeCompare(right.status) ||
      (left.conclusion ?? '').localeCompare(right.conclusion ?? '')
  )
}

/** 每个 context 只留最新一条（GitHub 新的在前，所以第一条就是最新），再按 context 排序。 */
function latestStatuses(statuses: readonly GithubCommitStatus[]): GithubCommitStatus[] {
  const latest = new Map<string, GithubCommitStatus>()
  for (const status of statuses) if (!latest.has(status.context)) latest.set(status.context, status)
  return [...latest.values()].sort((left, right) => left.context.localeCompare(right.context))
}

/** 一条检查运行 → 端口形状；缺名字或缺状态的条目返回 undefined（跳过）。 */
export function checkRunOf(value: unknown): GithubCheckRun | undefined {
  if (!isRecord(value)) return undefined
  const name = text(value, 'name')
  const status = text(value, 'status')
  if (name.length === 0 || status.length === 0) return undefined
  const conclusion = text(value, 'conclusion')
  return { name, status, conclusion: conclusion.length === 0 ? null : conclusion }
}

/** 一条提交状态 → 端口形状；缺 context 或 state 的条目返回 undefined（跳过）。 */
export function commitStatusOf(value: unknown): GithubCommitStatus | undefined {
  if (!isRecord(value)) return undefined
  const context = text(value, 'context')
  const state = text(value, 'state')
  return context.length === 0 || state.length === 0 ? undefined : { context, state }
}

/** 一条评审 → 端口形状；缺 id 的条目返回 undefined。 */
export function reviewOf(value: unknown): GithubReview | undefined {
  if (!isRecord(value)) return undefined
  const id = count(value, 'id')
  if (id <= 0) return undefined
  const author = authorOf(value)
  return {
    id,
    state: text(value, 'state'),
    login: author.login,
    bot: author.bot,
    body: text(value, 'body'),
    submittedAt: text(value, 'submitted_at') || text(value, 'created_at'),
    commitId: text(value, 'commit_id'),
    url: text(value, 'html_url')
  }
}

/** Issue/PR 号：`.../issues/42`、`.../pulls/42` 的末段。 */
export function issueNumberOf(apiUrl: string): number | undefined {
  const match = /\/(?:issues|pulls)\/(\d+)(?:$|[?#])/.exec(apiUrl)
  return match === null ? undefined : Number(match[1])
}

/** 打开分页的读参数（`--method GET` 是关键：`gh api -f` 默认把请求改成 POST）。 */
function pageArgs(path: string): string[] {
  return ['api', path, '--paginate', '--method', 'GET', '-f', 'per_page=100']
}

/** 限流的文案（与 `commands.test.ts` 的错误脱敏形状一致：只认标准错误里的这几句）。 */
const RATE_LIMITED = /rate limit|secondary rate|abuse detection/i

/**
 * 这个 CLI 失败是不是限流（§I.2 CI 行的失败处理列）：限流会自己恢复，所以读的人应当记录
 * 并在下一轮重试，不当成 Source 的连续失败。GitHub 的限流是 429，或带限流文案的 403
 * （primary / secondary rate limit、abuse detection）。
 */
export function rateLimited(error: unknown): boolean {
  if (!(error instanceof CliError)) return false
  if (error.code === 429) return true
  return error.code === 403 && RATE_LIMITED.test(error.message)
}

/**
 * `gh api` 驱动的读取端口。所有参数都是 argv 数组（§I.4 白名单 + `shell:false`）：
 * 仓库名与数字经这里进入参数，正文永远不出现在读路径里。
 */
export function createGithubApi(commands: CommandsHost, cli: string): GithubApi {
  /** 一条列表读取：解析每一项，畸形条目进 `skipped`。 */
  const readList = async <T>(
    args: readonly string[],
    parse: (value: unknown) => T | undefined
  ): Promise<GithubRead<T>> => {
    const output = await commands.run(cli, args)
    let skipped = 0
    const items: T[] = []
    for (const value of parseArray(output)) {
      const parsed = parse(value)
      if (parsed === undefined) skipped += 1
      else items.push(parsed)
    }
    return { items, skipped }
  }

  /** 一条单对象读取：形状不符只计数，JSON 本身不是对象时抛错。 */
  const readOne = async <T>(
    args: readonly string[],
    parse: (value: unknown) => T | undefined
  ): Promise<GithubRead<T>> => {
    const value = parseJson(await commands.run(cli, args))
    if (!isRecord(value)) return { items: [], skipped: 1 }
    const parsed = parse(value)
    return parsed === undefined ? { items: [], skipped: 1 } : { items: [parsed], skipped: 0 }
  }

  return {
    notifications(): Promise<GithubRead<GithubNotification>> {
      return readList(['api', 'notifications', '--paginate'], notificationOf)
    },
    issue(repository: string, issue: number): Promise<GithubRead<GithubIssue>> {
      return readOne(['api', `repos/${repository}/issues/${issue}`], issueOf)
    },
    issueComments(
      repository: string,
      issue: number,
      since: string | null
    ): Promise<GithubRead<GithubComment>> {
      const args = pageArgs(`repos/${repository}/issues/${issue}/comments`)
      // `--method GET` 下 `-f` 是查询参数（§I.2 的 `?per_page=100` 同义）。
      if (since !== null) args.push('-f', `since=${since}`)
      return readList(args, commentOf)
    },
    pull(repository: string, issue: number): Promise<GithubRead<GithubPull>> {
      return readOne(['api', `repos/${repository}/pulls/${issue}`], pullOf)
    },
    pullReviews(repository: string, issue: number): Promise<GithubRead<GithubReview>> {
      return readList(pageArgs(`repos/${repository}/pulls/${issue}/reviews`), reviewOf)
    },
    pullComments(repository: string, issue: number): Promise<GithubRead<GithubComment>> {
      return readList(pageArgs(`repos/${repository}/pulls/${issue}/comments`), commentOf)
    },
    async checks(repository: string, sha: string): Promise<GithubRead<GithubChecks>> {
      // check-runs 是对象响应：`--slurp` 把分页包成数组，再逐页展平（§I.2 CI 行）。
      const pages = parseJson(
        await commands.run(cli, [
          'api',
          `repos/${repository}/commits/${sha}/check-runs`,
          '--paginate',
          '--slurp',
          '--method',
          'GET',
          '-f',
          'per_page=100'
        ])
      )
      if (!Array.isArray(pages)) throw new Error('GitHub returned a non-array response')
      const runs = checkRunsOf(pages)
      // 总体状态：`/statuses` 是数组响应，与其它列表同一条读法。
      const statuses = await readList(
        pageArgs(`repos/${repository}/commits/${sha}/statuses`),
        commitStatusOf
      )
      return {
        items: [
          {
            headSha: sha,
            checks: sortedChecks(runs.checks),
            statuses: latestStatuses(statuses.items)
          }
        ],
        skipped: runs.skipped + statuses.skipped
      }
    }
  }
}

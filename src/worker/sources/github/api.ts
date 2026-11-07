// GitHub 的读取端口（§I.2 的「通知轮询」与「订阅读取」两行）：只读这些面——
// 通知列表、Issue/PR 本体、Issue 评论、评审与评审评论——而且只经 `CommandsHost` 调 `gh`（§I.4）。
//
// 解析是**容忍**的：GitHub 的 JSON 会多字段、少字段；这里只取要用的那些，畸形条目记进
// `skipped` 由调用方跳过（§I.2「畸形条目跳过并计数」）。传输层失败（不是 JSON）与形状不符
// 分开：前者抛错让这一轮失败、游标不动；后者只计数。
import type { JsonValue } from '../../core/index.ts'
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
}

/** 一个 PR（`/repos/:o/:r/pulls/:n`）；`merged` 供 §I.5 的结束判定。 */
export interface GithubPull {
  readonly number: number
  readonly title: string
  readonly url: string
  readonly state: string
  readonly merged: boolean
  readonly updatedAt: string
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
}

/** 一条评审（`/pulls/:n/reviews` 的一项）；评审的 Trigger 翻译归 #18。 */
export interface GithubReview {
  readonly id: number
  readonly state: string
  readonly login: string
  readonly body: string
  readonly submittedAt: string
  readonly url: string
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
  return {
    number,
    isPull,
    title: text(value, 'title'),
    url: text(value, 'html_url'),
    state: text(value, 'state'),
    updatedAt: text(value, 'updated_at')
  }
}

/** 一个 PR → 端口形状；缺编号的条目返回 undefined（跳过）。 */
export function pullOf(value: unknown): GithubPull | undefined {
  if (!isRecord(value)) return undefined
  const number = count(value, 'number')
  if (number <= 0) return undefined
  return {
    number,
    title: text(value, 'title'),
    url: text(value, 'html_url'),
    state: text(value, 'state'),
    merged: flag(value, 'merged'),
    updatedAt: text(value, 'updated_at')
  }
}

/** 一条评论 → 端口形状；缺 id 的条目返回 undefined。 */
export function commentOf(value: unknown): GithubComment | undefined {
  if (!isRecord(value)) return undefined
  const id = count(value, 'id')
  if (id <= 0) return undefined
  const user = isRecord(value['user']) ? value['user'] : {}
  const login = text(user, 'login')
  const updatedAt = text(value, 'updated_at') || text(value, 'created_at')
  return {
    id,
    login,
    bot: text(user, 'type') === 'Bot' || login.endsWith('[bot]'),
    body: text(value, 'body'),
    createdAt: text(value, 'created_at'),
    updatedAt,
    url: text(value, 'html_url')
  }
}

/** 一条评审 → 端口形状；缺 id 的条目返回 undefined。 */
export function reviewOf(value: unknown): GithubReview | undefined {
  if (!isRecord(value)) return undefined
  const id = count(value, 'id')
  if (id <= 0) return undefined
  const user = isRecord(value['user']) ? value['user'] : {}
  return {
    id,
    state: text(value, 'state'),
    login: text(user, 'login'),
    body: text(value, 'body'),
    submittedAt: text(value, 'submitted_at') || text(value, 'created_at'),
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
    }
  }
}

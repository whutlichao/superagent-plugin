// GitHub 的读取端口（§I.2 的「通知轮询」与「订阅读取」两条的最小面）：只读两种东西——
// 通知列表与 Issue 评论——而且只经 `CommandsHost` 调 `gh`（§I.4）。
//
// 解析是**容忍**的：GitHub 的 JSON 会多字段、少字段；这里只取本票要用的那些，畸形条目
// 记为 undefined 由调用方跳过（§I.2「畸形条目跳过并计数」的种子）。
import type { CommandsHost } from '../commands.ts'

/** 一条通知（`gh api notifications` 的一项，只取本票用到的字段）。 */
export interface GithubNotification {
  readonly id: string
  readonly updatedAt: string
  readonly lastReadAt: string | null
  readonly type: string
  readonly title: string
  readonly apiUrl: string
  readonly repository: string
}

/** 一条 Issue 评论（`/repos/:o/:r/issues/:n/comments` 的一项）。 */
export interface GithubComment {
  readonly id: number
  readonly login: string
  readonly bot: boolean
  readonly body: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly url: string
}

/** GitHub 的读取面（测试用 FakeCommands 实现同一个契约）。 */
export interface GithubApi {
  /** 未读通知；`gh api notifications --paginate`（§I.2）。 */
  notifications(): Promise<readonly GithubNotification[]>
  /** 一条 Issue 的评论；`since` 只回它之后的那些（通知的 `last_read_at`）。 */
  issueComments(repository: string, issue: number, since: string | null): Promise<readonly GithubComment[]>
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

/** 一个对象是否像 `{...}`（null 与数组都不算）。 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 解析一行 JSON；不是 JSON 或不是数组时抛错（让这一轮失败、游标不动）。 */
function parseArray(output: string): readonly unknown[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    throw new Error('GitHub returned a response that is not JSON')
  }
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

/** Issue/PR 号：`.../issues/42`、`.../pulls/42` 的末段。 */
export function issueNumberOf(apiUrl: string): number | undefined {
  const match = /\/(?:issues|pulls)\/(\d+)(?:$|[?#])/.exec(apiUrl)
  return match === null ? undefined : Number(match[1])
}

/**
 * `gh api` 驱动的读取端口。所有参数都是 argv 数组（§I.4 白名单 + `shell:false`）：
 * 仓库名与数字经这里进入参数，正文永远不出现在读路径里。
 */
export function createGithubApi(commands: CommandsHost, cli: string): GithubApi {
  return {
    async notifications(): Promise<readonly GithubNotification[]> {
      const output = await commands.run(cli, ['api', 'notifications', '--paginate'])
      return parseArray(output).flatMap((value) => {
        const notification = notificationOf(value)
        return notification === undefined ? [] : [notification]
      })
    },
    async issueComments(
      repository: string,
      issue: number,
      since: string | null
    ): Promise<readonly GithubComment[]> {
      const args = ['api', `repos/${repository}/issues/${issue}/comments`, '--paginate', '-f', 'per_page=100']
      // `gh api -f` 对 GET 是查询参数（§I.2 的 `?per_page=100` 同义）。
      if (since !== null) args.push('-f', `since=${since}`)
      const output = await commands.run(cli, args)
      return parseArray(output).flatMap((value) => {
        const comment = commentOf(value)
        return comment === undefined ? [] : [comment]
      })
    }
  }
}

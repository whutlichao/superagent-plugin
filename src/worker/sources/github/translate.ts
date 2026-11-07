// GitHub 事件 → Trigger 的翻译（§I.2「Trigger 翻译」行）：本票只翻 Issue 评论。
//
// 三条规则（每条都在 `tests/sources-github.test.ts` 里）：
// - id 由 `key('github', 'comment', <native id>, <updated_at>)` 派生：编辑算新事件，重复读
//   同一版本是同一个 id（引擎按 id 幂等）；
// - `addressed='mention'` 当且仅当正文点名了 agent 账号；没点名只是「发出来了」，是否
//   监听由 Source 的 scope 决定（§I.1 `scope`）；
// - 自身消息在翻译之前就被丢掉（`isSelf`），不产生 Trigger。
import { key } from '../../core/index.ts'
import type { ChannelRef, Trigger } from '../../core/index.ts'
import type { GithubComment } from './api.ts'

/** GitHub 的 Thread 键：Issue/PR 号（§I.2 Thread 行）。 */
export const githubThread = (issue: number): { source: 'github'; id: string } => ({
  source: 'github',
  id: String(issue)
})

/** 评论回复的地址：Issue 评论（评审线程回复由 #18 扩展）。 */
export function githubCommentChannel(repository: string, issue: number): ChannelRef {
  return {
    source: 'github',
    thread: `github:${issue}`,
    address: { repo: repository, issue: String(issue) }
  }
}

/** 正文是否点名了 `login`（`@name`，大小写不敏感；`@name[bot]` 也算点名 bot 本身）。 */
export function mentionsAgent(body: string, login: string): boolean {
  const wanted = login.trim()
  // GitHub login 最长 39 字符；更长的一律不当点名（也避免把用户输入拼进正则的 ReDoS 面）。
  if (wanted.length === 0 || wanted.length > 39) return false
  const pattern = new RegExp(`(^|[^\\w@/-])@${escapeRegExp(wanted)}(\\[bot\\])?(?![\\w-])`, 'i')
  return pattern.test(body)
}

/** 正则转义（login 里可能有 `.`/`-`）。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 这条评论是不是 agent 自己写的（§I.2：自身消息丢弃）。 */
export function isSelf(comment: GithubComment, login: string): boolean {
  return login.trim().length > 0 && comment.login.toLowerCase() === login.trim().toLowerCase()
}

/** Trigger id：同一评论版本永远同一个 id（§I.2 Trigger id 行）。 */
export function commentTriggerId(comment: GithubComment): string {
  return key('github', 'comment', String(comment.id), comment.updatedAt)
}

/** 一条 Issue 评论 → Trigger；`observeComments` 决定它是否被标成「观察」型。 */
export function commentTrigger(input: {
  readonly repository: string
  readonly issue: number
  readonly comment: GithubComment
  readonly login: string
  readonly observeComments: boolean
}): Trigger {
  const { repository, issue, comment, login } = input
  const mentioned = mentionsAgent(comment.body, login)
  return {
    id: commentTriggerId(comment),
    source: 'github',
    threads: [githubThread(issue)],
    actor: { source: 'github', id: comment.login },
    human: !comment.bot,
    ...(mentioned ? { addressed: 'mention' as const } : {}),
    at: comment.updatedAt,
    text: comment.body,
    ...(comment.url.length === 0 ? {} : { url: comment.url }),
    channel: githubCommentChannel(repository, issue),
    meta: {
      kind: 'comment',
      repository,
      issue,
      commentId: comment.id,
      updatedAt: comment.updatedAt
    }
  }
}

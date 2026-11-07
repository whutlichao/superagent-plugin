// GitHub 事件 → Trigger 的翻译（§I.2「Trigger 翻译」行）：评论、评审、评审评论与 Issue/PR
// 正文版本都走这里。
//
// 五条规则（每条都在 `tests/sources-github.test.ts` 里）：
// - id 由 `key('github', '<kind>', <native id>, <updated_at>)` 派生：编辑算新事件，重复读
//   同一版本是同一个 id（引擎按 id 幂等）；
// - `addressed='mention'` 当且仅当正文点名了 agent 账号；没点名只是「发出来了」，是否
//   监听由 Source 的 scope 决定（§I.1 `scope`）；
// - 自身消息在翻译之前就被丢掉（`isSelf`），不产生 Trigger；
// - `human = !isBot(login)`：`[bot]` 后缀或 GitHub App 都不是人；
// - 评审评论额外挂一个 `github:<number>/rt/<root comment id>` 相关 Thread：只加语境，
//   路由仍看 primary（Issue/PR 会话）。`root` 取 `in_reply_to_id`，根评论自己就是根。
import { key } from '../../core/index.ts'
import type { ChannelRef, Trigger } from '../../core/index.ts'
import type { GithubComment, GithubIssue, GithubPull, GithubReview } from './api.ts'

/** GitHub 的 Thread 键：Issue/PR 号（§I.2 Thread 行）。 */
export const githubThread = (issue: number): { source: 'github'; id: string } => ({
  source: 'github',
  id: String(issue)
})

/**
 * 评审线程的 Thread 键：`github:<number>/rt/<root comment id>`（§I.2 Thread 行）。
 * 它只与 Issue/PR Thread 相关（`thread.correlated`），从不承担 Eval。
 */
export const githubReviewThread = (
  issue: number,
  root: number
): { source: 'github'; id: string } => ({
  source: 'github',
  id: `${issue}/rt/${root}`
})

/**
 * 回复地址：Issue/PR 会话评论；`root` 给出时是评审线程（回复走该根评论的 replies 端点）。
 * 地址字段是 Source 自己的词汇，core 不解释（§D.1）。
 */
export function githubCommentChannel(repository: string, issue: number, root?: number): ChannelRef {
  return {
    source: 'github',
    thread: `github:${issue}`,
    address:
      root === undefined
        ? { repo: repository, issue: String(issue) }
        : { repo: repository, issue: String(issue), root: String(root) }
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

/**
 * 作者是不是 bot：GitHub App（`type: 'Bot'`）或 `[bot]` 后缀（§I.2 Actor 行）。
 * 解析层已经给过一次结论；这里再按 login 兜一层，调用方不必记住两种形态。
 */
export function isBot(login: string, app: boolean): boolean {
  return app || /\[bot\]$/i.test(login)
}

/** 这条评论/评审是不是 agent 自己写的（§I.2：自身消息丢弃）。 */
export function isSelf(message: { readonly login: string }, login: string): boolean {
  return login.trim().length > 0 && message.login.toLowerCase() === login.trim().toLowerCase()
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
    human: !isBot(comment.login, comment.bot),
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

/**
 * 评审的正文：非 `COMMENTED` 的评审是「决定」，即使没有正文也要让 worker 看见（上游同）；
 * `COMMENTED` 且没正文的评审不产生可读内容。
 */
function reviewText(review: GithubReview): string {
  const decision =
    review.state.length > 0 && review.state !== 'COMMENTED'
      ? `${review.state} review of commit ${review.commitId || 'unknown'}`
      : ''
  const body = review.body.trim()
  return [decision, body].filter((part) => part.length > 0).join('\n\n')
}

/** 一条提交的评审 → Trigger（§I.2 Trigger 翻译：review）。 */
export function reviewTrigger(input: {
  readonly repository: string
  readonly pull: number
  readonly review: GithubReview
  readonly login: string
}): Trigger {
  const { repository, pull, review, login } = input
  const mentioned = mentionsAgent(review.body, login)
  return {
    id: key('github', 'review', String(review.id), review.submittedAt),
    source: 'github',
    threads: [githubThread(pull)],
    actor: { source: 'github', id: review.login },
    human: !isBot(review.login, review.bot),
    ...(mentioned ? { addressed: 'mention' as const } : {}),
    at: review.submittedAt,
    text: reviewText(review),
    ...(review.url.length === 0 ? {} : { url: review.url }),
    channel: githubCommentChannel(repository, pull),
    meta: {
      kind: 'review',
      repository,
      issue: pull,
      reviewId: review.id,
      state: review.state,
      commitId: review.commitId,
      updatedAt: review.submittedAt
    }
  }
}

/**
 * 一条评审评论 → Trigger（§I.2 Trigger 翻译：review-comment）。
 *
 * `root = in_reply_to_id ?? id`：GitHub 的 `in_reply_to_id` 指向评审线程的第一条评论；
 * 根评论自己没有它，自己就是根。回复地址带上 `root`，Channel 才能回到那个评审线程；
 * 第二个 Thread 是 `github:<n>/rt/<root>`，只加语境，不承担 Eval。
 */
export function reviewCommentTrigger(input: {
  readonly repository: string
  readonly pull: number
  readonly comment: GithubComment
  readonly login: string
}): Trigger {
  const { repository, pull, comment, login } = input
  const root = comment.inReplyTo ?? comment.id
  const mentioned = mentionsAgent(comment.body, login)
  return {
    id: key('github', 'review-comment', String(comment.id), comment.updatedAt),
    source: 'github',
    threads: [githubThread(pull), githubReviewThread(pull, root)],
    actor: { source: 'github', id: comment.login },
    human: !isBot(comment.login, comment.bot),
    ...(mentioned ? { addressed: 'mention' as const } : {}),
    at: comment.updatedAt,
    text: comment.body,
    ...(comment.url.length === 0 ? {} : { url: comment.url }),
    channel: githubCommentChannel(repository, pull, root),
    meta: {
      kind: 'review-comment',
      repository,
      issue: pull,
      commentId: comment.id,
      rootCommentId: root,
      reviewThread: `${pull}/rt/${root}`,
      ...(comment.path.length === 0 ? {} : { path: comment.path, line: comment.line }),
      updatedAt: comment.updatedAt
    }
  }
}

/** 一条 Issue/PR 正文版本的来源：issues 视图与 pulls 视图的字段同形。 */
export type GithubBodySource = Pick<
  GithubIssue | GithubPull,
  'title' | 'body' | 'login' | 'bot' | 'createdAt' | 'updatedAt' | 'url'
>

/**
 * Issue/PR 正文 → Trigger（§I.2 Trigger 翻译：issue-body 的编辑版本）。
 *
 * id 用 `updated_at`：编辑是新的版本、新的 Trigger；同一版本重复读是 duplicate。
 * 正文不参与 id——它只负责 `addressed`（正文里 @ 了 agent 才是 mention）。
 */
export function issueBodyTrigger(input: {
  readonly repository: string
  readonly number: number
  readonly isPull: boolean
  readonly source: GithubBodySource
  /** agent 自己的 GitHub 账号：只用来判定正文有没有点名它。 */
  readonly login: string
}): Trigger {
  const { repository, number, isPull, source, login } = input
  const mentioned = mentionsAgent(source.body, login)
  const text = [source.title.trim(), source.body.trim()].filter((part) => part.length > 0).join('\n\n')
  return {
    id: key('github', 'issue', String(number), source.updatedAt),
    source: 'github',
    threads: [githubThread(number)],
    actor: { source: 'github', id: source.login },
    human: !isBot(source.login, source.bot),
    ...(mentioned ? { addressed: 'mention' as const } : {}),
    at: source.updatedAt,
    text,
    ...(source.url.length === 0 ? {} : { url: source.url }),
    channel: githubCommentChannel(repository, number),
    meta: {
      kind: isPull ? 'pull' : 'issue',
      repository,
      issue: number,
      updatedAt: source.updatedAt
    }
  }
}

/**
 * Issue/PR 正文的指纹（§I.2 的「issue-body 编辑」）：只有正文内容，不含 token/正文本身；
 * `key()` 是确定性的 sha256 前缀，所以同一正文永远同一指纹。Source 只把它放进 kv，
 * 下一次读同一 Thread 时比较，正文没变就不产 Trigger（评论活动不会污染它）。
 */
export function bodyFingerprint(body: string): string {
  return key('github-content', body)
}

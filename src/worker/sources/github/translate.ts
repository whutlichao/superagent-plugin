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
import type { GithubChecks, GithubComment, GithubIssue, GithubPull, GithubReview } from './api.ts'

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
 *
 * 导出给读面：资源读取与线程上下文里的评审消息与 Trigger 用同一份正文（一处定义）。
 */
export function reviewText(review: GithubReview): string {
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

/** CI 结论的三档（§I.2 CI 行）：成功、失败、进行中。 */
export type CiState = 'success' | 'failure' | 'running'

/** 算作失败的检查结论与状态（`success`/`neutral`/`skipped`/`stale` 不算，上游同）。 */
const FAILING = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
  'startup_failure',
  'error'
])

/**
 * 失败的检查与状态名（按名字排序）：`ciState`、指纹与两种 CI 摘要共用这一份判定。
 * 排序让「同一组失败」永远同一个指纹：GitHub 的返回顺序不参与比较。
 */
export function ciFailures(checks: GithubChecks): string[] {
  return [
    ...checks.checks
      .filter((check) => check.conclusion !== null && FAILING.has(check.conclusion))
      .map((check) => check.name),
    ...checks.statuses.filter((status) => FAILING.has(status.state)).map((status) => status.context)
  ].sort()
}

/**
 * 一个提交的 CI 读数 → 三档结论：有失败就是失败（即使还有在跑的，上游同）；否则还在跑
 * 就是进行中；全部完成且没有失败就是成功。
 */
export function ciState(checks: GithubChecks): CiState {
  if (ciFailures(checks).length > 0) return 'failure'
  const running =
    checks.checks.some((check) => check.status !== 'completed') ||
    checks.statuses.some((status) => status.state === 'pending')
  return running ? 'running' : 'success'
}

/** 摘要里列名字的数量上限（其余写成「and N more」，上游同）。 */
const SUMMARY_NAMES = 5

/** 结果的名字列表：失败时只列失败的名字，进行中时只列还在跑的名字。 */
function names(list: readonly string[]): string {
  const shown = list.slice(0, SUMMARY_NAMES).join(', ')
  return list.length > SUMMARY_NAMES ? `${shown}, and ${list.length - SUMMARY_NAMES} more` : shown
}

/**
 * CI 读数的一句话摘要（Trigger 的正文）：失败/进行中/通过 + 计数 + 在哪里 + 「去读哪个
 * 资源」。模型据此决定要不要看细节；资源名与 §I.2「资源读取」同一写法。
 */
function ciLine(checks: GithubChecks, where: string): string {
  const head = checks.headSha.slice(0, 7) || 'unknown'
  const at = `on ${where} at ${head}`
  const total = checks.checks.length + checks.statuses.length
  const failed = ciFailures(checks)
  const running = [
    ...checks.checks.filter((check) => check.status !== 'completed').map((check) => check.name),
    ...checks.statuses.filter((status) => status.state === 'pending').map((status) => status.context)
  ]
  return failed.length > 0
    ? `CI failed ${failed.length}/${total} ${at}: ${names(failed)}`
    : running.length > 0
      ? `CI running ${running.length}/${total} ${at}: ${names(running)}`
      : `CI passed ${total}/${total} ${at}`
}

/** 一个 PR 的 CI 摘要（§I.2 CI 行）：下面那一行是模型该去读的资源名。 */
export function ciSummary(checks: GithubChecks, pull: number): string {
  return `${ciLine(checks, `PR #${pull}`)}\nRead github/pulls/${pull}/checks for every check.`
}

/**
 * 默认分支 CI 的摘要（§I.2 receive-all 行）：默认分支没有 PR 编号，读法是那个提交的检查。
 * 只有失败集合变化时才出 Trigger（`branchCiFingerprint`），所以措辞照抄 `ciSummary`。
 */
export function branchCiSummary(checks: GithubChecks, branch: string): string {
  return `${ciLine(checks, branch)}\nRead github/commits/${checks.headSha}/checks for every check.`
}

/**
 * 一个提交的 CI 指纹（§I.2 CI 行）：只由检查与状态的**结果**派生，与摘要文本和时刻无关。
 * 同一结果永远同一指纹；轮询据此判断「只在变化时出 Trigger」。
 */
export function ciFingerprint(checks: GithubChecks): string {
  return key(
    'github',
    'ci',
    checks.headSha,
    JSON.stringify({
      checks: checks.checks.map((check) => [check.name, check.status, check.conclusion]),
      statuses: checks.statuses.map((status) => [status.context, status.state])
    })
  )
}

/**
 * 一个提交的 CI 读数 → Trigger（§I.2 CI 行、§K.2 第 6 条）。
 *
 * CI 没有发送者：`actor` 是 Source 自己、`id` 为空，`human=false`，永不带 `addressed`——
 * Gate 因此只读该接收行的最后一格。Thread 是它所属的 PR，回复地址是 PR 会话。
 * id 由指纹派生：同一结果永远同一 id（重复读到只是 `duplicate`），结果变化才是新事件。
 */
export function ciTrigger(input: {
  readonly repository: string
  readonly pull: number
  readonly checks: GithubChecks
  /** 这一轮读到的时刻（CI 自己没有 `updated_at`）。 */
  readonly at: string
  /** PR 页面地址；读不到时省略。 */
  readonly url?: string
}): Trigger {
  const { repository, pull, checks, at, url } = input
  return {
    id: key('github', 'ci', String(pull), ciFingerprint(checks)),
    source: 'github',
    threads: [githubThread(pull)],
    actor: { source: 'github', id: '' },
    human: false,
    at,
    text: ciSummary(checks, pull),
    ...(url === undefined || url.length === 0 ? {} : { url }),
    channel: githubCommentChannel(repository, pull),
    meta: {
      kind: 'ci',
      repository,
      issue: pull,
      headSha: checks.headSha,
      state: ciState(checks)
    }
  }
}

/**
 * 默认分支 CI 的 Thread 键：`github:ci:<branch>`（§I.2 receive-all 行）。它没有 Issue/PR 编号
 * 可挂，所以用分支名做 id；`subscribedThreads` 只认数字 id，因此永远不会把它当成 Issue 去轮询。
 */
export const githubBranchThread = (branch: string): { source: 'github'; id: string } => ({
  source: 'github',
  id: `ci:${branch}`
})

/**
 * 默认分支 CI 的指纹（§I.2 receive-all 行）：只由**失败的名字**派生。
 *
 * 通过、进行中都不算变化：默认分支每推一个新提交就跑一遍 CI，若按整份读数比指纹，每个绿提交
 * 都会产一条「CI 通过」的 Trigger，那是噪音而不是反馈。失败集合变了才是新闻（坏了、或修好了）。
 */
export function branchCiFingerprint(checks: GithubChecks): string {
  return key('github', 'ci', 'branch', JSON.stringify(ciFailures(checks)))
}

/**
 * 默认分支 CI 的变化 → Trigger（§I.2 receive-all 行、§K.2 第 6 条）。
 *
 * 与 PR 的 CI 同：没有发送者（`actor.id` 为空、`human=false`、永不带 `addressed`），准入行只看
 * 最后一格。区别是它没有可回复的会话——默认分支的 CI 不属于任何 Issue/PR，所以没有 `channel`；
 * Thread 是 `github:ci:<branch>`，语境是这条 Trigger 自己（见 `githubThreadContext`）。
 */
export function branchCiTrigger(input: {
  readonly repository: string
  readonly branch: string
  readonly checks: GithubChecks
  /** 这一轮读到的时刻（CI 自己没有 `updated_at`）。 */
  readonly at: string
  /** 提交页面的地址；读不到时省略。 */
  readonly url?: string
}): Trigger {
  const { repository, branch, checks, at, url } = input
  return {
    id: key('github', 'ci', `branch:${branch}`, branchCiFingerprint(checks)),
    source: 'github',
    threads: [githubBranchThread(branch)],
    actor: { source: 'github', id: '' },
    human: false,
    at,
    text: branchCiSummary(checks, branch),
    ...(url === undefined || url.length === 0 ? {} : { url }),
    meta: {
      kind: 'ci',
      repository,
      branch,
      headSha: checks.headSha,
      state: ciState(checks)
    }
  }
}

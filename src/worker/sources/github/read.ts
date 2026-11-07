// GitHub 的读面（§I.2 的「find」「线程上下文」「资源读取」三行）：搜索输入、评估窗口的语境页，
// 以及模型按资源名读的回执。
//
// 三种读法各自回答一个问题：
// - `githubFind`：用户粘进来的东西（`#12`、Issue/PR 链接、带锚点的评论链接）指向哪个 Thread，
//   以及拿什么词去搜 Trigger；它是**纯函数**，没有 I/O，推不出来的 key 不编；
// - `githubThreadContext`：一条 Trigger 所在 Thread 的一页语境（描述 + 评论页、评审页、评审
//   线程页），每页 20 条并带下一页游标，供评估窗口有界地读；
// - `githubRead`：`github/issues/<n>` 这一族资源名读到的东西（描述、评论页、评审页、评审线程、
//   检查结果），是技能文本里教模型用的读法。
//
// 两条硬纪律（与 Feishu 的读面同）：
// - **无权限 / 已删是状态，不是空**：`forbidden` / `deleted` / `missing` 各有明确取值；只有真正
//   可重试的失败（限流、超时、没有 HTTP 码）才抛错，由调用方给 unavailable；
// - **不猜内容**：读不到的东西不编，未知资源名直接拒绝并说明可用写法。
//
// 依赖纪律（§C.2）：只 import 命令端口、同目录的读取端口与翻译；`gh` 只经 `CommandsHost` 调用，
// 参数是 argv 数组（§I.4）。本文件不读时钟、不建计时器、不做网络。
import type { Trigger } from '../../core/index.ts'
import type { ContextMessage, ContextPart, ContextPartName, ThreadContext } from '../admission-context.ts'
import { CliError } from '../commands.ts'
import type { CommandsHost } from '../commands.ts'
import { createGithubApi, rateLimited } from './api.ts'
import type { GithubApi, GithubChecks, GithubComment, GithubPull, GithubReview } from './api.ts'
import type { GithubConfig } from './config.ts'
import { isBot, reviewText } from './translate.ts'

/** 一页资源读的条数（§I.2「资源读取」行与「线程上下文」行：每页 20 条）。 */
export const GITHUB_READ_PAGE_SIZE = 20

/**
 * 资源名不是 §I.2 列出的写法（或该写法与这个编号的 Issue/PR 不匹配）：调用方据此回
 * `unknown_resource`，而不是把它当成可重试的远端失败（§G.2 的 read 行）。
 */
export class GithubResourceError extends Error {
  readonly resource: string

  constructor(message: string, resource: string) {
    super(message)
    this.name = 'GithubResourceError'
    this.resource = resource
  }
}

/** GitHub 的 Thread key：Issue/PR 号（§I.2 Thread 行）。 */
const threadKeyOf = (number: string): string => `github:${number}`

/**
 * 一次读的状态。`available` 之外都不是「空结果」（§I.2 的失败处理行）：
 * - `forbidden`：agent 账号读不了这个仓库/资源（401/403，限流除外）；
 * - `deleted`：远端已删（410）；
 * - `missing`：找不到（404）——可能是真的不存在，也可能是没了权限，所以两档分开说。
 */
export type GithubReadStatus = 'available' | 'forbidden' | 'deleted' | 'missing'

/** 一条 Issue/PR 描述（`github/issues/<n>` 与 `github/pulls/<n>`）。 */
export interface GithubDescription {
  readonly number: number
  readonly isPull: boolean
  readonly title: string
  readonly state: string
  readonly url: string
  /** PR 已合并（图形上的 merged，不是 state）。 */
  readonly merged?: boolean
  /** PR 还是草稿。 */
  readonly draft?: boolean
  /** PR 的 head / base 分支名。 */
  readonly head?: string
  readonly base?: string
  /** 描述本体：与评论同一种消息形状，标题当作首行。 */
  readonly message: ContextMessage
}

/** 一次资源读的结果：描述、页（消息 + 下一页游标）或检查结果（§I.2「资源读取」行）。 */
export type GithubResourceRead =
  | {
      readonly kind: 'description'
      readonly status: GithubReadStatus
      readonly description: GithubDescription | null
      readonly body: Record<string, unknown>
    }
  | {
      readonly kind: 'messages'
      readonly status: GithubReadStatus
      readonly messages: readonly ContextMessage[]
      readonly next?: string | undefined
      readonly body: Record<string, unknown>
    }
  | {
      readonly kind: 'checks'
      readonly status: GithubReadStatus
      readonly checks: GithubChecks | null
      readonly body: Record<string, unknown>
    }

/** 一次资源读的输入：命令端口、CLI、仓库与资源名。 */
export interface GithubReadRequest {
  readonly host: CommandsHost
  readonly cli: string
  readonly repository: string
  readonly resource: string
  readonly signal?: AbortSignal | undefined
}

/**
 * 把一次 CLI 失败折成明确状态（§I.2「失败处理」列）：
 * - 401/403（限流除外）→ `forbidden`；
 * - 410 → `deleted`；404 → `missing`；
 * - 其余（限流、超时、崩溃、没有 HTTP 码）→ undefined，调用方抛错让它重试。
 */
export function githubReadStatus(error: unknown): GithubReadStatus | undefined {
  if (!(error instanceof CliError)) return undefined
  // 限流会自己恢复：它不是「读不到」，而是「这一轮先不读」。
  if (rateLimited(error)) return undefined
  if (error.code === 410) return 'deleted'
  if (error.code === 404) return 'missing'
  if (error.code === 401 || error.code === 403) return 'forbidden'
  return undefined
}

/**
 * Issue/PR 链接（可带 `#issuecomment-…` / `#discussion_r…` 锚点）：链接文本、编号。
 * 没写 scheme（用户粘的一半链接）也算；`pull` 是网页路径，`pulls` 是 API 路径，两种都认。
 */
const GITHUB_LINK =
  /(?:https?:\/\/(?:www\.)?)?github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pulls?)\/(\d+)(?:#[\w-]*)?/gi

/** 正文里的短引用（`#12`）；`#discussion_r…` 这类锚点后面不是数字，不会被当成短引用。 */
const SHORT_REF = /(?:^|[^\w#])#(\d+)(?![\w-])/g

/**
 * `find`（§I.2「find」行、§M.2 Search）：三类输入 → Thread key + 搜索词。
 *
 * - `#12`：工单里常用的短引用，直接是 Thread 12；
 * - Issue/PR 链接：`github.com/<owner>/<repo>/(issues|pull)/<n>`，Thread 是那个编号；
 * - 评论链接：带 `#issuecomment-<id>` 或 `#discussion_r<id>` 锚点，Thread 仍是它所在 Issue/PR
 *   的编号。评审线程的 `github:<n>/rt/<root>` 只在下一条评论的 `in_reply_to_id` 上才知道根是谁，
 *   而 `find` 没有 I/O，所以不编这个 key：搜索词里留着原链接，命中那条评论自己。
 *
 * 搜索词保留用户原文（整段查询）与规范化后的链接（去重）；`threads` 只放能确定的 key。
 */
export function githubFind(query: string): {
  readonly threads: readonly string[]
  readonly terms: readonly string[]
} {
  const trimmed = query.trim()
  const threads: string[] = []
  const terms: string[] = []
  const addThread = (key: string): void => {
    if (!threads.includes(key)) threads.push(key)
  }
  const addTerm = (value: string): void => {
    if (value.length > 0 && !terms.includes(value)) terms.push(value)
  }
  addTerm(trimmed)
  for (const match of trimmed.matchAll(SHORT_REF)) addThread(threadKeyOf(match[1] as string))
  for (const match of trimmed.matchAll(GITHUB_LINK)) {
    addTerm(match[0])
    addThread(threadKeyOf(match[1] as string))
  }
  return { threads, terms }
}

/** 资源名：`github/<issues|pulls>/<n>[/<section>[/<page|comment-id>]]`（§I.2「资源读取」行）。 */
const RESOURCE = /^github\/(issues|pulls)\/([1-9]\d*)(?:\/(comments|reviews|thread|checks)(?:\/([1-9]\d*))?)?$/

/** 提交的检查结果：`github/commits/<sha>/checks`（默认分支的 CI 没有 PR 编号）。 */
const COMMIT_CHECKS = /^github\/commits\/([0-9a-f]{7,40})\/checks$/

/** 资源名的可用写法（拒绝未知资源时原样告诉调用方）。 */
const RESOURCE_FORMS =
  'github/issues/<number>, github/pulls/<number>, github/issues/<number>/comments/<page>, ' +
  'github/pulls/<number>/comments/<page>, github/pulls/<number>/reviews/<page>, ' +
  'github/pulls/<number>/thread/<comment-id>, github/pulls/<number>/checks or ' +
  'github/commits/<sha>/checks'

/** 一条消息（`ContextMessage`）的 id：页面链接就是它的身份（没有链接时退回原生 id）。 */
const messageId = (url: string, fallback: string): string => (url.length > 0 ? url : fallback)

/** 一条 Issue/PR 描述 → 语境里的一条消息（标题当作正文首行，与 Trigger 的正文同形）。 */
function descriptionOf(input: {
  readonly number: number
  readonly isPull: boolean
  readonly title: string
  readonly state: string
  readonly url: string
  readonly body: string
  readonly login: string
  readonly bot: boolean
  readonly at: string
  readonly pull?: GithubPull
}): GithubDescription {
  const { number, isPull, title, state, url, body, login, bot, at, pull } = input
  const id = messageId(url, String(number))
  return {
    number,
    isPull,
    title,
    state,
    url,
    ...(pull === undefined
      ? {}
      : {
          merged: pull.merged,
          draft: pull.draft,
          ...(pull.headRef.length === 0 ? {} : { head: pull.headRef }),
          ...(pull.baseRef.length === 0 ? {} : { base: pull.baseRef })
        }),
    message: {
      id,
      from: login,
      at,
      text: [title.trim(), body.trim()].filter((part) => part.length > 0).join('\n\n'),
      ...(isBot(login, bot) ? { bot: true as const } : {}),
      ...(url.length === 0 ? {} : { url })
    }
  }
}

/** 一次描述读的结果：`body` 把同一些字段摊平，方便只读 `body` 的调用方。 */
function descriptionResult(
  status: GithubReadStatus,
  description: GithubDescription | null
): GithubResourceRead {
  return {
    kind: 'description',
    status,
    description,
    body: { status, next_resource: null, ...(description === null ? {} : { ...description }) }
  }
}

/** 读一条 Issue 或 PR 的描述（`github/issues/<n>` 与 `github/pulls/<n>`）。 */
async function readDescription(
  api: GithubApi,
  request: GithubReadRequest,
  number: number,
  isPull: boolean
): Promise<GithubResourceRead> {
  try {
    if (isPull) {
      const read = await api.pull(request.repository, number)
      const pull = read.items[0]
      if (pull === undefined) return descriptionResult('missing', null)
      return descriptionResult(
        'available',
        descriptionOf({
          number,
          isPull: true,
          title: pull.title,
          state: pull.state,
          url: pull.url,
          body: pull.body,
          login: pull.login,
          bot: pull.bot,
          at: pull.createdAt,
          pull
        })
      )
    }
    const read = await api.issue(request.repository, number)
    const issue = read.items[0]
    if (issue === undefined) return descriptionResult('missing', null)
    return descriptionResult(
      'available',
      descriptionOf({
        number,
        isPull: issue.isPull,
        title: issue.title,
        state: issue.state,
        url: issue.url,
        body: issue.body,
        login: issue.login,
        bot: issue.bot,
        at: issue.createdAt
      })
    )
  } catch (error) {
    const status = githubReadStatus(error)
    if (status === undefined) throw error
    return descriptionResult(status, null)
  }
}

/** 一条评论 → 语境里的消息（会话评论与评审评论同形，§I.1 的 `ContextMessage`）。 */
function commentMessage(comment: GithubComment): ContextMessage {
  return {
    id: messageId(comment.url, String(comment.id)),
    from: comment.login,
    at: comment.createdAt,
    text: comment.body,
    ...(isBot(comment.login, comment.bot) ? { bot: true as const } : {}),
    // 评审线程里的回复指向根评论：`in_reply_to_id` 就是 GitHub 给的根（§I.2 评审线程行）。
    ...(comment.inReplyTo === null ? {} : { replyTo: String(comment.inReplyTo) }),
    ...(comment.path.length === 0
      ? {}
      : { path: comment.path, ...(comment.line === null ? {} : { line: comment.line }) }),
    ...(comment.url.length === 0 ? {} : { url: comment.url })
  }
}

/** 一条评审 → 语境里的消息（正文与 Trigger 用同一份 `reviewText`，一处定义）。 */
function reviewMessage(review: GithubReview): ContextMessage {
  return {
    id: messageId(review.url, String(review.id)),
    from: review.login,
    at: review.submittedAt,
    text: reviewText(review),
    ...(isBot(review.login, review.bot) ? { bot: true as const } : {}),
    ...(review.url.length === 0 ? {} : { url: review.url })
  }
}

/** 一页读的资源名：它本身就是下一页的游标（`next_resource`，§I.2「资源读取」行）。 */
function pageResource(
  kind: 'issues' | 'pulls',
  number: number,
  section: 'comments' | 'reviews',
  page: number
): string {
  return `github/${kind}/${number}/${section}/${page}`
}

/** 一次页读的结果：消息、下一页游标（满页才有），以及 `body` 里的同一份读数。 */
function messagesResult(
  status: GithubReadStatus,
  messages: readonly ContextMessage[],
  next: string | undefined,
  skipped = 0
): GithubResourceRead {
  return {
    kind: 'messages',
    status,
    messages,
    ...(next === undefined ? {} : { next }),
    body: {
      status,
      next_resource: next ?? null,
      messages,
      ...(skipped === 0 ? {} : { skipped })
    }
  }
}

/** 读一页评论或评审（`/comments/<page>`、`/reviews/<page>`）。 */
async function readPage(
  api: GithubApi,
  request: GithubReadRequest,
  kind: 'issues' | 'pulls',
  number: number,
  section: 'comments' | 'reviews',
  page: number
): Promise<GithubResourceRead> {
  /** 满页才算「可能还有下一页」：短页就是末页。 */
  const nextOf = (count: number): string | undefined =>
    count === GITHUB_READ_PAGE_SIZE ? pageResource(kind, number, section, page + 1) : undefined
  try {
    if (section === 'reviews') {
      const read = await api.pullReviewsPage(request.repository, number, page, GITHUB_READ_PAGE_SIZE)
      const messages = read.items.map(reviewMessage)
      return messagesResult('available', messages, nextOf(messages.length), read.skipped)
    }
    // `pulls/<n>/comments` 是行内评审讨论，`issues/<n>/comments` 是会话评论（§I.2 资源读取行）。
    const read =
      kind === 'pulls'
        ? await api.pullCommentsPage(request.repository, number, page, GITHUB_READ_PAGE_SIZE)
        : await api.issueCommentsPage(request.repository, number, page, GITHUB_READ_PAGE_SIZE)
    const messages = read.items.map(commentMessage)
    return messagesResult('available', messages, nextOf(messages.length), read.skipped)
  } catch (error) {
    const status = githubReadStatus(error)
    if (status === undefined) throw error
    return messagesResult(status, [], undefined)
  }
}

/** 一次检查读的结果：head 提交、检查运行与提交状态（§I.2「资源读取」行）。 */
function checksResult(
  status: GithubReadStatus,
  checks: GithubChecks | null,
  skipped = 0
): GithubResourceRead {
  return {
    kind: 'checks',
    status,
    checks,
    body: {
      status,
      next_resource: null,
      ...(checks === null ? {} : { checks }),
      ...(skipped === 0 ? {} : { skipped })
    }
  }
}

/**
 * 一条评审评论所在的评审线程：根是 `in_reply_to_id`（根评论自己没有它），线程 = 根 + 回复。
 * 顺序按提交时刻（GitHub 不保证返回顺序）；名字给的是回复的 id 时先找到它的根。
 */
export function reviewThreadOf(
  comments: readonly GithubComment[],
  commentId: number
): readonly GithubComment[] {
  const named = comments.find((comment) => comment.id === commentId)
  if (named === undefined) return []
  const root = named.inReplyTo ?? named.id
  // 同一秒内的根与回复按时刻分不开（GitHub 的时间戳只到秒）：再按 id 排，根总在前面。
  return comments
    .filter((comment) => comment.id === root || comment.inReplyTo === root)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id - right.id)
}

/** 读一条评审线程（`github/pulls/<n>/thread/<comment-id>`）。 */
async function readReviewThread(
  api: GithubApi,
  request: GithubReadRequest,
  number: number,
  commentId: number
): Promise<GithubResourceRead> {
  try {
    const read = await api.pullComments(request.repository, number)
    const thread = reviewThreadOf(read.items, commentId)
    // 没有这个 id 的评论 / 评论已被删：线程读不到是 `missing`，不是「空线程」。
    if (thread.length === 0) return messagesResult('missing', [], undefined, read.skipped)
    return messagesResult('available', thread.map(commentMessage), undefined, read.skipped)
  } catch (error) {
    const status = githubReadStatus(error)
    if (status === undefined) throw error
    return messagesResult(status, [], undefined)
  }
}

/** 读一个提交的检查与状态（`github/commits/<sha>/checks` 与 PR 的 `/checks`）。 */
async function readChecks(api: GithubApi, request: GithubReadRequest, sha: string): Promise<GithubResourceRead> {
  try {
    const read = await api.checks(request.repository, sha)
    return checksResult('available', read.items[0] ?? null, read.skipped)
  } catch (error) {
    const status = githubReadStatus(error)
    if (status === undefined) throw error
    return checksResult(status, null)
  }
}

/** 读一个 PR 的检查：先用它的 head 提交找到 sha，再读那个提交（§I.2 CI 行）。 */
async function readPullChecks(
  api: GithubApi,
  request: GithubReadRequest,
  number: number
): Promise<GithubResourceRead> {
  try {
    const read = await api.pull(request.repository, number)
    const pull = read.items[0]
    // 没有 head 提交的 PR（已删分支、畸形页）没有检查可读：`missing`，不假装都是绿的。
    if (pull === undefined || pull.headSha.length === 0) return checksResult('missing', null, read.skipped)
    return await readChecks(api, request, pull.headSha)
  } catch (error) {
    const status = githubReadStatus(error)
    if (status === undefined) throw error
    return checksResult(status, null)
  }
}

/**
 * 按资源名读一个 GitHub 资源（§I.2「资源读取」行；技能文本里教模型用的就是这些名字）。
 * 未知写法直接拒绝（列出可用写法）；无权限、已删、找不到是状态而不是空结果。
 */
export async function githubRead(request: GithubReadRequest): Promise<GithubResourceRead> {
  const host = request.signal === undefined ? request.host : request.host.withSignal(request.signal)
  const api = createGithubApi(host, request.cli)
  const resource = request.resource.trim()
  const commit = COMMIT_CHECKS.exec(resource)
  if (commit !== null) return readChecks(api, request, commit[1] as string)
  const match = RESOURCE.exec(resource)
  if (match === null) {
    throw new GithubResourceError(`Unknown GitHub resource ${resource}; use ${RESOURCE_FORMS}`, resource)
  }
  const [, kindText, number, sectionText, page] = match
  const kind: 'issues' | 'pulls' = kindText === 'pulls' ? 'pulls' : 'issues'
  const issue = Number(number)
  const isPull = kind === 'pulls'
  if (sectionText === undefined) return readDescription(api, request, issue, isPull)
  if (!isPull && sectionText !== 'comments') {
    throw new GithubResourceError(
      `Reviews, review threads and checks require a pull request: ${resource}`,
      resource
    )
  }
  if (sectionText === 'checks') {
    if (page !== undefined) {
      throw new GithubResourceError(`Checks do not take a page number: ${resource}`, resource)
    }
    return readPullChecks(api, request, issue)
  }
  if (sectionText === 'thread') {
    if (page === undefined) {
      throw new GithubResourceError(
        `Name the review thread by one of its comments: github/pulls/${number}/thread/<comment-id>`,
        resource
      )
    }
    return readReviewThread(api, request, issue, Number(page))
  }
  const section: 'comments' | 'reviews' = sectionText === 'reviews' ? 'reviews' : 'comments'
  return readPage(api, request, kind, issue, section, page === undefined ? 1 : Number(page))
}

/** 语境页的种类（`ContextPart.status`）：描述 + 评论、评审页、评审线程、默认分支 CI。 */
export type GithubContextPage = 'conversation' | 'reviews' | 'review_thread' | 'branch_ci'

/**
 * 一条 Trigger 自己的消息 id：与语境里那条消息的 id 一致，评估窗口靠它定位「这条要评的消息」。
 * 页面链接是首选身份（评论、评审、描述的 `html_url` 各不相同）；没有链接时退回原生评论 id。
 */
export function githubMessageId(trigger: Trigger): string {
  if (typeof trigger.url === 'string' && trigger.url.length > 0) return trigger.url
  const commentId = trigger.meta['commentId']
  if (typeof commentId === 'number') return String(commentId)
  return trigger.id
}

/** 语境读取要的仓库：Trigger 记下的那个，缺省用配置（配置换了也读 Trigger 来自的仓库）。 */
function repositoryOf(trigger: Trigger, config: GithubConfig): string {
  const stored = trigger.meta['repository']
  return typeof stored === 'string' && stored.length > 0 ? stored : config.repository
}

/** 一页的页码：游标既认自己给的 `next_resource`，也认裸页码（`2`）。 */
function pageOf(cursor: string | undefined): number {
  if (cursor === undefined) return 1
  const match = /(?:^|\/)([1-9]\d*)$/.exec(cursor.trim())
  if (match === null) throw new Error(`Unknown GitHub page cursor: ${cursor}`)
  return Number(match[1])
}

/** 一页语境的结果：消息、下一页游标、Source 自己的原始体与状态说明。 */
function contextPart(
  status: GithubContextPage | GithubReadStatus,
  messages: readonly ContextMessage[],
  next: string | undefined,
  skipped = 0
): ContextPart {
  return {
    messages,
    ...(next === undefined ? {} : { next }),
    body: {
      status,
      next_resource: next ?? null,
      messages,
      ...(skipped === 0 ? {} : { skipped })
    },
    status
  }
}

/** 一次语境读的输入：读取端口、仓库、Trigger、要读的段与游标。 */
interface ContextRequest {
  readonly api: GithubApi
  readonly repository: string
  readonly trigger: Trigger
  readonly part: ContextPartName
  readonly cursor: string | undefined
}

/**
 * 会话页：第 1 页是 Issue/PR 描述 + 20 条会话评论，之后每页 20 条评论；满页才有下一页游标。
 * 描述走 `issues/<n>`（PR 也会返回它的描述），评论走会话评论端点——两者都是 PR 的会话。
 */
async function conversationPage(input: ContextRequest, number: number): Promise<ContextPart> {
  const page = pageOf(input.cursor)
  const messages: ContextMessage[] = []
  try {
    if (page === 1) {
      const read = await input.api.issue(input.repository, number)
      const issue = read.items[0]
      if (issue === undefined) return contextPart('missing', [], undefined, read.skipped)
      messages.push(
        descriptionOf({
          number,
          isPull: issue.isPull,
          title: issue.title,
          state: issue.state,
          url: issue.url,
          body: issue.body,
          login: issue.login,
          bot: issue.bot,
          at: issue.createdAt
        }).message
      )
    }
    const comments = await input.api.issueCommentsPage(
      input.repository,
      number,
      page,
      GITHUB_READ_PAGE_SIZE
    )
    messages.push(...comments.items.map(commentMessage))
    const next =
      comments.items.length === GITHUB_READ_PAGE_SIZE
        ? pageResource('issues', number, 'comments', page + 1)
        : undefined
    return contextPart('conversation', messages, next, comments.skipped)
  } catch (error) {
    const status = githubReadStatus(error)
    if (status === undefined) throw error
    return contextPart(status, [], undefined)
  }
}

/** 评审页：一次评审 Trigger 的语境是这条 PR 的评审列表（每页 20 条）。 */
async function reviewsPage(input: ContextRequest, number: number): Promise<ContextPart> {
  const page = pageOf(input.cursor)
  try {
    const read = await input.api.pullReviewsPage(input.repository, number, page, GITHUB_READ_PAGE_SIZE)
    const messages = read.items.map(reviewMessage)
    const next =
      read.items.length === GITHUB_READ_PAGE_SIZE
        ? pageResource('pulls', number, 'reviews', page + 1)
        : undefined
    return contextPart('reviews', messages, next, read.skipped)
  } catch (error) {
    const status = githubReadStatus(error)
    if (status === undefined) throw error
    return contextPart(status, [], undefined)
  }
}

/**
 * 评审线程页：`thread` 是根 + 它的回复（一条评审线程就是一页），`root` / `parent` 只读根。
 * 根由 Trigger 的 `rootCommentId` 给出（`reviewCommentTrigger` 写下的就是它）。
 */
async function reviewThreadPage(input: ContextRequest, number: number): Promise<ContextPart> {
  const root = Number(input.trigger.meta['rootCommentId'])
  if (!Number.isInteger(root) || root <= 0) {
    throw new Error('The GitHub review comment names no thread root')
  }
  try {
    const read = await input.api.pullComments(input.repository, number)
    const thread = reviewThreadOf(read.items, root)
    if (thread.length === 0) return contextPart('missing', [], undefined, read.skipped)
    const messages = thread.map(commentMessage)
    const selected = input.part === 'thread' ? messages : messages.slice(0, 1)
    return contextPart('review_thread', selected, undefined, read.skipped)
  } catch (error) {
    const status = githubReadStatus(error)
    if (status === undefined) throw error
    return contextPart(status, [], undefined)
  }
}

/** 默认分支的 CI 没有会话：它的 Trigger 就是它的语境（与上游同）。 */
function branchCiPage(trigger: Trigger): ContextPart {
  const message: ContextMessage = {
    id: githubMessageId(trigger),
    from: 'CI',
    at: trigger.at,
    text: trigger.text,
    bot: true
  }
  return contextPart('branch_ci', [message], undefined)
}

/** 一条 Trigger 的那一页语境（§I.2「线程上下文」行）。 */
async function contextPage(input: ContextRequest): Promise<ContextPart> {
  const { trigger } = input
  const kind = String(trigger.meta['kind'] ?? 'comment')
  // 默认分支的 CI 没有会话（§I.2 receive-all 行）：它的 meta 带 branch，别的都不带。
  if (typeof trigger.meta['branch'] === 'string') return branchCiPage(trigger)
  const number = Number(trigger.meta['issue'])
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error('The GitHub trigger names no Issue or pull request')
  }
  if (kind === 'review-comment') return reviewThreadPage(input, number)
  if (kind === 'review') return reviewsPage(input, number)
  return conversationPage(input, number)
}

/**
 * kind 的 `threadContext`（§I.1）：绑定 CLI，评估窗口与资源读都从这里进。每一页最多 20 条，
 * 满页才给 `next`；`next` 就是下一页的资源名（`github/issues/12/comments/2`），原样交回本读即
 * 可续读。读不到的东西是明确状态（`forbidden` / `deleted` / `missing`），不是空页。
 */
export function githubThreadContext(cli: string): ThreadContext<GithubConfig> {
  return {
    messageId: githubMessageId,
    async read(host, trigger, part, cursor, config, signal) {
      const bound = host.withSignal(signal)
      return contextPage({
        api: createGithubApi(bound, cli),
        repository: repositoryOf(trigger, config),
        trigger,
        part,
        cursor
      })
    }
  }
}

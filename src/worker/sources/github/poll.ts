// 通知轮询（§I.2「通知轮询」行）：一轮只做三件事——读通知、把每条通知的 subject 展开成
// Issue/PR 读取、翻成 Trigger 交给 Source 端口。游标按通知 id 存在 Source 自己的 kv 里
// （`github-cursor:<id>`），**整轮成功才推进**：被中断的一轮下一轮重读，而不是漏读（§I.6）。
//
// 失败姿态（§I.2 失败处理列）：单条失败留 `thread.meta.pollError`，下一轮重读（404 也一样：
// 它可能是丢权限而不是消失）；连续三轮失败把 health 的 `github` 条目报成 error；任何一次
// 成功清零。自身消息在这一层就被丢弃。
//
// 依赖纪律（§C.2）：本文件只 import core 的类型、命令端口的形状与同目录的兄弟模块；它拿不到
// Engine、Store 或宿主，收 Trigger 只能经注入的 `host.receive`。KV 键名也不由这里拼：
// `app/kv.ts` 是唯一命名处，组合根把构造函数（`cursorKey`）交进来（§D.3）。
import { liveTicket } from '../../core/index.ts'
import type { HealthEntry, Thread, Ticket, Trigger } from '../../core/index.ts'
import type { SourceContext } from '../kind.ts'
import type { GithubChecks, GithubNotification, GithubPull, GithubRead } from './api.ts'
import { issueNumberOf, rateLimited, type GithubApi } from './api.ts'
import type { GithubBodySource } from './translate.ts'
import {
  bodyFingerprint,
  ciFingerprint,
  ciTrigger,
  commentTrigger,
  isSelf,
  issueBodyTrigger,
  reviewCommentTrigger,
  reviewTrigger
} from './translate.ts'
import type { GithubConfig } from './config.ts'

/** 连续多少轮失败把 `github` 条目标成 error（§I.2：连续 3 轮）。 */
export const FAILURES_BEFORE_ERROR = 3

/**
 * 订阅 Thread 的水位线（§I.3 的 `POLL_HORIZON_MS`，同上游语义）：最后一条 Trigger 或
 * Ticket 结束后继续轮询两周；超过就标为过期、停止轮询，但 Thread 记录保留。
 */
export const POLL_HORIZON_MS = 14 * 24 * 3600_000

/** 轮询端口：组合根接 `app/source-context.ts`，测试接一个记录收到的 Trigger 的替身。 */
export type GithubPollHost = Pick<SourceContext, 'receive' | 'state' | 'report' | 'threads'>

/** 一个有 Ticket 订阅的 GitHub Thread（组合根从 Thread 行与 Ticket 行算出）。 */
export interface GithubSubscribedThread {
  /** Issue/PR 号（Thread id 的数字部分）。 */
  readonly issue: number
  /** 有活着的 Ticket 订阅：无论水位线都轮询。 */
  readonly live: boolean
  /** 最后活动时刻（Thread 最后一条 Trigger 与每条 Ticket 结束时刻的最大者）。 */
  readonly lastAt: string
}

/**
 * 这一轮读到的 PR 头部（#19 起带回）：CI 要读它的 head 提交，已关闭/已合并的不再读
 * （§I.5：Ticket 随之结束）。
 */
export interface GithubPullHead {
  readonly number: number
  readonly headSha: string
  readonly url: string
  readonly closed: boolean
}

/** 读一个 Thread 的读数：收到的 Trigger 数，以及（PR 时）CI 轮询要的 head。 */
interface ThreadRead {
  readonly received: number
  readonly pull?: GithubPullHead
}

/** 轮询器的依赖。 */
export interface GithubPollerOptions {
  readonly api: GithubApi
  readonly config: GithubConfig
  /** agent 的 GitHub 账号（来自部署/setup 探针；空串时无法判定点名与自身消息）。 */
  readonly login: string
  readonly host: GithubPollHost
  /**
   * 一条通知的游标键（`githubCursorKey(notificationId)`）：键名只活在 `app/kv.ts`，
   * 由组合根注入，Source 自己不拼字面量（§D.3）。
   */
  readonly cursorKey: (notificationId: string) => string
  /** 有 Ticket 订阅的 Thread；缺省（或没有它）时不读订阅。 */
  readonly subscribed?: () => readonly GithubSubscribedThread[]
  /**
   * Issue/PR 正文指纹的键（`githubBodyKey(number)`）：键名只活在 `app/kv.ts`，
   * 由组合根注入。缺省时不翻译正文版本（#36 的 receive-all 复用同一个键）。
   */
  readonly bodyKey?: (issue: number) => string
  /**
   * 一个 PR 某个 head 提交的 CI 指纹键（`githubCiKey(pull, headSha)`）：键名只活在
   * `app/kv.ts`，由组合根注入。缺省时不轮询 CI（与 `bodyKey` 同一条约定）。
   */
  readonly ciKey?: (pull: number, headSha: string) => string
  /**
   * 读到一条 PR 时先对账（§I.2「PR 规则」行的 `observePull`）：绑给分支唯一匹配的活 Ticket、
   * 把已合并/已关闭的交给 `threadClosed`。缺省只读不对账（纯读取的测试与没有 PR 规则的接线）。
   */
  readonly observePull?: (pull: GithubPull) => void
  /** 时钟（毫秒，水位线判定用）；缺省 `Date.now`。 */
  readonly now?: () => number
  readonly log?: (message: string) => void
}

/** 一轮轮询的读数（面板与测试用）。 */
export interface GithubPollResult {
  /** 这一轮处理的通知数（含跳过的类型）。 */
  readonly notifications: number
  /** 翻成 Trigger 并交给 Source 的条数（重复的不算）。 */
  readonly triggers: number
  /** 这一轮跳过的畸形条目数（不是失败：§I.2「畸形条目跳过并计数」）。 */
  readonly skipped: number
}

/** 一条通知的游标：上次处理到的 `updated_at` 与上一次的 `last_read_at`。 */
interface Cursor {
  readonly updatedAt: string
  readonly lastReadAt: string | null
  readonly skipped?: string
}

/** 读一个游标（畸形值当作没有：宁愿重读一轮，也不跳过错过的评论）。 */
function cursorOf(value: unknown): Cursor | null {
  if (typeof value !== 'object' || value === null) return null
  const updatedAt = (value as { updatedAt?: unknown }).updatedAt
  if (typeof updatedAt !== 'string') return null
  const lastReadAt = (value as { lastReadAt?: unknown }).lastReadAt
  const skipped = (value as { skipped?: unknown }).skipped
  return {
    updatedAt,
    lastReadAt: typeof lastReadAt === 'string' ? lastReadAt : null,
    ...(typeof skipped === 'string' ? { skipped } : {})
  }
}

/** 一条评论是否属于这一轮（`since` 过滤器之外再兜一层：编辑过的评论要重新出 Trigger）。 */
function fresh(updatedAt: string, createdAt: string, since: string | null): boolean {
  return since === null || updatedAt >= since || createdAt >= since
}

/** 一条 Thread 的引用（`github:<issue>`，§I.2 Thread 行）。 */
const threadRef = (issue: number): { source: 'github'; id: string } => ({
  source: 'github',
  id: String(issue)
})

/**
 * Thread 是否还在水位线内：活订阅永远在；否则从最后活动起算 `POLL_HORIZON_MS`。
 * 时刻解析不出来的当作不在（宁可少读，也不无限轮询一个坏记录）。
 */
export function withinHorizon(thread: GithubSubscribedThread, nowMs: number): boolean {
  if (thread.live) return true
  const at = Date.parse(thread.lastAt)
  return Number.isFinite(at) && nowMs - at < POLL_HORIZON_MS
}

/**
 * 从 Thread 行与 Ticket 行算出「有订阅的 Thread」：`live` 看是否还有活 Ticket（有就无条件
 * 轮询），`lastAt` 取 Thread 最后一条 Trigger 与各 Ticket 结束时刻的最大者（水位线用它）。
 * 组合根（`boot.ts`）按 Source 过滤后交给轮询器；轮询器自己不读库（§C.2）。
 */
export function subscribedThreads(
  threads: readonly Thread[],
  tickets: readonly Ticket[]
): readonly GithubSubscribedThread[] {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket] as const))
  const found: GithubSubscribedThread[] = []
  for (const thread of threads) {
    if (thread.ref.source !== 'github' || thread.subscriptions.length === 0) continue
    const issue = Number(thread.ref.id)
    if (!Number.isInteger(issue) || issue <= 0) continue
    const subscribed = thread.subscriptions.flatMap((id) => {
      const ticket = byId.get(id)
      return ticket === undefined ? [] : [ticket]
    })
    const times = [thread.lastAt ?? thread.createdAt, ...subscribed.map((ticket) => ticket.ended?.at ?? '')]
      .flatMap((at) => {
        const parsed = Date.parse(at)
        return Number.isFinite(parsed) ? [parsed] : []
      })
    const lastAt = new Date(times.length === 0 ? Date.parse(thread.createdAt) : Math.max(...times)).toISOString()
    found.push({ issue, live: subscribed.some((ticket) => liveTicket(ticket)), lastAt })
  }
  return found
}

/** 轮询器：`poll()` 可重复调用，游标与失败计数都在这个对象上。 */
export interface GithubPoller {
  poll(): Promise<GithubPollResult>
}

/**
 * 造一个通知轮询器。它不自己计时（组合根按 `pollSeconds` 驱动），也不碰网络（`api` 注入）。
 */
export function createGithubPoller(options: GithubPollerOptions): GithubPoller {
  const log = options.log ?? (() => undefined)
  const nowMs = options.now ?? (() => Date.now())
  let failures = 0
  /** 这一轮要写的游标；整轮成功才落盘（§I.2：被中断的一轮游标不动）。 */
  let pending = new Map<string, Cursor>()
  /** 已经标过过期的 Thread（同一进程只写一次 meta）。 */
  const expired = new Set<number>()

  const report = (entry: HealthEntry): void => options.host.report('github', entry)

  const failRound = (error: unknown): void => {
    failures += 1
    const text = error instanceof Error ? error.message : String(error)
    const detail = `poll failed ${failures} ${failures === 1 ? 'time' : 'times'}: ${text.slice(0, 200)}`
    if (failures >= FAILURES_BEFORE_ERROR) {
      report({ state: 'error', detail })
    }
    log(detail)
  }

  /** 单条 Thread 的失败写在它自己的 meta 上（§I.2 失败处理列）。 */
  const recordPollError = (issue: number, error: unknown): void => {
    const text = error instanceof Error ? error.message : String(error)
    options.host.threads.patch(threadRef(issue), { pollError: text.slice(0, 2000) })
  }

  /** 读成功：清掉轮询错误与过期标记；页面地址记进 Thread 自己的 meta（§D.2）。 */
  const recordSuccess = (issue: number, url: string | undefined): void => {
    expired.delete(issue)
    options.host.threads.patch(threadRef(issue), {
      ...(url === undefined || url.length === 0 ? {} : { url }),
      pollError: undefined,
      pollExpired: undefined
    })
  }

  /** 标一个超出水位线的 Thread 为过期：停止无意义轮询，但 Thread 记录保留（§I.2）。 */
  const markExpired = (issue: number): void => {
    if (expired.has(issue)) return
    expired.add(issue)
    options.host.threads.patch(threadRef(issue), { pollExpired: true })
  }

  /**
   * 一个 PR head 提交的 CI 读数（§I.2 CI 行）：指纹（`github-ci:<pr>#<sha>`）变化才交一条
   * Trigger——第一次读只当基线，同一结果重复读不出 Trigger（Trigger id 也按指纹幂等）。
   *
   * 限流不是失败（票 #19 的验收）：记一次日志、指纹不动，于是下一轮重读同一个提交；它不进
   * `failures`，因此连续限流也不会把 `github` 报成 error。只有 `observeCi` 打开时才读
   * （scope 层同样只在它打开时收 CI，§I.2 准入行）。
   */
  const readChecks = async (
    pull: GithubPullHead,
    hooks: { readonly skip: (count: number) => void; readonly defer: () => void }
  ): Promise<number> => {
    if (options.ciKey === undefined || !options.config.observeCi) return 0
    if (pull.closed || pull.headSha.length === 0) return 0
    let read: GithubRead<GithubChecks>
    try {
      read = await options.api.checks(options.config.repository, pull.headSha)
    } catch (error) {
      if (!rateLimited(error)) throw error
      const detail = error instanceof Error ? error.message : String(error)
      log(`CI checks for #${pull.number} are rate limited; retrying next round: ${detail.slice(0, 200)}`)
      hooks.defer()
      return 0
    }
    hooks.skip(read.skipped)
    const found = read.items[0]
    if (found === undefined) return 0
    const stateKey = options.ciKey(pull.number, pull.headSha)
    const seen = options.host.state.get(stateKey)
    const fingerprint = ciFingerprint(found)
    let received = 0
    if (typeof seen === 'string' && seen !== fingerprint) {
      const trigger = ciTrigger({
        repository: options.config.repository,
        pull: pull.number,
        checks: found,
        at: new Date(nowMs()).toISOString(),
        ...(pull.url.length === 0 ? {} : { url: pull.url })
      })
      if (options.host.receive(trigger) !== 'duplicate') received += 1
    }
    options.host.state.set(stateKey, fingerprint)
    return received
  }

  /**
   * 读一个 Thread 的会话：Issue/PR 本体、会话评论，PR 再读评审与评审评论（#18 只读不翻）。
   * `pull` 已知时（通知的 subject.type 就是 PullRequest）跳过 issues/<n> 的探测读取。
   */
  const readThread = async (input: {
    readonly repository: string
    readonly issue: number
    readonly since: string | null
    readonly knownPull: boolean | undefined
    readonly skip: (count: number) => void
  }): Promise<ThreadRead> => {
    const { repository, issue, since, skip } = input
    let isPull = input.knownPull === true
    let url: string | undefined
    let body: GithubBodySource | undefined
    let pull: GithubPullHead | undefined
    if (input.knownPull === undefined) {
      const read = await options.api.issue(repository, issue)
      skip(read.skipped)
      const found = read.items[0]
      isPull = found?.isPull === true
      url = found?.url
      if (found) body = found
    }
    if (isPull) {
      const read = await options.api.pull(repository, issue)
      skip(read.skipped)
      const found = read.items[0]
      url = found?.url ?? url
      if (found) {
        body = found
        // 先对账（§I.2「PR 规则」行）：开着的 PR 绑给分支唯一匹配的活 Ticket，已合并/已关闭的
        // 交给 `threadClosed`——结束的判定仍在领域里（§I.5）。
        options.observePull?.(found)
        // CI 读 head 提交的检查与状态；已关闭/已合并的 PR 不再读（§I.5、§I.2 CI 行）。
        pull = {
          number: issue,
          headSha: found.headSha,
          url: found.url,
          closed: found.state === 'closed' || found.merged
        }
      }
    }
    let received = 0
    // 正文版本（§I.2「issue-body 编辑」）：第一次读只当基线；之后只在正文指纹变化时
    // 产 Trigger。评论/评审活动会改 `updated_at` 但不改正文，因此不会制造正文 Trigger。
    if (options.bodyKey !== undefined && body !== undefined) {
      const fingerprint = bodyFingerprint(body.body)
      const stateKey = options.bodyKey(issue)
      const seen = options.host.state.get(stateKey)
      if (!isSelf(body, options.login) && typeof seen === 'string' && seen !== fingerprint) {
        const trigger = issueBodyTrigger({
          repository,
          number: issue,
          isPull,
          source: body,
          login: options.login
        })
        if (trigger.text.length > 0 && options.host.receive(trigger) !== 'duplicate') received += 1
      }
      options.host.state.set(stateKey, fingerprint)
    }
    const comments = await options.api.issueComments(repository, issue, since)
    skip(comments.skipped)
    for (const comment of comments.items) {
      if (isSelf(comment, options.login)) continue
      if (!fresh(comment.updatedAt, comment.createdAt, since)) continue
      const trigger: Trigger = commentTrigger({
        repository,
        issue,
        comment,
        login: options.login,
        observeComments: options.config.observeComments
      })
      // 同一版本评论重复读到只算一次（Trigger id 幂等，§I.2 Trigger id 行）。
      if (options.host.receive(trigger) !== 'duplicate') received += 1
    }
    if (isPull) {
      // 评审（review）与评审评论（review-comment）都翻成 Trigger（§I.2 Trigger 翻译行）。
      const reviews = await options.api.pullReviews(repository, issue)
      skip(reviews.skipped)
      for (const review of reviews.items) {
        if (isSelf(review, options.login)) continue
        if (!fresh(review.submittedAt, review.submittedAt, since)) continue
        const trigger = reviewTrigger({ repository, pull: issue, review, login: options.login })
        // 空的 COMMENTED 评审没有可读内容；有状态的决定仍有正文（`reviewText`）。
        if (trigger.text.length === 0) continue
        if (options.host.receive(trigger) !== 'duplicate') received += 1
      }
      const reviewComments = await options.api.pullComments(repository, issue)
      skip(reviewComments.skipped)
      for (const comment of reviewComments.items) {
        if (isSelf(comment, options.login)) continue
        if (!fresh(comment.updatedAt, comment.createdAt, since)) continue
        const trigger = reviewCommentTrigger({
          repository,
          pull: issue,
          comment,
          login: options.login
        })
        if (trigger.text.length === 0) continue
        if (options.host.receive(trigger) !== 'duplicate') received += 1
      }
    }
    recordSuccess(issue, url)
    return { received, ...(pull === undefined ? {} : { pull }) }
  }

  return {
    async poll(): Promise<GithubPollResult> {
      pending = new Map<string, Cursor>()
      let skipped = 0
      let deferred = 0
      let notifications = 0
      let triggers = 0
      /** 这一轮已经读过的 Issue/PR（通知与订阅两路只读一次）。 */
      const read = new Set<number>()
      /** 这一轮读到的 PR 头部：CI 段按订阅过滤后读它们的 head 提交（§I.2 CI 行）。 */
      const heads = new Map<number, GithubPullHead>()
      let failed = false
      let firstError: unknown
      const noteFailure = (error: unknown): void => {
        failed = true
        firstError ??= error
      }
      const addSkipped = (count: number): void => {
        skipped += count
      }
      const addDeferred = (): void => {
        deferred += 1
      }

      // 1) 通知：逐条 subject 展开成 Issue/PR 读取。
      try {
        const listing = await options.api.notifications()
        addSkipped(listing.skipped)
        notifications = listing.items.length
        for (const notification of listing.items) {
          try {
            const outcome = await readNotification(notification, read, addSkipped)
            triggers += outcome.received
            if (outcome.pull !== undefined) heads.set(outcome.pull.number, outcome.pull)
          } catch (error) {
            noteFailure(error)
            const issue = issueNumberOf(notification.apiUrl)
            if (issue !== undefined) recordPollError(issue, error)
          }
        }
      } catch (error) {
        noteFailure(error)
      }

      // 2) 订阅 Thread：凡有活 Ticket 订阅的都每轮读一次；超出水位线的标为过期、不再读。
      const subscribed = options.subscribed?.() ?? []
      for (const thread of subscribed) {
        if (!withinHorizon(thread, nowMs())) {
          markExpired(thread.issue)
          continue
        }
        if (read.has(thread.issue)) continue
        try {
          const outcome = await readThread({
            repository: options.config.repository,
            issue: thread.issue,
            // 订阅 Thread 每轮全量读会话评论：幂等由 Trigger id 保证（§I.2 Trigger id 行）。
            since: null,
            knownPull: undefined,
            skip: addSkipped
          })
          triggers += outcome.received
          if (outcome.pull !== undefined) heads.set(outcome.pull.number, outcome.pull)
        } catch (error) {
          noteFailure(error)
          recordPollError(thread.issue, error)
        }
      }

      // 3) CI：订阅的 PR 读一次 head 提交的检查与状态，只在指纹变化时出 Trigger（§I.2 CI 行）。
      //    只有还活着的 Ticket 需要 CI 反馈（上游只轮询 open ticket 的 PR）：结束的 Ticket 不再读。
      for (const thread of subscribed) {
        if (!thread.live) continue
        const pull = heads.get(thread.issue)
        if (pull === undefined) continue
        try {
          triggers += await readChecks(pull, { skip: addSkipped, defer: addDeferred })
        } catch (error) {
          noteFailure(error)
          recordPollError(pull.number, error)
        }
      }

      // 4) 整轮成功才推进游标：被中断的一轮重读，而不是漏读（§I.2 / §I.6）。
      if (failed) {
        failRound(firstError)
      } else {
        for (const [key, value] of pending) options.host.state.set(key, value)
        failures = 0
        const deferredText =
          deferred === 0 ? '' : `; ${deferred} CI ${deferred === 1 ? 'read' : 'reads'} deferred by rate limit`
        report({
          state: 'ready',
          detail: `${notifications} notifications${skipped > 0 ? `; ${skipped} unreadable items skipped` : ''}${deferredText}`
        })
      }
      return { notifications, triggers, skipped }
    }
  }

  /** 一条通知 → 它的 Issue/PR 读取与该条通知的游标（成功才进 `pending`）。 */
  async function readNotification(
    notification: GithubNotification,
    read: Set<number>,
    skip: (count: number) => void
  ): Promise<ThreadRead> {
    const key = options.cursorKey(notification.id)
    const cursor = cursorOf(options.host.state.get(key))
    if (cursor !== null && cursor.updatedAt === notification.updatedAt) return { received: 0 }
    const issue = issueNumberOf(notification.apiUrl)
    const repository = notification.repository || options.config.repository
    if (issue === undefined || (notification.type !== 'Issue' && notification.type !== 'PullRequest')) {
      // 不是 Issue/PR 的通知（Release、Discussion…）：记住位置，不读任何东西。
      pending.set(key, {
        updatedAt: notification.updatedAt,
        lastReadAt: notification.lastReadAt,
        ...(notification.type === '' ? {} : { skipped: notification.type })
      })
      return { received: 0 }
    }
    read.add(issue)
    const outcome = await readThread({
      repository,
      issue,
      since: cursor?.lastReadAt ?? notification.lastReadAt,
      knownPull: notification.type === 'PullRequest' ? true : undefined,
      skip
    })
    pending.set(key, {
      updatedAt: notification.updatedAt,
      lastReadAt: notification.lastReadAt
    })
    return outcome
  }
}

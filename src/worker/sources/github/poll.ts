// 通知轮询（§I.2「通知轮询」行）：一轮只做三件事——读通知、把对得上的那条读成 Issue 评论、
// 翻成 Trigger 交给 Source 端口。游标按通知 id 存在 Source 自己的 kv 里（`github-cursor:<id>`）。
//
// 失败姿态（§I.2 失败处理列）：单条通知失败只记这一轮失败，**游标不动**（下一轮重读）；连续
// 三轮失败把 health 的 `github` 条目报成 error；任何一次成功清零。自身消息在这一层就被丢弃。
//
// 依赖纪律（§C.2）：本文件只 import core 的类型、命令端口与同目录的兄弟模块；它拿不到
// Engine、Store 或宿主，收 Trigger 只能经注入的 `host.receive`。KV 键名也不由这里拼：
// `app/kv.ts` 是唯一命名处，组合根把构造函数（`cursorKey`）交进来（§D.3）。
import type { HealthEntry, Trigger } from '../../core/index.ts'
import type { SourceContext } from '../kind.ts'
import type { GithubComment, GithubNotification } from './api.ts'
import { issueNumberOf, type GithubApi } from './api.ts'
import { commentTrigger, isSelf } from './translate.ts'
import type { GithubConfig } from './config.ts'

/** 连续多少轮失败把 `github` 条目标成 error（§I.2：连续 3 轮）。 */
export const FAILURES_BEFORE_ERROR = 3

/** 轮询端口：组合根接 `app/source-context.ts`，测试接一个记录收到的 Trigger 的替身。 */
export type GithubPollHost = Pick<SourceContext, 'receive' | 'state' | 'report'>

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
  readonly log?: (message: string) => void
}

/** 一轮轮询的读数（面板与测试用）。 */
export interface GithubPollResult {
  /** 这一轮处理的通知数（含跳过的）。 */
  readonly notifications: number
  /** 翻成 Trigger 并交给 Source 的条数。 */
  readonly triggers: number
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
function fresh(comment: GithubComment, since: string | null): boolean {
  return since === null || comment.updatedAt >= since || comment.createdAt >= since
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
  let failures = 0

  const report = (entry: HealthEntry): void => options.host.report('github', entry)

  const fail = (error: unknown): void => {
    failures += 1
    const text = error instanceof Error ? error.message : String(error)
    const detail = `notification poll failed ${failures} ${
      failures === 1 ? 'time' : 'times'
    }: ${text.slice(0, 200)}`
    if (failures >= FAILURES_BEFORE_ERROR) {
      report({ state: 'error', detail })
    }
    log(detail)
  }

  const readNotification = async (notification: GithubNotification): Promise<number> => {
    const key = options.cursorKey(notification.id)
    const cursor = cursorOf(options.host.state.get(key))
    if (cursor !== null && cursor.updatedAt === notification.updatedAt) return 0
    const issue = issueNumberOf(notification.apiUrl)
    const repository = notification.repository || options.config.repository
    // 本票只读 Issue 评论；PR / Release 等通知记住位置就走（PR 面归 #17/#18）。
    if (notification.type !== 'Issue' || issue === undefined) {
      // 不是 Issue/PR 的通知（例如 Release）：记住位置，不读任何东西。
      options.host.state.set(key, {
        updatedAt: notification.updatedAt,
        lastReadAt: notification.lastReadAt,
        skipped: notification.type
      } satisfies Cursor)
      return 0
    }
    const comments = await options.api.issueComments(
      repository,
      issue,
      cursor?.lastReadAt ?? notification.lastReadAt
    )
    let received = 0
    for (const comment of comments) {
      if (isSelf(comment, options.login)) continue
      if (!fresh(comment, cursor?.lastReadAt ?? notification.lastReadAt)) continue
      const trigger: Trigger = commentTrigger({
        repository,
        issue,
        comment,
        login: options.login,
        observeComments: options.config.observeComments
      })
      options.host.receive(trigger)
      received += 1
    }
    // 只有读成功才推进游标：被中断的一轮会重读，而不是漏读（§I.2 / §I.6）。
    options.host.state.set(key, {
      updatedAt: notification.updatedAt,
      lastReadAt: notification.lastReadAt
    } satisfies Cursor)
    return received
  }

  return {
    async poll(): Promise<GithubPollResult> {
      let notifications: readonly GithubNotification[]
      try {
        notifications = await options.api.notifications()
      } catch (error) {
        fail(error)
        return { notifications: 0, triggers: 0 }
      }
      let triggers = 0
      let firstError: unknown
      for (const notification of notifications) {
        try {
          triggers += await readNotification(notification)
        } catch (error) {
          firstError ??= error
          fail(error)
        }
      }
      if (firstError === undefined) {
        failures = 0
        report({ state: 'ready', detail: 'notification poll ok' })
      }
      return { notifications: notifications.length, triggers }
    }
  }
}

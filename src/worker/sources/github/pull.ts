// GitHub 的 PR 规则（§I.2 的「PR 规则」「结束通知」两行、§I.5 的六条规则）：
//
// - `claimPull`：worker 在报告里给出 PR 号时，把它绑给这张 Ticket。PR 属于它的两条路——
//   它是这张 Ticket 的**来源 PR**（起点 Trigger 就是那条 PR），或它是 agent 在配置的仓库里
//   从「末段等于 Ticket 短名」的分支开出来的（`own`）。绑定失败给一句给人看的原因，命令层
//   把它落成固定码 `pr_mismatch`。
// - `observePull`：轮询读到一条 PR 时对账：还开着的 PR 绑给分支唯一匹配的活 Ticket；已合并/
//   已关闭的交给 `threadClosed`，由领域按 §I.5 判结束（Ticket 跟随它的 Thread 都了结了、
//   且没有未完成的恢复/重试工作时）。
// - `pullEndNotices`：因 PR 结束时的**一条** chat 通知。键由 PR 号、Channel 与结局派生，
//   因此同一个结束重复算也只排一条（幂等，§J.1）；GitHub 自己的时间线已经显示合并或关闭，
//   所以通知只发往别的 Channel。
//
// 依赖纪律（§C.2 规则 2）：本文件只 import core 的类型与同目录的兄弟模块；Ticket 的读写全经
// 注入的宿主端口（组合根接 Engine 与仓储，测试接内存仓储 + 真 Engine），它拿不到 Engine
// 本体、Store 或宿主。
import { key, liveTicket } from '../../core/index.ts'
import type { Follow, OutboundMessage, ThreadRef, Ticket, Trigger } from '../../core/index.ts'
import type { GithubApi, GithubPull } from './api.ts'
import { githubThread } from './translate.ts'

/** 一条 PR 的 Thread 键（`github:<number>`，§I.2 Thread 行）。 */
export const pullThread = (number: number): ThreadRef => githubThread(number)

/**
 * PR 规则的宿主端口：读 Ticket 与 Trigger、两字段的 Ticket 命令（绑定、关闭），以及判定
 * 「是不是 agent 开的 PR」需要的部署事实。组合根用 Engine + 仓储拼它（§C.2 规则 2）。
 */
export interface GithubPullHost {
  /** 读 PR 本体（`claimReportedPull` 用它，报告里只有号码）。 */
  readonly api: Pick<GithubApi, 'pull'>
  /** Ticket 的读面：一个（含已结束的）与全部（`open` 只要未结束的）。 */
  readonly tickets: {
    get(ticketId: string): Ticket | undefined
    open(): readonly Ticket[]
  }
  /** 一条已存的 Trigger（判「这条 PR 是不是这张 Ticket 的来源」）。 */
  readonly trigger: (triggerId: string) => Trigger | undefined
  /** 把 Ticket 绑定到 Thread，并记 `own`。 */
  readonly bind: (ticketId: string, thread: ThreadRef, own: boolean) => void
  /** 记一个 Thread 以该结局关闭（`at` 是 GitHub 给的时刻）。 */
  readonly close: (thread: ThreadRef, outcome: 'merged' | 'closed', at: string) => void
  /** agent 的 GitHub 账号（判定 PR 的作者）。 */
  readonly login: string
  /** 配置的仓库（`owner/name`）：head 仓库与它一致才不是 fork。 */
  readonly repository: string
  /** 时钟（PR 没给关闭时刻时用它）。 */
  readonly now: () => string
}

/** 两个名字是否同一个（GitHub 的 login 与仓库名大小写不敏感）。 */
const sameName = (left: string, right: string): boolean =>
  left.trim().toLowerCase() === right.trim().toLowerCase()

/** PR 是 agent 在配置的仓库里开出来的（作者是 agent，head 不是 fork 的仓库）。 */
export function agentPull(
  pull: Pick<GithubPull, 'login' | 'headRepo'>,
  identity: { readonly login: string; readonly repository: string }
): boolean {
  return (
    sameName(pull.login, identity.login) && sameName(pull.headRepo, identity.repository)
  )
}

/**
 * 分支名末段等于 Ticket 的短名时，这条分支就是它的（`agent/<short>`、`fix-<short>` 都算）。
 * 短名未知（执行器还没建 worktree）时永远不匹配：不猜。
 */
export function ticketBranch(
  ticket: Pick<Ticket, 'execution'>,
  ref: string
): boolean {
  const short = ticket.execution?.name ?? ''
  return short.length > 0 && ref.split('/').at(-1) === short
}

/** 一条 Thread 键是不是 GitHub 的 PR Thread（`github:<number>`），是就给出号码。 */
const pullNumber = (thread: string): number | undefined => {
  const match = /^github:(\d+)$/.exec(thread)
  return match === null ? undefined : Number(match[1])
}

/** Ticket 跟随的 PR 号；`open` 只要还开着的（§I.5 第 2 条的判据）。 */
function pullsOf(ticket: Pick<Ticket, 'follows'>, open = false): number[] {
  return (ticket.follows ?? []).flatMap((item) =>
    (!open || item.closed === undefined) ? (pullNumber(item.thread) ?? []) : []
  )
}

/**
 * Ticket 的起点 Trigger 是不是就落在这一条 PR 上（PR 正文、它上面的评论或评审）。GitHub 的
 * Issue 与 PR 共用一套编号，所以同一个号码不可能既是 Issue 又是 PR：号码对上就是这条 PR。
 */
function startedFrom(trigger: Trigger | undefined, number: number): boolean {
  if (trigger?.source !== 'github') return false
  return trigger.threads.some((ref) => ref.source === 'github' && ref.id === String(number))
}

/** 一个 PR 是不是这张 Ticket 的；不是就返回拒绝原因（检查顺序即给人看的顺序）。 */
function ownership(host: GithubPullHost, ticket: Ticket, pull: GithubPull): string | undefined {
  // 它开的 PR（agent + 配置仓库 + 分支末段是短名），或它的来源 PR。
  const opened = agentPull(pull, host) && ticketBranch(ticket, pull.headRef)
  if (opened || startedFrom(host.trigger(ticket.origin.triggerId), pull.number)) return undefined
  return `PR does not belong to this ticket: use the PR it started from, or a PR by ${host.login} from a branch whose last path segment is the ticket short name (${ticket.execution?.name ?? 'unknown'}); omit pr-number when no PR exists`
}

/** 把 PR 绑给 Ticket 并记 `own`（写者仍是 Engine：宿主的 `bind` 就是 `Engine.bindThread`）。 */
function bind(host: GithubPullHost, ticketId: string, pull: GithubPull, own: boolean): void {
  host.bind(ticketId, pullThread(pull.number), own)
}

/**
 * 把一个 PR 绑给 `ticketId`：`own` 是「这张 Ticket 开的」，来源 PR 是它跟随的（`own:false`）。
 * 返回拒绝原因时什么都不写（命令层落成 `pr_mismatch`）。
 *
 * 四条判定：Ticket 还开着；PR 属于它（见 `ownership`）；这条 PR 没有已经属于另一个活 Ticket；
 * 已关闭的 PR 不绑（它不是结束的起点，结束由 `observePull` 判）。
 */
export function claimPull(
  host: GithubPullHost,
  ticketId: string,
  pull: GithubPull
): string | undefined {
  const ticket = host.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its PR was closed'
  const refused = ownership(host, ticket, pull)
  if (refused !== undefined) return refused
  const owner = host.tickets
    .open()
    .find((item) => item.id !== ticketId && pullsOf(item, true).includes(pull.number))
  if (owner !== undefined) return 'PR already belongs to another active ticket'
  const follow = ticket.follows?.find((item) => item.thread === `github:${pull.number}`)
  const own = agentPull(pull, host) && ticketBranch(ticket, pull.headRef)
  if (pull.state === 'open' && (!follow || follow.closed !== undefined || (own && !follow.own))) {
    bind(host, ticketId, pull, own)
  }
  return undefined
}

/**
 * 读一条 PR 再按 `claimPull` 绑定：`report --pr-number` 的接线（报告里只有号码）。读不到这条
 * PR 时给出拒绝原因，让命令层如实回 `pr_mismatch` 而不是假装绑定成功。
 */
export async function claimReportedPull(
  host: GithubPullHost,
  ticketId: string,
  number: number
): Promise<string | undefined> {
  const read = await host.api.pull(host.repository, number)
  const pull = read.items[0]
  if (pull === undefined) return `PR #${number} could not be read from GitHub`
  return claimPull(host, ticketId, pull)
}

/** 一条 PR 是否已了结：关闭与合并都算（合并后 GitHub 的 `state` 也是 `closed`）。 */
const endedPull = (pull: Pick<GithubPull, 'state' | 'merged'>): boolean =>
  pull.state === 'closed' || pull.merged

/**
 * 把一条已了结的 PR 报给跟随它的 Ticket：`at` 取合并/关闭时刻，结局取合并或关闭。领域
 * 自己判结束（§I.5 第 2–4 条），这里只把 GitHub 的事实交进去。
 */
function closePull(host: GithubPullHost, pull: GithubPull): void {
  // 只有「还跟着一条开着的 PR」的活 Ticket 需要这次关闭。已结束的 Ticket 仍订阅着这条 PR
  // （第 5 条：人后续评论可恢复它），它的 `closed` 标记已经记过——重复读到同一次关闭不重复写。
  const followed = host.tickets.open().some((ticket) => pullsOf(ticket, true).includes(pull.number))
  if (!followed) return
  const at = pull.mergedAt ?? pull.closedAt ?? host.now()
  host.close(pullThread(pull.number), pull.merged ? 'merged' : 'closed', at)
}

/**
 * 轮询读到一条 PR 时对账（§I.2「PR 规则」行的 `observePull`）：还开着的 PR 绑给分支**唯一**
 * 匹配的活 Ticket（worker 报告能指名，轮询只在唯一时绑）；已合并/已关闭的交给 `threadClosed`。
 * @returns 这条 PR 是否已了结（调用方据此不再为它读 CI）。
 */
export function observePull(host: GithubPullHost, pull: GithubPull): boolean {
  if (endedPull(pull)) {
    closePull(host, pull)
    return true
  }
  const candidates = agentPull(pull, host)
    ? host.tickets.open().filter((ticket) => ticketBranch(ticket, pull.headRef))
    : []
  const ticket = candidates.length === 1 ? candidates[0] : undefined
  // 曾跟随、已关闭、又开着的 PR 重新被跟随；已经跟随别的开着的 PR 的 Ticket 不换绑。
  const reopened = ticket?.follows?.some(
    (item) => item.thread === `github:${pull.number}` && item.closed !== undefined
  )
  if (ticket && (reopened || pullsOf(ticket, true).every((number) => number === pull.number))) {
    claimPull(host, ticket.id, pull)
  }
  return false
}

/** 中文请求（含汉字、且不是假名）用中文通知，其余用英文（§I.5 的结束通知同一口径）。 */
const chinese = (request: string): boolean =>
  /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)

/** 一条 PR Thread 的页面地址。 */
const pullPage = (repository: string, number: number): string =>
  `https://github.com/${repository}/pull/${number}`

/**
 * Ticket 因 PR 结束时的**一条** chat 通知（§I.2「结束通知」行）：结局取它打开的最后一条 PR，
 * 没有就取它跟随的最后一条（§I.5 第 3 条）。键由 PR 号、Channel 与结局派生，因此同一个结束
 * 重复算也只排一条消息（固定键 ⇒ 幂等，§J.1）。
 *
 * GitHub 自己的时间线已经显示合并或关闭，所以通知只发往别的 Channel；没有这样的 Channel 时
 * 一条都不产生（GitHub 上的请求不需要重复告知）。
 */
export function pullEndNotices(
  ticket: Ticket,
  request: string,
  repository: string
): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  if (outcome !== 'merged' && outcome !== 'closed') return []
  const follows = (ticket.follows ?? []).filter(
    (item) => item.closed !== undefined && pullNumber(item.thread) !== undefined
  )
  /** 最近关闭的那条（`at` 最大）；空列表给 undefined。 */
  const latest = (items: readonly Follow[]): Follow | undefined => {
    let best: Follow | undefined
    for (const item of items) {
      const at = item.closed?.at ?? ''
      if (best === undefined || at > (best.closed?.at ?? '')) best = item
    }
    return best
  }
  const follow = latest(follows.filter((item) => item.own)) ?? latest(follows)
  const number = follow === undefined ? undefined : pullNumber(follow.thread)
  if (number === undefined) return []
  const url = pullPage(repository, number)
  const zh = chinese(request)
  const text =
    outcome === 'merged'
      ? zh
        ? `[PR #${number}](${url}) 已合并。`
        : `[PR #${number}](${url}) has merged.`
      : zh
        ? `[PR #${number}](${url}) 已关闭，未合并。`
        : `[PR #${number}](${url}) was closed without merging.`
  return ticket.channels
    .filter((channel) => channel.source !== 'github')
    .map((channel) => ({
      id: key('pr-terminal', String(number), channel.source, JSON.stringify(channel.address), outcome),
      channel,
      text,
      kind: 'notice' as const,
      ticketId: ticket.id
    }))
}

// `superagent read <resource>` 的读面（§G.2 的 read 行、§I.2 的「资源读取」行、§I.3 的五种
// Feishu 读法、§G.1 的角色与限额、§O 的「无权限如实说」）。
//
// 一件事只在这里做一次：**把资源名路由到 Source 的读模块**，把分页、角色与拒绝收成同一个
// 形状。CLI 与 HTTP 共用它——`http/read.ts` 只把查询串/角色搬进来、把拒绝换成 `ApiError`；
// `cli/commands.ts` 只把 `read github/…` 变成一次 HTTP 调用。
//
// 三条纪律（与 `app/eval.ts` 同）：
// - **无权限 / 已删 / 找不到是状态，不是空结果**：`forbidden` / `deleted` / `missing` 原样透出，
//   `items` 为空时 `status` 一定说明原因（§I.2、§I.3 的失败处理列）；
// - **不猜内容**：未知资源名直接拒绝并列出可用写法；读不到的东西不编；
// - **不新增出口**：GitHub 走 `githubRead`、Feishu 走 `feishuRead`（kind 自己的读模块），
//   CLI 只经 `CommandsHost` 调用（§I.4），本文件不 spawn、不拼 shell、不读时钟。
//
// 分页有两层，两层都要能推进（票面「分页与资源自身游标都可推进」）：
// - `offset` / `limit`：一页**之内**的切片。列表页的 `limit` 是条数（默认 20、上限 50）；
//   文本页（一条长消息）的 `limit` 是字符数（默认 4000、上限 8000），`offset` 是字符偏移；
// - 资源自己的游标：GitHub 的 `next` 就是下一个资源名（`github/issues/12/comments/2`），
//   Feishu 的 `next` 是 `body.next_resource`（`feishu/<trigger>/thread/<cursor>`）。把它原样
//   作为下一次的 `<resource>` 交回即可续读；于是两种 kind 的推进方式只有一句话。游标不带页
//   大小——想保持同一页大小就把 `--limit` 一起重复。
//
// Feishu 的 `thread` 读的是**话题本身**：消息没有话题时给 `no_thread`（如实说明），不在这里
// 退化成「聊天邻居」——那是 `feishu/<trigger>/around` 这一种读法（§I.3 的五种形式），
// 评估窗口 `threadContext.read` 的退化只属于 `app/eval.ts`。
//
// 依赖纪律（§C.2）：本文件在 `app/`，import 领域类型、`sources/` 的读模块与命令端口；不 import
// `http/`、不 import `cli/`、不读存储。
import { threadKey } from '../core/index.ts'
import type { Ticket, Trigger } from '../core/index.ts'
import type { ContextMessage } from '../sources/admission-context.ts'
import type { CommandsHost } from '../sources/commands.ts'
import { feishuRead } from '../sources/feishu/read.ts'
import type { FeishuReadResult, FeishuReadSection } from '../sources/feishu/read.ts'
import type { GithubChecks } from '../sources/github/api.ts'
import { GithubResourceError, githubRead } from '../sources/github/read.ts'
import type { GithubResourceRead } from '../sources/github/read.ts'

/** 列表页的条数：默认 20、上限 50（§G.2 的 read 行）。 */
export const READ_DEFAULT_LIMIT = 20
export const READ_MAX_LIMIT = 50

/** 文本页的字符数：默认 4000、上限 8000（§G.2 的 read 行）。 */
export const READ_TEXT_DEFAULT_CHARS = 4000
export const READ_TEXT_MAX_CHARS = 8000

/**
 * 单条正文的硬上限：一次响应最多带 1 MiB（§G.3 第 6 条的 body 上限同值）。更长的正文已经
 * 不是「一页」能承载的东西，给 `too_large` 而不是假装分页读完了。
 */
export const READ_TEXT_HARD_CHARS = 1024 * 1024

/** 列表页里每条消息的正文上限（固定值：列表页的 `limit` 是条数，不是字符数）。 */
export const READ_ITEM_TEXT_CHARS = READ_TEXT_DEFAULT_CHARS

/** Feishu 的五种读法（§I.3 的「线程上下文」行）。 */
export const FEISHU_READ_SECTIONS: readonly FeishuReadSection[] = [
  'message',
  'root',
  'parent',
  'thread',
  'around'
]

/**
 * `read` 现在服务的资源名（§I.2 的「资源读取」行 + §I.3 的读法）。未知资源名的拒绝把它原样
 * 交给调用方：技能文本里教模型用的就是这些写法。
 */
export const READ_SOURCE_RESOURCES: readonly string[] = [
  'github/issues/<number>',
  'github/issues/<number>/comments/<page>',
  'github/pulls/<number>',
  'github/pulls/<number>/comments/<page>',
  'github/pulls/<number>/reviews/<page>',
  'github/pulls/<number>/thread/<comment-id>',
  'github/pulls/<number>/checks',
  'github/commits/<sha>/checks',
  'feishu/<trigger>/message',
  'feishu/<trigger>/root',
  'feishu/<trigger>/parent',
  'feishu/<trigger>/thread',
  'feishu/<trigger>/around'
]

/** 三种 token 角色里 read 认的那些（§G.1 的角色阶梯；`http/routes.ts` 的同名联合）。 */
export type ReadRole = 'operator' | 'router' | 'assignment'

/** 一次读的固定拒绝码（§G.2 的 read 行 + §O 的角色与边界）。 */
export type ReadRefusalCode =
  | 'unknown_resource'
  | 'refused'
  | 'not_permitted_role'
  | 'missing'
  | 'too_large'
  | 'invalid_value'
  | 'unavailable'

/** 一次读的请求：资源名、角色与分页。 */
export interface ReadRequest {
  readonly resource: string
  readonly role: ReadRole
  /** assignment token 绑定的 Ticket（§O 角色行）；其他角色不读它。 */
  readonly ticketId?: string | undefined
  /** 一页之内的偏移：列表页是条数，文本页是字符数。 */
  readonly offset?: number | undefined
  /** 一页的大小：列表页是条数（≤ 50），文本页是字符数（≤ 8000）。 */
  readonly limit?: number | undefined
}

/** 一条被拒的读：`values` 只放填槽值（`forms`、`limit`、`reason`…）。 */
export interface ReadRefusal {
  readonly ok: false
  readonly code: ReadRefusalCode
  readonly message: string
  readonly values?: Readonly<Record<string, string>>
}

/** 一条读到的消息（与语境消息同形；正文可能按文本页截断）。 */
export interface ReadItem {
  readonly id: string
  readonly from: string
  readonly at: string
  readonly text: string
  /** 被截断时的全文长度（字符）。 */
  readonly chars?: number
  readonly truncated?: true
  readonly bot?: true
  readonly deleted?: true
  readonly replyTo?: string
  readonly url?: string
  readonly path?: string
  readonly line?: number
}

/** 一次读的回执（§G.2 的 `{items, next_offset}`，单条读就是 `items` 只有一条）。 */
export interface ReadView {
  readonly resource: string
  readonly kind: 'github' | 'feishu'
  /** Source 的状态（`available` / `forbidden` / `deleted` / `missing` / `no_thread`…）。 */
  readonly status: string
  readonly items: readonly ReadItem[]
  /** 这一页里继续读的偏移；`null` 表示这一页读完了（`next` 才是下一页）。 */
  readonly next_offset: number | null
  /** 资源自己的下一页游标（原样作为下一次的 `<resource>` 交回）；没有更多是 `null`。 */
  readonly next: string | null
  /** 文本页被切过（还有下一段，或这一段不是从头开始）。 */
  readonly truncated?: true
  /** 被切时全文的长度（字符）。 */
  readonly chars?: number
  /** 检查读（`/checks`）的读数：没有消息，只有这些。 */
  readonly checks?: GithubChecks | null
  /** Source 自己的原始体（`status` / `next_resource` / `skipped`…，§I.1）。 */
  readonly body: Record<string, unknown>
}

/** 一次读的结局。 */
export type ReadResult = { readonly ok: true; readonly result: ReadView } | ReadRefusal

/** 读工具需要的宿主端口（组合根注入；测试用替身）。 */
export interface ReadToolHost {
  /** Source 命令端口（唯一 CLI 出口，§I.4）。 */
  readonly commands: CommandsHost
  /** 一个启用的 Source 实例的配置；未安装或被人关掉时 undefined。 */
  readonly sourceConfig: (kind: string) => Record<string, unknown> | undefined
  /** 一条已存的 Trigger（Feishu 的资源名用它定位会话坐标）。 */
  readonly trigger: (id: string) => Trigger | undefined
  /** 全部 Ticket（assignment 只能读自己 Ticket 相关的资源，§O）。 */
  readonly tickets: () => readonly Ticket[]
  /** 内部失败的日志出口（不回显给调用方）。 */
  readonly log?: (message: string) => void
}

/** CLI 与 HTTP 共用的读命令。 */
export interface ReadTools {
  read(request: ReadRequest): Promise<ReadResult>
}

/** 一个资源名是否属于 Source 读面（`github/…` / `feishu/…`）。 */
export function isSourceResource(resource: string): boolean {
  const trimmed = resource.trim()
  return trimmed.startsWith('github/') || trimmed.startsWith('feishu/')
}

/** GitHub 资源名的粗形状（细节仍由 `githubRead` 判；这里只用来定位 role 判定要的编号/提交）。 */
const GITHUB_ISSUE_OR_PULL = /^github\/(issues|pulls)\/([1-9]\d*)(?:\/|$)/
const GITHUB_COMMIT_CHECKS = /^github\/commits\/([0-9a-fA-F]{7,64})\/checks$/

/** Feishu 资源名：`feishu/<trigger>/<section>[/<cursor>]`（游标可能含 `/`，整段都算游标）。 */
const FEISHU_RESOURCE = /^feishu\/([^/\s]+)\/([^/\s]+)(?:\/(.+))?$/

/** 解析后的资源名：GitHub 交给读模块，Feishu 还要定位 Trigger 与游标。 */
type ParsedResource =
  | { readonly kind: 'github'; readonly resource: string; readonly number?: number; readonly sha?: string }
  | {
      readonly kind: 'feishu'
      readonly resource: string
      readonly triggerId: string
      readonly section: FeishuReadSection
      readonly cursor?: string
    }

/** 取字符串字段（缺失 / 非字符串 → 空串）。 */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 游标段：`next_resource` 里它是 percent-encoded；直接给原值时解码失败就用原值。 */
function cursorOf(segment: string | undefined): string | undefined {
  if (segment === undefined) return undefined
  if (segment.length === 0) return undefined
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** 解析资源名；形状不认识就给 undefined（调用方落 `unknown_resource`）。 */
export function parseReadResource(resource: string): ParsedResource | undefined {
  const trimmed = resource.trim()
  const commit = GITHUB_COMMIT_CHECKS.exec(trimmed)
  if (commit !== null) return { kind: 'github', resource: trimmed, sha: (commit[1] as string).toLowerCase() }
  const github = GITHUB_ISSUE_OR_PULL.exec(trimmed)
  if (github !== null) return { kind: 'github', resource: trimmed, number: Number(github[2]) }
  const feishu = FEISHU_RESOURCE.exec(trimmed)
  if (feishu === null) return undefined
  const section = feishu[2] as FeishuReadSection
  if (!FEISHU_READ_SECTIONS.includes(section)) return undefined
  const cursor = cursorOf(feishu[3])
  return {
    kind: 'feishu',
    resource: trimmed,
    triggerId: feishu[1] as string,
    section,
    ...(cursor === undefined ? {} : { cursor })
  }
}

/** 一次固定拒绝。 */
function refuse(
  code: ReadRefusalCode,
  message: string,
  values?: Readonly<Record<string, string>>
): ReadRefusal {
  return values === undefined ? { ok: false, code, message } : { ok: false, code, message, values }
}

/** 未知资源名：把可用写法原样交出去（技能文本与模型照抄这些名字）。 */
function unknownResource(resource: string): ReadRefusal {
  return refuse('unknown_resource', `Unknown resource ${resource}`, {
    resource,
    forms: READ_SOURCE_RESOURCES.join(', ')
  })
}

/** 区间内的整数；不是数字或越界就 undefined（调用方决定是缺省还是拒绝）。 */
function integerIn(value: number | undefined, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value)) return undefined
  return value < minimum || value > maximum ? undefined : value
}

/** 一次读的形状：文本页（一条消息按字符分页）或列表页（多条消息按条分页）。 */
type ReadShape = 'text' | 'items' | 'checks'

/** 资源名 → 一页的形状：GitHub 的描述与 Feishu 的单条读是文本页，`/checks` 没有消息。 */
function shapeOf(parsed: ParsedResource): ReadShape {
  if (parsed.kind === 'github') {
    if (parsed.sha !== undefined) return 'checks'
    if (/\/checks$/.test(parsed.resource)) return 'checks'
    // 没有 section 的 `github/issues/<n>` 与 `github/pulls/<n>` 是单条描述。
    return /^github\/(issues|pulls)\/[1-9]\d*$/.test(parsed.resource) ? 'text' : 'items'
  }
  return parsed.section === 'message' || parsed.section === 'root' || parsed.section === 'parent'
    ? 'text'
    : 'items'
}

/** 一条消息 → 一页里的一项（`cut` 决定正文给多少）。 */
function itemOf(message: ContextMessage, text: string, extra: { chars?: number; truncated?: true }): ReadItem {
  return {
    id: message.id,
    from: message.from,
    at: message.at,
    text,
    ...extra,
    ...(message.bot === true ? { bot: true as const } : {}),
    ...(message.deleted === true ? { deleted: true as const } : {}),
    ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
    ...(message.url === undefined ? {} : { url: message.url }),
    ...(message.path === undefined ? {} : { path: message.path }),
    ...(message.line === undefined ? {} : { line: message.line })
  }
}

/** 一段正文的切法：从 `offset` 起 `limit` 个字符，并说明还有没有下一段。 */
function cutText(
  text: string,
  offset: number,
  limit: number
): { text: string; next: number | null; chars?: number; truncated?: true } {
  const window = text.slice(offset, offset + limit)
  const end = offset + window.length
  const next = end < text.length ? end : null
  const truncated = next !== null || offset > 0
  return { text: window, next, ...(truncated ? { chars: text.length, truncated: true as const } : {}) }
}

/** 一张 Ticket 认领的东西：来源 Trigger 的 Thread、它跟随的 Thread、以及那些 Trigger 的提交。 */
interface Claims {
  readonly threads: Set<string>
  readonly triggers: Set<string>
  readonly shas: Set<string>
}

/** 一张 Ticket 认领的集合（§I.2 的 Thread 键与 CI 的 `headSha`/`commitId`）。 */
function claimsOf(ticket: Ticket, triggerOf: (id: string) => Trigger | undefined): Claims {
  const threads = new Set<string>()
  const triggers = new Set<string>()
  const shas = new Set<string>()
  for (const id of [ticket.origin.triggerId, ...ticket.origin.triggerIds]) {
    triggers.add(id)
    const trigger = triggerOf(id)
    if (trigger === undefined) continue
    for (const ref of trigger.threads) threads.add(threadKey(ref))
    const sha = textOf(trigger.meta['headSha']) || textOf(trigger.meta['commitId'])
    if (sha.length > 0) shas.add(sha.toLowerCase())
  }
  for (const follow of ticket.follows ?? []) threads.add(follow.thread)
  return { threads, triggers, shas }
}

/**
 * 一张 Ticket 认领的 Thread 键集合（§I.2 的 Thread 键）。Source 资源读面用它判 assignment
 * 能不能读某个资源（`authorize`），视图读面（`read thread/<key>`）用同一个判定——
 * 「自己 Ticket 相关的 Thread」只有一处说法（§O）。
 */
export function ticketThreads(
  ticket: Ticket,
  triggerOf: (id: string) => Trigger | undefined
): ReadonlySet<string> {
  return claimsOf(ticket, triggerOf).threads
}

/** `github:<n>` 与 `github:<n>/…`（评审线程 `github:<n>/rt/<root>`）都算这个编号的 Thread。 */
function threadTouches(threads: ReadonlySet<string>, number: number): boolean {
  const prefix = `github:${number}`
  for (const key of threads) {
    if (key === prefix || key.startsWith(`${prefix}/`)) return true
  }
  return false
}

/** 一条 Feishu Trigger 是否落在这张 Ticket 认领的 Thread 上（或就是它的来源消息）。 */
function feishuTouches(claims: Claims, trigger: Trigger): boolean {
  if (claims.triggers.has(trigger.id)) return true
  return trigger.threads.some((ref) => claims.threads.has(threadKey(ref)))
}

/** 资源名是否落在 `claims` 里。 */
function claimsResource(claims: Claims, parsed: ParsedResource, trigger: Trigger | undefined): boolean {
  if (parsed.kind === 'github') {
    if (parsed.sha !== undefined) return claims.shas.has(parsed.sha)
    return parsed.number === undefined ? false : threadTouches(claims.threads, parsed.number)
  }
  return trigger === undefined ? false : feishuTouches(claims, trigger)
}

/**
 * 角色判定（§G.1 的角色阶梯、§O 的角色行）：router/operator 全读；assignment 只读自己 Ticket
 * 相关的资源。两种拒绝分得开：
 * - `not_permitted_role`：资源属于**别的** Ticket（越权）；
 * - `refused`：没有任何 Ticket 认领它（这个角色的读面就没有它）。
 */
function authorize(
  request: ReadRequest,
  parsed: ParsedResource,
  trigger: Trigger | undefined,
  host: ReadToolHost
): ReadRefusal | undefined {
  if (request.role !== 'assignment') return undefined
  const ticketId = request.ticketId
  if (ticketId === undefined) {
    return refuse(
      'not_permitted_role',
      'An assignment token names the ticket whose resources it may read',
      { role: request.role }
    )
  }
  const tickets = host.tickets()
  const own = tickets.find((ticket) => ticket.id === ticketId)
  if (own !== undefined && claimsResource(claimsOf(own, host.trigger), parsed, trigger)) return undefined
  const owners = tickets.filter(
    (ticket) =>
      ticket.id !== ticketId && claimsResource(claimsOf(ticket, host.trigger), parsed, trigger)
  )
  if (owners.length > 0) {
    return refuse(
      'not_permitted_role',
      'This resource belongs to another ticket; an assignment reads only its own',
      { resource: parsed.resource, tickets: owners.map((ticket) => ticket.id).join(',') }
    )
  }
  return refuse('refused', 'This resource is not tied to the ticket; ask the router to read it', {
    resource: parsed.resource,
    reason: 'not_related_to_ticket'
  })
}

/** GitHub 的配置读取：仓库与 CLI 是资源读要的两项（§I.2 的「配置」行）。 */
function githubOf(config: Record<string, unknown>): { repository: string; cli: string } {
  return { repository: textOf(config['repository']).trim(), cli: textOf(config['cli']).trim() || 'gh' }
}

/** Feishu 的配置读取：`cli` 缺失说明这条 Source 还没装好（§I.3 的「配置」行）。 */
function feishuCli(config: Record<string, unknown>): string {
  return textOf(config['cli']).trim()
}

/** 一次列表页的切片：`offset` 跳过、`limit` 截断，并说明这一页里还有没有下一段。 */
function sliceItems<T>(
  items: readonly T[],
  offset: number,
  limit: number
): { items: readonly T[]; next: number | null } {
  const slice = items.slice(offset, offset + limit)
  const end = offset + slice.length
  return { items: slice, next: end < items.length ? end : null }
}

/** 一次文本页的读数：一条消息按字符切。 */
function textView(input: {
  readonly parsed: ParsedResource
  readonly status: string
  readonly message: ContextMessage | null
  readonly body: Record<string, unknown>
  readonly offset: number
  readonly limit: number
}): ReadResult {
  if (input.message === null) {
    return {
      ok: true,
      result: {
        resource: input.parsed.resource,
        kind: input.parsed.kind,
        status: input.status,
        items: [],
        next_offset: null,
        next: null,
        body: input.body
      }
    }
  }
  const message = input.message
  if (message.text.length > READ_TEXT_HARD_CHARS) {
    return refuse(
      'too_large',
      `This message is ${message.text.length} characters; one read carries at most ${READ_TEXT_HARD_CHARS}`,
      { limit: String(READ_TEXT_HARD_CHARS), chars: String(message.text.length), resource: input.parsed.resource }
    )
  }
  const cut = cutText(message.text, input.offset, input.limit)
  return {
    ok: true,
    result: {
      resource: input.parsed.resource,
      kind: input.parsed.kind,
      status: input.status,
      items: [itemOf(message, cut.text, { ...(cut.chars === undefined ? {} : { chars: cut.chars }), ...(cut.truncated === true ? { truncated: true as const } : {}) })],
      next_offset: cut.next,
      next: null,
      ...(cut.truncated === true ? { truncated: true as const } : {}),
      ...(cut.chars === undefined ? {} : { chars: cut.chars }),
      body: input.body
    }
  }
}

/** 一次列表页的读数：消息按条切，每条正文截到 `READ_ITEM_TEXT_CHARS`。 */
function itemsView(input: {
  readonly parsed: ParsedResource
  readonly status: string
  readonly messages: readonly ContextMessage[]
  readonly next: string | null
  readonly body: Record<string, unknown>
  readonly offset: number
  readonly limit: number
  readonly checks?: GithubChecks | null
}): ReadResult {
  const sliced = sliceItems(input.messages, input.offset, input.limit)
  const items = sliced.items.map((message) => {
    const cut = cutText(message.text, 0, READ_ITEM_TEXT_CHARS)
    return itemOf(message, cut.text, {
      ...(cut.chars === undefined ? {} : { chars: cut.chars }),
      ...(cut.truncated === true ? { truncated: true as const } : {})
    })
  })
  return {
    ok: true,
    result: {
      resource: input.parsed.resource,
      kind: input.parsed.kind,
      status: input.status,
      items,
      next_offset: sliced.next,
      next: input.next,
      ...(input.checks === undefined ? {} : { checks: input.checks }),
      body: input.body
    }
  }
}

/** 资源名 → 一页的字符/条数上限（文本页读字符，列表页读条数）。 */
function limitsOf(shape: ReadShape): { readonly fallback: number; readonly maximum: number; readonly flag: string } {
  return shape === 'text'
    ? { fallback: READ_TEXT_DEFAULT_CHARS, maximum: READ_TEXT_MAX_CHARS, flag: 'limit' }
    : { fallback: READ_DEFAULT_LIMIT, maximum: READ_MAX_LIMIT, flag: 'limit' }
}

/** 分页参数的校验：`offset` 非负整数；`limit` 在形状对应的区间内。 */
function pagingOf(
  request: ReadRequest,
  shape: ReadShape
): { readonly offset: number; readonly limit: number } | ReadRefusal {
  const offset = request.offset
  if (offset !== undefined && integerIn(offset, 0, Number.MAX_SAFE_INTEGER) === undefined) {
    return refuse('invalid_value', 'offset must be a non-negative integer', {
      flag: 'offset',
      value: String(offset)
    })
  }
  const limits = limitsOf(shape)
  const limit = integerIn(request.limit, 1, limits.maximum)
  if (request.limit !== undefined && limit === undefined) {
    return refuse(
      'invalid_value',
      `limit must be an integer between 1 and ${limits.maximum} for this resource`,
      { flag: limits.flag, max: String(limits.maximum), value: String(request.limit) }
    )
  }
  return { offset: offset ?? 0, limit: limit ?? limits.fallback }
}

/** GitHub 的一次读：配置、角色与分页都过了才碰 CLI。 */
async function readGithub(
  host: ReadToolHost,
  parsed: Extract<ParsedResource, { kind: 'github' }>,
  request: ReadRequest,
  config: Record<string, unknown>
): Promise<ReadResult> {
  const { repository, cli } = githubOf(config)
  if (repository.length === 0) {
    return refuse('unavailable', 'The GitHub Source has no repository yet; finish its setup first', {
      source: 'github',
      reason: 'repository_missing'
    })
  }
  const shape = shapeOf(parsed)
  const paging = pagingOf(request, shape)
  if ('ok' in paging) return paging
  let read: GithubResourceRead
  try {
    read = await githubRead({ host: host.commands, cli, repository, resource: parsed.resource })
  } catch (error) {
    // `githubRead` 自己把 401/403/404/410 折成状态；还抛出来的只有两种：资源名形状不认识
    // （`GithubResourceError`）与真正可重试的失败（限流、超时、没有 HTTP 码）。
    if (error instanceof GithubResourceError) return unknownResource(parsed.resource)
    host.log?.(`read ${parsed.resource} failed: ${String(error)}`)
    return refuse('unavailable', 'The Source could not read this now; retry in a moment', {
      resource: parsed.resource,
      reason: 'source_unavailable'
    })
  }

  if (read.kind === 'messages') {
    return itemsView({
      parsed,
      status: read.status,
      messages: read.messages,
      next: read.next ?? null,
      body: read.body,
      offset: paging.offset,
      limit: paging.limit
    })
  }
  if (read.kind === 'checks') {
    return itemsView({
      parsed,
      status: read.status,
      messages: [],
      next: null,
      body: read.body,
      offset: 0,
      limit: READ_DEFAULT_LIMIT,
      checks: read.checks
    })
  }
  return textView({
    parsed,
    status: read.status,
    message: read.description?.message ?? null,
    body: read.body,
    offset: paging.offset,
    limit: paging.limit
  })
}

/** Feishu 的一次读：Trigger 由调用方解析好，游标与页大小交给 `feishuRead`。 */
async function readFeishu(
  host: ReadToolHost,
  parsed: Extract<ParsedResource, { kind: 'feishu' }>,
  trigger: Trigger,
  request: ReadRequest,
  config: Record<string, unknown>
): Promise<ReadResult> {
  const cli = feishuCli(config)
  if (cli.length === 0) {
    return refuse('unavailable', 'The Feishu Source has no CLI yet; finish its setup first', {
      source: 'feishu',
      reason: 'cli_missing'
    })
  }
  const shape = shapeOf(parsed)
  const paging = pagingOf(request, shape)
  if ('ok' in paging) return paging
  let read: FeishuReadResult
  try {
    read = await feishuRead({
      host: host.commands,
      cli,
      trigger,
      section: parsed.section,
      ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
      // 列表页的 `limit` 就是 lark-cli 的页大小（上限 50，与 CLI 的一致）。
      ...(shape === 'items' ? { pageSize: paging.limit } : {})
    })
  } catch (error) {
    host.log?.(`read ${parsed.resource} failed: ${String(error)}`)
    return refuse('unavailable', 'The Source could not read this now; retry in a moment', {
      resource: parsed.resource,
      reason: 'source_unavailable'
    })
  }
  if ('message' in read) {
    return textView({
      parsed,
      status: read.status,
      message: read.message,
      body: read.body,
      offset: paging.offset,
      limit: paging.limit
    })
  }
  const next = textOf(read.body['next_resource'])
  return itemsView({
    parsed,
    status: read.status,
    messages: read.messages,
    next: next.length === 0 ? null : next,
    body: read.body,
    offset: paging.offset,
    limit: paging.limit
  })
}

/**
 * 造读命令（§G.2 的 `read <resource>`）。每个资源名先过三关：形状（`unknown_resource`）、
 * Source 是否可用（`unavailable`）、角色（`refused` / `not_permitted_role`），然后交给
 * kind 自己的读模块；**分页与状态在这一层统一**，kind 不需要知道 CLI 的存在。
 */
export function createReadTools(host: ReadToolHost): ReadTools {
  return {
    async read(request: ReadRequest): Promise<ReadResult> {
      const parsed = parseReadResource(request.resource)
      if (parsed === undefined) return unknownResource(request.resource)
      const config = host.sourceConfig(parsed.kind)
      if (config === undefined) {
        return refuse('unavailable', `The ${parsed.kind} Source is not enabled`, {
          source: parsed.kind,
          reason: 'source_disabled'
        })
      }
      // Feishu 的资源名锚定一条 Trigger：它不存在就是 `missing`，不是空页（§I.3 的失败处理）。
      const trigger = parsed.kind === 'feishu' ? host.trigger(parsed.triggerId) : undefined
      if (parsed.kind === 'feishu' && trigger === undefined) {
        return refuse('missing', 'No such trigger', { trigger: parsed.triggerId, resource: parsed.resource })
      }
      const denied = authorize(request, parsed, trigger, host)
      if (denied !== undefined) return denied
      return parsed.kind === 'github'
        ? readGithub(host, parsed, request, config)
        : readFeishu(host, parsed, trigger as Trigger, request, config)
    }
  }
}

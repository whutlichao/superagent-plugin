// 路由表（§G.3）：**CLI 与面板唯一共享的契约**。本文件是这张表的单一命名处，改动它等于
// 改动 CLI 的语义，所以每条路由在这里写清四件事：方法 + 路径、对应命令、**最低角色**、
// handler 的签名。
//
// 契约（#8 的 CLI 直接消费）：
// - 路径一律相对 `/superagent/api/`；段以 `:` 开头的部分是参数（`decodeURIComponent` 后
//   原样给 handler）。
// - `minimumRole` 是**最低角色**，角色阶梯 `assignment < router < operator`（§G.1：
//   operator 全权、router 是路由与评估的子集、assignment 只有自己的 Ticket 与 worker
//   能力集）。判定是 `rank(caller) >= rank(route.minimumRole)`；不够 → `not_permitted_role`。
//   逐路由的依据见每条上的注释（§F.6 的 Router 命令清单 + 面板专属动作）。
// - 请求体是 JSON；响应体恒为 `{ok:true, result}` / `{ok:false, error:{code,message,values?}}`。
// - handler 抛 `ApiError` 决定状态码；抛别的按 500 `internal` 处理（不回显原文）。
// - **尚未落地的 handler 一律 `stub()`**：它们有最终签名与角色要求，但返回固定
//   `unavailable`（503），直到拥有该命令的票接上实现。替换只改 `handler` 字段。
//
// 字段级限制（比角色更细，仍在运行时判）：
// - `PUT settings/:block`：非 operator 改 setup 字段 → `origin_forbidden`（§K.8）。
// - `GET tickets/:id`：assignment 只能看自己绑定的 Ticket，否则 `not_permitted_role`（§O）。
//
// 写命令的幂等（§G.1 幂等行）：CLI 的 `--request-id` 走 HTTP 的 `x-superagent-request-id`
// 头；handler 用 `idempotency.ts` 的 `runIdempotent()` 包住真正的工作，同 id 一小时内
// 重试返回首次结果。**失败不缓存**（重试有机会成功）。
import { SETUP_FIELDS } from '../app/settings.ts'
import { ApiError, ERROR_CODES } from './errors.ts'

/** 三种 token 角色（与 `infra/tokens.ts` 的同名类型一致；这里只声明，不 import 实现）。 */
export type RouteRole = 'operator' | 'router' | 'assignment'

/** 角色阶梯：数字越大权限越宽（§G.1 角色行）。 */
export const ROLE_RANK: Readonly<Record<RouteRole, number>> = {
  assignment: 0,
  router: 1,
  operator: 2
}

/** 通过校验的调用者（角色 + assignment 绑定）。 */
export interface RouteCaller {
  readonly role: RouteRole
  readonly ticketId?: string
  readonly assignmentId?: string
}

/** handler 拿到的请求上下文。 */
export interface RouteInput {
  /** 路径参数（已解码）。 */
  readonly params: Readonly<Record<string, string>>
  /** 查询串（同名键取最后一个）。 */
  readonly query: Readonly<Record<string, string>>
  /** 已解析的 JSON body；没有 body 时为 `undefined`。 */
  readonly body: unknown
  /** 通过校验的调用者。 */
  readonly caller: RouteCaller
  /** 请求时间（ISO-8601；幂等记录用）。 */
  readonly at: string
  /**
   * 调用者的 Bearer token 原文：只给**幂等键的哈希**用（`callerKey()`），handler 不得回显、
   * 不得写进结果或日志（§O）。缺失表示调用没经过鉴权（只可能在测试的注入路由上发生）。
   */
  readonly token?: string
  /**
   * `x-superagent-request-id`（§G.1 幂等行）：CLI 的 `--request-id` 走这个头。
   * 没有头时为 `null`；body 里也允许带一份（面板/测试），由 handler 决定优先级。
   */
  readonly requestId?: string | null
}

/**
 * handler 的返回值：直接进 `{ok:true, result}`。只允许 JSON 能表达的值（对象由调用方
 * 负责它可序列化），这样 handler 不会把函数、Promise 或 class 实例漏给响应信封。
 */
export type RouteResult = object | string | number | boolean | null | undefined | void

/** handler 签名（CLI 与 HTTP 共用同一批 handler）。 */
export type RouteHandler = (input: RouteInput) => RouteResult | Promise<RouteResult>

/** 一条路由。 */
export interface RouteDefinition {
  readonly method: 'GET' | 'POST' | 'PUT'
  readonly path: string
  /** 对应的 CLI 命令（`superagent …`）；供契约测试与文档核对。 */
  readonly command: string
  /** 允许调用它的最低角色（阶梯见 `ROLE_RANK`）。 */
  readonly minimumRole: RouteRole
  readonly handler: RouteHandler
}

/** 尚未落地的 handler：固定 `unavailable`，等拥有它的票替换。 */
export function stub(): never {
  throw new ApiError(ERROR_CODES.unavailable, 'This command is not available in this build yet', {
    reason: 'not_implemented'
  })
}

/** 写方法是否要求 `x-superagent-request: 1`（§G.3 第 5 条：写方法恒要求）。 */
export function requiresRequestHeader(route: Pick<RouteDefinition, 'method'>): boolean {
  return route.method === 'POST' || route.method === 'PUT'
}

/** 某个角色是否达到该路由的最低要求。 */
export function allowsRole(route: Pick<RouteDefinition, 'minimumRole'>, role: RouteRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[route.minimumRole]
}

/** 该路由允许的全部角色（由阶梯推出；测试与 doctor 用）。 */
export function rolesFor(route: Pick<RouteDefinition, 'minimumRole'>): readonly RouteRole[] {
  const roles: RouteRole[] = ['operator', 'router', 'assignment']
  return roles.filter((role) => allowsRole(route, role))
}

/** setup 字段（§K.8：`stateDir`、`baseRepo`、`cli` 这类决定插件能否启动的字段）。 */
export const SETUP_SETTING_FIELDS: readonly string[] = SETUP_FIELDS

/**
 * `PUT settings/:block` 的角色细化（§K.8、§G.2 的 `origin_forbidden`）：
 * operator 全通；其余角色改 setup 字段 → `origin_forbidden`。
 */
export function assertSettingsWriteAllowed(caller: RouteCaller, body: unknown): void {
  if (caller.role === 'operator') return
  const value = bodyValue(body)
  const touched = SETUP_SETTING_FIELDS.filter((field) => containsKey(value, field))
  if (touched.length > 0) {
    throw new ApiError(
      ERROR_CODES.originForbidden,
      `Only the operator token may change setup fields: ${touched.join(', ')}`,
      { fields: touched.join(', ') }
    )
  }
}

/** `GET tickets/:id` 的运行时判定：assignment 只能看自己的 Ticket（§O 角色行）。 */
export function assertTicketVisible(caller: RouteCaller, ticketId: string): void {
  if (caller.role !== 'assignment') return
  if (caller.ticketId === ticketId) return
  throw new ApiError(
    ERROR_CODES.notPermittedRole,
    'An assignment token may only act on its own ticket',
    { ticket: ticketId }
  )
}

/**
 * 路由表（§G.3 逐行转写）。顺序即匹配顺序；`:param` 段匹配任意单段。
 * 已落地的 handler 由 `server.ts` 在启动时替换 `state` 行的 stub（它需要 HTTP 自身读数）。
 *
 * 最低角色的依据：
 * - `assignment`：`state`（worker 的 `status --json` 自检，§G.5）与 `tickets/:id`（只读自己的）。
 * - `router`：§F.6 列出的 Router 命令（read 的各类资源、route/eval 之外的路由动作、
 *   settings/policy/prompts、ticket 三件、trigger requeue、thread unsubscribe）。
 * - `operator`：面板专属视图（overview/sources/search/policy 历史）、面板动作
 *   （dismiss、刷新 labels）、运维动作（pause、setup check、router restart、workspace open、doctor）。
 */
export const ROUTE_TABLE: readonly RouteDefinition[] = [
  // ---- 读面
  { method: 'GET', path: 'state', command: 'status', minimumRole: 'assignment', handler: stub },
  { method: 'GET', path: 'overview', command: 'read overview', minimumRole: 'operator', handler: stub },
  { method: 'GET', path: 'sources', command: 'read sources', minimumRole: 'operator', handler: stub },
  { method: 'GET', path: 'search', command: 'read search', minimumRole: 'operator', handler: stub },
  { method: 'GET', path: 'threads', command: 'read threads', minimumRole: 'router', handler: stub },
  { method: 'GET', path: 'threads/:key', command: 'read thread/<key>', minimumRole: 'router', handler: stub },
  { method: 'GET', path: 'decisions', command: 'read decisions', minimumRole: 'router', handler: stub },
  { method: 'GET', path: 'tickets', command: 'read tickets', minimumRole: 'router', handler: stub },
  { method: 'GET', path: 'tickets/:id', command: 'read ticket/<id>', minimumRole: 'assignment', handler: stub },
  { method: 'GET', path: 'settings', command: 'settings get', minimumRole: 'router', handler: stub },
  { method: 'GET', path: 'prompts', command: 'prompts get', minimumRole: 'router', handler: stub },
  { method: 'GET', path: 'policy/history', command: 'settings get --history', minimumRole: 'operator', handler: stub },
  { method: 'GET', path: 'models', command: 'read models', minimumRole: 'router', handler: stub },

  // ---- 设置与 prompts（router 的写受 setup 字段限制，见 `assertSettingsWriteAllowed`）
  { method: 'PUT', path: 'settings/:block', command: 'settings save', minimumRole: 'router', handler: stub },
  { method: 'PUT', path: 'prompts', command: 'prompts save', minimumRole: 'router', handler: stub },
  { method: 'POST', path: 'prompts/preview', command: 'prompts save --preview', minimumRole: 'router', handler: stub },

  // ---- Router 的动作（§F.6）
  { method: 'POST', path: 'route', command: 'route', minimumRole: 'router', handler: stub },
  { method: 'POST', path: 'eval-decide/:id', command: 'eval-decide', minimumRole: 'router', handler: stub },
  { method: 'POST', path: 'policy-sync/:id', command: 'policy sync', minimumRole: 'router', handler: stub },
  { method: 'POST', path: 'triggers/:id/requeue', command: 'trigger requeue', minimumRole: 'router', handler: stub },
  { method: 'POST', path: 'threads/:key/unsubscribe', command: 'thread unsubscribe', minimumRole: 'router', handler: stub },
  { method: 'POST', path: 'tickets/:id/retry', command: 'ticket retry', minimumRole: 'router', handler: stub },
  { method: 'POST', path: 'tickets/:id/stop', command: 'ticket stop', minimumRole: 'router', handler: stub },
  { method: 'POST', path: 'tickets/:id/note', command: 'ticket note', minimumRole: 'router', handler: stub },
  { method: 'POST', path: 'tickets/:id/request-status', command: 'ticket request-status', minimumRole: 'router', handler: stub },

  // ---- Worker 的三条（§G.2 的 report / reply / ack；Ticket 来自 assignment token）
  { method: 'POST', path: 'report', command: 'report', minimumRole: 'assignment', handler: stub },
  { method: 'POST', path: 'reply', command: 'reply', minimumRole: 'assignment', handler: stub },
  { method: 'POST', path: 'ack', command: 'ack', minimumRole: 'assignment', handler: stub },

  // ---- 面板专属动作与运维动作（operator）
  { method: 'POST', path: 'sources/:id/labels', command: 'source labels', minimumRole: 'operator', handler: stub },
  { method: 'POST', path: 'decisions/:id/dismiss', command: 'read decisions --dismiss', minimumRole: 'operator', handler: stub },
  { method: 'POST', path: 'executor/pause', command: 'pause/resume', minimumRole: 'operator', handler: stub },
  { method: 'POST', path: 'setup/check', command: 'setup check', minimumRole: 'operator', handler: stub },
  { method: 'POST', path: 'router/restart', command: 'router restart', minimumRole: 'operator', handler: stub },
  { method: 'POST', path: 'workspaces/:id/open', command: 'workspace open', minimumRole: 'operator', handler: stub },
  { method: 'POST', path: 'doctor', command: 'doctor', minimumRole: 'operator', handler: stub },

  // ---- 运维：立即备份与轮换主 token（§G.2 的 admin 行；破坏性动作由 handler 要求确认）
  { method: 'POST', path: 'admin/backup', command: 'admin backup', minimumRole: 'operator', handler: stub },
  { method: 'POST', path: 'admin/rotate-token', command: 'admin rotate-token', minimumRole: 'operator', handler: stub }
]

/** 请求体里可以出现的一条 JSON 值（这里就是设置写入的形状）。 */
type BodyValue = string | number | boolean | null | readonly BodyValue[] | { readonly [key: string]: BodyValue }

/** 从 `{value, revision}` 的请求体里取 `value`（形状不对交给 handler 报 invalid_params）。 */
function bodyValue(body: unknown): BodyValue | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  return (body as { readonly value?: BodyValue }).value
}

/** 对象（或它的 `config`）是否自带某个键。 */
function containsKey(value: BodyValue | undefined, key: string): boolean {
  if (typeof value !== 'object' || value === null) return false
  if (Object.prototype.hasOwnProperty.call(value, key)) return true
  const config = (value as { readonly config?: BodyValue }).config
  return typeof config === 'object' && config !== null && Object.prototype.hasOwnProperty.call(config, key)
}

// Loopback HTTP 服务器（§G.3 第 1–9 条、§N.1 端口选择、§O 安全）。
//
// 每个请求按固定顺序过九道边界，任何一道不过就到此为止：
//   1. 只 bind 127.0.0.1（`listen(port, '127.0.0.1')`；运行期再核一次 `address()`）
//   2. Host 必须是 `127.0.0.1:<port>` / `localhost:<port>` → 否则 403 origin_forbidden
//   3. `Authorization: Bearer <token>` → 缺失/无效 401 unauthorized（不认 cookie）
//   4. 跨站 Origin → 403 origin_forbidden（字面量 `null` 也算跨站）
//   5. 写方法要 `x-superagent-request: 1` → 否则 403 origin_forbidden
//   6. 角色不足 → 403 not_permitted_role
//   7. 每 token 60/min + burst 20 → 超限 429 rate_limited + Retry-After
//   8. body ≤ 1 MiB → 否则 413 too_large；错误码按固定表落状态码
//   9. 日志只有 {method, path, status, code, ms, tokenRole}——没有 body、没有 token、没有查询串
//
// 顺序的理由：先挡「不是本机/不是本站」的请求（最便宜、也最该早拒），再花哈希成本校验
// token，再判角色（越权请求不该让服务端为它解析大 body），最后才读 body。
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { createRateLimiter, type RateLimiter } from './rate-limit.ts'
import { ApiError, ERROR_CODES, toApiError } from './errors.ts'
import { authenticate, authorize } from './auth.ts'
import {
  DEFAULT_PORT,
  portCandidates,
  readPortRecord,
  removePortRecord,
  writePortRecord,
  type PortRecord
} from './port-file.ts'
import {
  ROUTE_TABLE,
  assertSettingsWriteAllowed,
  assertTicketVisible,
  requiresRequestHeader,
  type RouteCaller,
  type RouteDefinition,
  type RouteInput
} from './routes.ts'
import { requestIdOf } from './idempotency.ts'
import { stateView, type HttpHost } from './state.ts'
import { createOpsHandlers, withOpsHandlers, type OpsPorts } from './ops.ts'
import { createPausedState } from '../app/pause.ts'
import { ensureApiToken } from '../infra/tokens.ts'

/** API 的基址前缀（§G.3：`/superagent/api/`）。 */
export const API_BASE = '/superagent/api'

/** 服务器只允许绑在这个地址（§G.3 第 1 条）。 */
export const LOOPBACK_HOST = '127.0.0.1'

/** body 上限：1 MiB（§G.1 限额行、§G.3 第 6 条）。 */
export const MAX_BODY_BYTES = 1024 * 1024

/** 允许的 loopback 主机名（§G.3 第 2、4 条）。 */
const ALLOWED_HOSTS = ['127.0.0.1', 'localhost']

/** 一条访问日志（§G.3 第 9 条）。`tokenRole` 在 401 时为 null；`code` 在成功时为 null。 */
export interface RequestLogLine {
  readonly method: string
  readonly path: string
  readonly status: number
  readonly code: string | null
  readonly ms: number
  readonly tokenRole: RouteCaller['role'] | null
}

/** 服务器启动的输入。 */
export interface HttpServerOptions {
  /** 状态目录（端口文件与 token 都在这里）。 */
  readonly stateDir: string
  /** state 视图与各 handler 的宿主端口。 */
  readonly host: HttpHost
  /**
   * 首选端口（§G.4：端口文件 → 缺省 3847）。`0` 表示直接用临时端口（测试用）。
   * 缺省读 `<stateDir>/api-port`，没有则 3847。
   */
  readonly preferredPort?: number
  /** 端口文件里写的 pid（缺省 `process.pid`；测试注入）。 */
  readonly pid?: number
  /** 启动时刻（ISO-8601；测试注入）。 */
  readonly startedAt?: string
  /** 时钟（测试注入；token 过期与限流都读它）。 */
  readonly now?: () => Date
  /** 访问日志出口（§G.3 第 9 条）。缺省不写。 */
  readonly log?: (line: RequestLogLine) => void
  /** 限流器（缺省 60/min + burst 20）。 */
  readonly rateLimiter?: RateLimiter
  /** 路由表（缺省 `ROUTE_TABLE`；测试可注入额外路由）。 */
  readonly routes?: readonly RouteDefinition[]
  /**
   * 运维命令的接线（§G.2）：暂停、source labels、admin backup/rotate-token、doctor。
   * 缺省用 store + stateDir 构造；组合根可以覆盖 `sourceLabels` / `run` / `cliPath`。
   */
  readonly ops?: OpsPorts
}

/** 起好的服务器句柄。 */
export interface HttpServerHandle {
  /** 实际监听的端口（写进端口文件的那个）。 */
  readonly port: number
  /** 运行期从 `address()` 读回的实际绑定地址（恒为 127.0.0.1）。 */
  readonly boundHost: string
  /** 期望绑定的地址（§G.3 第 1 条：`127.0.0.1`）。 */
  readonly host: string
  /** 基址前缀 `/superagent/api`。 */
  readonly basePath: string
  /** 已服务的请求数（`GET state` 的 `http.requests`）。 */
  readonly requests: number
  /** 关闭：释放监听并删掉自己写的端口文件；重复调用无副作用。 */
  close(): void
}

/** 一次请求的日志上下文。 */
interface RequestContext {
  readonly method: string
  readonly path: string
  readonly startedAtMs: number
  status: number
  code: string | null
  tokenRole: RouteCaller['role'] | null
  retryAfterMs: number | null
}

/** 解析成功的请求。 */
interface Parsed {
  readonly route: RouteDefinition
  readonly params: Readonly<Record<string, string>>
  readonly query: Readonly<Record<string, string>>
  readonly body: unknown
  readonly caller: RouteCaller
  /** 通过校验的 token 原文（只为幂等键的哈希存在；不写日志、不回显，§O）。 */
  readonly token: string
}

/**
 * 起 HTTP 服务器：先按 §N.1 找端口（端口文件 → 默认 → +1…+20 → 临时端口），
 * 绑成功后把实际端口写回端口文件（0600，含 pid 与启动时刻）。
 */
export async function startHttpServer(options: HttpServerOptions): Promise<HttpServerHandle> {
  const now = options.now ?? (() => new Date())
  const log = options.log ?? (() => undefined)
  const pid = options.pid ?? process.pid
  const startedAt = options.startedAt ?? now().toISOString()

  // 主 token 首启生成（§D.6）：API 起来之前 token 文件必须存在，否则 401 永远无法通过。
  ensureApiToken(options.stateDir)

  // 暂停状态是同一个读模型的两处出口：`pause`/`resume` 写它，`GET state` 的 `paused` 读它。
  // 于是 CLI 的 `pause` 之后紧接着 `status` 一定看到 `paused: true`（退出码因此是 3）。
  const pausedState = options.ops?.paused ?? createPausedState(options.host.store)
  const host: HttpHost =
    options.host.paused === undefined
      ? { ...options.host, paused: () => pausedState.paused() }
      : options.host

  const opsHandlers = createOpsHandlers({
    store: options.host.store,
    stateDir: options.stateDir,
    ...(options.host.cliPath === undefined ? {} : { cliPath: options.host.cliPath }),
    ...(options.ops === undefined ? {} : { ports: { ...options.ops, paused: pausedState } })
  })
  const routed = withOpsHandlers(options.routes ?? ROUTE_TABLE, opsHandlers)
  const routes = withStateRoute(routed, host, () => ({
    port: bound.port,
    requests
  }))
  const limiter = options.rateLimiter ?? createRateLimiter({ now: () => now().getTime() })

  let requests = 0
  const bound: { port: number } = { port: 0 }

  const listener = (request: IncomingMessage, response: ServerResponse): void => {
    requests += 1
    const context: RequestContext = {
      method: request.method ?? 'GET',
      path: pathOnly(request.url ?? '/'),
      startedAtMs: Date.now(),
      status: 500,
      code: ERROR_CODES.internal,
      tokenRole: null,
      retryAfterMs: null
    }
    void dispatch(request, response, context).finally(() => {
      log({
        method: context.method,
        path: context.path,
        status: context.status,
        code: context.code,
        ms: Math.max(0, Math.round(Date.now() - context.startedAtMs)),
        tokenRole: context.tokenRole
      })
    })
  }

  /** 一个请求的完整流程（九道边界 + 分派）。 */
  async function dispatch(
    request: IncomingMessage,
    response: ServerResponse,
    context: RequestContext
  ): Promise<void> {
    let parsed: Parsed
    try {
      parsed = await parse(request, context, bound.port, routes, limiter, options, now)
    } catch (error) {
      const apiError = toApiError(error)
      respond(response, context, apiError.status, { ok: false, error: apiError.toJSON() }, apiError.code)
      return
    }
    try {
      const result = await parsed.route.handler({
        params: parsed.params,
        query: parsed.query,
        body: parsed.body,
        caller: parsed.caller,
        at: now().toISOString(),
        token: parsed.token,
        requestId: requestIdOf(request.headers)
      })
      respond(response, context, 200, { ok: true, result }, null)
    } catch (error) {
      const apiError = toApiError(error)
      respond(response, context, apiError.status, { ok: false, error: apiError.toJSON() }, apiError.code)
    }
  }

  /** 写响应并把状态码/错误码记进日志上下文。 */
  function respond(
    response: ServerResponse,
    context: RequestContext,
    status: number,
    body: unknown,
    code: string | null
  ): void {
    context.status = status
    context.code = code
    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }
    if (status === 429) {
      // §G.3 第 7 条：`Retry-After` 是秒，向上取整，至少 1。
      headers['retry-after'] = String(Math.max(1, Math.ceil((context.retryAfterMs ?? 1000) / 1000)))
    }
    response.writeHead(status, headers)
    response.end(JSON.stringify(body))
  }

  const server: Server = createServer(listener)
  const preferred = options.preferredPort ?? readPortRecord(options.stateDir)?.port ?? DEFAULT_PORT
  // §N.1：端口文件 → 默认 → +1…+20 → 临时端口。`preferredPort: 0` 只是测试用法。
  const candidates = preferred === 0 ? [0] : [...portCandidates(preferred), 0]
  bound.port = await listenOn(server, candidates)

  const address = server.address()
  const boundHost = typeof address === 'object' && address !== null ? address.address : LOOPBACK_HOST
  if (boundHost !== LOOPBACK_HOST) {
    // 绝不带着非 loopback 的监听继续跑（§G.3 第 1 条）。
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw new ApiError(ERROR_CODES.internal, `refusing to serve on ${boundHost}`)
  }
  server.unref()

  const record: PortRecord = { port: bound.port, pid, startedAt }
  writePortRecord(options.stateDir, record)
  let closed = false

  return {
    port: bound.port,
    boundHost,
    host: LOOPBACK_HOST,
    basePath: API_BASE,
    get requests(): number {
      return requests
    },
    close(): void {
      if (closed) return
      closed = true
      removePortRecord(options.stateDir, record)
      server.closeAllConnections()
      server.close()
    }
  }

  /** 依次尝试候选端口；只有 `EADDRINUSE` 才往后走，别的错误直接抛。 */
  async function listenOn(target: Server, ports: readonly number[]): Promise<number> {
    let lastError: unknown = null
    for (const candidate of ports) {
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error): void => {
            target.removeListener('listening', onListening)
            reject(error)
          }
          const onListening = (): void => {
            target.removeListener('error', onError)
            resolve()
          }
          target.once('error', onError)
          target.once('listening', onListening)
          target.listen(candidate, LOOPBACK_HOST)
        })
        const address = target.address()
        return typeof address === 'object' && address !== null ? address.port : candidate
      } catch (error) {
        lastError = error
        if (!isAddressInUse(error)) throw error
      }
    }
    throw lastError ?? new Error('no port could be bound')
  }
}

/**
 * 把路由表里 `state` 行的 stub 换成真 handler：它需要 server 自己的 HTTP 读数，
 * 所以只能在这里替换。其余行原样保留。
 */
function withStateRoute(
  routes: readonly RouteDefinition[],
  host: HttpHost,
  self: () => { readonly port: number; readonly requests: number }
): readonly RouteDefinition[] {
  return routes.map((route) =>
    route.method === 'GET' && route.path === 'state'
      ? {
          ...route,
          handler: ({ at }: RouteInput) =>
            stateView(host, { host: LOOPBACK_HOST, port: self().port, requests: self().requests }, at)
        }
      : route
  )
}

/** 解析一个请求：边界 2–8 + 路由匹配。抛 `ApiError` 表示已经决定拒绝。 */
async function parse(
  request: IncomingMessage,
  context: RequestContext,
  port: number,
  routes: readonly RouteDefinition[],
  limiter: RateLimiter,
  options: HttpServerOptions,
  now: () => Date
): Promise<Parsed> {
  const url = request.url ?? '/'

  // 2. Host 白名单（§G.3 第 2 条）。
  assertHost(request.headers.host, port)

  // 4. Origin（有就必须是本站；`null` 也不行）。放在鉴权前：跨站请求不该触发哈希计算。
  assertOrigin(request.headers.origin, port)

  // 3. Bearer token（§G.3 第 3 条：不用 cookie）。
  const authenticated = authenticate({
    store: options.host.store,
    stateDir: options.stateDir,
    authorization: request.headers.authorization,
    now
  })
  const caller = authenticated.caller
  const token = authenticated.token
  context.tokenRole = caller.role

  // 路由匹配。
  const path = pathOnly(url)
  if (path !== API_BASE && !path.startsWith(`${API_BASE}/`)) {
    throw new ApiError(ERROR_CODES.missing, 'Unknown path')
  }
  const relative = path.slice(API_BASE.length + 1)
  const matched = matchRoute(routes, request.method ?? 'GET', relative)
  if (matched === null) {
    throw new ApiError(ERROR_CODES.missing, `Unknown operation: ${request.method ?? 'GET'} ${relative}`)
  }

  // 5. 写方法的显式请求头（§G.3 第 5 条）。
  if (requiresRequestHeader(matched.route) && request.headers['x-superagent-request'] !== '1') {
    throw new ApiError(
      ERROR_CODES.originForbidden,
      'Write requests need the x-superagent-request: 1 header'
    )
  }

  // 8a. 角色：先判角色再读 body——越权请求不该让服务端为它解析大 body。
  authorize(matched.route, caller)

  // 7. 限流：每 token 一个桶（§G.3 第 7 条）。
  const decision = limiter.take(token)
  if (!decision.allowed) {
    context.retryAfterMs = decision.retryAfterMs
    throw new ApiError(ERROR_CODES.rateLimited, 'Too many requests for this token', {
      retry_after_ms: String(decision.retryAfterMs)
    })
  }

  // 6. body（§G.3 第 6 条：≤ 1 MiB）。
  const body = await readBody(request)

  // 8b. 路由级的角色细化（非 operator 不能改 setup 字段、assignment 只能看自己的 Ticket）。
  if (matched.route.method === 'PUT' && matched.route.path === 'settings/:block') {
    assertSettingsWriteAllowed(caller, body)
  }
  if (matched.route.method === 'GET' && matched.route.path === 'tickets/:id') {
    assertTicketVisible(caller, matched.params['id'] ?? '')
  }

  return {
    route: matched.route,
    params: matched.params,
    query: queryOf(url),
    body,
    caller,
    token
  }
}

/** 2. Host 头必须是本机的两个名字之一 + 实际端口（§G.3 第 2 条）。 */
function assertHost(host: string | undefined, port: number): void {
  if (host === undefined) {
    throw new ApiError(ERROR_CODES.originForbidden, 'The Host header is required')
  }
  const expected = ALLOWED_HOSTS.map((name) => `${name}:${port}`)
  if (!expected.includes(host)) {
    throw new ApiError(
      ERROR_CODES.originForbidden,
      `The Host header must be ${expected.join(' or ')}`,
      { host }
    )
  }
}

/** 4. Origin：缺省允许；存在就必须等于 `http://<允许的 host>`（§G.3 第 4 条）。 */
function assertOrigin(origin: string | undefined, port: number): void {
  if (origin === undefined) return
  const allowed = ALLOWED_HOSTS.map((name) => `http://${name}:${port}`)
  if (!allowed.includes(origin)) {
    throw new ApiError(ERROR_CODES.originForbidden, 'Cross-site requests are refused', { origin })
  }
}

/** 6. 读 body：超过 1 MiB 立即 413，JSON 解析失败 400。 */
async function readBody(request: IncomingMessage): Promise<unknown> {
  const declared = request.headers['content-length']
  if (declared !== undefined && Number(declared) > MAX_BODY_BYTES) {
    // 声明超限：直接拒绝，不再把这几 MiB 读进内存。先把对端还在写的那部分排空再回响应，
    // 否则客户端会收到 EPIPE 而不是 413（测试也会看到「测试结束后仍有异步活动」）。
    await drain(request)
    throw new ApiError(ERROR_CODES.tooLarge, `The request body exceeds ${MAX_BODY_BYTES} bytes`)
  }
  let size = 0
  const chunks: string[] = []
  await new Promise<void>((resolve, reject) => {
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        // 没声明 Content-Length（chunked）才发现超限：同样先排空再把 413 交回调用点。
        reject(new ApiError(ERROR_CODES.tooLarge, `The request body exceeds ${MAX_BODY_BYTES} bytes`))
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve())
    request.on('error', (error: Error) => reject(error))
  })
  const text = chunks.join('')
  if (text.trim().length === 0) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new ApiError(ERROR_CODES.invalidParams, 'The request body is not JSON')
  }
}

/** 排空一个请求的剩余数据（丢弃），最多等到 `end`/`error`。 */
function drain(request: IncomingMessage): Promise<void> {
  return new Promise<void>((resolve) => {
    request.setEncoding('utf8')
    request.on('data', () => undefined)
    request.on('end', () => resolve())
    request.on('error', () => resolve())
    request.resume()
  })
}

/** 路径（去掉查询串）；不整体解码，避免 `%2F` 改变分段。 */
function pathOnly(url: string): string {
  const index = url.indexOf('?')
  return index < 0 ? url : url.slice(0, index)
}

/** 查询串 → 记录（同名键取最后一个）。 */
function queryOf(url: string): Readonly<Record<string, string>> {
  const index = url.indexOf('?')
  if (index < 0) return {}
  const query: Record<string, string> = {}
  for (const part of url.slice(index + 1).split('&')) {
    if (part.length === 0) continue
    const equals = part.indexOf('=')
    const key = decodeSegment(equals < 0 ? part : part.slice(0, equals))
    query[key] = equals < 0 ? '' : decodeSegment(part.slice(equals + 1))
  }
  return query
}

/** 解码一个查询/路径段；坏转义 → 400。 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    throw new ApiError(ERROR_CODES.invalidParams, 'A path segment has a malformed escape')
  }
}

/** 路由匹配：段数相同且逐段相等（`:name` 段吃任意一段并成为参数）。 */
function matchRoute(
  routes: readonly RouteDefinition[],
  method: string,
  relative: string
): { readonly route: RouteDefinition; readonly params: Readonly<Record<string, string>> } | null {
  const segments = relative.split('/')
  for (const route of routes) {
    if (route.method !== method) continue
    const pattern = route.path.split('/')
    if (pattern.length !== segments.length) continue
    const params: Record<string, string> = {}
    let fits = true
    for (let index = 0; index < pattern.length; index += 1) {
      const part = pattern[index] as string
      const segment = segments[index] as string
      if (part.startsWith(':')) {
        params[part.slice(1)] = decodeSegment(segment)
        continue
      }
      if (part !== segment) {
        fits = false
        break
      }
    }
    if (fits) return { route, params }
  }
  return null
}

/** 端口被占用（只有这种情况才继续试下一个）。 */
function isAddressInUse(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'EADDRINUSE'
}


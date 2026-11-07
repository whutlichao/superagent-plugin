// `superagent read <resource>` 的 HTTP handler（§G.2 的 read 行、§G.3 的视图路由与信封、
// §I.2 的「资源读取」行、§I.3 的五种 Feishu 读法、§O 的角色边界）。CLI 与面板共用同一份
// 实现，路由表只负责方法与最低角色。
//
// 这一层只做三件事：取出参数（路径里的资源名是一整段、百分号编码；`offset`/`limit` 是查询串）、
// 把读面的固定拒绝换成 `ApiError`（状态码由 `errors.ts` 的一张表决定）、返回结果本体。
// 资源名的路由、分页、窗口、角色与状态的语义全部在 `app/read.ts`（Source 资源）与
// `app/views/read.ts`（视图资源）——这里不判业务，也不做第二套查询。
//
// `GET threads/:key` 是唯一需要 handler 再判一次的视图：路由表允许 assignment（worker 要读
// 自己 Ticket 相关的 Thread，§O），于是这里用与 Source 读面同一个归属判定（`mayReadThread`）
// 拒绝别的 Ticket 的 Thread；其余视图的整个面由路由表的最低角色拒绝。
//
// 依赖纪律（§C.2）：本文件在 `http/`，只 import 同目录的 `ApiError`/路由类型与 `app/` 的读面；
// 不读存储、不做 I/O、不 spawn。
import { ApiError, ERROR_CODES } from './errors.ts'
import type { RouteDefinition, RouteHandler, RouteInput } from './routes.ts'
import {
  READ_SOURCE_RESOURCES,
  type ReadRefusal,
  type ReadResult,
  type ReadTools,
  type ReadView
} from '../app/read.ts'
import type { ViewReadTools } from '../app/views/read.ts'

/** handler 的接线：Source 读面与视图读面（组合根注入各自的产物；测试用替身或真库）。 */
export interface ReadHandlerOptions {
  readonly tools: ReadTools
  readonly views: ViewReadTools
}

/** 一个查询参数：缺省或空串都是「没给」。 */
function queryText(query: Readonly<Record<string, string>>, key: string): string | undefined {
  const value = query[key]
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * 一个非负整数查询参数（`--offset` / `--limit`）。形状不对是 `invalid_value`：分页的上限
 * 由资源名的形状决定（列表页 ≤ 50、文本页 ≤ 8000），那一条由 `app/read.ts` 判。
 */
function countParam(query: Readonly<Record<string, string>>, key: string): number | undefined {
  const text = queryText(query, key)
  if (text === undefined) return undefined
  const parsed = Number(text)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ApiError(ERROR_CODES.invalidValue, `${key} must be a non-negative integer`, {
      flag: key,
      value: text
    })
  }
  return parsed
}

/** 路径里的资源名：空段是参数错误，不是 `missing`。 */
function resourceOf(input: RouteInput): string {
  const resource = (input.params['resource'] ?? '').trim()
  if (resource.length === 0) {
    throw new ApiError(ERROR_CODES.unknownResource, 'read needs a resource name', {
      forms: READ_SOURCE_RESOURCES.join(', ')
    })
  }
  return resource
}

/** 视图读面的固定拒绝 → `ApiError`（码族决定状态码，§G.3 第 8 条）。 */
function accepted<T>(result: T | ReadRefusal): T {
  if (typeof result === 'object' && result !== null && (result as { readonly ok?: unknown }).ok === false) {
    const refusal = result as ReadRefusal
    throw new ApiError(refusal.code, refusal.message, refusal.values)
  }
  return result as T
}

/** Source 读面的结局 → `ReadView`（失败抛 `ApiError`）。 */
function readViewOf(result: ReadResult): ReadView {
  if (!result.ok) throw new ApiError(result.code, result.message, result.values)
  return result.result
}

/**
 * 组装 `read <resource>` 的 handler。返回 `{method path → handler}` 的表，由组合根叠加到
 * 路由表上（与 `withEvalHandlers` 同一模式：替换 handler，不改名字与角色）。
 *
 * Source 资源走 `read/:resource`（资源名一整段）；§G.3 的视图资源各走自己的路由——两边都是
 * 同一份读面实现，CLI 只把 `read <resource>` 映射到对应路由（`cli/commands.ts` 的 `readPath`）。
 */
export function createReadHandlers(options: ReadHandlerOptions): ReadonlyMap<string, RouteHandler> {
  const handlers = new Map<string, RouteHandler>()

  handlers.set('GET read/:resource', async (input) => {
    const offset = countParam(input.query, 'offset')
    const limit = countParam(input.query, 'limit')
    const result = await options.tools.read({
      resource: resourceOf(input),
      role: input.caller.role,
      ...(input.caller.ticketId === undefined ? {} : { ticketId: input.caller.ticketId }),
      ...(offset === undefined ? {} : { offset }),
      ...(limit === undefined ? {} : { limit })
    })
    // 固定拒绝原样落成信封里的 `error.code`；状态码由码族决定（§G.3 第 8 条）。
    return readViewOf(result)
  })

  // ---- 视图资源（§G.3 的 GET overview/sources/search/threads/decisions/models）
  handlers.set('GET overview', () => options.views.overview())

  handlers.set('GET sources', () => options.views.sources())

  handlers.set('GET search', ({ query }) => {
    const limit = countParam(query, 'limit')
    return accepted(
      options.views.search({
        query: queryText(query, 'q') ?? '',
        ...(limit === undefined ? {} : { limit })
      })
    )
  })

  handlers.set('GET threads', ({ query }) => {
    const filter = queryText(query, 'filter')
    const offset = countParam(query, 'offset')
    const limit = countParam(query, 'limit')
    return accepted(
      options.views.threads({
        ...(filter === undefined ? {} : { filter }),
        ...(offset === undefined ? {} : { offset }),
        ...(limit === undefined ? {} : { limit })
      })
    )
  })

  handlers.set('GET threads/:key', (input) => {
    const key = (input.params['key'] ?? '').trim()
    // assignment 只读自己 Ticket 相关的 Thread（§O）；§G.1 的角色是状态，不是空结果。
    if (input.caller.role === 'assignment') {
      const ticketId = input.caller.ticketId
      if (ticketId === undefined || !options.views.mayReadThread(ticketId, key)) {
        throw new ApiError(
          ERROR_CODES.notPermittedRole,
          'An assignment token may only read the threads of its own ticket',
          { thread: key }
        )
      }
    }
    const before = queryText(input.query, 'before')
    const around = queryText(input.query, 'around')
    const limit = countParam(input.query, 'limit')
    return accepted(
      options.views.thread(key, {
        ...(before === undefined ? {} : { before }),
        ...(around === undefined ? {} : { around }),
        ...(limit === undefined ? {} : { limit })
      })
    )
  })

  handlers.set('GET decisions', ({ query }) => {
    const kind = queryText(query, 'kind')
    const window = queryText(query, 'window')
    const offset = countParam(query, 'offset')
    const limit = countParam(query, 'limit')
    return accepted(
      options.views.decisions({
        ...(kind === undefined ? {} : { kind }),
        ...(window === undefined ? {} : { window }),
        ...(offset === undefined ? {} : { offset }),
        ...(limit === undefined ? {} : { limit })
      })
    )
  })

  handlers.set('GET models', () => options.views.models())

  return handlers
}

/** 把这几条 handler 叠加到路由表上（替换 handler，不改名字与角色）。 */
export function withReadHandlers(
  routes: readonly RouteDefinition[],
  handlers: ReadonlyMap<string, RouteHandler>
): readonly RouteDefinition[] {
  return routes.map((route) => {
    const handler = handlers.get(`${route.method} ${route.path}`)
    return handler === undefined ? route : { ...route, handler }
  })
}

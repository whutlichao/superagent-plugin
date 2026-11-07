// `superagent read <resource>` 的 HTTP handler（§G.2 的 read 行、§I.2 的「资源读取」行、§I.3 的
// 五种 Feishu 读法、§G.3 的信封）。CLI 与面板共用同一份实现，路由表只负责方法与角色。
//
// 这一层只做三件事：取出参数（路径里的资源名是一整段、百分号编码；`offset`/`limit` 是查询串）、
// 把读面的固定拒绝换成 `ApiError`（状态码由 `errors.ts` 的一张表决定）、返回结果本体。
// 资源名的路由、分页、角色与状态的语义全部在 `app/read.ts`——这里不判业务。
//
// 依赖纪律（§C.2）：本文件在 `http/`，只 import 同目录的 `ApiError` 与 `app/read.ts` 的类型；
// 不读存储、不做 I/O、不 spawn。
import { ApiError, ERROR_CODES } from './errors.ts'
import type { RouteDefinition, RouteHandler, RouteInput } from './routes.ts'
import { READ_SOURCE_RESOURCES, type ReadTools } from '../app/read.ts'

/** handler 的接线：读面本身（组合根注入 `createReadTools` 的产物）。 */
export interface ReadHandlerOptions {
  readonly tools: ReadTools
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

/**
 * 组装 `read <resource>` 的 handler。返回 `{method path → handler}` 的表，由组合根叠加到
 * 路由表上（与 `withEvalHandlers` 同一模式：替换 handler，不改名字与角色）。
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
    if (!result.ok) throw new ApiError(result.code, result.message, result.values)
    return result.result
  })

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

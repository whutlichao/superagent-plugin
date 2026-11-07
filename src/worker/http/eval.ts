// Router 两条评估读命令的 HTTP handler（§G.2 的 `eval` / `eval-read` 行、§G.3 的信封）。
// CLI 与面板共用同一份实现，路由表只负责方法与角色。
//
// 这一层只做四件事：取出参数（路径参数是 trigger id；`eval-read` 的四种读法是查询串）、
// 把命令服务的固定拒绝换成 `ApiError`（状态码由 `errors.ts` 的一张表决定）、成功后的刷新
// 钩子、以及响应信封的形状。业务判断（窗口、截断、路径包含、读缓存）全部在 `app/eval.ts`。
//
// 依赖纪律（§C.2）：本文件在 `http/`，只 import 同目录的 `ApiError` 与 `app/eval.ts` 的
// 类型与校验器；不读存储、不做 I/O、不 spawn。
import { ApiError, ERROR_CODES } from './errors.ts'
import type { RouteDefinition, RouteHandler, RouteInput } from './routes.ts'
import { EVAL_READ_PARTS } from './api-types.ts'
import { validateEvalRead, type EvalReadRequest, type EvalTools } from '../app/eval.ts'
import type { ContextPartName } from '../sources/admission-context.ts'

/** handler 的接线：两条读命令 + 写成功后的刷新（这两条是读，钩子留给面板将来用）。 */
export interface EvalHandlerOptions {
  readonly tools: EvalTools
  readonly afterWrite?: () => void
}

/** 编译期对齐：`--part` 的取值与 `ContextPartName` 是同一组三个词。 */
const PARTS: readonly ContextPartName[] = EVAL_READ_PARTS

/** 一个查询参数：缺省或空串都是「没给」。 */
function queryText(query: Readonly<Record<string, string>>, key: string): string | undefined {
  const value = query[key]
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** 把一条固定拒绝换成 `ApiError`（状态码由错误码族决定，调用点不自己挑）。 */
function refuse(refusal: { code: string; message: string; values?: Readonly<Record<string, string>> }): never {
  throw new ApiError(refusal.code, refusal.message, refusal.values)
}

/** 查询串 → 一次读的四种形式（恰好一种；`--cursor` 只属于 `--part thread`）。 */
export function evalReadRequest(input: Pick<RouteInput, 'query'>): EvalReadRequest {
  const part = queryText(input.query, 'part')
  if (part !== undefined && !PARTS.includes(part as ContextPartName)) {
    throw new ApiError(
      ERROR_CODES.invalidValue,
      `part must be one of: ${PARTS.join(', ')}`,
      { flag: 'part', choices: PARTS.join(',') }
    )
  }
  const request: EvalReadRequest = {
    ...(queryText(input.query, 'message-id') === undefined
      ? {}
      : { messageId: queryText(input.query, 'message-id') as string }),
    ...(queryText(input.query, 'image-id') === undefined
      ? {}
      : { imageId: queryText(input.query, 'image-id') as string }),
    ...(part === undefined ? {} : { part: part as ContextPartName }),
    ...(queryText(input.query, 'cursor') === undefined
      ? {}
      : { cursor: queryText(input.query, 'cursor') as string }),
    ...(queryText(input.query, 'path') === undefined ? {} : { path: queryText(input.query, 'path') as string })
  }
  const invalid = validateEvalRead(request)
  if (invalid !== undefined) refuse(invalid)
  return request
}

/** 路径参数里的 trigger id（空段是参数错误，不是 `missing`）。 */
function triggerId(input: RouteInput, command: string): string {
  const id = (input.params['id'] ?? '').trim()
  if (id.length === 0) {
    throw new ApiError(ERROR_CODES.invalidParams, `${command} needs a trigger id`, { field: 'id' })
  }
  return id
}

/**
 * 组装两条命令的 handler。返回 `{method path → handler}` 的表，由组合根叠加到路由表上
 * （与 `withAssessmentHandlers` 同一模式：替换 handler，不改名字与角色）。
 */
export function createEvalHandlers(options: EvalHandlerOptions): ReadonlyMap<string, RouteHandler> {
  const handlers = new Map<string, RouteHandler>()

  // ---- eval：路径参数是 trigger id，返回候选窗口（§G.2 的七个字段）。
  handlers.set('GET eval/:id', async (input) => {
    const result = await options.tools.window(triggerId(input, 'eval'))
    if (!result.ok) refuse(result)
    options.afterWrite?.()
    return result.window
  })

  // ---- eval-read：路径参数是 trigger id，查询串是四种读法之一。
  handlers.set('GET eval-read/:id', async (input) => {
    const request = evalReadRequest(input)
    const result = await options.tools.read(triggerId(input, 'eval-read'), request)
    if (!result.ok) refuse(result)
    options.afterWrite?.()
    return result.result
  })

  return handlers
}

/** 把这两条 handler 叠加到路由表上（替换 handler，不改名字与角色）。 */
export function withEvalHandlers(
  routes: readonly RouteDefinition[],
  handlers: ReadonlyMap<string, RouteHandler>
): readonly RouteDefinition[] {
  return routes.map((route) => {
    const handler = handlers.get(`${route.method} ${route.path}`)
    return handler === undefined ? route : { ...route, handler }
  })
}

// Router 两条命令的 HTTP handler（§G.2 的 `route` / `eval-decide` 行、§G.3 的信封与状态码）：
// CLI 与面板共用同一份实现，路由表只负责方法与角色。
//
// 这一层只做四件事：取参数（路径参数、body 的 `decisions` / `assessment`）、把命令服务的固定
// 拒绝换成 `ApiError`（状态码由 `errors.ts` 的一张表决定）、成功后的刷新钩子、以及给响应信封
// 的形状。业务判断全部在 `app/assessment.ts`。
//
// 依赖纪律（§C.2）：本文件在 `http/`，只 import 同目录的 `ApiError`/`values.ts` 与
// `app/assessment.ts` 的类型；不读存储、不做 I/O、不 spawn。
import { ApiError, ERROR_CODES } from './errors.ts'
import { bodyObject } from './values.ts'
import type { RouteDefinition, RouteHandler } from './routes.ts'
import type { RouterTools } from '../app/assessment.ts'

/** handler 的接线：命令服务 + 写成功后的刷新（面板 `state.changed`）。 */
export interface AssessmentHandlerOptions {
  readonly tools: Pick<RouterTools, 'decide' | 'route'>
  readonly afterWrite?: () => void
}

/** 把一条固定拒绝换成 `ApiError`（状态码由错误码族决定，调用点不自己挑）。 */
function refuse(refusal: { code: string; message: string; values?: Readonly<Record<string, string>> }): never {
  throw new ApiError(refusal.code, refusal.message, refusal.values)
}

/**
 * 组装两条命令的 handler。返回 `{method path → handler}` 的表，由组合根叠加到路由表上
 * （与 `withDomainHandlers` 同一模式）。
 */
export function createAssessmentHandlers(
  options: AssessmentHandlerOptions
): ReadonlyMap<string, RouteHandler> {
  const handlers = new Map<string, RouteHandler>()

  // ---- route：body `{decisions: [...]}`，1–20 条，逐条独立。
  handlers.set('POST route', ({ body }) => {
    const decisions = bodyObject(body)['decisions']
    const result = options.tools.route(decisions)
    if (!result.ok) refuse(result)
    options.afterWrite?.()
    return { results: result.results }
  })

  // ---- eval-decide：路径参数是 trigger id，body `{assessment: {...}}`。
  handlers.set('POST eval-decide/:id', ({ params, body }) => {
    const triggerId = params['id'] ?? ''
    if (triggerId.length === 0) {
      throw new ApiError(ERROR_CODES.invalidParams, 'eval-decide needs a trigger id', { field: 'id' })
    }
    const assessment = bodyObject(body)['assessment']
    if (assessment === undefined) {
      throw new ApiError(ERROR_CODES.invalidParams, 'eval-decide needs an assessment', {
        field: 'assessment'
      })
    }
    const result = options.tools.decide(triggerId, assessment)
    if (!result.ok) refuse(result)
    options.afterWrite?.()
    return {
      decision: result.decision,
      reason: result.reason,
      ...(result.ticket === undefined ? {} : { ticket: result.ticket })
    }
  })

  return handlers
}

/** 把这两条 handler 叠加到路由表上（替换 handler，不改名字与角色）。 */
export function withAssessmentHandlers(
  routes: readonly RouteDefinition[],
  handlers: ReadonlyMap<string, RouteHandler>
): readonly RouteDefinition[] {
  return routes.map((route) => {
    const handler = handlers.get(`${route.method} ${route.path}`)
    return handler === undefined ? route : { ...route, handler }
  })
}

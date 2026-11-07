// 面板专属动作的 HTTP handler（§G.2 的 `read decisions --dismiss` 行、§G.3 的信封与状态码）：
// 只有 unavailable 的 Decision 可以被 dismiss（§K.7）——dismiss 对该决定永久有效，且不建
// Ticket。这是一条写命令，因此要求显式请求头与 operator 角色（路由表里已声明）。
//
// 这一层只做三件事：取路径参数、把领域命令的固定拒绝换成 `ApiError`，以及给响应信封的形状。
// 业务判断全部在 `core/evals.ts` 的 `Evals.dismiss`（经注入的 `Engine.dismiss`）；
// 拒绝（Decision 不存在、或不是 unavailable）由 `UserError('unknownProblem')` 变成固定的
// `missing`，与其它引用未知状态的命令同一条规则（`errors.ts` 的 `toApiError`）。
//
// 依赖纪律（§C.2）：本文件在 `http/`，只 import 同目录的 `ApiError`、`routes.ts` 的类型与
// core 的 Decision 类型；不读存储、不做 I/O、不 spawn。
import { ApiError, ERROR_CODES } from './errors.ts'
import type { RouteDefinition, RouteHandler } from './routes.ts'
import type { Decision } from '../core/model.ts'

/** handler 的接线：领域命令 + 写成功后的刷新（面板 `state.changed` 与状态栏）。 */
export interface DecisionHandlerOptions {
  /** `Engine.dismiss`：把一条 unavailable Decision 标为已 dismiss。 */
  readonly dismiss: (decisionId: string) => Decision
  readonly afterWrite?: () => void
}

/** dismiss 成功后回给调用方的那一份（够面板把行标掉，不重复 Decision 的全部内容）。 */
export interface DismissedDecision {
  readonly id: string
  readonly kind: Decision['kind']
  readonly thread_key: string
  readonly at: string
  readonly dismissed: boolean
}

/**
 * 组装面板动作的 handler。返回 `{method path → handler}` 的表，由组合根叠加到路由表上
 * （与 `withAssessmentHandlers` / `withDomainHandlers` 同一模式）。
 */
export function createDecisionHandlers(
  options: DecisionHandlerOptions
): ReadonlyMap<string, RouteHandler> {
  const handlers = new Map<string, RouteHandler>()

  // ---- dismiss：路径参数是 Decision id；成功回最小的一份，拒绝由领域抛 UserError。
  handlers.set('POST decisions/:id/dismiss', ({ params }) => {
    const decisionId = params['id'] ?? ''
    if (decisionId.length === 0) {
      throw new ApiError(ERROR_CODES.invalidParams, 'dismiss needs a decision id', { field: 'id' })
    }
    const decision = options.dismiss(decisionId)
    options.afterWrite?.()
    const dismissed: DismissedDecision = {
      id: decision.id,
      kind: decision.kind,
      thread_key: decision.threadKey,
      at: decision.at,
      dismissed: decision.dismissed === true
    }
    return { decision: dismissed }
  })

  return handlers
}

/** 把这批 handler 叠加到路由表上（替换 handler，不改名字与角色）。 */
export function withDecisionHandlers(
  routes: readonly RouteDefinition[],
  handlers: ReadonlyMap<string, RouteHandler>
): readonly RouteDefinition[] {
  return routes.map((route) => {
    const handler = handlers.get(`${route.method} ${route.path}`)
    return handler === undefined ? route : { ...route, handler }
  })
}

// 鉴权层（§G.1 角色行、§G.3 第 3 条、§O 鉴权）：把「Bearer token → 调用者」与
// 「角色是否够」收敛到一处。
//
// 三种角色由 `infra/tokens.ts` 签发与吊销（文件 0600、库内只存哈希）；本模块只做请求侧：
// 1. 只认 `Authorization: Bearer <token>`（不认 cookie、不认查询串）；
// 2. 交给 `verifyToken` 判定有效性与绑定（assignment 的 ticketId / assignmentId / 过期）；
// 3. 按路由声明的最低角色判阶梯；不足 → `not_permitted_role`（403）。
import { ApiError, ERROR_CODES } from './errors.ts'
import { allowsRole, type RouteCaller, type RouteDefinition } from './routes.ts'
import { verifyToken } from '../infra/tokens.ts'
import type { Store } from '../app/store.ts'

/**
 * 从 `Authorization` 头里取 Bearer token；方案名大小写不敏感（RFC 6750），
 * 缺失或不是 Bearer 都返回 `null`（调用点报 401 `unauthorized`）。
 */
export function bearerToken(authorization: string | undefined): string | null {
  if (authorization === undefined) return null
  const match = /^Bearer[ ]+(\S+)$/i.exec(authorization.trim())
  return match === null ? null : (match[1] as string)
}

/** 校验一次请求的 token；无效/过期 → 401。 */
export function authenticate(options: {
  readonly store: Store
  readonly stateDir: string
  readonly authorization: string | undefined
  readonly now: () => Date
}): { readonly caller: RouteCaller; readonly token: string } {
  const token = bearerToken(options.authorization)
  if (token === null) {
    throw new ApiError(ERROR_CODES.unauthorized, 'A bearer token is required')
  }
  const caller = verifyToken({ store: options.store, stateDir: options.stateDir, token, now: options.now })
  if (caller === null) {
    throw new ApiError(ERROR_CODES.unauthorized, 'The bearer token is not valid')
  }
  return { caller, token }
}

/**
 * 角色判定：按 `ROLE_RANK` 的阶梯比 `route.minimumRole`。不足 → 403 `not_permitted_role`，
 * `values` 里带角色与命令名（固定值，不含 token）。
 */
export function authorize(route: RouteDefinition, caller: RouteCaller): void {
  if (allowsRole(route, caller.role)) return
  throw new ApiError(
    ERROR_CODES.notPermittedRole,
    `A ${caller.role} token may not run ${route.command}`,
    { role: caller.role, command: route.command, minimum_role: route.minimumRole }
  )
}

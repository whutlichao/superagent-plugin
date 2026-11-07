// 命令面 handler 的 body 读取（§G.3、§K.8）：**每个** handler 都从这一份拿对象，别再各写一遍。
//
// 唯一的判断是铸进固定码的边界：请求 body 必须是 JSON 对象。数组与 `null` 都不是对象——
// 一个数组 body 里取字段永远取不到，早一点按 `invalid_params`（400）拒绝，比后面报一个
// 「缺字段」更接近事实。
import { ApiError, ERROR_CODES } from './errors.ts'

/** 一个 body 对象；不是对象就按 `invalid_params` 拒绝。 */
export function bodyObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError(ERROR_CODES.invalidParams, 'The request body must be a JSON object')
  }
  return body as Record<string, unknown>
}

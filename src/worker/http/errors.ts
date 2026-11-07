// 固定错误码与状态码映射（§G.1 的统一信封、§G.3 第 8 条）。
//
// 规则（§G.3 第 8 条逐字）：`invalid_*` / `refused` / `stale_revision` / `too_long` → 400；
// `missing` → 404；`not_permitted_role` / `origin_forbidden` → 403；`conflict` → 409；
// `unavailable` → 503；其余 500。边界本身还需要三个码，它们同表登记：
// - `unauthorized`（缺 token / token 无效，第 3 条）→ 401；
// - `too_large`（body 超 1 MiB，第 6 条）→ 413；
// - `rate_limited`（第 7 条）→ 429。
//
// 响应体恒为 `{ok:false, error:{code, message, values?}}`；`values` 只给填槽值，不给内部细节。
import { UserError } from '../core/errors.ts'

/** 命令与边界共用的固定错误码（面板按 `error.code` 翻译，不解析 message）。 */
export const ERROR_CODES = {
  /** 参数形状不对（缺字段、类型错、JSON 解析失败）。 */
  invalidParams: 'invalid_params',
  /** 参数内容不合法（越界、未知枚举）。 */
  invalidValue: 'invalid_value',
  /** 评估载荷不是文档里的形状（§G.2 的 eval-decide）。 */
  invalidAssessment: 'invalid_assessment',
  /** 评估没有把每条启用规则恰好判定一次（§K.4 第 1 条）。 */
  incompleteRules: 'incomplete_rules',
  /** 评估期间 Policy 变了：按新版本重评，不写 Decision（§K.5）。 */
  policyChanged: 'policy_changed',
  /** 评估所指的 Eval 已结束：决定来晚了，不写 Decision（§K.7）。 */
  tooLate: 'too_late',
  /** `route` 一次超过 20 条（§G.1 限额行）。 */
  tooManyItems: 'too_many_items',
  /** 固定拒绝：调用方不该重试。 */
  refused: 'refused',
  /** 设置/prompt 的 base revision 已过期。 */
  staleRevision: 'stale_revision',
  /** 文本超过命令上限（100 词、600 字符等）。 */
  tooLong: 'too_long',
  /** 缺 token 或 token 无效（§G.3 第 3 条）。 */
  unauthorized: 'unauthorized',
  /** 角色不够（§G.1 角色表）。 */
  notPermittedRole: 'not_permitted_role',
  /** Host / Origin / 显式请求头不合法（§G.3 第 2、4、5 条）。 */
  originForbidden: 'origin_forbidden',
  /** 目标不存在，或路径没有对应的操作。 */
  missing: 'missing',
  /** 并发冲突（同名资源已存在等）。 */
  conflict: 'conflict',
  /** body 超过 1 MiB（§G.3 第 6 条）。 */
  tooLarge: 'too_large',
  /** 超出 60/min + burst 20（§G.3 第 7 条）。 */
  rateLimited: 'rate_limited',
  /** 未就绪（暂停、setup 未完成、handler 尚未落地）。 */
  unavailable: 'unavailable',
  /** 其余一切：不把内部细节回给调用方。 */
  internal: 'internal'
} as const

/** 一个固定错误码。 */
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

/** 错误信封里的 `error` 段（§G.1）。 */
export interface ErrorPayload {
  readonly code: string
  readonly message: string
  readonly values?: Readonly<Record<string, string>>
}

/** 响应信封（§G.1）：成功 `{ok:true, result}`，失败 `{ok:false, error}`。 */
export type ApiEnvelope =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: ErrorPayload }

/** 错误码 → HTTP 状态码（§G.3 第 8 条 + 三条边界码）。未知码一律 500。 */
export function statusForErrorCode(code: string): number {
  if (code.startsWith('invalid_')) return 400
  switch (code) {
    case ERROR_CODES.refused:
    case ERROR_CODES.staleRevision:
    case ERROR_CODES.tooLong:
    case ERROR_CODES.incompleteRules:
    case ERROR_CODES.policyChanged:
    case ERROR_CODES.tooLate:
    case ERROR_CODES.tooManyItems:
      return 400
    case ERROR_CODES.unauthorized:
      return 401
    case ERROR_CODES.notPermittedRole:
    case ERROR_CODES.originForbidden:
      return 403
    case ERROR_CODES.missing:
      return 404
    case ERROR_CODES.conflict:
      return 409
    case ERROR_CODES.tooLarge:
      return 413
    case ERROR_CODES.rateLimited:
      return 429
    case ERROR_CODES.unavailable:
      return 503
    default:
      return 500
  }
}

/**
 * 一次请求的可预期失败：`code` 是给面板/CLI 的固定码，`message` 是给人看的一句话，
 * `values` 只放填槽值。状态码由码推出，调用点不自己挑。
 */
export class ApiError extends Error {
  readonly code: string
  readonly values?: Readonly<Record<string, string>>

  constructor(code: string, message: string, values?: Readonly<Record<string, string>>) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    if (values !== undefined) this.values = values
  }

  /** 这个错误在 HTTP 上的状态码。 */
  get status(): number {
    return statusForErrorCode(this.code)
  }

  /** 信封里的 `error` 段。 */
  toJSON(): ErrorPayload {
    return this.values === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, values: this.values }
  }
}

/**
 * 把任意抛出物收敛成 `ApiError`。
 * - `ApiError` 原样通过；
 * - core 的 `UserError` 按 `missing` 落 `missing`/`refused`，填槽值保留；
 * - 其余（含宿主/驱动错误）变成固定的 `internal`，**不回显原文**——原文可能带路径、SQL 或 secret。
 */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  if (error instanceof UserError) {
    return new ApiError(
      error.missing ? ERROR_CODES.missing : ERROR_CODES.refused,
      error.message,
      error.values
    )
  }
  return new ApiError(ERROR_CODES.internal, 'Internal error')
}

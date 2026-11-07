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
  /** `ticket list --state` 的未知筛选值（§G.2 的 `ticket list` 行）。 */
  invalidState: 'invalid_state',
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
  /** 文本超过命令上限（100 词、600 字符等；也是 §L.6 提示词体量上限的固定码）。 */
  tooLong: 'too_long',
  /**
   * 团队技能用了内置技能的名字（§L.6）：内置技能是保留名、只读，不能被替换或删除。
   * 字符集与长度不合格走 `invalid_skill_name`（`invalid_*` 前缀已按 400 处理）。
   */
  reservedSkillName: 'reserved_skill_name',
  /** 缺 token 或 token 无效（§G.3 第 3 条）。 */
  unauthorized: 'unauthorized',
  /** 角色不够（§G.1 角色表）。 */
  notPermittedRole: 'not_permitted_role',
  /** Host / Origin / 显式请求头不合法（§G.3 第 2、4、5 条）。 */
  originForbidden: 'origin_forbidden',
  /** 目标不存在，或路径没有对应的操作。 */
  missing: 'missing',
  /**
   * 命令级的固定拒绝（§G.2 各命令行的「主要错误码」）。它们与 `refused` 同为 400：语义由该
   * 命令决定，面板与 CLI 能按码区分，不必解析文案。`not_owned`/`already_handed_back` 属于
   * `trigger handback`（Trigger 没到达这个 worker / 这张 Ticket 已交回过它）。
   */
  notOwned: 'not_owned',
  alreadyHandedBack: 'already_handed_back',
  /**
   * `ticket stop` / `ticket retry` 的固定拒绝（§G.2）：停止只能对未结束的 Ticket 发起，
   * 重试只对卡在 failed/blocked（或投递失败）的 Ticket 成立。
   */
  alreadyEnded: 'already_ended',
  notRetryable: 'not_retryable',
  /**
   * `trigger requeue` 的固定拒绝（§G.2）：执行器仍拥有这条人的消息，重排会绕过它的 worker。
   */
  notRequeueable: 'not_requeueable',
  /**
   * `thread follow` / `thread unrelated` 的固定拒绝（§G.2）：这是该 Ticket 自己的 Thread
   * （它的来源 Thread、PR Thread 或 Source 跟随的 Thread），不能当语境跟随、也不能标为无关。
   */
  ownThread: 'own_thread',
  /** `thread unrelated` 的固定拒绝（§G.2）：该 Ticket 没有跟随这个 Thread。 */
  notFollowed: 'not_followed',
  /**
   * `thread follow` 的固定拒绝（§G.2）：该 Ticket 仍**决定**这个 Thread 上的消息（它是被
   * attach 的订阅者），要跟随它的语境就得先用 `thread unrelated` 声明无关。
   */
  unrelatedRequired: 'unrelated_required',
  /** `policy sync <source>` 的固定拒绝（§G.2）：这个 Source 现在不能同步名单。 */
  notSyncable: 'not_syncable',
  /** `policy sync <source>` 的固定拒绝（§G.2）：一次同步读取/保存失败。 */
  syncFailed: 'sync_failed',
  /**
   * `settings save` 的固定拒绝（§K.8）：账号类字段（`cli`、`repository`）的写前 setup 检查
   * 不通过——值没有写进库，`issues[]` 说清缺什么。
   */
  setupFailed: 'setup_failed',
  /** 并发冲突（同名资源已存在等）。 */
  conflict: 'conflict',
  /**
   * `report --pr-number` 的固定拒绝（§G.2 的 `report` 行）：这条 PR 不属于本 Ticket（不是它的
   * 来源 PR，也不是 agent 从它的分支开的），或已经属于另一个活 Ticket。
   */
  prMismatch: 'pr_mismatch',
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

/** 一条字段级校验问题（§K.8 的 `{path,message}`；`path` 是点号分隔的字段路径）。 */
export interface ErrorIssue {
  readonly path: string
  readonly message: string
}

/** 错误信封里的 `error` 段（§G.1）。 */
export interface ErrorPayload {
  readonly code: string
  readonly message: string
  readonly values?: Readonly<Record<string, string>>
  /**
   * 字段级问题（§K.8：「错误以 `{issues:[{path,message}]}` 返回（400）」）。只有需要人改
   * 具体字段的拒绝带它：`settings save` 的 `invalid_value` 与 `setup_failed`。
   */
  readonly issues?: readonly ErrorIssue[]
}

/** 响应信封（§G.1）：成功 `{ok:true, result}`，失败 `{ok:false, error}`。 */
export type ApiEnvelope =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: ErrorPayload }

/**
 * 核心的用户可见码 → 命令在 §G.2 里写明的固定码（只映有分行的那几条）：领域语义不变，
 * 信封里落成调用方（面板与 agent）按码处理的那个名字。目前是 `trigger handback`、
 * `ticket retry` 与 `thread follow` / `thread unrelated`。
 */
export const COMMAND_ERROR_CODES: Readonly<Record<string, string>> = {
  notReached: ERROR_CODES.notOwned,
  handedBack: ERROR_CODES.alreadyHandedBack,
  notRetryable: ERROR_CODES.notRetryable,
  // `thread follow` / `thread unrelated`（§G.2）：核心只说「这是它自己的 Thread」与
  // 「它没跟随」，信封里落成那两条命令写明的两个码。
  sourceThread: ERROR_CODES.ownThread,
  followedThread: ERROR_CODES.ownThread,
  notFollowing: ERROR_CODES.notFollowed
}

/** 错误码 → HTTP 状态码（§G.3 第 8 条 + 三条边界码）。未知码一律 500。 */
export function statusForErrorCode(code: string): number {
  if (code.startsWith('invalid_')) return 400
  switch (code) {
    case ERROR_CODES.refused:
    case ERROR_CODES.staleRevision:
    case ERROR_CODES.tooLong:
    case ERROR_CODES.tooManyItems:
    case ERROR_CODES.incompleteRules:
    case ERROR_CODES.policyChanged:
    case ERROR_CODES.tooLate:
    // 命令级的固定拒绝（§G.2）：`trigger handback` 的 `not_owned`/`already_handed_back`、
    // `ticket stop` 的 `already_ended` 与 `ticket retry` 的 `not_retryable`。
    case ERROR_CODES.notOwned:
    case ERROR_CODES.alreadyHandedBack:
    case ERROR_CODES.alreadyEnded:
    case ERROR_CODES.notRetryable:
    // `report --pr-number` 的 `pr_mismatch`：PR 不属于本 Ticket（§I.2 的「PR 规则」行）。
    case ERROR_CODES.prMismatch:
    // 本票接线的命令级固定拒绝（§G.2 的 trigger requeue / thread * / policy sync / settings save）。
    case ERROR_CODES.notRequeueable:
    case ERROR_CODES.ownThread:
    case ERROR_CODES.notFollowed:
    case ERROR_CODES.unrelatedRequired:
    case ERROR_CODES.notSyncable:
    case ERROR_CODES.syncFailed:
    case ERROR_CODES.setupFailed:
    case ERROR_CODES.reservedSkillName:
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
  readonly issues?: readonly ErrorIssue[]

  constructor(
    code: string,
    message: string,
    values?: Readonly<Record<string, string>>,
    issues?: readonly ErrorIssue[]
  ) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    if (values !== undefined) this.values = values
    if (issues !== undefined && issues.length > 0) this.issues = issues
  }

  /** 这个错误在 HTTP 上的状态码。 */
  get status(): number {
    return statusForErrorCode(this.code)
  }

  /** 信封里的 `error` 段。 */
  toJSON(): ErrorPayload {
    return {
      code: this.code,
      message: this.message,
      ...(this.values === undefined ? {} : { values: this.values }),
      ...(this.issues === undefined ? {} : { issues: this.issues })
    }
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
      COMMAND_ERROR_CODES[error.code] ?? (error.missing ? ERROR_CODES.missing : ERROR_CODES.refused),
      error.message,
      error.values
    )
  }
  return new ApiError(ERROR_CODES.internal, 'Internal error')
}

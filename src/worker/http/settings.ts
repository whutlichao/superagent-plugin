// 设置与名单同步的 HTTP handler（§G.2 的 `settings get` / `settings save` / `policy sync`、
// §G.3 的 `GET settings` / `PUT settings/:block` / `GET policy/history` / `POST policy-sync/:id`、
// §K.8）：CLI 与面板共用同一份实现，路由表只负责方法与角色。
//
// 四件事只在这里发生一次：
// - **写前校验**：块的 strict schema 在写库之前跑完（全有或全无），失败返回 400 + `issues[]`；
// - **账号类字段的 setup 检查**（#44）：`cli` / `repository` 在写之前先按候选值跑一遍探针，
//   不通过就 400 且**什么都不写**（§K.8 的原话）；
// - **冲突与来源**：基础版本号过期 → `stale_revision`；`tool` 改 setup 字段 → `origin_forbidden`；
// - **名单同步**走 #23 的驱动器（`BootHandle.syncPolicy`）：`sync:<id>` 健康条目与 origin=sync
//   的记账都由驱动器负责，本文件只做参数、拒绝码与 `{policy, allowed, added, removed}` 的读数。
//
// 依赖纪律（§C.2）：本文件在 `http/`，只 import `app/`（settings、settings-blocks、setup 的
// 类型）、同目录的 `ApiError` 与 `api-types`；不读存储、不跑子进程——账号探针与同步驱动器
// 都由组合根以端口注入，缺哪个端口该路由就固定 `unavailable`。
import { ApiError, ERROR_CODES, type ErrorIssue } from './errors.ts'
import type { RouteDefinition, RouteHandler } from './routes.ts'
import type { WriteIdempotency } from './domain.ts'
import {
  accountCandidatesIn,
  RESTART_SETUP_FIELDS,
  validateSettingsBlock,
  type BlockValidator,
  type ParsedBlock
} from '../app/settings-blocks.ts'
import { parseSettingsBlock } from '../app/settings-blocks.ts'
import { SettingsError, type Settings } from '../app/settings.ts'
import type { AccountCandidates } from '../app/settings-blocks.ts'
import type { SetupIssue } from '../app/setup-types.ts'
import {
  SETTINGS_HISTORY_LIMIT,
  type PolicySyncResult,
  type SettingsBlockView,
  type SettingsHistoryResult,
  type SettingsResult,
  type SettingsSaveView,
  type SettingsVersionView
} from './api-types.ts'

/** 四个设置来源（§K.8）；CLI 恒为 `tool`，面板给 `panel`。 */
export const SETTINGS_ORIGINS = ['panel', 'tool', 'sync', 'operator'] as const

/** 账号类字段的写前 setup 检查（#44 的探针，按候选值跑）。 */
export type AccountCheckPort = (candidate: AccountCandidates) => Promise<readonly SetupIssue[]>

/**
 * 名单同步的端口（#23 的驱动器）：`sync` 就是 `BootHandle.syncPolicy`，健康条目与
 * `origin: 'sync'` 的保存都在驱动器里，这里只读「同步前后」的两份读数。
 */
export interface PolicySyncPort {
  /** 现在能同步的 Source（驱动器的 `syncable()`）。 */
  syncable(): readonly string[]
  /** 同步一个 Source（手动「立即同步」）；失败时抛错。 */
  sync(id: string): Promise<Record<string, unknown>>
  /** 该 Source 当前的允许名单（同步前：用来算 `added` / `removed`）。 */
  allowed(id: string): readonly unknown[]
  /** 同步之后的 Policy 块读数。 */
  policy(): { readonly revision: number; readonly version: string | null }
}

/** handler 的接线：设置写入器（#20）+ 端口（账号检查 #44、名单同步 #23）。 */
export interface SettingsHandlerOptions {
  readonly settings: Settings
  /**
   * 一个块的 strict 校验器（§K.8），按块名取。缺省用 `validateSettingsBlock` 的固定块形状；
   * 组合根在这里接 Policy 的 schema（含各 Source 的 extras）与各 kind 的 config schema。
   */
  readonly validate?: (block: string) => BlockValidator | undefined
  /** 已知的块名（`settings get` 列全部时用；缺省三个基块）。 */
  readonly blocks?: () => readonly string[]
  /** 某块当前生效的值（没保存过时是运行时那份）。 */
  readonly effective?: (block: string) => unknown
  /** 账号类字段的写前 setup 检查；缺省时账号类字段照常校验后保存（测试与裸服务器）。 */
  readonly checkAccount?: AccountCheckPort
  /** 名单同步驱动器；缺省时 `POST policy-sync/:id` 保持 `unavailable`。 */
  readonly policySync?: PolicySyncPort
  /** 写成功后的刷新钩子（面板 `state.changed`）。 */
  readonly afterWrite?: () => void
  /**
   * 写命令的幂等端口（§G.1 幂等行）：`settings save` 与 `policy sync` 都过它，组合根用真库
   * 实现 `runWrite`；缺省直接执行一次。
   */
  readonly idempotent?: WriteIdempotency
}

/** 一个 body 对象；不是对象就按 `invalid_params` 拒绝。 */
function bodyObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError(ERROR_CODES.invalidParams, 'The request body must be a JSON object')
  }
  return body as Record<string, unknown>
}

/** 一个非负整数 body 字段。 */
function requiredInteger(body: Record<string, unknown>, field: string): number {
  const value = body[field]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ApiError(ERROR_CODES.invalidParams, `${field} must be a non-negative integer`, { field })
  }
  return value
}

/** 校验器的 issues → 信封里的 `issues[]`（`path` 用点号连起来，`(root)` 表示整块）。 */
export function errorIssuesOf(
  issues: readonly { readonly path: readonly (string | number)[]; readonly message: string }[]
): readonly ErrorIssue[] {
  return issues.map((issue) => ({
    path: issue.path.length === 0 ? '(root)' : issue.path.join('.'),
    message: issue.message
  }))
}

/** setup 探针的 issues → 信封里的 `issues[]`（`path` 是探针的固定码，message 是现状）。 */
function setupIssuesOf(issues: readonly SetupIssue[]): readonly ErrorIssue[] {
  return issues.map((issue) => ({ path: issue.code, message: issue.detail }))
}

/** 一个保存被拒（§K.8）→ 固定码 + issues。 */
function apiErrorOf(error: unknown, block: string): never {
  if (error instanceof SettingsError) {
    if (error.code === 'origin_forbidden') {
      throw new ApiError(ERROR_CODES.originForbidden, error.message, { block })
    }
    if (error.code === 'conflict') {
      throw new ApiError(ERROR_CODES.staleRevision, error.message, { block })
    }
    throw new ApiError(ERROR_CODES.invalidValue, error.message, { block }, errorIssuesOf(error.issues))
  }
  throw error
}

/** 一个版本记录 → 读面（`history` 与单个块共用）。 */
function versionView(record: {
  readonly revision: number
  readonly predecessor: number | null
  readonly at: string
  readonly origin: 'panel' | 'tool' | 'sync' | 'operator'
  readonly block: string
  readonly policyVersion: string | null
}): SettingsVersionView {
  return {
    revision: record.revision,
    predecessor: record.predecessor,
    at: record.at,
    origin: record.origin,
    block: record.block,
    policyVersion: record.policyVersion
  }
}

/** 一个块的读数：保存过的值优先，否则是注入的「当前生效值」；修订号是**块**的。 */
function blockView(options: SettingsHandlerOptions, block: ParsedBlock, name: string): SettingsBlockView {
  const saved = options.settings.block(name)
  const value = saved === undefined ? (options.effective?.(name) ?? null) : saved.config
  return {
    block: name,
    revision: options.settings.blockRevision(name),
    value,
    saved: saved === undefined ? null : versionView(saved)
  }
}

/** 名字里点到的块是否存在（`settings get --block` 的 `missing` 判定）。 */
function knownBlock(options: SettingsHandlerOptions, name: string): ParsedBlock {
  const parsed = parseSettingsBlock(name)
  if (parsed === undefined) {
    throw new ApiError(ERROR_CODES.missing, `Unknown settings block: ${name}`, { block: name })
  }
  return parsed
}

/** 保存的来源：面板给 `panel`，CLI 恒为 `tool`；其余值照 §K.8 收下。 */
function originOf(body: Record<string, unknown>): (typeof SETTINGS_ORIGINS)[number] {
  const origin = body['origin'] === undefined ? 'tool' : body['origin']
  if (!(SETTINGS_ORIGINS as readonly unknown[]).includes(origin)) {
    throw new ApiError(ERROR_CODES.invalidValue, `origin must be one of: ${SETTINGS_ORIGINS.join(', ')}`, {
      field: 'origin'
    })
  }
  return origin as (typeof SETTINGS_ORIGINS)[number]
}

/** `added` / `removed`：两份允许名单的 id 差（顺序按新名单）。 */
export function allowListDiff(
  before: readonly unknown[],
  after: readonly unknown[]
): { readonly added: readonly string[]; readonly removed: readonly string[] } {
  const ids = (items: readonly unknown[]): string[] =>
    items.flatMap((item) => {
      const id = typeof item === 'object' && item !== null ? (item as { id?: unknown }).id : item
      return typeof id === 'string' && id.length > 0 ? [id] : []
    })
  const beforeIds = ids(before)
  const afterIds = ids(after)
  return {
    added: afterIds.filter((id) => !beforeIds.includes(id)),
    removed: beforeIds.filter((id) => !afterIds.includes(id))
  }
}

/** 把 handler 的表装进路由表（与 `withDomainHandlers` 同一模式）。 */
export function withSettingsHandlers(
  routes: readonly RouteDefinition[],
  handlers: ReadonlyMap<string, RouteHandler>
): readonly RouteDefinition[] {
  return routes.map((route) => {
    const handler = handlers.get(`${route.method} ${route.path}`)
    return handler === undefined ? route : { ...route, handler }
  })
}

/** 组装四条设置/Policy 路由的 handler。 */
export function createSettingsHandlers(
  options: SettingsHandlerOptions
): ReadonlyMap<string, RouteHandler> {
  const handlers = new Map<string, RouteHandler>()
  const write = options.idempotent ?? ((_input, work) => Promise.resolve(work()))

  // ---- GET settings：一个块（`--block`）或全部；值来自保存过的版本，否则是运行时那份。
  handlers.set('GET settings', ({ query }) => {
    const requested = query['block']
    const names =
      requested === undefined || requested.length === 0
        ? (options.blocks?.() ?? ['policy', 'eval', 'executor'])
        : [knownBlockName(options, requested)]
    const blocks = names.map((name) => blockView(options, knownBlock(options, name), name))
    const result: SettingsResult = { revision: options.settings.revision(), blocks }
    return result
  })

  // ---- GET policy/history：版本摘要（面板 History 页与 `settings get --history`）。
  handlers.set('GET policy/history', ({ query }) => {
    const limit = Number(query['limit'] ?? SETTINGS_HISTORY_LIMIT)
    const size = Number.isInteger(limit) && limit > 0 ? Math.min(limit, SETTINGS_HISTORY_LIMIT) : SETTINGS_HISTORY_LIMIT
    const result: SettingsHistoryResult = {
      revision: options.settings.revision(),
      history: options.settings.history(size).map(versionView)
    }
    return result
  })

  // ---- PUT settings/:block：校验 → 账号类字段的 setup 检查 → 写入（§K.8 全有或全无）。
  handlers.set('PUT settings/:block', (input) =>
    write(input, async () => {
      const name = input.params['block'] ?? ''
      if (parseSettingsBlock(name) === undefined) {
        throw new ApiError(
          ERROR_CODES.invalidValue,
          'block must be policy, eval, executor or source:<id>',
          { field: 'block' },
          [{ path: 'block', message: 'expected policy, eval, executor or source:<id>' }]
        )
      }
      const request = bodyObject(input.body)
      const revision = requiredInteger(request, 'revision')
      // `value` 必须出现（`null` 是合法值）：没给是参数形状问题，不是「清空」。
      if (!Object.prototype.hasOwnProperty.call(request, 'value')) {
        throw new ApiError(ERROR_CODES.invalidParams, 'a save needs value', { field: 'value' })
      }
      const value = request['value']
      const origin = originOf(request)
      const validateBlock = options.validate?.(name)
      const parsedValue =
        validateBlock !== undefined
          ? validateBlock(value)
          : (validateSettingsBlock(name, value) ?? { success: true as const, data: value })
      if (!parsedValue.success) {
        throw new ApiError(
          ERROR_CODES.invalidValue,
          `The ${name} block is invalid`,
          { block: name },
          errorIssuesOf(parsedValue.issues)
        )
      }
      const before = options.settings.block(name)
      const beforeValue = before?.config
      // 账号类字段（`cli` / `repository`）**变更时**：写之前按候选值跑 #44 的探针；不通过就
      // 400，一行都不写（§K.8）。值没变就跳过——只改轮询间隔不该被一次登录检查挡住。
      const candidates = accountCandidatesIn(parsedValue.data)
      const current = accountCandidatesIn(beforeValue ?? options.effective?.(name))
      const accountChanged =
        (candidates.cli !== undefined && candidates.cli !== current.cli) ||
        (candidates.repository !== undefined && candidates.repository !== current.repository)
      if (accountChanged && options.checkAccount !== undefined) {
        const issues = await options.checkAccount(candidates)
        if (issues.length > 0) {
          throw new ApiError(
            ERROR_CODES.setupFailed,
            `The ${name} block was not saved: the account fields do not pass the setup check`,
            { block: name },
            setupIssuesOf(issues)
          )
        }
      }
      let saved
      try {
        saved = options.settings.save({
          block: name,
          value: parsedValue.data,
          origin,
          expectedRevision: revision
        })
      } catch (error) {
        apiErrorOf(error, name)
      }
      options.afterWrite?.()
      const result: SettingsSaveView = {
        block: name,
        revision: options.settings.blockRevision(name),
        settings_revision: saved.revision,
        policy_changed:
          name === 'policy' && saved.changed && saved.policyVersion !== before?.policyVersion,
        restarting: restartingOf(beforeValue, parsedValue.data),
        changed: saved.changed,
        origin: saved.origin
      }
      return result
    })
  )

  // ---- POST policy-sync/:id：走 #23 的驱动器；健康与 origin=sync 的记账在驱动器里。
  const policySync = options.policySync
  if (policySync !== undefined) {
    handlers.set('POST policy-sync/:id', (input) =>
      write(input, async () => {
        const id = input.params['id'] ?? ''
        if (id.length === 0) throw new ApiError(ERROR_CODES.invalidParams, 'a source id is required')
        if (!policySync.syncable().includes(id)) {
          throw new ApiError(
            ERROR_CODES.notSyncable,
            `The ${id} Source has no allow list to sync, or is not running`,
            { source: id }
          )
        }
        const before = policySync.allowed(id)
        let part: Record<string, unknown>
        try {
          part = await policySync.sync(id)
        } catch {
          // 驱动器的错误原文只进日志与健康条目（§N.5）：信封里只给固定码与 Source。
          throw new ApiError(ERROR_CODES.syncFailed, `The ${id} policy sync failed`, { source: id })
        }
        const allowed = Array.isArray(part['allowed']) ? (part['allowed'] as unknown[]) : []
        const diff = allowListDiff(before, allowed)
        const policy = policySync.policy()
        const result: PolicySyncResult = {
          policy: { revision: policy.revision, version: policy.version },
          allowed,
          added: diff.added,
          removed: diff.removed
        }
        return result
      })
    )
  }

  return handlers
}

/** `settings get --block` 的名字：认得出就原样，认不出是 `missing`。 */
function knownBlockName(options: SettingsHandlerOptions, name: string): string {
  knownBlock(options, name)
  return name
}

/** 这次保存是否需要重启才生效（§H.12）：`stateDir` 真的变了。 */
function restartingOf(before: unknown, after: unknown): boolean {
  const fields = (value: unknown): string => {
    const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
    return JSON.stringify(RESTART_SETUP_FIELDS.map((field) => record[field] ?? null))
  }
  return fields(before) !== fields(after)
}

// 运维命令的 HTTP handler（§G.2 的运维行、§G.3 的路由表）：CLI 与面板共用同一份实现。
//
// CLI 侧只做「参数 → 请求 → 打印」，真正的工作全在这里（`cli/commands.ts` 不重写业务逻辑，
// §G「同一份 handler」）。本票接线的五条：
//   POST executor/pause         pause / resume（body `{paused}`，origin=operator）
//   POST sources/:id/labels     source labels（经注入的 Source 端口，见 `SourceLabelsPort`）
//   POST admin/backup           admin backup（VACUUM INTO + 保留最近 5 份）
//   POST admin/rotate-token     admin rotate-token（破坏性：body `{confirm:true}`）
//   POST doctor                 doctor（逐项 ok/warn/fail）
//
// 尚未接线的仍是 `stub()`：`router/restart`、`workspace open`、面板专属视图与所有
// Router/Worker 命令（各自的票接上时只改 handler 字段）。
//
// 依赖纪律（§C.2）：本文件在 `http/` 里，只 import `app/`、`infra/` 与同目录的兄弟模块；
// 不 import `sources/`（Source 端口由组合根注入），也不起子进程（doctor 的 runner 同样注入）。
import { ApiError, ERROR_CODES } from './errors.ts'
import { runWrite } from './idempotency.ts'
import type { RouteDefinition, RouteHandler } from './routes.ts'
import { rotateApiToken } from '../infra/tokens.ts'
import { backupNow } from '../app/backup.ts'
import { createPausedState, type PausedState } from '../app/pause.ts'
import { runDoctor, type CommandsRunner, type DoctorOptions } from '../app/doctor.ts'
import type {
  BackupResult,
  DoctorResult,
  PauseResult,
  RotateTokenResult,
  SetupCheckResult,
  SourceLabelsResult
} from './api-types.ts'
import type { Store } from '../app/store.ts'

/**
 * `source labels` 的端口：组合根把 SourceRegistry 包成这个方法（`kind.refreshLabels` 的
 * 单实例版本）。没有它时（本票的树）路由如实回 `unavailable`，而不是编一个空标签表。
 */
export type SourceLabelsPort = (source: string, at: string) => Promise<Record<string, string>>

/** handler 需要的接线。全部可选：缺哪个，对应路由保持 `stub()`。 */
export interface OpsPorts {
  /** 暂停状态（缺省用 store 建一个：暂停本来就是库里的一个 kv 键）。 */
  readonly paused?: PausedState
  /** `source labels`（SourceRegistry 的适配器；缺省时该路由 `unavailable`）。 */
  readonly sourceLabels?: SourceLabelsPort
  /** doctor 的子进程出口（生产给 `sources/commands.ts` 的 `Commands.run`）。 */
  readonly run?: CommandsRunner
  /** doctor 的 CLI 入口路径（缺省不检查这一项）。 */
  readonly cliPath?: string
  /** 时钟（测试注入固定时刻）。 */
  readonly now?: () => string
  /** doctor 的端口探测（测试注入；缺省真连 127.0.0.1:<port>）。 */
  readonly portOpen?: (port: number) => Promise<boolean>
  /**
   * `setup check`（§G.2 的运维行）：组合根给的重跑探针。缺省保持 `stub()`——
   * 一个没有组合根的测试服务器不能假装「检查过了」。
   */
  readonly setupCheck?: SetupCheckPort
}

/** `setup check` 的端口：返回组合根的重跑结论（`BootHandle.checkSetup`）。 */
export type SetupCheckPort = () => Promise<{
  readonly checked: boolean
  readonly problem: SetupCheckResult['problem']
  readonly issues: SetupCheckResult['issues']
  readonly restarted: boolean
}>

/** 一条被接线的路由：`<METHOD> <path>` → handler。 */
export type OpsHandlers = ReadonlyMap<string, RouteHandler>

/** 路由的键（与 `RouteDefinition` 的 method+path 一一对应）。 */
export function routeKey(route: Pick<RouteDefinition, 'method' | 'path'>): string {
  return `${route.method} ${route.path}`
}

/**
 * 组装本票接线的 handler。`store`/`stateDir` 从 server 的 host 传入（那里只有一个真库）。
 */
export function createOpsHandlers(options: {
  readonly store: Store
  readonly stateDir: string
  readonly ports?: OpsPorts
  /** 组合根给的 CLI 入口路径（server 的 host 上带过来；缺省用 `ports.cliPath`）。 */
  readonly cliPath?: string
}): OpsHandlers {
  const now = options.ports?.now ?? (() => new Date().toISOString())
  const paused = options.ports?.paused ?? createPausedState(options.store)
  const handlers = new Map<string, RouteHandler>()

  // ---- pause / resume（§K.6）：写命令，`--request-id` 幂等。
  handlers.set('POST executor/pause', ({ body, at, token, requestId }) =>
    idempotent(options.store, requestId ?? requestIdFrom(body), at, token, () => {
      const wanted = pausedFlag(body)
      const outcome = paused.setPaused(wanted, at, 'operator')
      const result: PauseResult = {
        paused: outcome.record.paused,
        at: outcome.record.at,
        changed: outcome.changed
      }
      return result
    })
  )

  // ---- source labels（§G.2「刷新显示名」）：读外部、写 kv，按 request id 幂等。
  const labels = options.ports?.sourceLabels
  if (labels !== undefined) {
    handlers.set('POST sources/:id/labels', ({ params, at, body, token, requestId }) => {
      const source = params['id'] ?? ''
      if (source.length === 0) throw new ApiError(ERROR_CODES.invalidParams, 'a source id is required')
      return idempotent(options.store, requestId ?? requestIdFrom(body), at, token, async () => {
        const refreshed = await labels(source, at)
        const result: SourceLabelsResult = { source, labels: refreshed }
        return result
      })
    })
  }

  // ---- admin backup（§G.2）：立即备份（升级前手工调用）。
  handlers.set('POST admin/backup', ({ at, body, token, requestId }) =>
    idempotent(options.store, requestId ?? requestIdFrom(body), at, token, () => {
      const result: BackupResult = backupNow(options.store, at)
      return result
    })
  )

  // ---- admin rotate-token（§G.2、§O）：破坏性，必须显式确认。
  handlers.set('POST admin/rotate-token', ({ at, body, token, requestId }) => {
    if (!confirmed(body)) {
      throw new ApiError(
        ERROR_CODES.refused,
        'rotate-token replaces the operator token; pass --yes to confirm',
        { reason: 'confirmation_required' }
      )
    }
    return idempotent(options.store, requestId ?? requestIdFrom(body), at, token, () => {
      const rotated = rotateApiToken(options.stateDir)
      const result: RotateTokenResult = { tokenFile: rotated.path, rotated: true }
      return result
    })
  })

  // ---- setup check（§G.2、§N.1）：重跑探针并重新武装挂起的循环；本来没问题就固定拒绝。
  const setupCheck = options.ports?.setupCheck
  if (setupCheck !== undefined) {
    handlers.set('POST setup/check', async ({ token, requestId, body, at }) =>
      idempotent(options.store, requestId ?? requestIdFrom(body), at, token, async () => {
        const outcome = await setupCheck()
        if (!outcome.checked) {
          throw new ApiError(
            ERROR_CODES.refused,
            'setup has no problems left; there is nothing to check again',
            { reason: 'nothing_to_check' }
          )
        }
        const result: SetupCheckResult = {
          checked: true,
          restarted: outcome.restarted,
          problem: outcome.problem,
          issues: outcome.issues
        }
        return result
      })
    )
  }

  // ---- doctor（§G.2、§N.4）：本地诊断；只报有没有，不报是什么。
  const doctorOptions: DoctorOptions = {
    stateDir: options.stateDir,
    ...(options.ports?.run === undefined ? {} : { run: options.ports.run }),
    ...((options.ports?.cliPath ?? options.cliPath) === undefined
      ? {}
      : { cliPath: options.ports?.cliPath ?? options.cliPath }),
    ...(options.ports?.portOpen === undefined ? {} : { portOpen: options.ports.portOpen }),
    now,
    inspectDatabase: () => options.store.inspect()
  }
  handlers.set('POST doctor', async () => {
    const result: DoctorResult = await runDoctor(doctorOptions)
    return result
  })

  return handlers
}

/**
 * 把 handler 装进路由表：键匹配的换成真实现，其余保持 `stub()`（未落地的动作仍回
 * 固定的 `unavailable`）。`state` 行由 server 自己替换（它需要 HTTP 自身读数）。
 */
export function withOpsHandlers(
  routes: readonly RouteDefinition[],
  handlers: OpsHandlers
): readonly RouteDefinition[] {
  return routes.map((route) => {
    if (route.method === 'GET' && route.path === 'state') return route
    const handler = handlers.get(routeKey(route))
    return handler === undefined ? route : { ...route, handler }
  })
}

/** `POST executor/pause` 的 body：`{paused: boolean}`（§G.3 的 body 说明）。 */
function pausedFlag(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) {
    throw new ApiError(ERROR_CODES.invalidParams, 'pause needs { paused: boolean }')
  }
  const flag = (body as { paused?: unknown }).paused
  if (typeof flag !== 'boolean') {
    throw new ApiError(ERROR_CODES.invalidParams, 'pause needs { paused: boolean }')
  }
  return flag
}

/** `{confirm: true}` 才算确认（破坏性动作，§O）。 */
function confirmed(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false
  return (body as { confirm?: unknown }).confirm === true
}

/** request id：body 里的 `requestId`（CLI 走 HTTP 头，见 `server.ts`；面板与测试可直接带）。 */
function requestIdFrom(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const value = (body as { requestId?: unknown }).requestId
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * 幂等包装（§G.1 幂等行）：有 request id 时同 id 一小时内返回首次结果；`caller` 用 token
 * 的哈希，两个调用者不会互相顶掉；**失败不缓存**（重试有机会成功）。
 *
 * 窗口、键与清理只有 `http/idempotency.ts` 的 `runWrite` 一份：本文件不再重写一遍。
 */
function idempotent<T>(
  store: Store,
  requestId: string | null,
  at: string,
  token: string | undefined,
  work: () => T | Promise<T>
): Promise<T> {
  return runWrite({ store, at, requestId, ...(token === undefined ? {} : { token }) }, work)
}

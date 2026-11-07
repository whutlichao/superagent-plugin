// 名单同步的驱动器（§I.3「同步」行、§N.4 的 `sync:<source id>` 健康条目）。
//
// 一个 kind 用 `policy.sync` 声明「从哪里同步」与「怎么读」；本文件负责时机与记账：
// - **启动时一次**：`start()` 对每个可同步的 Source 各跑一次（组合根在启动末尾调用）；
// - **手动「立即同步」**：`sync(id)`（面板按钮与 `policy sync` 命令共用）；
// - **失败退避**：1 min 起、每次翻倍、封顶 1 h（与上游 `retrySync` 同一序列）；成功清掉待重试；
// - **健康**：每个 Source 一条 `sync:<id>`，写者是这里（kind 声明的 `sync:` 会被注册表拒绝，
//   §N.4 的单一写者）。
//
// 保存 Policy 块是注入的端口：内容的解析/哈希与变更影响面归 `app/settings.ts`（§K.5），
// 本文件只提供「新的块 + 读它时的 revision」；同步期间有人改了 Policy（revision 变了）就
// 放弃这次结果并重试，绝不覆盖别人的改动。
//
// 依赖纪律（§C.2）：app 可以 import policy 与 sources 的端口类型；Infra 只给条目名。
import type { PolicyBlock, SourcePolicySection } from '../policy/index.ts'
import type { HealthClaim, HealthClaims } from '../sources/registry.ts'
import { syncHealthEntry } from '../infra/health.ts'

/** 第一次失败之后的等待（1 分钟，§I.3 同步行）。 */
export const SYNC_FIRST_DELAY_MS = 60_000

/** 退避的封顶（1 小时）：再失败也每分钟一次太吵，每小时一次足够。 */
export const SYNC_MAX_DELAY_MS = 3_600_000

/** 一次同步的依赖：全部注入，本模块不读时钟、不建定时器、不碰库。 */
export interface PolicySyncOptions {
  /** 当前生效的 Policy 块（保存过的优先，否则启动时那份）。 */
  readonly current: () => PolicyBlock
  /** 当前 Policy 块的 revision（乐观并发：同步期间变了就放弃这次结果）。 */
  readonly revision: () => number
  /** 写回 Policy 块（origin=`sync`）；`expectedRevision` 让并发保存变成冲突而不是覆盖。 */
  readonly save: (policy: PolicyBlock, expectedRevision: number) => void
  /** 现在能同步的 Source：实例启用、kind 声明了 `policy.sync`、`sync.ready(part)` 为真。 */
  readonly syncable: () => readonly string[]
  /** 跑一次读取：kind 的 `policy.sync.run`，绑定该 Source 的上下文。 */
  readonly run: (
    id: string,
    part: Record<string, unknown>,
    signal: AbortSignal
  ) => Promise<Record<string, unknown>>
  /** 健康板：`sync:<id>` 的唯一写者是这里。 */
  readonly health: HealthClaims
  readonly now: () => string
  /** 调度一次延后执行；返回取消函数（测试注入手工调度器，§P.1 不 sleep）。 */
  readonly schedule: (run: () => void, milliseconds: number) => () => void
  /** 停机信号：取消后的失败不再安排重试。 */
  readonly signal?: AbortSignal
  readonly log?: (message: string) => void
}

/** 驱动器对组合根的接口：启动时跑一轮、手动同步一个 Source、停机取消待重试。 */
export interface PolicySync {
  /** 现在能同步的 Source（面板据此显示「立即同步」是否可用）。 */
  syncable(): readonly string[]
  /** 同步一个 Source（手动「立即同步」）；不能同步时抛错。 */
  sync(id: string): Promise<Record<string, unknown>>
  /** 启动时一次：每个可同步的 Source 各跑一次，失败只记健康与日志，不抛给启动。 */
  start(): Promise<void>
  /** 停机：取消所有待重试（已经排好的读取不会再发生）。 */
  stop(): void
}

/** 一条错误的短句（只放进健康明细与日志，不含命令参数，§N.5）。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 一个 part 的名单长度（健康明细用；形状不对按 0）。 */
function allowedCount(part: Record<string, unknown>): number {
  return Array.isArray(part['allowed']) ? part['allowed'].length : 0
}

/**
 * 把 kind 返回的 part 合进块的静态形状。`next` 的键由该 kind 的 Policy schema 决定（这里是
 * `Record<string, unknown>`），真正的校验在 `save` 的 `validatePolicy` 里；这个断言只桥接
 * 静态类型，不改变运行时值。
 */
function sectionOf(part: Record<string, unknown>, previous?: SourcePolicySection): SourcePolicySection {
  const base: SourcePolicySection = previous ?? { allowed: [], bots: [], admission: {} }
  // SAFETY: 公共键（allowed/bots/admission）由 Policy schema 保证，kind 自有键（`syncChat`
  // 这类）由它的 strict schema 在保存时校验；这里只把上一次的形状当底，不改变运行时值。
  return { ...base, ...part } as unknown as SourcePolicySection
}

/**
 * 造一个名单同步驱动器。`sync` 可在启动前、启动后、停机前调用；同一 Source 的待重试只有
 * 一个（新的调度会取消旧的），因此连续失败不会叠出并行链条。
 */
export function createPolicySync(options: PolicySyncOptions): PolicySync {
  const claims = new Map<string, HealthClaim>()
  const retries = new Map<string, { cancel: () => void; wait: number }>()

  /** `sync:<id>` 的 claim（懒创建：从没同步过的 Source 不该先占一个空条目）。 */
  const healthOf = (id: string): HealthClaim => {
    const existing = claims.get(id)
    if (existing !== undefined) return existing
    const claim = options.health.claim(syncHealthEntry(id))
    claims.set(id, claim)
    return claim
  }

  /** 成功清掉待重试；失败按 1 min→1 h 翻倍再排一次。 */
  const retry = (id: string, failed: boolean): void => {
    const previous = retries.get(id)
    previous?.cancel()
    retries.delete(id)
    if (!failed || options.signal?.aborted === true) return
    const wait =
      previous === undefined ? SYNC_FIRST_DELAY_MS : Math.min(previous.wait * 2, SYNC_MAX_DELAY_MS)
    const cancel = options.schedule(() => {
      // 重试链自己消化失败：健康已经写了，启动路径不该被一个未处理的 rejection 打断。
      void sync(id).catch(() => undefined)
    }, wait)
    retries.set(id, { cancel, wait })
  }

  const sync = async (id: string): Promise<Record<string, unknown>> => {
    if (!options.syncable().includes(id)) {
      throw new Error(`The ${id} Source cannot sync now: it names no sync target or is not running`)
    }
    const health = healthOf(id)
    const revision = options.revision()
    const part = options.current().sources[id] ?? {}
    try {
      const next = await options.run(id, part, options.signal ?? new AbortController().signal)
      // 同步是一次网络读；期间有人保存了 Policy 就放弃这次结果（下次按新配置重读）。
      if (options.revision() !== revision) {
        throw new Error('The policy changed while syncing; retry with the current settings')
      }
      if (JSON.stringify(next) !== JSON.stringify(part)) {
        const latest = options.current()
        options.save(
          { ...latest, sources: { ...latest.sources, [id]: sectionOf(next, latest.sources[id]) } },
          revision
        )
      }
      health.set({ state: 'ready', detail: `${allowedCount(next)} allowed` })
      retry(id, false)
      return next
    } catch (error) {
      health.set({ state: 'error', detail: messageOf(error) })
      retry(id, true)
      throw error
    }
  }

  return {
    syncable(): readonly string[] {
      return [...options.syncable()]
    },
    sync,
    async start(): Promise<void> {
      await Promise.all(
        options.syncable().map((id) =>
          sync(id).catch((error: unknown) => {
            options.log?.(`the ${id} policy sync failed: ${messageOf(error)}`)
          })
        )
      )
    },
    stop(): void {
      for (const { cancel } of retries.values()) cancel()
      retries.clear()
    }
  }
}

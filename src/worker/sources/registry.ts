// Source 实例注册表（§I.1、§C.1 `sources/registry.ts`）：kind 的注册处，也是领域
// `SourceScope` 的实现，并独占「Source 总览」那一条健康（§N.4）。
//
// 职责：
// - 注册 kind，并替它 claim 声明的 health 条目（重复 claim 直接拒；`sync:` 前缀归 settings，
//   这里也拒）；
// - 把「已存实例」解析成「可用的实例」：配置按 kind 的 schema 校验，**校验失败即禁用**该实例
//   （配置回落到 schema 默认值），并把原因放在 `configError` 上供面板解释；
// - 对领域回答 `scope()`：kind 未安装 / 实例被禁用 / kind 自己说不监听，都给固定的原因码；
// - 给后续票提供查询面：`instances` / `instance` / `policyPart` / `channelAllowed` / `send` /
//   `link` / `find` / `repliesTo` / `threadContext` / `declarations` / `environments`。
//
// 健康状态用设计 §J.3 / §N.4 的四档 `starting | ready | paused | error`（`core/ports.ts`
// 的 `HEALTH_STATES`）。注册表按这四档写自己 claim 的条目：刚 claim、kind 还没报告时是
// `starting`；报告成功是 `ready`；该 Source 被暂停（不在跑）是 `paused`；达到设计的失败
// 阈值是 `error`。面板要的「生命周期」（missing/off 之类）由 `overview()` 单独给出，
// 那是面板的展示词汇，不是健康状态。
import type {
  ChannelRef,
  HealthEntry,
  OutboundMessage,
  ScopeResult,
  SourceScope,
  Trigger
} from '../core/index.ts'
import type { AnySchema } from '../infra/schema.ts'
import type {
  ChannelLink,
  ChannelLinks,
  Deployment,
  Fact,
  SourceInstance,
  SourceKind,
  ThreadContext,
  TriggerContext,
  VariableSpec
} from './kind.ts'
import type { CommandsHost } from './commands.ts'

/** 注册表内部持有的 kind：配置类型不可知（注册后统一按 `Record<string, unknown>` 用）。 */
type AnySourceKind = SourceKind<Record<string, unknown>>

/** 已存的 Source 实例（设置里的原始形态；配置尚未校验）。 */
export interface StoredSourceInstance {
  readonly enabled: boolean
  readonly config: Record<string, unknown>
}

/**
 * 注册表需要的设置视图（§K.1、§N.2）。`app/settings.ts`（#20/#42）的实现结构上满足它；
 * 这里只声明注册表真正读的两个字段，避免在没有设置票之前先造一个 Settings 类型。
 */
export interface SourceSettingsView {
  readonly sources: Readonly<Record<string, StoredSourceInstance>>
  readonly policy: {
    readonly sources: Readonly<Record<string, Record<string, unknown>>>
  }
}

/** 空设置：没有实例、没有 Policy 部分（启动早期与测试用）。 */
export const EMPTY_SOURCE_SETTINGS: SourceSettingsView = { sources: {}, policy: { sources: {} } }

/** 一条 health 条目的持有者（`infra/health.ts` 的 HealthBoard 在 #45 实现，这里只声明形状）。 */
export interface HealthClaim {
  get(): HealthEntry | undefined
  set(entry: HealthEntry): void
  /** 注销时释放；之后的 `set` 变成空操作（迟到的报告不能污染后来的注册）。 */
  release(): void
}

/** 注册表对健康板的唯一依赖：每个条目只有一个写者。 */
export interface HealthClaims {
  claim(name: string, initial?: HealthEntry): HealthClaim
}

/** 注册表自己持有的「Source 总览」条目名（§N.4）。 */
export const SOURCES_HEALTH_ENTRY = 'sources'

/**
 * 面板上每个实例的生命周期。前四档就是健康状态（§J.3 的 `starting | ready | paused | error`，
 * 与 `core/ports.ts` 的 `HEALTH_STATES` 同一组取值），后两档是注册表自己才知道、健康状态
 * 表达不了的事实：kind 没装（`missing`）和被人关掉（`off`，面板的开关词汇，不是健康状态）。
 * 面板的 `panel/marks.ts` 对六档各有一句措辞。
 */
export type SourceState = 'missing' | 'off' | 'starting' | 'paused' | 'error' | 'ready'

/** 总览的一行：实例、标题、可用性与生命周期。 */
export interface SourceOverview {
  readonly id: string
  readonly kind: string
  readonly title: { zh: string; en: string }
  readonly installed: boolean
  readonly enabled: boolean
  readonly state: SourceState
  /** 配置校验失败的原因（面板显示为「配置无效，已禁用」）。 */
  readonly configError?: string
  /** 这个实例声明的 health 条目名。 */
  readonly entries: readonly string[]
}

/** 解析后的实例：多带一个「配置为什么无效」。 */
export interface ResolvedSourceInstance<C = Record<string, unknown>> extends SourceInstance<C> {
  readonly configError?: string
}

/** 注册表构造依赖：设置视图 + 健康板 + 注册回调（后续票用它挂动态同步）。 */
export interface SourceRegistryOptions {
  readonly settings?: () => SourceSettingsView
  readonly health?: HealthClaims
  /** kind 注册成功后的回调；返回注销回调（例如停止该 kind 的轮询）。 */
  readonly registered?: (kind: AnySourceKind) => () => void
}

/** 校验失败的第一条 issue 变成人能读的一句话：`path: message`。 */
function firstIssue(
  issues: readonly { path: readonly (string | number)[]; message: string }[]
): string {
  const issue = issues[0]
  if (issue === undefined) return 'invalid configuration'
  return `${issue.path.join('.') || '(root)'}: ${issue.message}`
}

/**
 * 没有注入健康板时的默认实现：语义与 `infra/health.ts` 的 HealthBoard（#45）一致——每个
 * 条目一个写者、释放后 `set` 是空操作。注册表因此可以不依赖组合根单独使用（纯单测、
 * 面板快照），而组合根注入真板后行为不变。
 */
class RegistryHealthBoard implements HealthClaims {
  readonly #entries = new Map<string, HealthEntry>()
  readonly #claimed = new Set<string>()

  claim(name: string, initial?: HealthEntry): HealthClaim {
    if (this.#claimed.has(name)) {
      throw new Error(`The health entry ${name} is reported by another part`)
    }
    this.#claimed.add(name)
    if (initial !== undefined) this.#entries.set(name, initial)
    let held = true
    return {
      get: () => this.#entries.get(name),
      set: (entry) => {
        if (held) this.#entries.set(name, entry)
      },
      release: () => {
        if (!held) return
        held = false
        this.#claimed.delete(name)
        this.#entries.delete(name)
      }
    }
  }
}

/** 把一个 kind 的配置绑定到 Trigger 上，得到评估用的 `TriggerContext`（§C.1）。 */
function bindThreadContext<C>(
  trigger: Trigger,
  context: ThreadContext<C>,
  config: C
): TriggerContext {
  return {
    messageId: context.messageId(trigger),
    read: (host, part, cursor, signal) =>
      context.read(host, trigger, part, cursor, config, signal ?? new AbortController().signal),
    images: (text) => context.images?.(text) ?? [],
    image: async (host, imageId, signal) => {
      if (context.image === undefined) throw new Error('This Source has no images')
      return context.image(host, trigger, imageId, signal)
    }
  }
}

/**
 * kind 与实例的注册表，并实现领域的 `SourceScope`（§C.1）。所有查询都接受可选的设置，
 * 缺省用构造时给的 `settings()`，测试因此可以按用例换一份设置。
 */
export class SourceRegistry implements SourceScope {
  readonly #kinds = new Map<string, AnySourceKind>()
  readonly #claims = new Map<string, HealthClaim>()
  readonly #overview: HealthClaim
  readonly #board: HealthClaims
  readonly #settings: () => SourceSettingsView
  readonly #registered: (kind: AnySourceKind) => () => void

  constructor(options: SourceRegistryOptions = {}) {
    this.#settings = options.settings ?? (() => EMPTY_SOURCE_SETTINGS)
    this.#board = options.health ?? new RegistryHealthBoard()
    this.#registered = options.registered ?? (() => () => {})
    // 「Source 总览」由注册表独占（§N.4）。第一次 `overview()` 之前没有任何读数，
    // 所以初始状态是 `starting`——「已 claim、还没报告过」正是这一档的含义。
    this.#overview = this.#board.claim(SOURCES_HEALTH_ENTRY, {
      state: 'starting',
      detail: 'Not measured yet'
    })
  }

  /**
   * 注册一个 kind：claim 它声明的 health 条目，返回注销函数。重复注册、条目被别的部件
   * 占着、或声明了 settings 的 `sync:` 条目，都直接抛错（§N.4 单一写者）。
   */
  register<C>(kind: SourceKind<C>): () => void {
    if (this.#kinds.has(kind.kind)) {
      throw new Error(`The Source kind ${kind.kind} is already registered`)
    }
    const refused = (name: string): Error =>
      new Error(
        `The Source kind ${kind.kind} declares the health entry ${name}, which another part reports`
      )
    const synced = kind.health.find((name) => name.startsWith('sync:'))
    if (synced !== undefined) throw refused(synced)
    const claimed = new Map<string, HealthClaim>()
    const releaseHealth = (): void => {
      for (const [name, claim] of claimed) {
        claim.release()
        this.#claims.delete(name)
      }
      claimed.clear()
    }
    for (const name of kind.health) {
      let claim: HealthClaim
      try {
        // 刚 claim、kind 还没报告过：这正是 `starting` 的含义（§J.3）。
        claim = this.#board.claim(name, { state: 'starting', detail: 'Waiting for ' + kind.kind })
      } catch {
        releaseHealth()
        throw refused(name)
      }
      claimed.set(name, claim)
      this.#claims.set(name, claim)
    }
    this.#kinds.set(kind.kind, kind as unknown as AnySourceKind)
    let unregistered: () => void
    try {
      unregistered = this.#registered(kind as unknown as AnySourceKind)
    } catch (error) {
      this.#kinds.delete(kind.kind)
      releaseHealth()
      throw error
    }
    return () => {
      if (!this.#kinds.has(kind.kind)) return
      this.#kinds.delete(kind.kind)
      releaseHealth()
      unregistered()
    }
  }

  /** 已注册的 kind；没装时 undefined。 */
  kind(id: string): AnySourceKind | undefined {
    return this.#kinds.get(id)
  }

  /** 注册了的 kind，按 id 排序。 */
  kinds(): AnySourceKind[] {
    return [...this.#kinds.values()].sort((left, right) => left.kind.localeCompare(right.kind))
  }

  /** 一次注册留下的健康条目（迟到的报告写到注册时拿到的 claim 上，注销后是空操作）。 */
  healthEntries(names: readonly string[]): Map<string, HealthClaim> {
    const entries = new Map<string, HealthClaim>()
    for (const name of names) {
      const claim = this.#claims.get(name)
      if (claim !== undefined) entries.set(name, claim)
    }
    return entries
  }

  /** 全部实例：已装 kind 按 id 排序（含默认值），其后是 kind 未安装的已存实例。 */
  instances(
    settings: SourceSettingsView = this.#settings()
  ): (ResolvedSourceInstance & { installed: boolean })[] {
    const installed = this.kinds().map((kind) => ({
      ...this.resolve(kind, settings.sources[kind.kind]),
      installed: true
    }))
    const orphaned = Object.entries(settings.sources)
      .filter(([id]) => !this.#kinds.has(id))
      .map(([id, stored]) => ({
        id,
        kind: id,
        enabled: stored.enabled,
        config: stored.config,
        installed: false
      }))
    return [...installed, ...orphaned]
  }

  /** 一个已装实例；kind 没装时 undefined（即使存过配置）。 */
  instance<C extends Record<string, unknown> = Record<string, unknown>>(
    id: string,
    settings: SourceSettingsView = this.#settings()
  ): ResolvedSourceInstance<C> | undefined {
    const kind = this.#kinds.get(id)
    return kind === undefined
      ? undefined
      : (this.resolve(kind, settings.sources[id]) as ResolvedSourceInstance<C>)
  }

  /**
   * 校验一份提交上来的实例配置（设置保存路径）。kind 未安装或校验失败都抛错；校验成功返回
   * 带默认值的配置。
   */
  validate(
    id: string,
    value: { enabled: boolean; config: unknown }
  ): { enabled: boolean; config: Record<string, unknown> } {
    const kind = this.#kinds.get(id)
    if (kind === undefined) throw new Error(`The Source kind ${id} is not installed`)
    const parsed = (kind.schema as AnySchema).safeParse(value.config)
    if (!parsed.success) {
      throw new Error(`The ${id} Source configuration is invalid: ${firstIssue(parsed.issues)}`)
    }
    return { enabled: value.enabled, config: parsed.data as Record<string, unknown> }
  }

  /**
   * 校验 Policy 里每个 Source 的部分。`admission`（准入表）由 Policy 自己的 schema 校验
   * （§K.1，属 #20），这里原样保留；kind 只校验它声明的那部分。未安装的 kind 原样保留。
   */
  validatePolicy(
    parts: Readonly<Record<string, Record<string, unknown>>>
  ): Record<string, Record<string, unknown>> {
    return Object.fromEntries(
      Object.entries(parts).map(([id, part]) => {
        const policy = this.#kinds.get(id)?.policy
        if (policy === undefined) return [id, part]
        const { admission, ...rest } = part
        const parsed = policy.schema.safeParse(rest)
        if (!parsed.success) {
          throw new Error(`The ${id} Policy part is invalid: ${firstIssue(parsed.issues)}`)
        }
        return [id, { ...(parsed.data as Record<string, unknown>), admission: admission ?? {} }]
      })
    )
  }

  /** 一个 Source 的 Policy 部分（含 `admission`）；kind 没有 Policy 部分时 undefined。 */
  policyPart(
    id: string,
    settings: SourceSettingsView = this.#settings()
  ): Record<string, unknown> | undefined {
    const policy = this.#kinds.get(id)?.policy
    if (policy === undefined) return undefined
    const { admission, ...rest } = settings.policy.sources[id] ?? {}
    const parsed = policy.schema.safeParse(rest)
    const defaults = policy.schema.safeParse({})
    const data = parsed.success ? parsed.data : defaults.success ? defaults.data : {}
    return { ...(data as Record<string, unknown>), admission: admission ?? {} }
  }

  /** 这个地址还能不能收到回复：实例启用且 kind 的 `allowed` 同意。 */
  channelAllowed(
    channel: { source: string; address: ChannelRef['address'] },
    settings: SourceSettingsView = this.#settings()
  ): boolean {
    const kind = this.#kinds.get(channel.source)
    if (kind === undefined) return false
    const instance = this.resolve(kind, settings.sources[channel.source])
    if (!instance.enabled) return false
    return kind.channel?.allowed?.(channel.address, instance.config) ?? true
  }

  /**
   * 经 kind 的 Channel 发一条消息：kind 没装时 `waiting`（消息等它回来，不 drop），
   * 没有 Channel 的 kind 永远收不到，返回 `gone`。
   */
  async send(message: OutboundMessage, host: CommandsHost): Promise<'sent' | 'gone' | 'waiting'> {
    const kind = this.#kinds.get(message.channel.source)
    if (kind === undefined) return 'waiting'
    if (kind.channel === undefined) return 'gone'
    return kind.channel.send(host, message)
  }

  /** 地址的页面与标签；没有 Channel 或没有链接实现时给一个空链接。 */
  link(channel: ChannelRef, links: ChannelLinks): ChannelLink {
    const link = this.#kinds.get(channel.source)?.channel?.link?.(channel.address, links)
    return link ?? { url: '', label: { zh: channel.source, en: channel.source } }
  }

  /** 全部 kind 的搜索结果，Thread 键与搜索词各去重一次。 */
  find(query: string): { threads: string[]; terms: string[] } {
    const found = this.kinds().flatMap((kind) => (kind.find === undefined ? [] : [kind.find(query)]))
    return {
      threads: [...new Set(found.flatMap((item) => item.threads))],
      terms: [...new Set(found.flatMap((item) => item.terms))]
    }
  }

  /** 这条 Trigger 回复的是哪条 Trigger。 */
  repliesTo(trigger: Trigger): string | undefined {
    return this.#kinds.get(trigger.source)?.repliesTo?.(trigger)
  }

  /**
   * 绑定配置之后的 Thread 语境读取器（评估用）。kind 没装、没有 `threadContext`、或其实例
   * 被禁用时 undefined——评估因此不读任何语境。
   */
  threadContext(
    trigger: Trigger,
    settings: SourceSettingsView = this.#settings()
  ): ReturnType<typeof bindThreadContext> | undefined {
    const kind = this.#kinds.get(trigger.source)
    const context = kind?.threadContext
    if (kind === undefined || context === undefined) return undefined
    const instance = this.resolve(kind, settings.sources[kind.kind])
    if (!instance.enabled) return undefined
    return bindThreadContext(trigger, context, instance.config)
  }

  /** 环境变量的声明（所有已装 kind，含禁用的；面板要能显示「有什么变量」）。 */
  declarations(): { kind: string; variables: readonly VariableSpec[] }[] {
    return this.kinds().flatMap((kind) =>
      kind.environment === undefined
        ? []
        : [{ kind: kind.kind, variables: kind.environment.variables }]
    )
  }

  /** 每个启用实例的环境贡献（配置已校验）。 */
  environments(
    settings: SourceSettingsView = this.#settings()
  ): { kind: string; environment: NonNullable<AnySourceKind['environment']>; config: Record<string, unknown> }[] {
    return this.kinds().flatMap((kind) => {
      const instance = this.resolve(kind, settings.sources[kind.kind])
      if (kind.environment === undefined || !instance.enabled) return []
      return [{ kind: kind.kind, environment: kind.environment, config: instance.config }]
    })
  }

  /** 部署派生的事实，按 kind 汇总（面板的只读字段）。 */
  facts(deployment: Deployment): { kind: string; facts: readonly Fact[] }[] {
    return this.kinds().flatMap((kind) =>
      kind.facts === undefined ? [] : [{ kind: kind.kind, facts: kind.facts(deployment) }]
    )
  }

  /** 面板用的总览：每个实例的可用性与生命周期，并顺手刷新「Source 总览」健康条目。 */
  overview(settings: SourceSettingsView = this.#settings()): SourceOverview[] {
    const rows = this.instances(settings).map((instance): SourceOverview => {
      const kind = this.#kinds.get(instance.kind)
      const entries = kind?.health ?? []
      const states = entries.flatMap((name) => {
        const entry = this.#claims.get(name)?.get()
        return entry === undefined ? [] : [entry.state]
      })
      // 顺序即语义：没装是 missing；配置无效是 error（它不是人主动关的）；人关的是 off
      // （即使它此前的 health 条目还留着 error）；否则就按健康状态本身说话——error 最重，
      // 其次 paused（该 Source 不在跑），再次 starting（还没有任何一次成功），最后 ready。
      // 一个 kind 可以声明多条 health，任一条 paused 即视为暂停；`starting` 只在整个 kind
      // 都还没报告过时出现，否则一条成功过就足以说明它在跑。
      const state: SourceState = !instance.installed
        ? 'missing'
        : instance.configError !== undefined
          ? 'error'
          : !instance.enabled
            ? 'off'
            : states.includes('error')
              ? 'error'
              : states.includes('paused')
                ? 'paused'
                : states.length > 0 && states.every((entry) => entry === 'starting')
                  ? 'starting'
                  : 'ready'
      return {
        id: instance.id,
        kind: instance.kind,
        title: kind?.title ?? { zh: instance.id, en: instance.id },
        installed: instance.installed,
        enabled: instance.enabled,
        state,
        ...(instance.configError === undefined ? {} : { configError: instance.configError }),
        entries
      }
    })
    this.#reportOverview(rows)
    return rows
  }

  /** 领域的监听判定（§I.1 `scope`、§K.2）：给固定原因码，面板据此解释「为什么它没理我」。 */
  scope(
    trigger: Trigger,
    settings: SourceSettingsView = this.#settings()
  ): ScopeResult {
    const kind = this.#kinds.get(trigger.source)
    const stored = settings.sources[trigger.source]
    // kind 没装时无法判定监听范围：存过配置的实例什么都不听，没存过的（内置 kind 未注册）都听。
    if (kind === undefined) {
      return stored === undefined
        ? { listened: true, observed: false }
        : { listened: false, reason: 'source_not_installed' }
    }
    const instance = this.resolve(kind, stored)
    if (!instance.enabled) {
      return {
        listened: false,
        reason: instance.configError === undefined ? 'source_disabled' : 'source_config_invalid'
      }
    }
    return kind.scope === undefined
      ? { listened: true, observed: false }
      : kind.scope(trigger, instance.config)
  }

  /**
   * 把已存配置变成可用实例：schema 默认值 + 校验。校验失败时**禁用**实例并把配置回落到
   * 默认值（面板因此仍能显示字段），失败原因放在 `configError`。
   */
  private resolve(
    kind: AnySourceKind,
    stored: StoredSourceInstance | undefined
  ): ResolvedSourceInstance {
    const schema = kind.schema as AnySchema
    const parsed = schema.safeParse(stored?.config ?? {})
    if (parsed.success) {
      return {
        id: kind.kind,
        kind: kind.kind,
        enabled: stored?.enabled ?? true,
        config: parsed.data as Record<string, unknown>
      }
    }
    const defaults = schema.safeParse({})
    return {
      id: kind.kind,
      kind: kind.kind,
      enabled: false,
      config: (defaults.success ? defaults.data : {}) as Record<string, unknown>,
      configError: firstIssue(parsed.issues)
    }
  }

  /**
   * 「Source 总览」条目：有 error 就是 error；处理暂停时是 paused（每个 Source 都不在跑）；
   * 还没有任何一次成型读数时是 starting；否则 ready。明细写启用数与问题数。
   */
  #reportOverview(rows: readonly SourceOverview[]): void {
    const installed = rows.filter((row) => row.installed)
    const enabled = installed.filter((row) => row.enabled)
    const problems = installed.filter((row) => row.state === 'error')
    this.#overview.set({
      state:
        problems.length > 0
          ? 'error'
          : enabled.length === 0
            ? 'ready'
            : enabled.every((row) => row.state === 'paused')
              ? 'paused'
              : enabled.every((row) => row.state === 'starting' || row.state === 'paused')
                ? 'starting'
                : 'ready',
      detail: `${enabled.length} enabled, ${problems.length} problems`
    })
  }
}

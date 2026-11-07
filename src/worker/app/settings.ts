// 版本化设置块（§D.4 写者：`app/settings.ts`、§K.8、§D.3）：
// - 来源规则：`panel | operator` 才能改 setup 类字段（`stateDir` / `baseRepo` / `cli` /
//   `repository`）；`tool`（CLI）与 `sync`（名单同步）改这些 → `origin_forbidden`；
// - 写前校验：块的 schema 在写库之前跑完，任何 issue 都整单拒绝（全有或全无）；
// - 版本记账：每次有效保存写一行 `settings_version`、递增 `settings-revision`、写
//   `settings-version:<n>` 快照与 `settings-block-revision:<block>`（面板的乐观并发读它）。
//
// Policy 块多两件事（§K.5），都由本模块在保存的同一次调用里做完：
// - 版本是**内容哈希**：保存时现算（`policy/version.ts`），调用方不能自带一个版本，也不能
//   忘了算；其余块记 `null`。
// - 版本变了就先算影响面（`policy/effects.ts`）、写进 `settings-version:<n>` 的
//   `affectedTickets`，提交后在事务外取消在跑的评估并给受影响的 Ticket 发通知。变更**不**
//   吊销 Mandate：Ticket 保持 open，下一次醒来按新 Policy 复验（§K.3）。
import type { PolicyEffect, Ticket } from '../core/index.ts'
import type { SafeParse, SchemaIssue } from '../infra/schema.ts'
import { DEFAULT_POLICY, policyEffects, policyVersion, validatePolicy } from '../policy/index.ts'
import type { AdmissionRow, PolicyBlock, PolicyKindView } from '../policy/index.ts'
import type { Store } from './store.ts'
import { SETTINGS_REVISION_KEY, settingsBlockRevisionKey, settingsVersionKey } from './kv.ts'
import type { SettingsVersionRecord } from './records.ts'

/** Policy 块的块名（唯一一处字面量，见 §D.3 的块族）。 */
const POLICY_BLOCK = 'policy'

/** 没有版本变化时共享的空影响面（不给每次保存都新建一个表）。 */
const NO_EFFECTS: ReadonlyMap<string, PolicyEffect> = new Map()

/** 设置保存的来源（§K.8）：只有 `panel` / `operator` 有 setup 权限。 */
export type SettingsOrigin = 'panel' | 'tool' | 'sync' | 'operator'

/**
 * setup 类字段（§K.8）：改它们要先跑 setup 检查，所以只有面板与 operator 能改。
 * `http/routes.ts` 的角色过滤与这里共用同一份清单。
 */
export const SETUP_FIELDS = ['stateDir', 'baseRepo', 'cli', 'repository'] as const

/** 保存被拒的错误码（与 HTTP 的 `origin_forbidden` / 字段级 400 / 409 对应）。 */
export type SettingsErrorCode = 'origin_forbidden' | 'invalid_settings' | 'conflict'

/**
 * 四种来源原样落库（§K.8）：`operator` 与 `panel` 都有人工权限，但审计要能分清是谁动的手，
 * 所以 `settings_version.origin` 的 CHECK 与这里都收四个值（schema v2 起）。
 */
const storedOrigin = (origin: SettingsOrigin): SettingsVersionRecord['origin'] => origin

/** 保存被拒：固定错误码 + 字段级 issues（`invalid_settings` 时有值）。 */
export class SettingsError extends Error {
  readonly code: SettingsErrorCode
  readonly issues: SchemaIssue[]

  constructor(code: SettingsErrorCode, message: string, issues: readonly SchemaIssue[] = []) {
    super(message)
    this.name = 'SettingsError'
    this.code = code
    this.issues = [...issues]
  }
}

/** 一次保存的输入。`validate` 由调用方给（Policy 块或某个 kind 的 schema）。 */
export interface SettingsSaveInput {
  /** 块名：`policy` / `eval` / `executor` / `source:<id>` / `pause`…… */
  readonly block: string
  readonly value: unknown
  readonly origin: SettingsOrigin
  /** 面板提交的基版本；与当前块版本不一致即 `conflict`。 */
  readonly expectedRevision?: number
  /** 写前校验；返回失败即整单拒绝。 */
  readonly validate?: (value: unknown) => SafeParse<unknown>
}

/** 一次保存的结果（`changed: false` 时没有写任何行）。 */
export interface SettingsSaveResult extends SettingsVersionRecord {
  readonly changed: boolean
  /** 这次保存让哪些未结束 Ticket 收到「policy 已变更」（§K.5 第 2–3 条）；其他块为空。 */
  readonly affectedTickets: readonly string[]
}

/**
 * Policy 块保存的接线（§K.5）：版本是内容哈希、版本变化的影响面，以及变更之后要做的事。
 * 由组合根用真实模块组装（`createPolicySettingsPort`）；测试可以用一个固定版本的替身。
 */
export interface SettingsPolicyPort {
  /** 一个 Policy 块的内容哈希（§K.5）。 */
  readonly version: (config: unknown) => string
  /** 这次两版之间的影响面：受影响的是哪些未结束 Ticket、怎么受影响的（§K.5 第 2 条）。 */
  readonly effects: (input: {
    readonly from: unknown
    readonly to: unknown
  }) => ReadonlyMap<string, PolicyEffect>
  /**
   * 版本变了之后（事务外）：取消在跑的评估并把它的 Trigger 重新入队，再给每个受影响的
   * Ticket 投递一条 `policy-changed`（§K.5 第 1、3 条）。`from` 为 `null` 表示从未保存过。
   */
  readonly apply: (input: {
    readonly from: string | null
    readonly to: string
    readonly effects: ReadonlyMap<string, PolicyEffect>
  }) => void
}

/** `createPolicySettingsPort` 的依赖：真实的 Policy 读取、影响面与引擎写面。 */
export interface PolicySettingsPortOptions {
  /** 一个 Source 的准入行与 Policy 部分校验器（组合根的 `policyKind`，§I.1）。 */
  readonly kinds?: (source: string) => PolicyKindView | undefined
  /** 该 Source 今天声明的准入行（复验与影响面读「今天的格子」）。 */
  readonly rows: (source: string) => readonly AdmissionRow[]
  /** 当前的未结束 Ticket（影响面的对象，§K.5 第 2 条）。 */
  readonly openTickets: () => readonly Ticket[]
  /** 版本变了之后要做的事：组合根给 `Engine.policyChanged`。 */
  readonly changed: (from: string, to: string, effects: ReadonlyMap<string, PolicyEffect>) => void
  /** 从未保存过 Policy 时实际生效的块（组合根启动时那份；缺省 `DEFAULT_POLICY`）。 */
  readonly current?: () => PolicyBlock
}

/**
 * 造一个真实的 Policy 保存接线：内容哈希、影响面与「提交后做什么」都走 `policy/*` 与引擎。
 * 还给出 Policy 块的历史读面（`settings.block('policy')` 与 `settings-version:<n>`）。
 */
export function createPolicySettingsPort(options: PolicySettingsPortOptions): SettingsPolicyPort {
  const parse = (config: unknown): PolicyBlock => {
    if (config === undefined) return options.current?.() ?? DEFAULT_POLICY
    const parsed = validatePolicy(config, { kinds: options.kinds })
    if (!parsed.success) {
      throw new SettingsError(
        'invalid_settings',
        `The ${POLICY_BLOCK} block is invalid: ${parsed.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ')}`,
        parsed.issues
      )
    }
    return parsed.data
  }
  return {
    version: (config) => policyVersion(parse(config)),
    effects: ({ from, to }) =>
      policyEffects(parse(from), parse(to), options.openTickets(), { rows: options.rows }),
    apply: ({ from, to, effects }) => {
      options.changed(from ?? policyVersion(parse(undefined)), to, effects)
    }
  }
}

/** 递归找出一个值里出现的 setup 字段名（Source 配置嵌在 `config` 里也算）。 */
export function setupFieldsIn(value: unknown, found = new Set<string>()): string[] {
  if (Array.isArray(value)) {
    for (const item of value) setupFieldsIn(item, found)
    return [...found].sort()
  }
  if (typeof value !== 'object' || value === null) return [...found].sort()
  for (const [key, item] of Object.entries(value)) {
    if ((SETUP_FIELDS as readonly string[]).includes(key)) found.add(key)
    setupFieldsIn(item, found)
  }
  return [...found].sort()
}

/** 保存一个块时用的读/写面（`Store` 结构上满足它；测试可以只给这几个方法）。 */
export type SettingsStore = Pick<
  Store,
  'kvGet' | 'kvSet' | 'settingsVersions' | 'transaction'
>

/** `app/settings.ts` 的句柄：读当前版本、读一个块、保存一个块、读历史。 */
export interface Settings {
  /** 全局设置版本（`settings-revision`）。 */
  revision(): number
  /** 一个块最近的版本；没存过是 0。 */
  blockRevision(block: string): number
  /** 一个块当前的记录；没存过是 undefined。 */
  block(block: string): SettingsVersionRecord | undefined
  /** 版本历史，新→旧（面板 History 页与 `settings get --history` 共用）。 */
  history(limit?: number): readonly SettingsVersionRecord[]
  /** 校验并保存一个块（全有或全无）。 */
  save(input: SettingsSaveInput): SettingsSaveResult
}

/**
 * 一个块当前的已保存记录；没存过是 `undefined`（读面与写面共用这一条读法）。
 * 组合根在每次判定时读它——Policy 的保存因此立刻改变 Gate、复验与版本，而不必等重启
 * （§H.12 的配置热重载里属于 Policy 的那部分）。
 */
export function savedSettingsVersion(
  store: SettingsStore,
  block: string
): SettingsVersionRecord | undefined {
  const revision = store.kvGet<number>(settingsBlockRevisionKey(block)) ?? 0
  return revision === 0 ? undefined : (store.settingsVersions.byRevision(revision) ?? undefined)
}

/**
 * 造一个设置保存器。`now` 注入（§P.1：领域与存储不读环境时钟），`store` 是真库或测试替身；
 * `policy` 是 Policy 块的接线（§K.5），只有保存 Policy 块时需要——没有它时保存 Policy 块
 * 会被拒绝（版本不能凭空缺失）。
 */
export function createSettings(input: {
  readonly store: SettingsStore
  readonly now: () => string
  readonly policy?: SettingsPolicyPort
  /**
   * 保存成功（真的写了新版本）之后的回调：组合根用它把 `source:<id>` 的开关立刻交给
   * Source 运行时（§M.2「打开/关闭」不必重启）。回调在保存事务之外、事务之后调，
   * 因此不能要求它回滚已提交的版本；回滚退错由回调自己消化。
   */
  readonly saved?: (record: SettingsVersionRecord) => void
}): Settings {
  const { store, now } = input

  const policyPort = (): SettingsPolicyPort => {
    if (input.policy === undefined) {
      throw new Error(
        'saving the policy block needs its port (content hash and change fan-out); see createPolicySettingsPort'
      )
    }
    return input.policy
  }

  const revision = (): number => store.kvGet<number>(SETTINGS_REVISION_KEY) ?? 0
  const blockRevision = (block: string): number =>
    store.kvGet<number>(settingsBlockRevisionKey(block)) ?? 0
  const block = (name: string): SettingsVersionRecord | undefined => savedSettingsVersion(store, name)

  return {
    revision,
    blockRevision,
    block,
    history: (limit?: number) => store.settingsVersions.list(limit),
    save(saveInput: SettingsSaveInput): SettingsSaveResult {
      const { block: name, value, origin } = saveInput
      // 1. 来源规则（§K.8）：setup 字段只有面板与 operator 能改。写之前就拒。
      if (origin !== 'panel' && origin !== 'operator') {
        const touched = setupFieldsIn(value)
        if (touched.length > 0) {
          throw new SettingsError(
            'origin_forbidden',
            `Only the panel or the operator may change setup fields: ${touched.join(', ')}`
          )
        }
      }
      // 2. 写前校验（全有或全无）。
      const parsed = saveInput.validate === undefined ? undefined : saveInput.validate(value)
      if (parsed !== undefined && !parsed.success) {
        throw new SettingsError(
          'invalid_settings',
          `The ${name} block is invalid: ${parsed.issues
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; ')}`,
          parsed.issues
        )
      }
      const config = parsed !== undefined && parsed.success ? parsed.data : value
      // 3. 面板的乐观并发：提交的基版本必须还是当前版本。
      if (
        saveInput.expectedRevision !== undefined &&
        saveInput.expectedRevision !== blockRevision(name)
      ) {
        throw new SettingsError('conflict', 'Settings changed. Reload before saving.')
      }
      // 4. 没有改动就不记新版本（§K.5 的保存语义）。2>1 的版本号比较不能代替内容比较。
      const current = savedSettingsVersion(store, name)
      if (current !== undefined && JSON.stringify(current.config) === JSON.stringify(config)) {
        return { ...current, changed: false, affectedTickets: [] }
      }
      // 5. Policy 块的版本是内容哈希（§K.5）：在这里现算，调用方无法自带一个版本。
      //    版本变了就先算影响面——受影响 Ticket 的名单随这次保存一起落进历史。
      const isPolicy = name === POLICY_BLOCK
      const version = isPolicy ? policyPort().version(config) : null
      const previousVersion = current?.policyVersion ?? null
      const versionChanged = isPolicy && version !== null && previousVersion !== version
      const effects: ReadonlyMap<string, PolicyEffect> = versionChanged
        ? policyPort().effects({ from: current?.config, to: config })
        : NO_EFFECTS
      const affectedTickets = [...effects.keys()]
      const at = now()
      const predecessor = blockRevision(name)
      // 6. 记账：一行历史 + 三个 KV 键，同一个事务（抛错即全部回滚）。
      const result = store.transaction((): SettingsSaveResult => {
        const next = revision() + 1
        const record: SettingsVersionRecord = {
          revision: next,
          predecessor: predecessor === 0 ? null : predecessor,
          at,
          origin: storedOrigin(origin),
          block: name,
          config,
          policyVersion: version
        }
        store.settingsVersions.put(record)
        store.kvSet(SETTINGS_REVISION_KEY, next)
        store.kvSet(settingsVersionKey(next), {
          at,
          origin: record.origin,
          block: name,
          policyVersion: record.policyVersion,
          affectedTickets
        })
        store.kvSet(settingsBlockRevisionKey(name), next)
        return { ...record, changed: true, affectedTickets }
      })
      // 7. 事务外：取消在跑的评估、重新排队 Trigger、给受影响的 Ticket 发通知（§K.5 第 1、3 条）。
      //    不吊销任何 Mandate——那一刻之后 Ticket 仍 open，下一次醒来才按新 Policy 复验。
      if (versionChanged && version !== null) {
        policyPort().apply({ from: previousVersion, to: version, effects })
      }
      // 8. 保存已提交：通知挂在写者上的部件（组合根把 `source:<id>` 的开关接给 Source 运行时）。
      input.saved?.(result)
      return result
    }
  }
}

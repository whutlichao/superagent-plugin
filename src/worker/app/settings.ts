// 版本化设置块（§D.4 写者：`app/settings.ts`、§K.8、§D.3）：
// - 来源规则：`panel | operator` 才能改 setup 类字段（`stateDir` / `baseRepo` / `cli` /
//   `repository`）；`tool`（CLI）与 `sync`（名单同步）改这些 → `origin_forbidden`；
// - 写前校验：块的 schema 在写库之前跑完，任何 issue 都整单拒绝（全有或全无）；
// - 版本记账：每次有效保存写一行 `settings_version`、递增 `settings-revision`、写
//   `settings-version:<n>` 快照与 `settings-block-revision:<block>`（面板的乐观并发读它）。
//
// Policy 的内容哈希（§K.5）不在本模块计算：调用方把 #25 算出的 `policyVersion` 传进来记账；
// 其余块的保存记 `null`。
import type { SafeParse, SchemaIssue } from '../infra/schema.ts'
import type { Store } from './store.ts'
import { SETTINGS_REVISION_KEY, settingsBlockRevisionKey, settingsVersionKey } from './kv.ts'
import type { SettingsVersionRecord } from './records.ts'

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
 * §K.8 的四种来源映射到 §C.1 / §D.2 的三列存储值：`operator` 与 `panel` 是同一个人工路径
 * （面板与宿主命令都是操作员在动手），`settings_version.origin` 的 CHECK 只有三个值。
 */
function storedOrigin(origin: SettingsOrigin): SettingsVersionRecord['origin'] {
  return origin === 'operator' ? 'panel' : origin
}

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
  /** Policy 块的内容哈希（#25）；其他块记 `null`。 */
  readonly policyVersion?: string | null
}

/** 一次保存的结果（`changed: false` 时没有写任何行）。 */
export interface SettingsSaveResult extends SettingsVersionRecord {
  readonly changed: boolean
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

/** `app/settings.ts` 的句柄：读当前版本、读一个块、保存一个块。 */
export interface Settings {
  /** 全局设置版本（`settings-revision`）。 */
  revision(): number
  /** 一个块最近的版本；没存过是 0。 */
  blockRevision(block: string): number
  /** 一个块当前的记录；没存过是 undefined。 */
  block(block: string): SettingsVersionRecord | undefined
  /** 校验并保存一个块（全有或全无）。 */
  save(input: SettingsSaveInput): SettingsSaveResult
}

/**
 * 造一个设置保存器。`now` 注入（§P.1：领域与存储不读环境时钟），`store` 是真库或测试替身。
 */
export function createSettings(input: { readonly store: SettingsStore; readonly now: () => string }): Settings {
  const { store, now } = input

  const revision = (): number => store.kvGet<number>(SETTINGS_REVISION_KEY) ?? 0
  const blockRevision = (block: string): number =>
    store.kvGet<number>(settingsBlockRevisionKey(block)) ?? 0
  const block = (name: string): SettingsVersionRecord | undefined => {
    const current = blockRevision(name)
    return current === 0 ? undefined : (store.settingsVersions.byRevision(current) ?? undefined)
  }

  return {
    revision,
    blockRevision,
    block,
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
      const current = block(name)
      if (current !== undefined && JSON.stringify(current.config) === JSON.stringify(config)) {
        return { ...current, changed: false }
      }
      const at = now()
      const predecessor = blockRevision(name)
      // 5. 记账：一行历史 + 三个 KV 键，同一个事务（抛错即全部回滚）。
      return store.transaction(() => {
        const next = revision() + 1
        const record: SettingsVersionRecord = {
          revision: next,
          predecessor: predecessor === 0 ? null : predecessor,
          at,
          origin: storedOrigin(origin),
          block: name,
          config,
          policyVersion: saveInput.policyVersion ?? null
        }
        store.settingsVersions.put(record)
        store.kvSet(SETTINGS_REVISION_KEY, next)
        store.kvSet(settingsVersionKey(next), {
          at,
          origin: record.origin,
          block: name,
          policyVersion: record.policyVersion
        })
        store.kvSet(settingsBlockRevisionKey(name), next)
        return { ...record, changed: true }
      })
    }
  }
}

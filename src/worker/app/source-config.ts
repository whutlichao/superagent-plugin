// 一个 Source 实例的**当前**编辑值（§N.2、§M.3）：宿主设置给出安装时的基线，保存过的
// `source:<id>` 块覆盖它（`enabled` 与 `config` 都是「块里写了就以块为准」）。
//
// 组合根有四处需要这同一个读法，所以它只有这里一份：
// - Settings 页的读面——面板拿到的编辑基线；
// - Source 页的配置与事实（注册表实例的输入）——保存之后立刻变；
// - 运行时（轮询器、PR 规则、部署环境段）——保存之后立刻用新仓库/新 CLI；
// - 部署检查的输入——结论与探针读同一份配置。
//
// 依赖纪律（§C.2）：本文件只做「合并」，不读存储（`saved` 由调用方读并传入）、不跑子进程。
import type { SourceSettingsView } from '../sources/registry.ts'

/** 一个对象设置块；不是对象就当空。 */
function blockOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/** 一个保存过的 `source:<id>` 块（`{enabled, config}`）里的两项；块不存在时两项都缺。 */
export function savedSourceOf(saved: unknown): {
  readonly enabled?: boolean
  readonly config: Record<string, unknown>
} {
  const record = blockOf(saved)
  return {
    ...(typeof record['enabled'] === 'boolean' ? { enabled: record['enabled'] } : {}),
    config: blockOf(record['config'])
  }
}

/**
 * 一个 Source 的编辑值：kind 解析出的缺省值（`instance.config`）叠上保存过的块（保存过的优先）。
 * 没保存过时就是实例本身；块里的 `enabled` 不是布尔时回落到实例的值。
 *
 * `saved` 是 `source:<id>` 块的值（`{enabled, config}`），由调用方现读传入。
 */
export function liveSourceOf(
  instance: {
    readonly enabled: boolean
    readonly config: Record<string, unknown>
  },
  saved: unknown
): { readonly enabled: boolean; readonly config: Record<string, unknown> } {
  const record = savedSourceOf(saved)
  return {
    enabled: record.enabled ?? instance.enabled,
    config: { ...instance.config, ...record.config }
  }
}

/**
 * 一个设置视图：`raw` 给 Policy 部分（原样），`sources` 给每个实例的现值（`enabled` 必填）。
 * 注册表每次查询都调它，所以保存过的块在同一进程里立刻生效。
 */
export function viewWithSources(
  raw: Readonly<Record<string, unknown>>,
  sources: Record<string, { readonly enabled: boolean; readonly config: Record<string, unknown> }>
): SourceSettingsView {
  const policy = blockOf(raw['policy'])
  const policySources = blockOf(policy['sources'])
  return {
    sources,
    policy: {
      sources: Object.fromEntries(Object.keys(sources).map((id) => [id, blockOf(policySources[id])]))
    }
  }
}

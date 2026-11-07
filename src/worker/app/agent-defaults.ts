// 运行时默认 agent 的唯一代码真相（#51 的产品决定，2026-11）：worker 与 router 都是 `pi`。
//
// 为什么默认值要在这里再写一次，而不是只写清单：
// - `orca.settings.get()` 返回的是宿主给的快照；用户清空字段、迁移旧配置、或宿主漏回一项时，
//   调用点必须知道该用哪个 agent 启动，而不是把 `''` 交给 `orca agent launch`。
// - 清单里的 `default` 与这里的回落值必须同值；`tests/agent-defaults.test.ts` 同时断言两者，
//   防止「界面写着 pi、实际启动另一个 agent」的静默分裂。
//
// 纯逻辑：不 import `orca`、不做 I/O（§C.2 规则 4），因此 executor 与 router 都能直接用。
// 用户仍可在 Orca Settings 里覆盖这两项；保存时的非空校验在 §K.8，这里是读取侧的兜底。

/** 清单里带默认值的两个 agent 设置项（§N.2）。 */
export type AgentSettingKey = 'agent' | 'routerAgent'

/** 代码侧的默认值表，与 `orca-plugin.json` 的 `contributes.settings[].default` 一一对应。 */
export const AGENT_SETTING_DEFAULTS: Readonly<Record<AgentSettingKey, string>> = {
  agent: 'pi',
  routerAgent: 'pi'
}

/**
 * 从设置快照解析一项 agent 设置：非空字符串（去首尾空白）优先，其余一律回落默认值。
 * 回落涵盖「没有这一项」「空串/全空白」「不是字符串」三种宿主可能给的形态。
 */
export function resolveAgentSetting(
  settings: Readonly<Record<string, unknown>>,
  key: AgentSettingKey
): string {
  const configured = settings[key]
  if (typeof configured !== 'string') return AGENT_SETTING_DEFAULTS[key]
  const trimmed = configured.trim()
  return trimmed === '' ? AGENT_SETTING_DEFAULTS[key] : trimmed
}

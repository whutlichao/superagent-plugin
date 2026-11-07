// 两个角色的模型解析（§N.2、§H.4）：Router 与 worker 各自从设置快照里取 agent / model / effort。
//
// 为什么不复用 `executor/orca-executor.ts` 的 `resolveExecutorSettings`：§C.2 规则 5 要求
// `executor/` 与 `router/` 互不引用，而 `router/` 要读同一组 `executor.*` 设置。这里的解析
// 只读设置形状，不 import 执行器；两张表读同一组键，`roles.test.ts` 断言两者不漂移。
//
// 形状是宿主 `orca.settings.get()` 的扁平表：
//   { agent, routerAgent, baseRepo, executor: { model, effort, … }, router: { agent?, model, effort } }
//
// 优先级：清单里的 `routerAgent`（用户在 Orca Settings 看见的那一项）＞ 设计 §F.1 写的
// `router.agent` ＞ 代码回落 `pi`（唯一回落处 `agent-defaults.ts`，与清单 default 同值）。
// 空串/全空白/非字符串一律当「没有」，绝不把空串交给 `orca agent launch`。
import { resolveAgentSetting } from './agent-defaults.ts'

/** 一个角色启动 agent 需要的事实。 */
export interface RoleModel {
  /** Orca agent id（永远非空）。 */
  readonly agent: string
  /** 透传给 CLI 的 model id；没配就没有这一项。 */
  readonly model?: string
  /** 透传给 CLI 的 reasoning effort；没配就没有这一项。 */
  readonly effort?: string
}

/** 两个角色：Router 负责评估与路由，worker 负责一个 Ticket。 */
export interface Roles {
  readonly router: RoleModel
  readonly worker: RoleModel
}

/** 设置里的字符串（去空白；非字符串/空串当没有）。 */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** 一个设置块；不是对象就当空。 */
function block(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null ? (value as Readonly<Record<string, unknown>>) : {}
}

/** 一个角色的 `{agent, model, effort}`：只把配置过的项放进结果。 */
function role(agent: string, model: string | undefined, effort: string | undefined): RoleModel {
  return {
    agent,
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort })
  }
}

/**
 * 解析两个角色的启动设置：
 * - router：`routerAgent` ＞ `router.agent` ＞ `pi`；`router.model` / `router.effort`；
 * - worker：`agent` ＞ `pi`；`executor.model` / `executor.effort`。
 */
export function resolveRoles(raw: Readonly<Record<string, unknown>>): Roles {
  const router = block(raw['router'])
  const executor = block(raw['executor'])
  const routerAgent = text(raw['routerAgent']) ?? text(router['agent'])
  return {
    router: role(
      routerAgent ?? resolveAgentSetting(raw, 'routerAgent'),
      text(router['model']),
      text(router['effort'])
    ),
    worker: role(resolveAgentSetting(raw, 'agent'), text(executor['model']), text(executor['effort']))
  }
}

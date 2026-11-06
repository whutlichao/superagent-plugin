// Plugin entry: the supervisor worker. §N.1: activate(orca) does registration plus a boot kick,
// and heavy work belongs to the asynchronous boot sequence (later tickets). This ticket is the
// boot stub only — enough for `orca plugin test/check/validate` to load the plugin.
// The Orca type is imported through the runtime directory: only `src/worker/runtime/` names
// `orca/worker` (§B.1).
import type { OrcaWorkerApi } from './runtime/worker-api'

/** 四个贡献命令的 id，与 orca-plugin.json 的 contributes.commands 一一对应。 */
const COMMANDS = {
  pause: 'superagent.pause',
  resume: 'superagent.resume',
  restartRouter: 'superagent.restartRouter',
  checkSetup: 'superagent.checkSetup'
} as const

/** 三个订阅事件的 id，与 orca-plugin.json 的 contributes.events 一一对应。 */
const EVENTS = {
  agentStatus: 'agent.status.changed',
  workspaceCreated: 'workspace.created',
  workspaceRemoved: 'workspace.removed'
} as const

/** 唯一钩子：agent 启动前，用来注入执行环境（§H.11；实现在 F6C）。 */
const HOOK = 'agent.launch.before'

/**
 * 插件入口：Orca 在插件启用时调用一次。本票只登记贡献点并给出占位回执，
 * 真正的 boot（锁 → 迁移 → setup → HTTP → loops → 状态栏 → resume）由后续票接入。
 */
export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('superagent.state', () => ({ status: 'booting' as const }))

  orca.commands.register(COMMANDS.pause, () => 'Superagent: pause is not wired up yet.')
  orca.commands.register(COMMANDS.resume, () => 'Superagent: resume is not wired up yet.')
  orca.commands.register(
    COMMANDS.restartRouter,
    () => 'Superagent: restartRouter is not wired up yet.'
  )
  orca.commands.register(COMMANDS.checkSetup, () => 'Superagent: checkSetup is not wired up yet.')

  orca.events.on(EVENTS.agentStatus, () => undefined)
  orca.events.on(EVENTS.workspaceCreated, () => undefined)
  orca.events.on(EVENTS.workspaceRemoved, () => undefined)

  orca.hooks.on(HOOK, () => undefined)

  orca.log('Superagent worker activated (boot stub).')
}

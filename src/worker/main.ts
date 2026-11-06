// worker 入口：注册贡献点，并把面板壳的三条线接上（§N.1、§N.7、§M.6）。
//
// 本票只交付「能跑通的契约」：面板问 `state` 拿快照、暂停/恢复写回并把修订号加一、
// 每次变化推 `state.changed`，状态栏按同一份快照节流更新。重活（锁、迁移、HTTP、loops）
// 由后续票接进同一处 `activate`。
//
// 依赖纪律（§B.1）：本文件不 import `orca`/`orca/worker`，也不出现 `host.call(`；
// 宿主形状只在 `runtime/worker-host.ts` 里，这里只看到 `WorkerHost` 端口。
import type { OrcaWorkerApi } from './runtime/worker-api'
import { createWorkerHost } from './runtime/worker-host'
import { createStatusBarPublisher, statusBarView } from './app/status-bar'
import { createStubStateSource } from './app/state-source'

/** 四个贡献命令的 id，与 orca-plugin.json 的 contributes.commands 一一对应。 */
const COMMANDS = {
  pause: 'superagent.pause',
  resume: 'superagent.resume',
  restartRouter: 'superagent.restartRouter',
  checkSetup: 'superagent.checkSetup'
} as const

/** 三个订阅事件的 id，与 orca-plugin.json 的 contributes.events 一一对应。 */
const EVENTS = [
  'agent.status.changed',
  'workspace.created',
  'workspace.removed'
] as const

/** 唯一钩子：agent 启动前，用来注入执行环境（§H.11；实现在 F6C）。 */
const HOOK = 'agent.launch.before'

/**
 * 插件入口：Orca 在插件启用时调用一次。本票登记贡献点、接上面板契约与状态栏，
 * 真正的 boot（锁 → 迁移 → setup → HTTP → loops → resume）由后续票接入。
 */
export default function activate(orca: OrcaWorkerApi): void {
  const host = createWorkerHost(orca)
  const source = createStubStateSource()

  // 状态栏（§N.7）：同一份快照，最多每 2 s 一次，值未变不发。
  const statusBar = createStatusBarPublisher({
    send: (update) => host.setStatusBar(update),
    // worker 侧可以读时钟：它是常驻进程，且状态栏的节流本来就以真实时间为准。
    now: () => Date.now(),
    schedule: (run, milliseconds) => Number(setTimeout(run, milliseconds)),
    cancel: (handle) => clearTimeout(Number(handle))
  })

  // 每次状态变化：推给面板（带单调修订号），并把新值交给节流的状态栏。
  source.onChange(() => {
    const next = source.snapshot()
    host.postToPanels('state.changed', { revision: next.revision })
    statusBar.publish(statusBarView(next))
  })
  statusBar.publish(statusBarView(source.snapshot()))

  // 面板契约（§M.6）：`state` 读快照；`pause` 写回并返回改后的快照。
  host.handleRequest('state', () => source.snapshot())
  host.handleRequest('pause', (input) => {
    const paused = (input as { paused?: unknown } | null)?.paused
    if (typeof paused !== 'boolean') {
      throw Object.assign(new Error('pause needs { paused: boolean }'), { code: 'invalid_params' })
    }
    return source.setPaused(paused)
  })

  host.register(COMMANDS.pause, () => {
    source.setPaused(true)
    return 'Superagent: processing paused.'
  })
  host.register(COMMANDS.resume, () => {
    source.setPaused(false)
    return 'Superagent: processing resumed.'
  })
  host.register(COMMANDS.restartRouter, () => 'Superagent: restartRouter is not wired up yet.')
  host.register(COMMANDS.checkSetup, () => 'Superagent: checkSetup is not wired up yet.')

  for (const event of EVENTS) host.subscribe(event)
  host.hook(HOOK)

  host.log('Superagent worker activated (boot stub, panel contract wired).')
}

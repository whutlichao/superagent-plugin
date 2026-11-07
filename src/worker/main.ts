// worker 入口（§C.1、§N.1）：只做「注册贡献点 + 起 boot」，重活全在 `boot.ts` 的异步序列里。
//
// 依赖纪律（§B.1）：本文件不 import `orca`/`orca/worker`，也不出现 `host.call(`；宿主形状
// 只在 `runtime/` 里，这里只看到 `WorkerHost` 端口与 `OrcaRuntime` 接口。`activate` 同步
// 返回（Orca 的契约），boot 的失败记录在日志与 `state` 请求的拒绝里，不让插件加载失败。
import type { OrcaWorkerApi } from './runtime/worker-api'
import { createWorkerHost } from './runtime/worker-host'
import { createHostRuntime } from './runtime/host-runtime'
import { bootPlugin, defaultCliPath, type BootHandle } from './boot'
import { createStatusBarPublisher } from './app/status-bar'
import { Commands } from './sources/commands'
import { LAUNCH_HOOK_EVENT, launchHook, type LaunchHookEvent } from './executor/launch-hook'

/** 四个贡献命令的 id，与 orca-plugin.json 的 contributes.commands 一一对应。 */
const COMMANDS = {
  pause: 'superagent.pause',
  resume: 'superagent.resume',
  restartRouter: 'superagent.restartRouter',
  checkSetup: 'superagent.checkSetup'
} as const

/** 三个订阅事件的 id，与 orca-plugin.json 的 contributes.events 一一对应。 */
const EVENTS = ['agent.status.changed', 'workspace.created', 'workspace.removed'] as const

/** 当前这一次 activate 的 boot 句柄；`deactivate()` 与面板请求都读它。 */
let handle: BootHandle | null = null
/** 正在启动的 boot；面板请求等它而不是猜「已经起来了」。 */
let booting: Promise<BootHandle | null> | null = null

/** 一个未就绪的固定拒绝（面板请求按 `unavailable` 显示「正在启动」）。 */
function notReady(): Error & { code: string } {
  return Object.assign(new Error('the superagent worker is starting'), { code: 'unavailable' })
}

/** 等 boot 就绪；失败时按 `unavailable` 抛出（不让面板拿到半截状态）。 */
async function ready(): Promise<BootHandle> {
  const booted = handle ?? (booting === null ? null : await booting)
  if (booted === null) throw notReady()
  await booted.ready
  return booted
}

/** 不等结果的写（命令处理器必须是同步字符串返回）：失败只记日志。 */
function eventually(run: (booted: BootHandle) => void, onError: (message: string) => void): void {
  void ready()
    .then((booted) => run(booted))
    .catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))
}

/**
 * 插件入口：Orca 在插件启用时调用一次。它登记贡献点、接上面板契约与状态栏，并把 boot
 * 的异步序列交给 `bootPlugin`；`deactivate()` 按 §E.5 的顺序收尾。
 */
export default function activate(orca: OrcaWorkerApi): void {
  const host = createWorkerHost(orca)
  const runtime = createHostRuntime(orca, { log: (message) => host.log(message) })
  const commands = new Commands()
  const statusBar = createStatusBarPublisher({
    send: (update) => host.setStatusBar(update),
    now: () => Date.now(),
    schedule: (run, milliseconds) => setTimeout(run, milliseconds),
    cancel: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
  })

  booting = bootPlugin({
    runtime,
    readSettings: () => orca.settings.get(),
    commands,
    cliPath: defaultCliPath(),
    log: (message) => host.log(message),
    statusBar,
    panels: { post: (event, payload) => host.postToPanels(event, payload) },
    notify: (input) => {
      void runtime.notify(input)
    }
  })
    .then((booted) => {
      handle = booted
      host.log(`Superagent booted as ${booted.mode} in ${booted.stateDir}.`)
      return booted
    })
    .catch((error: unknown) => {
      host.log(`Superagent failed to boot: ${error instanceof Error ? error.message : String(error)}`)
      return null
    })

  // 面板契约（§M.6）：`state` 读真快照；`pause` 写暂停状态并返回改后的快照。
  host.handleRequest('state', async () => (await ready()).snapshot())
  host.handleRequest('pause', async (input) => {
    const paused = (input as { paused?: unknown } | null)?.paused
    if (typeof paused !== 'boolean') {
      throw Object.assign(new Error('pause needs { paused: boolean }'), { code: 'invalid_params' })
    }
    return (await ready()).setPaused(paused)
  })

  host.register(COMMANDS.pause, () => {
    eventually((booted) => booted.setPaused(true), (message) => host.log(message))
    return 'Superagent: processing paused.'
  })
  host.register(COMMANDS.resume, () => {
    eventually((booted) => booted.setPaused(false), (message) => host.log(message))
    return 'Superagent: processing resumed.'
  })
  host.register(COMMANDS.restartRouter, () => {
    eventually((booted) => booted.restartRouter(), (message) => host.log(message))
    return 'Superagent: restarting the router.'
  })
  host.register(COMMANDS.checkSetup, () => {
    eventually((booted) => booted.refresh(), (message) => host.log(message))
    return 'Superagent: setup check is not wired up yet.'
  })

  for (const event of EVENTS) host.subscribe(event)
  // `agent.status.changed` 的四态映射（§E.7）：事件是 worker 生命周期的唯一真源。
  runtime.onAgentStatus(async (event) => {
    try {
      const booted = await ready()
      await booted.onAgentStatus(event)
    } catch (error) {
      host.log(`an agent status event was dropped: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  // 执行环境钩子（§H.11）：执行器在 launch 之前往同一个单例里登记环境，这里把它接到宿主。
  launchHook.setLog((message) => host.log(message))
  host.hook<LaunchHookEvent>(LAUNCH_HOOK_EVENT, (event, next) => launchHook.handle(event, next))

  host.log('Superagent worker activating (boot started).')
}

/** 有序关闭（§E.5、§N.1）：停 passes → 排空 effects → 关 HTTP → 关库 → 放锁。 */
export async function deactivate(): Promise<void> {
  const booted = handle ?? (booting === null ? null : await booting)
  handle = null
  booting = null
  if (booted !== null) await booted.shutdown()
}

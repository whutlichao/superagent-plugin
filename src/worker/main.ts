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

/** 一个错误的可读信息（面板的错误态要显示原因，而不是「undefined」）。 */
function messageOf(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : String(error)
}

/**
 * 一个错误的拒绝码：领域错误自带 `code`（例如 `notRetryable`），宿主错误自带 Host 码；
 * 都没有时用调用给出的缺省码——不把未知错误伪装成成功。
 */
function codeOf(error: unknown, fallback: string): string {
  const code =
    typeof error === 'object' && error !== null
      ? (error as { code?: unknown }).code
      : undefined
  return typeof code === 'string' && code !== '' ? code : fallback
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

  // 面板契约（§M.6）：`state` 读真快照；`pause` 写暂停状态并返回改后的快照；
  // `check` 重跑一遍读模型；`ticket.retry`/`terminal.focus` 是 Overview 行上的直接动作。
  host.handleRequest('state', async () => (await ready()).snapshot())
  host.handleRequest('pause', async (input) => {
    const paused = (input as { paused?: unknown } | null)?.paused
    if (typeof paused !== 'boolean') {
      throw Object.assign(new Error('pause needs { paused: boolean }'), { code: 'invalid_params' })
    }
    return (await ready()).setPaused(paused)
  })
  host.handleRequest('check', async () => {
    const booted = await ready()
    return booted.refresh()
  })
  host.handleRequest('ticket.retry', async (input) => {
    const ticketId = (input as { ticketId?: unknown } | null)?.ticketId
    if (typeof ticketId !== 'string' || ticketId === '') {
      throw Object.assign(new Error('ticket.retry needs { ticketId: string }'), {
        code: 'invalid_params'
      })
    }
    const booted = await ready()
    try {
      return booted.retryTicket(ticketId)
    } catch (error) {
      // 领域的 `notRetryable` / 找不到工单都折成面板能显示的拒绝（§G.2 的固定错误面）。
      throw Object.assign(new Error(messageOf(error)), { code: codeOf(error, 'invalid_params') })
    }
  })
  host.handleRequest('terminal.focus', async (input) => {
    const terminalId = (input as { terminalId?: unknown } | null)?.terminalId
    if (typeof terminalId !== 'string' || terminalId === '') {
      throw Object.assign(new Error('terminal.focus needs { terminalId: string }'), {
        code: 'invalid_params'
      })
    }
    const booted = await ready()
    try {
      await booted.focusTerminal(terminalId)
      return { focused: true }
    } catch (error) {
      throw Object.assign(new Error(messageOf(error)), { code: codeOf(error, 'action_failed') })
    }
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
  // §N.2：贡献命令的 string 结果原样显示在 Orca 里；重跑探针是异步的，结果用通知/日志补上。
  host.register(COMMANDS.checkSetup, () => {
    eventually(async (booted) => {
      const outcome = await booted.checkSetup()
      if (!outcome.checked) {
        host.log('Superagent: setup has no problems left; nothing to check again.')
        return
      }
      const first = outcome.problem
      host.log(
        first === null
          ? 'Superagent: setup check passed; the worker loops were re-armed.'
          : `Superagent: setup still needs ${first.place} (${first.code}): ${first.fix ?? ''}`.trim()
      )
    }, (message) => host.log(message))
    return 'Superagent: re-running the setup probes.'
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

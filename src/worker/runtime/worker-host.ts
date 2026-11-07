// worker 宿主端口的薄适配器：把 `OrcaWorkerApi` 收窄成 `WorkerHost` 端口，
// 让 `src/worker/main.ts` 与领域模块只依赖端口，不出现 `host.call(`、`orca.panels.*` 这些
// 宿主形状（§B.1、§C.2 规则 3–4 的纪律）。
//
// 本文件在 `src/worker/runtime/` 内，是允许接触 Orca 的唯一目录。它**不是** `OrcaRuntime` 的实现：
// seam 的 Host API 一半（工作区、agent、终端、存储）仍由后续票的 `host-runtime.ts` 提供；
// 这里只做本票要用的四种转发：状态栏、面板请求、面板推送、命令/事件/钩子的注册。
import type { OrcaWorkerApi } from './worker-api'
import type { StatusBarUpdate } from './orca-runtime'

/**
 * 钩子的返回值：宿主只区分「继续」与「拒绝」，而「继续」就是把 `next` 的结果原样交回——
 * 真实宿主给回的是改过的事件对象，`orca/testing` 的挂载器给回 `{ kind: 'continue', event }`。
 * 插件永远选「继续」，所以这里只要求「一个对象或者什么都不返回」，不伪造其中一种形状。
 */
export type HookVerdict = object | undefined

/** 一个钩子处理器：拿到载荷与 `next`，返回裁决。 */
export type HookHandler<Event> = (event: Event, next: (event: Event) => HookVerdict) => HookVerdict

/** worker 侧需要的宿主动作；`main.ts` 与领域模块只看到这一组。 */
export interface WorkerHost {
  /** 更新清单里的状态栏项。 */
  setStatusBar(update: StatusBarUpdate): void
  /** 回答面板请求（名字由 `src/panel/protocol.ts` 声明）。 */
  handleRequest<Output>(name: string, handler: (input: unknown) => Output | Promise<Output>): void
  /** 向所有打开的面板推送事件。 */
  postToPanels(event: string, payload: unknown): void
  /** 注册贡献命令；返回的字符串原样显示在 Orca 里。 */
  register(commandId: string, handler: () => string): void
  subscribe(event: 'agent.status.changed' | 'workspace.created' | 'workspace.removed'): void
  /** 注册一个钩子处理器（目前只有一个钩子：`agent.launch.before`，§H.11）。 */
  hook<Event>(event: 'agent.launch.before', handler: HookHandler<Event>): void
  log(message: string): void
}

/** 把宿主对象收窄成端口。宿主已经收到的贡献点清单仍由清单（manifest）决定，这里只接线。 */
export function createWorkerHost(orca: OrcaWorkerApi): WorkerHost {
  return {
    setStatusBar(update: StatusBarUpdate): void {
      void orca.host.call('statusBar.update', {
        id: update.id,
        ...(update.text === undefined ? {} : { text: update.text }),
        ...(update.tone === undefined ? {} : { tone: update.tone }),
        ...(update.tooltip === undefined ? {} : { tooltip: update.tooltip }),
        ...(update.visible === undefined ? {} : { visible: update.visible })
      })
    },
    handleRequest<Output>(name: string, handler: (input: unknown) => Output | Promise<Output>): void {
      orca.panels.handle(name, (input) => handler(input))
    },
    postToPanels(event: string, payload: unknown): void {
      orca.panels.post(event, payload)
    },
    register(commandId: string, handler: () => string): void {
      orca.commands.register(commandId, handler)
    },
    subscribe(event: 'agent.status.changed' | 'workspace.created' | 'workspace.removed'): void {
      orca.events.on(event, () => undefined)
    },
    hook<Event>(event: 'agent.launch.before', handler: HookHandler<Event>): void {
      // 宿主给的是 `AgentLaunchBeforeEvent` 与一个返回 `unknown` 的 `next`；端口把它们收敛成
      // `HookHandler`，真假转换只发生在这一处（运行缝边界，§B.1）。
      orca.hooks.on(event, (payload, next) =>
        handler(payload as Event, (changed) => next(changed as typeof payload) as HookVerdict)
      )
    },
    log(message: string): void {
      orca.log(message)
    }
  }
}

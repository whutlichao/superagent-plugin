// 状态栏项的视图与节流（§N.7）。纯逻辑：不 import `orca`，时钟与定时器都注入，
// 因此单测可以用虚拟时间推进「最多每 2 s 一次」而不 sleep（§P.1 第 4 条）。
//
// 与设计的偏离（#45，协调者裁决）：§N.7 让状态栏项的点击跑 `superagent.pause`。本实现
// **故意不挂点击动作**——清单的 `contributes.statusBarItems[0]` 没有 `command` 字段——
// 因为状态栏常驻在标题栏上，误点会暂停整个处理；宿主当前也没有「只读/打开面板」的点击
// 动作可挂，不为了有得点而新增一个破坏性命令。`superagent.pause` 仍在命令面板里可用。
// DOC2（#50）负责把设计文本改成同口径。
//
// 文本是设计给死的四种（§N.7）：`Superagent` / `Superagent 3` / `Superagent paused` /
// `Superagent error`；worker 侧拿不到宿主的 UI 语言，所以它们不走面板的 `copy.ts`。
// 计数与健康来自同一份 `PanelState`，因此状态栏、tooltip 与面板永远说的是同一件事。
import type { PanelState } from '../../panel/protocol'
import type { StatusBarUpdate } from '../runtime/orca-runtime'

/** 状态栏项的 id，与 `orca-plugin.json` 的 `contributes.statusBarItems[0].id` 一致。 */
export const STATUS_BAR_ID = 'superagent'

/** 状态栏的一次取值：文本、语气与分项 tooltip。 */
export interface StatusBarView {
  readonly text: string
  readonly tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
  readonly tooltip: string
}

/** 待人工的总数（回答 + 评审）；风格上的「问题」不算「需要你动手」的工单。 */
function waiting(state: PanelState): number {
  return state.attention.answer + state.attention.review
}

/**
 * 快照 → 状态栏取值。语气优先级：error > paused > 有待人工 > 成功（§N.7）。
 * tooltip 始终分项给出三个计数，暂停或出错时也照给。
 */
export function statusBarView(state: PanelState): StatusBarView {
  const { answer, review, problems } = state.attention
  // 英文单复数：1 用单数（「1 problem」），其余用复数。状态栏拿不到宿主语言，文案固定英文。
  const tooltip = `${answer} awaiting answer · ${review} awaiting review · ${problems} ${problems === 1 ? 'problem' : 'problems'}`
  if (state.health.error) return { text: 'Superagent error', tone: 'danger', tooltip }
  if (state.health.paused) return { text: 'Superagent paused', tone: 'neutral', tooltip }
  const count = waiting(state)
  if (count > 0) return { text: `Superagent ${count}`, tone: 'warning', tooltip }
  return { text: 'Superagent', tone: 'success', tooltip }
}

/** 状态栏更新：节流器与发送端都是注入的。 */
export interface StatusBarPublisher {
  /** 交给它一份新取值；它在允许的时机（且值确实变了）调用 `send`。 */
  publish(view: StatusBarView): void
  /** 取消未到期的更新（插件关闭时）。 */
  dispose(): void
}

/** 发布器的依赖：发送端、时钟与定时器（后两者测试注入）。 */
export interface StatusBarPublisherOptions {
  readonly send: (update: StatusBarUpdate) => void
  readonly now: () => number
  /** 定时器句柄：测试给数字，生产给 Node 的 `Timeout`；发布器只负责原样交回 `cancel`。 */
  readonly schedule: (run: () => void, milliseconds: number) => unknown
  /** 句柄原样交回；发布器不解释它，因此注入方可以给任意形状。 */
  readonly cancel: (handle: unknown) => void
  /** 两次发送之间的最小间隔；缺省 2 s（§N.7）。 */
  readonly intervalMs?: number
}

/** 已发送（或正在发）的取值是否与新的相同：值未变不发。 */
function sameValue(a: StatusBarView | undefined, b: StatusBarView): boolean {
  return a !== undefined && a.text === b.text && a.tone === b.tone && a.tooltip === b.tooltip
}

/**
 * 节流发布器：第一次立即发；之后每 `intervalMs` 至多发一次，窗口内的多次变化合并成最新值，
 * 且与「上一次真正发出去的值」相同时不发（避免无意义的重绘）。
 */
export function createStatusBarPublisher(options: StatusBarPublisherOptions): StatusBarPublisher {
  const interval = options.intervalMs ?? 2000
  let lastSent: StatusBarView | undefined
  let lastSentAt = Number.NEGATIVE_INFINITY
  let pending: StatusBarView | undefined
  let timer: unknown = null

  const flush = (): void => {
    timer = null
    const next = pending
    pending = undefined
    if (next === undefined || sameValue(lastSent, next)) return
    lastSent = next
    lastSentAt = options.now()
    options.send({ id: STATUS_BAR_ID, text: next.text, tone: next.tone, tooltip: next.tooltip })
  }

  return {
    publish(view: StatusBarView): void {
      if (timer !== null) {
        // 窗口已开：只记最新值，等定时器到点发。
        pending = view
        return
      }
      const wait = lastSentAt + interval - options.now()
      if (wait > 0) {
        pending = view
        timer = options.schedule(flush, wait)
        return
      }
      if (sameValue(lastSent, view)) return
      lastSent = view
      lastSentAt = options.now()
      options.send({ id: STATUS_BAR_ID, text: view.text, tone: view.tone, tooltip: view.tooltip })
    },
    dispose(): void {
      if (timer !== null) {
        options.cancel(timer)
        timer = null
      }
      pending = undefined
    }
  }
}

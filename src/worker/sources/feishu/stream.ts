// Feishu 实时事件流（§I.3「实时事件」行）：以子进程消费 `im.message.receive_v1`，逐行读 JSON，
// 翻成 Trigger 交给 Source 端口。
//
// 五条硬规则，每条都在 `tests/sources-feishu.test.ts` 里：
// - **就绪行之后才算可用**：`[event] ready` 之前到达的行一律丢弃（真实 CLI 先发就绪行，再由
//   stdout 推事件）；45 s 没等到就停掉子进程并算一次失败；
// - **单事件 1 MiB 上限**：超了就不解析、不产生 Trigger，`feishu` 报错；
// - **非零退出按 1 s→60 s 退避重启**：一次跑满一分钟之后再失败，退避回到 1 s（同上游）；
// - **连续三次失败把 `feishu` 报成 error**，任何一次成功（看到就绪行）清零；
// - **禁用后 5 s 内停**：看门狗每 5 s 看一次实例开关，关掉就停子进程并结束循环（禁用期间
//   到达的事件也丢弃）。
//
// 依赖纪律（§C.2）：只 import core 的类型、命令端口与兄弟模块。起子进程只经 `CommandsHost.stream`
// （§I.4 的唯一出口），时钟与调度器都由组合根注入，因此测试不 sleep、不 spawn。
import type { HealthEntry, Trigger } from '../../core/index.ts'
import type { CommandStream, CommandsHost } from '../commands.ts'
import type { SourceContext } from '../kind.ts'
import { FAILURES_BEFORE_ERROR } from '../../infra/health.ts'
import type { FeishuBot } from './translate.ts'
import { feishuEventOf, feishuTrigger } from './translate.ts'

/** health 条目名（§N.4 的条目表：事件流写 `feishu`，回填写 `history`）。 */
export const FEISHU_HEALTH = 'feishu'

/** 消费命令的 argv（§I.3）：`<cli> event consume im.message.receive_v1 --as bot`。 */
export const CONSUMER_ARGS = ['event', 'consume', 'im.message.receive_v1', '--as', 'bot'] as const

/** 就绪行的前缀（CLI 的 stderr 契约：`[event] ready event_key=<key>`）。 */
export const READY_MARKER = '[event] ready'

/** 等就绪行的上限（§I.3：45 s）。 */
export const READY_TIMEOUT_MS = 45_000

/** 单个事件的大小上限（§I.3：1 MiB）。 */
export const MAX_EVENT_BYTES = 1024 * 1024

/** 重启退避的起点与封顶（§I.3：1 s → 60 s）。 */
export const MIN_RESTART_MS = 1_000
export const MAX_RESTART_MS = 60_000

/** 看门狗周期（§I.3：禁用到停不超过 5 s）。 */
export const WATCHDOG_MS = 5_000

/** 退避之后的等待：一次跑满一分钟就回到 1 s，否则翻倍到 60 s（上游同）。 */
export function consumerRetry(previous: number | undefined, ranMs: number): number {
  return previous === undefined || ranMs >= MAX_RESTART_MS
    ? MIN_RESTART_MS
    : Math.min(previous * 2, MAX_RESTART_MS)
}

/** 调度器：`schedule(run, ms)` 返一个取消函数。组合根传 `setTimeout`，测试传手工推进的替身。 */
export type Schedule = (run: () => void, milliseconds: number) => () => void

/** 事件流要的 kv 键（键名字面量只活在 `app/kv.ts`，§D.3）：只要会话表。 */
export interface FeishuStreamKeys {
  readonly chats: string
}

/** 事件流的宿主：收 Trigger、读写自己的 kv、报自己 claim 的那条 health（§I.1）。 */
export type FeishuStreamHost = Pick<SourceContext, 'receive' | 'state' | 'report'>

/** 事件流的依赖：全部注入，函数自己不读配置也不建计时器。 */
export interface FeishuStreamOptions {
  readonly commands: CommandsHost
  readonly cli: string
  readonly bot: FeishuBot
  readonly host: FeishuStreamHost
  readonly keys: FeishuStreamKeys
  /** 实例是否还在监听：关掉就停（§I.3）。 */
  readonly enabled: () => boolean
  /** 整体停机信号（插件关闭、来源删除）。 */
  readonly signal: AbortSignal
  readonly schedule: Schedule
  readonly now?: () => number
  readonly log?: (message: string) => void
  readonly readyTimeoutMs?: number
  readonly maxEventBytes?: number
}

/** 事件流的句柄：`run()` 在停机（信号或禁用）时结束。 */
export interface FeishuStream {
  run(): Promise<void>
}

/** 一次消费进程的读数：是否就绪、退出码、跑了多久。 */
interface ConsumeOutcome {
  readonly ready: boolean
  readonly code: number | null
  readonly ranMs: number
}

/** 一条消费进程 + 它的看门狗与就绪超时。 */
interface ConsumeHandle {
  readonly outcome: Promise<ConsumeOutcome>
  stop(): void
}

/**
 * 建一个实时事件流：`run()` 起一次 `event consume` 子进程、等就绪行、逐行翻成 Trigger，直到
 * 停机信号或实例被禁用（§I.3「实时事件」行）。依赖全部注入，所以测试不 sleep、不 spawn。
 */
export function createFeishuStream(options: FeishuStreamOptions): FeishuStream {
  const log = options.log ?? (() => undefined)
  const now = options.now ?? (() => Date.now())
  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS
  const maxEventBytes = options.maxEventBytes ?? MAX_EVENT_BYTES

  const report = (entry: HealthEntry): void => options.host.report(FEISHU_HEALTH, entry)

  /** 等一段时间，但信号取消时立即返回（停机的等待不该挡关闭）。 */
  const sleep = (milliseconds: number): Promise<void> =>
    new Promise<void>((resolve) => {
      let settled = false
      let cancel: () => void = () => undefined
      const done = (): void => {
        if (settled) return
        settled = true
        cancel()
        options.signal.removeEventListener('abort', done)
        resolve()
      }
      if (options.signal.aborted) {
        resolve()
        return
      }
      cancel = options.schedule(done, milliseconds)
      options.signal.addEventListener('abort', done, { once: true })
    })

  /**
   * 把一行标准输出翻成 Trigger。顺序要紧：先判大小上限（不解析一个超大的 JSON），再解析、
   * 丢弃机器人自己的消息（`feishuTrigger` 里判），最后在实例还开着时交给 Source。
   */
  const receiveLine = (line: string): void => {
    if (line.length > maxEventBytes) {
      report({ state: 'error', detail: 'The Feishu event exceeds 1 MiB' })
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      report({ state: 'error', detail: 'The Feishu event consumer printed a line that is not JSON' })
      return
    }
    const message = feishuEventOf(parsed)
    if (message === undefined) return
    // 读到事件时实例已经关掉：丢弃（消费进程马上也会停，§I.3）。
    if (!options.enabled()) return
    const trigger: Trigger | undefined = feishuTrigger(message, options.bot)
    if (trigger === undefined) return
    // 会话表给回填用：哪些 chat 要读、私聊还是群（§I.3 历史回填行）。
    const known = options.host.state.get(options.keys.chats)
    const chats = typeof known === 'object' && known !== null ? (known as Record<string, unknown>) : {}
    options.host.state.set(options.keys.chats, { ...chats, [message.chatId]: message.chatType === 'p2p' })
    options.host.receive(trigger)
  }

  /** 起一个消费进程，带着就绪超时与看门狗；返回它的退出读数。 */
  const consume = (): ConsumeHandle => {
    let ready = false
    let stopping = false
    let handle: CommandStream | undefined
    let resolveOutcome: (outcome: ConsumeOutcome) => void = () => undefined
    const outcome = new Promise<ConsumeOutcome>((resolve) => {
      resolveOutcome = resolve
    })
    let cancelReady: () => void = () => undefined
    let cancelWatchdog: () => void = () => undefined
    const began = now()

    const stop = (): void => {
      if (stopping) return
      stopping = true
      handle?.stop()
    }

    const finish = (code: number | null): void => {
      cancelReady()
      cancelWatchdog()
      options.signal.removeEventListener('abort', stop)
      resolveOutcome({ ready, code, ranMs: now() - began })
    }

    // 就绪超时：45 s 还没看到就绪行就停掉子进程（§I.3）。
    cancelReady = options.schedule(() => {
      if (ready) return
      log(`the Feishu event consumer did not say ${READY_MARKER} within ${readyTimeoutMs} ms`)
      stop()
    }, readyTimeoutMs)

    try {
      handle = options.commands.stream(options.cli, CONSUMER_ARGS, {
        signal: options.signal,
        onLine: (line) => {
          // 就绪行之前到达的事件不算数（§I.3：就绪之后才算可用）。
          if (!ready) return
          receiveLine(line)
        },
        onDiagnostic: (line) => {
          if (line.startsWith(READY_MARKER)) {
            if (ready) return
            ready = true
            cancelReady()
            report({ state: 'ready', detail: 'Listening for bot events' })
            return
          }
          if (/WARN|warn|drop|error/.test(line)) {
            log(`the Feishu event consumer said: ${line.slice(0, 200)}`)
          }
        },
        onExit: (exit) => finish(exit.code)
      })
    } catch (error) {
      // 起不来（程序不在、白名单拒绝）：先把定时器收回来，再把失败交给循环。
      cancelReady()
      cancelWatchdog()
      throw error
    }

    // 看门狗：每 5 s 看一次实例开关；关掉就停（禁用后 5 s 内停，§I.3）。
    const armWatchdog = (): void => {
      cancelWatchdog = options.schedule(() => {
        if (!options.enabled()) {
          stop()
          return
        }
        armWatchdog()
      }, WATCHDOG_MS)
    }
    armWatchdog()
    options.signal.addEventListener('abort', stop, { once: true })

    return { outcome, stop }
  }

  return {
    async run(): Promise<void> {
      let retry: number | undefined
      let failures = 0
      while (!options.signal.aborted) {
        if (!options.enabled()) {
          report({ state: 'paused', detail: 'The Feishu source is disabled' })
          return
        }
        let result: ConsumeOutcome
        try {
          result = await consume().outcome
        } catch (error) {
          // 起不来（程序缺失、白名单拒绝）：按失败走同一条退避，不让循环热转。
          failures += 1
          const detail = `The Feishu event consumer could not start: ${
            error instanceof Error ? error.message : String(error)
          }`
          report(failures >= FAILURES_BEFORE_ERROR ? { state: 'error', detail } : { state: 'starting', detail })
          log(detail)
          retry = consumerRetry(retry, 0)
          await sleep(retry)
          continue
        }
        if (options.signal.aborted) return
        // 禁用之后不再重启：来源关掉，消费进程就该停（§I.3）。
        if (!options.enabled()) {
          report({ state: 'paused', detail: 'The Feishu source is disabled' })
          return
        }
        if (result.ready) {
          failures = 0
        } else {
          failures += 1
        }
        if (result.code === 0 && result.ready) {
          // 正常结束（事件总线关了、CLI 自己退了）：不算失败，1 s 后接着听。
          report({ state: 'starting', detail: 'The Feishu event consumer exited; restarting' })
          retry = consumerRetry(undefined, 0)
          await sleep(retry)
          continue
        }
        const detail =
          result.code === null
            ? 'The Feishu event consumer ended without an exit code'
            : `The Feishu event consumer exited with code ${result.code}`
        if (failures >= FAILURES_BEFORE_ERROR) report({ state: 'error', detail })
        log(`${detail} (ready=${result.ready}, failures=${failures})`)
        retry = consumerRetry(retry, result.ranMs)
        await sleep(retry)
      }
    }
  }
}

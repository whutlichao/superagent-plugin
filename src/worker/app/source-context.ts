// Source 访问引擎的唯一端口（`sources/kind.ts` 的 `SourceContext`，§C.2 规则 2）：
// 组合根在这里把 Engine、注册表、健康条目与命令端口拼成 kind 能看到的那一份。
//
// kind 拿不到 Engine、Store 或宿主：它只能读自己的配置与 kv、收 Trigger、改自己的 Thread
// meta、报告自己 claim 的 health 条目，以及两次 Ticket 命令（bind / threadClosed）。
import type { HealthEntry, SourceProblem, Trigger } from '../core/index.ts'
import type { CommandsHost } from '../sources/commands.ts'
import type { SourceContext } from '../sources/kind.ts'
import { threadKey } from '../core/index.ts'
import type { EngineForSources } from '../core/index.ts'
import type { Store } from './store.ts'
import { createSourceStoragePorts } from './source-state.ts'
import type { HealthClaim } from '../sources/registry.ts'

/** 一条已解析的 Source 实例（配置已校验；禁用或未安装时为 undefined）。 */
export interface SourceContextInstance {
  readonly id: string
  readonly enabled: boolean
  readonly config: Record<string, unknown>
  /** 这个实例声明的 health 条目在注册表里的 claim。 */
  readonly health: Readonly<Record<string, HealthClaim>>
  readonly problem?: SourceProblem
}

/** 构造依赖：全部注入，函数本身不读时钟、不建定时器。 */
export interface SourceContextOptions {
  readonly engine: EngineForSources
  readonly store: Store
  readonly commands: CommandsHost
  readonly instance: SourceContextInstance
  /** setup 是否已经完成（未完成时 kind 只在 `configured()` 上看到 false）。 */
  readonly configured: () => boolean
  /** 读一条已存的 Trigger（搜索与视图用）。 */
  readonly triggerOf: (id: string) => Trigger | undefined
  /** 面板通知（组合根接 `runtime.notify`）。 */
  readonly notify: (input: { title: string; body?: string }) => void
}

/**
 * 拼一个实例的 `SourceContext`。`report` 只写该实例自己 claim 的条目：写别人 claim 的
 * 条目会静默失败（`HealthClaim.set` 在释放后是空操作，未 claim 的条目不在表里）。
 */
export function createSourceContext(options: SourceContextOptions): SourceContext {
  const ports = createSourceStoragePorts(options.store)
  const { instance } = options
  return {
    ready: instance.enabled && instance.problem === undefined,
    configured: options.configured,
    ...(instance.problem === undefined ? {} : { problem: instance.problem }),
    config<C extends Record<string, unknown>>(kind: string): C | undefined {
      return kind === instance.id ? (instance.config as C) : undefined
    },
    receive(trigger: Trigger) {
      return options.engine.receive(trigger)
    },
    atomic<T>(work: () => T): T {
      return options.store.transaction(work)
    },
    state: {
      get(key: string) {
        return ports.state.read(key) ?? undefined
      },
      set(key: string, value: unknown): void {
        ports.state.write(key, value)
      },
      delete(key: string): void {
        ports.state.delete(key)
      }
    },
    threads: {
      describe(ref) {
        const meta = ports.threads.read(threadKey(ref))
        if (meta === null) return undefined
        const label = meta['label']
        const facts = meta['facts']
        return {
          ...(typeof label === 'string' ? { label } : {}),
          ...(typeof facts === 'object' && facts !== null
            ? { facts: facts as Record<string, unknown> }
            : {})
        }
      },
      patch(ref, meta) {
        const key = threadKey(ref)
        const current = ports.threads.read(key)
        if (current === null) return
        ports.threads.describe(key, { ...current, ...meta })
      }
    },
    tickets: {
      bindThread(ticketId, ref, own) {
        return options.engine.bindThread(ticketId, ref, own)
      },
      threadClosed(ref, outcome, at) {
        options.engine.threadClosed(ref, outcome, at)
      }
    },
    triggers: {
      read: options.triggerOf
    },
    notify: options.notify,
    report(entry: string, health: HealthEntry): void {
      instance.health[entry]?.set(health)
    },
    commands: options.commands
  }
}

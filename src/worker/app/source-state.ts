// Source 的写端口（§D.4 第二行）：Source 只写自己的读位置与 Thread 元数据，
// 不直接写 Trigger/Thread/Decision/Ticket 行。
//
// 两个端口都只做「Source 被允许做的那一件事」：
// - `state`：typed KV（键由 `kv.ts` 的构造函数给出，§D.3「Source 状态」族）；
// - `threads`：只改 `thread.meta`（label/url/facts/pollError），绝不碰 `thread.body`
//   （body 的写者是领域引擎）。
import type { Store } from './store'

/** Source 的读位置/自身状态端口（`SourceContext.state` 的存储侧形状）。 */
export interface SourceStatePort {
  read<T>(key: string): T | null
  write(key: string, value: unknown): void
  delete(key: string): boolean
}

/** Source 的 Thread 元数据端口（`SourceContext.threads.describe` 的存储侧形状）。 */
export interface SourceThreadPort {
  /** 读该 Thread 的 meta；Thread 不存在时为 `null`。 */
  read(threadKey: string): Readonly<Record<string, unknown>> | null
  /** 只替换 meta；Thread 不存在时抛错（Source 不能凭空造 Thread）。 */
  describe(threadKey: string, meta: Readonly<Record<string, unknown>>): void
}

/** Source 拿到的全部存储能力。除此之外它拿不到 Store。 */
export interface SourceStoragePorts {
  readonly state: SourceStatePort
  readonly threads: SourceThreadPort
}

/** 在真库上构造 Source 端口。 */
export function createSourceStoragePorts(store: Store): SourceStoragePorts {
  return {
    state: {
      read<T>(key: string): T | null {
        return store.kvGet<T>(key)
      },
      write(key: string, value: unknown): void {
        store.kvSet(key, value)
      },
      delete(key: string): boolean {
        return store.kvDelete(key)
      }
    },
    threads: {
      read(threadKey) {
        return store.threads.meta(threadKey)
      },
      describe(threadKey, meta) {
        if (store.threads.meta(threadKey) === null) {
          throw new Error(`Source may only describe an existing thread: ${threadKey}`)
        }
        store.threads.describe(threadKey, meta)
      }
    }
  }
}

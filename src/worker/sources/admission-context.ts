// 评估窗口（§I.1 `threadContext` 的读取者、§P.2 的 `admission-context.test.ts`）：按部署
// 设置里的页数与超时，把一条 Trigger 所在 Thread 读成一段**有界**的消息窗口，供评估判断
// 语境；读不到、读不完、超时都要有明确结果，绝不假装完整。
//
// 三种「有界」的语义（与上游 `sources/admission-context.ts` 相同）：
// - 窗口 = Thread 开头 5 条 + Trigger 前后各 5 条；`omittedBefore` / `omittedAfter` 只描述
//   这次读到的快照，不是「还有多少未读」；
// - 最多读 `maxPages` 页；`complete` 为假时 `next` 是继续读的游标；游标重复出现即视为
//   分页坏了，直接报错（否则窗口会无限循环）；
// - 超时是**整个窗口**的时限（`admissionContextTimeoutMs`），不是单页的时限：一次评估的
//   语境读取必须在窗口内结束，超时给出 `timedOut: true` 与已读到的部分，不把异常丢给调用方。
import type { Trigger } from '../core/index.ts'
import type { CommandsHost } from './commands.ts'

/** 一条已归一化的 Thread 消息；`bot` 标记非人发送者（它永远不能单独授权工作）。 */
export interface ContextMessage {
  id: string
  from: string
  at: string
  text: string
  bot?: true
  deleted?: true
  replyTo?: string
  url?: string
  path?: string
  line?: number
}

/** 读的是哪一段：整个 Thread、话题根、或这条消息回复的那一条（§I.1）。 */
export type ContextPartName = 'thread' | 'root' | 'parent'

/** 一页 Thread 语境：消息、下一页游标、Source 自有的原始体与状态说明。 */
export interface ContextPart {
  messages: readonly ContextMessage[]
  next?: string | undefined
  body: Record<string, unknown>
  /** Source 给的旁注，例如 Feishu 没有话题时退化成「聊天邻居」的 `chat_neighbours`。 */
  status?: string
}

/**
 * Thread 语境的读取器（§I.1 `threadContext`）：kind 实现它。`messageId` 说明这条 Trigger
 * 自己的消息在 Thread 里是哪一条，`read` 读一页。图片能力只有支持的 kind 才有。
 */
export interface ThreadContext<C> {
  messageId(trigger: Trigger): string
  read(
    host: CommandsHost,
    trigger: Trigger,
    part: ContextPartName,
    cursor: string | undefined,
    config: C,
    signal: AbortSignal
  ): Promise<ContextPart>
  /** 从正文里认出可读的图片标识；不支持图片的 kind 不实现。 */
  images?(text: string): readonly string[]
  /** 读一张图片，返回落地路径与说明；读不到就报错，绝不猜内容。 */
  image?(
    host: CommandsHost,
    trigger: Trigger,
    imageId: string,
    signal: AbortSignal
  ): Promise<{ path: string; alt: string }>
}

/**
 * 绑定到一条 Trigger 的语境读取器：注册表用「实例配置」把它绑定好，评估只经它读
 * （§C.1 `registry.threadContext`）。调用方只提供命令端口与取消信号。
 */
export interface TriggerContext {
  /** 这条 Trigger 自己的消息 id。 */
  readonly messageId: string
  read(
    host: CommandsHost,
    part: ContextPartName,
    cursor?: string,
    signal?: AbortSignal
  ): Promise<ContextPart>
  images(text: string): readonly string[]
  /** 没有图片能力的 kind 抛错（调用方据此给出「无法读取图片」而不是空内容）。 */
  image(host: CommandsHost, imageId: string, signal: AbortSignal): Promise<{ path: string; alt: string }>
}

/** 窗口里的一条：在 Thread 里的位置（从 1 起）与它前面被略过的条数。 */
export interface WindowEntry {
  message: ContextMessage
  position: number
  omittedBefore: number
}

/** 有界窗口：入口条目、Trigger 是否在快照里、这次读到的条数与尾部略过多少。 */
export interface ThreadWindow {
  entries: readonly WindowEntry[]
  /** 这条 Trigger 的消息在快照里出现过。 */
  sourceFound: boolean
  /** 这次读到的消息总数（只描述快照）。 */
  loadedMessages: number
  /** 窗口最后一条之后还有多少条（只描述快照）。 */
  omittedAfter: number
}

/** 一次评估的语境：消息、窗口、是否读完，以及超时/未读完的游标。 */
export interface AdmissionContext {
  messages: readonly ContextMessage[]
  window: ThreadWindow
  /** 读到了 Thread 的末页。 */
  complete: boolean
  /** 没读完时继续读的游标（读完了是 null）。 */
  next: string | null
  /** Source 给的旁注（例如 `chat_neighbours`）。 */
  status?: string
  /** 超过了部署设置给的时限；此时 `messages` 是已读到的部分。 */
  timedOut: boolean
}

/** 窗口的固定形状：开头 5 条 + Trigger 前后各 5 条（§I.1、上游同名函数）。 */
const HEAD = 5
const AROUND = 5

/** 选中快照里的哪些消息，并按位置交代前后各略过多少。 */
export function threadWindow(messages: readonly ContextMessage[], sourceId: string): ThreadWindow {
  const sourceIndex = messages.findIndex((message) => message.id === sourceId)
  const selected: { message: ContextMessage; index: number }[] = []
  messages.forEach((message, index) => {
    if (index < HEAD || (sourceIndex >= 0 && Math.abs(index - sourceIndex) <= AROUND)) {
      selected.push({ message, index })
    }
  })
  let previous = -1
  const entries: WindowEntry[] = selected.map(({ message, index }) => {
    const omittedBefore = index - previous - 1
    previous = index
    return { message, position: index + 1, omittedBefore }
  })
  return {
    entries,
    sourceFound: sourceIndex >= 0,
    loadedMessages: messages.length,
    omittedAfter: messages.length - previous - 1
  }
}

/** 评估窗口的部署设置（§H.22：页数与超时来自面板的 Deployment 页）。 */
export interface AdmissionSettings {
  /** 一次评估最多读几页 Thread。 */
  readonly maxPages: number
  /** 整个窗口的时限，毫秒。 */
  readonly timeoutMs: number
}

/** 读取中游标重复：说明分页实现坏了，窗口不可能完整。 */
export class PaginationError extends Error {
  readonly cursor: string

  constructor(cursor: string) {
    super(`Thread pagination repeated the cursor ${cursor}; the context is incomplete`)
    this.name = 'PaginationError'
    this.cursor = cursor
  }
}

/**
 * 读一条 Trigger 的评估语境：最多 `maxPages` 页，整个读取限时 `timeoutMs`。消息按 id 去重，
 * 顺序保持 Source 给的顺序（时间序）。超时不抛错，返回已读到的部分与 `timedOut: true`。
 */
export async function admissionContext(
  context: TriggerContext,
  host: CommandsHost,
  settings: AdmissionSettings
): Promise<AdmissionContext> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs)
  const signal = controller.signal
  const messages: ContextMessage[] = []
  const seen = new Set<string>()
  const cursors = new Set<string>()
  let next: string | undefined
  let status: string | undefined
  let timedOut = false
  try {
    for (let page = 0; page < settings.maxPages; page += 1) {
      if (signal.aborted) {
        timedOut = true
        break
      }
      let result: ContextPart
      try {
        result = await context.read(host, 'thread', next, signal)
      } catch (error) {
        // 取消是「窗口到点」，不是失败：把已经读到的部分交回去。
        if (signal.aborted || (error as Error | undefined)?.name === 'AbortError') {
          timedOut = true
          break
        }
        throw error
      }
      for (const message of result.messages) {
        if (seen.has(message.id)) continue
        seen.add(message.id)
        messages.push(message)
      }
      status ??= result.status
      next = result.next
      if (next === undefined) break
      if (cursors.has(next)) throw new PaginationError(next)
      cursors.add(next)
    }
  } finally {
    clearTimeout(timer)
  }
  const window = threadWindow(messages, context.messageId)
  const complete = next === undefined && !timedOut
  return {
    messages,
    window,
    complete,
    next: complete ? null : (next ?? null),
    ...(status === undefined ? {} : { status }),
    timedOut
  }
}

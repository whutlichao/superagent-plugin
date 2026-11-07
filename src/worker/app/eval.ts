// Router 评估面的读模型（§G.2 的 `eval` / `eval-read` 行、§K.2 的候选窗口、§I.1 的
// `threadContext`、§O 的路径限制）。
//
// 两条命令的行为都在这里，只做一次：
// - `eval <trigger_id>`：把一条**正在进行**的推断候选收成有界窗口
//   `{trigger, batch, threadWindow, relatedTickets, ticketsTotal, policyVersion, stubs}`。
//   显式请求走 `route`，不评估；已结束/从未开始的评估给 `not_a_candidate`（§K.7 的语义：
//   决定来晚了是另一条码 `too_late`，那是 `eval-decide` 的事）。
// - `eval-read <trigger_id>`：四种读法二选一——整条消息（`--message-id`）、一张图片
//   （`--image-id`）、一段语境（`--part root|parent|thread`，可带 `--cursor`）、仓库内路径
//   （`--path`）。语境走 kind 的 `threadContext.read`，图片走 `threadContext.image`，路径走
//   `app/repo-read.ts` 的包含判定。
//
// 窗口的截断规则与上游 MasterAssessor 相同（§I.1 的窗口 + `runtime/admission` 的提示词）：
// 开头 5 条 + Trigger 前后各 5 条；Trigger 自己最多 4000 字符、最近两条邻居 1200、其余窗口
// 消息 400，被截断的带全文长度；窗口之外已加载的消息只给一行 stub 预览（50 字符）。按 id
// 读整条消息因此总有去处，而窗口本身不会撑爆 Router 的上下文。
//
// 读缓存按 `evalId` 留在进程内（与上游同一取舍）：一次评估里先 `eval` 再若干次 `eval-read`
// 只加载一次语境；worker 重启后缓存消失，重新 `eval` 即可。缓存不按 Trigger 分键——同批的
// 每条 Trigger 看到同一份语境。
//
// 依赖纪律（§C.2）：本文件在 `app/`，import 领域类型、`sources/` 的语境读取端口与
// `app/repo-read.ts`；不 import `http/`、不读时钟、不起子进程。
import { threadKey } from '../core/index.ts'
import type { Candidate, Strength, Ticket, Trigger } from '../core/index.ts'
import {
  admissionContext,
  type AdmissionContext,
  type AdmissionSettings,
  type ContextMessage,
  type ContextPartName,
  type TriggerContext
} from '../sources/admission-context.ts'
import type { CommandsHost } from '../sources/commands.ts'
import { readRepoPath, REPO_READ_MAX_BYTES, RepoReadError } from './repo-read.ts'

/** Trigger 自己的正文上限（§I.1 的窗口：一条 Trigger 只出现一次）。 */
export const EVAL_TRIGGER_CHARS = 4000
/** Trigger 前后各两条邻居的上限（更近，更可能相关）。 */
export const EVAL_NEAR_CHARS = 1200
/** 其余窗口消息的上限。 */
export const EVAL_WINDOW_CHARS = 400
/** 窗口之外、已加载消息的 stub 预览上限。 */
export const EVAL_STUB_CHARS = 50
/** 窗口里列出相关 Ticket 的上限（与候选卡一致）。 */
export const EVAL_TICKETS_LIMIT = 8
/** 进程内保留多少次评估的读缓存（忙碌时的上限；超出按最旧淘汰）。 */
export const EVAL_READ_CACHE_EVALS = 32

/** `eval` / `eval-read` 的固定拒绝码（§G.2 的两行；`refused` 是 §O 的路径拒绝）。 */
export type EvalRefusalCode =
  | 'not_a_candidate'
  | 'missing'
  | 'too_large'
  | 'refused'
  | 'invalid_params'
  | 'unavailable'

/** 一条被拒的评估读；`values` 只放填槽值。 */
export interface EvalRefusal {
  readonly ok: false
  readonly code: EvalRefusalCode
  readonly message: string
  readonly values?: Readonly<Record<string, string>>
}

/** 一条 Trigger 在窗口里的投影。 */
export interface EvalTriggerLine {
  readonly triggerId: string
  readonly source: string
  readonly actor: string
  readonly human: boolean
  readonly at: string
  /** primary thread 的键。 */
  readonly thread: string
  readonly strength: Strength
  /** 正文；长于 `EVAL_TRIGGER_CHARS` 时截断并以 `truncated` 标记。 */
  readonly text: string
  /** 正文的完整长度（字符）。 */
  readonly chars: number
  readonly truncated?: true
  readonly url?: string
  /** 这条 Trigger 自己的消息里的图片 id（`<message-id>/<key>`，交给 `eval-read --image-id`）。 */
  readonly images?: readonly string[]
}

/** 同批其余 Trigger 的投影。 */
export interface EvalBatchLine {
  readonly triggerId: string
  readonly actor: string
  readonly at: string
  readonly text: string
  /** 被截断时的全文长度。 */
  readonly chars?: number
  readonly truncated?: true
}

/** 窗口里的（或按 id 读到的）一条消息。 */
export interface EvalMessageLine {
  readonly id: string
  readonly from: string
  readonly at: string
  readonly bot?: true
  readonly deleted?: true
  /** Trigger 自己的那条消息：正文在窗口顶部的 `trigger.text` 里，不重复。 */
  readonly trigger?: true
  /** 它在 Thread 里的位置（从 1 起）。 */
  readonly position?: number
  /** 它前面被略过的条数（0 表示紧接上一条）。 */
  readonly omittedBefore?: number
  readonly url?: string
  readonly replyTo?: string
  readonly path?: string
  readonly line?: number
  readonly text?: string
  /** 被截断时的全文长度。 */
  readonly chars?: number
  readonly truncated?: true
  readonly images?: readonly string[]
}

/** 窗口之外、已加载的一条消息：只给长度与一行预览，按 id 读整条。 */
export interface EvalStubLine {
  readonly id: string
  readonly from: string
  readonly at: string
  readonly chars: number
  readonly preview: string
}

/** 有界 Thread 窗口（§I.1：开头 5 条 + Trigger 前后各 5 条，只描述这次读到的快照）。 */
export interface EvalThreadWindow {
  readonly complete: boolean
  readonly loadedMessages: number
  readonly sourceFound: boolean
  /** 没读完时继续读的游标（`eval-read --part thread --cursor`）。 */
  readonly next?: string
  readonly messages: readonly EvalMessageLine[]
  /** 读不到语境时的说明（窗口为空，但评估仍可用 Trigger 自己的正文）。 */
  readonly error?: string
}

/** 排序与投影只需要这几个字段（纯函数因此接受 `Ticket` 或它的子集）。 */
export type EvalTicketInput = Pick<Ticket, 'id' | 'title' | 'createdAt' | 'ended'>

/** 一条相关 Ticket（该 Thread 上的，含已结束的）。 */
export interface EvalTicketLine {
  readonly ticketId: string
  readonly title: string
  /** `open`，或结束时的结局（completed / merged / closed / dropped / stopped，§E.8）。 */
  readonly state: string
}

/** `eval` 的结果：候选窗口的七个字段（§G.2）。 */
export interface EvalWindow {
  readonly trigger: EvalTriggerLine
  readonly batch: readonly EvalBatchLine[]
  readonly threadWindow: EvalThreadWindow
  readonly relatedTickets: readonly EvalTicketLine[]
  readonly ticketsTotal: number
  /** 创建这次 Eval 的 Policy 版本；与 `eval-decide` 校验的是同一个（§K.5）。 */
  readonly policyVersion: string
  readonly stubs: readonly EvalStubLine[]
}

/** `eval` 的结局。 */
export type EvalWindowResult = { readonly ok: true; readonly window: EvalWindow } | EvalRefusal

/** `eval-read` 的四种读法（恰好一种；`cursor` 只属于 `part=thread`）。 */
export interface EvalReadRequest {
  readonly messageId?: string
  readonly imageId?: string
  readonly part?: ContextPartName
  readonly cursor?: string
  readonly path?: string
}

/** 一张读到的图片：落地路径 + 说明（§H.17：Router 用自己的读图工具）。 */
export interface EvalImage {
  readonly path: string
  readonly alt: string
}

/** 一次读到的仓库路径：命中的根、种类、正文与字符数。 */
export interface EvalPathRead {
  readonly root: string
  readonly path: string
  readonly kind: 'file' | 'directory'
  readonly chars: number
  readonly text: string
}

/** `eval-read` 的结果：只有被读到的那一项（§G.2 的 `{messages?, message?, image?, next?, path?}`）。 */
export interface EvalReadPayload {
  readonly messages?: readonly EvalMessageLine[]
  readonly message?: EvalMessageLine
  readonly image?: EvalImage
  readonly next?: string | null
  readonly status?: string
  readonly path?: EvalPathRead
}

/** `eval-read` 的结局。 */
export type EvalReadResult = { readonly ok: true; readonly result: EvalReadPayload } | EvalRefusal

/** 一次读必须恰好给一种读法（`--message-id` / `--image-id` / `--part` / `--path`）。 */
export const EVAL_READ_FORMS = ['messageId', 'imageId', 'part', 'path'] as const

/** 一条已加载消息的缓存：消息本身、游标与那次评估的语境。 */
interface Reads {
  readonly evalId: string
  readonly messages: Map<string, ContextMessage>
  readonly cursors: Set<string>
  context?: AdmissionContext
  loading: Promise<AdmissionContext> | undefined
}

/** 读工具需要的宿主端口（组合根注入；测试用替身）。 */
export interface EvalToolHost {
  /** 持有这条 Trigger 的那次 Eval 的候选；没有时 undefined。 */
  readonly candidate: (triggerId: string) => Candidate | undefined
  /** 一条已存的 Trigger（区分 `missing` 与 `not_a_candidate`）。 */
  readonly trigger: (triggerId: string) => Trigger | undefined
  /** 这条 Trigger 所属 kind 的语境读取器；Source 没有语境能力时 undefined。 */
  readonly threadContext: (trigger: Trigger) => TriggerContext | undefined
  /** Source 命令端口（语境读取用；唯一的 CLI 出口，§I.4）。 */
  readonly commands: CommandsHost
  /** 评估窗口的页数与超时（部署设置，§H.22）。 */
  readonly admission: () => AdmissionSettings
  /** `--path` 允许的根：base repo（若设置给了路径）与全部 Ticket worktree（§O）。 */
  readonly roots: () => readonly string[]
  /** 内部失败的日志出口（不回显给调用方）。 */
  readonly log?: (message: string) => void
}

/** HTTP 与 CLI 共用的两条读命令。 */
export interface EvalTools {
  window(triggerId: string, options?: EvalReadOptions): Promise<EvalWindowResult>
  read(triggerId: string, request: EvalReadRequest, options?: EvalReadOptions): Promise<EvalReadResult>
}

/**
 * 一次读的取消线（§O）：HTTP handler 的预算到点就取消它，`contextOf` / `source.read` /
 * `source.image` 的每一次 CLI 读取都把同一个信号交给 `CommandsHost`（子进程因此被 SIGTERM）。
 * 不给就是 CLI 与启动路径的老行为（一次读照旧有 `admissionContextTimeoutMs` 的单次上限）。
 */
export interface EvalReadOptions {
  readonly signal?: AbortSignal
}

/** 截断一段正文：短的原样、长的切到 `limit` 并带全文长度（上游 `cut` 同义）。 */
function cut(
  text: string,
  limit: number
): { readonly text: string; readonly chars?: number; readonly truncated?: true } {
  if (text.length <= limit) return { text }
  return { text: `${text.slice(0, limit)}…`, chars: text.length, truncated: true }
}

/** 一行预览：压缩空白、截到 `EVAL_STUB_CHARS`。 */
function stubPreview(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, EVAL_STUB_CHARS)
}

/** 相关 Ticket 的排序：开着的在前，同组内新的在前（上游 `relatedTickets` 的规则）。 */
function relatedOrder(left: EvalTicketInput, right: EvalTicketInput): number {
  if (Number(!left.ended) !== Number(!right.ended)) return left.ended ? 1 : -1
  return right.createdAt.localeCompare(left.createdAt)
}

/**
 * 相关 Ticket：开着的在前、同组内新的在前，最多 `EVAL_TICKETS_LIMIT` 条（上游 `relatedTickets`
 * 的排序规则），另给总数让模型知道还有多少。
 */
export function evalTicketLines(tickets: readonly EvalTicketInput[]): {
  readonly relatedTickets: readonly EvalTicketLine[]
  readonly ticketsTotal: number
} {
  const order = [...tickets].sort(relatedOrder)
  return {
    relatedTickets: order.slice(0, EVAL_TICKETS_LIMIT).map((ticket) => ({
      ticketId: ticket.id,
      title: ticket.title,
      state: ticket.ended?.outcome ?? 'open'
    })),
    ticketsTotal: tickets.length
  }
}

/** 一条 `ContextMessage` → 窗口里的一行（正文按位置截断，`trigger` 只标位置）。 */
function windowLine(
  message: ContextMessage,
  input: {
    readonly index: number
    readonly sourceIndex: number
    readonly position: number
    readonly omittedBefore: number
    readonly images: (messageId: string, text: string) => readonly string[]
  }
): EvalMessageLine {
  const base = {
    id: message.id,
    from: message.from,
    at: message.at,
    position: input.position,
    omittedBefore: input.omittedBefore,
    ...(message.bot === true ? { bot: true as const } : {}),
    ...(message.url === undefined ? {} : { url: message.url })
  }
  if (message.deleted === true) return { ...base, deleted: true }
  const images = input.images(message.id, message.text)
  const near = input.sourceIndex >= 0 && Math.abs(input.index - input.sourceIndex) <= 2
  return {
    ...base,
    ...cut(message.text, near ? EVAL_NEAR_CHARS : EVAL_WINDOW_CHARS),
    ...(images.length === 0 ? {} : { images })
  }
}

/**
 * 把一次评估的候选收成窗口（纯函数：只读入参，不读时钟、不读盘）。语境可以缺席（Source 没有
 * `threadContext` 或读失败）：那时窗口为空、`error` 说明原因，`trigger` 与 `batch` 照常。
 */
export function evalWindowOf(input: {
  readonly candidate: Candidate
  readonly trigger: Trigger
  readonly context?: AdmissionContext | undefined
  readonly sourceMessageId?: string | undefined
  readonly images: (messageId: string, text: string) => readonly string[]
  readonly error?: string | undefined
}): EvalWindow {
  const { candidate, trigger } = input
  const ownMessageId = input.sourceMessageId ?? trigger.id
  const triggerCut = cut(trigger.text, EVAL_TRIGGER_CHARS)
  const triggerImages = input.images(ownMessageId, trigger.text)
  const batch = candidate.triggers
    .filter((item) => item.id !== trigger.id)
    .map((item) => {
      const text = cut(item.text, EVAL_WINDOW_CHARS)
      return {
        triggerId: item.id,
        actor: item.actor.id,
        at: item.at,
        ...text
      }
    })
  const tickets = evalTicketLines(candidate.tickets)
  const context = input.context
  const sourceIndex =
    context === undefined || input.sourceMessageId === undefined
      ? -1
      : context.messages.findIndex((message) => message.id === input.sourceMessageId)
  const shown = new Map(
    context === undefined
      ? []
      : context.window.entries.map((entry) => [entry.message.id, entry] as const)
  )
  const messages: EvalMessageLine[] = []
  const stubs: EvalStubLine[] = []
  for (const [index, message] of (context?.messages ?? []).entries()) {
    const entry = shown.get(message.id)
    if (entry === undefined) {
      stubs.push({
        id: message.id,
        from: message.from,
        at: message.at,
        chars: message.text.length,
        preview: stubPreview(message.text)
      })
      continue
    }
    if (index === sourceIndex) {
      // Trigger 自己的正文在窗口顶部的 `trigger.text` 里：这里只标位置与图片。
      const images = input.images(message.id, message.text)
      messages.push({
        id: message.id,
        from: message.from,
        at: message.at,
        ...(message.bot === true ? { bot: true as const } : {}),
        trigger: true,
        position: entry.position,
        omittedBefore: entry.omittedBefore,
        ...(images.length === 0 ? {} : { images })
      })
      continue
    }
    messages.push(
      windowLine(message, {
        index,
        sourceIndex,
        position: entry.position,
        omittedBefore: entry.omittedBefore,
        images: input.images
      })
    )
  }
  const threadWindow: EvalThreadWindow =
    context === undefined
      ? {
          complete: false,
          loadedMessages: 0,
          sourceFound: false,
          messages: [],
          error:
            input.error ??
            'This Source gives no Thread context; assess the trigger text and the batch.'
        }
      : {
          complete: context.complete,
          loadedMessages: context.messages.length,
          sourceFound: context.window.sourceFound,
          ...(context.next === null ? {} : { next: context.next }),
          messages,
          ...(input.error === undefined ? {} : { error: input.error })
        }
  return {
    trigger: {
      triggerId: trigger.id,
      source: trigger.source,
      actor: trigger.actor.id,
      human: trigger.human,
      at: trigger.at,
      thread: threadKey(trigger.threads[0]!),
      strength: candidate.strength,
      text: triggerCut.text,
      chars: trigger.text.length,
      ...(triggerCut.truncated === true ? { truncated: true as const } : {}),
      ...(trigger.url === undefined ? {} : { url: trigger.url }),
      ...(triggerImages.length === 0 ? {} : { images: triggerImages })
    },
    batch,
    threadWindow,
    relatedTickets: tickets.relatedTickets,
    ticketsTotal: tickets.ticketsTotal,
    policyVersion: candidate.policyVersion,
    stubs
  }
}

/** 一条已加载消息 → 整条读的形状（图片 id 一并列出，按 id 读图因此有去处）。 */
function messagePayload(
  message: ContextMessage,
  images: (messageId: string, text: string) => readonly string[]
): EvalMessageLine {
  const found = message.deleted === true ? [] : images(message.id, message.text)
  return {
    id: message.id,
    from: message.from,
    at: message.at,
    ...(message.bot === true ? { bot: true as const } : {}),
    ...(message.deleted === true ? { deleted: true as const } : {}),
    ...(message.url === undefined ? {} : { url: message.url }),
    ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
    ...(message.path === undefined ? {} : { path: message.path }),
    ...(message.line === undefined ? {} : { line: message.line }),
    text: message.text,
    ...(found.length === 0 ? {} : { images: found })
  }
}

/** 一条读法的固定拒绝：`values.reason` 是可判定的原因，文案只给人看。 */
function refuse(
  code: EvalRefusalCode,
  message: string,
  values?: Readonly<Record<string, string>>
): EvalRefusal {
  return values === undefined ? { ok: false, code, message } : { ok: false, code, message, values }
}

/** 一次读的形态校验：恰好一种读法，`cursor` 只属于 `part=thread`。 */
export function validateEvalRead(request: EvalReadRequest): EvalRefusal | undefined {
  const chosen = EVAL_READ_FORMS.filter((form) => {
    const value = request[form]
    return value !== undefined && value !== ''
  })
  if (chosen.length !== 1) {
    return refuse(
      'invalid_params',
      'eval-read takes exactly one of --message-id, --image-id, --part, --path',
      { forms: EVAL_READ_FORMS.join(',') }
    )
  }
  if (request.cursor !== undefined && request.cursor !== '' && request.part !== 'thread') {
    return refuse('invalid_params', '--cursor belongs to --part thread', { flag: 'cursor' })
  }
  return undefined
}

/** 一次评估里的读状态：按 `evalId` 缓存加载过的消息与游标（重启即丢，重新 `eval` 即可）。 */
interface EvalReads {
  readonly byEval: Map<string, Reads>
}

/**
 * 造两条评估读命令。`window` 在有语境时先加载一次有界语境（并存进缓存）；`read` 的
 * `--message-id` 先查缓存、查不到再加载，`--part` 的游标只在本次评估里成立。
 */
export function createEvalTools(host: EvalToolHost): EvalTools {
  const cache: EvalReads = { byEval: new Map() }

  /** 一条 Trigger 的活跃候选；`missing` 与 `not_a_candidate` 在这里分清。 */
  const live = (
    triggerId: string
  ): { readonly ok: true; readonly candidate: Candidate; readonly trigger: Trigger } | EvalRefusal => {
    const trigger = host.trigger(triggerId)
    if (trigger === undefined) {
      return refuse('missing', 'No such trigger', { trigger: triggerId })
    }
    const candidate = host.candidate(triggerId)
    if (candidate === undefined) {
      return refuse(
        'not_a_candidate',
        'This trigger is not being assessed: it was decided, timed out, never reached assessment, or is routed instead',
        { trigger: triggerId, reason: 'not_assessing' }
      )
    }
    const held = candidate.triggers.find((item) => item.id === triggerId)
    if (held === undefined) {
      return refuse('not_a_candidate', 'This trigger is not part of the open assessment', {
        trigger: triggerId,
        reason: 'not_in_batch'
      })
    }
    if (candidate.strength === 'explicit') {
      return refuse(
        'not_a_candidate',
        'An explicit request is routed, not assessed: use `superagent route` with its trigger id',
        { trigger: triggerId, reason: 'explicit' }
      )
    }
    return { ok: true, candidate, trigger: held }
  }

  /** 一条评估的读缓存；先放 Trigger 自己的正文（语境加载后以 Source 的正文为准）。 */
  const readsFor = (candidate: Candidate, trigger: Trigger, source: TriggerContext | undefined): Reads => {
    const existing = cache.byEval.get(candidate.evalId)
    if (existing !== undefined) return existing
    const messages = new Map<string, ContextMessage>()
    messages.set(source?.messageId ?? trigger.id, {
      id: source?.messageId ?? trigger.id,
      from: trigger.actor.id,
      at: trigger.at,
      text: trigger.text,
      ...(trigger.human ? {} : { bot: true as const }),
      ...(trigger.url === undefined ? {} : { url: trigger.url })
    })
    const reads: Reads = {
      evalId: candidate.evalId,
      messages,
      cursors: new Set(),
      loading: undefined
    }
    cache.byEval.set(candidate.evalId, reads)
    // 忙碌时按插入顺序淘汰最旧的一次评估。
    for (const key of cache.byEval.keys()) {
      if (cache.byEval.size <= EVAL_READ_CACHE_EVALS) break
      cache.byEval.delete(key)
    }
    return reads
  }

  /** 加载一次有界语境（同一次评估里只读一次；失败不缓存，重试可能成功）。 */
  const contextOf = async (
    reads: Reads,
    source: TriggerContext,
    commands: CommandsHost
  ): Promise<AdmissionContext> => {
    if (reads.context !== undefined) return reads.context
    // `commands` 已经绑好这次读的取消线（调用方按 `options.signal` 绑的）：语境读取的每一次
    // CLI 调用都带着它。
    reads.loading ??= admissionContext(source, commands, host.admission())
      .then((context) => {
        reads.context = context
        for (const message of context.messages) {
          if (message.deleted === true) continue
          reads.messages.set(message.id, message)
        }
        if (context.next) reads.cursors.add(context.next)
        return context
      })
      .finally(() => {
        reads.loading = undefined
      })
    return reads.loading
  }

  /** 一次 Source 读失败 → 可重试的 `unavailable`（细节只进日志，不回显）。 */
  const unavailable = (what: string, error: unknown): EvalRefusal => {
    host.log?.(`eval-read ${what} failed: ${String(error)}`)
    return refuse(
      'unavailable',
      'The Source could not read this now; retry in a moment',
      { reason: 'context_unavailable' }
    )
  }

  /** 图片 id（`<message-id>/<key>`）必须来自一条已加载消息的正文，不接受任意远端 id。 */
  const imageRead = async (
    reads: Reads,
    source: TriggerContext,
    trigger: Trigger,
    imageId: string,
    commands: CommandsHost,
    signal: AbortSignal
  ): Promise<EvalReadResult> => {
    const slash = imageId.indexOf('/')
    if (slash <= 0 || slash === imageId.length - 1) {
      return refuse('missing', 'Unknown image id; copy one the window lists', {
        reason: 'unknown_image'
      })
    }
    const messageId = imageId.slice(0, slash)
    const key = imageId.slice(slash + 1)
    let message = reads.messages.get(messageId)
    if (message === undefined) {
      try {
        await contextOf(reads, source, commands)
      } catch (error) {
        return unavailable('image', error)
      }
      message = reads.messages.get(messageId)
    }
    if (message === undefined || !source.images(message.text).includes(key)) {
      return refuse('missing', 'Unknown image id; read the thread and copy an image id it lists', {
        reason: 'unknown_image',
        trigger: trigger.id
      })
    }
    try {
      const image = await source.image(commands, imageId, signal)
      return { ok: true, result: { image: { path: image.path, alt: image.alt } } }
    } catch (error) {
      host.log?.(`eval-read image ${imageId} failed: ${String(error)}`)
      return refuse('unavailable', 'The image could not be read now; retry in a moment', {
        reason: 'image_unavailable'
      })
    }
  }

  return {
    async window(triggerId: string, options?: EvalReadOptions): Promise<EvalWindowResult> {
      const signal = options?.signal
      const commands = signal === undefined ? host.commands : host.commands.withSignal(signal)
      const found = live(triggerId)
      if (!found.ok) return found
      const { candidate, trigger } = found
      const source = host.threadContext(trigger)
      const images = (messageId: string, text: string): readonly string[] =>
        (source?.images(text) ?? []).map((key) => `${messageId}/${key}`)
      if (source === undefined) {
        return { ok: true, window: evalWindowOf({ candidate, trigger, images }) }
      }
      const reads = readsFor(candidate, trigger, source)
      try {
        const context = await contextOf(reads, source, commands)
        return {
          ok: true,
          window: evalWindowOf({
            candidate,
            trigger,
            context,
            sourceMessageId: source.messageId,
            images
          })
        }
      } catch (error) {
        host.log?.(`eval ${triggerId} could not read its thread context: ${String(error)}`)
        return {
          ok: true,
          window: evalWindowOf({
            candidate,
            trigger,
            images,
            sourceMessageId: source.messageId,
            error: `Thread context unavailable: ${String(error).slice(0, 300)}`
          })
        }
      }
    },

    async read(
      triggerId: string,
      request: EvalReadRequest,
      options?: EvalReadOptions
    ): Promise<EvalReadResult> {
      const signal = options?.signal
      const commands = signal === undefined ? host.commands : host.commands.withSignal(signal)
      // `source.image` 要一个必填的信号：没给预算时就是一条不会被取消的线（与 #65 之前一致）。
      const readSignal = signal ?? new AbortController().signal
      const invalid = validateEvalRead(request)
      if (invalid !== undefined) return invalid
      const found = live(triggerId)
      if (!found.ok) return found
      const { candidate, trigger } = found
      const source = host.threadContext(trigger)
      const images = (messageId: string, text: string): readonly string[] =>
        (source?.images(text) ?? []).map((key) => `${messageId}/${key}`)
      if (request.path !== undefined) {
        try {
          const read = readRepoPath({ path: request.path, roots: host.roots() })
          return {
            ok: true,
            result: {
              path: {
                root: read.root,
                path: read.path,
                kind: read.kind,
                chars: read.chars,
                text: read.text
              }
            }
          }
        } catch (error) {
          if (error instanceof RepoReadError) {
            return refuse(error.code, error.message, error.values)
          }
          throw error
        }
      }
      if (source === undefined) {
        return refuse('missing', 'This Source gives no Thread context to read', {
          reason: 'no_context',
          trigger: trigger.id
        })
      }
      const reads = readsFor(candidate, trigger, source)
      if (request.imageId !== undefined) {
        return imageRead(reads, source, trigger, request.imageId, commands, readSignal)
      }
      if (request.messageId !== undefined) {
        let message = reads.messages.get(request.messageId)
        if (message === undefined) {
          try {
            await contextOf(reads, source, commands)
          } catch (error) {
            return unavailable('message', error)
          }
          message = reads.messages.get(request.messageId)
        }
        if (message === undefined) {
          return refuse('missing', 'Unknown message id; read the thread and copy an id it lists', {
            reason: 'unknown_message',
            trigger: trigger.id
          })
        }
        const chars = message.text.length
        if (chars > REPO_READ_MAX_BYTES) {
          return refuse('too_large', `The message is larger than ${REPO_READ_MAX_BYTES} bytes`, {
            limit: String(REPO_READ_MAX_BYTES),
            chars: String(chars)
          })
        }
        return { ok: true, result: { message: messagePayload(message, images) } }
      }
      // 剩下的一种：`--part`（`root` / `parent` / `thread`，`thread` 可带 `--cursor`）。
      const part = request.part as ContextPartName
      const cursor = request.cursor === '' ? undefined : request.cursor
      if (cursor !== undefined && !reads.cursors.has(cursor)) {
        return refuse(
          'missing',
          'Unknown cursor for this assessment; start from `superagent eval <trigger_id>` and copy a returned cursor',
          { reason: 'unknown_cursor', trigger: trigger.id }
        )
      }
      try {
        const page = await source.read(commands, part, cursor, readSignal)
        const chars = page.messages.reduce((total, message) => total + message.text.length, 0)
        if (chars > REPO_READ_MAX_BYTES) {
          return refuse('too_large', `The page is larger than ${REPO_READ_MAX_BYTES} bytes`, {
            limit: String(REPO_READ_MAX_BYTES),
            chars: String(chars)
          })
        }
        for (const message of page.messages) {
          if (message.deleted === true) continue
          reads.messages.set(message.id, message)
        }
        if (page.next) reads.cursors.add(page.next)
        return {
          ok: true,
          result: {
            messages: page.messages.map((message) => messagePayload(message, images)),
            ...(page.next === undefined ? {} : { next: page.next }),
            ...(page.status === undefined ? {} : { status: page.status })
          }
        }
      } catch (error) {
        return unavailable(`part ${part}`, error)
      }
    }
  }
}

// 向 Router 终端投递（§F.2、§H.14）：`relay` 与 `notice` 两种 effect 的 handler，以及
// 「一次一条、先进先出」的唯一互斥。
//
// 三件事只在这里做：
// 1. **渲染**：终端只收一行结构化短消息（`[superagent relay #<seq>] … — read: <file>`）；
//    长文一律落盘（`<stateDir>/relay/<seq>.md`，保留 `retention.relayDays` 天）。终端吞长
//    文本会断行/重复提交（附录 C S1），所以单行是纪律，不是风格。
// 2. **串行**：`relay` 与 `notice` 共用同一个 FIFO 互斥——上一行没有被终端接受之前，下一行
//    不写。effect 队列自己也保证 router 类 kind 不并发（§J.2），这层互斥是第二道闸：即使
//    两个 kind 被同时调度，写入顺序也与调用顺序一致。
// 3. **不丢**：终端不在、`sendText` 拒绝、传输失败一律**抛错**——effect 层按 2 s→60 s 退避
//    重试，失败的 relay 挡在同 kind 的队头（`ordered`）；这里绝不 drop、绝不改 payload。
//
// 依赖纪律（§C.2）：本文件只 import `OrcaRuntime` 接口与 `node:` 内置模块；不 import
// `app/effects`（队列形状由 `handlers()` 的签名给出），也不 import executor。
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OrcaRuntime } from '../runtime/orca-runtime.ts'

/** relay 正文的目录名（`<stateDir>/relay`，§D.5）。 */
export const RELAY_DIR = 'relay'

/** 正文保留天数（§F.2 的 `retention.relayDays` 缺省值）。 */
export const DEFAULT_RELAY_RETENTION_DAYS = 7

/** 终端那一行里摘要的最大字符数：完整正文在文件里，行内只留够判断的一段。 */
export const RELAY_INLINE_MAX = 200

/** 一条 relay：与 `app/effects.ts` 的 `EffectPayloads['relay']` 同形状（不 import 它）。 */
export interface RelayMessage {
  readonly messageId: string
  readonly kind: string
  readonly summary: string
  /** 已经写好的长文路径；缺省写到 `<stateDir>/relay/<seq>.md`。 */
  readonly file?: string
}

/** 一条 notice：无长文，只有一句。 */
export interface NoticeMessage {
  readonly summary: string
  readonly value?: Readonly<Record<string, unknown>>
}

/**
 * 一张候选卡：正文（Markdown）落盘为 `relay/<name>.md`，终端只收一行指针。
 * 与 `app/notices.ts` 的 `RouterCard` 同形状（不 import 它：本文件不依赖 app 层的实现）。
 */
export interface RouterCardMessage {
  readonly name: string
  readonly summary: string
  readonly body: string
}

/** 三种 kind 的 handler 形状（组合根把它们接到 effect 队列上）。 */
export interface RouterRelayHandlers {
  readonly relay: (payload: RelayMessage, key: string) => Promise<void>
  readonly notice: (payload: NoticeMessage, key: string) => Promise<void>
  /** 候选卡（`assessment` 的送达）：与 relay/notice 共用同一条串行链（§J.2 末注）。 */
  readonly card: (payload: RouterCardMessage) => Promise<void>
}

/** relay 的依赖：宿主、状态目录、当前终端与队列序号，全部注入。 */
export interface RouterRelayOptions {
  readonly runtime: OrcaRuntime
  readonly stateDir: string
  /** 当前 Router 终端；没有可用终端时返回 `null`（发送因此失败并被重试，绝不丢）。 */
  readonly terminal: () => string | null
  /**
   * 队列里那一行的 `seq`（持久、单调）：正文文件名与消息编号都用它，重启不重号。
   * 没有行时返回 `null`（直接用调用方的 `messageId` 作文件名与编号）。
   */
  readonly sequence: (kind: 'relay' | 'notice') => number | null
  readonly now?: () => number
  /** `retention.relayDays`；缺省 7 天（§F.2）。 */
  readonly retentionDays?: number
  readonly log?: (message: string) => void
}

/** 一个 relay 投递器：两个 handler + 正文清理。 */
export interface RouterRelay {
  handlers(): RouterRelayHandlers
  /** 删掉超过保留期的正文；返回删掉的文件数。启动时调一次即可（§F.2）。 */
  prune(): number
}

/** `<stateDir>/relay/<name>.md`。 */
export function relayFilePath(stateDir: string, name: string): string {
  return join(stateDir, RELAY_DIR, `${name}.md`)
}

/** 压成一行：relay 的终端消息绝不能被换行拆成多次提交（附录 C S1）。 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 行内摘要：超长时截断并留省略号，全文仍在正文文件里。 */
function inline(summary: string): string {
  const line = oneLine(summary)
  return line.length <= RELAY_INLINE_MAX ? line : `${line.slice(0, RELAY_INLINE_MAX - 1)}…`
}

/** 队列序号或 `messageId` 派生的稳定名字（文件与消息编号共用）。 */
function relayName(payload: RelayMessage, sequence: number | null): string {
  if (sequence !== null) return String(sequence)
  return payload.messageId.replace(/[^A-Za-z0-9_-]+/g, '-')
}

/** 终端那一行：一行摘要 + 文件指针（§F.2 的格式）。 */
export function relayLine(name: string, payload: RelayMessage, file: string): string {
  return `[superagent relay #${name}] ${payload.kind} · ${inline(payload.summary)} — read: ${file}`
}

/** 一条 notice 的终端行。 */
export function noticeLine(payload: NoticeMessage): string {
  return `[superagent] ${oneLine(payload.summary)}`
}

/** 文件与编号用的安全名字：候选卡的名字来自我们自己的 `eval-<hex>`，这里仍只放行安全字符。 */
function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]+/g, '-')
}

/** 候选卡的终端行：一行摘要 + 文件指针（与 relay 同形，§F.2）。 */
export function cardLine(name: string, summary: string, file: string): string {
  return `[superagent eval #${name}] candidate · ${inline(summary)} — read: ${file}`
}

/** 正文文件的内容：头部事实 + 原样的长文（不做换行压缩）。 */
export function relayBody(payload: RelayMessage, at: number): string {
  return [
    `# Relay ${payload.messageId}`,
    '',
    `- kind: ${payload.kind}`,
    `- at: ${new Date(at).toISOString()}`,
    '',
    payload.summary,
    ''
  ].join('\n')
}

/**
 * 建一个 relay 投递器。三个 kind（relay/notice/候选卡）共用 `#tail` 这一条串行链：`send`
 * 在上一件结束后才开始，即使上一件失败也继续（失败已经记在 effect 行上，后面的仍要按顺序
 * 尝试）。候选卡与 relay/notice 都是往 Router 终端写，因此同一个互斥（§J.2 末注）。
 */
export function createRouterRelay(options: RouterRelayOptions): RouterRelay {
  const now = options.now ?? (() => Date.now())
  const retentionDays = options.retentionDays ?? DEFAULT_RELAY_RETENTION_DAYS
  const log = options.log ?? (() => undefined)
  let tail: Promise<unknown> = Promise.resolve()

  /** 串到链尾：无论上一件成功还是失败，这一件都在它之后开始。 */
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work, work)
    tail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  /** 把一行写进 Router 终端；没有终端或终端拒绝都抛错（交给 effect 退避重试）。 */
  const write = async (text: string): Promise<void> => {
    const terminalId = options.terminal()
    if (terminalId === null) throw new Error('the router terminal is not available; the relay will be retried')
    const result = await options.runtime.sendText(terminalId, text, { enter: true })
    if (!result.accepted) throw new Error('the router terminal did not accept the relay; it will be retried')
  }

  const relay = (payload: RelayMessage): Promise<void> =>
    exclusive(async () => {
      const name = relayName(payload, options.sequence('relay'))
      const file = payload.file ?? relayFilePath(options.stateDir, name)
      if (payload.file === undefined) {
        mkdirSync(join(options.stateDir, RELAY_DIR), { recursive: true })
        // 先落盘再写终端：终端里出现指针时，文件一定已经在了。
        writeFileSync(file, relayBody(payload, now()), 'utf8')
      }
      await write(relayLine(name, payload, file))
      log(`relayed ${payload.messageId} to the router`)
    })

  const notice = (payload: NoticeMessage): Promise<void> =>
    exclusive(async () => {
      await write(noticeLine(payload))
    })

  const card = (payload: RouterCardMessage): Promise<void> =>
    exclusive(async () => {
      const name = safeName(payload.name)
      const file = relayFilePath(options.stateDir, name)
      mkdirSync(join(options.stateDir, RELAY_DIR), { recursive: true })
      // 先落盘再写终端：终端里出现指针时，正文一定已经在了（与 relay 同序）。
      writeFileSync(file, payload.body, 'utf8')
      await write(cardLine(name, payload.summary, file))
      log(`relayed candidate ${name} to the router`)
    })

  const prune = (): number => {
    const directory = join(options.stateDir, RELAY_DIR)
    const cutoff = now() - retentionDays * 24 * 60 * 60 * 1000
    let removed = 0
    const names = ((): readonly string[] => {
      try {
        return readdirSync(directory)
      } catch {
        return []
      }
    })()
    for (const name of names) {
      if (!name.endsWith('.md')) continue
      const path = join(directory, name)
      try {
        if (statSync(path).mtimeMs < cutoff) {
          rmSync(path)
          removed += 1
        }
      } catch {
        // 文件在列出与删除之间消失：已经是我们要的结果。
      }
    }
    if (removed > 0) log(`pruned ${removed} relay file(s)`)
    return removed
  }

  return {
    handlers: () => ({
      relay: (payload: RelayMessage) => relay(payload),
      notice: (payload: NoticeMessage) => notice(payload),
      card: (payload: RouterCardMessage) => card(payload)
    }),
    prune
  }
}

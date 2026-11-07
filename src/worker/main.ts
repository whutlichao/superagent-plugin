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
import { REPLY_WORD_LIMIT, wordCount } from './http/domain'
import { PromptTextError, PromptVersionError } from './app/prompts.ts'
import {
  EXECUTION_FILTERS,
  isExecutionFilter,
  isThreadFilter,
  THREAD_FILTERS,
  type ThreadDetailInput,
  type ThreadListInput,
  type DecisionListInput,
  type TicketListInput
} from '../panel/protocol'

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

/** 面板动作的固定拒绝（形状不对就是 `invalid_params`，与其它面板请求同一口径）。 */
function invalidParams(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'invalid_params' })
}

/** 一个非负整数面板参数（版本号与基版本）；形状不对就是 `invalid_params`，不猜。 */
function baseRevisionOf(value: unknown, name: string, field = 'baseRevision'): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalidParams(`${name} needs { ${field}: a non-negative integer }`)
  }
  return value
}

/**
 * 一个提示词拒绝 → 面板的宿主错误：固定码 + 填槽值（§G.2 的 `missing_placeholder` /
 * `stale_revision` / `reserved_skill_name` / `too_long`）。文案不在这里拼——面板按码翻译。
 */
function promptRefusal(error: unknown): Error & { code: string; values?: Record<string, string> } {
  const known =
    error instanceof PromptTextError || error instanceof PromptVersionError ? error : undefined
  const code = codeOf(error, 'invalid_params')
  const values = known === undefined ? undefined : { ...known.values }
  return Object.assign(new Error(messageOf(error)), {
    code,
    ...(values === undefined ? {} : { values })
  })
}

/** 一次面板请求里的 `{ ticketId: string }`。 */
function ticketIdOf(input: unknown, name: string): string {
  const ticketId = (input as { ticketId?: unknown } | null)?.ticketId
  if (typeof ticketId !== 'string' || ticketId === '') {
    throw invalidParams(`${name} needs { ticketId: string }`)
  }
  return ticketId
}

/** 一次面板请求里的 `{ sourceId: string }`（Source 页的开关、立即同步与刷新显示名）。 */
function sourceIdOf(input: unknown, name: string): string {
  const sourceId = (input as { sourceId?: unknown } | null)?.sourceId
  if (typeof sourceId !== 'string' || sourceId === '') {
    throw invalidParams(`${name} needs { sourceId: string }`)
  }
  return sourceId
}

/** 一次面板请求里的 `{ decisionId: string }`（Eval 的详情与 dismiss）。 */
function decisionIdOf(input: unknown, name: string): string {
  const decisionId = (input as { decisionId?: unknown } | null)?.decisionId
  if (typeof decisionId !== 'string' || decisionId === '') {
    throw invalidParams(`${name} needs { decisionId: string }`)
  }
  return decisionId
}

/** 一次 Eval 列表请求的分页窗口（§M.4）；越界的窗口按 `invalid_params` 拒绝。 */
function decisionListOf(input: unknown): DecisionListInput {
  const window = (input ?? {}) as { offset?: unknown; limit?: unknown }
  const count = (value: unknown, name: string): number | undefined => {
    if (value === undefined) return undefined
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw invalidParams(`decisions needs { ${name}: a non-negative integer }`)
    }
    return value
  }
  const offset = count(window.offset, 'offset')
  const limit = count(window.limit, 'limit')
  return {
    ...(offset === undefined ? {} : { offset }),
    ...(limit === undefined ? {} : { limit })
  }
}

/** 一次 Execution 列表请求（§M.2 的筛选 + §M.4 的分页）；越界的窗口按 `invalid_params` 拒绝。 */
function ticketListOf(input: unknown): TicketListInput {
  const window = (input ?? {}) as { filter?: unknown; offset?: unknown; limit?: unknown }
  const filter = window.filter
  if (filter !== undefined && !isExecutionFilter(filter)) {
    throw invalidParams(`tickets needs filter ∈ ${EXECUTION_FILTERS.join(', ')}`)
  }
  const count = (value: unknown, name: string): number | undefined => {
    if (value === undefined) return undefined
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw invalidParams(`tickets needs { ${name}: a non-negative integer }`)
    }
    return value
  }
  const offset = count(window.offset, 'offset')
  const limit = count(window.limit, 'limit')
  return {
    ...(isExecutionFilter(filter) ? { filter } : {}),
    ...(offset === undefined ? {} : { offset }),
    ...(limit === undefined ? {} : { limit })
  }
}

/** 一次 Trigger 列表请求（§M.2 的四档筛选 + §M.4 的分页）；越界的窗口按 `invalid_params` 拒绝。 */
function threadListOf(input: unknown): ThreadListInput {
  const window = (input ?? {}) as { filter?: unknown; offset?: unknown; limit?: unknown }
  const filter = window.filter
  if (filter !== undefined && !isThreadFilter(filter)) {
    throw invalidParams(`threads needs filter ∈ ${THREAD_FILTERS.join(', ')}`)
  }
  const count = (value: unknown, name: string): number | undefined => {
    if (value === undefined) return undefined
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw invalidParams(`threads needs { ${name}: a non-negative integer }`)
    }
    return value
  }
  const offset = count(window.offset, 'offset')
  const limit = count(window.limit, 'limit')
  return {
    ...(isThreadFilter(filter) ? { filter } : {}),
    ...(offset === undefined ? {} : { offset }),
    ...(limit === undefined ? {} : { limit })
  }
}

/** 一次请求里的 `{ threadKey: string }`（详情与取消订阅都按 Thread 键）。 */
function threadKeyOf(input: unknown, name: string): string {
  const threadKey = (input as { threadKey?: unknown } | null)?.threadKey
  if (typeof threadKey !== 'string' || threadKey === '') {
    throw invalidParams(`${name} needs { threadKey: string }`)
  }
  return threadKey
}

/**
 * 一次详情请求：`before` 是上一页返回的 `(at, id)` 复合游标（§D.2 要点 1），
 * `limit` 是一页几条。形状不对按 `invalid_params` 拒绝，不猜。
 */
function threadDetailOf(input: unknown): Omit<ThreadDetailInput, 'threadKey'> {
  const window = (input ?? {}) as { before?: unknown; limit?: unknown }
  const limit = window.limit
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1)) {
    throw invalidParams('thread.detail needs { limit: a positive integer }')
  }
  const raw = window.before
  if (raw === undefined) return typeof limit === 'number' ? { limit } : {}
  const cursor = raw as { at?: unknown; triggerId?: unknown } | null
  if (
    typeof cursor !== 'object' ||
    cursor === null ||
    typeof cursor.at !== 'string' ||
    cursor.at === '' ||
    typeof cursor.triggerId !== 'string' ||
    cursor.triggerId === ''
  ) {
    throw invalidParams('thread.detail needs before: { at: string, triggerId: string }')
  }
  return { before: { at: cursor.at, triggerId: cursor.triggerId }, ...(typeof limit === 'number' ? { limit } : {}) }
}

/** 一次请求里的 `{ triggerId: string }`（再评估一次）。 */
function triggerIdOf(input: unknown, name: string): string {
  const triggerId = (input as { triggerId?: unknown } | null)?.triggerId
  if (typeof triggerId !== 'string' || triggerId === '') {
    throw invalidParams(`${name} needs { triggerId: string }`)
  }
  return triggerId
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
  // Overview 的两条动作（#37）：`check` 重读读模型；`ticket.retry` 与 `terminal.focus` 在详情页。
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
  // Execution 页（§M.2）：列表与详情是读；停止、note、请求状态与两条 worktree 动作是写，
  // 都经 boot 的同一批 handler（命令行的 `ticket *` 走同一批领域函数）。
  host.handleRequest('tickets', async (input) => (await ready()).tickets(ticketListOf(input)))
  host.handleRequest('ticket.detail', async (input) => {
    const booted = await ready()
    try {
      return await booted.ticketDetail(ticketIdOf(input, 'ticket.detail'))
    } catch (error) {
      throw Object.assign(new Error(messageOf(error)), { code: codeOf(error, 'invalid_params') })
    }
  })
  host.handleRequest('ticket.stop', async (input) => {
    const booted = await ready()
    try {
      return booted.stopTicket(ticketIdOf(input, 'ticket.stop'))
    } catch (error) {
      throw Object.assign(new Error(messageOf(error)), { code: codeOf(error, 'invalid_params') })
    }
  })
  host.handleRequest('ticket.note', async (input) => {
    const text = (input as { text?: unknown } | null)?.text
    if (typeof text !== 'string' || text.trim() === '') {
      throw invalidParams('ticket.note needs { ticketId: string, text: string }')
    }
    // §G.2 的 `ticket note` 有同一道词数上限：命令行的拒绝与面板的拒绝必须是同一条规则。
    if (wordCount(text) > REPLY_WORD_LIMIT) {
      throw Object.assign(
        new Error(`the note is ${wordCount(text)} words; the limit is ${REPLY_WORD_LIMIT}`),
        { code: 'too_long' }
      )
    }
    const booted = await ready()
    try {
      return booted.noteTicket(ticketIdOf(input, 'ticket.note'), text)
    } catch (error) {
      throw Object.assign(new Error(messageOf(error)), { code: codeOf(error, 'invalid_params') })
    }
  })
  host.handleRequest('ticket.requestStatus', async (input) => {
    const booted = await ready()
    try {
      return { asked: booted.requestStatus(ticketIdOf(input, 'ticket.requestStatus')) }
    } catch (error) {
      throw Object.assign(new Error(messageOf(error)), { code: codeOf(error, 'invalid_params') })
    }
  })
  // Eval 页（§M.2 的 Decision 列表与详情、§K.7 的 dismiss）：列表/详情是读，dismiss 是写。
  host.handleRequest('decisions', async (input) => (await ready()).decisions(decisionListOf(input)))
  host.handleRequest('decision.detail', async (input) => {
    const booted = await ready()
    try {
      return booted.decisionDetail(decisionIdOf(input, 'decision.detail'))
    } catch (error) {
      throw Object.assign(new Error(messageOf(error)), { code: codeOf(error, 'invalid_params') })
    }
  })
  host.handleRequest('decision.dismiss', async (input) => {
    const booted = await ready()
    try {
      return booted.dismissDecision(decisionIdOf(input, 'decision.dismiss'))
    } catch (error) {
      throw Object.assign(new Error(messageOf(error)), { code: codeOf(error, 'invalid_params') })
    }
  })
  // Trigger 页（§M.2）：列表与详情是读；「再评估一次」与「取消订阅」是写，都经 boot 的同一批
  // handler（命令行的 `trigger requeue` / `thread unsubscribe` 走同一批领域函数）。
  host.handleRequest('threads', async (input) => (await ready()).threads(threadListOf(input)))
  host.handleRequest('thread.detail', async (input) => {
    const booted = await ready()
    try {
      return booted.threadDetail(threadKeyOf(input, 'thread.detail'), threadDetailOf(input))
    } catch (error) {
      throw Object.assign(new Error(messageOf(error)), { code: codeOf(error, 'invalid_params') })
    }
  })
  host.handleRequest('trigger.requeue', async (input) => {
    const booted = await ready()
    try {
      return { queued: booted.requeueTrigger(triggerIdOf(input, 'trigger.requeue')) }
    } catch (error) {
      throw Object.assign(new Error(messageOf(error)), { code: codeOf(error, 'invalid_params') })
    }
  })
  host.handleRequest('thread.unsubscribe', async (input) => {
    const booted = await ready()
    try {
      return { removed: booted.unsubscribeThread(threadKeyOf(input, 'thread.unsubscribe')) }
    } catch (error) {
      throw Object.assign(new Error(messageOf(error)), { code: codeOf(error, 'invalid_params') })
    }
  })
  host.handleRequest('workspace.open', async (input) => {
    const booted = await ready()
    try {
      await booted.openTicketWorkspace(ticketIdOf(input, 'workspace.open'))
      return { opened: true }
    } catch (error) {
      throw Object.assign(new Error(messageOf(error)), { code: codeOf(error, 'action_failed') })
    }
  })
  host.handleRequest('workspace.remove', async (input) => {
    const booted = await ready()
    try {
      await booted.removeTicketWorkspace(ticketIdOf(input, 'workspace.remove'))
      return { removed: true }
    } catch (error) {
      throw Object.assign(new Error(messageOf(error)), { code: codeOf(error, 'action_failed') })
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
  // Source 页（§M.2）：卡片读数是读；开关写 `source:<id>`、立即同步名单、刷新显示名是写。
  host.handleRequest('sources', async () => (await ready()).sources())
  host.handleRequest('source.setEnabled', async (input) => {
    const sourceId = sourceIdOf(input, 'source.setEnabled')
    const enabled = (input as { enabled?: unknown } | null)?.enabled
    if (typeof enabled !== 'boolean') {
      throw invalidParams('source.setEnabled needs { sourceId: string, enabled: boolean }')
    }
    const booted = await ready()
    try {
      return booted.setSourceEnabled(sourceId, enabled)
    } catch (error) {
      throw Object.assign(new Error(messageOf(error)), { code: codeOf(error, 'invalid_params') })
    }
  })
  host.handleRequest('source.sync', async (input) => {
    const sourceId = sourceIdOf(input, 'source.sync')
    const booted = await ready()
    try {
      const outcome = await booted.syncSource(sourceId)
      return { sourceId, allowed: outcome.allowed }
    } catch (error) {
      throw Object.assign(new Error(messageOf(error)), { code: codeOf(error, 'invalid_params') })
    }
  })
  host.handleRequest('source.labels', async (input) => {
    const sourceId = sourceIdOf(input, 'source.labels')
    const booted = await ready()
    try {
      const outcome = await booted.refreshSourceLabels(sourceId)
      return { sourceId, added: outcome.added, total: outcome.total }
    } catch (error) {
      throw Object.assign(new Error(messageOf(error)), { code: codeOf(error, 'invalid_params') })
    }
  })
  // Deployment 组（§M.3）：读数一次读完；doctor、重跑探针与两个破坏性动作各一条请求。
  host.handleRequest('deployment', async () => (await ready()).deployment())
  host.handleRequest('doctor', async () => (await ready()).doctor())
  host.handleRequest('setupCheck', async () => {
    const outcome = await (await ready()).checkSetup()
    return { checked: outcome.checked, problems: outcome.issues }
  })
  host.handleRequest('rotateToken', async () => (await ready()).rotateToken())
  host.handleRequest('restartRouter', async () => {
    const booted = await ready()
    await booted.restartRouter()
    return booted.deployment().router
  })
  // Prompts 组（§M.3）：一份读数、一次预览、一次保存、一次恢复。预览与保存共用 worker 的
  // 同一份校验；被拒时把固定码与填槽值一并带出（面板按码翻译），不把原因写成一句散文。
  host.handleRequest('prompts', async () => (await ready()).promptPanel())
  host.handleRequest('prompts.preview', async (input) => {
    const config = (input as { config?: unknown } | null)?.config
    if (config === undefined) throw invalidParams('prompts.preview needs { config: object }')
    const booted = await ready()
    return booted.previewPrompts(config)
  })
  host.handleRequest('prompts.save', async (input) => {
    const request = (input ?? {}) as { config?: unknown; baseRevision?: unknown }
    if (request.config === undefined) throw invalidParams('prompts.save needs { config: object }')
    const baseRevision = baseRevisionOf(request.baseRevision, 'prompts.save')
    const booted = await ready()
    try {
      return booted.savePrompts({ config: request.config, baseRevision })
    } catch (error) {
      throw promptRefusal(error)
    }
  })
  host.handleRequest('prompts.restore', async (input) => {
    const request = (input ?? {}) as { revision?: unknown; baseRevision?: unknown }
    const revision = baseRevisionOf(request.revision, 'prompts.restore', 'revision')
    const baseRevision = baseRevisionOf(request.baseRevision, 'prompts.restore')
    const booted = await ready()
    try {
      return booted.restorePrompts({ revision, baseRevision })
    } catch (error) {
      throw promptRefusal(error)
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

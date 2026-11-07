// 命令分派（§G.2 的**单一命令表** + §G.3 的路由）：每条命令的名字、参数形状、走哪条 HTTP
// 路由、以及「现在能不能服务」都在这里写一次；`dispatch()` 把一次 argv 变成一次 HTTP 调用 + 一个信封。
//
// 三类命令：
// - **已接线**：`status`、`health`、`pause`、`resume`、`setup check`、`source labels`、
//   `admin backup`、`admin rotate-token`、`doctor`，以及运维读面（`read <resource>`）；
// - **纯分派**：已接线的命令也**不重写业务逻辑**——它把参数变成一次 HTTP 调用，真正的工作
//   在 worker 的 handler 里（§G「两层，同一份 handler」）；
// - **未落地**：Router/Worker 的命令先占住最终名字与参数，返回固定 `unavailable`
//   （退出 3、HTTP 503）直到拥有它的票接上实现。**后票只填 handler，不改表。**
//
// 依赖纪律（§C.2 `cli → http/handlers`）：本文件只 import 类型、固定错误码与 HTTP 客户端，
// 不 import `orca`、不 import `app/`（CLI 是独立进程，只能经 HTTP 碰数据）。

import { readFileSync } from 'node:fs'
import { ApiError, ERROR_CODES, type ErrorCode, type ErrorPayload } from '../http/errors.ts'
import { statusCode } from '../http/state.ts'
import { REQUEST_ID_HEADER } from '../http/idempotency.ts'
import type { CliResponse } from './transport.ts'
import { requestJson } from './transport.ts'
import type { CliTarget } from './target.ts'
import { encodePathSegment } from './target.ts'
import { READ_MAX_LIMIT, READ_DEFAULT_LIMIT, READ_RESOURCES } from '../http/api-types.ts'
import { EXIT, exitForCode, type Envelope, type ExitCode, type ParsedArgs } from './io.ts'

/**
 * `--request-id` 的 flag 名由 HTTP 头的名字派生（`x-superagent-request-id` → `request-id`）：
 * 两处不会各写一份，也避免把幂等族的键前缀字面量抄进 CLI。
 */
export const REQUEST_ID_FLAG_NAME = REQUEST_ID_HEADER.replace(/^x-superagent-/, '')

/** 一个 flag 的形状：`value` 吃一个词，`switch` 是布尔开关。 */
export type FlagKind = 'value' | 'switch'

/** 命令参数表里的一项。 */
export interface FlagSpec {
  readonly name: string
  readonly kind: FlagKind
  /** 给 help 与错误提示用的一句话。 */
  readonly hint: string
  readonly required?: boolean
  /** 枚举值的候选（`invalid_value` 的判定用）。 */
  readonly choices?: readonly string[]
}

/** 位置参数的名字（按顺序）。 */
export interface PositionalSpec {
  readonly name: string
  readonly required: boolean
}

/** 一次已解析的参数（命令表匹配完命令名之后交给 handler 的形状）。 */
export interface CommandArgs {
  /** 位置参数（不含命令路径）。 */
  readonly positionals: readonly string[]
  readonly flags: Readonly<Record<string, string | true>>
  /** 可重复 flag 的全部取值（`--item`；§G.2 的 route 行）。 */
  readonly repeated: Readonly<Record<string, readonly string[]>>
  /** `--text`。 */
  readonly text: boolean
}

/** handler 的返回值：`result` 进成功信封；抛出 `ApiError` 决定固定拒绝码。 */
export type CommandHandler = (args: CommandArgs) => unknown | Promise<unknown>

/** 一条命令。 */
export interface CommandDefinition {
  /** 命令路径，例如 `['ticket', 'stop']`。 */
  readonly name: readonly string[]
  /** 一句话用途（`--help` 与测试用）。 */
  readonly summary: string
  /** 这条命令自己的参数表（全局开关不在里面）。 */
  readonly flags: readonly FlagSpec[]
  /** 位置参数（按顺序；空数组表示不吃位置参数）。 */
  readonly positionals: readonly PositionalSpec[]
  /** 写命令：可以带 `--request-id`（§G.1 幂等行）。 */
  readonly write: boolean
  /** 是否已接线。未接线的命令返回固定的 `unavailable`。 */
  readonly available: boolean
  /** 实现；未接线时为 `undefined`（由 `dispatch` 统一回固定拒绝）。 */
  readonly handler?: CommandHandler
}

/** 未落地的固定拒绝：`unavailable` + 命令名（可判定，不靠文案）。 */
export function unavailableFor(name: readonly string[]): ErrorPayload {
  return {
    code: ERROR_CODES.unavailable,
    message: `${name.join(' ')} is not available in this build yet`,
    values: { command: name.join(' ') }
  }
}

/** 位置参数不够时的固定码（`invalid_params`）。 */
export function missingPositional(name: string): ErrorPayload {
  return {
    code: ERROR_CODES.invalidParams,
    message: `missing the ${name} argument`,
    values: { argument: name }
  }
}

/** 值不在候选里时的固定码（`invalid_value`）。 */
export function invalidChoice(flag: string, choices: readonly string[]): ErrorPayload {
  return {
    code: ERROR_CODES.invalidValue,
    message: `--${flag} must be one of: ${choices.join(', ')}`,
    values: { flag, choices: choices.join(',') }
  }
}

// ---------------------------------------------------------------- 参数表的复用片段

/** `--request-id`（写命令共用的幂等键）。 */
export const REQUEST_ID_FLAG: FlagSpec = {
  name: REQUEST_ID_FLAG_NAME,
  kind: 'value',
  hint: 'reuse this id within an hour to get the first result (idempotency)'
}

/** `--state-dir` / `--token-file` 是全局开关，由 `io.ts` 解析，不进各命令的表。 */

/** 分页：`--offset` / `--limit`（默认 20、上限 50，§G.2 的 read 行）。 */
export const PAGE_FLAGS: readonly FlagSpec[] = [
  { name: 'offset', kind: 'value', hint: 'skip this many items (default 0)' },
  { name: 'limit', kind: 'value', hint: 'page size (default 20, at most 50)' }
]

// ---------------------------------------------------------------- 命令表

/**
 * 全部命令。顺序即 `--help` 的分组顺序：先运维，再 Router/Worker 的读与写，最后面板专属动作。
 * **未接线的条目也在这里**：它们有最终的名字与参数，只是 handler 还回固定拒绝。
 */
export const CLI_COMMANDS: readonly CommandDefinition[] = [
  // ---- 运维（本票接线）
  {
    name: ['status'],
    summary: 'process, store, http, loops, health, setup, paused and load; exit 0/1/2/3',
    flags: [],
    positionals: [],
    write: false,
    available: true
  },
  {
    name: ['health'],
    summary: 'the health entries only',
    flags: [],
    positionals: [],
    write: false,
    available: true
  },
  {
    name: ['pause'],
    summary: 'stop dispatching, evaluating and delivering (sources keep recording)',
    flags: [REQUEST_ID_FLAG],
    positionals: [],
    write: true,
    available: true
  },
  {
    name: ['resume'],
    summary: 'resume dispatching, evaluating and delivering',
    flags: [REQUEST_ID_FLAG],
    positionals: [],
    write: true,
    available: true
  },
  {
    name: ['setup', 'check'],
    summary: 're-run the setup probes (stub until #44 lands)',
    flags: [REQUEST_ID_FLAG],
    positionals: [],
    write: true,
    available: true
  },
  {
    name: ['source', 'labels'],
    summary: 're-read a source row label (for example a Feishu chat name)',
    flags: [REQUEST_ID_FLAG],
    positionals: [{ name: 'source', required: true }],
    write: true,
    available: true
  },
  {
    name: ['admin', 'backup'],
    summary: 'back up the database now (before an upgrade)',
    flags: [REQUEST_ID_FLAG],
    positionals: [],
    write: true,
    available: true
  },
  {
    name: ['admin', 'rotate-token'],
    summary: 'rotate the operator token (destructive; needs --yes)',
    flags: [{ name: 'yes', kind: 'switch', hint: 'confirm the destructive rotation' }, REQUEST_ID_FLAG],
    positionals: [],
    write: true,
    available: true
  },
  {
    name: ['doctor'],
    summary: 'check token, port, lock, database, CLI path, gh login and lark-cli config',
    flags: [],
    positionals: [],
    write: false,
    available: true
  },

  // ---- 读面（`read <resource>`；本票只服务运维视图，其余资源由各票接上）
  {
    name: ['read'],
    summary: 'read a resource: overview, sources, threads, decisions, tickets, settings, models…',
    flags: PAGE_FLAGS,
    positionals: [{ name: 'resource', required: true }, { name: 'id', required: false }],
    write: false,
    available: true
  },

  // ---- Router 的评估面（#16/#20/#24/#26）
  {
    name: ['route'],
    summary: 'route 1–20 decisions in one call',
    flags: [
      { name: 'decisions', kind: 'value', hint: 'JSON array, or - for stdin' },
      { name: 'item', kind: 'value', hint: 'one decision as JSON (repeatable)' },
      REQUEST_ID_FLAG
    ],
    positionals: [],
    write: true,
    available: true
  },
  {
    name: ['eval'],
    summary: 'the candidate window for one trigger',
    flags: [],
    positionals: [{ name: 'trigger_id', required: true }],
    write: false,
    available: false
  },
  {
    name: ['eval-read'],
    summary: 'read a message, image, thread part or repo path inside an eval',
    flags: [
      { name: 'message-id', kind: 'value', hint: 'message to read' },
      { name: 'image-id', kind: 'value', hint: 'image to download' },
      { name: 'part', kind: 'value', hint: 'root | parent | thread', choices: ['root', 'parent', 'thread'] },
      { name: 'cursor', kind: 'value', hint: 'continue a paged part' },
      { name: 'path', kind: 'value', hint: 'a path inside the repository' }
    ],
    positionals: [{ name: 'trigger_id', required: true }],
    write: false,
    available: false
  },
  {
    name: ['eval-decide'],
    summary: 'record an assessment and the resulting decision',
    flags: [{ name: 'assessment', kind: 'value', hint: 'JSON assessment, or - for stdin' }, REQUEST_ID_FLAG],
    positionals: [{ name: 'trigger_id', required: true }],
    write: true,
    available: true
  },

  // ---- Ticket / Trigger / Thread（#28/#29/#27）
  {
    name: ['ticket', 'retry'],
    summary: 'retry a failed or blocked ticket',
    flags: [REQUEST_ID_FLAG],
    positionals: [{ name: 'ticket_id', required: true }],
    write: true,
    available: false
  },
  {
    name: ['ticket', 'stop'],
    summary: 'stop a ticket (a person can still resume it)',
    flags: [{ name: 'reason', kind: 'value', hint: 'one sentence for the record' }, REQUEST_ID_FLAG],
    positionals: [{ name: 'ticket_id', required: true }],
    write: true,
    available: false
  },
  {
    name: ['ticket', 'note'],
    summary: 'send a person note to a running worker (at most 100 words)',
    flags: [{ name: 'text', kind: 'value', hint: 'the note', required: true }, REQUEST_ID_FLAG],
    positionals: [{ name: 'ticket_id', required: true }],
    write: true,
    available: false
  },
  {
    name: ['ticket', 'request-status'],
    summary: 'ask a waiting worker for a status report',
    flags: [REQUEST_ID_FLAG],
    positionals: [{ name: 'ticket_id', required: true }],
    write: true,
    available: false
  },
  {
    name: ['ticket', 'list'],
    summary: 'list tickets (optionally by state)',
    flags: [
      { name: 'state', kind: 'value', hint: 'open | person | working | idle | ended', choices: ['open', 'person', 'working', 'idle', 'ended'] },
      ...PAGE_FLAGS
    ],
    positionals: [],
    write: false,
    available: false
  },
  {
    name: ['trigger', 'requeue'],
    summary: 'evaluate a trigger again',
    flags: [REQUEST_ID_FLAG],
    positionals: [{ name: 'trigger_id', required: true }],
    write: true,
    available: false
  },
  {
    name: ['trigger', 'handback'],
    summary: 'hand a trigger back as beyond this ticket',
    flags: [{ name: 'reason', kind: 'value', hint: 'one sentence' }, REQUEST_ID_FLAG],
    positionals: [{ name: 'trigger_id', required: true }],
    write: true,
    available: false
  },
  {
    name: ['thread', 'unsubscribe'],
    summary: 'drop every subscription of a thread',
    flags: [REQUEST_ID_FLAG],
    positionals: [{ name: 'thread_key', required: true }],
    write: true,
    available: false
  },
  {
    name: ['thread', 'follow'],
    summary: 'follow a thread this ticket does not own',
    flags: [{ name: 'reason', kind: 'value', hint: 'one sentence' }, REQUEST_ID_FLAG],
    positionals: [{ name: 'thread_key', required: true }],
    write: true,
    available: false
  },
  {
    name: ['thread', 'unrelated'],
    summary: 'drop a followed thread as unrelated',
    flags: [{ name: 'reason', kind: 'value', hint: 'one sentence' }, REQUEST_ID_FLAG],
    positionals: [{ name: 'thread_key', required: true }],
    write: true,
    available: false
  },

  // ---- 回复与报告（#30/#31/#32）
  {
    name: ['reply'],
    summary: 'answer a person, return a result or raise attention',
    flags: [
      { name: 'purpose', kind: 'value', hint: 'answer | result | attention', required: true, choices: ['answer', 'result', 'attention'] },
      { name: 'ticket', kind: 'value', hint: 'the ticket to reply for' },
      { name: 'trigger', kind: 'value', hint: 'the human trigger being answered' },
      { name: 'text', kind: 'value', hint: 'at most 100 words' },
      { name: 'human-action', kind: 'value', hint: 'the decision a person must make' },
      REQUEST_ID_FLAG
    ],
    positionals: [],
    write: true,
    available: true
  },
  {
    name: ['ack'],
    summary: 'acknowledge a human request once',
    flags: [
      { name: 'trigger', kind: 'value', hint: 'the human trigger', required: true },
      { name: 'text', kind: 'value', hint: 'at most 100 words', required: true },
      REQUEST_ID_FLAG
    ],
    positionals: [],
    write: true,
    available: true
  },
  {
    name: ['report'],
    summary: 'report progress, waiting, ready, blocked, failed or dropped',
    flags: [
      { name: 'state', kind: 'value', hint: 'progress | waiting | ready | blocked | failed | dropped', required: true, choices: ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped'] },
      { name: 'summary', kind: 'value', hint: 'at most 600 characters' },
      { name: 'summary-file', kind: 'value', hint: 'read a long summary from this file' },
      { name: 'pr-number', kind: 'value', hint: 'the pull request this report is about' },
      { name: 'pr-url', kind: 'value', hint: 'the pull request url' },
      { name: 'human-action', kind: 'value', hint: 'the decision a person must make' },
      { name: 'reply-to-trigger', kind: 'value', hint: 'answer this human trigger' },
      { name: 'question-for-trigger', kind: 'value', hint: 'raise a question on this trigger' },
      REQUEST_ID_FLAG
    ],
    positionals: [],
    write: true,
    available: true
  },

  // ---- 设置、Policy 与 Prompts（#25/#33/#34/#42）
  {
    name: ['settings', 'get'],
    summary: 'read a settings block (or all of them)',
    flags: [
      { name: 'block', kind: 'value', hint: 'policy | eval | executor | source:<id>' },
      { name: 'history', kind: 'switch', hint: 'list past revisions' }
    ],
    positionals: [],
    write: false,
    available: false
  },
  {
    name: ['settings', 'save'],
    summary: 'write a settings block at a base revision',
    flags: [
      { name: 'block', kind: 'value', hint: 'policy | eval | executor | source:<id>', required: true },
      { name: 'value', kind: 'value', hint: 'JSON value, or - for stdin', required: true },
      { name: 'revision', kind: 'value', hint: 'the revision this save is based on', required: true },
      REQUEST_ID_FLAG
    ],
    positionals: [],
    write: true,
    available: false
  },
  {
    name: ['policy', 'sync'],
    summary: 'sync an allow list from its source',
    flags: [REQUEST_ID_FLAG],
    positionals: [{ name: 'source', required: true }],
    write: true,
    available: false
  },
  {
    name: ['prompts', 'get'],
    summary: 'read the prompt config or the assembled full text',
    flags: [
      { name: 'revision', kind: 'value', hint: 'a past revision' },
      { name: 'defaults', kind: 'switch', hint: 'the built-in defaults' },
      { name: 'text', kind: 'switch', hint: 'the assembled full text' }
    ],
    positionals: [],
    write: false,
    available: false
  },
  {
    name: ['prompts', 'save'],
    summary: 'write a prompt config at a base revision',
    flags: [
      { name: 'config', kind: 'value', hint: 'JSON config, or - for stdin' },
      { name: 'base-revision', kind: 'value', hint: 'the revision this save is based on' },
      { name: 'preview', kind: 'switch', hint: 'render without saving' },
      REQUEST_ID_FLAG
    ],
    positionals: [],
    write: true,
    available: false
  }
]

/** 命令表按名字索引（`dispatch` 用的最长前缀匹配）。 */
export function commandFor(words: readonly string[]): CommandDefinition | null {
  let best: CommandDefinition | null = null
  for (const command of CLI_COMMANDS) {
    if (command.name.length > words.length) continue
    if (!command.name.every((part, index) => words[index] === part)) continue
    if (best === null || command.name.length > best.name.length) best = command
  }
  return best
}

/** 一条命令的 `--request-id` 在 body 里的字段名（handler 读 body 时用）。 */
export const REQUEST_ID_BODY_FIELD = 'requestId'

/** 写命令是否接受 `--request-id`（读命令带上它没有意义，但不报错地忽略也是坏主意）。 */
export function acceptsRequestId(command: CommandDefinition): boolean {
  return command.flags.some((flag) => flag.name === REQUEST_ID_FLAG_NAME)
}

/** 错误码的再导出：命令实现里抛 `ApiError(code, …)` 时不必再 import 另一处。 */
export { ERROR_CODES }
export type { ErrorCode }

// ---------------------------------------------------------------- 分派

/** 一次调用的结果：信封 + 退出码。 */
export interface DispatchResult {
  readonly envelope: Envelope
  readonly exit: ExitCode
}

/** 分派需要的一切（目标可由调用方先解析好，测试因此不用起真服务器也不需要真 HOME）。 */
export interface DispatchInput {
  readonly parsed: ParsedArgs
  readonly target: CliTarget
  /** 重试前的等待（测试注入）。 */
  readonly sleep?: (milliseconds: number) => Promise<void>
  /** 读 stdin（`--decisions -` / `--value -`）；缺省不支持 stdin。 */
  readonly stdin?: () => Promise<string>
}

/** 命令路径与位置参数：从 `parsed.words` 里切出命令表认得出的最长前缀。 */
export function splitCommand(parsed: ParsedArgs): {
  readonly command: CommandDefinition | null
  readonly positionals: readonly string[]
} {
  const command = commandFor(parsed.words)
  if (command === null) return { command: null, positionals: parsed.words }
  return { command, positionals: parsed.words.slice(command.name.length) }
}

/**
 * 跑一次命令。未知命令 → `invalid_params`（退出 2）；未落地 → `unavailable`（退出 3）；
 * 参数不合法 → `invalid_params`/`invalid_value`（退出 2）；网络不可达 → `not_ready`（退出 3）。
 */
export async function dispatch(input: DispatchInput): Promise<DispatchResult> {
  const { command, positionals: words } = splitCommand(input.parsed)
  try {
    if (command === null) {
      throw new ApiError(
        ERROR_CODES.invalidParams,
        input.parsed.words.length === 0 ? 'a command is required' : 'unknown command'
      )
    }
    const flags = commandFlags(command, input.parsed)
    const positionals = withoutTextValue(command, words, input.parsed)
    validateFlags(command, flags)
    validatePositionals(command, positionals)
    if (!command.available) {
      return failureFrom(unavailableFor(command.name))
    }
    const args: CommandArgs = {
      positionals,
      flags,
      repeated: input.parsed.repeated,
      // `reply --text "…"` 里那个 `--text` 是命令值，不是全局的人读输出开关：输出仍是 JSON
      // 信封，worker 才能解析（§G.1 的 `--text` 只在不被命令声明为值时生效）。
      text: usesTextValue(command, input.parsed) ? false : input.parsed.text
    }
    const response = await run(command, args, input)
    return fromResponse(command, response)
  } catch (error) {
    if (error instanceof ApiError) {
      return { envelope: { ok: false, error: error.toJSON() }, exit: exitForCode(error.code) }
    }
    return {
      envelope: { ok: false, error: { code: ERROR_CODES.internal, message: 'Internal error' } },
      exit: EXIT.internal
    }
  }
}

/** 一条固定拒绝的信封 + 退出码。 */
function failureFrom(error: { readonly code: string; readonly message: string; readonly values?: Readonly<Record<string, string>> }): DispatchResult {
  return {
    envelope: { ok: false, error: { ...error } },
    exit: exitForCode(error.code)
  }
}

/** 命令自己的 flag 表 + 全局开关；其余一律 `invalid_params`（**只提 flag 名**）。 */
function validateFlags(command: CommandDefinition, flags: ParsedArgs['flags']): void {
  const allowed = new Set<string>(['json', 'text', 'state-dir', 'token-file', 'token'])
  if (command.write) allowed.add(REQUEST_ID_FLAG_NAME)
  for (const spec of command.flags) allowed.add(spec.name)
  for (const name of Object.keys(flags)) {
    if (!allowed.has(name)) throw new ApiError(ERROR_CODES.invalidParams, `--${name} is not a flag of ${command.name.join(' ')}`)
  }
  for (const spec of command.flags) {
    if (spec.required !== true) continue
    const value = flags[spec.name]
    if (value === undefined) {
      throw new ApiError(ERROR_CODES.invalidParams, `${command.name.join(' ')} needs --${spec.name}`, {
        flag: spec.name
      })
    }
    if (spec.choices !== undefined && typeof value === 'string' && !spec.choices.includes(value)) {
      const invalid = invalidChoice(spec.name, spec.choices)
      throw new ApiError(invalid.code, invalid.message, invalid.values)
    }
  }
}

/**
 * `--text` 的双重身份（§G.1 的全局 `--text` 与 §G.2 的 `--text <text>`）：
 * - 命令表声明了 `--text` 且它是**值**形态（`reply` / `ack` / `ticket note`）：`--text=value`
 *   原样可用；`--text value` 时取解析层记下的 `textValue`（那个词仍留在 `words` 里，由
 *   `withoutTextValue` 取走）；两者都没有 → `invalid_params`（只提 `--text`）；
 * - 命令表声明了 `--text` 且是开关（`prompts get --text`）：原样交给命令；
 * - 命令表没声明：`--text` 是全局输出开关，不进命令参数。
 */
function commandFlags(
  command: CommandDefinition,
  parsed: ParsedArgs
): Readonly<Record<string, string | true>> {
  const spec = command.flags.find((flag) => flag.name === 'text')
  if (spec === undefined) {
    const rest: Record<string, string | true> = { ...parsed.flags }
    delete rest['text']
    return rest
  }
  if (spec.kind === 'value' && parsed.flags['text'] === true) {
    if (parsed.textValue === undefined) {
      throw new ApiError(ERROR_CODES.invalidParams, `--text needs a value for ${command.name.join(' ')}`)
    }
    return { ...parsed.flags, text: parsed.textValue }
  }
  return parsed.flags
}

/**
 * 一次解析要不要按「人读文本」渲染：全局 `--text` 开关，除非这条命令把它当成了自己的值。
 * `main` 用它决定 `render(envelope, { text })`，与 `dispatch` 交给命令的 `args.text` 一致。
 */
export function outputText(parsed: ParsedArgs): boolean {
  if (!parsed.text) return false
  const command = commandFor(parsed.words)
  return command === null ? true : !usesTextValue(command, parsed)
}

/** 这条命令是否把 `--text value` 用成了自己的值（而不是全局的人读输出开关）。 */
function usesTextValue(command: CommandDefinition, parsed: ParsedArgs): boolean {
  const spec = command.flags.find((flag) => flag.name === 'text')
  return spec?.kind === 'value' && parsed.flags['text'] === true && parsed.textValue !== undefined
}

/** `--text value` 的那个值已经被当成 flag：不再把它算成一个多余的位置参数。 */
function withoutTextValue(
  command: CommandDefinition,
  positionals: readonly string[],
  parsed: ParsedArgs
): readonly string[] {
  const spec = command.flags.find((flag) => flag.name === 'text')
  if (spec?.kind !== 'value' || parsed.flags['text'] !== true || parsed.textValue === undefined) {
    return positionals
  }
  const index = positionals.lastIndexOf(parsed.textValue)
  if (index < 0) return positionals
  return [...positionals.slice(0, index), ...positionals.slice(index + 1)]
}

/** 位置参数：必填的缺了 → `invalid_params`；多余的 → `invalid_params`。 */
function validatePositionals(command: CommandDefinition, positionals: readonly string[]): void {
  command.positionals.forEach((spec, index) => {
    if (spec.required && positionals[index] === undefined) {
      const missing = missingPositional(spec.name)
      throw new ApiError(missing.code, missing.message, missing.values)
    }
  })
  if (positionals.length > command.positionals.length) {
    throw new ApiError(
      ERROR_CODES.invalidParams,
      `${command.name.join(' ')} takes at most ${command.positionals.length} arguments`
    )
  }
}

/** 参数里的开关。 */
function switched(args: CommandArgs, name: string): boolean {
  return args.flags[name] === true
}

/** 从 flags 里读字符串值。 */
function valueArgs(flags: ParsedArgs['flags'], name: string): string | undefined {
  const flag = flags[name]
  return typeof flag === 'string' ? flag : undefined
}

/** 去掉 undefined 的 body 字段（HTTP body 只带真正给出的参数）。 */
function compact(fields: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const body: Record<string, string> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value.length > 0) body[key] = value
  }
  return body
}

/** `--summary-file`：从文件读长摘要（§G.2 的 report 行）；读不到就按固定拒绝。 */
function summaryFile(args: CommandArgs): string | undefined {
  const path = valueArgs(args.flags, 'summary-file')
  if (path === undefined) return undefined
  return readFileSync(path, 'utf8')
}

/**
 * 读一个 JSON flag：一个文件路径，或 `-` 表示 stdin（`--decisions -` / `--assessment -`）。
 * 读不到或不是 JSON 都是 `invalid_params`，消息只提 flag 名，不回显正文或路径。
 */
async function jsonFlag(
  args: CommandArgs,
  input: DispatchInput,
  name: string
): Promise<unknown> {
  const source = valueArgs(args.flags, name)
  if (source === undefined) return undefined
  let text: string
  if (source === '-') {
    if (input.stdin === undefined) {
      throw new ApiError(ERROR_CODES.invalidParams, `--${name} - needs a readable stdin`)
    }
    text = await input.stdin()
  } else {
    try {
      text = readFileSync(source, 'utf8')
    } catch {
      throw new ApiError(ERROR_CODES.invalidParams, `--${name} could not be read`)
    }
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new ApiError(ERROR_CODES.invalidParams, `--${name} must be JSON`)
  }
}

/**
 * `route` 的入参：`--decisions <file|->`（JSON 数组）或重复的 `--item '<json>'`，二选一。
 * 条数上限（1–20）由服务端判（`too_many_items`），CLI 只保证形状。
 */
async function routeDecisions(args: CommandArgs, input: DispatchInput): Promise<unknown[]> {
  const items = args.repeated['item'] ?? []
  const source = valueArgs(args.flags, 'decisions')
  if (source !== undefined && items.length > 0) {
    throw new ApiError(ERROR_CODES.invalidParams, 'route takes --decisions or --item, not both')
  }
  if (items.length > 0) {
    return items.map((item) => {
      try {
        return JSON.parse(item)
      } catch {
        throw new ApiError(ERROR_CODES.invalidParams, 'each --item must be JSON')
      }
    })
  }
  if (source === undefined) {
    throw new ApiError(ERROR_CODES.invalidParams, 'route needs --decisions or --item')
  }
  const value = await jsonFlag(args, input, 'decisions')
  if (!Array.isArray(value)) {
    throw new ApiError(ERROR_CODES.invalidParams, '--decisions must be a JSON array')
  }
  return value
}

/** 写命令的 request id（读命令忽略它：`--request-id` 只对写有意义）。 */
function requestIdOf(parsed: ParsedArgs): string | null {
  const raw = valueArgs(parsed.flags, REQUEST_ID_FLAG_NAME)
  return raw === undefined || raw.trim().length === 0 ? null : raw.trim()
}

/** 一次已接线命令的 HTTP 调用。 */
async function run(
  command: CommandDefinition,
  args: CommandArgs,
  input: DispatchInput
): Promise<CliResponse> {
  const call = (path: string, options: { readonly method?: 'GET' | 'POST' | 'PUT'; readonly body?: unknown; readonly query?: Record<string, string | number | boolean | undefined> } = {}): Promise<CliResponse> =>
    requestJson({
      target: input.target,
      method: options.method ?? (command.write ? 'POST' : 'GET'),
      path,
      ...(options.query === undefined ? {} : { query: options.query }),
      ...(options.body === undefined ? {} : { body: options.body }),
      requestId: command.write ? requestIdOf(input.parsed) : null,
      ...(input.sleep === undefined ? {} : { sleep: input.sleep })
    })

  const [first, second] = command.name
  switch (`${first} ${second ?? ''}`.trim()) {
    case 'status':
      return call('state')
    case 'health':
      return call('state')
    case 'pause':
      return call('executor/pause', { method: 'POST', body: { paused: true } })
    case 'resume':
      return call('executor/pause', { method: 'POST', body: { paused: false } })
    case 'setup check':
      return call('setup/check', { method: 'POST', body: { check: true } })
    case 'source labels':
      return call(`sources/${encodePathSegment(args.positionals[0] ?? '')}/labels`, { method: 'POST', body: {} })
    case 'admin backup':
      return call('admin/backup', { method: 'POST', body: {} })
    case 'admin rotate-token':
      return call('admin/rotate-token', {
        method: 'POST',
        body: { confirm: switched(args, 'yes') === true }
      })
    case 'doctor':
      return call('doctor', { method: 'POST', body: {} })
    case 'reply':
      return call('reply', {
        method: 'POST',
        body: compact({
          purpose: valueArgs(args.flags, 'purpose'),
          ticketId: valueArgs(args.flags, 'ticket'),
          triggerId: valueArgs(args.flags, 'trigger'),
          text: valueArgs(args.flags, 'text'),
          question: valueArgs(args.flags, 'human-action')
        })
      })
    case 'ack':
      return call('ack', {
        method: 'POST',
        body: compact({
          trigger: valueArgs(args.flags, 'trigger'),
          text: valueArgs(args.flags, 'text')
        })
      })
    case 'report':
      return call('report', {
        method: 'POST',
        body: compact({
          state: valueArgs(args.flags, 'state'),
          summary: valueArgs(args.flags, 'summary') ?? summaryFile(args),
          prNumber: valueArgs(args.flags, 'pr-number'),
          prUrl: valueArgs(args.flags, 'pr-url'),
          humanAction: valueArgs(args.flags, 'human-action'),
          replyToTrigger: valueArgs(args.flags, 'reply-to-trigger'),
          questionForTrigger: valueArgs(args.flags, 'question-for-trigger')
        })
      })
    case 'read': {
      const resource = args.positionals[0] ?? ''
      return call(readPath(resource, args.positionals[1]), {
        method: 'GET',
        query: readQuery(resource, args)
      })
    }
    case 'route':
      return call('route', { method: 'POST', body: { decisions: await routeDecisions(args, input) } })
    case 'eval-decide': {
      const triggerId = args.positionals[0] ?? ''
      if (triggerId.length === 0) {
        throw new ApiError(ERROR_CODES.invalidParams, 'eval-decide needs a trigger id')
      }
      const assessment = await jsonFlag(args, input, 'assessment')
      if (assessment === undefined) {
        throw new ApiError(ERROR_CODES.invalidParams, 'eval-decide needs --assessment', {
          flag: 'assessment'
        })
      }
      return call(`eval-decide/${encodePathSegment(triggerId)}`, {
        method: 'POST',
        body: { assessment }
      })
    }
    default:
      // 表里没有这条命令的 handler：不该发生（`available` 与 handler 同表维护）。
      return {
        ok: false,
        status: null,
        notReady: false,
        error: unavailableFor(command.name)
      }
  }
}

/** `read <resource>` 的路径（`thread/<key>` 与 `ticket/<id>` 各占一段参数）。 */
export function readPath(resource: string, id: string | undefined): string {
  if (!READ_RESOURCES.includes(resource)) {
    throw new ApiError(ERROR_CODES.missing, `unknown resource: ${resource}`, { resource })
  }
  if (resource === 'thread' || resource === 'ticket' || resource === 'trigger') {
    if (id === undefined || id.length === 0) throw new ApiError(ERROR_CODES.invalidParams, `read ${resource} needs an id`)
    const segment = resource === 'thread' ? 'threads' : resource === 'ticket' ? 'tickets' : 'triggers'
    return `${segment}/${encodePathSegment(id)}`
  }
  return resource
}

/** `read` 的分页参数：默认 20、上限 50（§G.2 的 read 行）。 */
export function readQuery(resource: string, args: CommandArgs): Record<string, number> {
  const query: Record<string, number> = {}
  const offset = valueArgs(args.flags, 'offset')
  const limit = valueArgs(args.flags, 'limit')
  if (offset !== undefined) {
    const parsed = Number(offset)
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new ApiError(ERROR_CODES.invalidValue, '--offset must be a non-negative integer')
    }
    query['offset'] = parsed
  }
  if (limit !== undefined) {
    const parsed = Number(limit)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > READ_MAX_LIMIT) {
      throw new ApiError(ERROR_CODES.invalidValue, `--limit must be between 1 and ${READ_MAX_LIMIT}`, {
        max: String(READ_MAX_LIMIT)
      })
    }
    query['limit'] = parsed
  } else if (resource === 'threads' || resource === 'tickets' || resource === 'decisions') {
    query['limit'] = READ_DEFAULT_LIMIT
  }
  return query
}

/**
 * HTTP 结果 → 信封 + 退出码。`status` 与 `doctor` 有各自更细的退出码：
 * - `status`：0 正常 / 1 未就绪或运行时错误 / 2 非 runtime 部件报错 / 3 等 setup（§N.4）；
 * - `doctor`：有 `fail` → 1，否则 0（warn 只是「可选/未配置」）。
 */
export function fromResponse(command: CommandDefinition, response: CliResponse): DispatchResult {
  if (!response.ok) {
    return {
      envelope: { ok: false, error: response.error },
      exit: response.notReady ? EXIT.notReady : exitForCode(response.error.code)
    }
  }
  const name = command.name.join(' ')
  if (name === 'doctor') {
    // doctor 跑完就是成功：逐项结论在 `result.checks`/`summary` 里。**不**把 fail 折算成
    // 退出码——§G.1 的 1 是「内部错误」，而「gh 没登录」不是内部错误；要不要按 fail 退出由
    // #44 的 setup 探针定（设计只给 `status` 规定了 0/1/2/3 的判定口径）。
    return { envelope: { ok: true, result: response.result }, exit: EXIT.ok }
  }
  if (name === 'status') {
    return { envelope: { ok: true, result: response.result }, exit: statusExitCode(response.result) }
  }
  if (name === 'health') {
    // `health` 只印 health 数组（`--text` 时更可读）。退出码不套用 `status` 的口径：
    // §N.4 只规定了 `status` 的 0/1/2/3 判定；`health` 是一次读成功就是 0（#45 决定是否统一）。
    const result = response.result as { readonly health?: unknown } | null
    return { envelope: { ok: true, result: { health: result?.health ?? {} } }, exit: EXIT.ok }
  }
  return { envelope: { ok: true, result: response.result }, exit: EXIT.ok }
}

/**
 * `status` 的退出码（§N.4，与上游 `scripts/dsh-superagent status` 对齐；#8 补「暂停」一档）。
 * 判定本身在 `http/state.ts` 的 `statusCode()`：`status` 与面板读同一个 `StateView`，
 * 两处不能各判一次。这里只把 0/1/2/3 换成 CLI 自己的 `ExitCode`。
 */
export function statusExitCode(view: unknown): ExitCode {
  return statusCode(view)
}

/** 全部命令名（`--help` 与契约测试用）。 */
export function commandNames(): readonly string[] {
  return CLI_COMMANDS.map((command) => command.name.join(' '))
}

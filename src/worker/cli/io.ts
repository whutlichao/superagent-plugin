// CLI 的参数解析、JSON/`--text` 输出、`{ok,result}` / `{ok:false,error}` 信封与退出码（§G.1）。
//
// 本文件是纯逻辑：不读写文件、不发网络、不读时钟。`src/bin/superagent.mjs` 只做三件事——
// 把 argv 交给这里、把结果打印出来、用这里算出的退出码退出。
//
// 退出码（§G.1 与 §N.4）：
// - `0` 成功；
// - `1` 内部错误；
// - `2` 固定拒绝（`error.code` 有值）；
// - `3` 未就绪（setup 未完成 / 已暂停 / 未启动）。
//
// 解析只做**语法**：把 `--flag value` / `--flag=value` / 开关 / 普通词分开。哪个词是命令、
// 哪个 flag 属于哪条命令，由 `commands.ts` 的命令表判定（前缀匹配最长的命令名）。
import { ApiError, ERROR_CODES, type ErrorPayload } from '../http/errors.ts'
import { REQUEST_ID_HEADER } from '../http/idempotency.ts'

/** `--request-id` 的 flag 名由 HTTP 头的名字派生，两处不会各写一份。 */
export const REQUEST_ID_FLAG = REQUEST_ID_HEADER.replace(/^x-superagent-/, '')

/** 退出码（§G.1 退出码行）。 */
export const EXIT = {
  ok: 0,
  internal: 1,
  refused: 2,
  notReady: 3
} as const

/** 一个退出码。 */
export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

/** 未就绪的固定错误码（CLI 本地产生；HTTP 侧的 503 `unavailable` 也归到这一档）。 */
export const NOT_READY_CODE = 'not_ready'

/** 解析后的 argv：命令路径留给命令表去认。 */
export interface ParsedArgs {
  /** 非 flag 的词（命令名 + 位置参数，按出现顺序）。 */
  readonly words: readonly string[]
  /** `--flag value` 与 `--flag=value` 合并后的记录；开关值为 `true`。 */
  readonly flags: Readonly<Record<string, string | true>>
  /** `--text`：人读文本输出；缺省（或 `--json`）是 JSON 信封。 */
  readonly text: boolean
}

/** 所有命令都接受的全局开关（其余开关由命令自己的 spec 决定）。 */
export const GLOBAL_FLAGS: readonly string[] = ['json', 'text', 'state-dir', 'token-file', REQUEST_ID_FLAG]

/**
 * `--token` 只在调试时用（§O：「`--token` 仅用于调试且日志脱敏」）：接受它，但整个 CLI
 * 从不打印 argv、从不把 token 写进输出或错误（`cli-contract.test.ts` 逐条断言）。
 * 正常路径是 `--token-file`（§G.5 的 prompt 只给文件路径）。
 */
export const DEBUG_TOKEN_FLAG = 'token' as const


/**
 * 只作为开关、永远不吃下一个参数的 flag。
 *
 * `text` 在这里有双重身份：全局的 `--text` 是「人读输出」的开关，而 `ticket note --text`
 * 是命令自己的备注正文（吃一个值）。解析层不认识命令表，所以统一按开关处理；命令表里的
 * `--text` 规格由 `dispatch` 判定——给成开关形态时按「缺值」拒绝，给成 `--text=…` 时按值用。
 */
export const BOOLEAN_FLAGS: readonly string[] = [
  'json',
  'text',
  'help',
  'yes',
  'confirm',
  'preview',
  'defaults',
  'history'
]

/**
 * 解析 argv（不含 `node` 与脚本路径）。
 *
 * 规则：
 * - `--flag=value` 与 `--flag value` 等价；布尔开关不吃下一个词；
 * - `--` 之后的一切都是普通词（以 `-` 开头的路径/长文本）；
 * - 缺值、空 flag 名、重复 flag、以及 `--token` 一律抛 `invalid_params`（退出 2）；
 * - 错误消息只提**这一个** flag 的名字：不回显 argv（argv 里可能有消息正文），也不回显值。
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string | true> = {}
  const words: string[] = []
  let index = 0

  while (index < argv.length) {
    const word = argv[index] as string
    index += 1

    if (word === '--') {
      while (index < argv.length) words.push(argv[index++] as string)
      break
    }

    if (!word.startsWith('--')) {
      words.push(word)
      continue
    }

    const body = word.slice(2)
    const equals = body.indexOf('=')
    const name = equals < 0 ? body : body.slice(0, equals)
    if (name.length === 0) throw invalidFlag('an empty flag name')
    if (Object.prototype.hasOwnProperty.call(flags, name)) {
      throw invalidFlag(`--${name} was given more than once`)
    }
    if (equals >= 0) {
      flags[name] = body.slice(equals + 1)
      continue
    }
    if (BOOLEAN_FLAGS.includes(name)) {
      flags[name] = true
      continue
    }
    const value = argv[index]
    if (value === undefined || value.startsWith('--')) throw invalidFlag(`--${name} needs a value`)
    index += 1
    flags[name] = value
  }

  return { words, flags, text: flags['text'] === true }
}

/** `invalid_params` 的统一构造：只提 flag 名，不作任何回显。 */
function invalidFlag(detail: string): ApiError {
  return new ApiError(ERROR_CODES.invalidParams, detail)
}

/** 读一个 flag 的字符串值（开关或缺失时 `undefined`）。 */
export function flagValue(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags[name]
  return typeof value === 'string' ? value : undefined
}

/** 读一个开关。 */
export function flagOn(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags[name] === true
}

/** 信封（§G.1）：成功 `{ok:true,result}`，失败 `{ok:false,error:{code,message,values?}}`。 */
export type Envelope =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: ErrorPayload }

/** 一个成功信封。 */
export function successEnvelope(result: unknown): Envelope {
  return { ok: true, result }
}

/** 一个失败信封。 */
export function failureEnvelope(error: ErrorPayload): Envelope {
  return { ok: false, error }
}

/**
 * 任意抛出物 → 固定失败信封 + 退出码。
 * - `ApiError`：原样（`code`/`message`/`values` 都是给调用方的固定值）；
 * - 其余：`internal` 且**不回显原文**（原文可能带路径、SQL 或 secret，§N.5）。
 */
export function envelopeForError(error: unknown): {
  readonly envelope: Envelope
  readonly exit: ExitCode
} {
  if (error instanceof ApiError) {
    return { envelope: failureEnvelope(error.toJSON()), exit: exitForCode(error.code) }
  }
  return {
    envelope: failureEnvelope({ code: ERROR_CODES.internal, message: 'Internal error' }),
    exit: EXIT.internal
  }
}

/**
 * 错误码 → 退出码（§G.1 与 §N.4）：
 * - `not_ready` / `unavailable`（未启动、未就绪、暂停）→ 3；
 * - `internal`（以及任何没登记的码：说不清就是内部错误）→ 1；
 * - 其余有值的固定码 → 2。
 */
export function exitForCode(code: string): ExitCode {
  if (code === NOT_READY_CODE || code === ERROR_CODES.unavailable) return EXIT.notReady
  if (code === ERROR_CODES.internal) return EXIT.internal
  return EXIT.refused
}

/**
 * 把信封渲染成 stdout 文本。JSON 模式是 `JSON.stringify(envelope, null, 2)`；
 * `--text` 只打人要看的那几行，但错误仍然带 `code`（脚本与人看的是同一个事实）。
 */
export function render(envelope: Envelope, options: { readonly text: boolean }): string {
  if (!options.text) return JSON.stringify(envelope, null, 2)
  if (!envelope.ok) {
    const { code, message, values } = envelope.error
    const slots =
      values === undefined ? '' : ` (${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(', ')})`
    return `error: ${code}: ${message}${slots}`
  }
  return renderResult(envelope.result)
}

/**
 * `result` 的人读渲染：字符串原样，数组一行一项，对象按 `key: value` 平铺；
 * 嵌套值折成一行 JSON（足够读 health/status，不做完整 YAML）。
 */
export function renderResult(result: unknown): string {
  if (result === undefined || result === null) return 'ok'
  if (typeof result === 'string') return result
  if (typeof result === 'number' || typeof result === 'boolean') return String(result)
  if (Array.isArray(result)) {
    if (result.length === 0) return '(none)'
    return result.map((entry) => `- ${oneLine(entry)}`).join('\n')
  }
  if (typeof result === 'object') {
    const lines = Object.entries(result as Record<string, unknown>).map(
      ([key, value]) => `${key}: ${oneLine(value)}`
    )
    return lines.length === 0 ? 'ok' : lines.join('\n')
  }
  return String(result)
}

/** 单行渲染：标量直接写，对象/数组折成 JSON。 */
function oneLine(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

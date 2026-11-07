// 日志落盘（§N.5、§D.5）：`<stateDir>/logs/worker-<YYYYMMDD>.log`，JSON 行
// `{ts, level, msg, fields?}`，按日滚动、只保留十个；关键行同时交给 `orca.log`（由组合根
// 注入 `mirror`，本文件不 import `orca`，也不越过运行缝）。
//
// 最硬的规矩是脱敏：token、密钥、消息正文、CLI argv、`gh` 输出全文永不进日志。允许写进去的
// 只有标识与读数——message id、ticket id、长度、状态码、错误码。因此本模块是**唯一出口**：
// - 字段名命中密钥/正文族（`token`、`secret`、`body`、`argv`…）→ 整个值换成 `[redacted]`；
// - 数组/对象一律不序列化（argv 与消息正文通常就是这两种形状）；
// - 字符串再走一遍内容脱敏（`ghp_…`、`sk-…`、JWT、`Bearer …`、`token=…`、长 base64url）；
// - 单值截断，避免「短正文」借道普通字段整段落盘。
//
// 写日志失败不打断 worker：日志是旁路，不是业务路径。
import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { formatLogLine, type LogLine, type LogSink } from './log-line.ts'

/** 保留的日志文件份数（§N.5：按日滚动，保留 10 个）。 */
export const LOG_KEEP = 10

/** 日志目录名（`<stateDir>/logs`，§D.5）。 */
export const LOG_DIR_NAME = 'logs'

/** 一个日志文件的名字（只认这个形状；清理时不碰别的文件）。 */
const LOG_FILE = /^worker-\d{8}\.log$/

/** 单值截断长度：读数够用，正文整段落不进来。 */
const MAX_FIELD_CHARS = 160

/** 人写的那一行（`msg`）的截断长度。 */
const MAX_MESSAGE_CHARS = 300

/** 脱敏后的占位符。 */
export const REDACTED = '[redacted]'

/** 字段值：调用方给什么都可以，出口只写安全的形态。 */
export interface LogFields {
  readonly [key: string]: unknown
}

/** 进脱敏之前的一行：字段值可以是任何东西，出口会把它们变成 `LogLine` 的安全形态。 */
interface RawLogLine {
  readonly ts: string
  readonly level: LogLine['level']
  readonly msg: string
  readonly fields?: LogFields
}

/** 日志出口（组合根把 `mirror` 接到 `orca.log`）。 */
export interface Logger {
  /** 与既有 `LogSink` 兼容的出口：迁移、锁、保留策略都把日志行交给它。 */
  readonly sink: LogSink
  write(line: LogLine): void
  info(msg: string, fields?: LogFields): void
  warn(msg: string, fields?: LogFields): void
  error(msg: string, fields?: LogFields): void
  /** 关键行：除落盘外也镜像到 `orca.log`（§N.5「关键行同时给 Orca 自己的日志」）。 */
  key(msg: string, fields?: LogFields): void
  /** 当前正在写的文件（同一天内不换；测试与 doctor 读它）。 */
  currentFile(): string
}

/** 建 logger 的输入。 */
export interface LogOptions {
  /** 状态目录（§D.5）；日志落 `<stateDir>/logs/`。 */
  readonly stateDir: string
  /** 保留份数（缺省 `LOG_KEEP`）。 */
  readonly keep?: number
  /** 时钟（测试注入固定时刻；文件名按 UTC 的 `YYYYMMDD`）。 */
  readonly now?: () => Date
  /** 关键行/告警/错误的镜像出口（组合根传 `orca.log`）。 */
  readonly mirror?: (message: string) => void
}

/** 字段名命中这些族时整值脱敏：密钥族按后缀，正文/参数族按整名。 */
const SECRET_FIELD_NAME =
  /(?:token|secret|password|passwd|authorization|api[-_]?key)$|^(?:body|text|content|message|payload|argv|args|command|cmd|output|stdout|stderr|prompt|note)$/i

/** 内容里可识别的密钥形态；一次替换成 `REDACTED`。 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // `Bearer <token>`：先替换，避免被下面的 `authorization: …` 规则拆成两半。
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bgh[pousr]_[A-Za-z0-9_]{10,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{10,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
  // `token=…` / `secret: …` 这类赋值形态（`Bearer` 交给上一条，别在这里拆开）。
  /\b(token|secret|password|passwd|api[-_]?key|authorization)\b\s*[:=]\s*(?!Bearer\b)\S+/gi,
  // 长 base64url（含大小写与数字）：32 位十六进制 id 不含大写字母，因此不会被误伤。
  /\b(?=[A-Za-z0-9_-]{32,}\b)(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}\b/g
]

/** 一天的文件名（UTC 的 `YYYYMMDD`；同一天的日志追加到同一个文件）。 */
export function logFileName(at: Date): string {
  const year = at.getUTCFullYear()
  const month = String(at.getUTCMonth() + 1).padStart(2, '0')
  const day = String(at.getUTCDate()).padStart(2, '0')
  return `worker-${year}${month}${day}.log`
}

/** 日志目录（`<stateDir>/logs`）。 */
export function logDir(stateDir: string): string {
  return join(stateDir, LOG_DIR_NAME)
}

/**
 * 只保留最近 `keep` 个日志文件（按日期名排序即按时间排序），删掉更早的。
 * 只认 `worker-<8 位数字>.log`，别的东西不碰。
 */
export function pruneLogFiles(directory: string, keep: number = LOG_KEEP): readonly string[] {
  let names: readonly string[]
  try {
    names = readdirSync(directory).filter((name) => LOG_FILE.test(name))
  } catch {
    return []
  }
  const sorted = [...names].sort()
  for (const name of sorted.slice(0, Math.max(0, sorted.length - keep))) {
    try {
      unlinkSync(join(directory, name))
    } catch {
      // 删不掉旧日志不该让 worker 停下：下一轮滚动再试。
    }
  }
  return sorted.slice(Math.max(0, sorted.length - keep))
}

/** 内容脱敏：把可识别的密钥形态换成占位符。 */
export function redactText(text: string): string {
  let result = text
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match, name?: string) => {
      if (typeof name === 'string') return `${name}=${REDACTED}`
      return match.toLowerCase().startsWith('bearer') ? `Bearer ${REDACTED}` : REDACTED
    })
  }
  return result
}

/** 字符串截断（超长正文不整段落盘）。 */
function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

/** 一个字段的出口形态：密钥族与结构体整值脱敏，读数原样保留。 */
function sanitizeField(key: string, value: unknown): string | number | undefined {
  if (value === undefined || value === null) return undefined
  if (SECRET_FIELD_NAME.test(key)) return REDACTED
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value !== 'string') return REDACTED
  return truncate(redactText(value), MAX_FIELD_CHARS)
}

/** 整行脱敏（`sink` 收到的行也走这一处，出口只有一份规则）。 */
function sanitizeLine(line: RawLogLine): LogLine {
  const fields: Record<string, string | number> = {}
  let wrote = false
  for (const [key, value] of Object.entries(line.fields ?? {})) {
    const safe = sanitizeField(key, value)
    if (safe === undefined) continue
    fields[key] = safe
    wrote = true
  }
  const sanitized: LogLine = {
    ts: line.ts,
    level: line.level,
    msg: truncate(redactText(line.msg), MAX_MESSAGE_CHARS),
    ...(wrote ? { fields } : {})
  }
  return sanitized
}

/** 镜像给 `orca.log` 的一行：人能读，且已脱敏。 */
function mirrorText(line: LogLine): string {
  const fields = line.fields === undefined ? '' : ` ${JSON.stringify(line.fields)}`
  return `superagent ${line.level}: ${line.msg}${fields}`
}

/**
 * 建一个日志出口：确保 `<stateDir>/logs` 存在、清掉超出保留份数的旧文件，之后每次写都落到
 * 当天的文件；跨日时自动滚动并再清一次。`mirror` 只收关键行、告警与错误。
 */
export function createLogger(options: LogOptions): Logger {
  const keep = options.keep ?? LOG_KEEP
  const now = options.now ?? (() => new Date())
  const mirror = options.mirror
  const directory = logDir(options.stateDir)
  let day = ''
  let fileName = join(directory, logFileName(now()))

  /** 落盘 + 按需镜像；`mirrorAlways` 是 `key` 与普通 `info` 的唯一区别。 */
  const write = (line: RawLogLine, mirrorAlways = false): void => {
    const sanitized = sanitizeLine(line)
    const today = logFileName(now())
    const rotated = today !== day
    if (rotated) {
      day = today
      fileName = join(directory, today)
      mkdirSync(directory, { recursive: true })
    }
    try {
      appendFileSync(fileName, `${formatLogLine(sanitized)}\n`, 'utf8')
    } catch {
      // 日志是旁路：写不进去也不打断业务；镜像还能把它送到 `orca.log`。
    }
    // 滚动/首次写入之后才清理：先让当天的文件存在，再按「含今天共十个」删旧的。
    if (rotated) pruneLogFiles(directory, keep)
    if ((mirrorAlways || sanitized.level !== 'info') && mirror !== undefined) {
      mirror(mirrorText(sanitized))
    }
  }

  const emit = (level: LogLine['level'], msg: string, fields?: LogFields): void => {
    write({ ts: now().toISOString(), level, msg, ...(fields === undefined ? {} : { fields }) })
  }

  mkdirSync(directory, { recursive: true })

  return {
    // `sink` 只保证收 `LogLine`；字段值的脱敏在 `sanitizeLine` 里统一做。
    sink: (line) => write(line),
    write,
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    key: (msg, fields) =>
      write({ ts: now().toISOString(), level: 'info', msg, ...(fields === undefined ? {} : { fields }) }, true),
    currentFile: () => fileName
  }
}

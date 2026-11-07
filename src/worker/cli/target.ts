// CLI 的目标解析（§G.4 第 1–3 条）：状态目录 → 端口 → token。
//
// 三条解析各自独立、各自可降级：
// - 状态目录：`--state-dir` ＞ `$ORCA_SUPERAGENT_STATE_DIR` ＞ 默认（含指针文件，`infra/paths.ts`）；
// - 端口：`<stateDir>/api-port` 的实际监听端口，缺失/失效时回退 3847（S6 的回落）；
// - token：`--token` ＞ `$ORCA_SUPERAGENT_TOKEN_FILE` ＞ `<stateDir>/api-token`（每次现读，
//   轮换后无需重启）。
//
// 纪律（§O 鉴权）：token 只进 `Authorization` 头。它不进 URL、不进 argv（CLI 侧只接受
// `--token-file`，`--token` 仅用于调试）、不进任何错误信封；`baseUrl` 是唯一拼给 HTTP 客户端的
// 前缀，因此这里显式断言它不含 token。
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { resolveStateDir, type StateDirSource } from '../infra/paths.ts'
import { API_TOKEN_FILE, TOKENS_DIR, ROUTER_TOKEN_FILE } from '../infra/tokens.ts'
import { DEFAULT_PORT, readPortRecord } from '../http/port-file.ts'

export { DEFAULT_PORT, PORT_FILE } from '../http/port-file.ts'

/** token 文件环境变量（§G.4 第 3 条）。 */
export const TOKEN_ENV = 'ORCA_SUPERAGENT_TOKEN_FILE'

/** token 的来源（doctor 与 `status` 用来说明「拿的是哪把钥匙」）。 */
export type TokenSource = 'argument' | 'environment' | 'default'

/** 一次 token 解析的结果；一个文件都没有时 `token` 为 `null`（由调用点报 not_ready）。 */
export interface TokenResolution {
  readonly token: string | null
  readonly source: TokenSource
  /** 实际读到的文件路径（`--token` 直接给值时为 `null`）。 */
  readonly tokenFile: string | null
}

/** CLI 连 worker 需要的一切。 */
export interface CliTarget {
  readonly stateDir: string
  readonly stateDirSource: StateDirSource
  readonly port: number
  /** `http://127.0.0.1:<port>/superagent/api`；**绝不含 token**。 */
  readonly baseUrl: string
  readonly token: string | null
  readonly tokenSource: TokenSource
  readonly tokenFile: string | null
}

/** 读一个 token 文件；缺失或空白都返回 `null`（只关心「有没有」）。 */
function readTokenFile(path: string): string | null {
  try {
    const text = readFileSync(path, 'utf8').trim()
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}

/** 一个候选值是否「给了」：非空字符串才算。 */
function given(value: string | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

/**
 * 端口：读 `<stateDir>/api-port`（`readPortRecord` 已处理「纯数字旧形态」与「写文件的进程
 * 已不在」）。没有可用记录就回退 3847 —— 与 worker 的首选端口一致。
 */
export function resolvePort(stateDir: string): number {
  return readPortRecord(stateDir)?.port ?? DEFAULT_PORT
}

/**
 * token 三重解析（§G.4 第 3 条）。`--token` 是调试逃生口：它不写日志、不进错误；
 * 正常路径是 `--token-file`/环境变量给的**文件路径**（§G.5：prompt 里只给路径）。
 */
export function resolveToken(input: {
  readonly stateDir: string
  readonly argument?: string | undefined
  /** `--token-file`：它比环境变量与默认文件都优先（同一个「文件」层级里最显式）。 */
  readonly file?: string | undefined
  readonly env?: Readonly<Record<string, string | undefined>>
}): TokenResolution {
  const direct = given(input.argument)
  if (direct !== null) return { token: direct, source: 'argument', tokenFile: null }

  const flagFile = given(input.file)
  if (flagFile !== null) {
    const token = readTokenFile(flagFile)
    if (token !== null) return { token, source: 'argument', tokenFile: flagFile }
  }

  const env = input.env ?? process.env
  const fromEnv = given(env[TOKEN_ENV])
  if (fromEnv !== null) {
    const token = readTokenFile(fromEnv)
    if (token !== null) return { token, source: 'environment', tokenFile: fromEnv }
  }

  const fallback = join(input.stateDir, API_TOKEN_FILE)
  const token = readTokenFile(fallback)
  return { token, source: 'default', tokenFile: token === null ? null : fallback }
}

/**
 * 一次解析出全部三项。`stateDir` 先算（端口与默认 token 文件都跟着它走），
 * 所以改设置里的状态目录只需改指针文件，端口与 token 自动跟随。
 */
export function resolveTarget(
  input: {
    readonly stateDir?: string | undefined
    readonly token?: string | undefined
    /** `--token-file`（§G.5 的 agent 用法：prompt 里给的就是它的绝对路径）。 */
    readonly tokenFile?: string | undefined
    readonly env?: Readonly<Record<string, string | undefined>>
    readonly home?: string | undefined
  } = {}
): CliTarget {
  const state = resolveStateDir({ argument: input.stateDir, env: input.env ?? process.env, home: input.home })
  const port = resolvePort(state.stateDir)
  const token = resolveToken({
    stateDir: state.stateDir,
    argument: input.token,
    file: input.tokenFile,
    env: input.env ?? process.env
  })
  return {
    stateDir: state.stateDir,
    stateDirSource: state.source,
    port,
    baseUrl: `http://127.0.0.1:${port}/superagent/api`,
    token: token.token,
    tokenSource: token.source,
    tokenFile: token.tokenFile
  }
}

/**
 * router token 的文件路径（`<stateDir>/tokens/router`）。doctor 用它判断「router 的钥匙在不在」；
 * 这里只拼路径，不读内容。
 */
export function routerTokenFile(stateDir: string): string {
  return join(stateDir, TOKENS_DIR, ROUTER_TOKEN_FILE)
}

/**
 * 把一个值编码成单个 URL 路径段：`/`、空格、`#`、`:` 都必须转义，否则 Thread 键
 * （可能带 `/` 与空白）会被切成多段或被当成片段标识。
 */
export function encodePathSegment(value: string): string {
  return encodeURIComponent(value)
}

/** 一个路径是否是可用的绝对路径（`--state-dir` 的输入校验用）。 */
export function isAbsolutePath(value: string): boolean {
  return isAbsolute(value)
}

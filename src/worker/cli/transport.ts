// CLI 的 HTTP 客户端（§G.4 第 4 条、§G.1 的输出与退出码）。
//
// 一份请求最多试两次：**只有连不上**（拒绝连接、连接被重置、超时）才在 200 ms 后重试一次，
// 然后以「未就绪」收场并提示跑 `superagent doctor`。收到了 HTTP 响应就不重试——写命令可能
// 已经执行过，重放要靠 `--request-id` 的幂等，而不是客户端偷偷再来一次。
//
// 不做长轮询、不做退避、不 sleep 等待：agent 的 bash 调用不该卡住（§G.4 第 4 条）。
import { request as httpRequest } from 'node:http'
import type { ApiEnvelope, ErrorPayload } from '../http/errors.ts'
import type { CliTarget } from './target.ts'

/** 连接失败后的唯一一次重试间隔（§G.4 第 4 条的 200 ms）。 */
export const RETRY_DELAY_MS = 200

/** 单个请求的上限：HTTP handler 不承诺超过 10 s 的同步等待（§O 超时行）。 */
export const REQUEST_TIMEOUT_MS = 10_000

/** 未就绪的固定错误码（连接不上 / token 缺失 / 503 unavailable 都归到这里）。 */
export const NOT_READY_CODE = 'not_ready'

/** 一次调用结果：成功带 `result`，失败带固定 `error.code`；`notReady` 决定退出码 3。 */
export type CliResponse =
  | { readonly ok: true; readonly status: number; readonly result: unknown }
  | {
      readonly ok: false
      readonly status: number | null
      readonly notReady: boolean
      readonly error: ErrorPayload
    }

/** 一次请求的输入。 */
export interface RequestOptions {
  readonly target: CliTarget
  readonly method: 'GET' | 'POST' | 'PUT'
  /** 相对 `/superagent/api` 的路径（已编码；参数用 `encodePathSegment`）。 */
  readonly path: string
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>
  /** JSON body；写方法才发。 */
  readonly body?: unknown
  /** `--request-id`：写命令的幂等键（§G.1 幂等行）。 */
  readonly requestId?: string | null
  /** 重试前的等待（测试注入，避免真 sleep）。 */
  readonly sleep?: (milliseconds: number) => Promise<void>
}

/** 默认的等待：真睡（只有连不上时才走到这里，最多一次 200 ms）。 */
const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })

/** 连接失败的 Node 错误码（这些才重试；HTTP 状态码不是连接失败）。 */
const CONNECTION_ERRORS = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ERR_SOCKET_CONNECTION_TIMEOUT'
])

/** 把 `baseUrl` + 相对路径 + 查询串拼成一个请求路径。 */
export function requestPath(
  options: Pick<RequestOptions, 'path' | 'query'>
): string {
  const base = `/superagent/api/${options.path.replace(/^\/+/, '')}`
  const query = options.query ?? {}
  const pairs: string[] = []
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  }
  return pairs.length === 0 ? base : `${base}?${pairs.join('&')}`
}

/** 未就绪的统一信封：一句话，附带「跑 doctor」的提示，绝不含 token 或 argv。 */
export function notReadyError(detail: string): ErrorPayload {
  return {
    code: NOT_READY_CODE,
    message: `${detail}; run \`superagent doctor\` to see what is missing`
  }
}

/** 发送一次 HTTP 调用并把信封收敛成 `CliResponse`。 */
export async function requestJson(options: RequestOptions): Promise<CliResponse> {
  const sleep = options.sleep ?? defaultSleep
  const first = await attempt(options)
  if (first.kind === 'response') return first.response
  await sleep(RETRY_DELAY_MS)
  const second = await attempt(options)
  if (second.kind === 'response') return second.response
  return {
    ok: false,
    status: null,
    notReady: true,
    error: notReadyError(
      `the Superagent worker is not reachable at 127.0.0.1:${options.target.port}`
    )
  }
}

/** 一次尝试的结果：拿到响应，或连接失败（触发唯一一次重试）。 */
type Attempt =
  | { readonly kind: 'response'; readonly response: CliResponse }
  | { readonly kind: 'unreachable'; readonly reason: string }

/** 发一个请求；只有连接类错误算 `unreachable`。 */
function attempt(options: RequestOptions): Promise<Attempt> {
  return new Promise<Attempt>((resolve) => {
    const payload =
      options.body === undefined || options.method === 'GET' ? undefined : JSON.stringify(options.body)
    const headers: Record<string, string> = {
      accept: 'application/json'
    }
    if (options.target.token !== null) headers['authorization'] = `Bearer ${options.target.token}`
    if (payload !== undefined) headers['content-type'] = 'application/json'
    // 写方法要求显式的请求头（§G.3 第 5 条）；读方法带上也无害，但只给写方法加。
    if (options.method !== 'GET') headers['x-superagent-request'] = '1'
    if (typeof options.requestId === 'string' && options.requestId.length > 0) {
      headers['x-superagent-request-id'] = options.requestId
    }

    let settled = false
    const finish = (result: Attempt): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port: options.target.port,
        path: requestPath(options),
        method: options.method,
        headers
      },
      (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          text += chunk
        })
        response.on('end', () => finish({ kind: 'response', response: parseResponse(response.statusCode ?? 0, text) }))
        response.on('error', (error) => finish({ kind: 'unreachable', reason: error.message }))
      }
    )
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy()
      finish({ kind: 'unreachable', reason: 'timed out' })
    })
    request.on('error', (error) => {
      const code = (error as { code?: unknown }).code
      if (typeof code === 'string' && CONNECTION_ERRORS.has(code)) {
        finish({ kind: 'unreachable', reason: code })
        return
      }
      // 非连接类错误（例如本地 socket 参数错误）：同样不可达，但原因照实带回去。
      finish({ kind: 'unreachable', reason: error.message })
    })
    request.end(payload)
  })
}

/**
 * 把一次 HTTP 响应变成 `CliResponse`：
 * - 200 + `{ok:true}` → 成功；
 * - 任何带 `{ok:false,error}` 的响应 → 失败，`notReady` 只在 503 `unavailable` 时为真；
 * - 不是合法信封（HTML、空 body）→ `internal`（不改写成「拒绝」，那是另一回事）。
 */
export function parseResponse(status: number, text: string): CliResponse {
  let envelope: ApiEnvelope | null = null
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && 'ok' in parsed) {
      envelope = parsed as ApiEnvelope
    }
  } catch {
    envelope = null
  }

  if (envelope !== null && envelope.ok === true) {
    return status === 200
      ? { ok: true, status, result: envelope.result }
      : { ok: false, status, notReady: false, error: { code: 'internal', message: 'Unexpected success status' } }
  }
  if (envelope !== null && envelope.ok === false) {
    const error = envelope.error
    return {
      ok: false,
      status,
      notReady: error.code === 'unavailable',
      error: { code: error.code, message: error.message, ...(error.values === undefined ? {} : { values: error.values }) }
    }
  }
  return {
    ok: false,
    status,
    notReady: false,
    error: { code: 'internal', message: `The worker answered with HTTP ${status} and no JSON envelope` }
  }
}

// CLI 测试用的真 loopback 服务器（#7 的 `startHttpServer`）+ 真库 + 真 token 文件。
//
// 不用 fake HTTP：CLI 的解析、重试、信封与退出码都要对真实的 Host/Origin/鉴权/限流边界成立，
// 假服务器会把「Host 头不对」「写方法缺显式请求头」这些真实失败面测没了（§P.1 第 3 条）。
import type { Store } from '../../src/worker/app/store.ts'
import { openStore } from '../../src/worker/app/store.ts'
import type { RequestLogLine } from '../../src/worker/http/server.ts'
import { startHttpServer, type HttpServerHandle } from '../../src/worker/http/server.ts'
import type { RouteDefinition } from '../../src/worker/http/routes.ts'
import { ROUTE_TABLE } from '../../src/worker/http/routes.ts'
import type { HttpHost } from '../../src/worker/http/state.ts'
import {
  ensureApiToken,
  issueAssignmentToken,
  issueRouterToken,
  readApiToken
} from '../../src/worker/infra/tokens.ts'
import { createRateLimiter, type RateLimiter } from '../../src/worker/http/rate-limit.ts'
import type { CliTarget } from '../../src/worker/cli/target.ts'
import type { OpsPorts } from '../../src/worker/http/ops.ts'
import { readdirSync } from 'node:fs'
import { tempStateDir } from './state.ts'

/** 一次 CLI 调用的目标：状态目录、端口、token（与 `resolveTarget` 同形）。 */
export interface TestServer {
  readonly stateDir: string
  readonly port: number
  readonly store: Store
  readonly server: HttpServerHandle
  /** 服务器收到的请求（断言「只打了一次」「没有把 token 写进路径」用）。 */
  readonly requests: RequestLogLine[]
  /** 主 token（operator 角色）；轮换后这个值失效，用 `stableOperatorToken` 取长期身份。 */
  readonly operatorToken: string
  /** 当前 `api-token` 文件里的值（轮换后是新值；缺省没有时回退到启动时的值）。 */
  readOperatorToken(): string
  /** `<stateDir>/backups` 里的文件名（幂等用例数「真的执行了几次」）。 */
  readdirBackups(): readonly string[]
  /** 签一个 router token 并返回原文。 */
  routerToken(): string
  /** 签一个 assignment token 并返回原文。 */
  assignmentToken(ticketId: string, assignmentId: string): string
  /** 一个指向本服务器的 CLI 目标；不传 token 时用主 token 文件（会随轮换更新）。 */
  target(token?: string | null): CliTarget
  close(): void
}

/** 起服务器的选项：与 `startHttpServer` 同名的开关，外加宽容的限流器。 */
export interface TestServerOptions {
  readonly host?: Partial<HttpHost>
  /**
   * 路由表，或一个按**本服务器自己打开的库**造路由表的函数（prompt 版本、设置块这些 handler
   * 拿不到 `startHttpServer` 里的 store，只能这样接线；与组合根同一份 handler）。
   */
  readonly routes?: readonly RouteDefinition[] | ((store: Store) => readonly RouteDefinition[])
  readonly rateLimiter?: RateLimiter
  /** 运维命令的接线（doctor 的子进程出口、source labels 的端口、时钟）。 */
  readonly ops?: OpsPorts
}

/**
 * 起一个测试服务器：临时状态目录、真库、真 token、临时端口（端口文件照样落盘）。
 * 调用方负责 `close()`（幂等）。
 */
export async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const stateDir = tempStateDir()
  const store = openStore({ stateDir })
  const operatorToken = ensureApiToken(stateDir).token
  const requests: RequestLogLine[] = []
  const host: HttpHost = { store, stateDir, ...options.host }
  const server = await startHttpServer({
    stateDir,
    host,
    preferredPort: 0,
    // 限流另有用例；其余用例不该被 60/min 绊倒。
    rateLimiter: options.rateLimiter ?? createRateLimiter({ perMinute: 60_000, burst: 10_000 }),
    routes:
      options.routes === undefined
        ? ROUTE_TABLE
        : typeof options.routes === 'function'
          ? options.routes(store)
          : options.routes,
    ...(options.ops === undefined ? {} : { ops: options.ops }),
    log: (line) => void requests.push(line)
  })
  return {
    stateDir,
    port: server.port,
    store,
    server,
    requests,
    operatorToken,
    readOperatorToken: () => readApiToken(stateDir) ?? operatorToken,
    readdirBackups: () => {
      try {
        return readdirSync(store.backupDir).filter((name) => name.endsWith('.sqlite'))
      } catch {
        return []
      }
    },
    routerToken: () => issueRouterToken({ store, stateDir }).token,
    assignmentToken: (ticketId, assignmentId) =>
      issueAssignmentToken({
        store,
        stateDir,
        ticketId,
        assignmentId,
        expiresAt: '2099-01-01T00:00:00.000Z'
      }).token,
    // 缺省 token 每次现读文件：`admin rotate-token` 换掉的旧值因此立刻失效，
    // 与真实 CLI「每次解析都读文件」的行为一致。
    target: (token = readApiToken(stateDir)) => ({
      stateDir,
      stateDirSource: 'argument',
      port: server.port,
      baseUrl: `http://127.0.0.1:${server.port}/superagent/api`,
      token,
      tokenSource: token === null ? 'default' : 'argument',
      tokenFile: null
    }),
    close: () => {
      server.close()
      store.close()
    }
  }
}

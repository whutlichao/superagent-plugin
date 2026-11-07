// `node:*` 的最小声明：只声明本仓库真正用到的成员（§N.3 其二）。
// 理由：装 `@types/node` 会引入整套全局类型并与 `"types": []` 冲突，而插件必须能离线
// `npx tsc -p .`。成员随使用增长时在这里补，不引入 npm 类型包。
//
// 当前用到：`node:fs`（store/lock/migration 与 tests/support/repo.ts）、`node:path`、
// `node:os`（临时状态目录）、`node:sqlite`（§D.2 的唯一真源）、`node:crypto` 的
// createHash（`core/ids.ts`，§C.2 规则 1 允许的唯一内置模块）与 randomBytes/timingSafeEqual
// （`infra/tokens.ts` 的 token 签发与常数时间比较）、`node:http`（§G.3 的 loopback API）、
// `node:test` / `node:assert/strict`（纯领域测试不 import `orca/testing`，§P.6）、
// `import.meta.dirname`、`process.env|pid|hrtime` 与 `AbortSignal`（运行缝签名）。

/** `node:path` 的 `join` / `dirname` / `resolve` / `basename` / `isAbsolute`，只声明本仓库用到的签名。 */
declare module 'node:path' {
  export function join(...parts: string[]): string
  export function dirname(path: string): string
  export function resolve(...parts: string[]): string
  export function basename(path: string): string
  export function isAbsolute(path: string): boolean
}

/**
 * `node:child_process` 的 `execFile`：`sources/commands.ts` 是唯一允许起子进程的地方（§I.4）。
 * 只声明本仓库用到的成员：参数是 argv 数组、选项里有 `shell`（本仓库永远传 `false`）。
 */
declare module 'node:child_process' {
  export interface ExecFileOptions {
    cwd?: string
    env?: Record<string, string | undefined>
    signal?: AbortSignal
    timeout?: number
    maxBuffer?: number
    encoding?: 'utf8'
    /** 本仓库永远传 `false`：argv 数组直达 exec，不经 shell（§O 命令注入）。 */
    shell?: boolean
  }
  /** `execFile` 的失败形态：退出码/信号/是否被杀，以及标准错误（可能含 CLI 的诊断文本）。 */
  export interface ExecFileError extends Error {
    code?: number | string
    killed?: boolean
    signal?: string | null
    stderr?: string
    stdout?: string
  }
  export function execFile(
    file: string,
    args: readonly string[],
    options: ExecFileOptions,
    callback: (error: ExecFileError | null, stdout: string, stderr: string) => void
  ): unknown
}

/** `node:fs` 的同步子集（避免测试里出现异步竞态）。 */
declare module 'node:fs' {
  export interface Dirent {
    readonly name: string
    isDirectory(): boolean
    isFile(): boolean
  }
  export interface Stats {
    readonly size: number
    readonly mtimeMs: number
    readonly mode: number
    isFile(): boolean
    isDirectory(): boolean
  }
  export function readFileSync(path: string, encoding: 'utf8'): string
  export function writeFileSync(path: string, data: string, encoding?: 'utf8'): void
  /** 带权限位的写入：可执行的 shim（§H.11）需要 `mode`。 */
  export function writeFileSync(
    path: string,
    data: string,
    options: { readonly encoding: 'utf8'; readonly mode: number }
  ): void
  export function appendFileSync(path: string, data: string, encoding: 'utf8'): void
  export function readdirSync(
    path: string,
    options: { readonly withFileTypes: true }
  ): readonly Dirent[]
  export function readdirSync(path: string): readonly string[]
  export function statSync(path: string): Stats
  export function existsSync(path: string): boolean
  export function mkdirSync(path: string, options: { readonly recursive: true }): void
  export function mkdtempSync(prefix: string): string
  export function unlinkSync(path: string): void
  export function renameSync(from: string, to: string): void
  export function rmSync(path: string, options?: { readonly recursive?: boolean; readonly force?: boolean }): void
  export function utimesSync(path: string, atime: Date, mtime: Date): void
  export function utimesSync(path: string, atime: number, mtime: number): void
  export function openSync(path: string, flags: string, mode?: number): number
  export function closeSync(fd: number): void
  export function writeSync(fd: number, data: string, encoding: 'utf8'): number
  export function fsyncSync(fd: number): void
}

/** `node:os`：临时目录与家目录（§D.5 的 stateDir 默认值）。 */
declare module 'node:os' {
  export function tmpdir(): string
  export function homedir(): string
}

/** `node:crypto` 的 hash 子集：领域只用它派生稳定 key（§D.1、§C.2 规则 1）。 */
declare module 'node:crypto' {
  export interface Hash {
    update(data: string): Hash
    digest(encoding: 'hex'): string
  }
  export function createHash(algorithm: 'sha256'): Hash
  /** 32 字节随机数（token 的熵源，§D.6）。 */
  export function randomBytes(size: number): { toString(encoding: 'base64url'): string }
  /** 常数时间比较：token 校验不做早退（§O 鉴权）。 */
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean
}

/** `node:http` 的 loopback 服务端子集（§G.3）。只声明本仓库用到的成员：
 *  `createServer` 的处理器、`listen`/`close`/`closeAllConnections`/`address`，
 *  以及测试用的客户端 `request`。 */
declare module 'node:http' {
  /** 请求头（小写键；值是字符串或字符串数组）。 */
  export interface IncomingHttpHeaders {
    readonly host?: string
    readonly origin?: string
    readonly authorization?: string
    readonly cookie?: string
    readonly 'content-type'?: string
    readonly 'content-length'?: string
    readonly 'retry-after'?: string
    readonly 'x-superagent-request'?: string
    readonly [name: string]: string | readonly string[] | undefined
  }

  export interface IncomingMessage {
    readonly method?: string
    readonly url?: string
    readonly headers: IncomingHttpHeaders
    setEncoding(encoding: 'utf8'): void
    /** 排空剩余数据（拒绝大 body 时用，避免对端 EPIPE）。 */
    resume(): void
    on(event: 'data', listener: (chunk: string) => void): void
    on(event: 'end', listener: () => void): void
    on(event: 'error', listener: (error: Error) => void): void
  }

  export interface ServerResponse {
    readonly statusCode: number
    writeHead(status: number, headers?: Readonly<Record<string, string>>): void
    end(chunk?: string): void
  }

  /** 监听地址（`address()` 的返回；Unix socket 不在本仓库的用法里）。 */
  export interface AddressInfo {
    readonly address: string
    readonly family: string
    readonly port: number
  }

  export interface Server {
    listen(port: number, host: string, callback?: () => void): void
    close(callback?: () => void): void
    closeAllConnections(): void
    address(): AddressInfo | string | null
    on(event: 'error', listener: (error: Error) => void): void
    once(event: 'error', listener: (error: Error) => void): void
    once(event: 'listening', listener: () => void): void
    removeListener(event: 'error', listener: (error: Error) => void): void
    removeListener(event: 'listening', listener: () => void): void
    unref(): void
  }

  export type RequestListener = (request: IncomingMessage, response: ServerResponse) => void

  export function createServer(listener: RequestListener): Server

  /** 测试客户端的响应：状态码 + 头 + 正文分块。 */
  export interface ClientResponse {
    readonly statusCode?: number
    readonly statusMessage?: string
    readonly headers: IncomingHttpHeaders
    setEncoding(encoding: 'utf8'): void
    on(event: 'data', listener: (chunk: string) => void): void
    on(event: 'end', listener: () => void): void
    on(event: 'error', listener: (error: Error) => void): void
  }

  /** 测试客户端：只有它能发送任意的 `Host`（`fetch` 会覆写成目标地址）。 */
  export interface ClientRequest {
    on(event: 'error', listener: (error: Error) => void): void
    end(chunk?: string): void
  }

  export function request(
    options: {
      readonly host: string
      readonly port: number
      readonly path: string
      readonly method: string
      readonly headers?: Readonly<Record<string, string>>
    },
    callback: (response: ClientResponse) => void
  ): ClientRequest
}

/** `node:net`：端口探测（S6 的重复绑定与占用判定）。 */
declare module 'node:net' {
  export interface Socket {
    destroy(): void
    on(event: 'error', listener: (error: Error) => void): void
  }
  export function connect(options: { readonly host: string; readonly port: number }, callback?: () => void): Socket
}

/**
 * `node:sqlite` 的同步 API（§D.2 指定的唯一打开方式）。
 * 只声明本仓库用到的成员；`DatabaseSync` 与 `StatementSync` 的方法签名与 Node 25 一致。
 */
declare module 'node:sqlite' {
  /** 可绑定到 SQLite 参数的标量。 */
  export type SQLInputValue = null | number | bigint | string | Uint8Array

  export interface StatementResultingChanges {
    readonly changes: number | bigint
    readonly lastInsertRowid: number | bigint
  }

  export class StatementSync {
    run(...params: SQLInputValue[]): StatementResultingChanges
    get(...params: SQLInputValue[]): unknown
    all(...params: SQLInputValue[]): unknown[]
  }

  export interface DatabaseSyncOptions {
    readonly open?: boolean
    readonly readOnly?: boolean
    readonly enableForeignKeyConstraints?: boolean
    readonly enableDoubleQuotedStringLiterals?: boolean
    readonly allowExtension?: boolean
    readonly timeout?: number
  }

  export class DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions)
    open(): void
    close(): void
    exec(sql: string): void
    prepare(sql: string): StatementSync
    location(dbName?: string): string
  }
}

/**
 * `node:test` 的最小声明：纯领域测试（不依赖 Orca）用它，见 §P.6 与 §P.2 的 `stage` /
 * `core-engine` / `memory` 套件。只声明本仓库用到的成员。
 */
declare module 'node:test' {
  export function describe(name: string, fn: () => unknown): void
  export function test(name: string, fn: () => unknown): void
  export function beforeEach(fn: () => unknown): void
  export function afterEach(fn: () => unknown): void
  /**
   * 虚拟时钟：面板测试用它把「2 秒后只重试一次」推进到虚拟时间，绝不真的 sleep
   * （§P.1 第 4 条）。只声明本仓库用到的 `timers`。
   */
  export const mock: {
    timers: {
      enable(options: { apis: readonly ('setTimeout' | 'setInterval' | 'setImmediate' | 'Date')[] }): void
      tick(milliseconds: number): void
      reset(): void
    }
  }
}

/** `node:assert/strict` 的断言子集，与 `orca/testing` 的 `assert` 同一套方法。 */
declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): asserts value
    equal(actual: unknown, expected: unknown, message?: string): void
    notEqual(actual: unknown, expected: unknown, message?: string): void
    deepEqual(actual: unknown, expected: unknown, message?: string): void
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void
    ok(value: unknown, message?: string): asserts value
    strictEqual(actual: unknown, expected: unknown, message?: string): void
    throws(fn: () => unknown, expected?: unknown, message?: string): void
    throws(
      fn: () => unknown,
      validate: (error: unknown) => boolean,
      message?: string
    ): void
    rejects(promise: Promise<unknown>, expected?: unknown, message?: string): Promise<void>
    match(value: string, pattern: RegExp, message?: string): void
  }
  const assert: Assert
  export default assert
}

/** ESM 元信息：`orca plugin test` 以系统 Node 执行，`dirname`/`filename` 可用。 */
interface ImportMeta {
  readonly dirname: string
  readonly filename: string
  readonly url: string
}

/** 进程面：本仓库只读环境变量与 pid（§D.5 的 stateDir 解析、锁文件内容），
 *  `kill(pid, 0)` 做存活探测（§N.1 / S6 的端口文件校验），`hrtime` 量请求耗时。 */
declare const process: {
  readonly env: Record<string, string | undefined>
  readonly pid: number
  readonly platform: string
  kill(pid: number, signal: 0): true
  hrtime: { bigint(): bigint }
}

/** 定时器：心跳（§N.1 每 5 s 触碰锁）与保留策略的节流用。 */
declare function setInterval(handler: () => void, milliseconds: number): TimerHandle
declare function clearInterval(handle: TimerHandle): void
declare function setTimeout(handler: () => void, milliseconds: number): TimerHandle
/** 面板与状态栏用 `Number(handle)` 把句柄收成数字再交回（注入的节流器只认不透明句柄）。 */
declare function clearTimeout(handle: TimerHandle | number): void
declare function setImmediate(handler: (...args: readonly unknown[]) => void): void
/** 微任务：效果队列用它把派发推迟到当前事务提交之后（§J.2 执行行）。 */
declare function queueMicrotask(callback: () => void): void

/** Node 定时器句柄：`unref()` 让它不拖住进程退出。 */
interface TimerHandle {
  unref(): void
}

/** 取消信号：运行缝的接口参数与命令端口用它（§I.4 的「可取消」）。 */
interface AbortSignal {
  readonly aborted: boolean
  /** 监听取消；`{ once: true }` 让监听在触发后自行移除（`mergeSignals` 用）。 */
  addEventListener(type: 'abort', listener: () => void, options?: { readonly once?: boolean }): void
  removeEventListener(type: 'abort', listener: () => void): void
}

/**
 * 取消的发起端：命令端口与评估窗口用它造信号，测试用它模拟「窗口取消」。
 */
declare class AbortController {
  readonly signal: AbortSignal
  abort(): void
}




// `node:*` 的最小声明：只声明本仓库真正用到的成员（§N.3 其二）。
// 理由：装 `@types/node` 会引入整套全局类型并与 `"types": []` 冲突，而插件必须能离线
// `npx tsc -p .`。成员随使用增长时在这里补，不引入 npm 类型包。
//
// 当前用到：`node:fs`（store/lock/migration 与 tests/support/repo.ts）、`node:path`、
// `node:os`（临时状态目录）、`node:sqlite`（§D.2 的唯一真源）、`import.meta.dirname`、
// `process.env|pid` 与 `AbortSignal`（运行缝签名）。

/** `node:path` 的 `join` / `dirname` / `resolve`，只声明本仓库用到的签名。 */
declare module 'node:path' {
  export function join(...parts: string[]): string
  export function dirname(path: string): string
  export function resolve(...parts: string[]): string
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
    isFile(): boolean
    isDirectory(): boolean
  }
  export function readFileSync(path: string, encoding: 'utf8'): string
  export function writeFileSync(path: string, data: string, encoding: 'utf8'): void
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

/** ESM 元信息：`orca plugin test` 以系统 Node 执行，`dirname`/`filename` 可用。 */
interface ImportMeta {
  readonly dirname: string
  readonly filename: string
  readonly url: string
}

/** 进程面：本仓库只读环境变量与 pid（§D.5 的 stateDir 解析、锁文件内容）。 */
declare const process: {
  readonly env: Record<string, string | undefined>
  readonly pid: number
  readonly platform: string
}

/** 定时器：心跳（§N.1 每 5 s 触碰锁）与保留策略的节流用。 */
declare function setInterval(handler: () => void, milliseconds: number): TimerHandle
declare function clearInterval(handle: TimerHandle): void
declare function setTimeout(handler: () => void, milliseconds: number): TimerHandle
declare function clearTimeout(handle: TimerHandle): void
declare function setImmediate(handler: (...args: readonly unknown[]) => void): void

/** Node 定时器句柄：`unref()` 让它不拖住进程退出。 */
interface TimerHandle {
  unref(): void
}

/** 取消信号：运行缝的接口参数用它，具体实现由后续票提供。 */
interface AbortSignal {
  readonly aborted: boolean
  addEventListener(type: 'abort', listener: () => void): void
  removeEventListener(type: 'abort', listener: () => void): void
}

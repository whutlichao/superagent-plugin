// `node:*` 的最小声明：只声明本仓库真正用到的成员（§N.3 其二）。
// 理由：装 `@types/node` 会引入整套全局类型并与 `"types": []` 冲突，而插件必须能离线
// `npx tsc -p .`。成员随使用增长时在这里补，不引入 npm 类型包。
//
// 当前用到：`node:fs` 的 readFileSync / readdirSync（tests/support/repo.ts）、
// `node:path` 的 join（同上）、`import.meta.dirname`（同上）、`AbortSignal`（运行缝签名）、
// `node:crypto` 的 createHash（`core/ids.ts`，§C.2 规则 1 允许的唯一内置模块）、
// `node:test` / `node:assert/strict`（纯领域测试不 import `orca/testing`，§P.6）。

/** `node:path` 的 `join`，只声明本仓库用到的签名。 */
declare module 'node:path' {
  export function join(...parts: string[]): string
}

/** `node:fs` 的读取子集（同步读，避免测试里出现异步竞态）。 */
declare module 'node:fs' {
  export interface Dirent {
    readonly name: string
    isDirectory(): boolean
    isFile(): boolean
  }
  export function readFileSync(path: string, encoding: 'utf8'): string
  export function readdirSync(
    path: string,
    options: { readonly withFileTypes: true }
  ): readonly Dirent[]
}

/** `node:crypto` 的 hash 子集：领域只用它派生稳定 key（§D.1、§C.2 规则 1）。 */
declare module 'node:crypto' {
  export interface Hash {
    update(data: string): Hash
    digest(encoding: 'hex'): string
  }
  export function createHash(algorithm: 'sha256'): Hash
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

/** 取消信号：运行缝的接口参数用它，具体实现由后续票提供。 */
interface AbortSignal {
  readonly aborted: boolean
  addEventListener(type: 'abort', listener: () => void): void
  removeEventListener(type: 'abort', listener: () => void): void
}

// `node:*` 的最小声明：只声明本仓库真正用到的成员（§N.3 其二）。
// 理由：装 `@types/node` 会引入整套全局类型并与 `"types": []` 冲突，而插件必须能离线
// `npx tsc -p .`。成员随使用增长时在这里补，不引入 npm 类型包。
//
// 当前用到：`node:fs` 的 readFileSync / readdirSync（tests/support/repo.ts）、
// `node:path` 的 join（同上）、`import.meta.dirname`（同上）、`AbortSignal`（运行缝签名）。

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

// `eval-read --path` 的唯一读取口（§G.2 的 eval-read 行、§O 的路径行）。
//
// 三条纪律，一处实现：
// - **根**：只允许 base repo 与 Ticket worktree。相对路径按给定的根逐个解析；绝对路径也必须
//   realpath 之后仍落在某个根之内——符号链接逃逸因此同样被拒（`refused`）。
// - **内容**：文件给 UTF-8 文本；目录给排好序的条目名。隐藏段（`.` 开头）与 `node_modules`
//   在解析之前就拒（与上游 `readRepositoryPath` 同规则，`refused`）。
// - **体量**：一次读的信封上限是 §G.1 的 1 MiB；超过就是 `too_large`，绝不静默截断。
//
// 依赖纪律（§C.2）：本文件在 `app/`，只读文件系统（同步 API，与 `app/backup.ts` 同）；
// 不读时钟、不起子进程、不做网络。
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, isAbsolute, relative } from 'node:path'

/** 一次读的信封上限（§G.1：单次 body ≤ 1 MiB；`too_large` 与 §G.3 第 6 条同一个数）。 */
export const REPO_READ_MAX_BYTES = 1024 * 1024

/** `eval-read --path` 的三种固定拒绝（`refused` / `missing` / `too_large`，§G.2）。 */
export type RepoReadCode = 'refused' | 'missing' | 'too_large'

/** 一次被拒的仓库读；`values` 只放填槽值，不放文件内容。 */
export class RepoReadError extends Error {
  readonly code: RepoReadCode
  readonly values?: Readonly<Record<string, string>>

  constructor(code: RepoReadCode, message: string, values?: Readonly<Record<string, string>>) {
    super(message)
    this.name = 'RepoReadError'
    this.code = code
    if (values !== undefined) this.values = values
  }
}

/** 一次成功的仓库读：解析到哪个根、读的是什么、正文与字符数。 */
export interface RepoReadResult {
  /** 命中的根（realpath 之后的绝对路径）。 */
  readonly root: string
  /** 请求里的仓库内路径（原样回显，便于模型引用）。 */
  readonly path: string
  readonly kind: 'file' | 'directory'
  readonly text: string
  readonly chars: number
}

/** 请求里的路径是否带隐藏段或 `node_modules`（上游 `readRepositoryPath` 的同一组规则）。 */
export function hiddenSegment(path: string): string | undefined {
  for (const part of path.split(/[\\/]+/)) {
    if (part === '' || part === '.') continue
    if (part.startsWith('.')) return part
    if (part === 'node_modules') return part
  }
  return undefined
}

/** 一个路径是否在某个根之内（`relative` 空或不是 `..` 开头，且不是绝对路径）。 */
function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * 读一个仓库内路径。相对路径按 `roots` 的顺序逐个解析（base repo 在前，Ticket worktree 在后）；
 * 绝对路径只做包含判定。
 *
 * @throws RepoReadError `refused`（越界、隐藏段、没有根）/ `missing`（不存在）/ `too_large`
 */
export function readRepoPath(input: {
  readonly path: string
  readonly roots: readonly string[]
  readonly limit?: number
}): RepoReadResult {
  const requested = input.path.trim()
  if (requested.length === 0) {
    throw new RepoReadError('refused', 'A repository path is required', { reason: 'empty_path' })
  }
  const limit = input.limit ?? REPO_READ_MAX_BYTES
  const hidden = hiddenSegment(requested)
  if (hidden !== undefined) {
    // 值里只给命中的段名，不给完整路径以外的内容。
    throw new RepoReadError('refused', 'Only non-hidden repository paths are available', {
      reason: 'hidden_path',
      segment: hidden
    })
  }
  // 根的 realpath：路径比较必须在解析符号链接之后做，否则「根里的链接指向外面」会被误判为在内。
  // 不存在/解析不了的根直接跳过（它是配置里写了但还没建出来的目录）。
  const roots: string[] = []
  for (const root of input.roots) {
    try {
      const real = realpathSync(root)
      if (!roots.includes(real)) roots.push(real)
    } catch {
      continue
    }
  }
  if (roots.length === 0) {
    throw new RepoReadError('refused', 'No repository root is configured for reads', {
      reason: 'no_roots'
    })
  }
  let found: { root: string; real: string } | undefined
  let existed = false
  for (const root of roots) {
    const candidate = isAbsolute(requested) ? requested : join(root, requested)
    let real: string
    try {
      real = realpathSync(candidate)
    } catch {
      continue
    }
    existed = true
    if (!inside(root, real)) continue
    found = { root, real }
    break
  }
  if (found === undefined) {
    if (existed) {
      throw new RepoReadError('refused', 'Only paths inside the repository or a ticket worktree are available', {
        reason: 'outside_roots'
      })
    }
    throw new RepoReadError('missing', 'No such path in the repository', { path: requested })
  }
  const stats = statSync(found.real)
  if (stats.isDirectory()) {
    const names = readdirSync(found.real)
      .filter((name) => !name.startsWith('.') && name !== 'node_modules')
      .sort((left, right) => left.localeCompare(right))
    const text = names.join('\n')
    if (text.length > limit) {
      throw new RepoReadError('too_large', `The directory listing is larger than ${limit} bytes`, {
        limit: String(limit)
      })
    }
    return { root: found.root, path: requested, kind: 'directory', text, chars: text.length }
  }
  if (!stats.isFile()) {
    throw new RepoReadError('missing', 'The path is not a regular file or directory', {
      path: requested
    })
  }
  if (stats.size > limit) {
    throw new RepoReadError('too_large', `The file is larger than ${limit} bytes`, {
      limit: String(limit),
      bytes: String(stats.size)
    })
  }
  const text = readFileSync(found.real, 'utf8')
  return { root: found.root, path: requested, kind: 'file', text, chars: text.length }
}

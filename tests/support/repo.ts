// 测试夹具：从磁盘读仓库文件，供各测试共享同一份路径与读取逻辑。
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** 插件根目录（`tests/support/repo.ts` 的上两级）。 */
export const REPO_ROOT = join(import.meta.dirname, '..', '..')

/** 读取仓库内相对路径的 UTF-8 文本。 */
export function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8')
}

/** 读取并解析仓库内的 JSON 文件。 */
export function readRepoJson<T>(relativePath: string): T {
  return JSON.parse(readRepoFile(relativePath)) as T
}

/** 递归列出目录下的文件名（相对给定目录，正斜杠分隔，跳过点目录）。 */
export function listFiles(relativeDir: string, suffix?: string): string[] {
  const found: string[] = []
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(REPO_ROOT, relative), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const child = `${relative}/${entry.name}`
      if (entry.isDirectory()) walk(child)
      else if (suffix === undefined || entry.name.endsWith(suffix)) found.push(child)
    }
  }
  walk(relativeDir)
  return found.sort()
}

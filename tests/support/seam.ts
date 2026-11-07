// 运行缝扫描器的纯函数部分，供 runtime-seam.test.ts 与灵敏度自测共用。
// 扫描目标：插件源码里出现 Orca 类型导入、orca CLI 子进程调用与宿主调用的位置。

/** 裸 `orca` 导入：`from 'orca'` —— 组件面板的 UI 运行面。 */
export const ORCA_BARE_IMPORT_PATTERN = /(?:from\s*|import\s*\(\s*)['"]orca['"]/

/** worker/测试宿主面导入：`from 'orca/worker'` 或 `from 'orca/testing'`。 */
export const ORCA_HOST_IMPORT_PATTERN = /(?:from\s*|import\s*\(\s*)['"]orca\/(?:worker|testing)['"]/

/** 任一 Orca 导入（两条规则的并集，用于灵敏度自测）。 */
export const ORCA_IMPORT_PATTERN =
  /(?:from\s*|import\s*\(\s*)['"]orca(?:\/[a-z-]+)?['"]/

/** Orca CLI 子进程调用：`spawn('orca'` / `execFile('orca'` / `exec('orca `。 */
export const ORCA_CLI_CALL_PATTERN = /\b(?:spawn|spawnSync|exec|execFile|execFileSync)\s*\(\s*['"`]orca['"`]/

/** 宿主调用：`host.call(`。 */
export const HOST_CALL_PATTERN = /\bhost\s*\.\s*call\s*\(/

/** 行是否是注释（行首 `//`、块注释续行 `*` 或 `/*`）；注释里提到这些词不算违规。 */
export function isCommentLine(line: string): boolean {
  return /^\s*(?:\/\/|\*|\/\*)/.test(line)
}

/** 在源码文本里找违规行，返回从 1 开始的行号。 */
export function findViolations(source: string, pattern: RegExp): number[] {
  const lines = source.split('\n')
  const hits: number[] = []
  lines.forEach((line, index) => {
    if (isCommentLine(line)) return
    if (pattern.test(line)) hits.push(index + 1)
  })
  return hits
}

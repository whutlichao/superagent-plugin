// 组装后提示词的文件面（§L.5、§E.2）：写 `<ticketDir>/.superagent/prompt.md`。
//
// 为什么是文件而不是终端：附录 C S1 实测单行 1024 字节起在 canonical PTY 上永不送达，且多行
// 文本会被当成多次提交。组装后的全文有几十 KB，所以它只能落盘；终端里只留一行 ≤400 字符的
// 开播语指向这个文件（`executor/launch.ts` 的 `seedPrompt`）。
//
// 落在 `.superagent/` 里是刻意的：env.sh 已经在那个目录，`ensureExcluded` 加进
// `<common dir>/info/exclude` 的那一行就是这个**目录**（`.superagent/`），所以 prompt.md 不需要
// 第二条排除项，也不会出现在 `git status` 里（`tests/execution-environment.test.ts` 用
// `git check-ignore` 钉住这一点）。
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ENV_FILE_DIRECTORY } from './env-file.ts'

/** 组装后提示词的文件名。 */
export const PROMPT_FILE_NAME = 'prompt.md'

/** `<ticketDir>/.superagent/prompt.md` 的绝对路径。 */
export function promptFilePath(directory: string): string {
  return join(directory, ENV_FILE_DIRECTORY, PROMPT_FILE_NAME)
}

/**
 * 写组装后的全文并返回落点。目录不存在就建；每次 launch 覆盖（内容只由本次组装决定，
 * 所以同一版配置重复写是幂等的）。
 */
export function writePromptFile(options: {
  readonly directory: string
  readonly text: string
}): string {
  const path = promptFilePath(options.directory)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, options.text, 'utf8')
  return path
}

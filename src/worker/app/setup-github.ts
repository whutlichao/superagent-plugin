// GitHub 的**纯配置** setup 结论（§I.2「配置」行、§N.1、§I.4）：只看两项配置本身，不跑任何
// 外部探针。所以它既能在完整 setup 检查里用（缺项时连账号探针都不跑），也能在面板保存之后
// 立刻回答「现在还缺什么」：这两条结论只取决于配置值本身，按**现配置**算一次即可，不必重跑
// 完整检查（§N.2：`source:<id>` 保存即生效）。
//
// 依赖纪律（§C.2）：本文件不跑子进程、不读存储、不认识 HTTP；与 `setup.ts` 共用同一份
// `SetupIssue` 形状（`setup-types.ts`）与同一句修法，绝不另写一套结论文案。
import type { SetupIssue } from './setup-types.ts'
import { SETUP_CHECK_AGAIN } from './setup-types.ts'

/**
 * GitHub 配置的两条结论：`repository` 缺失 → `repository_missing`，`cli` 缺失 → `cli_missing`。
 * 都不缺时是空数组。`fix` 与完整检查逐字相同（面板只显示这一行）。
 */
export function githubConfigIssues(repository: string, cli: string): readonly SetupIssue[] {
  const issues: SetupIssue[] = []
  if (repository.trim() === '') {
    issues.push({
      place: 'github',
      code: 'repository_missing',
      kind: 'missing',
      detail: 'the GitHub Source has no repository',
      fix: 'set the repository (owner/name or its https://github.com/… URL) on the Source page',
      checkAgain: SETUP_CHECK_AGAIN
    })
  }
  if (cli.trim() === '') {
    issues.push({
      place: 'github',
      code: 'cli_missing',
      kind: 'missing',
      detail: 'the GitHub Source has no CLI',
      fix: 'set the GitHub CLI (gh or an agent wrapper script) on the Source page',
      checkAgain: SETUP_CHECK_AGAIN
    })
  }
  return issues
}

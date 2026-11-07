// GitHub Source 的配置（§I.2「配置」行）：
// - `repository`：`owner/name`；缺它时 Source 不启动轮询（setup 态）；
// - `cli`：`gh` 或包装脚本名（绝对路径必须在设置白名单里，§I.4）；
// - `pollSeconds`：默认 60，允许 10–3600（§I.2 通知轮询行）；
// - `observeIssues` / `observePulls` / `observeComments` / `observeCi`：接收没有点名 agent 的
//   仓库级条目（缺省 false）。本票只校验并保存这四个开关；receive-all 本体归 #36。
//
// 依赖纪律（§C.2）：配置只有 schema 与类型，不做 I/O；`gh` 的调用在 `api.ts`/`poll.ts`。
import { object, string, number, boolean } from '../../infra/schema.ts'

/** GitHub Source 的配置形状。 */
export interface GithubConfig {
  readonly repository: string
  readonly cli: string
  readonly pollSeconds: number
  readonly observeIssues: boolean
  readonly observePulls: boolean
  readonly observeComments: boolean
  readonly observeCi: boolean
}

/** 配置的校验与默认值（strict：未知键拒绝）。 */
export const githubConfigSchema = object({
  repository: string().default(''),
  cli: string().default('gh'),
  pollSeconds: number().int().min(10).max(3600).default(60),
  observeIssues: boolean().default(false),
  observePulls: boolean().default(false),
  observeComments: boolean().default(false),
  observeCi: boolean().default(false)
})

/**
 * 挡住轮询的 setup 问题码（§I.2 配置行：`repository` 或 `cli` 缺失 → Source `setup` 态，
 * 轮询不启动）。只判配置本身；账号是否可读由 setup 探针（`gh api user`）另判。
 */
export function githubSetupProblem(config: {
  readonly repository?: string
  readonly cli?: string
}): 'repository_missing' | 'cli_missing' | undefined {
  if ((config.repository ?? '').trim() === '') return 'repository_missing'
  if ((config.cli ?? '').trim() === '') return 'cli_missing'
  return undefined
}

// GitHub Source 的配置（§I.2「配置」行）。本票只落通知轮询需要的四项：
// - `repository`：`owner/name`；缺它时 Source 不启动轮询（setup 态）；
// - `cli`：`gh` 或包装脚本名（绝对路径必须在设置白名单里，§I.4）；
// - `pollSeconds`：默认 60，允许 10–3600（§I.2 通知轮询行）；
// - `observeComments`：接收没有点名 agent 的评论（缺省 false；#17/#18 的 receive-all 会扩展它）。
//
// 依赖纪律（§C.2）：配置只有 schema 与类型，不做 I/O；`gh` 的调用在 `api.ts`/`poll.ts`。
import { object, string, number, boolean } from '../../infra/schema.ts'

/** GitHub Source 的配置形状。 */
export interface GithubConfig {
  readonly repository: string
  readonly cli: string
  readonly pollSeconds: number
  readonly observeComments: boolean
}

/** 配置的校验与默认值（strict：未知键拒绝）。 */
export const githubConfigSchema = object({
  repository: string().default(''),
  cli: string().default('gh'),
  pollSeconds: number().int().min(10).max(3600).default(60),
  observeComments: boolean().default(false)
})

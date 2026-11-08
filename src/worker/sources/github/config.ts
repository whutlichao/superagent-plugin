// GitHub Source 的配置（§I.2「配置」行）：
// - `repository`：`owner/name`；缺它时 Source 不启动轮询（setup 态）；
// - `cli`：`gh` 或包装脚本名（绝对路径必须在设置白名单里，§I.4）；
// - `pollSeconds`：默认 60，允许 10–3600（§I.2 通知轮询行）；
// - `observeIssues` / `observePulls` / `observeComments` / `observeCi`：接收没有点名 agent 的
//   仓库级条目（缺省 false）。本票只校验并保存这四个开关；receive-all 本体归 #36。
//
// 依赖纪律（§C.2）：配置只有 schema 与类型，不做 I/O；`gh` 的调用在 `api.ts`/`poll.ts`。
import { object, string, number, boolean, refine, transform } from '../../infra/schema.ts'

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

/**
 * 一个仓库输入 → GitHub API 要的 `owner/name`；不是 GitHub 仓库就返回 `undefined`。
 *
 * 面板上的「仓库」是一个文本框，人会把仓库地址整段粘进来。两种写法都收：
 * - `owner/name`（本设计一直用的写法，也允许 `owner/name.git`）；
 * - `https://github.com/owner/name`（截图里的写法），可带 `www.`、`scheme`、`.git`、
 *   结尾斜杠与 `#…` / `?…` 片段。
 *
 * 只认仓库本身：多一段路径（`/issues/7`、`/tree/main`）不是仓库名，拒绝而不是猜——人应当
 * 粘仓库地址。也只认 github.com：GitLab / Bitbucket 的地址不是 GitHub 仓库，留着它只会让
 * `gh api` 每次失败，所以由 schema 拒绝（见 `repositoryInput`），不静默换一个。
 */
export function repositorySlug(input: string): string | undefined {
  const text = input.trim()
  if (text === '') return undefined
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i.exec(text)
  const path = url === null ? text : (url[1] as string)
  const cleaned = path.split(/[?#]/, 1)[0]!.replace(/\.git$/i, '').replace(/\/+$/, '')
  const parts = cleaned.split('/')
  // 只接受 `owner/name` 两段：页面地址里的 `/issues`、`/pull/1` 之后的部分不算仓库名。
  if (parts.length !== 2) return undefined
  const [owner, name] = parts as [string, string]
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) return undefined
  return `${owner}/${name}`
}

/**
 * `repository` 的输入校验：空串是「还没配」，原样留下；非空时必须是可用的 GitHub 仓库，
 * 存下来的值一律是规范形态 `owner/name`（运行时、API 与面板因此读同一个值）。
 */
const repositoryInput = transform(
  refine(
    string().trim().max(500),
    (value) => value === '' || repositorySlug(value) !== undefined,
    'expected owner/name or a https://github.com/owner/name URL'
  ),
  (value) => (value === '' ? '' : (repositorySlug(value) as string))
)

/** 配置的校验与默认值（strict：未知键拒绝）。 */
export const githubConfigSchema = object({
  repository: repositoryInput.default(''),
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

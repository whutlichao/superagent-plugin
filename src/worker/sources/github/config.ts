// GitHub Source 的配置（§I.2「配置」行）：
// - `repository`：`owner/name`；缺它时 Source 不启动轮询（setup 态）；
// - `cli`：`gh` 或包装脚本名（绝对路径必须在设置白名单里，§I.4）；
// - `pollSeconds`：默认 60，允许 10–3600（§I.2 通知轮询行）；
// - `observeIssues` / `observePulls` / `observeComments` / `observeCi`：接收没有点名 agent 的
//   仓库级条目（缺省 false）。本票只校验并保存这四个开关；receive-all 本体归 #36。
//
// 依赖纪律（§C.2）：配置只有 schema 与类型，不做 I/O；`gh` 的调用在 `api.ts`/`poll.ts`。
import { object, string, number, boolean, transform } from '../../infra/schema.ts'

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
 * 一个仓库输入 → GitHub API 要的 `owner/name`；不是一个能认出来的 GitHub 仓库就返回 `undefined`。
 *
 * 面板上的「仓库」是一个文本框，人会把仓库地址整段粘进来。两种写法都收：
 * - `owner/name`（本设计一直用的写法，也允许 `owner/name.git`）；
 * - `https://github.com/owner/name`（截图里的写法），可带 `www.`、`scheme`、`.git`、
 *   结尾斜杠、`#…` / `?…` 片段，以及 `/issues/7`、`/tree/main` 这类页面后缀——仓库永远是
 *   路径的前两段，所以取前两段不是猜。
 *
 * 只认 github.com。认不出来的值（别的 host、只有一段路径……）由 `repositoryInput` **原样
 * 保留**：这是本字段一直以来的行为，本票只加归一，不新增拒绝面。
 */
export function repositorySlug(input: string): string | undefined {
  const text = input.trim()
  if (text === '') return undefined
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i.exec(text)
  if (url === null) {
    // 裸写法：必须恰好是 `owner/name`（两段），多一段就不是仓库名；`.git` 后缀去掉。
    const bare = text.split(/[?#]/, 1)[0]!.replace(/\.git$/i, '').replace(/\/+$/, '')
    const parts = bare.split('/')
    return parts.length === 2 ? slugOf(parts[0], parts[1]) : undefined
  }
  const cleaned = (url[1] as string).split(/[?#]/, 1)[0]!.replace(/\.git$/i, '').replace(/\/+$/, '')
  const parts = cleaned.split('/')
  return parts.length >= 2 ? slugOf(parts[0], parts[1]) : undefined
}

/** 两段路径 → `owner/name`；字符集不像 GitHub 名字时 `undefined`。 */
function slugOf(owner: string | undefined, name: string | undefined): string | undefined {
  if (owner === undefined || name === undefined) return undefined
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) return undefined
  return `${owner}/${name}`
}

/**
 * `repository` 的输入：空串是「还没配」，原样留下；能认出来的 GitHub 仓库（`owner/name` 或
 * github.com 地址）存成规范形态 `owner/name`——运行时、API 与面板因此读同一个值；其余值
 * 原样保留（与这个字段一直以来的行为一致）。
 */
const repositoryInput = transform(string().trim(), (value) =>
  value === '' ? '' : (repositorySlug(value) ?? value)
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

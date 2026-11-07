// 执行环境变量（§E.11）：变量名保留上游写法（skills 与 prompts 里直接引用，改名会破坏等价性），
// 值由插件算出——来自 Ticket、部署与 Source 配置，不由 agent 自己「发现」。
//
// 三组变量的分工与上游 `src/app/execution-environment.ts` + `src/sources/*.ts` 的
// `environment.values` 同形，只是集中在一处（本插件的 Source kind 还没有实现票，#17/#21 之后
// 若自己声明 `environment`，它的贡献按「后写覆盖同名键」并入；见 `sources` 输入）。
//
// 依赖纪律（§C.2）：本文件只依赖领域类型（`core/model.ts`）与 Node 内建，不 import
// `sources/`、`runtime/` 或 `orca`；输入形状按结构化类型声明，`sources/kind.ts` 的
// `Deployment` / `SourceEnvironment` 结构上满足它们，组合根直接传即可。
import type { Trigger } from '../core/model.ts'

/** executor 自己声明的四个变量（§E.11 前四行）。 */
export const EXECUTOR_VARIABLES = [
  'DSH_SUPERAGENT_DIR',
  'DSH_SUPERAGENT_NAME',
  'DSH_SUPERAGENT_TICKET',
  'DSH_SUPERAGENT_BLOCKED_COMMANDS'
] as const

/** GitHub Source 的变量（§E.11；上游 `sources/github.ts` 的同名项）。 */
export const GITHUB_VARIABLES = [
  'DSH_SUPERAGENT_GITHUB_REPOSITORY',
  'DSH_SUPERAGENT_GITHUB_ACCOUNT',
  'DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL',
  'DSH_SUPERAGENT_GITHUB_NUMBER',
  'DSH_SUPERAGENT_GITHUB_PR_HEAD'
] as const

/** Feishu Source 的变量（§E.11；上游 `sources/feishu.ts` 的同名项）。 */
export const FEISHU_VARIABLES = ['DSH_SUPERAGENT_FEISHU_BOT', 'DSH_SUPERAGENT_FEISHU_CHAT'] as const

/** 本插件新增的三项（§E.11 末行、§G.5）。 */
export const PLUGIN_VARIABLES = [
  'SUPERAGENT_CLI',
  'SUPERAGENT_TOKEN_FILE',
  'SUPERAGENT_API'
] as const

/** 变量表的规范顺序：env.sh 的行序、面板「插入变量」菜单与断言都按它。 */
export const ENVIRONMENT_VARIABLES = [
  ...EXECUTOR_VARIABLES,
  ...GITHUB_VARIABLES,
  ...FEISHU_VARIABLES,
  ...PLUGIN_VARIABLES
] as const

/** 一个变量名（`ENVIRONMENT_VARIABLES` 的成员）。 */
export type EnvironmentVariable = (typeof ENVIRONMENT_VARIABLES)[number]

/** 一张变量表：每个变量都在，缺的值为空串（面板与 env.sh 都按「有没有这个变量」看）。 */
export type EnvironmentTable = Readonly<Record<EnvironmentVariable, string>>

/**
 * 部署派生的事实（§I.1 `Deployment` 的只读子集，§E.11 的变量源）。`sources/kind.ts` 的
 * `Deployment` 多出 CLI 路径等字段，结构上满足本类型；值缺了就写空串，不猜测。
 */
export interface EnvironmentDeployment {
  readonly repository: string
  readonly githubLogin: string
  readonly githubCommitEmail: string
  readonly feishuBotId: string
}

/** 什么都没配的部署（启动早期与测试用）：所有部署派生的变量都是空串。 */
export const EMPTY_DEPLOYMENT: EnvironmentDeployment = {
  repository: '',
  githubLogin: '',
  githubCommitEmail: '',
  feishuBotId: ''
}

/** Ticket 的执行事实（§E.1：短名、worktree 路径、ticket id）。 */
export interface EnvironmentTicket {
  readonly id: string
  readonly name: string
  readonly directory: string
}

/** 本插件的三项（§G.5）：CLI 的绝对路径、本次 Assignment 的 token 文件、loopback API 基址。 */
export interface EnvironmentPlugin {
  readonly cliPath: string
  readonly tokenFile: string
  readonly apiBase?: string
}

/**
 * 一个 Source kind 对执行环境的贡献（§I.1 `SourceEnvironment` 的结构化子集）。
 * `sources/registry.ts` 的 `environments()` 返回的元素结构上满足它。
 */
export interface SourceEnvironmentContribution {
  readonly kind: string
  readonly environment: {
    readonly variables: readonly { readonly key: string }[]
    values(input: {
      readonly deployment: EnvironmentDeployment
      readonly config: Record<string, unknown>
      readonly trigger?: Trigger
    }): Readonly<Record<string, string>>
  }
  readonly config: Record<string, unknown>
}

/** `environmentOf` 的输入。 */
export interface EnvironmentInput {
  /** 部署派生的事实（仓库、agent 账号与提交邮箱、Feishu bot）。 */
  readonly deployment: EnvironmentDeployment
  /** Ticket 的执行事实。 */
  readonly ticket: EnvironmentTicket
  /** 本插件的三项。 */
  readonly plugin: EnvironmentPlugin
  /** `executor.blockedCommands`：不可运行的个人 CLI 名单（值里逗号分隔）。 */
  readonly blockedCommands: readonly string[]
  /** 起始 Trigger；没有它时来源相关的变量为空串。 */
  readonly trigger?: Trigger
  /** 启用中的 Source kind 的额外贡献（同键覆盖前面的值；§I.1、#50 的扩展点）。 */
  readonly sources?: readonly SourceEnvironmentContribution[]
}

/** GitHub Source 的 kind id（`Trigger.source` 与 Thread 的 `source` 都用它）。 */
export const GITHUB_KIND = 'github'
/** Feishu Source 的 kind id。 */
export const FEISHU_KIND = 'feishu'

/** 起始 Trigger 是否从某个 Source kind 来（看它的 primary Thread，上游同口径）。 */
function fromKind(trigger: Trigger | undefined, kind: string): trigger is Trigger {
  return trigger !== undefined && trigger.threads[0]?.source === kind
}

/** 起始 Issue/PR 的编号（上游同：读 `meta.number`，读不出就是 0 → 空串）。 */
function githubNumber(trigger: Trigger | undefined): number {
  if (!fromKind(trigger, GITHUB_KIND)) return 0
  const number = Number(trigger.meta['number'])
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0
}

/** GitHub 相关的值：仓库、账号与提交邮箱来自部署；编号与 head 引用来自起始 Trigger。 */
function githubValues(
  deployment: EnvironmentDeployment,
  trigger: Trigger | undefined
): Record<(typeof GITHUB_VARIABLES)[number], string> {
  const number = githubNumber(trigger)
  return {
    DSH_SUPERAGENT_GITHUB_REPOSITORY: deployment.repository,
    DSH_SUPERAGENT_GITHUB_ACCOUNT: deployment.githubLogin,
    DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL: deployment.githubCommitEmail,
    DSH_SUPERAGENT_GITHUB_NUMBER: number === 0 ? '' : String(number),
    // 上游的写法：PR 的 head 引用是 `refs/pull/<编号>/head`，不是 PR 时为空。
    DSH_SUPERAGENT_GITHUB_PR_HEAD:
      number > 0 && trigger !== undefined && trigger.meta['isPr'] === true
        ? `refs/pull/${String(number)}/head`
        : ''
  }
}

/** Feishu 相关的值：bot 来自部署，起始 chat 来自从 Feishu 来的 Trigger。 */
function feishuValues(
  deployment: EnvironmentDeployment,
  trigger: Trigger | undefined
): Record<(typeof FEISHU_VARIABLES)[number], string> {
  return {
    DSH_SUPERAGENT_FEISHU_BOT: deployment.feishuBotId,
    DSH_SUPERAGENT_FEISHU_CHAT: fromKind(trigger, FEISHU_KIND)
      ? String(trigger.meta['chatId'] ?? '')
      : ''
  }
}

/** 把一个值写进 shell 的安全形态：单引号包裹，值里的 `'` 用 `'\''` 收尾再开。 */
export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** 变量替换的形态：`${名字}`；只有白名单里的名字会被替换（§O 的命令注入面）。 */
const VARIABLE_PATTERN = /\$\{([A-Za-z0-9_]+)\}/g

/**
 * 把命令文本里的 `${DSH_SUPERAGENT_*}` 换成单引号转义后的值（§E.3）。
 * 白名单是 `ENVIRONMENT_VARIABLES`：其余 `${…}`（例如 `$HOME`）原样留下，绝不猜测；
 * 替换后的文本因此永远不可能把消息正文里的字符变成 shell 语法。
 */
export function substituteVariables(
  command: string,
  environment: Readonly<Record<string, string>>
): string {
  const allowed = new Set<string>(ENVIRONMENT_VARIABLES)
  return command.replace(VARIABLE_PATTERN, (match, name: string) => {
    if (!allowed.has(name)) return match
    return shellSingleQuote(environment[name] ?? '')
  })
}

/**
 * 算出这个 Ticket 的执行环境（§E.11）。顺序固定、缺项为空串；Source kind 的额外贡献最后
 * 并入（同键覆盖，便于以后新增 Source 时不改本文件）。
 */
export function environmentOf(input: EnvironmentInput): EnvironmentTable {
  const table: Record<string, string> = {
    DSH_SUPERAGENT_DIR: input.ticket.directory,
    DSH_SUPERAGENT_NAME: input.ticket.name,
    DSH_SUPERAGENT_TICKET: input.ticket.id,
    // §E.11 写「逗号分隔」：名单里是命令名，不含逗号，拼接不产生歧义。
    DSH_SUPERAGENT_BLOCKED_COMMANDS: input.blockedCommands.join(','),
    ...githubValues(input.deployment, input.trigger),
    ...feishuValues(input.deployment, input.trigger),
    SUPERAGENT_CLI: input.plugin.cliPath,
    SUPERAGENT_TOKEN_FILE: input.plugin.tokenFile,
    SUPERAGENT_API: input.plugin.apiBase ?? ''
  }
  for (const contribution of input.sources ?? []) {
    const values = contribution.environment.values({
      deployment: input.deployment,
      config: contribution.config,
      ...(input.trigger === undefined ? {} : { trigger: input.trigger })
    })
    for (const key of Object.keys(values)) table[key] = values[key] ?? ''
  }
  return table as EnvironmentTable
}

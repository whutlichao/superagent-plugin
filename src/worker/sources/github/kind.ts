// GitHub Source kind（§I.1 的协议、§I.2 的最小面）：本票只声明通知轮询与 Issue 评论需要的
// 那部分协议——配置、字段、facts、health、scope、Channel 与 Policy。
//
// 这里**不做**通知轮询本身（`poll.ts` 由组合根按 `pollSeconds` 驱动）；kind 只回答
// 「这条 Trigger 我要不要听」（scope）与「回复怎么发出去」（channel）。
//
// Channel 的幂等（§I.2 Channel 行）：正文尾部带隐藏标记 `<!-- superagent:<messageId> -->`；
// 发送前先读已有评论（`?per_page=100`）查重，命中即 `sent`，不重复写。
import type {
  ChannelRef,
  HealthEntry,
  OutboundMessage,
  ReceiveResult,
  ScopeResult,
  Trigger
} from '../../core/index.ts'
import type { Localized, SourceContext, SourceKind } from '../kind.ts'
import type { CommandsHost } from '../commands.ts'
import { CliError, isGone, type GoneRule } from '../commands.ts'
import { array, object, string } from '../../infra/schema.ts'
import type { GithubConfig } from './config.ts'
import { githubConfigSchema } from './config.ts'
import { rateLimited } from './api.ts'
import { githubFind, githubThreadContext } from './read.ts'
import { mentionsAgent } from './translate.ts'

/** 这个 kind 的稳定 id。 */
export const GITHUB_KIND = 'github'

/** 隐藏幂等标记：面板与 GitHub 都不显示它，但发送前的查重读得到它。 */
export const idMarker = (messageId: string): string => `<!-- superagent:${messageId} -->`

/** 判定「这个地址永远收不到」的 GitHub 错误码（§I.2 Channel 失败处理行）。 */
export const GONE_RULES: readonly GoneRule[] = [{ code: 404 }, { code: 410 }, { code: 403 }]

/**
 * 403 也可以是限流（它会自己恢复），所以不能一律当 `gone`：只有非限流的 403
 * （锁定、无权限）才是永久失败，其余一律抛错重试（§I.2）。限流的判定与 CI 读同一处。
 */
export function githubGone(error: unknown): boolean {
  if (rateLimited(error)) return false
  return isGone(error, GONE_RULES)
}

/** 根评论不存在（已删/找不到）：评审线程的回复退到 PR 会话，而不是 `gone`。 */
function missingTarget(error: unknown): boolean {
  return error instanceof CliError && (error.code === 404 || error.code === 410)
}

/** 中英双语短句的简写（`Localized` 两种语言都要有值，与 `locales.test` 同一纪律）。 */
const both = (zh: string, en: string): Localized => ({ zh, en })

/** GitHub 的 Channel 地址字段（`ChannelRef.address`）。`root` 只在评审线程的地址上出现。 */
export type GithubAddress = Record<string, string> & {
  readonly repo: string
  readonly issue: string
  readonly root?: string
}

/** 解析后的地址：`root` 给出时回复走评审线程的 replies 端点。 */
interface GithubTarget {
  readonly repo: string
  readonly issue: string
  readonly root?: number
}

/** 一个地址是否够发一条评论（`root` 给出时必须是数字）。 */
function addressOf(address: Record<string, string>): GithubTarget | undefined {
  const repo = address['repo'] ?? ''
  const issue = address['issue'] ?? ''
  if (repo.length === 0 || !/^\d+$/.test(issue)) return undefined
  const root = address['root']
  if (root === undefined) return { repo, issue }
  return /^\d+$/.test(root) ? { repo, issue, root: Number(root) } : undefined
}

/** 发之前先按隐藏标记查重（最多一页，§I.2 Channel 行）。 */
async function hasMarker(
  host: CommandsHost,
  cli: string,
  path: string,
  marker: string
): Promise<boolean> {
  const output = await host.run(cli, ['api', `${path}?per_page=100`, '-q', '.[].body'])
  return output.includes(marker)
}

/** 评审线程的根评论还在不在（404/410 算不在；其余失败原样抛，让外层分别判 gone/重试）。 */
async function rootExists(
  host: CommandsHost,
  cli: string,
  repo: string,
  root: number
): Promise<boolean> {
  try {
    await host.run(cli, ['api', `repos/${repo}/pulls/comments/${root}`])
    return true
  } catch (error) {
    if (missingTarget(error)) return false
    throw error
  }
}

/**
 * 名单上的一行：Source 自己的身份（GitHub login）+ 可选显示名（§K.1 的 `allowed`）。
 * 大小写不敏感的重复检查在 `policy/schema.ts`（§K.8）。
 */
const allowedIdentitySchema = object({
  id: string().trim().min(1).max(200),
  name: string().trim().min(1).max(100).optional()
}).strict()

/** `bots` 名单的一行（§K.2 第 5 条）：可以提出推断候选，永远不能授权。 */
const botIdentitySchema = object({ id: string().trim().min(1).max(200) }).strict()

/** Policy 部分：允许名单 + bots 名单（准入表由 `rows()` 声明，配置由 Policy 块校验）。 */
const policySchema = object({
  allowed: array(allowedIdentitySchema).default([]),
  bots: array(botIdentitySchema).default([])
}).strict()

/**
 * 造一个 GitHub kind。`cli` 是当前配置的 `gh`（或包装脚本）：Channel 发送需要它，而
 * `SourceChannel.send` 的签名里没有配置（§I.1），所以由组合根在注册时闭包进来。给一个
 * **取值函数**时，每次发送/语境读取都读当时的 `cli`——设置保存后不必重新注册 kind
 * （`source:<id>` 的 `cli` 保存即生效，§N.2）。
 */
export function createGithubKind(cli: string | (() => string)): SourceKind<GithubConfig> {
  const cliNow = (): string => (typeof cli === 'function' ? cli() : cli)
  return {
    kind: GITHUB_KIND,
    title: both('GitHub', 'GitHub'),
    description: both(
      '轮询 GitHub 通知，读取 Issue 与 PR 的会话、评论和评审，并在原会话里回复。',
      'Polls GitHub notifications, reads Issues and pull requests with their comments and reviews, and replies in the same conversation.'
    ),
    schema: githubConfigSchema,
    /**
     * 评估窗口的语境（§I.2「线程上下文」行）：Issue/PR 描述 + 评论页、评审页、评审线程页，
     * 每页 20 条、带下一页游标；默认分支的 CI 以它自己的 Trigger 作语境。
     */
    threadContext: githubThreadContext(cliNow),
    fields: [
      {
        key: 'repository',
        type: 'text',
        label: both('仓库', 'Repository'),
        // 与 kind schema 同一个输入面：`owner/name` 或 github.com 的仓库地址（保存时归一）。
        pattern: '^(?:[^/\\s]+/[^/\\s]+|(?:https?://)?(?:www\\.)?github\\.com/[^/\\s?#]+/[^/\\s?#]+/?)$'
      },
      { key: 'cli', type: 'text', label: both('GitHub CLI', 'GitHub CLI') },
      {
        key: 'pollSeconds',
        type: 'number',
        min: 10,
        max: 3600,
        label: both('轮询间隔（秒）', 'Poll seconds'),
        advanced: true
      },
      {
        key: 'observeIssues',
        type: 'switch',
        label: both('接收仓库里的新 Issue', 'Observe new Issues'),
        hint: both(
          '打开后，没点名 agent 的新 Issue 也接收；从打开的那一刻开始，不读以前的。',
          'New Issues that do not mention the agent are received too, from the moment this is switched on; earlier ones are not read.'
        ),
        advanced: true
      },
      {
        key: 'observePulls',
        type: 'switch',
        label: both('接收仓库里的新 PR', 'Observe new pull requests'),
        hint: both(
          '打开后，没点名 agent 的新 PR 也接收；从打开的那一刻开始，不读以前的。',
          'New pull requests that do not mention the agent are received too, from the moment this is switched on; earlier ones are not read.'
        ),
        advanced: true
      },
      {
        key: 'observeComments',
        type: 'switch',
        label: both('接收未点名的评论', 'Observe unaddressed comments'),
        hint: both(
          '打开后，Issue 与 PR 上没点名 agent 的评论（含行内评审评论）也接收；从打开的那一刻开始。',
          'Comments on any Issue or pull request, review comments included, are received without a mention, from the moment this is switched on.'
        ),
        advanced: true
      },
      {
        key: 'observeCi',
        type: 'switch',
        label: both('接收 CI 变化', 'Observe CI changes'),
        hint: both(
          'PR 的 CI 变化与默认分支的 CI 失败/恢复都接收；默认分支只在失败集合变化时出事件，且从打开的那一刻建基线。',
          "A pull request's CI changes and the default branch's failures and recovery are received; the default branch reports only a change in its failing checks, baselined when this is switched on."
        ),
        advanced: true
      }
    ],
    facts: (deployment) => [
      {
        key: 'repository',
        value: deployment.repository === '' ? both('未配置', 'Not configured') : deployment.repository
      },
      {
        key: 'account',
        value: deployment.githubLogin === '' ? both('未检查', 'Not checked') : deployment.githubLogin
      }
    ],
    health: ['github'],
    /**
     * 监听范围（Gate 之前的第一层，§K.2 的输入）：准入行按事件类型分（§I.2）——`issues` /
     * `pulls` / `comments` / `ci`。点名的消息总是被接收（但不算「观察」）；未点名的只有开了
     * 对应 observe 开关才接收，并标 `observed`（准入表只对 receive-all 的行可用）。
     * CI 没有发送者，只有 receive-all 的 `ci` 行会收它。
     */
    scope(trigger: Pick<Trigger, 'source' | 'meta'> | Trigger, config: GithubConfig): ScopeResult {
      const addressed = (trigger as Trigger).addressed
      const kind = String(trigger.meta['kind'] ?? 'comment')
      if (kind === 'ci') {
        return config.observeCi
          ? { listened: true, observed: true, row: 'ci' }
          : { listened: false, reason: 'ci_not_observed' }
      }
      const row = kind === 'issue' ? 'issues' : kind === 'pull' ? 'pulls' : 'comments'
      const observe =
        kind === 'issue'
          ? config.observeIssues
          : kind === 'pull'
            ? config.observePulls
            : config.observeComments
      if (addressed !== undefined) return { listened: true, observed: false, row }
      if (observe) return { listened: true, observed: true, row }
      return { listened: false, reason: 'not_addressed' }
    },
    channel: {
      allowed(address) {
        return addressOf(address) !== undefined
      },
      async send(host: CommandsHost, message: OutboundMessage): Promise<'sent' | 'gone'> {
        const target = addressOf(message.channel.address)
        if (target === undefined) return 'gone'
        const cli = cliNow()
        const marker = idMarker(message.id)
        const body = `${message.text}\n\n${marker}`
        try {
          // 评审线程：先确认根评论还在；不在就退到 PR 会话（§I.2 Channel 行）。
          if (target.root !== undefined && (await rootExists(host, cli, target.repo, target.root))) {
            const path = `repos/${target.repo}/pulls/${target.issue}/comments`
            if (await hasMarker(host, cli, path, marker)) return 'sent'
            await host.run(cli, ['api', `${path}/${target.root}/replies`, '-f', `body=${body}`])
            return 'sent'
          }
          const path = `repos/${target.repo}/issues/${target.issue}/comments`
          // 先查重：读已有评论（最多一页）里有没有同一个标记（§I.2 Channel 幂等）。
          if (await hasMarker(host, cli, path, marker)) return 'sent'
          await host.run(cli, ['api', path, '-f', `body=${body}`])
        } catch (error) {
          if (githubGone(error)) return 'gone'
          throw error
        }
        return 'sent'
      },
      link(address) {
        const target = addressOf(address)
        if (target === undefined) {
          return { url: '', label: both('Issue', 'Issue') }
        }
        if (target.root !== undefined) {
          return {
            url: `https://github.com/${target.repo}/pull/${target.issue}#discussion_r${target.root}`,
            label: both(`#${target.issue} 的 review 讨论`, `Review discussion on #${target.issue}`)
          }
        }
        return {
          url: `https://github.com/${target.repo}/issues/${target.issue}`,
          label: both(`#${target.issue}`, `#${target.issue}`)
        }
      }
    },
    find(query: string) {
      // `#12`、Issue/PR 链接、评论链接 → Thread key + 搜索词（§I.2「find」行、读面的纯函数）。
      return githubFind(query)
    },
    policy: {
      schema: policySchema,
      fields: [
        {
          key: 'allowed',
          type: 'rows',
          label: both('允许名单', 'Allowed list'),
          columns: [
            {
              key: 'id',
              type: 'text',
              label: both('GitHub 账号', 'GitHub login'),
              pattern: '^[\\w.-]+(\\[bot\\])?$'
            },
            { key: 'name', type: 'text', label: both('显示名', 'Display name'), optional: true }
          ]
        }
      ],
      explicit: both('点名 agent 的评论', 'A comment that mentions the agent'),
      bots: [
        {
          key: 'bots',
          type: 'rows',
          label: both('机器人名单', 'Bots'),
          hint: both(
            '名单上的机器人只能提出推断候选，永远不能授权。',
            'A listed bot may only propose an inferred candidate; it never authorizes.'
          ),
          columns: [
            {
              key: 'id',
              type: 'text',
              label: both('GitHub 账号', 'GitHub login'),
              pattern: '^[\\w.-]+(\\[bot\\])?$'
            }
          ]
        }
      ],
      rows: (config) => {
        // 行的可用性即「该 scope 是否 receive-all」（§K.2、§I.2）：只有开了对应开关才有
        // 未点名的格子；点名的格子总是可用。CI 没有发送者，只有最后一格。
        const issue = config['observeIssues'] === true
        const pull = config['observePulls'] === true
        const comment = config['observeComments'] === true
        const ci = config['observeCi'] === true
        return [
          {
            id: 'issues',
            label: both('新 Issue', 'New Issues'),
            note: both(
              '仓库里新开的 Issue（未点名的也算观察，前提是开了观察开关）。',
              'A new Issue in the repository (unaddressed ones only while observing).'
            ),
            cells: {
              listedUnaddressed: issue,
              unlistedAddressed: true,
              unlistedUnaddressed: issue
            }
          },
          {
            id: 'pulls',
            label: both('新 PR', 'New pull requests'),
            note: both(
              '仓库里新开的 PR（未点名的也算观察，前提是开了观察开关）。',
              'A new pull request (unaddressed ones only while observing).'
            ),
            cells: {
              listedUnaddressed: pull,
              unlistedAddressed: true,
              unlistedUnaddressed: pull
            }
          },
          {
            id: 'comments',
            label: both('评论与评审', 'Comments and reviews'),
            note: both(
              'Issue / PR 下说出来的话；点名 agent 的评论总是被接收。',
              'A remark under an Issue or pull request; one that mentions the agent is always received.'
            ),
            cells: {
              listedUnaddressed: comment,
              unlistedAddressed: true,
              unlistedUnaddressed: comment
            }
          },
          {
            id: 'ci',
            label: both('CI 检查', 'CI checks'),
            note: both(
              'CI 变化没有发送者，只用最后一格判定。',
              'A CI change has no sender, so only the last cell speaks.'
            ),
            cells: {
              listedUnaddressed: false,
              unlistedAddressed: false,
              unlistedUnaddressed: ci
            }
          }
        ]
      }
    },
  }
}

/** 缺省实例（`cli = 'gh'`）：注册表、测试与面板的只读查询用。 */
export const githubKind: SourceKind<GithubConfig> = createGithubKind('gh')

/** 一条正文是否提到了 agent（导出给组合根与测试复用同一条判定）。 */
export const mentions = mentionsAgent

/** 一个 Channel 地址是否够发评论（面板与测试的只读判定）。 */
export function isGithubAddress(channel: ChannelRef): boolean {
  return addressOf(channel.address) !== undefined
}

/** health 条目的初始读数（注册表 claim 时用它；组合根不需要再写一份）。 */
export const GITHUB_HEALTH_STARTING: HealthEntry = { state: 'starting', detail: 'Waiting for github' }

/** `SourceContext` 在轮询器眼里的形状（组合根与测试共用）。 */
export type GithubHost = Pick<SourceContext, 'receive' | 'state' | 'report'>

/** `receive` 的读数（导出一份，避免调用方 import core）。 */
export type GithubReceiveResult = ReceiveResult

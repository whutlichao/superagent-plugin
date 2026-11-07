// GitHub Source kind（§I.1 的协议、§I.2 的最小面）：本票只声明通知轮询与 Issue 评论需要的
// 那部分协议——配置、字段、facts、health、scope、Channel、Policy 与执行环境。
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
import { isGone, type GoneRule } from '../commands.ts'
import { array, object, string } from '../../infra/schema.ts'
import type { GithubConfig } from './config.ts'
import { githubConfigSchema } from './config.ts'
import { mentionsAgent } from './translate.ts'

/** 这个 kind 的稳定 id。 */
export const GITHUB_KIND = 'github'

/** 隐藏幂等标记：面板与 GitHub 都不显示它，但发送前的查重读得到它。 */
export const idMarker = (messageId: string): string => `<!-- superagent:${messageId} -->`

/** 判定「这个地址永远收不到」的 GitHub 错误码（§I.2 Channel 失败处理行）。 */
export const GONE_RULES: readonly GoneRule[] = [
  { code: 404 },
  { code: 410 },
  { code: 403, message: /locked/i }
]

/** 中英双语短句的简写（`Localized` 两种语言都要有值，与 `locales.test` 同一纪律）。 */
const both = (zh: string, en: string): Localized => ({ zh, en })

/** GitHub 的 Channel 地址字段（`ChannelRef.address`）。 */
export interface GithubAddress extends Record<string, string> {
  readonly repo: string
  readonly issue: string
}

/** 一个地址是否够发一条 Issue 评论。 */
function addressOf(address: Record<string, string>): { repo: string; issue: string } | undefined {
  const repo = address['repo'] ?? ''
  const issue = address['issue'] ?? ''
  return repo.length > 0 && /^\d+$/.test(issue) ? { repo, issue } : undefined
}

/** Policy 部分里本票会读的字段：允许名单（§K.1）。 */
const policySchema = object({ allowed: array(string()).default([]) })

/**
 * 造一个 GitHub kind。`cli` 是当前配置的 `gh`（或包装脚本）：Channel 发送需要它，而
 * `SourceChannel.send` 的签名里没有配置（§I.1），所以由组合根在注册时闭包进来
 * （设置变了就重新注册，与设计 §N.2 的「重启后生效」一致）。
 */
export function createGithubKind(cli: string): SourceKind<GithubConfig> {
  return {
    kind: GITHUB_KIND,
    title: both('GitHub', 'GitHub'),
    description: both(
      '轮询 GitHub 通知，读取 Issue 评论，并在原会话里回复。',
      'Polls GitHub notifications, reads Issue comments and replies in the same conversation.'
    ),
    schema: githubConfigSchema,
    fields: [
      {
        key: 'repository',
        type: 'text',
        label: both('仓库', 'Repository'),
        pattern: '^[^/\\s]+/[^/\\s]+$'
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
        key: 'observeComments',
        type: 'switch',
        label: both('接收未点名的评论', 'Observe unaddressed comments'),
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
     * 监听范围（Gate 之前的第一层）：默认只听点名 agent 的消息；`observeComments` 打开时
     * 一切评论都进（作为「观察」scope，准入仍由 Gate 决定是否给强度）。
     */
    scope(trigger: Pick<Trigger, 'source' | 'meta'> | Trigger, config: GithubConfig): ScopeResult {
      const addressed = (trigger as Trigger).addressed
      if (addressed !== undefined) return { listened: true, observed: false, row: 'comments' }
      if (config.observeComments) return { listened: true, observed: true, row: 'comments' }
      return { listened: false, reason: 'not_addressed' }
    },
    channel: {
      allowed(address) {
        return addressOf(address) !== undefined
      },
      async send(host: CommandsHost, message: OutboundMessage): Promise<'sent' | 'gone'> {
        const target = addressOf(message.channel.address)
        if (target === undefined) return 'gone'
        const marker = idMarker(message.id)
        const body = `${message.text}\n\n${marker}`
        // 先查重：读已有评论（最多一页）里有没有同一个标记（§I.2 Channel 幂等）。
        const existing = await host.run(cli, [
          'api',
          `repos/${target.repo}/issues/${target.issue}/comments?per_page=100`,
          '-q',
          '.[].body'
        ])
        if (existing.includes(marker)) return 'sent'
        try {
          await host.run(cli, [
            'api',
            `repos/${target.repo}/issues/${target.issue}/comments`,
            '-f',
            `body=${body}`
          ])
        } catch (error) {
          if (isGone(error, GONE_RULES)) return 'gone'
          throw error
        }
        return 'sent'
      },
      link(address) {
        const target = addressOf(address)
        return {
          url: target === undefined ? '' : `https://github.com/${target.repo}/issues/${target.issue}`,
          label:
            target === undefined ? both('Issue', 'Issue') : both(`#${target.issue}`, `#${target.issue}`)
        }
      }
    },
    find(query: string) {
      // 最小切片只认评论/Issue 的 URL 与 `#12` 形式的短引用（完整搜索归 #36）。
      const url = /github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)/.exec(query)
      const short = /^#(\d+)$/.exec(query.trim())
      if (url !== null) return { threads: [`github:${url[2]}`], terms: [url[0]] }
      if (short !== null) return { threads: [`github:${short[1]}`], terms: [query.trim()] }
      return { threads: [], terms: [query.trim()] }
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
              key: 'login',
              type: 'text',
              label: both('GitHub 账号', 'GitHub login'),
              pattern: '^[\\w.-]+(\\[bot\\])?$'
            }
          ]
        }
      ],
      explicit: both('点名 agent 的评论', 'A comment that mentions the agent'),
      rows: () => [
        {
          id: 'comments',
          label: both('Issue 评论', 'Issue comments'),
          note: both(
            '评论的发送者按允许名单判定。',
            'A comment sender is judged by the allowed list.'
          ),
          cells: {
            listedUnaddressed: false,
            unlistedAddressed: false,
            unlistedUnaddressed: false
          }
        }
      ]
    },
    environment: {
      variables: [
        {
          key: 'DSH_SUPERAGENT_GITHUB_REPOSITORY',
          description: both('GitHub 仓库 owner/name', 'The GitHub repository owner/name')
        },
        {
          key: 'DSH_SUPERAGENT_GITHUB_ACCOUNT',
          description: both('agent 的 GitHub 账号', 'The agent GitHub login')
        },
        {
          key: 'DSH_SUPERAGENT_GITHUB_NUMBER',
          description: both('起始 Issue/PR 号', 'The originating issue or pull request number')
        }
      ],
      values: ({ deployment, trigger }) => ({
        DSH_SUPERAGENT_GITHUB_REPOSITORY: deployment.repository,
        DSH_SUPERAGENT_GITHUB_ACCOUNT: deployment.githubLogin,
        DSH_SUPERAGENT_GITHUB_NUMBER:
          trigger === undefined ? '' : String(trigger.meta['issue'] ?? '')
      })
    }
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

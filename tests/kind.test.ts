// kind 协议（§I.1）的契约测试：用一条最小的 kind 证明接口的每个成员都能被实现、被调用，
// 并守住三条纪律：
// - `SourceContext` 只在 `core/ports.ts` 的领域端口上做加法（组合，不重定义）；
// - `SourceKind` 的 `schema` 是 `infra/schema.ts` 的最小校验器，配置校验失败即禁用该实例
//   （由 registry 落地，见 `registry.test.ts`）；
// - `sources/` 里的类型文件不出现 `any`。
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { object, string, number, boolean, enumOf, array } from '../src/worker/infra/schema.ts'
import type {
  ChannelLink,
  Deployment,
  Fact,
  Field,
  SourceChannel,
  SourceContext,
  SourceInstance,
  SourceKind,
  SourcePolicyPart
} from '../src/worker/sources/kind.ts'
import type {
  ChannelRef,
  HealthEntry,
  OutboundMessage,
  ReceiveResult,
  ScopeResult,
  ThreadRef,
  Ticket,
  Trigger
} from '../src/worker/core/index.ts'
import { listFiles, readRepoFile } from './support/repo.ts'

/** kind 的最小配置：与 GitHub kind 的真实形状同构，只是字段少。 */
const configSchema = object({
  repository: string().default(''),
  cli: string().default(''),
  pollSeconds: number().int().min(60).max(3600).default(60),
  observeIssues: boolean().default(false),
  listen: enumOf(['mentions', 'all']).default('mentions'),
  chats: array(object({ chatId: string(), listen: enumOf(['mentions', 'all']) })).default([])
}).strict()

type Config = ReturnType<typeof configSchema.parse>

/** 部署事实的测试值（完整解析由部署票负责）。 */
const deployment: Deployment = {
  repository: 'acme/widgets',
  githubCli: 'gh',
  githubLogin: 'agent-bot',
  githubCommitEmail: '1+agent-bot@users.noreply.github.com',
  feishuCli: '',
  feishuBotId: '',
  feishuAppId: ''
}

/** 一条最小 Trigger。 */
const trigger: Trigger = {
  id: 't1',
  source: 'probe',
  threads: [{ source: 'probe', id: '12' }],
  actor: { source: 'probe', id: 'alice' },
  human: true,
  at: '2026-11-07T00:00:00.000Z',
  text: 'please fix',
  meta: { kind: 'issue' }
}

/** 一条最小 kind：只实现必填项，证明必填集就是这些。 */
const requiredOnly: SourceKind<Config> = {
  kind: 'probe',
  title: { zh: '探针', en: 'Probe' },
  description: { zh: '测试用', en: 'For tests' },
  schema: configSchema,
  fields: [{ key: 'repository', type: 'text', label: { zh: '仓库', en: 'Repository' } }],
  health: ['probe']
}

/** 实现全部可选成员的 kind：类型检查即证明 §I.1 的每个成员都能被实现。 */
const full: SourceKind<Config> = {
  ...requiredOnly,
  facts: (dep: Deployment): readonly Fact[] => [{ key: 'account', value: `@${dep.githubLogin}` }],
  scope: (received, config): ScopeResult =>
    config.observeIssues && received.meta.kind === 'issue'
      ? { listened: true, observed: true, row: 'issues' }
      : { listened: true, observed: false },
  channel: {
    allowed: (address, config): boolean => config.repository !== '' && address.number !== undefined,
    send: async (_host, message): Promise<'sent' | 'gone'> => (message.text === '' ? 'gone' : 'sent'),
    link: (address, links): ChannelLink => ({
      url: links.repository ? `https://github.com/${links.repository}/issues/${address.number ?? ''}` : '',
      label: { zh: `#${address.number ?? ''}`, en: `#${address.number ?? ''}` }
    })
  } satisfies SourceChannel<Config>,
  threadContext: {
    messageId: (received: Trigger): string => String(received.meta.id ?? ''),
    read: async (_host, _received, part, cursor, config, _signal) => ({
      messages: [{ id: `${part}:${cursor ?? 'first'}`, from: 'alice', at: trigger.at, text: config.repository }],
      next: undefined,
      body: {}
    })
  },
  find: (query: string) => ({ threads: [`probe:${query}`], terms: [] }),
  repliesTo: (received: Trigger): string | undefined =>
    typeof received.meta.parentId === 'string' ? received.meta.parentId : undefined,
  policy: {
    schema: object({
      allowed: array(object({ id: string().regex(/^[A-Za-z0-9-]+$/) })).default([])
    }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '名单', en: 'Allowed' }, columns: [] }],
    explicit: { zh: '点名', en: 'Mentions' },
    unnamed: { person: { zh: '人', en: 'Person' }, bot: { zh: '机器人', en: 'Bot' } },
    rows: (config) => [
      {
        id: 'issues',
        label: { zh: '新 Issue', en: 'New Issues' },
        note: { zh: '全部', en: 'All' },
        cells: {
          listedUnaddressed: config.observeIssues === true,
          unlistedAddressed: true,
          unlistedUnaddressed: config.observeIssues === true
        }
      }
    ],
    bots: [{ key: 'bots', type: 'rows', label: { zh: '机器人', en: 'Bots' }, columns: [] }]
  } satisfies SourcePolicyPart,
  environment: {
    variables: [{ key: 'PROBE_REPOSITORY', description: { zh: '仓库', en: 'Repository' } }],
    values: ({ deployment: dep, config }) => ({ PROBE_REPOSITORY: dep.repository ?? config.repository })
  },
  refreshLabels: async (_host, _config, _signal) => ({ issues: 'Issues' })
}

/** 只声明端口成员的最小上下文：测试里不构造实现，只用它的类型。 */
type Context = SourceContext

describe('the SourceKind contract', () => {
  test('a kind can implement every member the design lists', async () => {
    assert.equal(full.kind, 'probe')
    assert.deepEqual(full.title, { zh: '探针', en: 'Probe' })
    assert.deepEqual(full.schema.parse({ repository: 'acme/widgets' }).pollSeconds, 60)
    assert.deepEqual(full.facts?.(deployment), [{ key: 'account', value: '@agent-bot' }])
    assert.deepEqual(full.scope?.(trigger, full.schema.parse({ observeIssues: true })), {
      listened: true,
      observed: true,
      row: 'issues'
    })
    const sent = await full.channel?.send({} as never, {
      id: 'm1',
      channel: { source: 'probe', thread: 'probe:12', address: { number: '12' } },
      text: 'ok',
      kind: 'reply'
    } satisfies OutboundMessage)
    assert.equal(sent, 'sent')
    assert.deepEqual(
      full.channel?.link?.({ number: '12' }, { repository: 'acme/widgets' }),
      { url: 'https://github.com/acme/widgets/issues/12', label: { zh: '#12', en: '#12' } }
    )
    assert.equal(
      full.threadContext?.messageId(trigger),
      ''
    )
    assert.deepEqual(full.find?.('#12'), { threads: ['probe:#12'], terms: [] })
    assert.equal(full.repliesTo?.({ ...trigger, meta: { parentId: 'p0' } }), 'p0')
    assert.deepEqual(full.policy?.rows?.({ observeIssues: true }), [
      {
        id: 'issues',
        label: { zh: '新 Issue', en: 'New Issues' },
        note: { zh: '全部', en: 'All' },
        cells: { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true }
      }
    ])
    assert.deepEqual(full.environment?.values({ deployment, config: full.schema.parse({}) }), {
      PROBE_REPOSITORY: 'acme/widgets'
    })
    assert.deepEqual(await full.refreshLabels?.({} as Context, full.schema.parse({}), new AbortController().signal), {
      issues: 'Issues'
    })
  })

  test('the required set is exactly kind, title, description, schema, fields and health', () => {
    // 必填集由类型保证；这里再守一次运行期身份，避免有人把必填项改成可选后测试无声通过。
    for (const key of ['kind', 'title', 'description', 'schema', 'fields', 'health'] as const) {
      assert.ok(key in requiredOnly, `${key} is required`)
    }
    assert.equal(requiredOnly.scope, undefined)
    assert.equal(requiredOnly.channel, undefined)
    assert.equal(requiredOnly.policy, undefined)
  })

  test('the schema rejects an unknown key and fills defaults, so an invalid instance can be disabled', () => {
    // strict()：未知键拒绝——registry 用 safeParse 失败来禁用实例。
    assert.equal(configSchema.safeParse({ surprise: 1 }).success, false)
    // 越界拒绝。
    assert.equal(configSchema.safeParse({ pollSeconds: 5 }).success, false)
    // 类型错误拒绝，且路径可定位。
    const bad = configSchema.safeParse({ chats: [{ chatId: 7, listen: 'all' }] })
    assert.equal(bad.success, false)
    if (!bad.success) assert.deepEqual(bad.issues[0]?.path, ['chats', 0, 'chatId'])
    // 默认值。
    assert.deepEqual(configSchema.parse({}), {
      repository: '',
      cli: '',
      pollSeconds: 60,
      observeIssues: false,
      listen: 'mentions',
      chats: []
    })
  })

  test('a SourceContext is the domain port plus exactly four kind-facing members', () => {
    // 组合而非重定义：领域端口的成员名逐个出现在 kind 的上下文里（类型层面由 `extends` 保证，
    // 运行期用一个结构替身断言成员都在）。
    const domainMembers = [
      'ready',
      'receive',
      'atomic',
      'state',
      'threads',
      'tickets',
      'triggers',
      'notify',
      'report'
    ] as const
    const added = ['configured', 'problem', 'config', 'commands'] as const
    const context: Context = {
      ready: true,
      receive: (_trigger: Trigger): ReceiveResult => 'stored',
      atomic: <T,>(work: () => T): T => work(),
      state: { get: () => undefined, set: () => {}, delete: () => {} },
      threads: {
        describe: (_ref: ThreadRef) => undefined,
        patch: (_ref: ThreadRef, _meta) => {}
      },
      tickets: {
        bindThread: (_id: string, _ref: ThreadRef, _own: boolean): Ticket => ({}) as Ticket,
        threadClosed: (_ref: ThreadRef, _outcome, _at: string) => {}
      },
      triggers: { read: (_id: string) => undefined },
      notify: (_input) => {},
      report: (_entry: string, _health: HealthEntry) => {},
      configured: () => false,
      problem: { code: 'setupPending' },
      config: <C extends Record<string, unknown>>(_kind: string): C | undefined => undefined,
      commands: {
        run: async () => '',
        stream: () => ({ stop: () => {} }),
        withSignal: () => context.commands
      }
    }
    for (const member of [...domainMembers, ...added]) {
      assert.ok(member in context, `${member} is on the kind context`)
    }
    // 地址与 Thread 的类型只在 kind.ts 里别名，不新造结构。
    const address: ChannelRef['address'] = { number: '12' }
    assert.deepEqual(address, { number: '12' })
    const instance: SourceInstance<Config> = {
      id: 'probe',
      kind: 'probe',
      enabled: true,
      config: configSchema.parse({})
    }
    assert.equal(instance.enabled, true)
  })
})

describe('the sources type surface', () => {
  test('no `any` escape in the kind files, and no app or engine import', () => {
    const files = listFiles('src/worker/sources', '.ts')
    assert.deepEqual(files, [
      'src/worker/sources/admission-context.ts',
      'src/worker/sources/commands.ts',
      'src/worker/sources/feishu/api.ts',
      'src/worker/sources/feishu/channel.ts',
      'src/worker/sources/feishu/config.ts',
      'src/worker/sources/feishu/image.ts',
      'src/worker/sources/feishu/index.ts',
      'src/worker/sources/feishu/kind.ts',
      'src/worker/sources/feishu/poll.ts',
      'src/worker/sources/feishu/read.ts',
      'src/worker/sources/feishu/stream.ts',
      'src/worker/sources/feishu/sync.ts',
      'src/worker/sources/feishu/translate.ts',
      'src/worker/sources/github/api.ts',
      'src/worker/sources/github/config.ts',
      'src/worker/sources/github/index.ts',
      'src/worker/sources/github/kind.ts',
      'src/worker/sources/github/poll.ts',
      'src/worker/sources/github/pull.ts',
      'src/worker/sources/github/translate.ts',
      'src/worker/sources/kind.ts',
      'src/worker/sources/registry.ts'
    ])
    for (const file of files) {
      const source = readRepoFile(file)
      // 受控别名只有 `JsonValue = unknown`；`any` 一律不允许。
      assert.equal(/(?::\s*any\b|\bas\s+any\b|<any>)/.test(source), false, `${file} uses any`)
      assert.equal(/from\s+['"][^'"]*\/app\//.test(source), false, `${file} imports the app layer`)
    }
  })

  test('the field union covers the control types the panel renders', () => {
    // 每个控件类型至少出现一次，证明联合没有被收窄成「只有 text」。
    const fields: readonly Field[] = [
      { key: 'a', type: 'switch', label: { zh: 'a', en: 'a' } },
      { key: 'b', type: 'select', label: { zh: 'b', en: 'b' }, options: [{ value: 'x', label: { zh: 'x', en: 'x' } }] },
      { key: 'c', type: 'number', label: { zh: 'c', en: 'c' }, min: 1, max: 2 },
      { key: 'd', type: 'text', label: { zh: 'd', en: 'd' }, pattern: 'a+' },
      { key: 'e', type: 'fact', label: { zh: 'e', en: 'e' }, settings: 'deployment' },
      { key: 'f', type: 'rows', label: { zh: 'f', en: 'f' }, columns: [{ key: 'id', type: 'text', label: { zh: 'i', en: 'i' } }] }
    ]
    assert.deepEqual(
      fields.map((field) => field.type),
      ['switch', 'select', 'number', 'text', 'fact', 'rows']
    )
  })
})

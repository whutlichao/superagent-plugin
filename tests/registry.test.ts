// Source 注册表（§I.1、§C.1、票 #10 验收第一条）：实例注册、配置校验失败即禁用、Policy
// 部分、Channel、Thread 上下文、健康归属。
//
// 断言面全部走注册表的公开查询（`instances` / `instance` / `policyPart` / `channelAllowed` /
// `send` / `link` / `threadContext` / `scope` / `overview`），不碰私有实现。
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { array, boolean, enumOf, number, object, string } from '../src/worker/infra/schema.ts'
import { EMPTY_SOURCE_SETTINGS, SOURCES_HEALTH_ENTRY, SourceRegistry } from '../src/worker/sources/registry.ts'
import type { SourceSettingsView } from '../src/worker/sources/registry.ts'
import type { SourceKind } from '../src/worker/sources/kind.ts'
import type { OutboundMessage, Trigger } from '../src/worker/core/index.ts'
import { FakeHealthBoard } from './support/health-board.ts'
import { FakeCommands } from './support/fake-commands.ts'

/** 探针 kind 的配置：interval 有默认值，scope 依赖 `meta.room` 与 `listen`。 */
const probeSchema = object({
  interval: number().int().min(1).max(60).default(5),
  listen: enumOf(['mentions', 'all']).default('mentions'),
  rooms: array(object({ id: string(), listen: enumOf(['mentions', 'all']) })).default([]),
  direct: boolean().default(false)
}).strict()

type ProbeConfig = ReturnType<typeof probeSchema.parse>

/** 一条只实现必填项的 kind。 */
const probe: SourceKind<ProbeConfig> = {
  kind: 'probe',
  title: { zh: '探针', en: 'Probe' },
  description: { zh: '测试用', en: 'For tests' },
  schema: probeSchema,
  fields: [{ key: 'interval', type: 'number', label: { zh: '间隔', en: 'Interval' }, min: 1, max: 60 }],
  health: []
}

/** 带 Policy 部分的 kind：名单 + 准入行 + 两个格子。 */
const policyKind: SourceKind<ProbeConfig> = {
  ...probe,
  kind: 'policy-probe',
  health: ['policy-probe'],
  policy: {
    schema: object({
      allowed: array(object({ id: string().regex(/^[a-z]+$/) })).default([]),
      bots: array(object({ id: string() })).optional(),
      syncChat: string().default('')
    }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '名单', en: 'Allowed' }, columns: [] }],
    explicit: { zh: '点名', en: 'Mentions' },
    bots: [{ key: 'bots', type: 'rows', label: { zh: '机器人', en: 'Bots' }, columns: [] }],
    rows: (config) => [
      {
        id: 'room',
        label: { zh: '房间', en: 'Room' },
        note: { zh: '全部', en: 'All' },
        cells: {
          listedUnaddressed: config.listen === 'all',
          unlistedAddressed: true,
          unlistedUnaddressed: config.listen === 'all'
        }
      }
    ],
    sync: {
      label: { zh: '立即同步', en: 'Sync now' },
      ready: (part) => typeof part.syncChat === 'string' && part.syncChat !== '',
      run: async (_host, part) => part
    }
  }
}

/** 带 Channel 与 Thread 上下文的 kind：记录发出去的消息与读语境的参数。 */
function channelKind(record: {
  sent: OutboundMessage[]
  read: unknown[]
  configs: unknown[]
}): SourceKind<ProbeConfig> {
  return {
    ...probe,
    kind: 'channel-probe',
    health: ['channel-probe'],
    scope: (trigger, config) => {
      const room = typeof trigger.meta.room === 'string' ? trigger.meta.room : undefined
      const listed = config.rooms.find((entry) => entry.id === room)
      if (trigger.meta.direct === true) {
        return config.direct
          ? { listened: true, observed: false, row: 'direct' }
          : { listened: false, reason: 'direct_messages_not_allowed' }
      }
      if (listed !== undefined) {
        return { listened: true, observed: listed.listen === 'all', row: listed.id }
      }
      return config.listen === 'all'
        ? { listened: true, observed: true, row: 'other' }
        : { listened: false, reason: 'room_not_allowed' }
    },
    channel: {
      allowed: (address, config) =>
        config.rooms.some((entry) => entry.id === address.room) || config.listen === 'all',
      send: async (_host, message) => {
        record.sent.push(message)
        return message.text === 'gone' ? 'gone' : 'sent'
      },
      link: (address) => ({
        url: `https://probe.test/${address.room ?? ''}`,
        label: { zh: '探针', en: 'Probe' }
      })
    },
    threadContext: {
      messageId: (trigger) => String(trigger.meta.messageId ?? ''),
      read: async (_host, trigger, part, cursor, config, _signal) => {
        record.read.push([trigger.id, part, cursor, config.interval])
        record.configs.push(config)
        return {
          messages: [{ id: `${part}:${cursor ?? 'first'}`, from: 'user', at: trigger.at, text: 'hi' }],
          next: undefined,
          body: { page: cursor ?? 'first' }
        }
      }
    },
    find: (query) => ({ threads: [`channel-probe:${query}`], terms: [] }),
    repliesTo: (trigger) =>
      typeof trigger.meta.parentId === 'string' ? String(trigger.meta.parentId) : undefined
  }
}

/** 一份带实例与 Policy 的设置视图。 */
function settingsOf(
  sources: Record<string, { enabled: boolean; config: Record<string, unknown> }>,
  policy: Record<string, Record<string, unknown>> = {}
): SourceSettingsView {
  return { sources, policy: { sources: policy } }
}

/** 一条最小 Trigger（scope 只看 source/meta）。 */
function triggerOf(meta: Record<string, unknown> = {}): Trigger {
  return {
    id: 't1',
    source: 'channel-probe',
    threads: [{ source: 'channel-probe', id: 'room-1' }],
    actor: { source: 'channel-probe', id: 'alice' },
    human: true,
    at: '2026-11-07T00:00:00.000Z',
    text: 'please fix',
    meta
  }
}

/** 一条出站消息。 */
function messageOf(source: string, text = 'ok'): OutboundMessage {
  return {
    id: 'm1',
    channel: { source, thread: `${source}:room-1`, address: { room: 'room-1' } },
    text,
    kind: 'reply'
  }
}

describe('instance registration', () => {
  test('lists every installed kind with defaults, in id order, then stored instances of missing kinds', () => {
    const settings = settingsOf({
      probe: { enabled: false, config: { interval: 9 } },
      retired: { enabled: true, config: { x: 1 } }
    })
    const sources = new SourceRegistry({ settings: () => settings })
    sources.register(policyKind)
    sources.register(probe)
    assert.deepEqual(sources.instances(), [
      {
        id: 'policy-probe',
        kind: 'policy-probe',
        enabled: true,
        config: { interval: 5, listen: 'mentions', rooms: [], direct: false },
        installed: true
      },
      { id: 'probe', kind: 'probe', enabled: false, config: { interval: 9, listen: 'mentions', rooms: [], direct: false }, installed: true },
      { id: 'retired', kind: 'retired', enabled: true, config: { x: 1 }, installed: false }
    ])
  })

  test('validates submitted configurations with the kind schema and refuses kinds that are not installed', () => {
    const sources = new SourceRegistry()
    sources.register(probe)
    assert.deepEqual(sources.validate('probe', { enabled: true, config: {} }), {
      enabled: true,
      config: { interval: 5, listen: 'mentions', rooms: [], direct: false }
    })
    // 越界、未知键、类型错误都在写入前拒绝，并给出可定位的一句。
    assert.throws(() => sources.validate('probe', { enabled: true, config: { interval: 0 } }), /interval/)
    assert.throws(() => sources.validate('probe', { enabled: true, config: { surprise: 1 } }), /surprise/)
    assert.throws(() => sources.validate('probe', { enabled: true, config: { listen: 'none' } }), /listen/)
    assert.throws(() => sources.validate('missing', { enabled: true, config: {} }), /not installed/)
  })

  test('a stored configuration that fails validation disables its instance and falls back to defaults', () => {
    const settings = settingsOf({
      probe: { enabled: true, config: { interval: 900 } },
      'policy-probe': { enabled: true, config: { interval: 7 } }
    })
    const sources = new SourceRegistry({ settings: () => settings })
    sources.register(probe)
    sources.register(policyKind)
    const disabled = sources.instance('probe')
    assert.equal(disabled?.enabled, false, 'an invalid configuration disables the instance')
    assert.equal(disabled?.configError, 'interval: expected at most 60')
    assert.deepEqual(disabled?.config, { interval: 5, listen: 'mentions', rooms: [], direct: false })
    // 同一个注册表里，配置合法的实例照常启用。
    assert.equal(sources.instance('policy-probe')?.enabled, true)
    // 总览把这条标成 error，并带上原因。
    const row = sources.overview().find((entry) => entry.id === 'probe')
    assert.equal(row?.state, 'error')
    assert.equal(row?.configError, 'interval: expected at most 60')
  })

  test('a missing stored instance uses the schema defaults and stays enabled', () => {
    const sources = new SourceRegistry({ settings: () => EMPTY_SOURCE_SETTINGS })
    sources.register(probe)
    assert.deepEqual(sources.instance('probe'), {
      id: 'probe',
      kind: 'probe',
      enabled: true,
      config: { interval: 5, listen: 'mentions', rooms: [], direct: false }
    })
    assert.equal(sources.instance('missing-kind'), undefined)
  })

  test('refuses a second registration of a kind and forgets the kind after its disposer runs', () => {
    const board = new FakeHealthBoard()
    const sources = new SourceRegistry({ health: board })
    const dispose = sources.register(policyKind)
    assert.throws(() => sources.register(policyKind), /already registered/)
    assert.equal(sources.kind('policy-probe')?.kind, 'policy-probe')
    dispose()
    assert.equal(sources.kind('policy-probe'), undefined)
    assert.equal(board.held('policy-probe'), false, 'the kind gives up its health entry')
    // 注销后可以重新注册（例如开发期热重载）。
    sources.register(policyKind)
    assert.equal(sources.kind('policy-probe')?.kind, 'policy-probe')
  })
})

describe('health ownership', () => {
  test('claims exactly the entries a kind declares, and refuses entries another part reports', () => {
    const board = new FakeHealthBoard()
    // 先占住一个「别的部件」的条目。
    board.claim('runtime')
    const sources = new SourceRegistry({ health: board })
    sources.register(probe)
    assert.deepEqual([...sources.healthEntries(['probe'])], [])
    // 声明了别人的条目：注册失败，且不留下半截状态。
    assert.throws(() => sources.register({ ...probe, kind: 'greedy', health: ['runtime'] }), /declares the health entry runtime/)
    assert.equal(sources.kind('greedy'), undefined)
    // `sync:` 前缀归 settings（§N.4）。
    assert.throws(
      () => sources.register({ ...probe, kind: 'synced', health: ['sync:probe'] }),
      /declares the health entry sync:probe/
    )
  })

  test('the registry owns the sources overview entry and keeps it current', () => {
    const board = new FakeHealthBoard()
    const settings = settingsOf({
      probe: { enabled: true, config: {} },
      'policy-probe': { enabled: false, config: {} }
    })
    const sources = new SourceRegistry({ settings: () => settings, health: board })
    sources.register(probe)
    sources.register(policyKind)
    // 还没跑过第一轮 overview：总览条目已 claim 但没有任何读数，因此是 starting（§J.3）。
    assert.equal(board.entries[SOURCES_HEALTH_ENTRY]?.state, 'starting', 'initial value')
    assert.equal(board.entries[SOURCES_HEALTH_ENTRY]?.detail, 'Not measured yet', 'initial detail')
    // kind 声明的条目同样是 claimed-but-unreported：policy-probe 还没有一次成功。
    assert.deepEqual(
      board.entries['policy-probe'],
      { state: 'starting', detail: 'Waiting for policy-probe' },
      'a freshly claimed entry starts as starting'
    )
    const rows = sources.overview()
    assert.deepEqual(
      rows.map((row) => [row.id, row.state]),
      [
        ['policy-probe', 'off'],
        ['probe', 'ready']
      ]
    )
    assert.equal(board.entries[SOURCES_HEALTH_ENTRY]?.state, 'ready')
    assert.equal(board.entries[SOURCES_HEALTH_ENTRY]?.detail, '1 enabled, 0 problems')

    // kind 自己报 error：总览跟着变 error，并计入问题数。
    sources.healthEntries(['policy-probe']).get('policy-probe')?.set({ state: 'error', detail: 'boom' })
    const after = sources.overview()
    assert.equal(after.find((row) => row.id === 'policy-probe')?.state, 'off', 'a disabled instance stays off')
    sources.register(channelKind({ sent: [], read: [], configs: [] }))
    sources.healthEntries(['channel-probe']).get('channel-probe')?.set({ state: 'error', detail: 'boom' })
    sources.overview()
    assert.equal(board.entries[SOURCES_HEALTH_ENTRY]?.state, 'error')
    assert.equal(board.entries[SOURCES_HEALTH_ENTRY]?.detail, '2 enabled, 1 problems')
  })

  test('a report sent after its kind unregisters is a no-op and cannot touch a later registration', () => {
    const board = new FakeHealthBoard()
    const sources = new SourceRegistry({ health: board })
    const dispose = sources.register(policyKind)
    const first = sources.healthEntries(['policy-probe']).get('policy-probe')
    first?.set({ state: 'ready', detail: 'ok' })
    assert.equal(board.entries['policy-probe']?.detail, 'ok')
    dispose()
    assert.equal(board.entries['policy-probe'], undefined)
    first?.set({ state: 'error', detail: 'late' })
    assert.equal(board.entries['policy-probe'], undefined, 'late reports never resurrect an entry')
    sources.register(policyKind)
    first?.set({ state: 'error', detail: 'late again' })
    assert.equal(board.entries['policy-probe']?.detail, 'Waiting for policy-probe')
    sources.healthEntries(['policy-probe']).get('policy-probe')?.set({ state: 'ready', detail: 'again' })
    assert.equal(board.entries['policy-probe']?.detail, 'again')
  })
})

describe('policy parts', () => {
  test('validates each Source part with its kind and keeps parts of kinds that are not installed', () => {
    const settings = settingsOf({}, { 'policy-probe': { allowed: [{ id: 'alice' }] } })
    const sources = new SourceRegistry({ settings: () => settings })
    sources.register(policyKind)
    sources.register(probe)
    assert.deepEqual(
      sources.validatePolicy({
        'policy-probe': { allowed: [{ id: 'alice' }], admission: { room: { unlistedAddressed: 'explicit' } } },
        retired: { allowed: [], x: 1 }
      }),
      {
        'policy-probe': {
          allowed: [{ id: 'alice' }],
          syncChat: '',
          admission: { room: { unlistedAddressed: 'explicit' } }
        },
        retired: { allowed: [], x: 1 }
      }
    )
    // kind 的 schema 拒绝不合法的名单项（大小写、格式）。
    assert.throws(
      () => sources.validatePolicy({ 'policy-probe': { allowed: [{ id: 'Alice' }] } }),
      /allowed\.0\.id/
    )
    // 没有 Policy 部分的 kind：原样保留（没有可校验的形状）。
    assert.deepEqual(sources.validatePolicy({ probe: { anything: 1 } }), { probe: { anything: 1 } })
  })

  test('returns a part with defaults and its admission table, or undefined for a kind without one', () => {
    const settings = settingsOf({}, { 'policy-probe': { allowed: [{ id: 'alice' }], admission: {} } })
    const sources = new SourceRegistry({ settings: () => settings })
    sources.register(policyKind)
    sources.register(probe)
    assert.deepEqual(sources.policyPart('policy-probe'), {
      allowed: [{ id: 'alice' }],
      syncChat: '',
      admission: {}
    })
    assert.deepEqual(sources.policyPart('probe'), undefined)
    assert.deepEqual(sources.policyPart('missing'), undefined)
  })

  test('surfaces the admission rows a kind derives from its configuration', () => {
    const sources = new SourceRegistry({ settings: () => EMPTY_SOURCE_SETTINGS })
    sources.register(policyKind)
    const rows = sources.kind('policy-probe')?.policy?.rows?.({ listen: 'all' })
    assert.deepEqual(rows, [
      {
        id: 'room',
        label: { zh: '房间', en: 'Room' },
        note: { zh: '全部', en: 'All' },
        cells: { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true }
      }
    ])
    // 名单同步：`ready` 只在点名了同步目标时为真。
    const sync = sources.kind('policy-probe')?.policy?.sync
    assert.equal(sync?.ready({ syncChat: 'oc_1' }), true)
    assert.equal(sync?.ready({ syncChat: '' }), false)
  })
})

describe('channels', () => {
  test('sends, links and reads a kind\'s threads through its own channel and context', async () => {
    const settings = settingsOf({
      'channel-probe': { enabled: true, config: { interval: 7, listen: 'all' } }
    })
    const record = { sent: [] as OutboundMessage[], read: [] as unknown[], configs: [] as unknown[] }
    const sources = new SourceRegistry({ settings: () => settings })
    sources.register(channelKind(record))
    const cli = new FakeCommands()

    assert.equal(await sources.send(messageOf('channel-probe'), cli), 'sent')
    assert.deepEqual(record.sent, [messageOf('channel-probe')])
    // 下游说 gone：注册表原样转达（不重试的判断在 outbox）。
    assert.equal(await sources.send(messageOf('channel-probe', 'gone'), cli), 'gone')

    // 没有对应 kind：消息等待（不 drop）；没有 Channel 的 kind：永远收不到。
    assert.equal(await sources.send(messageOf('retired'), cli), 'waiting')
    sources.register(probe)
    assert.equal(await sources.send(messageOf('probe'), cli), 'gone')

    assert.deepEqual(sources.link(messageOf('channel-probe').channel, {}), {
      url: 'https://probe.test/room-1',
      label: { zh: '探针', en: 'Probe' }
    })
    assert.deepEqual(sources.link(messageOf('retired').channel, {}), {
      url: '',
      label: { zh: 'retired', en: 'retired' }
    })

    // Thread 语境：绑定的是这个实例的配置，读的是这条 Trigger 的上下文。
    const trigger = triggerOf({ messageId: 'm1' })
    const context = sources.threadContext(trigger)
    assert.ok(context !== undefined)
    assert.equal(context.messageId, 'm1')
    const part = await context.read(cli, 'thread', '2')
    assert.deepEqual(part.body, { page: '2' })
    assert.deepEqual(record.read, [['t1', 'thread', '2', 7]])
    // kind 没有图片能力时，读图片明确失败，且不猜内容。
    await assert.rejects(context.image(cli, 'img_1', new AbortController().signal), /no images/)
    assert.deepEqual(context.images('img_1'), [])
  })

  test('a disabled instance allows no replies and offers no thread context', async () => {
    const settings = settingsOf({
      'channel-probe': { enabled: false, config: { listen: 'all' } }
    })
    const sources = new SourceRegistry({ settings: () => settings })
    sources.register(channelKind({ sent: [], read: [], configs: [] }))
    assert.equal(sources.channelAllowed({ source: 'channel-probe', address: { room: 'room-1' } }), false)
    assert.equal(sources.threadContext(triggerOf()), undefined)
    // 未安装的 kind 也没有语境。
    assert.equal(sources.threadContext({ ...triggerOf(), source: 'retired' }), undefined)
  })

  test('allows a reply only on a channel whose kind accepts the address', () => {
    const settings = settingsOf({
      'channel-probe': { enabled: true, config: { rooms: [{ id: 'room-1', listen: 'mentions' }] } }
    })
    const sources = new SourceRegistry({ settings: () => settings })
    // kind 没装：不允许（不知道它还能不能收）。
    assert.equal(sources.channelAllowed({ source: 'channel-probe', address: { room: 'room-1' } }), false)
    sources.register(channelKind({ sent: [], read: [], configs: [] }))
    assert.equal(sources.channelAllowed({ source: 'channel-probe', address: { room: 'room-1' } }), true)
    assert.equal(sources.channelAllowed({ source: 'channel-probe', address: { room: 'room-2' } }), false)
  })
})

describe('the SourceScope port', () => {
  test('answers listening with the kind\'s own rows and fixed reason codes', () => {
    const settings = settingsOf({
      'channel-probe': { enabled: true, config: { rooms: [{ id: 'room-1', listen: 'all' }], direct: false } },
      off: { enabled: false, config: {} }
    })
    const sources = new SourceRegistry({ settings: () => settings })
    sources.register(channelKind({ sent: [], read: [], configs: [] }))

    assert.deepEqual(sources.scope({ source: 'channel-probe', meta: { room: 'room-1' } }), {
      listened: true,
      observed: true,
      row: 'room-1'
    })
    assert.deepEqual(sources.scope({ source: 'channel-probe', meta: { room: 'room-2' } }), {
      listened: false,
      reason: 'room_not_allowed'
    })
    assert.deepEqual(sources.scope({ source: 'channel-probe', meta: { direct: true } }), {
      listened: false,
      reason: 'direct_messages_not_allowed'
    })
    // 实例被禁用：固定原因码。
    assert.deepEqual(sources.scope({ source: 'off', meta: {} }), {
      listened: false,
      reason: 'source_not_installed'
    })
    // 没存过配置的未注册 kind：默认监听、不 observed（内置 kind 尚未注册的早期阶段）。
    assert.deepEqual(sources.scope({ source: 'unknown', meta: {} }), { listened: true, observed: false })
  })

  test('a disabled installed instance listens to nothing with its own reason', () => {
    const settings = settingsOf({ 'channel-probe': { enabled: false, config: {} } })
    const sources = new SourceRegistry({ settings: () => settings })
    sources.register(channelKind({ sent: [], read: [], configs: [] }))
    assert.deepEqual(sources.scope({ source: 'channel-probe', meta: {} }), {
      listened: false,
      reason: 'source_disabled'
    })
  })

  test('an invalid stored configuration listens to nothing and says the configuration is at fault', () => {
    const settings = settingsOf({ probe: { enabled: true, config: { interval: 0 } } })
    const sources = new SourceRegistry({ settings: () => settings })
    sources.register(probe)
    assert.deepEqual(sources.scope({ source: 'probe', meta: {} }), {
      listened: false,
      reason: 'source_config_invalid'
    })
  })

  test('a kind without scope listens to everything it produces and observes none of it', () => {
    const settings = settingsOf({ probe: { enabled: true, config: {} } })
    const sources = new SourceRegistry({ settings: () => settings })
    sources.register(probe)
    assert.deepEqual(sources.scope({ source: 'probe', meta: { anything: true } }), {
      listened: true,
      observed: false
    })
  })
})

describe('search, replies and environment', () => {
  test('finds what a query names across kinds, deduplicating thread keys and terms', () => {
    const sources = new SourceRegistry({ settings: () => EMPTY_SOURCE_SETTINGS })
    sources.register(channelKind({ sent: [], read: [], configs: [] }))
    sources.register(probe)
    assert.deepEqual(sources.find('#12'), { threads: ['channel-probe:#12'], terms: [] })
    assert.deepEqual(sources.find('nothing'), { threads: ['channel-probe:nothing'], terms: [] })
  })

  test('names the Trigger whose message a Trigger answers', () => {
    const sources = new SourceRegistry({ settings: () => EMPTY_SOURCE_SETTINGS })
    sources.register(channelKind({ sent: [], read: [], configs: [] }))
    assert.equal(sources.repliesTo(triggerOf({ parentId: 'p0' })), 'p0')
    assert.equal(sources.repliesTo(triggerOf()), undefined)
    assert.equal(sources.repliesTo({ ...triggerOf({ parentId: 'p0' }), source: 'probe' }), undefined)
  })

  test('declares environment variables for every installed kind and values only for enabled ones', () => {
    const withEnvironment: SourceKind<ProbeConfig> = {
      ...probe,
      kind: 'env-probe',
      environment: {
        variables: [{ key: 'PROBE_INTERVAL', description: { zh: '间隔', en: 'Interval' } }],
        values: ({ config }) => ({ PROBE_INTERVAL: String(config.interval) })
      }
    }
    const settings = settingsOf({ 'env-probe': { enabled: true, config: { interval: 11 } } })
    const sources = new SourceRegistry({ settings: () => settings })
    sources.register(withEnvironment)
    sources.register(probe)
    assert.deepEqual(sources.declarations(), [
      { kind: 'env-probe', variables: [{ key: 'PROBE_INTERVAL', description: { zh: '间隔', en: 'Interval' } }] }
    ])
    const environments = sources.environments()
    assert.equal(environments.length, 1)
    assert.deepEqual(
      environments[0]?.environment.values({
        deployment: {
          repository: '',
          githubCli: '',
          githubLogin: '',
          githubCommitEmail: '',
          feishuCli: '',
          feishuBotId: '',
          feishuAppId: ''
        },
        config: environments[0]?.config as ProbeConfig
      }),
      { PROBE_INTERVAL: '11' }
    )
  })
})

// GitHub Source 的最小垂直切片（§I.2 的「通知轮询 + Issue 评论读取」两行）：轮询同一条
// 通知两次只产生一条 Trigger；游标按通知 id 保存；自身消息丢弃；点没点名由正文决定。
//
// 不发网络：所有 `gh` 调用都经 `CommandsHost`，测试用 `FakeCommands`（§I.6）。
import { assert, test } from 'orca/testing'
import { key } from '../src/worker/core/index.ts'
import type { Trigger } from '../src/worker/core/index.ts'
import { CliError } from '../src/worker/sources/commands'
import { SourceRegistry, EMPTY_SOURCE_SETTINGS } from '../src/worker/sources/registry'
import { githubKind } from '../src/worker/sources/github/kind'
import { createGithubApi } from '../src/worker/sources/github/api'
import { createGithubPoller } from '../src/worker/sources/github/poll'
import { githubCursorKey } from '../src/worker/app/kv'
import { FakeCommands } from './support/fake-commands'
import { FakeHealthBoard } from './support/health-board'

const NOTIFICATION = {
  id: 'notification-1',
  unread: true,
  reason: 'mention',
  updated_at: '2026-11-07T03:26:00Z',
  last_read_at: '2026-11-07T03:25:00Z',
  subject: {
    title: 'Fix the login redirect',
    url: 'https://api.github.com/repos/acme/widgets/issues/42',
    type: 'Issue'
  },
  repository: { full_name: 'acme/widgets' }
}

/** 一条 GitHub 评论（`/issues/:n/comments` 的一项）。 */
function comment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 9001,
    user: { login: 'alice', type: 'User' },
    body: '@acme-agent please fix the login redirect before Friday.',
    created_at: '2026-11-07T03:25:30Z',
    updated_at: '2026-11-07T03:25:30Z',
    html_url: 'https://github.com/acme/widgets/issues/42#issuecomment-9001',
    ...overrides
  }
}

/** 一个记录收到的 Trigger 的宿主（`SourceContext` 的最小形状）。 */
function host() {
  const received: Trigger[] = []
  const state = new Map<string, unknown>()
  const health: { entry: string; state: string; detail?: string }[] = []
  return {
    received,
    state,
    health,
    port: {
      receive: (trigger: Trigger) => {
        received.push(trigger)
        return 'stored' as const
      },
      state: {
        get: (key: string) => state.get(key),
        set: (key: string, value: unknown) => {
          state.set(key, value)
        },
        delete: (key: string) => state.delete(key)
      },
      report: (entry: string, value: { state: string; detail?: string }) => {
        health.push({ entry, ...value })
      }
    }
  }
}

/** 一份可用的配置（`githubKind.schema.parse` 的结果）。 */
function config(overrides: Record<string, unknown> = {}) {
  return githubKind.schema.parse({
    repository: 'acme/widgets',
    cli: 'gh',
    pollSeconds: 60,
    ...overrides
  })
}

/** 装上 FakeCommands 的 GitHub 读写端口。 */
function api(commands: FakeCommands) {
  return createGithubApi(commands, 'gh')
}

test('a notification expands into the Issue comments and one Trigger per comment', async () => {
  const commands = new FakeCommands()
  commands.script('gh api notifications', () => JSON.stringify([NOTIFICATION]))
  commands.script('gh api repos/acme/widgets/issues/42/comments', () => JSON.stringify([comment()]))
  const h = host()
  const poller = createGithubPoller({
    api: api(commands),
    config: config(),
    login: 'acme-agent',
    host: h.port,
    cursorKey: githubCursorKey
  })
  const result = await poller.poll()
  assert.deepEqual(result, { notifications: 1, triggers: 1 })
  assert.deepEqual(h.received, [
    {
      id: key('github', 'comment', '9001', '2026-11-07T03:25:30Z'),
      source: 'github',
      threads: [{ source: 'github', id: '42' }],
      actor: { source: 'github', id: 'alice' },
      human: true,
      addressed: 'mention',
      at: '2026-11-07T03:25:30Z',
      text: '@acme-agent please fix the login redirect before Friday.',
      url: 'https://github.com/acme/widgets/issues/42#issuecomment-9001',
      channel: {
        source: 'github',
        thread: 'github:42',
        address: { repo: 'acme/widgets', issue: '42' }
      },
      meta: {
        kind: 'comment',
        repository: 'acme/widgets',
        issue: 42,
        commentId: 9001,
        updatedAt: '2026-11-07T03:25:30Z'
      }
    }
  ])
  // 游标按通知 id 保存：同一个 updated_at 再来一轮不读评论（§I.2）。
  assert.deepEqual(h.state.get(githubCursorKey('notification-1')), {
    updatedAt: '2026-11-07T03:26:00Z',
    lastReadAt: '2026-11-07T03:25:00Z'
  })
})

test('polling the same notification twice reads the comments once', async () => {
  const commands = new FakeCommands()
  commands.script('gh api notifications', () => JSON.stringify([NOTIFICATION]))
  commands.script('gh api repos/acme/widgets/issues/42/comments', () => JSON.stringify([comment()]))
  const h = host()
  const poller = createGithubPoller({
    api: api(commands),
    config: config(),
    login: 'acme-agent',
    host: h.port,
    cursorKey: githubCursorKey
  })
  assert.equal((await poller.poll()).triggers, 1)
  assert.equal((await poller.poll()).triggers, 0)
  const commentReads = commands.calls.filter((call) => call.args[1]?.includes('/comments')).length
  assert.equal(commentReads, 1, 'the cursor stops a second read of the same notification')
})

test('a comment that does not mention the agent is still translated, with no addressed value', async () => {
  const commands = new FakeCommands()
  commands.script('gh api notifications', () => JSON.stringify([NOTIFICATION]))
  commands.script('gh api repos/acme/widgets/issues/42/comments', () =>
    JSON.stringify([comment({ body: 'just thinking out loud' })])
  )
  const h = host()
  const poller = createGithubPoller({
    api: api(commands),
    config: config(),
    login: 'acme-agent',
    host: h.port,
    cursorKey: githubCursorKey
  })
  await poller.poll()
  assert.equal(h.received[0]?.addressed, undefined)
  // Source 的监听范围：默认只听点名它的消息。
  assert.deepEqual(githubKind.scope?.(h.received[0] as Trigger, config()), {
    listened: false,
    reason: 'not_addressed'
  })
  assert.deepEqual(
    githubKind.scope?.(h.received[0] as Trigger, config({ observeComments: true })),
    { listened: true, observed: true, row: 'comments' }
  )
})

test('a message the agent wrote itself is dropped, not stored as a Trigger', async () => {
  const commands = new FakeCommands()
  commands.script('gh api notifications', () => JSON.stringify([NOTIFICATION]))
  commands.script('gh api repos/acme/widgets/issues/42/comments', () =>
    JSON.stringify([comment({ user: { login: 'acme-agent', type: 'User' } })])
  )
  const h = host()
  await createGithubPoller({
    api: api(commands),
    config: config(),
    login: 'acme-agent',
    host: h.port,
    cursorKey: githubCursorKey
  }).poll()
  assert.deepEqual(h.received, [])
})

test('a bot comment is human:false and never carries a mention-based mandate', async () => {
  const commands = new FakeCommands()
  commands.script('gh api notifications', () => JSON.stringify([NOTIFICATION]))
  commands.script('gh api repos/acme/widgets/issues/42/comments', () =>
    JSON.stringify([comment({ user: { login: 'ci-bot[bot]', type: 'Bot' } })])
  )
  const h = host()
  await createGithubPoller({
    api: api(commands),
    config: config(),
    login: 'acme-agent',
    host: h.port,
    cursorKey: githubCursorKey
  }).poll()
  assert.equal(h.received[0]?.human, false, 'a bot is never a human author')
  // 页面上的「点名」仍然记下来；能不能成为请求由 Gate 判（bot 永远不是显式请求）。
  assert.equal(h.received[0]?.addressed, 'mention')
  assert.deepEqual(githubKind.scope?.(h.received[0] as Trigger, config()), {
    listened: true,
    observed: false,
    row: 'comments'
  })
})

test('a non-Issue notification is recorded and skipped without reading anything', async () => {
  const commands = new FakeCommands()
  commands.script('gh api notifications', () =>
    JSON.stringify([{ ...NOTIFICATION, subject: { ...NOTIFICATION.subject, type: 'PullRequest' } }])
  )
  const h = host()
  const result = await createGithubPoller({
    api: api(commands),
    config: config(),
    login: 'acme-agent',
    host: h.port,
    cursorKey: githubCursorKey
  }).poll()
  assert.deepEqual(result, { notifications: 1, triggers: 0 })
  assert.equal(commands.calls.length, 1, 'only the notification list was read')
  assert.deepEqual(h.state.get(githubCursorKey('notification-1')), {
    updatedAt: '2026-11-07T03:26:00Z',
    lastReadAt: '2026-11-07T03:25:00Z',
    skipped: 'PullRequest'
  })
})

test('three failing rounds put GitHub in error, and one success clears it', async () => {
  const commands = new FakeCommands()
  commands.script('gh api notifications', () => JSON.stringify([NOTIFICATION]))
  for (let attempt = 0; attempt < 3; attempt += 1) {
    commands.fail(
      'gh',
      ['api', 'repos/acme/widgets/issues/42/comments'],
      new CliError('gh exited with code 1', 500, 1),
      { once: true }
    )
  }
  const h = host()
  const poller = createGithubPoller({
    api: api(commands),
    config: config(),
    login: 'acme-agent',
    host: h.port,
    cursorKey: githubCursorKey
  })
  await poller.poll()
  await poller.poll()
  assert.equal(h.state.get(githubCursorKey('notification-1')), undefined, 'a failed round does not advance the cursor')
  await poller.poll()
  assert.deepEqual(h.health.at(-1), { entry: 'github', state: 'error', detail: expectDetail() })
  commands.script('gh api repos/acme/widgets/issues/42/comments', () => JSON.stringify([comment()]))
  await poller.poll()
  assert.deepEqual(h.health.at(-1), { entry: 'github', state: 'ready', detail: 'notification poll ok' })
  assert.equal(h.received.length, 1)
})

/** 失败明细以固定前缀开头（错误文本里带程序名与结束方式，不回显参数，§I.4）。 */
function expectDetail(): string {
  return 'notification poll failed 3 times: gh exited with code 1'
}

test('the kind is registered under github and claims exactly its own health entry', () => {
  const board = new FakeHealthBoard()
  const registry = new SourceRegistry({ health: board, settings: () => EMPTY_SOURCE_SETTINGS })
  const unregister = registry.register(githubKind)
  assert.deepEqual(githubKind.health, ['github'])
  assert.equal(board.held('github'), true)
  const instances = registry.instances({ sources: {}, policy: { sources: {} } })
  assert.equal(instances.length, 1)
  assert.equal(instances[0]?.kind, 'github')
  unregister()
  assert.equal(board.held('github'), false)
})

test('the channel reads the existing comments before writing, and appends a hidden id marker', async () => {
  const commands = new FakeCommands()
  commands.script(['api', 'repos/acme/widgets/issues/42/comments?per_page=100', '-q'], () => '')
  commands.script(['api', 'repos/acme/widgets/issues/42/comments', '-f'], () => '{}')
  const result = await githubKind.channel?.send(
    {
      run: (program, args, options) => commands.run(program, args, options ?? {}),
      stream: (program, args, options) => commands.stream(program, args, options),
      withSignal: () => commands
    },
    {
      id: 'reply-1',
      channel: {
        source: 'github',
        thread: 'github:42',
        address: { repo: 'acme/widgets', issue: '42' }
      },
      text: 'Done: the login redirect is fixed.',
      kind: 'reply',
      ticketId: 'ticket-1'
    }
  )
  assert.equal(result, 'sent')
  assert.deepEqual(
    commands.calls.map((call) => call.args.slice(0, 2)),
    [
      ['api', 'repos/acme/widgets/issues/42/comments?per_page=100'],
      ['api', 'repos/acme/widgets/issues/42/comments']
    ]
  )
  assert.deepEqual(commands.calls[1]?.args, [
    'api',
    'repos/acme/widgets/issues/42/comments',
    '-f',
    'body=Done: the login redirect is fixed.\n\n<!-- superagent:reply-1 -->'
  ])
})

test('a comment that already carries the marker is not written again', async () => {
  const commands = new FakeCommands()
  commands.script(
    ['api', 'repos/acme/widgets/issues/42/comments?per_page=100', '-q'],
    () => 'Done.\n\n<!-- superagent:reply-1 -->'
  )
  const result = await githubKind.channel?.send(
    {
      run: (program, args, options) => commands.run(program, args, options ?? {}),
      stream: (program, args, options) => commands.stream(program, args, options),
      withSignal: () => commands
    },
    {
      id: 'reply-1',
      channel: { source: 'github', thread: 'github:42', address: { repo: 'acme/widgets', issue: '42' } },
      text: 'Done.',
      kind: 'reply'
    }
  )
  assert.equal(result, 'sent')
  assert.equal(commands.calls.length, 1, 'only the duplicate check ran')
})

test('a locked or deleted issue is gone; any other failure is an error the queue retries', async () => {
  async function attempt(error: CliError): Promise<'sent' | 'gone'> {
    const commands = new FakeCommands()
    commands.script(['api', 'repos/acme/widgets/issues/42/comments?per_page=100', '-q'], () => '')
    commands.fail('gh', ['api', 'repos/acme/widgets/issues/42/comments', '-f'], error)
    return (await githubKind.channel?.send(
      {
      run: (program, args, options) => commands.run(program, args, options ?? {}),
      stream: (program, args, options) => commands.stream(program, args, options),
      withSignal: () => commands
    },
      {
        id: 'reply-1',
        channel: { source: 'github', thread: 'github:42', address: { repo: 'acme/widgets', issue: '42' } },
        text: 'Done.',
        kind: 'reply'
      }
    )) as 'sent' | 'gone'
  }
  assert.equal(await attempt(new CliError('gh exited with code 1: HTTP 410', 410, 1)), 'gone')
  assert.equal(await attempt(new CliError('gh exited with code 1: HTTP 404', 404, 1)), 'gone')
  await assert.rejects(attempt(new CliError('gh exited with code 1: HTTP 500', 500, 1)), /gh exited/)
})

// GitHub Source 的运维面（§I.2 的「通知轮询」「订阅读取」「配置」「Trigger 翻译」四行）：
// 通知按 subject 展开成 Issue/PR 读取；游标按通知 id 保存且整轮成功才推进；有 Ticket 订阅的
// Thread 每轮读一次（Issue、评论、PR、评审、评审评论）；单条失败只留 Thread 的 pollError，
// 连续三轮失败报 health error，任何成功清零；超出两周水位线的 Thread 标为过期、停止轮询。
//
// 不发网络：所有 `gh` 调用都经 `CommandsHost`，测试用 `FakeCommands` 喂
// `tests/fixtures/cli/github/` 的真实输出片段（§I.6）。
import { assert, test } from 'orca/testing'
import { key } from '../src/worker/core/index.ts'
import type { Thread, Ticket, Trigger } from '../src/worker/core/index.ts'
import { CliError } from '../src/worker/sources/commands'
import { SourceRegistry, EMPTY_SOURCE_SETTINGS } from '../src/worker/sources/registry'
import { githubKind } from '../src/worker/sources/github/kind'
import { createGithubApi } from '../src/worker/sources/github/api'
import { createGithubPoller, subscribedThreads, withinHorizon } from '../src/worker/sources/github/poll'
import { githubSetupProblem } from '../src/worker/sources/github/config'
import { githubCursorKey } from '../src/worker/app/kv'
import { FakeCommands } from './support/fake-commands'
import { FakeHealthBoard } from './support/health-board'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readRepoFile, readRepoJson } from './support/repo'
import { openBoot, settingsOf } from './support/boot'

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
  const meta = new Map<string, Record<string, unknown>>()
  const health: { entry: string; state: string; detail?: string }[] = []
  return {
    received,
    state,
    meta,
    health,
    port: {
      receive: (trigger: Trigger) => {
        // 与领域端口一致：同 id 的 Trigger 是重复，不存也不计数（§D.1 幂等）。
        if (received.some((entry) => entry.id === trigger.id)) return 'duplicate' as const
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
      threads: {
        describe: (ref: { source: string; id: string }) => {
          const value = meta.get(`${ref.source}:${ref.id}`)
          return value === undefined ? undefined : { facts: value }
        },
        patch: (ref: { source: string; id: string }, patch: Record<string, unknown>) => {
          const key = `${ref.source}:${ref.id}`
          // 与真端口一致：值为 undefined 的键不落盘（清除 pollError 的写法）。
          const next: Record<string, unknown> = { ...(meta.get(key) ?? {}) }
          for (const [name, value] of Object.entries(patch)) {
            if (value === undefined) delete next[name]
            else next[name] = value
          }
          meta.set(key, next)
        }
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

/** 夹具里的通知在端口眼里的读数（跳过畸形条目的测试用它做「读出来的那一条」）。 */
function readableNotification() {
  return {
    id: '26977600684',
    updatedAt: '2026-11-06T12:40:45Z',
    lastReadAt: null,
    type: 'PullRequest',
    title: 'docs: describe the identity of the agent account',
    apiUrl: 'https://api.github.com/repos/acme/widgets/pulls/45',
    repository: 'acme/widgets'
  }
}

/** 夹具里的 Issue 评论在端口眼里的读数。 */
function readableComment() {
  return {
    id: 6702566216,
    login: 'alice',
    bot: false,
    body: '@acme-agent please fix the login redirect before Friday.',
    createdAt: '2026-11-07T05:01:49Z',
    updatedAt: '2026-11-07T05:01:49Z',
    url: 'https://github.com/acme/widgets/issues/42#issuecomment-6702566216'
  }
}

/** 装上 FakeCommands 的 GitHub 读写端口。 */
function api(commands: FakeCommands) {
  return createGithubApi(commands, 'gh')
}

test('the config keeps the four receive-all switches, defaulting to false, and the 10-3600 poll window', () => {
  // §I.2「配置」行：后四个开关缺省 false；#36 的 receive-all 只校验并保存它们，本票不实现。
  assert.deepEqual(githubKind.schema.parse({ repository: 'acme/widgets', cli: 'gh' }), {
    repository: 'acme/widgets',
    cli: 'gh',
    pollSeconds: 60,
    observeIssues: false,
    observePulls: false,
    observeComments: false,
    observeCi: false
  })
  const observed = githubKind.schema.parse({
    repository: 'acme/widgets',
    cli: 'gh',
    pollSeconds: 10,
    observeIssues: true,
    observePulls: true,
    observeComments: true,
    observeCi: true
  })
  assert.equal(observed.observeIssues, true)
  assert.equal(observed.observePulls, true)
  assert.equal(observed.observeComments, true)
  assert.equal(observed.observeCi, true)
  assert.throws(() => githubKind.schema.parse({ repository: 'acme/widgets', pollSeconds: 9 }))
  assert.throws(() => githubKind.schema.parse({ repository: 'acme/widgets', pollSeconds: 3601 }))
})

test('a missing repository or CLI is a setup problem, not a polling failure', () => {
  assert.equal(githubSetupProblem({ repository: '', cli: 'gh' }), 'repository_missing')
  assert.equal(githubSetupProblem({ repository: '   ', cli: 'gh' }), 'repository_missing')
  assert.equal(githubSetupProblem({ repository: 'acme/widgets', cli: '' }), 'cli_missing')
  assert.equal(githubSetupProblem({ repository: 'acme/widgets', cli: '  ' }), 'cli_missing')
  assert.equal(githubSetupProblem({ repository: 'acme/widgets', cli: 'gh' }), undefined)
})

test('a notification expands into the Issue comments and one Trigger per comment', async () => {
  const commands = new FakeCommands()
  commands.script('gh api notifications', () => JSON.stringify([NOTIFICATION]))
  commands.script(['api', 'repos/acme/widgets/issues/42'], () => fixture('issue.json'))
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
  assert.deepEqual(result, { notifications: 1, triggers: 1, skipped: 0 })
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
  commands.script(['api', 'repos/acme/widgets/issues/42'], () => fixture('issue.json'))
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
  commands.script(['api', 'repos/acme/widgets/issues/42'], () => fixture('issue.json'))
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
  commands.script(['api', 'repos/acme/widgets/issues/42'], () => fixture('issue.json'))
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
  commands.script(['api', 'repos/acme/widgets/issues/42'], () => fixture('issue.json'))
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

test('a notification that is neither an Issue nor a PR is recorded and skipped without reading anything', async () => {
  const commands = new FakeCommands()
  commands.script('gh api notifications', () =>
    JSON.stringify([{ ...NOTIFICATION, subject: { ...NOTIFICATION.subject, type: 'Release' } }])
  )
  const h = host()
  const result = await createGithubPoller({
    api: api(commands),
    config: config(),
    login: 'acme-agent',
    host: h.port,
    cursorKey: githubCursorKey
  }).poll()
  assert.deepEqual(result, { notifications: 1, triggers: 0, skipped: 0 })
  assert.equal(commands.calls.length, 1, 'only the notification list was read')
  assert.deepEqual(h.state.get(githubCursorKey('notification-1')), {
    updatedAt: '2026-11-07T03:26:00Z',
    lastReadAt: '2026-11-07T03:25:00Z',
    skipped: 'Release'
  })
})

/**
 * §I.2「订阅读取」行的五个端点：夹具是真实输出的脱敏片段（`tests/fixtures/cli/github/`），
 * 期望产出写在各自的 `.expected.json` 里；测试只经 FakeCommands 喂它们（§I.6）。
 */
const GITHUB_FIXTURES = 'tests/fixtures/cli/github'
const fixture = (name: string): string => readRepoFile(`${GITHUB_FIXTURES}/${name}`)
const expectedOf = (name: string): Record<string, unknown> =>
  readRepoJson<Record<string, unknown>>(`${GITHUB_FIXTURES}/${name}.expected.json`)

test('an Issue read reports the Issue, and the same endpoint reports a PR as a PR', async () => {
  const commands = new FakeCommands()
  commands.script(['api', 'repos/acme/widgets/issues/42'], () => fixture('issue.json'))
  commands.script(['api', 'repos/acme/widgets/issues/45'], () => fixture('pull-as-issue.json'))
  const reads = api(commands)
  const issue = await reads.issue('acme/widgets', 42)
  assert.deepEqual(issue, {
    items: [
      {
        number: 42,
        isPull: false,
        title: 'Fix the login redirect',
        url: 'https://github.com/acme/widgets/issues/42',
        state: 'closed',
        updatedAt: '2026-11-07T05:07:26Z'
      }
    ],
    skipped: 0
  })
  const pull = await reads.issue('acme/widgets', 45)
  assert.equal(pull.items[0]?.isPull, true, 'issues/<n> returns a PR with pull_request set')
  assert.equal(pull.items[0]?.number, 45)
  // argv 数组直达 CLI，仓库名与数字不进 shell（§I.4）。
  assert.deepEqual(
    commands.calls.map((call) => call.args),
    [
      ['api', 'repos/acme/widgets/issues/42'],
      ['api', 'repos/acme/widgets/issues/45']
    ]
  )
})

test('the PR read keeps the PR state a later ticket needs for the closing rule', async () => {
  const commands = new FakeCommands()
  commands.script(['api', 'repos/acme/widgets/pulls/45'], () => fixture('pull.json'))
  const pull = await api(commands).pull('acme/widgets', 45)
  assert.deepEqual(pull, {
    items: [
      {
        number: 45,
        title: 'docs: describe the identity of the agent account',
        url: 'https://github.com/acme/widgets/pull/45',
        state: 'closed',
        merged: true,
        updatedAt: '2026-11-07T03:09:36Z'
      }
    ],
    skipped: 0
  })
  assert.deepEqual(commands.calls[0]?.args, ['api', 'repos/acme/widgets/pulls/45'])
})

test('the review and review-comment pages are read with the argv arrays the fixtures record', async () => {
  const commands = new FakeCommands()
  commands.script(['api', 'repos/acme/widgets/pulls/45/reviews', '--paginate'], () =>
    fixture('pull-reviews.json')
  )
  commands.script(['api', 'repos/acme/widgets/pulls/45/comments', '--paginate'], () =>
    fixture('pull-review-comments.json')
  )
  const reads = api(commands)
  const reviews = await reads.pullReviews('acme/widgets', 45)
  assert.deepEqual(reviews, {
    items: [
      {
        id: 1714394287,
        state: 'COMMENTED',
        login: 'carol',
        body: '',
        submittedAt: '2023-11-06T07:14:48Z',
        url: 'https://github.com/acme/widgets/pull/45#pullrequestreview-1714394287'
      }
    ],
    skipped: 0
  })
  const comments = await reads.pullComments('acme/widgets', 45)
  assert.equal(comments.items.length, 1)
  assert.equal(comments.items[0]?.login, 'carol')
  assert.equal(comments.items[0]?.body.includes('latest release'), true)
  assert.deepEqual(
    commands.calls.map((call) => call.args),
    [
      expectedOf('pull-reviews').read,
      expectedOf('pull-review-comments').read
    ].map((read) => (read as { args: readonly string[] }).args)
  )
})

test('a malformed entry is skipped with a counter, never a crash', async () => {
  const commands = new FakeCommands()
  // 真实夹具后面追加一条坏的：形状来自真实输出，坏的这一条是测试自己造的。
  commands.script('gh api notifications', () =>
    JSON.stringify([...JSON.parse(fixture('notifications.json')), { id: '', subject: {} }])
  )
  commands.script(['api', 'repos/acme/widgets/issues/42/comments', '--paginate'], () =>
    JSON.stringify([...JSON.parse(fixture('issue-comments.json')), { body: 'no id' }])
  )
  commands.script(['api', 'repos/acme/widgets/issues/42'], () => JSON.stringify({ hello: 'world' }))
  commands.script(['api', 'repos/acme/widgets/pulls/45/reviews', '--paginate'], () =>
    JSON.stringify([{ state: 'COMMENTED' }])
  )
  commands.script(['api', 'repos/acme/widgets/pulls/45/comments', '--paginate'], () =>
    JSON.stringify([{ body: 'no id' }])
  )
  commands.script(['api', 'repos/acme/widgets/pulls/45'], () => JSON.stringify({ title: 'no number' }))
  const reads = api(commands)
  assert.deepEqual(await reads.notifications(), {
    items: [readableNotification()],
    skipped: 1
  })
  assert.deepEqual(await reads.issueComments('acme/widgets', 42, null), {
    items: [readableComment()],
    skipped: 1
  })
  assert.deepEqual(await reads.issue('acme/widgets', 42), { items: [], skipped: 1 })
  assert.deepEqual(await reads.pullReviews('acme/widgets', 45), { items: [], skipped: 1 })
  assert.deepEqual(await reads.pullComments('acme/widgets', 45), { items: [], skipped: 1 })
  assert.deepEqual(await reads.pull('acme/widgets', 45), { items: [], skipped: 1 })
})

test('every Thread with a live Ticket subscription is read each round, PR endpoints included', async () => {
  const commands = new FakeCommands()
  commands.script('gh api notifications', () => JSON.stringify([]))
  commands.script(['api', 'repos/acme/widgets/issues/42'], () => fixture('issue.json'))
  commands.script(['api', 'repos/acme/widgets/issues/42/comments', '--paginate'], () =>
    fixture('issue-comments.json')
  )
  commands.script(['api', 'repos/acme/widgets/issues/45'], () => fixture('pull-as-issue.json'))
  commands.script(['api', 'repos/acme/widgets/pulls/45'], () => fixture('pull.json'))
  commands.script(['api', 'repos/acme/widgets/issues/45/comments', '--paginate'], () =>
    fixture('pull-conversation.json')
  )
  commands.script(['api', 'repos/acme/widgets/pulls/45/reviews', '--paginate'], () =>
    fixture('pull-reviews.json')
  )
  commands.script(['api', 'repos/acme/widgets/pulls/45/comments', '--paginate'], () =>
    fixture('pull-review-comments.json')
  )
  const h = host()
  const poller = createGithubPoller({
    api: api(commands),
    config: config(),
    login: 'acme-agent',
    host: h.port,
    cursorKey: githubCursorKey,
    subscribed: () => [
      { issue: 42, live: true, lastAt: '2026-11-07T03:00:00Z' },
      { issue: 45, live: true, lastAt: '2026-11-07T03:00:00Z' }
    ],
    now: () => Date.parse('2026-11-07T04:00:00Z')
  })
  const first = await poller.poll()
  assert.deepEqual(first, { notifications: 0, triggers: 2, skipped: 0 })
  assert.deepEqual(
    commands.calls.map((call) => call.args.slice(0, 2)),
    [
      ['api', 'notifications'],
      ['api', 'repos/acme/widgets/issues/42'],
      ['api', 'repos/acme/widgets/issues/42/comments'],
      ['api', 'repos/acme/widgets/issues/45'],
      ['api', 'repos/acme/widgets/pulls/45'],
      ['api', 'repos/acme/widgets/issues/45/comments'],
      ['api', 'repos/acme/widgets/pulls/45/reviews'],
      ['api', 'repos/acme/widgets/pulls/45/comments']
    ]
  )
  assert.deepEqual(
    h.received.map((trigger) => trigger.threads[0]?.id),
    ['42', '45']
  )
  // 每个 Thread 都读到了自己的页面地址（Thread meta 归 Source 写，§D.2）。
  assert.equal(h.meta.get('github:42')?.url, 'https://github.com/acme/widgets/issues/42')
  assert.equal(h.meta.get('github:45')?.url, 'https://github.com/acme/widgets/pull/45')

  // 下一轮再读一遍：读本身每轮都发生，但同一版本评论只交一次（Trigger id 幂等）。
  const second = await poller.poll()
  assert.equal(second.triggers, 0)
  const commentReads = commands.calls.filter((call) => call.args[1] === 'repos/acme/widgets/issues/42/comments')
  assert.equal(commentReads.length, 2, 'the subscribed Thread is read once per round')
})

test('a single Thread failure stays on its meta while other Threads are read', async () => {
  const commands = new FakeCommands()
  commands.script('gh api notifications', () => JSON.stringify([]))
  commands.script(['api', 'repos/acme/widgets/issues/42'], () => fixture('issue.json'))
  for (let attempt = 0; attempt < 3; attempt += 1) {
    commands.fail(
      'gh',
      ['api', 'repos/acme/widgets/issues/42/comments', '--paginate'],
      new CliError('gh exited with code 1', 500, 1),
      { once: true }
    )
  }
  commands.script(['api', 'repos/acme/widgets/issues/45'], () => fixture('pull-as-issue.json'))
  commands.script(['api', 'repos/acme/widgets/pulls/45'], () => fixture('pull.json'))
  commands.script(['api', 'repos/acme/widgets/issues/45/comments', '--paginate'], () =>
    fixture('pull-conversation.json')
  )
  commands.script(['api', 'repos/acme/widgets/pulls/45/reviews', '--paginate'], () =>
    fixture('pull-reviews.json')
  )
  commands.script(['api', 'repos/acme/widgets/pulls/45/comments', '--paginate'], () =>
    fixture('pull-review-comments.json')
  )
  const h = host()
  const poller = createGithubPoller({
    api: api(commands),
    config: config(),
    login: 'acme-agent',
    host: h.port,
    cursorKey: githubCursorKey,
    subscribed: () => [
      { issue: 42, live: true, lastAt: '2026-11-07T03:00:00Z' },
      { issue: 45, live: true, lastAt: '2026-11-07T03:00:00Z' }
    ],
    now: () => Date.parse('2026-11-07T04:00:00Z')
  })
  const first = await poller.poll()
  // #42 的评论失败只记在它的 Thread 上；#45 照常读、照常收。
  assert.equal(first.triggers, 1)
  assert.equal(typeof h.meta.get('github:42')?.pollError, 'string')
  assert.equal(h.meta.get('github:45')?.pollError, undefined)

  await poller.poll()
  await poller.poll()
  assert.equal(h.health.at(-1)?.state, 'error', 'three consecutive failed rounds mark github error')
  assert.equal(h.health.at(-1)?.detail?.startsWith('poll failed 3 times: gh exited with code 1'), true)

  // 一次成功清零：health 回到 ready，Thread 的错误被清掉。
  commands.script(['api', 'repos/acme/widgets/issues/42/comments', '--paginate'], () =>
    fixture('issue-comments.json')
  )
  const recovered = await poller.poll()
  assert.equal(recovered.triggers, 1)
  assert.equal(h.health.at(-1)?.state, 'ready')
  assert.equal(h.meta.get('github:42')?.pollError, undefined)
})

test('a Thread already read by its notification is not read again as a subscription', async () => {
  const commands = new FakeCommands()
  commands.script('gh api notifications', () => fixture('notifications.json'))
  commands.script(['api', 'repos/acme/widgets/pulls/45'], () => fixture('pull.json'))
  commands.script(['api', 'repos/acme/widgets/issues/45/comments', '--paginate'], () =>
    fixture('pull-conversation.json')
  )
  commands.script(['api', 'repos/acme/widgets/pulls/45/reviews', '--paginate'], () =>
    fixture('pull-reviews.json')
  )
  commands.script(['api', 'repos/acme/widgets/pulls/45/comments', '--paginate'], () =>
    fixture('pull-review-comments.json')
  )
  const h = host()
  await createGithubPoller({
    api: api(commands),
    config: config(),
    login: 'acme-agent',
    host: h.port,
    cursorKey: githubCursorKey,
    subscribed: () => [{ issue: 45, live: true, lastAt: '2026-11-07T03:00:00Z' }],
    now: () => Date.parse('2026-11-07T04:00:00Z')
  }).poll()
  const paths = commands.calls.map((call) => call.args[1])
  for (const path of ['repos/acme/widgets/pulls/45', 'repos/acme/widgets/issues/45/comments']) {
    assert.equal(paths.filter((entry) => entry === path).length, 1, `${path} is read once per round`)
  }
})

test('a Thread past the horizon is marked expired and no longer polled, with its record kept', async () => {
  const commands = new FakeCommands()
  commands.script('gh api notifications', () => JSON.stringify([]))
  // #42 活订阅；#45 没有活订阅，最后活动是 15 天前（超出两周水位线）。
  commands.script(['api', 'repos/acme/widgets/issues/42'], () => fixture('issue.json'))
  commands.script(['api', 'repos/acme/widgets/issues/42/comments', '--paginate'], () =>
    fixture('issue-comments.json')
  )
  const h = host()
  h.meta.set('github:45', { label: '#45 docs: describe the identity of the agent account' })
  const poller = createGithubPoller({
    api: api(commands),
    config: config(),
    login: 'acme-agent',
    host: h.port,
    cursorKey: githubCursorKey,
    subscribed: () => [
      { issue: 42, live: true, lastAt: '2026-11-07T03:00:00Z' },
      { issue: 45, live: false, lastAt: '2026-10-23T03:00:00Z' }
    ],
    now: () => Date.parse('2026-11-07T04:00:00Z')
  })
  const result = await poller.poll()
  assert.deepEqual(result, { notifications: 0, triggers: 1, skipped: 0 })
  // 过期的 Thread 一次都不读。
  assert.equal(
    commands.calls.some((call) => String(call.args[1] ?? '').includes('/45')),
    false
  )
  assert.equal(h.meta.get('github:45')?.pollExpired, true)
  // 详情仍要听「两周」的语义：10-23 到 11-07 是 15 天；同样的记录在两周内会被轮询。
  assert.equal(h.meta.get('github:45')?.label, '#45 docs: describe the identity of the agent account')
  const recent = createGithubPoller({
    api: api(commands),
    config: config(),
    login: 'acme-agent',
    host: host().port,
    cursorKey: githubCursorKey,
    subscribed: () => [{ issue: 45, live: false, lastAt: '2026-11-06T03:00:00Z' }],
    now: () => Date.parse('2026-11-07T04:00:00Z')
  })
  await recent.poll()
  assert.equal(
    commands.calls.some((call) => call.args[1] === 'repos/acme/widgets/issues/45'),
    true,
    'inside the horizon a dead subscription is still read'
  )
})

test('three failing rounds put GitHub in error, and one success clears it', async () => {
  const commands = new FakeCommands()
  commands.script('gh api notifications', () => JSON.stringify([NOTIFICATION]))
  commands.script(['api', 'repos/acme/widgets/issues/42'], () => fixture('issue.json'))
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
  assert.deepEqual(h.health.at(-1), { entry: 'github', state: 'ready', detail: '1 notifications' })
  assert.equal(h.received.length, 1)
})

/** 失败明细以固定前缀开头（错误文本里带程序名与结束方式，不回显参数，§I.4）。 */
function expectDetail(): string {
  return 'poll failed 3 times: gh exited with code 1'
}

test('a PullRequest notification expands into the PR and its conversation comments', async () => {
  const commands = new FakeCommands()
  commands.script('gh api notifications', () => fixture('notifications.json'))
  commands.script(['api', 'repos/acme/widgets/pulls/45'], () => fixture('pull.json'))
  commands.script(['api', 'repos/acme/widgets/issues/45/comments', '--paginate'], () =>
    fixture('pull-conversation.json')
  )
  // PR 的订阅读取还有评审与评审评论两页（本票只读，翻译归 #18）。
  commands.script(['api', 'repos/acme/widgets/pulls/45/reviews', '--paginate'], () =>
    fixture('pull-reviews.json')
  )
  commands.script(['api', 'repos/acme/widgets/pulls/45/comments', '--paginate'], () =>
    fixture('pull-review-comments.json')
  )
  const h = host()
  const result = await createGithubPoller({
    api: api(commands),
    config: config(),
    login: 'acme-agent',
    host: h.port,
    cursorKey: githubCursorKey,
    now: () => Date.parse('2026-11-07T04:00:00Z')
  }).poll()
  assert.deepEqual(result, { notifications: 1, triggers: 1, skipped: 0 })
  // 通知的 subject.type 已经说明是 PR：不再多读一次 issues/<n>（夹具的 expandsTo 记着这一点）。
  assert.deepEqual(
    commands.calls.map((call) => call.args.slice(0, 2)),
    [
      ['api', 'notifications'],
      ['api', 'repos/acme/widgets/pulls/45'],
      ['api', 'repos/acme/widgets/issues/45/comments'],
      ['api', 'repos/acme/widgets/pulls/45/reviews'],
      ['api', 'repos/acme/widgets/pulls/45/comments']
    ]
  )
  const { idRecipe: _recipe, ...expected } = expectedOf('pull-conversation').trigger as Trigger & {
    idRecipe: string
  }
  assert.deepEqual(h.received, [expected])
  // 读到的 PR 把页面地址写进 Thread 自己的 meta（§D.2：label/url/facts/pollError 归 Source）。
  assert.equal(h.meta.get('github:45')?.url, 'https://github.com/acme/widgets/pull/45')
  assert.equal(h.meta.get('github:45')?.pollError, undefined)
  assert.deepEqual(h.state.get(githubCursorKey('26977600684')), {
    updatedAt: '2026-11-06T12:40:45Z',
    lastReadAt: null
  })
})

test('an Issue notification reads the Issue first, then its comments', async () => {
  const commands = new FakeCommands()
  commands.script('gh api notifications', () => JSON.stringify([NOTIFICATION]))
  commands.script(['api', 'repos/acme/widgets/issues/42'], () => fixture('issue.json'))
  commands.script(['api', 'repos/acme/widgets/issues/42/comments', '--paginate'], () =>
    fixture('issue-comments.json')
  )
  const h = host()
  const result = await createGithubPoller({
    api: api(commands),
    config: config(),
    login: 'acme-agent',
    host: h.port,
    cursorKey: githubCursorKey
  }).poll()
  assert.deepEqual(result, { notifications: 1, triggers: 1, skipped: 0 })
  assert.deepEqual(
    commands.calls.map((call) => call.args.slice(0, 2)),
    [
      ['api', 'notifications'],
      ['api', 'repos/acme/widgets/issues/42'],
      ['api', 'repos/acme/widgets/issues/42/comments']
    ]
  )
  const { idRecipe: _recipe, ...expected } = expectedOf('issue-comments').trigger as Trigger & {
    idRecipe: string
  }
  assert.deepEqual(h.received, [expected])
})

test('the cursor advances only after the whole round succeeds', async () => {
  const commands = new FakeCommands()
  const second = {
    ...NOTIFICATION,
    id: 'notification-2',
    subject: { ...NOTIFICATION.subject, url: 'https://api.github.com/repos/acme/widgets/issues/43' }
  }
  commands.script('gh api notifications', () => JSON.stringify([NOTIFICATION, second]))
  commands.script(['api', 'repos/acme/widgets/issues/42'], () => fixture('issue.json'))
  commands.script(['api', 'repos/acme/widgets/issues/42/comments', '--paginate'], () =>
    fixture('issue-comments.json')
  )
  commands.script(['api', 'repos/acme/widgets/issues/43'], () => fixture('issue.json'))
  commands.fail(
    'gh',
    ['api', 'repos/acme/widgets/issues/43/comments', '--paginate', '--method', 'GET', '-f', 'per_page=100'],
    new CliError('gh exited with code 1', 500, 1),
    { once: true }
  )
  const h = host()
  const poller = createGithubPoller({
    api: api(commands),
    config: config(),
    login: 'acme-agent',
    host: h.port,
    cursorKey: githubCursorKey
  })
  const failed = await poller.poll()
  // 一条读成功、一条读失败：整轮算失败，两个游标都不动（下一轮重读，幂等由 Trigger id 保证）。
  assert.deepEqual(failed, { notifications: 2, triggers: 1, skipped: 0 })
  assert.equal(h.state.get(githubCursorKey('notification-1')), undefined)
  assert.equal(h.state.get(githubCursorKey('notification-2')), undefined)
  assert.equal(typeof h.meta.get('github:43')?.pollError, 'string', 'the failing Thread records the error')

  commands.script(['api', 'repos/acme/widgets/issues/43/comments', '--paginate'], () =>
    fixture('issue-comments.json')
  )
  const retried = await poller.poll()
  // 第二轮两条通知都重读：评论是同一个 Trigger id，只有第一次算收到。
  assert.equal(retried.notifications, 2)
  assert.deepEqual(h.state.get(githubCursorKey('notification-1')), {
    updatedAt: '2026-11-07T03:26:00Z',
    lastReadAt: '2026-11-07T03:25:00Z'
  })
  assert.notEqual(h.state.get(githubCursorKey('notification-2')), undefined)
  assert.equal(h.meta.get('github:43')?.pollError, undefined, 'a successful reread clears the Thread error')
})

test('a 404 is retried next round, not treated as a deleted Thread', async () => {
  const commands = new FakeCommands()
  commands.script('gh api notifications', () => JSON.stringify([]))
  // 订阅 Thread 先读 issues/<n>，用一次性 404 失败；下一轮重试用同一个端点（404 不是「消失」）。
  commands.fail(
    'gh',
    ['api', 'repos/acme/widgets/issues/42'],
    new CliError('gh exited with code 1: HTTP 404', 404, 1),
    { once: true }
  )
  commands.script(['api', 'repos/acme/widgets/issues/42'], () => fixture('issue.json'))
  commands.script(['api', 'repos/acme/widgets/issues/42/comments', '--paginate'], () =>
    fixture('issue-comments.json')
  )
  const h = host()
  const poller = createGithubPoller({
    api: api(commands),
    config: config(),
    login: 'acme-agent',
    host: h.port,
    cursorKey: githubCursorKey,
    subscribed: () => [{ issue: 42, live: true, lastAt: '2026-11-07T03:00:00Z' }],
    now: () => Date.parse('2026-11-07T04:00:00Z')
  })
  const first = await poller.poll()
  assert.equal(first.triggers, 0, 'a 404 is a failure, not a gone Thread')
  assert.equal(typeof h.meta.get('github:42')?.pollError, 'string')
  const second = await poller.poll()
  assert.equal(second.triggers, 1, 'the next round re-reads the Thread')
  assert.equal(h.meta.get('github:42')?.pollError, undefined)
})

test('the result counts malformed entries instead of crashing', async () => {
  const commands = new FakeCommands()
  commands.script('gh api notifications', () =>
    JSON.stringify([...JSON.parse(fixture('notifications.json')), { id: '', subject: {} }])
  )
  commands.script(['api', 'repos/acme/widgets/pulls/45'], () => fixture('pull.json'))
  commands.script(['api', 'repos/acme/widgets/issues/45/comments', '--paginate'], () =>
    fixture('pull-conversation.json')
  )
  commands.script(['api', 'repos/acme/widgets/pulls/45/reviews', '--paginate'], () =>
    JSON.stringify([{ state: 'COMMENTED' }])
  )
  commands.script(['api', 'repos/acme/widgets/pulls/45/comments', '--paginate'], () =>
    fixture('pull-review-comments.json')
  )
  const h = host()
  const result = await createGithubPoller({
    api: api(commands),
    config: config(),
    login: 'acme-agent',
    host: h.port,
    cursorKey: githubCursorKey
  }).poll()
  // 一条通知缺 id、一条评审缺 id：都只计数跳过，整轮仍算成功（不是失败）。
  assert.deepEqual(result, { notifications: 1, triggers: 1, skipped: 2 })
  assert.equal(h.health.at(-1)?.state, 'ready')
  assert.notEqual(h.state.get(githubCursorKey('26977600684')), undefined)
})

test('a missing repository or CLI leaves the Source in setup and starts no polling', async () => {
  const cases = [
    { repository: '', cli: 'gh' },
    { repository: 'acme/widgets', cli: '' }
  ]
  for (const config of cases) {
    const stateDir = mkdtempSync(join(tmpdir(), 'superagent-setup-'))
    const h = await openBoot({
      stateDir,
      settings: {
        ...settingsOf(stateDir),
        sources: { github: { enabled: true, config: { ...config, pollSeconds: 60 } } }
      }
    })
    try {
      // 组合根不造轮询器：`pollOnce` 返回空读数，且一个 gh 调用都没有（连账号探针都不跑）。
      assert.deepEqual(await h.handle.pollOnce(), { notifications: 0, triggers: 0, skipped: 0 })
      assert.equal(h.handle.snapshot().health.setupMissing, true, 'the panel sees a setup problem')
      assert.deepEqual(h.commands.calls, [], 'no gh call happens before setup completes')
    } finally {
      await h.cleanup()
    }
  }
})

test('the composition root polls Threads subscribed by a live Ticket from the real store', async () => {
  const h = await openBoot()
  try {
    await h.handle.pollOnce()
    await h.handle.passOnce()
    await h.handle.passOnce()
    await h.handle.passOnce()
    const before = h.commands.calls.length
    // 通知的游标停住了通知路径；Thread 上的 Ticket 订阅让它这一轮再被读一次。
    const second = await h.handle.pollOnce()
    assert.deepEqual(second, { notifications: 1, triggers: 0, skipped: 0 })
    assert.deepEqual(
      h.commands.calls.slice(before).map((call) => call.args.slice(0, 2)),
      [
        ['api', 'notifications'],
        ['api', 'repos/acme/widgets/issues/42'],
        ['api', 'repos/acme/widgets/issues/42/comments']
      ]
    )
  } finally {
    await h.cleanup()
  }
})

test('a live subscription bypasses the two-week horizon; a dead one ends there', () => {
  const AT = '2026-11-07T03:00:00Z'
  const thread = (key: string, source: string, id: string, subscriptions: string[], lastAt: string): Thread => ({
    key,
    ref: { source, id },
    createdAt: '2026-01-01T00:00:00Z',
    lastAt,
    subscriptions,
    correlated: [],
    pending: [],
    meta: {}
  })
  const ticket = (id: string, ended?: { at: string; by: 'executor'; outcome: 'completed' }): Ticket => ({
    id,
    title: 'Fix the login flow',
    decisionId: 'decision-1',
    mandate: {
      strength: 'explicit',
      policyVersion: 'v1',
      basis: { via: 'addressed', addressed: 'mention' },
      actor: { source: 'github', id: 'alice' },
      scope: 'ticket'
    },
    channels: [],
    assignments: [],
    inputs: [],
    undelivered: [],
    createdAt: AT,
    updatedAt: AT,
    origin: { triggerId: 'gh-comment-1', triggerIds: ['gh-comment-1'] },
    ...(ended === undefined ? {} : { ended })
  })
  const subscribed = subscribedThreads(
    [
      // 活 Ticket：最后一条 Trigger 是年初也照读（活订阅绕过水位线）。
      thread('github:42', 'github', '42', ['ticket-live'], '2026-01-01T00:00:00Z'),
      // Ticket 已结束：从结束时刻起算两周。
      thread('github:45', 'github', '45', ['ticket-old'], '2026-10-01T00:00:00Z'),
      // 没有订阅的 Thread 不轮询。
      thread('github:46', 'github', '46', [], '2026-11-07T00:00:00Z'),
      // 别的 Source 的 Thread 不归这里。
      thread('feishu:x', 'feishu', 'x', ['ticket-live'], '2026-11-07T00:00:00Z'),
      // 评审线程（`<n>/rt/<id>`）不是 Issue/PR 号，跳过。
      thread('github:42/rt/7', 'github', '42/rt/7', ['ticket-live'], '2026-11-07T00:00:00Z')
    ],
    [
      ticket('ticket-live'),
      ticket('ticket-old', { at: '2026-10-20T00:00:00Z', by: 'executor', outcome: 'completed' })
    ]
  )
  assert.deepEqual(
    subscribed.map((item) => item.issue),
    [42, 45]
  )
  assert.equal(subscribed[0]?.live, true)
  assert.equal(subscribed[0]?.lastAt, '2026-01-01T00:00:00.000Z')
  assert.equal(subscribed[1]?.live, false)
  assert.equal(subscribed[1]?.lastAt, '2026-10-20T00:00:00.000Z', 'the later of the activity and the end')

  const now = Date.parse('2026-11-07T04:00:00Z')
  assert.equal(withinHorizon(subscribed[0]!, now), true)
  assert.equal(withinHorizon(subscribed[1]!, now), false)
  // 正好两周算过期（与上游 `now - at < POLL_HORIZON_MS` 同一比较）。
  assert.equal(withinHorizon({ issue: 1, live: false, lastAt: '2026-10-24T04:00:00Z' }, now), false)
  assert.equal(withinHorizon({ issue: 1, live: false, lastAt: '2026-10-24T04:00:00.001Z' }, now), true)
})

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

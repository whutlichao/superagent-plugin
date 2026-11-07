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
import { createGithubApi, rateLimited } from '../src/worker/sources/github/api'
import type {
  GithubChecks,
  GithubCheckRun,
  GithubComment,
  GithubCommitStatus,
  GithubReview
} from '../src/worker/sources/github/api'
import {
  bodyFingerprint,
  ciState,
  ciTrigger,
  commentTrigger,
  issueBodyTrigger,
  reviewCommentTrigger,
  reviewTrigger
} from '../src/worker/sources/github/translate'
import { createGithubPoller, subscribedThreads, withinHorizon } from '../src/worker/sources/github/poll'
import { githubSetupProblem } from '../src/worker/sources/github/config'
import { createPolicy, validatePolicy } from '../src/worker/policy/index'
import { githubBodyKey, githubCiKey, githubCursorKey } from '../src/worker/app/kv'
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
    url: 'https://github.com/acme/widgets/issues/42#issuecomment-6702566216',
    inReplyTo: null,
    path: '',
    line: null
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
        updatedAt: '2026-11-07T05:07:26Z',
        body: 'On the settings page the login redirect drops the `next` query parameter, so people land on the dashboard instead of the page they asked for.\n\nSteps to reproduce:\n1. Open the settings page while signed out.\n2. Sign in.\n3. The redirect goes to the dashboard.\n\nExpected: it returns to the settings page.',
        login: 'alice',
        bot: false,
        createdAt: '2026-11-07T05:01:09Z'
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
        // CI 读这个 head 提交的检查与状态（#19）。
        headSha: CI_SHA,
        updatedAt: '2026-11-07T03:09:36Z',
        body: 'When the agent account is described in the docs, a reader cannot tell whether the worker signs its commits with a token or a dedicated account.\n\nThis change says the agent CLI is signed in to the agent account and that the commit email is the noreply address. No behaviour changes.',
        login: 'bob',
        bot: false,
        createdAt: '2023-11-04T07:30:25Z'
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
        bot: false,
        body: '',
        submittedAt: '2023-11-06T07:14:48Z',
        commitId: '48ab24d08ec56a03ee76d0ddad470517cdb900bd',
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
  assert.deepEqual(first, { notifications: 0, triggers: 3, skipped: 0 })
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
    ['42', '45', '45']
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
  // #42 的评论失败只记在它的 Thread 上；#45 照常读、照常收（会话评论 + 评审评论）。
  assert.equal(first.triggers, 2)
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
  // PR 的订阅读取还有评审与评审评论两页（评审为空、评审评论译为 Trigger）。
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
  assert.deepEqual(result, { notifications: 1, triggers: 2, skipped: 0 })
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
  assert.deepEqual(h.received[0], expected)
  // 评审评论（夹具里的行内讨论）属于同一个 PR 会话，但额外挂一个评审 Thread 与回复根。
  const inline = h.received[1]!
  assert.equal(inline.id, key('github', 'review-comment', '1382860676', '2023-11-06T07:14:48Z'))
  assert.deepEqual(inline.threads, [
    { source: 'github', id: '45' },
    { source: 'github', id: '45/rt/1382860676' }
  ])
  assert.deepEqual(inline.channel, {
    source: 'github',
    thread: 'github:45',
    address: { repo: 'acme/widgets', issue: '45', root: '1382860676' }
  })
  assert.deepEqual(h.received.map((trigger) => trigger.meta['kind']), ['comment', 'review-comment'])
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
  assert.deepEqual(result, { notifications: 1, triggers: 2, skipped: 2 })
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
      // 一个 `gh` 调用都没有：setup 没完成之前连账号探针都不跑（git 探针与本例无关）。
      assert.deepEqual(
        h.commands.calls.filter((call) => call.program === 'gh'),
        [],
        'no gh call happens before setup completes'
      )
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

// ---- #18：评审、评审评论与 Issue/PR 正文的翻译（§I.2「Trigger 翻译」行） ----

/** 一条评审（`/pulls/:n/reviews` 的一项），字段与端口同形。 */
function review(overrides: Partial<GithubReview> = {}): GithubReview {
  return {
    id: 7001,
    state: 'CHANGES_REQUESTED',
    login: 'carol',
    bot: false,
    body: '@acme-agent please keep the `next` parameter.',
    submittedAt: '2026-11-07T06:00:00Z',
    commitId: 'abc123',
    url: 'https://github.com/acme/widgets/pull/45#pullrequestreview-7001',
    ...overrides
  }
}

/** 一条评审评论（`/pulls/:n/comments` 的一项），字段与端口同形。 */
function reviewComment(overrides: Partial<GithubComment> = {}): GithubComment {
  return {
    id: 8001,
    login: 'carol',
    bot: false,
    body: 'Consider keeping `next` here.',
    createdAt: '2026-11-07T06:01:00Z',
    updatedAt: '2026-11-07T06:01:00Z',
    url: 'https://github.com/acme/widgets/pull/45#discussion_r8001',
    inReplyTo: 7000,
    path: 'src/app/login.go',
    line: 54,
    ...overrides
  }
}

/** 端口形状 → GitHub JSON 形状（轮询测试造 CLI 输出用）。 */
function reviewJson(overrides: Partial<GithubReview> = {}): Record<string, unknown> {
  const value = review(overrides)
  return {
    id: value.id,
    user: { login: value.login, type: value.bot ? 'Bot' : 'User' },
    body: value.body,
    state: value.state,
    submitted_at: value.submittedAt,
    commit_id: value.commitId,
    html_url: value.url
  }
}

/** 端口形状 → GitHub JSON 形状（轮询测试造 CLI 输出用）。 */
function reviewCommentJson(overrides: Partial<GithubComment> = {}): Record<string, unknown> {
  const value = reviewComment(overrides)
  return {
    id: value.id,
    user: { login: value.login, type: value.bot ? 'Bot' : 'User' },
    body: value.body,
    created_at: value.createdAt,
    updated_at: value.updatedAt,
    html_url: value.url,
    in_reply_to_id: value.inReplyTo,
    path: value.path,
    line: value.line
  }
}

test('a submitted review becomes one Trigger with its actor, state and mention', () => {
  const trigger = reviewTrigger({
    repository: 'acme/widgets',
    pull: 45,
    review: review(),
    login: 'acme-agent'
  })
  assert.deepEqual(trigger, {
    id: key('github', 'review', '7001', '2026-11-07T06:00:00Z'),
    source: 'github',
    threads: [{ source: 'github', id: '45' }],
    actor: { source: 'github', id: 'carol' },
    human: true,
    addressed: 'mention',
    at: '2026-11-07T06:00:00Z',
    text: 'CHANGES_REQUESTED review of commit abc123\n\n@acme-agent please keep the `next` parameter.',
    url: 'https://github.com/acme/widgets/pull/45#pullrequestreview-7001',
    channel: {
      source: 'github',
      thread: 'github:45',
      address: { repo: 'acme/widgets', issue: '45' }
    },
    meta: {
      kind: 'review',
      repository: 'acme/widgets',
      issue: 45,
      reviewId: 7001,
      state: 'CHANGES_REQUESTED',
      commitId: 'abc123',
      updatedAt: '2026-11-07T06:00:00Z'
    }
  })
  // 一个只有状态的评审决定仍然可读；空的 COMMENTED 评审没有内容。
  const approved = reviewTrigger({
    repository: 'acme/widgets',
    pull: 45,
    review: review({ state: 'APPROVED', body: '' }),
    login: 'acme-agent'
  })
  assert.equal(approved.text, 'APPROVED review of commit abc123')
  assert.equal(approved.addressed, undefined)
  const commented = reviewTrigger({
    repository: 'acme/widgets',
    pull: 45,
    review: review({ state: 'COMMENTED', body: '' }),
    login: 'acme-agent'
  })
  assert.equal(commented.text, '')
  // [bot] 不是人，即使 GitHub 没把 type 写成 Bot。
  assert.equal(
    reviewTrigger({ repository: 'acme/widgets', pull: 45, review: review({ login: 'ci-bot[bot]' }), login: 'acme-agent' })
      .human,
    false
  )
})

test('a review comment carries its root id, the review thread and the reply address', () => {
  const trigger = reviewCommentTrigger({
    repository: 'acme/widgets',
    pull: 45,
    comment: reviewComment(),
    login: 'acme-agent'
  })
  assert.deepEqual(trigger.threads, [
    { source: 'github', id: '45' },
    { source: 'github', id: '45/rt/7000' }
  ])
  assert.deepEqual(trigger.channel, {
    source: 'github',
    thread: 'github:45',
    address: { repo: 'acme/widgets', issue: '45', root: '7000' }
  })
  assert.equal(trigger.id, key('github', 'review-comment', '8001', '2026-11-07T06:01:00Z'))
  assert.deepEqual(trigger.meta, {
    kind: 'review-comment',
    repository: 'acme/widgets',
    issue: 45,
    commentId: 8001,
    rootCommentId: 7000,
    reviewThread: '45/rt/7000',
    path: 'src/app/login.go',
    line: 54,
    updatedAt: '2026-11-07T06:01:00Z'
  })
  assert.equal(trigger.addressed, undefined, 'the body does not mention the agent')
  // 根评论自己没有 in_reply_to_id：它自己就是根。
  const root = reviewCommentTrigger({
    repository: 'acme/widgets',
    pull: 45,
    comment: reviewComment({ inReplyTo: null }),
    login: 'acme-agent'
  })
  assert.deepEqual(root.threads[1], { source: 'github', id: '45/rt/8001' })
  assert.equal(root.channel?.address['root'], '8001')
  assert.equal(root.addressed, undefined)
  // 正文点名 agent 时仍是 mention；改写不会改变 root。
  const mention = reviewCommentTrigger({
    repository: 'acme/widgets',
    pull: 45,
    comment: reviewComment({ body: '@acme-agent this is the same finding.' }),
    login: 'acme-agent'
  })
  assert.equal(mention.addressed, 'mention')
})

test('an issue body version keys on updated_at: an edit is a new Trigger, the same version repeats', () => {
  const base = {
    repository: 'acme/widgets',
    number: 42,
    isPull: false,
    login: 'acme-agent',
    source: {
      title: 'Fix the login redirect',
      body: 'On the settings page the login redirect drops the `next` query parameter.',
      login: 'alice',
      bot: false,
      createdAt: '2026-11-07T05:01:09Z',
      updatedAt: '2026-11-07T05:07:26Z',
      url: 'https://github.com/acme/widgets/issues/42'
    }
  } as const
  const first = issueBodyTrigger(base)
  assert.deepEqual(first, {
    id: key('github', 'issue', '42', '2026-11-07T05:07:26Z'),
    source: 'github',
    threads: [{ source: 'github', id: '42' }],
    actor: { source: 'github', id: 'alice' },
    human: true,
    at: '2026-11-07T05:07:26Z',
    text:
      'Fix the login redirect\n\nOn the settings page the login redirect drops the `next` query parameter.',
    url: 'https://github.com/acme/widgets/issues/42',
    channel: {
      source: 'github',
      thread: 'github:42',
      address: { repo: 'acme/widgets', issue: '42' }
    },
    meta: {
      kind: 'issue',
      repository: 'acme/widgets',
      issue: 42,
      updatedAt: '2026-11-07T05:07:26Z'
    }
  })
  assert.equal(first.id, issueBodyTrigger(base).id, 'the same version repeats')
  // 编辑：updated_at 变了就是新事件、新 id。id 里没有正文本身。
  const edited = issueBodyTrigger({
    ...base,
    source: { ...base.source, body: `${base.source.body}\n\nEdit: keep the anchor too.`, updatedAt: '2026-11-07T06:30:00Z' }
  })
  assert.notEqual(edited.id, first.id)
  // 正文 @ 了 agent 才是 mention；actor 用 Issue/PR 的作者，bot 永远不是人。
  const mentioned = issueBodyTrigger({
    ...base,
    source: { ...base.source, body: '@acme-agent please fix this.', updatedAt: '2026-11-07T06:40:00Z' }
  })
  assert.equal(mentioned.addressed, 'mention')
  assert.equal(
    issueBodyTrigger({ ...base, source: { ...base.source, login: 'ci-bot[bot]', bot: true } }).human,
    false
  )
  // PR 正文走同一个 translator，meta.kind 记 'pull'，scope 才会落到 pulls 行。
  assert.equal(issueBodyTrigger({ ...base, isPull: true }).meta['kind'], 'pull')
  // 指纹只认正文：同一正文同一指纹，改了正文才变。
  assert.equal(bodyFingerprint('same'), bodyFingerprint('same'))
  assert.notEqual(bodyFingerprint('same'), bodyFingerprint('changed'))
})

test('a subscribed PR translates its reviews and review comments, dropping the agent and marking bots', async () => {
  const commands = new FakeCommands()
  commands.script('gh api notifications', () => JSON.stringify([]))
  commands.script(['api', 'repos/acme/widgets/issues/45'], () => fixture('pull-as-issue.json'))
  commands.script(['api', 'repos/acme/widgets/pulls/45'], () => fixture('pull.json'))
  commands.script(['api', 'repos/acme/widgets/issues/45/comments', '--paginate'], () => JSON.stringify([]))
  commands.script(['api', 'repos/acme/widgets/pulls/45/reviews', '--paginate'], () =>
    JSON.stringify([
      reviewJson({ id: 1, state: 'APPROVED', body: '@acme-agent approve?' }),
      reviewJson({ id: 2, state: 'COMMENTED', login: 'acme-agent', body: 'my own review' }),
      reviewJson({ id: 3, state: 'COMMENTED', body: '' }),
      reviewJson({ id: 4, state: 'COMMENTED', login: 'ci-bot[bot]', bot: true, body: 'automated finding' })
    ])
  )
  commands.script(['api', 'repos/acme/widgets/pulls/45/comments', '--paginate'], () =>
    JSON.stringify([
      reviewCommentJson({ id: 10, inReplyTo: 9000, body: 'keep `next`' }),
      reviewCommentJson({ id: 11, login: 'acme-agent', body: 'self reply' }),
      reviewCommentJson({ id: 12, login: 'ci-bot[bot]', bot: true, body: 'bot finding' })
    ])
  )
  const h = host()
  const result = await createGithubPoller({
    api: api(commands),
    config: config(),
    login: 'acme-agent',
    host: h.port,
    cursorKey: githubCursorKey,
    subscribed: () => [{ issue: 45, live: true, lastAt: '2026-11-07T03:00:00Z' }],
    now: () => Date.parse('2026-11-07T04:00:00Z')
  }).poll()
  assert.deepEqual(result, { notifications: 0, triggers: 4, skipped: 0 })
  assert.deepEqual(
    h.received.map((trigger) => [
      trigger.meta['kind'],
      trigger.actor.id,
      trigger.human,
      trigger.addressed ?? null
    ]),
    [
      ['review', 'carol', true, 'mention'],
      ['review', 'ci-bot[bot]', false, null],
      ['review-comment', 'carol', true, null],
      ['review-comment', 'ci-bot[bot]', false, null]
    ]
  )
  // 评审评论带上根评论与相关 Thread；评审本身只属于 PR 会话。
  const inline = h.received[2]!
  assert.deepEqual(inline.threads, [
    { source: 'github', id: '45' },
    { source: 'github', id: '45/rt/9000' }
  ])
  assert.equal(inline.channel?.address['root'], '9000')
  assert.deepEqual(h.received[0]!.threads, [{ source: 'github', id: '45' }])
  // 自身消息两条（评审与回复）都没有变成 Trigger。
  assert.equal(h.received.some((trigger) => trigger.actor.id === 'acme-agent'), false)
})

test('an issue body edit becomes a Trigger only after the baseline; comment activity alone does not', async () => {
  const commands = new FakeCommands()
  commands.script('gh api notifications', () => JSON.stringify([]))
  const v1 = JSON.parse(fixture('issue.json')) as Record<string, unknown>
  const sameBodyNewVersion = { ...v1, updated_at: '2026-11-07T06:00:00Z' }
  const edited: Record<string, unknown> = {
    ...v1,
    body: `${String(v1.body)}\n\nEdit: also keep the anchor.`,
    updated_at: '2026-11-07T06:30:00Z'
  }
  // 四轮各读一次 Issue：基线、同正文新 updated_at、正文编辑、同一编辑再读。
  for (const issue of [v1, sameBodyNewVersion, edited, edited]) {
    commands.next('gh', ['api', 'repos/acme/widgets/issues/42'], JSON.stringify(issue))
  }
  commands.script(['api', 'repos/acme/widgets/issues/42/comments', '--paginate'], () => JSON.stringify([]))
  const h = host()
  const poller = createGithubPoller({
    api: api(commands),
    config: config(),
    login: 'acme-agent',
    host: h.port,
    cursorKey: githubCursorKey,
    bodyKey: githubBodyKey,
    subscribed: () => [{ issue: 42, live: true, lastAt: '2026-11-07T03:00:00Z' }],
    now: () => Date.parse('2026-11-07T04:00:00Z')
  })
  assert.equal((await poller.poll()).triggers, 0, 'the first read only sets the baseline')
  assert.equal(h.state.get(githubBodyKey(42)), bodyFingerprint(String(v1.body)))
  assert.equal((await poller.poll()).triggers, 0, 'a new updated_at with the same body is comment activity, not an edit')
  assert.equal((await poller.poll()).triggers, 1)
  assert.equal(h.received[0]?.id, key('github', 'issue', '42', '2026-11-07T06:30:00Z'))
  assert.equal(h.received[0]?.text, `${String(edited.title)}\n\n${String(edited.body)}`)
  assert.equal(h.state.get(githubBodyKey(42)), bodyFingerprint(String(edited.body)))
  assert.equal((await poller.poll()).triggers, 0, 'the same version repeats as duplicate')
})

test('a PR body edit uses the same translator and fingerprint key, with meta kind pull', async () => {
  const commands = new FakeCommands()
  commands.script('gh api notifications', () => JSON.stringify([]))
  commands.script(['api', 'repos/acme/widgets/issues/45'], () => fixture('pull-as-issue.json'))
  const v1 = JSON.parse(fixture('pull.json')) as Record<string, unknown>
  const v2 = { ...v1, body: `${String(v1.body)}\n\nEdit: name the account too.`, updated_at: '2026-11-07T07:00:00Z' }
  commands.next('gh', ['api', 'repos/acme/widgets/pulls/45'], JSON.stringify(v1))
  commands.next('gh', ['api', 'repos/acme/widgets/pulls/45'], JSON.stringify(v2))
  commands.script(['api', 'repos/acme/widgets/issues/45/comments', '--paginate'], () => JSON.stringify([]))
  commands.script(['api', 'repos/acme/widgets/pulls/45/reviews', '--paginate'], () => JSON.stringify([]))
  commands.script(['api', 'repos/acme/widgets/pulls/45/comments', '--paginate'], () => JSON.stringify([]))
  const h = host()
  const poller = createGithubPoller({
    api: api(commands),
    config: config(),
    login: 'acme-agent',
    host: h.port,
    cursorKey: githubCursorKey,
    bodyKey: githubBodyKey,
    subscribed: () => [{ issue: 45, live: true, lastAt: '2026-11-07T03:00:00Z' }],
    now: () => Date.parse('2026-11-07T04:00:00Z')
  })
  assert.equal((await poller.poll()).triggers, 0)
  assert.equal(h.state.get(githubBodyKey(45)), bodyFingerprint(String(v1.body)))
  assert.equal((await poller.poll()).triggers, 1)
  assert.equal(h.received[0]?.meta['kind'], 'pull')
  assert.equal(h.received[0]?.id, key('github', 'issue', '45', '2026-11-07T07:00:00Z'))
})

// ---- #18：评审线程回复、回退与 Channel 幂等（§I.2 Channel 行） ----

/** 一个把 `FakeCommands` 当 `CommandsHost` 用的最小视图。 */
function channelHost(commands: FakeCommands) {
  return {
    run: (program: string, args: readonly string[], options?: Parameters<FakeCommands['run']>[2]) =>
      commands.run(program, args, options ?? {}),
    stream: (program: string, args: readonly string[], options: Parameters<FakeCommands['stream']>[2]) =>
      commands.stream(program, args, options),
    withSignal: () => commands
  }
}

/** 一条发往评审线程的消息。 */
function reviewReply(id = 'reply-9', root = '7000') {
  return {
    id,
    channel: {
      source: 'github',
      thread: 'github:45',
      address: { repo: 'acme/widgets', issue: '45', root }
    },
    text: 'Fixed in abc123.',
    kind: 'reply' as const
  }
}

test('a review-thread reply confirms the root and posts to the replies endpoint', async () => {
  const commands = new FakeCommands()
  commands.script(['api', 'repos/acme/widgets/pulls/comments/7000'], () => JSON.stringify({ id: 7000 }))
  commands.script(['api', 'repos/acme/widgets/pulls/45/comments?per_page=100', '-q'], () => '')
  commands.script(['api', 'repos/acme/widgets/pulls/45/comments/7000/replies', '-f'], () => '{}')
  const result = await githubKind.channel?.send(channelHost(commands), reviewReply())
  assert.equal(result, 'sent')
  assert.deepEqual(
    commands.calls.map((call) => call.args),
    [
      ['api', 'repos/acme/widgets/pulls/comments/7000'],
      ['api', 'repos/acme/widgets/pulls/45/comments?per_page=100', '-q', '.[].body'],
      [
        'api',
        'repos/acme/widgets/pulls/45/comments/7000/replies',
        '-f',
        'body=Fixed in abc123.\n\n<!-- superagent:reply-9 -->'
      ]
    ]
  )
  // 绝不把评审线程的回复写成 PR 会话评论，也不替 worker 调 resolve。
  assert.equal(
    commands.calls.some((call) => call.args.includes('graphql') || call.args.includes('resolveReviewThread')),
    false
  )
})

test('a missing root comment falls back to the PR conversation', async () => {
  const commands = new FakeCommands()
  commands.fail(
    'gh',
    ['api', 'repos/acme/widgets/pulls/comments/7000'],
    new CliError('gh exited with code 1: HTTP 404', 404, 1)
  )
  commands.script(['api', 'repos/acme/widgets/issues/45/comments?per_page=100', '-q'], () => '')
  commands.script(['api', 'repos/acme/widgets/issues/45/comments', '-f'], () => '{}')
  const result = await githubKind.channel?.send(channelHost(commands), reviewReply())
  assert.equal(result, 'sent')
  assert.deepEqual(
    commands.calls.map((call) => call.args),
    [
      ['api', 'repos/acme/widgets/pulls/comments/7000'],
      ['api', 'repos/acme/widgets/issues/45/comments?per_page=100', '-q', '.[].body'],
      ['api', 'repos/acme/widgets/issues/45/comments', '-f', 'body=Fixed in abc123.\n\n<!-- superagent:reply-9 -->']
    ]
  )
})

test('two sends of the same review reply produce one comment', async () => {
  const commands = new FakeCommands()
  commands.script(['api', 'repos/acme/widgets/pulls/comments/7000'], () => JSON.stringify({ id: 7000 }))
  let markerPresent = false
  commands.script(['api', 'repos/acme/widgets/pulls/45/comments?per_page=100', '-q'], () =>
    markerPresent ? 'Fixed in abc123.\n\n<!-- superagent:reply-9 -->' : ''
  )
  commands.script(['api', 'repos/acme/widgets/pulls/45/comments/7000/replies', '-f'], () => {
    markerPresent = true
    return '{}'
  })
  const host = channelHost(commands)
  assert.equal(await githubKind.channel?.send(host, reviewReply()), 'sent')
  assert.equal(await githubKind.channel?.send(host, reviewReply()), 'sent')
  const posts = commands.calls.filter((call) => call.args.includes('-f'))
  assert.equal(posts.length, 1, 'the marker stops the second write')
  assert.equal(markerPresent, true)
})

test('a locked, deleted or forbidden target is gone; a rate limit is retried', async () => {
  async function attempt(error: CliError): Promise<'sent' | 'gone'> {
    const commands = new FakeCommands()
    commands.script(['api', 'repos/acme/widgets/issues/42/comments?per_page=100', '-q'], () => '')
    commands.fail('gh', ['api', 'repos/acme/widgets/issues/42/comments', '-f'], error)
    return (await githubKind.channel?.send(channelHost(commands), {
      id: 'reply-1',
      channel: { source: 'github', thread: 'github:42', address: { repo: 'acme/widgets', issue: '42' } },
      text: 'Done.',
      kind: 'reply'
    })) as 'sent' | 'gone'
  }
  assert.equal(await attempt(new CliError('gh exited with code 1: issue is locked (HTTP 403)', 403, 1)), 'gone')
  assert.equal(
    await attempt(new CliError('gh exited with code 1: Resource not accessible by integration (HTTP 403)', 403, 1)),
    'gone'
  )
  assert.equal(await attempt(new CliError('gh exited with code 1: HTTP 404', 404, 1)), 'gone')
  assert.equal(await attempt(new CliError('gh exited with code 1: HTTP 410', 410, 1)), 'gone')
  await assert.rejects(
    attempt(new CliError('gh exited with code 1: API rate limit exceeded (HTTP 403)', 403, 1)),
    /rate limit/
  )
  await assert.rejects(attempt(new CliError('gh exited with code 1: HTTP 500', 500, 1)), /gh exited/)
})

test('the channel accepts a review-thread address only when its root is a number', () => {
  assert.equal(githubKind.channel?.allowed?.({ repo: 'acme/widgets', issue: '45', root: '7000' }, config()), true)
  assert.equal(githubKind.channel?.allowed?.({ repo: 'acme/widgets', issue: '45' }, config()), true)
  assert.equal(githubKind.channel?.allowed?.({ repo: 'acme/widgets', issue: '45', root: 'x' }, config()), false)
  assert.equal(githubKind.channel?.allowed?.({ repo: '', issue: '45' }, config()), false)
  assert.equal(githubKind.channel?.allowed?.({ repo: 'acme/widgets', issue: 'four' }, config()), false)
  // 评审线程的链接指向讨论锚点（面板与 outbox 读它）。
  const link = githubKind.channel?.link?.(
    {
      repo: 'acme/widgets',
      issue: '45',
      root: '7000'
    },
    {}
  )
  assert.equal(link?.url, 'https://github.com/acme/widgets/pull/45#discussion_r7000')
})

test('an issue body the agent itself wrote is dropped like any other self message', async () => {
  const commands = new FakeCommands()
  commands.script('gh api notifications', () => JSON.stringify([]))
  const original = JSON.parse(fixture('issue.json')) as Record<string, unknown>
  const mine: Record<string, unknown> = {
    ...original,
    user: { login: 'acme-agent', type: 'User' },
    body: 'The agent edited its own description.',
    updated_at: '2026-11-07T07:30:00Z'
  }
  commands.next('gh', ['api', 'repos/acme/widgets/issues/42'], JSON.stringify(original))
  commands.next('gh', ['api', 'repos/acme/widgets/issues/42'], JSON.stringify(mine))
  commands.script(['api', 'repos/acme/widgets/issues/42/comments', '--paginate'], () => JSON.stringify([]))
  const h = host()
  const poller = createGithubPoller({
    api: api(commands),
    config: config(),
    login: 'acme-agent',
    host: h.port,
    cursorKey: githubCursorKey,
    bodyKey: githubBodyKey,
    subscribed: () => [{ issue: 42, live: true, lastAt: '2026-11-07T03:00:00Z' }],
    now: () => Date.parse('2026-11-07T04:00:00Z')
  })
  assert.equal((await poller.poll()).triggers, 0, 'the baseline')
  assert.equal((await poller.poll()).triggers, 0, 'the agent edited its own body')
  assert.deepEqual(h.received, [])
  // 即便如此，指纹仍然前进：下一次真正的人编辑才是新事件。
  assert.equal(h.state.get(githubBodyKey(42)), bodyFingerprint(String(mine.body)))
})

test('editing a comment, review or review comment is a new Trigger; the same version repeats', () => {
  const comment = {
    id: 1,
    login: 'alice',
    bot: false,
    body: 'first version',
    createdAt: '2026-11-07T05:00:00Z',
    updatedAt: '2026-11-07T05:00:00Z',
    url: '',
    inReplyTo: null,
    path: '',
    line: null
  }
  const issueComment = (updatedAt: string) =>
    commentTrigger({
      repository: 'acme/widgets',
      issue: 42,
      comment: { ...comment, updatedAt },
      login: 'acme-agent',
      observeComments: false
    })
  assert.equal(issueComment('2026-11-07T05:00:00Z').id, issueComment('2026-11-07T05:00:00Z').id)
  assert.notEqual(issueComment('2026-11-07T05:00:00Z').id, issueComment('2026-11-07T05:10:00Z').id)

  const reviewAt = (submittedAt: string) =>
    reviewTrigger({
      repository: 'acme/widgets',
      pull: 45,
      review: review({ submittedAt }),
      login: 'acme-agent'
    })
  assert.equal(reviewAt('2026-11-07T06:00:00Z').id, reviewAt('2026-11-07T06:00:00Z').id)
  assert.notEqual(reviewAt('2026-11-07T06:00:00Z').id, reviewAt('2026-11-07T06:10:00Z').id)

  const inlineAt = (updatedAt: string) =>
    reviewCommentTrigger({
      repository: 'acme/widgets',
      pull: 45,
      comment: { ...reviewComment(), updatedAt },
      login: 'acme-agent'
    })
  assert.equal(inlineAt('2026-11-07T06:01:00Z').id, inlineAt('2026-11-07T06:01:00Z').id)
  assert.notEqual(inlineAt('2026-11-07T06:01:00Z').id, inlineAt('2026-11-07T06:11:00Z').id)
})

// ---- #19：CI 检查结果作为 Trigger（§I.2 CI 行、§K.2 第 6 条） ----

/** 夹具 PR 的 head 提交（`pull.json` 的 `head.sha`）。 */
const CI_SHA = '724125307bfe91a1cceb2a0406a8020fed6f6def'

/** 一条检查运行（`/commits/<sha>/check-runs` 的一项），端口形状。 */
function checkRun(overrides: Partial<GithubCheckRun> = {}): GithubCheckRun {
  return { name: 'build', status: 'completed', conclusion: 'success', ...overrides }
}

/** 一条提交状态（`/commits/<sha>/statuses` 的一项），端口形状。 */
function commitStatus(overrides: Partial<GithubCommitStatus> = {}): GithubCommitStatus {
  return { context: 'ci/legacy', state: 'success', ...overrides }
}

/** 一个提交的 CI 读数（端口形状）。 */
function checks(overrides: Partial<GithubChecks> = {}): GithubChecks {
  return { headSha: CI_SHA, checks: [checkRun()], statuses: [], ...overrides }
}

test('a CI result classifies as failure, running or success', () => {
  assert.equal(ciState(checks({ checks: [checkRun({ status: 'in_progress', conclusion: null })] })), 'running')
  assert.equal(ciState(checks({ checks: [checkRun({ conclusion: 'failure' })] })), 'failure')
  assert.equal(ciState(checks({ statuses: [commitStatus({ state: 'pending' })] })), 'running')
  assert.equal(ciState(checks({ statuses: [commitStatus({ state: 'error' })] })), 'failure')
  assert.equal(ciState(checks()), 'success')
  // 失败优先于进行中：等待恢复时先报失败（上游同）。
  assert.equal(
    ciState(
      checks({
        checks: [
          checkRun({ conclusion: 'failure' }),
          checkRun({ name: 'lint', status: 'in_progress', conclusion: null })
        ]
      })
    ),
    'failure'
  )
})

test('a CI result becomes a Trigger with no sender, its PR thread and the CI summary', () => {
  const snapshot = checks({
    checks: [checkRun({ conclusion: 'failure' }), checkRun({ name: 'lint' })]
  })
  const trigger = ciTrigger({
    repository: 'acme/widgets',
    pull: 45,
    checks: snapshot,
    at: '2026-11-07T04:00:00.000Z',
    url: 'https://github.com/acme/widgets/pull/45'
  })
  // 没有发送者：actor 是 Source 自己、id 为空；永不寻址、永不「人写的」。
  assert.deepEqual(trigger.actor, { source: 'github', id: '' })
  assert.equal(trigger.human, false)
  assert.equal(trigger.addressed, undefined)
  assert.deepEqual(trigger.threads, [{ source: 'github', id: '45' }])
  assert.equal(trigger.at, '2026-11-07T04:00:00.000Z')
  assert.equal(
    trigger.text,
    'CI failed 1/2 on PR #45 at 7241253: build\nRead github/pulls/45/checks for every check.'
  )
  assert.equal(trigger.url, 'https://github.com/acme/widgets/pull/45')
  assert.deepEqual(trigger.channel, {
    source: 'github',
    thread: 'github:45',
    address: { repo: 'acme/widgets', issue: '45' }
  })
  assert.deepEqual(trigger.meta, {
    kind: 'ci',
    repository: 'acme/widgets',
    issue: 45,
    headSha: CI_SHA,
    state: 'failure'
  })
  // 同一结果同一个 id；结果变了才是新事件（§I.2 CI 行：只在变化时出 Trigger）。
  const again = ciTrigger({
    repository: 'acme/widgets',
    pull: 45,
    checks: snapshot,
    at: '2026-11-07T05:00:00.000Z'
  })
  assert.equal(again.id, trigger.id)
  const changed = ciTrigger({
    repository: 'acme/widgets',
    pull: 45,
    checks: checks({
      checks: [checkRun({ conclusion: 'failure' }), checkRun({ name: 'lint', conclusion: 'failure' })]
    }),
    at: '2026-11-07T05:00:00.000Z'
  })
  assert.notEqual(changed.id, trigger.id)
})

test('CI has no sender, so only the last admission cell can admit it', () => {
  const trigger = ciTrigger({
    repository: 'acme/widgets',
    pull: 45,
    checks: checks(),
    at: '2026-11-07T04:00:00.000Z'
  })
  // Source 的监听范围：CI 行只有开了 observeCi 才可用（§I.2 准入行）。
  assert.deepEqual(githubKind.scope?.(trigger, config({ observeCi: true })), {
    listened: true,
    observed: true,
    row: 'ci'
  })
  assert.deepEqual(githubKind.scope?.(trigger, config()), { listened: false, reason: 'ci_not_observed' })
  // 准入表：CI 行只有最后一格可用，两个「寻址」格永远是 false（不会要求寻址判定）。
  const rows = githubKind.policy?.rows?.({ ...config({ observeCi: true }) }) ?? []
  const row = rows.find((entry) => entry.id === 'ci')
  assert.deepEqual(row?.cells, {
    listedUnaddressed: false,
    unlistedAddressed: false,
    unlistedUnaddressed: true
  })
  // 真实 Gate：trigger 没有 addressed，仍然只按 `ci` 行的最后一格准入（§K.2 第 6 条）。
  const parsed = validatePolicy(
    {
      acceptMode: 'auto',
      sources: {
        github: { allowed: [], bots: [], admission: { ci: { unlistedUnaddressed: 'inferred' } } }
      }
    },
    { kinds: (source) => (source === 'github' ? { rows: () => rows } : undefined) }
  )
  assert.equal(parsed.success, true, JSON.stringify(parsed))
  if (!parsed.success) throw new Error('unreachable')
  const policy = createPolicy({
    block: () => parsed.data,
    sources: {
      scope: (value) =>
        githubKind.scope?.(value, config({ observeCi: true })) ?? {
          listened: false,
          reason: 'unknown'
        }
    },
    rows: (source) => (source === 'github' ? rows : [])
  })
  const thread: Thread = {
    key: 'github:45',
    ref: { source: 'github', id: '45' },
    createdAt: '2026-11-07T03:00:00Z',
    subscriptions: [],
    correlated: [],
    pending: [],
    meta: {}
  }
  assert.deepEqual(policy.gate(trigger, thread, []), {
    admissible: true,
    strength: 'inferred',
    basis: {
      source: 'github',
      scope: trigger.meta,
      row: 'ci',
      via: 'admission',
      cell: 'unlistedUnaddressed',
      observation: { mode: 'auto' }
    }
  })
})

test('the check-runs and statuses reads use the documented endpoints and keep one status per context', async () => {
  const commands = new FakeCommands()
  commands.script(['api', `repos/acme/widgets/commits/${CI_SHA}/check-runs`, '--paginate'], () =>
    JSON.stringify([
      {
        total_count: 3,
        check_runs: [
          // 真实响应还有 id / details_url / app …，端口只取结果面。
          { id: 1, name: 'lint', status: 'completed', conclusion: 'success', details_url: 'https://x/1' },
          { id: 2, name: 'build', status: 'in_progress', conclusion: null }
        ]
      },
      { total_count: 3, check_runs: [{ id: 3, name: 'docs', status: 'completed', conclusion: 'neutral' }] }
    ])
  )
  commands.script(['api', `repos/acme/widgets/commits/${CI_SHA}/statuses`, '--paginate'], () =>
    JSON.stringify([
      // 同一个 context 有多条时 GitHub 新的在前：只有第一条（最新）算数。
      { context: 'ci/legacy', state: 'pending', updated_at: '2026-11-07T03:10:00Z' },
      { context: 'ci/legacy', state: 'success', updated_at: '2026-11-07T03:00:00Z' },
      { context: 'ci/other', state: 'failure', updated_at: '2026-11-07T03:05:00Z' }
    ])
  )
  const read = await api(commands).checks('acme/widgets', CI_SHA)
  assert.deepEqual(read, {
    items: [
      {
        headSha: CI_SHA,
        checks: [
          { name: 'build', status: 'in_progress', conclusion: null },
          { name: 'docs', status: 'completed', conclusion: 'neutral' },
          { name: 'lint', status: 'completed', conclusion: 'success' }
        ],
        statuses: [
          { context: 'ci/legacy', state: 'pending' },
          { context: 'ci/other', state: 'failure' }
        ]
      }
    ],
    skipped: 0
  })
  assert.deepEqual(
    commands.calls.map((call) => call.args),
    [
      [
        'api',
        `repos/acme/widgets/commits/${CI_SHA}/check-runs`,
        '--paginate',
        '--slurp',
        '--method',
        'GET',
        '-f',
        'per_page=100'
      ],
      [
        'api',
        `repos/acme/widgets/commits/${CI_SHA}/statuses`,
        '--paginate',
        '--method',
        'GET',
        '-f',
        'per_page=100'
      ]
    ]
  )
})

test('a malformed check-run page, check run or status is skipped with a counter', async () => {
  const commands = new FakeCommands()
  commands.script(['api', `repos/acme/widgets/commits/${CI_SHA}/check-runs`, '--paginate'], () =>
    JSON.stringify([
      // 一整页没有 check_runs（契约坏了一页）：只计数，其余页照读。
      { total_count: 0 },
      {
        total_count: 3,
        check_runs: [
          { id: 1 },
          { id: 2, name: 'build', status: 'completed', conclusion: 'success' },
          { id: 3, name: 'lint' }
        ]
      }
    ])
  )
  commands.script(['api', `repos/acme/widgets/commits/${CI_SHA}/statuses`, '--paginate'], () =>
    JSON.stringify([
      { state: 'success' },
      { context: 'ci/legacy', state: 'success' },
      { context: 'ci/other' },
      7
    ])
  )
  const read = await api(commands).checks('acme/widgets', CI_SHA)
  assert.equal(read.skipped, 6)
  assert.deepEqual(read.items[0]?.checks, [{ name: 'build', status: 'completed', conclusion: 'success' }])
  assert.deepEqual(read.items[0]?.statuses, [{ context: 'ci/legacy', state: 'success' }])
})

/** check-runs 的分页响应（真实响应是对象 `{total_count, check_runs}`；`--slurp` 把分页包成数组）。 */
function checkRunsJson(raw: readonly Record<string, unknown>[]): string {
  return JSON.stringify([{ total_count: raw.length, check_runs: raw }])
}

/** 端口形状 → check-runs 的一项（真实响应还有 id / details_url 等，端口只取结果面）。 */
function checkRunJson(check: GithubCheckRun): Record<string, unknown> {
  return { id: 1, name: check.name, status: check.status, conclusion: check.conclusion }
}

/** 端口形状 → statuses 数组。 */
function statusesJson(statuses: readonly GithubCommitStatus[]): string {
  return JSON.stringify(statuses.map((status) => ({ context: status.context, state: status.state })))
}

/** 一份仍开着的 PR（夹具是已合并的真实 PR；CI 只轮询还开着的 PR，§I.5）。 */
function openPull(): string {
  const pull = JSON.parse(fixture('pull.json')) as Record<string, unknown>
  return JSON.stringify({ ...pull, state: 'open', merged: false })
}

/** 一份订阅着的 PR 45 的所有读面；任何没脚本化的调用都会让测试失败。 */
function scriptPull45(commands: FakeCommands, pull = openPull()): FakeCommands {
  return commands
    .script('gh api notifications', () => JSON.stringify([]))
    .script(['api', 'repos/acme/widgets/issues/45'], () => fixture('pull-as-issue.json'))
    .script(['api', 'repos/acme/widgets/pulls/45'], () => pull)
    .script(['api', 'repos/acme/widgets/issues/45/comments', '--paginate'], () => JSON.stringify([]))
    .script(['api', 'repos/acme/widgets/pulls/45/reviews', '--paginate'], () => JSON.stringify([]))
    .script(['api', 'repos/acme/widgets/pulls/45/comments', '--paginate'], () => JSON.stringify([]))
}

/** 轮询订阅着的 PR 45（CI 开关打开），四轮用 `now` 固定在一个时刻。 */
function pull45Poller(commands: FakeCommands, h: ReturnType<typeof host>, overrides: Record<string, unknown> = {}) {
  return createGithubPoller({
    api: api(commands),
    config: config({ observeCi: true }),
    login: 'acme-agent',
    host: h.port,
    cursorKey: githubCursorKey,
    ciKey: githubCiKey,
    subscribed: () => [{ issue: 45, live: true, lastAt: '2026-11-07T03:00:00Z' }],
    now: () => Date.parse('2026-11-07T04:00:00Z'),
    ...overrides
  })
}

test('a CI change on a subscribed PR becomes one Trigger; the same result stays quiet', async () => {
  const commands = scriptPull45(new FakeCommands())
  const running = [checkRunJson(checkRun({ status: 'in_progress', conclusion: null }))]
  const passed = [checkRunJson(checkRun())]
  // 四轮：基线（进行中）、同样的进行中、通过、同样的通过。
  for (const result of [running, running, passed, passed]) {
    commands.next('gh', ['api', `repos/acme/widgets/commits/${CI_SHA}/check-runs`], checkRunsJson(result))
    commands.next('gh', ['api', `repos/acme/widgets/commits/${CI_SHA}/statuses`], JSON.stringify([]))
  }
  const h = host()
  const poller = pull45Poller(commands, h)
  assert.equal((await poller.poll()).triggers, 0, 'the first read only sets the baseline')
  assert.equal(typeof h.state.get(githubCiKey(45, CI_SHA)), 'string')
  assert.equal((await poller.poll()).triggers, 0, 'the same result is not a change')
  assert.equal((await poller.poll()).triggers, 1, 'the completed check is one change')
  assert.equal((await poller.poll()).triggers, 0, 'the same result repeats as a duplicate')
  assert.equal(h.received.length, 1)
  const trigger = h.received[0] as Trigger
  assert.equal(trigger.meta['kind'], 'ci')
  assert.equal(trigger.meta['headSha'], CI_SHA)
  assert.equal(trigger.meta['state'], 'success')
  assert.equal(trigger.actor.id, '')
  assert.equal(trigger.human, false)
  assert.equal(trigger.addressed, undefined)
  assert.equal(trigger.at, '2026-11-07T04:00:00.000Z')
  assert.equal(
    trigger.text,
    'CI passed 1/1 on PR #45 at 7241253\nRead github/pulls/45/checks for every check.'
  )
})

test('a rate-limited CI read is recorded, retried next round, and never a Source failure', async () => {
  const commands = scriptPull45(new FakeCommands())
  const rateLimit = new CliError(
    'gh exited with code 1: API rate limit exceeded for installation (HTTP 403)',
    403,
    1
  )
  // 三轮限流后才成功：若限流算进连续失败，第三轮 health 就已是 error。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    commands.fail('gh', ['api', `repos/acme/widgets/commits/${CI_SHA}/check-runs`], rateLimit, {
      once: true
    })
  }
  commands.script(['api', `repos/acme/widgets/commits/${CI_SHA}/check-runs`, '--paginate'], () =>
    checkRunsJson([checkRunJson(checkRun())])
  )
  commands.script(['api', `repos/acme/widgets/commits/${CI_SHA}/statuses`, '--paginate'], () =>
    JSON.stringify([])
  )
  const logs: string[] = []
  const h = host()
  const poller = pull45Poller(commands, h, { log: (line: string) => logs.push(line) })
  for (let round = 0; round < 3; round += 1) {
    assert.equal((await poller.poll()).triggers, 0)
    assert.equal(
      h.state.get(githubCiKey(45, CI_SHA)),
      undefined,
      'the fingerprint stays unset so the next round retries'
    )
    assert.equal(h.meta.get('github:45')?.pollError, undefined, 'a rate limit is not a Thread failure')
  }
  assert.equal(h.health.some((entry) => entry.state === 'error'), false, 'a rate limit is not a Source failure')
  assert.equal(
    /rate limit/.test(String(h.health.at(-1)?.detail)),
    true,
    'the round records the deferred read'
  )
  assert.equal(
    logs.some((line) => /rate limit/i.test(line)),
    true,
    'the rate limit is recorded'
  )
  assert.equal((await poller.poll()).triggers, 0, 'the retried read only sets the baseline')
  assert.equal(typeof h.state.get(githubCiKey(45, CI_SHA)), 'string')
})

test('only rate limiting is deferred; other CI read failures still fail the round', () => {
  const failure = (code: number, message: string) => new CliError(`gh exited with code 1: ${message} (HTTP ${code})`, code, 1)
  assert.equal(rateLimited(failure(429, 'Too many requests')), true)
  assert.equal(rateLimited(failure(403, 'API rate limit exceeded for installation')), true)
  assert.equal(rateLimited(failure(403, 'You have exceeded a secondary rate limit')), true)
  assert.equal(rateLimited(failure(403, 'issue is locked')), false)
  assert.equal(rateLimited(failure(500, 'Internal Server Error')), false)
  assert.equal(rateLimited(new Error('boom')), false)
})

test('CI is neither read nor translated while observeCi is off', async () => {
  const commands = scriptPull45(new FakeCommands())
  const h = host()
  const result = await pull45Poller(commands, h, { config: config() }).poll()
  assert.equal(result.triggers, 0)
  // FakeCommands 对没脚本化的调用直接失败：没有脚本化 check-runs 就证明一次都没读。
  assert.equal(commands.calls.some((call) => String(call.args[1]).includes('/check-runs')), false)
  assert.equal(commands.calls.some((call) => String(call.args[1]).includes('/statuses')), false)
})

test('a closed or merged pull request stops being polled for checks', async () => {
  const commands = scriptPull45(new FakeCommands(), fixture('pull.json'))
  const h = host()
  const result = await pull45Poller(commands, h).poll()
  assert.equal(result.triggers, 0)
  assert.equal(commands.calls.some((call) => String(call.args[1]).includes('/check-runs')), false)
})

test('a malformed check run is skipped and counted in the round', async () => {
  const commands = scriptPull45(new FakeCommands())
  commands.script(['api', `repos/acme/widgets/commits/${CI_SHA}/check-runs`, '--paginate'], () =>
    checkRunsJson([{ id: 1 }, checkRunJson(checkRun())])
  )
  commands.script(['api', `repos/acme/widgets/commits/${CI_SHA}/statuses`, '--paginate'], () =>
    JSON.stringify([{ state: 'success' }])
  )
  const result = await pull45Poller(commands, host()).poll()
  assert.equal(result.skipped, 2)
  assert.equal(result.triggers, 0)
})

test('a commit status changing is a CI change like a check run', async () => {
  const commands = scriptPull45(new FakeCommands())
  const pending = [commitStatus({ state: 'pending' })]
  const failed = [commitStatus({ state: 'failure' })]
  // 三轮：基线（pending）、同样的 pending、失败。
  for (const statuses of [pending, pending, failed]) {
    commands.next('gh', ['api', `repos/acme/widgets/commits/${CI_SHA}/check-runs`], checkRunsJson([]))
    commands.next('gh', ['api', `repos/acme/widgets/commits/${CI_SHA}/statuses`], statusesJson(statuses))
  }
  const h = host()
  const poller = pull45Poller(commands, h)
  assert.equal((await poller.poll()).triggers, 0, 'the baseline is the running status')
  assert.equal((await poller.poll()).triggers, 0)
  assert.equal((await poller.poll()).triggers, 1, 'a failing status is a change')
  assert.equal(h.received[0]?.meta['state'], 'failure')
  assert.equal(
    h.received[0]?.text,
    'CI failed 1/1 on PR #45 at 7241253: ci/legacy\nRead github/pulls/45/checks for every check.'
  )
})

test('a PR whose subscriptions have all ended is read but no longer polled for checks', async () => {
  const commands = scriptPull45(new FakeCommands())
  const h = host()
  // 已结束的 Ticket 仍在两周水位线内：Thread 照读（新评论可恢复），CI 不再读。
  const result = await pull45Poller(commands, h, {
    subscribed: () => [{ issue: 45, live: false, lastAt: '2026-11-01T00:00:00Z' }]
  }).poll()
  assert.equal(result.triggers, 0)
  assert.equal(commands.calls.some((call) => String(call.args[1]).includes('/check-runs')), false)
})

test('the composition root reads CI for a subscribed PR when CI observation is on', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'superagent-ci-boot-'))
  const h = await openBoot({
    stateDir,
    settings: {
      ...settingsOf(stateDir),
      sources: {
        github: {
          enabled: true,
          config: { repository: 'acme/widgets', cli: 'gh', pollSeconds: 60, observeCi: true }
        }
      }
    },
    scripts: (commands) => {
      // 一条 PR 通知（45）而不是 Issue：工单挂到 PR Thread 上，CI 才会被轮询（§I.2 CI 行）。
      commands.script('gh api notifications', () =>
        JSON.stringify([
          {
            id: 'notification-45',
            updated_at: '2026-11-07T03:26:00Z',
            last_read_at: '2026-11-07T03:25:00Z',
            subject: {
              title: 'docs: describe the identity of the agent account',
              url: 'https://api.github.com/repos/acme/widgets/pulls/45',
              type: 'PullRequest'
            },
            repository: { full_name: 'acme/widgets' }
          }
        ])
      )
      commands.script(['api', 'repos/acme/widgets/issues/45'], () => fixture('pull-as-issue.json'))
      commands.script(['api', 'repos/acme/widgets/pulls/45'], () => openPull())
      commands.script(['api', 'repos/acme/widgets/issues/45/comments', '--paginate'], () =>
        JSON.stringify([
          { ...comment(), html_url: 'https://github.com/acme/widgets/pull/45#issuecomment-9001' }
        ])
      )
      commands.script(['api', 'repos/acme/widgets/pulls/45/reviews', '--paginate'], () => JSON.stringify([]))
      commands.script(['api', 'repos/acme/widgets/pulls/45/comments', '--paginate'], () => JSON.stringify([]))
      commands.script(['api', `repos/acme/widgets/commits/${CI_SHA}/check-runs`, '--paginate'], () =>
        checkRunsJson([checkRunJson(checkRun())])
      )
      commands.script(['api', `repos/acme/widgets/commits/${CI_SHA}/statuses`, '--paginate'], () =>
        JSON.stringify([])
      )
    }
  })
  try {
    // 通知 → 工单：三次 pass 之后 Ticket 订阅了 github:45。
    await h.handle.pollOnce()
    await h.handle.passOnce()
    await h.handle.passOnce()
    await h.handle.passOnce()
    const before = h.commands.calls.length
    const second = await h.handle.pollOnce()
    assert.equal(second.triggers, 0, 'the first CI read only sets the baseline')
    const read = h.commands.calls
      .slice(before)
      .map((call) => String(call.args[1] ?? ''))
      .filter((path) => path.length > 0)
    assert.equal(
      read.includes(`repos/acme/widgets/commits/${CI_SHA}/check-runs`),
      true,
      'the composition root passes the CI fingerprint key, so checks are read'
    )
    assert.equal(read.includes(`repos/acme/widgets/commits/${CI_SHA}/statuses`), true)
  } finally {
    await h.cleanup()
  }
})

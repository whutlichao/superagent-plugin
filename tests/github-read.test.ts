// GitHub 的读面（§I.2 的「receive-all」「find」「线程上下文」「资源读取」四行）：仓库级事件流
// 怎么发现新条目、搜索怎么把三类输入解成 Thread key 与搜索词、线程上下文与资源读取给评估窗口
// 什么形状。
//
// 不发网络：所有 `gh` 调用经 `FakeCommands`（§I.6），断言的是 argv 与返回形状，不是内部实现。
// 畸形条目一律跳过并计数，无权限与已删给出明确 `status`，绝不返回空结果冒充「没有内容」。
import { assert, describe, test } from 'orca/testing'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeCommands, cliFailure } from './support/fake-commands.ts'
import { openBoot, settingsOf } from './support/boot.ts'
import type { Trigger } from '../src/worker/core/index.ts'
import {
  branchCiFingerprint,
  branchCiTrigger,
  commentTrigger,
  issueBodyTrigger,
  reviewCommentTrigger,
  reviewTrigger
} from '../src/worker/sources/github/translate.ts'
import { githubKind } from '../src/worker/sources/github/kind.ts'
import { createGithubApi } from '../src/worker/sources/github/api.ts'
import { createGithubPoller } from '../src/worker/sources/github/poll.ts'
import {
  githubBodyKey,
  githubBranchCiKey,
  githubCursorKey,
  githubStreamKey
} from '../src/worker/app/kv.ts'
import { commentOf as commentPortOf, reviewOf as reviewPortOf } from '../src/worker/sources/github/api.ts'
import type { GithubComment, GithubReview } from '../src/worker/sources/github/api.ts'
import { githubConfigSchema } from '../src/worker/sources/github/config.ts'
import { githubFind, githubRead, githubThreadContext } from '../src/worker/sources/github/read.ts'
import type { GithubDescription, GithubResourceRead } from '../src/worker/sources/github/read.ts'
import type { ContextMessage } from '../src/worker/sources/admission-context.ts'

const REPOSITORY = 'acme/widgets'

/** 一个 `gh api` 读取的一次输出。 */
const json = (value: unknown): string => JSON.stringify(value)

/** 一条 Issue（`/issues/:n` 的字段集合；`pull_request` 只在 PR 上有）。 */
function issueJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 12,
    title: 'Login redirect loops',
    state: 'open',
    body: 'Signing in bounces back to /login.',
    html_url: 'https://github.com/acme/widgets/issues/12',
    created_at: '2026-11-07T03:20:00Z',
    updated_at: '2026-11-07T03:21:00Z',
    user: { login: 'alice', type: 'User' },
    ...overrides
  }
}

/** 读一个资源（`gh` 经 FakeCommands）。 */
function readResource(commands: FakeCommands, resource: string, repository = REPOSITORY) {
  return githubRead({ host: commands, cli: 'gh', repository, resource })
}

/** 一条 Issue/PR 会话评论（`/issues/:n/comments` 的一项）。 */
function commentJson(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    user: { login: 'bob', type: 'User' },
    body: `comment ${id}`,
    created_at: '2026-11-07T05:00:00Z',
    updated_at: '2026-11-07T05:00:00Z',
    html_url: `https://github.com/acme/widgets/issues/12#issuecomment-${id}`,
    ...overrides
  }
}

/** 一条评审评论（`/pulls/:n/comments` 的一项；`in_reply_to_id` 指向线程根）。 */
function reviewCommentJson(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    user: { login: 'bob', type: 'User' },
    body: `review comment ${id}`,
    created_at: '2026-11-07T05:00:00Z',
    updated_at: '2026-11-07T05:00:00Z',
    html_url: `https://github.com/acme/widgets/pull/45#discussion_r${id}`,
    path: 'docs/account.md',
    line: 12,
    ...overrides
  }
}

/** 一条评审（`/pulls/:n/reviews` 的一项）。 */
function reviewJson(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    user: { login: 'carol', type: 'User' },
    state: 'COMMENTED',
    body: `review ${id}`,
    submitted_at: '2026-11-07T06:00:00Z',
    commit_id: '7241253bde5bcbbd0e3f7c278f5f0b9a0baa4eb1',
    html_url: `https://github.com/acme/widgets/pull/45#pullrequestreview-${id}`,
    ...overrides
  }
}

/** 一个 PR（`/pulls/:n` 的字段集合）。 */
function pullJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 45,
    title: 'docs: describe the identity of the agent account',
    state: 'open',
    body: 'Clarifies the account paragraph.',
    html_url: 'https://github.com/acme/widgets/pull/45',
    created_at: '2026-11-07T04:00:00Z',
    updated_at: '2026-11-07T04:10:00Z',
    user: { login: 'alice', type: 'User' },
    merged: false,
    draft: false,
    head: { ref: 'docs/account', sha: '7241253bde5bcbbd0e3f7c278f5f0b9a0baa4eb1' },
    base: { ref: 'main' },
    ...overrides
  }
}

/** 一条检查运行（`/commits/:sha/check-runs` 的一项）。 */
function checkRunJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'test', status: 'completed', conclusion: 'success', ...overrides }
}

/** 一页读取的 `gh` 参数（与 `api.ts` 的页读同形）。 */
function pageArgs(path: string, page: number, pageSize = 20): string[] {
  return [
    'api',
    `repos/${REPOSITORY}/${path}`,
    '--method',
    'GET',
    '-f',
    `per_page=${pageSize}`,
    '-f',
    `page=${page}`
  ]
}

/** 一条消息的简化断言形状（`ContextMessage` 里本卷关心的字段）。 */
function messageShape(message: ContextMessage): Record<string, unknown> {
  return {
    id: message.id,
    from: message.from,
    at: message.at,
    text: message.text,
    ...(message.bot === true ? { bot: true } : {}),
    ...(message.url === undefined ? {} : { url: message.url }),
    ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
    ...(message.path === undefined ? {} : { path: message.path }),
    ...(message.line === undefined ? {} : { line: message.line })
  }
}

/** 断言这是一次描述读，并收窄类型（测试的守卫，不参与生产路径）。 */
function descriptionOfRead(read: GithubResourceRead): GithubDescription {
  if (read.kind !== 'description') throw new Error(`expected a description read, got ${read.kind}`)
  if (read.description === null) throw new Error('expected a description')
  return read.description
}

/** 断言这是一次页读取，并收窄类型（连同 `next` 一起）。 */
function expectMessages(read: GithubResourceRead): Extract<GithubResourceRead, { kind: 'messages' }> {
  if (read.kind !== 'messages') throw new Error(`expected a messages read, got ${read.kind}`)
  return read
}

describe('reading a resource by its name', () => {
  test('an Issue description becomes one message with its title, state and body', async () => {
    const commands = new FakeCommands().script(['api', `repos/${REPOSITORY}/issues/12`], () =>
      json(issueJson())
    )
    const read = await readResource(commands, 'github/issues/12')
    assert.equal(read.kind, 'description')
    assert.equal(read.status, 'available')
    const description = descriptionOfRead(read)
    assert.deepEqual(description, {
      number: 12,
      isPull: false,
      title: 'Login redirect loops',
      state: 'open',
      url: 'https://github.com/acme/widgets/issues/12',
      message: {
        id: 'https://github.com/acme/widgets/issues/12',
        from: 'alice',
        at: '2026-11-07T03:20:00Z',
        text: 'Login redirect loops\n\nSigning in bounces back to /login.',
        url: 'https://github.com/acme/widgets/issues/12'
      }
    })
    assert.equal(read.body['status'], 'available')
    assert.equal(read.body['next_resource'], null)
  })

  test('a pull request description keeps its state, draft and branches', async () => {
    const commands = new FakeCommands().script(['api', `repos/${REPOSITORY}/pulls/45`], () =>
      json(pullJson({ state: 'closed', merged: true, draft: true }))
    )
    const read = await readResource(commands, 'github/pulls/45')
    assert.equal(read.status, 'available')
    assert.deepEqual(descriptionOfRead(read), {
      number: 45,
      isPull: true,
      title: 'docs: describe the identity of the agent account',
      state: 'closed',
      url: 'https://github.com/acme/widgets/pull/45',
      merged: true,
      draft: true,
      head: 'docs/account',
      base: 'main',
      message: {
        id: 'https://github.com/acme/widgets/pull/45',
        from: 'alice',
        at: '2026-11-07T04:00:00Z',
        text: 'docs: describe the identity of the agent account\n\nClarifies the account paragraph.',
        url: 'https://github.com/acme/widgets/pull/45'
      }
    })
  })

  test('a comments page holds 20 entries and names the next page while one may follow', async () => {
    const rows = Array.from({ length: 20 }, (_, index) => commentJson(9001 + index))
    const commands = new FakeCommands().script(pageArgs('issues/12/comments', 1), () => json(rows))
    const read = expectMessages(await readResource(commands, 'github/issues/12/comments/1'))
    assert.equal(read.status, 'available')
    const messages = read.messages
    assert.equal(messages.length, 20)
    assert.deepEqual(messages[0], {
      id: 'https://github.com/acme/widgets/issues/12#issuecomment-9001',
      from: 'bob',
      at: '2026-11-07T05:00:00Z',
      text: 'comment 9001',
      url: 'https://github.com/acme/widgets/issues/12#issuecomment-9001'
    })
    assert.equal(read.next, 'github/issues/12/comments/2')
    assert.equal(read.body['next_resource'], 'github/issues/12/comments/2')
  })

  test('a short page has no next cursor, and the cursor it hands back reads the page after it', async () => {
    const commands = new FakeCommands()
      .script(pageArgs('issues/12/comments', 1), () => json([commentJson(9001)]))
      .script(pageArgs('issues/12/comments', 2), () => json([commentJson(9021)]))
    const first = expectMessages(await readResource(commands, 'github/issues/12/comments/1'))
    assert.equal(first.next, undefined)
    assert.equal(first.body['next_resource'], null)
    const second = expectMessages(await readResource(commands, 'github/issues/12/comments/2'))
    assert.deepEqual(
      second.messages.map((message) => message.text),
      ['comment 9021']
    )
  })

  test('a reviews page reads the reviews as decisions with their author and state', async () => {
    const commands = new FakeCommands().script(pageArgs('pulls/45/reviews', 1), () =>
      json([
        reviewJson(7001, { state: 'APPROVED', body: 'Looks right.' }),
        reviewJson(7002, { state: 'COMMENTED', body: '' })
      ])
    )
    const read = expectMessages(await readResource(commands, 'github/pulls/45/reviews/1'))
    assert.equal(read.next, undefined)
    assert.deepEqual(
      read.messages.map((message) => messageShape(message)),
      [
        {
          id: 'https://github.com/acme/widgets/pull/45#pullrequestreview-7001',
          from: 'carol',
          at: '2026-11-07T06:00:00Z',
          text: 'APPROVED review of commit 7241253bde5bcbbd0e3f7c278f5f0b9a0baa4eb1\n\nLooks right.',
          url: 'https://github.com/acme/widgets/pull/45#pullrequestreview-7001'
        },
        {
          id: 'https://github.com/acme/widgets/pull/45#pullrequestreview-7002',
          from: 'carol',
          at: '2026-11-07T06:00:00Z',
          text: '',
          url: 'https://github.com/acme/widgets/pull/45#pullrequestreview-7002'
        }
      ]
    )
  })

  test('a review comment page keeps the review thread root and the file it sits on', async () => {
    const commands = new FakeCommands().script(pageArgs('pulls/45/comments', 1), () =>
      json([reviewCommentJson(7001), reviewCommentJson(7002, { in_reply_to_id: 7001 })])
    )
    const read = expectMessages(await readResource(commands, 'github/pulls/45/comments/1'))
    assert.deepEqual(
      read.messages.map((message) => messageShape(message)),
      [
        {
          id: 'https://github.com/acme/widgets/pull/45#discussion_r7001',
          from: 'bob',
          at: '2026-11-07T05:00:00Z',
          text: 'review comment 7001',
          url: 'https://github.com/acme/widgets/pull/45#discussion_r7001',
          path: 'docs/account.md',
          line: 12
        },
        {
          id: 'https://github.com/acme/widgets/pull/45#discussion_r7002',
          from: 'bob',
          at: '2026-11-07T05:00:00Z',
          text: 'review comment 7002',
          url: 'https://github.com/acme/widgets/pull/45#discussion_r7002',
          replyTo: '7001',
          path: 'docs/account.md',
          line: 12
        }
      ]
    )
  })
})

describe('find: the GitHub inputs name a Thread and its search terms', () => {
  test('a #12 short reference names Thread 12', () => {
    assert.deepEqual(githubFind('#12'), { threads: ['github:12'], terms: ['#12'] })
  })

  test('an Issue or pull request link names the same Thread', () => {
    assert.deepEqual(githubFind('https://github.com/acme/widgets/issues/12'), {
      threads: ['github:12'],
      terms: ['https://github.com/acme/widgets/issues/12']
    })
    assert.deepEqual(githubFind('https://github.com/acme/widgets/pull/45'), {
      threads: ['github:45'],
      terms: ['https://github.com/acme/widgets/pull/45']
    })
  })

  test('a comment link names its Issue or PR Thread, and the whole link stays a search term', () => {
    // 锚点只是那条评论的页内位置：Thread 仍是它所在的 Issue/PR（§I.2「find」行）。
    assert.deepEqual(githubFind('https://github.com/acme/widgets/issues/12#issuecomment-9001'), {
      threads: ['github:12'],
      terms: ['https://github.com/acme/widgets/issues/12#issuecomment-9001']
    })
    assert.deepEqual(githubFind('https://github.com/acme/widgets/pull/45#discussion_r7001'), {
      threads: ['github:45'],
      terms: ['https://github.com/acme/widgets/pull/45#discussion_r7001']
    })
  })

  test('a link inside prose keeps the prose and the normalised link as two terms', () => {
    const read = githubFind('see github.com/acme/widgets/pull/45#discussion_r7001 for the thread')
    assert.deepEqual(read.threads, ['github:45'])
    assert.deepEqual(read.terms, [
      'see github.com/acme/widgets/pull/45#discussion_r7001 for the thread',
      'github.com/acme/widgets/pull/45#discussion_r7001'
    ])
  })

  test('a short reference inside prose names its Thread, and plain words only name search terms', () => {
    assert.deepEqual(githubFind('check #12 and #13'), {
      threads: ['github:12', 'github:13'],
      terms: ['check #12 and #13']
    })
    assert.deepEqual(githubFind('login redirect'), { threads: [], terms: ['login redirect'] })
    assert.deepEqual(githubFind('   '), { threads: [], terms: [] })
  })
})

describe('a review thread, the checks of a commit, and what a read refuses', () => {
  const SHA = '7241253bde5bcbbd0e3f7c278f5f0b9a0baa4eb1'

  test('a review thread reads its root and replies in order, each reply naming the root', async () => {
    const commands = new FakeCommands().script(
      ['api', `repos/${REPOSITORY}/pulls/45/comments`, '--paginate'],
      () =>
        json([
          // GitHub 不保证顺序：读面自己按提交时刻排，根在最前（§I.2 评审线程行）。
          reviewCommentJson(7002, { in_reply_to_id: 7001 }),
          reviewCommentJson(7009),
          reviewCommentJson(7001)
        ])
    )
    // 用回复的 id 命名线程也一样：根由 `in_reply_to_id` 认出来。
    const read = expectMessages(await readResource(commands, 'github/pulls/45/thread/7002'))
    assert.equal(read.status, 'available')
    assert.deepEqual(
      read.messages.map((message) => messageShape(message)),
      [
        {
          id: 'https://github.com/acme/widgets/pull/45#discussion_r7001',
          from: 'bob',
          at: '2026-11-07T05:00:00Z',
          text: 'review comment 7001',
          url: 'https://github.com/acme/widgets/pull/45#discussion_r7001',
          path: 'docs/account.md',
          line: 12
        },
        {
          id: 'https://github.com/acme/widgets/pull/45#discussion_r7002',
          from: 'bob',
          at: '2026-11-07T05:00:00Z',
          text: 'review comment 7002',
          url: 'https://github.com/acme/widgets/pull/45#discussion_r7002',
          replyTo: '7001',
          path: 'docs/account.md',
          line: 12
        }
      ]
    )
    assert.equal(read.next, undefined)
  })

  test('a review thread named by a comment this PR does not have is missing, not empty', async () => {
    const commands = new FakeCommands().script(
      ['api', `repos/${REPOSITORY}/pulls/45/comments`, '--paginate'],
      () => json([reviewCommentJson(7001)])
    )
    const read = expectMessages(await readResource(commands, 'github/pulls/45/thread/9999'))
    assert.equal(read.status, 'missing')
    assert.deepEqual(read.messages, [])
  })

  test('a pull request checks read follows its head commit; a commit checks read names the sha', async () => {
    const commands = new FakeCommands()
      .script(['api', `repos/${REPOSITORY}/pulls/45`], () => json(pullJson()))
      .script(['api', `repos/${REPOSITORY}/commits/${SHA}/check-runs`, '--paginate', '--slurp'], () =>
        json([{ check_runs: [checkRunJson(), { name: 'lint', status: 'completed', conclusion: 'failure' }] }])
      )
      .script(['api', `repos/${REPOSITORY}/commits/${SHA}/statuses`, '--paginate'], () =>
        json([{ context: 'ci/legacy', state: 'success' }])
      )
    const fromPull = await readResource(commands, 'github/pulls/45/checks')
    assert.equal(fromPull.kind, 'checks')
    if (fromPull.kind !== 'checks') throw new Error('expected a checks read')
    assert.equal(fromPull.status, 'available')
    assert.deepEqual(fromPull.checks, {
      headSha: SHA,
      checks: [
        { name: 'lint', status: 'completed', conclusion: 'failure' },
        { name: 'test', status: 'completed', conclusion: 'success' }
      ],
      statuses: [{ context: 'ci/legacy', state: 'success' }]
    })
    assert.equal(fromPull.body['next_resource'], null)

    const fromCommit = await readResource(commands, `github/commits/${SHA}/checks`)
    if (fromCommit.kind !== 'checks') throw new Error('expected a checks read')
    assert.equal(fromCommit.checks?.headSha, SHA)
    // 同一个 sha 的两次读走同一个端点：一次 `pulls/<n>` 探测 + 两次提交检查（各两页读）。
    assert.deepEqual(
      commands.calls.map((call) => call.args.slice(0, 2).join(' ')),
      [
        `api repos/${REPOSITORY}/pulls/45`,
        `api repos/${REPOSITORY}/commits/${SHA}/check-runs`,
        `api repos/${REPOSITORY}/commits/${SHA}/statuses`,
        `api repos/${REPOSITORY}/commits/${SHA}/check-runs`,
        `api repos/${REPOSITORY}/commits/${SHA}/statuses`
      ]
    )
  })

  test('an unknown resource is refused with the forms that work, before any CLI call', async () => {
    const commands = new FakeCommands()
    await assert.rejects(readResource(commands, 'github/pulls/45/labels'), /Unknown GitHub resource/)
    await assert.rejects(readResource(commands, 'github/issues/12/reviews/1'), /require a pull request/)
    await assert.rejects(readResource(commands, 'github/pulls/45/thread'), /Name the review thread/)
    await assert.rejects(readResource(commands, 'github/pulls/45/checks/2'), /do not take a page number/)
    await assert.rejects(readResource(commands, 'github/commits/not-a-sha/checks'), /Unknown GitHub resource/)
    assert.deepEqual(commands.calls, [], 'a refusal reads nothing')
  })

  test('no permission, a deletion and a missing resource are explicit statuses; a rate limit still retries', async () => {
    const statuses = new FakeCommands()
      .fail('gh', ['api', `repos/${REPOSITORY}/issues/12`], cliFailure('gh', {
        code: 403,
        stderr: 'Resource not accessible by integration (HTTP 403)'
      }))
      .fail('gh', ['api', `repos/${REPOSITORY}/issues/13`], cliFailure('gh', {
        code: 410,
        stderr: 'This issue was deleted (HTTP 410)'
      }))
      .fail('gh', ['api', `repos/${REPOSITORY}/issues/14`], cliFailure('gh', {
        code: 404,
        stderr: 'Not Found (HTTP 404)'
      }))
    for (const [number, status] of [
      [12, 'forbidden'],
      [13, 'deleted'],
      [14, 'missing']
    ] as const) {
      const read = await readResource(statuses, `github/issues/${number}`)
      assert.equal(read.status, status)
      assert.equal(read.kind === 'description' ? read.description : undefined, null)
    }
    // 页读也折叠状态：读不到评论时是明确的 `forbidden`，不是「这一页是空的」。
    const page = new FakeCommands().fail(
      'gh',
      ['api', `repos/${REPOSITORY}/issues/12/comments`, '--method'],
      cliFailure('gh', { code: 403, stderr: 'Resource not accessible by integration (HTTP 403)' })
    )
    const denied = await readResource(page, 'github/issues/12/comments/1')
    assert.equal(denied.status, 'forbidden')
    assert.deepEqual(denied.kind === 'messages' ? denied.messages : undefined, [])
    const limited = new FakeCommands().fail(
      'gh',
      ['api', `repos/${REPOSITORY}/issues/12`],
      cliFailure('gh', { code: 403, stderr: 'API rate limit exceeded for installation (HTTP 403)' })
    )
    await assert.rejects(readResource(limited, 'github/issues/12'), /rate limit/)
  })
})

describe('the thread context an assessment window reads', () => {
  const CONFIG = githubConfigSchema.parse({ repository: REPOSITORY })
  const signal = new AbortController().signal

  /** 一条会话评论的端口形状（`commentOf` 的产物）。 */
  function commentOf(row: Record<string, unknown>): GithubComment {
    const parsed = commentPortOf(row)
    if (parsed === undefined) throw new Error('the comment fixture is malformed')
    return parsed
  }

  /** 一条评审的端口形状。 */
  function reviewOf(row: Record<string, unknown>): GithubReview {
    const parsed = reviewPortOf(row)
    if (parsed === undefined) throw new Error('the review fixture is malformed')
    return parsed
  }

  test('the conversation page starts with the description and holds 20 comments, then hands the cursor on', async () => {
    const trigger = commentTrigger({
      repository: REPOSITORY,
      issue: 12,
      comment: commentOf(commentJson(9001)),
      login: 'acme-agent',
      observeComments: true
    })
    const comments = Array.from({ length: 20 }, (_, index) => commentJson(9001 + index))
    const commands = new FakeCommands()
      .script(['api', `repos/${REPOSITORY}/issues/12`], () => json(issueJson()))
      .script(pageArgs('issues/12/comments', 1), () => json(comments))
      .script(pageArgs('issues/12/comments', 2), () => json([commentJson(9021)]))
    const context = githubThreadContext('gh')
    const first = await context.read(commands, trigger, 'thread', undefined, CONFIG, signal)
    assert.equal(first.status, 'conversation')
    assert.equal(first.messages.length, 21, 'the description plus one page of comments')
    assert.deepEqual(first.messages[0]?.id, 'https://github.com/acme/widgets/issues/12')
    assert.equal(first.next, 'github/issues/12/comments/2')
    assert.equal(first.body['next_resource'], 'github/issues/12/comments/2')
    const second = await context.read(commands, trigger, 'thread', first.next, CONFIG, signal)
    assert.deepEqual(second.messages.map((message) => message.text), ['comment 9021'])
    assert.equal(second.next, undefined)
  })

  test('a review trigger reads the reviews page, so the window sees what the reviewers said', async () => {
    const trigger = reviewTrigger({
      repository: REPOSITORY,
      pull: 45,
      review: reviewOf(reviewJson(7001)),
      login: 'acme-agent'
    })
    const reviews = Array.from({ length: 20 }, (_, index) => reviewJson(7001 + index, { body: `review ${index}` }))
    const commands = new FakeCommands().script(pageArgs('pulls/45/reviews', 1), () => json(reviews))
    const context = githubThreadContext('gh')
    const page = await context.read(commands, trigger, 'thread', undefined, CONFIG, signal)
    assert.equal(page.status, 'reviews')
    assert.equal(page.messages.length, 20)
    assert.equal(page.messages[0]?.from, 'carol')
    assert.equal(page.next, 'github/pulls/45/reviews/2')
    assert.equal(page.body['next_resource'], 'github/pulls/45/reviews/2')
  })

  test('an inline review comment reads its own review thread, and root/parent read the root', async () => {
    const trigger = reviewCommentTrigger({
      repository: REPOSITORY,
      pull: 45,
      comment: commentOf(reviewCommentJson(7002, { in_reply_to_id: 7001 })),
      login: 'acme-agent'
    })
    const commands = new FakeCommands().script(
      ['api', `repos/${REPOSITORY}/pulls/45/comments`, '--paginate'],
      () => json([reviewCommentJson(7002, { in_reply_to_id: 7001 }), reviewCommentJson(7001), reviewCommentJson(7009)])
    )
    const context = githubThreadContext('gh')
    const thread = await context.read(commands, trigger, 'thread', undefined, CONFIG, signal)
    assert.equal(thread.status, 'review_thread')
    assert.deepEqual(
      thread.messages.map((message) => message.id),
      [
        'https://github.com/acme/widgets/pull/45#discussion_r7001',
        'https://github.com/acme/widgets/pull/45#discussion_r7002'
      ]
    )
    assert.equal(thread.next, undefined, 'a review thread is one page')
    const root = await context.read(commands, trigger, 'root', undefined, CONFIG, signal)
    assert.deepEqual(root.messages.map((message) => message.id), [
      'https://github.com/acme/widgets/pull/45#discussion_r7001'
    ])
  })

  test('default-branch CI has no conversation: its trigger is its own context', async () => {
    const trigger = branchCiTrigger({
      repository: REPOSITORY,
      branch: 'main',
      checks: {
        headSha: '7241253bde5bcbbd0e3f7c278f5f0b9a0baa4eb1',
        checks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
        statuses: []
      },
      at: '2026-11-07T07:00:00.000Z',
      url: `https://github.com/${REPOSITORY}/commit/7241253bde5bcbbd0e3f7c278f5f0b9a0baa4eb1`
    })
    const context = githubThreadContext('gh')
    const page = await context.read(new FakeCommands(), trigger, 'thread', undefined, CONFIG, signal)
    assert.equal(page.status, 'branch_ci')
    assert.deepEqual(page.messages.map((message) => message.id), [trigger.url as string])
    assert.equal(page.next, undefined)
  })

  test('the trigger message id is the id its context message carries, so the window can find it', async () => {
    const context = githubThreadContext('gh')
    const comment = commentOf(commentJson(9001))
    assert.equal(
      context.messageId(
        commentTrigger({ repository: REPOSITORY, issue: 12, comment, login: 'acme-agent', observeComments: true })
      ),
      'https://github.com/acme/widgets/issues/12#issuecomment-9001'
    )
    assert.equal(
      context.messageId(
        issueBodyTrigger({
          repository: REPOSITORY,
          number: 12,
          isPull: false,
          source: {
            title: 'Login redirect loops',
            body: 'Signing in bounces back to /login.',
            login: 'alice',
            bot: false,
            createdAt: '2026-11-07T03:20:00Z',
            updatedAt: '2026-11-07T03:21:00Z',
            url: 'https://github.com/acme/widgets/issues/12'
          },
          login: 'acme-agent'
        })
      ),
      'https://github.com/acme/widgets/issues/12'
    )
  })
})

describe('receive-all: the repository itself is a receiving surface', () => {
  const SHA = '7241253bde5bcbbd0e3f7c278f5f0b9a0baa4eb1'

  /** 一个记录收到的 Trigger 的宿主（`GithubPollHost` 的最小形状）。 */
  function pollHost() {
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

  /** 一个固定的时钟（`started` 与 Trigger 的 `at` 都读它）。 */
  function clockOf(at: string) {
    let now = Date.parse(at)
    return {
      now: () => now,
      advance: (ms: number) => {
        now += ms
      }
    }
  }

  /** 一个轮询器：通知永远是空的，仓库流的脚本由每个用例自己给。 */
  function pollerOf(
    commands: FakeCommands,
    h: ReturnType<typeof pollHost>,
    options: { config?: Record<string, unknown>; now?: () => number } = {}
  ) {
    return createGithubPoller({
      api: createGithubApi(commands, 'gh'),
      config: githubConfigSchema.parse({ repository: REPOSITORY, cli: 'gh', ...options.config }),
      login: 'acme-agent',
      host: h.port,
      cursorKey: githubCursorKey,
      bodyKey: githubBodyKey,
      streamKey: githubStreamKey,
      branchCiKey: githubBranchCiKey,
      ...(options.now === undefined ? {} : { now: options.now })
    })
  }

  /** 一条通知读（每轮都先读通知；这里永远是空表）。 */
  function noNotifications(commands: FakeCommands): FakeCommands {
    return commands.script(['api', 'notifications', '--paginate'], () => json([]))
  }

  test('new Issues are discovered, and only ones opened after the switch was on', async () => {
    const h = pollHost()
    const clock = clockOf('2026-11-07T08:00:00Z')
    const commands = noNotifications(new FakeCommands())
    commands.next('gh', ['api', `repos/${REPOSITORY}/issues`, '--paginate'], json([]))
    commands.script(['api', `repos/${REPOSITORY}/issues`, '--paginate'], () =>
      json([
        // 开关打开之后开的：收到。
        issueJson({
          number: 12,
          created_at: '2026-11-07T08:03:00Z',
          updated_at: '2026-11-07T08:03:00Z'
        }),
        // 开关打开之前就在的：不读以前的。
        issueJson({ number: 11, created_at: '2026-11-07T07:00:00Z', updated_at: '2026-11-07T07:00:00Z' }),
        // PR 属 observePulls：这个开关没开，它不进 issues 行。
        issueJson({
          number: 45,
          pull_request: { url: `https://api.github.com/repos/${REPOSITORY}/pulls/45` },
          created_at: '2026-11-07T08:03:30Z',
          updated_at: '2026-11-07T08:03:30Z'
        })
      ])
    )
    const poller = pollerOf(commands, h, { config: { observeIssues: true }, now: clock.now })
    assert.equal((await poller.poll()).triggers, 0, 'the first round only records where the stream starts')
    clock.advance(5 * 60_000)
    const second = await poller.poll()
    assert.equal(second.triggers, 1)
    const trigger = h.received[0] as Trigger
    assert.equal(trigger.meta['kind'], 'issue')
    assert.deepEqual(trigger.threads, [{ source: 'github', id: '12' }])
    assert.equal(trigger.actor.id, 'alice')
    assert.equal(trigger.human, true)
    assert.equal(trigger.addressed, undefined, 'receive-all is about not being addressed')
    assert.equal(trigger.text, 'Login redirect loops\n\nSigning in bounces back to /login.')
    // 游标记住了两个开了的种类（PR 没开，所以没有 pulls）。
    const cursor = h.state.get(githubStreamKey('issues')) as {
      since: string
      started: Record<string, string>
    }
    assert.deepEqual(Object.keys(cursor.started), ['issues'])
    assert.equal(cursor.started['issues'], '2026-11-07T08:00:00.000Z')
    // 最新一条（这里的 PR，即使它不归 Issues 行）往前 5 秒：没投递的条目也不重读，
    // 之后单独打开 observePulls 时由它自己的 `started.pulls` 挡住更早的条目。
    assert.equal(cursor.since, '2026-11-07T08:03:25.000Z', 'five seconds before the newest item')
  })

  test('new pull requests are discovered only while observePulls is on', async () => {
    const h = pollHost()
    const clock = clockOf('2026-11-07T08:00:00Z')
    const commands = noNotifications(new FakeCommands())
    commands.next('gh', ['api', `repos/${REPOSITORY}/issues`, '--paginate'], json([]))
    commands.script(['api', `repos/${REPOSITORY}/issues`, '--paginate'], () =>
      json([
        issueJson({
          number: 45,
          title: 'docs: describe the identity of the agent account',
          body: 'Clarifies the account paragraph.',
          html_url: `https://github.com/${REPOSITORY}/pull/45`,
          pull_request: { url: `https://api.github.com/repos/${REPOSITORY}/pulls/45` },
          created_at: '2026-11-07T08:01:00Z',
          updated_at: '2026-11-07T08:01:00Z'
        })
      ])
    )
    const poller = pollerOf(commands, h, { config: { observePulls: true }, now: clock.now })
    await poller.poll()
    clock.advance(60_000)
    assert.equal((await poller.poll()).triggers, 1)
    const trigger = h.received[0] as Trigger
    assert.equal(trigger.meta['kind'], 'pull')
    assert.deepEqual(trigger.threads, [{ source: 'github', id: '45' }])
    assert.equal(trigger.text, 'docs: describe the identity of the agent account\n\nClarifies the account paragraph.')
  })

  test('new comments are discovered on Issues and on review threads, and the agent’s own words are dropped', async () => {
    const h = pollHost()
    const clock = clockOf('2026-11-07T08:00:00Z')
    const commands = noNotifications(new FakeCommands())
    commands.next('gh', ['api', `repos/${REPOSITORY}/issues/comments`, '--paginate'], json([]))
    commands.script(['api', `repos/${REPOSITORY}/issues/comments`, '--paginate'], () =>
      json([
        {
          ...commentJson(9001, {
            body: 'The redirect still loops on Safari.',
            created_at: '2026-11-07T08:02:00Z',
            updated_at: '2026-11-07T08:02:00Z'
          }),
          issue_url: `https://api.github.com/repos/${REPOSITORY}/issues/12`
        },
        {
          // 自己写的评论：丢掉，不产 Trigger。
          ...commentJson(9002, {
            user: { login: 'acme-agent', type: 'User' },
            created_at: '2026-11-07T08:02:10Z',
            updated_at: '2026-11-07T08:02:10Z'
          }),
          issue_url: `https://api.github.com/repos/${REPOSITORY}/issues/12`
        },
        {
          // 没有正文的评论没有可读内容。
          ...commentJson(9003, {
            body: '',
            created_at: '2026-11-07T08:02:20Z',
            updated_at: '2026-11-07T08:02:20Z'
          }),
          issue_url: `https://api.github.com/repos/${REPOSITORY}/issues/12`
        }
      ])
    )
    commands.next('gh', ['api', `repos/${REPOSITORY}/pulls/comments`, '--paginate'], json([]))
    commands.script(['api', `repos/${REPOSITORY}/pulls/comments`, '--paginate'], () =>
      json([
        {
          ...reviewCommentJson(7001, {
            created_at: '2026-11-07T08:02:30Z',
            updated_at: '2026-11-07T08:02:30Z'
          }),
          pull_request_url: `https://api.github.com/repos/${REPOSITORY}/pulls/45`
        }
      ])
    )
    const poller = pollerOf(commands, h, { config: { observeComments: true }, now: clock.now })
    await poller.poll()
    clock.advance(60_000)
    const second = await poller.poll()
    assert.equal(second.triggers, 2)
    assert.deepEqual(
      h.received.map((trigger) => [trigger.meta['kind'], trigger.threads[0]?.id]),
      [
        ['comment', '12'],
        ['review-comment', '45']
      ]
    )
    assert.equal(h.received.some((trigger) => trigger.actor.id === 'acme-agent'), false)
    assert.equal(
      h.received[1]?.meta['rootCommentId'],
      7001,
      'a review comment keeps its review thread root'
    )
  })

  test('a malformed repository entry is skipped and counted, never a crash', async () => {
    const h = pollHost()
    const clock = clockOf('2026-11-07T08:00:00Z')
    const commands = noNotifications(new FakeCommands())
    commands.next('gh', ['api', `repos/${REPOSITORY}/issues`, '--paginate'], json([]))
    commands.script(['api', `repos/${REPOSITORY}/issues`, '--paginate'], () =>
      json([
        { title: 'no number at all' },
        issueJson({ number: 0 }),
        issueJson({ number: 12, created_at: '2026-11-07T08:01:00Z', updated_at: '2026-11-07T08:01:00Z' })
      ])
    )
    const poller = pollerOf(commands, h, { config: { observeIssues: true }, now: clock.now })
    await poller.poll()
    clock.advance(60_000)
    const result = await poller.poll()
    assert.equal(result.skipped, 2)
    assert.equal(result.triggers, 1)
  })

  test('with every switch off the repository is not read at all', async () => {
    const h = pollHost()
    const commands = noNotifications(new FakeCommands())
    const poller = pollerOf(commands, h, {})
    await poller.poll()
    const paths = commands.calls.map((call) => String(call.args[1] ?? ''))
    assert.deepEqual(paths, ['notifications'], 'only the notification read happened')
  })

  test('a received trigger lands on the admission row its receive-all switch makes available', async () => {
    const h = pollHost()
    const clock = clockOf('2026-11-07T08:00:00Z')
    const commands = noNotifications(new FakeCommands())
    commands.next('gh', ['api', `repos/${REPOSITORY}/issues`, '--paginate'], json([]))
    commands.script(['api', `repos/${REPOSITORY}/issues`, '--paginate'], () =>
      json([
        issueJson({ number: 12, created_at: '2026-11-07T08:01:00Z', updated_at: '2026-11-07T08:01:00Z' }),
        issueJson({
          number: 13,
          body: '@acme-agent please take a look',
          created_at: '2026-11-07T08:01:10Z',
          updated_at: '2026-11-07T08:01:10Z'
        })
      ])
    )
    const poller = pollerOf(commands, h, { config: { observeIssues: true }, now: clock.now })
    await poller.poll()
    clock.advance(60_000)
    await poller.poll()
    const config = githubConfigSchema.parse({ repository: REPOSITORY, observeIssues: true })
    const observed = h.received.find((trigger) => trigger.meta['issue'] === 12) as Trigger
    const addressed = h.received.find((trigger) => trigger.meta['issue'] === 13) as Trigger
    assert.deepEqual(githubKind.scope?.(observed, config), {
      listened: true,
      observed: true,
      row: 'issues'
    })
    assert.deepEqual(githubKind.scope?.(addressed, config), {
      listened: true,
      observed: false,
      row: 'issues'
    })
  })

  test('default-branch CI is received only when its failure set changes, on its own Thread', async () => {
    const h = pollHost()
    const clock = clockOf('2026-11-07T08:00:00Z')
    const commands = noNotifications(new FakeCommands())
    commands.script(['api', `repos/${REPOSITORY}`], () => json({ default_branch: 'main' }))
    commands.script(['api', `repos/${REPOSITORY}/actions/runs`, '--method'], () =>
      json({ total_count: 1, workflow_runs: [{ head_sha: SHA, status: 'completed', conclusion: 'success' }] })
    )
    const passing = [checkRunJson()]
    const failing = [checkRunJson({ name: 'test', status: 'completed', conclusion: 'failure' })]
    for (const result of [passing, passing, failing, failing]) {
      commands.next(
        'gh',
        ['api', `repos/${REPOSITORY}/commits/${SHA}/check-runs`, '--paginate'],
        json([{ check_runs: result }])
      )
      commands.next(
        'gh',
        ['api', `repos/${REPOSITORY}/commits/${SHA}/statuses`, '--paginate'],
        json([])
      )
    }
    const poller = pollerOf(commands, h, { config: { observeCi: true }, now: clock.now })
    assert.equal((await poller.poll()).triggers, 0, 'the first read only sets the baseline')
    clock.advance(60_000)
    assert.equal((await poller.poll()).triggers, 0, 'a passing default branch is not news')
    clock.advance(60_000)
    const failed = await poller.poll()
    assert.equal(failed.triggers, 1)
    const trigger = h.received[0] as Trigger
    assert.deepEqual(trigger.threads, [{ source: 'github', id: 'ci:main' }])
    assert.equal(trigger.meta['kind'], 'ci')
    assert.equal(trigger.meta['branch'], 'main')
    assert.equal(trigger.meta['state'], 'failure')
    assert.equal(trigger.channel, undefined, 'no conversation to reply in')
    assert.equal(trigger.human, false)
    assert.equal(trigger.actor.id, '')
    assert.equal(
      trigger.text,
      'CI failed 1/1 on main at 7241253: test\nRead github/commits/' + SHA + '/checks for every check.'
    )
    assert.equal(trigger.url, `https://github.com/${REPOSITORY}/commit/${SHA}`)
    // 准入行：CI 没有发送者，只有最后一格（§I.2 准入行、§K.2）。
    assert.deepEqual(
      githubKind.scope?.(trigger, githubConfigSchema.parse({ repository: REPOSITORY, observeCi: true })),
      { listened: true, observed: true, row: 'ci' }
    )
    clock.advance(60_000)
    assert.equal((await poller.poll()).triggers, 0, 'the same failures repeat as a duplicate')
    assert.deepEqual(h.state.get(githubBranchCiKey), {
      branch: 'main',
      fingerprint: branchCiFingerprint({ headSha: SHA, checks: failing as never, statuses: [] })
    })
  })
})

describe('the kind exposes the read surface, and the composition root wires receive-all', () => {
  const SHA = '7241253bde5bcbbd0e3f7c278f5f0b9a0baa4eb1'

  test('the GitHub kind carries the thread context and the search mapping', () => {
    assert.equal(typeof githubKind.threadContext?.read, 'function')
    assert.equal(typeof githubKind.threadContext?.messageId, 'function')
    assert.deepEqual(githubKind.find?.('https://github.com/acme/widgets/pull/45#discussion_r7001'), {
      threads: ['github:45'],
      terms: ['https://github.com/acme/widgets/pull/45#discussion_r7001']
    })
    assert.deepEqual(githubKind.find?.('#12'), { threads: ['github:12'], terms: ['#12'] })
    // 四个开关都在设置表单里（面板据此画控件），并且带「从打开的时刻开始」的说明。
    const switches = (githubKind.fields ?? []).filter((field) => field.type === 'switch')
    assert.deepEqual(
      switches.map((field) => field.key),
      ['observeIssues', 'observePulls', 'observeComments', 'observeCi']
    )
    assert.equal(
      switches.every((field) => field.type === 'switch' && field.hint !== undefined),
      true,
      'each receive-all switch says what turning it on does'
    )
  })

  test('the composition root polls the repository streams and the default branch', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'superagent-receive-all-'))
    const h = await openBoot({
      stateDir,
      settings: {
        ...settingsOf(stateDir),
        sources: {
          github: {
            enabled: true,
            config: {
              repository: 'acme/widgets',
              cli: 'gh',
              pollSeconds: 60,
              observeIssues: true,
              observeCi: true
            }
          }
        }
      },
      scripts: (commands) => {
        commands.script('gh api notifications', () => json([]))
        commands.script(['api', 'repos/acme/widgets/issues', '--paginate'], () => json([]))
        commands.script(['api', 'repos/acme/widgets'], () => json({ default_branch: 'main' }))
        commands.script(['api', 'repos/acme/widgets/actions/runs', '--method'], () =>
          json({ total_count: 1, workflow_runs: [{ head_sha: SHA }] })
        )
        commands.script(['api', `repos/acme/widgets/commits/${SHA}/check-runs`, '--paginate'], () =>
          json([{ check_runs: [] }])
        )
        commands.script(['api', `repos/acme/widgets/commits/${SHA}/statuses`, '--paginate'], () =>
          json([])
        )
      }
    })
    try {
      await h.handle.pollOnce()
      const paths = h.commands.calls.map((call) => String(call.args[1] ?? ''))
      // 组合根把 streamKey/branchCiKey 交给了轮询器：否则这些读一次都不会发生。
      assert.equal(
        paths.includes('repos/acme/widgets/issues'),
        true,
        'the repository Issues stream is read'
      )
      assert.equal(
        paths.includes('repos/acme/widgets'),
        true,
        'the repository itself is read for its default branch'
      )
      assert.equal(
        paths.includes('repos/acme/widgets/actions/runs'),
        true,
        'the default branch runs are read'
      )
      assert.equal(
        paths.includes(`repos/acme/widgets/commits/${SHA}/check-runs`),
        true,
        'the commit checks of the default branch head are read'
      )
    } finally {
      await h.cleanup()
    }
  })
})

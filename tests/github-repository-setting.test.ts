// 缺陷回归：在设置里填 GitHub 仓库 URL 之后，保存、设置读面、Source 页、部署检查与轮询必须
// 说的是同一个仓库，而且不要求重启插件。
//
// 三层断言（票面 acceptance）：
// - 写面：`settings.save` 把 `https://github.com/<owner>/<name>` 规范成 `owner/name` 并存库，
//   坏值整单拒绝且什么都不写；
// - 读面：Settings / Source / Deployment 三处读数一致，不再报 `repository_missing`；
// - 运行时：轮询器用规范后的 `owner/name` 调 `gh api`；下一次启动也从保存的块恢复。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBoot, settingsOf } from './support/boot.ts'
import { removeTree } from './support/state.ts'
import type { SettingsSaveOutcome } from '../src/panel/protocol'

/** 截图里的输入。 */
const URL = 'https://github.com/whutlichao/superagent-test'
/** 它能用于 GitHub API 的形态。 */
const REPOSITORY = 'whutlichao/superagent-test'
/** 一条点名 agent 的 Issue 号（新仓库里的）。 */
const ISSUE = 7

/** 一份没有配置仓库的设置（其余部分与 `settingsOf` 相同）：复现截图里的起点。 */
function withoutRepository(stateDir: string): Record<string, unknown> {
  return {
    ...settingsOf(stateDir),
    sources: { github: { enabled: true, config: { cli: 'gh', pollSeconds: 60 } } }
  }
}

/** 一条指向 `repository` 的通知（`gh api notifications` 的输出）。 */
function notificationOf(repository: string, issue: number): string {
  return JSON.stringify([
    {
      id: `notification-${issue}`,
      unread: true,
      reason: 'mention',
      updated_at: '2026-11-07T03:26:00Z',
      last_read_at: '2026-11-07T03:25:00Z',
      subject: {
        title: 'Fix the login redirect',
        url: `https://api.github.com/repos/${repository}/issues/${issue}`,
        type: 'Issue'
      },
      repository: { full_name: repository }
    }
  ])
}

/** 一条 Issue（`gh api repos/:owner/:name/issues/:n` 的输出）。 */
function issueOf(repository: string, issue: number): string {
  return JSON.stringify({
    number: issue,
    title: 'Fix the login redirect',
    state: 'open',
    body: 'Signing in bounces back to /login.',
    html_url: `https://github.com/${repository}/issues/${issue}`,
    created_at: '2026-11-07T03:20:00Z',
    updated_at: '2026-11-07T03:21:00Z',
    user: { login: 'alice', type: 'User' }
  })
}

/** 把新仓库的 `gh` 读取脚本化（先于 `openBoot` 的缺省脚本注册，因此优先命中）。 */
function scriptNewRepository(commands: {
  script(matcher: string | readonly string[], reply: string | (() => string)): unknown
}): void {
  commands.script('gh api notifications', () => notificationOf(REPOSITORY, ISSUE))
  commands.script(['api', `repos/${REPOSITORY}/issues/${ISSUE}`], () => issueOf(REPOSITORY, ISSUE))
  commands.script(['api', `repos/${REPOSITORY}/issues/${ISSUE}/comments`, '--paginate'], () => '[]')
}

/** 一次保存的结果必须成功；返回成功分支（失败时把原因带进断言消息）。 */
function accepted(outcome: SettingsSaveOutcome): Extract<SettingsSaveOutcome, { ok: true }> {
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  return outcome as Extract<SettingsSaveOutcome, { ok: true }>
}

test('saving a GitHub repository URL is normalised, applied at once, and reaches the runtime', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'superagent-github-repo-'))
  const h = await openBoot({
    stateDir,
    settings: withoutRepository(stateDir),
    scripts: scriptNewRepository
  })
  try {
    // 起点与截图一致：没有仓库，Source 卡与部署检查都报 repository_missing。
    const before = await h.handle.settingsView()
    const card = before.sources.instances.find((instance) => instance.id === 'github')
    assert.ok(card, 'the github Source is in the view')
    assert.equal(card.config['repository'], '')
    const startCard = h.handle.sources().items.find((item) => item.id === 'github')
    assert.equal(startCard?.problem?.code, 'repository_missing')
    assert.equal(h.handle.snapshot().health.setupMissing, true)
    assert.deepEqual(await h.handle.pollOnce(), { notifications: 0, triggers: 0, skipped: 0 })

    // 一个不是 GitHub 仓库的值：整单拒绝，什么都不写（相机能说清是哪个字段）。
    const refused = await h.handle.settingsSave({
      block: 'source:github',
      revision: card.revision,
      value: { enabled: true, config: { ...card.config, repository: 'https://gitlab.com/whutlichao/superagent-test' } }
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.ok === false ? refused.reason : 'ok', 'invalid')
    const issues = refused.ok === false && 'issues' in refused ? refused.issues : []
    assert.equal(
      issues.some((issue) => issue.path === 'config.repository'),
      true,
      `the refusal names the repository field: ${JSON.stringify(issues)}`
    )
    const stillEmpty = await h.handle.settingsView()
    assert.equal(
      stillEmpty.sources.instances.find((instance) => instance.id === 'github')?.config['repository'],
      '',
      'a refused save writes nothing'
    )

    // 截图里的 URL：保存成功，规范化成 owner/name，并且**不要求重启**。
    const saved = accepted(
      await h.handle.settingsSave({
        block: 'source:github',
        revision: card.revision,
        value: { enabled: true, config: { ...card.config, repository: URL } }
      })
    )
    assert.equal(saved.restarting, false, 'the GitHub Source configuration applies without a restart')

    // 设置读面：保存的是规范形态（面板下一次读到的就是它能用于 GitHub API 的值）。
    const after = await h.handle.settingsView()
    const savedCard = after.sources.instances.find((instance) => instance.id === 'github')
    assert.equal(savedCard?.config['repository'], REPOSITORY)

    // Source 页：问题消失，字段与派生事实都写规范形态。
    const github = h.handle.sources().items.find((item) => item.id === 'github')
    assert.equal(github?.problem, undefined, 'the Source page no longer reports repository_missing')
    assert.deepEqual(
      github?.fields.find((field) => field.key === 'repository')?.value,
      { type: 'text', text: REPOSITORY }
    )
    assert.deepEqual(
      github?.facts.find((fact) => fact.key === 'repository')?.value,
      REPOSITORY
    )

    // 部署检查：github 这一组不再有问题（状态栏也不再是「等 setup」）。
    assert.equal(
      h.handle.deployment().setup.some((issue) => issue.place === 'github'),
      false,
      JSON.stringify(h.handle.deployment().setup)
    )
    assert.equal(h.handle.snapshot().health.setupMissing, false)
    const health = h.handle.deployment().health.find((entry) => entry.name === 'github')
    assert.notEqual(health?.detail, 'repository_missing', 'health no longer carries the setup code')

    // 运行时：下一轮真的用规范后的 owner/name 读 GitHub。
    assert.deepEqual(await h.handle.pollOnce(), { notifications: 1, triggers: 0, skipped: 0 })
    assert.equal(
      h.commands.calls.some((call) =>
        call.args.join(' ').includes(`repos/${REPOSITORY}/issues/${ISSUE}`)
      ),
      true,
      `the poller reads the saved repository: ${JSON.stringify(h.commands.args)}`
    )
    assert.equal(
      h.commands.calls.some((call) => call.args.join(' ').includes('repos/https://github.com/')),
      false,
      'no GitHub API call ever carries the raw URL'
    )
  } finally {
    await h.cleanup()
    await removeTree(stateDir)
  }
})

test('a legacy raw URL already stored in the host settings is read as owner/name', async () => {
  // 旧版本把 URL 原样存下来过（或人直接写进了宿主设置）：启动路径也要归一，不能只修面板保存。
  const stateDir = mkdtempSync(join(tmpdir(), 'superagent-github-repo-legacy-'))
  const h = await openBoot({
    stateDir,
    settings: {
      ...settingsOf(stateDir),
      sources: { github: { enabled: true, config: { repository: URL, cli: 'gh', pollSeconds: 60 } } }
    },
    scripts: scriptNewRepository
  })
  try {
    const github = h.handle.sources().items.find((item) => item.id === 'github')
    assert.equal(github?.problem, undefined)
    assert.deepEqual(
      github?.fields.find((field) => field.key === 'repository')?.value,
      { type: 'text', text: REPOSITORY }
    )
    assert.deepEqual(await h.handle.pollOnce(), { notifications: 1, triggers: 0, skipped: 0 })
    assert.equal(
      h.commands.calls.some((call) =>
        call.args.join(' ').includes(`repos/${REPOSITORY}/issues/${ISSUE}`)
      ),
      true,
      `the poller reads the normalised repository: ${JSON.stringify(h.commands.args)}`
    )
  } finally {
    await h.cleanup()
    await removeTree(stateDir)
  }
})

test('a saved GitHub repository URL survives a restart and is used by the next boot', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'superagent-github-repo-restart-'))
  const first = await openBoot({
    stateDir,
    settings: withoutRepository(stateDir),
    scripts: scriptNewRepository
  })
  try {
    const view = await first.handle.settingsView()
    const card = view.sources.instances.find((instance) => instance.id === 'github')
    assert.ok(card)
    accepted(
      await first.handle.settingsSave({
        block: 'source:github',
        revision: card.revision,
        value: { enabled: true, config: { ...card.config, repository: URL } }
      })
    )
  } finally {
    // 只关进程，保留 stateDir：第二个实例要验证「下次启动从保存的块恢复」。
    await first.handle.shutdown()
    await removeTree(first.worktrees)
  }
  const second = await openBoot({
    stateDir,
    // 宿主设置仍然是「没有仓库」：仓库只能来自保存过的 `source:github` 块。
    settings: withoutRepository(stateDir),
    scripts: scriptNewRepository
  })
  try {
    const github = second.handle.sources().items.find((item) => item.id === 'github')
    assert.equal(github?.problem, undefined)
    assert.deepEqual(
      github?.facts.find((fact) => fact.key === 'repository')?.value,
      REPOSITORY
    )
    assert.deepEqual(await second.handle.pollOnce(), { notifications: 1, triggers: 0, skipped: 0 })
    assert.equal(
      second.commands.calls.some((call) =>
        call.args.join(' ').includes(`repos/${REPOSITORY}/issues/${ISSUE}`)
      ),
      true
    )
  } finally {
    await second.cleanup()
    await removeTree(stateDir)
  }
})

// 缺陷回归：`gitconfig_missing` 要求人设置 `githubCommitEmail`，但仓库里没有任何设置入口——
// 清单只有四项宿主设置，面板 Execution 组没有这一格，`executor` 块也不收这个键。
//
// 本票修的是真实配置链路（不是把提示改软）：提交邮箱成为 `executor` 块的一个字段，保存之后
// 运行时部署检查、worker 的 git 配置与下一次 launch 的环境段都读同一份值；块存在库里，所以
// 重启后仍然有效。验证分四层：
// - 读面：Settings 的 Execution 组给出这一格（空串表示还没配）；
// - 写面：面板保存这个字段成功（旧形状 strict，会整单拒绝）；
// - 运行时：保存那一次就按新身份重写 `<stateDir>/worker-gitconfig`，部署检查的问题消失；
// - 重启与环境：再启动一次仍从保存的块恢复；worker 的 `env.sh` 拿到同一个邮箱。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBoot, settingsOf } from './support/boot.ts'
import { removeTree } from './support/state.ts'
import { workerGitConfigPath } from '../src/worker/infra/gitconfig.ts'
import { dispatch } from '../src/worker/cli/commands.ts'
import { parseArgs } from '../src/worker/cli/io.ts'
import { readApiToken } from '../src/worker/infra/tokens.ts'
import type { SettingsSaveOutcome } from '../src/panel/protocol'

/** agent 账号的 noreply 地址（GitHub 的 `<id>+<login>@users.noreply.github.com` 形式）。 */
const EMAIL = '1234567+acme-agent@users.noreply.github.com'

/** 一份**没有**提交邮箱的设置：复现「提示要求设置、但哪里都配不了」的起点。 */
function withoutCommitEmail(stateDir: string): Record<string, unknown> {
  const settings = { ...settingsOf(stateDir) }
  delete settings['githubCommitEmail']
  return settings
}

/** 一次保存必须成功；失败时把原因带进断言消息。 */
function accepted(outcome: SettingsSaveOutcome): Extract<SettingsSaveOutcome, { ok: true }> {
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  return outcome as Extract<SettingsSaveOutcome, { ok: true }>
}

/** 工单 worktree 的 `env.sh`（下一次 launch 注入 worker 的环境）。 */
function envFileOf(h: Awaited<ReturnType<typeof openBoot>>): string {
  const workspace = h.runtime.workspaces.find((row) => !row.name.includes('router'))
  assert.ok(workspace, 'a ticket worktree was created')
  return join(workspace.path, '.superagent', 'env.sh')
}

test('the commit email is a real settings entry, and saving it fixes the deployment check at once', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'superagent-commit-email-'))
  const h = await openBoot({ stateDir, settings: withoutCommitEmail(stateDir) })
  try {
    // 起点：部署检查报 gitconfig_missing，修法必须指向真实设置入口。
    const before = h.handle.deployment().setup.find((issue) => issue.code === 'gitconfig_missing')
    assert.ok(before, 'the deployment check reports the missing commit identity')
    assert.match(before.fix, /githubCommitEmail/)
    assert.match(before.fix, /Execution/, 'the fix names the panel group that carries the field')
    assert.match(before.fix, /Settings/, 'and says where that group lives')

    // 读面：Settings 的 Execution 组有这一格，还没配时是空串（不默认成任何人的邮箱）。
    const view = await h.handle.settingsView()
    assert.equal(view.execution.value.githubCommitEmail, '', 'nothing is defaulted')

    // 写面：这一格走同一条 `settings.save`（旧形状 strict，会把未知键整单拒绝——那正是
    // 「没有入口」的机器面）。保存只要改它，不要求重启。
    const saved = accepted(
      await h.handle.settingsSave({
        block: 'executor',
        revision: view.execution.revision,
        value: { ...view.execution.value, githubCommitEmail: EMAIL }
      })
    )
    assert.equal(saved.restarting, false, 'the commit email is read live, not at boot')

    // 运行时部署检查：保存这一次就把 `<stateDir>/worker-gitconfig` 按新身份重写了一遍
    // （`gitConfigWriteIssue` 也随之清空），问题消失——不必再点一次「检查一次」。
    assert.equal(
      h.handle.deployment().setup.some((issue) => issue.code === 'gitconfig_missing'),
      false,
      JSON.stringify(h.handle.deployment().setup)
    )
    const path = workerGitConfigPath(stateDir)
    assert.equal(existsSync(path), true, 'the save writes the worker git config')
    const text = readFileSync(path, 'utf8')
    assert.ok(text.includes(`email = "${EMAIL}"`), 'the configured email is the commit email')
    assert.ok(text.includes('name = "acme-agent"'), 'the account still comes from the gh probe')

    // 运行时部署事实：下一次 launch 的 env.sh 用同一个邮箱（不是启动时的旧快照）。
    await h.handle.pollOnce()
    await h.handle.passOnce()
    await h.handle.passOnce()
    await h.handle.passOnce()
    const env = readFileSync(envFileOf(h), 'utf8')
    assert.ok(
      env.includes(`export DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL='${EMAIL}'`),
      `the worker environment carries the saved email: ${env}`
    )
  } finally {
    await h.cleanup()
    await removeTree(stateDir)
  }
})

test('the saved commit email survives a restart and the next boot writes the same identity', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'superagent-commit-email-restart-'))
  const first = await openBoot({ stateDir, settings: withoutCommitEmail(stateDir) })
  try {
    const view = await first.handle.settingsView()
    accepted(
      await first.handle.settingsSave({
        block: 'executor',
        revision: view.execution.revision,
        value: { ...view.execution.value, githubCommitEmail: EMAIL }
      })
    )
    // 下一次启动：宿主设置里仍然没有这一项，值只能来自保存过的 `executor` 块。
  } finally {
    await first.handle.shutdown()
    await removeTree(first.worktrees)
  }
  const second = await openBoot({ stateDir, settings: withoutCommitEmail(stateDir) })
  try {
    const view = await second.handle.settingsView()
    assert.equal(
      view.execution.value.githubCommitEmail,
      EMAIL,
      'the saved block is the value in force after a restart'
    )
    assert.equal(
      second.handle.deployment().setup.some((issue) => issue.code === 'gitconfig_missing'),
      false,
      'the restarting deployment check reads the saved email'
    )
    const text = readFileSync(workerGitConfigPath(stateDir), 'utf8')
    assert.ok(
      text.includes(`email = "${EMAIL}"`),
      'the next boot writes the saved address into the worker git config'
    )
  } finally {
    await second.cleanup()
    await removeTree(stateDir)
  }
})

test('the commit email is a setup field: CLI saves cannot change it', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'superagent-commit-email-origin-'))
  const h = await openBoot({ stateDir })
  try {
    const port = h.handle.port()
    assert.notEqual(port, null)
    // 走 CLI（origin=tool）写这一格：服务端固定拒绝，什么都不写。
    const refused = await dispatch({
      parsed: parseArgs([
        'settings',
        'save',
        '--block',
        'executor',
        '--revision',
        '0',
        '--value',
        '-'
      ]),
      stdin: async () => JSON.stringify({ githubCommitEmail: EMAIL }),
      target: {
        stateDir: h.stateDir,
        stateDirSource: 'argument' as const,
        port: port as number,
        baseUrl: `http://127.0.0.1:${port}/superagent/api`,
        token: readApiToken(h.stateDir),
        tokenSource: 'argument' as const,
        tokenFile: null
      },
      sleep: async () => undefined
    })
    assert.equal(refused.exit, 2, JSON.stringify(refused.envelope))
    assert.equal(
      (refused.envelope as { error?: { code?: string } }).error?.code,
      'origin_forbidden',
      'the commit email is a setup field (§K.8)'
    )
    // 什么都没写：读面仍是启动时那份（旧安装的宿主设置落点），不是这次想写的值。
    const after = (await h.handle.settingsView()).execution.value.githubCommitEmail
    assert.notEqual(after, EMAIL, 'the refused save wrote nothing')
    assert.deepEqual(h.handle.settingsHistory().history, [], 'and recorded no version')
  } finally {
    await h.cleanup()
    await removeTree(stateDir)
  }
})

test('a write that fails is named, and Check again reads the saved email once it can write', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'superagent-commit-email-check-'))
  // 路径被同名目录占住：保存这一次写不出文件，但保存本身已经提交（设置是库里的）。
  mkdirSync(workerGitConfigPath(stateDir), { recursive: true })
  const h = await openBoot({ stateDir, settings: withoutCommitEmail(stateDir) })
  try {
    const view = await h.handle.settingsView()
    const saved = accepted(
      await h.handle.settingsSave({
        block: 'executor',
        revision: view.execution.revision,
        value: { ...view.execution.value, githubCommitEmail: EMAIL }
      })
    )
    assert.equal(saved.restarting, false)
    // 写不进去是一条具名问题（broken），身份本身已不再是 missing。
    const setup = h.handle.deployment().setup
    assert.equal(setup.some((issue) => issue.code === 'gitconfig_missing'), false, JSON.stringify(setup))
    assert.equal(setup.some((issue) => issue.code === 'gitconfig_unwritable'), true, JSON.stringify(setup))

    // 人清掉挡路的目录，点一次「检查一次」：探针读到的是保存过的邮箱（不是宿主设置的旧快照）。
    rmSync(workerGitConfigPath(stateDir), { recursive: true, force: true })
    const checked = await h.handle.checkSetup()
    assert.equal(checked.checked, true, 'there was a problem to re-check')
    assert.equal(checked.issues.some((issue) => issue.code.startsWith('gitconfig')), false, JSON.stringify(checked.issues))
    const text = readFileSync(workerGitConfigPath(stateDir), 'utf8')
    assert.ok(text.includes(`email = "${EMAIL}"`), 'the re-run check uses the saved email')
  } finally {
    await h.cleanup()
    await removeTree(stateDir)
  }
})

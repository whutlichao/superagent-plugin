// Settings 页的 worker 面（§M.3、§K.8）：读四个可编辑组、以 panel 来源保存一个块、读历史。
//
// 断言面是组合根的 `BootHandle`（真库 + 假 Orca 缝 + 假 CLI）：
// - 读面：Source 的字段表/事实、Policy 的名单与准入行、executor 的值、四个机器限额；
// - 写面：Policy 保存立刻生效（`restarting: false`），启动时读的块标「重启后生效」；
// - 账号类字段：保存前跑 #44 的探针，失败返回字段级 issues 且**什么都不写**（§K.8 的原话）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBoot } from './support/boot.ts'
import { cliFailure } from './support/fake-commands.ts'
import { removeTree } from './support/state.ts'

/** 一份可保存的 Policy 值（github 的公共三键；accept mode 改成 auto）。 */
function policyValue(): Record<string, unknown> {
  return {
    rules: [],
    acceptMode: 'auto',
    eval: { timeoutSeconds: 300 },
    sources: { github: { allowed: [{ id: 'alice' }], bots: [], admission: {} } }
  }
}

test('the settings view carries the Source fields, the policy sections and the machine limits', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'superagent-settings-view-'))
  const harness = await openBoot({ stateDir })
  try {
    const view = await harness.handle.settingsView()
    // Sources：一张 github 卡，带 kind 的字段表、真实的配置值与只读事实。
    const github = view.sources.instances.find((card) => card.id === 'github')
    assert.ok(github, 'the github Source is in the view')
    assert.deepEqual(github.block, 'source:github')
    assert.equal(['starting', 'ready'].includes(github.state), true, `github state: ${github.state}`)
    assert.equal(github.enabled, true)
    assert.deepEqual(github.config['repository'], 'acme/widgets')
    const fieldKeys = github.fields.map((field) => field.key)
    for (const key of ['repository', 'cli', 'observeIssues', 'pollSeconds']) {
      assert.equal(fieldKeys.includes(key), true, `the ${key} field comes from the kind`)
    }
    assert.equal(
      github.facts.some((fact) => fact.key === 'repository'),
      true,
      'the deployment facts are read-only rows on the card'
    )
    // Eval：Policy 的名单与准入行（availability 来自该行是否 observe）。
    const section = view.eval.sources.find((source) => source.source === 'github')
    assert.ok(section, 'the github policy section is in the view')
    assert.deepEqual(section.values['allowed'], [{ id: 'alice' }])
    const issues = section.admission.find((row) => row.id === 'issues')
    assert.ok(issues, 'the issues admission row')
    const listed = issues.cells.find((cell) => cell.cell === 'listedUnaddressed')
    const addressed = issues.cells.find((cell) => cell.cell === 'unlistedAddressed')
    assert.equal(listed?.available, false, 'not observing means the unaddressed cell is unavailable')
    assert.equal(addressed?.available, true, 'the addressed cell is always available')
    // 不可用的格子按「不看」读（配置值留给以后打开 receive-all 时用，§K.1）。
    assert.equal(listed?.value, 'ignore', 'an unavailable cell reads as ignore')
    assert.equal(listed?.default, 'inferred', 'its configured default stays visible')
    // Execution：executor 的值、base repo 的选择项与 prepare 的变量表。
    assert.equal(view.execution.value.agent, 'pi')
    assert.equal(view.execution.value.maxWorkers, 2)
    assert.equal(
      view.execution.repos.some((repo) => repo.value === 'path:/repos/widgets'),
      true,
      'orca repo list is mirrored for the base repo select'
    )
    assert.equal(view.execution.variables.includes('DSH_SUPERAGENT_DIR'), true)
    // Deployment：四个机器限额的缺省值。
    assert.deepEqual(view.limits.value, {
      promptMaxChars: 200_000,
      admissionContextMaxPages: 10,
      admissionContextTimeoutMs: 15_000,
      retentionDays: 90
    })
    assert.equal(view.limits.saved, null)
  } finally {
    await harness.cleanup()
  }
  await removeTree(stateDir)
})

test('a panel save records the version: the policy applies at once, the startup blocks ask for a restart', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'superagent-settings-save-'))
  const harness = await openBoot({ stateDir })
  try {
    const policy = await harness.handle.settingsSave({
      block: 'policy',
      revision: 0,
      value: policyValue()
    })
    assert.equal(policy.ok, true)
    if (policy.ok) {
      assert.equal(policy.changed, true)
      assert.equal(policy.restarting, false, 'the policy block takes effect at once (§K.5)')
      assert.equal(policy.policyChanged, true)
      assert.equal(policy.origin, 'panel', 'the panel cannot choose another origin')
    }
    const afterPolicy = await harness.handle.settingsView()
    assert.equal(
      afterPolicy.eval.saved?.revision,
      policy.ok ? policy.revision : -1,
      JSON.stringify(harness.handle.settingsHistory())
    )
    assert.equal(afterPolicy.eval.acceptMode, 'auto', 'the saved policy is the one in force')
    assert.match(afterPolicy.eval.policyVersion, /^[0-9a-f]{12}$/)

    const executor = await harness.handle.settingsSave({
      block: 'executor',
      revision: 0,
      value: { agent: 'pi', maxWorkers: 3, model: '', branchPrefix: 'agent/' }
    })
    assert.equal(executor.ok, true)
    if (executor.ok) {
      assert.equal(executor.restarting, true, 'the executor block is read at boot (§H.12)')
      assert.equal(executor.policyChanged, false)
    }
    const afterExecutor = await harness.handle.settingsView()
    assert.equal(afterExecutor.execution.value.maxWorkers, 3, 'the editor reads back the saved value')
    assert.equal(
      afterExecutor.execution.saved?.revision,
      executor.ok ? executor.revision : -1,
      JSON.stringify(harness.handle.settingsHistory())
    )

    // 历史：新→旧，带每一版的值；Policy 那一版带内容哈希（没有未结束工单时受影响名单为空）。
    const history = harness.handle.settingsHistory()
    assert.deepEqual(
      history.history.map((row) => [row.block, row.origin]),
      [
        ['executor', 'panel'],
        ['policy', 'panel']
      ]
    )
    const policyRow = history.history.find((row) => row.block === 'policy')
    assert.equal(policyRow?.policyVersion, afterPolicy.eval.policyVersion)
    assert.deepEqual(policyRow?.affectedTickets, [])
  } finally {
    await harness.cleanup()
  }
  await removeTree(stateDir)
})

test('an account-field save that fails the setup check is refused with issues and writes nothing', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'superagent-settings-account-'))
  // 探针读不到账号：与「人还没 gh auth login」同一个失败面。
  const harness = await openBoot({
    stateDir,
    scripts: (commands) => {
      commands.script('gh api user', () => {
        throw cliFailure('gh', { stderr: 'not logged in' })
      })
    }
  })
  try {
    const before = await harness.handle.settingsView()
    const card = before.sources.instances.find((instance) => instance.id === 'github')
    assert.ok(card)
    const refusal = await harness.handle.settingsSave({
      block: 'source:github',
      revision: card.revision,
      value: { enabled: true, config: { ...card.config, cli: 'gh-agent' } }
    })
    assert.equal(refusal.ok, false)
    if (!refusal.ok) {
      assert.equal(refusal.reason, 'invalid', 'a failed account check is a field-level refusal (400)')
      if (refusal.reason === 'invalid') {
        assert.equal(refusal.issues.length > 0, true, 'the probe names what is wrong')
      }
    }
    // 全有或全无：没有版本、没有历史、块修订号仍是 0。
    assert.deepEqual(harness.handle.settingsHistory().history, [])
    const after = await harness.handle.settingsView()
    assert.equal(after.sources.instances.find((instance) => instance.id === 'github')?.revision, 0)
    assert.equal(after.revision, 0)

    // 原值（没改账号字段）照常能存：检查只在字段**变更**时跑。
    const unchanged = await harness.handle.settingsSave({
      block: 'source:github',
      revision: 0,
      value: { enabled: true, config: card.config }
    })
    assert.equal(unchanged.ok, true)
  } finally {
    await harness.cleanup()
  }
  await removeTree(stateDir)
})

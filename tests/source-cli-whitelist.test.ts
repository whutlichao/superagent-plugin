// 缺陷回归（#73）：Source 的 `cli` 指向**绝对路径的包装脚本**时，保存与运行都必须真的走通，
// 而未配置的绝对路径仍然被白名单拒绝。
//
// 三层断言（票面 acceptance）：
// - 写面：`settings.save` 的写前账号检查按**候选** `cli` 跑，因此第一次从裸名切到绝对路径
//   就能存下（`configuredPrograms()` 用的是当前配置，不含候选值时会回 `account_unreadable`）；
// - 拒面：另一个哪儿都没配置的绝对路径仍在写前检查里被拒（`not inside a configured CLI`），
//   白名单没有被放松成「任意绝对路径」；
// - 运行时：保存之后 Source 轮询真的用那个脚本（`github` health 走到 `ready`，账号是脚本给的
//   那个），所以白名单不许只修在 setup 探针那一处。
//
// 这里**故意不注入 `FakeCommands`**：缺陷就在真命令端口的白名单上，换掉端口等于把 bug 藏起来。
// `gh` 因此被换成本地包装脚本（写进临时目录），其余探针只跑本机的 `git --version`。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootPlugin } from '../src/worker/boot.ts'
import { openBoot, settingsOf, type BootHarness } from './support/boot.ts'

/** 包装脚本给出的账号（真实部署里是 `superagent-bot-1106[bot]` 那样的机器人身份）。 */
const BOT_LOGIN = 'superagent-bot-1106[bot]'

/** 一个 `gh` 包装脚本：记下每次调用，按子命令给出账号或一条空的通知流。 */
interface Wrapper {
  /** 脚本的绝对路径（就是将来存进 `source:github` 的 `cli`）。 */
  readonly path: string
  /** 调用日志（一行一次，脚本自己写）。 */
  readonly log: string
  /** 脚本被调用过的命令行（读不到日志时是空数组）。 */
  calls(): string[]
}

/**
 * 在 `directory` 里造一个包装脚本。它比真 `gh` 简单得多：`api user` 回账号，
 * `notifications` 回空数组，其余回 `{}`——正好覆盖本票要经过的两条路径（setup 探针与轮询）。
 */
function wrapperIn(directory: string, name: string, login: string = BOT_LOGIN): Wrapper {
  const path = join(directory, name)
  const log = join(directory, `${name}.calls`)
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${log}'`,
      'case "$*" in',
      `  'api user'*) printf '%s\\n' '${login}' ;;`,
      '  *notifications*) printf \'[]\\n\' ;;',
      '  *) printf \'{}\\n\' ;;',
      'esac',
      ''
    ].join('\n'),
    { mode: 0o755 }
  )
  return {
    path,
    log,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((line) => line !== '') : [])
  }
}

/** 一份把 GitHub Source 的 `cli` 换成 `cli` 的设置（其余与夹具的缺省设置相同）。 */
function settingsWithGithubCli(stateDir: string, cli: string): Record<string, unknown> {
  const base = settingsOf(stateDir)
  const sources = base['sources'] as Record<string, { enabled: boolean; config: Record<string, unknown> }>
  const github = sources['github']
  return {
    ...base,
    sources: { ...sources, github: { enabled: true, config: { ...github.config, cli } } }
  }
}

/**
 * 起一次**真命令端口**的组合根：`options.commands` 不注入，`Commands` 因此按 boot 自己的
 * `configuredPrograms()` 判定路径白名单——缺陷与修复都只在这里可见。
 */
async function openRealPortBoot(stateDir: string, cli: string): Promise<BootHarness> {
  return openBoot({
    stateDir,
    settings: settingsWithGithubCli(stateDir, cli),
    boot: (directory, runtime) =>
      bootPlugin({
        runtime,
        readSettings: async () => settingsWithGithubCli(directory, cli),
        stateDir: directory,
        preferredPort: 0,
        disableTimers: true
      })
  })
}

/** `source:github` 卡片现在的修订号（面板保存要它）。 */
async function githubRevision(h: BootHarness): Promise<number> {
  const view = await h.handle.settingsView()
  const instance = view.sources.instances.find((candidate) => candidate.id === 'github')
  assert.ok(instance, 'the GitHub Source is in the view')
  return instance.revision
}

/** Source 页上 `github` 那一张卡。 */
function githubCard(h: BootHarness): ReturnType<BootHarness['handle']['sources']>['items'][number] {
  const card = h.handle.sources().items.find((item) => item.id === 'github')
  assert.ok(card, 'the GitHub Source is on the Source page')
  return card
}

/** 一次保存的结果：失败时把整份结果带进断言消息（`issues` 里有白名单的原文）。 */
function accepted(outcome: Awaited<ReturnType<BootHarness['handle']['settingsSave']>>): void {
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
}

/** 一次保存必须被**字段级**拒绝；返回那条分支（`issues` 里有探针的原文）。 */
function refused(
  outcome: Awaited<ReturnType<BootHarness['handle']['settingsSave']>>
): Extract<NonNullable<typeof outcome>, { reason: 'invalid' }> {
  assert.equal(outcome.ok, false, JSON.stringify(outcome))
  if (outcome.ok || outcome.reason !== 'invalid') {
    throw new Error(`expected an invalid-value refusal, got ${JSON.stringify(outcome)}`)
  }
  return outcome
}

test('boot probes the CLI the Source is actually configured with', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'superagent-cli-'))
  const stateDir = mkdtempSync(join(tmpdir(), 'superagent-cli-state-'))
  const configured = wrapperIn(directory, 'gh-configured', 'configured-bot[bot]')
  const h = await openRealPortBoot(stateDir, configured.path)
  try {
    // 启动的 setup 探针读的就是 `source:github` 的 `cli`：白名单用的是**现配置**，不是那个
    // 从未声明的宿主 `githubCli` 键（`text(undefined)` → 名单恒为 `[undefined]`，一切拒绝）。
    assert.ok(
      configured.calls().includes('api user --jq .login'),
      `the boot probe ran the configured CLI, calls: ${JSON.stringify(configured.calls())}`
    )
    const card = githubCard(h)
    assert.equal(card.problem, undefined, JSON.stringify(card.problem))
    assert.deepEqual(card.facts.find((fact) => fact.key === 'account')?.value, 'configured-bot[bot]')
  } finally {
    await h.cleanup()
    rmSync(directory, { recursive: true, force: true })
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a Source CLI at an absolute path is saved, then used by the poller', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'superagent-cli-'))
  const stateDir = mkdtempSync(join(tmpdir(), 'superagent-cli-state-'))
  // 起点：已经配置好的那个包装脚本（boot 的 setup 探针就走它，测试因此不碰真 `gh`）。
  const configured = wrapperIn(directory, 'gh-configured', 'configured-bot[bot]')
  // 本次要保存的候选：第一次从裸名/另一个路径切过来的那个绝对路径。
  const candidate = wrapperIn(directory, 'gh-superagent-bot')
  const h = await openRealPortBoot(stateDir, configured.path)
  try {
    const revision = await githubRevision(h)
    const outcome = await h.handle.settingsSave({
      block: 'source:github',
      revision,
      value: { enabled: true, config: { repository: 'acme/widgets', cli: candidate.path, pollSeconds: 60 } }
    })
    // 写前账号检查按候选 `cli` 跑：候选路径因此必须已经在白名单里（否则这里回 setup_failed）。
    accepted(outcome)

    // 候选脚本真的被跑过（不是「白名单放行了但没读账号」）。
    assert.ok(
      candidate.calls().includes('api user --jq .login'),
      `the write-time account check ran the candidate CLI, calls: ${JSON.stringify(candidate.calls())}`
    )

    // 保存即生效：下一轮轮询用新脚本，账号是它给出的那个，health 走到 ready。
    const saved = githubCard(h)
    assert.deepEqual(
      saved.fields.find((field) => field.key === 'cli')?.value,
      { type: 'text', text: candidate.path }
    )
    assert.deepEqual(saved.facts.find((fact) => fact.key === 'account')?.value, BOT_LOGIN)

    const round = await h.handle.pollOnce()
    assert.equal(round.notifications, 0, JSON.stringify(round))
    assert.ok(
      candidate.calls().some((call) => call.includes('notifications')),
      `the poller ran the saved CLI, calls: ${JSON.stringify(candidate.calls())}`
    )
    const polling = githubCard(h)
    assert.equal(polling.state, 'ready', JSON.stringify(polling.health))
    assert.deepEqual(polling.facts.find((fact) => fact.key === 'account')?.value, BOT_LOGIN)
  } finally {
    await h.cleanup()
    rmSync(directory, { recursive: true, force: true })
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('saving a Source CLI does not widen the allowlist: relative paths and bare names are still refused', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'superagent-cli-'))
  const stateDir = mkdtempSync(join(tmpdir(), 'superagent-cli-state-'))
  const configured = wrapperIn(directory, 'gh-configured', 'configured-bot[bot]')
  const h = await openRealPortBoot(stateDir, configured.path)
  try {
    const revision = await githubRevision(h)
    /** 用一个候选 `cli` 保存一次（预期被写前检查拒掉）。 */
    const refusedCli = async (cli: string) =>
      refused(
        await h.handle.settingsSave({
          block: 'source:github',
          revision,
          value: { enabled: true, config: { repository: 'acme/widgets', cli, pollSeconds: 60 } }
        })
      )
    // 相对路径：候选也得是绝对路径。
    assert.match(JSON.stringify((await refusedCli('local/bin/gh-stranger')).issues), /must be absolute/)
    // 裸名：只认 `ALLOWED_PROGRAMS` 里的五个，`gh-agent` 这种包装脚本名照样拒（不放松白名单）。
    assert.match(
      JSON.stringify((await refusedCli('gh-agent')).issues),
      /not one of the allowed programs/
    )
    // 被拒的保存一行都不写：修订号还是刚才那个。
    assert.equal(await githubRevision(h), revision)
  } finally {
    await h.cleanup()
    rmSync(directory, { recursive: true, force: true })
    rmSync(stateDir, { recursive: true, force: true })
  }
})

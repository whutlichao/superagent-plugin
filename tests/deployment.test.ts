// 部署解析与 setup 探针（§N.1、§N.2、§I.4、§H.11、§O；设计 §P.2 的 `deployment.test.ts`）。
//
// 这一套断言的是「一次只告诉人缺什么」：每个探针一条用例，结论只有「有没有问题」，
// 绝不含 token、密钥或消息正文；setup 问题把对应部件留在 `starting`/`setup`，不写成 `error`。
//
// 外部世界全部注入：CLI 用脚本化的 runner（绝不真登录、真联网），仓库与 ref 用注入的
// 列表，stateDir 用临时目录（§P.1：真库/真目录，不 mock 内部层）。
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { runSetupChecks } from '../src/worker/app/setup'
import type { SetupCheckInput, SetupReport } from '../src/worker/app/setup'
import { DeadlineError } from '../src/worker/infra/deadline'
import { runDoctor } from '../src/worker/app/doctor'
import { GITCONFIG_MODE, workerGitConfigPath } from '../src/worker/infra/gitconfig'
import { bootPlugin } from '../src/worker/boot'
import { dispatch } from '../src/worker/cli/commands'
import { parseArgs, render } from '../src/worker/cli/io'
import { readApiToken } from '../src/worker/infra/tokens'
import { openBoot, settingsOf } from './support/boot'
import { openStore } from '../src/worker/app/store'
import { tempStateDir } from './support/state'

/** 一个被记录的 CLI 调用（断言「探针真的问了 CLI」与「没问多余的东西」）。 */
interface Ran {
  readonly program: string
  readonly args: readonly string[]
}

/** 跑一条指向 boot 服务器的 CLI 命令（真的 loopback HTTP，§P.1）。 */
async function runCli(stateDir: string, port: number, argv: readonly string[]) {
  return dispatch({
    parsed: parseArgs(argv),
    target: {
      stateDir,
      stateDirSource: 'argument' as const,
      port,
      baseUrl: `http://127.0.0.1:${port}/superagent/api`,
      token: readApiToken(stateDir),
      tokenSource: 'argument' as const,
      tokenFile: null
    },
    sleep: async () => undefined
  })
}

/** 一份「什么配置都齐、什么都查得到」的输入；每个用例只改它关心的一两项。 */
function inputOf(stateDir: string, overrides: Partial<SetupCheckInput> = {}): SetupCheckInput {
  return {
    stateDir,
    agent: 'pi',
    baseRepo: { path: '/repos/widgets' },
    repository: 'acme/widgets',
    githubCli: 'gh',
    ...overrides
  }
}

/** 一次跑探针：CLI、仓库、ref 都给确定的假结果（缺口用 `fail` 注入）。 */
async function checksOf(
  stateDir: string,
  options: {
    readonly overrides?: Partial<SetupCheckInput>
    readonly fail?: readonly string[]
    readonly login?: string
    readonly repos?: readonly { id: string; path: string; name: string }[]
    readonly refs?: readonly string[]
  } = {}
) {
  const ran: Ran[] = []
  const run = async (program: string, args: readonly string[]): Promise<string> => {
    ran.push({ program, args })
    const key = [program, ...args].join(' ')
    if (options.fail?.includes(key) === true) {
      const error = new Error(`${program} is not available`)
      Object.assign(error, { code: 'ENOENT' })
      throw error
    }
    if (program === 'gh' && args[0] === 'api' && args[1] === 'user') return `${options.login ?? 'acme-agent'}\n`
    if (program === 'git') return 'git version 2.39.0\n'
    if (program === 'lark-cli') return JSON.stringify({ identities: { bot: { status: 'ready' } } })
    throw new Error(`unexpected program ${program}`)
  }
  const report = await runSetupChecks({
    ...inputOf(stateDir, options.overrides),
    ports: {
      isAbsolute: (path) => path.startsWith('/'),
      writable: () => undefined,
      run,
      repos: async () => options.repos ?? [{ id: 'repo-1', path: '/repos/widgets', name: 'widgets' }],
      searchRefs: async (_selector, query) => (options.refs ?? ['main']).filter((ref) => ref.includes(query))
    }
  })
  return { report, ran }
}

/** 某一项的结论（没有就是 undefined，用 `assert.equal(..., undefined)` 断言「没问题」）。 */
function issueOf(report: SetupReport, code: string) {
  return report.issues.find((issue) => issue.code === code)
}

describe('the setup probes tell a person one missing thing at a time', () => {
  test('a complete deployment has no setup issue at all', async () => {
    const stateDir = tempStateDir()
    try {
      const { report, ran } = await checksOf(stateDir)
      assert.deepEqual(report.issues, [])
      assert.equal(report.githubLogin, 'acme-agent')
      // 只问了真正需要的两个 CLI：git 在不在、agent 账号能不能读；没有多余的 gh 调用。
      assert.deepEqual(
        ran.map((call) => [call.program, ...call.args]),
        [
          ['git', '--version'],
          ['gh', 'api', 'user', '--jq', '.login']
        ]
      )
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test('a ready deployment writes the worker git config; an unfinished identity is a named issue', async () => {
    const stateDir = tempStateDir()
    try {
      const email = '1+acme-agent@users.noreply.github.com'
      const { report } = await checksOf(stateDir, { overrides: { gitConfig: { email } } })
      assert.deepEqual(report.issues, [])
      const path = workerGitConfigPath(stateDir)
      assert.equal(existsSync(path), true, 'the setup check really writes the file')
      assert.equal(statSync(path).mode & 0o777, GITCONFIG_MODE, 'mode 0600')
      const text = readFileSync(path, 'utf8')
      assert.ok(text.includes(email), 'the commit email comes from the deployment')
      assert.ok(text.includes('acme-agent'), 'the account comes from the probed gh login')
      assert.equal(text.includes('ghp_'), false, 'no token is ever written')

      // 身份不完整：不写文件（宁可回落到操作者环境），并给一条具名问题。
      rmSync(path)
      const unfinished = await checksOf(stateDir, { overrides: { gitConfig: { email: '   ' } } })
      const missing = issueOf(unfinished.report, 'gitconfig_missing')
      assert.equal(missing?.place, 'executor')
      assert.equal(missing?.kind, 'missing')
      assert.equal(existsSync(path), false, 'a partial identity writes nothing')

      // 路径被占用、写不进去：broken（有原因），而不是静默。
      mkdirSync(path, { recursive: true })
      const blocked = await checksOf(stateDir, { overrides: { gitConfig: { email } } })
      const unwritable = issueOf(blocked.report, 'gitconfig_unwritable')
      assert.equal(unwritable?.place, 'executor')
      assert.equal(unwritable?.kind, 'broken')
      assert.ok(unwritable?.detail.includes(path), 'the path is not a secret (§N.5)')
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test('the state directory must be absolute and writable', async () => {
    const stateDir = tempStateDir()
    try {
      const relative = await runSetupChecks({
        ...inputOf('state'),
        ports: {
          isAbsolute: () => false,
          writable: () => undefined,
          run: async () => '',
          repos: async () => [{ id: 'r', path: '/repos/widgets', name: 'widgets' }]
        }
      })
      const issue = issueOf(relative, 'state_dir_relative')
      assert.ok(issue !== undefined, 'a relative stateDir is a named setup issue')
      assert.equal(issue.place, 'state')
      assert.equal(issue.checkAgain.length > 0, true, 'every issue carries the check-again path')
      assert.equal(issue.fix.length > 0, true, 'every issue carries a one-line fix')  // eslint 自检：issue 非空已断言

      const unwritable = await runSetupChecks({
        ...inputOf(stateDir),
        ports: {
          isAbsolute: () => true,
          writable: () => {
            throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
          },
          run: async () => '',
          repos: async () => [{ id: 'r', path: '/repos/widgets', name: 'widgets' }]
        }
      })
      assert.equal(issueOf(unwritable, 'state_dir_unwritable')?.place, 'state')
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test('an empty agent id, a blank model field and a missing git are named separately', async () => {
    const stateDir = tempStateDir()
    try {
      const { report } = await checksOf(stateDir, {
        fail: ['git --version'],
        overrides: { agent: '   ', model: '  ' }
      })
      const agent = issueOf(report, 'agent_missing')
      assert.equal(agent?.place, 'executor')
      assert.equal(agent?.kind, 'missing')
      assert.equal(issueOf(report, 'model_missing')?.kind, 'missing')
      const git = issueOf(report, 'git_missing')
      assert.equal(git?.place, 'executor')
      assert.equal(git?.kind, 'missing')
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test('a base repository must exist in `orca repo list`', async () => {
    const stateDir = tempStateDir()
    try {
      const unset = await checksOf(stateDir, { overrides: { baseRepo: undefined } })
      const missing = issueOf(unset.report, 'base_repo_missing')
      assert.equal(missing?.kind, 'missing')
      assert.equal(missing?.place, 'executor')

      // 设置里有、Orca 里没有：同一个码，但 detail 指出选择器。
      const unknown = await checksOf(stateDir, {
        overrides: { baseRepo: { path: '/repos/elsewhere' } },
        repos: [{ id: 'repo-1', path: '/repos/widgets', name: 'widgets' }]
      })
      const notFound = issueOf(unknown.report, 'base_repo_missing')
      assert.ok(notFound !== undefined)
      assert.equal(notFound.detail.includes('/repos/elsewhere'), true, 'the selector is named, not a secret')

      // 三种选择器都认：id、path、name。
      for (const baseRepo of [{ id: 'repo-1' }, { path: '/repos/widgets' }, { name: 'widgets' }]) {
        const { report } = await checksOf(stateDir, { overrides: { baseRepo } })
        assert.equal(report.issues.length, 0, JSON.stringify(baseRepo))
      }
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test('the `orca` CLI being unreadable is an orca issue, not an executor one', async () => {
    const stateDir = tempStateDir()
    try {
      const report = await runSetupChecks({
        ...inputOf(stateDir),
        ports: {
          isAbsolute: () => true,
          writable: () => undefined,
          run: async () => '',
          repos: async () => {
            throw Object.assign(new Error('orca is not available'), { code: 'cli_missing' })
          }
        }
      })
      const issue = issueOf(report, 'cli_missing')
      assert.equal(issue?.place, 'orca')
      assert.equal(issue?.kind, 'broken')
      assert.ok(issue !== undefined && issue.fix.length > 0, 'the issue carries a fix')
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test('a configured base ref is verified; an unconfigured one is never guessed', async () => {
    const stateDir = tempStateDir()
    try {
      // 配了且存在：没问题。查找用 base ref 作为 query（`orca repo search-refs`）。
      const ok = await checksOf(stateDir, { overrides: { baseRef: 'main' }, refs: ['main', 'origin/main'] })
      assert.equal(ok.report.issues.length, 0)
      // 配了但不存在：一个具名问题，修法写明「清空就用 HEAD」。
      const missing = await checksOf(stateDir, { overrides: { baseRef: 'release' }, refs: ['main'] })
      const issue = issueOf(missing.report, 'base_ref_missing')
      assert.equal(issue?.place, 'executor')
      assert.equal(issue?.kind, 'missing')
      assert.ok(issue !== undefined && issue.fix.includes('HEAD'), 'the fix names the HEAD fallback')
      // 没配：不查、不报——插件显式传 HEAD，绝不假装读得到 Orca 的默认 base ref（§E.1）。
      const none = await checksOf(stateDir)
      assert.equal(issueOf(none.report, 'base_ref_missing'), undefined)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test('the GitHub CLI must be configured and must be able to read its account', async () => {
    const stateDir = tempStateDir()
    try {
      const noRepo = await checksOf(stateDir, { overrides: { repository: '' } })
      assert.equal(issueOf(noRepo.report, 'repository_missing')?.place, 'github')
      // 配置缺项时不问账号：一个 gh 调用都不发（与 #17 的轮询口径一致）。
      assert.deepEqual(noRepo.ran.filter((call) => call.program === 'gh'), [])

      const noCli = await checksOf(stateDir, { overrides: { githubCli: ' ' } })
      assert.equal(issueOf(noCli.report, 'cli_missing')?.place, 'github')

      const signedOut = await checksOf(stateDir, { fail: ['gh api user --jq .login'] })
      const issue = issueOf(signedOut.report, 'account_unreadable')
      assert.equal(issue?.place, 'github')
      assert.equal(issue?.kind, 'missing')
      assert.equal(signedOut.report.githubLogin, '')
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test('a disabled GitHub instance only has its configuration checked', async () => {
    const stateDir = tempStateDir()
    try {
      const { report, ran } = await checksOf(stateDir, { overrides: { githubEnabled: false } })
      assert.deepEqual(report.issues, [])
      assert.deepEqual(ran.filter((call) => call.program === 'gh'), [], 'a disabled source asks nobody')
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test('Feishu is checked only when it is configured, and must be bot-only', async () => {
    const stateDir = tempStateDir()
    try {
      // 没配置：不问 lark-cli。
      const none = await checksOf(stateDir)
      assert.deepEqual(none.ran.filter((call) => call.program === 'lark-cli'), [])

      // 配了、bot ready、没有 user 身份：通过。
      const bot = await runSetupChecks({
        ...inputOf(stateDir, { feishuCli: 'lark-cli' }),
        ports: {
          isAbsolute: () => true,
          writable: () => undefined,
          run: async (program) => {
            if (program === 'git') return 'git version 2.39.0'
            if (program === 'gh') return 'acme-agent\n'
            return JSON.stringify({ identities: { bot: { status: 'ready' }, user: { status: 'missing' } } })
          },
          repos: async () => [{ id: 'r', path: '/repos/widgets', name: 'widgets' }]
        }
      })
      assert.deepEqual(bot.issues, [])

      // 配了、CLI 不在：setup 问题（不是 error）。
      const absent = await checksOf(stateDir, {
        overrides: { feishuCli: 'lark-cli' },
        fail: ['lark-cli auth status']
      })
      assert.equal(issueOf(absent.report, 'cli_missing')?.place, 'feishu')

      // 配了、但这份配置能当用户身份用：拒绝（上游同口径）。
      const asUser = await runSetupChecks({
        ...inputOf(stateDir, { feishuCli: 'lark-cli' }),
        ports: {
          isAbsolute: () => true,
          writable: () => undefined,
          run: async (program) => {
            if (program === 'git') return 'git version 2.39.0'
            if (program === 'gh') return 'acme-agent\n'
            return JSON.stringify({ identities: { bot: { status: 'ready' }, user: { status: 'ready' } } })
          },
          repos: async () => [{ id: 'r', path: '/repos/widgets', name: 'widgets' }]
        }
      })
      assert.equal(issueOf(asUser, 'user_identity')?.kind, 'broken')

      // 配了、没有 bot 身份：missing。
      const noBot = await runSetupChecks({
        ...inputOf(stateDir, { feishuCli: 'lark-cli' }),
        ports: {
          isAbsolute: () => true,
          writable: () => undefined,
          run: async (program) => {
            if (program === 'git') return 'git version 2.39.0'
            if (program === 'gh') return 'acme-agent\n'
            return JSON.stringify({ identities: {} })
          },
          repos: async () => [{ id: 'r', path: '/repos/widgets', name: 'widgets' }]
        }
      })
      assert.equal(issueOf(noBot, 'bot_missing')?.kind, 'missing')
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test('a setup issue reports presence only: never a token, a secret or a message body', async () => {
    const stateDir = tempStateDir()
    try {
      const { report } = await checksOf(stateDir, {
        fail: ['gh api user --jq .login'],
        login: 'acme-agent'
      })
      mkdirSync(join(stateDir, 'logs'), { recursive: true })
      const text = JSON.stringify(report)
      for (const forbidden of ['ghp_', 'token=', 'Bearer', 'secret']) {
        assert.equal(text.includes(forbidden), false, `the report does not contain ${forbidden}`)
      }
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})

// §O「超时」行：HTTP handler 内不做超过 10 s 的同步等待。一条 setup 探针是一个子进程，
// 它可能在网络/登录上挂住；预算到点必须取消探针（信号进 `execFile`，子进程被掐掉），
// 并把「这次检查没做完」如实抛出去——**不**把超时折成「缺什么」那条结论。
describe('every setup probe has a deadline', () => {
  test('a hanging CLI probe is cancelled at the probe budget, and nothing is applied', async () => {
    const stateDir = tempStateDir()
    try {
      let seen: { signal?: AbortSignal; timeoutMs?: number } | undefined
      const started = Date.now()
      const failure = await runSetupChecks({
        ...inputOf(stateDir, {
          // 身份齐全：探针跑得完就会写 `<stateDir>/worker-gitconfig`（断言「没跑完就没写」）。
          gitConfig: { account: 'acme-agent', email: '1+acme-agent@users.noreply.github.com' },
          budget: { probeMs: 20 }
        }),
        ports: {
          isAbsolute: (path) => path.startsWith('/'),
          writable: () => undefined,
          repos: async () => [{ id: 'repo-1', path: '/repos/widgets', name: 'widgets' }],
          // `git --version` 永不返回：探针必须到点取消，而不是陪着它挂。
          run: (_program, _args, options) => {
            seen = options
            return new Promise<string>(() => undefined)
          }
        }
      }).then(
        () => undefined,
        (error: unknown) => error
      )
      const elapsed = Date.now() - started
      assert.ok(failure instanceof DeadlineError, `expected a deadline error, got ${String(failure)}`)
      assert.equal(failure.what, 'the git probe')
      assert.ok(elapsed < 1000, `the probe gave up after ${elapsed} ms`)
      assert.equal(seen?.signal?.aborted, true, 'the signal handed to the probe is aborted')
      assert.equal(seen?.timeoutMs, 20, 'the subprocess is given the same cap')
      assert.equal(existsSync(join(stateDir, 'worker-gitconfig')), false, 'a cancelled check writes nothing')
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test('without a budget a probe keeps waiting: the boot path is unchanged', async () => {
    const stateDir = tempStateDir()
    try {
      let runs = 0
      const report = await runSetupChecks({
        ...inputOf(stateDir),
        ports: {
          isAbsolute: (path) => path.startsWith('/'),
          writable: () => undefined,
          repos: async () => [{ id: 'repo-1', path: '/repos/widgets', name: 'widgets' }],
          run: async (program) => {
            runs += 1
            return program === 'git' ? 'git version 2.39.0' : 'acme-agent\n'
          }
        }
      })
      assert.equal(runs, 2, 'the git and GitHub probes both ran')
      assert.deepEqual(report.issues, [])
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})

// 子进程环境（§I.4 的统一命令端口、§O 的命令注入面、票面「剥掉 *_KEY / *_SECRET / *_TOKEN」）。
// 两条真实断言：`gh`/`git` 走的 `Commands` 与 `orca` 走的 CLI 包装都经同一个纯函数组环境。
// 这里真的起一次 `sh`（白名单内的程序），否则「剥没剥」只能靠读源码猜。
describe('the environment of every child process', () => {
  test('names that carry a secret are stripped; paths and neutral flags stay', async () => {
    const { withoutSecretEnvironment } = await import('../src/worker/infra/env')
    const stripped = withoutSecretEnvironment({
      PATH: '/usr/bin:/bin',
      HOME: '/Users/somebody',
      GH_PROMPT_DISABLED: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_GLOBAL: '/state/worker-gitconfig',
      // 值：一律剥掉（四个真实世界里会出现的形状）。
      GITHUB_TOKEN: 'ghp_live',
      LARK_APP_SECRET: 'app-secret',
      ANTHROPIC_API_KEY: 'sk-ant',
      AWS_SECRET_ACCESS_KEY: 'aws',
      DB_PASSWORD: 'pw',
      // 名字里带 TOKEN 但它是**路径**：不是秘密，保留。
      SUPERAGENT_TOKEN_FILE: '/state/tokens/asg_1',
      // `undefined` 的值不变成字符串 "undefined"。
      EMPTY: undefined
    })
    assert.deepEqual(stripped, {
      PATH: '/usr/bin:/bin',
      HOME: '/Users/somebody',
      GH_PROMPT_DISABLED: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_GLOBAL: '/state/worker-gitconfig',
      SUPERAGENT_TOKEN_FILE: '/state/tokens/asg_1'
    })
    // 值绝不出现在结果里（只有名字被剥掉）。
    assert.equal(JSON.stringify(stripped).includes('ghp_live'), false)
  })

  test('the command port never passes a secret to gh, git or sh', async () => {
    const { Commands } = await import('../src/worker/sources/commands')
    process.env['SUPERAGENT_TEST_API_KEY'] = 'sk-live-123'
    process.env['SUPERAGENT_TEST_TOKEN'] = 'tok-123'
    try {
      const out = await new Commands().run('sh', [
        '-c',
        'printf "%s|%s|%s" "$SUPERAGENT_TEST_API_KEY" "$SUPERAGENT_TEST_TOKEN" "$GH_PROMPT_DISABLED"'
      ])
      assert.equal(out, '||1', 'the secrets are gone and the neutral variable is still set')
    } finally {
      delete process.env['SUPERAGENT_TEST_API_KEY']
      delete process.env['SUPERAGENT_TEST_TOKEN']
    }
  })

  test('the orca CLI wrapper applies the same strip', async () => {
    const { createOrcaCli } = await import('../src/worker/runtime/cli')
    process.env['SUPERAGENT_TEST_TOKEN'] = 'LEAKED'
    try {
      // `createOrcaCli` 追加 `--json`；`sh -c '<script>' --json` 把它当 $0，脚本照常跑。
      const cli = createOrcaCli('sh')
      const result = await cli.run([
        '-c',
        'printf \'{"ok":true,"result":{"seen":"%s"}}\' "$SUPERAGENT_TEST_TOKEN"'
      ])
      assert.deepEqual(result, { seen: '' })
    } finally {
      delete process.env['SUPERAGENT_TEST_TOKEN']
    }
  })

  test('both child-process sites go through the one strip function', async () => {
    const { readRepoFile } = await import('./support/repo')
    for (const file of ['src/worker/sources/commands.ts', 'src/worker/runtime/cli.ts']) {
      const source = readRepoFile(file)
      assert.equal(
        source.includes('withoutSecretEnvironment('),
        true,
        `${file} composes its child environment with the strip`
      )
    }
  })
})

// ------------------------------------------------------------------ 组合根上的 setup check
// §G.2 / §N.1：`setup check` 重跑探针、重新武装挂起的循环，**不重启 Orca**；本来就没有问题
// 时固定拒绝。断言走真的 CLI → 真的 loopback HTTP → 真的组合根（§P.1：只替换外部世界）。
describe('the setup check on the composition root', () => {
  test('a setup problem leaves the part in setup, never in error', async () => {
    const h = await openBoot({
      // 第一次读账号失败（人还没 `gh auth login`），之后成功。
      scripts: (commands) => {
        commands.fail(
          'gh',
          ['api', 'user'],
          Object.assign(new Error('gh auth status exited with code 1'), { code: 1 }),
          { once: true }
        )
      }
    })
    try {
      const snapshot = h.handle.snapshot()
      assert.equal(snapshot.health.setupMissing, true, 'the panel sees a setup problem')
      assert.equal(snapshot.health.error, false, 'a setup problem is not a component error')

      const port = h.handle.port()
      assert.notEqual(port, null)
      const status = await runCli(h.stateDir, port as number, ['status'])
      assert.equal(status.exit, 3, 'waiting for setup is exit 3 (§N.4)')
      const state = (status.envelope as { result: Record<string, unknown> }).result
      const problem = (state['setup'] as { problem: Record<string, unknown> }).problem
      assert.equal(problem['place'], 'github')
      assert.equal(problem['code'], 'account_unreadable')
      assert.equal(typeof problem['fix'], 'string')
      assert.equal(problem['checkAgain'], 'superagent setup check')

      // Source 的健康条目是 `starting`（等 setup），而不是 `error`（看着像坏了）。
      const github = (state['health'] as Record<string, { state: string }>)['github']
      assert.equal(github?.state, 'starting')

      // setup 未完成时一轮都不读（Source 停在 setup）。
      assert.deepEqual(await h.handle.pollOnce(), { notifications: 0, triggers: 0, skipped: 0 })
    } finally {
      await h.cleanup()
    }
  })

  test('the check reruns the probes, restarts the loops and then refuses to run again', async () => {
    const h = await openBoot({
      scripts: (commands) => {
        commands.fail(
          'gh',
          ['api', 'user'],
          Object.assign(new Error('gh auth status exited with code 1'), { code: 1 }),
          { once: true }
        )
      }
    })
    try {
      const port = h.handle.port() as number
      const check = await runCli(h.stateDir, port, ['setup', 'check'])
      assert.equal(check.exit, 0, JSON.stringify(check.envelope))
      const result = (check.envelope as { result: Record<string, unknown> }).result
      assert.equal(result['checked'], true)
      assert.equal(result['problem'], null, 'the account is readable now')
      assert.equal(result['restarted'], true, 'the polling loop was re-armed')

      // 循环真的重新武装了：下一轮就把通知读进来（不必重启 Orca）。
      assert.deepEqual(await h.handle.pollOnce(), { notifications: 1, triggers: 1, skipped: 0 })

      // 没有问题了：`setup check` 固定拒绝（§G.2 的「已无问题时拒绝」）。
      const again = await runCli(h.stateDir, port, ['setup', 'check'])
      assert.equal(again.exit, 2)
      assert.equal((again.envelope as { error: { code: string } }).error.code, 'refused')
    } finally {
      await h.cleanup()
    }
  })

  test('a hanging CLI makes setup check return unavailable inside the budget and apply nothing', async () => {
    // 一次真的 HTTP 往返（真库、真 loopback）：boot 时 `gh` 读账号失败一次，于是 setup 有待查的
    // 问题；之后同一条命令挂住（§O 的超时用例）。
    const h = await openBoot({
      scripts: (commands) => {
        commands.fail(
          'gh',
          ['api', 'user'],
          Object.assign(new Error('gh auth status exited with code 1'), { code: 1 }),
          { once: true }
        )
      }
    })
    try {
      const port = h.handle.port() as number
      const before = h.handle.deployment()
      assert.equal(before.setup.length > 0, true, 'the boot left a setup problem behind')
      const written = h.commands.calls.length

      // 从现在起 `gh api user` 永不返回：探针到点必须被取消，而不是陪着它挂。
      h.commands.hang('gh', ['api', 'user'])
      const started = Date.now()
      const check = await runCli(h.stateDir, port, ['setup', 'check'])
      const elapsed = Date.now() - started

      // 固定码：`unavailable`（exit 3）与「稍后重试」——不折成一条编出来的 setup 结论。
      assert.equal(check.exit, 3, JSON.stringify(check.envelope))
      const envelope = check.envelope as { ok: false; error: { code: string; message: string } }
      assert.equal(envelope.error.code, 'unavailable')
      assert.ok(envelope.error.message.includes('retry later'), envelope.error.message)
      // §O 的探针上限是 2 s：整次请求在 9 s 的总预算里返回（这里一定远早于它）。
      assert.ok(elapsed < 5_000, `the handler returned after ${elapsed} ms`)

      // 取消传到了 CLI：这次调用拿到的信号已经取消，并且它同时带着同一个上限。
      const hung = h.commands.calls.slice(written).find((call) => call.program === 'gh')
      assert.equal(hung?.options.signal?.aborted, true, 'the probe signal is aborted')
      assert.equal(hung?.options.timeoutMs, 2_000, 'the subprocess gets the same cap')

      // 什么都没应用：setup 结论还是启动时那一条（超时的检查一半都没落地）。
      assert.equal(h.handle.snapshot().health.setupMissing, true)
      assert.deepEqual(h.handle.deployment().setup, before.setup)
    } finally {
      await h.cleanup()
    }
  })

  test('a hanging doctor probe is a timeout on that item: the other checks keep their readings and nothing is written', async () => {
    // 真 HTTP 往返（真库、真 loopback）：`gh auth status` 挂住，其余七项照常。
    const h = await openBoot()
    const store = openStore({ stateDir: h.stateDir })
    try {
      const port = h.handle.port() as number
      const before = [...store.kvKeys()]
      const written = h.commands.calls.length

      // 从现在起 `gh auth status` 永不返回：探针 2 s 到点必须被取消，而不是陪着它挂。
      h.commands.hang('gh', ['auth', 'status'])
      const started = Date.now()
      const doctor = await runCli(h.stateDir, port, ['doctor'])
      const elapsed = Date.now() - started

      // 跑完就是成功：200/退出 0，逐项结论在 `result.checks` 里（超时不是一个退出码）。
      assert.equal(doctor.exit, 0, JSON.stringify(doctor.envelope))
      const envelope = doctor.envelope as { ok: true; result: Record<string, unknown> }
      assert.deepEqual(
        (envelope.result['checks'] as readonly { name: string }[]).map((check) => check.name),
        ['token', 'port', 'lock', 'database', 'cli', 'gitconfig', 'gh', 'lark']
      )
      const checks = envelope.result['checks'] as readonly {
        name: string
        state: string
        detail: string
        hint?: string
      }[]
      const gh = checks.find((check) => check.name === 'gh')
      // 超时如实标记：不是 ok（不伪装查过了），也不是 fail（没查完不等于坏了）。
      assert.equal(gh?.state, 'timeout')
      assert.equal(String(gh?.detail).includes('2000 ms'), true, String(gh?.detail))
      assert.equal(typeof gh?.hint, 'string', 'a timeout says what to do next')
      // 四档计数如实：这一条是超时，没有 fail（跑完就是一次成功的诊断）。
      const summary = envelope.result['summary'] as Record<string, number>
      assert.equal(summary['timeout'], 1)
      assert.equal(summary['fail'], 0)
      // 其余项照常：端口真的回答，token 与库都读得到。
      assert.equal(checks.find((check) => check.name === 'port')?.state, 'ok')
      assert.equal(checks.find((check) => check.name === 'token')?.state, 'ok')
      assert.equal(checks.find((check) => check.name === 'database')?.state, 'ok')
      // §O 的探针上限：整次请求在 9 s 的总预算里返回（这里一定远早于它）。
      assert.ok(elapsed < 5_000, `the handler returned after ${elapsed} ms`)

      // 取消传到了 CLI：挂住的那次调用拿到的信号已经取消，并带着同一个上限。
      const hung = h.commands.calls.slice(written).find((call) => call.program === 'gh')
      assert.equal(hung?.options.signal?.aborted, true, 'the probe signal is aborted')
      assert.equal(hung?.options.timeoutMs, 2_000, 'the subprocess gets the same cap')
      // 诊断不写库。
      assert.deepEqual([...store.kvKeys()], before)
    } finally {
      store.close()
      await h.cleanup()
    }
  })

  test('a hanging source-labels read returns unavailable inside the budget, cancels the read and keeps the old labels', async () => {
    const stateDir = tempStateDir()
    const h = await openBoot({
      stateDir,
      // Feishu 装上但不开：`source labels` 不看开关，读的是 kind 的 `refreshLabels`。
      settings: {
        ...settingsOf(stateDir),
        sources: {
          github: { enabled: true, config: { repository: 'acme/widgets', cli: 'gh', pollSeconds: 60 } },
          feishu: { enabled: false, config: { cli: 'lark-cli' } }
        }
      },
      scripts: (commands) => {
        commands.script(['im', '+chat-list', '--as', 'bot'], () =>
          JSON.stringify({ chats: [{ chat_id: 'oc_all', name: 'Build alerts', chat_mode: 'group' }] })
        )
      }
    })
    const store = openStore({ stateDir: stateDir })
    try {
      const port = h.handle.port() as number
      // 先成功一次：名单写进 kv（证明「超时之后这份名单没有被覆盖成空表」）。
      const first = await runCli(h.stateDir, port, ['source', 'labels', 'feishu'])
      assert.equal(first.exit, 0, JSON.stringify(first.envelope))
      assert.deepEqual(store.kvGet('source-labels:feishu'), { oc_all: 'Build alerts' })
      const written = h.commands.calls.length

      // 从现在起 `lark-cli im +chat-list` 永不返回：探针到点必须被取消，而不是陪着它挂。
      h.commands.hang('lark-cli', ['im', '+chat-list'])
      const started = Date.now()
      const labels = await runCli(h.stateDir, port, ['source', 'labels', 'feishu'])
      const elapsed = Date.now() - started

      // 这是一次动作：超预算就是固定码 `unavailable` + 「稍后重试」，没有半份成功。
      assert.equal(labels.exit, 3, JSON.stringify(labels.envelope))
      const envelope = labels.envelope as { ok: false; error: { code: string; message: string } }
      assert.equal(envelope.error.code, 'unavailable')
      assert.ok(envelope.error.message.includes('retry later'), envelope.error.message)
      assert.ok(elapsed < 5_000, `the handler returned after ${elapsed} ms`)

      // 取消传到了 CLI：信号已取消（真实现里子进程被 SIGTERM 掐掉）。
      const hung = h.commands.calls.slice(written).find((call) => call.program === 'lark-cli')
      assert.equal(hung?.options.signal?.aborted, true, 'the read signal is aborted')
      // 没有 DB 写入：上一次的名单原样留着。
      assert.deepEqual(store.kvGet('source-labels:feishu'), { oc_all: 'Build alerts' })
    } finally {
      store.close()
      await h.cleanup()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test('a base repository that Orca does not have is an executor setup problem', async () => {
    const h = await openBoot({
      boot: async (stateDir, runtime, commands) => {
        // Orca 里没有这个仓库：`orca repo list` 是空的。
        runtime.repos = []
        return bootPlugin({
          runtime,
          readSettings: async () => settingsOf(stateDir),
          commands,
          stateDir,
          disableTimers: true
        })
      }
    })
    try {
      const snapshot = h.handle.snapshot()
      assert.equal(snapshot.health.setupMissing, true)
      const port = h.handle.port() as number
      const status = await runCli(h.stateDir, port, ['status'])
      const problem = ((status.envelope as { result: Record<string, unknown> }).result['setup'] as {
        problem: Record<string, unknown>
      }).problem
      assert.equal(problem['place'], 'executor')
      assert.equal(problem['code'], 'base_repo_missing')
      assert.equal(String(problem['detail']).includes('/repos/widgets'), true)

      // 把仓库加进 Orca（人做的事），再检查一次：问题消失，Router 才被允许建会话。
      h.runtime.repos = [{ id: 'repo-1', path: '/repos/widgets', name: 'widgets' }]
      const check = await runCli(h.stateDir, port, ['setup', 'check'])
      assert.equal(check.exit, 0, JSON.stringify(check.envelope))
      const result = (check.envelope as { result: Record<string, unknown> }).result
      assert.equal(result['problem'], null)
      assert.equal(result['restarted'], true, 'the router supervision was armed')
      assert.equal(h.handle.snapshot().health.setupMissing, false)
    } finally {
      await h.cleanup()
    }
  })

  test('the worker git config exists after start with mode 0600 and the agent identity', async () => {
    const h = await openBoot()
    try {
      const path = workerGitConfigPath(h.stateDir)
      assert.equal(existsSync(path), true, 'boot writes the file the launch hook points at')
      assert.equal(statSync(path).mode & 0o777, GITCONFIG_MODE)
      const text = readFileSync(path, 'utf8')
      assert.ok(text.includes('!gh auth git-credential'), 'the agent account gh is the credential helper')
      assert.ok(text.includes('git@github.com:'), 'SSH URIs are rewritten to HTTPS')
      assert.ok(text.includes('acme-agent'), 'the name is the agent account (probed from gh)')
      assert.ok(text.includes('1+acme-agent@users.noreply.github.com'), 'the email is the deployment noreply')
      assert.equal(h.handle.snapshot().health.setupMissing, false, 'a written file is not a setup problem')
    } finally {
      await h.cleanup()
    }
  })

  test('a worker git config that cannot be written is a named setup problem', async () => {
    const stateDir = tempStateDir()
    // 路径被同名目录占住：写文件不可能成功。
    mkdirSync(workerGitConfigPath(stateDir), { recursive: true })
    const h = await openBoot({ stateDir })
    try {
      assert.equal(h.handle.snapshot().health.setupMissing, true)
      const port = h.handle.port() as number
      const status = await runCli(h.stateDir, port, ['status'])
      const problem = ((status.envelope as { result: Record<string, unknown> }).result['setup'] as {
        problem: Record<string, unknown>
      }).problem
      assert.equal(problem['place'], 'executor')
      assert.equal(problem['code'], 'gitconfig_unwritable')
      assert.equal(String(problem['fix']).length > 0, true, 'the issue carries a fix')
    } finally {
      await h.cleanup()
    }
  })

  test('an unfinished identity leaves the file missing and says what to configure', async () => {
    const stateDir = tempStateDir()
    const settings = { ...settingsOf(stateDir) }
    delete settings['githubCommitEmail']
    const h = await openBoot({ stateDir, settings })
    try {
      assert.equal(existsSync(workerGitConfigPath(stateDir)), false, 'no partial identity is written')
      const port = h.handle.port() as number
      const status = await runCli(h.stateDir, port, ['status'])
      const problem = ((status.envelope as { result: Record<string, unknown> }).result['setup'] as {
        problem: Record<string, unknown>
      }).problem
      assert.equal(problem['place'], 'executor')
      assert.equal(problem['code'], 'gitconfig_missing')
      assert.match(String(problem['fix']), /githubCommitEmail/)
    } finally {
      await h.cleanup()
    }
  })
})

// ------------------------------------------------------------------ doctor 与 setup 的分工
describe('doctor and the setup check are different questions', () => {
  test('the doctor says so in its own result, in words', async () => {
    const stateDir = tempStateDir()
    try {
      const result = await runDoctor({
        stateDir,
        now: () => '2026-11-07T03:26:00.000Z',
        portOpen: async () => false,
        run: async () => {
          throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
        }
      })
      assert.equal(typeof result.note, 'string')
      assert.equal(/setup check/i.test(result.note), true, result.note)
      // 「没配置」是 warn、不是 fail：可选项不该让退出码变红（§G.2）。
      const lark = result.checks.find((check) => check.name === 'lark')
      assert.equal(lark?.state, 'warn')
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test('no CLI output reaches the doctor: not a token, not a secret', async () => {
    const stateDir = tempStateDir()
    try {
      const result = await runDoctor({
        stateDir,
        now: () => '2026-11-07T03:26:00.000Z',
        portOpen: async () => false,
        cliPath: join(stateDir, 'superagent.mjs'),
        run: async (program) => {
          // 真实的 gh/lark-cli 输出里会有账号名、appId、scope 列表；这里给一个更坏的情况：
          // 连 token 都打出来了。doctor 只允许报「有没有」。
          if (program === 'gh') return 'Logged in to github.com as acme-agent (oauth_token=ghp_live_value)'
          return JSON.stringify({
            identities: { bot: { status: 'ready', appSecret: 'lark-app-secret' } },
            appId: 'cli_app123'
          })
        }
      })
      const text = JSON.stringify(result)
      for (const leaked of ['ghp_live_value', 'lark-app-secret', 'cli_app_123', 'acme-agent']) {
        assert.equal(text.includes(leaked), false, `the doctor never echoes ${leaked}`)
      }
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// 部署页的读数（§M.3 Deployment）：组合根把 setup、限额、暂停、health 与 Router 拼成一份，
// 面板只读它；轮换主 token 与 doctor 也从同一份接线来（§D.6、§G.2、§O）。
// ---------------------------------------------------------------------------

/** 用指定 token 跑一条 CLI 命令（真的 loopback HTTP；token 可以是一个已经作废的）。 */
async function runCliWith(stateDir: string, port: number, token: string | null, argv: readonly string[]) {
  return dispatch({
    parsed: parseArgs(argv),
    target: {
      stateDir,
      stateDirSource: 'argument' as const,
      port,
      baseUrl: `http://127.0.0.1:${port}/superagent/api`,
      token,
      tokenSource: 'argument' as const,
      tokenFile: null
    },
    sleep: async () => undefined
  })
}

/** `ApiError.toJSON()` 的错误码（dispatch 的信封）。 */
function codeOf(result: Awaited<ReturnType<typeof dispatch>>): string | undefined {
  const envelope = result.envelope as { ok?: boolean; error?: { code?: string } }
  return envelope.ok === false ? envelope.error?.code : undefined
}

describe('the deployment read the panel renders', () => {
  test('carries the state directory, the limits in force, paused and the real health board', async () => {
    const boot = await openBoot()
    try {
      const view = boot.handle.deployment()
      assert.equal(view.stateDir, boot.stateDir)
      assert.deepEqual({ ...view.limits }, {
        promptMaxChars: 200_000,
        admissionContextMaxPages: 10,
        admissionContextTimeoutMs: 15_000,
        retentionDays: 90
      })
      assert.deepEqual(view.setup, [], 'a complete deployment has no setup problem')
      assert.equal(view.paused, false)

      // health 明细就是健康板上那些条目（#45 的写者已 claim 过），按名字序、无假条目。
      const names = view.health.map((entry) => entry.name)
      for (const name of ['runtime', 'passes', 'models', 'router']) {
        assert.ok(names.includes(name), `the health board reports ${name}`)
      }
      assert.deepEqual(names, [...names].sort(), 'entries are read in name order')
      assert.equal(new Set(names).size, names.length, 'each entry appears once')
      assert.ok(view.health.every((entry) => entry.state !== undefined))

      // 暂停由 `app/pause.ts` 这一个写者；面板读到的是写后的值。
      boot.handle.setPaused(true)
      assert.equal(boot.handle.deployment().paused, true)
      boot.handle.setPaused(false)
      assert.equal(boot.handle.deployment().paused, false)

      // Router 读数与 `routerStatus()` 同一份（这里是「还没起来」，不是二手字段）。
      assert.equal(view.router.terminalId, boot.handle.routerStatus().terminalId)
      assert.equal(view.router.restarts, boot.handle.routerStatus().restarts)
      assert.equal(view.router.state, boot.handle.routerStatus().state)
    } finally {
      await boot.cleanup()
    }
  })

  test('the limits come from the machine settings, and a bad value falls back to the design default', async () => {
    const stateDir = tempStateDir()
    const boot = await openBoot({
      stateDir,
      settings: {
        ...settingsOf(stateDir),
        promptMaxChars: 500_000,
        admissionContextMaxPages: 4,
        admissionContextTimeoutMs: 7000,
        retention: { days: 30 }
      }
    })
    try {
      assert.deepEqual({ ...boot.handle.deployment().limits }, {
        promptMaxChars: 500_000,
        admissionContextMaxPages: 4,
        admissionContextTimeoutMs: 7000,
        retentionDays: 30
      })
    } finally {
      await boot.cleanup()
    }

    const broken = tempStateDir()
    const second = await openBoot({
      stateDir: broken,
      settings: { ...settingsOf(broken), promptMaxChars: 0, admissionContextMaxPages: -1, admissionContextTimeoutMs: 1.5 }
    })
    try {
      // 限额只接受正整数：写坏的值回落缺省值，而不是被当成 0 或小数用。
      assert.deepEqual({ ...second.handle.deployment().limits }, {
        promptMaxChars: 200_000,
        admissionContextMaxPages: 10,
        admissionContextTimeoutMs: 15_000,
        retentionDays: 90
      })
    } finally {
      await second.cleanup()
    }
  })

  test('rotating the operator token rewrites the file, reports the path and never the value', async () => {
    const boot = await openBoot()
    try {
      const port = boot.handle.port()
      assert.notEqual(port, null, 'the leader serves the loopback API')
      const before = readApiToken(boot.stateDir)
      assert.notEqual(before, null)

      const result = boot.handle.rotateToken()
      const after = readApiToken(boot.stateDir)
      assert.equal(result.rotated, true)
      assert.equal(result.tokenFile, join(boot.stateDir, 'api-token'))
      assert.notEqual(after, before, 'the file holds a new token')
      assert.equal(JSON.stringify(result).includes(after as string), false, 'the token value is never returned')

      // 鉴权每次请求都读那个文件：旧 token 立刻 401，新 token 照常读 state（§D.6）。
      const stale = await runCliWith(boot.stateDir, port as number, before, ['status'])
      assert.equal(codeOf(stale), 'unauthorized')
      const fresh = await runCliWith(boot.stateDir, port as number, after, ['status'])
      assert.equal(fresh.exit, 0)
    } finally {
      await boot.cleanup()
    }
  })

  test('doctor runs the machine diagnosis through the same wiring as the CLI', async () => {
    // 这台「机器」上 `gh` 是登录好的（缺省脚本只覆盖了 `gh api user`）；lark-cli 没装 → warn。
    const boot = await openBoot({
      scripts: (commands) => commands.script('gh auth status', () => 'github.com\n  Logged in to github.com as acme-agent\n')
    })
    try {
      const result = await boot.handle.doctor()
      assert.equal(result.stateDir, boot.stateDir)
      // 缺省脚本化的两个登录（gh 的 auth status 与 lark-cli）是 warn，不是 fail；
      // token、端口、锁、库、CLI 路径与 worker git 配置在这台「机器」上都齐。
      assert.equal(result.summary.fail, 0, JSON.stringify(result.checks))
      assert.equal(result.checks.length, 8)
      assert.equal(result.note.includes('superagent setup check'), true)
      const token = result.checks.find((check) => check.name === 'token')
      assert.equal(token?.state, 'ok')
      assert.equal(JSON.stringify(result).includes(readApiToken(boot.stateDir) as string), false, 'doctor never prints the token')
    } finally {
      await boot.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// 面板 host 方法的 §O 预算（§O「超时」行）：面板请求同样不能占住 worker。四条方法与
// 它们的 HTTP 路由共用同一份接线与同一条预算；用例注入小预算并让依赖挂住。
// ---------------------------------------------------------------------------

/** 一个拒绝的形状：面板 host 方法的错误带 `code`（面板按码翻译）。 */
function refusalCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined
}

describe('the panel host methods carry the same §O budgets as the HTTP routes', () => {
  test('a hanging setup probe on the panel check returns unavailable and applies nothing', async () => {
    // boot 时 `gh api user` 失败一次 → setup 有待查的问题；之后同一条探针挂住（§O 的超时用例）。
    const h = await openBoot({
      budgets: { setupCheck: { probeMs: 10, totalMs: 40 } },
      scripts: (commands) => {
        commands.fail(
          'gh',
          ['api', 'user'],
          Object.assign(new Error('gh auth status exited with code 1'), { code: 1 }),
          { once: true }
        )
      }
    })
    try {
      const before = h.handle.deployment().setup
      assert.equal(before.length > 0, true, 'the boot left a setup problem behind')
      h.commands.hang('gh', ['api', 'user'])
      const started = Date.now()
      let refusal: unknown
      try {
        await h.handle.checkSetup()
      } catch (error) {
        refusal = error
      }
      const elapsed = Date.now() - started
      // 固定码：这不是一条编出来的 setup 结论，也不是内部错误。
      assert.equal(refusalCode(refusal), 'unavailable', String(refusal))
      assert.ok(String((refusal as Error).message).includes('retry later'), String(refusal))
      assert.ok(elapsed < 1_000, `the panel call returned after ${elapsed} ms`)
      // 超时的检查一半都没落地：`deployment().setup` 还是 boot 时那一条。
      assert.deepEqual(h.handle.deployment().setup, before)
    } finally {
      await h.cleanup()
    }
  })

  test('a hanging doctor probe on the panel is a timeout on that item, inside the budget', async () => {
    const h = await openBoot({ budgets: { doctor: { probeMs: 10, totalMs: 500 } } })
    try {
      const written = h.commands.calls.length
      // 一个永不返回的子进程（真实现里信号进 `execFile`，子进程被 SIGTERM 掐掉）。
      h.commands.hang('gh', ['auth', 'status'])
      const started = Date.now()
      const result = await h.handle.doctor()
      const elapsed = Date.now() - started
      // 单条探针到点只把那一项标 `timeout`：面板仍拿到一份完整读数，不是一个报错。
      const gh = result.checks.find((check) => check.name === 'gh')
      assert.equal(gh?.state, 'timeout', JSON.stringify(result.summary))
      assert.equal(String(gh?.detail).includes('10 ms'), true, String(gh?.detail))
      assert.ok(elapsed < 1_000, `the panel call returned after ${elapsed} ms`)
      const hung = h.commands.calls.slice(written).find((call) => call.program === 'gh')
      assert.equal(hung?.options.signal?.aborted, true, 'the budget signal is aborted')
      assert.equal(hung?.options.timeoutMs, 10, 'the probe gets the same cap')
    } finally {
      await h.cleanup()
    }
  })

  test('a panel doctor call that blows the whole budget fails with unavailable', async () => {
    // 总预算比探针上限更紧：整次到点 → 固定码 `unavailable`（不是一份没跑完的读数）。
    const h = await openBoot({ budgets: { doctor: { probeMs: 2_000, totalMs: 10 } } })
    try {
      h.commands.hang('gh', ['auth', 'status'])
      const started = Date.now()
      let refusal: unknown
      try {
        await h.handle.doctor()
      } catch (error) {
        refusal = error
      }
      const elapsed = Date.now() - started
      assert.equal(refusalCode(refusal), 'unavailable', String(refusal))
      assert.ok(String((refusal as Error).message).includes('retry later'), String(refusal))
      assert.ok(elapsed < 1_000, `the panel call returned after ${elapsed} ms`)
    } finally {
      await h.cleanup()
    }
  })

  test('a hanging label read on the panel returns unavailable and keeps the old labels', async () => {
    const stateDir = tempStateDir()
    const h = await openBoot({
      stateDir,
      settings: {
        ...settingsOf(stateDir),
        sources: {
          github: { enabled: true, config: { repository: 'acme/widgets', cli: 'gh', pollSeconds: 60 } },
          feishu: { enabled: false, config: { cli: 'lark-cli' } }
        }
      },
      scripts: (commands) => {
        commands.script(['im', '+chat-list', '--as', 'bot'], () =>
          JSON.stringify({ chats: [{ chat_id: 'oc_all', name: 'Build alerts', chat_mode: 'group' }] })
        )
      },
      budgets: { sourceLabels: { probeMs: 10, totalMs: 40 } }
    })
    const store = openStore({ stateDir })
    try {
      // 先成功一次：名单写进 kv（证明超时之后这份名单没有被覆盖成空表）。
      const first = await h.handle.refreshSourceLabels('feishu')
      assert.equal(first.total, 1)
      assert.deepEqual(store.kvGet('source-labels:feishu'), { oc_all: 'Build alerts' })

      h.commands.hang('lark-cli', ['im', '+chat-list'])
      const written = h.commands.calls.length
      const started = Date.now()
      let refusal: unknown
      try {
        await h.handle.refreshSourceLabels('feishu')
      } catch (error) {
        refusal = error
      }
      const elapsed = Date.now() - started
      // 面板按 `code` 翻译；预算到点不是「参数不对」（`invalid_params`）。
      assert.equal(refusalCode(refusal), 'unavailable', String(refusal))
      assert.ok(String((refusal as Error).message).includes('retry later'), String(refusal))
      assert.ok(elapsed < 1_000, `the panel call returned after ${elapsed} ms`)
      const hung = h.commands.calls.slice(written).find((call) => call.program === 'lark-cli')
      assert.equal(hung?.options.signal?.aborted, true, 'the read signal is aborted')
      // 名单没被覆盖：上一次那份原样留着。
      assert.deepEqual(store.kvGet('source-labels:feishu'), { oc_all: 'Build alerts' })
    } finally {
      store.close()
      await h.cleanup()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test('a hanging list sync on the panel returns unavailable inside the budget and saves nothing', async () => {
    const stateDir = tempStateDir()
    const h = await openBoot({
      stateDir,
      settings: {
        ...settingsOf(stateDir),
        sources: {
          github: { enabled: true, config: { repository: 'acme/widgets', cli: 'gh', pollSeconds: 60 } },
          feishu: { enabled: true, config: { cli: 'lark-cli' } }
        },
        policy: {
          sources: {
            github: { allowed: [{ id: 'alice' }] },
            feishu: { allowed: [], syncChat: 'oc_all' }
          }
        }
      },
      scripts: (commands) => {
        // 机器人的身份探针（§I.3 配置行）：可同步的前提是 setup 认为它可用。
        commands.script(['auth', 'status'], () =>
          JSON.stringify({ appId: 'cli_app123', identities: { bot: { status: 'ready' } } })
        )
        commands.script(['api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot'], () =>
          JSON.stringify({ bot: { open_id: 'ou_bot1' } })
        )
        commands.script(['im', '+chat-members-list'], () =>
          JSON.stringify({ members: [{ id: 'ou_all', name: 'Alice' }] })
        )
      },
      budgets: { policySync: { totalMs: 40 } }
    })
    const store = openStore({ stateDir })
    try {
      // 启动时那一轮同步照常完成（不然下面挂住的是它，不是「立即同步」）。
      await h.handle.policySync()
      const before = [...store.kvKeys()]

      h.commands.hang('lark-cli', ['im', '+chat-members-list'])
      const written = h.commands.calls.length
      const started = Date.now()
      let refusal: unknown
      try {
        await h.handle.syncSource('feishu')
      } catch (error) {
        refusal = error
      }
      const elapsed = Date.now() - started
      assert.equal(refusalCode(refusal), 'unavailable', String(refusal))
      assert.ok(String((refusal as Error).message).includes('retry later'), String(refusal))
      assert.ok(elapsed < 1_000, `the panel call returned after ${elapsed} ms`)
      // 取消传到了读取（信号经驱动器的退避链进 `lark-cli`）。
      const hung = h.commands.calls.slice(written).find((call) => call.program === 'lark-cli')
      assert.equal(hung?.options.signal?.aborted, true, 'the sync read signal is aborted')
      // 没有新名单落库：这次同步什么都没写（`kv` 的键一字不差；Policy 没有新版本）。
      assert.deepEqual([...store.kvKeys()], before)
    } finally {
      store.close()
      await h.cleanup()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test('a hanging account probe on a panel save fails with unavailable and writes nothing', async () => {
    const stateDir = tempStateDir()
    const h = await openBoot({ stateDir, budgets: { settingsSave: { probeMs: 10, totalMs: 40 } } })
    const store = openStore({ stateDir })
    try {
      const before = [...store.kvKeys()]
      // 换掉账号类字段（`repository`）才会跑写前检查；`gh api user` 是那个探针。
      h.commands.hang('gh', ['api', 'user'])
      const started = Date.now()
      const outcome = await h.handle.settingsSave({
        block: 'source:github',
        revision: 0,
        value: { enabled: true, config: { repository: 'acme/other', cli: 'gh', pollSeconds: 60 } }
      })
      const elapsed = Date.now() - started
      // 面板拿到的是一次固定拒绝：不是保存成功，也不是「校验不通过」（`invalid`）。
      assert.equal(outcome.ok, false)
      assert.equal(outcome.ok === false ? outcome.reason : 'ok', 'failed')
      const failure = outcome.ok === false && 'error' in outcome ? outcome.error : ''
      // 具体文案原样交给面板：挂住的是哪条探针、多少毫秒、稍后重试（不是泛泛的 failed）。
      // 探针自己的 10 ms 上限先到，所以消息点名的是那条 CLI 探针，而不是外层的整次检查。
      assert.match(failure, /^The GitHub CLI probe did not finish within \d+ ms; retry later$/)
      assert.ok(elapsed < 1_000, `the panel call returned after ${elapsed} ms`)
      // 什么都没写：没有设置版本、没有块修订号。
      assert.deepEqual([...store.kvKeys()], before)
      assert.equal(store.kvGet('settings:revision'), null)
    } finally {
      store.close()
      await h.cleanup()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// `admin backup`：VACUUM 不进 handler（§O「长活进 effect」）。
// ---------------------------------------------------------------------------

describe('admin backup runs the VACUUM off the request', () => {
  test('the command queues the backup, returns the path it will land in, and the queue finishes it', async () => {
    const h = await openBoot()
    try {
      const port = h.handle.port() as number
      const called = await runCli(h.stateDir, port, ['admin', 'backup'])
      assert.equal(called.exit, 0, JSON.stringify(called.envelope))
      const result = (called.envelope as { ok: true; result: Record<string, unknown> }).result
      // 入队返回：handler 没有做 VACUUM（`queued` 与「没有 bytes」同时成立）。
      assert.equal(result['queued'], true)
      assert.equal(result['bytes'], undefined, 'the file is not written yet')
      const path = String(result['path'])
      assert.equal(path.startsWith(join(h.stateDir, 'backups')), true, path)
      assert.equal(path.endsWith('.sqlite'), true, path)

      // 队列跑完：文件真的在那里，大小也读得到（与自动备份同一份 `backupNow`）。
      await h.handle.passOnce()
      assert.equal(existsSync(path), true, 'the queued VACUUM wrote the backup')
      assert.ok(statSync(path).size > 0, 'the backup has bytes')

      // 同一份 `at` 再入队只会合并成一行（key 是备份时刻）：再跑一轮不会多出一个文件。
      const again = await runCli(h.stateDir, port, ['admin', 'backup'])
      assert.equal(again.exit, 0)
      await h.handle.passOnce()
    } finally {
      await h.cleanup()
    }
  })

  test('the `--text` reply is `queued` plus the path it will land in, never a finished copy', async () => {
    const h = await openBoot()
    try {
      const called = await runCli(h.stateDir, h.handle.port() as number, ['admin', 'backup', '--text'])
      assert.equal(called.exit, 0, JSON.stringify(called.envelope))
      const text = render(called.envelope, { text: true })
      // 人读的三行：先「入队了」，再给它将落到的路径（§O：VACUUM 还没跑）。
      assert.ok(text.includes('queued: true'), text)
      assert.ok(text.includes('path: '), text)
      assert.ok(text.includes('at: '), text)
      // 文件还没写：不出现 bytes/kept，也不把入队说成完成。
      assert.equal(text.includes('bytes:'), false, text)
      assert.equal(text.includes('kept:'), false, text)
    } finally {
      await h.cleanup()
    }
  })
})

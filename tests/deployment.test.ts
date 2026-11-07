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
import { parseArgs } from '../src/worker/cli/io'
import { readApiToken } from '../src/worker/infra/tokens'
import { openBoot, settingsOf } from './support/boot'
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
            appId: 'cli_app_123'
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

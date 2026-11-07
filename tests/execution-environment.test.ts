// 执行环境的文件面（§E.11）：`<ticketDir>/.superagent/env.sh` 与 worktree 的 git 排除。
// 断言按「外面能看见的行为」写：
// 1. env.sh 的行序就是变量表顺序，值逐值单引号转义——真用 `/bin/sh` source 一遍取值，
//    而不是把转义算法再算一次；
// 2. 排除生效：真建 repo + linked worktree，`git status` 看不到 `.superagent/`，且 base repo
//    的索引文件（`.git/index`）一个字节都没变；
// 3. 重复写是幂等的（排除文件里只有一行）。
import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Trigger } from '../src/worker/core/model'
import { ENVIRONMENT_VARIABLES, environmentOf, type EnvironmentTable } from '../src/worker/executor/environment'
import {
  createLaunchHook,
  HOOK_BUDGET_MS,
  launchEnvironment,
  type LaunchHookEvent
} from '../src/worker/executor/launch-hook'
import { writeCommandShims } from '../src/worker/executor/shims'
import { listFiles, readRepoFile } from './support/repo'
import { FakeOrcaRuntime } from './support/fake-orca-runtime'
import type { WorkspaceHandle } from '../src/worker/runtime/orca-runtime'
import { PREPARE_TIMEOUT_MS, PrepareError, runPrepare } from '../src/worker/executor/prepare'
import {
  ENV_FILE_EXCLUDE_ENTRY,
  ensureExcluded,
  envFilePath,
  gitExcludePath,
  renderEnvFile,
  writeEnvFile
} from '../src/worker/executor/env-file'

const directories: string[] = []

/** 一个临时目录（用例结束删掉）。 */
function tempDir(prefix: string): string {
  const created = mkdtempSync(join(tmpdir(), prefix))
  directories.push(created)
  return created
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** 隔离掉操作者的 git 配置：测试只验证仓库自己的忽略规则。 */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com'
}

/**
 * 跑一条 git 命令（测试面允许子进程；生产代码只有 `sources/commands.ts` 与 `runtime/` 可以，§B）。
 * 用 `execFile` 的 argv 数组，不经过 shell。
 */
function git(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', shell: false }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

/** 建一个 repo 与它的 linked worktree（Ticket 的 worktree 就是这种形态）。 */
async function repoWithWorktree(): Promise<{ base: string; worktree: string }> {
  const base = tempDir('superagent-base-')
  await git(base, 'init', '-q', '-b', 'main')
  writeFileSync(join(base, 'README.md'), '# base\n')
  await git(base, 'add', '.')
  await git(base, 'commit', '-qm', 'init')
  const worktree = tempDir('superagent-wt-')
  rmSync(worktree, { recursive: true, force: true })
  await git(base, 'worktree', 'add', '-q', '-b', 'agent/fix-the-login-flow', worktree)
  return { base, worktree }
}

/** 一张变量表：目录名里带单引号与空格，逼出转义路径。 */
function tableFor(directory: string): EnvironmentTable {
  const trigger: Trigger = {
    id: 'github:issue:12',
    source: 'github',
    threads: [{ source: 'github', id: 'github:12' }],
    actor: { source: 'github', id: 'alice' },
    human: true,
    at: '2026-11-07T03:26:00.000Z',
    text: 'Please fix the login flow.',
    meta: { number: 12 }
  }
  return environmentOf({
    deployment: {
      repository: 'acme/widgets',
      githubLogin: 'acme-agent',
      githubCommitEmail: '1+acme-agent@users.noreply.github.com',
      feishuBotId: ''
    },
    ticket: { id: 'ticket-11', name: 'fix-the-login-flow', directory },
    plugin: { cliPath: '/plugins/superagent.mjs', tokenFile: '/state/tokens/asg_1', apiBase: 'http://127.0.0.1:3082' },
    blockedCommands: ['personal-gh'],
    trigger
  })
}

describe('the env file', () => {
  test('is one `export K=\'v\'` line per variable, in the table order', () => {
    const directory = join(tempDir('superagent-dir-'), "it's a ticket dir")
    const table = tableFor(directory)
    const path = writeEnvFile({ directory, environment: table, ticketId: 'ticket-11' })

    assert.equal(path, join(directory, '.superagent', 'env.sh'))
    assert.equal(envFilePath(directory), path)
    const exports = readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('export '))
    assert.deepEqual(
      exports.map((line) => line.slice('export '.length, line.indexOf('='))),
      [...ENVIRONMENT_VARIABLES]
    )
    assert.ok(readFileSync(path, 'utf8').includes('do not commit'), 'the file says it must not be committed')
  })

  test('a value with a single quote survives being sourced by /bin/sh unchanged', async () => {
    const directory = join(tempDir('superagent-dir-'), "it's a ticket dir")
    const table = tableFor(directory)
    const path = writeEnvFile({ directory, environment: table, ticketId: 'ticket-11' })

    const read = await new Promise<string>((resolve, reject) => {
      const script = `. "${path}" && printf '%s\\n%s\\n' "$DSH_SUPERAGENT_DIR" "$DSH_SUPERAGENT_TICKET"`
      execFile('/bin/sh', ['-c', script], { encoding: 'utf8', shell: false }, (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      })
    })
    assert.deepEqual(read.split('\n').slice(0, 2), [directory, 'ticket-11'])
  })

  test('renders every value inside single quotes, even an empty one', () => {
    const text = renderEnvFile({ DSH_SUPERAGENT_DIR: '', SUPERAGENT_API: "a'; rm -rf /" })
    assert.ok(text.includes("export DSH_SUPERAGENT_DIR=''"))
    assert.ok(text.includes("export SUPERAGENT_API='a'\\''; rm -rf /'"))
  })
})

describe('keeping the env file out of git', () => {
  test('a linked worktree takes its entry in the common info/exclude, and the base index is untouched', async () => {
    const { base, worktree } = await repoWithWorktree()
    const index = join(base, '.git', 'index')
    const stagedBefore = await git(base, 'ls-files', '-s')
    const indexBefore = statSync(index)

    writeEnvFile({ directory: worktree, environment: tableFor(worktree), ticketId: 'ticket-11' })
    const excluded = ensureExcluded(worktree)

    // linked worktree：`.git` 是文件，git 只读 common dir 的 info/exclude（实测 git 2.56）。
    assert.equal(excluded?.path, gitExcludePath(worktree))
    assert.equal(excluded?.added, true)
    assert.equal(await git(worktree, 'status', '--porcelain'), '', '`.superagent/` is ignored')
    // base repo 的索引：条目内容与索引文件本身都没变（索引不是排除文件）。
    assert.equal(await git(base, 'ls-files', '-s'), stagedBefore, 'the base index entries are untouched')
    assert.deepEqual(
      { size: statSync(index).size, mtimeMs: statSync(index).mtimeMs },
      { size: indexBefore.size, mtimeMs: indexBefore.mtimeMs }
    )
    assert.equal(await git(base, 'status', '--porcelain'), '', 'the base checkout stays clean')

    // 幂等：重复写不再加第二行，也不再报告 added。
    const again = ensureExcluded(worktree)
    assert.equal(again?.added, false)
    const lines = readFileSync(excluded!.path, 'utf8').split('\n').filter((line) => line === ENV_FILE_EXCLUDE_ENTRY)
    assert.deepEqual(lines, [ENV_FILE_EXCLUDE_ENTRY])
  })

  test('the entry is the directory itself, so env.sh never shows up as an untracked change', async () => {
    const { worktree } = await repoWithWorktree()
    writeEnvFile({ directory: worktree, environment: tableFor(worktree), ticketId: 'ticket-11' })
    assert.equal(ENV_FILE_EXCLUDE_ENTRY, '.superagent/')
    await assert.rejects(git(worktree, 'check-ignore', '-q', '.superagent/env.sh'))
    ensureExcluded(worktree)
    assert.equal((await git(worktree, 'check-ignore', '.superagent/env.sh')).trim(), '.superagent/env.sh')
  })

  test('a plain directory outside git is left alone instead of failing the launch', () => {
    const directory = tempDir('superagent-plain-')
    assert.equal(gitExcludePath(directory), null)
    assert.equal(ensureExcluded(directory), null)
  })
})

describe('prepare substitution (§E.3)', () => {
  /** 一次 prepare 的最小输入：假 runtime 记录命令，不真起终端。 */
  function prepareHarness(): {
    runtime: FakeOrcaRuntime
    stateDir: string
    workspace: WorkspaceHandle
  } {
    return {
      runtime: new FakeOrcaRuntime(),
      stateDir: tempDir('superagent-state-'),
      workspace: {
        workspaceId: 'ws:superagent-fix-the-login-flow',
        path: '/worktrees/acme/superagent-fix-the-login-flow',
        branch: 'agent/fix-the-login-flow',
        created: false
      }
    }
  }

  test('the configured command reaches the seam with its variables substituted and quoted', async () => {
    const harness = prepareHarness()
    const result = await runPrepare({
      runtime: harness.runtime,
      ticketId: 'ticket-11',
      assignmentId: 'a-1',
      workspace: harness.workspace,
      command: 'mkdir -p ${DSH_SUPERAGENT_DIR}/tmp && echo ${DSH_SUPERAGENT_TICKET}; echo ${NOT_OURS}',
      stateDir: harness.stateDir,
      environment: {
        DSH_SUPERAGENT_DIR: '/worktrees/acme/fix the login',
        DSH_SUPERAGENT_TICKET: 'ticket-11'
      }
    })
    assert.equal(result.ran, true)
    assert.equal(
      harness.runtime.calls.runCommand[0]?.command,
      `mkdir -p '/worktrees/acme/fix the login'/tmp && echo 'ticket-11'; echo \${NOT_OURS}`
    )
    assert.equal(harness.runtime.calls.runCommand[0]?.timeoutMs, PREPARE_TIMEOUT_MS)
    assert.ok(readFileSync(result.logPath, 'utf8').includes("echo 'ticket-11'"), 'the log keeps the resolved command')
  })

  test('a failing prepare still surfaces its output and the log, and never starts the agent', async () => {
    const harness = prepareHarness()
    harness.runtime.script.runCommand = () => ({ terminalId: 'term_prepare', exitCode: 2, output: ['lockfile is out of date'] })
    await assert.rejects(
      runPrepare({
        runtime: harness.runtime,
        ticketId: 'ticket-11',
        assignmentId: 'a-1',
        workspace: harness.workspace,
        command: 'npm ci',
        stateDir: harness.stateDir,
        environment: {}
      }),
      (error: unknown) => {
        assert.ok(error instanceof PrepareError)
        assert.equal(error.exitCode, 2)
        assert.deepEqual(error.output, ['lockfile is out of date'])
        return true
      }
    )
  })

  test('no configured command means nothing runs', async () => {
    const harness = prepareHarness()
    const result = await runPrepare({
      runtime: harness.runtime,
      ticketId: 'ticket-11',
      assignmentId: 'a-1',
      workspace: harness.workspace,
      command: '   ',
      stateDir: harness.stateDir,
      environment: {}
    })
    assert.equal(result.ran, false)
    assert.equal(harness.runtime.calls.runCommand.length, 0)
  })
})

describe('the agent.launch.before hook (§H.11)', () => {
  /** 一台本插件发起的 launch：Orca 送的载荷（附录 C S4 的实测字段）。 */
  function launchEvent(workspaceId: string | null): LaunchHookEvent {
    return {
      agent: 'pi',
      workspaceId,
      workspaceKind: workspaceId === null ? null : 'worktree',
      command: 'pi',
      env: {}
    }
  }

  /** `next` 的记录器：记下它收到了什么，并原样返回（宿主据此继续 launch）。 */
  function recorder(): { next: (event: LaunchHookEvent) => unknown; seen: LaunchHookEvent[] } {
    const seen: LaunchHookEvent[] = []
    return {
      seen,
      next: (event) => {
        seen.push(event)
        return { kind: 'continue', event }
      }
    }
  }

  test('a launch this plugin started gets its environment injected; every other launch passes unchanged', () => {
    const hook = createLaunchHook()
    const release = hook.expect({
      workspaceId: 'ws:superagent-fix-the-login-flow',
      environment: { DSH_SUPERAGENT_TICKET: 'ticket-11', SUPERAGENT_TOKEN_FILE: '/state/tokens/asg_1' }
    })

    const mine = recorder()
    hook.handle(launchEvent('ws:superagent-fix-the-login-flow'), mine.next)
    assert.deepEqual(mine.seen, [
      {
        ...launchEvent('ws:superagent-fix-the-login-flow'),
        env: { DSH_SUPERAGENT_TICKET: 'ticket-11', SUPERAGENT_TOKEN_FILE: '/state/tokens/asg_1' }
      }
    ])

    // 别人的 launch（同一台机器上的另一个 worktree、或浮动 workspace）：原样放行，不注入。
    for (const workspaceId of ['ws:someone-else', null]) {
      const other = recorder()
      hook.handle(launchEvent(workspaceId), other.next)
      assert.deepEqual(other.seen, [launchEvent(workspaceId)], `${String(workspaceId)} is untouched`)
    }
    release()
  })

  test('one launch consumes the entry: a second launch of the same worktree gets nothing', () => {
    const hook = createLaunchHook()
    hook.expect({ workspaceId: 'ws:ticket', environment: { DSH_SUPERAGENT_TICKET: 'ticket-11' } })

    const first = recorder()
    hook.handle(launchEvent('ws:ticket'), first.next)
    assert.deepEqual(first.seen[0]?.env, { DSH_SUPERAGENT_TICKET: 'ticket-11' })

    // 同 worktree 里人手动开一个 agent：env 保持空（只影响本插件发起的 launch）。
    const second = recorder()
    hook.handle(launchEvent('ws:ticket'), second.next)
    assert.deepEqual(second.seen[0]?.env, {})
  })

  test('a hook slower than the two second budget passes without injecting, and says so', () => {
    const lines: string[] = []
    const times = [1_000, 1_000 + HOOK_BUDGET_MS + 1]
    const hook = createLaunchHook({ now: () => times.shift() ?? 0, log: (line) => lines.push(line) })
    hook.expect({ workspaceId: 'ws:ticket', environment: { DSH_SUPERAGENT_TICKET: 'ticket-11' } })

    const slow = recorder()
    hook.handle(launchEvent('ws:ticket'), slow.next)
    assert.deepEqual(slow.seen[0]?.env, {}, 'over budget: the launch goes on without the environment')
    assert.equal(HOOK_BUDGET_MS, 2_000)
    assert.equal(lines.length, 1)
    assert.ok(/budget/.test(lines[0] ?? ''))

    // 预算内（同一个时钟下一次读数没到上限）就照常注入。
    const inBudget = createLaunchHook({ now: () => 5_000 })
    inBudget.expect({ workspaceId: 'ws:ticket', environment: { DSH_SUPERAGENT_TICKET: 'ticket-11' } })
    const fast = recorder()
    inBudget.handle(launchEvent('ws:ticket'), fast.next)
    assert.deepEqual(fast.seen[0]?.env, { DSH_SUPERAGENT_TICKET: 'ticket-11' })
  })

  test('a failure inside the hook still lets the launch go on, and is logged', () => {
    const lines: string[] = []
    const hook = createLaunchHook({ log: (line) => lines.push(line) })
    const broken = {
      expect: () => hook.expect,
      handle: () => undefined
    }
    void broken
    // 让取 entry 这条路自己炸：workspaceId 的 getter 抛错。
    const hostile = {
      ...launchEvent('ws:ticket'),
      get workspaceId(): string | null {
        throw new Error('boom')
      }
    }
    hook.expect({ workspaceId: 'ws:ticket', environment: { DSH_SUPERAGENT_TICKET: 'ticket-11' } })
    const next = recorder()
    const decision = hook.handle(hostile, next.next)
    assert.deepEqual(next.seen, [hostile], 'fail-open: the launch proceeds with the original event')
    assert.equal(lines.length, 1)
    assert.ok(/boom/.test(lines[0] ?? ''))
    assert.deepEqual(decision, { kind: 'continue', event: hostile })
    // hook 永远不返回 deny：返回值就是 next 的返回值。
    assert.equal('deny' in (decision as object), false)
  })

  test('releasing an unused expectation leaves nothing behind for the next launch', () => {
    const hook = createLaunchHook()
    const release = hook.expect({ workspaceId: 'ws:ticket', environment: { DSH_SUPERAGENT_TICKET: 'ticket-11' } })
    release() // 宿主没走钩子（恢复会话、或 launch 在注册前就失败）
    const later = recorder()
    hook.handle(launchEvent('ws:ticket'), later.next)
    assert.deepEqual(later.seen[0]?.env, {})
  })

  test('the injected environment prepends the shim directory and sets the worker git config', () => {
    assert.deepEqual(
      launchEnvironment({
        environment: { DSH_SUPERAGENT_TICKET: 'ticket-11' },
        binDirectory: '/state/bin',
        gitConfig: '/state/worker-gitconfig',
        basePath: '/usr/local/bin:/usr/bin'
      }),
      {
        DSH_SUPERAGENT_TICKET: 'ticket-11',
        PATH: '/state/bin:/usr/local/bin:/usr/bin',
        GIT_CONFIG_GLOBAL: '/state/worker-gitconfig'
      }
    )
    // 没有既有 PATH 时也不留一个空段（空段等于把当前目录放进 PATH）。
    assert.deepEqual(
      launchEnvironment({ environment: {}, binDirectory: '/state/bin', basePath: '' }),
      { PATH: '/state/bin' }
    )
  })
})

describe('the blocked-command shims (§H.11 第 c 条)', () => {
  /** 跑一个 shim：返回退出码与 stderr（真执行，不看脚本文本）。 */
  function run(path: string): Promise<{ code: number; stderr: string }> {
    return new Promise((resolve) => {
      execFile(path, [], { encoding: 'utf8', shell: false }, (error, _stdout, stderr) => {
        resolve({ code: error?.code === undefined || typeof error.code !== 'number' ? 0 : error.code, stderr })
      })
    })
  }

  test('a blocked command exits non-zero and says why; the shim directory also holds nothing else', async () => {
    const stateDir = tempDir('superagent-state-')
    const result = writeCommandShims({
      binDirectory: join(stateDir, 'bin'),
      blockedCommands: ['personal-gh', 'gh-legacy']
    })
    assert.deepEqual([...result.written], ['personal-gh', 'gh-legacy'])
    const blocked = await run(join(stateDir, 'bin', 'personal-gh'))
    assert.equal(blocked.code, 1)
    assert.ok(/personal-gh is blocked/.test(blocked.stderr))
    assert.ok(/not a security boundary/.test(blocked.stderr), 'the shim itself says it is not a boundary')
    assert.deepEqual(result.skipped, [])
  })

  test('a command name that could escape the directory is ignored, and foreign files are never overwritten', async () => {
    const stateDir = tempDir('superagent-state-')
    writeFileSync(join(stateDir, 'foreign'), '#!/bin/sh\nexit 0\n')
    const result = writeCommandShims({
      binDirectory: stateDir,
      blockedCommands: ['../escape', 'a/b', '', 'mine']
    })
    assert.deepEqual([...result.written], ['mine'], 'only plain command names get a shim')
    assert.equal(readFileSync(join(stateDir, 'foreign'), 'utf8'), '#!/bin/sh\nexit 0\n', 'a file we did not write is left alone')
    // 重复写是幂等的：同一个名字不会报告第二次写。
    const again = writeCommandShims({ binDirectory: stateDir, blockedCommands: ['mine'] })
    assert.deepEqual([...again.written], [])
    assert.deepEqual([...again.skipped], [])
    assert.equal((await run(join(stateDir, 'mine'))).code, 1)
  })
})

describe('no code path turns message text into a shell string (§O)', () => {
  /** 生产代码（`src/worker`）的全部 TypeScript 文件。 */
  const CODE_FILES = listFiles('src/worker', '.ts')

  /** 只留代码行：整行注释里写「绝不拼 shell」不算违规。 */
  function codeLines(file: string): { readonly line: string; readonly number: number }[] {
    return readRepoFile(file)
      .split('\n')
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
  }

  /** 消息正文在代码里的形态（Trigger / Input / 回复正文）。 */
  const MESSAGE_TEXT = /(?:trigger|input|message|reply|\.text\b)[^\n]*\.(?:text|title)\b|\btrigger\.text\b|\binput\.text\b/

  /** 会把字符串交给 shell / 子进程的位置。 */
  const SHELL_POSITION =
    /(?:runCommand\s*\(|command\s*:|shell\s*:\s*true|\bsh['"],\s*\[['"]-c\b|\bexecFile\s*\(|\bexecSync\s*\(|\bexec\s*\()/

  /** 一段源码里同时落在「shell 位置」又携带消息正文的代码行（注释不算）。 */
  function offendingLines(source: string): { readonly line: string; readonly number: number }[] {
    return source
      .split('\n')
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
      .filter(({ line }) => SHELL_POSITION.test(line) && MESSAGE_TEXT.test(line))
  }

  /** 同时是「shell 位置」又携带消息正文的代码行，按 `file:line` 报。 */
  function shellTextLines(files: readonly string[]): string[] {
    return files.flatMap((file) =>
      offendingLines(readRepoFile(file)).map(
        ({ line, number }) => `${file}:${number}: ${line.trim()}`
      )
    )
  }

  test('the scanner looks at the whole worker and catches the shape it forbids', () => {
    assert.ok(CODE_FILES.length > 30, 'the scan is not looking at an empty file set')
    assert.equal(shellTextLines(CODE_FILES).length, 0, 'the real tree is clean')
    // 灵敏度自测：这两行正是「把消息正文拼进命令」的形态；扫描器漏掉它就是假绿。
    const sample = [
      'runCommand({ command: `echo ${trigger.text} | sh` })',
      'const spec = { command: trigger.text }',
      '// a comment quoting trigger.text next to command: is not a violation',
      'const brief = trigger.text'
    ].join('\n')
    assert.equal(offendingLines(sample).length, 2)
  })

  test('no worker code puts message text where a shell or a subprocess reads it', () => {
    assert.deepEqual(shellTextLines(CODE_FILES), [])
  })

  test('the substitution table is the only place that knows the variable names', () => {
    const owners = CODE_FILES.filter((file) =>
      codeLines(file).some(({ line }) => line.includes('DSH_SUPERAGENT_'))
    )
    assert.deepEqual(owners, ['src/worker/executor/environment.ts'])
  })

  test('only the command port starts a child process, so text can never reach a shell elsewhere', () => {
    const importers = CODE_FILES.filter((file) => codeLines(file).some(({ line }) => line.includes("'node:child_process'")))
    assert.deepEqual(importers, ['src/worker/sources/commands.ts'])
  })
})

describe('the hook log sink', () => {
  test('a wired sink receives the fail-open and over-budget lines', () => {
    const lines: string[] = []
    const hook = createLaunchHook()
    hook.setLog((line) => lines.push(line))
    // 让 workspaceId 的读取自己抛错：处理体失败，必须留一行日志。
    const hostile = {
      agent: 'pi',
      workspaceKind: 'worktree' as const,
      command: 'pi',
      env: {},
      get workspaceId(): string | null {
        throw new Error('boom')
      }
    }
    hook.handle(hostile, (event) => event)
    assert.equal(lines.length, 1)
    assert.ok(/boom/.test(lines[0] ?? ''))

    // 超预算同样留一行（时钟注入让这次读数是 2 s 之后）。
    hook.setLog((line) => lines.push(line))
    const times = [1_000, 1_000 + HOOK_BUDGET_MS + 1]
    const slow = createLaunchHook({ now: () => times.shift() ?? 0 })
    const slowLines: string[] = []
    slow.setLog((line) => slowLines.push(line))
    slow.expect({ workspaceId: 'ws:ticket', environment: { DSH_SUPERAGENT_TICKET: 'ticket-11' } })
    slow.handle(
      { agent: 'pi', workspaceId: 'ws:ticket', workspaceKind: 'worktree', command: 'pi', env: {} },
      (event) => event
    )
    assert.equal(slowLines.length, 1)
    assert.ok(/budget/.test(slowLines[0] ?? ''))
  })
})

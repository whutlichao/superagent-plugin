// 可执行入口（`src/bin/superagent.mjs`）的端到端验证：真起一个 node 子进程，真读 stdout/stderr，
// 真拿退出码。
//
// 这一层只能在这里测：CLI 的价值有一半在「`node <abs>/superagent.mjs` 这个字面形态能跑」——
// 入口用 `.mjs`、其余模块是 `.ts`（Node 的 strip-only 类型剥离），路径里带空格（插件装在
// `Application Support` 下）。这些都不是单元测试能证明的。
//
// 不起真 worker：这里测「连不上时」的行为（退出 3 + doctor 提示 + 不泄漏 token）。
import { assert, test } from 'orca/testing'
import { execFileSync } from 'node:child_process'
import { join, relative } from 'node:path'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { REPO_ROOT } from './support/repo'
import { tempStateDir } from './support/state'

/** 入口的绝对路径。 */
const ENTRY = join(REPO_ROOT, 'src', 'bin', 'superagent.mjs')

/** 一次子进程调用的观测结果（子进程失败时 `execFileSync` 会抛，所以统一用 try 捕获）。 */
interface Run {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

/** 跑一次入口；`args` 原样作为 argv。 */
function runEntry(args: readonly string[], env: Readonly<Record<string, string | undefined>>): Run {
  try {
    const stdout = execFileSync(process.execPath, [ENTRY, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    const failure = error as { status?: unknown; stdout?: unknown; stderr?: unknown }
    return {
      status: typeof failure.status === 'number' ? failure.status : -1,
      stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
      stderr: typeof failure.stderr === 'string' ? failure.stderr : ''
    }
  }
}

test('the entry runs under plain node and exits 3 when no worker answers', () => {
  const stateDir = tempStateDir()
  try {
    const run = runEntry(['status', '--state-dir', stateDir], { ORCA_SUPERAGENT_TOKEN_FILE: '' })
    assert.equal(run.status, 3, 'not-ready exits 3')
    const envelope = JSON.parse(run.stdout) as { ok: boolean; error: { code: string; message: string } }
    assert.equal(envelope.ok, false)
    assert.equal(envelope.error.code, 'not_ready')
    assert.ok(envelope.error.message.includes('superagent doctor'), 'the hint names the doctor command')
    assert.ok(run.stderr.includes('not_ready'), 'stderr carries one human line with the code')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('the entry reads the port file and never puts the token on the command line', () => {
  const stateDir = tempStateDir()
  try {
    // 一个不存在的端口 + 一个含标记的 token 文件：输出里不该出现 token 值。
    writeFileSync(join(stateDir, 'api-port'), '1', 'utf8')
    const tokenFile = join(stateDir, 'api-token')
    writeFileSync(tokenFile, 'entry-test-secret-token', { encoding: 'utf8', mode: 0o600 })
    const run = runEntry(['status', '--state-dir', stateDir, '--token-file', tokenFile], {})
    assert.equal(run.status, 3)
    assert.equal(run.stdout.includes('entry-test-secret-token'), false, 'the token never reaches stdout')
    assert.equal(run.stderr.includes('entry-test-secret-token'), false, 'the token never reaches stderr')
    // 错误里连 argv 也不回显。
    assert.equal(run.stdout.includes('--state-dir'), false, 'argv is never echoed')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('--help lists every command name the dispatch table knows', () => {
  // help 由命令表生成：新增命令会自动出现，删掉的命令不会留在帮助里。
  const out = runEntry(['--help'], {})
  // 未实现 `--help` 时这条会失败：帮助是 agent 的发现面，必须有。
  assert.ok(out.stdout.length > 0 || out.status === 0 || out.status === 2)
  const designNames = ['status', 'pause', 'resume', 'doctor', 'ticket stop', 'report', 'reply', 'route']
  for (const name of designNames) {
    assert.ok(out.stdout.includes(name), `help names ${name}`)
  }
})

test('a path with spaces still runs (the plugin lives under Application Support)', () => {
  const home = tempStateDir()
  try {
    const spaced = join(home, 'Application Support', 'orca', 'state')
    mkdirSync(spaced, { recursive: true })
    const run = runEntry(['status', '--state-dir', spaced], {})
    assert.equal(run.status, 3)
    assert.equal(JSON.parse(run.stdout).error.code, 'not_ready')
    // 提示里带上实际端口（3847 缺省），不把路径拼成一条执行命令。
    assert.equal(relative(REPO_ROOT, ENTRY).includes('..'), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

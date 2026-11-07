// `worker-gitconfig`（§H.11）：`<stateDir>/worker-gitconfig` 的内容、权限与「只有文件存在才注入」。
//
// 断言按外部行为写：把文件交给**真的 git**（`git config --file`、`git config --get` 与一次真
// `git commit`），而不是把渲染算法再算一遍。身份与凭据 helper 都来自部署事实；文件里绝不出现
// token、secret 或操作者个人身份。
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GITCONFIG_MODE,
  WORKER_GITCONFIG_FILE,
  renderWorkerGitConfig,
  workerGitConfigPath,
  writeWorkerGitConfig
} from '../src/worker/infra/gitconfig'
import { launchEnvironment } from '../src/worker/executor/launch-hook'

/** 部署事实里的 agent 账号与其 noreply 邮箱（与 `DSH_SUPERAGENT_GITHUB_*` 同源）。 */
const ACCOUNT = 'acme-agent'
const EMAIL = '1+acme-agent@users.noreply.github.com'

const directories: string[] = []

/** 一个临时目录（用例结束删掉）。 */
function tempDir(prefix: string): string {
  const created = mkdtempSync(join(tmpdir(), prefix))
  directories.push(created)
  return created
}

/** 每个用例结束清掉自己造的目录（与 `execution-environment.test.ts` 同一口径）。 */
function cleanup(): void {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
}

/** 隔离操作者的 git 配置：只有这份文件提供身份，系统配置与 `HOME` 都是空的。 */
function gitEnvironment(configPath: string, home: string): Record<string, string | undefined> {
  return {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: home,
    GIT_CONFIG_GLOBAL: configPath,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0'
  }
}

/** 跑一次 git（argv 数组、`shell:false`）。 */
function git(cwd: string, args: readonly string[], env: Record<string, string | undefined>): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', shell: false })
}

describe('the worker git config file (§H.11)', () => {
  test('it exists with mode 0600 and holds only the helper, the rewrite and the identity', () => {
    const stateDir = tempDir('superagent-gitconfig-')
    try {
      const outcome = writeWorkerGitConfig({ stateDir, account: ACCOUNT, email: EMAIL })
      assert.equal(outcome.state, 'written')
      const path = workerGitConfigPath(stateDir)
      assert.equal(path, join(stateDir, WORKER_GITCONFIG_FILE))
      assert.equal(existsSync(path), true, 'the file exists after the write')
      assert.equal(statSync(path).mode & 0o777, GITCONFIG_MODE, 'mode 0600')
      assert.equal(GITCONFIG_MODE, 0o600)

      // git 自己解析出来的键正好是这四个（不读我们自己渲染的文本比对）。
      const listed = git(stateDir, ['config', '--file', path, '--list'], gitEnvironment(path, stateDir))
        .trim()
        .split('\n')
        .map((line) => line.slice(0, line.indexOf('=')))
        .sort()
      assert.deepEqual(listed, [
        'credential.https://github.com.helper',
        'url.https://github.com/.insteadof',
        'user.email',
        'user.name'
      ])

      const env = gitEnvironment(path, stateDir)
      assert.equal(
        git(stateDir, ['config', '--file', path, '--get', 'credential.https://github.com.helper'], env),
        '!gh auth git-credential\n',
        'the helper is the agent account gh'
      )
      assert.equal(
        git(stateDir, ['config', '--file', path, '--get', 'url.https://github.com/.insteadOf'], env),
        'git@github.com:\n',
        'SSH URIs are rewritten to HTTPS'
      )
      assert.equal(git(stateDir, ['config', '--file', path, '--get', 'user.name'], env), `${ACCOUNT}\n`)
      assert.equal(git(stateDir, ['config', '--file', path, '--get', 'user.email'], env), `${EMAIL}\n`)

      // 文件里没有 token、secret 或操作者身份（只有部署的 agent 账号）。
      const text = readFileSync(path, 'utf8')
      for (const forbidden of ['ghp_', 'Bearer', 'token=', 'secret', 'operator', 'root@']) {
        assert.equal(text.includes(forbidden), false, `the file never contains ${forbidden}`)
      }
    } finally {
      cleanup()
    }
  })

  test('git resolves the helper and the rewrite and commits with the agent identity', () => {
    const stateDir = tempDir('superagent-gitconfig-')
    try {
      const outcome = writeWorkerGitConfig({ stateDir, account: ACCOUNT, email: EMAIL })
      assert.equal(outcome.state, 'written')
      const configPath = outcome.path
      const home = tempDir('superagent-gitconfig-home-')
      const base = tempDir('superagent-gitconfig-repo-')
      const env = gitEnvironment(configPath, home)
      // 不联网、不依赖操作者配置：`git config` 的解析结果就是这份文件。
      assert.equal(
        git(base, ['config', '--get', 'url.https://github.com/.insteadOf'], env),
        'git@github.com:\n'
      )
      assert.equal(
        git(base, ['config', '--get', 'credential.https://github.com.helper'], env),
        '!gh auth git-credential\n'
      )
      // Orca 建的是 linked worktree（附录 C S3）：在它里面提交才是真实场景。
      git(base, ['init', '-q', '-b', 'main'], env)
      writeFileSync(join(base, 'note.txt'), 'note\n', 'utf8')
      git(base, ['add', 'note.txt'], env)
      git(base, ['commit', '-q', '-m', 'base'], env)
      const worktree = join(base, 'ticket-52-worktree')
      git(base, ['worktree', 'add', '-q', '-b', 'ticket-52', worktree], env)
      writeFileSync(join(worktree, 'work.txt'), 'work\n', 'utf8')
      git(worktree, ['add', 'work.txt'], env)
      git(worktree, ['commit', '-q', '-m', 'from the agent account'], env)
      const identity = git(worktree, ['log', '-1', '--format=%an <%ae>'], env)
      assert.equal(identity, `${ACCOUNT} <${EMAIL}>\n`, 'the commit carries the worker identity')
    } finally {
      cleanup()
    }
  })

  test('an unfinished deployment writes nothing: no account or email means no file', () => {
    const stateDir = tempDir('superagent-gitconfig-')
    try {
      for (const identity of [
        { account: '', email: EMAIL },
        { account: ACCOUNT, email: '' },
        { account: '   ', email: '   ' }
      ]) {
        const outcome = writeWorkerGitConfig({ stateDir, ...identity })
        assert.equal(outcome.state, 'missing_identity', JSON.stringify(identity))
        assert.equal(existsSync(workerGitConfigPath(stateDir)), false, 'a partial identity never severs the global config')
      }
      // 部分内容也渲染不出来（渲染器只接受完整身份）。
      assert.throws(() => renderWorkerGitConfig({ account: '', email: EMAIL }))
    } finally {
      cleanup()
    }
  })

  test('a rewrite takes the file back: mode fixed to 0600 and no stale key survives', () => {
    const stateDir = tempDir('superagent-gitconfig-')
    try {
      const path = workerGitConfigPath(stateDir)
      // 上一版留下的文件：多一个键、权限过宽。
      writeFileSync(path, '[user]\n\tname = somebody\n\tsigningkey = SECRET\n', 'utf8')
      chmodSync(path, 0o644)
      const outcome = writeWorkerGitConfig({ stateDir, account: ACCOUNT, email: EMAIL })
      assert.equal(outcome.state, 'written')
      assert.equal(statSync(path).mode & 0o777, 0o600, 'the mode is tightened')
      const text = readFileSync(path, 'utf8')
      assert.equal(text.includes('SECRET'), false, 'the old key is gone, not merged')
      assert.equal(text.includes('somebody'), false)
      assert.deepEqual(
        git(stateDir, ['config', '--file', path, '--get-regexp', '.*'], gitEnvironment(path, stateDir))
          .trim()
          .split('\n')
          .length,
        4
      )
    } finally {
      cleanup()
    }
  })

  test('a path that cannot be a file is reported, never thrown', () => {
    const stateDir = tempDir('superagent-gitconfig-')
    try {
      // 同名目录占着位置：写文件不可能成功。
      mkdirSync(workerGitConfigPath(stateDir), { recursive: true })
      const outcome = writeWorkerGitConfig({ stateDir, account: ACCOUNT, email: EMAIL })
      assert.equal(outcome.state, 'failed')
      assert.ok(outcome.state === 'failed' && outcome.detail.length > 0, 'the reason is kept for the setup issue')
    } finally {
      cleanup()
    }
  })
})

describe('GIT_CONFIG_GLOBAL is injected only when the file exists (§H.11)', () => {
  test('an existing file is injected; a missing one is not', () => {
    const stateDir = tempDir('superagent-gitconfig-')
    try {
      const path = workerGitConfigPath(stateDir)
      const missing = launchEnvironment({
        environment: { DSH_SUPERAGENT_TICKET: 'ticket-11' },
        binDirectory: join(stateDir, 'bin'),
        gitConfig: path,
        basePath: '/usr/bin:/bin'
      })
      assert.equal('GIT_CONFIG_GLOBAL' in missing, false, 'a missing file must not sever the operator config')

      const written = writeWorkerGitConfig({ stateDir, account: ACCOUNT, email: EMAIL })
      assert.equal(written.state, 'written')
      assert.deepEqual(
        launchEnvironment({
          environment: { DSH_SUPERAGENT_TICKET: 'ticket-11' },
          binDirectory: join(stateDir, 'bin'),
          gitConfig: path,
          basePath: '/usr/bin:/bin'
        }),
        {
          DSH_SUPERAGENT_TICKET: 'ticket-11',
          PATH: `${join(stateDir, 'bin')}:/usr/bin:/bin`,
          GIT_CONFIG_GLOBAL: path
        }
      )

      // 同名目录不是一份可读的配置：当成「不在」，也不注入。
      rmSync(path)
      mkdirSync(path, { recursive: true })
      assert.equal(
        'GIT_CONFIG_GLOBAL' in launchEnvironment({ environment: {}, gitConfig: path }),
        false,
        'a directory is not a git config file'
      )
    } finally {
      cleanup()
    }
  })
})

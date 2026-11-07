// 组合根（boot）的测试夹具：真库 + 假 Orca 缝 + 假 CLI + 真临时目录（§P.1）。
//
// 不发网络、不 sleep：定时器关闭，测试用 `pollOnce`/`passOnce` 手动推进；HTTP 仍是真
// loopback 服务器（CLI 的 status/read 走真 HTTP）。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootPlugin, type BootHandle } from '../../src/worker/boot.ts'
import { readRepoJson } from './repo.ts'
import { FakeOrcaRuntime } from './fake-orca-runtime.ts'
import { FakeCommands } from './fake-commands.ts'

/** 一条通知（`gh api notifications`）。 */
export const NOTIFICATION = {
  id: 'notification-1',
  unread: true,
  reason: 'mention',
  updated_at: '2026-11-07T03:26:00Z',
  last_read_at: '2026-11-07T03:25:00Z',
  subject: {
    title: 'Fix the login redirect',
    url: 'https://api.github.com/repos/acme/widgets/issues/42',
    type: 'Issue'
  },
  repository: { full_name: 'acme/widgets' }
}

/** 一条点名 agent 的 Issue 评论。 */
export const COMMENT = {
  id: 9001,
  user: { login: 'alice', type: 'User' },
  body: '@acme-agent please fix the login redirect before Friday.',
  created_at: '2026-11-07T03:25:30Z',
  updated_at: '2026-11-07T03:25:30Z',
  html_url: 'https://github.com/acme/widgets/issues/42#issuecomment-9001'
}

/** 一份最小可用设置：仓库、base repo、允许名单都在。 */
export function settingsOf(stateDir: string): Record<string, unknown> {
  return {
    stateDir,
    agent: 'pi',
    baseRepo: '/repos/widgets',
    executor: { agent: 'pi', maxWorkers: 2, confirmDelivery: false },
    sources: {
      github: { enabled: true, config: { repository: 'acme/widgets', cli: 'gh', pollSeconds: 60 } }
    },
    policy: { sources: { github: { allowed: [{ id: 'alice' }] } } }
  }
}

/** 一套装好的夹具：boot 句柄、假缝、假 CLI、清理函数。 */
export interface BootHarness {
  readonly handle: BootHandle
  readonly runtime: FakeOrcaRuntime
  readonly commands: FakeCommands
  readonly stateDir: string
  readonly worktrees: string
  cleanup(): Promise<void>
}

/** 起一次 boot（默认：一条通知、一条点名评论、gh 账号可读）。 */
export async function openBoot(options: {
  readonly stateDir?: string
  readonly scriptComment?: boolean
  readonly settings?: Record<string, unknown>
  /**
   * 在缺省脚本**之前**注册自己的脚本（`FakeCommands` 先注册者优先）：用来模拟
   * 「第一次调用失败、之后成功」（例如人刚做完 `gh auth login`）。
   */
  readonly scripts?: (commands: FakeCommands) => void
  readonly boot?: (stateDir: string, runtime: FakeOrcaRuntime, commands: FakeCommands) => Promise<BootHandle>
} = {}): Promise<BootHarness> {
  const stateDir = options.stateDir ?? mkdtempSync(join(tmpdir(), 'superagent-boot-'))
  const worktrees = mkdtempSync(join(tmpdir(), 'superagent-worktrees-'))
  const runtime = new FakeOrcaRuntime()
  runtime.worktreeRoot = worktrees
  const commands = new FakeCommands()
  options.scripts?.(commands)
  // setup 探针会问 `git --version`（§I.4：worker 需要 git）；不脚本化就等于「没装」。
  commands.script('git --version', () => 'git version 2.39.0\n')
  commands.script('gh api user', () => 'acme-agent\n')
  commands.script('gh api notifications', () => JSON.stringify([NOTIFICATION]))
  // 通知的 subject 先展开成 Issue 读取（§I.2「通知轮询」行），再读评论。
  commands.script(['api', 'repos/acme/widgets/issues/42'], () =>
    JSON.stringify(readRepoJson('tests/fixtures/cli/github/issue.json'))
  )
  // 读评论与写评论是同一个路径、不同的参数形状：脚本必须带上区分两者的那一段
  // （读带 `--paginate`，写带 `-f body=…`），否则先注册的读脚本会把写调用也吃掉。
  commands.script(['api', 'repos/acme/widgets/issues/42/comments', '--paginate'], () =>
    JSON.stringify(options.scriptComment === false ? [] : [COMMENT])
  )
  commands.script(['api', 'repos/acme/widgets/issues/42/comments?per_page=100', '-q'], () => '')
  commands.script(['api', 'repos/acme/widgets/issues/42/comments', '-f'], () => '{}')
  const settings = options.settings ?? settingsOf(stateDir)
  const handle = await (options.boot?.(stateDir, runtime, commands) ??
    bootPlugin({
      runtime,
      readSettings: async () => settings,
      // 假 CLI 必须真的进组合根：否则 poll 会跑操作者机器上的真 `gh`（§I.6）。
      commands,
      stateDir,
      disableTimers: true
    }))
  return {
    handle,
    runtime,
    commands,
    stateDir,
    worktrees,
    cleanup: async () => {
      await handle.shutdown()
      rmSync(stateDir, { recursive: true, force: true })
      rmSync(worktrees, { recursive: true, force: true })
    }
  }
}

/** 一个 Assignment 的 token（boot 在 launch 时签发到 `tokens/<assignmentId>`）。 */
export function assignmentToken(stateDir: string, assignmentId: string): string {
  return readFileSync(join(stateDir, 'tokens', assignmentId), 'utf8').trim()
}

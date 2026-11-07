// 运行缝的 launch 回执与反查（#16 的附录 C 实测）：真实宿主上
// `orca agent launch --surface terminal --json` 的终端句柄在 `result.outcome.handle`，
// 不在早期记录的 `result.launch.outcome.handle`；并且 `terminal list` 对「没有可见 pane 的
// 后台 agent 终端」给 `orphaned: true, connected: true`——它仍然是我们要的那个会话。
//
// 这两点由本票的 Router 启动路径直接依赖：读错字段会让每次 launch 都走 `agent_gone` 反查，
// 而反查若把 orphaned 当死亡，就永远找不到自己刚起的会话。
//
// 测试只经 seam 的公开方法观察；宿主与 CLI 都是替身（§P.1：集成测试只替换这一层）。
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHostRuntime } from '../src/worker/runtime/host-runtime'
import type { OrcaCli } from '../src/worker/runtime/cli'
import type { OrcaWorkerApi } from '../src/worker/runtime/worker-api'
import type { WorkspaceHandle } from '../src/worker/runtime/orca-runtime'

/** 一个只实现 launch 会用到的面的宿主替身。 */
function fakeHost(): OrcaWorkerApi {
  return {
    api: { major: 1, minor: 3, locale: 'en' },
    host: {
      has: () => true,
      call: async (method: string) => {
        if (method === 'workspace.list') return { workspaces: [] }
        return {}
      }
    },
    commands: {},
    events: {},
    hooks: {},
    panels: {},
    storage: {},
    settings: {},
    secrets: {},
    grantedCapabilities: [],
    log: () => undefined
  } as unknown as OrcaWorkerApi
}

/** 一个按命令回话的 CLI 替身：记录 argv，返回脚本给的结果。 */
function fakeCli(answers: (args: readonly string[]) => unknown): OrcaCli & {
  readonly calls: readonly (readonly string[])[]
} {
  const calls: (readonly string[])[] = []
  return {
    calls,
    async run(args: readonly string[]) {
      calls.push(args)
      return answers(args)
    }
  }
}

const WORKSPACE: WorkspaceHandle = {
  workspaceId: 'ws:router',
  path: '/w/superagent-router',
  branch: null,
  created: false
}

describe('the launch receipt on Orca 1.4.251', () => {
  test('the terminal handle comes from result.outcome.handle', async () => {
    // 实测回执（附录 C 的 #16 记录，字段名原样）：
    //   { outcome: { kind: 'terminal', handle: 'term_…', paneKey: '…' },
    //     worktreeId: '…', receipt: { mode: 'terminal', … }, prompt: { delivery: 'submit' },
    //     placement: { groupId: '…' }, operationId: '…' }
    const cli = fakeCli((args) =>
      args[0] === 'agent'
        ? {
            outcome: { kind: 'terminal', handle: 'term_measured', paneKey: 'tab:leaf' },
            worktreeId: WORKSPACE.workspaceId,
            receipt: { mode: 'terminal', preferred: 'terminal', reason: 'requested' },
            prompt: { delivery: 'submit', outcome: 'handed-to-terminal' }
          }
        : { terminals: [] }
    )
    const runtime = createHostRuntime(fakeHost(), { cli })
    const handle = await runtime.launchAgent({
      workspace: WORKSPACE,
      agent: 'pi',
      surface: 'terminal',
      prompt: 'hello'
    })
    assert.equal(handle.terminalId, 'term_measured')
    assert.equal(handle.workspaceId, 'ws:router')
    // 回执里有句柄，就不该再去反查（那会多一次终端枚举与 200 ms 的抖动）。
    assert.deepEqual(
      cli.calls.filter((args) => args[0] === 'terminal' && args[1] === 'list'),
      []
    )
  })

  test('an orphaned-but-connected terminal is still the agent we launched', async () => {
    // 实测：起在没打开的 worktree 里的 agent 终端是 `connected: true, orphaned: true`
    // （它只是没有挂载到可见 pane）。反查必须把它算作命中，否则插件永远找不到自己刚起的会话。
    const cli = fakeCli(() => ({
      terminals: [
        {
          handle: 'term_background',
          worktreeId: 'ws:router',
          worktreePath: '/w/superagent-router',
          title: 'π - superagent-router',
          connected: true,
          orphaned: true
        }
      ]
    }))
    const runtime = createHostRuntime(fakeHost(), { cli })
    const found = await runtime.findAgent('ws:router')
    assert.equal(found?.terminalId, 'term_background')
  })

  test('a disconnected terminal is not adopted', async () => {
    const cli = fakeCli(() => ({
      terminals: [
        { handle: 'term_dead', worktreeId: 'ws:router', connected: false, orphaned: true }
      ]
    }))
    const runtime = createHostRuntime(fakeHost(), { cli })
    assert.equal(await runtime.findAgent('ws:router'), null)
  })
})

// setup 探针要用的两条只读仓库查询（§E.1 base repo / base ref 行）：
// `orca repo list --json` 的仓库行与 `orca repo search-refs --json` 的命中 ref。
// 它们只读、不建 worktree；探针因此不会因为「查一下」而改动操作者的 Orca。
describe('the repo probes of the setup check', () => {
  test('repo list reads id/path/displayName from the CLI envelope', async () => {
    const cli = fakeCli((args) =>
      args[0] === 'repo' && args[1] === 'list'
        ? {
            repos: [
              { id: 'repo-1', path: '/repos/widgets', displayName: 'widgets' },
              // 缺 id 或 path 的行不是可用的仓库：跳过而不是编一个。
              { displayName: 'broken' }
            ]
          }
        : {}
    )
    const runtime = createHostRuntime(fakeHost(), { cli })
    assert.deepEqual(await runtime.listRepos(), [
      { id: 'repo-1', path: '/repos/widgets', name: 'widgets' }
    ])
    assert.deepEqual(cli.calls[0], ['repo', 'list'])
  })

  test('search-refs passes the selector and the query, and returns the refs', async () => {
    const cli = fakeCli(() => ({ refs: ['main', 'origin/main'], truncated: false }))
    const runtime = createHostRuntime(fakeHost(), { cli })
    assert.deepEqual(await runtime.searchRefs({ path: '/repos/widgets' }, 'main'), ['main', 'origin/main'])
    assert.deepEqual(cli.calls[0], [
      'repo',
      'search-refs',
      '--repo',
      'path:/repos/widgets',
      '--query',
      'main'
    ])
    // 名称与 id 选择器用同一条规则（与 worktree create 的 `--repo` 前缀一致）。
    await runtime.searchRefs({ id: 'repo-1' }, 'release')
    assert.equal(cli.calls[1]?.[3], 'id:repo-1')
  })

  test('a missing orca CLI surfaces as a seam error, not as an empty list', async () => {
    const cli: OrcaCli = {
      async run() {
        throw Object.assign(new Error('spawn orca ENOENT'), { code: 'cli_missing' })
      }
    }
    const runtime = createHostRuntime(fakeHost(), { cli })
    await assert.rejects(runtime.listRepos(), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'cli_missing')
      return true
    })
  })
})

describe('removing a worktree (§E.1「清理」)', () => {
  test('removes by path with the documented flags and reports no value beyond success', async () => {
    const cli = fakeCli(() => ({ ok: true, result: { removed: true } }))
    const runtime = createHostRuntime(fakeHost(), { cli })
    await runtime.removeWorkspace({ workspaceId: 'repo-1::/repos/widgets/superagent-fix', path: '/repos/widgets/superagent-fix' })
    // 附录 C S3 实测过的形态：`worktree rm --worktree path:<p> --force --delete-branch`。
    assert.deepEqual(cli.calls[0], [
      'worktree',
      'rm',
      '--worktree',
      'path:/repos/widgets/superagent-fix',
      '--force',
      '--delete-branch'
    ])
  })

  test('a failing removal surfaces as a seam error the panel can show', async () => {
    const cli: OrcaCli = {
      async run() {
        throw Object.assign(new Error('worktree is in use'), { code: 'cli_failed' })
      }
    }
    const runtime = createHostRuntime(fakeHost(), { cli })
    await assert.rejects(runtime.removeWorkspace({ workspaceId: 'ws', path: '/w/x' }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'cli_failed')
      return true
    })
  })
})

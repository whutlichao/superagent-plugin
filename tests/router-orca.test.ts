// 常驻 Router 的 Orca 行为面（#16、§F.1–§F.6）：专用 worktree 的建/复用、terminal 面的启动、
// relay 的单行消息与正文落盘、保活与重启退避、prompt revision 的通知语义，以及「插件不等
// Router 的一轮」。
//
// 全部经 `FakeOrcaRuntime`（§B.4 的测试替身）观察：它是 seam 的外部世界，不是内部层的 mock
// （§P.1）。真库与真目录用临时状态目录，时钟与等待由测试推进，绝不 sleep。
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { routerPrompt, ROUTER_ROLE_LINES } from '../src/worker/router/prompt'
import { ensureRouterWorkspace, launchRouter } from '../src/worker/router/router'
import { OrcaRuntimeError } from '../src/worker/runtime/orca-runtime'
import {
  createRouterRelay
} from '../src/worker/router/relay'
import {
  createRouterSupervision,
  type RouterRestartState,
  type RouterTerminalState,
  type RouterWorkspaceState
} from '../src/worker/router/supervision'
import { HealthBoard } from '../src/worker/infra/health'
import { readApiToken } from '../src/worker/infra/tokens'
import { dispatch } from '../src/worker/cli/commands'
import { parseArgs } from '../src/worker/cli/io'
import { openBoot } from './support/boot'
import { createClock, openQueue } from './support/queue'
import { FakeOrcaRuntime } from './support/fake-orca-runtime'

/** 一份部署环境：路径里带空格，钉住「一律双引号包裹」这条（§G.5）。 */
const ENVIRONMENT = {
  cliPath: '/Applications/Orca Support/plugins/superagent/src/bin/superagent.mjs',
  tokenFile: '/Users/me/.local/state/orca-superagent/tokens/router',
  stateDir: '/Users/me/.local/state/orca-superagent',
  directory: '/w/superagent-router',
  repository: 'acme/widgets',
  agentAccount: 'acme-agent',
  acceptMode: 'observe' as const,
  policyVersion: 'policy-7',
  promptRevision: 4
}

describe('the router prompt', () => {
  test('opens with the role and makes the status self-check its first action', () => {
    const prompt = routerPrompt(ENVIRONMENT)
    // 角色层在最前：launch prompt 是叠加在 agent 自身系统提示词之上的用户层（§L.5.1）。
    assert.equal(prompt.startsWith(ROUTER_ROLE_LINES[0]!), true, 'the role text opens the prompt')
    const firstAction = prompt.slice(prompt.indexOf('First action'))
    // 「第一句先做状态自检重建现场」（§F.1、§F.5）：绝对路径 + 引号 + `status --json`。
    assert.match(firstAction.split('\n')[0]!, /First action: run node ".*" status --json/)
    assert.equal(
      prompt.indexOf('First action') < prompt.indexOf('Deployment'),
      true,
      'the self-check is stated before the deployment detail'
    )
    // 自检先于重建现场的读取命令。
    assert.ok(prompt.indexOf('status --json') < prompt.indexOf('read decisions'))
    assert.ok(prompt.includes(`node "${ENVIRONMENT.cliPath}"`), 'the path is always double quoted')
    assert.ok(prompt.includes(ENVIRONMENT.tokenFile), 'the token file path is given, not the token value')
  })

  test('carries every literal of the §G.5 deployment trailer', () => {
    const prompt = routerPrompt(ENVIRONMENT)
    for (const fact of [
      ENVIRONMENT.stateDir,
      ENVIRONMENT.repository,
      ENVIRONMENT.agentAccount,
      ENVIRONMENT.acceptMode,
      ENVIRONMENT.policyVersion,
      `revision ${ENVIRONMENT.promptRevision}`
    ]) {
      assert.ok(prompt.includes(fact), `the trailer names ${fact}`)
    }
    // 工作目录就是 Router 自己那个专用 worktree。
    assert.ok(prompt.includes(ENVIRONMENT.directory))
  })

  test('states the boundaries the design can only ask for', () => {
    const prompt = routerPrompt(ENVIRONMENT)
    // §F.3 的无等待：逐字沿用上游那句，并写死「不 sleep / 不轮询」。
    assert.ok(prompt.includes('The main Session does not wait'))
    assert.match(prompt, /never sleep/i)
    // §H.19：Router 不读代码、不直接修。
    assert.match(prompt, /never read or edit repository code/i)
    // §L.5.1：本终端没有操作者，需要人决定时走 CLI 的 attention。
    assert.match(prompt, /superagent reply --purpose attention/)
    // §F.3 的结构性保证：信息是被推来的，不靠轮询。
    assert.match(prompt, /pushed/i)
  })
})

describe('the dedicated router worktree', () => {
  const settings = { baseRepo: { path: '/repos/widgets' }, baseBranch: 'main' }

  test('a missing router worktree is created with the documented spec', async () => {
    const runtime = new FakeOrcaRuntime()
    const result = await ensureRouterWorkspace(runtime, settings)
    // §F.1：ensureWorkspace({ name:'superagent-router', baseBranch:<default>, setup:'skip', parent:'none' })。
    assert.deepEqual(runtime.calls.ensureWorkspace, [
      {
        name: 'superagent-router',
        repo: { path: '/repos/widgets' },
        baseBranch: 'main',
        setup: 'skip',
        parent: 'none',
        activate: false
      }
    ])
    assert.equal(result.created, true)
    assert.equal(result.handle.path, `${FakeOrcaRuntime.WORKTREE_ROOT}/superagent-router`)
  })

  test('an existing worktree with the router path is reused instead of created again', async () => {
    const runtime = new FakeOrcaRuntime()
    runtime.workspaces = [
      {
        workspaceId: 'ws:router',
        kind: 'worktree',
        name: 'superagent-router',
        path: '/w/superagent-router',
        branch: 'agent/router'
      }
    ]
    const result = await ensureRouterWorkspace(runtime, settings)
    assert.deepEqual(runtime.calls.ensureWorkspace, [], 'no second worktree for the same router')
    assert.equal(result.created, false)
    assert.equal(result.handle.workspaceId, 'ws:router')
    assert.equal(result.handle.path, '/w/superagent-router')
  })

  test('a hand-made folder workspace with the router path is adopted by path', async () => {
    const runtime = new FakeOrcaRuntime()
    // 用户可能自己在 Orca 里开了一个叫别的名字、但目录是 `superagent-router` 的 folder workspace。
    runtime.workspaces = [
      {
        workspaceId: 'ws:folder',
        kind: 'folder',
        name: 'my-coding-area',
        path: '/Users/me/Code/superagent-router',
        branch: null
      }
    ]
    const result = await ensureRouterWorkspace(runtime, settings)
    assert.deepEqual(runtime.calls.ensureWorkspace, [], 'the folder workspace is adopted, not duplicated')
    assert.equal(result.handle.workspaceId, 'ws:folder')
    assert.equal(result.handle.path, '/Users/me/Code/superagent-router')
  })

  test('an unset base ref is passed as HEAD, never guessed', async () => {
    const runtime = new FakeOrcaRuntime()
    await ensureRouterWorkspace(runtime, { baseRepo: { path: '/repos/widgets' } })
    assert.equal(runtime.calls.ensureWorkspace[0]?.baseBranch, 'HEAD')
  })
})

describe('the router launch', () => {
  const workspace = { workspaceId: 'ws:router', path: '/w/superagent-router', branch: null, created: false }

  test('launches on the terminal surface with the router role settings and the composed prompt', async () => {
    const runtime = new FakeOrcaRuntime()
    const handle = await launchRouter(runtime, {
      workspace,
      settings: { agent: 'claude', model: 'o3', effort: 'high' },
      prompt: 'PROMPT'
    })
    assert.deepEqual(runtime.calls.launchAgent, [
      { workspace, agent: 'claude', model: 'o3', effort: 'high', surface: 'terminal', prompt: 'PROMPT' }
    ])
    assert.equal(handle.terminalId, 'term_1')
    assert.equal(handle.workspaceId, 'ws:router')
  })

  test('an omitted model or effort is not sent as an empty string', async () => {
    const runtime = new FakeOrcaRuntime()
    await launchRouter(runtime, { workspace, settings: { agent: 'pi' }, prompt: 'P' })
    const spec = runtime.calls.launchAgent[0]!
    assert.equal('model' in spec, false)
    assert.equal('effort' in spec, false)
  })

  test('a receipt without a terminal handle falls back to finding the agent by workspace', async () => {
    const runtime = new FakeOrcaRuntime()
    runtime.script.launchAgent = () => {
      throw new OrcaRuntimeError('agent_gone', 'the launch receipt carried no terminal handle')
    }
    runtime.registerAgent('ws:router', { terminalId: 'term_found', workspaceId: 'ws:router', launchedAt: 5 })
    const handle = await launchRouter(runtime, { workspace, settings: { agent: 'pi' }, prompt: 'P' })
    assert.equal(handle.terminalId, 'term_found')
    assert.deepEqual(runtime.calls.findAgent, ['ws:router'])
  })

  test('a failed launch surfaces the error so supervision can back off', async () => {
    const runtime = new FakeOrcaRuntime()
    runtime.script.launchAgent = () => {
      throw new OrcaRuntimeError('cli_failed', 'orca agent launch failed')
    }
    await assert.rejects(
      launchRouter(runtime, { workspace, settings: { agent: 'pi' }, prompt: 'P' }),
      (error: unknown) => error instanceof OrcaRuntimeError && error.code === 'cli_failed'
    )
  })
})

describe('relaying to the router terminal', () => {
  /** 一套 relay 夹具：假缝、临时状态目录、虚拟时钟。 */
  function openRelay(options: {
    readonly sequence?: number | null
    readonly terminal?: string | null
    readonly retentionDays?: number
  } = {}) {
    const stateDir = mkdtempSync(join(tmpdir(), 'superagent-relay-'))
    const runtime = new FakeOrcaRuntime()
    runtime.registerAgent('ws:router', { terminalId: 'term_router', workspaceId: 'ws:router', launchedAt: 1 })
    const relay = createRouterRelay({
      runtime,
      stateDir,
      terminal: () => (options.terminal === undefined ? 'term_router' : options.terminal),
      sequence: () => (options.sequence === undefined ? 12 : options.sequence),
      now: () => Date.parse('2026-11-07T03:26:00Z'),
      ...(options.retentionDays === undefined ? {} : { retentionDays: options.retentionDays })
    })
    return {
      runtime,
      stateDir,
      relay,
      cleanup: () => rmSync(stateDir, { recursive: true, force: true })
    }
  }

  test('a relay writes the long text to relay/<seq>.md and sends one line with the pointer', async () => {
    const h = openRelay()
    try {
      await h.relay.handlers().relay(
        {
          messageId: 'm1',
          kind: 'report',
          summary: 'The login redirect is fixed.\nSecond line stays in the file.'
        },
        'router'
      )
      const body = readFileSync(join(h.stateDir, 'relay', '12.md'), 'utf8')
      // 长文只落盘：两行都在文件里。
      assert.ok(body.includes('The login redirect is fixed.'))
      assert.ok(body.includes('Second line stays in the file.'))
      assert.ok(body.includes('m1'), 'the file names the message it belongs to')
      // 终端只收一行：一行摘要 + 文件指针（§F.2、附录 C S1）。
      assert.equal(h.runtime.calls.sent.length, 1)
      const sent = h.runtime.calls.sent[0]!
      assert.equal(sent.terminalId, 'term_router')
      assert.equal(sent.enter, true)
      assert.equal(sent.text.includes('\n'), false, 'a relay is a single line')
      assert.ok(sent.text.includes('[superagent relay #12]'))
      assert.ok(sent.text.includes('report'))
      assert.ok(sent.text.includes('The login redirect is fixed.'))
      assert.ok(sent.text.includes(join(h.stateDir, 'relay', '12.md')), 'the line points at the body file')
    } finally {
      h.cleanup()
    }
  })

  test('a notice is one line on the same terminal and writes no relay file', async () => {
    const h = openRelay()
    try {
      await h.relay.handlers().notice(
        { summary: 'prompts updated to r2; re-read with superagent prompts get --text' },
        'router'
      )
      const sent = h.runtime.calls.sent[0]!
      assert.equal(sent.terminalId, 'term_router')
      assert.equal(sent.text.includes('\n'), false)
      assert.equal(sent.text.startsWith('[superagent]'), true)
      assert.ok(sent.text.includes('prompts updated to r2'))
      assert.equal(existsSync(join(h.stateDir, 'relay')), false, 'a notice has no long text')
    } finally {
      h.cleanup()
    }
  })

  test('relay and notice share one FIFO mutex: the second waits for the first to be accepted', async () => {
    const h = openRelay()
    try {
      // 第一条的 sendText 停在闸门上：此时第二条不能先写进终端（否则就是一个被打断的队列）。
      let release: (() => void) | undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let first = true
      h.runtime.script.sendText = async () => {
        if (first) {
          first = false
          await gate
        }
        return { accepted: true }
      }
      const handlers = h.relay.handlers()
      const relayed = handlers.relay({ messageId: 'm1', kind: 'candidate', summary: 'first' }, 'router')
      const noticed = handlers.notice({ summary: 'second' }, 'router')
      await Promise.resolve()
      assert.equal(h.runtime.calls.sent.length, 1, 'only the head was written while it is in flight')
      release?.()
      await Promise.all([relayed, noticed])
      const order = h.runtime.calls.sent.map((entry) => entry.text)
      assert.equal(order.length, 2)
      assert.ok(order[0]!.includes('first'))
      assert.ok(order[1]!.includes('second'))
    } finally {
      h.cleanup()
    }
  })

  test('a relay without a live terminal fails so the queue retries it instead of dropping it', async () => {
    const h = openRelay({ terminal: null })
    try {
      await assert.rejects(
        h.relay.handlers().relay({ messageId: 'm1', kind: 'report', summary: 'later' }, 'router'),
        /router terminal/i
      )
      assert.deepEqual(h.runtime.calls.sent, [])
    } finally {
      h.cleanup()
    }
  })

  test('relay bodies older than the retention window are pruned', () => {
    const h = openRelay({ retentionDays: 7 })
    try {
      const directory = join(h.stateDir, 'relay')
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, '1.md'), 'old')
      writeFileSync(join(directory, '2.md'), 'new')
      const now = Date.parse('2026-11-07T03:26:00Z')
      const old = new Date(now - 8 * 24 * 60 * 60 * 1000)
      utimesSync(join(directory, '1.md'), old, old)
      assert.equal(h.relay.prune(), 1)
      assert.deepEqual(readdirSync(directory), ['2.md'])
    } finally {
      h.cleanup()
    }
  })
})

/** 内存里的 Router 快照存储（生产是 `kv` 的四行；形状与 `supervision.ts` 的端口一致）。 */
function memoryRouterState() {
  let terminal: RouterTerminalState | null = null
  let workspace: RouterWorkspaceState | null = null
  let restarts: RouterRestartState = { at: [], lastError: null }
  return {
    terminal: () => terminal,
    saveTerminal: (value: RouterTerminalState | null) => {
      terminal = value
    },
    workspace: () => workspace,
    saveWorkspace: (value: RouterWorkspaceState) => {
      workspace = value
    },
    restarts: () => restarts,
    saveRestarts: (value: RouterRestartState) => {
      restarts = value
    }
  }
}

/** 一套监督夹具：假缝、健康板、虚拟时钟、内存快照、可观察的 notice/token 端口。 */
function openSupervision(
  options: {
    readonly runtime?: FakeOrcaRuntime
    readonly board?: HealthBoard
    readonly clock?: ReturnType<typeof createClock>
    readonly enabled?: boolean
    readonly undecidedCandidates?: () => number
    readonly promptRevision?: number
  } = {}
) {
  const runtime = options.runtime ?? new FakeOrcaRuntime()
  const board = options.board ?? new HealthBoard()
  const clock = options.clock ?? createClock()
  const state = memoryRouterState()
  const notices: string[] = []
  const tokens: string[] = []
  /** `start()` 交给调度器的周期（毫秒）：钉住「3 s 一跳」（§F.1）。 */
  const ticks: number[] = []
  const supervisor = createRouterSupervision({
    runtime,
    health: board,
    state,
    notice: {
      enqueue: (summary: string) => {
        notices.push(summary)
      }
    },
    settings: {
      agent: 'claude',
      model: 'o3',
      effort: 'high',
      baseRepo: { path: '/repos/widgets' },
      baseBranch: 'main',
      repository: 'acme/widgets',
      acceptMode: 'observe',
      policyVersion: 'policy-7'
    },
    cliPath: '/opt/orca/superagent.mjs',
    stateDir: '/state',
    rotateToken: () => {
      const path = `/state/tokens/router-${tokens.length + 1}`
      tokens.push(path)
      return path
    },
    promptRevision: options.promptRevision ?? 1,
    enabled: options.enabled ?? true,
    ...(options.undecidedCandidates === undefined ? {} : { undecidedCandidates: options.undecidedCandidates }),
    now: () => clock.now(),
    schedule: (_run, milliseconds) => {
      ticks.push(milliseconds)
      return ticks.length
    },
    cancel: () => undefined
  })
  return { runtime, board, clock, state, notices, tokens, ticks, supervisor }
}

describe('router supervision', () => {
  test('the first tick creates the dedicated worktree and launches the session in it', async () => {
    const h = openSupervision()
    await h.supervisor.start()
    assert.deepEqual(h.runtime.calls.ensureWorkspace, [
      {
        name: 'superagent-router',
        repo: { path: '/repos/widgets' },
        baseBranch: 'main',
        setup: 'skip',
        parent: 'none',
        activate: false
      }
    ])
    const spec = h.runtime.calls.launchAgent[0]!
    assert.equal(spec.agent, 'claude')
    assert.equal(spec.model, 'o3')
    assert.equal(spec.effort, 'high')
    assert.equal(spec.surface, 'terminal', 'the plugin needs a terminal to relay and supervise')
    // 启动首动作是状态自检（§F.1）：prompt 给出这轮签发的 token 文件路径。
    assert.match(spec.prompt ?? '', /First action: run node ".*" status --json/)
    assert.ok((spec.prompt ?? '').includes(h.tokens[0]!), 'the prompt points at the freshly rotated token file')
    const snapshot = h.supervisor.snapshot()
    assert.equal(snapshot.terminalId, 'term_1')
    assert.equal(snapshot.workspaceId, 'ws:superagent-router')
    assert.equal(snapshot.state, 'ready')
    assert.equal(snapshot.startedAt, new Date(h.clock.now()).toISOString())
    assert.equal(snapshot.restarts, 0)
    assert.equal(h.state.terminal()?.terminalId, 'term_1')
    assert.equal(h.state.workspace()?.path, '/tmp/superagent-worktrees/superagent-router')
    assert.equal(h.supervisor.terminalId(), 'term_1')
    assert.deepEqual(h.ticks, [3000], 'the keepalive is a 3 s tick (§F.1)')
  })

  test('a terminal that is still alive is adopted instead of launching a second session', async () => {
    const h = openSupervision()
    h.state.saveTerminal({ terminalId: 'term_old', workspaceId: 'ws:router', launchedAt: 1, promptRevision: 3 })
    h.runtime.registerAgent('ws:router', { terminalId: 'term_old', workspaceId: 'ws:router', launchedAt: 1 })
    await h.supervisor.start()
    assert.deepEqual(h.runtime.calls.launchAgent, [], 'no second router session')
    assert.equal(h.supervisor.snapshot().terminalId, 'term_old')
    assert.equal(h.board.all()['router']?.state, 'ready')
  })

  test('an adopted session older than the configured revision gets one notice', async () => {
    const h = openSupervision({ promptRevision: 5 })
    h.state.saveTerminal({ terminalId: 'term_old', workspaceId: 'ws:router', launchedAt: 1, promptRevision: 4 })
    h.runtime.registerAgent('ws:router', { terminalId: 'term_old', workspaceId: 'ws:router', launchedAt: 1 })
    await h.supervisor.start()
    assert.deepEqual(h.notices, ['prompts updated to r5; re-read with superagent prompts get --text'])
    assert.deepEqual(h.runtime.calls.launchAgent, [], 'a notice, not a relaunch')
    assert.equal(h.supervisor.snapshot().promptRevision, 4, 'the live session still has the old text')
    assert.equal(h.supervisor.snapshot().currentRevision, 5)
  })

  test('a gone terminal is restarted on the next tick', async () => {
    const h = openSupervision()
    await h.supervisor.start()
    h.runtime.terminals.delete('term_1')
    await h.supervisor.tick()
    assert.equal(h.runtime.calls.launchAgent.length, 2)
    assert.equal(h.supervisor.snapshot().terminalId, 'term_2')
    assert.equal(h.supervisor.snapshot().restarts, 1)
  })

  test('an orphaned but connected terminal is kept: a background agent simply has no pane', async () => {
    const h = openSupervision()
    await h.supervisor.start()
    // #16 实测（附录 C）：`agent launch --surface terminal` 起在没打开的 worktree 里时，
    // `orphaned=true` 而 `connected=true`、进程与 TUI 都活着。把它当死亡会无限重启。
    h.runtime.script.listTerminals = () => [
      { handle: 'term_1', worktreeId: null, worktreePath: null, title: null, connected: true, orphaned: true }
    ]
    await h.supervisor.tick()
    assert.equal(h.runtime.calls.launchAgent.length, 1, 'no restart for a pty without a pane')
    assert.equal(h.supervisor.snapshot().terminalId, 'term_1')
    assert.equal(h.supervisor.snapshot().orphaned, true, 'the fact is still readable')
  })

  test('a disappeared router worktree is rebuilt before the session is relaunched', async () => {
    const h = openSupervision()
    await h.supervisor.start()
    assert.equal(h.runtime.calls.ensureWorkspace.length, 1)
    // §F.5 的第三个触发条件：worktree 消失 → 先重建，再 launch。
    h.runtime.workspaces = []
    h.runtime.terminals.delete(h.supervisor.terminalId()!)
    await h.supervisor.tick()
    assert.equal(h.runtime.calls.ensureWorkspace.length, 2, 'the worktree is re-ensured')
    assert.equal(h.runtime.calls.launchAgent.length, 2)
  })

  test('a disconnected terminal is restarted on the next tick', async () => {
    const h = openSupervision()
    await h.supervisor.start()
    h.runtime.script.listTerminals = () => [
      { handle: 'term_1', worktreeId: null, worktreePath: null, title: null, connected: false, orphaned: true }
    ]
    await h.supervisor.tick()
    assert.equal(h.runtime.calls.launchAgent.length, 2)
  })

  test('a failed launch backs off 5 s, then doubles, capped at 300 s', async () => {
    const h = openSupervision()
    h.runtime.script.launchAgent = () => {
      throw new OrcaRuntimeError('cli_failed', 'orca agent launch failed')
    }
    await h.supervisor.start()
    const start = h.clock.now()
    assert.equal(h.runtime.calls.launchAgent.length, 1)
    let snapshot = h.supervisor.snapshot()
    assert.equal(snapshot.state, 'starting')
    assert.equal(snapshot.nextAttemptAt, new Date(start + 5000).toISOString())
    assert.match(snapshot.detail ?? '', /orca agent launch failed/)
    const delays: number[] = []
    for (const expected of [10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]) {
      const due = Date.parse(h.supervisor.snapshot().nextAttemptAt!)
      // 差一毫秒都不重试。
      h.clock.advance(due - h.clock.now() - 1)
      const before = h.runtime.calls.launchAgent.length
      await h.supervisor.tick()
      assert.equal(h.runtime.calls.launchAgent.length, before, 'the backoff is not parsed as "now"')
      h.clock.advance(1)
      await h.supervisor.tick()
      const next = Date.parse(h.supervisor.snapshot().nextAttemptAt!)
      delays.push(next - h.clock.now())
      assert.equal(delays.at(-1), expected)
    }
    // 退避到点后成功：状态回到 ready，下一次尝试清空。
    delete (h.runtime.script as { launchAgent?: unknown }).launchAgent
    h.clock.advance(Date.parse(h.supervisor.snapshot().nextAttemptAt!) - h.clock.now())
    await h.supervisor.tick()
    snapshot = h.supervisor.snapshot()
    assert.equal(snapshot.state, 'ready')
    assert.equal(snapshot.terminalId, 'term_1', 'the retry is the first session that actually started')
    assert.equal(snapshot.nextAttemptAt, null)
    assert.equal(h.board.all()['router']?.state, 'ready')
  })

  test('five restarts inside ten minutes mark the router health as an error, and ten quiet minutes clear it', async () => {
    const h = openSupervision()
    await h.supervisor.start()
    for (let restarted = 0; restarted < 5; restarted += 1) {
      h.runtime.terminals.delete(h.supervisor.terminalId()!)
      h.clock.advance(10_000)
      await h.supervisor.tick()
    }
    assert.equal(h.supervisor.snapshot().restarts, 5)
    assert.equal(h.board.all()['router']?.state, 'error')
    assert.match(h.board.all()['router']?.detail ?? '', /restarts 5/)
    // 成功后再过十分钟：计数清零，条目回到 ready（§F.1）。
    h.clock.advance(10 * 60 * 1000)
    await h.supervisor.tick()
    assert.equal(h.supervisor.snapshot().restarts, 0)
    assert.equal(h.board.all()['router']?.state, 'ready')
  })

  test('a done status event is a turn end, not a death: the session is not restarted', async () => {
    // #12 的 S7 实测：terminal 面的 agent 在启动与每一轮结束时都会收到 `done`，而 TUI 仍在跑。
    // 把 done 当死亡会让 Router 每一轮都被重启。
    const h = openSupervision()
    await h.supervisor.start()
    await h.supervisor.onAgentStatus(FakeOrcaRuntime.statusEvent('term_1', 'done'))
    await h.supervisor.onAgentStatus(FakeOrcaRuntime.statusEvent('term_1', 'working'))
    await h.supervisor.onAgentStatus(FakeOrcaRuntime.statusEvent('term_1', 'done'))
    assert.equal(h.runtime.calls.launchAgent.length, 1)
    assert.equal(h.supervisor.snapshot().terminalId, 'term_1')
    assert.equal(h.supervisor.snapshot().agentState, 'done')
  })

  test('a status event for another terminal never touches the router', async () => {
    const h = openSupervision()
    await h.supervisor.start()
    await h.supervisor.onAgentStatus(FakeOrcaRuntime.statusEvent('term_worker', 'done'))
    await h.supervisor.onAgentStatus(FakeOrcaRuntime.statusEvent('term_worker', 'waiting'))
    assert.equal(h.runtime.calls.launchAgent.length, 1)
    assert.equal(h.supervisor.snapshot().idle.waits, 0)
  })

  test('a prompt revision change is a notice, and the role text only changes with a restart', async () => {
    const h = openSupervision({ promptRevision: 1 })
    await h.supervisor.start()
    assert.ok((h.runtime.calls.launchAgent[0]?.prompt ?? '').includes('revision 1'))
    h.supervisor.notifyPromptRevision(2)
    assert.deepEqual(h.notices, ['prompts updated to r2; re-read with superagent prompts get --text'])
    assert.equal(h.runtime.calls.launchAgent.length, 1, 'no relaunch for a prompt revision')
    h.supervisor.notifyPromptRevision(2)
    assert.equal(h.notices.length, 1, 'the same revision is announced once')
    await h.supervisor.restart('apply prompt revision')
    assert.ok((h.runtime.calls.launchAgent[1]?.prompt ?? '').includes('revision 2'))
    assert.deepEqual(h.runtime.calls.closeTerminal, ['term_1'], 'the old session is closed first')
    assert.equal(h.supervisor.snapshot().restarts, 0, 'an explicit restart is not a crash loop')
  })

  test('looking idle with N undecided candidates is readable from the data layer', async () => {
    const h = openSupervision({ undecidedCandidates: () => 4 })
    await h.supervisor.start()
    assert.equal(h.supervisor.snapshot().idle.suspected, false)
    for (let round = 0; round < 3; round += 1) {
      await h.supervisor.onAgentStatus(FakeOrcaRuntime.statusEvent('term_1', 'working'))
      h.clock.advance(10_000)
      await h.supervisor.onAgentStatus(FakeOrcaRuntime.statusEvent('term_1', 'waiting'))
    }
    const snapshot = h.supervisor.snapshot()
    assert.equal(snapshot.idle.suspected, true)
    assert.equal(snapshot.idle.waits, 3)
    assert.equal(snapshot.idle.since, new Date(Date.parse(snapshot.startedAt!) + 10_000).toISOString())
    assert.equal(snapshot.undecidedCandidates, 4)
    // 新的 Decision 让「疑似空转」失效：这是可观测事实，不是拦截（§F.3）。
    h.supervisor.noteDecision()
    assert.equal(h.supervisor.snapshot().idle.suspected, false)
  })

  test('waiting transitions older than five minutes are forgotten', async () => {
    const h = openSupervision()
    await h.supervisor.start()
    for (let round = 0; round < 3; round += 1) {
      await h.supervisor.onAgentStatus(FakeOrcaRuntime.statusEvent('term_1', 'working'))
      await h.supervisor.onAgentStatus(FakeOrcaRuntime.statusEvent('term_1', 'waiting'))
    }
    assert.equal(h.supervisor.snapshot().idle.waits, 3)
    h.clock.advance(5 * 60 * 1000 + 1)
    await h.supervisor.tick()
    assert.equal(h.supervisor.snapshot().idle.suspected, false)
  })

  test('setup that is not ready keeps the router paused instead of launching', async () => {
    const h = openSupervision({ enabled: false })
    await h.supervisor.start()
    assert.deepEqual(h.runtime.calls.launchAgent, [])
    assert.deepEqual(h.runtime.calls.ensureWorkspace, [])
    assert.equal(h.board.all()['router']?.state, 'paused')
  })

  test('a relay queue survives a restart and delivers to the new terminal', async () => {
    const queue = openQueue()
    const runtime = new FakeOrcaRuntime()
    const h = openSupervision({ runtime, board: queue.board, clock: queue.clock })
    const relay = createRouterRelay({
      runtime,
      stateDir: queue.stateDir,
      terminal: () => h.supervisor.terminalId(),
      sequence: (kind) => queue.store.effects.get(kind, 'router')?.seq ?? null,
      now: () => queue.clock.now()
    })
    try {
      await h.supervisor.start()
      // 路由器死了：发送会失败，队列必须留着这一行。
      runtime.terminals.delete(h.supervisor.terminalId()!)
      const handlers = relay.handlers()
      queue.effects.handle('relay', handlers.relay)
      queue.effects.enqueue('relay', 'router', {
        messageId: 'm1',
        kind: 'report',
        summary: 'survives a restart'
      })
      await queue.effects.idle()
      assert.equal(queue.effects.pending('relay', 'router'), true, 'a failed relay is never dropped')
      const seq = queue.store.effects.get('relay', 'router')?.seq
      // 显式重启换一台终端；队列不清空，退避到点后发到新终端。
      await h.supervisor.restart('terminal died')
      queue.clock.advance(2000)
      await queue.effects.idle()
      assert.equal(queue.effects.pending('relay'), false)
      const sent = runtime.calls.sent.at(-1)!
      assert.equal(sent.terminalId, h.supervisor.terminalId())
      assert.ok(sent.text.includes('survives a restart'))
      assert.equal(existsSync(join(queue.stateDir, 'relay', `${seq}.md`)), true)
    } finally {
      queue.cleanup()
    }
  })
})

/** 一条指向 boot 服务器的 CLI 目标（与 `runtime.test.ts` 同一形状）。 */
function cliTarget(stateDir: string, port: number, token: string) {
  return {
    stateDir,
    stateDirSource: 'argument' as const,
    port,
    baseUrl: `http://127.0.0.1:${port}/superagent/api`,
    token,
    tokenSource: 'argument' as const,
    tokenFile: null
  }
}

/** 跑一条 CLI 命令。 */
async function cli(stateDir: string, port: number, argv: readonly string[]) {
  return dispatch({
    parsed: parseArgs(argv),
    target: cliTarget(stateDir, port, readApiToken(stateDir) ?? ''),
    sleep: async () => undefined
  })
}

/** 组合根起的 Router 会话（`superagent-router` worktree 里的那一个）。 */
function routerLaunches(runtime: FakeOrcaRuntime) {
  return runtime.calls.launchAgent.filter((spec) => spec.workspace.path.endsWith('/superagent-router'))
}

describe('the router inside the composition root', () => {
  test('boot starts exactly one router session and reports it next to the models entry', async () => {
    const h = await openBoot()
    try {
      const launches = routerLaunches(h.runtime)
      assert.equal(launches.length, 1, 'one long-lived router session')
      assert.match(launches[0]?.prompt ?? '', /First action: run node ".*" status --json/)
      const status = h.handle.routerStatus()
      assert.equal(status.state, 'ready')
      // 快照里的终端就是 FakeOrcaRuntime 为 Router 工作区登记的那一个。
      assert.equal(status.terminalId, h.runtime.agentsByWorkspace.get('ws:superagent-router')?.terminalId)
      assert.equal(status.directory?.endsWith('/superagent-router'), true)
      // 健康面：router 与 models 两条都在，models 恒 ready（§N.4、§H.4）。
      const health = await cli(h.stateDir, h.handle.port()!, ['health'])
      assert.equal(health.exit, 0)
      const view = (health.envelope as { result: { health: Record<string, { state: string; detail?: string }> } }).result.health
      assert.equal(view['router']?.state, 'ready')
      assert.equal(view['models']?.state, 'ready')
      assert.equal(view['models']?.detail, 'handled by Orca')
    } finally {
      await h.cleanup()
    }
  })

  test('a lost router terminal is revived by the next supervision tick', async () => {
    const h = await openBoot()
    try {
      const before = h.handle.routerStatus().terminalId!
      h.runtime.terminals.delete(before)
      await h.handle.routerTick()
      const after = h.handle.routerStatus()
      assert.notEqual(after.terminalId, before)
      assert.equal(after.restarts, 1)
      assert.equal(routerLaunches(h.runtime).length, 2)
    } finally {
      await h.cleanup()
    }
  })

  test('a pass and an HTTP read never wait for the router to take a turn', async () => {
    const h = await openBoot()
    try {
      // 任何「等 Router 回复」的实现都会卡在这两个读数上：终端不产出、读回永不返回。
      h.runtime.script.readTerminal = () => new Promise(() => undefined)
      const routerTerminal = h.handle.routerStatus().terminalId!
      h.handle.notifyPromptRevision(1)
      await h.handle.passOnce()
      const sent = h.runtime.calls.sent.filter((entry) => entry.terminalId === routerTerminal)
      assert.equal(sent.length, 1, 'the notice was pushed, not awaited')
      assert.equal(sent[0]?.text, '[superagent] prompts updated to r1; re-read with superagent prompts get --text')
      // §F.3 的结构性保证：不问 agent 状态、也不读终端取证。
      assert.deepEqual(
        h.runtime.calls.readTerminal.filter((entry) => entry.terminalId === routerTerminal),
        []
      )
      const health = await cli(h.stateDir, h.handle.port()!, ['health'])
      assert.equal(health.exit, 0, 'an HTTP read answers while the router is silent')
    } finally {
      await h.cleanup()
    }
  })

  test('a prompt revision notice reaches the live session; the role text changes only on restart', async () => {
    const h = await openBoot()
    try {
      assert.equal(routerLaunches(h.runtime).length, 1)
      h.handle.notifyPromptRevision(3)
      await h.handle.passOnce()
      const terminal = h.handle.routerStatus().terminalId!
      const sent = h.runtime.calls.sent.filter((entry) => entry.terminalId === terminal)
      assert.equal(sent.at(-1)?.text, '[superagent] prompts updated to r3; re-read with superagent prompts get --text')
      assert.equal(routerLaunches(h.runtime).length, 1, 'no relaunch for a revision notice')
      await h.handle.restartRouter()
      const launches = routerLaunches(h.runtime)
      assert.equal(launches.length, 2)
      assert.ok((launches[1]?.prompt ?? '').includes('revision 3'), 'the new session carries the new revision')
      assert.equal(h.handle.routerStatus().currentRevision, 3)
    } finally {
      await h.cleanup()
    }
  })
})

describe('the relay queue the plugin owns', () => {
  test('a failed relay blocks its own kind, keeps the row, and retries it after the backoff', async () => {
    const queue = openQueue()
    const runtime = new FakeOrcaRuntime()
    runtime.registerAgent('ws:router', { terminalId: 'term_router', workspaceId: 'ws:router', launchedAt: 1 })
    const delivered: string[] = []
    let failures = 1
    runtime.script.sendText = async () => {
      if (failures > 0) {
        failures -= 1
        throw new OrcaRuntimeError('unavailable', 'the router terminal is busy')
      }
      return { accepted: true }
    }
    const relay = createRouterRelay({
      runtime,
      stateDir: queue.stateDir,
      terminal: () => 'term_router',
      sequence: (kind) => queue.store.effects.get(kind, 'router')?.seq ?? null,
      now: () => queue.clock.now()
    })
    try {
      queue.effects.handle('relay', async (payload) => {
        await relay.handlers().relay(payload, 'router')
        delivered.push(payload.messageId)
      })
      queue.effects.enqueue('relay', 'router', { messageId: 'm1', kind: 'report', summary: 'head stays' })
      await queue.effects.idle()
      const row = queue.store.effects.get('relay', 'router')
      // 失败即退避（2 s），不丢行、不改 payload（§F.2）。
      assert.equal(row?.attempts, 1)
      assert.match(row?.lastError ?? '', /busy/)
      assert.equal(row?.dueAt, new Date(queue.clock.now() + 2000).toISOString())
      assert.deepEqual(row?.payload, { messageId: 'm1', kind: 'report', summary: 'head stays' })
      assert.deepEqual(delivered, [], 'a failed head sends nothing else')
      // 退避未到：连尝试都没有。
      queue.clock.advance(1999)
      await queue.effects.idle()
      assert.deepEqual(delivered, [])
      // 到点：同一条重试成功，行删除。
      queue.clock.advance(1)
      await queue.effects.idle()
      assert.deepEqual(delivered, ['m1'])
      assert.equal(queue.effects.pending('relay', 'router'), false)
      assert.ok(runtime.calls.sent.at(-1)?.text.includes('head stays'))
    } finally {
      queue.cleanup()
    }
  })
})

// 执行器的 Orca 启动路径（#11，§E.1–§E.4、§E.6）：worktree 的建/复用、worker agent 的启动与
// 回执兜底、Input 投递（直发/指针、回车、回读）、worker slots、以及把 `launch` / `delivery`
// 两个 effect handler 接到真实副作用队列上。
//
// 所有 Orca 交互都经 `FakeOrcaRuntime`（§B.4 的测试替身，`tests/support/fake-orca-runtime.ts`）：
// 它是 seam 的外部世界，不是内部层的 mock（§P.1）。领域一侧用真 `Engine` + 内存仓储，
// 队列用真 SQLite（临时目录），时钟与等待由测试推进，绝不 sleep。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import {
  deliverPendingInputs,
  DeliveryError,
  confirmsDelivery,
  inboxPath,
  type DeliverySettings
} from '../src/worker/executor/deliver'
import { launchTicketAgent, seedPrompt } from '../src/worker/executor/launch'
import {
  OrcaExecutor,
  registerExecutorEffects,
  resolveExecutorSettings
} from '../src/worker/executor/orca-executor'
import {
  countSlots,
  DEFAULT_MAX_WORKERS,
  loadReadout,
  mayLaunch,
  mayWake,
  slotState
} from '../src/worker/executor/slots'
import { ensureTicketWorkspace } from '../src/worker/executor/workspace'
import {
  Engine,
  MemoryRepositories,
  type Assessor,
  type Assignment,
  type Outbox,
  type Policy,
  type Ticket,
  type TicketInput,
  type Trigger
} from '../src/worker/core/index.ts'
import { openQueue } from './support/queue'
import { isOrcaRuntimeError, OrcaRuntimeError } from '../src/worker/runtime/orca-runtime'
import { FakeOrcaRuntime } from './support/fake-orca-runtime'
import { AT } from './support/state'

/** 一个最小的 Ticket；只填这一票会读的字段，其余给稳定默认值。 */
function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 'ticket-11',
    title: 'Fix the login flow',
    decisionId: 'decision-1',
    mandate: {
      strength: 'explicit',
      policyVersion: 'policy-1',
      basis: { via: 'addressed', addressed: 'mention' },
      actor: { source: 'github', id: 'royce' },
      scope: 'repo:widgets'
    },
    channels: [],
    assignments: [],
    inputs: [],
    undelivered: [],
    createdAt: AT,
    updatedAt: AT,
    origin: { triggerId: 'trigger-1', triggerIds: ['trigger-1'] },
    ...overrides
  }
}

/** 已存在的工作区行（`listWorkspaces()` 的回答）。 */
function workspace(name: string, path: string, branch: string | null): {
  workspaceId: string
  kind: 'worktree'
  name: string
  path: string
  branch: string | null
} {
  return { workspaceId: `ws:${name}`, kind: 'worktree', name, path, branch }
}

test('an existing worktree for the ticket branch is reused instead of created', async () => {
  const runtime = new FakeOrcaRuntime()
  runtime.workspaces = [
    workspace('superagent-fix-the-login-flow', '/w/superagent-fix-the-login-flow', 'agent/fix-the-login-flow')
  ]

  const result = await ensureTicketWorkspace(runtime, {
    ticket: ticket(),
    settings: { baseRepo: { path: '/repos/widgets' }, branchPrefix: 'agent/' }
  })

  assert.deepEqual(runtime.calls.ensureWorkspace, [], 'no worktree create when one already exists')
  assert.equal(result.created, false)
  assert.equal(result.short, 'fix-the-login-flow')
  assert.equal(result.handle.workspaceId, 'ws:superagent-fix-the-login-flow')
  assert.equal(result.handle.path, '/w/superagent-fix-the-login-flow')
})

test('a missing worktree is created with the documented create arguments', async () => {
  const runtime = new FakeOrcaRuntime()

  const result = await ensureTicketWorkspace(runtime, {
    ticket: ticket(),
    settings: {
      baseRepo: { path: '/repos/widgets' },
      baseBranch: 'main',
      branchPrefix: 'agent/'
    }
  })

  // 设计 §E.1 的创建命令逐字段对应到 seam 的 WorkspaceSpec：
  //   orca worktree create --name superagent-fix-the-login-flow --repo path:/repos/widgets \
  //     --base-branch main --branch agent/fix-the-login-flow --setup skip --no-parent --json
  assert.deepEqual(runtime.calls.ensureWorkspace, [
    {
      name: 'superagent-fix-the-login-flow',
      repo: { path: '/repos/widgets' },
      baseBranch: 'main',
      branch: 'agent/fix-the-login-flow',
      setup: 'skip',
      parent: 'none',
      activate: false
    }
  ])
  assert.equal(result.created, true)
  assert.equal(result.short, 'fix-the-login-flow')
  assert.equal(result.handle.path, `${'/tmp/superagent-worktrees'}/superagent-fix-the-login-flow`)
})

test('an unset base ref is passed as HEAD, never guessed from the repo default', async () => {
  const runtime = new FakeOrcaRuntime()
  await ensureTicketWorkspace(runtime, {
    ticket: ticket(),
    settings: { baseRepo: { id: 'repo-1' }, branchPrefix: 'agent/' }
  })
  assert.equal(runtime.calls.ensureWorkspace[0]?.baseBranch, 'HEAD')
})

test('a recorded directory reuses the checkout even when the branch was renamed', async () => {
  const runtime = new FakeOrcaRuntime()
  runtime.workspaces = [
    workspace('superagent-fix-the-login-flow-3', '/w/fix-login-3', 'agent/fix-the-login-flow-3')
  ]
  const result = await ensureTicketWorkspace(runtime, {
    ticket: ticket({
      execution: { name: 'fix-the-login-flow', directory: '/w/fix-login-3', assignment: '' }
    }),
    settings: { branchPrefix: 'agent/' }
  })
  assert.deepEqual(runtime.calls.ensureWorkspace, [])
  assert.equal(result.handle.path, '/w/fix-login-3')
  assert.equal(result.short, 'fix-the-login-flow-3', 'the short follows the real worktree')
})

test('a short name taken by another worktree gets the -2 suffix before creating', async () => {
  const runtime = new FakeOrcaRuntime()
  runtime.workspaces = [workspace('superagent-fix-the-login-flow', '/w/other', 'other/work')]

  const result = await ensureTicketWorkspace(runtime, {
    ticket: ticket(),
    settings: { branchPrefix: 'agent/' }
  })

  assert.deepEqual(runtime.calls.ensureWorkspace, [
    {
      name: 'superagent-fix-the-login-flow-2',
      branch: 'agent/fix-the-login-flow-2',
      baseBranch: 'HEAD',
      setup: 'skip',
      parent: 'none',
      activate: false
    }
  ])
  assert.equal(result.short, 'fix-the-login-flow-2')
})

test('the accept worktree_name is sanitised and wins over the title', async () => {
  const runtime = new FakeOrcaRuntime()
  const result = await ensureTicketWorkspace(runtime, {
    ticket: ticket({ execution: { name: 'My_Login  FIX', directory: '', assignment: '' } }),
    settings: { branchPrefix: 'agent/' }
  })
  assert.equal(result.short, 'my-login-fix')
  assert.equal(runtime.calls.ensureWorkspace[0]?.name, 'superagent-my-login-fix')
})

test('a title that leaves no ascii short name falls back to the ticket id, deterministically', async () => {
  const runtime = new FakeOrcaRuntime()
  const first = await ensureTicketWorkspace(runtime, {
    ticket: ticket({ id: 'ab12cd34ef56', title: '修复登录流程' }),
    settings: { branchPrefix: 'agent/' }
  })
  assert.equal(first.short, 'tab12cd34')
  assert.equal(runtime.calls.ensureWorkspace[0]?.branch, 'agent/tab12cd34')
})

/** 一条人的 GitHub 评论（Input 的来源）。 */
function trigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: 'trigger-1',
    source: 'github',
    threads: [{ source: 'github', id: 'acme/widgets#42' }],
    actor: { source: 'github', id: 'royce' },
    human: true,
    addressed: 'mention',
    at: AT,
    text: 'Please fix the login flow before Friday.',
    url: 'https://github.com/acme/widgets/issues/42#issuecomment-1',
    channel: {
      source: 'github',
      thread: 'acme/widgets#42',
      address: { repo: 'acme/widgets', issue: '42' }
    },
    meta: {},
    ...overrides
  }
}

/** 一条待投递的 trigger Input（`seq` 由它在 `ticket.inputs` 里的位置决定）。 */
function triggerInput(id = 'input-1', triggerId = 'trigger-1'): TicketInput {
  return { id, kind: 'trigger', triggerId, at: AT, human: true }
}

/** 一个真实临时状态目录；调用方负责删除。 */
function stateDir(): { readonly dir: string; readonly cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'superagent-inbox-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const DELIVERY: DeliverySettings = { inlineLimit: 1000, confirmDelivery: true }

/** 一台虚拟的已建好的工作区（launch 只需要句柄）。 */
function handleOf(workspaceId = 'ws:superagent-fix-the-login-flow'): {
  workspaceId: string
  path: string
  branch: string
  created: boolean
} {
  return {
    workspaceId,
    path: '/tmp/superagent-worktrees/superagent-fix-the-login-flow',
    branch: 'agent/fix-the-login-flow',
    created: true
  }
}

/** 一个记录「等待多久」的虚拟等待：不 sleep，测试按它断言反查节奏。 */
function waits(): { readonly values: number[]; readonly wait: (ms: number) => Promise<void> } {
  const values: number[] = []
  return {
    values,
    wait: async (ms: number) => {
      values.push(ms)
    }
  }
}

const LAUNCH = {
  short: 'fix-the-login-flow',
  cliPath: '/plugins/superagent/src/bin/superagent.mjs',
  tokenFile: '/state/tokens/asg-1',
  inboxPath: '/state/inbox/ticket-11/0.md'
} as const

test('the seed prompt is short and names the role, ticket, directory, CLI and first input', () => {
  const prompt = seedPrompt({
    ticketId: 'ticket-11',
    short: 'fix-the-login-flow',
    directory: '/tmp/superagent-worktrees/superagent-fix-the-login-flow',
    cliPath: LAUNCH.cliPath,
    tokenFile: LAUNCH.tokenFile,
    inboxPath: LAUNCH.inboxPath
  })
  assert.ok(prompt.length <= 400, `the seed prompt stays under 400 chars (got ${prompt.length})`)
  assert.equal(prompt.includes('\n'), false, 'one line: the terminal never gets a multi-line seed')
  for (const part of [
    'ticket-11',
    'fix-the-login-flow',
    '/tmp/superagent-worktrees/superagent-fix-the-login-flow',
    '/plugins/superagent/src/bin/superagent.mjs',
    '/state/tokens/asg-1',
    '/state/inbox/ticket-11/0.md'
  ]) {
    assert.ok(prompt.includes(part), `the seed prompt names ${part}`)
  }
})

test('with very long deployment paths the seed prompt keeps the first-input pointer', () => {
  const prompt = seedPrompt({
    ticketId: 'ticket-11',
    short: 'fix-the-login-flow',
    directory: `/Users/someone/${'deep/'.repeat(30)}worktree`,
    cliPath: `/Users/someone/Library/Application Support/Orca/plugins/${'x'.repeat(80)}/src/bin/superagent.mjs`,
    tokenFile: `/Users/someone/.local/state/${'y'.repeat(60)}/tokens/asg-1`,
    inboxPath: '/state/inbox/ticket-11/0.md'
  })
  assert.ok(prompt.length <= 400)
  assert.ok(prompt.includes('/state/inbox/ticket-11/0.md'), 'the worker still learns what to read first')
  assert.equal(prompt.includes('\n'), false)
})

test('the worker agent is launched on the terminal surface with model, effort and prompt', async () => {
  const runtime = new FakeOrcaRuntime()
  const handle = await launchTicketAgent(runtime, {
    ticket: ticket(),
    workspace: handleOf(),
    settings: { agent: 'claude', model: 'claude-sonnet-4', effort: 'high' },
    ...LAUNCH
  })

  const spec = runtime.calls.launchAgent[0]
  assert.ok(spec !== undefined)
  assert.equal(spec.surface, 'terminal', 'a terminal handle is required to deliver and stop')
  assert.equal(spec.agent, 'claude')
  assert.equal(spec.model, 'claude-sonnet-4')
  assert.equal(spec.effort, 'high')
  assert.equal(spec.workspace.workspaceId, 'ws:superagent-fix-the-login-flow')
  assert.ok((spec.prompt ?? '').includes('/state/inbox/ticket-11/0.md'))
  assert.equal(handle.terminalId, 'term_1')
})

test('without model or effort the launch leaves both unset so the host can pick', async () => {
  const runtime = new FakeOrcaRuntime()
  await launchTicketAgent(runtime, {
    ticket: ticket(),
    workspace: handleOf(),
    settings: { agent: 'pi' },
    ...LAUNCH
  })
  const spec = runtime.calls.launchAgent[0]
  assert.equal(Object.hasOwn(spec ?? {}, 'model'), false)
  assert.equal(Object.hasOwn(spec ?? {}, 'effort'), false)
})

test('a receipt without a terminal handle is recovered by looking the agent up by workspace', async () => {
  const runtime = new FakeOrcaRuntime()
  let lookups = 0
  runtime.script.launchAgent = () => {
    throw new OrcaRuntimeError('agent_gone', 'the receipt carried no terminal handle')
  }
  runtime.script.findAgent = (workspaceId) => {
    lookups += 1
    return lookups >= 3
      ? { terminalId: 'term_found', workspaceId, launchedAt: 1 }
      : null
  }
  const clock = waits()

  const handle = await launchTicketAgent(runtime, {
    ticket: ticket(),
    workspace: handleOf(),
    settings: { agent: 'pi' },
    ...LAUNCH,
    wait: clock.wait
  })

  assert.equal(handle.terminalId, 'term_found')
  assert.equal(runtime.calls.launchAgent.length, 1, 'the lookup replaces a relaunch')
  assert.equal(runtime.calls.findAgent.length, 3)
  assert.deepEqual(clock.values, [200, 200], '200 ms between lookups')
})

test('a missing handle after ten seconds is retried once, then surfaces agent_gone', async () => {
  const runtime = new FakeOrcaRuntime()
  runtime.script.launchAgent = () => {
    throw new OrcaRuntimeError('agent_gone', 'the receipt carried no terminal handle')
  }
  runtime.script.findAgent = () => null
  const clock = waits()

  await assert.rejects(
    launchTicketAgent(runtime, {
      ticket: ticket(),
      workspace: handleOf(),
      settings: { agent: 'pi' },
      ...LAUNCH,
      wait: clock.wait
    }),
    (error: unknown) => isOrcaRuntimeError(error) && error.code === 'agent_gone'
  )
  assert.equal(runtime.calls.launchAgent.length, 2, 'one retry, then give up')
  // 10 s 窗口 / 200 ms 间隔 = 50 次等待 + 1 次收尾查询；两次尝试共 102 次查询、100 次等待。
  assert.equal(runtime.calls.findAgent.length, 102, '51 lookups per attempt at 200 ms')
  assert.equal(clock.values.length, 100, 'waiting happens between lookups, not after the last one')
  assert.ok(clock.values.every((ms) => ms === 200))
})

// ---- Input 投递（§E.4） -------------------------------------------------------------

test('a short input is written to the inbox and sent inline as one line', async () => {
  const runtime = new FakeOrcaRuntime()
  runtime.registerAgent('ws:superagent-fix-the-login-flow', {
    terminalId: 'term_1',
    workspaceId: 'ws:superagent-fix-the-login-flow',
    launchedAt: 1
  })
  const dir = stateDir()
  const delivered: string[] = []
  try {
    const pending = ticket({ inputs: [triggerInput()], undelivered: ['input-1'] })
    const result = await deliverPendingInputs(runtime, {
      ticket: pending,
      terminalId: 'term_1',
      stateDir: dir.dir,
      settings: DELIVERY,
      triggerOf: () => trigger(),
      onDelivered: (inputId) => delivered.push(inputId)
    })

    const path = inboxPath(dir.dir, pending.id, 1)
    const file = readFileSync(path, 'utf8')
    assert.ok(file.startsWith('[superagent] #1'), 'the file names the delivery number')
    assert.ok(file.includes('Please fix the login flow before Friday.'), 'the file carries the text')
    assert.ok(file.includes('replies_to: github:acme/widgets#42'), 'the file names where to reply')
    assert.ok(file.includes('https://github.com/acme/widgets/issues/42#issuecomment-1'))

    assert.equal(runtime.calls.sent.length, 1)
    const sent = runtime.calls.sent[0]!
    assert.equal(sent.terminalId, 'term_1')
    assert.equal(sent.enter, true, 'a delivery always presses enter')
    assert.equal(sent.text.includes('\n'), false, 'the inline copy is one line (S1)')
    assert.ok(sent.text.startsWith('[superagent] #1'), 'the inline copy carries the read-back marker')
    assert.ok(sent.text.includes('Please fix the login flow before Friday.'))

    assert.deepEqual(result.delivered, ['input-1'])
    assert.deepEqual(delivered, ['input-1'], 'the caller learns about the delivery per input')
    assert.ok(runtime.calls.readTerminal.length >= 1, 'delivery is confirmed by reading back')
  } finally {
    dir.cleanup()
  }
})

test('a long input is sent as a one-line pointer to the file, never as the body', async () => {
  const runtime = new FakeOrcaRuntime()
  runtime.registerAgent('ws:superagent-fix-the-login-flow', {
    terminalId: 'term_1',
    workspaceId: 'ws:superagent-fix-the-login-flow',
    launchedAt: 1
  })
  const dir = stateDir()
  try {
    const long = 'x'.repeat(5000)
    const pending = ticket({ inputs: [triggerInput()], undelivered: ['input-1'] })
    await deliverPendingInputs(runtime, {
      ticket: pending,
      terminalId: 'term_1',
      stateDir: dir.dir,
      settings: DELIVERY,
      triggerOf: () => trigger({ text: long })
    })

    const path = inboxPath(dir.dir, pending.id, 1)
    const sent = runtime.calls.sent[0]!
    assert.equal(sent.text, `[superagent] 新输入 #1，读它：${path}`)
    assert.ok(!sent.text.includes('x'.repeat(50)), 'the body stays in the file')
    const file = readFileSync(path, 'utf8')
    assert.ok(file.includes('truncated'), 'a clipped body points at the original')
    assert.ok(file.length < 5000 + 2000, 'the file keeps the body bounded')
  } finally {
    dir.cleanup()
  }
})

test('the read-back confirms only a [superagent] line with this delivery number', () => {
  assert.equal(confirmsDelivery(['noise', '❯ [superagent] #7'], 7), true)
  assert.equal(confirmsDelivery(['[superagent] #12'], 1), false, '#12 is not #1')
  assert.equal(confirmsDelivery(['[superagent] 新输入 #3，读它：/x'], 3), true)
  assert.equal(confirmsDelivery(['#3 without the tag'], 3), false)
})

test('a delivery whose marker never shows up fails so the queue can back off and retry', async () => {
  const runtime = new FakeOrcaRuntime()
  runtime.registerAgent('ws:superagent-fix-the-login-flow', {
    terminalId: 'term_1',
    workspaceId: 'ws:superagent-fix-the-login-flow',
    launchedAt: 1
  })
  runtime.script.readTerminal = () => ({ lines: ['nothing here'], truncated: false })
  const dir = stateDir()
  const waits: number[] = []
  const delivered: string[] = []
  try {
    const pending = ticket({ inputs: [triggerInput()], undelivered: ['input-1'] })
    await assert.rejects(
      deliverPendingInputs(runtime, {
        ticket: pending,
        terminalId: 'term_1',
        stateDir: dir.dir,
        settings: DELIVERY,
        triggerOf: () => trigger(),
        wait: async (ms) => {
          waits.push(ms)
        },
        onDelivered: (inputId) => delivered.push(inputId)
      }),
      (error: unknown) => error instanceof DeliveryError && error.inputId === 'input-1'
    )
    assert.equal(runtime.calls.sent.length, 1, 'one write, then read back')
    assert.ok(runtime.calls.readTerminal.length > 1, 'the read-back is retried, not a single shot')
    assert.deepEqual(delivered, [], 'an unconfirmed delivery is not reported as delivered')
    assert.ok(waits.length > 0 && waits.every((ms) => ms === 500))
  } finally {
    dir.cleanup()
  }
})

test('without confirmation a delivery is written once and never read back', async () => {
  const runtime = new FakeOrcaRuntime()
  runtime.registerAgent('ws:superagent-fix-the-login-flow', {
    terminalId: 'term_1',
    workspaceId: 'ws:superagent-fix-the-login-flow',
    launchedAt: 1
  })
  const dir = stateDir()
  try {
    const pending = ticket({ inputs: [triggerInput()], undelivered: ['input-1'] })
    await deliverPendingInputs(runtime, {
      ticket: pending,
      terminalId: 'term_1',
      stateDir: dir.dir,
      settings: { inlineLimit: 1000, confirmDelivery: false },
      triggerOf: () => trigger()
    })
    assert.equal(runtime.calls.sent.length, 1)
    assert.deepEqual(runtime.calls.readTerminal, [], 'the opt-out really turns the read off')
  } finally {
    dir.cleanup()
  }
})

test('several pending inputs are delivered in order, each with its own number and file', async () => {
  const runtime = new FakeOrcaRuntime()
  runtime.registerAgent('ws:superagent-fix-the-login-flow', {
    terminalId: 'term_1',
    workspaceId: 'ws:superagent-fix-the-login-flow',
    launchedAt: 1
  })
  const dir = stateDir()
  try {
    const pending = ticket({
      inputs: [
        triggerInput('input-1', 'trigger-1'),
        { id: 'input-2', kind: 'text', text: 'Also update the docs.', at: AT }
      ],
      undelivered: ['input-1', 'input-2']
    })
    const result = await deliverPendingInputs(runtime, {
      ticket: pending,
      terminalId: 'term_1',
      stateDir: dir.dir,
      settings: DELIVERY,
      triggerOf: () => trigger()
    })
    assert.deepEqual(result.delivered, ['input-1', 'input-2'])
    assert.deepEqual(runtime.calls.sent.map((sent) => sent.text.split(' ')[1]), ['#1', '#2'])
    assert.ok(readFileSync(inboxPath(dir.dir, pending.id, 2), 'utf8').includes('Also update the docs.'))
  } finally {
    dir.cleanup()
  }
})

test('a write the terminal refuses surfaces as a delivery failure, not a success', async () => {
  const runtime = new FakeOrcaRuntime()
  runtime.registerAgent('ws:superagent-fix-the-login-flow', {
    terminalId: 'term_1',
    workspaceId: 'ws:superagent-fix-the-login-flow',
    launchedAt: 1
  })
  runtime.script.sendText = () => ({ accepted: false })
  const dir = stateDir()
  try {
    const pending = ticket({ inputs: [triggerInput()], undelivered: ['input-1'] })
    await assert.rejects(
      deliverPendingInputs(runtime, {
        ticket: pending,
        terminalId: 'term_1',
        stateDir: dir.dir,
        settings: DELIVERY,
        triggerOf: () => trigger()
      }),
      (error: unknown) => error instanceof DeliveryError
    )
  } finally {
    dir.cleanup()
  }
})

// ---- worker slots（§E.6） -----------------------------------------------------------

/** 一个按状态构造的 Assignment。 */
function assignment(id: string, state: Assignment['state']): Assignment {
  return { id, state, createdAt: AT }
}

/** `count` 张正在跑的 Ticket（每张一个 running Assignment）。 */
function running(count: number): Ticket[] {
  return Array.from({ length: count }, (_, index) =>
    ticket({ id: `running-${index}`, assignments: [assignment(`a-${index}`, 'running')] })
  )
}

test('slots count pending and running assignments of live tickets only', () => {
  const tickets = [
    ...running(2),
    ticket({ id: 'pending', assignments: [assignment('a-pending', 'pending')] }),
    ticket({ id: 'ended-assignment', assignments: [assignment('a-ended', 'ended')] }),
    ticket({
      id: 'ended-ticket',
      ended: { at: AT, by: 'human', outcome: 'stopped' },
      assignments: [assignment('a-still-running', 'running')]
    })
  ]
  assert.deepEqual(countSlots(tickets), { running: 2, pending: 1, occupied: 3 })
})

test('the default limit is the designed two normal workers plus one human slot', () => {
  assert.equal(DEFAULT_MAX_WORKERS, 2)
  // 两个普通槽被占满：新的 launch 拿不到槽，人的唤醒还能用唯一的人类槽。
  const full = running(DEFAULT_MAX_WORKERS)
  assert.equal(mayLaunch(full, DEFAULT_MAX_WORKERS, false), false)
  assert.equal(mayLaunch(full, DEFAULT_MAX_WORKERS, true), true)
  assert.deepEqual(slotState(full, DEFAULT_MAX_WORKERS), {
    running: 2,
    pending: 0,
    occupied: 2,
    maxWorkers: 2,
    humanSlot: 'free'
  })
  // 人类槽也被占了：谁都不能再起新的。
  const over = running(DEFAULT_MAX_WORKERS + 1)
  assert.equal(mayLaunch(over, DEFAULT_MAX_WORKERS, true), false)
  assert.equal(slotState(over, DEFAULT_MAX_WORKERS).humanSlot, 'used')
})

test('a wake never adds a slot: it only guards the absolute worker capacity', () => {
  assert.equal(mayWake(1, 2), true, 'a running ticket already owns its slot')
  assert.equal(mayWake(2, 2), true)
  assert.equal(mayWake(3, 2), true, 'the extra slot is the human one')
  assert.equal(mayWake(4, 2), false, 'one human slot only, so four workers is over capacity')
})

test('the load readout is running/maxWorkers with the human slot listed apart', () => {
  assert.deepEqual(loadReadout(running(1), DEFAULT_MAX_WORKERS), {
    running: 1,
    maxWorkers: DEFAULT_MAX_WORKERS,
    humanSlot: 'free'
  })
  assert.deepEqual(loadReadout(running(3), DEFAULT_MAX_WORKERS), {
    running: 3,
    maxWorkers: DEFAULT_MAX_WORKERS,
    humanSlot: 'used'
  })
})

// ---- 把 launch / delivery 接到 effect 队列上（§E.3、§E.4、§J.2） ---------------------

/** 在假 Orca 里登记一台终端（投递要有地方可写、可回读）。 */
function withTerminal(runtime: FakeOrcaRuntime): void {
  runtime.registerAgent('ws:superagent-fix-the-login-flow', {
    terminalId: 'term_1',
    workspaceId: 'ws:superagent-fix-the-login-flow',
    launchedAt: 1
  })
}

/** 真实 Engine（内存仓储）+ 真实 SQLite 队列 + 假 Orca 的执行器夹具。 */
function harness(options: { readonly maxWorkers?: number; readonly prepare?: string } = {}) {
  const opened = new MemoryRepositories()
  const repo = opened.claimWriter()
  const queue = openQueue()
  const runtime = new FakeOrcaRuntime()
  const logs: string[] = []
  const policy: Policy = {
    version: 'policy-1',
    paused: false,
    evalTimeoutMs: 60_000,
    gate: () => ({ admissible: false, reason: 'test' }),
    revalidate: () => true,
    admitsInferred: () => false
  }
  const policyProvider = (): Policy => policy
  const assessor: Assessor = { request: () => undefined }
  const outbox: Outbox = { send: () => undefined, status: () => undefined, withdraw: () => undefined }
  const executor = new OrcaExecutor({ effects: queue.effects, runtime, log: (line) => logs.push(line) })
  const engine = new Engine({
    repo,
    policy: policyProvider,
    scope: { scope: () => ({ listened: true, observed: false }) },
    assessor,
    executor,
    outbox,
    now: () => queue.clock.iso()
  })
  const executorBlock = {
    ...(options.maxWorkers === undefined ? {} : { maxWorkers: options.maxWorkers }),
    ...(options.prepare === undefined ? {} : { prepare: options.prepare })
  }
  const settings = resolveExecutorSettings({ agent: 'pi', executor: executorBlock })
  registerExecutorEffects({
    runtime,
    effects: queue.effects,
    engine,
    records: repo,
    settings,
    stateDir: queue.stateDir,
    cliPath: '/plugins/superagent/src/bin/superagent.mjs',
    tokenFile: (assignmentId) => `/state/tokens/${assignmentId}`,
    wait: async () => undefined,
    log: (line) => logs.push(line)
  })
  const seed = (value: Ticket): void => {
    repo.atomic(() => repo.tickets.save(value))
  }
  const seedTrigger = (value: Trigger): void => {
    repo.atomic(() => repo.triggers.save(value))
  }
  const read = (id: string): Ticket | undefined => repo.tickets.get(id)
  // 关库之前先把在跑的 effect 任务收干净：否则迟到的一次派发会在关掉的库上抛错。
  const cleanup = async (): Promise<void> => {
    await queue.effects.idle().catch(() => undefined)
    queue.cleanup()
  }
  return { ...queue, cleanup, runtime, engine, executor, settings, seed, seedTrigger, read, logs }
}

test('a launch builds the worktree, writes the brief and starts the worker on a terminal', async () => {
  const h = harness()
  const pending = ticket({ assignments: [assignment('a-1', 'pending')] })
  h.seed(pending)
  h.seedTrigger(trigger())

  h.executor.start(pending, pending.assignments[0]!)
  await h.effects.idle('launch')

  assert.equal(h.runtime.calls.ensureWorkspace.length, 1)
  assert.equal(h.runtime.calls.ensureWorkspace[0]?.name, 'superagent-fix-the-login-flow')
  assert.equal(h.runtime.calls.launchAgent.length, 1)
  assert.equal(h.runtime.calls.launchAgent[0]?.surface, 'terminal')

  const stored = h.read('ticket-11')!
  assert.equal(stored.assignments[0]?.state, 'running')
  assert.equal(stored.assignments[0]?.terminalId, 'term_1')
  assert.equal(stored.execution?.name, 'fix-the-login-flow')
  assert.equal(
    stored.execution?.directory,
    `${FakeOrcaRuntime.WORKTREE_ROOT}/superagent-fix-the-login-flow`
  )
  const brief = readFileSync(inboxPath(h.stateDir, 'ticket-11', 0), 'utf8')
  assert.ok(brief.includes('Fix the login flow'), 'the brief names the ticket')
  assert.ok(brief.includes('Please fix the login flow before Friday.'), 'the brief carries the request')
  assert.ok(
    (h.runtime.calls.launchAgent[0]?.prompt ?? '').includes(inboxPath(h.stateDir, 'ticket-11', 0)),
    'the seed prompt points at the brief'
  )
  await h.cleanup()
})

test('three failed launches mark the ticket failed and put the launch health entry in error', async () => {
  const h = harness()
  h.runtime.script.ensureWorkspace = () => {
    throw new OrcaRuntimeError('cli_failed', 'worktree create failed')
  }
  const pending = ticket({ assignments: [assignment('a-1', 'pending')] })
  h.seed(pending)

  h.executor.start(pending, pending.assignments[0]!)
  await h.effects.idle('launch')
  assert.equal(h.runtime.calls.ensureWorkspace.length, 1, 'first attempt')
  h.clock.advance(5_000)
  await h.effects.idle('launch')
  assert.equal(h.runtime.calls.ensureWorkspace.length, 2, 'retried after 5 s')
  h.clock.advance(10_000)
  await h.effects.idle('launch')
  assert.equal(h.runtime.calls.ensureWorkspace.length, 3, 'retried after 10 s')

  const stored = h.read('ticket-11')!
  assert.equal(stored.assignments[0]?.report?.state, 'failed', 'the ticket is failed')
  assert.ok(/worktree create failed/.test(stored.assignments[0]?.report?.summary ?? ''), 'the failure reason is kept')
  assert.equal(h.effects.pending('launch', 'ticket-11'), false, 'the launch row is given up')
  assert.equal(h.board.all()['launch']?.state, 'error', 'the launch health entry reports the failure')
  await h.cleanup()
})

test('a full set of worker slots defers a new launch without failing it', async () => {
  const h = harness({ maxWorkers: 2 })
  h.seed(ticket({ id: 'busy-1', assignments: [assignment('a-busy-1', 'running')] }))
  h.seed(ticket({ id: 'busy-2', assignments: [assignment('a-busy-2', 'running')] }))
  const queued = ticket({ id: 'queued-ticket', assignments: [assignment('a-queued', 'pending')] })
  h.seed(queued)

  h.executor.start(queued, queued.assignments[0]!)
  await h.effects.idle('launch')

  assert.equal(h.runtime.calls.ensureWorkspace.length, 0, 'no slot, no worktree')
  assert.equal(h.read('queued-ticket')?.assignments[0]?.state, 'pending')
  assert.equal(h.effects.pending('launch', 'queued-ticket'), true, 'the row waits for a slot')
  assert.equal(h.board.all()['launch']?.state, 'ready', 'Later is not a failure')
  await h.cleanup()
})

test('a human wake may use the human slot when the normal slots are full', async () => {
  const h = harness({ maxWorkers: 2 })
  h.seed(ticket({ id: 'busy-1', assignments: [assignment('a-busy-1', 'running')] }))
  h.seed(ticket({ id: 'busy-2', assignments: [assignment('a-busy-2', 'running')] }))
  const woken = ticket({
    id: 'woken-ticket',
    assignments: [assignment('a-woken', 'pending')],
    inputs: [triggerInput('input-resumed'), triggerInput()],
    undelivered: ['input-resumed']
  })
  // 人的消息让已结束的 Ticket 恢复：`wake` 会把 `resumed` Input 排在待投递队列最前。
  h.seed({
    ...woken,
    inputs: [{ id: 'input-resumed', kind: 'resumed', triggerId: 'trigger-1', at: AT }]
  })

  h.executor.start(woken, woken.assignments[0]!)
  await h.effects.idle('launch')

  assert.equal(h.runtime.calls.ensureWorkspace.length, 1, 'the human slot let it start')
  assert.equal(h.read('woken-ticket')?.assignments[0]?.state, 'running')
  await h.cleanup()
})

test('a delivery clears the undelivered inputs and records the delivery on the assignment', async () => {
  const h = harness()
  const runningTicket = ticket({
    assignments: [
      { id: 'a-1', state: 'running', createdAt: AT, terminalId: 'term_1', startedAt: AT }
    ],
    inputs: [triggerInput()],
    undelivered: ['input-1']
  })
  h.seed(runningTicket)
  h.seedTrigger(trigger())
  withTerminal(h.runtime)

  h.executor.deliver(runningTicket, runningTicket.assignments[0]!)
  await h.effects.idle('delivery')

  const stored = h.read('ticket-11')!
  assert.deepEqual(stored.undelivered, [])
  assert.ok(stored.assignments[0]?.deliveredAt !== undefined)
  assert.equal(h.runtime.calls.sent.length, 1)
  assert.ok(h.runtime.calls.sent[0]?.text.startsWith('[superagent] #1'))
  assert.equal(stored.delivery, undefined)
  await h.cleanup()
})

test('a failed delivery lands on the ticket, not on the health board, and is retried', async () => {
  const h = harness()
  h.runtime.script.sendText = () => ({ accepted: false })
  const runningTicket = ticket({
    assignments: [
      { id: 'a-1', state: 'running', createdAt: AT, terminalId: 'term_1', startedAt: AT }
    ],
    inputs: [triggerInput()],
    undelivered: ['input-1']
  })
  h.seed(runningTicket)
  h.seedTrigger(trigger())
  withTerminal(h.runtime)

  h.executor.deliver(runningTicket, runningTicket.assignments[0]!)
  await h.effects.idle('delivery')

  const failed = h.read('ticket-11')!
  assert.ok(/did not accept/.test(failed.delivery?.error ?? ''), 'the delivery error is on the ticket')
  assert.equal(h.effects.pending('delivery', 'ticket-11'), true, 'the row backs off and retries')
  assert.equal(h.board.all()['delivery']?.state, 'ready', 'delivery failures stay off the health board')

  h.runtime.script.sendText = undefined
  h.clock.advance(2_000)
  await h.effects.idle('delivery')
  const delivered = h.read('ticket-11')!
  assert.equal(delivered.delivery, undefined, 'one success clears the failure')
  assert.deepEqual(delivered.undelivered, [])
  await h.cleanup()
})

test('stopping an assignment closes its terminal and never throws from the domain transaction', async () => {
  const h = harness()
  const runningTicket = ticket({
    assignments: [
      { id: 'a-1', state: 'running', createdAt: AT, terminalId: 'term_1', startedAt: AT }
    ]
  })
  h.seed(runningTicket)
  h.runtime.script.closeTerminal = () => {
    throw new OrcaRuntimeError('agent_gone', 'the terminal is already gone')
  }

  h.executor.stop(runningTicket, runningTicket.assignments[0]!, 'stopped')
  await Promise.resolve()
  await Promise.resolve()

  assert.deepEqual(h.runtime.calls.closeTerminal, ['term_1'])
  assert.ok(h.logs.some((line) => line.includes('term_1')), 'the failure is logged, not thrown')
  await h.cleanup()
})

test('executor settings fall back to the designed defaults and parse the repo selector', () => {
  const settings = resolveExecutorSettings({})
  assert.equal(settings.agent, 'pi')
  assert.equal(settings.maxWorkers, DEFAULT_MAX_WORKERS)
  assert.equal(settings.inlineLimit, 1000)
  assert.equal(settings.confirmDelivery, true)
  assert.equal(settings.branchPrefix, 'agent/')
  assert.equal(settings.worktreeRetention, 'keep')
  assert.equal(settings.baseRepo, undefined)

  const configured = resolveExecutorSettings({
    agent: 'codex',
    baseRepo: 'path:/repos/widgets',
    executor: {
      model: 'gpt-6',
      effort: 'high',
      maxWorkers: 4,
      baseBranch: 'develop',
      branchPrefix: 'ticket/',
      inlineLimit: 500,
      confirmDelivery: false,
      worktreeRetention: 'on-end'
    }
  })
  assert.deepEqual(configured.baseRepo, { path: '/repos/widgets' })
  assert.equal(configured.agent, 'codex')
  assert.equal(configured.model, 'gpt-6')
  assert.equal(configured.effort, 'high')
  assert.equal(configured.maxWorkers, 4)
  assert.equal(configured.baseBranch, 'develop')
  assert.equal(configured.branchPrefix, 'ticket/')
  assert.equal(configured.inlineLimit, 500)
  assert.equal(configured.confirmDelivery, false)
  assert.equal(configured.worktreeRetention, 'on-end')
  assert.deepEqual(resolveExecutorSettings({ baseRepo: 'id:abc' }).baseRepo, { id: 'abc' })
  assert.deepEqual(resolveExecutorSettings({ baseRepo: 'name:widgets' }).baseRepo, { name: 'widgets' })
})

// ---- prepare（§E.3：checkout 后置命令） ---------------------------------------------

test('the prepare command runs once per assignment with a ten minute budget', async () => {
  const h = harness({ prepare: 'npm ci' })
  const pending = ticket({ assignments: [assignment('a-1', 'pending')] })
  h.seed(pending)

  h.executor.start(pending, pending.assignments[0]!)
  await h.effects.idle('launch')
  assert.equal(h.runtime.calls.runCommand.length, 1, 'prepare ran before the agent')
  assert.equal(h.runtime.calls.runCommand[0]?.command, 'npm ci')
  assert.equal(h.runtime.calls.runCommand[0]?.timeoutMs, 600_000, 'ten minute budget')
  assert.equal(
    h.runtime.calls.runCommand[0]?.workspace.path,
    `${FakeOrcaRuntime.WORKTREE_ROOT}/superagent-fix-the-login-flow`
  )
  assert.equal(h.runtime.calls.launchAgent.length, 1, 'the agent starts after prepare succeeds')

  // 同一条 launch effect 再跑一次（例如崩溃后重放）：prepare 不再跑第二遍。
  h.executor.start(pending, pending.assignments[0]!)
  await h.effects.idle('launch')
  assert.equal(h.runtime.calls.runCommand.length, 1)
  await h.cleanup()
})

test('a failing prepare records its output and fails the ticket without starting an agent', async () => {
  const h = harness({ prepare: 'npm ci' })
  h.runtime.script.runCommand = () => ({
    terminalId: 'term_prepare',
    exitCode: 2,
    output: ['npm ERR! lockfile is out of date']
  })
  const pending = ticket({ assignments: [assignment('a-1', 'pending')] })
  h.seed(pending)

  h.executor.start(pending, pending.assignments[0]!)
  await h.effects.idle('launch')

  assert.equal(h.runtime.calls.launchAgent.length, 0, 'no worker on a broken checkout')
  assert.equal(h.effects.pending('launch', 'ticket-11'), false, 'prepare failure is not a launch retry')
  const stored = h.read('ticket-11')!
  assert.equal(stored.assignments[0]?.report?.state, 'failed')
  assert.ok(/lockfile is out of date/.test(stored.assignments[0]?.report?.summary ?? ''))
  const log = readFileSync(join(h.stateDir, 'logs', 'prepare-ticket-11-a-1.log'), 'utf8')
  assert.ok(log.includes('lockfile is out of date'), 'the output is kept for the person')
  await h.cleanup()
})

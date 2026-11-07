// 执行器的 Orca 启动路径（#11，§E.1–§E.4、§E.6）：worktree 的建/复用、worker agent 的启动与
// 回执兜底、Input 投递（直发/指针、回车、回读）、worker slots、以及把 `launch` / `delivery`
// 两个 effect handler 接到真实副作用队列上。
//
// 所有 Orca 交互都经 `FakeOrcaRuntime`（§B.4 的测试替身，`tests/support/fake-orca-runtime.ts`）：
// 它是 seam 的外部世界，不是内部层的 mock（§P.1）。领域一侧用真 `Engine` + 内存仓储，
// 队列用真 SQLite（临时目录），时钟与等待由测试推进，绝不 sleep。
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import {
  deliverPendingInputs,
  DeliveryError,
  confirmsDelivery,
  inboxPath,
  renderInputMarkdown,
  type DeliverySettings
} from '../src/worker/executor/deliver'
import { launchTicketAgent, seedPrompt } from '../src/worker/executor/launch'
import type { EnvironmentDeployment } from '../src/worker/executor/environment'
import { ENVIRONMENT_VARIABLES } from '../src/worker/executor/environment'
import { promptFilePath } from '../src/worker/executor/prompt-file'
import { assembleLaunchPrompt } from '../src/worker/app/launch-prompt'
import { createPromptVersions, type PromptVersions } from '../src/worker/app/prompts'
import { createLaunchHook, type LaunchHook } from '../src/worker/executor/launch-hook'
import { writeWorkerGitConfig, workerGitConfigPath } from '../src/worker/infra/gitconfig'
import {
  OrcaExecutor,
  registerExecutorEffects,
  registerExecutorLifecycle,
  renderAssignmentBrief,
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
import {
  BACKGROUND_LIMIT_MS,
  createBackgroundTracker
} from '../src/worker/executor/background'
import { resumeAssignments, type ResumeReport } from '../src/worker/executor/resume'
import { retryTicket } from '../src/worker/executor/retry'
import { createStatusHandler, NO_PROMPT } from '../src/worker/executor/status'
import { ensureTicketWorkspace } from '../src/worker/executor/workspace'
import {
  Engine,
  MemoryRepositories,
  type Assessor,
  type Assignment,
  type Outbox,
  type OutboundMessage,
  type Policy,
  type Ticket,
  UserError,
  canRetry,
  ticketStage,
  type TicketInput,
  type Trigger
} from '../src/worker/core/index.ts'
import { openQueue } from './support/queue'
import { isOrcaRuntimeError, OrcaRuntimeError } from '../src/worker/runtime/orca-runtime'
import { FakeOrcaRuntime } from './support/fake-orca-runtime'
import { AT, removeTree } from './support/state'

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

/** 一个真实临时状态目录；调用方负责删除（有界重试、只把 ENOENT 当成功）。 */
function stateDir(): { readonly dir: string; readonly cleanup: () => Promise<void> } {
  const dir = mkdtempSync(join(tmpdir(), 'superagent-inbox-'))
  return { dir, cleanup: () => removeTree(dir) }
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
  // 组装后的全文落在 ticket 目录里（§L.5）：开播语只给这个文件与它的 revision。
  promptPath: '/tmp/superagent-worktrees/superagent-fix-the-login-flow/.superagent/prompt.md',
  revision: 4,
  inboxPath: '/state/inbox/ticket-11/0.md'
} as const

test('the seed prompt is short and names the role, ticket, directory, CLI, prompt file and first input', () => {
  const prompt = seedPrompt({
    ticketId: 'ticket-11',
    short: 'fix-the-login-flow',
    directory: '/tmp/superagent-worktrees/superagent-fix-the-login-flow',
    cliPath: LAUNCH.cliPath,
    tokenFile: LAUNCH.tokenFile,
    promptPath: LAUNCH.promptPath,
    revision: LAUNCH.revision,
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
    LAUNCH.promptPath,
    'prompt revision 4',
    '/state/inbox/ticket-11/0.md'
  ]) {
    assert.ok(prompt.includes(part), `the seed prompt names ${part}`)
  }
})

test('with very long deployment paths the seed prompt keeps the prompt file and the first-input pointer', () => {
  const directory = `/Users/someone/${'deep/'.repeat(30)}worktree`
  const prompt = seedPrompt({
    ticketId: 'ticket-11',
    short: 'fix-the-login-flow',
    directory,
    cliPath: `/Users/someone/Library/Application Support/Orca/plugins/${'x'.repeat(80)}/src/bin/superagent.mjs`,
    tokenFile: `/Users/someone/.local/state/${'y'.repeat(60)}/tokens/asg-1`,
    promptPath: `${directory}/.superagent/prompt.md`,
    revision: 9,
    inboxPath: '/state/inbox/ticket-11/0.md'
  })
  assert.ok(prompt.length <= 400)
  assert.ok(prompt.includes(`${directory}/.superagent/prompt.md`), 'the assembled prompt file is still named')
  assert.ok(prompt.includes('prompt revision 9'), 'and so is the revision it carries')
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
  assert.ok((spec.prompt ?? '').includes(LAUNCH.promptPath), 'the seed points at the assembled prompt file')
  assert.ok((spec.prompt ?? '').includes('prompt revision 4'), 'and says which revision it is')
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
    await dir.cleanup()
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
    await dir.cleanup()
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
    await dir.cleanup()
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
    await dir.cleanup()
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
    await dir.cleanup()
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
    await dir.cleanup()
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
function harness(
  options: {
    readonly maxWorkers?: number
    readonly prepare?: string
    readonly blockedCommands?: readonly string[]
    readonly deployment?: EnvironmentDeployment
    readonly launchHook?: LaunchHook
    /** 注入真的 prompt 版本库（§L.4）：不给时启动读到 revision 0 与默认文本。 */
    readonly prompts?: boolean
  } = {}
) {
  const opened = new MemoryRepositories()
  const repo = opened.claimWriter()
  const queue = openQueue()
  const runtime = new FakeOrcaRuntime()
  // 执行环境会往 worktree 目录里写文件：给它一个临时根，用例结束删干净。
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'superagent-worktrees-'))
  runtime.worktreeRoot = worktreeRoot
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
  /** 已排队的对外消息（§J.1）：stop 的收尾消息、attention 的撤回都在这里断言。 */
  const outboxMessages: OutboundMessage[] = []
  const outbox: Outbox = {
    send: (message) => {
      if (!outboxMessages.some((item) => item.id === message.id)) outboxMessages.push(message)
    },
    status: (id) =>
      outboxMessages.some((item) => item.id === id) ? 'pending' : undefined,
    withdraw: () => undefined,
    withdrawTicket: () => undefined
  }
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
    ...(options.prepare === undefined ? {} : { prepare: options.prepare }),
    ...(options.blockedCommands === undefined ? {} : { blockedCommands: [...options.blockedCommands] })
  }
  const settings = resolveExecutorSettings({ agent: 'pi', executor: executorBlock })
  const promptVersions: PromptVersions = createPromptVersions({ store: queue.store, now: () => queue.clock.iso() })
  registerExecutorEffects({
    runtime,
    effects: queue.effects,
    engine,
    records: repo,
    settings,
    stateDir: queue.stateDir,
    cliPath: '/plugins/superagent/src/bin/superagent.mjs',
    tokenFile: (assignmentId) => `/state/tokens/${assignmentId}`,
    apiBase: 'http://127.0.0.1:3082',
    path: '/usr/bin:/bin',
    prompts: promptVersions,
    ...(options.deployment === undefined ? {} : { deployment: options.deployment }),
    ...(options.launchHook === undefined ? {} : { launchHook: options.launchHook }),
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
  const readAll = (): readonly Ticket[] => repo.tickets.list()
  // 关库之前先把在跑的 effect 任务收干净：否则迟到的一次派发会在关掉的库上抛错。
  const cleanup = async (): Promise<void> => {
    await queue.effects.idle().catch(() => undefined)
    queue.cleanup()
    await removeTree(worktreeRoot)
  }
  return {
    ...queue,
    cleanup,
    runtime,
    engine,
    executor,
    settings,
    prompts: promptVersions,
    seed,
    seedTrigger,
    read,
    readAll,
    logs,
    outboxMessages,
    worktreeRoot
  }
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
  assert.equal(stored.execution?.directory, `${h.worktreeRoot}/superagent-fix-the-login-flow`)
  const brief = readFileSync(inboxPath(h.stateDir, 'ticket-11', 0), 'utf8')
  assert.ok(brief.includes('Fix the login flow'), 'the brief names the ticket')
  assert.ok(brief.includes('Please fix the login flow before Friday.'), 'the brief carries the request')
  assert.ok(
    (h.runtime.calls.launchAgent[0]?.prompt ?? '').includes(inboxPath(h.stateDir, 'ticket-11', 0)),
    'the seed prompt points at the brief'
  )
  await h.cleanup()
})

/** 一张主动接受（inferred）的票：Mandate 记着匹配到的规则。 */
function proactiveTicket(): Ticket {
  return ticket({
    title: 'Fix the typo',
    mandate: {
      strength: 'inferred',
      policyVersion: 'policy-1',
      basis: { via: 'followup', rules: ['copy', 'visual'] },
      actor: { source: 'github', id: 'royce' },
      scope: 'one typo'
    }
  })
}

/** 开播正文的固定输入（与真 launch 同一形状）。 */
const BRIEF = {
  short: 'fix-the-typo',
  directory: '/tmp/superagent-worktrees/superagent-fix-the-typo',
  cliPath: LAUNCH.cliPath,
  tokenFile: LAUNCH.tokenFile,
  environment: {}
} as const

test('a proactive ticket briefs its matched rules and the local-only limit', () => {
  const brief = renderAssignmentBrief({ ticket: proactiveTicket(), trigger: trigger(), ...BRIEF })
  assert.ok(brief.includes('Proactively accepted'), brief)
  for (const rule of ['copy', 'visual']) assert.ok(brief.includes(rule), `the brief names ${rule}`)
  assert.ok(brief.includes('only the local small change'), brief)
  // 显式票没有这段限制：它的授权来自那条消息，不需要额外收窄。
  const explicit = renderAssignmentBrief({ ticket: ticket(), trigger: trigger(), ...BRIEF })
  assert.equal(explicit.includes('only the local small change'), false)
})

test('every later input to a proactive ticket repeats the local-only limit', () => {
  const markdown = renderInputMarkdown(
    proactiveTicket(),
    { id: 'input-2', kind: 'text', text: 'a person replied', at: AT },
    2,
    undefined
  )
  assert.ok(markdown.includes('only the local small change'), markdown)
  const explicit = renderInputMarkdown(
    ticket(),
    { id: 'input-2', kind: 'text', text: 'a person replied', at: AT },
    2,
    undefined
  )
  assert.equal(explicit.includes('only the local small change'), false)
})

test('a policy-change input carries what changed: the rule text and the lowered authority', () => {
  const markdown = renderInputMarkdown(
    proactiveTicket(),
    {
      id: 'input-3',
      kind: 'policy-changed',
      from: 'aaaaaaaaaaaa',
      to: 'bbbbbbbbbbbb',
      at: AT,
      effect: {
        rules: [
          { id: 'copy', name: 'Copy fixes', change: 'changed', instruction: 'Fix spelling only' }
        ],
        proactive: false
      }
    },
    3,
    undefined
  )
  assert.ok(markdown.includes('aaaaaaaaaaaa → bbbbbbbbbbbb'), markdown)
  assert.ok(markdown.includes('Fix spelling only'), markdown)
  assert.ok(markdown.includes('no longer accepted'), markdown)
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
    `${h.worktreeRoot}/superagent-fix-the-login-flow`
  )
  assert.equal(h.runtime.calls.launchAgent.length, 1, 'the agent starts after prepare succeeds')

  // 同一条 launch effect 再跑一次（例如崩溃后重放）：prepare 不再跑第二遍。
  h.executor.start(pending, pending.assignments[0]!)
  await h.effects.idle('launch')
  assert.equal(h.runtime.calls.runCommand.length, 1)
  await h.cleanup()
})

// ---- 执行环境（§E.11、§H.11）：env.sh、shim、prepare 替换、launch 钩子与开播语 ------------

/** 部署派生的事实（测试里只有这四个字段被环境表读到）。 */
const DEPLOYMENT: EnvironmentDeployment = {
  repository: 'acme/widgets',
  githubLogin: 'acme-agent',
  githubCommitEmail: '1+acme-agent@users.noreply.github.com',
  feishuBotId: 'ou_bot_1'
}

test('a launch writes the ticket environment, shims the blocked commands and briefs the values', async () => {
  const h = harness({ deployment: DEPLOYMENT, blockedCommands: ['personal-gh'] })
  const pending = ticket({ assignments: [assignment('a-1', 'pending')] })
  h.seed(pending)
  h.seedTrigger(trigger())
  h.executor.start(pending, pending.assignments[0]!)
  await h.effects.idle('launch')

  const directory = `${h.worktreeRoot}/superagent-fix-the-login-flow`
  const environment = readFileSync(join(directory, '.superagent', 'env.sh'), 'utf8')
  assert.ok(environment.includes(`export DSH_SUPERAGENT_DIR='${directory}'`), 'the worktree path')
  assert.ok(environment.includes("export DSH_SUPERAGENT_TICKET='ticket-11'"), 'the ticket id')
  assert.ok(environment.includes("export DSH_SUPERAGENT_GITHUB_REPOSITORY='acme/widgets'"), 'the repository')
  assert.ok(environment.includes("export DSH_SUPERAGENT_GITHUB_ACCOUNT='acme-agent'"), 'the account')
  assert.ok(environment.includes("export DSH_SUPERAGENT_BLOCKED_COMMANDS='personal-gh'"), 'the blocked list')
  assert.ok(environment.includes("export SUPERAGENT_TOKEN_FILE='/state/tokens/a-1'"), 'this assignment token')
  assert.ok(environment.includes("export SUPERAGENT_API='http://127.0.0.1:3082'"), 'the API base')

  const shim = readFileSync(join(h.stateDir, 'bin', 'personal-gh'), 'utf8')
  assert.ok(/exit 1/.test(shim), 'a blocked command fails')
  assert.ok(/not a security boundary/.test(shim), 'and says it is not a guarantee')

  const brief = readFileSync(inboxPath(h.stateDir, 'ticket-11', 0), 'utf8')
  assert.ok(brief.includes('DSH_SUPERAGENT_TICKET = ticket-11'), 'the brief carries the values')
  assert.ok(brief.includes(`DSH_SUPERAGENT_DIR = ${directory}`))
  assert.ok(brief.includes('.superagent/env.sh'), 'and names the env file')
  assert.ok(/Never write these values/.test(brief), 'and says they must not be committed')
  await h.cleanup()
})

test('a launch writes the assembled prompt into the ticket directory and seeds the worker with its pointer', async () => {
  const h = harness({ deployment: DEPLOYMENT })
  const pending = ticket({ assignments: [assignment('a-1', 'pending')] })
  h.seed(pending)
  h.seedTrigger(trigger())
  h.executor.start(pending, pending.assignments[0]!)
  await h.effects.idle('launch')

  const directory = `${h.worktreeRoot}/superagent-fix-the-login-flow`
  const path = join(directory, '.superagent', 'prompt.md')
  // §L.5：固定文件、在 `.superagent/` 里（与 env.sh 同一个目录，同一份 git 排除）。
  assert.equal(promptFilePath(directory), path)
  const text = readFileSync(path, 'utf8')
  // 文件内容就是那个唯一的组装函数的结果（§L.3：一个组装函数，两个消费者）。
  const expected = assembleLaunchPrompt({
    role: 'worker',
    revision: 0,
    config: {},
    environment: {
      variables: [...ENVIRONMENT_VARIABLES],
      cliPath: '/plugins/superagent/src/bin/superagent.mjs',
      tokenFile: '/state/tokens/a-1',
      stateDir: h.stateDir,
      repository: DEPLOYMENT.repository,
      account: DEPLOYMENT.githubLogin
    }
  })
  assert.equal(text, expected.text, 'the file equals the assembled result')
  // 独立抽查（不只靠上面的等号）：角色、团队段、环境段与 revision 都在正文里。
  assert.ok(text.includes('## The worker'), 'the worker role layer')
  assert.ok(text.includes('## Communication'), 'the team sections')
  assert.ok(text.includes('Inherited variables: DSH_SUPERAGENT_DIR'), 'the deployment section')
  assert.ok(text.includes("node '/plugins/superagent/src/bin/superagent.mjs'".replaceAll("'", '"')))
  assert.ok(text.includes('/state/tokens/a-1'), 'the token file path, never a token value')
  assert.ok(text.includes(`${DEPLOYMENT.repository}   agent account: ${DEPLOYMENT.githubLogin}`))
  assert.ok(text.includes('Prompt revision 0'))

  // 开播语 ≤400 字符、单行，并且只给文件与号，不给正文。
  const seed = h.runtime.calls.launchAgent[0]!.prompt!
  assert.ok(seed.length <= 400, `the seed stays under 400 chars (got ${seed.length})`)
  assert.equal(seed.includes('\n'), false)
  assert.ok(seed.includes(path), 'the seed points at the prompt file')
  assert.ok(seed.includes('prompt revision 0'), 'and names the revision it carries')
  assert.ok(seed.includes(inboxPath(h.stateDir, 'ticket-11', 0)), 'the first input is still named')

  // §L.5：日志只有 revision 与长度，绝不出现正文。
  const promptLogs = h.logs.filter((line) => line.includes('prompt revision'))
  assert.equal(promptLogs.length, 1)
  assert.equal(/prompt revision 0 \(\d+ chars\)/.test(promptLogs[0]!), true, 'revision and length only')
  for (const line of h.logs) {
    assert.equal(line.includes('## The worker'), false, 'no prompt body in any log line')
    assert.equal(line.includes('## Communication'), false)
  }
  await h.cleanup()
})

test('a relaunch after a prompt version bump carries the new revision and the new text', async () => {
  const h = harness({ deployment: DEPLOYMENT })
  const pending = ticket({ assignments: [assignment('a-1', 'pending')] })
  h.seed(pending)
  h.seedTrigger(trigger())
  h.executor.start(pending, pending.assignments[0]!)
  await h.effects.idle('launch')
  assert.ok(h.runtime.calls.launchAgent[0]!.prompt!.includes('prompt revision 0'))

  // 保存一版：团队段与一个 override。下一次 launch 必须用新内容与新 revision（§L.4、§L.5）。
  const saved = h.prompts.save({
    config: {
      team: { scope: 'Only the settings page.' },
      overrides: { 'team/communication': { text: 'Report in one sentence.' } }
    },
    baseRevision: 0,
    origin: 'panel'
  })
  assert.equal(saved.revision, 1)

  h.engine.report('ticket-11', { state: 'failed', summary: 'the build is broken' })
  retryTicket(h.engine, 'ticket-11')
  await h.effects.idle()

  const directory = `${h.worktreeRoot}/superagent-fix-the-login-flow`
  const text = readFileSync(join(directory, '.superagent', 'prompt.md'), 'utf8')
  assert.ok(text.includes('Only the settings page.'), 'the new team section is in the new launch')
  assert.ok(text.includes('Report in one sentence.'), 'and so is the new override')
  assert.ok(text.includes('Prompt revision 1'), 'the new revision is written down')
  const seed = h.runtime.calls.launchAgent.at(-1)!.prompt!
  assert.ok(seed.includes('prompt revision 1'), 'the seed names the revision it points at')
  assert.ok(seed.length <= 400)
  await h.cleanup()
})

test('prepare gets the substituted command, and a retry on a new assignment runs it again', async () => {
  const h = harness({
    deployment: DEPLOYMENT,
    prepare: 'echo ${DSH_SUPERAGENT_TICKET} ${DSH_SUPERAGENT_GITHUB_PR_HEAD} ${SUPERAGENT_TOKEN_FILE}'
  })
  const pending = ticket({ assignments: [assignment('a-1', 'pending')] })
  h.seed(pending)
  h.seedTrigger(trigger({ meta: { number: 42, isPr: true } }))
  h.executor.start(pending, pending.assignments[0]!)
  await h.effects.idle('launch')
  assert.equal(
    h.runtime.calls.runCommand[0]?.command,
    "echo 'ticket-11' 'refs/pull/42/head' '/state/tokens/a-1'"
  )

  // 人的 retry：同一 worktree、新 Assignment；prepare 按「一次 Assignment 一次」重跑。
  const retried = ticket({
    assignments: [pending.assignments[0]!, assignment('a-2', 'pending')]
  })
  h.seed(retried)
  h.executor.start(retried, retried.assignments[1]!)
  await h.effects.idle('launch')
  assert.equal(h.runtime.calls.runCommand.length, 2, 'the new assignment runs prepare again')
  assert.equal(
    h.runtime.calls.runCommand[1]?.command,
    "echo 'ticket-11' 'refs/pull/42/head' '/state/tokens/a-2'",
    'with the new assignment token'
  )
  await h.cleanup()
})

test('the launch hook injects this launch and leaves every other launch alone', async () => {
  const hook = createLaunchHook()
  const injected: Record<string, string>[] = []
  const strangers: Record<string, string>[] = []
  const h = harness({ deployment: DEPLOYMENT, blockedCommands: ['personal-gh'], launchHook: hook })
  // 组合根在启动时写好这份文件（§H.11）；这里显式写一次，费定「文件存在才注入」。
  assert.equal(
    writeWorkerGitConfig({
      stateDir: h.stateDir,
      account: DEPLOYMENT.githubLogin,
      email: DEPLOYMENT.githubCommitEmail
    }).state,
    'written'
  )
  // 替身扮演宿主：真正 launch 之前先发一次钩子，把环境交给「启动」这一步。
  h.runtime.script.launchAgent = (spec) => {
    const mine = hook.handle(
      {
        agent: spec.agent,
        workspaceId: spec.workspace.workspaceId,
        workspaceKind: 'worktree',
        command: 'pi',
        env: {}
      },
      (event) => {
        injected.push({ ...event.env })
        return { kind: 'continue' as const, event }
      }
    )
    assert.equal('deny' in mine, false, 'the plugin never denies a launch')
    hook.handle(
      {
        agent: 'claude',
        workspaceId: 'ws:someone-else',
        workspaceKind: 'worktree',
        command: 'claude',
        env: {}
      },
      (event) => {
        strangers.push({ ...event.env })
        return { kind: 'continue' as const, event }
      }
    )
    return { terminalId: 'term_1', workspaceId: spec.workspace.workspaceId, launchedAt: 1 }
  }
  const pending = ticket({ assignments: [assignment('a-1', 'pending')] })
  h.seed(pending)
  h.seedTrigger(trigger())
  h.executor.start(pending, pending.assignments[0]!)
  await h.effects.idle('launch')

  assert.equal(injected.length, 1, 'one launch, one injection')
  assert.equal(injected[0]?.['DSH_SUPERAGENT_TICKET'], 'ticket-11')
  assert.equal(injected[0]?.['DSH_SUPERAGENT_NAME'], 'fix-the-login-flow')
  assert.equal(injected[0]?.['PATH'], `${h.stateDir}/bin:/usr/bin:/bin`, 'the shim directory leads PATH')
  assert.equal(injected[0]?.['GIT_CONFIG_GLOBAL'], workerGitConfigPath(h.stateDir))
  assert.deepEqual(strangers, [{}], 'another worktree is untouched')
  await h.cleanup()
})

test('without the worker git config file nothing is injected, so the operator config still applies', async () => {
  const hook = createLaunchHook()
  const injected: Record<string, string>[] = []
  const h = harness({ deployment: DEPLOYMENT, launchHook: hook })
  h.runtime.script.launchAgent = (spec) => {
    hook.handle(
      {
        agent: spec.agent,
        workspaceId: spec.workspace.workspaceId,
        workspaceKind: 'worktree',
        command: 'pi',
        env: {}
      },
      (event) => {
        injected.push({ ...event.env })
        return { kind: 'continue' as const, event }
      }
    )
    return { terminalId: 'term_1', workspaceId: spec.workspace.workspaceId, launchedAt: 1 }
  }
  const pending = ticket({ assignments: [assignment('a-1', 'pending')] })
  h.seed(pending)
  h.seedTrigger(trigger())
  h.executor.start(pending, pending.assignments[0]!)
  await h.effects.idle('launch')

  assert.equal(injected.length, 1)
  assert.equal('GIT_CONFIG_GLOBAL' in (injected[0] ?? {}), false, 'a missing file must not sever the operator config')
  assert.equal(injected[0]?.['DSH_SUPERAGENT_TICKET'], 'ticket-11', 'the rest of the environment is still injected')
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

// ---- 停止（§E.5）：撤回 Mandate、收尾消息、关闭终端、保留 worktree ---------------------

/** Ticket 开始时的 Channel：收尾消息回到这里。 */
const CHANNEL = {
  source: 'github',
  thread: 'acme/widgets#42',
  address: { repo: 'acme/widgets', issue: '42' }
}

test('a human stop sends the closing notice, closes the terminal, keeps the worktree and takes no input', async () => {
  const h = harness()
  const runningTicket = ticket({
    channels: [CHANNEL],
    execution: {
      name: 'fix-the-login-flow',
      directory: '/w/superagent-fix-the-login-flow',
      assignment: 'the brief'
    },
    assignments: [
      { id: 'a-1', state: 'running', createdAt: AT, terminalId: 'term_1', startedAt: AT }
    ]
  })
  h.seed(runningTicket)
  h.seedTrigger(trigger())
  withTerminal(h.runtime)
  h.engine.bindThread('ticket-11', { source: 'github', id: 'acme/widgets#42' }, false)

  h.engine.stopTicket('ticket-11', 'Human asked to stop')
  await h.effects.idle()

  const stopped = h.read('ticket-11')!
  assert.equal(stopped.ended?.by, 'human')
  assert.equal(stopped.ended?.outcome, 'stopped')
  assert.equal(stopped.ended?.reason, 'Human asked to stop')
  assert.deepEqual(stopped.assignments.map((item) => item.state), ['ended'])
  assert.equal(stopped.assignments[0]?.endedReason, 'stopped')
  assert.deepEqual(
    h.runtime.calls.closeTerminal,
    ['term_1'],
    'the assignment terminal is closed with `orca terminal close`'
  )
  assert.equal(
    stopped.execution?.directory,
    '/w/superagent-fix-the-login-flow',
    'the worktree is kept, never removed'
  )

  const notices = h.outboxMessages.filter((message) => message.kind === 'notice')
  assert.equal(notices.length, 1, 'exactly one closing message')
  assert.equal(notices[0]?.ticketId, 'ticket-11')
  assert.deepEqual(notices[0]?.channel, CHANNEL, 'the closing message goes to the ticket channel')
  assert.ok((notices[0]?.text ?? '').includes('Fix the login flow'), 'it names the ticket')

  // 停止之后：人写的消息不再到达，note 被拒，终端里一条也不投。
  h.engine.receive(trigger({ id: 'trigger-2' }))
  await h.effects.idle()
  assert.deepEqual(h.runtime.calls.sent, [], 'a stopped ticket delivers no input')
  assert.throws(
    () => h.engine.note('ticket-11', 'too late'),
    (error: unknown) => error instanceof UserError && error.code === 'ticketEnded'
  )

  // 幂等：再停止一次不再关闭终端，也不发第二条收尾消息。
  h.engine.stopTicket('ticket-11')
  await h.effects.idle()
  assert.deepEqual(h.runtime.calls.closeTerminal, ['term_1'])
  assert.equal(h.outboxMessages.filter((message) => message.kind === 'notice').length, 1)
  await h.cleanup()
})

// ---- 重试（§E.5）：结束当前 Assignment、同一 worktree 上新建、带恢复说明 ---------------

test('a retry ends the assignment, closes its terminal and relaunches on the same worktree with the recovery note', async () => {
  const h = harness()
  const pending = ticket({
    follows: [{ thread: 'github:9', own: true }],
    assignments: [assignment('a-1', 'pending')]
  })
  h.seed(pending)
  h.seedTrigger(trigger())
  h.executor.start(pending, pending.assignments[0]!)
  await h.effects.idle()
  assert.equal(h.runtime.calls.ensureWorkspace.length, 1, 'the first launch built the worktree')
  const first = h.read('ticket-11')!
  assert.equal(first.assignments[0]?.terminalId, 'term_1')

  h.engine.report('ticket-11', { state: 'failed', summary: 'the build is broken' })
  retryTicket(h.engine, 'ticket-11')
  await h.effects.idle()

  const retried = h.read('ticket-11')!
  assert.deepEqual(retried.assignments.map((item) => item.state), ['ended', 'running'])
  assert.equal(retried.assignments[0]?.endedReason, 'retried')
  assert.deepEqual(h.runtime.calls.closeTerminal, ['term_1'], 'the replaced terminal is closed')
  assert.equal(h.runtime.calls.ensureWorkspace.length, 1, 'the same worktree is reused')
  assert.equal(h.runtime.calls.launchAgent.length, 2, 'one new worker launched')
  assert.equal(retried.assignments[1]?.terminalId, 'term_2')
  assert.equal(retried.execution?.directory, first.execution?.directory, 'same directory')
  assert.equal(retried.execution?.name, first.execution?.name, 'same branch short name')
  assert.deepEqual(retried.follows, [{ thread: 'github:9', own: true }], 'the same pull request stays followed')

  const note = retried.inputs.find(
    (input) => input.kind === 'text' && input.text.includes('git history and GitHub')
  )
  assert.ok(note, 'the recovery note is a stored input of the new assignment')
  assert.ok(
    h.runtime.calls.sent.some(
      (sent) => sent.terminalId === 'term_2' && sent.text.includes('git history and GitHub')
    ),
    'the new worker is told to check the worktree, git history and GitHub'
  )
  await h.cleanup()
})

test('a retried launch keeps the same worktree and the documented 5 s -> 10 s backoff', async () => {
  const h = harness()
  const pending = ticket({ assignments: [assignment('a-1', 'pending')] })
  h.seed(pending)
  h.seedTrigger(trigger())
  h.executor.start(pending, pending.assignments[0]!)
  await h.effects.idle()
  h.engine.report('ticket-11', { state: 'failed', summary: 'the build is broken' })

  h.runtime.script.launchAgent = () => {
    throw new OrcaRuntimeError('cli_failed', 'the agent binary is gone')
  }
  retryTicket(h.engine, 'ticket-11')
  await h.effects.idle()
  assert.equal(h.runtime.calls.ensureWorkspace.length, 1, 'retry never builds a second worktree')
  assert.equal(h.runtime.calls.launchAgent.length, 2, 'the retried launch starts immediately')

  h.clock.advance(5_000)
  await h.effects.idle()
  assert.equal(h.runtime.calls.launchAgent.length, 3, 'retried after 5 s')
  h.clock.advance(10_000)
  await h.effects.idle()
  assert.equal(h.runtime.calls.launchAgent.length, 4, 'retried after 10 s')

  const stored = h.read('ticket-11')!
  assert.equal(stored.assignments[1]?.report?.state, 'failed', 'three failed launches fail the assignment')
  assert.equal(h.effects.pending('launch', 'ticket-11'), false, 'the launch row is given up')
  await h.cleanup()
})

// ---- agent 状态映射（§E.7）：事件是唯一真源 ------------------------------------------

/** 把状态处理器接到已建好的执行器夹具上（§E.7 的唯一入口）。 */
function statusOf(h: ReturnType<typeof harness>) {
  return createStatusHandler({
    engine: h.engine,
    records: { tickets: { get: (id) => h.read(id), list: () => h.readAll() } },
    runtime: h.runtime,
    log: (line) => h.logs.push(line)
  })
}

/** 一个带终端的运行中 Ticket（状态事件要能按句柄找到它）。 */
function runningWithTerminal(): Ticket {
  return ticket({
    assignments: [
      { id: 'a-1', state: 'running', createdAt: AT, terminalId: 'term_1', startedAt: AT }
    ]
  })
}

/** 一条 agent 状态事件（宿主 payload 的投影）。 */
function event(
  state: 'working' | 'blocked' | 'waiting' | 'done',
  overrides: { readonly terminalId?: string } = {}
): Parameters<ReturnType<typeof createStatusHandler>>[0] {
  return {
    workspaceId: 'ws:superagent-fix-the-login-flow',
    paneKey: 'pane-1',
    ...(overrides.terminalId === undefined ? {} : { terminalId: overrides.terminalId }),
    state,
    receivedAt: 1
  }
}

test('agent status: working keeps the running assignment and adds no attention', async () => {
  const h = harness()
  h.seed(runningWithTerminal())
  withTerminal(h.runtime)
  await statusOf(h)(event('working', { terminalId: 'term_1' }))

  const stored = h.read('ticket-11')!
  assert.equal(stored.assignments[0]?.state, 'running', 'the assignment keeps running')
  assert.equal(stored.assignments[0]?.endedAt, undefined)
  assert.equal(stored.attention, undefined, 'working raises no question')
  assert.deepEqual(h.runtime.calls.readTerminal, [], 'working needs no evidence read')
  assert.deepEqual(h.runtime.calls.closeTerminal, [])
  assert.deepEqual(h.runtime.calls.launchAgent, [])

  // 「清等待标记」：domain 里没有单独的 flag，stage 用 live 的 agentState 判定，
  // 所以一条 waiting 报告之后的 working 事件让 Ticket 回到 working（§E.8）。
  h.seed(
    ticket({
      assignments: [
        {
          id: 'a-1',
          state: 'running',
          createdAt: AT,
          terminalId: 'term_1',
          startedAt: AT,
          report: { state: 'waiting', summary: 'idle for now', at: AT }
        }
      ]
    })
  )
  await statusOf(h)(event('working', { terminalId: 'term_1' }))
  const resumed = h.read('ticket-11')!
  assert.deepEqual(ticketStage(resumed, 'working'), { stage: 'working' })
  assert.equal(resumed.assignments[0]?.state, 'running')
  await h.cleanup()
})

test('agent status: blocked raises an Attention from the last twenty terminal lines, via terminal', async () => {
  const h = harness()
  h.seed(runningWithTerminal())
  withTerminal(h.runtime)
  for (let line = 1; line <= 25; line += 1) {
    await h.runtime.sendText('term_1', `prompt line ${line}`, { enter: false })
  }
  h.runtime.calls.readTerminal.length = 0

  await statusOf(h)(event('blocked', { terminalId: 'term_1' }))

  const stored = h.read('ticket-11')!
  assert.equal(stored.assignments[0]?.report?.state, 'blocked', 'the report says blocked')
  assert.equal(stored.attention?.via, 'terminal', 'the Attention names its source: the terminal')
  assert.equal(stored.attention?.at, AT, 'the question carries its time')
  const question = stored.attention?.question ?? ''
  assert.ok(question.includes('prompt line 25'), 'the summary carries the newest line')
  assert.ok(question.includes('prompt line 6'), 'the summary keeps the last twenty lines')
  assert.equal(question.includes('prompt line 5'), false, 'older lines fall out of the summary')
  assert.equal(h.runtime.calls.readTerminal.length, 1)
  assert.equal(h.runtime.calls.readTerminal[0]?.maxLines, 20, 'exactly the last twenty lines')
  assert.equal(stored.assignments[0]?.state, 'running', 'a blocked agent keeps its assignment')
  await h.cleanup()
})

test('agent status: blocked with an empty or unreadable terminal writes that no prompt is shown', async () => {
  const empty = harness()
  empty.seed(runningWithTerminal())
  withTerminal(empty.runtime)
  await statusOf(empty)(event('blocked', { terminalId: 'term_1' }))
  assert.equal(empty.read('ticket-11')?.attention?.question, NO_PROMPT)
  assert.equal(empty.read('ticket-11')?.attention?.via, 'terminal')
  await empty.cleanup()

  const broken = harness()
  broken.seed(runningWithTerminal())
  withTerminal(broken.runtime)
  broken.runtime.script.readTerminal = () => {
    throw new OrcaRuntimeError('agent_gone', 'the terminal went away')
  }
  await statusOf(broken)(event('blocked', { terminalId: 'term_1' }))
  const stored = broken.read('ticket-11')!
  assert.equal(stored.attention?.question, NO_PROMPT, 'a failed read still becomes a question')
  assert.equal(stored.assignments[0]?.report?.state, 'blocked', 'the evidence never blocks the event')
  await broken.cleanup()
})

test('agent status: blocked keeps a structured question the worker already asked', async () => {
  const h = harness()
  h.seed(runningWithTerminal())
  withTerminal(h.runtime)
  h.engine.report('ticket-11', { state: 'blocked', summary: 'need a decision', question: 'Which branch?' })

  await statusOf(h)(event('blocked', { terminalId: 'term_1' }))

  const stored = h.read('ticket-11')!
  assert.equal(stored.attention?.question, 'Which branch?', 'the structured question wins over a terminal summary')
  assert.equal(stored.attention?.via, undefined)
  assert.deepEqual(h.runtime.calls.readTerminal, [], 'no evidence read replaces a real question')
  await h.cleanup()
})

test('agent status: waiting ends the idle assignment as ended(waiting)', async () => {
  const h = harness()
  h.seed(runningWithTerminal())
  withTerminal(h.runtime)

  await statusOf(h)(event('waiting', { terminalId: 'term_1' }))

  const stored = h.read('ticket-11')!
  assert.equal(stored.assignments[0]?.state, 'ended')
  assert.equal(stored.assignments[0]?.endedReason, 'waiting')
  assert.equal(stored.ended, undefined, 'the ticket stays open for a later trigger')
  assert.deepEqual(h.runtime.calls.closeTerminal, [], 'a waiting worker keeps its terminal')
  await h.cleanup()
})

test('agent status: waiting keeps the assignment while an Input or a pending assignment waits', async () => {
  const h = harness()
  h.seed(
    ticket({
      assignments: [
        { id: 'a-1', state: 'running', createdAt: AT, terminalId: 'term_1', startedAt: AT },
        { id: 'a-2', state: 'pending', createdAt: AT }
      ],
      inputs: [triggerInput()],
      undelivered: ['input-1']
    })
  )
  withTerminal(h.runtime)

  await statusOf(h)(event('waiting', { terminalId: 'term_1' }))

  const stored = h.read('ticket-11')!
  assert.equal(stored.assignments[0]?.state, 'running', 'an undelivered Input still needs the worker')
  assert.equal(stored.assignments[0]?.endedReason, undefined)
  await h.cleanup()
})

test('agent status: an event without a terminal handle is located by paneKey or the machine-wide terminal list', async () => {
  const h = harness()
  h.seed(runningWithTerminal())
  withTerminal(h.runtime)

  // paneKey 直接是终端句柄（宿主某些版本如此，附录 C S7/S9）。
  await statusOf(h)({
    workspaceId: 'ws:superagent-fix-the-login-flow',
    paneKey: 'term_1',
    state: 'working',
    receivedAt: 1
  })
  assert.equal(h.read('ticket-11')?.assignments[0]?.state, 'running')

  // 两者都不是句柄：用 `listTerminals()`（全机）按 workspaceId 反查，`listAgents()` 不参与。
  await statusOf(h)({
    workspaceId: 'ws:superagent-fix-the-login-flow',
    paneKey: 'pane:1',
    state: 'waiting',
    receivedAt: 2
  })
  assert.equal(h.read('ticket-11')?.assignments[0]?.endedReason, 'waiting')
  assert.deepEqual(h.runtime.calls.listAgents, [], 'the focused-workspace agent list is never the truth')
  await h.cleanup()
})

test('agent status: done without a final report ends the assignment and marks the report missing', async () => {
  const h = harness()
  h.seed(runningWithTerminal())
  withTerminal(h.runtime)

  await statusOf(h)(event('done', { terminalId: 'term_1' }))

  const stored = h.read('ticket-11')!
  assert.equal(stored.assignments[0]?.state, 'ended')
  assert.equal(stored.assignments[0]?.endedReason, 'done')
  assert.equal(stored.assignments[0]?.report?.state, 'failed', 'a failure shows on the ticket')
  assert.ok(/final report/.test(stored.assignments[0]?.report?.summary ?? ''), 'the reason is report_missing')
  assert.equal(canRetry(stored), true, 'the failed ticket can be retried')
  assert.deepEqual(ticketStage(stored, 'done'), { stage: 'person', action: 'failed' })
  assert.equal(stored.ended, undefined, 'done alone does not end the ticket')
  assert.deepEqual(h.runtime.calls.closeTerminal, [])
  await h.cleanup()
})

test('agent status: done with a final report keeps it and ends the ticket by the report rules', async () => {
  const h = harness()
  h.seed(
    ticket({
      follows: [{ thread: 'github:9', own: false }],
      assignments: [
        {
          id: 'a-1',
          state: 'running',
          createdAt: AT,
          terminalId: 'term_1',
          startedAt: AT,
          report: { state: 'ready', summary: 'PR #9 is ready', at: AT }
        }
      ]
    })
  )
  withTerminal(h.runtime)

  await statusOf(h)(event('done', { terminalId: 'term_1' }))

  const stored = h.read('ticket-11')!
  assert.equal(stored.assignments[0]?.state, 'ended')
  assert.equal(stored.assignments[0]?.endedReason, 'done')
  assert.equal(stored.assignments[0]?.report?.state, 'ready', 'the final report is never overwritten')
  assert.equal(stored.ended, undefined, 'the ready report waits for its pull request to close')
  await h.cleanup()
})

test('agent status: a done event after a human stop is idempotent compensation, not a new lifecycle', async () => {
  const h = harness()
  h.seed(runningWithTerminal())
  withTerminal(h.runtime)
  h.engine.stopTicket('ticket-11')
  await h.effects.idle()
  const before = h.read('ticket-11')!

  await statusOf(h)(event('done', { terminalId: 'term_1' }))

  const after = h.read('ticket-11')!
  assert.deepEqual(after.assignments, before.assignments, 'the stopped assignment keeps its ending')
  assert.deepEqual(h.runtime.calls.launchAgent, [], 'no assignment is started by a done event')
  assert.deepEqual(h.runtime.calls.closeTerminal, ['term_1'], 'the stop already closed it exactly once')
  await h.cleanup()
})

test('agent status: each of the four states is persisted on the ticket with the moment it was observed', async () => {
  // §E.7 的四个状态要能在库里读回（#58）：Ticket 上带 `agentState` 与 `agentStateAt`，重启后
  // 读模型照样拿得到。`waiting` 结束 Assignment 但状态留在 `waiting`（§E.8 第 7 行的观测值）。
  for (const state of ['working', 'blocked', 'waiting', 'done'] as const) {
    const h = harness()
    h.seed(runningWithTerminal())
    withTerminal(h.runtime)

    await statusOf(h)(event(state, { terminalId: 'term_1' }))

    const stored = h.read('ticket-11')!
    assert.equal(stored.agentState, state, `${state} is written to the ticket`)
    assert.equal(stored.agentStateAt, AT, `${state} keeps the moment it was observed`)
    await h.cleanup()
  }
})

test('agent status: an ending assignment settles a stale blocked to done, and a human stop clears it', async () => {
  // 附录 C S7 的回落：不等事件，直接置为结束；事件只作幂等补偿。陈旧的 blocked 不该留下来
  // 把 Ticket 永远钉在 Blocked（§E.8 的收尾行）；`done` 仍是那一行集合的成员。
  const h = harness()
  h.seed(
    ticket({
      agentState: 'blocked',
      agentStateAt: AT,
      assignments: [
        {
          id: 'a-1',
          state: 'running',
          createdAt: AT,
          startedAt: AT,
          terminalId: 'term_1',
          report: { state: 'blocked', summary: 'need a decision', at: AT }
        }
      ]
    })
  )
  withTerminal(h.runtime)

  await statusOf(h)(event('done', { terminalId: 'term_1' }))

  const settled = h.read('ticket-11')!
  assert.equal(settled.agentState, 'done', 'the ended turn settles the observation')
  assert.deepEqual(ticketStage(settled), { stage: 'person', action: 'blocked' }, 'row 5 still holds on done')
  await h.cleanup()

  const stopped = harness()
  stopped.seed(
    ticket({
      agentState: 'blocked',
      agentStateAt: AT,
      assignments: [{ id: 'a-1', state: 'running', createdAt: AT, startedAt: AT, terminalId: 'term_1' }]
    })
  )
  withTerminal(stopped.runtime)
  stopped.engine.stopTicket('ticket-11')
  await stopped.effects.idle()
  assert.equal(stopped.read('ticket-11')!.agentState, 'done', 'a closed ticket leaves no stale blocked')
  await stopped.cleanup()
})

// ---- 崩溃 / 重启恢复（§E.5、§E.10）：全机终端枚举，认领或重建 -------------------------

/** 恢复夹具：一个仍在跑的 Assignment 与它记录下来的 worktree。 */
function resumeHarness(options: {
  readonly directory?: string
  readonly terminalId?: string
  readonly created?: string
  readonly id?: string
} = {}) {
  const h = harness()
  const directory = options.directory ?? '/w/superagent-fix-the-login-flow'
  h.runtime.workspaces = [
    workspace('superagent-fix-the-login-flow', directory, 'agent/fix-the-login-flow')
  ]
  h.runtime.registerAgent('ws:superagent-fix-the-login-flow', {
    terminalId: options.terminalId ?? 'term_1',
    workspaceId: 'ws:superagent-fix-the-login-flow',
    launchedAt: 1
  })
  h.seed(
    ticket({
      id: options.id ?? 'ticket-11',
      execution: { name: 'fix-the-login-flow', directory, assignment: 'the brief' },
      // 重启前 agent 停在提示上：认领（adopt）不该改写它，重建（interrupt）则收尾成 done。
      agentState: 'blocked',
      agentStateAt: AT,
      assignments: [
        {
          id: `${options.id ?? 'ticket-11'}-a1`,
          state: 'running',
          createdAt: options.created ?? AT,
          startedAt: AT,
          terminalId: options.terminalId ?? 'term_1'
        }
      ]
    })
  )
  const resume = (): Promise<ResumeReport> =>
    resumeAssignments({
      runtime: h.runtime,
      engine: h.engine,
      records: { tickets: { list: () => h.readAll() } },
      log: (line) => h.logs.push(line)
    })
  return { ...h, resume }
}

test('resume adopts a live terminal whose worktree is this ticket and says restored', async () => {
  const h = resumeHarness()

  const report = await h.resume()

  const stored = h.read('ticket-11')!
  assert.deepEqual(stored.assignments.map((item) => item.state), ['running'], 'the assignment is adopted')
  // 认领是「会话还在」：观测值原样保留（§E.10 的恢复不改事实，下一个事件才改）。
  assert.equal(stored.agentState, 'blocked', 'an adopted assignment keeps the observed agent state')
  assert.equal(stored.agentStateAt, AT, 'and the moment it was observed')
  assert.equal(h.runtime.calls.sent.length, 1, 'the worker is told it was restored')
  const sent = h.runtime.calls.sent[0]!
  assert.equal(sent.terminalId, 'term_1')
  assert.equal(sent.enter, true)
  assert.ok(/restored/i.test(sent.text), `the message says restored: ${sent.text}`)
  assert.equal(sent.text.includes('\n'), false, 'one line, never a multi-line seed')
  assert.deepEqual(h.runtime.calls.launchAgent, [], 'no worker is started over an adopted one')
  assert.deepEqual(h.runtime.calls.listAgents, [], 'the focused-workspace agent list is never the truth')
  assert.deepEqual(report.assignments.map((item) => item.outcome), ['adopted'])
  await h.cleanup()
})

test('resume adopts an orphaned-but-connected terminal: no pane is not no process (附录 C S2/S7)', async () => {
  const h = resumeHarness()
  // #16 的附录 C 实测：`agent launch --surface terminal` 起在没打开的 worktree 里，终端是
  // `connected: true, orphaned: true`——它只是没有挂载到可见 pane，进程与 TUI 都活着。判活因此
  // 与 `OrcaRuntime.findAgent` 同一格（只看 `connected`）；把 orphaned 当死亡会让后台 worker
  // 在插件重启后被重建，同一张 Ticket 上出现两条 Assignment。
  h.runtime.script.listTerminals = () => [
    {
      handle: 'term_1',
      worktreeId: 'ws:superagent-fix-the-login-flow',
      worktreePath: '/w/superagent-fix-the-login-flow',
      title: null,
      connected: true,
      orphaned: true
    }
  ]

  const report = await h.resume()

  const stored = h.read('ticket-11')!
  assert.deepEqual(report.assignments.map((item) => item.outcome), ['adopted'], 'the background worker is adopted')
  assert.deepEqual(stored.assignments.map((item) => item.state), ['running'], 'no second assignment is created')
  assert.equal(stored.assignments[0]?.endedReason, undefined, 'the live assignment is not ended')
  assert.equal(stored.agentState, 'blocked', 'the observed agent state is left for the next event')
  assert.equal(h.runtime.calls.sent.length, 1, 'the worker is told it was restored')
  assert.equal(h.runtime.calls.sent[0]?.terminalId, 'term_1')
  assert.ok(/restored/i.test(h.runtime.calls.sent[0]?.text ?? ''), 'the message says restored')
  assert.deepEqual(h.runtime.calls.launchAgent, [], 'a background worker is never started twice')
  await h.effects.idle()
  assert.deepEqual(h.runtime.calls.ensureWorkspace, [], 'and its worktree is not rebuilt')
  await h.cleanup()
})

test('resume interrupts assignments whose terminal is gone and rebuilds them, oldest first, with the recovery note', async () => {
  const h = harness()
  h.seed(
    ticket({
      id: 'ticket-12',
      title: 'Older work',
      assignments: [
        { id: 'a-old', state: 'running', createdAt: '2026-11-07T03:00:00.000Z', terminalId: 'term_gone' }
      ]
    })
  )
  h.seed(
    ticket({
      id: 'ticket-11',
      assignments: [
        { id: 'a-new', state: 'running', createdAt: '2026-11-07T03:10:00.000Z', terminalId: 'term_also_gone' }
      ]
    })
  )

  const report = await resumeAssignments({
    runtime: h.runtime,
    engine: h.engine,
    records: { tickets: { list: () => h.readAll() } }
  })
  assert.deepEqual(
    report.assignments.map((item) => `${item.ticketId}:${item.outcome}`),
    ['ticket-12:interrupted', 'ticket-11:interrupted'],
    'oldest assignment first'
  )
  for (const id of ['ticket-11', 'ticket-12']) {
    const ticket = h.read(id)!
    assert.deepEqual(ticket.assignments.map((item) => item.state), ['ended', 'pending'])
    assert.equal(ticket.assignments[0]?.endedReason, 'interrupted')
    const note = ticket.inputs.find(
      (input) => input.kind === 'text' && input.text.includes('git history and GitHub')
    )
    assert.ok(note, `${id} restarts with the recovery note`)
  }

  await h.effects.idle()
  assert.deepEqual(
    h.runtime.calls.ensureWorkspace.map((spec) => spec.name),
    ['superagent-older-work', 'superagent-fix-the-login-flow'],
    'the rebuilds keep the oldest-first order'
  )
  await h.cleanup()
})

test('resume interrupts a terminal that is alive but belongs to another worktree', async () => {
  const h = resumeHarness({ directory: '/w/someone-elses-checkout' })
  h.runtime.workspaces = [
    workspace('other', '/w/someone-elses-checkout', 'other/work')
  ]

  const report = await h.resume()

  assert.deepEqual(report.assignments.map((item) => item.outcome), ['interrupted'])
  assert.equal(h.read('ticket-11')?.assignments[0]?.endedReason, 'interrupted')
  assert.equal(h.read('ticket-11')?.agentState, 'done', 'the replaced session leaves no stale blocked')
  assert.deepEqual(h.runtime.calls.sent, [], 'the wrong terminal is never written to')
  await h.cleanup()
})

test('resume interrupts a disconnected terminal even when it is also marked orphaned', async () => {
  const h = resumeHarness()
  h.runtime.script.listTerminals = () => [
    {
      handle: 'term_1',
      worktreeId: 'ws:superagent-fix-the-login-flow',
      worktreePath: '/w/superagent-fix-the-login-flow',
      title: null,
      connected: false,
      orphaned: true
    }
  ]

  const report = await h.resume()

  assert.deepEqual(report.assignments.map((item) => item.outcome), ['interrupted'])
  assert.deepEqual(h.runtime.calls.sent, [])
  await h.cleanup()
})

// ---- 30 分钟后台工作（§E.9 的近似）：计时、收尾指令、清除标记 -------------------------

/** 把后台计时器接到夹具上（面板读的就是 `state()`）。 */
function backgroundOf(h: ReturnType<typeof harness>) {
  return createBackgroundTracker({
    records: { tickets: { get: (id) => h.read(id) } },
    runtime: h.runtime,
    now: () => h.clock.now(),
    log: (line) => h.logs.push(line)
  })
}

/** 一个已 report 过的运行中 Ticket（§E.9 第 1 步的前置）。 */
function reportedWorking(state: 'progress' | 'ready' | 'waiting' = 'progress'): Ticket {
  return ticket({
    follows: state === 'ready' ? [{ thread: 'github:9', own: false }] : undefined,
    assignments: [
      {
        id: 'a-1',
        state: 'running',
        createdAt: AT,
        terminalId: 'term_1',
        startedAt: AT,
        report: { state, summary: 'still going', at: AT }
      }
    ]
  })
}

test('background work: a progress report followed by working starts the clock, and 30 min sends the wrap-up', async () => {
  const h = harness()
  h.seed(reportedWorking())
  withTerminal(h.runtime)
  const background = backgroundOf(h)

  background.observed('ticket-11', 'working')
  assert.deepEqual(background.state('ticket-11'), { since: h.clock.now(), expired: false })

  h.clock.advance(BACKGROUND_LIMIT_MS - 1_000)
  await background.poll()
  assert.deepEqual(h.runtime.calls.sent, [], 'nothing is sent before the limit')

  h.clock.advance(1_000)
  await background.poll()
  const sent = h.runtime.calls.sent[0]!
  assert.equal(sent.terminalId, 'term_1')
  assert.equal(sent.enter, true)
  assert.ok(/30 minutes/.test(sent.text), `the wrap-up names the limit: ${sent.text}`)
  assert.ok(/report waiting/.test(sent.text), 'it tells the worker how to end the turn')
  assert.equal(sent.text.includes('\n'), false, 'one line')
  assert.equal(background.state('ticket-11')?.expired, true, 'the ticket is marked as past 30 minutes')
  assert.deepEqual(h.runtime.calls.closeTerminal, [], 'the process is never killed')

  h.clock.advance(BACKGROUND_LIMIT_MS)
  await background.poll()
  assert.equal(h.runtime.calls.sent.length, 1, 'the wrap-up is sent once')
  await h.cleanup()
})

test('background work: a waiting agent or a person\'s message clears the flags', async () => {
  const h = harness()
  h.seed(reportedWorking())
  withTerminal(h.runtime)
  const background = backgroundOf(h)
  background.observed('ticket-11', 'working')
  h.clock.advance(BACKGROUND_LIMIT_MS)
  await background.poll()
  assert.equal(background.state('ticket-11')?.expired, true)

  background.observed('ticket-11', 'waiting')
  assert.equal(background.state('ticket-11'), undefined, 'waiting ends the background turn')

  // 人的消息之后，旧起点不再算数。
  h.clock.advance(1_000)
  background.observed('ticket-11', 'working')
  assert.ok(background.state('ticket-11'))
  h.clock.advance(60_000)
  const withPerson = h.read('ticket-11')!
  h.seed({
    ...withPerson,
    inputs: [
      ...withPerson.inputs,
      {
        id: 'human-1',
        kind: 'trigger',
        triggerId: 'trigger-1',
        at: new Date(h.clock.now()).toISOString(),
        human: true
      }
    ]
  })
  assert.equal(background.state('ticket-11'), undefined, 'a person\'s message clears the flag')
  h.clock.advance(BACKGROUND_LIMIT_MS * 2)
  await background.poll()
  assert.equal(h.runtime.calls.sent.length, 1, 'a cleared flag sends nothing more')
  await h.cleanup()
})

test('background work: only progress or ready reports start the clock', async () => {
  const h = harness()
  h.seed(reportedWorking('waiting'))
  withTerminal(h.runtime)
  const background = backgroundOf(h)

  background.observed('ticket-11', 'working')
  assert.equal(background.state('ticket-11'), undefined, 'a waiting report is not background work')

  const ready = harness()
  ready.seed(reportedWorking('ready'))
  withTerminal(ready.runtime)
  const readyBackground = backgroundOf(ready)
  readyBackground.observed('ticket-11', 'working')
  assert.ok(readyBackground.state('ticket-11'), 'a ready report followed by working starts the clock')
  await h.cleanup()
  await ready.cleanup()
})

// ---- 阻塞与失败（§E.5 / §H.4）：三次失败后不再自动输入，工具仍可用 ----------------------

test('three failed launches stop automatic input, and the failure shows on the ticket', async () => {
  const h = harness()
  h.runtime.script.ensureWorkspace = () => {
    throw new OrcaRuntimeError('cli_failed', 'worktree create failed')
  }
  h.seed(ticket({ assignments: [assignment('a-1', 'pending')] }))
  h.seedTrigger(trigger())
  h.engine.bindThread('ticket-11', { source: 'github', id: 'acme/widgets#42' }, false)
  h.executor.start(h.read('ticket-11')!, h.read('ticket-11')!.assignments[0]!)
  await h.effects.idle()
  h.clock.advance(5_000)
  await h.effects.idle()
  h.clock.advance(10_000)
  await h.effects.idle()

  const failed = h.read('ticket-11')!
  assert.equal(failed.assignments[0]?.report?.state, 'failed')
  assert.deepEqual(ticketStage(failed, 'done'), { stage: 'person', action: 'failed' }, 'the panel shows it')
  assert.equal(h.effects.pending('launch', 'ticket-11'), false, 'no fourth attempt')

  // CI / bot 消息到了：记在 Ticket 上，但不投递、也不再唤醒它。
  h.clock.advance(60_000)
  const bot = trigger({
    id: 'trigger-ci',
    human: false,
    addressed: undefined,
    actor: { source: 'github', id: 'ci-bot' }
  })
  assert.equal(h.engine.receive(bot), 'stored')
  await h.effects.idle()
  const after = h.read('ticket-11')!
  assert.ok(after.inputs.some((input) => input.kind === 'trigger' && input.triggerId === 'trigger-ci'))
  assert.deepEqual(after.undelivered, [], 'an automatic Input stays undelivered')
  assert.deepEqual(h.runtime.calls.sent, [], 'nothing is written to a worker that failed')
  assert.equal(h.effects.pending('launch', 'ticket-11'), false, 'the bot message does not relaunch')
  await h.cleanup()
})

test('a failed worker keeps its terminal and tools, and a person\'s message releases the hold', async () => {
  const h = harness()
  h.seed(runningWithTerminal())
  withTerminal(h.runtime)
  h.seedTrigger(trigger())
  h.engine.bindThread('ticket-11', { source: 'github', id: 'acme/widgets#42' }, false)
  h.engine.report('ticket-11', { state: 'failed', summary: 'the build could not be fixed' })

  h.clock.advance(60_000)
  const bot = trigger({
    id: 'trigger-ci',
    human: false,
    addressed: undefined,
    actor: { source: 'github', id: 'ci-bot' }
  })
  assert.equal(h.engine.receive(bot), 'stored')
  await h.effects.idle()
  assert.deepEqual(h.runtime.calls.sent, [], 'automatic input waits while the worker is failed')
  assert.deepEqual(h.runtime.calls.closeTerminal, [], 'its terminal stays open: the tools stay available')
  assert.deepEqual(ticketStage(h.read('ticket-11')!, 'done'), { stage: 'person', action: 'failed' })

  // 人的消息结束这个 hold：它被投递给仍在跑的 worker。
  h.clock.advance(60_000)
  h.engine.receive(
    trigger({ id: 'trigger-human-2', text: 'Try the other branch instead.' })
  )
  await h.effects.idle()
  assert.ok(h.runtime.calls.sent.length > 0, 'a person can continue the ticket directly')
  const released = h.read('ticket-11')!
  assert.equal(released.assignments[0]?.state, 'running', 'the session is still the same worker')
  assert.deepEqual(ticketStage(released, 'working'), { stage: 'working' })
  await h.cleanup()
})

test('the executor lifecycle wires agent status into the background clock and resume', async () => {
  const h = harness()
  const directory = '/w/superagent-fix-the-login-flow'
  h.runtime.workspaces = [workspace('superagent-fix-the-login-flow', directory, 'agent/fix-the-login-flow')]
  h.seed({ ...reportedWorking(), execution: { name: 'fix-the-login-flow', directory, assignment: 'brief' } })
  withTerminal(h.runtime)
  const lifecycle = registerExecutorLifecycle({
    runtime: h.runtime,
    engine: h.engine,
    records: { tickets: { get: (id) => h.read(id), list: () => h.readAll() }, triggers: { get: () => undefined } },
    now: () => h.clock.now(),
    log: (line) => h.logs.push(line)
  })

  await lifecycle.status(event('working', { terminalId: 'term_1' }))
  assert.ok(lifecycle.background.state('ticket-11'), 'a working event starts the background clock')
  h.clock.advance(BACKGROUND_LIMIT_MS)
  await lifecycle.background.poll()
  assert.equal(h.runtime.calls.sent.filter((sent) => /30 minutes/.test(sent.text)).length, 1)

  const resumed = await lifecycle.resume()
  assert.deepEqual(resumed.assignments.map((item) => item.outcome), ['adopted'])
  lifecycle.background.stop()
  assert.equal(lifecycle.background.state('ticket-11'), undefined)
  await h.cleanup()
})

test('a later trigger wakes an idle assignment that waiting ended', async () => {
  const h = harness()
  h.seed(runningWithTerminal())
  h.seedTrigger(trigger())
  h.engine.bindThread('ticket-11', { source: 'github', id: 'acme/widgets#42' }, false)
  withTerminal(h.runtime)

  await statusOf(h)(event('waiting', { terminalId: 'term_1' }))
  assert.equal(h.read('ticket-11')?.assignments[0]?.endedReason, 'waiting')

  h.clock.advance(60_000)
  assert.equal(
    h.engine.receive(trigger({ id: 'trigger-followup', text: 'Now also update the docs.' })),
    'stored'
  )
  const woken = h.read('ticket-11')!
  assert.deepEqual(
    woken.assignments.map((item) => item.state),
    ['ended', 'pending'],
    'a new assignment carries the follow-up'
  )
  assert.equal(woken.ended, undefined, 'the ticket itself stays open')

  await h.effects.idle()
  const started = h.read('ticket-11')!
  assert.equal(started.assignments[1]?.state, 'running', 'the new assignment is launched')
  assert.ok(started.assignments[1]?.terminalId, 'the new assignment has its own terminal')
  assert.equal(h.runtime.calls.launchAgent.length, 1, 'only the follow-up launches a worker')
  assert.ok(
    h.runtime.calls.sent.some((sent) => sent.text.includes('Now also update the docs.')),
    'the follow-up reaches the new worker'
  )
  assert.deepEqual(h.runtime.calls.ensureWorkspace.length, 1, 'the worktree is reused')
  await h.cleanup()
})

test('agent status: done after a waiting report is an idle turn, not a missing report', async () => {
  const h = harness()
  h.seed(
    ticket({
      assignments: [
        {
          id: 'a-1',
          state: 'running',
          createdAt: AT,
          terminalId: 'term_1',
          startedAt: AT,
          report: { state: 'waiting', summary: 'nothing left to do', at: AT }
        }
      ]
    })
  )
  withTerminal(h.runtime)

  await statusOf(h)(event('done', { terminalId: 'term_1' }))

  const stored = h.read('ticket-11')!
  assert.equal(stored.assignments[0]?.state, 'ended')
  assert.equal(stored.assignments[0]?.endedReason, 'done')
  assert.equal(
    stored.assignments[0]?.report?.state,
    'waiting',
    'a reported turn end keeps its waiting report (Orca reports `done` for every finished turn)'
  )
  assert.deepEqual(ticketStage(stored, 'done'), { stage: 'idle' })
  assert.equal(canRetry(stored), false, 'an idle turn is not a failure to retry')
  await h.cleanup()
})

test('agent status: done after only a progress report still counts as a missing final report', async () => {
  const h = harness()
  h.seed(
    ticket({
      assignments: [
        {
          id: 'a-1',
          state: 'running',
          createdAt: AT,
          terminalId: 'term_1',
          startedAt: AT,
          report: { state: 'progress', summary: 'still going', at: AT }
        }
      ]
    })
  )
  withTerminal(h.runtime)

  await statusOf(h)(event('done', { terminalId: 'term_1' }))

  const stored = h.read('ticket-11')!
  assert.equal(stored.assignments[0]?.report?.state, 'failed')
  assert.ok(/final report/.test(stored.assignments[0]?.report?.summary ?? ''))
  assert.equal(canRetry(stored), true)
  await h.cleanup()
})

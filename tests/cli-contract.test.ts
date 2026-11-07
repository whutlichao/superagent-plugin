// CLI 契约（§P.2 的 `cli-contract.test.ts` 行）：**表驱动**，每条命令至少一条成功与一条固定
// 拒绝，断言 `error.code` 而不是文案。
//
// 命令分两类，成功面的含义不同（票面「Router/Worker 命令先占住最终名字与参数，返回固定
// `unavailable` 直到拥有它的票接上实现」）：
// - **已接线**：成功用例打到真 loopback 服务器并断言 `result` 的形状；拒绝用例断言固定码；
// - **未落地**：成功面就是那条固定的 `unavailable`（退出 3），并断言**没有发出**任何 HTTP
//   请求——「这台构建还没有它」与「worker 不在」因此不会混淆；等拥有它的票接上后，这张表
//   的该行换成真成功用例（那时 `available` 变 true）。
//
// 每条命令都必须出现在表里（下面有断言），于是新增命令不会漏测；断言一律按 `error.code`。
import { assert, test } from 'orca/testing'
import { rmSync } from 'node:fs'
import { CLI_COMMANDS, commandFor } from '../src/worker/cli/commands'
import { ApiError } from '../src/worker/http/errors'
import { dispatch } from '../src/worker/cli/commands'
import { parseArgs } from '../src/worker/cli/io'
import { main } from '../src/worker/cli/main'
import { createDomainHandlers, withDomainHandlers } from '../src/worker/http/domain'
import { createSettingsHandlers, withSettingsHandlers } from '../src/worker/http/settings'
import { createSettings } from '../src/worker/app/settings'
import { runWrite } from '../src/worker/http/idempotency'
import { EVAL_BLOCK_SCHEMA } from '../src/worker/app/settings-blocks'
import { createAssessmentHandlers, withAssessmentHandlers } from '../src/worker/http/assessment'
import { createEvalHandlers, withEvalHandlers } from '../src/worker/http/eval'
import { createReadHandlers, withReadHandlers } from '../src/worker/http/read'
import { createReadTools } from '../src/worker/app/read'
import { createEvalTools } from '../src/worker/app/eval'
import { FakeCommands } from './support/fake-commands'
import { createPromptHandlers, withPromptHandlers } from '../src/worker/http/prompts'
import { createPromptVersions } from '../src/worker/app/prompts'
import type { Store } from '../src/worker/app/store'
import { createRouterTools } from '../src/worker/app/assessment'
import type { Candidate, Decision, Thread, Ticket } from '../src/worker/core/index'
import { ROUTE_TABLE, type RouteDefinition } from '../src/worker/http/routes'
import { UserError } from '../src/worker/core/index'
import { AT, tempStateDir } from './support/state'
import { startTestServer, type TestServer } from './support/cli-server'

/** 一条契约用例。`ok` 为真时断言成功，否则断言 `error.code` 与退出码。 */
interface Case {
  readonly argv: readonly string[]
  /** 期望的退出码（§G.1：0/1/2/3）。 */
  readonly exit: number
  /** 期望成功的 `result` 顶层字段（只列出必须有的）。 */
  readonly resultKeys?: readonly string[]
  /** 期望的固定错误码。 */
  readonly code?: string
  /** 用什么 token（缺省 operator）。`null` 表示一个都没有。 */
  readonly token?: 'operator' | 'router' | 'assignment' | null
  /** 这条用例不该发出 HTTP 请求（未落地命令的固定拒绝）。 */
  readonly offline?: boolean
  /** 喂给 stdin 的正文（`--assessment -` 这类 `<file|->` 参数）。 */
  readonly stdin?: string
}

/** 已接线命令的成功 + 固定拒绝。 */
const WIRED: readonly (readonly [string, Case, Case])[] = [
  [
    'status',
    { argv: ['status'], exit: 0, resultKeys: ['process', 'store', 'http', 'health', 'setup', 'paused', 'load'] },
    { argv: ['status', '--bogus', 'x'], exit: 2, code: 'invalid_params' }
  ],
  [
    'health',
    { argv: ['health'], exit: 0, resultKeys: ['health'] },
    { argv: ['health', '--offset', 'x'], exit: 2, code: 'invalid_params' }
  ],
  [
    'pause',
    { argv: ['pause'], exit: 0, resultKeys: ['paused', 'at', 'changed'] },
    // router token 不够 operator 档（§G.1 角色行）。
    { argv: ['pause'], exit: 2, code: 'not_permitted_role', token: 'router' }
  ],
  [
    'resume',
    { argv: ['resume'], exit: 0, resultKeys: ['paused', 'changed'] },
    { argv: ['resume'], exit: 2, code: 'not_permitted_role', token: 'router' }
  ],
  [
    'setup check',
    // 没有组合根的测试服务器不给 setup 端口：形状固定为 unavailable，绝不冒充「检查过了」。
    // 真的重跑（含「已无问题时 refused」）由 `deployment.test.ts` 在真组合根上断言。
    { argv: ['setup', 'check'], exit: 3, code: 'unavailable' },
    { argv: ['setup', 'check'], exit: 2, code: 'not_permitted_role', token: 'router' }
  ],
  [
    'source labels',
    { argv: ['source', 'labels', 'github'], exit: 3, code: 'unavailable' },
    { argv: ['source', 'labels'], exit: 2, code: 'invalid_params' }
  ],
  [
    'admin backup',
    { argv: ['admin', 'backup'], exit: 0, resultKeys: ['path', 'at', 'bytes', 'kept'] },
    { argv: ['admin', 'backup'], exit: 2, code: 'not_permitted_role', token: 'router' }
  ],
  [
    'admin rotate-token',
    { argv: ['admin', 'rotate-token', '--yes'], exit: 0, resultKeys: ['tokenFile', 'rotated'] },
    // 破坏性动作没有 `--yes`：固定拒绝（§O），且什么都不改。
    { argv: ['admin', 'rotate-token'], exit: 2, code: 'refused' }
  ],
  [
    'doctor',
    { argv: ['doctor'], exit: 0, resultKeys: ['checks', 'summary', 'stateDir', 'at'] },
    { argv: ['doctor'], exit: 2, code: 'not_permitted_role', token: 'router' }
  ],
  [
    'read',
    // Source 资源读面（#57）：一个真资源名读到一条 Issue 描述（真 loopback + 假 `gh`）。
    {
      argv: ['read', 'github/issues/12'],
      exit: 0,
      resultKeys: ['resource', 'kind', 'status', 'items', 'next_offset', 'next', 'body']
    },
    // 未知资源名是固定拒绝（`unknown_resource`，退出 2），且**不发请求**：换一种写法是人的事。
    { argv: ['read', 'nope'], exit: 2, code: 'unknown_resource', offline: true }
  ],
  // 本票接线的 Worker 三条（§G.2 的 report / reply / ack）：打到真的领域 handler。
  [
    'route',
    {
      argv: ['route', '--item', '{"kind":"ignore","trigger_id":"trigger-1","reason":"chatter"}'],
      exit: 0,
      resultKeys: ['results'],
      token: 'router'
    },
    { argv: ['route'], exit: 2, code: 'invalid_params' }
  ],
  // 评估面（§G.2 的 eval / eval-read）：router 可用、读同一份 handler；非候选是 missing。
  [
    'eval',
    {
      argv: ['eval', 'trigger-1'],
      exit: 0,
      resultKeys: [
        'trigger',
        'batch',
        'threadWindow',
        'relatedTickets',
        'ticketsTotal',
        'policyVersion',
        'stubs'
      ],
      token: 'router'
    },
    { argv: ['eval', 'nope'], exit: 2, code: 'missing', token: 'router' }
  ],
  [
    'eval-read',
    {
      argv: ['eval-read', 'trigger-1', '--message-id', 'trigger-1'],
      exit: 0,
      resultKeys: ['message'],
      token: 'router'
    },
    // 四种读法必须恰好给一种：两种就是参数错误，且不发请求。
    {
      argv: ['eval-read', 'trigger-1', '--message-id', 'x', '--part', 'thread'],
      exit: 2,
      code: 'invalid_params',
      token: 'router',
      offline: true
    }
  ],
  [
    'eval-decide',
    {
      argv: ['eval-decide', 'trigger-1', '--assessment', '-'],
      exit: 0,
      resultKeys: ['decision', 'reason'],
      token: 'router',
      stdin:
        '{"decision":"ignore","direction":{"implementation_requested":false,"target_basis":"undetermined","requires_design_decision":false,"evidence":"chatter"},"rule_assessments":[],"reason":"chatter"}'
    },
    // 没有 Eval 持有它：固定的 too_late，不是 internal。
    {
      argv: ['eval-decide', 'nope', '--assessment', '-'],
      exit: 2,
      code: 'too_late',
      token: 'router',
      stdin: '{}'
    }
  ],
  [
    'reply',
    {
      argv: ['reply', '--purpose', 'attention', '--text', 'Need a decision', '--human-action', 'Which branch?'],
      exit: 0,
      resultKeys: ['id', 'status', 'reused']
    },
    { argv: ['reply', '--purpose', 'answer', '--text', 'yes'], exit: 2, code: 'invalid_params' }
  ],
  [
    'ack',
    {
      argv: ['ack', '--trigger', 'trigger-1', '--text', 'On it'],
      exit: 0,
      resultKeys: ['id', 'status', 'reused'],
      token: 'assignment'
    },
    // 没有 assignment token 的调用者不能替某个 Ticket 确认（§O）。
    { argv: ['ack', '--trigger', 'trigger-1', '--text', 'On it'], exit: 2, code: 'not_permitted_role' }
  ],
  // Prompt 配置（§L.4）：保存是带基础版本号的写，读面给出配置、内置分片与历史。
  [
    'prompts get',
    { argv: ['prompts', 'get'], exit: 0, resultKeys: ['revision', 'config', 'parts', 'default_changed', 'history'], token: 'router' },
    { argv: ['prompts', 'get', '--revision', 'nope'], exit: 2, code: 'invalid_value' }
  ],
  [
    'prompts save',
    {
      argv: ['prompts', 'save', '--config', '-', '--base-revision', '0'],
      exit: 0,
      resultKeys: ['revision', 'changed', 'dropped'],
      token: 'router',
      stdin: '{"team":{"scope":"Settings only."}}'
    },
    // 保存必须带基础版本号：缺了是参数错误，不是 fixed unavailable。
    { argv: ['prompts', 'save', '--config', '-'], exit: 2, code: 'invalid_params', stdin: '{}' }
  ],
  [
    'report',
    {
      argv: ['report', '--state', 'ready', '--summary', 'The redirect is fixed.'],
      exit: 0,
      resultKeys: ['ticket', 'assignment'],
      token: 'assignment'
    },
    // report 只属于 assignment：Ticket 来自它的 token，不是参数（§G.2）。
    {
      argv: ['report', '--state', 'ready', '--summary', 'The redirect is fixed.'],
      exit: 2,
      code: 'not_permitted_role'
    }
  ],
  // #28 的 `ticket note`：100 词上限由 handler 固定拒绝；成功面是一条 `note` Input。
  [
    'ticket note',
    { argv: ['ticket', 'note', 'ticket-own', '--text=a fact'], exit: 0, resultKeys: ['sent'] },
    { argv: ['ticket', 'note', 'ticket-own', '--text=' + 'word '.repeat(101)], exit: 2, code: 'too_long' }
  ],
  [
    'ticket request-status',
    { argv: ['ticket', 'request-status', 'ticket-own'], exit: 0, resultKeys: ['asked', 'ticket'] },
    { argv: ['ticket', 'request-status', 'nope'], exit: 2, code: 'missing' }
  ],
  // #29 的两条：重试新建一个 Assignment，停止要确认且只对未结束的 Ticket 成立（§G.2、§O）。
  [
    'ticket retry',
    { argv: ['ticket', 'retry', 'ticket-own'], exit: 0, resultKeys: ['retried', 'assignment'] },
    { argv: ['ticket', 'retry', 'ticket-ended'], exit: 2, code: 'not_retryable' }
  ],
  [
    'ticket stop',
    { argv: ['ticket', 'stop', 'ticket-own', '--yes', '--reason=Not needed'], exit: 0, resultKeys: ['stopped'] },
    // 已经结束的 Ticket 不再改变状态：固定的 `already_ended`，不是 `refused`。
    { argv: ['ticket', 'stop', 'ticket-ended', '--yes'], exit: 2, code: 'already_ended' }
  ],
  // `trigger handback` 是 worker 的命令：Ticket 来自 assignment token（§G.2）。
  [
    'trigger handback',
    {
      argv: ['trigger', 'handback', 'trigger-1', '--reason=It is a different request.'],
      exit: 0,
      resultKeys: ['queued'],
      token: 'assignment'
    },
    {
      argv: ['trigger', 'handback', 'never-reached', '--reason=Not mine.'],
      exit: 2,
      code: 'not_owned',
      token: 'assignment'
    }
  ],
  // 本票接线的命令面（§G.2）：ticket list / trigger requeue / thread * / settings * / policy sync。
  [
    'ticket list',
    { argv: ['ticket', 'list', '--state', 'open', '--limit', '5'], exit: 0, resultKeys: ['items', 'next_offset'] },
    // `--state` 的候选由服务端的读模型判（`invalid_state`），不在客户端猜。
    { argv: ['ticket', 'list', '--state', 'nope'], exit: 2, code: 'invalid_state' }
  ],
  [
    'trigger requeue',
    { argv: ['trigger', 'requeue', 'trigger-2'], exit: 0, resultKeys: ['queued'] },
    // 执行器仍拥有这条人的消息：固定的 `not_requeueable`，不绕开它的 worker。
    { argv: ['trigger', 'requeue', 'trigger-1'], exit: 2, code: 'not_requeueable' }
  ],
  [
    'thread unsubscribe',
    { argv: ['thread', 'unsubscribe', 'github:acme/widgets#43'], exit: 0, resultKeys: ['removed', 'thread'] },
    { argv: ['thread', 'unsubscribe', 'github:none'], exit: 2, code: 'missing' }
  ],
  [
    'thread follow',
    {
      argv: ['thread', 'follow', 'github:acme/widgets#43', '--reason=Related context'],
      exit: 0,
      resultKeys: ['followed'],
      token: 'assignment'
    },
    // 它自己的 Thread（来源 Thread）：不能当语境跟随。
    {
      argv: ['thread', 'follow', 'github:acme/widgets#42', '--reason=Mine'],
      exit: 2,
      code: 'own_thread',
      token: 'assignment'
    }
  ],
  [
    'thread unrelated',
    {
      argv: ['thread', 'unrelated', 'github:acme/widgets#44', '--reason=Not this ticket'],
      exit: 0,
      resultKeys: ['dropped', 'handedBack'],
      token: 'assignment'
    },
    {
      argv: ['thread', 'unrelated', 'github:acme/widgets#45', '--reason=Not this ticket'],
      exit: 2,
      code: 'not_followed',
      token: 'assignment'
    }
  ],
  [
    'settings get',
    { argv: ['settings', 'get', '--block', 'executor'], exit: 0, resultKeys: ['revision', 'blocks'], token: 'router' },
    { argv: ['settings', 'get', '--block', 'nope'], exit: 2, code: 'missing', token: 'router' }
  ],
  [
    'settings save',
    {
      argv: ['settings', 'save', '--block', 'eval', '--value', '-', '--revision', '0'],
      exit: 0,
      resultKeys: ['revision', 'policy_changed', 'restarting'],
      token: 'router',
      stdin: '{"timeoutSeconds":120}'
    },
    // 基础版本号已被上一次保存超过：固定的 `stale_revision`（§G.2）。
    {
      argv: ['settings', 'save', '--block', 'eval', '--value', '-', '--revision', '0'],
      exit: 2,
      code: 'stale_revision',
      token: 'router',
      stdin: '{"timeoutSeconds":300}'
    }
  ],
  [
    'policy sync',
    { argv: ['policy', 'sync', 'github'], exit: 0, resultKeys: ['policy', 'allowed', 'added', 'removed'], token: 'router' },
    { argv: ['policy', 'sync', 'nope'], exit: 2, code: 'not_syncable', token: 'router' }
  ]
]

/** 一个能通过领域 handler 形状检查的最小 Ticket（handler 只读它来组 view）。 */
function ticketForCommands(): Ticket {
  return {
    id: 'ticket-own',
    title: 'Fix the login redirect',
    decisionId: 'decision-1',
    mandate: {
      strength: 'explicit',
      policyVersion: 'v1',
      basis: { via: 'addressed', addressed: 'mention' },
      actor: { source: 'github', id: 'alice' },
      scope: 'ticket'
    },
    channels: [],
    assignments: [{ id: 'assignment-1', state: 'running', createdAt: AT, startedAt: AT }],
    inputs: [],
    undelivered: [],
    createdAt: AT,
    updatedAt: AT,
    origin: { triggerId: 'trigger-1', triggerIds: ['trigger-1'] }
  }
}

/**
 * Router 命令的替身宿主：`trigger-1` 有一个推断候选（`eval` / `eval-read` 只对推断候选可用），
 * 其余 trigger 没有 Eval（too_late）。领域写入被固定为一条 ignore Decision（route /
 * eval-decide 的形状与错误码是这里的断言面，真正的领域行为在 `route.test.ts` 用真 Engine 覆盖）。
 */
function commandFixture(): { ticket: Ticket; trigger: Candidate['triggers'][number]; candidate: Candidate } {
  const ticket = ticketForCommands()
  const trigger = {
    id: 'trigger-1',
    source: 'github',
    threads: [{ source: 'github', id: 'acme/widgets#42' }],
    actor: { source: 'github', id: 'alice' },
    human: true,
    at: AT,
    text: 'please fix this',
    meta: {}
  }
  const candidate: Candidate = {
    evalId: 'eval-1',
    thread: {
      key: 'github:acme/widgets#42',
      ref: { source: 'github', id: 'acme/widgets#42' },
      createdAt: AT,
      subscriptions: [],
      correlated: [],
      pending: [],
      meta: {}
    },
    triggers: [trigger],
    strength: 'inferred',
    policyVersion: 'v1',
    tickets: []
  }
  return { ticket, trigger, candidate }
}

function commandRouterTools() {
  const { ticket, candidate } = commandFixture()
  const decision: Decision = {
    id: 'decision-1',
    evalId: 'eval-1',
    threadKey: 'github:acme/widgets#42',
    triggerIds: ['trigger-1'],
    policyVersion: 'v1',
    at: AT,
    kind: 'ignore',
    reason: [{ code: 'noRuleMatched' }],
    strength: 'inferred'
  }
  return createRouterTools({
    candidate: (triggerId) => (triggerId === 'trigger-1' ? candidate : undefined),
    policy: () => ({ acceptMode: 'observe', rules: [] }),
    policyVersion: () => 'v1',
    decide: () => decision,
    attach: () => ticket,
    ticketOf: (id) => (id === ticket.id ? ticket : undefined)
  })
}

/**
 * 真领域 handler 的接线：report/reply/ack 的写入口换成记录用的替身（它们各自有专门测试）。
 * Prompt 配置的 handler 用**服务器自己打开的库**（版本表与 KV 都在里面），于是 `prompts save`
 * 在这里是一次真的写、`prompts get` 读得到它。
 */
function commandRoutes(
  store: Store,
  counters: { readonly calls: { reevaluated: number } } = { calls: { reevaluated: 0 } }
): readonly RouteDefinition[] {
  const ticket = ticketForCommands()
  const { trigger, candidate } = commandFixture()
  const evalTools = createEvalTools({
    candidate: (triggerId) => (triggerId === trigger.id ? candidate : undefined),
    trigger: (triggerId) => (triggerId === trigger.id ? trigger : undefined),
    // 语境：这条 Thread 只有 Trigger 自己那条消息（图片能力缺席）。
    threadContext: () => ({
      messageId: trigger.id,
      read: async () => ({
        messages: [{ id: trigger.id, from: trigger.actor.id, at: trigger.at, text: trigger.text }],
        body: {}
      }),
      images: () => [],
      image: async () => {
        throw new Error('This Source has no images')
      }
    }),
    commands: new FakeCommands(),
    admission: () => ({ maxPages: 1, timeoutMs: 1_000 }),
    roots: () => []
  })
  // Source 资源读面（#57）：`gh` 经 `FakeCommands`，资源名整段落在 `read/:resource` 上。
  const readCommands = new FakeCommands()
  readCommands.script(['api', 'repos/acme/widgets/issues/12'], () =>
    JSON.stringify({
      number: 12,
      title: 'Login redirect loops',
      state: 'open',
      body: 'Signing in bounces back to /login.',
      html_url: 'https://github.com/acme/widgets/issues/12',
      created_at: AT,
      updated_at: AT,
      user: { login: 'alice', type: 'User' }
    })
  )
  const readTools = createReadTools({
    commands: readCommands,
    sourceConfig: (kind) => (kind === 'github' ? { repository: 'acme/widgets', cli: 'gh' } : undefined),
    trigger: () => undefined,
    tickets: () => [ticket]
  })
  const keys = (key: string): Thread | undefined => {
    if (!key.startsWith('github:')) return undefined
    const ref = { source: 'github', id: key.slice('github:'.length) }
    const base = { key, ref, createdAt: AT, correlated: [], pending: [], meta: {} }
    // #42 是 Ticket 自己的来源 Thread；#44 attach 过（决定了消息）；其余只是存在的 Thread。
    if (key === 'github:acme/widgets#42' || key === 'github:acme/widgets#44') {
      return { ...base, subscriptions: [ticket.id] }
    }
    if (key === 'github:none') return undefined
    return { ...base, subscriptions: [] }
  }
  const domain = createDomainHandlers({
    report: () => ticket,
    reply: () => ({ id: 'reply-1', status: 'pending', reused: false }),
    note: () => ticket,
    requestStatus: () => true,
    handback: (ticketId, triggerId) => {
      // 到达过这张 Ticket 的消息可以交回；其余的给核心的固定拒绝（`not_owned`）。
      if (triggerId !== 'trigger-1') throw new UserError('notReached')
      return ticketId === ticket.id
    },
    // 停止与重试的可用性由领域判定：这里只替身「能不能」与「是否已结束」两个事实。
    stop: () => ticket,
    retry: (ticketId) => {
      if (ticketId === ticket.id) return ticket
      if (ticketId === 'ticket-ended') throw new UserError('notRetryable')
      throw new UserError('unknownTicket')
    },
    // 本票的四条领域命令：语义在 `route.test.ts`/`core-engine.test.ts`，这里替身边界事实。
    reevaluate: (triggerId) => {
      if (triggerId !== 'trigger-2') return false
      counters.calls.reevaluated += 1
      return true
    },
    unsubscribe: (thread) => thread === 'github:acme/widgets#43',
    markUnrelated: (_ticketId, thread) => {
      if (thread === 'github:acme/widgets#44') return 1
      throw new UserError('notFollowing')
    },
    followForContext: (_ticketId, ref) => ref.id !== 'acme/widgets#42',
    // 与组合根同一份幂等口（`runWrite` 落在本服务器自己的库上）。
    idempotent: (input, work) =>
      runWrite(
        { store, token: input.token, requestId: input.requestId ?? null, at: input.at },
        work
      ),
    threadOf: (key) => keys(key),
    triggerOf: (id) =>
      id === trigger.id ? trigger : id === 'trigger-2' ? { ...trigger, id: 'trigger-2' } : undefined,
    // `trigger-1` 仍归这张 Ticket 的 worker；`trigger-2` 谁都不拥有。
    owners: (found) => (found.id === 'trigger-1' ? [ticket.id] : []),
    ticketOf: (id) =>
      id === ticket.id
        ? ticket
        : id === 'ticket-ended'
          ? { ...ticket, ended: { at: AT, by: 'human', outcome: 'stopped' } }
          : undefined,
    tickets: () => [ticket]
  })
  const settingsHandlers = createSettingsHandlers({
    settings: createSettings({
      store,
      now: () => AT,
      // `policy` 块的版本与影响面：这里只关心命令面的形状。
      policy: { version: () => 'v1', effects: () => new Map(), apply: () => undefined }
    }),
    validate: (name) =>
      name === 'eval' ? (value: unknown) => EVAL_BLOCK_SCHEMA.safeParse(value) : undefined,
    blocks: () => ['policy', 'eval', 'executor'],
    effective: (name) => (name === 'executor' ? { maxWorkers: 2 } : {}),
    // 名单同步驱动器的替身：一次读回两条名单（新增 `bob`）。
    idempotent: (input, work) =>
      runWrite(
        { store, token: input.token, requestId: input.requestId ?? null, at: input.at },
        work
      ),
    policySync: {
      syncable: () => ['github'],
      sync: async () => ({ allowed: [{ id: 'alice' }, { id: 'bob' }] }),
      allowed: () => [{ id: 'alice' }],
      policy: () => ({ revision: 1, version: 'v1' })
    }
  })
  return withSettingsHandlers(
    withPromptHandlers(
      withReadHandlers(
        withEvalHandlers(
        withAssessmentHandlers(
          withDomainHandlers(ROUTE_TABLE, domain),
          createAssessmentHandlers({ tools: commandRouterTools() })
        ),
          createEvalHandlers({ tools: evalTools })
        ),
        createReadHandlers({ tools: readTools })
      ),
      createPromptHandlers({
        versions: createPromptVersions({ store, now: () => AT }),
        deployment: {
          environment: () => ({
            variables: ['SUPERAGENT_CLI', 'SUPERAGENT_TOKEN_FILE'],
            cliPath: '/opt/superagent/src/bin/superagent.mjs',
            tokenFile: '/tmp/state/tokens/router',
            stateDir: '/tmp/state',
            repository: 'acme/widgets'
          }),
          policy: () => ({ version: 'v1', mode: 'observe', rules: [] })
        }
      })
    ),
    settingsHandlers
  )
}

/** 跑一次用例：真服务器、真 token、真 HTTP；`offline` 的用例断言零请求。 */
async function runCase(server: TestServer, entry: Case): Promise<{ readonly exit: number; readonly envelope: unknown }> {
  const before = server.requests.length
  const token =
    entry.token === null
      ? null
      : entry.token === 'router'
        ? server.routerToken()
        : entry.token === 'assignment'
          ? server.assignmentToken('ticket-own', 'assignment-1')
          : server.readOperatorToken()
  const result = await dispatch({
    parsed: parseArgs(entry.argv),
    target: server.target(token),
    sleep: async () => undefined,
    ...(entry.stdin === undefined ? {} : { stdin: async () => entry.stdin as string })
  })
  if (entry.offline === true) {
    assert.equal(server.requests.length, before, `${entry.argv.join(' ')} refuses before the wire`)
  }
  return { exit: result.exit, envelope: result.envelope }
}

/** 断言失败信封的固定码与退出码。 */
function assertFailure(envelope: unknown, code: string): void {
  assert.equal(typeof envelope, 'object')
  const failure = envelope as { readonly ok?: unknown; readonly error?: { readonly code?: unknown } }
  assert.equal(failure.ok, false, 'a refusal envelope')
  assert.equal(failure.error?.code, code, 'the fixed error code')
}

test('the contract table covers every command in the dispatch table', () => {
  const covered = new Set<string>(WIRED.map(([name]) => name))
  const missing = CLI_COMMANDS.map((command) => command.name.join(' ')).filter((name) => !covered.has(name))
  assert.deepEqual(missing, [], 'every command has at least one contract case')
})

test('no command is left as a fixed unavailable', () => {
  // 命令面收尾（#56）：表里的每一条都已接线；`available:false` 的清单必须为空，而不是留着
  // 「这台构建还没有它」的旧行。
  assert.deepEqual(
    CLI_COMMANDS.filter((command) => !command.available).map((command) => command.name.join(' ')),
    []
  )
  // `commandFor` 仍按最长前缀解析（`thread unrelated` 不会落到 `thread`）。
  assert.equal(commandFor(['thread', 'unrelated', 'k'])?.name.join(' '), 'thread unrelated')
})

test('every command that is wired has a success case and a fixed refusal', async () => {
  const server = await startTestServer({
    // 本文件不测 doctor 的外部探针：注入一个「什么都装好了」的 runner 与假端口探测。
    ops: {
      run: async () => '{"identities":{"bot":{"status":"ready"}}}',
      cliPath: process.execPath,
      now: () => '2026-11-07T03:26:00.000Z',
      portOpen: async () => true
    },
    routes: commandRoutes
  })
  try {
    for (const [name, success, refusal] of WIRED) {
      const ok = await runCase(server, { ...success, token: success.token ?? 'operator' })
      assert.equal(ok.exit, success.exit, `${name}: success exit`)
      const envelope = ok.envelope as {
        readonly ok?: unknown
        readonly result?: Record<string, unknown>
        readonly error?: { readonly code?: unknown }
      }
      if (success.code !== undefined) {
        // 「已接线但仍是明说的 stub」的命令：成功面是那条固定拒绝，不是 200。
        assertFailure(envelope, success.code)
      } else {
        assert.equal(envelope.ok, true, `${name}: success envelope`)
        for (const key of success.resultKeys ?? []) {
          assert.ok(envelope.result !== undefined && key in envelope.result, `${name}: result.${key}`)
        }
      }

      const refused = await runCase(server, refusal)
      assert.equal(refused.exit, refusal.exit, `${name}: refusal exit`)
      assertFailure(refused.envelope, refusal.code ?? 'invalid_params')
    }
  } finally {
    server.close()
  }
})

test('route accepts its decisions from stdin too, not only repeated --item', async () => {
  const server = await startTestServer({ routes: commandRoutes })
  try {
    const decisions = JSON.stringify([
      { kind: 'ignore', trigger_id: 'trigger-1', reason: 'chatter' }
    ])
    const { exit, envelope } = await runCase(server, {
      argv: ['route', '--decisions', '-'],
      exit: 0,
      token: 'router',
      stdin: decisions
    })
    assert.equal(exit, 0, JSON.stringify(envelope))
    const view = envelope as { readonly ok?: unknown; readonly result?: { readonly results?: readonly unknown[] } }
    assert.equal(view.ok, true)
    assert.equal(view.result?.results?.length, 1, 'the batch from stdin ran')
  } finally {
    server.close()
  }
})

test('a command with a bad argument refuses before the fixed unavailable of a pending command', async () => {
  const server = await startTestServer()
  try {
    // 参数形状先于「有没有实现」判定：`ticket stop` 缺少 ticket id 是 invalid_params（退出 2），
    // 不是 unavailable（退出 3）。于是后票接上实现时，参数表的语义不会变。
    const missing = await runCase(server, { argv: ['ticket', 'stop'], exit: 2, code: 'invalid_params', offline: true })
    assertFailure(missing.envelope, 'invalid_params')

    // 枚举值也不合法：`--purpose` 只有三种取值。
    const choice = await runCase(server, {
      argv: ['reply', '--purpose', 'nope'],
      exit: 2,
      code: 'invalid_value',
      offline: true
    })
    assertFailure(choice.envelope, 'invalid_value')
  } finally {
    server.close()
  }
})

test('an unknown command is invalid_params and names no argv element', async () => {
  const server = await startTestServer()
  try {
    const result = await runCase(server, { argv: ['nonsense', '--text'], exit: 2, code: 'invalid_params', offline: true })
    assertFailure(result.envelope, 'invalid_params')
    const text = JSON.stringify(result.envelope)
    assert.equal(text.includes('nonsense'), false, 'the unknown word is not echoed back')
  } finally {
    server.close()
  }
})

test('a missing token is a fixed refusal: unauthorized is not "not ready"', async () => {
  const server = await startTestServer()
  try {
    // §G.1：401 是「有值的固定码」→ 退出 2。它与「worker 没起来」（not_ready，退出 3）必须
    // 分得开：前者要人去配 token，后者只是没启动。
    const result = await runCase(server, { argv: ['status'], exit: 2, code: 'unauthorized', token: null })
    assertFailure(result.envelope, 'unauthorized')
    assert.equal(result.exit, 2, 'HTTP 401 is a refusal (exit 2)')

    // 而「连不上」是 not_ready（退出 3）：同一台机器上换一个没人听的端口。
    const gone = await dispatch({
      parsed: parseArgs(['status']),
      target: { ...server.target(), port: 1, baseUrl: 'http://127.0.0.1:1/superagent/api' },
      sleep: async () => undefined
    })
    assert.equal(gone.exit, 3)
    assertFailure(gone.envelope, 'not_ready')
  } finally {
    server.close()
  }
})

test('a request id makes a retried write return the first result, and only once', async () => {
  const server = await startTestServer()
  try {
    // `admin backup` 每次都会真的落一个文件：用「返回的备份路径」数「执行了几次」，
    // 比看时间戳更直接（保留策略会删旧文件，所以不能数目录）。
    const first = await dispatch({
      parsed: parseArgs(['admin', 'backup', '--request-id', 'req-backup-1']),
      target: server.target()
    })
    assert.equal(first.exit, 0, JSON.stringify(first.envelope))
    const firstResult = (first.envelope as { result?: Record<string, unknown> }).result
    assert.equal(typeof firstResult?.['path'], 'string', 'the first call returned a backup path')

    // 同 id 重试（§G.1 幂等行）：返回首次结果，不再写第二个文件。
    const retry = await dispatch({
      parsed: parseArgs(['admin', 'backup', '--request-id', 'req-backup-1']),
      target: server.target()
    })
    assert.equal(retry.exit, 0)
    assert.deepEqual((retry.envelope as { result?: unknown }).result, firstResult, 'the first result is replayed')

    // 换一个 id 就是一次新的写：新的备份路径（保留策略只留最近五份，所以只比路径）。
    const fresh = await dispatch({
      parsed: parseArgs(['admin', 'backup', '--request-id', 'req-backup-2']),
      target: server.target()
    })
    assert.equal(fresh.exit, 0)
    assert.notEqual((fresh.envelope as { result?: Record<string, unknown> }).result?.['path'], firstResult?.['path'])
  } finally {
    server.close()
  }
})

test('read applies the documented page defaults and caps before it goes to the wire', async () => {
  const server = await startTestServer()
  try {
    // §G.2 的 read 行：默认 20、上限 50。上限在客户端就判（`invalid_value`，退出 2），
    // 不发一次注定被拒的请求。
    const { readQuery, readPath } = await import('../src/worker/cli/commands')
    const args = (flags: Record<string, string>) => ({ positionals: [], flags, repeated: {}, text: false })
    assert.deepEqual(readQuery('threads', args({})), { limit: 20 })
    assert.deepEqual(readQuery('threads', args({ limit: '5', offset: '10' })), { limit: 5, offset: 10 })
    assert.deepEqual(readQuery('models', args({})), {}, 'non-paged resources get no limit')
    const badFlags: readonly Record<string, string>[] = [{ limit: '0' }, { limit: '51' }, { offset: '-1' }, { limit: 'x' }]
    for (const bad of badFlags) {
      let caught: unknown = null
      try {
        readQuery('threads', args(bad))
      } catch (error) {
        caught = error
      }
      assert.ok(caught instanceof ApiError, JSON.stringify(bad))
      if (caught instanceof ApiError) assert.equal(caught.code, 'invalid_value')
    }

    // 路径：单个参数进路径、带 `/` 与空格的键被转义成一段。
    assert.equal(readPath('tickets', undefined), 'tickets')
    assert.equal(readPath('ticket', 't-1'), 'tickets/t-1')
    assert.equal(readPath('thread', 'gh:o/r #1'), 'threads/gh%3Ao%2Fr%20%231')
    // Source 的资源名是一整段（`/` 不改变分段），服务端整段解码。
    assert.equal(readPath('github/issues/12', undefined), 'read/github%2Fissues%2F12')
    assert.equal(readPath('feishu/om_1/thread', undefined), 'read/feishu%2Fom_1%2Fthread')
    let missing: unknown = null
    try {
      readPath('nope', undefined)
    } catch (error) {
      missing = error
    }
    assert.ok(missing instanceof ApiError)
    if (missing instanceof ApiError) assert.equal(missing.code, 'unknown_resource')
    // 文本页的 `--limit` 是字符数：CLI 只判较宽的界（8000），形状的上限由服务端判。
    assert.deepEqual(readQuery('github/issues/12', args({ limit: '8000', offset: '4000' })), {
      limit: 8000,
      offset: 4000
    })
    assert.deepEqual(readQuery('github/issues/12/comments/1', args({ limit: '51' })), { limit: 51 })
    assert.deepEqual(readQuery('github/issues/12', args({})), {}, 'a Source read has no client-side default')
    let tooWide: unknown = null
    try {
      readQuery('github/issues/12', args({ limit: '8001' }))
    } catch (error) {
      tooWide = error
    }
    assert.ok(tooWide instanceof ApiError)
    if (tooWide instanceof ApiError) assert.equal(tooWide.code, 'invalid_value')

    // 端到端：`read threads --limit 1` 打到未落地的视图路由 → 503 unavailable（退出 3）。
    const result = await dispatch({
      parsed: parseArgs(['read', 'threads', '--limit', '1']),
      target: server.target()
    })
    assert.equal(result.exit, 3)
    assert.equal((result.envelope as { error: { code: string } }).error.code, 'unavailable')
    assert.equal(server.requests.length, 1, 'one request, to the real route')
  } finally {
    server.close()
  }
})

test('read routes github/… and feishu/… through one handler, with the role matrix and paging', async () => {
  const server = await startTestServer({ routes: commandRoutes })
  try {
    // 成功面：operator 读一条 Issue（真 HTTP、假 `gh`）。
    const ok = await runCase(server, { argv: ['read', 'github/issues/12'], exit: 0 })
    const view = (ok.envelope as { readonly result?: Record<string, unknown> }).result
    assert.equal(view?.['status'], 'available')
    assert.equal(view?.['resource'], 'github/issues/12')
    assert.equal((view?.['items'] as readonly unknown[]).length, 1)
    // 分页参数真的到了 wire（查询串），并且 handler 认它们。
    const paged = await runCase(server, {
      argv: ['read', 'github/issues/12', '--offset', '0', '--limit', '4000'],
      exit: 0
    })
    assert.equal((paged.envelope as { readonly result?: Record<string, unknown> }).result?.['next_offset'], null)
    // 文本页的 `--limit` 上限是 8000：8001 在客户端就拒（`invalid_value`，退出 2，不发请求）。
    const tooWide = await runCase(server, {
      argv: ['read', 'github/issues/12', '--limit', '8001'],
      exit: 2,
      code: 'invalid_value',
      offline: true
    })
    assertFailure(tooWide.envelope, 'invalid_value')
    // 角色矩阵：assignment token 读不到不属于自己 Ticket 的资源（`refused` 是固定拒绝）。
    const refused = await runCase(server, {
      argv: ['read', 'github/issues/12'],
      exit: 2,
      code: 'refused',
      token: 'assignment'
    })
    assertFailure(refused.envelope, 'refused')
    // 未知的 Source 资源名：CLI 把它原样交给 `read/:resource`（写法只有一处定义），
    // 由 handler 回 `unknown_resource`——`/` 不改变分段。
    const unknown = await runCase(server, {
      argv: ['read', 'github/labels/12'],
      exit: 2,
      code: 'unknown_resource',
      token: 'router'
    })
    assertFailure(unknown.envelope, 'unknown_resource')
  } finally {
    server.close()
  }
})

test('stdout and stderr never carry the token, and the error line carries the fixed code', async () => {
  const server = await startTestServer()
  const dir = tempStateDir()
  try {
    const out: string[] = []
    const err: string[] = []
    const result = await main({
      argv: ['admin', 'rotate-token'],
      io: { out: (line) => out.push(line), err: (line) => err.push(line) },
      target: server.target()
    })
    assert.equal(result.exit, 2)
    const everything = [...out, ...err].join('\n')
    assert.equal(everything.includes(server.operatorToken), false, 'the token never reaches the output')
    assert.equal(everything.includes('Bearer'), false, 'no auth header leaks')
    assert.ok(err.join('\n').includes('refused'), 'the stderr line carries the code')
    // stdout 仍是 JSON 信封：脚本读它，人读 stderr 那一行。
    assert.equal(JSON.parse(out.join('\n')).error.code, 'refused')
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--text as a command value keeps the JSON envelope (it is not the output switch)', async () => {
  const server = await startTestServer({ routes: commandRoutes })
  try {
    const out: string[] = []
    const result = await main({
      argv: ['reply', '--purpose', 'attention', '--text', 'Need a decision', '--human-action', 'Which branch?'],
      io: { out: (line) => out.push(line), err: () => undefined },
      target: server.target()
    })
    assert.equal(result.exit, 0)
    const printed = JSON.parse(out.join('\n')) as { readonly ok?: unknown }
    assert.equal(printed.ok, true, 'worker scripts parse the JSON envelope, not a human line')
  } finally {
    server.close()
  }
})

test('--text prints a human line for a refusal and still carries the code', async () => {
  const server = await startTestServer()
  try {
    const out: string[] = []
    const err: string[] = []
    const result = await main({
      argv: ['admin', 'rotate-token', '--text'],
      io: { out: (line) => out.push(line), err: (line) => err.push(line) },
      target: server.target()
    })
    assert.equal(result.exit, 2)
    assert.equal(out.join('\n'), 'error: refused: rotate-token replaces the operator token; pass --yes to confirm (reason=confirmation_required)')
  } finally {
    server.close()
  }
})

test('a request id replays the first result of a closeout write', async () => {
  const counters = { calls: { reevaluated: 0 } }
  const server = await startTestServer({ routes: (store) => commandRoutes(store, counters) })
  try {
    const run = (): Promise<{ readonly exit: number; readonly envelope: unknown }> =>
      dispatch({
        parsed: parseArgs(['trigger', 'requeue', 'trigger-2', '--request-id=req-requeue-1']),
        target: server.target(),
        sleep: async () => undefined
      })
    const first = await run()
    assert.equal(first.exit, 0, JSON.stringify(first.envelope))
    const replay = await run()
    assert.equal(replay.exit, 0)
    // 同 id 一小时内重试：先返回首次结果，且领域写入只发生一次（§G.1 幂等行）。
    assert.deepEqual(replay.envelope, first.envelope)
    assert.equal(counters.calls.reevaluated, 1, 'the write ran exactly once')
  } finally {
    server.close()
  }
})

// Router 的两条评估读命令（§G.2 的 `eval` / `eval-read` 行、§I.1 的 `threadContext`、§O 的路径行）：
// `app/eval.ts` 把它们做成 HTTP 与 CLI 共用的一份实现。
//
// 断言面：候选窗口的七个字段与截断规则、`eval-read` 四种形式各自的结果形状、按 id 读整条消息、
// 游标只在本次评估里成立、`--path` 的 realpath containment（含符号链接逃逸）、四种固定拒绝码
// （`not_a_candidate` / `missing` / `too_large` / `refused`）。接缝是 `createEvalTools()` 的端口，
// 底下是**真 Engine + 内存仓储**（§P.1：只换外部世界）。
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Engine, MemoryRepositories } from '../src/worker/core/index.ts'
import type { Candidate, Policy, Trigger } from '../src/worker/core/index.ts'
import { createEvalTools, evalTicketLines, type EvalTicketInput } from '../src/worker/app/eval.ts'
import type { EvalTools } from '../src/worker/app/eval.ts'
import { readRepoPath, REPO_READ_MAX_BYTES, RepoReadError } from '../src/worker/app/repo-read.ts'
import type {
  AdmissionSettings,
  ContextMessage,
  ContextPart,
  TriggerContext
} from '../src/worker/sources/admission-context.ts'
import { FakeCommands } from './support/fake-commands.ts'
import { createEvalHandlers, withEvalHandlers } from '../src/worker/http/eval.ts'
import { ROUTE_TABLE, stub } from '../src/worker/http/routes.ts'
import { dispatch } from '../src/worker/cli/commands.ts'
import { parseArgs } from '../src/worker/cli/io.ts'
import { startTestServer, type TestServer } from './support/cli-server.ts'

/** 固定的测试时刻。 */
const AT = '2026-11-07T00:00:00.000Z'

/** 这条 Trigger 自己的正文（`eval` 窗口的第一条）。 */
const TRIGGER_TEXT = 'please look at img_abc and fix it'

/** 一条测试 Trigger（`guest` 是推断候选，`alice` 是显式请求）。 */
function trigger(id: string, overrides: Partial<Trigger> = {}): Trigger {
  return {
    id,
    source: 'chat',
    threads: [{ source: 'chat', id: 't1' }],
    actor: { source: 'chat', id: 'guest' },
    human: true,
    at: AT,
    text: `message ${id}`,
    channel: { source: 'chat', thread: 't1', address: { message: id } },
    meta: {},
    ...overrides
  }
}

/** 真引擎 + 内存仓储；`requests` 记每次评估的候选。 */
function harness(): {
  engine: Engine
  repo: ReturnType<MemoryRepositories['claimWriter']>
  requests: Candidate[]
} {
  const repo = new MemoryRepositories().claimWriter()
  const requests: Candidate[] = []
  const policy: Policy = {
    version: 'policy-1',
    paused: false,
    evalTimeoutMs: 60_000,
    gate: (t) =>
      t.actor.id === 'alice'
        ? { admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'mention' } }
        : { admissible: true, strength: 'inferred', basis: { via: 'followup' } },
    revalidate: () => true,
    admitsInferred: (matched) => matched.length > 0
  }
  const engine = new Engine({
    repo,
    scope: { scope: () => ({ listened: true, observed: false }) },
    policy: () => policy,
    assessor: {
      request: (candidate: Candidate) => {
        requests.push(candidate)
      }
    },
    executor: { start: () => undefined, deliver: () => undefined, stop: () => undefined },
    outbox: {
      send: () => undefined,
      status: () => undefined,
      withdraw: () => undefined,
      withdrawTicket: () => undefined
    },
    now: () => AT
  })
  return { engine, repo, requests }
}

/** 收一批 Trigger 并推进一次 Eval（返回那次评估的候选）。 */
function evaluate(h: ReturnType<typeof harness>, triggers: readonly Trigger[]): Candidate {
  for (const item of triggers) h.engine.receive(item)
  h.engine.evaluateDue()
  const candidate = h.requests.at(-1)
  assert.notEqual(candidate, undefined, 'the triggers reached an evaluation')
  return candidate as Candidate
}

/** 一条评估语境里的消息。 */
function message(index: number, text = `Message ${index}`): ContextMessage {
  return {
    id: `m${index}`,
    from: 'guest',
    at: `2026-11-07T00:00:${String(index).padStart(2, '0')}.000Z`,
    text
  }
}

/** 一页对话（按游标脚本化）。 */
type Pages = Readonly<Record<string, ContextPart>>

/** 一个脚本化的 `TriggerContext`：记录每次读的参数与次数。 */
function fakeContext(
  options: {
    readonly pages?: Pages
    readonly root?: ContextPart
    readonly parent?: ContextPart
    readonly image?: (imageId: string) => { path: string; alt: string }
    readonly images?: (text: string) => readonly string[]
    readonly fail?: string
  } = {}
): {
  context: TriggerContext
  reads: { part: string; cursor: string | undefined }[]
  imagesRead: { imageId: string }[]
} {
  const reads: { part: string; cursor: string | undefined }[] = []
  const imagesRead: { imageId: string }[] = []
  const page = (part: string, cursor: string | undefined): ContextPart => {
    if (part === 'thread') {
      const found = options.pages?.[cursor ?? 'first']
      if (found === undefined) throw new Error(`no thread page scripted for ${cursor ?? '(first)'}`)
      return found
    }
    const found = part === 'root' ? options.root : options.parent
    if (found === undefined) throw new Error(`no ${part} page scripted`)
    return found
  }
  return {
    reads,
    imagesRead,
    context: {
      messageId: 'm6',
      async read(_host, part, cursor) {
        reads.push({ part, cursor })
        if (options.fail !== undefined) throw new Error(options.fail)
        return page(part, cursor)
      },
      images: options.images ?? (() => []),
      image: async (_host, imageId) => {
        imagesRead.push({ imageId })
        if (options.image === undefined) throw new Error('This Source has no images')
        return options.image(imageId)
      }
    }
  }
}

/** 默认的语境：两页对话 + 两个锚点 + 一条图片 key。 */
function pagedContext(): ReturnType<typeof fakeContext> {
  return fakeContext({
    pages: {
      first: {
        messages: [1, 2, 3, 4, 5].map((index) => message(index)).concat([
          message(6, TRIGGER_TEXT),
          ...[7, 8, 9, 10].map((index) => message(index))
        ]),
        next: 'p2',
        body: {}
      },
      p2: { messages: [message(11), message(12)], next: 'p3', status: 'chat_neighbours', body: {} }
    },
    root: { messages: [message(6, TRIGGER_TEXT)], body: {} },
    parent: { messages: [message(4), message(6, TRIGGER_TEXT)], body: {} },
    images: (text) => (text.includes('img_abc') ? ['img_abc'] : []),
    image: (imageId) => ({
      path: `/state/inbox/images/${imageId.replace('/', '-')}.png`,
      alt: 'a screenshot'
    })
  })
}

// 页数来自部署设置（§H.22）：一次评估只读 1 页，于是窗口的 `next` 是真的有下一页。
const SETTINGS: AdmissionSettings = { maxPages: 1, timeoutMs: 5_000 }

/** 命令与读取工具的接线（`roots` 由用例给）。 */
function toolsFor(
  h: ReturnType<typeof harness>,
  context: TriggerContext | undefined,
  roots: readonly string[] = []
): EvalTools {
  return createEvalTools({
    candidate: (id) => h.engine.candidate(id),
    trigger: (id) => h.repo.triggers.get(id),
    threadContext: () => context,
    commands: new FakeCommands(),
    admission: () => SETTINGS,
    roots: () => roots
  })
}

/** 一个临时目录，测试结束删除。 */
function tempDir(prefix: string): { path: string; clean: () => void } {
  const path = mkdtempSync(join(tmpdir(), `${prefix}-`))
  return { path, clean: () => rmSync(path, { recursive: true, force: true }) }
}

/** 一条活的推断候选：一条 Trigger 已经开过 Ticket（relatedTickets 的来源），另一批在评估。 */
function liveCandidate(): {
  h: ReturnType<typeof harness>
  tools: (context: TriggerContext | undefined, roots?: readonly string[]) => EvalTools
} {
  const h = harness()
  evaluate(h, [trigger('t0', { at: '2026-11-06T23:00:00.000Z' })])
  h.engine.decide('t0', {
    kind: 'accept',
    title: 'Earlier work',
    scope: 'one file',
    reason: 'asked',
    rules: ['copy']
  })
  // 结束那张 Ticket（人的停止）：它仍是这条 Thread 上的相关 Ticket，但不再接收后续消息，
  // 于是下一批 Trigger 真的进入新的 Eval（§K.2 第 3 条、§K.3）。
  const [earlier] = h.repo.tickets.list()
  h.engine.stopTicket(earlier!.id, 'no longer needed')
  evaluate(h, [
    trigger('t1', { at: AT, text: TRIGGER_TEXT }),
    trigger('t2', { at: '2026-11-07T00:00:01.000Z', text: 'and the header too' })
  ])
  return { h, tools: (context, roots = []) => toolsFor(h, context, roots) }
}

describe('eval: the candidate window', () => {
  test('has the seven documented fields and the batch around the trigger', async () => {
    const { tools } = liveCandidate()
    const result = await tools(pagedContext().context).window('t1')
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok) return
    const window = result.window
    assert.deepEqual(Object.keys(window).sort(), [
      'batch',
      'policyVersion',
      'relatedTickets',
      'stubs',
      'threadWindow',
      'ticketsTotal',
      'trigger'
    ])
    assert.equal(window.policyVersion, 'policy-1')
    assert.deepEqual(window.trigger, {
      triggerId: 't1',
      source: 'chat',
      actor: 'guest',
      human: true,
      at: AT,
      thread: 'chat:t1',
      strength: 'inferred',
      text: TRIGGER_TEXT,
      chars: TRIGGER_TEXT.length,
      images: ['m6/img_abc']
    })
    assert.deepEqual(
      window.batch.map((line) => line.triggerId),
      ['t2']
    )
    assert.equal(window.batch[0]?.text, 'and the header too')
    assert.equal(window.ticketsTotal, 1)
    assert.deepEqual(
      window.relatedTickets.map((ticket) => ({ title: ticket.title, state: ticket.state })),
      [{ title: 'Earlier work', state: 'stopped' }]
    )
  })

  test('the window is the first five messages plus five on either side, each cut with its length', async () => {
    const { tools } = liveCandidate()
    const long = 'x'.repeat(1300)
    const context = fakeContext({
      pages: {
        first: {
          messages: [
            ...[1, 2, 3, 4, 5].map((index) => message(index, 'y'.repeat(600))),
            message(6, 'the trigger itself'),
            message(7),
            message(8, long),
            message(9),
            message(10),
            message(11),
            message(12)
          ],
          body: {}
        }
      }
    })
    const result = await tools(context.context).window('t1')
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok) return
    const window = result.window.threadWindow
    assert.equal(window.complete, true)
    assert.equal(window.loadedMessages, 12)
    assert.equal(window.sourceFound, true)
    assert.deepEqual(
      window.messages.map((line) => line.id),
      ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11']
    )
    const byId = new Map(window.messages.map((line) => [line.id, line]))
    // 触发者自己的那条只标 `trigger`，正文不重复（它在 `trigger.text` 里）。
    assert.equal(byId.get('m6')?.trigger, true)
    assert.equal(byId.get('m6')?.text, undefined)
    // 前后各两条邻居放宽到 1200 字符，其余窗口消息 400；被截断的带全文长度。
    assert.equal(byId.get('m8')?.text?.length, 1201, 'a near neighbour keeps 1200 characters plus …')
    assert.equal(byId.get('m8')?.chars, 1300)
    assert.equal(byId.get('m4')?.text?.length, 600, 'a short near neighbour is not cut')
    assert.equal(byId.get('m4')?.chars, undefined)
    assert.equal(byId.get('m1')?.text?.length, 401, 'a far window message keeps 400 characters plus …')
    assert.equal(byId.get('m1')?.chars, 600)
    // 窗口之外、已加载的消息是 stub：只有一行预览。
    assert.deepEqual(result.window.stubs, [
      { id: 'm12', from: 'guest', at: '2026-11-07T00:00:12.000Z', chars: 10, preview: 'Message 12' }
    ])
    // 位置与前后略过条数保留，模型能看懂快照缺了什么。
    assert.equal(byId.get('m1')?.position, 1)
    assert.equal(byId.get('m1')?.omittedBefore, 0)
  })

  test('a Source without thread context still has a window, and says why it is empty', async () => {
    const { tools } = liveCandidate()
    const result = await tools(undefined).window('t1')
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok) return
    assert.deepEqual(result.window.stubs, [])
    assert.equal(result.window.threadWindow.complete, false)
    assert.equal(result.window.threadWindow.messages.length, 0)
    assert.equal(typeof result.window.threadWindow.error, 'string')
  })

  test('a context read failure is reported in the window, not as an internal error', async () => {
    const { tools } = liveCandidate()
    const result = await tools(fakeContext({ fail: 'gh api timed out' }).context).window('t1')
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok) return
    assert.equal(result.window.threadWindow.complete, false)
    assert.ok(result.window.threadWindow.error?.includes('Thread context unavailable'))
  })

  test('an unknown trigger is missing; a trigger without an eval is not_a_candidate', async () => {
    const { tools } = liveCandidate()
    const unknown = await tools(undefined).window('nope')
    assert.equal(unknown.ok, false)
    if (!unknown.ok) assert.equal(unknown.code, 'missing')

    const finished = await tools(undefined).window('t0')
    assert.equal(finished.ok, false)
    if (!finished.ok) {
      assert.equal(finished.code, 'not_a_candidate')
      assert.equal(finished.values?.['reason'], 'not_assessing')
    }
  })

  test('an explicit request is routed instead of assessed: not_a_candidate', async () => {
    const h = harness()
    evaluate(h, [trigger('explicit-1', { actor: { source: 'chat', id: 'alice' } })])
    const result = await toolsFor(h, pagedContext().context).window('explicit-1')
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, 'not_a_candidate')
      assert.equal(result.values?.['reason'], 'explicit')
    }
  })

  test('related tickets are open first, newest first, capped at eight', () => {
    const tickets: readonly EvalTicketInput[] = [
      { id: 'ticket-1', title: 'Ticket 1', createdAt: '2026-11-07T00:00:01.000Z', ended: { at: AT, by: 'human', outcome: 'merged' } },
      { id: 'ticket-2', title: 'Ticket 2', createdAt: '2026-11-07T00:00:02.000Z' },
      { id: 'ticket-3', title: 'Ticket 3', createdAt: '2026-11-07T00:00:03.000Z', ended: { at: AT, by: 'human', outcome: 'merged' } },
      ...[4, 5, 6, 7, 8, 9, 10].map((index) => ({
        id: `ticket-${index}`,
        title: `Ticket ${index}`,
        createdAt: `2026-11-07T00:00:${String(index).padStart(2, '0')}.000Z`
      }))
    ]
    const { relatedTickets, ticketsTotal } = evalTicketLines(tickets)
    assert.equal(ticketsTotal, 10)
    assert.equal(relatedTickets.length, 8)
    assert.deepEqual(relatedTickets.slice(0, 2).map((line) => line.ticketId), ['ticket-10', 'ticket-9'])
    assert.deepEqual(relatedTickets.at(-1), { ticketId: 'ticket-2', title: 'Ticket 2', state: 'open' })
  })
})

describe('eval-read: message, image, part and path', () => {
  test('a window message is read whole by its id, and the window is not loaded twice', async () => {
    const { tools } = liveCandidate()
    const context = pagedContext()
    const evalTools = tools(context.context)
    await evalTools.window('t1')
    const readsAfterWindow = context.reads.length
    const result = await evalTools.read('t1', { messageId: 'm8' })
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok) return
    assert.deepEqual(result.result.message, {
      id: 'm8',
      from: 'guest',
      at: '2026-11-07T00:00:08.000Z',
      text: 'Message 8'
    })
    assert.equal(context.reads.length, readsAfterWindow, 'the window is cached for this eval')
  })

  test('a stub is readable whole, and the trigger itself resolves to its message id', async () => {
    const { tools } = liveCandidate()
    const context = fakeContext({
      pages: {
        first: {
          messages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((index) => message(index)),
          body: {}
        }
      }
    })
    const evalTools = tools(context.context)
    await evalTools.window('t1')
    const stub = await evalTools.read('t1', { messageId: 'm12' })
    assert.equal(stub.ok, true, JSON.stringify(stub))
    if (stub.ok) assert.equal(stub.result.message?.text, 'Message 12')

    const own = await evalTools.read('t1', { messageId: 'm6' })
    assert.equal(own.ok, true, JSON.stringify(own))
    if (own.ok) assert.equal(own.result.message?.id, 'm6')
  })

  test('an unknown message id is missing, not an empty read', async () => {
    const { tools } = liveCandidate()
    const result = await tools(pagedContext().context).read('t1', { messageId: 'nope' })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, 'missing')
      assert.equal(result.values?.['reason'], 'unknown_message')
    }
  })

  test('images come back as a readable path plus a note', async () => {
    const { tools } = liveCandidate()
    const context = pagedContext()
    const result = await tools(context.context).read('t1', { imageId: 'm6/img_abc' })
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok) return
    assert.deepEqual(result.result.image, {
      path: '/state/inbox/images/m6-img_abc.png',
      alt: 'a screenshot'
    })
    assert.deepEqual(context.imagesRead, [{ imageId: 'm6/img_abc' }])
  })

  test('an image id the source message does not carry is missing', async () => {
    const { tools } = liveCandidate()
    const result = await tools(pagedContext().context).read('t1', { imageId: 'm6/img_other' })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, 'missing')
      assert.equal(result.values?.['reason'], 'unknown_image')
    }
  })

  test('a part reads one page, returns its next cursor, and only that cursor is accepted', async () => {
    const { tools } = liveCandidate()
    const context = pagedContext()
    const evalTools = tools(context.context)
    const first = await evalTools.window('t1')
    assert.equal(first.ok, true)
    if (!first.ok) return
    assert.equal(first.window.threadWindow.next, 'p2')

    const page = await evalTools.read('t1', { part: 'thread', cursor: 'p2' })
    assert.equal(page.ok, true, JSON.stringify(page))
    if (!page.ok) return
    assert.deepEqual(page.result.messages?.map((line) => line.id), ['m11', 'm12'])
    assert.equal(page.result.status, 'chat_neighbours')
    assert.equal(page.result.next, 'p3')

    // 读来的消息进缓存：整条读得出来。
    const later = await evalTools.read('t1', { messageId: 'm11' })
    assert.equal(later.ok, true, JSON.stringify(later))

    const unknown = await evalTools.read('t1', { part: 'thread', cursor: 'forged' })
    assert.equal(unknown.ok, false)
    if (!unknown.ok) {
      assert.equal(unknown.code, 'missing')
      assert.equal(unknown.values?.['reason'], 'unknown_cursor')
    }
  })

  test('root and parent read the two anchored parts, and thread pagination is the only cursor', async () => {
    const { tools } = liveCandidate()
    const context = pagedContext()
    const evalTools = tools(context.context)
    const root = await evalTools.read('t1', { part: 'root' })
    assert.equal(root.ok, true, JSON.stringify(root))
    if (root.ok) assert.deepEqual(root.result.messages?.map((line) => line.id), ['m6'])

    const parent = await evalTools.read('t1', { part: 'parent' })
    assert.equal(parent.ok, true, JSON.stringify(parent))

    const cursor = await evalTools.read('t1', { part: 'parent', cursor: 'p2' })
    assert.equal(cursor.ok, false)
    if (!cursor.ok) assert.equal(cursor.code, 'invalid_params')
  })

  test('a Source without thread context refuses parts and images as missing', async () => {
    const { tools } = liveCandidate()
    const evalTools = tools(undefined)
    const part = await evalTools.read('t1', { part: 'thread' })
    assert.equal(part.ok, false)
    if (!part.ok) assert.equal(part.code, 'missing')
    const image = await evalTools.read('t1', { imageId: 'm6/img_abc' })
    assert.equal(image.ok, false)
    if (!image.ok) assert.equal(image.code, 'missing')
  })

  test('the four forms are mutually exclusive: exactly one is required', async () => {
    const { tools } = liveCandidate()
    const context = pagedContext()
    const none = await tools(context.context).read('t1', {})
    assert.equal(none.ok, false)
    if (!none.ok) assert.equal(none.code, 'invalid_params')
    const two = await tools(context.context).read('t1', { messageId: 'm1', part: 'thread' })
    assert.equal(two.ok, false)
    if (!two.ok) assert.equal(two.code, 'invalid_params')
  })

  test('eval-read is only for candidates: explicit and finished are not_a_candidate', async () => {
    const { tools } = liveCandidate()
    const finished = await tools(undefined).read('t0', { messageId: 'm1' })
    assert.equal(finished.ok, false)
    if (!finished.ok) assert.equal(finished.code, 'not_a_candidate')

    const h = harness()
    evaluate(h, [trigger('explicit-1', { actor: { source: 'chat', id: 'alice' } })])
    const explicit = await toolsFor(h, pagedContext().context).read('explicit-1', { part: 'thread' })
    assert.equal(explicit.ok, false)
    if (!explicit.ok) assert.equal(explicit.code, 'not_a_candidate')
  })

  test('a Source read failure is unavailable, never a silently empty page', async () => {
    const { tools } = liveCandidate()
    const result = await tools(fakeContext({ fail: 'gh api timed out' }).context).read('t1', {
      part: 'thread'
    })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, 'unavailable')
      assert.equal(result.values?.['reason'], 'context_unavailable')
    }
  })
})

describe('eval-read --path: repository containment (§O)', () => {
  test('a relative path resolves inside the base repo and returns its text', async () => {
    const base = tempDir('superagent-base')
    const worktree = tempDir('superagent-wt')
    try {
      writeFileSync(join(base.path, 'README.md'), '# the repo\n')
      const { tools } = liveCandidate()
      const result = await tools(pagedContext().context, [base.path, worktree.path]).read('t1', {
        path: 'README.md'
      })
      assert.equal(result.ok, true, JSON.stringify(result))
      if (!result.ok) return
      assert.deepEqual(result.result.path, {
        root: realpathSync(base.path),
        path: 'README.md',
        kind: 'file',
        chars: 11,
        text: '# the repo\n'
      })
    } finally {
      base.clean()
      worktree.clean()
    }
  })

  test('a ticket worktree is a root too, and an absolute path there is allowed', async () => {
    const base = tempDir('superagent-base')
    const worktree = tempDir('superagent-wt')
    try {
      writeFileSync(join(base.path, 'README.md'), 'base\n')
      writeFileSync(join(worktree.path, 'notes.txt'), 'worktree note\n')
      const { tools } = liveCandidate()
      const result = await tools(pagedContext().context, [base.path, worktree.path]).read('t1', {
        path: join(worktree.path, 'notes.txt')
      })
      assert.equal(result.ok, true, JSON.stringify(result))
      if (result.ok) {
        assert.equal(result.result.path?.text, 'worktree note\n')
        assert.equal(result.result.path?.root, realpathSync(worktree.path))
      }
    } finally {
      base.clean()
      worktree.clean()
    }
  })

  test('a directory reads as a sorted listing without hidden entries', async () => {
    const base = tempDir('superagent-base')
    try {
      mkdirSync(join(base.path, 'src'), { recursive: true })
      writeFileSync(join(base.path, 'src', 'b.ts'), 'b')
      writeFileSync(join(base.path, 'src', 'a.ts'), 'a')
      writeFileSync(join(base.path, 'src', '.hidden'), 'x')
      mkdirSync(join(base.path, 'src', 'node_modules'), { recursive: true })
      const { tools } = liveCandidate()
      const result = await tools(pagedContext().context, [base.path]).read('t1', { path: 'src' })
      assert.equal(result.ok, true, JSON.stringify(result))
      if (!result.ok) return
      assert.equal(result.result.path?.kind, 'directory')
      assert.equal(result.result.path?.text, 'a.ts\nb.ts')
    } finally {
      base.clean()
    }
  })

  test('an escaped relative path, an outside absolute path and a symlink escape are refused', async () => {
    const outside = tempDir('superagent-outside')
    const base = tempDir('superagent-base')
    try {
      writeFileSync(join(outside.path, 'secret.txt'), 'secret')
      writeFileSync(join(base.path, 'README.md'), 'repo')
      symlinkSync(join(outside.path, 'secret.txt'), join(base.path, 'link.txt'))
      const { tools } = liveCandidate()
      const evalTools = tools(pagedContext().context, [base.path])
      for (const request of [
        { path: '../secret.txt' },
        { path: join(outside.path, 'secret.txt') },
        { path: 'link.txt' }
      ]) {
        const result = await evalTools.read('t1', request)
        assert.equal(result.ok, false, JSON.stringify(request))
        if (!result.ok) assert.equal(result.code, 'refused', JSON.stringify(request))
      }
    } finally {
      outside.clean()
      base.clean()
    }
  })

  test('hidden segments and node_modules are refused before any read', async () => {
    const base = tempDir('superagent-base')
    try {
      writeFileSync(join(base.path, '.env'), 'TOKEN=1')
      mkdirSync(join(base.path, 'node_modules'), { recursive: true })
      writeFileSync(join(base.path, 'node_modules', 'x.js'), 'x')
      const { tools } = liveCandidate()
      const evalTools = tools(pagedContext().context, [base.path])
      for (const path of ['.env', 'node_modules/x.js']) {
        const result = await evalTools.read('t1', { path })
        assert.equal(result.ok, false, path)
        if (!result.ok) {
          assert.equal(result.code, 'refused')
          assert.equal(result.values?.['reason'], 'hidden_path')
        }
      }
    } finally {
      base.clean()
    }
  })

  test('a missing path is missing and a file past the envelope limit is too_large', async () => {
    const base = tempDir('superagent-base')
    try {
      writeFileSync(join(base.path, 'big.txt'), 'x'.repeat(REPO_READ_MAX_BYTES + 10))
      const { tools } = liveCandidate()
      const evalTools = tools(pagedContext().context, [base.path])
      const missing = await evalTools.read('t1', { path: 'nope.txt' })
      assert.equal(missing.ok, false)
      if (!missing.ok) assert.equal(missing.code, 'missing')
      const large = await evalTools.read('t1', { path: 'big.txt' })
      assert.equal(large.ok, false)
      if (!large.ok) {
        assert.equal(large.code, 'too_large')
        assert.equal(large.values?.['limit'], String(REPO_READ_MAX_BYTES))
      }
    } finally {
      base.clean()
    }
  })

  test('without any configured root, any path is refused', async () => {
    const { tools } = liveCandidate()
    const result = await tools(pagedContext().context, []).read('t1', { path: 'README.md' })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, 'refused')
  })
})

describe('repo path reading is the one containment rule', () => {
  test('readRepoPath is pure input → output and throws the fixed codes', () => {
    const base = tempDir('superagent-base')
    try {
      writeFileSync(join(base.path, 'a.txt'), 'a')
      assert.equal(readRepoPath({ path: 'a.txt', roots: [base.path] }).text, 'a')
      assert.throws(
        () => readRepoPath({ path: '../a.txt', roots: [base.path] }),
        (error: unknown) => error instanceof RepoReadError && error.code === 'refused'
      )
      assert.throws(
        () => readRepoPath({ path: 'gone.txt', roots: [base.path] }),
        (error: unknown) => error instanceof RepoReadError && error.code === 'missing'
      )
    } finally {
      base.clean()
    }
  })
})

describe('the two routes are wired for router and operator only', () => {
  test('the route table carries their handlers by method and path', () => {
    const { tools } = liveCandidate()
    const routes = withEvalHandlers(
      ROUTE_TABLE,
      createEvalHandlers({ tools: tools(pagedContext().context) })
    )
    for (const [method, path] of [
      ['GET', 'eval/:id'],
      ['GET', 'eval-read/:id']
    ] as const) {
      const route = routes.find((entry) => entry.method === method && entry.path === path)
      assert.ok(route !== undefined, `${method} ${path} exists`)
      assert.notEqual(route.handler, stub, `${method} ${path} is wired`)
      assert.equal(route.minimumRole, 'router', `${method} ${path} is a Router command`)
      assert.equal(route.command, method === 'GET' && path === 'eval/:id' ? 'eval' : 'eval-read')
    }
  })

  test('CLI → HTTP → the same handler serves every read form, and assignment is refused', async () => {
    const base = tempDir('superagent-base')
    const server: TestServer = await startTestServer({
      routes: (() => {
        const { tools } = liveCandidate()
        return withEvalHandlers(
          ROUTE_TABLE,
          createEvalHandlers({ tools: tools(pagedContext().context, [base.path]) })
        )
      })()
    })
    const call = async (argv: readonly string[], token: string): Promise<{ exit: number; envelope: unknown }> =>
      dispatch({ parsed: parseArgs(argv), target: server.target(token), sleep: async () => undefined })
    const operator = server.readOperatorToken()
    const router = server.routerToken()
    const assignment = server.assignmentToken('ticket-own', 'assignment-1')
    const resultOf = (envelope: unknown): Record<string, unknown> =>
      (envelope as { result: Record<string, unknown> }).result
    try {
      writeFileSync(join(base.path, 'README.md'), '# the repo\n')
      const window = await call(['eval', 't1'], router)
      assert.equal(window.exit, 0, JSON.stringify(window.envelope))
      assert.equal(typeof resultOf(window.envelope)['threadWindow'], 'object')
      assert.equal((await call(['eval', 't1'], operator)).exit, 0, 'the operator token may read too')

      const refused = await call(['eval', 't1'], assignment)
      assert.equal(refused.exit, 2)
      assert.equal((refused.envelope as { error: { code: string } }).error.code, 'not_permitted_role')

      const message = await call(['eval-read', 't1', '--message-id', 'm8'], router)
      assert.equal(message.exit, 0, JSON.stringify(message.envelope))
      assert.equal((resultOf(message.envelope)['message'] as { text: string }).text, 'Message 8')

      const image = await call(['eval-read', 't1', '--image-id', 'm6/img_abc'], router)
      assert.equal(image.exit, 0, JSON.stringify(image.envelope))
      assert.equal(
        (resultOf(image.envelope)['image'] as { path: string }).path,
        '/state/inbox/images/m6-img_abc.png'
      )

      const part = await call(['eval-read', 't1', '--part', 'thread', '--cursor', 'p2'], router)
      assert.equal(part.exit, 0, JSON.stringify(part.envelope))
      assert.deepEqual(
        (resultOf(part.envelope)['messages'] as { id: string }[]).map((line) => line.id),
        ['m11', 'm12']
      )

      const path = await call(['eval-read', 't1', '--path', 'README.md'], router)
      assert.equal(path.exit, 0, JSON.stringify(path.envelope))
      assert.equal((resultOf(path.envelope)['path'] as { text: string }).text, '# the repo\n')

      const missing = await call(['eval', 'nope'], router)
      assert.equal(missing.exit, 2)
      assert.equal((missing.envelope as { error: { code: string } }).error.code, 'missing')

      const escaped = await call(['eval-read', 't1', '--path', '../secret.txt'], router)
      assert.equal(escaped.exit, 2)
      assert.equal((escaped.envelope as { error: { code: string } }).error.code, 'refused')

      assert.ok(server.requests.length >= 8, 'the CLI went over the wire')
    } finally {
      server.close()
      base.clean()
    }
  })
})

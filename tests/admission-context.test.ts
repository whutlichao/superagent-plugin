// 评估窗口与 fake CLI（§I.1 `threadContext`、§I.6、票 #10 验收第四、五条）：
// - 页数与超时来自部署设置（`AdmissionSettings`），不是硬编码；
// - 「读完 / 还有下一页 / 超时 / 分页坏了」四种结局各有明确结果；
// - 窗口形状（开头 5 条 + 前后各 5 条）与前后略过条数只描述快照；
// - `FakeCommands` 会记录调用、脚本化成功与失败、保留取消信号，没脚本化的调用直接失败。
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  admissionContext,
  PaginationError,
  threadWindow
} from '../src/worker/sources/admission-context.ts'
import type {
  AdmissionSettings,
  ContextMessage,
  ContextPart,
  TriggerContext
} from '../src/worker/sources/admission-context.ts'
import { CliError } from '../src/worker/sources/commands.ts'
import { FakeCommands, abortError, cliFailure } from './support/fake-commands.ts'

/** 恒定的测试时刻。 */
const AT = '2026-11-07T00:00:00.000Z'

/** 第 `index` 条消息（id 稳定，正文可读）。 */
const message = (index: number): ContextMessage => ({
  id: `om_${index}`,
  from: 'ou_user',
  at: `${AT}#${index}`,
  text: `Message ${index}`
})

/** 一个只返回给定页序列的语境读取器；记录每次读的参数。 */
function pager(pages: readonly ContextPart[]): {
  context: TriggerContext
  reads: { part: string; cursor: string | undefined; signal: AbortSignal | undefined }[]
} {
  const reads: { part: string; cursor: string | undefined; signal: AbortSignal | undefined }[] = []
  let index = 0
  return {
    reads,
    context: {
      messageId: 'om_source',
      async read(_host, part, cursor, signal) {
        reads.push({ part, cursor, signal })
        const page = pages[Math.min(index, pages.length - 1)]
        index += 1
        if (page === undefined) throw new Error('no page scripted')
        return page
      },
      images: () => [],
      image: async () => {
        throw new Error('This Source has no images')
      }
    }
  }
}

/** 部署设置：页数与超时都由调用方给（证明它们不是写死的）。 */
const settings = (overrides: Partial<AdmissionSettings> = {}): AdmissionSettings => ({
  maxPages: 3,
  timeoutMs: 5_000,
  ...overrides
})

describe('the thread window', () => {
  test('returns the thread opening and the trigger neighbours with exact internal and trailing gaps', () => {
    const result = threadWindow(
      Array.from({ length: 40 }, (_, index) => message(index)),
      'om_25'
    )
    assert.deepEqual(
      result.entries.map((entry) => entry.position),
      [1, 2, 3, 4, 5, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]
    )
    assert.equal(result.entries[5]?.omittedBefore, 15)
    assert.equal(result.omittedAfter, 9)
    assert.equal(result.sourceFound, true)
    assert.equal(result.loadedMessages, 40)
  })

  test('deduplicates overlapping windows and reports an absent source without inventing neighbours', () => {
    const messages = Array.from({ length: 12 }, (_, index) => message(index))
    assert.deepEqual(
      threadWindow(messages, 'om_3').entries.map((entry) => entry.position),
      [1, 2, 3, 4, 5, 6, 7, 8, 9]
    )
    assert.deepEqual(threadWindow(messages, 'om_absent'), {
      entries: [0, 1, 2, 3, 4].map((index) => ({
        message: message(index),
        position: index + 1,
        omittedBefore: 0
      })),
      sourceFound: false,
      loadedMessages: 12,
      omittedAfter: 7
    })
  })
})

describe('reading the admission context', () => {
  test('reads at most the configured number of pages and keeps the cursor to continue', async () => {
    const cli = new FakeCommands()
    const page = (ids: number[], next?: string): ContextPart => ({
      messages: ids.map(message),
      next,
      body: { page: next ?? 'last' }
    })
    const { context, reads } = pager([page([0, 1], 'a'), page([2, 3], 'b'), page([4, 5], 'c')])
    const result = await admissionContext(context, cli, settings({ maxPages: 2 }))
    assert.equal(result.complete, false)
    assert.equal(result.next, 'b')
    assert.equal(result.timedOut, false)
    assert.deepEqual(reads.map((read) => read.cursor), [undefined, 'a'])
    assert.equal(result.messages.length, 4)
    assert.equal(result.window.loadedMessages, 4)
    // 没读完时的 `complete` 是假，而且窗口只描述这一份快照。
    assert.equal(result.window.sourceFound, false)
    // 设置换成 10 页就读到底：页数来自设置，不是写死的。
    const deep = pager([page([0, 1], 'a'), page([2], 'b'), page([3])])
    const complete = await admissionContext(deep.context, cli, settings({ maxPages: 10 }))
    assert.equal(complete.complete, true)
    assert.equal(complete.next, null)
    assert.equal(complete.messages.length, 4)
  })

  test('deduplicates overlapping pages and keeps the first status the Source reports', async () => {
    const cli = new FakeCommands()
    const { context } = pager([
      { messages: [message(0), message(1)], next: 'a', body: {}, status: 'chat_neighbours' },
      { messages: [message(1), message(2)], body: {}, status: 'other' }
    ])
    const result = await admissionContext(context, cli, settings())
    assert.deepEqual(result.messages.map((entry) => entry.id), ['om_0', 'om_1', 'om_2'])
    assert.equal(result.status, 'chat_neighbours')
    assert.equal(result.complete, true)
  })

  test('a repeated cursor is a broken pagination, not an endless window', async () => {
    const cli = new FakeCommands()
    const { context } = pager([
      { messages: [message(0)], next: 'same', body: {} },
      { messages: [message(1)], next: 'same', body: {} }
    ])
    await assert.rejects(admissionContext(context, cli, settings()), (error: unknown) => {
      assert.ok(error instanceof PaginationError)
      assert.equal(error.cursor, 'same')
      return true
    })
  })

  test('a slow read ends at the configured timeout with what was read so far', async () => {
    const cli = new FakeCommands()
    let released: (() => void) | undefined
    const context: TriggerContext = {
      messageId: 'om_source',
      read: (_host, _part, _cursor, signal) =>
        new Promise<ContextPart>((resolve, reject) => {
          const timer = setTimeout(
            () => resolve({ messages: [message(0)], body: {} }),
            10_000
          )
          signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            released = () => reject(abortError())
            released()
          })
        }),
      images: () => [],
      image: async () => {
        throw new Error('This Source has no images')
      }
    }
    const started = Date.now()
    const result = await admissionContext(context, cli, settings({ timeoutMs: 20 }))
    assert.equal(result.timedOut, true)
    assert.equal(result.complete, false)
    assert.deepEqual(result.messages, [], 'nothing was read before the timeout')
    assert.ok(Date.now() - started < 2_000, 'the window ends at the configured timeout')
  })

  test('the window gives each read its own signal and aborts it when the time is up', async () => {
    const cli = new FakeCommands()
    const signals: AbortSignal[] = []
    const context: TriggerContext = {
      messageId: 'om_source',
      read: (_host, _part, _cursor, signal) => {
        if (signal !== undefined) signals.push(signal)
        // 第二次读挂住：窗口到点必须自己取消它，而不是无限等下去。
        return signals.length === 1
          ? Promise.resolve({ messages: [message(0)], next: 'a', body: {} })
          : new Promise<ContextPart>((_resolve, reject) => {
              signal?.addEventListener('abort', () => reject(abortError()))
            })
      },
      images: () => [],
      image: async () => {
        throw new Error('This Source has no images')
      }
    }
    const result = await admissionContext(context, cli, settings({ timeoutMs: 30 }))
    assert.equal(signals.length, 2)
    assert.equal(signals[0]?.aborted, true, 'the window aborts its own signal at the deadline')
    assert.equal(result.timedOut, true)
    assert.equal(result.complete, false)
    assert.equal(result.next, 'a', 'the last cursor is handed back so a later window can continue')
    assert.deepEqual(result.messages.map((entry) => entry.id), ['om_0'])
  })

  test('a CLI failure that is not a cancellation surfaces as itself', async () => {
    const cli = new FakeCommands()
    cli.fail('lark-cli', ['im', '+threads-messages-list'], cliFailure('lark-cli', { stderr: 'rate limited', code: 99991400 }))
    const context: TriggerContext = {
      messageId: 'om_source',
      read: async (host, part, cursor, signal) => {
        await host.run('lark-cli', ['im', '+threads-messages-list', '--thread', 'omt_1'], { signal })
        return { messages: [], body: {} }
      },
      images: () => [],
      image: async () => {
        throw new Error('This Source has no images')
      }
    }
    await assert.rejects(admissionContext(context, cli, settings()), (error: unknown) => {
      assert.ok(error instanceof CliError)
      assert.equal(error.code, 99991400)
      return true
    })
    assert.deepEqual(cli.programs, ['lark-cli'])
  })
})

describe('FakeCommands', () => {
  test('scripts answers, records calls and refuses anything unscripted', async () => {
    const cli = new FakeCommands()
    cli.script('gh api notifications', () => '[]')
    assert.equal(await cli.run('gh', ['api', 'notifications', '--paginate']), '[]')
    assert.deepEqual(cli.programs, ['gh'])
    assert.deepEqual(cli.args, [['api', 'notifications', '--paginate']])
    await assert.rejects(cli.run('gh', ['api', 'repos/acme/widgets']), /no script for gh api repos\/acme\/widgets/)
  })

  test('scripts failures, one-shot answers, and keeps the order of calls', async () => {
    const cli = new FakeCommands()
    // 一次失败排在一个一次性成功之前：两条脚本都命中同一次调用序列里的不同次。
    cli.next('gh', ['api', 'repos/acme/widgets/issues/1'], new CliError('gh exited with code 1: Not Found (HTTP 404)', 404, 1))
    cli.next('gh', ['api', 'repos/acme/widgets/issues/1'], '{"number":1}')
    cli.script('git status', () => 'clean')
    await assert.rejects(cli.run('gh', ['api', 'repos/acme/widgets/issues/1']), (error: unknown) => {
      assert.ok(error instanceof CliError)
      assert.equal(error.code, 404)
      return true
    })
    assert.equal(await cli.run('gh', ['api', 'repos/acme/widgets/issues/1']), '{"number":1}')
    assert.equal(await cli.run('git', ['status']), 'clean')
    assert.deepEqual(cli.programs, ['gh', 'gh', 'git'])
  })

  test('a bound signal reaches every call, and an aborted signal rejects with an AbortError', async () => {
    const cli = new FakeCommands()
    const window = new AbortController()
    const bound = cli.withSignal(window.signal)
    cli.script('gh api notifications', () => '[]')
    await bound.run('gh', ['api', 'notifications'])
    assert.equal(cli.calls[0]?.signal?.aborted, false)
    assert.deepEqual(cli.signals, [window.signal])
    window.abort()
    await assert.rejects(bound.run('gh', ['api', 'notifications']), (error: unknown) =>
      (error as Error).name === 'AbortError'
    )
    // 未绑定信号的视图不受影响。
    assert.equal(await cli.run('gh', ['api', 'notifications']), '[]')
  })

  test('`next` interleaves successes and failures for one call', async () => {
    const cli = new FakeCommands()
    cli.next('sh', ['-c', 'exit 1'], new CliError('sh exited with code 1', undefined, 1))
    cli.next('sh', ['-c', 'exit 1'], 'ok')
    await assert.rejects(cli.run('sh', ['-c', 'exit 1']), /exited with code 1/)
    assert.equal(await cli.run('sh', ['-c', 'exit 1']), 'ok')
  })
})

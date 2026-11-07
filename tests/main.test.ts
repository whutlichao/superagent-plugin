// 插件入口的启动面：`activate(orca)` 只登记贡献点（§N.1），把等待留给 boot。
// 这里用 `mountWorker` 断言「清单声明的命令/事件/钩子都注册了、没有越权宿主调用」。
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as main from '../src/worker/main'
import { readRepoFile } from './support/repo'
import { removeTree } from './support/state'

/**
 * 挂载一次 worker，并给它一个独立的状态目录（真实组合根：boot 会取锁、开库、起 HTTP）。
 * 不这么做的话，进程里别的测试留下的临时 stateDir 指针会让这次挂载变成 follower。
 */
async function mounted(): Promise<{
  readonly worker: Awaited<ReturnType<typeof mountWorker>>
  cleanup(): Promise<void>
}> {
  const stateDir = mkdtempSync(join(tmpdir(), 'superagent-main-'))
  const worker = await mountWorker(main, { host: mockHost({ settings: { stateDir } }) })
  return {
    worker,
    cleanup: async () => {
      // `deactivate()` 走的是 boot 的同一个关停屏障（§N.1）：返回之后状态目录不再被写。
      await worker.deactivate()
      await removeTree(stateDir)
    }
  }
}

/** 清单里的贡献点，作为断言清单的独立真相。 */
const manifest = JSON.parse(readRepoFile('orca-plugin.json')) as {
  contributes: {
    commands: readonly { id: string }[]
    events: readonly { on: string }[]
    hooks: readonly { event: string }[]
    statusBarItems: readonly { id: string }[]
  }
}

test('activates without a refused host call', async () => {
  const { worker, cleanup } = await mounted()
  assert.deepEqual(worker.refusals, [])
  await cleanup()
})

test('registers every contributed command', async () => {
  const { worker, cleanup } = await mounted()
  for (const command of manifest.contributes.commands) {
    const result = await worker.command(command.id)
    assert.equal(typeof result, 'string', `${command.id} answers a string the host shows as-is`)
  }
  await cleanup()
})

test('subscribes every contributed event and the one hook', async () => {
  const { worker, cleanup } = await mounted()
  for (const event of manifest.contributes.events) {
    // 事件能送达即说明 worker 订阅了；未订阅的事件 Orca 不会投递。
    await worker.emit(event.on, payloadFor(event.on))
  }
  const decision = await worker.hooks.fire('agent.launch.before', {
    agent: 'claude',
    workspaceId: null,
    workspaceKind: null,
    command: 'claude',
    env: {}
  })
  assert.equal(decision.kind, 'continue')
  assert.deepEqual(worker.refusals, [])
  await cleanup()
})

test('answers the panel state request with the shell contract snapshot', async () => {
  const { worker, cleanup } = await mounted()
  const state = (await worker.request('state')) as {
    revision: number
    booted: boolean
    health: { paused: boolean }
    attention: { answer: number; review: number; problems: number; items: readonly unknown[] }
  }
  assert.equal(state.booted, true)
  assert.equal(state.revision >= 1, true)
  assert.equal(state.health.paused, false)
  assert.deepEqual(state.attention, { answer: 0, review: 0, problems: 0, items: [] })
  await cleanup()
})

test('pausing through the panel contract bumps the revision and pushes state.changed', async () => {
  const { worker, cleanup } = await mounted()
  const before = (await worker.request('state')) as { revision: number }
  // boot 自己也推过一次首屏（revision 2）：只看这次暂停新增的那一条。
  const seen = worker.posts.length
  const paused = (await worker.request('pause', { paused: true })) as {
    revision: number
    health: { paused: boolean }
  }
  assert.equal(paused.health.paused, true)
  assert.equal(paused.revision, before.revision + 1, 'the revision is monotonic')
  assert.deepEqual(worker.posts.slice(seen), [
    { event: 'state.changed', payload: { revision: paused.revision } }
  ])
  await cleanup()
})

test('check reads the read model again and pushes the new revision', async () => {
  const { worker, cleanup } = await mounted()
  const before = (await worker.request('state')) as { revision: number }
  const seen = worker.posts.length
  const next = (await worker.request('check')) as { revision: number }
  assert.equal(next.revision, before.revision + 1, 'the check really re-read the model')
  assert.deepEqual(worker.posts.slice(seen), [
    { event: 'state.changed', payload: { revision: next.revision } }
  ])
  await cleanup()
})

test('the retry and terminal actions refuse malformed input instead of guessing', async () => {
  const { worker, cleanup } = await mounted()
  await assert.rejects(worker.request('ticket.retry', {}), /ticketId/)
  await assert.rejects(worker.request('terminal.focus', {}), /terminalId/)
  // 未知工单由领域拒绝（不假装重试成功，也不吞掉原因）。
  await assert.rejects(worker.request('ticket.retry', { ticketId: 'ticket-unknown' }), /.+/)
  await cleanup()
})

test('the pause command answers a string Orca shows as-is, and moves the same state', async () => {
  const { worker, cleanup } = await mounted()
  const before = (await worker.request('state')) as { revision: number }
  assert.equal(await worker.command('superagent.pause'), 'Superagent: processing paused.')
  const paused = (await worker.request('state')) as { health: { paused: boolean } }
  assert.equal(paused.health.paused, true, 'the command moved the real composition root')
  assert.equal(await worker.command('superagent.resume'), 'Superagent: processing resumed.')
  const state = (await worker.request('state')) as { revision: number; health: { paused: boolean } }
  assert.equal(state.health.paused, false)
  assert.equal(state.revision, before.revision + 2, 'pause and resume each moved it once')
  await cleanup()
})

test('a malformed pause request is refused with invalid_params, not silently accepted', async () => {
  const { worker, cleanup } = await mounted()
  await assert.rejects(worker.request('pause', { paused: 'yes' }), /paused/)
  await cleanup()
})

test('updates the status bar item the manifest contributes', async () => {
  const { worker, cleanup } = await mounted()
  // 等 boot 完成：状态栏的首个值在组合根完成装配后发布（不是 activate 同步返回时）。
  await worker.request('state')
  const calls = worker.host.callsOf('statusBar.update')
  assert.ok(calls.length >= 1, 'the shell publishes the first status bar value')
  const first = calls[0] as { id: string; text?: string; tone?: string; tooltip?: string }
  assert.equal(first.id, 'superagent')
  assert.equal(first.text, 'Superagent')
  assert.equal(first.tone, 'success')
  // 语气与 tooltip 来自同一份真实快照（#45 的注意力计数，§N.7）。
  assert.equal(first.tooltip, '0 awaiting answer · 0 awaiting review · 0 problems')
  await cleanup()
})

/** 每个订阅事件的最小合法负载（references/events.md）。 */
function payloadFor(event: string): Record<string, unknown> {
  switch (event) {
    case 'agent.status.changed':
      return { workspaceId: null, paneKey: 'pane-1', state: 'working', receivedAt: 1 }
    case 'workspace.created':
      return { workspaceId: 'w1', kind: 'worktree', path: '/tmp/w1', branch: 'main' }
    case 'workspace.removed':
      return { workspaceId: 'w1', kind: 'worktree', path: '/tmp/w1' }
    default:
      return {}
  }
}

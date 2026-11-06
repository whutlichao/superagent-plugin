// 插件入口的启动面：`activate(orca)` 只登记贡献点（§N.1），把等待留给 boot。
// 这里用 `mountWorker` 断言「清单声明的命令/事件/钩子都注册了、没有越权宿主调用」。
import { assert, mountWorker, test } from 'orca/testing'
import * as main from '../src/worker/main'
import { readRepoFile } from './support/repo'

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
  const worker = await mountWorker(main)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('registers every contributed command', async () => {
  const worker = await mountWorker(main)
  for (const command of manifest.contributes.commands) {
    const result = await worker.command(command.id)
    assert.equal(typeof result, 'string', `${command.id} answers a string the host shows as-is`)
  }
  await worker.deactivate()
})

test('subscribes every contributed event and the one hook', async () => {
  const worker = await mountWorker(main)
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
  await worker.deactivate()
})

test('answers the panel state request with the shell contract snapshot', async () => {
  const worker = await mountWorker(main)
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
  await worker.deactivate()
})

test('pausing through the panel contract bumps the revision and pushes state.changed', async () => {
  const worker = await mountWorker(main)
  const before = (await worker.request('state')) as { revision: number }
  const paused = (await worker.request('pause', { paused: true })) as {
    revision: number
    health: { paused: boolean }
  }
  assert.equal(paused.health.paused, true)
  assert.equal(paused.revision, before.revision + 1, 'the revision is monotonic')
  assert.deepEqual(worker.posts, [{ event: 'state.changed', payload: { revision: paused.revision } }])
  await worker.deactivate()
})

test('the pause command answers a string Orca shows as-is, and moves the same state', async () => {
  const worker = await mountWorker(main)
  assert.equal(await worker.command('superagent.pause'), 'Superagent: processing paused.')
  assert.equal(await worker.command('superagent.resume'), 'Superagent: processing resumed.')
  const state = (await worker.request('state')) as { revision: number }
  assert.equal(state.revision, 3, 'pause and resume each moved it once')
  await worker.deactivate()
})

test('a malformed pause request is refused with invalid_params, not silently accepted', async () => {
  const worker = await mountWorker(main)
  await assert.rejects(worker.request('pause', { paused: 'yes' }), /paused/)
  await worker.deactivate()
})

test('updates the status bar item the manifest contributes', async () => {
  const worker = await mountWorker(main)
  const calls = worker.host.callsOf('statusBar.update')
  assert.ok(calls.length >= 1, 'the shell publishes the first status bar value')
  const first = calls[0] as { id: string; text?: string; tone?: string; tooltip?: string }
  assert.equal(first.id, 'superagent')
  assert.equal(first.text, 'Superagent')
  assert.equal(first.tone, 'success')
  await worker.deactivate()
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

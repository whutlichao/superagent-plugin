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

test('answers the panel state request with a booting status', async () => {
  const worker = await mountWorker(main)
  assert.deepEqual(await worker.request('superagent.state'), { status: 'booting' })
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

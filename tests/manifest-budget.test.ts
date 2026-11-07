// 清单预算与形态：`orca-plugin.json` 是 `trusted-worker` 插件，且每类贡献点都在宿主上限之内（§N.2）。
import { assert, test } from 'orca/testing'
import { readRepoJson } from './support/repo'

interface Named {
  readonly id?: string
  readonly kind?: string
  readonly on?: string
  readonly event?: string
  readonly key?: string
  readonly onError?: string
}

interface Manifest {
  readonly manifestVersion: number
  readonly id: string
  readonly execution: string
  readonly pluginApi: number
  readonly license: string
  readonly main: string
  readonly engines: { readonly orca: string }
  readonly contributes: Readonly<Record<string, readonly Named[] | undefined>>
  readonly capabilities: readonly Named[]
}

const manifest = readRepoJson<Manifest>('orca-plugin.json')

/** 某类贡献点的条目；未声明与空数组等价（清单允许省略保留数组）。capabilities 在顶层。 */
const contributions = (name: string): readonly Named[] =>
  name === 'capabilities' ? manifest.capabilities : (manifest.contributes[name] ?? [])

/** 取某类贡献点的 id/key/event 之类的标识字段。 */
const identities = (name: string, field: keyof Named): string[] =>
  contributions(name).map((entry) => String(entry[field]))

test('declares the trusted-worker plugin the design describes', () => {
  assert.equal(manifest.manifestVersion, 2)
  assert.equal(manifest.id, 'superagent')
  assert.equal(manifest.execution, 'trusted-worker')
  assert.equal(manifest.pluginApi, 1)
  assert.equal(manifest.license, 'MIT')
  assert.equal(manifest.main, 'src/worker/main.ts')
  assert.equal(manifest.engines.orca, '>=1.4.250')
})

test('stays inside the host contribution budgets', () => {
  const budgets: readonly (readonly [string, number, number])[] = [
    ['events', 4, 3],
    ['hooks', 8, 1],
    ['commands', 256, 4],
    ['capabilities', 32, 10],
    ['settings', 64, 4]
  ]
  for (const [name, limit, used] of budgets) {
    const count = contributions(name).length
    assert.ok(count <= limit, `${name}: ${count} exceeds the host limit ${limit}`)
    assert.equal(count, used, `${name}: design uses ${used}`)
  }
})

test('keeps the reserved contribution arrays empty', () => {
  for (const name of [
    'agentHarnesses',
    'skills',
    'mcpServers',
    'taskSources',
    'connections',
    'sidebarCards'
  ]) {
    assert.deepEqual(contributions(name), [], `${name} must stay empty`)
  }
})

test('contributes the four commands, three events, one hook and one status bar item', () => {
  assert.deepEqual(identities('commands', 'id'), [
    'superagent.pause',
    'superagent.resume',
    'superagent.restartRouter',
    'superagent.checkSetup'
  ])
  assert.deepEqual(identities('events', 'on'), [
    'agent.status.changed',
    'workspace.created',
    'workspace.removed'
  ])
  assert.deepEqual(identities('hooks', 'event'), ['agent.launch.before'])
  assert.equal(contributions('hooks')[0]?.onError, 'pass')
  assert.deepEqual(identities('statusBarItems', 'id'), ['superagent'])
  assert.deepEqual(identities('panels', 'id'), ['superagent'])
})

test('asks for exactly the ten capabilities the design approves', () => {
  assert.deepEqual(identities('capabilities', 'kind'), [
    'workspace:read',
    'workspace:write',
    'agent:read',
    'agent:launch',
    'terminal:send',
    'terminal:read',
    'notifications:show',
    'storage:own',
    'secrets:own',
    'settings:own'
  ])
})

test('declares the four host settings that decide whether the plugin can start', () => {
  assert.deepEqual(identities('settings', 'key'), ['stateDir', 'agent', 'routerAgent', 'baseRepo'])
})

test('the status bar item has no click command (approved deviation from §N.7, #45)', () => {
  // §N.7 原本让点击跑 `superagent.pause`；#45 的裁决是**不挂点击动作**：状态栏常驻在标题栏上，
  // 误点会暂停整个处理，而宿主没有「只读/打开面板」的点击动作可挂。`superagent.pause` 仍在
  // 命令面板里（上面的四条命令断言）。DOC2（#50）把设计文本改成同口径。
  const items = (manifest.contributes['statusBarItems'] ?? []) as readonly {
    readonly id?: string
    readonly command?: string
  }[]
  assert.equal(items.length, 1)
  assert.equal(items[0]?.id, 'superagent')
  assert.equal(Object.hasOwn(items[0] ?? {}, 'command'), false, 'the click is inert')
})

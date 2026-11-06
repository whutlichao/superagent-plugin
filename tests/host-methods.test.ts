// 运行缝的宿主方法清单测试：源码里出现的每个 `host.call('<m>')` 字面量都必须来自唯一清单，且清单每项带 since 出处（§N.3 其四）。
import { assert, test } from 'orca/testing'
import { listFiles, readRepoFile } from './support/repo'

interface HostMethod {
  readonly method: string
  readonly since: string
}

/** 从 source 里抽出所有 `host.call('<method>'` / `host.call("<method>"` 的方法名。 */
function calledMethods(source: string): string[] {
  return [...source.matchAll(/host\s*\.\s*call\s*\(\s*['"]([a-zA-Z][\w.]*)['"]/g)].map(
    (match) => match[1] as string
  )
}

/** 源码里出现 host.call 字面量的位置（相对仓库根），只扫我们自己的 src。 */
function sourcesCallingTheHost(): readonly { file: string; methods: string[] }[] {
  return listFiles('src', '.ts')
    .filter((file) => !file.endsWith('.d.ts'))
    .map((file) => ({ file, methods: calledMethods(readRepoFile(file)) }))
    .filter((entry) => entry.methods.length > 0)
}

const listSource = readRepoFile('src/worker/runtime/host-methods.ts')
const listMethods: readonly HostMethod[] = (await import('../src/worker/runtime/host-methods.ts'))
  .HOST_METHODS

test('every host.call literal in the sources is on the single method list', () => {
  const listed = new Set(listMethods.map((entry) => entry.method))
  const unlisted = sourcesCallingTheHost().flatMap(({ file, methods }) =>
    methods.filter((method) => !listed.has(method)).map((method) => `${file}: ${method}`)
  )
  assert.deepEqual(unlisted, [], 'host.call literals outside HOST_METHODS')
})

test('the method list is not empty and names each method once', () => {
  assert.ok(listMethods.length > 0, 'HOST_METHODS must list the host calls the plugin makes')
  const names = listMethods.map((entry) => entry.method)
  assert.deepEqual(
    names.filter((name, index) => names.indexOf(name) !== index),
    [],
    'duplicate methods in HOST_METHODS'
  )
})

test('every list entry says which Orca release introduced it', () => {
  // 清单项紧挨着的上一行必须是 `// since x.y.z`（可带出处说明），且与条目上的 since 一致。
  const missing = listMethods
    .filter((entry) => entry.since.trim().length === 0 || !/^\d+\.\d+/.test(entry.since))
    .map((entry) => entry.method)
  assert.deepEqual(missing, [], 'entries without a parseable since')

  const sinceComments = [...listSource.matchAll(/^\s*\/\/\s*since\s+(\S+)/gm)].map(
    (match) => match[1] as string
  )
  assert.deepEqual(
    sinceComments,
    listMethods.map((entry) => entry.since),
    'every HOST_METHODS entry needs its own `// since <version>` comment, in order'
  )
})

test('the list covers the host surfaces the runtime seam relies on', () => {
  // 方法名来自 `orca skills get orca-plugin-authoring --reference references/host-api.md`。
  assert.deepEqual(
    listMethods.map((entry) => entry.method),
    [
      'workspace.list',
      'workspace.open',
      'agents.list',
      'agent.launch',
      'terminal.sendText',
      'terminal.read',
      'notifications.show',
      'statusBar.update',
      'storage.get',
      'storage.set',
      'storage.delete',
      'storage.keys',
      'secrets.get',
      'secrets.set',
      'secrets.delete',
      'secrets.protection',
      'settings.get',
      'settings.set'
    ]
  )
})

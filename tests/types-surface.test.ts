// 类型面自检（§N.3 其四）：手写声明里出现的宿主方法名必须全部来自 `HOST_METHODS`，
// 且清单里的每个方法都在声明里有一份类型（少一个就报）。声明与清单漂移时这里先炸。
import { assert, test } from 'orca/testing'
import { listFiles, readRepoFile } from './support/repo'

/** 与 `src/worker/runtime/host-methods.ts` 相同的清单（测试独立读取，避免经由 seam 实现）。 */
const listed: readonly string[] = (
  await import('../src/worker/runtime/host-methods.ts')
).HOST_METHODS.map((entry: { readonly method: string }) => entry.method)

/** `types/orca.d.ts` 里被标记包住的宿主方法表区域。 */
const HOST_METHODS_BLOCK = /\/\/ @host-methods:start[\s\S]*?\/\/ @host-methods:end/

/** 从 `HostMethods` 接口区域抽出方法名（形如 `'workspace.list': {` 的键）。 */
function declaredHostMethods(source: string): string[] {
  const block = HOST_METHODS_BLOCK.exec(source)?.[0]
  if (block === undefined) return []
  return [...block.matchAll(/^\s*'([a-z][a-zA-Z]*\.[a-zA-Z][\w.]*)'\s*:/gm)].map(
    (match) => match[1] as string
  )
}

/** 从事件/钩子声明里抽出名字（形如 `'agent.status.changed':` 的键）。 */
function declaredNamesIn(source: string, interfaceName: string): string[] {
  const block = new RegExp(`interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`).exec(source)?.[1]
  if (block === undefined) return []
  return [...block.matchAll(/^\s*'([a-z][a-zA-Z]*\.[a-zA-Z][\w.]*)'\s*:/gm)].map(
    (match) => match[1] as string
  )
}

/** 类型声明文件（types/ 下全部 .d.ts）。 */
const declarationFiles = (): readonly string[] => listFiles('types', '.d.ts')

const orcaTypes = (): string => readRepoFile('types/orca.d.ts')
const workerTypes = (): string => readRepoFile('types/orca-worker.d.ts')

test('the declarations type exactly the host methods on the single list', () => {
  assert.deepEqual(declaredHostMethods(orcaTypes()), listed)
})

test('the host methods the list carries are all declared, none extra', () => {
  const declared = new Set(declaredHostMethods(orcaTypes()))
  const missing = listed.filter((method) => !declared.has(method))
  const extra = [...declared].filter((method) => !listed.includes(method))
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] })
})

test('every host-like name in the declaration files is a listed method, an event or a hook', () => {
  // §N.3 其四的「声明里不出现清单外的方法」：把本条当成拒绝清单，任何新出现的点分名
  // 都必须先落进 HOST_METHODS、WorkerEvents 或钩子清单，否则这里红。
  const allowed = new Set(['agent.launch.before']) // 唯一钩子，由下面的事件/钩子测试逐项核对
  for (const name of listed) allowed.add(name)
  for (const name of declaredNamesIn(workerTypes(), 'WorkerEvents')) allowed.add(name)

  const offenders = [...orcaTypes(), ...workerTypes()]
    .join('\n')
    .match(/['"][a-z][a-zA-Z]*\.[a-zA-Z][\w.]*['"]/g)
    ?.map((literal) => literal.slice(1, -1))
    .filter((name) => !allowed.has(name))
  assert.deepEqual([...(offenders ?? [])].sort(), [])
})

test('events and hooks in the declarations are declared in the manifest, and vice versa', () => {
  const manifest = JSON.parse(readRepoFile('orca-plugin.json')) as {
    contributes: {
      events: readonly { on: string }[]
      hooks: readonly { event: string }[]
    }
  }
  const declaredEvents = declaredNamesIn(workerTypes(), 'WorkerEvents')
  assert.deepEqual(declaredEvents, manifest.contributes.events.map((entry) => entry.on))

  // 钩子面用重载声明（`on(event: 'agent.launch.before', …)`），单独抽取。
  const declaredHooks = [
    ...workerTypes().matchAll(/on\(\s*(?:event:\s*)?'([a-z][a-zA-Z]*\.[a-zA-Z][\w.]*)'\s*,/g)
  ].map((match) => match[1] as string)
  assert.deepEqual(declaredHooks, manifest.contributes.hooks.map((entry) => entry.event))
})

test('the declarations name the ten capabilities the manifest requests', () => {
  const surface = `${orcaTypes()}\n${workerTypes()}`
  const manifest = JSON.parse(readRepoFile('orca-plugin.json')) as {
    capabilities: readonly { kind: string }[]
  }
  for (const { kind } of manifest.capabilities) {
    assert.ok(surface.includes(`'${kind}'`), `capability ${kind} declared`)
  }
})

test('the declaration files stay interface-only (no any escapes)', () => {
  // §N.3 其五：类型文件里不写实现、不写 `any` 逃逸；唯一允许的是受控的 JsonValue 别名。
  const offenders = declarationFiles().flatMap((file) => {
    const lines = readRepoFile(file).split('\n')
    return lines
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => /\bany\b/.test(line) && !/\/\//.test(line))
      .map(({ line, number }) => `${file}:${number}: ${line.trim()}`)
  })
  assert.deepEqual(offenders, [])
})

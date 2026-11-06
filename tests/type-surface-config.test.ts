// 自包含类型面：手写声明与 `HOST_METHODS` 必须逐项对齐，且 `tsc` 不依赖任何 Orca 生成文件（§N.3）。
import { assert, test } from 'orca/testing'
import { listFiles, readRepoFile } from './support/repo'

/** 与 `src/worker/runtime/host-methods.ts` 相同的清单（测试独立读取）。 */
const listed: readonly string[] = (
  await import('../src/worker/runtime/host-methods.ts')
).HOST_METHODS.map((entry: { readonly method: string }) => entry.method)

/** `types/orca.d.ts` 的 `HostMethods` 接口必须被显式标记包住，便于逐项比对。 */
function declaredHostMethods(source: string): string[] {
  const block = /\/\/ @host-methods:start[\s\S]*?\/\/ @host-methods:end/.exec(source)?.[0]
  if (block === undefined) return []
  return [...block.matchAll(/^\s*'([a-z][a-zA-Z]*\.[a-zA-Z][\w.]*)'\s*:/gm)].map(
    (match) => match[1] as string
  )
}

test('the self-contained tsconfig never extends Orca-generated types', () => {
  const tsconfig = JSON.parse(readRepoFile('tsconfig.json')) as {
    extends?: string
    compilerOptions: {
      types?: readonly string[]
      paths?: Readonly<Record<string, readonly string[]>>
      noEmit?: boolean
      strict?: boolean
    }
    include: readonly string[]
  }
  // §N.3 其二：自包含配置，不 extends ./.orca/types/tsconfig.json，也不引用 .orca 下任何文件。
  assert.equal(tsconfig.extends, undefined)
  assert.equal(readRepoFile('tsconfig.json').includes('.orca/types'), false)
  assert.deepEqual(tsconfig.compilerOptions.types, [])
  assert.equal(tsconfig.compilerOptions.noEmit, true)
  assert.equal(tsconfig.compilerOptions.strict, true)
  assert.deepEqual(tsconfig.compilerOptions.paths, {
    orca: ['./types/orca.d.ts'],
    'orca/worker': ['./types/orca-worker.d.ts'],
    'orca/testing': ['./types/orca-testing.d.ts']
  })
  for (const included of ['src', 'tests', 'types']) {
    assert.ok(tsconfig.include.includes(included), `include covers ${included}`)
  }
})

test('the hand-written declarations live where the tsconfig paths point', () => {
  const declared = listFiles('types', '.d.ts')
  assert.deepEqual(declared, [
    'types/node-shim.d.ts',
    'types/orca-testing.d.ts',
    'types/orca-worker.d.ts',
    'types/orca.d.ts'
  ])
})

test('every host method on the list has a declaration and nothing extra is declared', () => {
  const declared = declaredHostMethods(readRepoFile('types/orca.d.ts'))
  assert.deepEqual(declared, listed)
})

test('the declarations carry the pinned Orca version', () => {
  for (const file of ['types/orca.d.ts', 'types/orca-worker.d.ts', 'types/orca-testing.d.ts']) {
    assert.ok(
      readRepoFile(file).includes('pinned to Orca 1.4.251'),
      `${file} states the pinned Orca version`
    )
  }
})

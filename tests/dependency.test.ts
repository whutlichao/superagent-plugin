// 依赖方向（§C.2 规则 3–6）：面板只依赖 `orca` 与 `panel/protocol.ts`；面板不 import worker，
// worker 不 import 面板。`dependency.test.ts` 是这条纪律的守门人。
import { assert, test } from 'orca/testing'
import { listFiles, readRepoFile } from './support/repo'

/** 一个源码文件里的模块说明符（`import … from 'x'`、`import 'x'`、`export … from 'x'`、`import('x')`）。 */
function specifiers(source: string): string[] {
  return [
    ...source.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g),
    ...source.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g),
    ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)
  ].map((match) => match[1] as string)
}

/**
 * 面板源码。测试文件与 `*.check.ts` 情景豁免：前者要 `import 'orca/testing'`，
 * 后者由 `orca plugin check` 加载，本来就只活在测试面（与 `runtime-seam.test.ts` 同一口径）。
 */
const panelFiles = (): readonly string[] =>
  listFiles('src/panel').filter(
    (file) => !file.endsWith('.test.ts') && !file.endsWith('.test.tsx') && !file.endsWith('.check.ts')
  )

/** worker 源码（测试与 check 情景豁免，口径同上）。 */
const workerFiles = (): readonly string[] =>
  listFiles('src/worker').filter(
    (file) => !file.endsWith('.test.ts') && !file.endsWith('.test.tsx') && !file.endsWith('.check.ts')
  )

test('the panel imports only orca, its own files, and panel/protocol.ts', () => {
  const offenders = panelFiles().flatMap((file) =>
    specifiers(readRepoFile(file))
      .filter((specifier) => !(specifier === 'orca' || specifier.startsWith('./') || specifier.startsWith('../')))
      .map((specifier) => `${file}: ${specifier}`)
  )
  assert.deepEqual(offenders, [])
})

test('the panel never reaches into the worker', () => {
  // §C.2 规则 3 的原话：`panel/` 不 import `src/worker/**`。相对路径与包路径两种写法都挡。
  const offenders = panelFiles().flatMap((file) =>
    specifiers(readRepoFile(file))
      .filter((specifier) => specifier.includes('worker') && !specifier.startsWith('orca'))
      .map((specifier) => `${file}: ${specifier}`)
  )
  assert.deepEqual(offenders, [])
})

test('the worker imports only panel/protocol.ts from the panel, never a page or a widget', () => {
  // `protocol.ts` 是两侧共用的唯一契约（§M.6、票面），worker 读它是设计要的；
  // 其余面板文件（页面、组件、文案、样式）都只属于面板运行面，worker 读不到。
  const offenders = workerFiles().flatMap((file) =>
    specifiers(readRepoFile(file))
      .filter((specifier) => specifier.includes('panel'))
      .filter((specifier) => !/(?:^|\/)protocol(?:\.ts)?$/.test(specifier))
      .map((specifier) => `${file}: ${specifier}`)
  )
  assert.deepEqual(offenders, [])
})

test('the panel does not name the orca CLI seam nor the worker-only orca modules', () => {
  const offenders = panelFiles().flatMap((file) => {
    const source = readRepoFile(file)
    return [
      ...source.matchAll(/(?:from\s*|import\s*\(\s*)['"]orca\/(?:worker|testing)['"]/g)
    ].map((match) => `${file}: ${match[0]}`)
  })
  assert.deepEqual(offenders, [])
})

test('protocol.ts is a pure contract: no values beyond its declaration lists, no orca import', () => {
  const source = readRepoFile('src/panel/protocol.ts')
  assert.equal(/from\s*['"]orca['"]/.test(source), false, 'protocol.ts imports no orca runtime value')
  assert.equal(/\bhost\s*\.\s*call\s*\(/.test(source), false, 'no host.call in the panel')
  assert.equal(/\bspawn\s*\(/.test(source), false, 'no subprocess in the panel')
  assert.equal(/\bnode:/.test(source), false, 'no Node built-ins in the panel (it is sandboxed-ui)')
})

// 运行缝纪律：只有 `src/worker/runtime/` 允许接触 Orca（§B.1、§C.2 规则 3–4、§P.3）。
//
// 两条各自命名的规则（coordinator 裁决 2026-11-07）：
// - `orca/worker` 与 `orca/testing` 只允许在 `src/worker/runtime/`（测试文件豁免：
//   `*.test.ts(x)` 必须能 `import 'orca/testing'`）。
// - `from 'orca'`（组件面板的 UI 运行面，§C.2 规则 3）只允许在 `src/panel/` 与
//   `src/worker/runtime/`。
// 两条规则之外，`spawn('orca')` 与 `host.call(` 同样只在 `runtime/`（测试文件豁免）。
import { assert, test } from 'orca/testing'
import { listFiles, readRepoFile } from './support/repo'
import {
  findViolations,
  HOST_CALL_PATTERN,
  ORCA_BARE_IMPORT_PATTERN,
  ORCA_CLI_CALL_PATTERN,
  ORCA_HOST_IMPORT_PATTERN
} from './support/seam'

/** 允许接触 Orca 的唯一目录。 */
const SEAM_DIR = 'src/worker/runtime/'

/** 允许 import 裸 `orca`（组件面）的目录（§C.2 规则 3）。 */
const PANEL_DIR = 'src/panel/'

/** 目录是否在 seam 之内。 */
const inSeam = (file: string): boolean => file.startsWith(SEAM_DIR)

/** 布局源码文件：排除声明文件与宿主加载的测试/check 情景。 */
const pluginSources = (): readonly string[] =>
  listFiles('src')
    .filter((file) => !file.endsWith('.d.ts'))
    .filter((file) => !file.endsWith('.test.ts') && !file.endsWith('.test.tsx'))
    .filter((file) => !file.endsWith('.check.ts'))

/** 在允许目录之外的源码里找违规行；`allowed(file)` 为真的是允许目录。 */
function violations(
  pattern: RegExp,
  allowed: (file: string) => boolean
): string[] {
  return pluginSources()
    .filter((file) => !allowed(file))
    .flatMap((file) => {
      const lines = readRepoFile(file).split('\n')
      return findViolations(lines.join('\n'), pattern).map(
        (line) => `${file}:${line}: ${lines[line - 1]?.trim() ?? ''}`
      )
    })
}

test('rule 1: orca/worker and orca/testing types only in src/worker/runtime (tests exempt)', () => {
  assert.deepEqual(violations(ORCA_HOST_IMPORT_PATTERN, inSeam), [])
})

test('rule 2: the bare orca import only in src/panel and src/worker/runtime', () => {
  assert.deepEqual(
    violations(ORCA_BARE_IMPORT_PATTERN, (file) => inSeam(file) || file.startsWith(PANEL_DIR)),
    []
  )
})

test('rule 3: the orca CLI is spawned only from src/worker/runtime', () => {
  assert.deepEqual(violations(ORCA_CLI_CALL_PATTERN, inSeam), [])
})

test('rule 4: host.call only from src/worker/runtime', () => {
  assert.deepEqual(violations(HOST_CALL_PATTERN, inSeam), [])
})

test('the scanners actually catch the shapes they forbid', () => {
  // 灵敏度自测：扫描器若漏掉这些形态，上面的规则测试就是假绿。
  assert.deepEqual(
    findViolations("import type { OrcaWorkerApi } from 'orca/worker'", ORCA_HOST_IMPORT_PATTERN),
    [1]
  )
  assert.deepEqual(findViolations("import { assert } from 'orca/testing'", ORCA_HOST_IMPORT_PATTERN), [1])
  assert.deepEqual(findViolations("import { atom } from 'orca'", ORCA_BARE_IMPORT_PATTERN), [1])
  assert.deepEqual(findViolations("import { atom } from 'orca'", ORCA_HOST_IMPORT_PATTERN), [])
  assert.deepEqual(findViolations("await spawn('orca', ['worktree'])", ORCA_CLI_CALL_PATTERN), [1])
  assert.deepEqual(findViolations("host.call('workspace.list')", HOST_CALL_PATTERN), [1])
  // 注释与说明文字不算违规。
  assert.deepEqual(findViolations('// we never call host.call( here', HOST_CALL_PATTERN), [])
  assert.deepEqual(findViolations(" * from 'orca' is forbidden here", ORCA_BARE_IMPORT_PATTERN), [])
})

test('the seam directory stays interface-only in this ticket', () => {
  // §B: 本票只建立接口与错误类型；实现（host-runtime/cli/fake-runtime）由后续票补齐。
  // `worker-api.ts` 是同一目录下的纯类型再导出（不含实现、不 host.call、不 spawn），
  // 让 `src/worker/main.ts` 只从 runtime 拿 `OrcaWorkerApi`。
  const runtimeFiles = listFiles('src/worker/runtime', '.ts').map((file) =>
    file.slice(file.lastIndexOf('/') + 1)
  )
  assert.deepEqual(runtimeFiles, ['host-methods.ts', 'orca-runtime.ts', 'worker-api.ts'])

  const workerApi = readRepoFile('src/worker/runtime/worker-api.ts')
  assert.equal(/\bhost\s*\.\s*call\s*\(/.test(workerApi), false, 'no host.call in worker-api.ts')
  assert.equal(/\bspawn\s*\(/.test(workerApi), false, 'no spawn in worker-api.ts')
  // 纯类型：每一行导出都是 `export type { … }` 形式。
  const nonCommentLines = workerApi
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|$)/.test(line))
  for (const line of nonCommentLines) {
    assert.ok(
      /^(?:export type \{|  [A-Za-z]|  [A-Za-z]+,|  [A-Za-z]+$|\} from)/.test(line),
      `worker-api.ts stays type-only: ${line}`
    )
  }
})

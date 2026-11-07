// 依赖方向与零 I/O（§C.2 规则 1–2、票面验收第四条）：源码扫描断言领域内核不 import 其他
// 源码目录、除 `node:crypto` 不用内置模块、不出现任何 I/O 形态；`sources/` 只经端口访问
// 引擎，`panel/` 不 import `src/worker/**`。
//
// 规则只认「真的会出现」的形态，并配灵敏度自测：扫描器若漏掉它们，这里就是假绿。
// `runtime-seam.test.ts` 负责 Orca 接触点（§C.2 规则 3–4），两者不重叠。
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import * as panelKit from 'orca/testing'
import { listFiles, readRepoFile } from './support/repo'

/** 仓库根（`tests/` 的上一级）。 */
const REPO_ROOT = join(import.meta.dirname, '..')

/** 递归列出目录下的 `.ts` 文件（相对仓库根，正斜杠分隔）。 */
function listSources(relative: string): string[] {
  const found: string[] = []
  const walk = (relativeDir: string): void => {
    for (const entry of readdirSync(join(REPO_ROOT, relativeDir), { withFileTypes: true })) {
      const child = `${relativeDir}/${entry.name}`
      if (entry.isDirectory()) walk(child)
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) found.push(child)
    }
  }
  walk(relative)
  return found.sort()
}

/** 去掉注释与字符串里的假阳性：只保留代码骨架（用于 I/O 形态扫描）。 */
function codeOnly(source: string): string[] {
  return source
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
    .map((line) => line.replace(/\/\/.*$/, ''))
}

/** 从代码里取出 import/export ... from 的模块名，以及动态 import() 的目标。 */
function importedModules(source: string): string[] {
  const modules: string[] = []
  const fromPattern = /(?:^|\n)\s*(?:import|export)\b[^;\n]*?\bfrom\s*['"]([^'"]+)['"]/g
  for (const match of source.matchAll(fromPattern)) modules.push(match[1] as string)
  const barePattern = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g
  for (const match of source.matchAll(barePattern)) modules.push(match[1] as string)
  const dynamicPattern = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const match of source.matchAll(dynamicPattern)) modules.push(match[1] as string)
  return modules
}

/** 一个文件是否在 core 目录之内（相对 import 的解析用）。 */
const isCoreFile = (file: string): boolean => file.startsWith('src/worker/core/')

/** 把相对 import 解析成仓库相对路径（只处理 core 里会出现的 `./x.ts` 形态）。 */
function resolveRelative(file: string, specifier: string): string {
  const base = file.slice(0, file.lastIndexOf('/'))
  const parts = `${base}/${specifier}`.split('/')
  const stack: string[] = []
  for (const part of parts) {
    if (part === '.' || part === '') continue
    if (part === '..') stack.pop()
    else stack.push(part)
  }
  return stack.join('/')
}

const CORE_FILES = listSources('src/worker/core')

describe('core imports nothing outside itself', () => {
  test('the kernel has a file set to scan', () => {
    // 本票交付的模块清单：少一个就说明扫描目标被改名或漏掉。
    assert.deepEqual(CORE_FILES, [
      'src/worker/core/assignments.ts',
      'src/worker/core/engine.ts',
      'src/worker/core/errors.ts',
      'src/worker/core/evals.ts',
      'src/worker/core/ids.ts',
      'src/worker/core/index.ts',
      'src/worker/core/intake.ts',
      'src/worker/core/memory.ts',
      'src/worker/core/model.ts',
      'src/worker/core/part.ts',
      'src/worker/core/ports.ts',
      'src/worker/core/reasons.ts',
      'src/worker/core/replies.ts',
      'src/worker/core/stage.ts',
      'src/worker/core/tickets.ts'
    ])
  })

  test('every module core imports is another core file or node:crypto', () => {
    const offenders = CORE_FILES.flatMap((file) =>
      importedModules(readFileSync(join(REPO_ROOT, file), 'utf8'))
        .filter((specifier) => {
          if (specifier === 'node:crypto') return false
          if (specifier.startsWith('./')) return !isCoreFile(resolveRelative(file, specifier))
          return true
        })
        .map((specifier) => `${file}: ${specifier}`)
    )
    assert.deepEqual(offenders, [])
  })

  test('node:crypto is the only builtin module, and only from ids.ts', () => {
    const builtinImports = CORE_FILES.flatMap((file) =>
      importedModules(readFileSync(join(REPO_ROOT, file), 'utf8'))
        .filter((specifier) => specifier.startsWith('node:'))
        .map((specifier) => `${file}: ${specifier}`)
    )
    assert.deepEqual(builtinImports, ['src/worker/core/ids.ts: node:crypto'])
  })

  test('core never imports the Orca runtime, the app layer, or the panel', () => {
    const offenders = CORE_FILES.flatMap((file) =>
      importedModules(readFileSync(join(REPO_ROOT, file), 'utf8'))
        .filter((specifier) =>
          specifier === 'orca' ||
          specifier.startsWith('orca/') ||
          specifier.startsWith('../runtime/') ||
          specifier.startsWith('../app/') ||
          specifier.startsWith('../infra/') ||
          specifier.startsWith('../sources/') ||
          specifier.startsWith('../executor/') ||
          specifier.startsWith('../../panel/')
        )
        .map((specifier) => `${file}: ${specifier}`)
    )
    assert.deepEqual(offenders, [])
  })
})

/** 零 I/O 的形态：出现任何一个都说明 core 做了副作用。 */
const IO_SHAPES: readonly { name: string; pattern: RegExp }[] = [
  { name: 'fs import', pattern: /\bfrom\s*['"]node:fs/ },
  { name: 'fs read', pattern: /\b(?:readFile|writeFile|appendFile|createReadStream|createWriteStream)\w*\s*\(/ },
  { name: 'sqlite', pattern: /\bDatabaseSync\b/ },
  { name: 'child process', pattern: /\b(?:spawn|spawnSync|exec|execFile|execFileSync)\s*\(/ },
  { name: 'http', pattern: /\bcreateServer\s*\(/ },
  { name: 'network fetch', pattern: /\bfetch\s*\(/ },
  { name: 'timers', pattern: /\b(?:setTimeout|setInterval|setImmediate)\s*\(/ },
  { name: 'async api', pattern: /\bnew\s+Promise\b|\bawait\s/ },
  { name: 'randomness', pattern: /\bMath\s*\.\s*random\s*\(/ },
  { name: 'ambient clock', pattern: /\bnew\s+Date\s*\(\s*\)/ }
]


// 依赖方向（§C.2 规则 3–6）：面板只依赖 `orca` 与 `panel/protocol.ts`；面板不 import worker，
// worker 不 import 面板。`dependency.test.ts` 是这条纪律的守门人。

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

panelKit.test('the panel imports only orca, its own files, and panel/protocol.ts', () => {
  const offenders = panelFiles().flatMap((file) =>
    specifiers(readRepoFile(file))
      .filter((specifier) => !(specifier === 'orca' || specifier.startsWith('./') || specifier.startsWith('../')))
      .map((specifier) => `${file}: ${specifier}`)
  )
  panelKit.assert.deepEqual(offenders, [])
})

panelKit.test('the panel never reaches into the worker', () => {
  // §C.2 规则 3 的原话：`panel/` 不 import `src/worker/**`。相对路径与包路径两种写法都挡。
  const offenders = panelFiles().flatMap((file) =>
    specifiers(readRepoFile(file))
      .filter((specifier) => specifier.includes('worker') && !specifier.startsWith('orca'))
      .map((specifier) => `${file}: ${specifier}`)
  )
  panelKit.assert.deepEqual(offenders, [])
})

panelKit.test('the worker imports only panel/protocol.ts from the panel, never a page or a widget', () => {
  // `protocol.ts` 是两侧共用的唯一契约（§M.6、票面），worker 读它是设计要的；
  // 其余面板文件（页面、组件、文案、样式）都只属于面板运行面，worker 读不到。
  const offenders = workerFiles().flatMap((file) =>
    specifiers(readRepoFile(file))
      .filter((specifier) => specifier.includes('panel'))
      .filter((specifier) => !/(?:^|\/)protocol(?:\.ts)?$/.test(specifier))
      .map((specifier) => `${file}: ${specifier}`)
  )
  panelKit.assert.deepEqual(offenders, [])
})

panelKit.test('the panel does not name the orca CLI seam nor the worker-only orca modules', () => {
  const offenders = panelFiles().flatMap((file) => {
    const source = readRepoFile(file)
    return [
      ...source.matchAll(/(?:from\s*|import\s*\(\s*)['"]orca\/(?:worker|testing)['"]/g)
    ].map((match) => `${file}: ${match[0]}`)
  })
  panelKit.assert.deepEqual(offenders, [])
})

panelKit.test('protocol.ts is a pure contract: no values beyond its declaration lists, no orca import', () => {
  const source = readRepoFile('src/panel/protocol.ts')
  panelKit.assert.equal(/from\s*['"]orca['"]/.test(source), false, 'protocol.ts imports no orca runtime value')
  panelKit.assert.equal(/\bhost\s*\.\s*call\s*\(/.test(source), false, 'no host.call in the panel')
  panelKit.assert.equal(/\bspawn\s*\(/.test(source), false, 'no subprocess in the panel')
  panelKit.assert.equal(/\bnode:/.test(source), false, 'no Node built-ins in the panel (it is sandboxed-ui)')
})


describe('sources reach the engine only through its ports', () => {
  const sourceFiles = (): string[] => {
    try {
      return listSources('src/worker/sources')
    } catch {
      // 本票还没有 sources 目录；扫描规则随第一个 Source 文件一起生效。
      return []
    }
  }

  test('no source file imports the app layer, the store or an engine implementation', () => {
    const offenders = sourceFiles().flatMap((file) =>
      importedModules(readFileSync(join(REPO_ROOT, file), 'utf8'))
        .filter(
          (specifier) =>
            specifier.startsWith('../app/') ||
            specifier.startsWith('../../app/') ||
            /(?:^|\/)store(?:\.ts)?$/.test(specifier)
        )
        .map((specifier) => `${file}: ${specifier}`)
    )
    assert.deepEqual(offenders, [])
  })
})

describe('core does no I/O', () => {
  for (const shape of IO_SHAPES) {
    test(`no ${shape.name}`, () => {
      const offenders = CORE_FILES.flatMap((file) =>
        codeOnly(readFileSync(join(REPO_ROOT, file), 'utf8'))
          .map((line, index) => ({ line, number: index + 1 }))
          .filter(({ line }) => shape.pattern.test(line))
          .map(({ line, number }) => `${file}:${number}: ${line.trim()}`)
      )
      assert.deepEqual(offenders, [])
    })
  }

  test('the scanner catches the shapes it forbids', () => {
    // 灵敏度自测：漏掉这些形态的扫描器会让上面十条变成假绿。
    const sample = [
      "import { readFileSync } from 'node:fs'",
      'const database = new DatabaseSync(path)',
      "spawn('orca', ['worktree'])",
      'await fetch(url)',
      'setTimeout(fn, 10)',
      'return new Promise(resolve => resolve(1))',
      'const started = new Date()'
    ].join('\n')
    const hit = IO_SHAPES.filter((shape) => shape.pattern.test(sample)).map((shape) => shape.name)
    assert.deepEqual(hit, [
      'fs import',
      'sqlite',
      'child process',
      'network fetch',
      'timers',
      'async api',
      'ambient clock'
    ])
    // 注释与说明文字不算：先按 `codeOnly` 去掉注释再扫。
    const comment = codeOnly('// we never call fetch( here')
    assert.equal(IO_SHAPES.some((shape) => comment.some((line) => shape.pattern.test(line))), false)
  })
})

describe('policy depends only on the domain and the minimal validator', () => {
  // §C.2：`policy → core, app/settings-types`。这里再钉紧一点：Policy 只许 import 领域类型、
  // 最小校验器 `infra/schema.ts` 与自己的文件——它不能反过来 import sources（那是环）。
  const policyFiles = (): string[] => listSources('src/worker/policy')

  test('the policy module has a file set to scan', () => {
    assert.deepEqual(policyFiles(), [
      'src/worker/policy/admission.ts',
      'src/worker/policy/assessment.ts',
      'src/worker/policy/gate.ts',
      'src/worker/policy/index.ts',
      'src/worker/policy/schema.ts'
    ])
  })

  test('no policy file imports the app layer, a source, the executor, the router or the runtime', () => {
    const allowed = (file: string, specifier: string): boolean => {
      if (specifier === 'node:crypto') return true
      if (!specifier.startsWith('.')) return false
      const resolved = resolveRelative(file, specifier)
      return (
        resolved.startsWith('src/worker/policy/') ||
        resolved.startsWith('src/worker/core/') ||
        resolved === 'src/worker/infra/schema.ts'
      )
    }
    const offenders = policyFiles().flatMap((file) =>
      importedModules(readFileSync(join(REPO_ROOT, file), 'utf8'))
        .filter((specifier) => !allowed(file, specifier))
        .map((specifier) => `${file}: ${specifier}`)
    )
    assert.deepEqual(offenders, [])
  })
})

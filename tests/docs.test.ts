// 文档门禁（§P.2 的 `docs.test.ts` 行；§C.1、§P.2、§R.2、附录 A、附录 B）。
//
// 断言的是「文档之间不许互相撒谎」，不是措辞：
// - 链接：README 与 `docs/**/*.md` 里每个本地链接都能解析，且不指到仓库外；编号文档只链接更早的；
// - 冲突标记：任何文档里都不许留下 `<<<<<<<` / `=======` / `>>>>>>>`；
// - 表：§C.1 的模块表覆盖 `src/` 下每个模块目录、且没有指向不存在路径的行；§P.2 的测试表与
//   §R.2 的可追溯表互相对得上（§R.2 自己写明「本表每一行的 Orca 对应都必须在 §P.2 出现」）；
// - README：十一项已知限制与 attribution 句逐字来自各自的单一来源（`LIMITATIONS`/`COPY` 与
//   附录 A），安装与故障排查的硬事实（命令、四项设置、三档/四码、`.codegraph` 陷阱、无 CI）
//   与代码、清单保持一致。
//
// 依赖纪律（§C.2）：测试读文件、读面板的纯数据模块，不碰 Orca、不碰 I/O 之外的世界。
import { assert, test } from 'orca/testing'
import { existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { COPY } from '../src/panel/copy'
import { LIMITATIONS } from '../src/panel/limitations'
import { REPO_ROOT, listFiles, readRepoFile, readRepoJson } from './support/repo'

/** 设计文档（本仓唯一的技术设计）。 */
const DESIGN = 'docs/design/orca-superagent.md'

/** 仓库里的全部文档：根上两份，其余在 `docs/` 下。 */
const DOCUMENTS: readonly string[] = ['README.md', 'AGENTS.md', ...listFiles('docs', '.md')]

/** 一个文档里的本地链接目标（去掉 `#fragment`，跳过外链与纯锚点）。 */
function linksOf(document: string): readonly string[] {
  return [...readRepoFile(document).matchAll(/\]\(([^)\s]+)\)/g)]
    .map((match) => (match[1] as string).split('#')[0] as string)
    .filter((target) => target !== '' && !/^[a-z]+:/i.test(target))
}

/** 设计文档里从标题 `from` 到下一个标题 `to` 之间的行（标题行本身包含在内）。 */
function designSection(from: string, to: string): readonly string[] {
  const lines = readRepoFile(DESIGN).split('\n')
  const start = lines.findIndex((line) => line.startsWith(from))
  assert.ok(start >= 0, `the design carries the heading ${from}`)
  const end = lines.findIndex((line, index) => index > start && line.startsWith(to))
  return lines.slice(start, end < 0 ? undefined : end)
}

/** 一节里的表格数据行（跳过表头与分隔行）。 */
function rowsOf(section: readonly string[]): readonly string[] {
  return section.filter((line) => line.startsWith('| ')).slice(2)
}

/** 一行表格的单元格（去掉首尾的空列）。 */
function cellsOf(row: string): readonly string[] {
  return row
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim())
}

/** 一个单元格里用反引号点名的名字。 */
function quotedIn(cell: string): readonly string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1] as string)
}

test('every local link in the README and the docs resolves inside the repository', () => {
  const root = resolve(REPO_ROOT)
  const broken: string[] = []
  for (const document of DOCUMENTS) {
    for (const target of linksOf(document)) {
      const linked = resolve(root, dirname(document), target)
      if (!existsSync(linked)) broken.push(`${document} → ${target}`)
      else if (relative(root, linked).startsWith('..')) broken.push(`${document} → ${target} (outside the repo)`)
    }
  }
  assert.deepEqual(broken, [])
  // 链接检查不能空转：README 至少指着设计文档与许可证。
  const readme = linksOf('README.md')
  assert.ok(readme.includes(DESIGN), 'the README links the design document')
  assert.ok(readme.includes('LICENSE'), 'the README links the license')
})

test('no document carries a merge conflict marker', () => {
  const marked = DOCUMENTS.filter((document) => /^(<{7}|={7}|>{7})( |$)/m.test(readRepoFile(document)))
  assert.deepEqual(marked, [])
})

test('numbered documents are consecutive from 000 and only link to earlier ones', () => {
  // 上游的 `docs/000`–`008` 在本仓收敛成一份设计文档，所以今天没有编号文档；规则仍在这里
  // 生效：一旦有人引入 `NNN-name.md`，编号必须从 000 连号，且只能链接更早的编号文档
  //（链接检查已在上一支里覆盖可解析性；这一支只禁「指向未来」的依赖）。
  const numbered = listFiles('docs', '.md')
    .map((path) => path.slice('docs/'.length))
    .filter((name) => /^\d{3}-[a-z0-9-]+\.md$/.test(name))
    .sort()
  assert.deepEqual(
    numbered.map((name) => name.slice(0, 3)),
    numbered.map((_, index) => String(index).padStart(3, '0')),
    'numbered documents run 000, 001, … without gaps'
  )
  const forward = numbered.flatMap((name) =>
    linksOf(`docs/${name}`).flatMap((target) => {
      const linked = target.split('/').pop() ?? ''
      if (!/^\d{3}-[a-z0-9-]+\.md$/.test(linked)) return []
      return Number(linked.slice(0, 3)) < Number(name.slice(0, 3)) ? [] : [`${name} → ${target}`]
    })
  )
  assert.deepEqual(forward, [], 'a numbered document links only to earlier numbered documents')
})

/** §C.1 的一个模块模式落在哪个目录（`core/*` → `src/worker/core`；`worker/main.ts` → `src/worker`）。 */
function moduleDir(pattern: string): string | null {
  for (const base of ['src/', 'src/worker/']) {
    const candidate = `${base}${pattern}`
    const star = candidate.indexOf('*')
    if (star >= 0) {
      const directory = candidate.slice(0, star).replace(/\/$/, '')
      if (existsSync(join(REPO_ROOT, directory))) return directory
      continue
    }
    if (existsSync(join(REPO_ROOT, candidate))) return dirname(candidate)
  }
  return null
}

/** §C 的目录树里点名的 `src/…` 文件（`src/bin/superagent.mjs` 只在树里，不在职责表里）。 */
function treeModuleDirs(): readonly string[] {
  return designSection('## C. 模块地图', '### C.1').flatMap((line) =>
    [...line.matchAll(/(src\/[\w./-]*\.[a-z]+)/g)].map((match) => dirname(match[1] as string))
  )
}

test('the §C.1 module table covers every module directory and names no missing path', () => {
  const patterns = rowsOf(designSection('### C.1', '### C.2')).flatMap((row) => quotedIn(cellsOf(row)[0] ?? ''))
  assert.ok(patterns.length >= 30, 'the module table lists the modules, not a sample of them')
  // 反向：表里的每一行都得指向真实存在的东西（死行比缺行更会误导人）。
  const unresolved = patterns.filter((pattern) => moduleDir(pattern) === null)
  assert.deepEqual(unresolved, [], 'every module row names a path that exists')
  // 正向：`src/` 下每个模块目录都在表里有一行（或写在 §C 的目录树里）。
  const covered = new Set([
    ...patterns.map(moduleDir).filter((directory): directory is string => directory !== null),
    ...treeModuleDirs()
  ])
  const directories = [...new Set(listFiles('src').map((path) => dirname(path).replace(/\\/g, '/')))]
  const undocumented = directories.filter((directory) => !covered.has(directory))
  assert.deepEqual(undocumented, [], 'every module directory has a row in the module table')
})

/**
 * §R.2 声明为一对一、但 §P.2 还没有对应行的上游测试面。#50（设计文档最终对齐）把这张表清空了：
 * 每一行要么补了 §P.2 的对应，要么在 §R.2 里改成「合并/删除」并在 §P.2 表末记为差异。
 * 留一个空数组是故意的——新出现的漂移会直接红。
 */
const R2_PENDING: readonly string[] = []

/** §P.2 里有没有这个名字（`sources-*` 这类写法按前缀匹配）。 */
function listedInP2(name: string, p2: string): boolean {
  return name.endsWith('*') ? p2.includes(name.slice(0, -1)) : p2.includes(name)
}

test('the §P.2 test table and the §R.2 traceability table agree', () => {
  const p2 = designSection('### P.2', '### P.3').join('\n')
  const r2 = designSection('### R.2', '## 附录 A')

  // (1) §R.2 → §P.2（§R.2 最后一行明写的核对方式）。
  const missing = rowsOf(r2).flatMap((row) =>
    quotedIn(cellsOf(row)[1] ?? '')
      .filter((name) => !R2_PENDING.includes(name) && !listedInP2(name, p2))
      .map((name) => `${name} (§R.2 says §P.2 carries it)`)
  )
  assert.deepEqual(missing, [])

  // (2) §P.2 的每一行都要能对上现实：点名的测试文件要么存在，要么能在 §R.2 找到（「已声明、
  // 尚未落地」必须可追溯，不能是笔误）；`panel-*.test.tsx` 这类模式至少命中一个真实文件。
  const tests = new Set(listFiles('tests').map((path) => path.slice('tests/'.length)))
  const r2Text = r2.join('\n')
  const names = rowsOf(designSection('### P.2', '### P.3')).flatMap((row) => quotedIn(cellsOf(row)[0] ?? ''))
  const unmatched = names.flatMap((name) => {
    const star = name.indexOf('*')
    if (star >= 0) {
      const prefix = name.slice(0, star)
      const suffix = name.slice(star + 1)
      const hits = [...tests].some((file) => file.startsWith(prefix) && file.endsWith(suffix))
      return hits ? [] : [`${name} matches no test file`]
    }
    if (tests.has(name)) return []
    if (!/\.test\.tsx?$/.test(name)) return [] // `panel.check.ts` 之类的非测试文件不在此列
    const stem = name.replace(/\.test\.tsx?$/, '')
    return r2Text.includes(stem) ? [] : [`${name} exists nowhere and §R.2 does not declare it`]
  })
  assert.deepEqual(unmatched, [])
})

test('README states all eleven limitations, in the design order, in the panel’s words', () => {
  const readme = readRepoFile('README.md')
  // §A.3 的十一项（不是十二条，也不是「待定」）：计数由单一来源给。
  assert.equal(LIMITATIONS.length, 11)
  let last = -1
  for (const item of LIMITATIONS) {
    const title = COPY[item.titleKey].zh
    const position = readme.indexOf(title)
    assert.ok(position >= 0, `README carries the limitation ${item.id}`)
    assert.ok(position > last, `README keeps the design order at ${item.id}`)
    last = position
    assert.ok(readme.includes(COPY[item.impactKey].zh), `README carries the impact of ${item.id}`)
    // 每条都指向 §H 差异表里查得到的行。
    assert.equal(item.refs.length > 0, true, `the limitation ${item.id} names its §H rows`)
  }
})

test('README carries the design appendix A attribution sentence verbatim', () => {
  // 独立真相是设计文档：把它附录 A 的引用块折成一行，README 必须逐字包含（作为引用块）。
  const quoted = designSection('## 附录 A', '## 附录 B')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('> '))
    .map((line) => line.slice(2))
    .join(' ')
  assert.ok(quoted.includes('deepseek-ai/dsh-superagent-prototype'), '附录 A carries the attribution sentence')
  assert.ok(quoted.includes('8c32a9dc5d72c033816c6a8110b37f40cf94fba4'), '附录 A pins the upstream commit')
  assert.ok(readRepoFile('README.md').includes(`> ${quoted}`), 'README repeats it word for word, as a blockquote')
})

test('README is installable from: commands, the four host settings, state layout, gates and the dev-install trap', () => {
  const readme = readRepoFile('README.md')
  const required = [
    // 安装：先看能力与内容哈希，再（开发）加载；`--approve` 是十项能力的审批入口。
    'orca plugin inspect . --json',
    'orca plugin dev load',
    '--approve',
    // `validate` 不是安装探针；它照旧是四道门禁之一。
    'orca plugin validate . --json',
    'scripts/check.sh',
    // 开发安装陷阱：插件根不能有多余条目，且钩子会重建 `.codegraph`。
    '.codegraph',
    'daemon.sock',
    'plugin_invalid',
    'approval_required',
    // CLI 入口与状态目录。
    'src/bin/superagent.mjs',
    'superagent setup check',
    'superagent doctor',
    'superagent status',
    // 凭据留在已有 CLI 里，插件不存 GitHub token / Feishu app secret。
    'lark-cli',
    // 没有 CI 的事实，原文如此。
    'no checks, repo has no workflows',
    // 设计文本的对齐交接：§A.3 的 11 项、§H 标「是」的 15 行、附录 B 的 11 + 4（附加近似），
    // 计数口径的单一来源是面板的 LIMITATIONS。
    'src/panel/limitations.ts',
    'H.14'
  ]
  const absent = required.filter((text) => !readme.includes(text))
  assert.deepEqual(absent, [])

  // 四项宿主设置的名字来自清单，不是 README 自己起的。
  const manifest = readRepoJson<{ contributes: { settings: { key: string }[] } }>('orca-plugin.json')
  assert.equal(manifest.contributes.settings.length, 4)
  for (const { key } of manifest.contributes.settings) {
    assert.ok(readme.includes(`\`${key}\``), `README names the host setting ${key}`)
  }

  // 故障排查要能照着查：doctor 三档、status 四码，各有一行。
  for (const state of ['ok', 'warn', 'fail']) {
    assert.ok(readme.includes(`| \`${state}\` |`), `README carries the doctor state ${state}`)
  }
  for (const code of ['0', '1', '2', '3']) {
    assert.ok(readme.includes(`| \`${code}\` |`), `README carries the status exit code ${code}`)
  }
})

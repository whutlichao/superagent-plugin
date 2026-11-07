// 类、函数与模块的文档纪律（§P.2 的 `class-docs.test.ts` 行，对应上游 `class-docs.spec.ts`）：
// `src/worker/**` 与 `src/panel/**` 里每个导出类、每个导出具名函数都要在声明正上方有一段
// JSDoc（`/** … */`），每个模块的首部都要有一段说明「它是什么、守哪几条纪律」的文档注释。
//
// 为什么符号必须是 JSDoc、模块首部两种写法都算：本仓 187 个源码文件的既有风格是文件顶上一段
// `//` 散文，符号则一律用 `/** … */`（598 个导出符号全部如此）。把 187 个首部统一改写成 JSDoc
// 是一场只动注释、覆盖每个文件的大 diff，与所有在飞的工单互相冲突，却不带来任何新信息；
// 这条纪律要锁的是「模块开头有一段说明」，`//` 与 `/** */` 都满足它。符号不同：JSDoc 是仓库
// 既有惯例，也只有它能被编辑器、hover 与生成的文档读到。
//
// 扫描器与 `dependency.test.ts` 同一口径：正则读源码、不引 parser，测试与 `*.check.ts` 情景
// 豁免（它们只活在测试面）。不用 TypeScript 自己的 parser 是有原因的：`scripts/check.sh` 在没有
// `node_modules` 的全新克隆上也要能跑，所以测试不能 import `typescript`。规则配灵敏度自测——
// 扫描器若漏掉「没注释的类 / 函数 / 模块」，上面两条断言就是假绿。
//
// 射程：声明形式的导出——`export class` 与 `export function`（含 `abstract` / `async` /
// `default`）。挂在 `export const` 上的箭头函数不在射程：那是值不是具名函数声明，仓库里有 33 个，
// 其中 `app/kv.ts` 的 7 个键名构造器共用一段家族注释（§D.3），逐个再要求 JSDoc 只会把那段
// 注释拆成七句同义话。要扩到它们，先扩票面。
import { assert, test } from 'orca/testing'
import { listFiles, readRepoFile } from './support/repo'

/**
 * 允许没有 JSDoc 的导出符号（`文件:名字`）与它们的理由。每条必须是「为什么可以没有」，
 * 不是「暂时不想写」——能补注释的就补，票面写的是「补注释而不是放宽规则」。今天为空：
 * 规则落地时 598 个导出符号全部满足，留一个空数组是故意的，新增的缺注释会直接红。
 */
const EXEMPT: readonly { readonly symbol: string; readonly reason: string }[] = []

/** 一个待检查的导出符号：声明所在的行（1 起）、种类与名字。 */
interface ExportedSymbol {
  readonly file: string
  readonly line: number
  readonly kind: 'class' | 'function'
  readonly name: string
}

/** 扫描目标：worker 与面板的源码（测试与 `*.check.ts` 情景豁免，口径同 `dependency.test.ts`）。 */
function sourceFiles(): readonly string[] {
  const skip = (file: string): boolean =>
    /\.test\.tsx?$/.test(file) || file.endsWith('.check.ts') || file.endsWith('.d.ts')
  return [...listFiles('src/worker'), ...listFiles('src/panel')].filter((file) => !skip(file))
}

/** 一段注释块里的散文：去掉块注释的开符与闭符、每行开头的 `*` 或 `//`，用来判断它不是空壳。 */
function proseOf(block: readonly string[]): string {
  return block
    .join('\n')
    .split('\n')
    .map((line) =>
      line
        .trim()
        .replace(/^\/\*\*/, '')
        .replace(/^\/\//, '')
        .replace(/^\*/, '')
        .replace(/\*\/$/, '')
        .trim()
    )
    .join(' ')
    .trim()
}

/**
 * 声明正上方的 JSDoc 块（隔空行也算「正上方」：这条规则管文档在不在，不管空行）；没有就返回
 * `null`。单星号的块注释不是 JSDoc，内容为空的 `/**` 块也不算。
 */
function jsdocAbove(lines: readonly string[], index: number): readonly string[] | null {
  let last = index - 1
  while (last >= 0 && (lines[last] ?? '').trim() === '') last--
  if (last < 0 || !(lines[last] ?? '').trimEnd().endsWith('*/')) return null
  let first = last
  while (first >= 0 && !(lines[first] ?? '').trimStart().startsWith('/*')) first--
  if (first < 0 || !(lines[first] ?? '').trimStart().startsWith('/**')) return null
  const block = lines.slice(first, last + 1)
  return proseOf(block) === '' ? null : block
}

/** 模块首部的说明块：文件顶上连续的 `//` 散文，或以 `/**` 开头的块；没有就返回 `null`。 */
function headBlock(lines: readonly string[]): readonly string[] | null {
  const start = lines.findIndex((line) => (line ?? '').trim() !== '')
  if (start < 0) return null
  const first = (lines[start] ?? '').trimStart()
  if (first.startsWith('/**')) {
    const end = lines.findIndex((line, index) => index >= start && (line ?? '').includes('*/'))
    if (end < 0) return null
    const block = lines.slice(start, end + 1)
    return proseOf(block) === '' ? null : block
  }
  if (!first.startsWith('//')) return null
  const block: string[] = []
  for (let index = start; index < lines.length; index++) {
    if (!(lines[index] ?? '').trimStart().startsWith('//')) break
    block.push(lines[index] as string)
  }
  return block
}

/** 一行的导出声明形状：`export` 之后可带 `abstract` / `async` / `default`。 */
const EXPORT_DECLARATION =
  /^\s*export\s+(?:abstract\s+|async\s+|default\s+)*(class|function)\s+([A-Za-z0-9_$]+)/

/** 一个文件里的全部导出类与导出具名函数。 */
function symbolsOf(file: string, lines: readonly string[]): readonly ExportedSymbol[] {
  return lines.flatMap((line, index) => {
    const match = EXPORT_DECLARATION.exec(line)
    if (match === null) return []
    return [
      {
        file,
        line: index + 1,
        kind: match[1] as ExportedSymbol['kind'],
        name: match[2] as string
      }
    ]
  })
}

/** 扫描到的文件与它们的行（只读一次源码）。 */
const SCANNED = sourceFiles().map((file) => ({ file, lines: readRepoFile(file).split('\n') }))

/** 全部待检查的导出符号。 */
const SYMBOLS = SCANNED.flatMap(({ file, lines }) => symbolsOf(file, lines))

/** `文件:名字`：豁免表与失败信息用同一个键。 */
const keyOf = (file: string, name: string): string => `${file}:${name}`

test('the scan covers the worker and the panel, and finds the symbols it checks', () => {
  // 不空转：目录改名、扫描器坏掉或 `listFiles` 漏掉一类后缀，下面两条都会变成假绿。
  assert.ok(SCANNED.length >= 180, `the scan reads the sources: ${SCANNED.length}`)
  assert.ok(SYMBOLS.length >= 550, `the scan finds the exported symbols: ${SYMBOLS.length}`)
  const files = new Set(SCANNED.map(({ file }) => file))
  for (const file of ['src/worker/executor/resume.ts', 'src/worker/main.ts', 'src/panel/panel.tsx']) {
    assert.ok(files.has(file), `the scan covers ${file}`)
  }
  // 被豁免的文件确实不在扫描里（否则「跳过测试」这条豁免无从核对）。
  assert.equal(files.has('src/panel/panel.check.ts'), false, 'check scenarios are not sources')
})

test('every exported class and named function carries a JSDoc block', () => {
  const offenders = SCANNED.flatMap(({ file, lines }) =>
    symbolsOf(file, lines)
      .filter((symbol) => jsdocAbove(lines, symbol.line - 1) === null)
      .filter((symbol) => !EXEMPT.some((entry) => entry.symbol === keyOf(file, symbol.name)))
      .map((symbol) => `${file}:${symbol.line} ${symbol.kind} ${symbol.name}`)
  )
  assert.deepEqual(offenders, [], 'a doc block, or an entry in EXEMPT with a reason')
})

test('every module opens with a documentation block', () => {
  const offenders = SCANNED.filter(({ lines }) => headBlock(lines) === null).map(({ file }) => file)
  assert.deepEqual(offenders, [], 'a module says what it is before it says what it does')
})

test('the scanner catches the shapes it forbids', () => {
  // 灵敏度自测：漏掉这些形态的扫描器会让上面两条断言变成假绿。
  const lines = (source: string): readonly string[] => source.split('\n')
  // 符号：JSDoc 算数，`//`、`/* */`、空壳 JSDoc 与「什么都没有」都不算。
  const documented = lines('/** 导出给组合根用的启动函数。 */\nexport function launch(): void {}')
  assert.ok(jsdocAbove(documented, 1) !== null, 'a JSDoc block above a function counts')
  const multiline = lines(['/**', ' * 两行的 JSDoc。', ' */', '', 'export class Worker {}'].join('\n'))
  assert.ok(jsdocAbove(multiline, 4) !== null, 'a multi-line JSDoc block counts, blank line or not')
  for (const [reason, source, index] of [
    ['a line comment', '// 只是行注释\nexport class Worker {}', 1],
    ['a plain block', '/* 不是 JSDoc */\nexport class Worker {}', 1],
    ['an empty JSDoc', '/** */\nexport class Worker {}', 1],
    ['nothing at all', 'export function launch(): void {}', 0]
  ] as const) {
    assert.equal(jsdocAbove(lines(source), index), null, `${reason} is not a JSDoc block`)
  }
  // 模块首部：`//` 散文与 JSDoc 都算数，直接以代码开头则不算。
  assert.ok(headBlock(lines('// 模块说明\n\nimport x from \'y\'')) !== null, 'a line-comment head counts')
  assert.ok(headBlock(lines('/** 模块说明 */\nimport x from \'y\'')) !== null, 'a JSDoc head counts')
  assert.equal(headBlock(lines("import x from 'y'")), null, 'a module that starts with code has no head')
  assert.equal(headBlock(lines('')), null, 'an empty module has no head')
  // 导出声明：三种前缀都认，非导出的声明不管。
  const declarations = lines(
    [
      'export class A {}',
      'export abstract class B {}',
      'export async function c() {}',
      'export default function activate() {}',
      'class Unused {}'
    ].join('\n')
  )
  assert.deepEqual(
    symbolsOf('f.ts', declarations).map((symbol) => `${symbol.kind} ${symbol.name}`),
    ['class A', 'class B', 'function c', 'function activate']
  )
})

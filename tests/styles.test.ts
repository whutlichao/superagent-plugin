// 面板的样式通道（§M.4「无 style/className」+ references/host-api.md「Theme variables in frames」）。
//
// 事实来源：
// - 组件面板没有 DOM，样式只能来自 Orca 的语义 prop（Tone / Gap / Size）与宿主主题；
//   面板源码里不许出现 `style=`、`className=`，也不许出现调色板字面量。
// - 若将来出现样式表（例如换成 HTML 面板），它只能读 `--orca-*` 主题变量，不能自带颜色、
//   字号或圆角——否则浅色/深色切换下会失真（票面「CSS variables only, no hard-coded palette」）。
import { assert, test } from 'orca/testing'
import { listFiles, readRepoFile } from './support/repo'

/** Orca 主题提供的变量（references/host-api.md 的清单）。 */
const THEME_VARIABLES = [
  '--orca-background',
  '--orca-foreground',
  '--orca-card',
  '--orca-card-foreground',
  '--orca-popover',
  '--orca-popover-foreground',
  '--orca-primary',
  '--orca-primary-foreground',
  '--orca-secondary',
  '--orca-secondary-foreground',
  '--orca-muted',
  '--orca-muted-foreground',
  '--orca-accent',
  '--orca-accent-foreground',
  '--orca-destructive',
  '--orca-destructive-foreground',
  '--orca-border',
  '--orca-input',
  '--orca-ring',
  '--orca-radius'
]

/** Orca 的 Tone 档位：面板能表达「颜色」的唯一方式。 */
const TONES = ['neutral', 'accent', 'success', 'warning', 'danger']

/** 面板源码（`.ts` 与 `.tsx`）。 */
const panelSources = (): readonly { file: string; source: string }[] =>
  listFiles('src/panel')
    .filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'))
    .map((file) => ({ file, source: readRepoFile(file) }))

/** 面板里的样式表（今天没有：组件面板没有 DOM）。 */
const panelStylesheets = (): readonly string[] =>
  listFiles('src/panel').filter((file) => file.endsWith('.css'))

/** 一段文本里的调色板字面量：十六进制、rgb()/hsl()，以及颜色属性的具名颜色。 */
function paletteLiterals(text: string): string[] {
  const plain = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const hits = [
    ...plain.matchAll(/#[0-9a-fA-F]{3,8}\b/g),
    ...plain.matchAll(/\b(?:rgba?|hsla?)\s*\(/g)
  ].map((match) => match[0])
  const colourValues = [
    ...plain.matchAll(/(?:color|background|border-color|fill|stroke)\s*[:=]\s*['"`]?([^;'"`}\n]+)/g)
  ]
  for (const value of colourValues) {
    for (const named of (value[1] as string).matchAll(
      /\b(?:white|black|red|green|blue|gray|grey|orange|yellow|purple)\b/g
    )) {
      hits.push(named[0])
    }
  }
  return hits
}

test('a components panel ships no stylesheet: it has no DOM to style', () => {
  // 若哪天换成 HTML 面板，这条会连同下面的变量规则一起被有意改写，而不是无声加一份样式表。
  assert.deepEqual(panelStylesheets(), [])
})

test('no stylesheet, if one is ever added, may carry its own palette or read a non-theme variable', () => {
  // 逐份真实样式表跑同一条规则（今天为零份，规则本身由下面两条样本测试钉住）。
  for (const file of panelStylesheets()) {
    const css = readRepoFile(file)
    assert.deepEqual(paletteLiterals(css), [], `${file} hard-codes no palette`)
    const used = [...css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((match) => match[1] as string)
    assert.deepEqual(used.filter((name) => !THEME_VARIABLES.includes(name)), [], `${file} reads theme variables`)
  }
  // 样本：规则真的会抓住硬编码，不是空跑。
  assert.deepEqual(paletteLiterals('.sa-badge { color: #ff0000 }'), ['#ff0000'])
  assert.deepEqual(paletteLiterals('.sa-badge { color: rgb(0 0 0) }'), ['rgb('])
  assert.deepEqual(paletteLiterals('.sa-badge { color: white }'), ['white'])
  assert.deepEqual(paletteLiterals('.sa-badge { color: var(--orca-foreground) }'), [])
})

test('panel sources hard-code no palette', () => {
  const offenders = panelSources().flatMap(({ file, source }) =>
    paletteLiterals(source).map((literal) => `${file}: ${literal}`)
  )
  assert.deepEqual(offenders, [])
})

test('panel sources use no inline style or class-name channel', () => {
  const offenders = panelSources().flatMap(({ file, source }) =>
    [...source.matchAll(/\b(?:className|style)\s*=/g)].map((match) => `${file}: ${match[0]}`)
  )
  assert.deepEqual(offenders, [])
})

test('every tone the panel asks for is one Orca draws', () => {
  const used = panelSources().flatMap(({ file, source }) =>
    [...source.matchAll(/\btone=(?:"([a-z]+)"|\{'([a-z]+)'\})/g)].map((match) => ({
      file,
      tone: (match[1] ?? match[2]) as string
    }))
  )
  assert.deepEqual(used.filter(({ tone }) => !TONES.includes(tone)), [])
})

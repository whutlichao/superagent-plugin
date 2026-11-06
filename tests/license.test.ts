// 许可证与归属（§附录 A）：MIT 文本落位，README 的署名句与设计附录 A 逐字一致。
import { assert, test } from 'orca/testing'
import { readRepoFile } from './support/repo'

/** §附录 A 里的署名句（逐字）。 */
const ATTRIBUTION =
  'Ported from `deepseek-ai/dsh-superagent-prototype` (MIT, Copyright DeepSeek), commit ' +
  '`8c32a9dc5d72c033816c6a8110b37f40cf94fba4`. The Orca adaptation changes the host integration; ' +
  'the domain rules, prompts and documents are derived from that prototype.'

/** 设计文档里的附录 A 段。 */
function appendixA(): string {
  const design = readRepoFile('docs/design/orca-superagent.md')
  const start = design.indexOf('## 附录 A')
  const end = design.indexOf('## 附录 B')
  assert.ok(start >= 0 && end > start, 'design carries 附录 A before 附录 B')
  return design.slice(start, end)
}

test('the design attribution sentence is the one README must carry', () => {
  // 独立真相：从设计文档里取出那句 `> Ported from …`，去掉引用标记与换行折叠。
  const quoted = appendixA()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('> '))
    .map((line) => line.slice(2))
    .join(' ')
  assert.ok(quoted.includes(ATTRIBUTION), 'design sentence matches the expected text')
})

test('README carries the attribution sentence verbatim, as a blockquote', () => {
  // §附录 A 用引用块给出该句；README 以同样形态保留（逐字）。
  assert.ok(readRepoFile('README.md').includes(`> ${ATTRIBUTION}`))
})

test('LICENSE keeps the upstream MIT text', () => {
  const license = readRepoFile('LICENSE')
  assert.ok(license.startsWith('MIT License'))
  assert.ok(license.includes('Copyright (c) 2026 DeepSeek Harness Team'))
  assert.ok(license.includes('Permission is hereby granted, free of charge'))
  assert.ok(license.includes('THE SOFTWARE IS PROVIDED "AS IS"'))
})

test('the manifest declares the MIT license', () => {
  const manifest = JSON.parse(readRepoFile('orca-plugin.json')) as { license: string }
  assert.equal(manifest.license, 'MIT')
})

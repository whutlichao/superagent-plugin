// 门禁脚本（§P.5）：四道门禁依次执行，`orca plugin types .` 记为已知缺陷并忽略。
import { assert, test } from 'orca/testing'
import { readRepoFile } from './support/repo'

const script = readRepoFile('scripts/check.sh')

/** 脚本里出现的门禁命令（按出现顺序；允许缩进，额外类型检查缩进在探针函数里）。 */
function gateCommands(source: string): string[] {
  return [...source.matchAll(/^\s*run_gate\s+"([^"]+)"\s+(.+)$/gm)].map(
    (match) => `${match[1]} :: ${(match[2] as string).trim()}`
  )
}

test('runs the four gates in the design order', () => {
  // 四个基线门禁的先后顺序，忽略条件性的额外类型检查。
  const baseline = gateCommands(script).filter((line) => !line.startsWith('extra typecheck'))
  assert.deepEqual(baseline, [
    'self-contained typecheck :: run_tsc -p .',
    'plugin tests :: orca plugin test . --json',
    'panel check :: orca plugin check . --json',
    'manifest validation :: orca plugin validate . --json'
  ])
})

test('records orca plugin types as a known defect instead of failing', () => {
  assert.ok(script.includes('orca plugin types .'), 'probes the types command')
  assert.ok(script.includes('Known defect, ignored'), 'labels the failure as known')
  assert.ok(
    script.includes('Re-check after an Orca upgrade with: orca plugin types . --json && ls .orca/types'),
    'prints the re-check line'
  )
  // 已知缺陷探针不得进入 FAILED 计数：只有 run_gate 里的失败会加一。
  const probeBlock = script.slice(
    script.indexOf('probe_plugin_types() {'),
    script.indexOf('probe_plugin_types()\n\nrun_gate')
  )
  assert.equal(probeBlock.includes('FAILED=$((FAILED + 1))'), false)
})

test('appends an extra typecheck only when the types command succeeds', () => {
  assert.ok(
    script.includes('if [[ $code -eq 0 && -d .orca/types ]]'),
    'extra check is conditional on the types command succeeding'
  )
  assert.ok(script.includes('run_extra_typecheck'), 'extra typecheck exists')
  // 基线仍是自包含配置：额外的 tsconfig 只在临时文件里 extends 生成的配置。
  assert.ok(script.includes('"extends": "./.orca/types/tsconfig.json"'))
  // 额外检查通过 run_gate 执行，因此它的失败会真的让脚本失败。
  assert.ok(
    gateCommands(script).some((line) => line.startsWith('extra typecheck')),
    'the extra typecheck runs through run_gate'
  )
})

test('keeps the self-contained typecheck as the baseline even without node_modules', () => {
  assert.ok(script.includes('node_modules/.bin/tsc'))
  assert.ok(script.includes('npx --yes --package typescript@5.9.2 -- tsc'))
})

test('exits non-zero when any gate fails', () => {
  assert.ok(script.includes('exit 1'), 'fails when a gate failed')
  assert.ok(script.includes('exit 0'), 'succeeds when all gates passed')
})

test('is executable so a fresh clone can run it directly', () => {
  // 权限位不在文件内容里；用 git 的索引读它（未提交时退化为检查 shebang）。
  assert.ok(script.startsWith('#!/usr/bin/env bash'))
})

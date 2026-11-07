// 门禁脚本（§P.5）：四道基线门禁是唯一的失败来源；`orca plugin types .` 的探针成功时
// 追加一次生成类型的额外检查（informational，不影响退出码），失败时记为已知缺陷（同样不影响）。
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { readRepoFile } from './support/repo'

const script = readRepoFile('scripts/check.sh')

/** 脚本里出现的门禁命令（按出现顺序；允许缩进）。 */
function gateCommands(source: string): string[] {
  return [...source.matchAll(/^\s*run_gate\s+"([^"]+)"\s+(.+)$/gm)].map(
    (match) => `${match[1]} :: ${(match[2] as string).trim()}`
  )
}

/** 脚本里出现的参考用检查（`run_info`：打印但不计入退出码）。 */
function infoCommands(source: string): string[] {
  return [...source.matchAll(/^\s*run_info\s+"([^"]+)"\s+(.+)$/gm)].map(
    (match) => `${match[1]} :: ${(match[2] as string).trim()}`
  )
}

/** 取源码里某个 shell 函数的函数体（从声明到下一个顶层 `}` 前）。 */
function functionBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration)
  assert.ok(start >= 0, `${declaration} exists`)
  const rest = source.slice(start)
  const end = rest.indexOf('\n}\n')
  return end < 0 ? rest : rest.slice(0, end)
}

/** 一次脚本运行的观测结果（子进程失败时 `execFileSync` 会抛，所以统一用 try 捕获）。 */
interface Run {
  readonly status: number
  readonly output: string
  readonly root: string
}

/** 跑一次真实的 `check.sh`：只有脚本自己（bash + 两个假替身），不碰真的 Orca 与 tsc。 */
function runCheckScript(options: {
  /** `orca plugin types` 的退出码；0 时替身会写出 `.orca/types/tsconfig.json`。 */
  typesExit: number
  /** 让哪条 orca 门禁失败（`test`/`check`/`validate`；不传则都通过）。 */
  failGate?: string
  /** 针对生成配置的额外类型检查的退出码。 */
  extraTypecheckExit: number
}): Run {
  const root = mkdtempSync(join(tmpdir(), 'check-script-'))
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(join(root, 'scripts', 'check.sh'), script)
  chmodSync(join(root, 'scripts', 'check.sh'), 0o755)

  // 假 tsc：基线（`-p .`）通过，只有针对 `.orca/types` 生成配置的那次按 FAKE_EXTRA_TSC_EXIT。
  const bin = join(root, 'node_modules', '.bin')
  mkdirSync(bin, { recursive: true })
  const tsc = join(bin, 'tsc')
  writeFileSync(
    tsc,
    [
      '#!/usr/bin/env bash',
      'for arg in "$@"; do',
      '  if [[ "$arg" == "./tsconfig.orca.json" ]]; then exit "${FAKE_EXTRA_TSC_EXIT:-0}"; fi',
      'done',
      'exit 0',
      ''
    ].join('\n')
  )
  chmodSync(tsc, 0o755)

  // 假 orca：`plugin types` 按 FAKE_TYPES_EXIT（成功时写出生成配置），其余门禁按 FAKE_FAIL_GATE。
  mkdirSync(join(root, 'bin'), { recursive: true })
  const orca = join(root, 'bin', 'orca')
  writeFileSync(
    orca,
    [
      '#!/usr/bin/env bash',
      'if [[ "${1:-} ${2:-}" == "plugin types" ]]; then',
      '  if [[ "${FAKE_TYPES_EXIT:-0}" == "0" ]]; then',
      '    mkdir -p .orca/types && printf \'{}\\n\' > .orca/types/tsconfig.json',
      '  fi',
      '  printf \'{"ok": %s}\\n\' "$([[ ${FAKE_TYPES_EXIT:-0} == 0 ]] && echo true || echo false)"',
      '  exit "${FAKE_TYPES_EXIT:-0}"',
      'fi',
      'if [[ -n "${FAKE_FAIL_GATE:-}" && "${2:-}" == "${FAKE_FAIL_GATE}" ]]; then',
      '  printf \'{"ok": false}\\n\'',
      '  exit 1',
      'fi',
      'printf \'{"ok": true}\\n\'',
      'exit 0',
      ''
    ].join('\n')
  )
  chmodSync(orca, 0o755)

  const bash = join(root, 'scripts', 'check.sh')
  const env = {
    PATH: `${join(root, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    HOME: process.env.HOME ?? root,
    FAKE_TYPES_EXIT: String(options.typesExit),
    FAKE_FAIL_GATE: options.failGate ?? '',
    FAKE_EXTRA_TSC_EXIT: String(options.extraTypecheckExit)
  }
  try {
    const stdout = execFileSync('bash', [bash], {
      cwd: root,
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { status: 0, output: stdout, root }
  } catch (error) {
    const failure = error as { status?: unknown; stdout?: unknown; stderr?: unknown }
    const stdout = typeof failure.stdout === 'string' ? failure.stdout : ''
    const stderr = typeof failure.stderr === 'string' ? failure.stderr : ''
    return { status: typeof failure.status === 'number' ? failure.status : -1, output: `${stdout}${stderr}`, root }
  }
}

test('runs exactly the four baseline gates in the design order', () => {
  // 基线门禁的顺序就是设计顺序；额外类型检查走 `run_info`，不在这张表里。
  assert.deepEqual(gateCommands(script), [
    'self-contained typecheck :: run_tsc -p .',
    'plugin tests :: orca plugin test . --json',
    'panel check :: orca plugin check . --json',
    'manifest validation :: orca plugin validate . --json'
  ])
})

test('records a failing orca plugin types as a known defect instead of failing', () => {
  assert.ok(script.includes('orca plugin types .'), 'probes the types command')
  assert.ok(script.includes('Known defect, ignored'), 'labels the failure as known')
  assert.ok(
    script.includes('Re-check after an Orca upgrade with: orca plugin types . --json && ls .orca/types'),
    'prints the re-check line'
  )
  // 失败分支不跑额外检查，也不进入 FAILED 计数：只有 run_gate 里的失败会加一。
  const probe = functionBody(script, 'probe_plugin_types() {')
  assert.equal(probe.includes('FAILED=$((FAILED + 1))'), false)
  assert.equal(probe.includes('run_gate '), false, 'the probe never runs a gate')
})

test('runs the generated-type check as informational when the types command succeeds', () => {
  assert.ok(
    script.includes('if [[ $code -eq 0 && -d .orca/types ]]'),
    'the extra check is conditional on the types command succeeding'
  )
  assert.ok(script.includes('run_extra_typecheck'), 'the extra typecheck exists')
  // 基线仍是自包含配置：额外的 tsconfig 只在临时文件里 extends 生成的配置。
  assert.ok(script.includes('"extends": "./.orca/types/tsconfig.json"'))
  // 额外检查走 run_info：打印标题、命令与退出码，但绝不计入 FAILED。
  const extra = infoCommands(script)
  assert.equal(extra.length, 1, 'one informational check')
  assert.ok(extra[0]?.startsWith('extra typecheck'), 'the informational check is the extra typecheck')
  assert.equal(
    gateCommands(script).some((line) => line.startsWith('extra typecheck')),
    false,
    'the extra typecheck is never a gate'
  )
  assert.equal(functionBody(script, 'run_info() {').includes('FAILED=$((FAILED + 1))'), false)
  assert.ok(script.includes('informational'), 'the output says the check is informational')
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

test('exits 0 when the generated-type check disagrees but every baseline gate passes', () => {
  const { status, output, root } = runCheckScript({ typesExit: 0, extraTypecheckExit: 2 })
  try {
    assert.ok(output.includes('extra typecheck'), 'the extra check ran')
    assert.ok(
      output.includes('-> exit 2 (informational — does not affect the exit code)'),
      'the extra check reports its exit code as informational'
    )
    assert.equal(output.includes('!! gate failed'), false, 'no gate was blamed')
    assert.ok(output.includes('All gates passed.'))
    assert.equal(status, 0, 'the four baseline gates decide the exit code')
    // 临时 tsconfig 用完就删，不在插件根留东西。
    assert.equal(existsSync(join(root, 'tsconfig.orca.json')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('exits 1 when a baseline gate fails, even though the generated-type check is informational', () => {
  const { status, output, root } = runCheckScript({
    typesExit: 0,
    failGate: 'test',
    extraTypecheckExit: 0
  })
  try {
    assert.ok(output.includes('!! gate failed: plugin tests'))
    assert.ok(output.includes('1 gate(s) failed.'))
    assert.equal(status, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('stays usable when a future Orca breaks orca plugin types again', () => {
  const { status, output, root } = runCheckScript({ typesExit: 1, extraTypecheckExit: 0 })
  try {
    assert.ok(output.includes('Known defect, ignored'), 'the failure is recorded, not fatal')
    assert.equal(output.includes('extra typecheck'), false, 'the extra check is skipped')
    assert.ok(output.includes('All gates passed.'))
    assert.equal(status, 0, 'the types failure never changes the exit code')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

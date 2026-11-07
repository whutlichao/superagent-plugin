// `doctor` 的逐项结论与「只报有没有，不报是什么」（票面 acceptance 第 5 条、§G.2、§O）。
//
// 七项：token / port / lock / database / cli / gh / lark，每项 `ok | warn | fail`。
// 断言的是**结论与不泄漏**，不是文案细节：`detail` 的一句话会变，`state` 与「不含 token 值」
// 不会变。外部命令（gh / lark-cli）一律用注入的 runner，绝不在这台机器上真登录/真联网。
import { assert, test } from 'orca/testing'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runDoctor, botStatus, defaultPortProbe } from '../src/worker/app/doctor'
import { DeadlineError } from '../src/worker/infra/deadline'
import {
  DOCTOR_STATES,
  doctorExitCode,
  doctorResult,
  orderChecks,
  stateRank,
  summarize
} from '../src/worker/app/doctor-types'
import { GITCONFIG_MODE, workerGitConfigPath, writeWorkerGitConfig } from '../src/worker/infra/gitconfig'
import type { DoctorCheck } from '../src/worker/http/api-types'
import { openStore } from '../src/worker/app/store'
import { SCHEMA_VERSION } from '../src/worker/app/schema'
import { acquireLock } from '../src/worker/infra/lock'
import { ensureApiToken, TOKEN_MODE } from '../src/worker/infra/tokens'
import { DEFAULT_PORT, PORT_FILE } from '../src/worker/http/port-file'
import { tempStateDir } from './support/state'
import { closedPort } from './support/ports'

/** 固定的测试时刻（doctor 的 `at` 与锁的年龄都按它算）。 */
const AT = '2026-11-07T03:26:00.000Z'

/** 跑一次 doctor，端口探测与外部命令都给确定的假结果。 */
async function doctorOf(
  stateDir: string,
  options: {
    readonly gh?: 'ok' | 'signed-out' | 'missing'
    readonly lark?: 'ready' | 'missing' | 'no-bot' | 'missing-cli'
    readonly portOpen?: boolean
    readonly cliPath?: string
    /** 库的只读自检（生产由 `Store.inspect` 提供；不给就是「还没建库」）。 */
    readonly inspect?: () => {
      readonly path: string
      readonly schemaVersion: number
      readonly pluginVersion: number
      readonly tables: number
      readonly bytes: number
    }
  } = {}
) {
  const run = async (program: string, args: readonly string[]): Promise<string> => {
    if (program === 'gh') {
      if (options.gh === 'missing') throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
      if (options.gh === 'signed-out') throw new Error('gh auth status exited with code 1')
      void args
      return 'Logged in to github.com as agent-bot'
    }
    if (program === 'lark-cli') {
      if (options.lark === 'missing-cli') throw Object.assign(new Error('spawn lark-cli ENOENT'), { code: 'ENOENT' })
      if (options.lark === 'no-bot') return JSON.stringify({ identities: { bot: { status: 'missing' } } })
      return JSON.stringify({ identities: { bot: { status: 'ready' }, user: { status: 'ready' } } })
    }
    throw new Error(`unexpected program ${program}`)
  }
  return runDoctor({
    stateDir,
    run,
    now: () => AT,
    portOpen: async () => options.portOpen ?? true,
    ...(options.cliPath === undefined ? {} : { cliPath: options.cliPath }),
    ...(options.inspect === undefined ? {} : { inspectDatabase: options.inspect })
  })
}

/** 取一项结论。 */
function checkOf(checks: readonly DoctorCheck[], name: string): DoctorCheck {
  const found = checks.find((check) => check.name === name)
  assert.ok(found !== undefined, `doctor reports ${name}`)
  return found as DoctorCheck
}

test('the eight checks are always reported, in the design order', async () => {
  const stateDir = tempStateDir()
  try {
    const result = await doctorOf(stateDir, { cliPath: join(stateDir, 'superagent.mjs') })
    assert.deepEqual(
      result.checks.map((check) => check.name),
      ['token', 'port', 'lock', 'database', 'cli', 'gitconfig', 'gh', 'lark']
    )
    assert.deepEqual(result.checks.map((check) => check.state), [
      'fail', // 没有 token
      'fail', // 没有端口文件
      'ok', // 没有锁
      'warn', // 没有库
      'fail', // CLI 入口不存在
      'warn', // 没有 worker git 配置（还没启动过）
      'ok', // gh 已登录（注入的 runner）
      'ok' // lark-cli 的 bot 身份 ready（注入的 runner）
    ])
    assert.deepEqual(result.summary, { ok: 3, warn: 2, fail: 3, timeout: 0 })
    assert.equal(doctorExitCode(result), 1, 'a fail makes the doctor exit non-zero')
    assert.equal(result.at, AT)
    assert.equal(result.stateDir, stateDir)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a token file with the wrong mode is a warn, never a value', async () => {
  const stateDir = tempStateDir()
  try {
    const token = ensureApiToken(stateDir).token
    const path = join(stateDir, 'api-token')
    // 默认 0600：ok。
    let result = await doctorOf(stateDir)
    assert.equal(checkOf(result.checks, 'token').state, 'ok')
    assert.equal(statSync(path).mode & 0o777, TOKEN_MODE)

    // 放宽到 0644：warn，且提示里不含 token 值。
    writeFileSync(path, `${token}\n`, { encoding: 'utf8', mode: 0o644 })
    const { chmodSync } = await import('node:fs')
    chmodSync(path, 0o644)
    result = await doctorOf(stateDir)
    const tokenCheck = checkOf(result.checks, 'token')
    assert.equal(tokenCheck.state, 'warn')
    assert.equal(JSON.stringify(result).includes(token), false, 'the token value never appears')
    assert.equal(JSON.stringify(result).includes('api-token'), true, 'the path is not a secret (§N.5)')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('the port check reads the port file and asks whether something answers', async () => {
  const stateDir = tempStateDir()
  try {
    // 文件在、端口有人听 → ok（端口号来自文件，不是缺省值）。
    writeFileSync(join(stateDir, PORT_FILE), '4321', 'utf8')
    let result = await doctorOf(stateDir, { portOpen: true })
    assert.equal(checkOf(result.checks, 'port').state, 'ok')
    assert.ok(checkOf(result.checks, 'port').detail.includes('4321'))

    // 文件在、没人听 → warn（可能是 worker 正在起）。
    result = await doctorOf(stateDir, { portOpen: false })
    assert.equal(checkOf(result.checks, 'port').state, 'warn')

    // 文件不在 → fail，提示里给缺省端口。
    rmSync(join(stateDir, PORT_FILE))
    result = await doctorOf(stateDir)
    assert.equal(checkOf(result.checks, 'port').state, 'fail')
    assert.ok(checkOf(result.checks, 'port').detail.includes(String(DEFAULT_PORT)))
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('the lock check distinguishes a live worker from a stale lock', async () => {
  const stateDir = tempStateDir()
  try {
    // 没有锁：ok（插件还没启用过）。
    let result = await doctorOf(stateDir)
    assert.equal(checkOf(result.checks, 'lock').state, 'ok')

    // 活锁：刚写过，mtime 新鲜 → ok，并报持有者 pid。
    const lock = acquireLock({ stateDir, pid: process.pid, now: () => new Date(AT) })
    assert.equal(lock.mode, 'leader')
    if (lock.mode === 'leader') {
      result = await doctorOf(stateDir)
      assert.equal(checkOf(result.checks, 'lock').state, 'ok')
      assert.ok(checkOf(result.checks, 'lock').detail.includes(String(process.pid)))
      lock.lock.release()
    }

    // 陈旧锁：把一个 pid 不再存在的锁文件放进去 → warn。
    writeFileSync(join(stateDir, 'lock'), JSON.stringify({ pid: 999_999, startedAt: AT }), 'utf8')
    const { utimesSync } = await import('node:fs')
    const old = new Date(0)
    utimesSync(join(stateDir, 'lock'), old, old)
    result = await doctorOf(stateDir)
    assert.equal(checkOf(result.checks, 'lock').state, 'warn')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('the database check reads the schema version without migrating anything', async () => {
  const stateDir = tempStateDir()
  try {
    // 没有库：warn（worker 首启会建）。
    let result = await doctorOf(stateDir)
    assert.equal(checkOf(result.checks, 'database').state, 'warn')

    // 建好库（迁移到当前版本）：ok，报表数。doctor 读的是 `Store.inspect`（只读视图），
    // 不自己开库、不迁移。
    const store = openStore({ stateDir })
    let inspected: ReturnType<typeof store.inspect>
    try {
      inspected = store.inspect()
      assert.equal(inspected.schemaVersion, SCHEMA_VERSION)
      assert.equal(inspected.pluginVersion, SCHEMA_VERSION)
      assert.equal(inspected.tables, store.tables().length)
      assert.equal(inspected.bytes > 0, true)
    } finally {
      store.close()
    }
    result = await doctorOf(stateDir, { inspect: () => inspected })
    const database = checkOf(result.checks, 'database')
    assert.equal(database.state, 'ok')
    assert.ok(database.detail.includes(`schema ${SCHEMA_VERSION}`))
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('the CLI path check fails only when the entry is missing, and warns when unknown', async () => {
  const stateDir = tempStateDir()
  try {
    let result = await doctorOf(stateDir)
    assert.equal(checkOf(result.checks, 'cli').state, 'warn', 'no path given')

    const entry = join(stateDir, 'superagent.mjs')
    result = await doctorOf(stateDir, { cliPath: entry })
    assert.equal(checkOf(result.checks, 'cli').state, 'fail', 'the path does not exist yet')

    writeFileSync(entry, '', 'utf8')
    result = await doctorOf(stateDir, { cliPath: entry })
    assert.equal(checkOf(result.checks, 'cli').state, 'ok')
    assert.ok(checkOf(result.checks, 'cli').detail.includes(entry))
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('gh reports ok / signed-out / missing as three different states', async () => {
  const stateDir = tempStateDir()
  try {
    assert.equal(checkOf((await doctorOf(stateDir, { gh: 'ok' })).checks, 'gh').state, 'ok')
    assert.equal(checkOf((await doctorOf(stateDir, { gh: 'signed-out' })).checks, 'gh').state, 'fail')
    assert.equal(checkOf((await doctorOf(stateDir, { gh: 'missing' })).checks, 'gh').state, 'warn')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('lark-cli is optional: missing is a warn, a missing bot identity is a warn, ready is ok', async () => {
  const stateDir = tempStateDir()
  try {
    for (const [mode, expected] of [
      ['ready', 'ok'],
      ['no-bot', 'warn'],
      ['missing-cli', 'warn']
    ] as const) {
      const check = checkOf((await doctorOf(stateDir, { lark: mode })).checks, 'lark')
      assert.equal(check.state, expected, mode)
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('the lark status reader keeps only the bot status, never the appId, openId or scopes', () => {
  const text = JSON.stringify({
    appId: 'cli_secret_app_id',
    identities: {
      bot: { status: 'ready', available: true },
      user: { status: 'missing', openId: 'ou_secret', scope: 'im:message a b c' }
    },
    note: 'run lark-cli auth login'
  })
  assert.equal(botStatus(text), 'ready')
  // 没有 identities 段：读不出结论 → `unknown`（doctor 报 warn，不猜「没配」）。
  assert.equal(botStatus('{}'), 'unknown')
  assert.equal(botStatus(JSON.stringify({ identities: {} })), 'missing')
  assert.equal(botStatus('not json'), 'unknown')
})

test('the result is ordered, counted and mapped to an exit code in one place', () => {
  const checks: readonly DoctorCheck[] = [
    { name: 'lark', state: 'ok', detail: 'x' },
    { name: 'token', state: 'fail', detail: 'x', hint: 'y' },
    { name: 'port', state: 'warn', detail: 'x', hint: 'y' },
    { name: 'gh', state: 'timeout', detail: 'x', hint: 'y' }
  ]
  assert.deepEqual(orderChecks(checks).map((check) => check.name), ['token', 'port', 'gh', 'lark'])
  // 四档各计一次；`timeout` 不折进 warn（那是「可选/未配置」）。
  assert.deepEqual(summarize(checks), { ok: 1, warn: 1, fail: 1, timeout: 1 })
  // 排序权重：fail → timeout → warn → ok（超时是「没结论」，比警告靠前、比失败靠后）。
  assert.deepEqual([...DOCTOR_STATES], ['fail', 'timeout', 'warn', 'ok'])
  assert.equal(stateRank('fail') < stateRank('timeout'), true)
  assert.equal(stateRank('timeout') < stateRank('warn'), true)
  assert.equal(stateRank('warn') < stateRank('ok'), true)
  // 退出码只按 fail：一条 timeout 不算失败（200 就是 0，判定口径在 setup 检查）。
  assert.equal(doctorExitCode(doctorResult([{ name: 'gh', state: 'timeout', detail: 'x', hint: 'y' }], { stateDir: '/x', at: AT })), 0)
})

test('a probe that misses its budget is a timeout: the other checks keep their real readings', async () => {
  const stateDir = tempStateDir()
  const handed: { readonly signal?: AbortSignal; readonly timeoutMs?: number }[] = []
  try {
    ensureApiToken(stateDir)
    writeFileSync(join(stateDir, PORT_FILE), String(DEFAULT_PORT), 'utf8')
    // `gh` 永远不回来；`lark-cli` 正常。预算只在 handler 里给，这里注入 10 ms 让用例快到能跑。
    const run = (program: string, _args: readonly string[], options?: { signal?: AbortSignal; timeoutMs?: number }) => {
      handed.push({ ...(options ?? {}) })
      if (program === 'gh') return new Promise<string>(() => undefined)
      return Promise.resolve(JSON.stringify({ identities: { bot: { status: 'ready' } } }))
    }
    const result = await runDoctor({
      stateDir,
      run,
      now: () => AT,
      portOpen: async () => true,
      budget: { probeMs: 10 }
    })
    const gh = checkOf(result.checks, 'gh')
    assert.equal(gh.state, 'timeout', 'a hung probe is never reported as ok')
    assert.equal(gh.detail.includes('10 ms'), true, 'the detail names the budget')
    assert.equal(typeof gh.hint, 'string', 'a timeout carries the next step')
    // 其余项照常：端口与 lark 读到真读数，token/库/CLI/gitconfig 各自给结论。
    assert.equal(checkOf(result.checks, 'port').state, 'ok')
    assert.equal(checkOf(result.checks, 'lark').state, 'ok')
    assert.equal(checkOf(result.checks, 'token').state, 'ok')
    assert.equal(checkOf(result.checks, 'database').state, 'warn')
    assert.deepEqual(
      result.checks.map((check) => check.name),
      ['token', 'port', 'lock', 'database', 'cli', 'gitconfig', 'gh', 'lark']
    )
    // 四档计数：一项 timeout，没有 fail（超时不是坏掉）。
    assert.deepEqual(result.summary, { ok: 4, warn: 3, fail: 0, timeout: 1 })
    // 取消真的到了子进程那一层：挂住的那次调用拿到已取消的信号与同一个上限。
    assert.equal(handed[0]?.timeoutMs, 10)
    assert.equal(handed[0]?.signal?.aborted, true)
    // 没有 fail：doctor 的退出码口径不看 timeout。
    assert.equal(doctorExitCode(result), 0)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a cancelled whole call is not a timed-out check: the deadline is rethrown', async () => {
  const stateDir = tempStateDir()
  try {
    ensureApiToken(stateDir)
    // 整次调用已经被取消（handler 的总预算/停机）：探针不该编一条 `timeout` 结论。
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      runDoctor({
        stateDir,
        run: () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        now: () => AT,
        portOpen: async () => true,
        budget: { probeMs: 10, signal: controller.signal }
      }),
      (error: unknown) => error instanceof DeadlineError
    )
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a doctor result with only warnings and oks exits 0', async () => {
  const stateDir = tempStateDir()
  try {
    ensureApiToken(stateDir)
    writeFileSync(join(stateDir, PORT_FILE), String(DEFAULT_PORT), 'utf8')
    const result = await doctorOf(stateDir, { portOpen: false, cliPath: join(stateDir, 'missing') })
    assert.equal(result.summary.fail, 1, 'the missing CLI entry is the only fail')
    assert.equal(doctorExitCode(result), 1)
    // 把 CLI 入口补上：只剩 warn，退出 0。
    writeFileSync(join(stateDir, 'missing'), '', 'utf8')
    const clean = await doctorOf(stateDir, { portOpen: false, cliPath: join(stateDir, 'missing') })
    assert.equal(clean.summary.fail, 0)
    assert.equal(doctorExitCode(clean), 0)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('the gitconfig check reads existence and mode, never the contents', async () => {
  const stateDir = tempStateDir()
  try {
    // 缺失：warn，并说清怎么让它出现（不是静默，也不把缺失说成坏掉）。
    const missing = checkOf((await doctorOf(stateDir)).checks, 'gitconfig')
    assert.equal(missing.state, 'warn')
    assert.equal(typeof missing.hint, 'string')

    // 存在且 0600：ok。doctor 只 stat，不读内容（账号与邮箱不出现在结果里）。
    const email = '1+acme-agent@users.noreply.github.com'
    assert.equal(writeWorkerGitConfig({ stateDir, account: 'acme-agent', email }).state, 'written')
    const ok = checkOf((await doctorOf(stateDir)).checks, 'gitconfig')
    assert.equal(ok.state, 'ok')
    assert.equal(JSON.stringify(ok).includes('acme-agent'), false, 'the contents are never read')
    assert.equal(JSON.stringify(ok).includes(email), false)

    // 权限过宽：warn，且给出 chmod（与 token 检查同一口径）。
    const path = workerGitConfigPath(stateDir)
    const { chmodSync } = await import('node:fs')
    chmodSync(path, 0o644)
    const tooOpen = checkOf((await doctorOf(stateDir)).checks, 'gitconfig')
    assert.equal(tooOpen.state, 'warn')
    assert.equal(tooOpen.detail.includes('644'), true, 'the actual mode is reported')
    assert.equal(GITCONFIG_MODE, 0o600)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('the port probe times out instead of hanging when nothing answers', async () => {
  // 一个刚放掉的真实端口：探测立即失败（不挂起、不 sleep）。端口取自内核临时区间之外的窄带
  // （#53），所以并行的另一个测试文件 `listen(0)` 也拿不到它，无需探测后重绑。
  const port = await closedPort()
  assert.equal(await defaultPortProbe(port), false)
})

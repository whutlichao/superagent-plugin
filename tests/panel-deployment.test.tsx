// Deployment 页（§M.3 的 Deployment 组、§N.4 的 health 明细、§G.2 的 doctor、§H 的已知限制）。
//
// 断言分两层：
// - 面板侧：挂载真面板模块，走到 Settings 页的 Deployment 组，读每块内容与动作；
//   轮换 token 与重启 Router 都必须先经过行内二次确认（§M.2 的确认对话）；
// - 读模型侧：`deploymentView` 把**真** `HealthBoard` 的条目与真 Router 快照变成面板的
//   形状（不是手写夹具），于是「按部件分组、每项带状态与明细」是同一份读法。
//
// data 走面板协议（`deployment`/`doctor`/`setupCheck`/`rotateToken`/`restartRouter`），
// 破坏性动作只发一次请求，绝不因为一次点击就写。
import { assert, mockHost, mount, test } from 'orca/testing'
import { HealthBoard } from '../src/worker/infra/health'
import { DEFAULT_MACHINE_LIMITS, machineLimits, type MachineLimits } from '../src/worker/app/limits'
import { deploymentView } from '../src/worker/app/deployment-view'
import type { SetupIssue } from '../src/worker/app/setup'
import type { RouterSnapshot } from '../src/worker/router/supervision'
import type { DoctorView, DeploymentView, PanelState } from '../src/panel/protocol'
import { COPY } from '../src/panel/copy'
import { LIMITATIONS } from '../src/panel/limitations'
import { readRepoFile } from './support/repo'
import * as panelModule from '../src/panel/panel'
import check from '../src/panel/panel.check.ts'

/** 一份健康的 worker 快照（Deployment 页读的是 `deployment`，这一份只让面板壳起来）。 */
function snapshot(paused = false): PanelState {
  return {
    revision: 1,
    booted: true,
    health: {
      error: false,
      paused,
      setupMissing: false,
      activity: { received: 2, evaluated: 1, accepted: 1, ignored: 0, ended: 0 },
      executor: { running: 0, maxWorkers: 4 }
    },
    attention: { answer: 0, review: 0, problems: 0, items: [] },
    tickets: []
  }
}

/** 一份 Router 快照（真形状；面板只读其中五个字段）。 */
function routerOf(overrides: Partial<RouterSnapshot> = {}): RouterSnapshot {
  return {
    state: 'ready',
    detail: 'restarts 1 in 10 min, terminal term_router',
    terminalId: 'term_router',
    workspaceId: 'ws_1',
    directory: '/repos/widgets-router',
    startedAt: '2026-11-07T03:00:00.000Z',
    promptRevision: 3,
    currentRevision: 3,
    restarts: 1,
    lastError: null,
    nextAttemptAt: null,
    idle: { suspected: false, waits: 0, since: null },
    undecidedCandidates: 0,
    orphaned: null,
    agentState: null,
    ...overrides
  }
}

/** 一份部署读数；`board` 是**真**健康板，条目由测试 claim。 */
function view(options: {
  readonly paused?: boolean
  readonly setup?: readonly SetupIssue[]
  readonly board?: HealthBoard
  readonly router?: RouterSnapshot
  readonly limits?: MachineLimits
  readonly stateDir?: string
} = {}): DeploymentView {
  const board = options.board ?? new HealthBoard()
  return deploymentView({
    stateDir: options.stateDir ?? '/var/lib/superagent',
    setup: options.setup ?? [],
    limits: options.limits ?? DEFAULT_MACHINE_LIMITS,
    paused: options.paused ?? false,
    health: board.all(),
    router: options.router ?? routerOf()
  })
}

/** 一份 doctor 结果。 */
function doctorOf(overrides: Partial<DoctorView> = {}): DoctorView {
  return {
    checks: [
      { name: 'token', state: 'ok', detail: 'the operator token file is present (0600)' },
      { name: 'gh', state: 'warn', detail: 'the agent GitHub CLI is not signed in', hint: 'run gh auth login' }
    ],
    summary: { ok: 1, warn: 1, fail: 0 },
    at: '2026-11-07T03:20:00.000Z',
    note: 'doctor diagnoses this machine',
    ...overrides
  }
}

/** 一个固定时刻的 setup 问题（修法与重跑入口恒在）。 */
function problem(overrides: Partial<SetupIssue> = {}): SetupIssue {
  return {
    place: 'executor',
    code: 'base_repo_missing',
    kind: 'missing',
    detail: 'the base repository path:/repos/widgets is not registered in Orca',
    fix: 'pick a repository Orca already has (`orca repo list`), or add it to Orca first',
    checkAgain: 'superagent setup check',
    ...overrides
  }
}

let panel: Awaited<ReturnType<typeof mount>> | undefined

/** 挂载面板并停在 Settings → Deployment；`read` 每次请求都重新取一份读数。 */
async function openDeployment(
  read: () => DeploymentView,
  options: {
    readonly doctor?: DoctorView
    readonly onSetupCheck?: () => unknown
    readonly onRotate?: () => unknown
    readonly onRestart?: () => unknown
    readonly locale?: string
  } = {}
) {
  panel = await mount(panelModule, {
    host: mockHost({
      requests: {
        state: () => snapshot(read().paused),
        deployment: () => read(),
        doctor: () => options.doctor ?? doctorOf(),
        pause: (input: unknown) => snapshot((input as { paused?: boolean } | null)?.paused === true),
        setupCheck: options.onSetupCheck ?? (() => ({ checked: true, problems: [] })),
        rotateToken: options.onRotate ?? (() => ({ rotated: true, tokenFile: '/var/lib/superagent/api-token' })),
        restartRouter: options.onRestart ?? (() => routerOf())
      }
    }),
    locale: options.locale ?? 'en'
  })
  await panel.select({ type: 'Tabs' }, 'settings')
  return panel
}

/** 面板向 worker 发过的一次请求（按名字过滤）。 */
function requests(host: ReturnType<typeof mockHost>, name: string): unknown[] {
  return host
    .callsOf('plugin.request')
    .map((params) => params as { name?: string; input?: unknown })
    .filter((params) => params.name === name)
    .map((params) => params.input)
}

test('the Deployment page shows the state directory, the machine limits and the paused switch', async () => {
  const limits = machineLimits({
    promptMaxChars: 111_111,
    admissionContextMaxPages: 7,
    admissionContextTimeoutMs: 2222,
    retention: { days: 45 }
  })
  const mounted = await openDeployment(() => view({ limits }))

  // 状态目录：只读展示（可选中的文本），修改入口指向 Orca 设置并说明要重启。
  assert.ok(mounted.find({ text: /\/var\/lib\/superagent/ }), 'the state directory is shown')
  assert.ok(mounted.find({ text: COPY['deployment.stateDirReadOnly'].en }), 'the path is read-only')
  assert.ok(mounted.find({ text: COPY['deployment.stateDirChange'].en }), 'the change entry is named')

  // 机器限额：四个数值都来自设置，缺省时是设计里的缺省值。
  assert.ok(mounted.find({ type: 'KeyValue' }), 'the limits are a facts table')
  const rendered = JSON.stringify(mounted.tree())
  for (const key of ['promptMaxChars', 'admissionContextMaxPages', 'admissionContextTimeoutMs', 'retentionDays'] as const) {
    assert.ok(rendered.includes(JSON.stringify(COPY[`deployment.limit.${key}`].en)), `the ${key} label`)
  }
  for (const value of ['111111', '7', '2222', '45']) {
    assert.ok(rendered.includes(`"${value}"`) || rendered.includes(`:${value},`), `the value in force: ${value}`)
  }

  // 暂停开关：标签是「暂停处理」，当前值来自这一份部署读数。
  const toggle = mounted.find({ type: 'Switch' })
  assert.equal(toggle?.label, COPY['deployment.paused'].en)
  assert.equal(mounted.valueOf({ type: 'Switch' }), false)

  // 打开它才写：一次 `pause` 请求，输入是 `{ paused: true }`。
  assert.deepEqual(requests(mounted.host, 'pause'), [])
  await mounted.toggle({ type: 'Switch' })
  assert.deepEqual(requests(mounted.host, 'pause'), [{ paused: true }])

  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('the machine limits fall back to the design defaults when the settings say nothing', () => {
  assert.deepEqual(
    { ...machineLimits({}) },
    {
      promptMaxChars: 200_000,
      admissionContextMaxPages: 10,
      admissionContextTimeoutMs: 15_000,
      retentionDays: 90
    }
  )
})

test('each setup problem names what is missing, how to fix it, and Check again re-runs the probes', async () => {
  let current = view({
    setup: [
      problem({
        place: 'state',
        code: 'state_dir_unwritable',
        kind: 'broken',
        detail: 'the state directory /var/lib/superagent is not writable',
        fix: 'create it and make it writable by your account (mkdir -p /var/lib/superagent)'
      }),
      problem()
    ]
  })
  const mounted = await openDeployment(() => current, {
    onSetupCheck: () => {
      // 人修好了外部条件：重跑探针之后没有问题，页面跟着新读数说「通过」。
      current = view({ setup: [] })
      return { checked: true, problems: [] }
    }
  })

  // 逐条：归属部件、固定码、现状、修法与重跑命令（每条都能照着做）。
  assert.ok(mounted.find({ text: /state_dir_unwritable/ }), 'the fixed code is shown')
  assert.ok(mounted.find({ text: /is not writable/ }), 'the detail says what is wrong')
  assert.ok(mounted.find({ text: /make it writable/ }), 'the fix says what to do')
  assert.ok(mounted.find({ text: 'superagent setup check' }), 'the re-run entry is the command')
  assert.ok(mounted.find({ text: /base_repo_missing/ }), 'the second problem is listed too')
  assert.equal(mounted.findAll({ type: 'Callout' }).length >= 2, true, 'one callout per problem')

  // 「检查一次」是唯一的动作：按下才发请求，结果按新读数说。
  assert.deepEqual(requests(mounted.host, 'setupCheck'), [])
  await mounted.press({ text: COPY['deployment.checkAgain'].en })
  assert.equal(requests(mounted.host, 'setupCheck').length, 1)
  assert.ok(mounted.find({ text: COPY['deployment.setupPassed'].en }), 'the section says it passed')
  assert.equal(mounted.find({ text: /state_dir_unwritable/ }), null, 'the fixed problem is gone')

  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('the health list groups every board entry by part, with its state and counts', async () => {
  // 真健康板（#45）：条目由各写者 claim，面板读的是同一份 `all()`。
  const board = new HealthBoard()
  board.claim('runtime', { state: 'ready', detail: 'loopback api on 127.0.0.1:3847' })
  board.claim('passes', { state: 'error', detail: 'failed 3 times in a row' })
  board.claim('assessment', { state: 'ready', detail: 'waiting 2, failed 0' })
  board.claim('router', { state: 'starting', detail: 'restarts 0 in 10 min' })
  board.claim('github', { state: 'ready', detail: 'polled 3 minutes ago' })
  board.claim('sync:acme', { state: 'paused', detail: 'not synced yet' })
  board.claim('custom-part', { state: 'ready', detail: 'reported by a future ticket' })

  const mounted = await openDeployment(() => view({ board }))

  // 按部件分组：每组的标题带条目数（不是把所有条目摊成一列）。
  assert.ok(mounted.find({ text: 'Runtime · 1' }), 'runtime')
  assert.ok(mounted.find({ text: 'Passes · 1' }), 'passes')
  assert.ok(mounted.find({ text: 'Effects · 1' }), 'the effect kinds')
  assert.ok(mounted.find({ text: 'Router · 1' }), 'router')
  assert.ok(mounted.find({ text: 'Sources · 2' }), 'both Source entries, including the sync entry')
  assert.ok(mounted.find({ text: 'Other · 1' }), 'an entry no group knows is still shown')

  // 每一条都带名字、状态与明细（计数就在明细里：#45 的 detail 形状）。
  for (const name of ['passes', 'assessment', 'sync:acme', 'custom-part']) {
    assert.ok(mounted.find({ text: name }), `the entry ${name}`)
  }
  assert.ok(mounted.find({ text: /failed 3 times in a row/ }), 'the detail of the failing entry')
  assert.ok(mounted.find({ text: /waiting 2, failed 0/ }), 'counts travel inside the detail')
  assert.ok(mounted.find({ text: COPY['deployment.state.error'].en }), 'the error state is named')
  assert.ok(mounted.find({ text: COPY['deployment.state.paused'].en }), 'the paused state is named')

  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('the Router block shows the terminal, since when, the restart count, and Restart asks first', async () => {
  const mounted = await openDeployment(
    () =>
      view({
        router: routerOf({ restarts: 4, startedAt: '2026-11-07T03:00:00.000Z', detail: 'restarts 4 in 10 min' })
      }),
    { onRestart: () => routerOf({ restarts: 0 }) }
  )

  assert.ok(mounted.find({ text: COPY['deployment.routerTerminal'].en }), 'the terminal fact')
  assert.ok(mounted.find({ text: /term_router/ }), 'the terminal id')
  assert.ok(mounted.find({ text: COPY['deployment.routerSince'].en }), 'the start time fact')
  assert.ok(mounted.find({ text: COPY['deployment.routerRestarts'].en }), 'the restart count fact')
  // 时间只由宿主组件画（面板不自己格式化 ISO 串）。
  assert.equal(mounted.findAll({ type: 'RelativeTime' }).length, 1)
  assert.ok(JSON.stringify(mounted.tree()).includes('"4"'), 'the restart count is the number in force')

  // 重启是破坏性动作：先问，确认后才发一次请求。
  assert.deepEqual(requests(mounted.host, 'restartRouter'), [])
  await mounted.press({ text: COPY['deployment.routerRestart'].en })
  const question = COPY['confirm.bodyPlain'].en.replace('{action}', COPY['deployment.routerRestart'].en)
  assert.ok(mounted.find({ text: new RegExp(question) }), 'the block asks before restarting')
  assert.deepEqual(requests(mounted.host, 'restartRouter'), [])
  await mounted.press({ text: COPY['action.confirm'].en })
  assert.equal(requests(mounted.host, 'restartRouter').length, 1)
  assert.ok(mounted.find({ text: COPY['deployment.routerRestarted'].en }), 'it says what happened')

  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('the doctor block runs the diagnosis and lists every check with its state and hint', async () => {
  let runs = 0
  const mounted = await openDeployment(() => view({}), {
    // 一次真包含三项（一条 fail、一条 warn、一条 ok）的诊断。
    doctor: {
      ...doctorOf(),
      checks: [
        { name: 'token', state: 'ok', detail: 'the operator token file is present (0600)' },
        { name: 'gh', state: 'warn', detail: 'the agent GitHub CLI is not signed in', hint: 'run gh auth login' },
        { name: 'port', state: 'fail', detail: 'nothing answers on the recorded port' }
      ],
      summary: { ok: 1, warn: 1, fail: 1 }
    }
  })

  // 打开这一页时诊断已经跑过一次（人不按按钮也能看到结论）。
  assert.equal(requests(mounted.host, 'doctor').length, 1)
  assert.equal(mounted.findAll({ type: 'Table' }).length, 1, 'the checks are a table')
  const rendered = JSON.stringify(mounted.tree())
  for (const name of ['token', 'gh', 'port']) assert.ok(rendered.includes(`"${name}"`), `the check ${name}`)
  assert.ok(rendered.includes('not signed in'), 'the conclusion')
  assert.ok(rendered.includes('run gh auth login'), 'the hint')
  assert.ok(
    mounted.find({
      text: COPY['deployment.doctorSummary'].en
        .replace('{ok}', '1')
        .replace('{warn}', '1')
        .replace('{fail}', '1')
    }),
    'the three counts'
  )
  for (const state of ['ok', 'warn', 'fail'] as const) {
    assert.ok(rendered.includes(JSON.stringify(COPY[`deployment.doctorState.${state}`].en)), `the ${state} state`)
  }

  // 「运行诊断」再跑一次（人不重启就重跑）。
  runs = requests(mounted.host, 'doctor').length
  await mounted.press({ text: COPY['deployment.doctorRun'].en })
  assert.equal(requests(mounted.host, 'doctor').length, runs + 1)

  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('Rotate token asks first and then reports the file, never the token value', async () => {
  const mounted = await openDeployment(() => view({}), {
    onRotate: () => ({ rotated: true, tokenFile: '/var/lib/superagent/api-token' })
  })

  assert.ok(mounted.find({ text: COPY['deployment.tokenIntro'].en }), 'the block says what the token is for')
  assert.deepEqual(requests(mounted.host, 'rotateToken'), [])

  await mounted.press({ text: COPY['deployment.rotateToken'].en })
  const question = COPY['confirm.bodyPlain'].en.replace('{action}', COPY['deployment.rotateToken'].en)
  assert.ok(mounted.find({ text: new RegExp(question) }), 'rotation asks before acting')
  assert.deepEqual(requests(mounted.host, 'rotateToken'), [])

  await mounted.press({ text: COPY['action.confirm'].en })
  assert.equal(requests(mounted.host, 'rotateToken').length, 1)
  // 结论只说文件路径；token 值不出现在任何读数或页面上（§O）。
  assert.ok(mounted.find({ text: /\/var\/lib\/superagent\/api-token/ }), 'the token file is named')
  assert.ok(JSON.stringify(mounted.tree()).includes(COPY['deployment.rotated'].en.replace('{file}', '')), 'it says the rotation happened')

  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('the Limitations section lists the eleven approximations, and the README says the same words', async () => {
  const mounted = await openDeployment(() => view({}))

  // §A.3：十一项只能近似的能力（不是十二条，也不是「待定」）。
  assert.equal(LIMITATIONS.length, 11)
  // 文本里的引号在树里被转义过：先还原，再按原话比对（比对的是页面上的字）。
  const rendered = JSON.stringify(mounted.tree()).replace(/\\"/g, '"')
  let last = -1
  for (const item of LIMITATIONS) {
    const title = COPY[item.titleKey].en
    const position = rendered.indexOf(title)
    assert.ok(position >= 0, `the limitation ${item.id} is on the page`)
    assert.ok(position > last, `the limitations keep the design order at ${item.id}`)
    last = position
    assert.ok(rendered.includes(COPY[item.impactKey].en), `the impact of ${item.id} is stated: ${rendered.slice(rendered.indexOf(title), rendered.indexOf(title) + 900)}`)
    // 每一项都指向差异表里能查到的行：引用不是装饰。
    assert.equal(item.refs.length > 0, true, `the limitation ${item.id} names its §H rows`)
  }

  // 同一份来源、同一套措辞：README 的已知限制段逐条包含面板上的中英之一（中文）。
  const readme = readRepoFile('README.md')
  for (const item of LIMITATIONS) {
    assert.ok(readme.includes(COPY[item.titleKey].zh), `README carries ${item.id}`)
    assert.ok(readme.includes(COPY[item.impactKey].zh), `README carries the impact of ${item.id}`)
  }

  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('the plugin check scenario opens on the Deployment group with a real read', async () => {
  const scenario = check.deployment
  const mounted = await mount(panelModule, {
    host: mockHost({ requests: scenario.requests, storage: scenario.storage }),
    locale: 'en'
  })
  assert.equal(mounted.valueOf({ type: 'Tabs' }), 'settings', 'the scenario opens Settings')
  assert.ok(mounted.find({ text: COPY['deployment.stateDir'].en }), 'the deployment read is on screen')
  assert.ok(mounted.find({ text: `${COPY['deployment.setup'].en} · 1` }), 'setup problems too')
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

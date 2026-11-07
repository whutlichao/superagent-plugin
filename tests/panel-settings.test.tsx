// Settings 页（§M.3、§K.8）：五组框架、每组一个保存栏（脏/保存中/失败/冲突）、准入表的
// 三格可用性、prepare 的变量插入，以及历史的恢复。
//
// 断言面分两层：
// - 面板：挂载真面板模块，切到 Settings 的每一组，读控件与保存栏的四态；保存只发一次
//   `settings.save`（块 + 基线修订号 + 面板来源由 worker 填，不由面板选）；
// - worker：`tests/settings-limits.test.ts` 覆盖读面/写面的接线（origin、账号检查、重启标记）。
import { assert, mockHost, mount, test } from 'orca/testing'
import { COPY } from '../src/panel/copy'
import type {
  AdmissionRowView,
  PolicyRuleView,
  SettingsHistoryView,
  SettingsPageView,
  SettingsSaveInput,
  SettingsSaveOutcome,
  PanelState,
  SourcePolicyView,
  SourceSettingsCard
} from '../src/panel/protocol'
import { SETTINGS_GROUPS } from '../src/panel/protocol'
import * as panelModule from '../src/panel/panel'
import { SETTINGS_GROUP_BODIES, SETTINGS_GROUP_ORDER } from '../src/panel/settings'
import { minimalPromptsView } from './support/prompts-view'

/** 一份健康的 worker 快照（Settings 页读自己的请求，这一份只让面板壳起来）。 */
function snapshot(): PanelState {
  return {
    revision: 1,
    booted: true,
    health: {
      error: false,
      paused: false,
      setupMissing: false,
      sources: { enabled: 1, problems: 0 },
      activity: { received: 0, evaluated: 0, accepted: 0, ignored: 0, ended: 0 },
      executor: { running: 0, maxWorkers: 4, humanSlot: 'free' }
    },
    attention: { answer: 0, review: 0, problems: 0, items: [] },
    problems: [],
    tickets: []
  }
}

/** 一个 Source 卡（github）：开关、一个布尔字段、一个数字字段与一个行编辑器。 */
function sourceCard(overrides: Partial<SourceSettingsCard> = {}): SourceSettingsCard {
  return {
    block: 'source:github',
    id: 'github',
    kind: 'github',
    title: { zh: 'GitHub', en: 'GitHub' },
    description: { zh: '仓库的通知与评论。', en: 'Repository notifications and comments.' },
    state: 'ready',
    enabled: true,
    config: { observeIssues: false, pollSeconds: 60 },
    fields: [
      { key: 'observeIssues', type: 'switch', label: { zh: '观察新 Issue', en: 'Observe new Issues' } },
      {
        key: 'pollSeconds',
        type: 'number',
        label: { zh: '轮询间隔（秒）', en: 'Poll interval (seconds)' },
        min: 10,
        max: 3600
      }
    ],
    facts: [{ key: 'repository', value: { zh: 'acme/widgets', en: 'acme/widgets' } }],
    syncable: false,
    revision: 2,
    ...overrides
  }
}

/** 一条准入行：`observe` 决定未点名两格是否可用。 */
function admissionRow(observe: boolean): AdmissionRowView {
  return {
    id: 'issues',
    label: { zh: '新 Issue', en: 'New Issues' },
    note: { zh: '仓库里新开的 Issue。', en: 'A new Issue in the repository.' },
    cells: [
      {
        cell: 'listedUnaddressed',
        available: observe,
        value: 'inferred',
        default: 'inferred',
        options: ['inferred', 'ignore']
      },
      {
        cell: 'unlistedAddressed',
        available: true,
        value: 'ignore',
        default: 'ignore',
        options: ['explicit', 'inferred', 'ignore']
      },
      {
        cell: 'unlistedUnaddressed',
        available: observe,
        value: 'ignore',
        default: 'ignore',
        options: ['inferred', 'ignore']
      }
    ]
  }
}

/** 一条规则。 */
function rule(overrides: Partial<PolicyRuleView> = {}): PolicyRuleView {
  return {
    id: 'ship',
    name: 'Ship small fixes',
    instruction: { zh: '只做小的修复。', en: 'Only small fixes.' },
    enabled: true,
    ...overrides
  }
}

/** github 的 Policy 部分：允许名单、bots 与准入表。 */
function policySource(observe: boolean, overrides: Partial<SourcePolicyView> = {}): SourcePolicyView {
  return {
    source: 'github',
    title: { zh: 'GitHub', en: 'GitHub' },
    fields: [
      {
        key: 'allowed',
        type: 'rows',
        label: { zh: '允许名单', en: 'Allowed list' },
        columns: [
          { key: 'id', type: 'text', label: { zh: 'GitHub 账号', en: 'GitHub login' } },
          { key: 'name', type: 'text', label: { zh: '显示名', en: 'Display name' }, optional: true }
        ]
      },
      { key: 'bots', type: 'rows', label: { zh: '机器人名单', en: 'Bots' }, columns: [{ key: 'id', type: 'text', label: { zh: 'GitHub 账号', en: 'GitHub login' } }] }
    ],
    values: { allowed: [{ id: 'alice' }], bots: [] },
    admission: [admissionRow(observe)],
    syncable: false,
    ...overrides
  }
}

/** 一份设置读数；`observeIssues` 同时改变 Source 卡的配置与准入表的可用性。 */
function settingsView(
  overrides: {
    readonly observeIssues?: boolean
    readonly sourceRevision?: number
    readonly policyRevision?: number
    readonly engineRevision?: number
    readonly limitsRevision?: number
    readonly prepare?: string
  } = {}
): SettingsPageView {
  const observe = overrides.observeIssues ?? false
  return {
    revision: 4,
    sources: {
      instances: [
        sourceCard({
          revision: overrides.sourceRevision ?? 2,
          config: { observeIssues: observe, pollSeconds: 60 }
        })
      ]
    },
    eval: {
      block: 'policy',
      revision: overrides.policyRevision ?? 3,
      saved: { revision: overrides.policyRevision ?? 3, at: '2026-11-07T03:00:00.000Z', origin: 'panel', policyVersion: 'abc123def456' },
      policyVersion: 'abc123def456',
      acceptMode: 'observe',
      model: '',
      timeoutSeconds: 300,
      rules: [rule()],
      sources: [policySource(observe)]
    },
    execution: {
      block: 'executor',
      revision: overrides.engineRevision ?? 5,
      saved: null,
      value: {
        agent: 'pi',
        model: '',
        effort: '',
        maxWorkers: 2,
        baseRepo: 'path:/repos/widgets',
        baseBranch: 'main',
        branchPrefix: 'agent/',
        prepare: overrides.prepare ?? '',
        blockedCommands: ['rm'],
        inlineLimit: 1000,
        worktreeRetention: 'keep',
        confirmDelivery: true
      },
      repos: [{ value: 'path:/repos/widgets', label: 'widgets (/repos/widgets)' }],
      variables: ['DSH_SUPERAGENT_DIR', 'DSH_SUPERAGENT_NAME']
    },
    limits: {
      block: 'limits',
      revision: overrides.limitsRevision ?? 1,
      saved: null,
      value: {
        promptMaxChars: 200_000,
        admissionContextMaxPages: 10,
        admissionContextTimeoutMs: 15_000,
        retentionDays: 90
      }
    }
  }
}

/** 一份历史读数：一次块保存 + 一次 Policy 保存（带受影响工单）。 */
function historyView(): SettingsHistoryView {
  return {
    revision: 4,
    history: [
      {
        revision: 4,
        predecessor: 3,
        at: '2026-11-07T03:10:00.000Z',
        origin: 'panel',
        block: 'source:github',
        policyVersion: null,
        value: { enabled: true, config: { observeIssues: true, pollSeconds: 60 } },
        affectedTickets: []
      },
      {
        revision: 3,
        predecessor: null,
        at: '2026-11-07T03:00:00.000Z',
        origin: 'panel',
        block: 'policy',
        policyVersion: 'abc123def456',
        value: {},
        affectedTickets: ['t1']
      }
    ]
  }
}

/** 挂载面板并停在 Settings 的某一组。 */
async function openSettings(options: {
  readonly view?: () => SettingsPageView
  readonly history?: SettingsHistoryView
  readonly onSave?: (input: SettingsSaveInput) => SettingsSaveOutcome
  readonly locale?: string
}) {
  const panel = await mount(panelModule, {
    host: mockHost({
      storage: { 'panel.promptTab': 'edit' },
      requests: {
        state: () => snapshot(),
        deployment: () => ({
          stateDir: '/var/lib/superagent',
          setup: [],
          limits: { promptMaxChars: 200_000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15_000, retentionDays: 90 },
          paused: false,
          health: [],
          router: {
            state: 'ready',
            detail: 'restarts 0 in 10 min',
            terminalId: 'term_router',
            startedAt: '2026-11-07T03:00:00.000Z',
            restarts: 0,
            lastError: null
          }
        }),
        doctor: () => ({ checks: [], summary: { ok: 0, warn: 0, fail: 0, timeout: 0 }, at: '2026-11-07T03:00:00.000Z', note: 'doctor' }),
        setupCheck: () => ({ checked: false, problems: [] }),
        rotateToken: () => ({ rotated: false, tokenFile: '' }),
        restartRouter: () => ({ state: 'ready', detail: '', terminalId: null, startedAt: null, restarts: 0, lastError: null }),
        'settings.read': () => (options.view ?? settingsView)(),
        'settings.history': () => options.history ?? historyView(),
        // Prompts 组（#43）挂在同一张组表里：它的读数由自己那条请求提供，子页固定在编辑页。
        prompts: () => minimalPromptsView(),
        'settings.save': (input) =>
          options.onSave?.(input as SettingsSaveInput) ?? {
            ok: true,
            block: (input as SettingsSaveInput).block,
            revision: (input as SettingsSaveInput).revision + 1,
            changed: true,
            restarting: true,
            policyChanged: false,
            origin: 'panel'
          }
      }
    }),
    locale: options.locale ?? 'en'
  })
  await panel.select({ type: 'Tabs' }, 'settings')
  // 首屏的 Settings 读数与 Deployment 组的读数是异步的：等它们落地再断言。
  await panel.settled()
  return panel
}

/** 切到 Settings 的某一组（子 Tabs 的 label 是「设置」）。 */
async function groupTab(panel: Awaited<ReturnType<typeof mount>>, value: string, locale = 'en'): Promise<void> {
  await panel.select({ type: 'Tabs', label: COPY['nav.settings'][locale === 'en' ? 'en' : 'zh'] }, value)
  await panel.settled()
}

/** 一次 `settings.save` 请求的输入。 */
function saves(host: ReturnType<typeof mockHost>): SettingsSaveInput[] {
  return host
    .callsOf('plugin.request')
    .map((params) => params as { name?: string; input?: unknown })
    .filter((params) => params.name === 'settings.save')
    .map((params) => params.input as SettingsSaveInput)
}

/** 已经打开的那一组（面板里默认 Sources；这一页一次只渲染当前组）。 */
test('the Settings page shows the five groups in the design order, and Prompts is the real editor', async () => {
  const panel = await openSettings({})
  const labels = panel.findAll({ role: 'tab' }).map((tab) => tab.text)
  // 当前页的子 Tabs 是五组（§M.3 的顺序）；它嵌在导航的 Settings 项里。
  const groups = labels.slice(labels.indexOf(COPY['settings.group.sources'].en), labels.indexOf(COPY['settings.group.sources'].en) + 5)
  assert.deepEqual(groups, [
    COPY['settings.group.sources'].en,
    COPY['settings.group.eval'].en,
    COPY['settings.group.execution'].en,
    COPY['settings.group.prompts'].en,
    COPY['settings.group.deployment'].en
  ])
  await groupTab(panel, 'prompts')
  // #43 的 Prompts 组是注册进来的真组件（`SETTINGS_GROUP_BODIES.prompts`），不是占位：
  // 团队文本、分片与四个子页都在这一格里，子页默认停在编辑。
  assert.ok(panel.find({ text: COPY['prompt.intro'].en }), 'the group opens on the edit page')
  assert.ok(panel.find({ text: COPY['prompt.team'].en }), 'the team text section is the real one')
  assert.ok(
    panel.find({ type: 'Textarea', label: 'runtime/replies' }),
    'the per-part overrides are the real ones'
  )
  assert.equal(
    panel.valueOf({ type: 'Tabs', label: COPY['prompt.tabs'].en }),
    'edit',
    'the four sub-tabs live inside the group body'
  )
  for (const key of ['prompt.tab.edit', 'prompt.tab.full', 'prompt.tab.history', 'prompt.tab.skills'] as const) {
    assert.ok(panel.find({ role: 'tab', text: COPY[key].en }), `the ${key} sub-tab is drawn by the real component`)
  }
  assert.deepEqual(panel.refusals, [])
  assert.deepEqual(panel.errors, [])
  await panel.unmount()
})

test('one group table: every group id has exactly one body, and each draws once', async () => {
  // 只有一张组表（`settings.tsx` 的 `SETTINGS_GROUP_BODIES`）：键就是协议里的五个组 id，
  // 一个 id 一行；重复的组表会让同一个 id 出现两次。
  assert.deepEqual([...SETTINGS_GROUP_ORDER].sort(), [...SETTINGS_GROUPS].sort(), 'the order table is the five groups')
  assert.equal(new Set(SETTINGS_GROUP_ORDER).size, SETTINGS_GROUP_ORDER.length, 'no group id is listed twice')
  assert.deepEqual(
    Object.keys(SETTINGS_GROUP_BODIES).sort(),
    [...SETTINGS_GROUPS].sort(),
    'exactly one body per group id'
  )
  for (const [groupId, body] of Object.entries(SETTINGS_GROUP_BODIES)) {
    assert.equal(typeof body, 'function', `the ${groupId} group has a body to draw`)
  }

  // 渲染面：每组一段独有正文（只在这一组的组件里出现）；选一组就只画它，且只画一次。
  const panel = await openSettings({})
  const bodies = [
    ['sources', COPY['settings.sources.intro'].en],
    ['eval', COPY['settings.eval.intro'].en],
    ['execution', COPY['settings.execution.intro'].en],
    ['prompts', COPY['prompt.intro'].en],
    ['deployment', COPY['settings.limits.title'].en]
  ] as const
  for (const [groupId, marker] of bodies) {
    await groupTab(panel, groupId)
    assert.equal(
      panel.findAll({ text: marker }).length,
      1,
      `the ${groupId} group draws its body exactly once`
    )
    for (const [other, otherMarker] of bodies) {
      if (other === groupId) continue
      assert.equal(
        panel.findAll({ text: otherMarker }).length,
        0,
        `the ${other} body is not drawn on the ${groupId} group`
      )
    }
  }
  assert.deepEqual(panel.refusals, [])
  assert.deepEqual(panel.errors, [])
  await panel.unmount()
})

test('a clean group takes no space; a change shows N changes with Save and Discard', async () => {
  const panel = await openSettings({})
  assert.equal(panel.find({ text: COPY['action.save'].en }), null, 'a clean draft shows no save bar')
  assert.deepEqual(saves(panel.host), [])

  // Sources 组：打开 observe 开关 = 一个值改了。
  await panel.toggle({ type: 'Switch', label: 'Observe new Issues' })
  assert.ok(panel.find({ text: COPY['draft.changeOne'].en.replace('{count}', '1') }), '1 change')
  assert.deepEqual(saves(panel.host), [], 'nothing is written before Save')

  // 再改一个值 → 两处改动。
  await panel.type({ type: 'Input', label: 'Poll interval (seconds)' }, '120')
  const two = COPY['draft.changes'].en.replace('{count}', '2')
  assert.ok(panel.find({ text: two }), '2 changes')

  // Discard 把它丢掉，不发请求。
  await panel.press({ text: COPY['action.discard'].en })
  assert.equal(panel.find({ text: COPY['action.save'].en }), null, 'the bar is gone')
  assert.deepEqual(saves(panel.host), [])
  assert.deepEqual(panel.refusals, [])
  await panel.unmount()
})

test('Save sends one request for the edited block, at its base revision, and the bar closes on the new revision', async () => {
  let current = settingsView({ observeIssues: false })
  let calls = 0
  const panel = await openSettings({
    view: () => current,
    onSave: (input) => {
      calls += 1
      // 服务端保存之后，下一次读面就是新值（块修订号 +1）。
      current = settingsView({ observeIssues: true, sourceRevision: 3 })
      return {
        ok: true,
        block: input.block,
        revision: 3,
        changed: true,
        restarting: true,
        policyChanged: false,
        origin: 'panel'
      }
    }
  })

  await panel.toggle({ type: 'Switch', label: 'Observe new Issues' })
  await panel.press({ text: COPY['action.save'].en })
  assert.equal(calls, 1)
  const [saved] = saves(panel.host)
  assert.deepEqual(saved, {
    block: 'source:github',
    revision: 2,
    value: { enabled: true, config: { observeIssues: true, pollSeconds: 60 } }
  })
  assert.equal(panel.find({ text: COPY['action.save'].en }), null, 'the draft ended after the new revision')
  assert.ok(panel.find({ text: COPY['settings.saveRestart'].en }), 'it says a restart applies the new value')
  assert.deepEqual(panel.refusals, [])
  await panel.unmount()
})

test('field-level issues name the field, and the control is marked invalid', async () => {
  const panel = await openSettings({
    onSave: (input) => ({
      ok: false,
      reason: 'invalid',
      block: input.block,
      issues: [{ path: 'config.pollSeconds', message: 'expected at least 10' }]
    })
  })
  await panel.type({ type: 'Input', label: 'Poll interval (seconds)' }, '5')
  await panel.press({ text: COPY['action.save'].en })
  // 保存栏列出带块名的字段路径（能直接找到那个控件）。
  assert.ok(panel.find({ text: /source:github\.config\.pollSeconds/ }), 'the path names the block and field')
  // 那个控件自己也标了 invalid（字段级定位）。
  assert.equal(panel.valueOf({ type: 'Input', label: 'Poll interval (seconds)' }) !== undefined, true)
  const rendered = JSON.stringify(panel.tree())
  assert.ok(rendered.includes(COPY['settings.fieldInvalid'].en), 'the field says it is invalid')
  assert.equal(panel.find({ text: COPY['action.save'].en }) !== null, true, 'the draft is still there')
  await panel.unmount()
})

test('a save that missed its deadline shows the worker’s specific retry-later message', async () => {
  // 与 `deployment.test.ts` 的面板保存用例同一条文案：handler 到点后拿到的是一次 `failed`
  // （reason 仍是 `failed`，没有第二种 timeout 形状），`error` 原样进保存栏。那条用例里先
  // 到点的是探针自己的 10 ms，所以点名的是「GitHub CLI probe」。
  const message = 'The GitHub CLI probe did not finish within 10 ms; retry later'
  const panel = await openSettings({
    onSave: (input) => ({ ok: false, reason: 'failed', block: input.block, error: message })
  })
  await panel.toggle({ type: 'Switch', label: 'Observe new Issues' })
  await panel.press({ text: COPY['action.save'].en })
  const shown = COPY['draft.failed'].en.replace('{error}', message)
  assert.ok(panel.find({ text: shown }), 'the save bar carries the worker’s exact message')
  assert.ok(panel.find({ text: /did not finish within 10 ms; retry later/ }), 'including the deadline and retry hint')
  assert.equal(panel.find({ text: COPY['action.save'].en }) !== null, true, 'the draft is still there')
  assert.deepEqual(panel.refusals, [])
  await panel.unmount()
})

test('a stale revision shows the conflict and Reload takes the server value', async () => {
  let current = settingsView({ observeIssues: false })
  const panel = await openSettings({
    view: () => current,
    onSave: (input) => {
      // 别人先保存了：服务端已在 revision 9，而且值与人手里这份不同（冲突要保住草稿）。
      current = settingsView({ observeIssues: false, sourceRevision: 9 })
      return { ok: false, reason: 'conflict', block: input.block, revision: 9 }
    }
  })
  await panel.toggle({ type: 'Switch', label: 'Observe new Issues' })
  await panel.press({ text: COPY['action.save'].en })
  const conflict = COPY['draft.conflict'].en.replace('{revision}', '9')
  assert.ok(panel.find({ text: conflict }), 'the bar says it changed elsewhere')
  assert.ok(panel.find({ text: COPY['draft.reload'].en }), 'and offers Reload')
  await panel.press({ text: COPY['draft.reload'].en })
  assert.equal(panel.find({ text: conflict }), null, 'reloading ends the draft')
  assert.equal(panel.find({ text: COPY['action.save'].en }), null)
  await panel.unmount()
})

test('the admission cells are enabled only for rows that observe every message', async () => {
  const panel = await openSettings({})
  await groupTab(panel, 'eval')
  const notAddressed = { type: 'Select', label: COPY['settings.admission.listedUnaddressed'].en }
  const addressed = { type: 'Select', label: COPY['settings.admission.unlistedAddressed'].en }
  // 未开启 observe：两个未点名的格子不可用；点名的格子总是可用。
  assert.equal(panel.find(notAddressed)?.disabled, true, 'listed unaddressed is disabled')
  assert.equal(panel.find(addressed)?.disabled, false, 'unlisted addressed stays enabled')
  await panel.unmount()

  const observing = await openSettings({ view: () => settingsView({ observeIssues: true }) })
  await groupTab(observing, 'eval')
  assert.equal(observing.find(notAddressed)?.disabled, false, 'with observe on, the unaddressed cell is editable')
  await observing.unmount()
})

test('the prepare editor inserts a whitelisted variable, value by value', async () => {
  const panel = await openSettings({})
  await groupTab(panel, 'execution')
  await panel.press({ text: COPY['settings.execution.insertVariable'].en })
  const rendered = JSON.stringify(panel.tree())
  assert.ok(rendered.includes('${DSH_SUPERAGENT_DIR}'), 'the exact variable token is inserted')
  assert.ok(rendered.includes(COPY['action.save'].en), 'the insertion is a draft change')
  await panel.press({ text: COPY['action.save'].en })
  const [saved] = saves(panel.host)
  assert.equal(saved?.block, 'executor')
  assert.equal(saved?.revision, 5)
  const value = saved?.value as { prepare: string }
  assert.equal(value.prepare, '${DSH_SUPERAGENT_DIR}', 'the saved value is the token, not a substituted value')
  await panel.unmount()
})

test('History lists what was saved and Restore saves that version again, after a confirmation', async () => {
  let restored: SettingsSaveInput | undefined
  const panel = await openSettings({
    onSave: (input) => {
      restored = input
      return {
        ok: true,
        block: input.block,
        revision: input.revision + 1,
        changed: true,
        restarting: true,
        policyChanged: false,
        origin: 'panel'
      }
    }
  })
  // 历史在页面底部，任何一组都能看到。
  assert.ok(
    panel.find({ text: new RegExp(COPY['settings.history.title'].en) }),
    'the history section is there'
  )
  assert.ok(panel.find({ text: '#4' }), 'the newest revision')
  assert.ok(
    panel.find({ text: COPY['settings.history.affectedTickets'].en.replace('{tickets}', 't1') }),
    'the affected ticket of the policy save'
  )

  // 恢复先确认，确认之后走同一条保存路径（块 + 当前修订号 + 那一版的值）。
  await panel.press({ label: COPY['settings.history.restore'].en })
  assert.equal(panel.find({ text: COPY['settings.history.confirmRestore'].en.replace('{revision}', '4') }) !== null, true)
  assert.deepEqual(saves(panel.host), [], 'no write before the confirmation')
  await panel.press({ text: COPY['action.confirm'].en })
  assert.deepEqual(restored, {
    block: 'source:github',
    revision: 2,
    value: { enabled: true, config: { observeIssues: true, pollSeconds: 60 } }
  })
  assert.ok(panel.find({ text: COPY['settings.history.restored'].en.replace('{revision}', '4') }))
  await panel.unmount()
})

test('the page speaks Chinese too, and every group renders without a refusal', async () => {
  const panel = await openSettings({ locale: 'zh-CN' })
  for (const [value, label] of [
    ['sources', COPY['settings.group.sources'].zh],
    ['eval', COPY['settings.group.eval'].zh],
    ['execution', COPY['settings.group.execution'].zh],
    ['prompts', COPY['settings.group.prompts'].zh],
    ['deployment', COPY['settings.group.deployment'].zh]
  ] as const) {
    await groupTab(panel, value, 'zh')
    assert.ok(panel.find({ text: label }), `the ${value} group is named`)
  }
  assert.ok(panel.find({ text: COPY['settings.limits.title'].zh }), 'the limits are editable in Chinese too')
  assert.deepEqual(panel.refusals, [])
  assert.deepEqual(panel.errors, [])
  await panel.unmount()
})

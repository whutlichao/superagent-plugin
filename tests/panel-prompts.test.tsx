// Prompts 组（§M.3 的四个子页、§L.3 的必保留占位符、§L.4 的版本/历史/default-updated、
// §L.6 的技能文件）。
//
// 断言分两层：
// - 面板侧：挂载真面板模块，停在 Settings → Prompts，读四个子页的内容；被改的分片标
//   `changed`；模板展示必保留占位符；全文与「已保存」「默认」两个基准的行级 diff 都能选；
//   历史恢复产生新版本并回到编辑页；default-updated 的分片同时给出旧默认与新默认，两个
//   选择各发一次保存；团队技能的增删改与稳定路径。草稿被拒时显示的是 worker 的固定码对应
//   的可读文案（占位符、保留名、字符集、体量上限），面板不自己校验一遍。
// - worker 侧：真库（临时目录的 SQLite）+ 真版本库 + 真 handler：`prompts` 回一份完整读数，
//   `prompts.save` 拒绝丢占位符的模板，`prompts.restore` 是「再存一个新版本」。
import { afterEach, assert, mockHost, mount, mountWorker, test } from 'orca/testing'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPromptVersions, PROMPT_PART_KEYS, PROMPT_PARTS } from '../src/worker/app/prompts.ts'
import { PROMPT_BUILTIN_BASE_KEY } from '../src/worker/app/kv.ts'
import { promptPanelView } from '../src/worker/app/prompt-view.ts'
import type { PromptEnvironment, PromptPolicy } from '../src/worker/app/prompts.ts'
import { COPY, translate, type CopyKey } from '../src/panel/copy'
import type {
  PanelPromptConfig,
  PanelPromptIssue,
  PanelPromptPart,
  PanelPromptsView,
  PanelState,
  PromptTab
} from '../src/panel/protocol'
import { PROMPT_TABS } from '../src/panel/protocol'
import { changedParts, skillPath } from '../src/panel/prompt-view'
import * as panelModule from '../src/panel/panel'
import * as main from '../src/worker/main'
import { emptySettingsPage } from './support/settings-page'
import { AT, openTempStore } from './support/state'
import { openPromptPage } from './support/panel-nav'

/** 面板挂载后的请求表（测试只写用到的名字）。 */
type Requests = NonNullable<NonNullable<Parameters<typeof mockHost>[0]>['requests']>

/** 技能目录所在的根（与 worker 的 `skillFilePath` 同一个约定）。 */
const STATE_DIR = '/var/lib/superagent'

/** 部署事实（全文的生成段要它；面板不填值，值由 worker 填）。 */
const ENVIRONMENT: PromptEnvironment = {
  variables: ['DSH_SUPERAGENT_DIR', 'SUPERAGENT_CLI'],
  cliPath: '/plugins/superagent/src/bin/superagent.mjs',
  tokenFile: '/var/lib/superagent/api-token',
  stateDir: STATE_DIR,
  repository: 'acme/widgets'
}

/** 一份启用了两条规则的 Policy（Router 的 Policy 段）。 */
const POLICY: PromptPolicy = {
  version: 'policy-4f2a',
  mode: 'auto',
  rules: [
    { id: 'copy', name: 'Copy fixes', instruction: 'Fix a typo in one place.' },
    { id: 'release', name: 'Release', instruction: 'Ship a version bump.' }
  ]
}

/** 一份健康的 worker 快照（只让面板壳起来；Prompts 组读的是 `prompts`）。 */
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

/** 一个分片的读数：正文用分片键代替（面板只显示它，不解释）。 */
function partOf(key: (typeof PROMPT_PART_KEYS)[number]): PanelPromptPart {
  const registered = PROMPT_PARTS[key]
  return {
    key,
    roles: [...registered.roles],
    kind: registered.kind,
    placement: registered.placement,
    text: `Built-in text of ${key}`,
    placeholders:
      key === 'runtime/environment'
        ? ['{variables}', '{cli}', '{token_file}', '{state_dir}', '{repository}']
        : key === 'runtime/policy'
          ? ['{version}', '{mode}', '{rules}']
          : key === 'runtime/policy/none'
            ? ['{version}', '{mode}']
            : [],
    base: `b-${key}`
  }
}

/** 一份读数；每个用例只写它关心的字段。 */
function viewOf(overrides: Partial<PanelPromptsView> = {}): PanelPromptsView {
  return {
    revision: 1,
    saved: { revision: 1, predecessor: null, at: AT, origin: 'panel' },
    config: {},
    sections: ['communication', 'scope', 'delivery'],
    parts: PROMPT_PART_KEYS.map(partOf),
    defaultChanged: [],
    removedParts: [],
    changes: [],
    history: [{ revision: 1, predecessor: null, at: AT, origin: 'panel' }],
    skills: [
      {
        name: 'superagent-github',
        path: `${STATE_DIR}/skills/superagent-github/SKILL.md`,
        text: 'GitHub skill body',
        readOnly: true
      },
      {
        name: 'superagent-feishu',
        path: `${STATE_DIR}/skills/superagent-feishu/SKILL.md`,
        text: 'Feishu skill body',
        readOnly: true
      }
    ],
    stateDir: STATE_DIR,
    maxChars: 200_000,
    texts: {
      saved: { orchestrator: 'orchestrator saved text', worker: 'worker saved text' },
      defaults: { orchestrator: 'orchestrator default text', worker: 'worker default text' }
    },
    ...overrides
  }
}

let panel: Awaited<ReturnType<typeof mount>> | undefined

/** 最近一次挂载的 Prompts 面板（子页切换要按它上面的按钮）。 */
let mountedPanel: Awaited<ReturnType<typeof mount>> | undefined

/** 切到 Prompts 的一个子页（helper 见 `tests/support/panel-nav.ts`）。 */
async function openPromptTab(tab: 'edit' | 'full' | 'history' | 'skills'): Promise<void> {
  if (mountedPanel === undefined) throw new Error('no Prompts panel is mounted')
  await openPromptPage(mountedPanel, tab)
}

afterEach(async () => {
  await panel?.unmount()
  panel = undefined
})

/** 子页的标签（测试与页面读同一份文案）。 */
const tabLabel = (locale: string, tab: PromptTab): string =>
  translate(locale, `prompt.tab.${tab}` as CopyKey)

/** 一次请求的入参（最后一次同名请求）。 */
function requestInput(
  host: ReturnType<typeof mockHost>,
  name: string
): Record<string, unknown> | undefined {
  const call = host
    .callsOf('plugin.request')
    .map((params) => params as { name?: string; input?: Record<string, unknown> })
    .filter((params) => params.name === name)
    .at(-1)
  return call?.input
}

/** 一段文案的字面量正则（文案里有括号/星号，直接 `new RegExp` 会变成组语法）。 */
function literal(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
}

/** 面板发过的请求名（按顺序）。 */
function requestNames(host: ReturnType<typeof mockHost>): string[] {
  return host.callsOf('plugin.request').map((params) => (params as { name?: string }).name ?? '')
}

/**
 * 一条组合后的全文：草稿里的团队段与 override 会出现在里面（预览由 worker 拼，这里只
 * 模拟「同一份配置 → 同一份全文」）。
 */
function textsOf(config: PanelPromptConfig): { orchestrator: string; worker: string } {
  const communication = config.team?.communication ?? 'default communication'
  const scope = config.team?.scope ?? 'default scope'
  const delivery = config.team?.delivery ?? 'default delivery'
  const replies = config.overrides?.['runtime/replies']?.text ?? 'default replies'
  const body = `${communication}\n${scope}\n${delivery}\n${replies}`
  return { orchestrator: `orchestrator text\n${body}`, worker: `worker text\n${body}` }
}

/**
 * 挂载面板并停在 Settings → Prompts。`read` 每次 `prompts` 请求都重新取一份读数；
 * `issuesOf` 让预览按草稿返回一条拒绝（保存因此不会发出去）。
 */
async function openPrompts(
  read: () => PanelPromptsView,
  options: {
    readonly issuesOf?: (config: PanelPromptConfig) => readonly PanelPromptIssue[]
    readonly locale?: string
  } = {}
): Promise<Awaited<ReturnType<typeof mount>>> {
  const locale = options.locale ?? 'en'
  const requests: Requests = {
    state: () => snapshot(),
    prompts: () => read(),
    'prompts.preview': (input: unknown) => {
      const config = ((input ?? {}) as { config?: PanelPromptConfig }).config ?? {}
      const issues = options.issuesOf?.(config) ?? []
      if (issues.length > 0) return { ok: false, issues }
      return { ok: true, texts: textsOf(config), config, dropped: [] }
    },
    'prompts.save': (input: unknown) => {
      const config = ((input ?? {}) as { config?: PanelPromptConfig }).config ?? {}
      // 保存写下的配置就是预览说会写下的那份（与 worker 的预览同一语义）。
      return viewOf({ ...read(), config, revision: read().revision + 1 })
    },
    'prompts.restore': () => read(),
    // Prompts 是 Settings 页的一组：组框架自己的读数与历史也要答得上（空读数就够，
    // 这一组的内容只读写 `prompts` 那一份）。
    'settings.read': () => emptySettingsPage(),
    'settings.history': () => ({ revision: 1, history: [] })
  }
  panel = await mount(panelModule, {
    host: mockHost({
      requests,
      // 打开面板就停在 Settings 的 Prompts 组（`settings.group` 是这个 atom 的 id）。
      storage: { 'panel.page': 'settings', 'settings.group': 'prompts' }
    }),
    locale
  })
  mountedPanel = panel
  return panel
}

// ---------------------------------------------------------------------------
// 四个子页与「已修改」标记
// ---------------------------------------------------------------------------

test('the group has the four sub-tabs, and the edit page marks the changed parts', async () => {
  const mounted = await openPrompts(() =>
    viewOf({
      config: {
        team: { communication: 'Talk in short sentences.' },
        overrides: { 'runtime/replies': { text: 'One line replies.', base: 'b-runtime/replies' } }
      }
    })
  )
  assert.equal(
    mounted.persisted.storage['panel.promptTab'] ?? 'edit',
    'edit',
    'the edit page opens first'
  )
  const rendered = JSON.stringify(mounted.tree())
  for (const tab of PROMPT_TABS) {
    // 四个子页是 RadioGroup 的选项（宿主把选项画在控件内部，树里以 option 的形状存在）。
    assert.ok(rendered.includes(JSON.stringify(tabLabel('en', tab))), `the ${tab} sub-page is there`)
  }
  // 三段团队文本与每个分片一个字段（§M.3：「每个内置分片的 override」）。
  assert.equal(
    mounted.findAll({ type: 'Textarea' }).length,
    3 + PROMPT_PART_KEYS.filter((key) => PROMPT_PARTS[key].kind !== 'team').length,
    'three team sections and one field per other part'
  )
  // 被改的两个分片带标记（值来自面板对草稿的同一份判定）。
  assert.equal(mounted.findAll({ text: COPY['prompt.changed'].en }).length, 2)
  assert.deepEqual(
    changedParts(
      {
        team: { communication: 'Talk in short sentences.' },
        overrides: { 'runtime/replies': { text: 'One line replies.' } }
      },
      PROMPT_PART_KEYS.map(partOf)
    ),
    ['runtime/replies', 'team/communication']
  )
  // 模板处展示必保留占位符（§L.3）。
  assert.ok(mounted.find({ text: /\{variables\}/ }), 'the environment template shows its placeholders')
  assert.ok(mounted.find({ text: /\{token_file\}/ }), 'every placeholder of the template is listed')
  assert.deepEqual(mounted.refusals, [])
  assert.deepEqual(mounted.errors, [])
  await mounted.unmount()
  panel = undefined
})

test('typing an override marks the part changed, and using the default drops it again', async () => {
  const mounted = await openPrompts(() => viewOf())
  assert.equal(mounted.findAll({ text: COPY['prompt.changed'].en }).length, 0)

  await mounted.type({ type: 'Textarea', label: 'runtime/replies' }, 'Reply in one line.', { replace: true })
  assert.equal(mounted.findAll({ text: COPY['prompt.changed'].en }).length, 1, 'the edited part is marked')
  assert.ok(mounted.find({ text: translate('en', 'draft.changeOne', { count: 1 }) }), 'one change')

  const reset = translate('en', 'prompt.useDefault', { part: 'runtime/replies' })
  assert.ok(mounted.find({ text: reset }), 'the changed part offers the default again')
  await mounted.press({ text: reset })
  assert.equal(mounted.findAll({ text: COPY['prompt.changed'].en }).length, 0, 'the draft follows the default again')
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

// ---------------------------------------------------------------------------
// 保存：worker 的拒绝原样可见
// ---------------------------------------------------------------------------

test('a template that dropped a required placeholder is refused, and the page says why', async () => {
  const mounted = await openPrompts(() => viewOf(), {
    issuesOf: (config) =>
      config.overrides?.['runtime/environment']?.text.includes('{variables}') === true ||
      config.overrides?.['runtime/environment'] === undefined
        ? []
        : [
            {
              code: 'missing_placeholder',
              part: 'runtime/environment',
              values: { part: 'runtime/environment', placeholders: '{variables}' }
            }
          ]
  })
  await mounted.type(
    { type: 'Textarea', label: 'runtime/environment' },
    'No placeholders at all.',
    { replace: true }
  )
  await mounted.press({ text: COPY['action.save'].en })

  assert.deepEqual(requestInput(mounted.host, 'prompts.preview')?.['config'], {
    overrides: { 'runtime/environment': { text: 'No placeholders at all.', base: 'b-runtime/environment' } }
  })
  assert.equal(requestInput(mounted.host, 'prompts.save'), undefined, 'an invalid draft is not sent as a save')
  assert.ok(
    mounted.find({
      text: literal(
        translate('en', 'prompt.error.missing_placeholder', { placeholders: '{variables}' })
      )
    }),
    'the readable reason names the placeholder'
  )
  assert.ok(mounted.find({ text: /runtime\/environment/ }), 'the field list names the part')
  assert.ok(mounted.find({ text: COPY['action.save'].en }), 'the draft is still there to fix')
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

// ---------------------------------------------------------------------------
// 全文与两个 diff 基准
// ---------------------------------------------------------------------------

test('the full prompt shows the composed text and diffs it against the saved text or the default', async () => {
  const mounted = await openPrompts(() =>
    viewOf({ config: { team: { communication: 'Talk in short sentences.' } } })
  )
  await openPromptTab('full')

  assert.ok(mounted.find({ text: /orchestrator saved text/ }), 'the assembled orchestrator text is shown')
  assert.ok(mounted.find({ text: COPY['prompt.sameAsSaved'].en }), 'nothing changed yet')
  assert.equal(mounted.findAll({ type: 'CodeView' }).length, 2, 'the text and the diff are two code views')
  assert.equal(requestNames(mounted.host).includes('prompts.preview'), false, 'a clean draft needs no preview')

  // 基准换成「默认」：左边成了默认文本，同一个正文于是显示为一条被替换的行。
  await mounted.select(
    { type: 'RadioGroup', label: translate('en', 'prompt.full.baseline') },
    'default'
  )
  assert.ok(mounted.find({ text: /- orchestrator default text/ }), 'the default is the left side now')
  assert.ok(mounted.find({ text: /\+ orchestrator saved text/ }), 'the saved text is the right side')
  assert.equal(mounted.find({ text: COPY['prompt.sameAsSaved'].en }), null, 'they differ now')
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('an edited draft is previewed by the worker, and the diff shows the added lines', async () => {
  const mounted = await openPrompts(() => viewOf())
  await mounted.type(
    { type: 'Textarea', label: translate('en', 'prompt.section.delivery') },
    'Open a PR before you stop.',
    { replace: true }
  )
  await openPromptTab('full')

  assert.deepEqual(requestInput(mounted.host, 'prompts.preview'), {
    config: { team: { delivery: 'Open a PR before you stop.' } }
  })
  assert.ok(mounted.find({ text: /\+ Open a PR before you stop\./ }), 'the diff marks the added line')
  assert.equal(mounted.find({ text: COPY['prompt.sameAsSaved'].en }), null, 'it is no longer the saved text')
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

// ---------------------------------------------------------------------------
// 历史与恢复
// ---------------------------------------------------------------------------

test('the history page lists the versions and restoring one returns to the edit page', async () => {
  const mounted = await openPrompts(() =>
    viewOf({
      revision: 3,
      history: [
        { revision: 3, predecessor: 2, at: AT, origin: 'panel' },
        { revision: 2, predecessor: 1, at: AT, origin: 'tool' },
        { revision: 1, predecessor: null, at: AT, origin: 'panel' }
      ]
    })
  )
  await openPromptTab('history')
  assert.equal(mounted.rowsOf({ type: 'Table' }).length, 3, 'every version is a row')
  assert.ok(mounted.find({ text: COPY['prompt.history.intro'].en }), 'the page explains that history is read-only')

  await mounted.activateRow({ type: 'Table' }, '2')
  await mounted.press({ text: COPY['prompt.restore'].en })
  assert.deepEqual(requestInput(mounted.host, 'prompts.restore'), { revision: 2, baseRevision: 3 })
  assert.equal(
    mounted.persisted.storage['panel.promptTab'],
    'edit',
    'restoring returns to the edit page'
  )
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

// ---------------------------------------------------------------------------
// default-updated：旧默认 vs 新默认，两个选择
// ---------------------------------------------------------------------------

test('a default-updated part shows both texts and offers keeping mine or taking the new default', async () => {
  /** 一份「override 编辑自旧默认」的读数：旧默认与新默认都要给出来（§L.4）。 */
  const outdated = (): PanelPromptsView =>
    viewOf({
      config: { overrides: { 'runtime/replies': { text: 'My replies.', base: 'b-old' } } },
      defaultChanged: ['runtime/replies'],
      changes: [
        {
          part: 'runtime/replies',
          base: 'b-old',
          previous: 'Old default replies.',
          next: 'New default replies.',
          removed: false
        }
      ]
    })

  // 「用新默认」：丢掉这一段 override，之后它跟随内置文本。
  const adopting = await openPrompts(outdated)
  assert.ok(adopting.find({ text: literal(COPY['prompt.defaultUpdated'].en) }), 'the banner names the situation')
  assert.ok(adopting.find({ text: /Old default replies\./ }), 'the old default is shown')
  assert.ok(adopting.find({ text: /New default replies\./ }), 'the new default is shown')
  await adopting.press({ text: translate('en', 'prompt.adoptDefault', { part: 'runtime/replies' }) })
  assert.deepEqual(
    requestInput(adopting.host, 'prompts.save')?.['config'],
    {},
    'taking the default drops the override'
  )
  assert.deepEqual(adopting.refusals, [])
  await adopting.unmount()
  panel = undefined

  // 「保留我的文本」：同一个正文，base 换成当前默认的键，于是它不再算 default-updated。
  const keeping = await openPrompts(outdated)
  await keeping.press({ text: translate('en', 'prompt.keepMine', { part: 'runtime/replies' }) })
  assert.deepEqual(
    requestInput(keeping.host, 'prompts.save')?.['config'],
    { overrides: { 'runtime/replies': { text: 'My replies.', base: 'b-runtime/replies' } } },
    'keeping mine re-bases the override on the current default'
  )
  assert.deepEqual(keeping.refusals, [])
  await keeping.unmount()
  panel = undefined
})

// ---------------------------------------------------------------------------
// 技能：内置只读 + 团队技能增删改
// ---------------------------------------------------------------------------

test('the skills page keeps the built-in skills read-only and adds, edits and deletes team skills', async () => {
  const mounted = await openPrompts(() =>
    viewOf({ config: { skills: { 'team-style': 'Write short sentences.' } } })
  )
  await openPromptTab('skills')

  // 内置技能只读，每个技能都带自己的稳定路径。
  assert.ok(mounted.find({ text: literal(COPY['prompt.skills.builtIn'].en) }), 'the read-only group is named')
  assert.ok(mounted.find({ text: /superagent-github/ }), 'the built-in skill is listed')
  assert.ok(mounted.find({ text: /\/var\/lib\/superagent\/skills\/superagent-github\/SKILL\.md/ }))
  assert.ok(mounted.find({ text: /\/var\/lib\/superagent\/skills\/team-style\/SKILL\.md/ }))
  assert.equal(mounted.findAll({ type: 'Textarea' }).length, 1, 'only team skills are editable')
  assert.equal(skillPath(STATE_DIR, 'team-style'), `${STATE_DIR}/skills/team-style/SKILL.md`)

  // 新建一个团队技能并写正文，然后删掉旧的：都是同一份配置的草稿改动。
  await mounted.type({ type: 'Input', label: translate('en', 'prompt.skills.name') }, 'team-review')
  await mounted.press({ text: COPY['prompt.skills.add'].en })
  await mounted.type(
    { type: 'Textarea', label: 'team-review' },
    'Review the diff before you report.',
    { replace: true }
  )
  await mounted.press({ text: translate('en', 'prompt.skills.remove', { name: 'team-style' }) })
  await mounted.press({ text: COPY['action.save'].en })

  assert.deepEqual(requestInput(mounted.host, 'prompts.save')?.['config'], {
    skills: { 'team-review': 'Review the diff before you report.' }
  })
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  panel = undefined
})

test('a refused skill name or an over-limit config is answered with a readable reason', async () => {
  const refusals: readonly { issue: PanelPromptIssue; copy: string }[] = [
    {
      issue: {
        code: 'reserved_skill_name',
        part: 'superagent-github',
        values: { skill: 'superagent-github' }
      },
      copy: translate('en', 'prompt.error.reserved_skill_name', { skill: 'superagent-github' })
    },
    {
      issue: { code: 'invalid_skill_name', part: 'Team Style', values: { skill: 'Team Style' } },
      copy: translate('en', 'prompt.error.invalid_skill_name')
    },
    {
      issue: { code: 'too_long', part: null, values: { limit: '200000', actual: '240000' } },
      copy: translate('en', 'prompt.error.too_long', { limit: '200000', actual: '240000' })
    }
  ]
  for (const refusal of refusals) {
    panel = await openPrompts(() => viewOf(), { issuesOf: () => [refusal.issue] })
    await openPromptTab('skills')
    await panel.type({ type: 'Input', label: translate('en', 'prompt.skills.name') }, 'team-style')
    await panel.press({ text: COPY['prompt.skills.add'].en })
    await panel.type({ type: 'Textarea', label: 'team-style' }, 'Write short sentences.', {
      replace: true
    })
    await panel.press({ text: COPY['action.save'].en })
    assert.ok(panel.find({ text: literal(refusal.copy) }), `${refusal.issue.code} is readable`)
    assert.equal(requestInput(panel.host, 'prompts.save'), undefined, 'a refused draft is not saved')
    assert.deepEqual(panel.refusals, [])
    await panel.unmount()
    panel = undefined
  }
})

// ---------------------------------------------------------------------------
// worker 侧：真库 + 真版本库 + 真 handler
// ---------------------------------------------------------------------------

/** 一份真读数上的版本库接线（与组合根同一处构造）。 */
function promptFixture(): {
  readonly versions: ReturnType<typeof createPromptVersions>
  readonly store: ReturnType<typeof openTempStore>['store']
  readonly stateDir: string
  readonly cleanup: () => void
} {
  const { store, stateDir, cleanup } = openTempStore()
  const versions = createPromptVersions({ store, now: () => AT })
  return { versions, store, stateDir, cleanup }
}

test('the prompts read view marks the changed parts, keeps the bases and lists the skill files', () => {
  const { versions, stateDir, cleanup } = promptFixture()
  try {
    assert.deepEqual(
      promptPanelView({
        versions,
        stateDir,
        environment: () => ENVIRONMENT,
        policy: () => POLICY
      }).config,
      {},
      'nothing saved is the default config'
    )

    versions.save({
      config: {
        team: { communication: 'Talk in short sentences.' },
        overrides: { 'runtime/replies': { text: 'One line replies.' } },
        skills: { 'team-style': 'Write short sentences.' }
      },
      baseRevision: 0,
      origin: 'panel'
    })
    const view = promptPanelView({
      versions,
      stateDir,
      environment: () => ENVIRONMENT,
      policy: () => POLICY
    })
    assert.equal(view.revision, 1)
    assert.deepEqual(view.saved, { revision: 1, predecessor: null, at: AT, origin: 'panel' })
    assert.deepEqual(view.parts.map((part) => part.key), [...PROMPT_PART_KEYS], 'every part of the registry')
    const replies = view.parts.find((part) => part.key === 'runtime/replies')
    assert.equal(replies?.base, 'b-runtime/replies', 'each part carries the key of its current text')
    assert.deepEqual(
      view.parts.find((part) => part.key === 'runtime/environment')?.placeholders,
      ['{variables}', '{cli}', '{token_file}', '{state_dir}', '{repository}']
    )
    assert.deepEqual(
      changedParts(view.config, view.parts),
      ['runtime/replies', 'team/communication'],
      'the edited parts are the ones that differ from the built-in text'
    )
    // 技能：两个内置只读 + 一个团队技能，各自带稳定路径。
    assert.deepEqual(
      view.skills.map((skill) => [skill.name, skill.readOnly, skill.path]),
      [
        ['superagent-github', true, join(stateDir, 'skills', 'superagent-github', 'SKILL.md')],
        ['superagent-feishu', true, join(stateDir, 'skills', 'superagent-feishu', 'SKILL.md')],
        ['team-style', false, join(stateDir, 'skills', 'team-style', 'SKILL.md')]
      ]
    )
    // 两份全文：已保存的那份含团队段与 override，默认那份不含。
    assert.ok(view.texts.saved.worker.includes('Talk in short sentences.'))
    assert.ok(view.texts.saved.worker.includes('One line replies.'))
    assert.equal(view.texts.defaults.worker.includes('One line replies.'), false)
    assert.equal(view.texts.defaults.worker.includes(POLICY.version), false, 'the worker has no Policy section')
    assert.ok(view.texts.saved.orchestrator.includes(POLICY.version), 'the orchestrator carries the Policy version')
    assert.equal(view.maxChars, 200_000)
    assert.deepEqual(view.history.map((version) => version.revision), [1])
  } finally {
    cleanup()
  }
})

test('a default-updated override carries both the old and the new default', () => {
  const { versions, store, stateDir, cleanup } = promptFixture()
  try {
    versions.save({
      config: { overrides: { 'runtime/replies': { text: 'My replies.', base: 'b-old' } } },
      baseRevision: 0,
      origin: 'tool'
    })
    // 升级：旧默认正文由更早的构建留在 `prompt-builtin-base` 里。
    store.kvSet(PROMPT_BUILTIN_BASE_KEY, { 'b-old': 'Old default replies.' })
    const view = promptPanelView({
      versions,
      stateDir,
      environment: () => ENVIRONMENT,
      policy: () => POLICY
    })
    assert.deepEqual(view.defaultChanged, ['runtime/replies'])
    assert.deepEqual(view.changes, [
      {
        part: 'runtime/replies',
        base: 'b-old',
        previous: 'Old default replies.',
        next: PROMPT_PARTS['runtime/replies'].lines.join('\n'),
        removed: false
      }
    ])
  } finally {
    cleanup()
  }
})

test('the worker answers the Prompts requests the panel sends, and refuses a dropped placeholder', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'superagent-prompts-'))
  const worker = await mountWorker(main, { host: mockHost({ settings: { stateDir } }) })
  try {
    const initial = (await worker.request('prompts')) as PanelPromptsView
    assert.equal(initial.revision, 0, 'a fresh install reads as the built-in default')
    assert.deepEqual(initial.config, {})
    assert.ok(initial.texts.saved.worker.length > 0, 'the assembled text is readable even before the first save')
    assert.deepEqual(initial.history, [])

    // 丢占位符的模板被 handler 按固定码拒绝（面板只显示它们的码，不自己校验一遍）。
    await assert.rejects(
      worker.request('prompts.save', {
        config: { overrides: { 'runtime/environment': { text: 'No placeholders at all.' } } },
        baseRevision: 0
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'missing_placeholder')
        return true
      }
    )
    // 预览是同一份校验，只是不写库：拒绝以 `issues[]` 回来（填槽值还在）。
    const refused = (await worker.request('prompts.preview', {
      config: { overrides: { 'runtime/environment': { text: 'No placeholders at all.' } } }
    })) as { ok: boolean; issues: readonly PanelPromptIssue[] }
    assert.equal(refused.ok, false)
    assert.equal(refused.issues[0]?.code, 'missing_placeholder')
    assert.equal(refused.issues[0]?.part, 'runtime/environment')

    // 保留占位符的同一段可以被保存，并且真的产生一个版本。
    const saved = (await worker.request('prompts.save', {
      config: {
        team: { delivery: 'Open a PR before you stop.' },
        overrides: {
          'runtime/environment': {
            text: 'vars {variables}; cli {cli}; token {token_file}; state {state_dir}; repo {repository}'
          }
        }
      },
      baseRevision: 0
    })) as PanelPromptsView
    assert.equal(saved.revision, 1)
    assert.deepEqual(saved.saved?.origin, 'panel')
    assert.ok(
      /cli .*superagent\.mjs/.test(saved.texts.saved.worker),
      'the template is filled from the deployment facts'
    )

    // 恢复版本 0（默认）也是「再存一个新版本」，历史只增不改。
    const restored = (await worker.request('prompts.restore', { revision: 0, baseRevision: 1 })) as PanelPromptsView
    assert.equal(restored.revision, 2)
    assert.deepEqual(restored.config, {})
    assert.deepEqual(restored.history.map((version) => version.revision), [2, 1])

    // 预览与保存同一份校验：团队技能在全文里只出现路径。
    const preview = (await worker.request('prompts.preview', {
      config: { skills: { 'team-style': 'Write short sentences.' } }
    })) as { ok: boolean; texts: { worker: string } }
    assert.equal(preview.ok, true)
    assert.ok(preview.texts.worker.includes('team-style/SKILL.md'), 'a team skill appears by path')
    const reserved = (await worker.request('prompts.preview', {
      config: { skills: { 'superagent-github': 'x' } }
    })) as { ok: boolean; issues: readonly PanelPromptIssue[] }
    assert.equal(reserved.ok, false, 'a reserved skill name is refused by the preview too')
    assert.equal(reserved.issues[0]?.code, 'reserved_skill_name')
    assert.equal(reserved.issues[0]?.part, 'superagent-github')

    // 形状不对的请求是 `invalid_params`，不是一个空答案。
    await assert.rejects(worker.request('prompts.save', { config: {} }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'invalid_params')
      return true
    })
    await assert.rejects(worker.request('prompts.restore', { revision: 99, baseRevision: 2 }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'missing')
      return true
    })
    await assert.rejects(worker.request('prompts.save', { config: {}, baseRevision: 0 }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'stale_revision')
      return true
    })
    assert.deepEqual(worker.refusals, [])

    // 团队技能真的落在自己的稳定路径上（§L.6：技能是文件）。
    const skilled = (await worker.request('prompts.save', {
      config: { skills: { 'team-style': 'Write short sentences.' } },
      baseRevision: 2
    })) as PanelPromptsView
    assert.equal(skilled.revision, 3)
    assert.equal(skilled.skills.some((skill) => skill.name === 'team-style'), true)
    assert.equal(
      readFileSync(join(stateDir, 'skills', 'team-style', 'SKILL.md'), 'utf8'),
      'Write short sentences.'
    )
  } finally {
    await worker.deactivate()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

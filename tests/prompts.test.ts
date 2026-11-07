// 内置提示词的**分片清单、模板占位符、组装顺序与优先级**（§L.1–L.3、§L.5.1）。
//
// 断言口径（票面验收第一、二条）：
// - 分片键与 §L.2 的表逐键相等，且每个分片的角色、放置位置（prompt 或 skills）写死在注册表里；
// - 生成段（执行环境、Policy、无规则替代）的必保留占位符逐字列出，缺一个就是
//   `missing_placeholder`（固定码，不解析文案）；
// - 组装顺序**逐段断言位置**：每个分片的正文在拼好的全文里出现，且 `indexOf` 严格递增——
//   只说「包含」会让顺序错了还绿；
// - 优先级分两层断言：文本解析的弱→强（built-in < team < override < deployment）与
//   §L.3 的强→弱五层（工具与宿主强制 > 内置/生成段 > 主动票的匹配规则 > 团队三段 > 外部文本）。
//
// 使用提示词的一方只用 `composePrompt` / `promptSections`：本文件的断言不碰私有函数。
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  composePrompt,
  composeSkill,
  fillTemplate,
  missingPlaceholders,
  PROMPT_PART_KEYS,
  PROMPT_PARTS,
  PROMPT_PRIORITY,
  PROMPT_ORDER,
  PROMPT_TEXT_SOURCES,
  promptSections,
  TEAM_SECTIONS,
  TEAM_SECTION_HEADINGS,
  validateOverrides,
  PromptTextError,
  type ComposeInput,
  type PromptEnvironment,
  type PromptPolicy,
  type PromptPartKey
} from '../src/worker/app/prompts.ts'
import { mandateInstructions } from '../src/worker/executor/mandate.ts'

/** 部署事实（§G.5 的字面量形状；路径里有空格，和插件安装目录一样）。 */
const ENVIRONMENT: PromptEnvironment = {
  variables: ['DSH_SUPERAGENT_DIR', 'DSH_SUPERAGENT_TICKET', 'SUPERAGENT_CLI', 'SUPERAGENT_TOKEN_FILE'],
  cliPath: '/Users/me/Library/Application Support/Orca/plugins/whutlichao.superagent/src/bin/superagent.mjs',
  tokenFile: '/Users/me/.local/state/orca-superagent/tokens/asg_7f3a',
  stateDir: '/Users/me/.local/state/orca-superagent',
  repository: 'acme/widgets'
}

/** 一份启用了两条规则的 Policy（§K.1、§K.5）。 */
const POLICY: PromptPolicy = {
  version: 'policy-4f2a',
  mode: 'auto',
  rules: [
    { id: 'copy', name: 'Copy fixes', instruction: 'Fix a typo or a wrong label in one place.' },
    { id: 'visual', name: 'Visual fixes', instruction: 'Fix a spacing defect against an established reference.' }
  ]
}

/** 拼一份提示词的输入；`overrides` / `team` 按用例覆盖。 */
function input(overrides: Partial<ComposeInput> = {}): ComposeInput {
  return { role: 'orchestrator', environment: ENVIRONMENT, policy: POLICY, ...overrides }
}

/** 一段正文在全文里的起点；找不到时给出可读的失败原因。 */
function positionOf(haystack: string, needle: string, label: string): number {
  const index = haystack.indexOf(needle)
  assert.notEqual(index, -1, `the assembled prompt is missing ${label}: ${needle.slice(0, 80)}`)
  return index
}

/** 断言这些片段在全文里依次出现（位置严格递增，也不允许重复同一片段冒充两段）。 */
function assertInOrder(haystack: string, needles: readonly (readonly [string, string])[]): void {
  let previous = -1
  for (const [needle, label] of needles) {
    const index = positionOf(haystack, needle, label)
    assert.ok(index > previous, `${label} must come after the previous section`)
    previous = index
  }
}

describe('the part registry', () => {
  test('names every part of the design table exactly once, in the table order', () => {
    assert.deepEqual([...PROMPT_PART_KEYS], [
      'runtime/shared',
      'runtime/orchestrator',
      'runtime/worker',
      'runtime/subscriptions',
      'runtime/replies',
      'runtime/dispatch',
      'runtime/work',
      'runtime/admission',
      'runtime/handoff',
      'runtime/handoff/orchestrator',
      'runtime/handoff/worker',
      'runtime/cli',
      'skill/github',
      'skill/feishu',
      'runtime/environment',
      'runtime/policy',
      'runtime/policy/none',
      'team/communication',
      'team/scope',
      'team/delivery'
    ])
  })

  test('every part is a non-empty list of single-line sentences with its own key back', () => {
    for (const key of PROMPT_PART_KEYS) {
      const part = PROMPT_PARTS[key]
      assert.equal(part.key, key)
      assert.ok(part.lines.length > 0, `${key} has no text`)
      assert.ok(part.roles.length > 0, `${key} names no role`)
      for (const line of part.lines) {
        assert.equal(line.includes('\n'), false, `${key} has a line that carries a newline`)
        assert.ok(line.trim().length > 0, `${key} has an empty line`)
        assert.equal(line, line.trimEnd(), `${key} has trailing whitespace: ${line}`)
      }
    }
  })

  test('says which role reads each part and where the text lives', () => {
    const roleOf = (key: PromptPartKey) => [...PROMPT_PARTS[key].roles]
    assert.deepEqual(roleOf('runtime/shared'), ['orchestrator', 'worker'])
    assert.deepEqual(roleOf('runtime/orchestrator'), ['orchestrator'])
    assert.deepEqual(roleOf('runtime/worker'), ['worker'])
    assert.deepEqual(roleOf('runtime/dispatch'), ['orchestrator'])
    assert.deepEqual(roleOf('runtime/work'), ['worker'])
    assert.deepEqual(roleOf('runtime/admission'), ['orchestrator'])
    assert.deepEqual(roleOf('runtime/handoff/orchestrator'), ['orchestrator'])
    assert.deepEqual(roleOf('runtime/handoff/worker'), ['worker'])
    assert.deepEqual(roleOf('runtime/policy'), ['orchestrator'])
    // 两个技能文本与命令行用法不拼进系统提示词：它们写成 SKILL.md 文件（§L.6）。
    const skills = PROMPT_PART_KEYS.filter((key) => PROMPT_PARTS[key].placement === 'skill')
    assert.deepEqual(skills, ['runtime/cli', 'skill/github', 'skill/feishu'])
    const kinds = Object.fromEntries(PROMPT_PART_KEYS.map((key) => [key, PROMPT_PARTS[key].kind]))
    assert.equal(kinds['runtime/environment'], 'generated')
    assert.equal(kinds['runtime/policy'], 'generated')
    assert.equal(kinds['runtime/policy/none'], 'generated')
    assert.equal(kinds['team/communication'], 'team')
    assert.equal(kinds['team/scope'], 'team')
    assert.equal(kinds['team/delivery'], 'team')
    assert.equal(kinds['runtime/shared'], 'built-in')
  })

  test('declares the placeholders validation keeps for each generated template', () => {
    assert.deepEqual([...PROMPT_PARTS['runtime/environment'].placeholders], [
      '{variables}',
      '{cli}',
      '{token_file}',
      '{state_dir}',
      '{repository}'
    ])
    assert.deepEqual([...PROMPT_PARTS['runtime/policy'].placeholders], ['{version}', '{mode}', '{rules}'])
    assert.deepEqual([...PROMPT_PARTS['runtime/policy/none'].placeholders], ['{version}', '{mode}'])
    for (const key of PROMPT_PART_KEYS) {
      if (key === 'runtime/environment' || key === 'runtime/policy' || key === 'runtime/policy/none') continue
      assert.deepEqual([...PROMPT_PARTS[key].placeholders], [], `${key} should not require placeholders`)
    }
    // 模板正文里真的带着这些占位符，否则「必保留」无从谈起。
    for (const key of ['runtime/environment', 'runtime/policy', 'runtime/policy/none'] as const) {
      const text = PROMPT_PARTS[key].lines.join('\n')
      for (const placeholder of PROMPT_PARTS[key].placeholders) {
        assert.ok(text.includes(placeholder), `${key} must carry ${placeholder}`)
      }
    }
  })

  test('the three team sections have the headings other parts refer them by', () => {
    assert.deepEqual([...TEAM_SECTIONS], ['communication', 'scope', 'delivery'])
    assert.deepEqual(TEAM_SECTION_HEADINGS, {
      communication: 'Communication',
      scope: 'Ticket scope',
      delivery: 'Delivery requirements'
    })
  })
})

describe('placeholder validation', () => {
  test('reports every placeholder an override dropped', () => {
    assert.deepEqual(missingPlaceholders('runtime/policy', 'Policy version {version}, mode {mode}. No rules.'), ['{rules}'])
    assert.deepEqual(missingPlaceholders('runtime/policy/none', '{version} {mode}'), [])
    assert.deepEqual(missingPlaceholders('runtime/shared', 'nothing to keep'), [])
  })

  test('refuses an override of a generated template that drops a placeholder', () => {
    assert.throws(
      () => validateOverrides({ 'runtime/environment': 'Execution environment: see the settings page.' }),
      (error: unknown) => {
        assert.ok(error instanceof PromptTextError, 'the refusal is a prompt text error')
        assert.equal(error.code, 'missing_placeholder')
        assert.deepEqual(error.values, {
          part: 'runtime/environment',
          placeholders: '{variables}, {cli}, {token_file}, {state_dir}, {repository}'
        })
        return true
      }
    )
    assert.throws(
      () => validateOverrides({ 'runtime/policy': 'Policy {version} {mode}.' }),
      (error: unknown) => error instanceof PromptTextError && error.code === 'missing_placeholder'
    )
  })

  test('keeps an override that retains every placeholder', () => {
    const kept = validateOverrides({
      'runtime/policy': 'Policy {version} in {mode}:\n{rules}',
      'runtime/shared': 'A team rewrite of the shared part.'
    })
    assert.deepEqual(kept, {
      'runtime/policy': 'Policy {version} in {mode}:\n{rules}',
      'runtime/shared': 'A team rewrite of the shared part.'
    })
  })

  test('refuses a part this version does not have, and an empty part', () => {
    assert.throws(
      () => validateOverrides({ 'runtime/nonexistent': 'text' }),
      (error: unknown) =>
        error instanceof PromptTextError && error.code === 'unknown_part' && error.values.part === 'runtime/nonexistent'
    )
    assert.throws(
      () => validateOverrides({ 'runtime/shared': '   ' }),
      (error: unknown) => error instanceof PromptTextError && error.code === 'invalid_part'
    )
  })
})

describe('the assembled prompt', () => {
  test('orders the orchestrator sections exactly as §L.3 does', () => {
    const sections = promptSections(input())
    assert.deepEqual(
      sections.map((section) => section.key),
      PROMPT_ORDER.orchestrator
    )
    // 每一段都在全文里，且出现位置依次递增——拼错顺序会让这条先红。
    const text = composePrompt(input())
    assertInOrder(
      text,
      sections.map((section) => [firstLineOf(section.text), section.key] as const)
    )
    // 段与段之间正好一个空行：没有粘连，也没有三连空行。
    assert.equal(text.includes('\n\n\n'), false, 'sections must be separated by one blank line')
  })

  test('orders the worker sections exactly as §L.3 does', () => {
    const sections = promptSections(input({ role: 'worker' }))
    assert.deepEqual(
      sections.map((section) => section.key),
      PROMPT_ORDER.worker
    )
    assertInOrder(
      composePrompt(input({ role: 'worker' })),
      sections.map((section) => [firstLineOf(section.text), section.key] as const)
    )
  })

  test('puts the shared part and the role first and the role-specific guides after the team sections', () => {
    const text = composePrompt(input())
    const shared = positionOf(text, PROMPT_PARTS['runtime/shared'].lines[0]!, 'runtime/shared')
    const role = positionOf(text, PROMPT_PARTS['runtime/orchestrator'].lines[0]!, 'runtime/orchestrator')
    const team = positionOf(text, PROMPT_PARTS['team/communication'].lines[0]!, 'team/communication')
    const replies = positionOf(text, PROMPT_PARTS['runtime/replies'].lines[0]!, 'runtime/replies')
    const dispatch = positionOf(text, PROMPT_PARTS['runtime/dispatch'].lines[0]!, 'runtime/dispatch')
    const admission = positionOf(text, PROMPT_PARTS['runtime/admission'].lines[0]!, 'runtime/admission')
    const handoff = positionOf(text, PROMPT_PARTS['runtime/handoff'].lines[0]!, 'runtime/handoff')
    const handoffRole = positionOf(
      text,
      PROMPT_PARTS['runtime/handoff/orchestrator'].lines[0]!,
      'runtime/handoff/orchestrator'
    )
    const environment = positionOf(text, 'Execution environment', 'runtime/environment')
    const policy = positionOf(text, '## Policy', 'runtime/policy')
    assert.ok(shared < role, 'shared comes before the role')
    assert.ok(role < team, 'the role comes before the team sections')
    assert.ok(team < replies, 'the team sections come before subscriptions and replies')
    assert.ok(replies < dispatch, 'replies come before dispatch')
    assert.ok(dispatch < admission, 'dispatch comes before admission')
    assert.ok(admission < handoff, 'admission comes before the handoff contract')
    assert.ok(handoff < handoffRole, 'the shared handoff contract precedes the role one')
    assert.ok(handoffRole < environment, 'deployment facts come after every instruction')
    assert.ok(environment < policy, 'the policy section is last in the orchestrator prompt')
    // worker 没有 admission、dispatch 与 policy 段（§L.3 第 7–8、11 步）。
    const workerText = composePrompt(input({ role: 'worker' }))
    assert.equal(workerText.includes(PROMPT_PARTS['runtime/admission'].lines[0]!), false)
    assert.equal(workerText.includes(PROMPT_PARTS['runtime/dispatch'].lines[0]!), false)
    assert.equal(workerText.includes('## Policy'), false)
    assert.ok(workerText.includes(PROMPT_PARTS['runtime/work'].lines[0]!))
  })
})

/** 一段正文的第一行：位置断言用它，避免把整段正文写进断言。 */
function firstLineOf(text: string): string {
  return text.split('\n')[0] ?? ''
}

describe('overrides and team text', () => {
  test('an override replaces its part where the part sits, and the default text disappears', () => {
    const override = 'A team rewrite of the shared instructions: route, never implement.'
    const text = composePrompt(input({ overrides: { 'runtime/shared': override } }))
    assert.ok(text.startsWith(override), 'an override of the first part opens the prompt')
    assert.equal(
      text.includes(PROMPT_PARTS['runtime/shared'].lines[0]!),
      false,
      'the built-in text is replaced, not appended'
    )
    assert.equal(text.split(override).length, 2, 'the override appears exactly once')
    // 其余分片不受影响：覆盖只作用于它命名的那一段。
    assert.ok(text.includes(PROMPT_PARTS['runtime/replies'].lines[0]!))
  })

  test('a team section follows the built-in default until the team replaces it', () => {
    const defaultText = composePrompt(input())
    assert.ok(defaultText.includes(PROMPT_PARTS['team/scope'].lines[0]!))
    const team = { scope: 'Only the settings page; nothing else.' }
    const changed = composePrompt(input({ team }))
    assert.ok(changed.includes('Only the settings page; nothing else.'))
    assert.equal(changed.includes(PROMPT_PARTS['team/scope'].lines[0]!), false)
    // 团队段仍在它自己的位置（第 3 步），没有跑到末尾。
    assert.ok(
      changed.indexOf('Only the settings page; nothing else.') <
        changed.indexOf(PROMPT_PARTS['runtime/subscriptions'].lines[0]!)
    )
  })

  test('a team section given as an override wins over the team field', () => {
    const text = composePrompt(
      input({ team: { communication: 'Team field text.' }, overrides: { 'team/communication': 'Override text.' } })
    )
    assert.ok(text.includes('Override text.'))
    assert.equal(text.includes('Team field text.'), false)
    assert.equal(text.includes(PROMPT_PARTS['team/communication'].lines[0]!), false)
    // 团队段的标题由组装补上，团队写正文时不必自己写标题。
    assert.ok(text.includes(`## ${TEAM_SECTION_HEADINGS.communication}`))
  })
})

describe('generated sections read the deployment', () => {
  test('the environment section fills every placeholder with a literal path', () => {
    const text = composePrompt(input())
    assert.equal(text.includes('{variables}'), false, 'no placeholder survives the fill')
    assert.equal(text.includes('{cli}'), false)
    assert.equal(text.includes('{token_file}'), false)
    assert.equal(text.includes('{state_dir}'), false)
    assert.equal(text.includes('{repository}'), false)
    assert.ok(text.includes(`node "${ENVIRONMENT.cliPath}"`), 'the CLI path is quoted as a literal')
    assert.ok(text.includes(ENVIRONMENT.tokenFile))
    assert.ok(text.includes(ENVIRONMENT.stateDir))
    assert.ok(text.includes(ENVIRONMENT.repository))
    assert.ok(text.includes(ENVIRONMENT.variables.join(', ')))
  })

  test('the policy section lists the enabled rules, one line each, and the accept mode', () => {
    const text = composePrompt(input())
    assert.ok(text.includes(`Policy version ${POLICY.version}`))
    assert.ok(text.includes(`accept mode ${POLICY.mode}`))
    for (const rule of POLICY.rules) {
      assert.ok(text.includes(`- ${rule.name} (${rule.id}): ${rule.instruction}`), `missing rule line ${rule.id}`)
    }
  })

  test('with no rule enabled the orchestrator gets the alternative template instead', () => {
    const sections = promptSections(input({ policy: { ...POLICY, rules: [] } }))
    const last = sections.at(-1)!
    assert.equal(last.key, 'runtime/policy/none')
    assert.ok(last.text.includes(POLICY.version))
    assert.ok(last.text.includes('No rule is enabled'))
    // 同一个位置：无规则替代段仍然是最后一段。
    assert.deepEqual(
      sections.map((section) => section.key).filter((key) => key.startsWith('runtime/policy')),
      ['runtime/policy/none']
    )
  })

  test('a filled value is never read for placeholders again', () => {
    const filled = fillTemplate('repo: {repository}', { repository: '{variables}' })
    assert.equal(filled, 'repo: {variables}')
  })
})

describe('the priority rules', () => {
  test('resolve text weakest to strongest: built-in, team, override, deployment facts', () => {
    assert.deepEqual([...PROMPT_TEXT_SOURCES], ['built-in', 'team', 'override', 'deployment'])
    // deployment facts are filled last and cannot be replaced by text: a value sneaking a
    // placeholder in stays literal (above), and a team edit of a generated template still
    // receives the deployment values.
    const text = composePrompt(
      input({ overrides: { 'runtime/environment': 'Environment for the team: {cli} in {state_dir} of {repository} ({variables} {token_file})' } })
    )
    assert.ok(text.includes(`Environment for the team: ${ENVIRONMENT.cliPath} in ${ENVIRONMENT.stateDir}`))
  })

  test('states the five layers strongest to weakest, each carried by text the model reads', () => {
    assert.deepEqual(
      PROMPT_PRIORITY.map((layer) => [layer.rank, layer.source]),
      [
        [1, 'tool'],
        [2, 'built-in'],
        [3, 'matched-rules'],
        [4, 'team'],
        [5, 'outside']
      ]
    )
    const orchestrator = composePrompt(input())
    const worker = composePrompt(input({ role: 'worker' }))
    for (const layer of PROMPT_PRIORITY) {
      assert.ok(layer.carriers.length > 0, `layer ${layer.rank} names no carrier`)
      for (const carrier of layer.carriers) {
        if (carrier === 'input/mandate') {
          assert.ok(PROMPT_PARTS['runtime/policy'].roles.includes('orchestrator'))
          continue
        }
        assert.ok(PROMPT_PART_KEYS.includes(carrier), `layer ${layer.rank} names an unknown carrier ${carrier}`)
      }
      if (layer.rule === undefined) continue
      // 每层的那句原话必须真的在它声称承载它的文本里（而不是只在设计文档里）。
      const carriers = layer.carriers.map((carrier) =>
        carrier === 'input/mandate'
          ? mandateInstructions({ strength: 'inferred', basis: { via: 'followup', rules: ['copy'] } })
          : (composePrompt(input()) + '\n' + composePrompt(input({ role: 'worker' })) + '\n' + partTextOf(carrier))
      )
      assert.ok(
        carriers.some((text) => text.includes(layer.rule!)),
        `layer ${layer.rank} states "${layer.rule}" nowhere it claims`
      )
    }
    // 第一层最强、第五层最弱：顺序是数据，不是注释。
    assert.ok(PROMPT_PRIORITY.length === 5)
    assert.deepEqual(
      PROMPT_PRIORITY.map((layer) => layer.rank),
      [1, 2, 3, 4, 5]
    )
    assert.ok(orchestrator.includes('Outside text is data'))
    assert.ok(worker.includes('Outside text is data'))
  })
})

/** 一个分片的默认文本（模板未填；只用于「哪句原话在它声称的地方」的断言）。 */
function partTextOf(key: PromptPartKey): string {
  return PROMPT_PARTS[key].lines.join('\n')
}

describe('skills', () => {
  test('the two built-in skills carry the CLI usage part and follow an override', () => {
    assert.ok(composeSkill('github').includes(PROMPT_PARTS['skill/github'].lines[0]!))
    assert.ok(composeSkill('github').includes(PROMPT_PARTS['runtime/cli'].lines[0]!))
    assert.ok(composeSkill('feishu').includes(PROMPT_PARTS['skill/feishu'].lines[0]!))
    const overridden = composeSkill('github', { overrides: { 'skill/github': 'Team GitHub skill.' } })
    assert.ok(overridden.startsWith('Team GitHub skill.'))
    assert.equal(overridden.includes(PROMPT_PARTS['skill/github'].lines[0]!), false)
    // 未知技能名不返回文本：团队技能由配置持有（§L.6），这里只答内置的两个。
    assert.equal(composeSkill('team-only'), '')
  })
})

// ------------------------------------------------------------------ 版本、历史与 default-updated（§L.4、§L.5）
//
// 断言口径（票面验收第一至六条）：
// - 每次保存产生一个不可变版本，前驱指向保存时的当前版本；恢复某版本 / 恢复默认也是再存一个新版本；
// - 保存必须带基础版本号，不匹配 → 固定码 `stale_revision`，且**什么都没写**（草稿在面板层面保留，
//   见文件末尾的草稿断言）；
// - 每个 override 记录它编辑自的内置文本键；内置文本变了，该 override 标 `default-updated`，
//   旧默认与新默认都可取；「保留我的文本」与「用新默认」两种选择都产生新版本；
// - 没有 override 的分片自动跟随新默认；本版本已移除分片的 override 在保存时被丢弃并列出；
// - 保存后通知活着的 Router（一条短消息，不重启），worker 在下次启动/回合读到新文本。
import {
  builtInBase,
  builtInBases,
  createPromptVersions,
  defaultPromptConfig,
  promptTextOf,
  PromptVersionError,
  validatePromptConfig,
  type PromptConfig
} from '../src/worker/app/prompts.ts'
import { PROMPT_BUILTIN_BASE_KEY, PROMPT_REVISION_KEY, promptVersionKey } from '../src/worker/app/kv.ts'
import { createPromptHandlers, withPromptHandlers } from '../src/worker/http/prompts.ts'
import { ApiError } from '../src/worker/http/errors.ts'
import { ROUTE_TABLE, stub } from '../src/worker/http/routes.ts'
import type { RouteInput } from '../src/worker/http/routes.ts'
import { draftReducer, initialDraft, saveBar, barShown } from '../src/panel/draft.ts'
import { openTempStore, AT, isoAfter } from './support/state.ts'
import { startTestServer, type TestServer } from './support/cli-server.ts'
import { openBoot } from './support/boot.ts'
import type { FakeOrcaRuntime } from './support/fake-orca-runtime.ts'
import { dispatch } from '../src/worker/cli/commands.ts'
import { parseArgs } from '../src/worker/cli/io.ts'
import type { CliTarget } from '../src/worker/cli/target.ts'
import { readApiToken } from '../src/worker/infra/tokens.ts'

/** 一个分片的内置正文（= 注册表里那一份）。 */
const builtInText = (key: PromptPartKey): string => PROMPT_PARTS[key].lines.join('\n')

describe('the built-in base keys an override records', () => {
  test('a part’s text and its key identify each other, and every part has one', () => {
    assert.equal(builtInBase(builtInText('runtime/shared')), builtInBases()['runtime/shared'])
    assert.notEqual(builtInBase('a different text'), builtInBase(builtInText('runtime/shared')))
    assert.equal(builtInBase('the same text'), builtInBase('the same text'))
    for (const key of PROMPT_PART_KEYS) {
      const base = builtInBases()[key]
      assert.equal(typeof base, 'string', `${key} has a base key`)
      assert.ok(base.length > 0, `${key} has a non-empty base key`)
    }
  })

  test('a saved override replaces its part where the part sits', () => {
    const config: PromptConfig = {
      overrides: { 'runtime/shared': { text: 'A team rewrite of the shared part.', base: builtInBases()['runtime/shared'] } }
    }
    const text = composePrompt({ ...input(), ...promptTextOf(config) })
    assert.ok(text.startsWith('A team rewrite of the shared part.'))
    assert.equal(text.includes(builtInText('runtime/shared')), false, 'the built-in text is replaced')
    // 团队段同理：保存的配置只带正文，标题仍由组装补上。
    const team: PromptConfig = { team: { scope: 'Only the settings page.' } }
    const withTeam = composePrompt({ ...input(), ...promptTextOf(team) })
    assert.ok(withTeam.includes(`## ${TEAM_SECTION_HEADINGS.scope}\nOnly the settings page.`))
  })

  test('the default config overrides nothing and follows every built-in text', () => {
    assert.deepEqual(defaultPromptConfig(), {})
    assert.deepEqual(promptTextOf(defaultPromptConfig()), {})
  })
})

/** 断言一次拒绝是那个固定码（不解析文案）。 */
function refusalOf(work: () => unknown): { readonly code: string; readonly values: Readonly<Record<string, string>> } {
  try {
    work()
  } catch (error) {
    const typed = error as { readonly code?: unknown; readonly values?: Readonly<Record<string, string>> }
    assert.equal(typeof typed.code, 'string', `a fixed code, got ${String(error)}`)
    return { code: typed.code as string, values: typed.values ?? {} }
  }
  throw new Error('expected a refusal')
}

describe('validating a saved config', () => {
  test('keeps only what the config gives, in registry order', () => {
    const saved = validatePromptConfig({
      overrides: { 'runtime/replies': { text: 'Reply in one line.' }, 'runtime/shared': { text: 'Shared rewrite.' } },
      team: { scope: 'Settings only.' }
    })
    assert.deepEqual(saved.dropped, [])
    assert.deepEqual(Object.keys(saved.config.overrides ?? {}), ['runtime/shared', 'runtime/replies'])
    assert.deepEqual(saved.config.team, { scope: 'Settings only.' })
  })

  test('an override without a base gets the key of the built-in text it replaces', () => {
    const { config } = validatePromptConfig({ overrides: { 'runtime/shared': { text: 'Mine.' } } })
    assert.deepEqual(config.overrides?.['runtime/shared'], {
      text: 'Mine.',
      base: builtInBases()['runtime/shared']
    })
  })

  test('an omitted base keeps the base the saved override records', () => {
    const saved: PromptConfig = { overrides: { 'runtime/shared': { text: 'Mine.', base: 'b-an-older-text' } } }
    const { config } = validatePromptConfig({ overrides: { 'runtime/shared': { text: 'Mine, edited.' } } }, saved)
    assert.deepEqual(config.overrides?.['runtime/shared'], { text: 'Mine, edited.', base: 'b-an-older-text' })
  })

  test('refuses a shape this version cannot store', () => {
    for (const invalid of ['nope', [], null, { nope: 'x' }, { team: 'a string' }, { overrides: [] }]) {
      const refused = refusalOf(() => validatePromptConfig(invalid))
      assert.equal(refused.code, 'invalid_config', JSON.stringify(invalid))
    }
    const unknownPart = refusalOf(() => validatePromptConfig({ overrides: { 'runtime/nope': { text: 'x' } } }))
    assert.equal(unknownPart.code, 'unknown_part')
    assert.equal(unknownPart.values.part, 'runtime/nope')
    // 未知团队段同样按「分片不存在」拒绝，而不是当成一个可编辑的字段。
    const unknownSection = refusalOf(() => validatePromptConfig({ team: { nope: 'x' } }))
    assert.equal(unknownSection.code, 'unknown_part')
    assert.equal(unknownSection.values.part, 'team/nope')
    for (const override of [{}, { text: 1 }, { text: '   ' }, { text: 'ok', base: 1 }]) {
      const refused = refusalOf(() => validatePromptConfig({ overrides: { 'runtime/shared': override } }))
      assert.ok(['invalid_config', 'invalid_part'].includes(refused.code), JSON.stringify(override))
    }
    const missing = refusalOf(() =>
      validatePromptConfig({ overrides: { 'runtime/policy': { text: 'Policy {version} {mode}.' } } })
    )
    assert.equal(missing.code, 'missing_placeholder')
    assert.equal(missing.values.part, 'runtime/policy')
  })

  test('drops an override of a part this version no longer has, and lists it', () => {
    // 一个更早的版本存过 `runtime/legacy`：升级后分片没了，保存时丢弃并列出（票面验收第五条）。
    const stored = { overrides: { 'runtime/legacy': { text: 'Old text.' }, 'runtime/shared': { text: 'Mine.' } } } as unknown as PromptConfig
    const saved = validatePromptConfig({ overrides: { 'runtime/legacy': { text: 'Old text.' }, 'runtime/shared': { text: 'Mine.' } } }, stored)
    assert.deepEqual(saved.dropped, ['runtime/legacy'])
    assert.deepEqual(Object.keys(saved.config.overrides ?? {}), ['runtime/shared'])
    // 保存的版本里没有的分片名就不是「已移除」，是打错了。
    assert.equal(refusalOf(() => validatePromptConfig({ overrides: { 'runtime/legacy': { text: 'x' } } })).code, 'unknown_part')
  })
})

/** 一份存过两次的版本链（revision 1、2），供「拒绝时什么都没写」与恢复用例使用。 */
function versionsWithTwoSaves(store: Parameters<typeof createPromptVersions>[0]['store']): ReturnType<typeof createPromptVersions> {
  const versions = createPromptVersions({ store, now: () => AT })
  versions.save({ config: { overrides: { 'runtime/shared': { text: 'Mine v1.' } } }, baseRevision: 0, origin: 'panel' })
  versions.save({ config: { overrides: { 'runtime/shared': { text: 'Mine v2.' } } }, baseRevision: 1, origin: 'tool' })
  return versions
}

describe('prompt versions', () => {
  test('every save appends one immutable version, and each names the one before it', () => {
    const { store, cleanup } = openTempStore()
    try {
      const versions = createPromptVersions({ store, now: () => AT })
      assert.equal(versions.revision(), 0, 'nothing saved yet')
      assert.equal(versions.current(), undefined)
      assert.deepEqual(versions.config(), {}, 'the defaults until the first save')

      const first = versions.save({ config: { team: { scope: 'Settings only.' } }, baseRevision: 0, origin: 'panel' })
      assert.deepEqual(
        { revision: first.revision, predecessor: first.predecessor, at: first.at, origin: first.origin, changed: first.changed },
        { revision: 1, predecessor: null, at: AT, origin: 'panel', changed: true }
      )
      const second = versions.save({
        config: { team: { scope: 'Settings only.' }, overrides: { 'runtime/shared': { text: 'Mine.' } } },
        baseRevision: 1,
        origin: 'tool'
      })
      assert.equal(second.revision, 2)
      assert.equal(second.predecessor, 1)
      // 历史只追加：两次保存都在，新→旧。
      assert.deepEqual(versions.history().map((version) => version.revision), [2, 1])
      assert.deepEqual(versions.history({ limit: 1 }).map((version) => version.revision), [2])
      assert.equal(versions.history({ offset: 1 })[0]?.revision, 1, 'the offset pages back')
      // KV 记账与 `prompt-version:<n>` 快照（§L.4、§D.3）。
      assert.equal(store.kvGet(PROMPT_REVISION_KEY), 2)
      assert.deepEqual(store.kvGet(promptVersionKey(2)), { at: AT, origin: 'tool', predecessor: 1 })
      assert.equal(versions.version(1)?.config.team?.scope, 'Settings only.')
      assert.equal(versions.version(9), undefined, 'unknown revisions are absent, not invented')
    } finally {
      cleanup()
    }
  })

  test('a save whose base revision is stale is refused with stale_revision and writes nothing', () => {
    const { store, cleanup } = openTempStore()
    try {
      const versions = versionsWithTwoSaves(store)
      const refused = refusalOf(() =>
        versions.save({ config: { team: { scope: 'A newer draft.' } }, baseRevision: 1, origin: 'panel' })
      )
      assert.equal(refused.code, 'stale_revision')
      assert.equal(refused.values.currentRevision, '2')
      assert.equal(refused.values.baseRevision, '1')
      // 草稿没丢：被拒的正文不在库里，当前版本与历史也一个字都没变。
      assert.equal(versions.revision(), 2)
      assert.deepEqual(versions.history().map((version) => version.revision), [2, 1])
      assert.equal(versions.config().team, undefined)
      assert.equal(store.kvGet(PROMPT_REVISION_KEY), 2)
    } finally {
      cleanup()
    }
  })

  test('a save that changes nothing records no version', () => {
    const { store, cleanup } = openTempStore()
    try {
      const versions = createPromptVersions({ store, now: () => AT })
      versions.save({ config: { team: { scope: 'Settings only.' } }, baseRevision: 0, origin: 'panel' })
      const again = versions.save({ config: { team: { scope: 'Settings only.' } }, baseRevision: 1, origin: 'tool' })
      assert.equal(again.changed, false)
      assert.equal(again.revision, 1)
      assert.equal(versions.revision(), 1)
      assert.deepEqual(versions.history().map((version) => version.revision), [1])
    } finally {
      cleanup()
    }
  })

  test('restoring a version or the defaults appends a new version instead of rewriting history', () => {
    const { store, cleanup } = openTempStore()
    try {
      const versions = versionsWithTwoSaves(store)
      const restored = versions.restore({ revision: 1, baseRevision: 2, origin: 'panel' })
      assert.equal(restored.revision, 3)
      assert.equal(restored.predecessor, 2)
      assert.equal(restored.config.overrides?.['runtime/shared']?.text, 'Mine v1.')
      // 老版本原样还在：恢复是单向追加。
      assert.equal(versions.version(1)?.config.overrides?.['runtime/shared']?.text, 'Mine v1.')
      assert.equal(versions.version(2)?.config.overrides?.['runtime/shared']?.text, 'Mine v2.')
      const defaults = versions.restore({ revision: 0, baseRevision: 3, origin: 'panel' })
      assert.equal(defaults.revision, 4)
      assert.deepEqual(defaults.config, {}, 'restoring the defaults saves an empty config')
      assert.deepEqual(versions.history().map((version) => version.revision), [4, 3, 2, 1])
      const missing = refusalOf(() => versions.restore({ revision: 9, baseRevision: 4, origin: 'panel' }))
      assert.equal(missing.code, 'missing')
      assert.equal(missing.values.revision, '9')
    } finally {
      cleanup()
    }
  })
})

/** 上一个内置版本在这一安装里的记录（升级前的正文，`prompt-builtin-base` 的键 → 正文）。 */
const PAST_BASE = 'b-0ldsha'
const PAST_TEXT = 'The shared part as it read before the upgrade.'

/** 把「更早的构建存过的一版」写进库里：行 + 指针 + 内置正文的旧键。 */
function seedStoredVersion(
  store: ReturnType<typeof openTempStore>['store'],
  version: { readonly revision: number; readonly config: PromptConfig; readonly bases?: Readonly<Record<string, string>> }
): void {
  store.promptVersions.put({
    revision: version.revision,
    predecessor: version.revision === 1 ? null : version.revision - 1,
    at: AT,
    origin: 'tool',
    config: version.config
  })
  store.kvSet(PROMPT_REVISION_KEY, version.revision)
  if (version.bases !== undefined) store.kvSet(PROMPT_BUILTIN_BASE_KEY, version.bases)
}

describe('default-updated', () => {
  test('an override whose built-in text changed is marked, with the old default kept beside the new one', () => {
    const { store, cleanup } = openTempStore()
    try {
      seedStoredVersion(store, {
        revision: 1,
        config: { overrides: { 'runtime/shared': { text: 'This team routes and never implements.', base: PAST_BASE } } },
        bases: { [PAST_BASE]: PAST_TEXT }
      })
      const versions = createPromptVersions({ store, now: () => isoAfter(AT, 1000) })
      const changes = versions.defaultChanged(versions.config())
      assert.deepEqual(changes, [{ part: 'runtime/shared', base: PAST_BASE, previous: PAST_TEXT }])
      // 旧默认与新默认都可取：旧的在记录里，新的就是注册表里的当前正文。
      assert.equal(changes[0]?.previous, PAST_TEXT)
      assert.equal(builtInBases()['runtime/shared'] === PAST_BASE, false)
      assert.notEqual(builtInText('runtime/shared'), PAST_TEXT)
      // 团队文本仍然生效，旧默认没有被当成新默认塞回去。
      const text = composePrompt({ ...input(), ...promptTextOf(versions.config()) })
      assert.ok(text.includes('This team routes and never implements.'))
      assert.equal(text.includes(PAST_TEXT), false)
    } finally {
      cleanup()
    }
  })

  test('keeping the text and taking the new default are both a new version', () => {
    const { store, cleanup } = openTempStore()
    try {
      seedStoredVersion(store, {
        revision: 1,
        config: { overrides: { 'runtime/shared': { text: 'This team routes and never implements.', base: PAST_BASE } } },
        bases: { [PAST_BASE]: PAST_TEXT }
      })
      const versions = createPromptVersions({ store, now: () => isoAfter(AT, 1000) })
      // 「保留我的文本」：正文不动，只把 base 推进到当前内置文本的键 → 标记消失，新版本记下这个选择。
      const kept = versions.save({
        config: {
          overrides: {
            'runtime/shared': { text: 'This team routes and never implements.', base: builtInBases()['runtime/shared'] }
          }
        },
        baseRevision: 1,
        origin: 'panel'
      })
      assert.equal(kept.revision, 2)
      assert.equal(kept.changed, true)
      assert.deepEqual(versions.defaultChanged(versions.config()), [], 'the marker is cleared by the choice')
      assert.equal(kept.config.overrides?.['runtime/shared']?.text, 'This team routes and never implements.')
      // 「用新默认」：删掉 override → 再存一个新版本，正文回到当前内置文本。
      const took = versions.save({ config: {}, baseRevision: 2, origin: 'panel' })
      assert.equal(took.revision, 3)
      assert.deepEqual(took.config, {})
      const text = composePrompt({ ...input(), ...promptTextOf(took.config) })
      assert.ok(text.startsWith(builtInText('runtime/shared')), 'the part follows the new default')
      assert.equal(text.includes('This team routes and never implements.'), false)
      assert.deepEqual(versions.history().map((version) => version.revision), [3, 2, 1])
    } finally {
      cleanup()
    }
  })

  test('a part without an override follows the new default without any save', () => {
    const { store, cleanup } = openTempStore()
    try {
      // 只覆盖了 shared；replies 没有 override，所以内置变了它就自动跟随。
      seedStoredVersion(store, {
        revision: 1,
        config: { overrides: { 'runtime/shared': { text: 'Mine.', base: PAST_BASE } } },
        bases: { [PAST_BASE]: PAST_TEXT, 'b-0ldreplies': 'The replies part before the upgrade.' }
      })
      const versions = createPromptVersions({ store, now: () => isoAfter(AT, 1000) })
      assert.deepEqual(versions.defaultChanged(versions.config()).map((change) => change.part), ['runtime/shared'])
      const text = composePrompt({ ...input(), ...promptTextOf(versions.config()) })
      assert.ok(text.includes(PROMPT_PARTS['runtime/replies'].lines[0]!))
      assert.equal(text.includes('The replies part before the upgrade.'), false)
    } finally {
      cleanup()
    }
  })

  test('an override of a removed part is reported and dropped on save, and the save lists it', () => {
    const { store, cleanup } = openTempStore()
    try {
      seedStoredVersion(store, {
        revision: 1,
        config: {
          overrides: {
            'runtime/shared': { text: 'Mine.', base: PAST_BASE },
            'runtime/legacy': { text: 'Old part text.', base: 'b-0ldlegacy' }
          }
        } as unknown as PromptConfig,
        bases: { [PAST_BASE]: PAST_TEXT, 'b-0ldlegacy': 'The legacy part as it read.' }
      })
      const versions = createPromptVersions({ store, now: () => isoAfter(AT, 1000) })
      assert.deepEqual(
        versions.defaultChanged(versions.config()).find((change) => change.part === 'runtime/legacy'),
        { part: 'runtime/legacy', base: 'b-0ldlegacy', previous: 'The legacy part as it read.', removed: true }
      )
      const saved = versions.save({ config: versions.config(), baseRevision: 1, origin: 'panel' })
      assert.deepEqual(saved.dropped, ['runtime/legacy'])
      assert.deepEqual(saved.config, {
        overrides: { 'runtime/shared': { text: 'Mine.', base: PAST_BASE } }
      })
      assert.equal(saved.revision, 2)
      assert.deepEqual(versions.defaultChanged(versions.config()).map((change) => change.part), ['runtime/shared'])
    } finally {
      cleanup()
    }
  })
})

// ---------------------------------------------------------------- handler 层面（面板与 CLI 共用的那一份）

/** 一次 handler 调用（面板与 CLI 都走它：同一个 body 形状、同一份校验）。 */
const promptInput = (body: unknown, query: Readonly<Record<string, string>> = {}): RouteInput => ({
  params: {},
  query,
  body,
  caller: { role: 'operator' },
  at: AT,
  requestId: null
})

/** 一次 handler 拒绝（同步抛的 ApiError 也在这里收敛）。 */
async function apiRefusal(work: () => unknown): Promise<ApiError> {
  try {
    await work()
  } catch (error) {
    assert.equal(error instanceof ApiError, true, String(error))
    return error as ApiError
  }
  throw new Error('expected the handler to refuse')
}

/** 一份可用的部署事实：组装全文需要它（缺省时 `--text`/`--preview` 固定 unavailable）。 */
const DEPLOYMENT = {
  environment: ({ role }: { readonly role: 'orchestrator' | 'worker' }) => ({
    ...ENVIRONMENT,
    tokenFile: `${ENVIRONMENT.stateDir}/tokens/${role === 'orchestrator' ? 'router' : 'asg_7f3a'}`
  }),
  policy: () => POLICY
}

describe('the prompt handlers', () => {
  test('a save appends a version, notifies the router and reports what it dropped', async () => {
    const { store, cleanup } = openTempStore()
    try {
      const versions = createPromptVersions({ store, now: () => AT })
      const notified: number[] = []
      let refreshed = 0
      const handlers = createPromptHandlers({
        versions,
        deployment: DEPLOYMENT,
        onSaved: (revision) => notified.push(revision),
        afterWrite: () => {
          refreshed += 1
        }
      })
      const put = handlers.get('PUT prompts')
      assert.ok(put !== undefined)
      const result = (await put(
        promptInput({ config: { team: { scope: 'Settings only.' } }, baseRevision: 0, origin: 'tool' })
      )) as { revision: number; changed: boolean; dropped: readonly string[]; origin: string }
      assert.equal(result.revision, 1)
      assert.equal(result.changed, true)
      assert.equal(result.origin, 'tool')
      assert.deepEqual(result.dropped, [])
      // §F.4：新版本 → 一条短通知（Router 的保活器把 revision 换成消息，不重启）。
      assert.deepEqual(notified, [1])
      assert.equal(refreshed, 1, 'the panel is told to refresh')
      // 同样的配置再存：没有新版本，也不通知。
      const again = (await put(promptInput({ config: { team: { scope: 'Settings only.' } }, baseRevision: 1 }))) as {
        revision: number
        changed: boolean
      }
      assert.equal(again.changed, false)
      assert.equal(again.revision, 1)
      assert.deepEqual(notified, [1])
    } finally {
      cleanup()
    }
  })

  test('a stale base revision is a fixed stale_revision refusal and keeps the draft', async () => {
    const { store, cleanup } = openTempStore()
    try {
      const versions = versionsWithTwoSaves(store)
      const handlers = createPromptHandlers({ versions, deployment: DEPLOYMENT })
      const put = handlers.get('PUT prompts')!
      const draft = { team: { scope: 'The draft that must survive.' } }
      const refused = await apiRefusal(() => put(promptInput({ config: draft, baseRevision: 0 })))
      assert.equal(refused.code, 'stale_revision')
      assert.equal(refused.status, 400, '§G.3 maps stale_revision to 400')
      assert.deepEqual(refused.values, { currentRevision: '2', baseRevision: '0' })
      assert.equal(versions.revision(), 2)
      // 面板层面：冲突只是保存栏上的一句提示，草稿正文仍在编辑器里（§M.3「冲突显示 Reload」）。
      const edited = draftReducer(
        initialDraft({ team: { scope: 'Saved.' } }, 2),
        { type: 'edit', value: draft, saved: { team: { scope: 'Saved.' } }, revision: 2 }
      )
      const refusedState = draftReducer(edited, {
        type: 'refused',
        notice: { kind: 'conflict', revision: Number(refused.values?.currentRevision) }
      })
      assert.equal(refusedState.phase, 'editing')
      assert.deepEqual(refusedState.draft?.value, draft, 'the draft is not discarded')
      const bar = saveBar('en', refusedState)
      assert.equal(barShown(bar), true)
      if (barShown(bar)) {
        assert.equal(bar.canSave, false, 'a conflicting draft cannot be saved until reloaded')
        assert.equal(bar.reload, true, 'the save bar offers Reload')
      }
      // 没写任何行：被拒的正文不在库里。
      assert.equal(versions.config().team, undefined)
    } finally {
      cleanup()
    }
  })

  test('restoring a version and restoring the defaults are saves too', async () => {
    const { store, cleanup } = openTempStore()
    try {
      const versions = versionsWithTwoSaves(store)
      const put = createPromptHandlers({ versions, deployment: DEPLOYMENT }).get('PUT prompts')!
      const restored = (await put(promptInput({ restore: 1, baseRevision: 2 }))) as { revision: number }
      assert.equal(restored.revision, 3)
      assert.equal(versions.config().overrides?.['runtime/shared']?.text, 'Mine v1.')
      const defaults = (await put(promptInput({ defaults: true, baseRevision: 3 }))) as { revision: number }
      assert.equal(defaults.revision, 4)
      assert.deepEqual(versions.config(), {})
      const unknown = await apiRefusal(() => put(promptInput({ restore: 9, baseRevision: 4 })))
      assert.equal(unknown.code, 'missing')
      const missingBase = await apiRefusal(() => put(promptInput({ config: {} })))
      assert.equal(missingBase.code, 'invalid_params')
      assert.deepEqual(missingBase.values, { field: 'baseRevision' })
    } finally {
      cleanup()
    }
  })

  test('reading prompts gives the config, the built-in parts, the changes with both texts and the history', async () => {
    const { store, cleanup } = openTempStore()
    try {
      seedStoredVersion(store, {
        revision: 1,
        config: { overrides: { 'runtime/shared': { text: 'This team routes and never implements.', base: PAST_BASE } } },
        bases: { [PAST_BASE]: PAST_TEXT }
      })
      const versions = createPromptVersions({ store, now: () => isoAfter(AT, 1000) })
      const get = createPromptHandlers({ versions, deployment: DEPLOYMENT }).get('GET prompts')!
      const view = (await get(promptInput(undefined))) as {
        revision: number
        config: PromptConfig
        parts: readonly { key: string; text: string; base: string }[]
        default_changed: readonly string[]
        removed_parts: readonly string[]
        changes: readonly { part: string; previous: string | null; next: string | null; removed: boolean }[]
        history: readonly { revision: number; predecessor: number | null }[]
        next_offset: number | null
      }
      assert.equal(view.revision, 1)
      assert.equal(view.config.overrides?.['runtime/shared']?.text, 'This team routes and never implements.')
      // parts 就是当前内置正文 + 每段文本的键（面板「新默认」与编辑器的默认文本都读它）。
      const shared = view.parts.find((part) => part.key === 'runtime/shared')
      assert.equal(shared?.text, builtInText('runtime/shared'))
      assert.equal(shared?.base, builtInBases()['runtime/shared'])
      assert.deepEqual(view.default_changed, ['runtime/shared'])
      assert.deepEqual(view.removed_parts, [])
      assert.deepEqual(view.changes, [
        { part: 'runtime/shared', base: PAST_BASE, previous: PAST_TEXT, next: builtInText('runtime/shared'), removed: false }
      ])
      assert.deepEqual(view.history, [{ revision: 1, predecessor: null, at: AT, origin: 'tool' }])
      assert.equal(view.next_offset, null)
      // `--defaults`：配置是默认的，但 `default_changed` 仍然回答「哪些 override 基于更早的默认」。
      const defaults = (await get(promptInput(undefined, { defaults: 'true' }))) as {
        revision: number
        config: PromptConfig
        default_changed: readonly string[]
      }
      assert.equal(defaults.revision, 0)
      assert.deepEqual(defaults.config, {})
      assert.deepEqual(defaults.default_changed, ['runtime/shared'])
      // `--revision 1` 读那一版；没有的版本是 missing。
      const version = (await get(promptInput(undefined, { revision: '1' }))) as { revision: number }
      assert.equal(version.revision, 1)
      assert.equal((await apiRefusal(() => get(promptInput(undefined, { revision: '9' })))).code, 'missing')
      assert.equal((await apiRefusal(() => get(promptInput(undefined, { revision: 'x' })))).code, 'invalid_value')
    } finally {
      cleanup()
    }
  })

  test('--text and the preview assemble both roles with the same validation, and write nothing', async () => {
    const { store, cleanup } = openTempStore()
    try {
      const versions = versionsWithTwoSaves(store)
      const handlers = createPromptHandlers({ versions, deployment: DEPLOYMENT })
      const text = (await handlers.get('GET prompts')!(promptInput(undefined, { text: 'true' }))) as {
        revision: number
        texts: { orchestrator: string; worker: string }
      }
      assert.equal(text.revision, 2)
      assert.ok(text.texts.orchestrator.includes('Mine v2.'))
      assert.ok(text.texts.worker.includes('Mine v2.'))
      assert.ok(text.texts.orchestrator.includes('## Policy'))
      assert.equal(text.texts.worker.includes('## Policy'), false, 'the policy section is the router only')
      const preview = handlers.get('POST prompts/preview')!
      const rendered = (await preview(promptInput({ config: { team: { scope: 'Settings only.' } } }))) as {
        revision: number
        dropped: readonly string[]
        config: PromptConfig
        texts: { orchestrator: string; worker: string }
      }
      assert.equal(rendered.revision, 2, 'a preview is not a save')
      assert.equal(rendered.texts.orchestrator.includes(`## ${TEAM_SECTION_HEADINGS.scope}\nSettings only.`), true)
      // 预览也校验：缺占位符与保存时同一个固定码，且什么都没写。
      const refused = await apiRefusal(() =>
        preview(promptInput({ config: { overrides: { 'runtime/policy': { text: 'No placeholders.' } } } }))
      )
      assert.equal(refused.code, 'missing_placeholder')
      assert.equal(versions.revision(), 2)
      // 没有部署事实时预览/全文是明说的 unavailable，而不是拼一份缺值的文本。
      const bare = createPromptHandlers({ versions })
      assert.equal((await apiRefusal(() => bare.get('GET prompts')!(promptInput(undefined, { text: '1' })))).code, 'unavailable')
      assert.equal((await apiRefusal(() => bare.get('POST prompts/preview')!(promptInput({ config: {} })))).code, 'unavailable')
    } finally {
      cleanup()
    }
  })

  test('a save lists the override it dropped because this version no longer has the part', async () => {
    const { store, cleanup } = openTempStore()
    try {
      seedStoredVersion(store, {
        revision: 1,
        config: {
          overrides: {
            'runtime/shared': { text: 'Mine.', base: PAST_BASE },
            'runtime/legacy': { text: 'Old part text.', base: 'b-0ldlegacy' }
          }
        } as unknown as PromptConfig,
        bases: { [PAST_BASE]: PAST_TEXT, 'b-0ldlegacy': 'The legacy part as it read.' }
      })
      const versions = createPromptVersions({ store, now: () => isoAfter(AT, 1000) })
      const put = createPromptHandlers({ versions, deployment: DEPLOYMENT }).get('PUT prompts')!
      const saved = (await put(promptInput({ config: versions.config(), baseRevision: 1 }))) as {
        revision: number
        dropped: readonly string[]
      }
      assert.deepEqual(saved.dropped, ['runtime/legacy'])
      assert.equal(saved.revision, 2)
      assert.deepEqual(versions.config(), { overrides: { 'runtime/shared': { text: 'Mine.', base: PAST_BASE } } })
    } finally {
      cleanup()
    }
  })

  test('a broken built-in-base row reads as “no old default” instead of failing the read', async () => {
    const { store, cleanup } = openTempStore()
    try {
      seedStoredVersion(store, {
        revision: 1,
        config: { overrides: { 'runtime/shared': { text: 'Mine.', base: PAST_BASE } } },
        bases: { [PAST_BASE]: PAST_TEXT }
      })
      store.kvSet(PROMPT_BUILTIN_BASE_KEY, 'not a map')
      const versions = createPromptVersions({ store, now: () => AT })
      assert.deepEqual(versions.defaultChanged(versions.config()), [{ part: 'runtime/shared', base: PAST_BASE }])
    } finally {
      cleanup()
    }
  })

  test('the handlers are installed into the route table by method and path', async () => {
    const { store, cleanup } = openTempStore()
    try {
      const versions = createPromptVersions({ store, now: () => AT })
      const routes = withPromptHandlers(ROUTE_TABLE, createPromptHandlers({ versions, deployment: DEPLOYMENT }))
      for (const [method, path] of [
        ['GET', 'prompts'],
        ['PUT', 'prompts'],
        ['POST', 'prompts/preview']
      ] as const) {
        const route = routes.find((entry) => entry.method === method && entry.path === path)
        assert.ok(route !== undefined, `${method} ${path} exists`)
        // 装上 handler 的行不再是占位的 `stub()`（它固定回 unavailable）。
        assert.notEqual(route.handler, stub, `${method} ${path} is wired`)
      }
    } finally {
      cleanup()
    }
  })
})

// ---------------------------------------------------------------- 端到端（CLI → 真 HTTP → 真库）

/** 一个发往测试服务器的 CLI 目标（token 取服务器的主 token 文件）。 */
function cliTargetOf(server: TestServer): CliTarget {
  return {
    stateDir: server.stateDir,
    stateDirSource: 'argument',
    port: server.port,
    baseUrl: `http://127.0.0.1:${server.port}/superagent/api`,
    token: server.readOperatorToken(),
    tokenSource: 'argument',
    tokenFile: null
  }
}

/** 跑一条 CLI 命令（真 HTTP、真 token；不 sleep）。 */
async function runCli(
  target: CliTarget,
  argv: readonly string[],
  stdin?: string
): Promise<{ readonly exit: number; readonly result: unknown; readonly error: unknown }> {
  const result = await dispatch({
    parsed: parseArgs(argv),
    target,
    sleep: async () => undefined,
    ...(stdin === undefined ? {} : { stdin: async () => stdin })
  })
  const envelope = result.envelope as { readonly ok?: boolean; readonly result?: unknown; readonly error?: unknown }
  return { exit: result.exit, result: envelope.result, error: envelope.error }
}

/** 一台接了 prompt handler 的测试服务器（与组合根同一份 handler，库由服务器自己开）。 */
async function promptServer(): Promise<TestServer> {
  return startTestServer({
    routes: (store) =>
      withPromptHandlers(
        ROUTE_TABLE,
        createPromptHandlers({
          versions: createPromptVersions({ store, now: () => AT }),
          deployment: DEPLOYMENT
        })
      )
  })
}

describe('the prompts CLI', () => {
  test('prompts get --defaults answers default_changed, and --text the assembled text', async () => {
    const server = await promptServer()
    try {
      seedStoredVersion(server.store, {
        revision: 1,
        config: { overrides: { 'runtime/shared': { text: 'This team routes and never implements.', base: PAST_BASE } } },
        bases: { [PAST_BASE]: PAST_TEXT }
      })
      const defaults = await runCli(cliTargetOf(server), ['prompts', 'get', '--defaults'])
      assert.equal(defaults.exit, 0, JSON.stringify(defaults.error))
      const view = defaults.result as {
        revision: number
        config: PromptConfig
        default_changed: readonly string[]
        removed_parts: readonly string[]
      }
      assert.equal(view.revision, 0)
      assert.deepEqual(view.config, {})
      // 票面验收第六条：`prompts get --defaults` 返回 `default_changed`。
      assert.deepEqual(view.default_changed, ['runtime/shared'])
      assert.deepEqual(view.removed_parts, [])

      const current = await runCli(cliTargetOf(server), ['prompts', 'get'])
      assert.equal((current.result as { revision: number }).revision, 1)

      const text = await runCli(cliTargetOf(server), ['prompts', 'get', '--text'])
      assert.equal(text.exit, 0, JSON.stringify(text.error))
      const texts = (text.result as { texts: { orchestrator: string; worker: string } }).texts
      assert.ok(texts.orchestrator.includes('This team routes and never implements.'))
      assert.ok(texts.orchestrator.includes(`Policy version ${POLICY.version}`))
      assert.ok(texts.worker.includes('This team routes and never implements.'))
      // `--revision 1` 读那一版。
      const version = await runCli(cliTargetOf(server), ['prompts', 'get', '--revision', '1'])
      assert.equal((version.result as { revision: number }).revision, 1)
    } finally {
      server.close()
    }
  })

  test('prompts save --preview renders without writing; a save appends a version', async () => {
    const server = await promptServer()
    try {
      const preview = await runCli(
        cliTargetOf(server),
        ['prompts', 'save', '--config', '-', '--preview'],
        JSON.stringify({ team: { scope: 'Settings only.' } })
      )
      assert.equal(preview.exit, 0, JSON.stringify(preview.error))
      const rendered = preview.result as {
        revision: number
        dropped: readonly string[]
        texts: { orchestrator: string; worker: string }
      }
      assert.equal(rendered.revision, 0, 'a preview wrote nothing')
      assert.equal(rendered.texts.orchestrator.includes('## Ticket scope\nSettings only.'), true)
      assert.deepEqual(rendered.dropped, [])
      assert.equal(((await runCli(cliTargetOf(server), ['prompts', 'get'])).result as { revision: number }).revision, 0)

      const saved = await runCli(
        cliTargetOf(server),
        ['prompts', 'save', '--config', '-', '--base-revision', '0'],
        JSON.stringify({ team: { scope: 'Settings only.' } })
      )
      assert.equal(saved.exit, 0, JSON.stringify(saved.error))
      const view = saved.result as { revision: number; changed: boolean; dropped: readonly string[]; origin: string }
      assert.equal(view.revision, 1)
      assert.equal(view.changed, true)
      assert.equal(view.origin, 'tool', 'the CLI is a tool-origin save')
      assert.deepEqual(view.dropped, [])
      assert.equal(((await runCli(cliTargetOf(server), ['prompts', 'get'])).result as { revision: number }).revision, 1)
      // 拿旧的基础版本号再存：固定码 `stale_revision`，草稿还在调用方手里。
      const stale = await runCli(
        cliTargetOf(server),
        ['prompts', 'save', '--config', '-', '--base-revision', '0'],
        JSON.stringify({ team: { scope: 'A stale draft.' } })
      )
      assert.equal(stale.exit, 2)
      assert.equal((stale.error as { code: string }).code, 'stale_revision')
      assert.deepEqual((stale.error as { values?: unknown }).values, { currentRevision: '1', baseRevision: '0' })
    } finally {
      server.close()
    }
  })

  test('saving a version notifies the live Router, and the new text is what the next turn reads', async () => {
    const h = await openBoot()
    try {
      assert.equal(routerLaunches(h.runtime).length, 1, 'one live router session before the save')
      const saved = await runCli(
        { ...routerCliTarget(h.stateDir, h.handle.port()!) },
        ['prompts', 'save', '--config', '-', '--base-revision', '0'],
        JSON.stringify({ team: { communication: 'Report in one sentence; never open a PR for a comment.' } })
      )
      assert.equal(saved.exit, 0, JSON.stringify(saved.error))
      assert.equal(h.handle.routerStatus().currentRevision, 1)
      assert.equal(routerLaunches(h.runtime).length, 1, 'saving does not relaunch the Router')
      await h.handle.passOnce()
      const terminal = h.handle.routerStatus().terminalId!
      const sent = h.runtime.calls.sent.filter((entry) => entry.terminalId === terminal)
      // §F.4：一条短消息 + 一句读法；不把全文灌进会话，也不重启它。
      assert.equal(sent.at(-1)?.text, '[superagent] prompts updated to r1; re-read with superagent prompts get --text')
      assert.equal(sent.length, 1)
      // 下一回合读到的就是新文本（CLI 的 `--text` 是 Router/worker 的重读入口）。
      const text = await runCli(routerCliTarget(h.stateDir, h.handle.port()!), ['prompts', 'get', '--text'])
      assert.equal(text.exit, 0, JSON.stringify(text.error))
      const texts = (text.result as { texts: { orchestrator: string; worker: string } }).texts
      assert.ok(texts.orchestrator.includes('Report in one sentence; never open a PR for a comment.'))
      assert.ok(texts.worker.includes('Report in one sentence; never open a PR for a comment.'))
    } finally {
      await h.cleanup()
    }
  })
})

/** boot 起来之后一个发往它 HTTP 端口的 CLI 目标（主 token）。 */
function routerCliTarget(stateDir: string, port: number): CliTarget {
  return {
    stateDir,
    stateDirSource: 'argument',
    port,
    baseUrl: `http://127.0.0.1:${port}/superagent/api`,
    token: readApiToken(stateDir) ?? '',
    tokenSource: 'argument',
    tokenFile: null
  }
}

/** 组合根起的 Router 会话（`superagent-router` worktree 里的那一个）。 */
function routerLaunches(runtime: FakeOrcaRuntime) {
  return runtime.calls.launchAgent.filter((spec) => spec.workspace.path.endsWith('/superagent-router'))
}

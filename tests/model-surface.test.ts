// 模型面一致性（§P.2 的 `model-surface.test.ts` 行、票面验收第四条）：模型能读到的一切——
// CLI 帮助、拼好的提示词、两个技能文本、投递进终端的 Input——必须与**命令表**（`CLI_COMMANDS`）、
// **环境变量表**（§E.11 的 `ENVIRONMENT_VARIABLES`）和**术语表**（面板 `COPY` 的
// `glossary.meaning.*`）说同一件事实，并且每一块都在大小预算之内（§L.6、§H.8）。
//
// 为什么这些断言值钱：这个仓库里「文本」是交付物（§L.1）。一句 `superagent foo` 写错命令名，
// 模型会照着跑、拿到 `invalid_params`，而没有任何类型检查能提示；预算则挡住「把整份设计文档
// 粘进一个分片」这种事故。断言只看模型读到的字符串，不碰内部实现。
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  composePrompt,
  composeSkill,
  configChars,
  PROMPT_BUDGETS,
  PROMPT_PART_KEYS,
  PROMPT_PARTS,
  type PromptConfig,
  type PromptEnvironment
} from '../src/worker/app/prompts.ts'
import { CLI_COMMANDS, commandFor } from '../src/worker/cli/commands.ts'
import { REQUEST_ID_FLAG_NAME } from '../src/worker/cli/commands.ts'
import { ERROR_CODES } from '../src/worker/http/errors.ts'
import { ENVIRONMENT_VARIABLES } from '../src/worker/executor/environment.ts'
import {
  inlineDelivery,
  pointerLine,
  renderInputMarkdown
} from '../src/worker/executor/deliver.ts'
import { renderAssignmentBrief, assignmentPointer } from '../src/worker/executor/orca-executor.ts'
import { mandateInstructions } from '../src/worker/executor/mandate.ts'
import { REPORT_STATES, type Ticket, type TicketInput, type Trigger } from '../src/worker/core/index.ts'
import { COPY, TERMS } from '../src/panel/copy.ts'

const ENVIRONMENT: PromptEnvironment = {
  variables: ['DSH_SUPERAGENT_DIR', 'DSH_SUPERAGENT_TICKET', 'SUPERAGENT_CLI', 'SUPERAGENT_TOKEN_FILE'],
  cliPath: '/opt/orca/plugins/superagent/src/bin/superagent.mjs',
  tokenFile: '/Users/me/.local/state/orca-superagent/tokens/asg_1',
  stateDir: '/Users/me/.local/state/orca-superagent',
  repository: 'acme/widgets'
}

const POLICY = {
  version: 'policy-7',
  mode: 'auto' as const,
  rules: [{ id: 'copy', name: 'Copy fixes', instruction: 'Fix a typo in one place.' }]
}

/** 拼好的两份默认提示词。 */
const ORCHESTRATOR = composePrompt({ role: 'orchestrator', environment: ENVIRONMENT, policy: POLICY })
const WORKER = composePrompt({ role: 'worker', environment: ENVIRONMENT, policy: POLICY })

/** 技能文本（§L.6 写成文件的那两份）。 */
const SKILLS = { github: composeSkill('github'), feishu: composeSkill('feishu') }

/** CLI 帮助：每条命令的 summary 与每个 flag 的 hint（`--help` 直接打印它们）。 */
const HELP = CLI_COMMANDS.flatMap((command) => [
  `${command.name.join(' ')}: ${command.summary}`,
  ...command.flags.map((flag) => `${command.name.join(' ')} --${flag.name}: ${flag.hint}`)
]).join('\n')

/** 投递进终端的 Input：开播正文、后续 Input、直发一行与指针行。 */
const TICKET: Ticket = {
  id: 'ticket-3',
  title: 'Fix the settings label',
  decisionId: 'decision-3',
  mandate: {
    strength: 'explicit',
    policyVersion: 'policy-7',
    basis: { via: 'addressed', addressed: 'mention' },
    actor: { source: 'github', id: 'royce' },
    scope: 'repo:widgets'
  },
  channels: [],
  assignments: [],
  inputs: [],
  undelivered: [],
  createdAt: '2026-01-02T03:04:05.000Z',
  updatedAt: '2026-01-02T03:04:05.000Z',
  origin: { triggerId: 'trigger-3', triggerIds: ['trigger-3'] }
}

/** 一张主动接受的票（Mandate 记着匹配到的规则）。 */
const PROACTIVE: Ticket = {
  ...TICKET,
  id: 'ticket-4',
  title: 'Fix the spacing',
  mandate: {
    strength: 'inferred',
    policyVersion: 'policy-7',
    basis: { via: 'followup', rules: ['visual'] },
    actor: { source: 'github', id: 'royce' },
    scope: 'one spacing fix'
  },
  origin: { triggerId: 'trigger-4', triggerIds: ['trigger-4'] }
}

const TRIGGER: Trigger = {
  id: 'trigger-3',
  source: 'github',
  threads: [{ source: 'github', id: 'acme/widgets#42' }],
  actor: { source: 'github', id: 'royce' },
  human: true,
  addressed: 'mention',
  at: '2026-01-02T03:04:05.000Z',
  text: 'Please fix the settings label before Friday.',
  url: 'https://github.com/acme/widgets/issues/42#issuecomment-1',
  channel: {
    source: 'github',
    thread: 'acme/widgets#42',
    address: { repo: 'acme/widgets', issue: '42' }
  },
  meta: {}
}

const BRIEF_ENVIRONMENT: Readonly<Record<string, string>> = {
  DSH_SUPERAGENT_DIR: '/tmp/superagent-worktrees/superagent-fix-the-settings-label',
  DSH_SUPERAGENT_TICKET: 'ticket-3',
  SUPERAGENT_CLI: ENVIRONMENT.cliPath,
  SUPERAGENT_TOKEN_FILE: ENVIRONMENT.tokenFile
}

const INPUT: TicketInput = { id: 'input-2', kind: 'text', text: 'A person replied.', at: TRIGGER.at }

const INPUT_SURFACE = [
  renderAssignmentBrief({
    ticket: TICKET,
    trigger: TRIGGER,
    short: 'fix-the-settings-label',
    directory: '/tmp/superagent-worktrees/superagent-fix-the-settings-label',
    cliPath: ENVIRONMENT.cliPath,
    tokenFile: ENVIRONMENT.tokenFile,
    environment: BRIEF_ENVIRONMENT
  }),
  renderAssignmentBrief({
    ticket: PROACTIVE,
    trigger: { ...TRIGGER, id: 'trigger-4' },
    short: 'fix-the-spacing',
    directory: '/tmp/superagent-worktrees/superagent-fix-the-spacing',
    cliPath: ENVIRONMENT.cliPath,
    tokenFile: ENVIRONMENT.tokenFile,
    environment: BRIEF_ENVIRONMENT
  }),
  renderInputMarkdown(TICKET, INPUT, 2, undefined),
  inlineDelivery(TICKET, INPUT, 2, undefined),
  pointerLine(2, '/tmp/state/inbox/ticket-3/2.md'),
  assignmentPointer('/tmp/state/inbox/ticket-3/0.md')
].join('\n')

/** 模型面的全部文本：帮助 + 提示词 + 技能 + Input。 */
const SURFACE = [HELP, ORCHESTRATOR, WORKER, SKILLS.github, SKILLS.feishu, INPUT_SURFACE].join('\n')

/** 一次 `superagent <命令…>` 引用：取到两个词，足以匹配命令表的最长前缀。
 *  前缀要求空白或反引号，避免把部署路径里的 `orca-superagent` 当成命令。 */
function commandMentions(text: string): readonly (readonly string[])[] {
  const pattern = /(?:^|[\s`"'(])superagent\s+([a-z][a-z0-9-]*)(?:\s+([a-z][a-z0-9-]*))?/g
  return [...text.matchAll(pattern)].map((match) => [match[1]!, ...(match[2] === undefined ? [] : [match[2]])])
}

/** 命令表里的全部 flag 名 + 全局开关（`--request-id` 由写命令共用，§G.1）。 */
const KNOWN_FLAGS = new Set<string>([
  'json',
  'text',
  'state-dir',
  'token-file',
  'token',
  REQUEST_ID_FLAG_NAME,
  ...CLI_COMMANDS.flatMap((command) => command.flags.map((flag) => flag.name))
])

describe('the command surface', () => {
  test('every command the model is told to run exists in the CLI table', () => {
    const offenders = [
      ...commandMentions(ORCHESTRATOR).map((words) => ['prompt (orchestrator)', words] as const),
      ...commandMentions(WORKER).map((words) => ['prompt (worker)', words] as const),
      ...commandMentions(SKILLS.github).map((words) => ['skill/github', words] as const),
      ...commandMentions(SKILLS.feishu).map((words) => ['skill/feishu', words] as const),
      ...commandMentions(INPUT_SURFACE).map((words) => ['input', words] as const)
    ]
      .filter(([, words]) => commandFor(words) === null)
      .map(([where, words]) => `${where}: superagent ${words.join(' ')}`)
    assert.deepEqual(offenders, [])
  })

  test('every command reference is mentioned at least once, so a rename reaches the text', () => {
    // 反方向也留一条：§G.2 里 Router/Worker 会用的命令必须至少在提示词或技能里出现一次，
    // 否则改名时没人会发现文本还停在旧名字上。
    const mentioned = new Set(
      [...commandMentions(ORCHESTRATOR), ...commandMentions(WORKER), ...commandMentions(SKILLS.github)]
        .map((words) => commandFor(words)?.name.join(' '))
        .filter((name): name is string => name !== undefined)
    )
    for (const name of ['route', 'read', 'eval', 'eval-read', 'eval-decide', 'reply', 'ack', 'report']) {
      assert.ok(mentioned.has(name), `no prompt text tells the model about "superagent ${name}"`)
    }
  })

  test('every flag named next to a superagent command exists on the command table', () => {
    const offenders: string[] = []
    for (const [where, text] of [
      ['prompt (orchestrator)', ORCHESTRATOR],
      ['prompt (worker)', WORKER],
      ['skill/github', SKILLS.github],
      ['skill/feishu', SKILLS.feishu],
      ['input', INPUT_SURFACE]
    ] as const) {
      for (const line of text.split('\n')) {
        // 只核「同一行里点了 superagent」的 flag：`gh api … --method` 与 `lark-cli --help`
        // 是别的工具的参数，不属于命令表。
        if (!line.includes('superagent')) continue
        for (const match of line.matchAll(/--([a-z][a-z0-9-]*)/g)) {
          if (!KNOWN_FLAGS.has(match[1]!)) offenders.push(`${where}: --${match[1]}`)
        }
      }
    }
    assert.deepEqual(offenders, [])
  })

  test('the reply purposes and the report states in the text are the ones the CLI accepts', () => {
    const reply = CLI_COMMANDS.find((command) => command.name.join(' ') === 'reply')
    assert.ok(reply)
    const purpose = reply.flags.find((flag) => flag.name === 'purpose')
    assert.deepEqual(purpose?.choices, ['answer', 'result', 'attention'])
    // 文本逐字点了这三个用途与全部六个报告状态。
    for (const choice of purpose?.choices ?? []) {
      assert.ok(ORCHESTRATOR.includes(choice), `the prompt never names the ${choice} purpose`)
    }
    for (const state of REPORT_STATES) {
      assert.ok(WORKER.includes(`--state ${state}`), `the worker prompt never names --state ${state}`)
    }
    const report = CLI_COMMANDS.find((command) => command.name.join(' ') === 'report')
    assert.deepEqual(report?.flags.find((flag) => flag.name === 'state')?.choices, [...REPORT_STATES])
  })

  test('the text limit the prompt states is the error code the CLI returns', () => {
    assert.ok(WORKER.includes('too_long') || ORCHESTRATOR.includes('too_long'), 'the prompt names the refusal code')
    assert.ok(Object.values(ERROR_CODES).includes('too_long'))
  })

  test('the help text never names a command or an upstream tool that does not exist here', () => {
    // §H.23：不许伪装。上游的 `orchestrator_*` 工具名与 `dsh` CLI 在 Orca 上不存在。
    for (const [where, text] of [
      ['help', HELP],
      ['prompt', ORCHESTRATOR + WORKER],
      ['skills', SKILLS.github + SKILLS.feishu],
      ['input', INPUT_SURFACE]
    ] as const) {
      assert.equal(/orchestrator_/.test(text), false, `${where} names an upstream tool`)
      assert.equal(/\bdsh (?:plugin|superagent|--profile)\b/.test(text), false, `${where} names the upstream CLI`)
    }
  })
})

describe('the environment surface', () => {
  test('every variable the model is told about is one the executor sets', () => {
    const pattern = /\b(?:DSH_)?SUPERAGENT_[A-Z][A-Z0-9_]*\b/g
    const known = new Set<string>(ENVIRONMENT_VARIABLES)
    const offenders = [...SURFACE.matchAll(pattern)]
      .map((match) => match[0])
      .filter((name) => !known.has(name))
    assert.deepEqual(offenders, [])
  })

  test('the prompt points at the token file and never at a token value', () => {
    assert.ok(ORCHESTRATOR.includes('SUPERAGENT_TOKEN_FILE'), 'the export example names the variable')
    assert.ok(ORCHESTRATOR.includes(ENVIRONMENT.tokenFile), 'the token file path is a literal')
    // 值长这样：至少 40 个字符的连续 token 字符；prompt 里出现任何一个都算泄漏。
    assert.equal(/[A-Za-z0-9_-]{40,}/.test(ORCHESTRATOR + WORKER), false, 'no token-like literal in the prompt')
  })

  test('the brief hands over the environment table it was given', () => {
    for (const name of Object.keys(BRIEF_ENVIRONMENT)) {
      assert.ok(INPUT_SURFACE.includes(name), `the brief never names ${name}`)
    }
  })
})

describe('the vocabulary surface', () => {
  /** 提示词必须用术语表里的词：一个词一个术语键。 */
  const TERMS_IN_PROMPT: Readonly<Record<string, string>> = {
    ticket: 'ticket',
    assignment: 'assignment',
    trigger: 'trigger',
    thread: 'thread',
    decision: 'decision',
    eval: 'eval',
    mandate: 'mandate',
    policy: 'policy',
    source: 'source',
    attention: 'attention',
    report: 'report',
    input: 'input',
    subscription: 'subscription',
    scope: 'scope',
    orchestrator: 'mainSession',
    worker: 'executorSession'
  }

  test('every domain term the prompt uses has a two-language glossary entry', () => {
    for (const [term, key] of Object.entries(TERMS_IN_PROMPT)) {
      assert.ok(
        new RegExp(`\\b${term}s?\\b`, 'i').test(ORCHESTRATOR + WORKER),
        `the prompt never uses the term ${term}`
      )
      const copy = COPY[`glossary.meaning.${key}` as keyof typeof COPY]
      assert.ok(copy, `the glossary has no entry glossary.meaning.${key}`)
      assert.ok(copy.zh.trim().length > 0 && copy.en.trim().length > 0, `${key} needs both languages`)
    }
  })

  test('the code tables the prompt quotes keep their glossary terms', () => {
    // 术语表与码表逐键相等由 `terms.test.ts` 守；这里只确认提示词引用的两类码仍在表里。
    for (const state of REPORT_STATES) {
      assert.ok(TERMS[`report.${state}`], `the report state ${state} has no term`)
    }
  })
})

describe('size budgets', () => {
  test('each part stays inside its own budget, so no document is pasted into one section', () => {
    const over = PROMPT_PART_KEYS.filter((key) => PROMPT_PARTS[key].lines.join('\n').length > PROMPT_BUDGETS.partMaxChars)
    assert.deepEqual(over, [])
  })

  test('each role prompt stays inside the prompt budget', () => {
    assert.ok(ORCHESTRATOR.length <= PROMPT_BUDGETS.promptMaxChars, `orchestrator prompt is ${ORCHESTRATOR.length}`)
    assert.ok(WORKER.length <= PROMPT_BUDGETS.promptMaxChars, `worker prompt is ${WORKER.length}`)
  })

  test('each skill stays inside the skill budget', () => {
    for (const [name, text] of Object.entries(SKILLS)) {
      assert.ok(text.length <= PROMPT_BUDGETS.skillMaxChars, `${name} skill is ${text.length}`)
    }
  })

  test('the help text stays small enough for an agent to read', () => {
    assert.ok(HELP.length <= PROMPT_BUDGETS.promptMaxChars, `help is ${HELP.length}`)
  })

  test('the default configuration stays inside the save limit of §L.6, skill text included', () => {
    const saved: PromptConfig = { skills: Object.fromEntries(Object.entries(SKILLS)) }
    // §L.6 的总量含团队技能文本：技能正文虽然不进提示词，但它是团队要读的文本，计入同一个上限。
    assert.equal(
      configChars(saved),
      SKILLS.github.length + SKILLS.feishu.length,
      'every skill character counts toward the limit'
    )
    assert.ok(configChars(saved) <= PROMPT_BUDGETS.configMaxChars, `config is ${configChars(saved)}`)
    // 拼好的全文也都在上限之下（§L.6 的另一个强制点）。
    assert.ok(ORCHESTRATOR.length <= PROMPT_BUDGETS.configMaxChars)
    assert.ok(WORKER.length <= PROMPT_BUDGETS.configMaxChars)
  })

  test('the mandate that narrows a proactive ticket keeps the local-only line', () => {
    const mandate = mandateInstructions(PROACTIVE.mandate)
    assert.ok(mandate.includes('only the local small change'))
    assert.ok(INPUT_SURFACE.includes('only the local small change'), 'the brief carries the mandate')
  })
})

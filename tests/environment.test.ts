// 执行环境的变量表（§E.11、§E.3）：变量名保留上游写法（skills 与 prompts 直接引用），
// 值来自 Ticket、部署与 Source 配置——不由 agent 自己「发现」。本文件断言四件事：
// 1. 逐项的值（含起始是 PR、来自 Feishu 时的附加变量）；
// 2. 变量顺序稳定（env.sh 的行序因此可断言）；
// 3. 值进 shell 时逐值单引号转义：消息正文里的 `; rm -rf` 必须原样落在引号内；
// 4. `${DSH_SUPERAGENT_*}` 只替换白名单变量，未知变量原样留下。
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Trigger } from '../src/worker/core/model'
import {
  ENVIRONMENT_VARIABLES,
  environmentOf,
  shellSingleQuote,
  substituteVariables,
  type EnvironmentDeployment,
  type EnvironmentInput
} from '../src/worker/executor/environment'

/** 部署派生的事实（`sources/kind.ts` 的 `Deployment` 结构上满足它；测试只列相关字段）。 */
const deployment: EnvironmentDeployment = {
  repository: 'acme/widgets',
  githubLogin: 'acme-agent',
  githubCommitEmail: '1+acme-agent@users.noreply.github.com',
  feishuBotId: 'ou_bot_1'
}

/** 一条 GitHub Issue 起始的 Trigger（`threads[0]` 是 primary thread，§D.1）。 */
const issueTrigger: Trigger = {
  id: 'github:issue:12',
  source: 'github',
  threads: [{ source: 'github', id: 'github:12' }],
  actor: { source: 'github', id: 'alice' },
  human: true,
  at: '2026-11-07T03:26:00.000Z',
  text: 'Please fix the login flow.',
  meta: { number: 12 }
}

/** 同一件事，但起始是 PR：多一个 head 引用。 */
const pullTrigger: Trigger = { ...issueTrigger, meta: { number: 34, isPr: true } }

/** 起始在 Feishu 的话题里。 */
const feishuTrigger: Trigger = {
  id: 'feishu:message:om_1',
  source: 'feishu',
  threads: [{ source: 'feishu', id: 'feishu:om_1' }],
  actor: { source: 'feishu', id: 'ou_alice' },
  human: true,
  at: '2026-11-07T03:26:00.000Z',
  text: '看看这个登录问题',
  meta: { chatId: 'oc_chat_1' }
}

/** 一个 Ticket 的执行事实（§E.1）。 */
const ticket = {
  id: 'ticket-11',
  name: 'fix-the-login-flow',
  directory: '/worktrees/acme/superagent-fix-the-login-flow'
}

/** 本插件的三项（§G.5：CLI 绝对路径、token 文件路径、API 基址）。 */
const plugin = {
  cliPath: '/plugins/whutlichao.superagent/src/bin/superagent.mjs',
  tokenFile: '/state/tokens/asg_7f3a',
  apiBase: 'http://127.0.0.1:3082'
}

/** 一个 GitHub Issue 起始的完整输入。 */
const base: EnvironmentInput = {
  deployment,
  ticket,
  plugin,
  blockedCommands: ['personal-gh', 'gh-legacy'],
  trigger: issueTrigger
}

describe('the execution variable table of §E.11', () => {
  test('every upstream name is present, in a stable order', () => {
    assert.deepEqual(ENVIRONMENT_VARIABLES, [
      'DSH_SUPERAGENT_DIR',
      'DSH_SUPERAGENT_NAME',
      'DSH_SUPERAGENT_TICKET',
      'DSH_SUPERAGENT_BLOCKED_COMMANDS',
      'DSH_SUPERAGENT_GITHUB_REPOSITORY',
      'DSH_SUPERAGENT_GITHUB_ACCOUNT',
      'DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL',
      'DSH_SUPERAGENT_GITHUB_NUMBER',
      'DSH_SUPERAGENT_GITHUB_PR_HEAD',
      'DSH_SUPERAGENT_FEISHU_BOT',
      'DSH_SUPERAGENT_FEISHU_CHAT',
      'SUPERAGENT_CLI',
      'SUPERAGENT_TOKEN_FILE',
      'SUPERAGENT_API'
    ])
    assert.deepEqual(Object.keys(environmentOf(base)), [...ENVIRONMENT_VARIABLES])
  })

  test('ticket, deployment and plugin values are filled in; a GitHub issue start fills the number', () => {
    assert.deepEqual(environmentOf(base), {
      DSH_SUPERAGENT_DIR: '/worktrees/acme/superagent-fix-the-login-flow',
      DSH_SUPERAGENT_NAME: 'fix-the-login-flow',
      DSH_SUPERAGENT_TICKET: 'ticket-11',
      DSH_SUPERAGENT_BLOCKED_COMMANDS: 'personal-gh,gh-legacy',
      DSH_SUPERAGENT_GITHUB_REPOSITORY: 'acme/widgets',
      DSH_SUPERAGENT_GITHUB_ACCOUNT: 'acme-agent',
      DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL: '1+acme-agent@users.noreply.github.com',
      DSH_SUPERAGENT_GITHUB_NUMBER: '12',
      DSH_SUPERAGENT_GITHUB_PR_HEAD: '',
      DSH_SUPERAGENT_FEISHU_BOT: 'ou_bot_1',
      DSH_SUPERAGENT_FEISHU_CHAT: '',
      SUPERAGENT_CLI: '/plugins/whutlichao.superagent/src/bin/superagent.mjs',
      SUPERAGENT_TOKEN_FILE: '/state/tokens/asg_7f3a',
      SUPERAGENT_API: 'http://127.0.0.1:3082'
    })
  })

  test('a pull request start adds the head reference next to its number', () => {
    const table = environmentOf({ ...base, trigger: pullTrigger })
    assert.equal(table.DSH_SUPERAGENT_GITHUB_NUMBER, '34')
    assert.equal(table.DSH_SUPERAGENT_GITHUB_PR_HEAD, 'refs/pull/34/head')
  })

  test('a Feishu start fills the chat and leaves the GitHub number and head empty', () => {
    const table = environmentOf({ ...base, trigger: feishuTrigger })
    assert.equal(table.DSH_SUPERAGENT_FEISHU_CHAT, 'oc_chat_1')
    assert.equal(table.DSH_SUPERAGENT_FEISHU_BOT, 'ou_bot_1')
    assert.equal(table.DSH_SUPERAGENT_GITHUB_NUMBER, '')
    assert.equal(table.DSH_SUPERAGENT_GITHUB_PR_HEAD, '')
  })

  test('without a trigger, or from another source, the source-specific values are empty', () => {
    assert.equal(environmentOf(base).DSH_SUPERAGENT_GITHUB_NUMBER, '12')
    const none = environmentOf({ ...base, trigger: undefined })
    assert.equal(none.DSH_SUPERAGENT_GITHUB_NUMBER, '')
    assert.equal(none.DSH_SUPERAGENT_FEISHU_CHAT, '')
    const elsewhere = environmentOf({
      ...base,
      trigger: { ...issueTrigger, source: 'gitlab', threads: [{ source: 'gitlab', id: 'gitlab:1' }] }
    })
    assert.equal(elsewhere.DSH_SUPERAGENT_GITHUB_NUMBER, '')
    assert.equal(elsewhere.DSH_SUPERAGENT_GITHUB_REPOSITORY, 'acme/widgets', 'the repository is deployment facts, not the trigger')
    assert.equal(elsewhere.DSH_SUPERAGENT_BLOCKED_COMMANDS, 'personal-gh,gh-legacy')
  })

  test('a source kind may contribute extra variables and wins over a duplicate key', () => {
    const table = environmentOf({
      ...base,
      sources: [
        {
          kind: 'probe',
          config: { repository: 'acme/probe' },
          environment: {
            variables: [{ key: 'PROBE_REPOSITORY' }, { key: 'DSH_SUPERAGENT_GITHUB_REPOSITORY' }],
            values: (input) => ({
              PROBE_REPOSITORY: String(input.config['repository']),
              DSH_SUPERAGENT_GITHUB_REPOSITORY: 'probe/wins'
            })
          }
        }
      ]
    })
    assert.equal(table['PROBE_REPOSITORY' as keyof typeof table], 'acme/probe')
    assert.equal(table.DSH_SUPERAGENT_GITHUB_REPOSITORY, 'probe/wins')
  })
})

describe('values that enter a shell', () => {
  test('a single quote leaves the quoted run and comes back, so the value stays one word', () => {
    assert.equal(shellSingleQuote('plain'), "'plain'")
    assert.equal(shellSingleQuote("it's"), "'it'\\''s'")
    assert.equal(shellSingleQuote(''), "''")
  })

  test('the prepare command substitutes whitelisted variables and never concatenates raw text', () => {
    const hostile = environmentOf({
      ...base,
      // 消息正文里的 `; rm -rf` 进了变量值（例如个人 CLI 名单）：替换后仍必须是一个引号串。
      blockedCommands: ['personal-gh; rm -rf /tmp/x', 'gh']
    })
    const command = substituteVariables(
      'cd ${DSH_SUPERAGENT_DIR} && echo ${DSH_SUPERAGENT_BLOCKED_COMMANDS} ${HOME}',
      hostile
    )
    assert.equal(
      command,
      `cd '${ticket.directory}' && echo 'personal-gh; rm -rf /tmp/x,gh' \${HOME}`
    )
    // 值里的 `; rm -rf` 只出现在一对单引号内：否则 shell 会把它切成第三条命令。
    assert.equal(command.includes("'; rm -rf"), false)
    assert.ok(command.includes("'personal-gh; rm -rf /tmp/x,gh'"))
  })

  test('an unknown variable is left for the shell instead of being guessed', () => {
    assert.equal(
      substituteVariables('echo ${DSH_SUPERAGENT_TICKET}-${NOT_OURS}-$PLAIN', {
        DSH_SUPERAGENT_TICKET: 'ticket-11'
      }),
      `echo 'ticket-11'-\${NOT_OURS}-$PLAIN`
    )
  })

  test('a missing variable becomes an empty quoted string, never the literal form', () => {
    assert.equal(substituteVariables('mkdir -p ${SUPERAGENT_API}', {}), "mkdir -p ''")
  })
})

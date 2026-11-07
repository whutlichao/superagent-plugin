// 两个生成段（§L.2 的 `runtime/environment`、`runtime/policy`、`runtime/policy/none`；§L.3、
// §G.5）：正文是**模板**，值来自部署与 Policy，由 `app/prompts.ts` 在组装时填。
//
// 必保留占位符（§L.3 的表，缺一个就是 `missing_placeholder` 拒绝保存）：
// - 环境段：`{variables}`、`{cli}`、`{token_file}`、`{state_dir}`、`{repository}`；
// - Policy 段：`{version}`、`{mode}`、`{rules}`；
// - 无规则替代段：`{version}`、`{mode}`。
//
// 为什么这些值是字面量而不是「让 agent 去发现」：Orca 不给 agent 注入 stateDir 的位置，CLI 的
// 绝对路径与 token 文件路径只能是 prompt 里写死的（§G.4、§G.5）。路径可能有空格，所以模板里
// 一律带双引号；token 只写**文件路径**，绝不写值（§D.6）。
export const ENVIRONMENT_LINES: readonly string[] = [
  '## Execution environment',
  "These values come from this installation's settings and take precedence over any repository or account named elsewhere in these instructions; an empty value means that part is not configured here.",
  'The prepare command of a ticket directory reads the same variables.',
  'Inherited variables: {variables}',
  'CLI (absolute path; use it as it is, in double quotes): node "{cli}"',
  'Token file: {token_file}',
  '  usage: node "{cli}" status --json --token-file "{token_file}"',
  '  or export SUPERAGENT_TOKEN_FILE="{token_file}"',
  '  If a command answers 401 or 403 and the token file is gone, this assignment has ended: stop, report that, and do not retry.',
  'stateDir: {state_dir}',
  'repository: {repository}'
]

export const POLICY_LINES: readonly string[] = [
  '## Policy',
  'Policy version {version}; accept mode {mode}.',
  'The accept mode and the rules decide proactive candidates only: an explicit request from an allowed sender is routed as dispatch says, in any mode and whatever the rules.',
  'An enabled rule may narrow what counts as a deliberate request for its category, and it never widens the ticket scope or an explicit request.',
  "When a matched rule narrows a proactive ticket, that ticket's worker follows the rule and nothing outside it.",
  'The enabled rules, by name and id:',
  '{rules}'
]

export const POLICY_NONE_LINES: readonly string[] = [
  '## Policy',
  'Policy version {version}; accept mode {mode}.',
  'No rule is enabled, so a proactive candidate can only be ignored; accept explicit requests from allowed senders as dispatch says.',
  'The accept mode and the rules decide proactive candidates only, and this section is empty of rules on purpose.'
]

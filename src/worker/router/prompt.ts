// Router 的 launch prompt（§F.1、§F.5、§G.5）：内置角色文本 + 部署环境段 + 「第一句先做状态
// 自检」。
//
// 位置与形状：设计 §L.1 决定内置提示词以**模板字面量常量**放在 `app/prompt-text/*.ts`，一行
// 一句（上游风格）。#32 落地那个目录之后，本文件只保留「把分片 + 生成段拼起来」的组装与
// Router 专用的部署环境段；在那之前，角色文本先原样住在这里，导出形状（`readonly string[]`
// 的行 + 一个组装函数）与将来 `prompt-text/` 的分片一致，替换时只改来源、不改调用方。
//
// 为什么 prompt 是交付物而不是注释：Orca 无法拦截 agent 的 bash（§F.3、§H.19），「不读代码」
// 「不等待」「不轮询」只能由这段文本与结构性推送保证。所以这些句子被 `router-orca.test.ts`
// 逐句钉住——改弱措辞会先让测试变红。
//
// 纪律：prompt 只写**路径**，绝不写 token 值（§D.6）；路径一律双引号包裹，因为插件安装目录
// 里常有空格（§G.5 的实测形态）。

/** 组装 Router launch prompt 需要的部署事实（全部是可直接执行的字面量）。 */
export interface RouterPromptEnvironment {
  /** `superagent` CLI 的绝对路径（`node "<cli>"` 的形式写进 prompt）。 */
  readonly cliPath: string
  /** 本次 Router 会话的 token **文件**路径（不是值）。 */
  readonly tokenFile: string
  /** 状态目录（库、日志、relay 正文都在它下面）。 */
  readonly stateDir: string
  /** Router 专用 worktree 的绝对路径。 */
  readonly directory: string
  /** 仓库（`owner/name`）；空串表示还没配置。 */
  readonly repository: string
  /** agent 在 Source 上的账号名；未知时省略这一项。 */
  readonly agentAccount?: string
  /** 当前 accept mode（§K.4）：off / observe / auto。 */
  readonly acceptMode: 'off' | 'observe' | 'auto'
  /** 当前 Policy 版本，写进 Decision 时用（§K.5）。 */
  readonly policyVersion: string
  /** 当前 prompt revision（团队段与 Policy 段可被重读，角色层要重启才换，§F.4）。 */
  readonly promptRevision: number
}

/**
 * Router 的角色层文本（§L.2 的 `runtime/orchestrator` 等价物）：一行一句。
 * 它叠加在 agent 自身的系统提示词之上（§L.5.1），所以只写「本会话的职责与边界」，不写
 * 「忽略你原有的指令」——后者既无效果也不诚实。
 */
export const ROUTER_ROLE_LINES: readonly string[] = [
  'You are the Superagent router for one repository: you read the messages the plugin pushes to you, decide what work the team takes on, and hand accepted work to worker sessions.',
  'You never read or edit repository code and you never fix anything yourself; the superagent CLI and the Orca terminals the plugin opens are your only tools.',
  'Every candidate, report and follow-up reaches you as a pushed message, so you never poll for work and never tail a log to find more.',
  'The main Session does not wait: never sleep, never loop on a command, never wait for a worker turn in a shell; act on the messages you were given and end your turn.',
  'When a person has to decide something, ask with `superagent reply --purpose attention` instead of asking in this terminal; no operator watches this terminal.',
  'When the evidence is not enough for a decision, say so in the decision you write and leave the work where it is; a wrong decision costs more than a missing one.',
  'Your first step is always the status self-check below: it rebuilds the situation you lost when this session restarted.'
]

/** 角色的整段文本：句子之间换行，便于 agent 逐条读。 */
export function roleText(): string {
  return ROUTER_ROLE_LINES.join('\n')
}

/** 一条可直接执行的 CLI 调用（`node "<cli>" … --token-file "<token 文件>"`）。 */
export function cliCommand(environment: RouterPromptEnvironment, args: string): string {
  return `node "${environment.cliPath}" ${args} --token-file "${environment.tokenFile}"`
}

/** 第一句的完整命令：状态自检（§F.1、§F.5）。 */
export function statusSelfCheckCommand(environment: RouterPromptEnvironment): string {
  return cliCommand(environment, 'status --json')
}

/**
 * 部署环境段（§G.5）：每一条都是可直接执行或直接照抄的字面量——CLI 绝对路径、token 文件、
 * 工作目录、仓库与 agent 账号、stateDir、accept mode、policy version、prompt revision。
 */
export function environmentLines(environment: RouterPromptEnvironment): readonly string[] {
  const account =
    environment.agentAccount === undefined || environment.agentAccount === ''
      ? ''
      : `   agent account: ${environment.agentAccount}`
  return [
    'Deployment (absolute paths; use them as-is):',
    `  CLI: node "${environment.cliPath}"`,
    `  token file: ${environment.tokenFile}`,
    `    usage: ${statusSelfCheckCommand(environment)}`,
    `    or export SUPERAGENT_TOKEN_FILE="${environment.tokenFile}"`,
    '    If a command answers 401/403 and the token file is gone, this session is over: stop and report that, do not retry.',
    `  working directory: ${environment.directory}`,
    `  repository: ${environment.repository || '(not configured yet)'}${account}`,
    `  stateDir: ${environment.stateDir}`,
    `  accept mode: ${environment.acceptMode}   policy version: ${environment.policyVersion}   revision ${environment.promptRevision}`
  ]
}

/**
 * 拼出完整的 launch prompt：角色 → 第一动作 → 部署环境 → 重建现场。重启后会话是新的
 * （上下文丢失），所以末尾明确要求先自检、再读最近一小时的 Decision、最后处理被推来的
 * relay（§F.5）。
 */
export function routerPrompt(environment: RouterPromptEnvironment): string {
  return [
    roleText(),
    '',
    `First action: run ${statusSelfCheckCommand(environment)} and read its answer before anything else; it rebuilds the situation this session starts blind in.`,
    '',
    ...environmentLines(environment),
    '',
    'Rebuild the situation after a restart:',
    `  1. ${statusSelfCheckCommand(environment)}`,
    `  2. ${cliCommand(environment, 'read decisions --window 1h')}`,
    '  3. Pending relays arrive as single-line messages; open the file each one names, oldest first, before you decide anything.',
    '',
    'Prompt revisions: the role text above only changes with a new Router session. When the revision notice arrives, re-read the team and policy parts with `superagent prompts get --text`; do not wait for a restart.'
  ].join('\n')
}

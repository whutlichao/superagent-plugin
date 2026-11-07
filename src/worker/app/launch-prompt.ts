// 启动时的提示词组装（§L.3、§L.5、§E.2、§F.1）：**一个**组装函数，两个消费者。
//
// 为什么单独一层：§L.5 要求 Router 与 Worker 都在 launch 时拿到全文，而两者的差别只在
// 「全文怎么送」（Router 直接当 launch prompt，Worker 落到 `.superagent/prompt.md` 并只给
// 终端一行指针）。组装（分片顺序、团队段与 override、当时的 Policy 段与部署环境段）因此
// 只能写在这里一次；`router/` 与 `executor/` 各自只负责投递方式，绝不各拼一份文本。
//
// 版本语义（§L.4、§L.5）：全文末尾带这一版 revision 与「之后怎么重读」。两句话都不承诺
// 热更新——运行中的会话不会自动换上新的角色层，版本随消息走、全文要新会话或显式重读。
//
// 依赖纪律（§C.2）：本文件只 import 同层的 `prompts.ts`（纯组装，无 I/O、无时钟），所以
// Router 与 Executor 都可以用它，而 `app/` 不会反过来依赖它们。
import {
  composePrompt,
  promptTextOf,
  type PromptConfig,
  type PromptEnvironment,
  type PromptPolicy,
  type PromptRole
} from './prompts.ts'

/** 一次 launch 的全文、它的 revision 与长度。 */
export interface LaunchPrompt {
  readonly role: PromptRole
  /** 这一版配置的版本号：写进全文，也进日志（§L.4）。 */
  readonly revision: number
  readonly text: string
  /** `text` 的字符数——日志只记它，绝不记正文。 */
  readonly length: number
}

/** 组装一次 launch 需要的全部事实：每次 launch 现读，不复用旧缓存。 */
export interface LaunchPromptInput {
  readonly role: PromptRole
  readonly revision: number
  /** 保存下来的配置（团队三段与 override 按它读，§L.4）。 */
  readonly config: PromptConfig
  /** 部署环境段的填值（§G.5）。 */
  readonly environment: PromptEnvironment
  /** Router 的 Policy 段；Worker 的组装顺序里没有它（§L.3 第 11 步只属于 Router）。 */
  readonly policy?: PromptPolicy
}

/**
 * 启动时读「当前保存的提示词配置与版本」的口子（§L.4）：每次 launch 现读，不复用旧缓存。
 * `app/prompts.ts` 的 `PromptVersions` 结构上满足它；Executor 只拿这两个读数，不碰版本表。
 */
export interface LaunchPromptSource {
  /** 当前版本号；还没存过是 0（= 内置默认）。 */
  revision(): number
  /** 当前配置；还没存过时是默认配置（`{}`）。 */
  config(): PromptConfig
}

/** 这一版 revision 的说明，按角色给读法（§F.4、§L.5）。 */export function revisionLines(role: PromptRole, revision: number): readonly string[] {
  if (role === 'orchestrator') {
    return [
      `Prompt revision ${revision}.`,
      'Team and policy text can be re-read with `superagent prompts get --text`; the role text above only changes with a new Router session.'
    ]
  }
  return [
    `Prompt revision ${revision}.`,
    'When a message names a newer revision, read it with `superagent prompts get --revision <n>`; the role text above stays as this session was launched with it.'
  ]
}

/**
 * 组装一次 launch 的全文：§L.3 的顺序（`composePrompt`）＋末尾这一版 revision 的说明。
 * 生成段（环境、Policy）用的是本次调用传进来的值，所以每次 launch 都是当下的部署与 Policy。
 */
export function assembleLaunchPrompt(input: LaunchPromptInput): LaunchPrompt {
  const composed = composePrompt({
    role: input.role,
    environment: input.environment,
    ...(input.policy === undefined ? {} : { policy: input.policy }),
    ...promptTextOf(input.config)
  })
  const text = [composed, '', '## Prompt revision', ...revisionLines(input.role, input.revision)].join('\n')
  return { role: input.role, revision: input.revision, text, length: text.length }
}

/**
 * 一条可以进日志的描述：只有 revision 与长度（§L.5 的「日志不含正文」）。
 * 拼好的全文可能有上百 KB，任何一次「顺手把 prompt 打出来」都会把 token 文件路径与团队
 * 文本写进日志；所以日志的唯一入口是这一行（按 `{revision, length}` 收参数，两个消费者都
 * 只拿得到这两个数，不拿整份 `LaunchPrompt` 就能记日志）。
 */
export function promptLogLine(prompt: { readonly revision: number; readonly length: number }): string {
  return `prompt revision ${prompt.revision} (${prompt.length} chars)`
}

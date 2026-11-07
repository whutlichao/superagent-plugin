// Router 的 launch prompt（§F.1、§F.5、§G.5）：**组装后的全文**（§L.3，由 `app/launch-prompt.ts`
// 产出）＋ Router 自己的尾部——「第一句先做状态自检」与「重启后怎么重建现场」。
//
// 位置与形状：设计 §L.1 决定内置提示词以**模板字面量常量**放在 `app/prompt-text/*.ts`，一行
// 一句（上游风格）。Router 的角色层、团队三段、Policy 段与部署环境段全在组装里，这里只保留
// Router 专属的两段：可执行的自检命令与重建步骤。同一个角色文本不抄第二份，`ROUTER_ROLE_LINES`
// 只是那份分片的再导出，调用方与 `router-orca.test.ts` 不用改。
//
// 为什么 prompt 是交付物而不是注释：Orca 无法拦截 agent 的 bash（§F.3、§H.19），「不读代码」
// 「不等待」「不轮询」只能由这段文本与结构性推送保证。所以这些句子被 `router-orca.test.ts`
// 逐句钉住——改弱措辞会先让测试变红。
//
// 纪律：prompt 只写**路径**，绝不写 token 值（§D.6）；路径一律双引号包裹，因为插件安装目录
// 里常有空格（§G.5 的实测形态）。
import { ORCHESTRATOR_LINES } from '../app/prompt-text/roles.ts'

/** 拼 Router 那次 launch 需要的全部输入。 */
export interface RouterPromptInput {
  /**
   * 组装好的全文（§L.3 的十一段 + 这一版 revision 的说明），来自 `assembleLaunchPrompt`。
   * 本文件不再拼一遍：只追加 Router 专属的尾部。
   */
  readonly text: string
  /** `superagent` CLI 的绝对路径（`node "<cli>"` 的形式写进自检命令）。 */
  readonly cliPath: string
  /** 本次 Router 会话的 token **文件**路径（不是值）。 */
  readonly tokenFile: string
  /** Router 专用 worktree 的绝对路径。 */
  readonly directory: string
}

/**
 * 组装 Router launch prompt 的端口（§L.5）：组合根在 **launch 的那一刻**读当前的配置、
 * Policy 与部署事实，再把拼好的全文交回监督。监督只负责投递与生命周期，不拼文本；
 * 这样「保存了新的团队段 → 下一次 launch 用新内容」不依赖任何缓存。
 */
export interface RouterPromptComposer {
  compose(input: {
    readonly tokenFile: string
    readonly directory: string
    /** 这一次会话要写进全文的 revision（§L.4）。 */
    readonly revision: number
  }): { readonly text: string; readonly length: number }
}

/**
 * Router 的角色层文本（§L.2 的 `runtime/orchestrator`）：一行一句，正文住在
 * `app/prompt-text/roles.ts`。它叠加在 agent 自身的系统提示词之上（§L.5.1），所以只写
 * 「本会话的职责与边界」，不写「忽略你原有的指令」——后者既无效果也不诚实。
 */
export const ROUTER_ROLE_LINES: readonly string[] = ORCHESTRATOR_LINES

/** 一条可直接执行的 CLI 调用（`node "<cli>" … --token-file "<token 文件>"`）。 */
export function cliCommand(input: Pick<RouterPromptInput, 'cliPath' | 'tokenFile'>, args: string): string {
  return `node "${input.cliPath}" ${args} --token-file "${input.tokenFile}"`
}

/** 第一句的完整命令：状态自检（§F.1、§F.5）。 */
export function statusSelfCheckCommand(input: Pick<RouterPromptInput, 'cliPath' | 'tokenFile'>): string {
  return cliCommand(input, 'status --json')
}

/**
 * 拼出完整的 launch prompt：组装后的全文（§L.3）→ 第一动作 → 重建现场。重启后会话是新的
 * （上下文丢失），所以末尾明确要求先自检、再读最近一小时的 Decision、最后处理被推来的
 * relay（§F.5）。部署事实（CLI 路径、token 文件、stateDir、仓库、accept mode、policy
 * version）在全文的执行环境段与 Policy 段里，这里只给出可执行的命令与工作目录。
 */
export function routerPrompt(input: RouterPromptInput): string {
  return [
    input.text,
    '',
    '## This session',
    `Work in ${input.directory}; every command below runs there.`,
    `First action: run ${statusSelfCheckCommand(input)} and read its answer before anything else; it rebuilds the situation this session starts blind in.`,
    '',
    'Rebuild the situation after a restart:',
    `  1. ${statusSelfCheckCommand(input)}`,
    `  2. ${cliCommand(input, 'read decisions --window 1h')}`,
    '  3. Pending relays arrive as single-line messages; open the file each one names, oldest first, before you decide anything.'
  ].join('\n')
}

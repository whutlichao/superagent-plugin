// `agent.launch.before` 钩子（§H.11、附录 C S4）：只给**本插件发起的** launch 追加执行环境。
//
// 事实（Orca 1.4.251 的 `app.asar`，函数 `vWe`）：宿主把钩子的返回值的 `env` 并进这次 PTY
// 启动的环境（`{...e.env, ...a.env}`），钩子收到的 `env` 恒为空对象——所以注入量由插件给全，
// PATH 的底座只能用插件进程自己的 PATH。宿主在恢复已存会话、续接 provider session、结构化
// spawn 与没有 agent 命令时不发这个钩子，因此 `expect` 之后必须有 `release`（launch 失败或
// 钩子没来都不留残留）。宿主给每个插件 2 s（文档口径）；超预算按 §H.11 的回落走「不注入、
// 留日志」，绝不 deny（清单里是 `onError: pass`）。
//
// 依赖纪律（§C.2）：本文件不 import `orca`、不起子进程；它只处理宿主送来的一份 JSON 载荷，
// 把「本插件发起的 launch」与「别人的 launch」区分开。区分靠 `expect` 注册的 workspaceId：
// 只有本插件的执行器在 launch 之前注册，一次 launch 消费一次。

/** 清单 `contributes.hooks` 里的唯一钩子名。 */
export const LAUNCH_HOOK_EVENT = 'agent.launch.before'

/** 宿主给每个插件的钩子预算（§H.11 第 b 条）。 */
export const HOOK_BUDGET_MS = 2_000

/**
 * `agent.launch.before` 的载荷（`types/orca-worker.d.ts` 的 `AgentLaunchBeforeEvent` 同形）。
 * 宿主送的 `env` 恒为空对象：注入什么全由插件算。
 */
export interface LaunchHookEvent {
  readonly agent: string
  readonly workspaceId: string | null
  readonly workspaceKind: 'worktree' | 'folder' | null
  readonly terminalId?: string
  readonly command: string
  readonly env: Readonly<Record<string, string>>
}

/** 钩子的 `next`：改变或放行这次 launch；返回值是宿主的裁决，插件原样交回。 */
export type LaunchHookNext<Decision> = (event: LaunchHookEvent) => Decision

/** 一次即将发生的、由本插件发起的 launch 的环境。 */
export interface PendingLaunch {
  readonly workspaceId: string
  /** 要并进这次 launch 的变量（§E.11 的变量表 + PATH / GIT_CONFIG_GLOBAL）。 */
  readonly environment: Readonly<Record<string, string>>
}

/** 钩子的可注入依赖：时钟（预算判定）与日志（失败与超预算都留一行）。 */
export interface LaunchHookOptions {
  readonly now?: () => number
  readonly log?: (message: string) => void
}

/** 钩子的两面：launch 之前注册环境，钩子到达时消费它。 */
export interface LaunchHook {
  /**
   * 声明「这次 launch 是本插件的」：返回释放函数（幂等）。launch 结束——成功、失败或钩子
   * 没来——都要调用它，避免一次没发生的 launch 把环境留给下一台终端。
   */
  expect(launch: PendingLaunch): () => void
  /**
   * 处理一次 `agent.launch.before`：命中就注入，其余一律原样放行，永不 deny。
   * 泛型只把宿主的裁决原样传回；插件不解释它，所以 `unknown` 只留在宿主边界上。
   */
  handle<Decision>(event: LaunchHookEvent, next: LaunchHookNext<Decision>): Decision
  /**
   * 接上插件的日志出口（`main.ts` 把它指向 `host.log`）。单例的日志默认丢弃——测试各自造
   * 实例时用 `log` 选项，生产必须在 `activate` 里接一次，否则超预算与失败就没有痕迹。
   */
  setLog(log: (message: string) => void): void
}

/** 一条错误的短文本（日志用；不带堆栈）。 */
function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

/** 造一个钩子处理器（测试各造一个；生产用文件末尾的单例）。 */
export function createLaunchHook(options: LaunchHookOptions = {}): LaunchHook {
  const now = options.now ?? (() => Date.now())
  let log = options.log ?? (() => undefined)
  const pending = new Map<string, PendingLaunch>()
  return {
    setLog(next: (message: string) => void): void {
      log = next
    },
    expect(launch: PendingLaunch): () => void {
      pending.set(launch.workspaceId, launch)
      return () => {
        // 只释放自己那一条：同 worktree 上后一次注册不能被前一次的 release 抹掉。
        if (pending.get(launch.workspaceId) === launch) pending.delete(launch.workspaceId)
      }
    },
    handle<Decision>(event: LaunchHookEvent, next: LaunchHookNext<Decision>): Decision {
      let injected: LaunchHookEvent | undefined
      try {
        injected = decide(event)
      } catch (error) {
        // fail-open：钩子里任何一处炸了都只留日志，launch 照常继续（§H.11 第 b 条）。
        log(`[superagent] launch hook passed without injecting: ${messageOf(error)}`)
        injected = undefined
      }
      return injected === undefined ? next(event) : next(injected)

      /** 算这次要不要注入：只认注册过的 workspace，一次 launch 消费一次。 */
      function decide(launch: LaunchHookEvent): LaunchHookEvent | undefined {
        const workspaceId = launch.workspaceId
        if (workspaceId === null) return undefined
        const started = now()
        const environment = pending.get(workspaceId)
        if (environment === undefined) return undefined
        // 先消费再判预算：超预算也只是一次 launch 不注入，不该在下一台终端上「补上」。
        pending.delete(workspaceId)
        const injected = { ...launch, env: { ...launch.env, ...environment.environment } }
        if (now() - started > HOOK_BUDGET_MS) {
          log(
            `[superagent] launch hook for ${workspaceId} exceeded the ${String(HOOK_BUDGET_MS)} ms budget; the launch continues without the environment`
          )
          return undefined
        }
        return injected
      }
    }
  }
}

/**
 * 生产用单例：`main.ts` 在这里注册钩子，执行器在 launch 之前往同一张表里登记环境
 * （一个进程只有一份「当前待启动的 launch」记录）。
 */
/** 生产单例：日志在 `activate` 里指向 `host.log`（`launchHook.setLog`），在那之前只丢弃。 */
export const launchHook: LaunchHook = createLaunchHook()

/** `launchEnvironment` 的输入。 */
export interface LaunchEnvironmentOptions {
  /** §E.11 的变量表。 */
  readonly environment: Readonly<Record<string, string>>
  /** `<stateDir>/bin`：被禁命令的 shim 目录，前置到 PATH。 */
  readonly binDirectory?: string
  /** `<stateDir>/worker-gitconfig`：worker 的 git 全局配置（无身份、无操作者凭据）。 */
  readonly gitConfig?: string
  /** PATH 的底座：插件进程自己的 PATH（钩子载荷里拿不到宿主环境）。 */
  readonly basePath?: string
}

/**
 * 组出这次 launch 要注入的环境：变量表 + PATH 前置 shim 目录 + worker 的 git 配置。
 * PATH 为空时不留空段（空段等于把当前目录放进 PATH）。
 */
export function launchEnvironment(
  options: LaunchEnvironmentOptions
): Record<string, string> {
  const injected: Record<string, string> = { ...options.environment }
  if (options.binDirectory !== undefined) {
    const base = options.basePath ?? ''
    injected['PATH'] = base === '' ? options.binDirectory : `${options.binDirectory}:${base}`
  }
  if (options.gitConfig !== undefined) injected['GIT_CONFIG_GLOBAL'] = options.gitConfig
  return injected
}

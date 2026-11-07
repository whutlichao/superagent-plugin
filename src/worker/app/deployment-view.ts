// 部署页的读模型（§M.3 Deployment、§N.4 health 明细）：把 worker 内部的读者（setup 状态、
// 健康板、Router 快照、暂停状态、机器限额）拼成面板的**一份**读数。
//
// 只有这里决定「面板上的部署页读什么」；`boot.ts` 把各部件接上，面板只渲染。形状来自
// `src/panel/protocol.ts`（两侧唯一的契约，§M.6），所以字段一改两侧同时被类型检查抓住。
//
// 依赖纪律（§C.2）：本文件只 import 领域健康类型与面板协议类型；不 import router/app 的
// 实现（Router 读数按结构接收，避免 app → router 的环），也不碰 I/O。
import type { HealthEntry } from '../core/index.ts'
import type {
  DeploymentLimits,
  DeploymentRouter,
  DeploymentSetupIssue,
  DeploymentView,
  HealthDetail
} from '../../panel/protocol'
import type { MachineLimits } from './limits.ts'

/**
 * Router 读数的输入：`RouterSnapshot` 结构上满足它（§F.1 的 `terminalId`/`startedAt`/
 * `restarts`/`lastError`）。这里写成独立形状，是为了不让 `app/` 依赖 `router/`（那里已经
 * import `app/launch-prompt`，反向依赖会成环）。
 */
export interface DeploymentRouterInput {
  readonly state: HealthEntry['state']
  readonly detail: string
  readonly terminalId: string | null
  readonly startedAt: string | null
  readonly restarts: number
  readonly lastError: string | null
}

/** 部署读数的输入：每个字段都有一个唯一写者（§D.4），这里只做汇总。 */
export interface DeploymentInput {
  readonly stateDir: string
  readonly setup: readonly DeploymentSetupIssue[]
  readonly limits: MachineLimits
  readonly paused: boolean
  /** 健康板的全部条目（按条目名升序；分区交面板的 `health-groups`）。 */
  readonly health: Readonly<Record<string, HealthEntry | undefined>>
  readonly router: DeploymentRouterInput
}

/** 健康板 → 面板的明细行：每条一个名字、四档状态与明细（明细里带计数）。 */
function healthDetails(health: DeploymentInput['health']): readonly HealthDetail[] {
  return Object.entries(health)
    .filter(([, entry]) => entry !== undefined)
    .map(([name, entry]) => ({
      name,
      state: (entry as HealthEntry).state,
      ...((entry as HealthEntry).detail === undefined ? {} : { detail: (entry as HealthEntry).detail as string })
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

/** Router 读数 → 面板的那一份（状态、终端、起始时刻、重启次数、最后错误）。 */
function routerView(router: DeploymentRouterInput): DeploymentRouter {
  return {
    state: router.state,
    detail: router.detail,
    terminalId: router.terminalId,
    startedAt: router.startedAt,
    restarts: router.restarts,
    lastError: router.lastError
  }
}

/** 组装一份部署读数。`limits` 与 `stateDir` 只读，面板不给它们写入入口。 */
export function deploymentView(input: DeploymentInput): DeploymentView {
  const limits: DeploymentLimits = {
    promptMaxChars: input.limits.promptMaxChars,
    admissionContextMaxPages: input.limits.admissionContextMaxPages,
    admissionContextTimeoutMs: input.limits.admissionContextTimeoutMs,
    retentionDays: input.limits.retentionDays
  }
  return {
    stateDir: input.stateDir,
    setup: input.setup,
    limits,
    paused: input.paused,
    health: healthDetails(input.health),
    router: routerView(input.router)
  }
}

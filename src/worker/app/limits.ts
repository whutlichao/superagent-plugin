// 机器限额（§H.12、§H.22、§L.6、§D.2 要点 5）：Deployment 页与生成提示词读同一份数值。
//
// 上游把这些放在 `cordis.patch.yml` 的机器配置里（改了要重启 profile）；本插件把它们放进
// 系统的设置快照，缺省值就是这里的缺省值。设计承诺的四个数值：
// - `promptMaxChars`：保存的提示词配置总量上限（§L.6 缺省 200 000 字符）；
// - `admissionContextMaxPages` / `admissionContextTimeoutMs`：一次评估语境读取的页数与时限
//   （上游 `src/deployment.ts` 的缺省 10 页 / 15 000 ms，§H.22）；
// - `retention.days`：Trigger/Decision 等旧记录的保留天数（§D.2 要点 5 缺省 90 天）。
//
// 依赖纪律（§C.2）：本文件只读一个设置快照与两个既有常量，不碰 I/O、不碰 Orca。
import { DEFAULT_RETENTION } from './retention.ts'
import { PROMPT_BUDGETS } from './prompts.ts'

/** 本机在用的四个限额（面板 Deployment 页与 `machineLimits()` 共用这一份形状）。 */
export interface MachineLimits {
  readonly promptMaxChars: number
  readonly admissionContextMaxPages: number
  readonly admissionContextTimeoutMs: number
  readonly retentionDays: number
}

/**
 * 设置里没写时的缺省值。`promptMaxChars` 取 §L.6 的 200 000（设计规定值，不是上游的
 * 100 000）；页数与时限沿用上游部署配置的缺省（10 页 / 15 000 ms）；保留天数取 §D.2。
 */
export const DEFAULT_MACHINE_LIMITS: MachineLimits = {
  promptMaxChars: PROMPT_BUDGETS.configMaxChars,
  admissionContextMaxPages: 10,
  admissionContextTimeoutMs: 15_000,
  retentionDays: DEFAULT_RETENTION.days
}

/** 一个正整数设置；不是正整数就当没写（绝不把 0 或小数当限额用）。 */
function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/** 一个设置块；不是对象就当空（与 `boot.ts` 的同名习惯一致）。 */
function block(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/**
 * 从一份设置快照读出四个限额：写了的用写的，没写（或写坏）的用缺省值。设置是启动时读到的
 * 那一份，所以改限额要重启插件（§H.12：没有热重载）。
 */
export function machineLimits(settings: Readonly<Record<string, unknown>>): MachineLimits {
  return {
    promptMaxChars: positiveInteger(settings['promptMaxChars']) ?? DEFAULT_MACHINE_LIMITS.promptMaxChars,
    admissionContextMaxPages:
      positiveInteger(settings['admissionContextMaxPages']) ??
      DEFAULT_MACHINE_LIMITS.admissionContextMaxPages,
    admissionContextTimeoutMs:
      positiveInteger(settings['admissionContextTimeoutMs']) ??
      DEFAULT_MACHINE_LIMITS.admissionContextTimeoutMs,
    retentionDays: positiveInteger(block(settings['retention'])['days']) ?? DEFAULT_MACHINE_LIMITS.retentionDays
  }
}

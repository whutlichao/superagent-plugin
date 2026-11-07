// doctor 的单条结论与整体结果（§G.2 的 doctor 行、§N.4、§O）。
//
// **只报有没有，不报是什么**：token 与密钥的值绝不出现在输出里（§O「secret 不落日志」行）。
// 这里只有类型与纯函数（排序、计数、退出码），读文件与跑子进程在 `app/doctor.ts`。

/**
 * `doctor` 的四档状态。前三档是结论；`timeout` 是**没结论**：那条探针在自己的上限内没回来
 * （§O），既不是 ok（不能伪装查过了）也不是 fail（不能把「没查完」说成「坏了」）。
 */
export type DoctorState = 'ok' | 'warn' | 'timeout' | 'fail'

/** `doctor` 的检查项名字（§G.2 的 doctor 行：token/端口/锁/库迁移/CLI 路径/worker git 配置/gh 登录/lark-cli 配置）。 */
export type DoctorCheckName =
  | 'token'
  | 'port'
  | 'lock'
  | 'database'
  | 'cli'
  | 'gitconfig'
  | 'gh'
  | 'lark'

/** 一条 doctor 结论：**只报有没有，不报是什么**（§O：不输出 token 与密钥值）。 */
export interface DoctorCheck {
  readonly name: DoctorCheckName
  readonly state: DoctorState
  /** 一句话说明（可含路径：路径不是秘密，§N.5）。 */
  readonly detail: string
  /** 给人下一步做什么（warn/fail/timeout 才给）。 */
  readonly hint?: string
}

/** `doctor` 的完整结果。 */
export interface DoctorResult {
  readonly checks: readonly DoctorCheck[]
  /** 四档计数（面板与脚本都按它判定）。 */
  readonly summary: { readonly ok: number; readonly warn: number; readonly fail: number; readonly timeout: number }
  readonly stateDir: string
  readonly at: string
  /**
   * 一句分工说明：doctor 是**诊断**（「没配置」与「坏了」逐项分开、只报有没有）；
   * 决定插件能不能开工的是 setup 检查（`superagent setup check`）。两件事不要混看。
   */
  readonly note: string
}

/** `doctor` 结果里的那句分工说明（CLI 的 `--text`、面板 Deployment 页与测试共用一处）。 */
export const DOCTOR_NOTE =
  'doctor diagnoses this machine (present or missing, never a value); the setup check decides whether the plugin may start: superagent setup check'

/** 四档的固定顺序（`--text` 输出把 fail 排最前，便于一眼看到要修什么；超时在警告之前）。 */
export const DOCTOR_STATES: readonly DoctorState[] = ['fail', 'timeout', 'warn', 'ok']

/** 检查项的固定顺序（§G.2 的名字顺序，不看完成顺序）。 */
export const DOCTOR_ORDER: readonly DoctorCheckName[] = [
  'token',
  'port',
  'lock',
  'database',
  'cli',
  'gitconfig',
  'gh',
  'lark'
]

/** 四档的排序权重（fail=0 … ok=3）。 */
export function stateRank(state: DoctorState): number {
  return DOCTOR_STATES.indexOf(state)
}

/** 按固定顺序排好（同一项只该出现一次；重复就让调用方看见）。 */
export function orderChecks(checks: readonly DoctorCheck[]): readonly DoctorCheck[] {
  return [...checks].sort((left, right) => DOCTOR_ORDER.indexOf(left.name) - DOCTOR_ORDER.indexOf(right.name))
}

/** 四档计数。 */
export function summarize(checks: readonly DoctorCheck[]): DoctorResult['summary'] {
  const summary = { ok: 0, warn: 0, fail: 0, timeout: 0 }
  for (const check of checks) summary[check.state] += 1
  return summary
}

/**
 * 组一份结果。`at` 由调用方给（doctor 不读时钟的两处之一：另一处是 `lockAgeMs`）。
 * 有 fail → CLI 退出 1；warn 与 timeout 不失败（未配置的可选项不是坏掉，没查完更不是，§G.2）。
 */
export function doctorResult(checks: readonly DoctorCheck[], input: { readonly stateDir: string; readonly at: string }): DoctorResult {
  const ordered = orderChecks(checks)
  return {
    checks: ordered,
    summary: summarize(ordered),
    stateDir: input.stateDir,
    at: input.at,
    note: DOCTOR_NOTE
  }
}

/** doctor 的退出码：有 fail → 1；否则 0（timeout 不是 fail：判定口径在 setup 检查）。 */
export function doctorExitCode(result: DoctorResult): number {
  return result.summary.fail > 0 ? 1 : 0
}

/** 一条结论的构造：warn/fail/timeout 必须带 hint（给人下一步）。 */
export function doctorCheck(
  name: DoctorCheckName,
  state: DoctorState,
  detail: string,
  hint?: string
): DoctorCheck {
  if (state === 'ok') return { name, state, detail }
  return hint === undefined ? { name, state, detail } : { name, state, detail, hint }
}

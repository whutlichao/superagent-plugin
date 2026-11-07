// §O「超时」行的 HTTP 折码：一段被预算的等待到点（或整次调用被取消）→ 固定码 `unavailable`
// + 「稍后重试」；其余错误原样抛出（「不吞」：挂住的依赖可以是内部故障，别把它说成超时）。
//
// 预算本身只有 `infra/deadline.ts` 一份（`withDeadline` / `withinBudget` / `probeRunner`）：
// 这里**不**装定时器、也不判预算，只做一件事——把那个模块抛出的 `DeadlineError` 翻译成信封里
// 的固定码。文案与毫秒数都取自错误自身（`what` 是调用点给的同一个短语、`ms` 是真正到点的那条
// 线），所以每个端点的「谁没做完、多少毫秒」只有一处说法，不存在第二份。
//
// 依赖纪律（§C.2）：本文件在 `http/`，只 import `infra/` 与同目录的 `errors.ts`。
import { DeadlineError } from '../infra/deadline.ts'
import { ApiError, ERROR_CODES } from './errors.ts'

/**
 * 一次被预算的等待 → 固定码 `unavailable`（503）+「…did not finish within N ms; retry later」。
 *
 * `values` 只放填槽值（`reason: 'timeout'`、`source` 这类），不放内部细节或 argv（§O）；
 * 到点意味着**没做完**，于是调用方看到的是可重试的「稍后重试」，而不是一条编出来的结论。
 * 非截止期错误一律原样抛出：handler 的那张错误码表决定它落成什么。
 */
export function refuseOnDeadline<T>(
  work: Promise<T>,
  values?: Readonly<Record<string, string>>
): Promise<T> {
  return work.catch((error: unknown) => {
    if (!(error instanceof DeadlineError)) throw error
    throw new ApiError(
      ERROR_CODES.unavailable,
      `${sentenceOf(error.what)} did not finish within ${error.ms} ms; retry later`,
      values
    )
  })
}

/** 一句话开头的那个字母大写（`what` 是 `the setup check` 这种小写短语）。 */
function sentenceOf(what: string): string {
  return what.length === 0 ? what : `${what[0]?.toUpperCase() ?? ''}${what.slice(1)}`
}

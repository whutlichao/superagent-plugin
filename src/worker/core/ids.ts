// 稳定、由内容派生的标识：同样的输入永远得到同样的 id（§D.2 的幂等全靠它）。
// 这是 core 唯一允许的内置模块：`node:crypto`，只用来做 hash（§C.2 规则 1）。
import { createHash } from 'node:crypto'

/**
 * 由若干字符串派生一个 32 位十六进制 key。
 *
 * - Trigger：`key('<kind>', <原生 id>[, <版本>])`（§D.1；编辑算新事件，版本就是那个变化）；
 * - 其余：`key('ticket', evalId)`、`key('input', ticketId, 'trigger', triggerId)` 等。
 */
export function key(...values: string[]): string {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 32)
}

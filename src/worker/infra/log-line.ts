// 日志行的共享形状（§N.5：`{ts, level, msg, fields?}` 的 JSON 行）。
// 这里只有类型与「静默出口」，日志落盘/滚动由 #46 的 `infra/log.ts` 负责；
// 迁移、锁、保留策略都需要写一条可读日志，因此先把形状钉在一处，避免三个模块各写一份。
export interface LogLine {
  readonly ts: string
  readonly level: 'info' | 'warn' | 'error'
  readonly msg: string
  readonly fields?: Readonly<Record<string, string | number>>
}

/** 日志出口：调用方决定落到 `orca.log`、文件还是测试数组。 */
export type LogSink = (line: LogLine) => void

/** 不写日志的出口（默认值；避免每个调用点判空）。 */
export const SILENT_LOG: LogSink = () => undefined

/** 把一行日志序列化成磁盘上的形态（一个 JSON 对象一行）；不落盘的地方也用它做断言。 */
export function formatLogLine(line: LogLine): string {
  return JSON.stringify(line)
}

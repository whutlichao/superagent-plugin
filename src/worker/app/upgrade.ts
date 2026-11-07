// 插件版本升级（§N.6 第 5 条）：插件版本一变，正在跑的 Assignment 在旧会话里已经没有意义
// （启动指令、prompt、行为都可能变了），启动时按 `interrupted` 处理，再走 #12 的同一条恢复
// 路径（`executor/resume.ts` 的 `resumeAfterUpgrade`）在新版本上重建。
//
// 判定只需要一个键：`kv['plugin-version']` 记上一次运行的版本。首次运行没有这个键，按
// 「没有前一个版本」处理（不是升级，也不会误伤任何运行中的 Assignment）。
import { SILENT_LOG, type LogLine, type LogSink } from '../infra/log-line.ts'
import { PLUGIN_VERSION_KEY } from './kv.ts'

/**
 * 本插件版本。与 `orca-plugin.json` 的 `version` 必须一致（升级测试断言两者相等），
 * 因为「升级」就是这一个字符串变了。
 */
export const PLUGIN_VERSION = '0.1.0'

/** 版本记录只需要 KV 的读写两面（组合根传整个 Store）。 */
export interface PluginVersionStore {
  kvGet<T>(key: string): T | null
  kvSet(key: string, value: unknown): void
}

/** 记录版本时的输入。 */
export interface PluginVersionOptions {
  /** 本次运行的版本（缺省 `PLUGIN_VERSION`；测试注入）。 */
  readonly version?: string
  readonly now?: () => Date
  /** 版本变化要留一条可读日志（§N.5、§N.6「不静默」）。 */
  readonly log?: LogSink
}

/** 一次启动的版本读数。 */
export interface PluginVersionRecord {
  /** 上一次运行的版本；首次运行是 `null`。 */
  readonly from: string | null
  readonly to: string
  /** 版本变了（升级或降级）：调用方应走 `resumeAfterUpgrade`，不要认领旧会话。 */
  readonly upgraded: boolean
  readonly at: string
}

/**
 * 记下本次运行的插件版本，并报告是否发生了版本变化。
 *
 * 只在版本真的变过时才 `upgraded: true`；首次运行（没有记录）不算升级——状态目录如果是
 * 全新的，本来就没有在跑的 Assignment，没必要走一次「全部中断」的重建。
 */
export function notePluginVersion(
  store: PluginVersionStore,
  options: PluginVersionOptions = {}
): PluginVersionRecord {
  const to = options.version ?? PLUGIN_VERSION
  const now = options.now ?? (() => new Date())
  const log = options.log ?? SILENT_LOG
  const stored: unknown = store.kvGet<unknown>(PLUGIN_VERSION_KEY)
  const from = typeof stored === 'string' && stored.length > 0 ? stored : null
  const at = now().toISOString()
  const upgraded = from !== null && from !== to
  store.kvSet(PLUGIN_VERSION_KEY, to)
  if (upgraded) {
    const line: LogLine = {
      ts: at,
      level: 'info',
      msg: `plugin updated from ${from} to ${to}; running assignments are treated as interrupted`,
      fields: { from, to }
    }
    log(line)
  }
  return { from, to, upgraded, at }
}

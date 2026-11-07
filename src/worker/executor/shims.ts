// 被禁命令的 shim（§H.11 第 c 条）：`<stateDir>/bin/<命令>` 就是一句 `exit 1`。
//
// 用途只有一个：操作者名单里那些「个人 CLI」在这个执行环境里被挡下时**明确失败**，而不是
// 悄悄用操作者的账号跑出一次外部动作。它是**默认值，不是安全边界**——一个知道路径的人可以直接
// 调真二进制；能挡住的是「照着 prompt 顺手敲了个 personal-gh」。脚本与面板文案都必须这么写
// （本文件、设计 §H.11、`Limitations`）。
//
// 写入规则（与上游 `writeEnvironment` 同口径的保守版）：
// - 只有纯命令名（`[A-Za-z0-9._-]`）才写 shim；带路径分隔符或 `..` 的名字直接忽略，
//   绝不让名单把文件写到 `<stateDir>/bin` 之外；
// - 已有文件若不是本插件写的（没有 marker），一律不动——那是别人的东西；
// - 重复写幂等：内容相同的 shim 不重写，不报告 `written`。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** shim 脚本都会带这一行；用它判断「这个文件是我们写的」。 */
export const SHIM_MARKER = 'written by Superagent; not a security boundary'

/** 合法的命令名：不带路径，也不带 shell 会解释的字符。 */
export const SHIM_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** shim 文件的权限：可执行（`0o755`）。 */
export const SHIM_MODE = 0o755

/** `writeCommandShims` 的结果：真写了哪些、跳过了哪些（跳过的原因在日志里，不在结果里）。 */
export interface ShimsResult {
  /** shim 目录的绝对路径（调用方把它前置到 PATH）。 */
  readonly directory: string
  /** 这次写（或覆盖）了 shim 的命令名，按名单顺序。 */
  readonly written: readonly string[]
  /** 名单里不合法、或被别人的文件占住的命令名。 */
  readonly skipped: readonly string[]
}

/** 一个命令名的 shim 脚本文本：说清楚是什么、为什么失败、以及它不是安全边界。 */
export function shimScript(command: string): string {
  return [
    '#!/bin/sh',
    `# ${command} is blocked in this Superagent execution environment (${SHIM_MARKER}).`,
    `# It is a default for clumsy hands, not a security boundary: the real binary is still on the machine.`,
    `printf '%s\\n' "${command} is blocked in this execution environment; use the agent's own CLI instead (this shim is a default, not a security boundary)." >&2`,
    'exit 1',
    ''
  ].join('\n')
}

/**
 * 为名单里的每个命令写一个 `exit 1` 的 shim。目录不存在就建；返回写/跳过清单，
 * 由调用方把 `directory` 前置到 PATH（`launchEnvironment`）。
 */
export function writeCommandShims(options: {
  readonly binDirectory: string
  readonly blockedCommands: readonly string[]
}): ShimsResult {
  mkdirSync(options.binDirectory, { recursive: true })
  const written: string[] = []
  const skipped: string[] = []
  for (const command of options.blockedCommands) {
    if (!SHIM_NAME_PATTERN.test(command)) {
      skipped.push(command)
      continue
    }
    const path = join(options.binDirectory, command)
    if (existsSync(path)) {
      const existing = readFileSync(path, 'utf8')
      if (!existing.includes(SHIM_MARKER)) {
        // 别人的文件：不动它（它不是我们的 shim，覆盖会破坏操作者的工具）。
        skipped.push(command)
        continue
      }
      if (existing === shimScript(command)) continue
    }
    writeFileSync(path, shimScript(command), { encoding: 'utf8', mode: SHIM_MODE })
    written.push(command)
  }
  return { directory: options.binDirectory, written, skipped }
}

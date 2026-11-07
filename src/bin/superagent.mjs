#!/usr/bin/env node
// Superagent CLI —— agent 在终端里唯一要用的可执行入口（§G、§G.4、§G.5）。
//
// 用法（**一律用 node 起，不依赖 shebang 与执行位**，§G.5）：
//   node "<plugin>/src/bin/superagent.mjs" status --json --token-file "<token 文件>"
//
// 这个文件只做三件事：把 argv 交给 `src/worker/cli/main.ts`、把输出写到 stdout/stderr、
// 用返回的退出码退出。所有逻辑都在 `src/worker/cli/` 里（参数解析、目标解析、HTTP、信封与
// 退出码 0/1/2/3），于是 CLI 的行为可以被单测覆盖，而入口本身没有分支。
//
// 为什么是 `.mjs`：插件清单只加载 `src/worker/main.ts` 作为 worker，CLI 必须是独立进程里
// 跑的普通脚本；Node ≥ 22.18（Orca 1.4.251 自带 Node 25）能直接 import `.ts`（strip-only
// 类型剥离），所以入口不需要构建步骤，仓库也仍然「零运行时依赖」。
import { main } from '../worker/cli/main.ts'

const exit = await main({
  argv: process.argv.slice(2),
  env: process.env
})

process.exitCode = exit.exit

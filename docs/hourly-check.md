# 小时级健康巡检（可选，不创建也不影响主机制）

主机制是**常驻状态栏 + 面板**（§N.7）：状态栏显示 `Superagent <n>` / `Superagent paused` /
`Superagent error`，面板的 Overview 与 Deployment 页列出每个健康条目。巡检只是补一条
「没人在看屏幕时也能发现」的线；**不创建这个 Automation 不会让任何主机制停止工作**。

巡检读的是与面板同一个 `GET state` 读数，退出码也与 `status` 完全一致（§N.4）：

| 退出码 | 含义 | 重启能修吗 |
| --- | --- | --- |
| `0` | 正常运行 | — |
| `1` | 没跑 / 跑了两份 / 不响应 / `runtime` 报错 | 通常可以 |
| `2` | 某个非 `runtime` 部件报错（如 `github`、`relay`、`router`） | 不能，要人看 |
| `3` | 等 setup 或处理已暂停（都不是故障） | 不能，要人补配置或恢复 |

## 命令

CLI 一律用 `node` 起绝对路径（§G.5）。状态目录的优先级是
`--state-dir` > `$ORCA_SUPERAGENT_STATE_DIR` > 默认目录（含 worker 写的 `state-dir-pointer`）；
token 的优先级是 `--token` > `$ORCA_SUPERAGENT_TOKEN_FILE` > `<stateDir>/api-token`
（解析规则见 `src/worker/cli/target.ts`）。

```sh
node "<plugin-root>/src/bin/superagent.mjs" status --json
# 显式指定状态目录（不依赖指针文件与环境变量）：
node "<plugin-root>/src/bin/superagent.mjs" status --json --state-dir "<stateDir>"
```

`--json` 在成功时把完整读数打到 stdout；失败时 stdout 仍是 JSON 信封、stderr 一行
`error: <code>: <message>`，退出码是上表的 1/2/3。读数里 `health` 的每个条目都带
`state`（`starting|ready|paused|error`）与 `detail`，`setup.problem` 说明等 setup 的原因。

## 用 Orca Automation 定时跑（示例）

`orca automations create` 的 `--precheck` 语义是「退出 0 才继续」；我们要的是
「`status` 非 0 才继续」，所以 precheck 里把判断反过来：

```sh
orca automations create \
  --name "Superagent hourly check" \
  --trigger hourly \
  --provider pi \
  --precheck 'sh -c "node \"<plugin-root>/src/bin/superagent.mjs\" status --json >/dev/null; test $? -ne 0"' \
  --prompt 'Run `node "<plugin-root>/src/bin/superagent.mjs" status --json`. If it exits 0, reply with one line: superagent ok. Otherwise read the `health` entries whose state is `error` and the `setup.problem` field, then tell the operator which part is broken and what needs a person. Do not pause, restart or repair anything yourself.'
```

- `--trigger hourly` 就是小时级；也可以给 5 段 cron 或 RRULE（`orca automations create --help`）。
- precheck 让健康的小时**不启动** agent 会话，只有非 0 时才叫醒它去通知人；`orca automations run`
  会绕过 precheck，方便手动验证一次。
- Automation 的 provider 选你机器上已装好的 agent（示例是 `pi`）；它只负责「读退出码并通知」，
  不做任何修复动作。

## 不建议做的事

- 不要在巡检里自动暂停、恢复或重启插件：这些动作会改变用户可见的处理状态，应该由人在面板或
  命令面板里做（`superagent.pause` / `superagent.resume` 仍在命令面板里）。
- 不要把 `status` 的 `1/2/3` 折叠成一个「坏了」：`3` 是「等 setup 或已暂停」，重启或重试都不会
  修，先看 `setup.problem` 与 `paused` 字段。

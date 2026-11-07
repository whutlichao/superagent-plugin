# superagent-plugin

把 DSH superagent 的工作流（来源 → 触发 → 工单 → Orca worker → 报告 → 回到原会话）重新实现在 Orca 自己的原语上的插件。面板只显示需要人处理的东西。

插件是 `trusted-worker` 形态：一个组件面板、四个贡献命令、三个订阅事件、一个启动前钩子、四个宿主设置项、一个状态栏项、十项能力（§N.2）。所有接触 Orca 的代码都收敛在唯一的运行缝 `src/worker/runtime/orca-runtime.ts`（§B）。仓库当前处于骨架票的状态：清单、手写 Orca 类型声明、自包含 TypeScript 配置、运行缝接口与错误码、宿主方法清单与四道门禁已就位；领域、执行器、Router、面板七页与 CLI 由后续票落地。

## 门禁

```sh
scripts/check.sh          # 四道门禁，按序执行
npx tsc -p .              # 自包含类型检查（不依赖任何 Orca 生成文件）
orca plugin test . --json # 插件内全部 *.test.ts(x)
orca plugin check . --json
orca plugin validate . --json
```

Orca 1.4.251 上 `orca plugin types .` 与 `orca plugin create` 因应用包缺 `resources/plugins/declarative/orca.d.ts` 而失败（§N.3）。`scripts/check.sh` 把它记为「已知缺陷，忽略」并打印复核语句，而不是让门禁失败；上面三条宿主命令仍是权威。

## 目录

```text
orca-plugin.json        清单（trusted-worker）
tsconfig.json           自包含；绝不 extends .orca/types
types/                  手写的最小 Orca 声明（pinned to Orca 1.4.251）
src/worker/main.ts      activate(orca)：登记贡献点 + boot 桩
src/worker/runtime/     唯一接触 Orca 的目录（§B）
tests/                  *.test.ts，由 `orca plugin test .` 执行
scripts/check.sh        四道门禁，按序执行
```

## 许可证与归属

MIT；见 `LICENSE`。

> Ported from `deepseek-ai/dsh-superagent-prototype` (MIT, Copyright DeepSeek), commit `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`. The Orca adaptation changes the host integration; the domain rules, prompts and documents are derived from that prototype.

## 已知限制（摘要）

十一项只能近似的能力。完整说明见设计文档的 §A.3、§H 差异表与附录 B；面板 Deployment 页的
Limitations 段与本节读同一份文案（同源同措辞）。

1. **Session preset 的工具裁剪** —— Worker 与 Router 都是普通 Orca agent 会话，工具集不可裁剪：「Router 不读代码」只由提示词约束，Router 理论上仍能改代码；worker 可用的工具也与上游的 WORK_TOOLS 不完全相同（H.1、H.19）。
2. **系统提示词在 launch 时一次性注入** —— 运行中的会话不会自动看到新的 Policy 段；变更只用消息告知 revision 与读法，全文对新会话才完整生效（H.2）。
3. **看不到 agent 内部的后台工作与 30 分钟预算** —— 30 分钟规则退化为「发收尾指令并标记过期」，不杀进程：长任务可能继续占着 slot，也可能被误判为过期（H.3）。
4. **模型预算重试由 Orca 负责** —— 插件只做三次 launch 重试；看不到预算重试状态，provider 抖动时工单可能直接失败；models 健康项恒为就绪并写明「由 Orca 负责」（H.4）。
5. **没有 DSH Plugin Manager 页面** —— 少量项在 Orca 设置里改，其余在面板的 Settings → Deployment 组；两处不重复（H.5）。
6. **没有 DSH 的 Web 面板与端口** —— 面板只在 Orca 客户端里打开，没有可跨设备访问的 URL（H.6；视为改进）。
7. **生命周期归 Orca，没有服务脚本与 tmux** —— 没有 start/stop 命令，也没有 tmux 会话；「停」用 paused 表达，读数用 superagent status 的 0/1/2/3 退出码（H.7）。
8. **Skills 不是宿主注册表** —— 内置 skills 写到 <stateDir>/skills/<name>/SKILL.md，提示词只给绝对路径；agent 可能不读（H.8）。
9. **没有 dsh CLI 与 profile** —— 用 superagent CLI 与 orca CLI 顶上；没有 profile、没有 --from-default-profile，安装步骤与上游完全不同（H.9）。
10. **无法移除 worker 的提问工具** —— worker 可能在自己的终端里等人，而不是用 report --human-action；插件把 blocked 状态当作 Attention 兜住，但问题文本只是终端摘要（H.10）。
11. **进程隔离与执行环境注入只是近似** —— blocked commands 与账号 shim 依赖 agent.launch.before 钩子（2 秒、失败即放行），不是安全边界；worker 的 git 配置是最小副本（凭据 helper、SSH→HTTPS、提交身份），http.*、LFS 等其余全局项只剩系统级配置；插件不做进程隔离，建议专用 OS 账号（H.11、H.20）。

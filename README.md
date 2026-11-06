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

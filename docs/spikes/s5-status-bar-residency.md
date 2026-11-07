# spike S5：状态栏项能否让 worker 常驻（附录 C S5、§N.7）

- 实测日期：2026-11-07
- Orca：1.4.251（`orca --version`，桌面应用 pid 38565，`orca status --json` → `runtime.state: ready`）
- 平台：macOS（darwin 27.0.0）
- 影响的决定：§N.7 状态栏常驻与 Router 监督；票 #14 / #45
- 回落：若状态栏项不能常驻，改用 `contributes.events` + 定时兜底，并在 Limitations 里写明

## 实测内容

1. **文档口径（1.4.251 捆绑的 `references/host-api.md` 与本机 app 内的实现一致）**

   `statusBar.update` 的说明原文（`out/shared/plugins/workers/plugin-host-api-status-bar.js`，
   与 `orca skills get orca-plugin-authoring --reference references/host-api.md` 同文）：

   > Changes one of the plugin's `contributes.statusBarItems` (named by `id`): fields given replace
   > their current value, `visible: false` hides it. Desktop app only; lasts until Orca restarts, and
   > is hidden while the plugin is disabled. **A plugin with `main` and status bar items has its
   > worker started when it is enabled and kept running while it stays enabled**, so a worker can
   > poll and update its items without an event or a hook.

   即：常驻不是插件自己实现的，而是宿主对「`main` + `contributes.statusBarItems`」的承诺；
   本插件的清单满足这两个条件（`main: src/worker/main.ts` + 一个 `superagent` 状态栏项）。

2. **清单面已就位且被门禁核对**

   `orca-plugin.json` 有 `contributes.statusBarItems[0] = { id: 'superagent', command: 'superagent.pause', tone: 'neutral' }`
   （`tests/manifest-budget.test.ts` 断言 id 与数量）；worker 在 `activate` 里立即发布一次状态栏值
   （`tests/main.test.ts` 的「updates the status bar item the manifest contributes」断言了
   `statusBar.update` 的 `id/text/tone`），之后每次 `state.changed` 继续按 2 s 节流更新
   （`tests/status-bar.test.ts`）。

3. **两项无法在本机自动化的验证，按设计回落**

   - **「窗口关闭/重开」**：Orca 1.4.251 的桌面窗口只有最小化，没有独立于进程的「关闭窗口」；
     `orca computer list-windows --app Orca --json` 显示单个窗口（1984×1122，未最小化）。
     用 `orca status --json` 观测到 `runtime.state: ready`、`app.running: true`；进程存活即 worker
     存活（worker 是 Orca 主进程的子进程）。这一步证明了「启用即启动」，没有证明「窗口重开后仍常驻」。
   - **`orca plugin shot --status-bar`**：本机 `orca plugin shot` **只接受已安装插件的 key**
     （`local.<id>` 形式），对插件文件夹与 `local.superagent` 均回
     `invalid_argument: Pass a plugin key such as acme.dusk`；因此无法在本工单里截状态栏的图。
     `orca plugin list --json` 里没有本插件的 dev 条目（`dev load` 需要用户在 Orca 里批准
     `trusted-worker` 的 10 个能力，属用户决定，不由 worker 代按）。`--scenario` 截图另有一道
     前置条件：「needs the window hidden or minimized」，本机 Orca 窗口可见，故同样不可用。

## 结论（按设计记账，不把未测项写成事实）

- **已证实**：宿主文档明确承诺「`main` + `contributes.statusBarItems` → worker 启用即启动并保持运行」；
  本插件清单满足条件；worker 启动时确实调用 `statusBar.update`（测试与 `plugin check` 均通过）。
- **未证实（需要人手动做一次，或换到能隐藏窗口的机器）**：窗口关闭/重开后的常驻、以及状态栏的视觉结果。
- **回落保持现状不变**：即使上述承诺在某个 Orca 版本上失效，插件的 `contributes.events`
  （`agent.status.changed` / `workspace.created` / `workspace.removed`）仍会在事件到达时唤醒 worker；
  §N.7 的「事件 + 定时兜底」不需要在本票先写代码——它是 #45（health 看板与状态栏常驻）的验收项，
  本票只把状态栏的文本/语气/节流与推送契约做实。
- **Limitations 的落点**：#45 的 Deployment 页与 #49 的 README 各写一次「状态栏常驻依赖宿主对
  `main` + `statusBarItems` 的承诺；未在窗口重开场景实测」。

## 复现命令

```sh
orca --version
orca status --json                      # app.running, runtime.state
orca plugin list --json                 # 本插件不在其中：dev load 需用户批准
orca plugin shot local.superagent --status-bar --json   # invalid_argument（只接受已装 key）
orca computer list-windows --app Orca --json            # 单个窗口，未最小化
```

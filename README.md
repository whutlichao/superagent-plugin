# superagent-plugin

把 DSH superagent 的工作流（来源 → 触发 → 工单 → Orca worker → 报告 → 回到原会话）重新实现在 Orca 自己的原语上的插件。面板只显示需要人处理的东西。

这份 README 是给新操作者看的：装上一个插件、填四项宿主设置、走完一次 setup 检查，然后知道出了问题先看哪里。技术设计在 [`docs/design/orca-superagent.md`](docs/design/orca-superagent.md)，两者冲突时以设计文档为准。

## 形态：一个插件、一个面板、一个 CLI

一个 `trusted-worker` 形态的 Orca 插件（`orca-plugin.json`）：

- **一个组件面板** `Superagent`：七个导航项（Overview / Source / Trigger / Eval / Execution / Settings / Search），术语表是页头 `(?)` 打开的覆盖层。面板只显示需要人处理的东西。
- **一个 CLI** `src/bin/superagent.mjs`：agent 与运维都用它，一律 `node "<绝对路径>" …` 起（不依赖 shebang 与执行位）。它经 loopback HTTP 调常驻 worker，是独立进程与常驻进程之间的唯一契约。
- **四个贡献命令**：`superagent.pause` / `resume` / `restartRouter` / `checkSetup`（面板与命令面板的入口；`pause` / `resume` / `setup check` 在 CLI 里同名可跑）。
- **三个订阅事件**（`agent.status.changed`、`workspace.created`、`workspace.removed`）、**一个钩子**（`agent.launch.before`，`onError: pass`）、**一个状态栏项**、**十项能力**。
- **一个运行缝**：所有接触 Orca 的代码都在 `src/worker/runtime/`（§B）。其余模块只依赖 `OrcaRuntime` 接口与领域端口，`runtime-seam.test.ts` / `dependency.test.ts` 守着这条线。

状态栏文本是 `Superagent` / `Superagent 3`（待人工数）/ `Superagent paused` / `Superagent error`，工具提示给分项计数。暂停与恢复走命令面板里的四个贡献命令或 CLI（`superagent pause` / `resume`）。插件启用即启动 worker 并保持常驻，禁用/卸载即停——生命周期归 Orca，没有 start/stop 命令（H.7）。

## 安装

### 0. 前置条件

| 需要 | 版本 / 形态 | 用来做什么 |
| --- | --- | --- |
| Orca | ≥ 1.4.250（实测 1.4.251） | 宿主：面板、worker、worktree、agent 会话 |
| Node | Orca 自带（实测 Node 25；插件要求 ≥ 22.18 的类型剥离） | 跑 worker 与 CLI，不需要单独安装 |
| `gh` | ≥ 2.48（可以是指向 agent 账号的包装脚本） | GitHub 来源的全部读写 |
| `git` | ≥ 2.32 | worker 在自己的 worktree 里提交/推送 |
| `lark-cli` | 可选，**必须 bot-only** | Feishu 来源；可充当用户身份的配置会被 setup 拒绝 |
| 一个 base repo | Orca 里已注册（`orca repo list --json`） | 每个工单的 worktree 从这里建 |

凭据不需要交给插件：GitHub token 留在 `gh`，Feishu app secret 留在 `lark-cli`。插件不存 GitHub token、不存 Feishu app secret；它自己的 loopback API token 是另一回事，生成在 `<stateDir>/api-token`（0600）。

### 1. 安装前先看清它要什么：`inspect`，不是 `validate`

```sh
orca plugin inspect . --json      # 校验 + 按「安装的方式」给文件算哈希；打印十项能力与内容哈希
```

`inspect` 就是安装探针。`orca plugin validate . --json` 只校验清单与清单点名的文件，**它通过不代表能装**（下面第 3 步有实测）。审批面是下面这十项能力，清单里没有请求别的（不请求 `appearance:write`）：

1. `workspace:read` —— 读当前工作区的名字/分支/终端列表，收到工作区创建与移除
2. `workspace:write` —— 在 Orca 里打开工作区与文件、运行内置命令
3. `agent:read` —— 收到 agent 状态变化
4. `agent:launch` —— 在工作区里启动 agent（本地与 SSH）
5. `terminal:send` —— 在终端里输入并运行命令（本地与 SSH）
6. `terminal:read` —— 读终端输出（本地与 SSH）
7. `notifications:show` —— 显示带插件名的桌面通知
8. `storage:own` —— 在插件自己的 storage 目录存数据
9. `secrets:own` —— 在插件自己的加密文件里存取 secret
10. `settings:own` —— 读写插件自己的设置

执行形态是 `trusted-worker`：它会在 Orca 主机上以你的用户账号跑自己的 Node 进程。

### 2. 开发安装：加载 → 审批 → 启用

现在没有发布目录，走开发文件夹（Development folders）：

```sh
# 1) 加载；未审批时退出码 3，error.code = approval_required，打印指纹 ap1-…
orca plugin dev load . --json

# 2) 用上一步打印的指纹审批（指纹绑定插件、版本、文件与访问面；内容或能力变了要新指纹）
orca plugin dev load . --approve ap1-…

# 3) 看它活没活：status 是 running / idle / pending / errored / invalid
orca plugin list --json
orca plugin logs local.superagent
orca plugin restart local.superagent      # 停 worker，下次命令/事件重新起
orca plugin disable local.superagent
```

也可以在 Orca 的 Settings → Plugins 里启用/审批同一个插件（`orca plugin enable local.superagent --approve ap1-…`）。插件跑起来后，Orca 的侧边栏出现 `Superagent` 面板与状态栏项。

### 3. 开发安装的陷阱：插件根不能有多余条目（实测）

Orca 的 setup 钩子会在插件根（也就是仓库/worktree 根）创建 `.codegraph/`（含 `daemon.sock`）；开发时 `npm ci` 又会留下 `node_modules/`（`node_modules/.bin/tsc` 是指向上一级目录的符号链接）。`inspect` 与安装路径会扫描插件根下的每个条目，这两样都会被当成「不支持的插件条目」，于是安装失败——而 `validate` 照样通过，看起来毫无问题。

实测（Orca 1.4.251，同一份工作树，逐个状态）：

| 插件根状态 | `orca plugin validate . --json` | `orca plugin inspect . --json` | `orca plugin dev load . --json`（未审批） |
| --- | --- | --- | --- |
| `.codegraph/daemon.sock` 存在 | exit 0，`valid: true` | exit 2，`plugin_invalid`：`unsupported plugin entry type: .codegraph/daemon.sock` | exit 3，`approval_required` |
| `npm ci` 之后（`node_modules/` 在） | exit 0，`valid: true` | exit 2，`plugin_invalid`：`symlink not allowed in plugin content: node_modules/.bin/tsc` | exit 3，`approval_required` |
| 两者都清掉 | exit 0，`valid: true` | exit 0，`valid: true`（打印十项能力与内容哈希） | exit 3，`approval_required` + 安装指纹 `ap1-…` |

读法与做法：

- **`dev load` 未审批时永远先要审批**（exit 3 `approval_required`），它不会告诉你安装扫描过不过。判断「能不能装」看 `inspect`，不要看 `validate`，也不要只看 `dev load` 的退出码。
- 例行步骤：**装之前清一次插件根**

  ```sh
  rm -rf .codegraph node_modules     # 或换成干净副本，把 .codegraph/.git/node_modules 排除掉
  ```

  `.codegraph/` 已进 `.gitignore`，不会提交；但 setup 钩子会重建它，所以「跑完测试/门禁 → 再安装」之间要重新清。`node_modules/` 只在跑 `npx tsc -p .` 与 `scripts/check.sh` 时需要（`npm ci`），装完再装回来即可。
- 干净副本的例子：`/Users/apple/orca-dev/superagent`（排除 `.codegraph/.git/node_modules` 的副本，`inspect` exit 0）。`dev load` 的说明写明开发文件夹会覆盖同 key 的已安装插件，所以并行验证时让每份副本用不同的清单 `id`。

### 4. 四个宿主设置（Orca Settings → Superagent）

只有决定「能不能开工」的四项进宿主设置，其余全在面板 Settings 的五个组里（Sources / Eval / Execution / Prompts / Deployment），存库即生效（`stateDir` 除外）：

| key | 标题 | 缺省 | 说明 |
| --- | --- | --- | --- |
| `stateDir` | State directory | 空 | 数据库、日志、token、备份的绝对路径。改动需重启插件（H.12） |
| `agent` | Worker agent | `pi` | 每个工单 worker 用的 Orca agent id |
| `routerAgent` | Router agent | `pi` | 常驻 Router 会话用的 Orca agent id |
| `baseRepo` | Base repository | 空 | 建工单 worktree 的仓库选择器：`path:<路径>` / `name:<名字>` / `id:<id>` |

两个 agent 设置的默认值在清单与 `src/worker/app/agent-defaults.ts` 两处都写 `pi`，必须同值（`agent-defaults.test.ts` 断言）；你在 Orca Settings 里随时可覆盖。其余设置（模型、并发、`prepare`、blocked commands、CLI 路径、端口、保留策略、四个机器限额）在面板里改。

### 5. 首次运行：最小可用配置走查

1. **准备 base repo**：`orca repo list --json`，确认要托管工单的仓库在里面；拿到它的 `path:`/`name:`/`id:` 写法。
2. **用 agent 账号登录 `gh`**：`gh auth login`（或把 Source 的 CLI 指到 agent 账号的包装脚本，例如 `gh-agent`）。`gh api user --jq .login` 能读出账号名才算好。
3. **填四项设置**：`stateDir` 必须是绝对路径且可写；`agent` / `routerAgent` 填已安装的 Orca agent id；`baseRepo` 填第 1 步的写法。
4. **启用插件**（第 2 步的 `dev load --approve`，或 Settings → Plugins）。状态栏出现 `Superagent`。
5. **打开面板 → Deployment 页**，看 setup 问题列表：每条都写「缺配置（missing）」还是「读不通（broken）」，附一句修法与重跑入口。修一条、点一次「检查一次」（= `superagent setup check`）。setup 干净之前，受影响的来源停在 `starting`，不轮询、不报 `error`。
6. **配来源**：Source 页填 GitHub 的 `repository`（`owner/name`）与 `cli`（`gh` 或 agent 包装脚本）。Feishu 可选：只接受 bot-only 的 `lark-cli` 配置。
7. **跑一次诊断**：`superagent doctor`（本机有没有 token/端口/锁/库/CLI/worker git 配置/两个登录），它只报「有没有」，不报「是什么」。
8. **看一眼读数**：`superagent status --json`，退出码见下面的故障排查表。此后面板 Overview 与状态栏用同一份数据。

worker 的提交身份（`<stateDir>/worker-gitconfig`）由启动与 `superagent setup check` 写入：只含 GitHub 凭据 helper、`git@github.com:` → `https://` 与提交身份三组键，身份不全时不写、不注入（H.11）。要它生效，面板 Execution 组里配好 agent 账号与其 noreply 提交邮箱。

## 状态目录

优先级：设置 `stateDir` ＞ `$ORCA_SUPERAGENT_STATE_DIR` ＞ 默认 `${XDG_STATE_HOME:-$HOME/.local/state}/orca-superagent`（CLI 还会读 `<默认>/state-dir-pointer`，所以改过设置也能找到）。布局（§D.5）：

```text
<stateDir>/
├── superagent.sqlite (+ -wal, -shm)   唯一真源
├── lock                               pid + 起始时间；每 5 s 触碰 mtime（单实例）
├── api-port                           实际监听的端口（缺省 3847，占用则 +1 试到 +20）
├── api-token                          主 token（32 字节，0600）
├── tokens/<assignmentId>              每 Assignment 的 token，Assignment 结束即删
├── tokens/router                      Router token，重启轮换
├── inbox/<ticket>/<n>.md              投递给 worker 的长文本
├── relay/<n>.md                       投递给 Router 的长文本
├── prompts/defaults.json              内置提示词快照（面板 diff 用）
├── skills/<name>/SKILL.md             内置 skills 的落盘副本（面板可编辑）
├── bin/                               PATH 注入用的包装脚本（blocked commands 的 shim）
├── worker-gitconfig                   worker 的最小 git 配置（0600）
├── logs/worker-<YYYYMMDD>.log         JSON 行日志，保留 10 个
└── backups/                           迁移前备份，保留 5 份
```

升级时先备份再迁移；库版本高于插件版本会**拒绝启动**（`database schema <n> is newer than this plugin (<m>)`），不带着半迁移的库跑。

## 日常操作（CLI）

CLI 一律 `node` 起绝对路径（路径里有空格要双引号），输出默认是 JSON 信封，`--text` 给人读：

```sh
node "<plugin-root>/src/bin/superagent.mjs" status --json
node "<plugin-root>/src/bin/superagent.mjs" status --json --state-dir "<stateDir>"
node "<plugin-root>/src/bin/superagent.mjs" doctor
```

stateDir 解析顺序 `--state-dir` ＞ `$ORCA_SUPERAGENT_STATE_DIR` ＞ 默认目录（含指针文件）；token 解析顺序 `--token` ＞ `$ORCA_SUPERAGENT_TOKEN_FILE` ＞ `<stateDir>/api-token`（worker 的 prompt 只给 token **文件路径**，不给值）。

| 命令 | 用途 |
| --- | --- |
| `superagent status [--json]` | 进程/库/HTTP/loop、每个 health 条目、setup 问题、`paused`、负载；退出码 0/1/2/3 |
| `superagent health` | 只打 health 数组 |
| `superagent pause` / `resume` | 暂停/恢复处理（写设置里的 `paused`，origin=`operator`） |
| `superagent setup check` | 重跑 setup（会重启 worker 内的 loops，不重启 Orca）；已经没有 setup 问题时**拒绝**（`nothing_to_check`，exit 2） |
| `superagent doctor` | 本机诊断八项，逐项 `ok`/`warn`/`fail`；有 `fail` 退出 1，否则 0 |
| `superagent admin backup` | 立即备份（升级前手工调用） |
| `superagent admin rotate-token` | 轮换主 token（破坏性，要 `--yes`；面板里要二次确认） |
| `superagent source labels <id>` | 刷新来源的显示名 |

Router 与 worker 用的命令（`route`、`eval`、`eval-read`、`eval-decide`、`report`、`reply`、`ack`、`ticket …`、`trigger …`、`thread …`、`settings …`、`prompts …`、`read …`）在命令表里占住最终名字与参数，逐条见设计 §G.2；任何还没有 handler 的命令都返回固定 `unavailable`（exit 3），不会静默成功。它们的角色由 token 决定，越权是固定拒绝 `not_permitted_role`（exit 2）。

## 门禁

```sh
scripts/check.sh          # 四道门禁按序执行，全绿才退出 0
npx tsc -p .              # 自包含类型检查（不依赖任何 Orca 生成文件）
orca plugin test . --json # 插件内全部 *.test.ts(x)（截至 #64 合并的实测快照：89 个文件、1576 条测试、fail 0）
orca plugin check . --json
orca plugin validate . --json
```

`scripts/check.sh` 依次跑后四条，并先对 `orca plugin types . --json` 探一次（§N.3）。版本口径分两段，别混读：

- **当前（Orca 1.4.253，本机实测）**：`orca plugin types .` 与 `orca plugin create <dir> --template worker-panel` 都通过（退出 0；前者写出 `.orca/types`）。所以探针会真的跑一次基于生成类型的额外类型检查。
- **历史（Orca 1.4.251 实测，不是现状）**：那时候应用包缺 `resources/plugins/declarative/orca.d.ts`，两条命令都报同一个 `ENOENT`。这段记录留着解释「为什么仓库自带手写声明」，不代表今天仍坏。

```text
ENOENT: no such file or directory, open
'/Applications/Orca.app/Contents/Resources/app.asar.unpacked/resources/plugins/declarative/orca.d.ts'
```

探针**不参与退出码**，两个方向都是：成功时那次额外类型检查标为 informational——生成类型与仓库手写声明目前不一致（`tsc` 报出多条真实差异），让它变红没有意义；失败时记为「已知缺陷，忽略」并打印复核语句。退出码只由四道基线门禁决定，而 `npx tsc -p .` 不依赖 `.orca/types`。

变通（设计强制，已在仓库里，与探针成功与否无关）：`types/orca.d.ts`、`orca-worker.d.ts`、`orca-testing.d.ts` 是手写的最小声明（只声明插件实际用到的 API，标注「pinned to Orca 1.4.251 references」）；`tsconfig.json` 自包含，**不** `extends ./.orca/types/tsconfig.json`。所以缺 `orca.d.ts` 的机器上 `npx tsc -p .` 也能过，权威门禁仍是 Orca 自己的三条命令。对齐生成类型（迁到宿主类型面）是独立决定，单独立项；`create` 生成的模板与本仓库结构本就不同，只作提示，不要求逐文件对齐。复查探针：

```sh
orca plugin types . --json && ls .orca/types
```

**没有 CI**：`no checks, repo has no workflows`——仓库没有 GitHub Actions，本票只改文档、也不新增。门禁只能在本机跑（`orca plugin test/check` 需要本机 Orca）。纯 Node 的测试可以直接跑，例如 `node --test tests/schema.test.ts`；凡是要 Orca 提供 `orca` / `orca/worker` 解析的测试（如 `tests/host-runtime.test.ts`）只能在 `orca plugin test` 下跑。

## 故障排查

先分清两件事：`doctor` 是**本机诊断**（有没有、坏没坏，只报存在性）；**setup 检查**才决定插件现在能不能开工。两条命令不同源，别混看。

`superagent doctor` 的三档结论：

| 状态 | 含义 | 脚本怎么判 |
| --- | --- | --- |
| `ok` | 这一项就绪 | 不影响退出码 |
| `warn` | 可选项没配（例如没配 Feishu 的 `lark-cli`） | **不算失败**，退出码仍可是 0 |
| `fail` | 有东西缺了或坏了（token 缺失、库迁移失败、CLI 路径不对…） | 有任何一个 `fail` → 退出 1 |

`superagent status` 的四个退出码（与面板 Overview、状态栏同一份读数）：

| 退出码 | 含义 | 重启能修吗 |
| --- | --- | --- |
| `0` | 正常运行 | — |
| `1` | `runtime` 不是 ready/paused（`starting` 也算没跑起来）或它报错；「跑了两份」归这一档 | 通常可以 |
| `2` | 某个**非 runtime** 部件报错（例如 `github`、`relay`、`router`） | 不能，要人看 |
| `3` | 等 setup / 已暂停 / **连不上 worker**（未启动、端口没人听） | 不能，要人补配置或恢复 |

常见几件：

- **插件装不上，`inspect` 报 `plugin_invalid`**：插件根有多余条目。看第 3 步——清 `.codegraph/`（含 `daemon.sock`）与 `node_modules/`，或换一份干净副本。
- **`dev load` 一直 exit 3**：先看是不是 `approval_required`（正常，需要 `--approve <指纹>`）；指纹过期（改了代码或能力）也会重新要审批。
- **状态栏显示 `Superagent error`**：打开面板 → Deployment，看 health 明细里哪个部件是 `error`；`superagent doctor` 再分「没配」与「坏了」。
- **`superagent setup check` 拒绝**：说明 setup 已经没有问题（`nothing_to_check`），没必要重跑。
- **CLI 连不上**：先 `cat "<stateDir>/api-port"`，再 `superagent doctor`（端口、锁、token 三项）。HTTP 只 bind `127.0.0.1`，不跨设备。
- **日志**：`<stateDir>/logs/worker-<YYYYMMDD>.log`（JSON 行，保留 10 个）与 `orca plugin logs local.superagent`。日志里不会有 token、secret 或消息正文。

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

这一节是**近似**的清单，不是已实现功能的清单：没有 DSH 的机制就是没有，替换物如上所述。

计数口径只有一处：这十一项就是用户可见的完整列表，单一来源是 `src/panel/limitations.ts`（面板
Deployment 页的 Limitations 段与本节读同一份文案，中英各一份，顺序也由它给）。设计文档 §A.3 列的
同样是这十一项；§H 差异表标「是」的 15 行里，H.19 并入第 1 项、H.20 并入第 11 项，剩下 4 行
（H.14 relay 的送达时机、H.15 宿主工具面、H.16 没有权威模型清单、H.17 Feishu 图片）是精度与能力面
的附加近似，列在设计附录 B 的第二张表并注明披露位置，**不**扩成第 12–15 项。

## 目录

```text
orca-plugin.json        清单（trusted-worker）
tsconfig.json           自包含；绝不 extends .orca/types
types/                  手写的最小 Orca 声明（pinned to Orca 1.4.251）
docs/design/            技术设计（唯一的设计文档）
docs/adding-a-source.md  新增一个 Source 的十一步指南（§I.1 的工程说明）
docs/spikes/            实测记录（附录 C 的 spike 台账）
docs/hourly-check.md    可选的小时级巡检（Orca Automation）
src/worker/main.ts      activate(orca)：登记贡献点 + boot
src/worker/runtime/     唯一接触 Orca 的目录（§B）
src/worker/{core,policy,sources,executor,router,app,http,cli,infra}/  领域与实现
src/panel/              components 面板（七页 + 覆盖层）
src/bin/superagent.mjs  CLI 的唯一可执行入口
tests/                  *.test.ts(x)，由 `orca plugin test .` 执行；support/ 是夹具
scripts/check.sh        四道门禁，按序执行
```

## 许可证与归属

MIT；上游的 MIT 文本原样保留在 [`LICENSE`](LICENSE)，`orca-plugin.json` 的 `license` 也是 `MIT`。上游是 `deepseek-ai/dsh-superagent-prototype`（MIT，Copyright DeepSeek），本移植固定的 commit 是 `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`。attribution 句与设计附录 A 逐字一致：

> Ported from `deepseek-ai/dsh-superagent-prototype` (MIT, Copyright DeepSeek), commit `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`. The Orca adaptation changes the host integration; the domain rules, prompts and documents are derived from that prototype.

不复制上游 `src/**` 代码：领域规则按「同一规则、Orca 原生实现」重写。上游 `prompts/*.md` 与 `skills/**/SKILL.md` 的等价文本保留在 `src/worker/app/prompt-text/` 与 `app/skills.ts`，文件头注释写明来源与许可。

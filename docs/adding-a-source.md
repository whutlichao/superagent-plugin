# 新增一个 Source：十二步

这份文档回答一件事：**在这个仓库里加一个新的 Source kind，要动哪些文件、写哪些测试、守哪些缝。**
它是 §R.1 里上游 `docs/008` 的落点，也是 §I.1 那张 `SourceKind` 协议的工程说明——协议本身在
`src/worker/sources/kind.ts`，本文不重复抄接口，只讲「怎么落地」与「哪里会红」。

先读三处，再动手：

1. [`docs/design/orca-superagent.md`](design/orca-superagent.md) 的 §I.1（kind 协议与 `SourceContext`）、
   §K.1/§K.2（Policy 与 Gate 怎么用 Source 给的准入行）、§N.4（health 条目）。
2. `src/worker/sources/kind.ts`（契约与全部值形状）与 `src/worker/sources/registry.ts`（注册表：
   实例解析、配置校验、Policy 部分、health 归属）。
3. 一个现成的 kind：`src/worker/sources/github/`（通知轮询 + Channel 幂等 + 评审线程）或
   `src/worker/sources/feishu/`（事件流 + 回填 + 图片）。**新 kind 应当长得像它们**：一个
   `index.ts` 出口，`config.ts` 放 schema，`translate.ts` 放「原生事件 → Trigger」，`poll.ts`
   放轮询/事件流，`read.ts` 放读面，`kind.ts` 只把上面这些接成协议。

两个概念先分清（上游同）：**kind 是代码**（`github` / `feishu` / …，全局唯一），**实例是配置**
（一条设置里的 `{enabled, config}`，`id` 就是 kind 名）。一个 kind 可以没有实例（默认实例仍然
存在，配置取 schema 默认值）；实例的配置校验失败时，实例被**禁用**并把原因放进 `configError`，
不会带着半份配置跑。

---

## 十二步一览

| # | 步骤 | 落在哪 | 谁替你检查 |
| --- | --- | --- | --- |
| 1 | kind 与配置 schema | `sources/<kind>/config.ts`、`sources/<kind>/kind.ts` | `registry.test.ts`、`kind.test.ts`、`schema.test.ts` |
| 2 | `fields`：设置表单 | `sources/<kind>/kind.ts` | `registry.test.ts`、面板 `panel-source.test.tsx` |
| 3 | `facts(deployment)`：账号与仓库 | `sources/<kind>/kind.ts` + setup 探针 | `deployment.test.ts` |
| 4 | `health` 条目 | `sources/<kind>/kind.ts` + §N.4 的表 | `health.test.ts`、`health-states.test.ts` |
| 5 | `scope`：监听范围与准入行 | `sources/<kind>/kind.ts` | `policy.test.ts`、`registry.test.ts`、`sources-<kind>.test.ts` |
| 6 | `channel`：写回 | `sources/<kind>/channel.ts`（或 `kind.ts`） | `commands.test.ts`、`outbox.test.ts`、`sources-<kind>.test.ts` |
| 7 | `threadContext`：评估语境与图片 | `sources/<kind>/read.ts`、`admission-context.ts` | `admission-context.test.ts`、`feishu-read.test.ts` 类 |
| 8 | `find`：搜索 | `sources/<kind>/read.ts` | `read-views.test.ts`、`sources-<kind>.test.ts` |
| 9 | `policy` 部分：准入行、bots、sync | `sources/<kind>/kind.ts` + `policy/admission.ts` | `policy.test.ts`、`settings.test.ts` |
| 10 | `environment`：执行环境变量 | `sources/<kind>/kind.ts` + `sources/<kind>/environment` 段 | `environment.test.ts`、`model-surface.test.ts` |
| 11 | 夹具与测试：`FakeCommands` + `.expected.json` | `tests/support/fake-commands.ts`、`tests/fixtures/cli/<kind>/` | `fixtures.test.ts`、`sources-<kind>.test.ts` |
| 12 | 资源名：`ParsedResource` 联合与 `READ_SOURCE_RESOURCES` | `src/worker/app/read.ts` | `read-surface.test.ts`、`read-views.test.ts`、`cli-contract.test.ts` |

下面逐步说。最后三节讲**注册**（registry + boot）、**`SourceContext` 能用什么**、**必须守的缝**。

---

## 1. kind 与配置 schema

```ts
// src/worker/sources/<kind>/config.ts
import { array, boolean, enumOf, number, object, string } from '../../infra/schema.ts'

export type ExampleConfig = {
  readonly cli: string
  readonly repository: string
  readonly rooms: readonly { readonly id: string; readonly listen: 'mentions' | 'all' }[]
  readonly pollSeconds: number
}

/** 每个字段自己给默认值；`.strict()` 让未知键成为错误（设置保存时逐条报路径）。 */
export const exampleConfigSchema = object({
  cli: string().trim().default('example-cli'),
  repository: string().trim().default(''),
  rooms: array(
    object({
      id: string().trim().regex(/^ex_[a-zA-Z0-9]+$/),
      listen: enumOf(['mentions', 'all'] as const)
    }).strict()
  ).default([]),
  pollSeconds: number().int().min(10).max(3600).default(60)
}).strict()
```

- 校验器是本仓自带的 `src/worker/infra/schema.ts`（零 npm 依赖）：`object/string/number/boolean/
  array/enumOf/union/record/literal` + `refine`，`safeParse` 返回带路径的 `issues`。两个容易记错的
  默认值：**`object()` 默认丢掉未知键，要拒它们必须写 `.strict()`**；原生数组/字符串/数字**没有**
  默认值，`.default(...)` 要显式写（`array(x)` 只吃一个参数）。**不要**引入 zod（§O 的供应链约束）。
- schema 的默认值就是「新实例」的配置；`registry.resolve()` 用它给缺失字段补值、也用它判断
  「这份存库配置还算不算数」（`configError` 时实例禁用）。
- 配置里出现的每个可变项都要有 `field`（第 2 步），否则面板改不了它。
- 账号与仓库这类**部署派生**的东西不进实例配置（它们在 `facts(deployment)` 与 setup 探针里，
  见第 3 步）。

## 2. `fields`：设置表单

`fields` 是数据，不是 JSX：面板按它生成控件（`src/panel/source-page.tsx`）。六种字段：
`switch`、`select`、`number`（带 `min`/`max`）、`text`（可带 `pattern`/`readonly`）、
`fact`（只读，值来自 `facts`）、`rows`（一列记录，按第一列作键）。

- 标签与提示都写双语文案（`{ zh, en }`），`locales.test.ts` 要求两边都有值。
- 每项可加 `advanced: true` 收进「Advanced」折叠区（端口、页大小、超时这类）。
- 表单字段的 `key` 必须与 schema 的键同名——面板与保存路径都按它读写。

## 3. `facts(deployment)`：部署派生的事实

`facts()` 返回只读的 `{ key, value }`，由 `type: 'fact'` 的字段显示（账号、仓库、bot 名）。
`key` 与字段的 `key` 对齐。它在 setup 没完成时返回空表（`{ repository: '' }` 之类），**不要编**。

这些值同时是执行环境变量的来源（第 10 步的 `values()` 从同一个 `Deployment` 取值），也是
`scope()` 判断「是不是我自己的消息」的依据。

## 4. `health` 条目

kind 在 `health` 里**声明并独占**它的条目；注册表替它 claim，重复 claim 直接抛，条目名也不能带
`sync:` 前缀（那是 settings 的族）。

- 条目名必须是 `src/worker/infra/health.ts` 的 `HEALTH_ENTRIES` 里的名字。**加一个新的固定条目
  要有三处一起改**：§N.4 的设计表、`HEALTH_ENTRIES`、`health.test.ts` 的 `DESIGN_ENTRIES`——
  那条测试就是为此存在的。
- 状态只有四档：`starting | ready | paused | error`（§J.3）。`warning` 不是条目状态，它是面板语气。
- 写的时候用 `ctx.report(name, { state, detail })`：`ready` 是唯一的「清除」路径；连续 3 次失败 →
  `error`；暂停不是成功，不清零计数。

## 5. `scope`：监听范围与准入行

```ts
scope(trigger, config): ScopeResult   // { listened: true, observed, row? } | { listened: false, reason }
```

- `listened`：这条 Trigger 是否进入系统。**不进**就存下并记 `filtered: { code: reason }`（面板
  Source 页能看到每条被过滤的 Trigger 与原因码），不产生候选。
- `observed`：这条是「观察到的」（receive-all 打开时的新 Issue / 新评论 / CI），而不是「点名给我」的。
  它是 `listened: true` 时的**必填**字段；不实现 `scope` 的 kind 由注册表按 `{ listened: true, observed: false }`
  处理（kind 没装且没存过配置时也一样）。
  Gate 用它与 `addressed` 一起决定强度（§K.2）。
- `row`：这条 Trigger 落在准入表的哪一行；不写就用表的默认行（§K.1）。**行 id 必须与你
  `policy.rows()` 声明的行同名**，否则准入表里的配置永远不生效。

`scope` 只做「这个来源的配置允许我看这条吗」的判断；**谁能发起工作**是 Gate 与 Policy 的事，
不要在 `scope` 里复刻（§K.2）。`Source` 自己的时间/去重（游标、指纹）也不要写进 `scope`。

## 6. `channel`：写回

```ts
channel: {
  allowed?(address, config): boolean        // 这个地址现在还能收到回复吗（实例关闭时置 false）
  send(host, message): Promise<'sent' | 'gone'>
  link?(address, links): { url, label }     // 面板里的链接；缺部署信息时 url 给空串
}
```

- 只有两类返回值：`sent` 与 `gone`。**能稍后重试的失败要抛错**（带 `CliError.code` 让调用方区分），
  不要用 `gone` 表达限流或网络抖动——`gone` 是「永远收不到」，只会被用来 drop 消息（§J.1）。
- 幂等：同一条 outbox 消息可能重发，所以发送要做幂等。GitHub 用正文尾部的隐藏标记
  `<!-- superagent:<messageId> -->` 先查重；Feishu 用 `--idempotency-key <messageId>`（上限 50
  字符，超长确定性截短）。**不要**指望 Channel 自己知道重试。
- 发送前做长度/字数校验（该 kind 的上限），超限要拒——启动子进程之前拒。
- `link` 只拼链接，不发请求；缺部署信息时返回空 `url`，面板显示纯文本。

## 7. `threadContext`：评估语境与图片

```ts
threadContext: {
  messageId(trigger): string
  read(host, trigger, part, cursor, config, signal): Promise<ContextPart>
  images?(text): readonly string[]
  image?(host, trigger, imageId, signal): Promise<{ path, alt }>
}
```

- `part` 是 `root | parent | thread`；Feishu 还多两种读法（`message`、`around`），那是它的
  `read.ts` 自己的事，`threadContext.read` 只承担评估窗口要的三种。
- 返回的 `ContextPart` 要如实写 `status` 与 `next` 游标；`status` 是 kind 自己的短码，例如 GitHub
  的 `available` / `forbidden` / `deleted` / `missing`，Feishu 在没有话题时给 `chat_neighbours`。
  **读不到就是状态，不是空列表**（§I.2/§I.3 的失败处理列）；资源读面（`read github/…`）另有自己
  的一组状态，见 `sources/<kind>/read.ts`。
- 分页有上限：页数由部署设置 `admissionContextMaxPages`、超时由 `admissionContextTimeoutMs`
  控制（`admission-context.ts` 统一做），kind 不该自己再定一套。
- 图片 id 的唯一契约是 **`<message-id>/<image-key>`**：`images(text)` 从正文认出 key，
  `image(host, trigger, '<message>/<key>')` 原样收回。**只接受自己正文里出现过的 key**，绝不下载
  任意远端 id。
- 一切外部读取都经 `host`（`CommandsHost`）并传 `signal`：窗口超时要能取消。

## 8. `find`：搜索

```ts
find(query): { threads: readonly string[]; terms: readonly string[] }
```

把用户输入（编号 `#12`、URL、原生消息 id）解成候选 Thread 键与搜索词；面板 Search 页与
`read search` 都读它。纯函数、**不发网络**——解析不出来就返回空，别猜。

## 9. `policy` 部分：准入行、bots、sync

```ts
policy: {
  schema,                    // 这个 Source 在 Policy 块里的那一部分（含 allowed 名单）
  fields,                    // 表单字段；第一个是 allowed
  explicit: { zh, en },      // 「在跟智能体说话」在本 Source 里长什么样
  rows(config): readonly AdmissionRow[],
  bots?: readonly Field[],
  sync?: { label, ready(part), run(host, part, signal) }
}
```

- `rows()` 声明**接收 scope 的行**，每行三个格子（`listedUnaddressed` / `unlistedAddressed` /
  `unlistedUnaddressed`）各自声明「这个格子可不可用」。只收点名的 Source 把未点名的格子设成
  `cells: false`，准入表就只由 addressed 那一格说话（§K.1 的「准入表只对 receive-all 可用」）。
- `bots` 是这一部分的第二个名单字段（§K.2 第 5 条）；bot 的消息不能授权工作。
- `sync` 是名单同步（如群成员）：`ready(part)` 说明目标点名了没有，`run()` 读外部名单并返回
  **新的 `part`**——kind 不写库，保存由设置层做。同步的结果落到 `sync:<source id>` 健康条目
  （那个条目由 settings 写，kind 不 claim）。
- 校验：`registry.validatePolicy()` 会先把 `admission` 摘出来（它由 Policy 自己的 schema 管），
  只拿 kind 的 `schema` 校验其余部分。

## 10. `environment`：执行环境变量

```ts
environment: {
  variables: readonly { key, description: { zh, en } }[],
  values(input: { trigger?, deployment, config }): Record<string, string>
}
```

- 变量名是**契约**：skills 与 prompts 里直接引用（`DSH_SUPERAGENT_*`），改名会破坏等价性。
- 值只来自 Ticket、部署与 Source 配置（起始 Trigger 的 `meta`），不由 agent「发现」；`values()`
  是纯函数，不读时钟、不发命令。
- 声明了就要给出值：`environment.test.ts` 逐项断言值，`model-surface.test.ts` 断言 prompt 里
  提到的一切与变量表/命令表一致。
- worktree 里的 `.superagent/env.sh` 由执行器统一写（`executor/env-file.ts`），kind 不需要知道；
  变量替换（`${DSH_SUPERAGENT_*}`）只在 `prepare` 的命令文本里发生，逐值单引号转义（§E.11）。

## 11. 夹具与测试：`FakeCommands` + `.expected.json`

**测试绝不 spawn 真 CLI。** `sources/commands.ts` 的 `Commands` 是端口，测试用
`tests/support/fake-commands.ts` 的 `FakeCommands`：

```ts
const cli = new FakeCommands()
cli.script('gh api notifications', () => readRepoJson('tests/fixtures/cli/github/notifications.json'))
cli.fail('gh', ['api', 'repos/acme/widgets/issues/42'], new CliError('gh exited with code 1', 404, 1))
await poller.poll()
assert.deepEqual(cli.programs, ['gh', 'gh'])
```

- `script(matcher, reply)` / `fail(program, args, error)` / `next(...)` / `scriptStream(...)`；
  任何**没脚本化**的调用都会抛错（「测试不跑真 CLI」是默认姿态，不是约定）。
- 事件流（`lark-cli event consume`）用 `scriptStream`：测试拿到 `FakeStream` 自己推行、推诊断、
  给退出码。

夹具放 `tests/fixtures/cli/<kind>/`，规则见 `tests/fixtures/cli/README.md`：

1. 每条夹具是**真实 CLI 输出的脱敏片段**（只替换可识别身份与正文，字段一个不少），采集命令写在
   期望文件的 `source.command` 里；
2. 每条夹具配一份 `.expected.json`，描述**期望产出**（Trigger 的 `id`/`threads`/`actor`/`human`/
   `addressed`/`channel`、游标推进、Channel 调用），稳定 id 必须能用 `key()` 复算；
3. `tests/fixtures.test.ts` 会检查「每个夹具都有期望文件、期望文件点名它的夹具、字段与真实契约一致」。

测试类别与它们的落点：

| 面 | 文件 | 断言什么 |
| --- | --- | --- |
| 协议 | `tests/kind.test.ts` | 你的 kind 能实现接口的每个成员；`SourceContext` 的边界 |
| 注册表 | `tests/registry.test.ts` | 注册、实例解析、配置失败禁用、Policy 部分、Channel、线程上下文 |
| Source 行为 | `tests/sources-<kind>.test.ts` | 翻译、轮询/事件流、读位置、失败处理、`gone` 的判定 |
| 读面 | `tests/<kind>-read.test.ts` | 资源读取、线程上下文、图片、搜索 |
| 命令端口 | `tests/commands.test.ts` | 所有 CLI 调用都经端口、argv 数组、错误脱敏 |
| 配置与表单 | `tests/deployment.test.ts`、`tests/settings.test.ts` | setup 探针、配置校验、保存的 origin 规则 |

---

## 12. 资源名：`ParsedResource` 联合与 `READ_SOURCE_RESOURCES`

`read <resource>`（以及 `GET read/:resource`）的资源名是**两份**表一起决定的，两个都在
`src/worker/app/read.ts`——kind 自己的读模块只管「怎么读」，不管「叫什么」：

1. `ParsedResource`（该文件的联合类型）：资源名解析后的形状。GitHub 是 `{kind: 'github',
   resource, number?, sha?}`，Feishu 多定位一段 `{kind: 'feishu', resource, triggerId, section,
   cursor?}`。新 kind 要么复用已有分支的形状，要么在这里加一支——**加一支就要同时改**
   `parseReadResource`（形状判定）、`shapeOf`（文本页 / 列表页 / `checks`）与 `claimsResource`
   （assignment 角色的越权边界，§O 的角色行）。
2. `READ_SOURCE_RESOURCES`（同一文件的字符串数组）：**唯一**的「可用写法」清单。未知资源名的
   `unknown_resource` 拒绝把这份清单原样放进 `values.forms`（§G.2 的 read 行），技能文本与模型
   照抄的就是它；漏写就是「实现了但教不会模型用」。

两条硬规矩：

- **资源名本身就是契约**：`next`（`github/issues/12/comments/2`、`feishu/<trigger>/thread/<cursor>`）
  要能原样交回作下一次读，所以游标编码、分隔与大小写都在这里定，kind 的读模块只负责产出。
- **越权要在这里拦**：assignment token 只读自己 Ticket 相关的资源（`claimsResource`）；
  新 kind 若带 Ticket 边界，把那条判定加进同一个函数，别在 kind 里另写一套。

测试：`tests/read-surface.test.ts`（未知资源名的 `forms`、分页与外形的拒绝）与
`tests/read-views.test.ts`（视图路由）会红；`tests/cli-contract.test.ts` 断言命令面仍然只
经已有路由（§G.2：不新增命令）。

## 注册：registry 与 boot

一个 kind 只有被注册才算装上。组合根（`src/worker/boot.ts`）做两件事：

```ts
const registry = new SourceRegistry({ health: board, settings: () => sourceSettings })
const unregister = registry.register(createExampleKind(/* 需要闭包的配置 */))
// 注销（关停或热替换时）：
unregister()
```

- `SourceRegistry` 的构造参数是两个必填的：健康板（唯一写者，§D.4）与设置视图
  （`{ sources: { <id>: { enabled, config } }, policy: { sources: { <id>: part } } }`）；另有可选的
  `registered` 回调。`sourceSettings` 由 `settingsView(settings, …)` 在 boot 里算，**不要让 kind 去
  读设置**。
- `register()` 会 claim `kind.health` 的条目（失败时释放已 claim 的并抛错）、并调用构造时给的
  `registered` 回调（给需要额外接线的东西，例如事件流）。返回的注销函数必须幂等。
- kind 需要 CLI 名、`stateDir` 这类**部署值**时，用工厂函数把值闭包进去
  （`createGithubKind(cli)`、`createFeishuKind(cli, { stateDir, labelsKey })`）——`channel.send`
  与 `threadContext.read` 只拿得到 `CommandsHost` 与实例配置，拿不到部署。
- 注册之后，boot 通过注册表的读面把 kind 接进各条流程：`instance(id)`（是否启用/配置错误）、
  `healthEntries([...])`（把 claim 句柄交给轮询器）、`scope(trigger)`（领域问监听范围）、
  `channelAllowed/send/link`（outbox）、`threadContext(id)`（评估窗口）、`find`（搜索）、
  `declarations`/`environments`（执行环境变量）、`refreshLabels`（`source labels` 与面板的
  「刷新显示名」）、`overview()`（面板 Source 页与 `sources` 健康条目）。
- 轮询/事件流是 **boot 的循环**，不是 kind 自己起定时器：boot 按 `pollSeconds` 调
  `<kind>Poller.poll()`，按 abort signal 停事件流。kind 的 `poll.ts` 只负责「跑一轮、返回结果」，
  退避、游标推进与 health 由 boot 与 kind 共同遵守的约定给出（见 `github/poll.ts` 与
  `feishu/stream.ts` 的注释）。

## `SourceContext`：kind 能用的一切

kind 在运行期只拿得到 `SourceContext`（`ctx`）。它能做：

| 成员 | 用途 | 不能做的事 |
| --- | --- | --- |
| `ready` | 实例是否已就绪（配置有效、CLI 可用） | 不要用它代替 `configured()` 的 setup 判断 |
| `configured()` | setup 是否完成 | 完成前别轮询（会拿到空账号） |
| `problem` | 挡住这个 kind 的 setup 问题 | 不要自己编问题码 |
| `config(kind)` | 本实例已校验的配置 | 不要读别的 kind 的配置 |
| `receive(trigger)` | 收一条 Trigger：幂等、扇出、排队 Eval | 不要自己写 trigger/thread 表 |
| `atomic(fn)` | 同一事务里做多步 | 事务里别发网络 |
| `state.get/set/delete` | 自己的读位置等小 KV（键字面量在 `app/kv.ts`） | 不要存大对象；不要用别的 kind 的键 |
| `threads.describe/patch` | Thread 的人读描述与 Source 自有 meta | 不要改订阅、决策、工单状态 |
| `tickets.bindThread/threadClosed` | 绑定 Ticket 到一个 Thread / 报告 Thread 关闭（PR 规则用） | 不要建 Ticket、不要改 Mandate |
| `triggers.read(id)` | 读一条已存 Trigger（搜索/视图用） | 不要改 Trigger |
| `notify({title, body})` | 给面板一条通知 | 不要用它代替 Channel 回复 |
| `report(entry, health)` | 写自己 claim 的那条健康 | 不要写别人的条目（单一写者） |
| `commands.withSignal(signal)` | 拿到绑定了取消信号的命令端口 | 不要 `spawn`、不要拼 shell |

一句话：**kind 通过端口读写，永远不 import `core/` 的实现、`app/`、`http/`，也不自己开子进程。**

## 必须守的缝

1. **`sources/` 不 import `app/`，也不 import `core/` 的实现**（只 import 类型与值形状）；
   一切引擎访问经 `SourceContext`（§C.2 规则 2，`dependency.test.ts` 扫描）。
2. **不 `spawn`、不 `exec`、不拼 shell**：所有 CLI 都经 `CommandsHost`；白名单与 argv 数组由
   `commands.ts` 与执行器的 shim 保证（§I.4、§O）。
3. **不自己读时钟、不读环境变量**：时间从 Trigger 或注入的 `now` 来——`poll.ts` / `stream.ts`
   都接 `options.now`（缺省 `Date.now()` 只写在那一处，测试一律传值）；需要「现在」的决策
   （例如水位）就用它，不要在循环里散落 `new Date()`。
4. **不发网络**：除了 `CommandsHost` 起的子进程，`sources/` 里没有别的出口（`commands.test.ts`
   断言生产代码只经端口调用）。
5. **每个状态只有一个写者**：读位置是你的、Trigger/Thread/Ticket 是领域的、health 条目是注册表
   替你 claim 的、outbox 是 outbox 的（§D.4）。
6. **失败要可判定**：能重试的抛错（带 `CliError.code`），永久失效才 `gone`；健康条目按
   「连续 3 次失败 → error、下一次成功即清除」写（`infra/health.ts`）。
7. **没有就是没有**：读不到的语境写 `status`，拿不到的图片说「无法读取」，绝不编内容（§H.17）。
8. **不新增命令/路由**：Source 的能力经已有命令面（`read`、`policy sync`、`source labels`、
   `GET read/:resource`）。新命令要另开票（§G.2 的契约与 `model-surface.test.ts` 都要改）。

## 交付前自检

- [ ] `npx tsc -p .` 通过；`orca plugin test .` 全绿；`orca plugin check .` / `validate .` 通过。
- [ ] `registry.test.ts` 与 `kind.test.ts` 都覆盖了新 kind（注册、校验、Policy 部分、Channel、
      线程上下文）。
- [ ] `health` 里声明的条目都在 `HEALTH_ENTRIES` 里，且 §N.4 的表与 `health.test.ts` 的
      `DESIGN_ENTRIES` 一起更新。
- [ ] `fields` 与 schema 的键一一对应；每个字段有双语标签；`locales.test.ts` 绿。
- [ ] `scope().row` 与 `policy.rows()` 的行 id 对得上；准入表在面板里能改。
- [ ] `channel.send` 幂等、只返回 `sent`/`gone`、超限在起子进程前拒。
- [ ] 夹具是真实输出的脱敏片段、带 `.expected.json`、`source.command` 与可复算的 id。
- [ ] `environment.variables` 的每个键都在 `values()` 里有值，`environment.test.ts` 断言到。
- [ ] 新资源名写进了 `src/worker/app/read.ts` 的 `ParsedResource` 与 `READ_SOURCE_RESOURCES`
      （第 12 步），`unknown_resource` 的 `forms` 里有它。
- [ ] 没有新增 npm 依赖；没有 `spawn`、没有 `shell: true`、没有裸 `fetch`。

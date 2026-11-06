# CLI fixtures (`tests/fixtures/cli/**`)

每条夹具都是**真实 CLI 输出的脱敏片段**，旁边配一份 `.expected.json` 说明它应当被翻译成
什么（Trigger / Thread / Channel 调用）。设计依据：§I.6；断言在 `tests/fixtures.test.ts`。

## 规则

1. **不手写理想 JSON。** 夹具的字段集合、层级与类型必须来自本机真实命令的输出；只允许把
   可识别身份的字符串（仓库名、账号、群名、消息正文）替换成中性值，且替换后字段一个不少、
   类型不变。采集命令写在 `.expected.json` 的 `source.command` 里。
2. **每个夹具一份 `.expected.json`。** 它描述翻译的**期望产出**（不是实现快照）：Trigger 的
   `id` / `threads` / `actor` / `human` / `addressed` / `channel`，以及游标推进与 Channel 调用。
   后续 GitHub / Feishu 票（#17/#18/#21/#22）直接拿它断言。
3. **不发网络。** 测试只经 `FakeCommands`（`tests/support/fake-commands.ts`）喂夹具；没有任何
   测试会跑真 CLI。

## 现有夹具

| 夹具 | 来源命令 | 说明 |
| --- | --- | --- |
| `github/notifications.json` | `gh api 'notifications?all=true&per_page=2'` | 真实输出里取第二条（PullRequest / `state_change`）；仓库与账号脱敏为 `acme/widgets`、`acme`，标题改成通用句子。`repository` 的 60 余个 URL 字段原样保留，用来证明解析器不能假设窄形状。 |
| `feishu/message-event.jsonl` | `lark-cli event consume im.message.receive_v1 --as bot` | 一行 NDJSON 事件；字段名与类型取自同目录的 `message-event.schema.json`（本机真实输出，原样保存），`om_` / `oc_` / `ou_` 值与正文是脱敏后的中性值。 |
| `feishu/message-event.schema.json` | `lark-cli event schema im.message.receive_v1 --json` | 原样保存的真实输出：事件消费的字段契约（`jq_root_path`、`resolved_output_schema`）。 |

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
| `github/issue.json` | `gh api repos/cli/cli/issues/14980` | 关闭的 Issue（34 个字段）；仓库、账号、标题、正文与编号脱敏为 `acme/widgets`、Issue 42。没有 `pull_request` 键，是「Issue」的唯一判据。 |
| `github/issue-comments.json` | `gh api 'repos/cli/cli/issues/14980/comments?per_page=1'` | 一条 Issue 评论（14 个字段）；正文保留 `@acme-agent` 的点名形态，用来断言 `addressed=mention`。 |
| `github/pull-as-issue.json` | `gh api repos/cli/cli/issues/8294` | 同一个 PR 的 `issues/<n>` 视图（33 个字段）：带 `pull_request` 键，是「这是 PR」的判据。编号脱敏为 45。 |
| `github/pull.json` | `gh api repos/cli/cli/pulls/8294` | PR 视图（48 个字段，含 `base.repo` 的完整仓库对象）；仓库、账号、标题、正文、分支名与编号脱敏。 |
| `github/pull-conversation.json` | `gh api 'repos/cli/cli/issues/8294/comments?per_page=1'` | PR 的会话评论（与 Issue 评论同形）；正文不含点名，期望里没有 `addressed`。 |
| `github/pull-reviews.json` | `gh api 'repos/cli/cli/pulls/8294/reviews?per_page=1'` | 一条评审（13 个字段，含 `_links` 与 `submitted_at`）；翻译归 #18，本票只读。 |
| `github/pull-review-comments.json` | `gh api 'repos/cli/cli/pulls/8294/comments?per_page=1'` | 一条评审评论（28 个字段，含 `diff_hunk` / `path` / `line`）；翻译归 #18，本票只读。 |
| `feishu/message-event.jsonl` | `lark-cli event consume im.message.receive_v1 --as bot` | 一行 NDJSON 事件；字段名与类型取自同目录的 `message-event.schema.json`（本机真实输出，原样保存），`om_` / `oc_` / `ou_` 值与正文是脱敏后的中性值。 |
| `feishu/message-event.schema.json` | `lark-cli event schema im.message.receive_v1 --json` | 原样保存的真实输出：事件消费的字段契约（`jq_root_path`、`resolved_output_schema`）。 |

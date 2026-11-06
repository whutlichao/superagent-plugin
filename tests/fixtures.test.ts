// 夹具的形态与期望产出（§I.6、票 #10 验收第三条）：每条夹具是**真实 CLI 输出的脱敏片段**，
// 不是手写的理想 JSON；每个夹具配一份 `.expected.json`。这里守住三件事：
// - 夹具必须带 `source.command`（采集命令），字段集合必须与真实输出的契约一致；
// - 期望产出必须覆盖触发翻译的全部面（id / threads / actor / human / addressed / channel）；
// - 期望产出里的稳定 id 必须能用 `key()` 复算（改夹具就要改期望，不能两边对不上）。
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readRepoFile, readRepoJson, listFiles } from './support/repo.ts'
import { key } from '../src/worker/core/ids.ts'

/** 夹具目录（相对仓库根）。 */
const FIXTURES = 'tests/fixtures/cli'

/** 某条夹具的期望产出（字段按夹具类型各取所需，测试逐项断言）。 */
interface Expected {
  readonly fixture: string
  readonly source: { readonly command: string; readonly note: string }
  readonly trigger?: Record<string, unknown>
  readonly notification?: Record<string, unknown>
  readonly expandsTo?: Record<string, unknown>
  readonly readCursor?: Record<string, unknown>
  readonly channelCalls?: readonly Record<string, unknown>[]
  readonly tally?: Record<string, number>
}

describe('fixture layout', () => {
  test('every fixture has an expected file next to it, and every expected file names its fixture', () => {
    const files = listFiles(FIXTURES).filter((file) => !file.endsWith('README.md'))
    const fixtures = files.filter((file) => !file.endsWith('.expected.json') && !file.endsWith('.schema.json'))
    const expected = files.filter((file) => file.endsWith('.expected.json'))
    assert.deepEqual(
      fixtures.sort(),
      [
        `${FIXTURES}/feishu/message-event.jsonl`,
        `${FIXTURES}/github/notifications.json`
      ],
      'the representative GitHub and Feishu fixtures'
    )
    for (const fixture of fixtures) {
      const expectedFile = fixture.replace(/\.(json|jsonl)$/, '.expected.json')
      assert.ok(expected.includes(expectedFile), `${fixture} has ${expectedFile}`)
      const content = readRepoJson<Expected>(expectedFile)
      assert.equal(content.fixture, fixture, `${expectedFile} names its fixture`)
      assert.ok(content.source.command.length > 0, `${expectedFile} records the command that produced it`)
      assert.ok(content.source.note.length > 0, `${expectedFile} says what was scrubbed`)
    }
    assert.deepEqual(expected.sort(), [
      `${FIXTURES}/feishu/message-event.expected.json`,
      `${FIXTURES}/github/notifications.expected.json`
    ])
  })
})

describe('the GitHub notifications fixture', () => {
  const fixture = readRepoJson<Record<string, unknown>[]>(`${FIXTURES}/github/notifications.json`)
  const expected = readRepoJson<Expected>(`${FIXTURES}/github/notifications.expected.json`)

  test('keeps the real shape of a `gh api notifications` answer, scrubbed', () => {
    // 真实输出是数组；条目带 id / reason / subject / repository / url 等字段，字段一个不少。
    assert.equal(Array.isArray(fixture), true)
    assert.equal(fixture.length, 1)
    const notification = fixture[0] as Record<string, unknown>
    for (const field of ['id', 'unread', 'reason', 'updated_at', 'last_read_at', 'subject', 'repository', 'url', 'subscription_url']) {
      assert.ok(field in notification, `notification carries ${field}`)
    }
    const subject = notification.subject as Record<string, unknown>
    for (const field of ['title', 'url', 'latest_comment_url', 'type']) {
      assert.ok(field in subject, `subject carries ${field}`)
    }
    const repository = notification.repository as Record<string, unknown>
    // 真实 repository 形状很宽（这次采集是 46 个键）：解析器不能假设只有 full_name。
    assert.ok(Object.keys(repository).length > 40, 'the repository object keeps its real width')
    assert.equal(repository.full_name, 'acme/widgets')
    // 脱敏后的值：没有任何可识别的真实账号/仓库。
    const raw = readRepoFile(`${FIXTURES}/github/notifications.json`)
    assert.equal(raw.includes('whutlichao'), false)
    assert.equal(raw.includes('superagent-test'), false)
    // 与期望产出对得上。
    const notificationExpectation = expected.notification as Record<string, unknown>
    assert.equal(notification.id, notificationExpectation.id)
    assert.equal(notification.reason, notificationExpectation.reason)
    assert.equal(notification.updated_at, notificationExpectation.updatedAt)
    assert.equal(repository.full_name, notificationExpectation.repository)
    assert.equal(subject.type, notificationExpectation.subjectType)
    assert.equal(subject.url, notificationExpectation.subjectUrl)
  })

  test('the expected expansion reads the subject and advances the cursor', () => {
    const expansion = expected.expandsTo as {
      read: { program: string; args: readonly string[] }
      thread: { key: string }
      cursor: { key: string; value: string }
    }
    assert.deepEqual(expansion.read.args, ['api', 'repos/acme/widgets/pulls/45'])
    assert.equal(expansion.thread.key, 'github:45')
    assert.equal(expansion.cursor.key, 'github-cursor:26977600684')
    assert.equal(expansion.cursor.value, '2026-11-06T12:40:45Z')
    assert.deepEqual(expected.tally, { skipped: 0 })
  })
})

describe('the Feishu message event fixture', () => {
  const lines = readRepoFile(`${FIXTURES}/feishu/message-event.jsonl`)
    .split('\n')
    .filter((line) => line.trim().length > 0)
  const event = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>
  const expected = readRepoJson<Expected>(`${FIXTURES}/feishu/message-event.expected.json`)
  const schema = readRepoJson<{
    jq_root_path: string
    resolved_output_schema: { properties: Record<string, { type: string; enum?: string[] }> }
  }>(`${FIXTURES}/feishu/message-event.schema.json`)

  test('is one NDJSON line whose fields are exactly the schema the CLI publishes', () => {
    assert.equal(lines.length, 1, 'event consume prints one JSON object per line')
    // 字段集合 == 真实 schema 的属性集合：多一个或少一个都说明夹具不是真实输出。
    assert.deepEqual(Object.keys(event).sort(), Object.keys(schema.resolved_output_schema.properties).sort())
    assert.equal(schema.jq_root_path, '.', 'the event is flattened (fields at the top level)')
    // 类型与枚举照 schema。
    const properties = schema.resolved_output_schema.properties
    assert.deepEqual(properties.chat_type?.enum, ['p2p', 'group'])
    assert.deepEqual(properties.sender_type?.enum, ['user', 'bot'])
    assert.equal(typeof event.message_id, 'string')
    assert.equal(typeof event.create_time, 'string')
    assert.match(String(event.message_id), /^om_[a-zA-Z0-9]+$/)
    assert.match(String(event.chat_id), /^oc_[a-zA-Z0-9]+$/)
    assert.match(String(event.sender_id), /^ou_[a-zA-Z0-9]+$/)
    // 脱敏：正文与 ID 都是中性值。
    assert.equal(readRepoFile(`${FIXTURES}/feishu/message-event.jsonl`).includes('李超'), false)
  })

  test('the expected Trigger names the thread, actor, addressing and channel the event carries', () => {
    const trigger = expected.trigger as {
      id: string
      idRecipe: string
      threads: { source: string; id: string }[]
      actor: { source: string; id: string }
      human: boolean
      addressed: string
      at: string
      text: string
      channel: { source: string; thread: string; address: Record<string, string> }
      meta: Record<string, unknown>
    }
    // 稳定 id 由 `key('feishu', <message id>)` 复算：动作 id 与期望必须一致。
    assert.equal(trigger.id, key('feishu', String(event.message_id)))
    assert.equal(trigger.idRecipe, "key('feishu', 'om_40eb06e7b84dc71c03e009ad3c754195')")
    // Thread 是「群 + 话题根」；事件里有 root_id 时用根消息，否则用消息自己。
    assert.deepEqual(trigger.threads, [
      { source: 'feishu', id: `${String(event.chat_id)}:${String(event.root_id)}` }
    ])
    assert.deepEqual(trigger.actor, { source: 'feishu', id: String(event.sender_id) })
    assert.equal(trigger.human, event.sender_type === 'user')
    // 群消息里 @ 了机器人 → mention；私聊 → direct（由 chat_type 决定）。
    assert.equal(trigger.addressed, event.mentions !== undefined ? 'mention' : 'direct')
    assert.equal(trigger.at, new Date(Number(event.create_time)).toISOString())
    assert.equal(trigger.text, event.content)
    assert.deepEqual(trigger.channel, {
      source: 'feishu',
      thread: `feishu:${String(event.chat_id)}`,
      address: { chatId: event.chat_id, messageId: event.message_id }
    })
    assert.deepEqual(trigger.meta, {
      chatId: event.chat_id,
      messageId: event.message_id,
      direct: event.chat_type === 'p2p',
      mentioned: true,
      rootId: event.root_id,
      threadId: event.thread_id
    })
  })

  test('the expected cursor and channel call follow the event', () => {
    const cursor = expected.readCursor as { key: string; advancesTo: string }
    assert.equal(cursor.key, `feishu-cursor:${String(event.chat_id)}`)
    assert.equal(cursor.advancesTo, new Date(Number(event.timestamp)).toISOString())
    const [call] = expected.channelCalls as { program: string; args: string[]; result: string }[]
    assert.equal(call?.program, 'lark-cli')
    // 回复落在话题根消息上（Feishu 的话题回复语义）。
    assert.deepEqual(call?.args.slice(0, 4), ['im', '+message-reply', '--as', 'bot'])
    assert.equal(call?.args[call.args.indexOf('--message-id') + 1], event.root_id)
    assert.equal(call?.result, 'sent')
  })
})

describe('fixtures are never hand-written', () => {
  test('the fixture README states the rule and the collection commands', () => {
    const readme = readRepoFile(`${FIXTURES}/README.md`)
    assert.ok(readme.includes('真实 CLI 输出的脱敏片段'))
    assert.ok(readme.includes("gh api 'notifications?all=true&per_page=2'"))
    assert.ok(readme.includes('lark-cli event schema im.message.receive_v1 --json'))
    assert.ok(readme.includes('FakeCommands'))
  })

  test('every fixture parses as JSON or NDJSON without comments', () => {
    // 手写的理想 JSON 常带注释或尾逗号；真实输出不会。逐文件解析即证明它们是机器产出的。
    // 夹具本体（不是 `.expected.json`：期望文件是我们写的说明，URL 里本来就带 `//`）。
    for (const file of listFiles(FIXTURES).filter((entry) => entry.endsWith('.json') && !entry.endsWith('.expected.json'))) {
      const text = readRepoFile(file)
      assert.equal(JSON.parse(text) !== undefined, true, `${file} parses`)
      assert.equal(/^\s*\/\//m.test(text), false, `${file} carries no comment lines`)
    }
    for (const file of listFiles(FIXTURES).filter((entry) => entry.endsWith('.jsonl'))) {
      for (const line of readRepoFile(file).split('\n').filter((entry) => entry.trim().length > 0)) {
        assert.equal(JSON.parse(line) !== undefined, true, `${file} line parses`)
      }
    }
  })
})

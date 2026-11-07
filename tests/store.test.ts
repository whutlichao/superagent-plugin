// 存储内核的第一个红灯（§D.2、§P.1）：`<stateDir>/superagent.sqlite` 是真的 SQLite，
// 打开后四条 PRAGMA 生效，且 KV 能存能读。先失败，再实现 `app/store.ts`。
import { assert, test } from 'orca/testing'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { openStore } from '../src/worker/app/store'
import { SCHEMA_VERSION } from '../src/worker/app/schema'
import { AT, isoAfter, openTempStore, tempStateDir } from './support/state'
import { githubCursorKey, KV_KEY_LITERALS, SETTINGS_REVISION_KEY } from '../src/worker/app/kv'
import { listFiles, readRepoFile } from './support/repo'

/** 只保留代码行（去掉行首注释：`//`、`*`、`/*`），与 seam 扫描器的规则一致。 */
function codeLines(source: string): readonly string[] {
  return source
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
}

test('opening a state directory creates superagent.sqlite with the four pragmas', () => {
  const { store, stateDir, cleanup } = openTempStore()
  try {
    assert.equal(existsSync(join(stateDir, 'superagent.sqlite')), true, 'the database file exists')
    assert.deepEqual(store.pragmas(), {
      journalMode: 'wal',
      synchronous: 1, // NORMAL
      foreignKeys: 1,
      busyTimeout: 5000
    })
  } finally {
    cleanup()
  }
})

test('a fresh database carries every table family the design names', () => {
  const { store, cleanup } = openTempStore()
  try {
    // §D.2 的表族：Trigger、Disposition、Trigger–Thread、Thread、Ticket、Decision、Effect、
    // Outbox、KV，加上设计点名的 settings/prompt 版本表。
    assert.deepEqual(store.tables(), [
      'decision',
      'disposition',
      'effect',
      'kv',
      'outbox',
      'prompt_version',
      'settings_version',
      'thread',
      'ticket',
      'trigger',
      'trigger_thread'
    ])
  } finally {
    cleanup()
  }
})

test('a thread timeline pages by the (at, id) composite cursor without loss or repetition', () => {
  const { store, cleanup } = openTempStore()
  try {
    store.triggers.insert({
      id: 'trigger-a',
      source: 'github',
      at: AT,
      actor: { source: 'github', id: 'alice' },
      human: true,
      addressed: 'mention',
      text: 'please fix the build',
      url: 'https://example.test/1',
      body: { kind: 'comment' }
    })
    store.triggers.insert({
      id: 'trigger-b',
      source: 'github',
      at: AT, // 同一时刻：只有 (at, id) 复合游标能既不丢也不重
      actor: { source: 'github', id: 'bob' },
      human: true,
      addressed: null,
      text: 'second at the same instant',
      url: null,
      body: {}
    })
    store.triggers.insert({
      id: 'trigger-c',
      source: 'github',
      at: isoAfter(AT, 1000),
      actor: { source: 'github', id: 'carol' },
      human: false,
      addressed: null,
      text: 'later',
      url: null,
      body: {}
    })
    for (const triggerId of ['trigger-a', 'trigger-b', 'trigger-c']) {
      store.triggerThreads.link({
        threadKey: 'github:1',
        at: triggerId === 'trigger-c' ? isoAfter(AT, 1000) : AT,
        triggerId,
        human: true,
        primaryThread: triggerId === 'trigger-a'
      })
    }
    // 另一个 Thread 的行不能混进来。
    store.triggerThreads.link({
      threadKey: 'github:2',
      at: AT,
      triggerId: 'trigger-a',
      human: true,
      primaryThread: true
    })

    const first = store.triggerThreads.timeline('github:1', { limit: 2 })
    assert.deepEqual(
      first.items.map((item) => item.triggerId),
      ['trigger-a', 'trigger-b'],
      'same-instant rows both appear, ordered by id'
    )
    assert.deepEqual(first.next, { at: AT, triggerId: 'trigger-b' })

    const second = store.triggerThreads.timeline('github:1', { limit: 2, after: first.next })
    assert.deepEqual(
      second.items.map((item) => item.triggerId),
      ['trigger-c'],
      'the row after the cursor is neither repeated nor skipped'
    )
    assert.equal(second.next, null, 'no more pages once the last page is short')

    const everything = [
      ...first.items.map((item) => item.triggerId),
      ...second.items.map((item) => item.triggerId)
    ]
    assert.deepEqual(everything, ['trigger-a', 'trigger-b', 'trigger-c'])
  } finally {
    cleanup()
  }
})

test('the tail and before reads walk a thread timeline backwards without loss or repetition', () => {
  const { store, cleanup } = openTempStore()
  try {
    // 五条同一时刻的 Trigger：只有 (at, id) 复合游标能既不丢也不重。
    const ids = ['trigger-a', 'trigger-b', 'trigger-c', 'trigger-d', 'trigger-e']
    for (const id of ids) {
      store.triggers.insert({
        id,
        source: 'github',
        at: AT,
        actor: { source: 'github', id: 'alice' },
        human: true,
        addressed: null,
        text: id,
        url: null,
        body: {}
      })
      store.triggerThreads.link({
        threadKey: 'github:1',
        at: AT,
        triggerId: id,
        human: true,
        primaryThread: false
      })
    }
    const tail = store.triggerThreads.tail('github:1', 2)
    assert.deepEqual(tail.items.map((item) => item.triggerId), ['trigger-d', 'trigger-e'])
    assert.deepEqual(tail.before, { at: AT, triggerId: 'trigger-d' })

    const second = store.triggerThreads.before('github:1', tail.before as never, 2)
    assert.deepEqual(second.items.map((item) => item.triggerId), ['trigger-b', 'trigger-c'])
    assert.deepEqual(second.before, { at: AT, triggerId: 'trigger-b' })

    const third = store.triggerThreads.before('github:1', second.before as never, 2)
    assert.deepEqual(third.items.map((item) => item.triggerId), ['trigger-a'])
    assert.equal(third.before, null, 'the earliest page ends the walk')

    // `item` 是 `around` 的锚点：恰好落在游标上的那一行。
    assert.equal(store.triggerThreads.item('github:1', { at: AT, triggerId: 'trigger-c' })?.triggerId, 'trigger-c')
    assert.equal(store.triggerThreads.item('github:1', { at: AT, triggerId: 'trigger-nope' }), undefined)
    assert.equal(
      store.triggerThreads.item('github:2', { at: AT, triggerId: 'trigger-c' }),
      undefined,
      'another thread never anchors'
    )
  } finally {
    cleanup()
  }
})

test('the working sets are read through generated columns and partial indexes only', () => {
  const { store, cleanup } = openTempStore()
  try {
    // 50 个不活跃的 Thread + 50 个已结束 Ticket + 50 条已发消息，只有少数几行是「活」的。
    const completed = isoAfter(AT, 1000)
    for (let index = 0; index < 50; index += 1) {
      store.threads.put({ key: `github:${index}`, source: 'github', meta: {}, body: {} })
      store.tickets.put({
        id: `ticket-${index}`,
        at: AT,
        body: { ended: { at: completed, reason: 'ready' } }
      })
      store.outbox.put({
        id: `message-${index}`,
        ticketId: null,
        channel: 'github:1',
        status: 'sent',
        body: {},
        settledAt: completed,
        droppedAt: null,
        droppedReason: null
      })
    }
    store.threads.put({
      key: 'github:active',
      source: 'github',
      meta: {},
      body: { eval: { id: 'eval-1' }, queued: [], subscriptions: [{ ticketId: 'ticket-active' }] }
    })
    store.tickets.put({ id: 'ticket-active', at: AT, body: { inputs: [{ id: 'input-1' }] } })
    store.outbox.put({
      id: 'message-pending',
      ticketId: 'ticket-active',
      channel: 'github:1',
      status: 'pending',
      body: {},
      settledAt: null,
      droppedAt: null,
      droppedReason: null
    })

    // 只扫活行：50 条死行一条都不出现。
    assert.deepEqual(store.workingSet(), {
      activeThreads: ['github:active'],
      openTickets: ['ticket-active'],
      activeTickets: ['ticket-active'],
      pendingOutbox: ['message-pending']
    })

    // 查询计划：每条都走对应的部分索引，没有 SCAN <table>。
    const plans = store.workingSetPlan()
    const expectedIndex = {
      activeThreads: 'thread_active',
      openTickets: 'ticket_open',
      activeTickets: 'ticket_active',
      pendingOutbox: 'outbox_waiting'
    } as const
    for (const [name, index] of Object.entries(expectedIndex)) {
      const lines = plans[name as keyof typeof plans]
      assert.ok(
        lines.some((line) => line.includes(`INDEX ${index}`)),
        `${name} reads through ${index}: ${lines.join(' / ')}`
      )
      // 非活跃行一律不进扫描：不能出现对整表的 SCAN。
      assert.equal(
        lines.some((line) => /^SCAN \w+$/.test(line)),
        false,
        `${name} must not full-scan its table: ${lines.join(' / ')}`
      )
    }
  } finally {
    cleanup()
  }
})

test('KV stores JSON values, lists keys in order and deletes one key', () => {
  const { store, cleanup } = openTempStore()
  try {
    store.kvSet(githubCursorKey('n-1'), { seen: true, at: AT })
    store.kvSet(SETTINGS_REVISION_KEY, 3)
    // `schema-version` 本身就是 KV 的唯一版本源（§D.2 要点 3），因此它一定在列表里。
    assert.deepEqual(store.kvKeys(), ['github-cursor:n-1', 'schema-version', 'settings-revision'])
    assert.deepEqual(store.kvGet(githubCursorKey('n-1')), { seen: true, at: AT })
    assert.equal(store.kvGet(SETTINGS_REVISION_KEY), 3)
    assert.equal(store.kvGet('missing'), null)
    assert.equal(store.kvDelete(githubCursorKey('n-1')), true)
    assert.equal(store.kvDelete(githubCursorKey('n-1')), false)
    assert.deepEqual(store.kvKeys(), ['schema-version', 'settings-revision'])
    assert.equal(
      store.kvGet<number>('schema-version'),
      SCHEMA_VERSION,
      'the schema version is readable through KV'
    )
  } finally {
    cleanup()
  }
})

test('KV key literals live only in app/kv.ts and app/migration.ts', () => {
  // §D.3 的上线约束：键字面量只允许出现在命名模块与迁移模块里（源码扫描测试）。
  // 做法：把 `kv.ts` 的 `KV_KEY_LITERALS` 当成唯一的字面量清单（它本身就是设计 §D.3
  // 表格的逐行转写），在其余源码里搜这些字面量；`migration.ts` 是唯一豁免。
  const literals = Object.values(KV_KEY_LITERALS).map((literal) => literal.replace(/:$/, ''))
  assert.ok(literals.length >= 20, 'the literal list covers every key family in §D.3')
  const allowed = new Set(['src/worker/app/kv.ts', 'src/worker/app/migration.ts'])
  const offenders = listFiles('src', '.ts')
    .filter((file) => !file.endsWith('.d.ts') && !allowed.has(file))
    .flatMap((file) =>
      codeLines(readRepoFile(file)).flatMap((line, index) =>
        literals
          .filter((literal) => line.includes(`'${literal}`) || line.includes(`"${literal}`))
          .map((literal) => `${file}:${index + 1}: ${literal}`)
      )
    )
  assert.deepEqual(offenders, [], 'KV key literals outside app/kv.ts')
  // 注释里提到键名不算违规（与 `tests/support/seam.ts` 的规则一致），但正控要能抓到代码行。
  assert.deepEqual(codeLines('// kv[key] schema-version is the source'), [])

  // 灵敏度自测：扫描器真的能抓到这些形态，否则上面的空结果说明不了任何事。
  assert.ok(literals.includes('schema-version'))
  assert.ok(literals.includes('settings-version'))
  assert.ok(literals.includes('github-cursor'))
  assert.ok(readRepoFile('src/worker/app/kv.ts').includes("schemaVersion: 'schema-version'"))
  // 反向：不是 §D.3 的键名不会被误报（例如表名 `thread` 与列名 `active`）。
  assert.equal(literals.includes('thread'), false)
  assert.equal(literals.includes('active'), false)
})

test('one transaction rolls back on throw and nests with savepoints', () => {
  const { store, cleanup } = openTempStore()
  try {
    assert.throws(() =>
      store.transaction(() => {
        store.kvSet('outer-kept', 1)
        store.transaction(() => {
          store.kvSet('inner-rolled-back', 2)
          throw new Error('inner')
        })
        throw new Error('outer')
      })
    )
    assert.equal(store.kvGet('outer-kept'), null, 'the outer rollback undoes the outer write')
    assert.deepEqual(store.kvKeys(), ['schema-version'])

    // 内层失败被外层吞掉时，内层写入仍然回滚，外层写入保留。
    store.transaction(() => {
      store.kvSet('outer-kept', 1)
      try {
        store.transaction(() => {
          store.kvSet('inner-rolled-back', 2)
          throw new Error('inner')
        })
      } catch {
        // 外层决定继续
      }
    })
    assert.equal(store.kvGet('outer-kept'), 1)
    assert.equal(store.kvGet('inner-rolled-back'), null)
  } finally {
    cleanup()
  }
})

test('an invalid ISO time is refused by the database, so text order stays time order', () => {
  const { store, cleanup } = openTempStore()
  try {
    const insertAt = (at: string): void => {
      store.triggers.insert({
        id: `trigger-${at}`,
        source: 'github',
        at,
        actor: { source: 'github', id: 'alice' },
        human: true,
        addressed: null,
        text: 'x',
        url: null,
        body: {}
      })
    }
    insertAt(AT)
    // 非 ISO 形态与不存在的时刻都进不来（§D.2 要点 1：时间只有 ISO-8601 一种形态）。
    for (const bad of ['2026-11-07T03:26:00Z', '2026-13-07T03:26:00.000Z', 'yesterday']) {
      assert.throws(() => insertAt(bad), `refuses at=${bad}`)
    }
    assert.deepEqual(
      store.triggers.byTime().map((trigger) => trigger.at),
      [AT]
    )
  } finally {
    cleanup()
  }
})

test('only app/store.ts imports node:sqlite in the whole plugin source', () => {
  // §D.2：「只有 `app/store.ts` 打开它」。这条扫描守住单一打开点，
  // 也守住「插件零运行时依赖」之外的一条：存储驱动只在一个文件里出现。
  const offenders = listFiles('src', '.ts')
    .filter((file) => !file.endsWith('.d.ts'))
    .filter((file) => /from\s+['"]node:sqlite['"]/.test(readRepoFile(file)))
    .filter((file) => file !== 'src/worker/app/store.ts')
  assert.deepEqual(offenders, [])

  // 灵敏度：store.ts 自己确实命中了扫描器。
  assert.equal(/from\s+['"]node:sqlite['"]/.test(readRepoFile('src/worker/app/store.ts')), true)
})

test('every table carries the columns the design names, generated ones included', () => {
  const { store, cleanup } = openTempStore()
  try {
    // 独立真相：§D.2 代码块里的列清单（逐行转写）。生成列在 `hidden` 里标 2。
    const expected: Readonly<Record<string, readonly string[]>> = {
      trigger: ['id', 'source', 'at', 'actor', 'human', 'addressed', 'text', 'url', 'body'],
      disposition: ['trigger_id', 'filtered', 'eval_id', 'decision_id', 'requeued_at', 'body'],
      trigger_thread: ['thread_key', 'at', 'trigger_id', 'human', 'primary_thread'],
      thread: ['key', 'source', 'meta', 'body', 'active', 'subscribed'],
      ticket: ['id', 'at', 'body', 'open', 'active'],
      decision: ['id', 'thread_key', 'at', 'kind', 'body'],
      effect: ['kind', 'key', 'payload', 'seq', 'due_at', 'attempts', 'last_error'],
      outbox: [
        'id',
        'ticket_id',
        'channel',
        'status',
        'body',
        'settled_at',
        'dropped_at',
        'dropped_reason',
        'pending',
        'dropped'
      ],
      kv: ['key', 'value'],
      settings_version: [
        'revision',
        'predecessor',
        'at',
        'origin',
        'block',
        'config',
        'policy_version'
      ],
      prompt_version: ['revision', 'predecessor', 'at', 'origin', 'config']
    }
    for (const [table, columns] of Object.entries(expected)) {
      const actual = store.sql
        .all(`PRAGMA table_xinfo(${table})`)
        .map((row) => String((row as Record<string, unknown>)['name']))
      assert.deepEqual(actual, columns, `${table} columns`)
    }
    // 生成列（`hidden = 2`）只能是设计点名的那几个。
    const generated = store.sql
      .all(
        "SELECT m.name AS tbl, p.name AS col FROM sqlite_master m, pragma_table_xinfo(m.name) p WHERE m.type = 'table' AND p.hidden = 2 ORDER BY m.name, p.name"
      )
      .map((row) => `${String((row as Record<string, unknown>)['tbl'])}.${String((row as Record<string, unknown>)['col'])}`)
    assert.deepEqual(generated, [
      'outbox.dropped',
      'outbox.pending',
      'thread.active',
      'thread.subscribed',
      'ticket.active',
      'ticket.open'
    ])
  } finally {
    cleanup()
  }
})

test('effect, settings-version and prompt-version repositories round-trip their records', () => {
  const { store, cleanup } = openTempStore()
  try {
    store.effects.put({
      kind: 'reply',
      key: 'message-1',
      payload: { messageId: 'message-1' },
      seq: 7,
      dueAt: AT,
      attempts: 2,
      lastError: 'boom'
    })
    store.effects.put({
      kind: 'reply',
      key: 'message-1',
      payload: { messageId: 'message-1', retried: true },
      seq: 7,
      dueAt: isoAfter(AT, 5000),
      attempts: 3,
      lastError: null
    })
    const effect = store.effects.get('reply', 'message-1')
    assert.deepEqual(effect, {
      kind: 'reply',
      key: 'message-1',
      payload: { messageId: 'message-1', retried: true },
      seq: 7,
      dueAt: isoAfter(AT, 5000),
      attempts: 3,
      lastError: null
    })
    assert.deepEqual(store.effects.due(isoAfter(AT, 4000)).map((row) => row.key), [])
    assert.deepEqual(store.effects.due(isoAfter(AT, 5000)).map((row) => row.key), ['message-1'])

    store.settingsVersions.put({
      revision: 1,
      predecessor: null,
      at: AT,
      origin: 'panel',
      block: 'eval',
      config: { acceptMode: 'observe' },
      policyVersion: 'abc123def456'
    })
    store.settingsVersions.put({
      revision: 2,
      predecessor: 1,
      at: isoAfter(AT, 1000),
      origin: 'sync',
      block: 'eval',
      config: { acceptMode: 'auto' },
      policyVersion: 'abc123def456'
    })
    assert.deepEqual(store.settingsVersions.latest(), {
      revision: 2,
      predecessor: 1,
      at: isoAfter(AT, 1000),
      origin: 'sync',
      block: 'eval',
      config: { acceptMode: 'auto' },
      policyVersion: 'abc123def456'
    })
    assert.equal(store.settingsVersions.byRevision(1)?.config !== undefined, true)

    store.promptVersions.put({
      revision: 1,
      predecessor: null,
      at: AT,
      origin: 'tool',
      config: { sections: { communication: 'be brief' } }
    })
    assert.deepEqual(store.promptVersions.latest()?.config, {
      sections: { communication: 'be brief' }
    })
    // 历史是新→旧的一列（§L.4 的版本表）：面板的 History 页与 `prompts get` 都按它取。
    store.promptVersions.put({
      revision: 2,
      predecessor: 1,
      at: isoAfter(AT, 1000),
      origin: 'panel',
      config: { team: { scope: 'Settings only.' } }
    })
    assert.deepEqual(store.promptVersions.list().map((version) => version.revision), [2, 1])
    assert.deepEqual(store.promptVersions.list(1).map((version) => version.revision), [2])
    assert.deepEqual(store.promptVersions.list().map((version) => version.predecessor), [1, null])
  } finally {
    cleanup()
  }
})

test('a decision keeps the four kinds and refuses anything else', () => {
  const { store, cleanup } = openTempStore()
  try {
    for (const kind of ['accept', 'stop', 'ignore', 'unavailable'] as const) {
      store.decisions.put({ id: `d-${kind}`, threadKey: 'github:1', at: AT, kind, body: { reason: kind } })
    }
    // 同一时刻的四条按 id 排序（`at, id` 的稳定顺序），不是按 kind 的字母序。
    assert.deepEqual(
      store.decisions.byThread('github:1').map((decision) => decision.id),
      ['d-accept', 'd-ignore', 'd-stop', 'd-unavailable']
    )
    assert.throws(() =>
      store.decisions.put({
        id: 'd-bad',
        threadKey: 'github:1',
        at: AT,
        kind: 'maybe' as 'accept',
        body: {}
      })
    )
  } finally {
    cleanup()
  }
})

test('afterCommit runs a callback only once the outermost transaction commits', () => {
  const { store, cleanup } = openTempStore()
  const ran: string[] = []
  try {
    // 未提交前什么也不跑（§J.2 执行行：副作用在提交后才执行）。
    store.transaction(() => {
      store.kvSet('committed-key', 1)
      store.afterCommit(() => ran.push('committed'))
      assert.deepEqual(ran, [], 'nothing runs inside the transaction')
    })
    assert.deepEqual(ran, ['committed'])

    // 回滚的事务：回调丢弃，一次也不跑。
    assert.throws(() =>
      store.transaction(() => {
        store.afterCommit(() => ran.push('rolled back'))
        throw new Error('rolled back')
      })
    )
    assert.deepEqual(ran, ['committed'])

    // 事务外调用：立即执行（调用方已经提交过了）。
    store.afterCommit(() => ran.push('direct'))
    assert.deepEqual(ran, ['committed', 'direct'])
  } finally {
    cleanup()
  }
})

test('afterCommit callbacks of a nested savepoint run only with the outer commit, and die with its rollback', () => {
  const { store, cleanup } = openTempStore()
  const ran: string[] = []
  try {
    store.transaction(() => {
      store.afterCommit(() => ran.push('outer'))
      store.transaction(() => {
        store.afterCommit(() => ran.push('inner'))
      })
      assert.deepEqual(ran, [], 'a released savepoint is not a commit')
    })
    assert.deepEqual(ran, ['outer', 'inner'])

    ran.length = 0
    store.transaction(() => {
      try {
        store.transaction(() => {
          store.afterCommit(() => ran.push('inner rolled back'))
          throw new Error('inner')
        })
      } catch {
        // 外层继续
      }
      store.afterCommit(() => ran.push('outer again'))
    })
    assert.deepEqual(ran, ['outer again'], 'the rolled-back savepoint’s callback never ran')
  } finally {
    cleanup()
  }
})

test('a failing afterCommit callback is logged and does not fail the committed transaction', () => {
  const stateDir = tempStateDir()
  const lines: { level: string; msg: string }[] = []
  const store = openStore({ stateDir, log: (line) => void lines.push({ level: line.level, msg: line.msg }) })
  try {
    const result = store.transaction(() => {
      store.kvSet('kept', 1)
      store.afterCommit(() => {
        throw new Error('callback blew up')
      })
      return 'committed'
    })
    assert.equal(result, 'committed')
    assert.equal(store.kvGet('kept'), 1, 'the write stayed committed')
    // 迁移本身会留一行 info；这里只断言回调失败的那一行在（§N.5 不静默）。
    assert.deepEqual(
      lines.filter((line) => line.level === 'error').map((line) => line.msg),
      ['an afterCommit callback failed']
    )
  } finally {
    store.close()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

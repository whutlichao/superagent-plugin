// 健康看板的写者纪律（§N.4、§D.4 写者表）：每个条目只能被一个部件 claim，重复 claim
// 直接抛；release 之后才允许换写者，且交出的写者不能再把条目写回来。
//
// 这一条是 §N.4「每个条目一个写者」的可执行形式：没有它，两个部件会互相覆盖状态，
// Overview 的 System problems 就说不清是谁坏了。
//
// 状态取 `core/ports.ts` 的四档 `HEALTH_STATES`（§J.3、§N.4：starting|ready|paused|error）；
// `at` 由读数方（HTTP 视图）补，不进看板。
import { assert, test } from 'orca/testing'
import {
  claimModelsEntry,
  createHealthTracker,
  FAILURES_BEFORE_ERROR,
  HEALTH_ENTRIES,
  HealthBoard,
  isHealthEntryName,
  MODELS_HEALTH_DETAIL,
  syncHealthEntry
} from '../src/worker/infra/health'
import { HEALTH_STATES, type HealthEntry } from '../src/worker/core/index.ts'

/** 一条健康读数：看板只认 state 与 detail。 */
const read = (state: HealthEntry['state'], detail?: string): HealthEntry =>
  detail === undefined ? { state } : { state, detail }

test('the board accepts exactly the four states the design names', () => {
  // 独立真相：§J.3 / §N.4 的四档，而不是从看板实现里读出来的。
  assert.deepEqual([...HEALTH_STATES], ['starting', 'ready', 'paused', 'error'])
  const board = new HealthBoard()
  const handle = board.claim('runtime')
  for (const state of HEALTH_STATES) {
    handle.set(read(state))
    assert.equal(board.all().runtime?.state, state)
  }
})

test('a health entry has exactly one writer: a second claim throws', () => {
  const board = new HealthBoard()
  board.claim('runtime')
  // 错误消息带条目名：Ops 从日志里能直接看出冲突的是哪一条。
  assert.throws(
    () => board.claim('runtime'),
    /health entry runtime is already reported by another part/
  )
})

test('two parts claim different entries side by side', () => {
  const board = new HealthBoard()
  const runtime = board.claim('runtime')
  const relay = board.claim('relay')
  runtime.set(read('ready', 'loopback api on 127.0.0.1:3847'))
  relay.set(read('error', 'waiting 1, failed 1'))
  assert.deepEqual(board.all(), {
    relay: read('error', 'waiting 1, failed 1'),
    runtime: read('ready', 'loopback api on 127.0.0.1:3847')
  })
})

test('a claimed entry with an initial reading is readable before the first set', () => {
  const board = new HealthBoard()
  board.claim('relay', read('ready', 'waiting 0, failed 0'))
  assert.deepEqual(board.all().relay, read('ready', 'waiting 0, failed 0'))
  // 没给初始值的条目在第一次 set 之前不出现：还没接上的部件不假装就绪。
  board.claim('notice')
  assert.equal(board.all().notice, undefined)
})

test('a released entry can be claimed again, and the old writer can no longer set it', () => {
  const board = new HealthBoard()
  const first = board.claim('relay', read('ready', 'waiting 0, failed 0'))
  first.release()
  // 交出去的写者不再生效：否则旧部件能把新写者的读数覆盖掉。
  first.set(read('error', 'stale'))
  assert.equal(board.all().relay, undefined)
  const second = board.claim('relay')
  second.set(read('ready', 'waiting 2, failed 0'))
  assert.deepEqual(board.all().relay, read('ready', 'waiting 2, failed 0'))
  // release 幂等：重复 release 不抛，也不影响新写者。
  first.release()
  assert.deepEqual(board.all().relay, read('ready', 'waiting 2, failed 0'))
})

test('the board lists entries and claims in name order for the panel and status read', () => {
  const board = new HealthBoard()
  for (const name of ['reply', 'assessment', 'relay']) board.claim(name)
  assert.deepEqual(board.claimed(), ['assessment', 'relay', 'reply'])
  // 未写过的条目不出现在读数里（缺行 = 还没接上，不是就绪）。
  assert.deepEqual(board.all(), {})
})

// ---------------------------------------------------------------- §N.4 的条目表与失败计数

/**
 * §N.4 表格的手抄（独立真相）：运行时、pass、模型、评估、七个副作用 kind、worker、router、
 * 两个 Source、历史回填、（名单同步是前缀族）、Source 总览。顺序即设计表格顺序。
 */
const DESIGN_ENTRIES = [
  'runtime',
  'passes',
  'models',
  'evals',
  'assessment',
  'launch',
  'delivery',
  'relay',
  'notice',
  'reply',
  'return',
  'worker',
  'router',
  'github',
  'feishu',
  'history',
  'sources'
] as const

test('the entry catalogue is exactly the design table, plus the sync prefix family', () => {
  assert.deepEqual([...HEALTH_ENTRIES], [...DESIGN_ENTRIES])
  // `sync:<source id>` 是唯一的前缀族（写者是 settings）；空 id 不是条目。
  assert.equal(isHealthEntryName(syncHealthEntry('github-main')), true)
  assert.equal(syncHealthEntry('github-main'), 'sync:github-main')
  assert.equal(isHealthEntryName('sync:'), false)
  assert.equal(isHealthEntryName('sync'), false)
  assert.equal(isHealthEntryName('warning'), false)
  // 表里每一项都能被 claim；`warning` 之流不是条目（§J.3：warning 是面板语气）。
  for (const name of DESIGN_ENTRIES) assert.equal(isHealthEntryName(name), true, name)
})

test('every design entry has exactly one writer: a second claim of any of them throws', () => {
  const board = new HealthBoard()
  for (const name of DESIGN_ENTRIES) board.claim(name)
  assert.deepEqual(board.claimed(), [...DESIGN_ENTRIES].sort())
  for (const name of DESIGN_ENTRIES) {
    assert.throws(
      () => board.claim(name),
      (error: unknown) =>
        error instanceof Error && error.message.includes(`health entry ${name} is already reported`),
      name
    )
  }
  // `sync:` 条目按 id 各自一条：两个 Source 各写各的，互不冲突。
  board.claim(syncHealthEntry('github-main'))
  board.claim(syncHealthEntry('feishu-team'))
  assert.deepEqual(
    board.claimed().filter((name) => name.startsWith('sync:')),
    ['sync:feishu-team', 'sync:github-main']
  )
})

test('three consecutive failures mark one entry error, and the next success clears it', () => {
  assert.equal(FAILURES_BEFORE_ERROR, 3)
  const board = new HealthBoard()
  const tracker = createHealthTracker({ board, name: 'github' })
  // 已 claim、还没报告过：starting（不假装 ready）。
  assert.deepEqual(tracker.entry(), { state: 'starting', detail: 'not reported yet' })
  tracker.fail(new Error('gh api 502'))
  assert.deepEqual(tracker.entry(), {
    state: 'starting',
    detail: 'failed 1 time: gh api 502'
  })
  tracker.fail(new Error('gh api 502'))
  assert.equal(tracker.entry()?.state, 'starting', 'two failures are below the threshold')
  assert.equal(tracker.entry()?.detail, 'failed 2 times: gh api 502')
  tracker.fail(new Error('gh api 502'))
  assert.equal(tracker.entry()?.state, 'error', 'the third consecutive failure is an error')
  assert.equal(tracker.entry()?.detail, 'failed 3 times: gh api 502')
  // 下一次成功即清除：计数归零、状态回到 ready（§N.4）。
  tracker.ready('polled 2 threads')
  assert.deepEqual(tracker.entry(), { state: 'ready', detail: 'polled 2 threads' })
  // 清除之后重新计数：再一次失败只是一次，不是第四次。
  tracker.fail(new Error('gh api 500'))
  assert.deepEqual(tracker.entry(), { state: 'ready', detail: 'failed 1 time: gh api 500' })
})

test('a paused entry says paused, and a success after the pause clears it', () => {
  const board = new HealthBoard()
  const tracker = createHealthTracker({ board, name: 'feishu' })
  tracker.ready('polled once')
  tracker.paused('source is off')
  assert.deepEqual(tracker.entry(), { state: 'paused', detail: 'source is off' })
  tracker.ready('polled again')
  assert.deepEqual(tracker.entry(), { state: 'ready', detail: 'polled again' })
})

test('the models entry is always ready and says Orca handles it (H.4)', () => {
  const board = new HealthBoard()
  const handle = claimModelsEntry(board)
  assert.deepEqual(board.all().models, { state: 'ready', detail: 'handled by Orca' })
  assert.equal(MODELS_HEALTH_DETAIL, 'handled by Orca')
  handle.release()
  assert.equal(board.all().models, undefined)
})

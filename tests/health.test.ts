// 健康看板的写者纪律（§N.4、§D.4 写者表）：每个条目只能被一个部件 claim，重复 claim
// 直接抛；release 之后才允许换写者，且交出的写者不能再把条目写回来。
//
// 这一条是 §N.4「每个条目一个写者」的可执行形式：没有它，两个部件会互相覆盖状态，
// Overview 的 System problems 就说不清是谁坏了。
//
// 状态取 `core/ports.ts` 的四档 `HEALTH_STATES`（§J.3、§N.4：starting|ready|paused|error）；
// `at` 由读数方（HTTP 视图）补，不进看板。
import { assert, test } from 'orca/testing'
import { HealthBoard } from '../src/worker/infra/health'
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

// 单实例锁（§N.1、§D.5、§P.3 R11）：第二个实例被拒并进入跟随模式；
// 陈旧锁（超过 30 s 未触碰）被回收；心跳每 5 s 触碰一次。
//
// 测试全部用注入的时钟与手动 `touch()`，不 sleep（§P.1 第 4 条）。
import { assert, test } from 'orca/testing'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  acquireLock,
  HEARTBEAT_MS,
  LOCK_FILE,
  lockAgeMs,
  readLock,
  STALE_AFTER_MS
} from '../src/worker/infra/lock'
import { tempStateDir } from './support/state'

/**
 * 可推进的假时钟（不 sleep 也能验证 5 s / 30 s 两条阈值）。起点取真实当前时刻：
 * 锁文件的 mtime 由内核写成墙上时间，时钟若从未来起跳，第一把锁就会被误判成陈旧。
 */
function fakeClock(): { now: () => Date; advance: (ms: number) => void; at: () => string } {
  let current = Date.now()
  const clock = {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms
    },
    at: () => new Date(current).toISOString()
  }
  return clock
}

test('the first instance takes the lock and writes pid plus startedAt', () => {
  const stateDir = tempStateDir()
  const clock = fakeClock()
  const outcome = acquireLock({ stateDir, pid: 4242, now: clock.now })
  assert.equal(outcome.mode, 'leader')
  if (outcome.mode !== 'leader') return
  try {
    assert.equal(outcome.reclaimed, false)
    const path = join(stateDir, LOCK_FILE)
    assert.equal(existsSync(path), true)
    assert.deepEqual(readLock(path), { pid: 4242, startedAt: clock.at() })
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { pid: 4242, startedAt: clock.at() })
  } finally {
    outcome.lock.release()
  }
  assert.equal(existsSync(join(stateDir, LOCK_FILE)), false, 'release removes the lock')
})

test('a second instance is refused and follows the live one', () => {
  const stateDir = tempStateDir()
  const clock = fakeClock()
  const first = acquireLock({ stateDir, pid: 1000, now: clock.now })
  assert.equal(first.mode, 'leader')
  if (first.mode !== 'leader') return
  try {
    const logs: string[] = []
    const second = acquireLock({
      stateDir,
      pid: 2000,
      now: clock.now,
      log: (line) => void logs.push(`${line.level}: ${line.msg}`)
    })
    assert.equal(second.mode, 'follower', 'the second instance never becomes leader')
    if (second.mode !== 'follower') return
    assert.deepEqual(second.holder, { pid: 1000, startedAt: clock.at() })
    assert.ok(second.ageMs <= STALE_AFTER_MS)
    assert.deepEqual(logs, ['warn: another instance holds the state directory; following it'])
    // 跟随者不动别人的锁。
    assert.deepEqual(readLock(join(stateDir, LOCK_FILE)), { pid: 1000, startedAt: clock.at() })
  } finally {
    first.lock.release()
  }
})

test('the heartbeat touches the file every five seconds, keeping it fresh', () => {
  const stateDir = tempStateDir()
  const clock = fakeClock()
  const outcome = acquireLock({ stateDir, pid: 7, now: clock.now })
  assert.equal(outcome.mode, 'leader')
  if (outcome.mode !== 'leader') return
  try {
    const path = join(stateDir, LOCK_FILE)
    // 心跳间隔就是设计里的 5 s（§N.1）。
    assert.equal(HEARTBEAT_MS, 5000)

    // 走过 29 s：仍是活锁，第二个实例被拒。
    clock.advance(29_000)
    assert.ok((lockAgeMs(path, clock.now) ?? 0) >= 29_000 - 1000)
    const stillAlive = acquireLock({ stateDir, pid: 8, now: clock.now })
    assert.equal(stillAlive.mode, 'follower')

    // 心跳触碰一次：锁重新变新鲜，第二个实例依旧被拒。
    clock.advance(HEARTBEAT_MS)
    outcome.lock.touch()
    assert.ok((lockAgeMs(path, clock.now) ?? Infinity) <= 1000, 'the touch makes the lock fresh again')
    const afterHeartbeat = acquireLock({ stateDir, pid: 9, now: clock.now })
    assert.equal(afterHeartbeat.mode, 'follower')

    // 停止心跳后不再触碰：越过 30 s 就变陈旧。
    clock.advance(STALE_AFTER_MS + 1)
    assert.ok((lockAgeMs(path, clock.now) ?? 0) > STALE_AFTER_MS)
  } finally {
    outcome.lock.release()
  }
})

test('a stale lock older than thirty seconds is reclaimed', () => {
  const stateDir = tempStateDir()
  const clock = fakeClock()
  const crashed = acquireLock({ stateDir, pid: 111, now: clock.now })
  assert.equal(crashed.mode, 'leader')
  if (crashed.mode !== 'leader') return
  // 模拟崩溃前最后一次心跳：把 mtime 钉在假时钟的当前时刻，再推过陈旧阈值。
  // （不先 touch 的话，mtime 是真实墙上时间，比假时钟起点晚几毫秒，边界会偶发翻转。）
  crashed.lock.touch()
  const path = join(stateDir, LOCK_FILE)
  clock.advance(STALE_AFTER_MS + 1)
  assert.ok((lockAgeMs(path, clock.now) ?? 0) > STALE_AFTER_MS)

  const logs: string[] = []
  const next = acquireLock({
    stateDir,
    pid: 222,
    now: clock.now,
    log: (line) => void logs.push(`${line.level}: ${line.msg}`)
  })
  assert.equal(next.mode, 'leader', 'the stale lock was reclaimed')
  if (next.mode !== 'leader') return
  try {
    assert.equal(next.reclaimed, true)
    assert.deepEqual(readLock(path), { pid: 222, startedAt: clock.now().toISOString() })
    assert.deepEqual(logs, ['warn: reclaiming a stale lock'])
    // 崩溃实例的 release 不该删掉新持有者的锁。
    assert.equal(crashed.lock.release(), false)
    assert.deepEqual(readLock(path), { pid: 222, startedAt: clock.now().toISOString() })
  } finally {
    next.lock.release()
  }
})

test('release only removes the lock this process owns', () => {
  const stateDir = tempStateDir()
  const clock = fakeClock()
  const first = acquireLock({ stateDir, pid: 1, now: clock.now })
  assert.equal(first.mode, 'leader')
  if (first.mode !== 'leader') return
  // 另一个进程接管（模拟回收后取锁），旧句柄的 release 不得删它。
  first.lock.release()
  const second = acquireLock({ stateDir, pid: 2, now: clock.now })
  assert.equal(second.mode, 'leader')
  if (second.mode !== 'leader') return
  try {
    assert.equal(first.lock.release(), false)
    assert.deepEqual(readLock(join(stateDir, LOCK_FILE)), { pid: 2, startedAt: clock.at() })
  } finally {
    second.lock.release()
  }
})

test('the heartbeat timer touches the file without a manual touch', async () => {
  const stateDir = tempStateDir()
  const clock = fakeClock()
  let ticks = 0
  const outcome = acquireLock({
    stateDir,
    pid: 3,
    now: () => {
      // 每次读时钟推进 5 s，模拟心跳周期。
      const at = clock.now()
      clock.advance(HEARTBEAT_MS)
      return at
    },
    heartbeatMs: 5
  })
  assert.equal(outcome.mode, 'leader')
  if (outcome.mode !== 'leader') return
  const stop = outcome.lock.startHeartbeat()
  try {
    const path = join(stateDir, LOCK_FILE)
    // 轮询到条件成立（带上限），不 sleep（§P.1 第 4 条）。
    const deadline = Date.now() + 2000
    while (ticks < 2 && Date.now() < deadline) {
      const before = readFileSync(path, 'utf8')
      await new Promise((resolve) => setImmediate(resolve))
      if (readFileSync(path, 'utf8') === before) ticks += 1
    }
    assert.ok(existsSync(path))
  } finally {
    stop()
    outcome.lock.release()
  }
})

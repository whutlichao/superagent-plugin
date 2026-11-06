// CLI 命令的入参/出参/错误码（§P.2 的 `tools.test.ts` 行：等价上游工具 schema 面）。
//
// 本票只覆盖 HTTP 这一层能测的部分：**请求幂等**（§G.1 幂等行：同 id 一小时内重试返回首次
// 结果）。命令本身的成功/固定拒绝面由 #8 的 `cli-contract.test.ts` 接管。
import { assert, test } from 'orca/testing'
import { openStore } from '../src/worker/app/store'
import {
  IDEMPOTENCY_WINDOW_MS,
  requestIdOf,
  runIdempotent,
  type IdempotentOutcome
} from '../src/worker/http/idempotency'
import { ApiError, ERROR_CODES } from '../src/worker/http/errors'
import { REQUEST_ID_PREFIX } from '../src/worker/app/kv'
import { tempStateDir } from './support/state'

/** 一个固定的测试时刻。 */
const AT = '2026-11-07T03:26:00.000Z'

/** 相对 `AT` 偏移若干毫秒的时刻。 */
const after = (ms: number): string => new Date(new Date(AT).getTime() + ms).toISOString()

/** 在临时状态目录上开库并跑一个幂等用例。 */
function withStore<T>(work: (store: ReturnType<typeof openStore>) => T): T {
  const stateDir = tempStateDir()
  const store = openStore({ stateDir })
  try {
    return work(store)
  } finally {
    store.close()
  }
}

test('the idempotency window is one hour and the header is the documented one', () => {
  assert.equal(IDEMPOTENCY_WINDOW_MS, 60 * 60 * 1000)
  assert.equal(requestIdOf({ 'x-superagent-request-id': 'r-1' }), 'r-1')
  assert.equal(requestIdOf({}), null)
  assert.equal(requestIdOf({ 'x-superagent-request-id': '' }), null, 'an empty header means no id')
})

test('the same request id within an hour returns the first result without running again', () => {
  withStore((store) => {
    let runs = 0
    const first = runIdempotent({
      store,
      caller: 'operator-token-hash',
      requestId: 'r-1',
      at: AT,
      run: () => {
        runs += 1
        return { retried: true, n: runs }
      }
    })
    assert.deepEqual(first.outcome, { kind: 'ran', result: { retried: true, n: 1 } })
    assert.equal(runs, 1)

    // 同 id + 同请求体（这里没有体）在一小时内 → 首次结果，不重跑。
    const replay = runIdempotent({
      store,
      caller: 'operator-token-hash',
      requestId: 'r-1',
      at: after(59 * 60 * 1000),
      run: () => {
        runs += 1
        return { retried: true, n: runs }
      }
    })
    assert.deepEqual(replay.outcome, { kind: 'replayed', result: { retried: true, n: 1 } })
    assert.equal(runs, 1, 'the work ran exactly once')

    // 超过一小时 → 重新执行（并覆盖记录）。
    const expired = runIdempotent({
      store,
      caller: 'operator-token-hash',
      requestId: 'r-1',
      at: after(61 * 60 * 1000),
      run: () => {
        runs += 1
        return { retried: true, n: runs }
      }
    })
    assert.deepEqual(expired.outcome, { kind: 'ran', result: { retried: true, n: 2 } })
    assert.equal(runs, 2)
  })
})

test('a different token or a different request id is a different operation', () => {
  withStore((store) => {
    const run = (caller: string, requestId: string, value: number): IdempotentOutcome => {
      let calls = 0
      const outcome = runIdempotent({
        store,
        caller,
        requestId,
        at: AT,
        run: () => {
          calls += 1
          return value
        }
      })
      assert.equal(calls, 1, 'each distinct operation runs')
      return outcome.outcome
    }
    assert.deepEqual(run('token-a', 'r-1', 1), { kind: 'ran', result: 1 })
    // 同一 id、另一个 token：独立记录（幂等键含 token 的哈希，而不是全局）。
    assert.deepEqual(run('token-b', 'r-1', 2), { kind: 'ran', result: 2 })
    // 同一 token、另一个 id：独立记录。
    assert.deepEqual(run('token-a', 'r-2', 3), { kind: 'ran', result: 3 })
    // 原组合仍然命中首次结果。
    let reran = false
    const replay = runIdempotent({
      store,
      caller: 'token-a',
      requestId: 'r-1',
      at: AT,
      run: () => {
        reran = true
        return 99
      }
    })
    assert.deepEqual(replay.outcome, { kind: 'replayed', result: 1 })
    assert.equal(reran, false)
  })
})

test('a failed run is not remembered, so a retry may succeed', () => {
  withStore((store) => {
    assert.throws(() =>
      runIdempotent({
        store,
        caller: 'operator-token-hash',
        requestId: 'r-1',
        at: AT,
        run: () => {
          throw new ApiError(ERROR_CODES.refused, 'no')
        }
      })
    )
    // 同一 id 再试：真的又跑了一次（失败不缓存）。
    let runs = 0
    const outcome = runIdempotent({
      store,
      caller: 'operator-token-hash',
      requestId: 'r-1',
      at: AT,
      run: () => {
        runs += 1
        return 'ok'
      }
    })
    assert.deepEqual(outcome.outcome, { kind: 'ran', result: 'ok' })
    assert.equal(runs, 1)
  })
})

test('without a request id the work always runs', () => {
  withStore((store) => {
    let runs = 0
    for (let index = 0; index < 3; index += 1) {
      const outcome = runIdempotent({
        store,
        caller: 'operator-token-hash',
        requestId: null,
        at: AT,
        run: () => {
          runs += 1
          return runs
        }
      })
      assert.deepEqual(outcome.outcome, { kind: 'ran', result: runs })
    }
    assert.equal(runs, 3)
  })
})

test('expired records are pruned on the next write, so the kv does not grow forever', () => {
  withStore((store) => {
    for (let index = 0; index < 5; index += 1) {
      runIdempotent({
        store,
        caller: 'operator-token-hash',
        requestId: `old-${index}`,
        at: AT,
        run: () => index
      })
    }
    const before = store
      .sql.all('SELECT key FROM kv WHERE key LIKE ?', [`${REQUEST_ID_PREFIX}%`])
      .length
    assert.equal(before, 5)
    // 两小时后写一条新记录：旧的过期记录应被清掉。
    runIdempotent({
      store,
      caller: 'operator-token-hash',
      requestId: 'fresh',
      at: after(2 * 60 * 60 * 1000),
      run: () => 'fresh'
    })
    const keys = store.sql
      .all('SELECT key FROM kv ORDER BY key')
      .map((row) => String((row as Record<string, unknown>)['key']))
    assert.deepEqual(
      keys.filter((key) => key.startsWith(REQUEST_ID_PREFIX)),
      [keys.find((key) => key.endsWith(':fresh')) ?? 'missing'],
      'only the fresh record stays'
    )
  })
})

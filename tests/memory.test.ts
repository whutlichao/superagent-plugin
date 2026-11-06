// 内存仓储（§P.1 其三）：只给纯领域单测用，语义与真实仓储一致 —— 克隆隔离、快照回滚（含
// 嵌套）、按 (at, id) 的排序与按 id 的唯一性；单写者纪律：绕过引擎直接写被拒（§D.4）。
//
// 本文件不 import 'orca/testing'：设计 §P.6 要求纯领域与 store 测试能在没有 Orca 的 CI 上跑。
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryRepositories, WriterError } from '../src/worker/core/index.ts'
import type { Decision, Ticket, Trigger } from '../src/worker/core/index.ts'

/** 一条最小 Trigger（同 id 即同一条，幂等由 id 保证）。 */
function trigger(id: string, at: string, thread = 't1'): Trigger {
  return {
    id,
    source: 'chat',
    threads: [{ source: 'chat', id: thread }],
    actor: { source: 'chat', id: 'alice' },
    human: true,
    at,
    text: `message ${id}`,
    meta: {}
  }
}

/** 一张最小 Ticket。 */
function ticket(id: string, createdAt: string): Ticket {
  return {
    id,
    title: id,
    decisionId: `decision-${id}`,
    mandate: {
      strength: 'explicit',
      policyVersion: 'v1',
      basis: { via: 'addressed', addressed: 'mention' },
      actor: { source: 'chat', id: 'alice' },
      scope: 'small'
    },
    channels: [],
    assignments: [],
    inputs: [],
    undelivered: [],
    createdAt,
    updatedAt: createdAt,
    origin: { triggerId: `trigger-${id}`, triggerIds: [`trigger-${id}`] }
  }
}

/** 一条最小 Decision。 */
function decision(id: string, at: string): Decision {
  return {
    id,
    evalId: `eval-${id}`,
    threadKey: 'chat:t1',
    triggerIds: [id],
    policyVersion: 'v1',
    at,
    kind: 'ignore',
    reason: [{ code: 'said', values: { text: 'chatter' } }],
    strength: 'explicit'
  }
}

/** 打开一个可写的内存仓储，并保留仓储本体做只读断言。 */
function store(): { store: MemoryRepositories; repo: ReturnType<MemoryRepositories['claimWriter']> } {
  const opened = new MemoryRepositories()
  return { store: opened, repo: opened.claimWriter() }
}

describe('single writer', () => {
  test('the writer role can be claimed once', () => {
    const opened = new MemoryRepositories()
    opened.claimWriter()
    assert.throws(
      () => opened.claimWriter(),
      (error: unknown) => error instanceof WriterError && error.code === 'writer_taken'
    )
  })

  test('a write outside the engine transaction is refused', () => {
    const { repo } = store()
    assert.throws(
      () => repo.tickets.save(ticket('t1', '2026-09-23T00:00:00.000Z')),
      (error: unknown) => error instanceof WriterError && error.code === 'outside_transaction'
    )
  })

  test('the store itself exposes reads only, so a second writer cannot appear', () => {
    const { store: opened } = store()
    // 读面仍可用（测试断言用）……
    assert.deepEqual(opened.tickets.list(), [])
    // ……但没有写方法可调：写只能经领取到的写者。
    assert.equal('save' in opened.tickets, false)
    assert.equal('atomic' in opened, false)
  })
})

describe('atomic', () => {
  test('commits every write of a transaction', () => {
    const { store: opened, repo } = store()
    repo.atomic(() => {
      repo.triggers.save(trigger('1', '2026-09-23T00:00:01.000Z'))
      repo.tickets.save(ticket('t1', '2026-09-23T00:00:02.000Z'))
    })
    assert.deepEqual(opened.triggers.get('1')?.id, '1')
    assert.deepEqual(opened.tickets.get('t1')?.id, 't1')
  })

  test('restores the snapshot when the work throws', () => {
    const { store: opened, repo } = store()
    assert.throws(
      () =>
        repo.atomic(() => {
          repo.triggers.save(trigger('1', '2026-09-23T00:00:01.000Z'))
          repo.tickets.save(ticket('t1', '2026-09-23T00:00:02.000Z'))
          throw new Error('boom')
        }),
      /boom/
    )
    assert.equal(opened.triggers.get('1'), undefined)
    assert.equal(opened.tickets.get('t1'), undefined)
  })

  test('a nested transaction rolls back only its own writes when its caller recovers', () => {
    const { store: opened, repo } = store()
    repo.atomic(() => {
      repo.tickets.save(ticket('outer', '2026-09-23T00:00:01.000Z'))
      assert.throws(() =>
        repo.atomic(() => {
          repo.tickets.save(ticket('inner', '2026-09-23T00:00:02.000Z'))
          throw new Error('inner')
        })
      )
      assert.deepEqual(opened.tickets.list().map((item) => item.id), ['outer'])
    })
    assert.deepEqual(opened.tickets.list().map((item) => item.id), ['outer'])
  })

  test('a failing outer transaction rolls back what a committed inner one wrote', () => {
    const { store: opened, repo } = store()
    assert.throws(() =>
      repo.atomic(() => {
        repo.atomic(() => {
          repo.tickets.save(ticket('inner', '2026-09-23T00:00:02.000Z'))
        })
        throw new Error('outer')
      })
    )
    assert.deepEqual(opened.tickets.list(), [])
  })
})

describe('records', () => {
  test('reads are clones: mutating a returned record changes nothing stored', () => {
    const { store: opened, repo } = store()
    repo.atomic(() => repo.tickets.save(ticket('t1', '2026-09-23T00:00:01.000Z')))
    const read = opened.tickets.get('t1')!
    read.title = 'mutated'
    read.assignments.push({ id: 'a', state: 'running', createdAt: '2026-09-23T00:00:02.000Z' })
    const again = opened.tickets.get('t1')!
    assert.equal(again.title, 't1')
    assert.deepEqual(again.assignments, [])
  })

  test('an id names one row: saving twice replaces rather than appending', () => {
    const { store: opened, repo } = store()
    repo.atomic(() => {
      repo.triggers.save(trigger('1', '2026-09-23T00:00:01.000Z'))
      repo.triggers.save(trigger('1', '2026-09-23T00:00:05.000Z'))
    })
    assert.equal(opened.triggers.byThread('chat:t1').length, 1)
    assert.equal(opened.triggers.get('1')?.at, '2026-09-23T00:00:05.000Z')
  })

  test('a trigger lands on every thread it belongs to, in (at, id) order', () => {
    const { store: opened, repo } = store()
    repo.atomic(() => {
      repo.triggers.save(trigger('b', '2026-09-23T00:00:02.000Z'))
      repo.triggers.save(trigger('a', '2026-09-23T00:00:02.000Z'))
      repo.triggers.save(trigger('c', '2026-09-23T00:00:01.000Z'))
      repo.triggers.save({
        ...trigger('d', '2026-09-23T00:00:03.000Z'),
        threads: [
          { source: 'chat', id: 't1' },
          { source: 'chat', id: 't2' }
        ]
      })
    })
    assert.deepEqual(opened.triggers.byThread('chat:t1').map((item) => item.id), ['c', 'a', 'b', 'd'])
    assert.deepEqual(opened.triggers.byThread('chat:t2').map((item) => item.id), ['d'])
  })

  test('tickets list newest first, open and active filter as the store does', () => {
    const { store: opened, repo } = store()
    const open = ticket('open', '2026-09-23T00:00:01.000Z')
    open.undelivered = ['i1']
    const ended = ticket('ended', '2026-09-23T00:00:02.000Z')
    ended.ended = { at: '2026-09-23T00:00:03.000Z', by: 'executor', outcome: 'completed' }
    const running = ticket('running', '2026-09-23T00:00:04.000Z')
    running.assignments = [{ id: 'a', state: 'running', createdAt: '2026-09-23T00:00:05.000Z' }]
    repo.atomic(() => {
      repo.tickets.save(open)
      repo.tickets.save(ended)
      repo.tickets.save(running)
    })
    assert.deepEqual(opened.tickets.list().map((item) => item.id), ['running', 'ended', 'open'])
    assert.deepEqual(opened.tickets.open().map((item) => item.id), ['running', 'open'])
    assert.deepEqual(opened.tickets.active().map((item) => item.id), ['running', 'open'])
  })

  test('decisions of a thread read in (at, id) order', () => {
    const { store: opened, repo } = store()
    repo.atomic(() => {
      repo.decisions.save(decision('b', '2026-09-23T00:00:02.000Z'))
      repo.decisions.save(decision('a', '2026-09-23T00:00:02.000Z'))
      repo.decisions.save(decision('c', '2026-09-23T00:00:01.000Z'))
    })
    assert.deepEqual(opened.decisions.byThread('chat:t1').map((item) => item.id), ['c', 'a', 'b'])
    assert.deepEqual(opened.decisions.byThread('chat:t2'), [])
  })

  test('a thread is active while it queues or evaluates triggers', () => {
    const { store: opened, repo } = store()
    const idle: Parameters<typeof repo.threads.save>[0] = {
      key: 'chat:idle',
      ref: { source: 'chat', id: 'idle' },
      createdAt: '2026-09-23T00:00:01.000Z',
      subscriptions: [],
      correlated: [],
      pending: [],
      meta: {}
    }
    repo.atomic(() => {
      repo.threads.save(idle)
      repo.threads.save({ ...idle, key: 'chat:queued', ref: { source: 'chat', id: 'queued' }, pending: ['1'] })
    })
    assert.deepEqual(opened.threads.active().map((item) => item.key), ['chat:queued'])
  })
})

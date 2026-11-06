// Source 写端口（§D.4 第二行）：Source 只经端口写自己的读位置与 Thread 元数据；
// 它拿不到整个 Store，也不能改 `thread.body`。
import { assert, test } from 'orca/testing'
import { createSourceStoragePorts } from '../src/worker/app/source-state'
import { githubCursorKey } from '../src/worker/app/kv'
import { AT, openTempStore } from './support/state'

test('a source reads and writes only its own kv keys through the state port', () => {
  const { store, cleanup } = openTempStore()
  try {
    const ports = createSourceStoragePorts(store)
    assert.equal(ports.state.read(githubCursorKey('n-1')), null)
    ports.state.write(githubCursorKey('n-1'), { seenAt: AT })
    assert.deepEqual(ports.state.read(githubCursorKey('n-1')), { seenAt: AT })
    // 端口背后就是同一个 KV：引擎侧读得到 Source 写的位置。
    assert.deepEqual(store.kvGet(githubCursorKey('n-1')), { seenAt: AT })
    assert.equal(ports.state.delete(githubCursorKey('n-1')), true)
    assert.equal(ports.state.read(githubCursorKey('n-1')), null)
  } finally {
    cleanup()
  }
})

test('a source describes thread meta without touching the thread body', () => {
  const { store, cleanup } = openTempStore()
  try {
    store.threads.put({
      key: 'github:1',
      source: 'github',
      meta: { label: 'old' },
      body: { subscriptions: [{ ticketId: 'ticket-1' }], eval: { id: 'eval-1' } }
    })
    const ports = createSourceStoragePorts(store)
    assert.deepEqual(ports.threads.read('github:1'), { label: 'old' })
    ports.threads.describe('github:1', { label: 'Issue #1', url: 'https://example.test/1' })
    const row = store.threads.get('github:1')
    assert.deepEqual(row?.meta, { label: 'Issue #1', url: 'https://example.test/1' })
    assert.deepEqual(row?.body, { subscriptions: [{ ticketId: 'ticket-1' }], eval: { id: 'eval-1' } })
    assert.equal(row?.active, true, 'the generated columns still follow the body the engine owns')
  } finally {
    cleanup()
  }
})

test('a source cannot invent a thread by describing it', () => {
  const { store, cleanup } = openTempStore()
  try {
    const ports = createSourceStoragePorts(store)
    assert.equal(ports.threads.read('github:404'), null)
    assert.throws(() => ports.threads.describe('github:404', { label: 'nope' }))
    assert.equal(store.threads.get('github:404'), null, 'no thread row was created')
  } finally {
    cleanup()
  }
})

test('the port surface exposes no way to write trigger, ticket or decision rows', () => {
  const { store, cleanup } = openTempStore()
  try {
    const ports = createSourceStoragePorts(store)
    assert.deepEqual(Object.keys(ports).sort(), ['state', 'threads'])
    assert.deepEqual(Object.keys(ports.state).sort(), ['delete', 'read', 'write'])
    assert.deepEqual(Object.keys(ports.threads).sort(), ['describe', 'read'])
  } finally {
    cleanup()
  }
})

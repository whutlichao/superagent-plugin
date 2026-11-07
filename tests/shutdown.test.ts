// 关停屏障（#60）：`boot.shutdown()` 返回之后，状态目录里不该再出现任何写——定时器驱动的轮、
// Router 监督的 launch、HTTP handler 都必须先收尾；临时目录的删除对有界重试幂等（ENOENT 算
// 成功，其余错误原样抛出）。
//
// 观测不用 sleep 判定：先把「关停之后的目录快照」拿到，再轮询到截止时刻，任何一个新条目或
// mtime 变化都算失败；等到截止时刻为止是**观测窗口**，不是掩盖竞态的等待。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentHandle } from '../src/worker/runtime/orca-runtime.ts'
import { openBoot } from './support/boot.ts'
import { removeTree } from './support/state.ts'

/** 一条目录树的读面：相对路径 → `mtimeMs:size`。 */
function treeState(root: string): Map<string, string> {
  const state = new Map<string, string>()
  const walk = (directory: string): void => {
    let names: readonly string[]
    try {
      names = readdirSync(directory)
    } catch {
      return
    }
    for (const name of names) {
      const path = join(directory, name)
      let stamp: string
      let isDirectory = false
      try {
        const stats = statSync(path)
        stamp = `${stats.mtimeMs}:${stats.size}`
        isDirectory = stats.isDirectory()
      } catch {
        continue
      }
      state.set(path.slice(root.length), stamp)
      if (isDirectory) walk(path)
    }
  }
  walk(root)
  return state
}

/** 轮询到截止时刻：没变就是安静；返回第一次看到的差异（没有差异给 `null`）。 */
async function firstChange(root: string, windowMs: number): Promise<string | null> {
  const before = treeState(root)
  const deadline = Date.now() + windowMs
  for (;;) {
    const now = treeState(root)
    for (const [path, stamp] of now) {
      if (!before.has(path)) return `added ${path}`
      if (before.get(path) !== stamp) return `touched ${path}`
    }
    for (const path of before.keys()) if (!now.has(path)) return `removed ${path}`
    if (Date.now() >= deadline) return null
    await new Promise<void>((resolve) => setTimeout(resolve, 1))
  }
}

/** 等到一个条件成立（带截止时刻；超时就说清楚在等什么）。 */
async function waitFor(what: string, condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for: ${what}`)
    await new Promise<void>((resolve) => setTimeout(resolve, 1))
  }
}

/** 关停之后的观测窗口：目录不新增、不改动（§N.1 的关停屏障）。 */
async function assertQuiet(root: string): Promise<void> {
  assert.equal(await firstChange(root, 200), null, 'the state dir stayed untouched after shutdown')
}

test('a plain shutdown leaves the state directory untouched', async () => {
  const h = await openBoot()
  try {
    await h.handle.pollOnce()
    await h.handle.passOnce()
    await h.handle.passOnce()
    await h.handle.passOnce()
    await h.handle.shutdown()
    await assertQuiet(h.stateDir)
  } finally {
    await h.cleanup()
  }
})

test('shutdown waits for an in-flight router restart instead of resolving under it', async () => {
  const h = await openBoot()
  let release!: (handle: AgentHandle) => void
  const gate = new Promise<AgentHandle>((resolve) => {
    release = resolve
  })
  h.runtime.script.launchAgent = () => gate
  try {
    // 组合根启动时已经 launch 过一次 Router；这次显式重启还要再 launch 一次，卡在假缝上。
    const launches = h.runtime.calls.launchAgent.length
    const restarting = h.handle.restartRouter()
    await waitFor('the restart reached the launch seam', () => h.runtime.calls.launchAgent.length > launches)

    const stopping = h.handle.shutdown()
    // 关停不能越过这个还在跑的 launch：抢在它前面返回就是「返回后还有写者」。
    const raced = await Promise.race([
      stopping.then(() => 'resolved' as const),
      new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 50))
    ])
    assert.equal(raced, 'waiting', 'shutdown does not resolve while the router launch is in flight')

    release({ terminalId: 'term_router_2', workspaceId: 'ws:superagent-router', launchedAt: 2 })
    await restarting
    await stopping
    await assertQuiet(h.stateDir)
  } finally {
    await h.cleanup()
  }
})

test('the bounded delete treats a missing path as done', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'superagent-remove-'))
  try {
    await removeTree(join(parent, 'never-existed'))
    assert.equal(existsSync(join(parent, 'never-existed')), false)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('the bounded delete retries a racing writer and still fails loudly at the end', async () => {
  const transient = (): Error => Object.assign(new Error('Directory not empty'), { code: 'ENOTEMPTY' })

  const parent = mkdtempSync(join(tmpdir(), 'superagent-remove-'))
  try {
    // 前两次撞上 ENOTEMPTY（有写者在目录被读空之后又写了新文件），第三次成功。
    const target = join(parent, 'raced')
    mkdirSync(target, { recursive: true })
    let attempts = 0
    await removeTree(target, {
      delayMs: 0,
      remove: (target_: string) => {
        attempts += 1
        if (attempts < 3) throw transient()
        rmSync(target_, { recursive: true, force: true })
      }
    })
    assert.equal(attempts, 3, 'the retry loop kept trying until the race cleared')
    assert.equal(existsSync(target), false)

    // 一直撞：重试用尽之后原样抛出（绝不吞掉）。
    let exhausted = 0
    await assert.rejects(
      removeTree(join(parent, 'always'), {
        attempts: 4,
        delayMs: 0,
        remove: () => {
          exhausted += 1
          throw transient()
        }
      }),
      (error: unknown) => (error as { code?: string }).code === 'ENOTEMPTY'
    )
    assert.equal(exhausted, 4, 'the retry loop is bounded')

    // 别的错误不是竞态：第一次就抛出来，不做无意义的退避。
    let other = 0
    await assert.rejects(
      removeTree(join(parent, 'denied'), {
        delayMs: 0,
        remove: () => {
          other += 1
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
        }
      }),
      (error: unknown) => (error as { code?: string }).code === 'EACCES'
    )
    assert.equal(other, 1, 'only a racing delete is retried')
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

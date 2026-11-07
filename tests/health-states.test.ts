// 健康状态集合（§J.3、§N.4）：设计把 health 条目钉成 `starting | ready | paused | error`。
// 这张表曾经漂过一次——#9 的 `core/ports.ts` 写成 `ready | warning | error`，#10 的注册表
// 只好跟着它，面板与 HTTP 又各写一份。本文件钉住三件事，让下一次漂移先在这里炸：
//
// 1. 领域码表（`HEALTH_STATES`）逐字就是设计的四档，且 `warning` 不在其中；
// 2. 每个值都能从健康板写进去、再经面板状态视图（`stateView` → `health`）原样读出来；
// 3. 面板把健康状态渲染成自己的标记（`sourceMark`）时，四档各有措辞，`warning` 不是状态。
//
// 断言面只用公开查询：`SourceRegistry` 的 `overview()` / `healthEntries()`、`http/state.ts`
// 的 `stateView()`、`panel/marks.ts` 的 `sourceMark()`。
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { HEALTH_STATES, type HealthState } from '../src/worker/core/index.ts'
import { SourceRegistry, SOURCES_HEALTH_ENTRY } from '../src/worker/sources/registry.ts'
import type { SourceKind } from '../src/worker/sources/kind.ts'
import { stateView, defaultHealth, type HealthEntry } from '../src/worker/http/state.ts'
import { sourceMark } from '../src/panel/marks.ts'
import { number, object, string } from '../src/worker/infra/schema.ts'
import { FakeHealthBoard } from './support/health-board.ts'
import { openTempStore, AT } from './support/state.ts'

/** 设计 §J.3 的原话：`state ∈ starting|ready|paused|error`。 */
const DESIGN_STATES = ['starting', 'ready', 'paused', 'error'] as const

/** 一条声明单个 health 条目的探针 kind（其余项按必填下限给）。 */
const probeSchema = object({ label: string().default('probe'), interval: number().int().min(1).default(5) })

const probe: SourceKind<ReturnType<typeof probeSchema.parse>> = {
  kind: 'probe',
  title: { zh: '探针', en: 'Probe' },
  description: { zh: '测试用', en: 'For tests' },
  schema: probeSchema,
  fields: [],
  health: ['probe']
}

/** 一份只关心 health 的最小设置视图。 */
const settingsOf = (sources: Record<string, { enabled: boolean; config: Record<string, unknown> }>) => ({
  sources,
  policy: { sources: {} }
})

describe('the health state set is the design set', () => {
  test('HEALTH_STATES is exactly starting | ready | paused | error, in design order', () => {
    assert.deepEqual([...HEALTH_STATES], [...DESIGN_STATES])
    assert.equal(new Set(HEALTH_STATES).size, HEALTH_STATES.length, 'no duplicates')
  })

  test('warning is not a health state', () => {
    // §J.3：warning 是面板的语气（`MarkTone`）与 `detail` 的措辞，不是健康板的第四档。
    assert.equal((HEALTH_STATES as readonly string[]).includes('warning'), false)
  })

  test('the dev-time type admits the design four and refuses warning', () => {
    // 类型层面钉死：`warning` 不是 `HealthState`。下一张票若把它加回去，这行会变成
    // 「未使用的 @ts-expect-error」而让 `tsc` 直接失败——比运行期的集合检查更早。
    const accepted: HealthState[] = ['starting', 'ready', 'paused', 'error']
    assert.deepEqual(accepted, [...DESIGN_STATES])
    // @ts-expect-error §J.3: warning 是面板语气与 detail 措辞，不是健康状态
    const warned: HealthState = 'warning'
    assert.equal(typeof warned, 'string')
    const refused: string[] = ['warning', 'ok', 'degraded', '']
    assert.deepEqual(
      refused.filter((value) => (HEALTH_STATES as readonly string[]).includes(value)),
      []
    )
  })
})

describe('every state survives a write to the health board and a read through the state view', () => {
  /**
   * 健康板（`core/ports.ts` 的 `HealthEntry`：状态 + 明细）→ `GET state` 的 health 段
   * （多一个读数时刻 `at`）。真正的桥由 #45 的 HealthBoard 写者接上；这里用同一份最小
   * 适配把「写进去的状态」原样送到状态视图，证明这条链路上没有第五档状态。
   */
  const boardAsStateHealth = (
    entries: Readonly<Record<string, { state: HealthState; detail?: string }>>
  ): Readonly<Record<string, HealthEntry>> =>
    Object.fromEntries(
      Object.entries(entries).map(([name, entry]) => [
        name,
        { state: entry.state, ...(entry.detail === undefined ? {} : { detail: entry.detail }), at: AT }
      ])
    )

  /** 建一个真库 + 一份最小宿主，`health` 端口直接回健康板上读到的条目。 */
  const viewOf = (health: () => Readonly<Record<string, HealthEntry>>) => {
    const { store, stateDir, cleanup } = openTempStore()
    try {
      return {
        state: stateView(
          { store, stateDir, health, startedAt: AT },
          { host: '127.0.0.1', port: 3847, requests: 0 },
          AT
        ),
        cleanup
      }
    } catch (error) {
      cleanup()
      throw error
    }
  }

  test('a kind writes each of the four states and the panel state view reads it back', () => {
    for (const state of DESIGN_STATES) {
      const board = new FakeHealthBoard()
      const sources = new SourceRegistry({
        settings: () => settingsOf({ probe: { enabled: true, config: {} } }),
        health: board
      })
      sources.register(probe)
      // 经 kind 注册时拿到的 claim 写——这就是生产里 Source 报告的路径。
      const claim = sources.healthEntries(['probe']).get('probe')
      assert.ok(claim !== undefined, `${state}: the kind claimed its entry`)
      claim.set({ state, detail: `reported ${state}` })

      const { state: view, cleanup } = viewOf(() => boardAsStateHealth(board.entries))
      try {
        assert.deepEqual(view.health['probe'], {
          state,
          detail: `reported ${state}`,
          at: AT
        })
        // 总览把同一份读数翻成面板生命周期：四档都能表达。
        assert.equal(
          sources.overview().find((row) => row.id === 'probe')?.state,
          state,
          `${state}: the overview speaks the same four states`
        )
      } finally {
        cleanup()
      }
    }
  })

  test('the registry starts the sources overview entry as starting until the first read', () => {
    // 「已 claim、还没报告过」= starting；第一次 `overview()` 之后才有真读数，而它的读数
    // 来自各方条目——probe 还没报告过，所以总览诚实地留在 starting，直到有一次成功。
    const board = new FakeHealthBoard()
    const sources = new SourceRegistry({
      settings: () => settingsOf({ probe: { enabled: true, config: {} } }),
      health: board
    })
    assert.deepEqual(board.entries[SOURCES_HEALTH_ENTRY], {
      state: 'starting',
      detail: 'Not measured yet'
    })
    sources.register(probe)
    sources.overview()
    assert.equal(
      board.entries[SOURCES_HEALTH_ENTRY]?.state,
      'starting',
      'a source that has not reported keeps the overview at starting'
    )
    sources.healthEntries(['probe']).get('probe')?.set({ state: 'ready', detail: 'polled once' })
    sources.overview()
    assert.equal(board.entries[SOURCES_HEALTH_ENTRY]?.state, 'ready', 'the first success clears starting')
  })

  test('a paused source is paused, and ready comes back after a success', () => {
    // Source 自己暂停或关闭时它不在跑：条目报 paused；重新跑起来后的第一次成功报 ready。
    // 注意处理暂停（§K.6）不是这一档：暂停期间 Sources 仍照常记录 Trigger。
    const board = new FakeHealthBoard()
    const sources = new SourceRegistry({
      settings: () => settingsOf({ probe: { enabled: true, config: {} } }),
      health: board
    })
    sources.register(probe)
    const claim = sources.healthEntries(['probe']).get('probe')
    claim?.set({ state: 'paused', detail: 'processing is paused' })
    assert.equal(sources.overview().find((row) => row.id === 'probe')?.state, 'paused')
    assert.equal(board.entries[SOURCES_HEALTH_ENTRY]?.state, 'paused')
    claim?.set({ state: 'ready', detail: 'polled once' })
    assert.equal(sources.overview().find((row) => row.id === 'probe')?.state, 'ready')
    assert.equal(board.entries[SOURCES_HEALTH_ENTRY]?.state, 'ready')
  })

  test('error outranks paused and starting in the overview, and clears on the next success', () => {
    // §J.3 / §N.4：连续 3 次失败才报 error，直到有一次成功；这里只钉「读法」。
    const board = new FakeHealthBoard()
    const sources = new SourceRegistry({
      settings: () => settingsOf({ probe: { enabled: true, config: {} } }),
      health: board
    })
    sources.register(probe)
    const claim = sources.healthEntries(['probe']).get('probe')
    claim?.set({ state: 'error', detail: 'failed 3 times' })
    assert.equal(sources.overview().find((row) => row.id === 'probe')?.state, 'error')
    assert.equal(board.entries[SOURCES_HEALTH_ENTRY]?.state, 'error')
    claim?.set({ state: 'ready', detail: 'recovered' })
    assert.equal(sources.overview().find((row) => row.id === 'probe')?.state, 'ready')
    assert.equal(board.entries[SOURCES_HEALTH_ENTRY]?.state, 'ready')
  })

  test('the shipped default health is one of the four states, not a fifth', () => {
    const health = defaultHealth({ host: '127.0.0.1', port: 3847, requests: 0 }, AT)
    for (const entry of Object.values(health)) {
      assert.ok(
        (DESIGN_STATES as readonly string[]).includes(entry.state),
        `${entry.state} is one of the design's four`
      )
    }
  })
})

describe('the panel renders each health state as its own mark', () => {
  test('all four health states have a panel mark, and warning is only a tone', () => {
    const marks = DESIGN_STATES.map((state) => {
      const mark = sourceMark(state)
      return [state, mark.labelKey, mark.tone] as const
    })
    assert.deepEqual(marks, [
      ['starting', 'source.starting', 'accent'],
      ['ready', 'source.ready', 'success'],
      ['paused', 'source.paused', 'warning'],
      ['error', 'source.error', 'danger']
    ])
    // `warning` 在这里只以语气出现：它是 pause 那一档的语气，不是第六个状态。
    assert.equal(
      (DESIGN_STATES as readonly string[]).some((state) => String(state) === 'warning'),
      false
    )
  })
})

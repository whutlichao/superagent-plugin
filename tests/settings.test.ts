// 设置保存（§K.8、§D.3、§N.2）：来源规则（origin）、写前校验与版本记账。
//
// 断言面：`SettingsError.code`（`origin_forbidden` / `invalid_settings` / `conflict`）、
// 真库里的 `settings_version` 行与 KV 记账，以及「拒绝时什么都没写」。
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createSettings, SETUP_FIELDS, SettingsError } from '../src/worker/app/settings.ts'
import type { SettingsPolicyPort } from '../src/worker/app/settings.ts'
import {
  SETTINGS_REVISION_KEY,
  settingsBlockRevisionKey,
  settingsVersionKey
} from '../src/worker/app/kv.ts'
import { number, object } from '../src/worker/infra/schema.ts'
import { openTempStore, AT } from './support/state.ts'

/** 一个固定的 Policy 接线：簿记测试只关心「保存时记了什么」，不关心哈希怎么算。 */
function fixedPolicy(): SettingsPolicyPort {
  return {
    version: () => 'abc123def456',
    effects: () => new Map(),
    apply: () => undefined
  }
}

/** 一个可用的设置块校验器（真实模块用 policy/schema 或 kind 的 schema，这里只要一个能失败的）。 */
const evalBlock = object({
  timeoutSeconds: number().int().min(30).max(600)
}).strict()

/** 断言一个保存被拒，并返回那个错误。 */
function refusal(work: () => unknown): SettingsError {
  try {
    work()
  } catch (error) {
    assert.equal(error instanceof SettingsError, true, String(error))
    return error as SettingsError
  }
  throw new Error('expected the save to be refused')
}

describe('settings origin rules', () => {
  test('only the panel or the operator may change a setup field', () => {
    const { store, cleanup } = openTempStore()
    try {
      const settings = createSettings({ store, now: () => AT })
      for (const origin of ['tool', 'sync'] as const) {
        for (const field of SETUP_FIELDS) {
          const refused = refusal(() =>
            settings.save({ block: 'executor', origin, value: { [field]: '/somewhere' } })
          )
          assert.equal(refused.code, 'origin_forbidden', `${origin} ${field}`)
        }
      }
      // 嵌在 Source 配置里也算（`cli` / `repository` 属于账号类字段）。
      const nested = refusal(() =>
        settings.save({
          block: 'source:github',
          origin: 'tool',
          value: { enabled: true, config: { repository: 'acme/widgets', cli: 'gh-agent' } }
        })
      )
      assert.equal(nested.code, 'origin_forbidden')
      // 拒绝时一行都没写。
      assert.equal(store.kvGet(SETTINGS_REVISION_KEY), null)
      assert.equal(store.settingsVersions.latest(), null)
      // panel 与 operator 可以改同样的字段（值不同，否则第二次是无改动保存），并且审计
      // 如实记下是谁动的手（§K.8 的四种来源；schema v2 起 CHECK 收 operator）。
      for (const origin of ['panel', 'operator'] as const) {
        const saved = settings.save({
          block: 'executor',
          origin,
          value: { baseRepo: `acme/${origin}` }
        })
        assert.equal(saved.origin, origin)
        assert.equal(store.settingsVersions.byRevision(saved.revision)?.origin, origin)
      }
    } finally {
      cleanup()
    }
  })

  test('a tool origin may still change an ordinary block', () => {
    const { store, cleanup } = openTempStore()
    try {
      const settings = createSettings({ store, now: () => AT })
      const saved = settings.save({ block: 'eval', origin: 'tool', value: { timeoutSeconds: 120 } })
      assert.deepEqual(saved.config, { timeoutSeconds: 120 })
    } finally {
      cleanup()
    }
  })
})

describe('settings validation', () => {
  test('validates before writing and refuses the whole save on any issue', () => {
    const { store, cleanup } = openTempStore()
    try {
      const settings = createSettings({ store, now: () => AT })
      const refused = refusal(() =>
        settings.save({
          block: 'eval',
          origin: 'panel',
          value: { timeoutSeconds: 5 },
          validate: (value: unknown) => evalBlock.safeParse(value)
        })
      )
      assert.equal(refused.code, 'invalid_settings')
      assert.deepEqual(refused.issues, [
        { path: ['timeoutSeconds'], message: 'expected at least 30' }
      ])
      // 全有或全无：库里的版本与历史都没动。
      assert.equal(store.kvGet(SETTINGS_REVISION_KEY), null)
      assert.equal(store.settingsVersions.latest(), null)
      // 同一份数据修正后可以保存。
      const saved = settings.save({
        block: 'eval',
        origin: 'panel',
        value: { timeoutSeconds: 120 },
        validate: (value: unknown) => evalBlock.safeParse(value)
      })
      assert.equal(saved.revision, 1)
    } finally {
      cleanup()
    }
  })

  test('a stale base revision is refused without writing', () => {
    const { store, cleanup } = openTempStore()
    try {
      const settings = createSettings({ store, now: () => AT })
      settings.save({ block: 'eval', origin: 'panel', value: { timeoutSeconds: 120 } })
      settings.save({ block: 'eval', origin: 'panel', value: { timeoutSeconds: 300 } })
      const refused = refusal(() =>
        settings.save({
          block: 'eval',
          origin: 'panel',
          value: { timeoutSeconds: 600 },
          expectedRevision: 1
        })
      )
      assert.equal(refused.code, 'conflict')
      assert.equal(settings.blockRevision('eval'), 2)
      assert.deepEqual(store.settingsVersions.latest()?.config, { timeoutSeconds: 300 })
    } finally {
      cleanup()
    }
  })
})

describe('settings version bookkeeping', () => {
  test('records the revision, the block revision and the snapshot with its origin', () => {
    const { store, cleanup } = openTempStore()
    try {
      const settings = createSettings({ store, now: () => AT, policy: fixedPolicy() })
      assert.equal(settings.revision(), 0)
      assert.equal(settings.block('policy'), undefined)

      const first = settings.save({
        block: 'policy',
        origin: 'panel',
        value: { acceptMode: 'observe' }
      })
      assert.deepEqual(first, {
        block: 'policy',
        revision: 1,
        predecessor: null,
        at: AT,
        origin: 'panel',
        config: { acceptMode: 'observe' },
        policyVersion: 'abc123def456',
        changed: true,
        affectedTickets: []
      })
      assert.deepEqual(store.settingsVersions.byRevision(1), {
        revision: 1,
        predecessor: null,
        at: AT,
        origin: 'panel',
        block: 'policy',
        config: { acceptMode: 'observe' },
        policyVersion: 'abc123def456'
      })
      assert.deepEqual(store.kvGet(settingsVersionKey(1)), {
        at: AT,
        origin: 'panel',
        block: 'policy',
        policyVersion: 'abc123def456',
        affectedTickets: []
      })
      assert.equal(store.kvGet(SETTINGS_REVISION_KEY), 1)
      assert.equal(store.kvGet(settingsBlockRevisionKey('policy')), 1)
      const { changed: _changed, affectedTickets: _affected, ...stored } = first
      assert.deepEqual(settings.block('policy'), stored)

      const second = settings.save({ block: 'policy', origin: 'tool', value: { acceptMode: 'auto' } })
      assert.equal(second.revision, 2)
      assert.equal(second.predecessor, 1)
      assert.equal(second.policyVersion, 'abc123def456', 'the version is the content hash, not the caller\'s word')
      assert.equal(settings.blockRevision('policy'), 2)
      assert.equal(settings.revision(), 2)
    } finally {
      cleanup()
    }
  })

  test('a save with no change records no new revision', () => {
    const { store, cleanup } = openTempStore()
    try {
      const settings = createSettings({ store, now: () => AT })
      settings.save({ block: 'eval', origin: 'panel', value: { timeoutSeconds: 120 } })
      const again = settings.save({ block: 'eval', origin: 'panel', value: { timeoutSeconds: 120 } })
      assert.equal(again.changed, false)
      assert.equal(again.revision, 1)
      assert.equal(settings.revision(), 1)
      assert.equal(store.settingsVersions.byRevision(2), null)
    } finally {
      cleanup()
    }
  })
})

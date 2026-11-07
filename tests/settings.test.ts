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
import { number, object, string } from '../src/worker/infra/schema.ts'
import { createSettingsHandlers } from '../src/worker/http/settings.ts'
import { ApiError } from '../src/worker/http/errors.ts'
import {
  EXECUTOR_BLOCK_SCHEMA,
  accountCandidatesIn,
  hasAccountCandidates,
  validateSettingsBlock
} from '../src/worker/app/settings-blocks.ts'
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

  test('a write notifies the saved hook only when it really wrote a version', () => {
    const { store, cleanup } = openTempStore()
    try {
      const seen: string[] = []
      const settings = createSettings({
        store,
        now: () => AT,
        saved: (record) => seen.push(`${record.block}@${record.revision}`)
      })
      // 开关保存（§M.2）：组合根在这里把新状态交给 Source 运行时。
      settings.save({ block: 'source:github', origin: 'panel', value: { enabled: false } })
      assert.deepEqual(seen, ['source:github@1'])
      // 没有改动（面板重复保存同一个值）：不写版本，也不通知（不该白白降级健康）。
      settings.save({ block: 'source:github', origin: 'panel', value: { enabled: false } })
      assert.deepEqual(seen, ['source:github@1'])
      // 被拒的保存：同样不通知。
      refusal(() => settings.save({ block: 'executor', origin: 'tool', value: { stateDir: '/x' } }))
      assert.deepEqual(seen, ['source:github@1'])
      // 真的改了：通知一次。
      settings.save({ block: 'source:github', origin: 'panel', value: { enabled: true } })
      assert.deepEqual(seen, ['source:github@1', 'source:github@2'])
    } finally {
      cleanup()
    }
  })
})

// ---------------------------------------------------------------- 命令面（#56）

/**
 * 命令面的 handler 夹具：**真库**（`openTempStore`）+ 真写入器（#20）+ 注入的端口。
 * 断言面是 `ApiError.code` 与库里的行——不是文案。
 */
function surface(
  options: {
    readonly checkAccount?: Parameters<typeof createSettingsHandlers>[0]['checkAccount']
    readonly policySync?: Parameters<typeof createSettingsHandlers>[0]['policySync']
  } = {}
) {
  const { store, cleanup } = openTempStore()
  const handlers = createSettingsHandlers({
    settings: createSettings({ store, now: () => AT, policy: fixedPolicy() }),
    // eval 块用本文件上面的窄 schema（30–600 秒），其余块走缺省的 strict 形状。
    validate: (name) =>
      name === 'eval' ? (value: unknown) => evalBlock.safeParse(value) : undefined,
    blocks: () => ['policy', 'eval', 'executor', 'source:github'],
    effective: (name) => (name === 'executor' ? { maxWorkers: 2 } : {}),
    ...options
  })
  const call = async (
    key: string,
    input: { params?: Record<string, string>; query?: Record<string, string>; body?: unknown } = {}
  ) => {
    const handler = handlers.get(key)
    assert.ok(handler, `${key} is wired`)
    // `async` 把同步拒绝也变成 rejection：信封层的固定码是唯一的断言面。
    return handler({
      params: input.params ?? {},
      query: input.query ?? {},
      body: input.body,
      caller: { role: 'operator' },
      at: AT,
      requestId: null
    })
  }
  return { store, handlers, call, cleanup }
}

/** 断言一次调用被固定码拒绝（信封层：`ApiError` 的 code 与状态码）。 */
async function apiRefusal(work: Promise<unknown>): Promise<ApiError> {
  try {
    await work
  } catch (error) {
    assert.equal(error instanceof ApiError, true, String(error))
    return error as ApiError
  }
  throw new Error('expected the call to be refused')
}

describe('settings block shapes (§K.8)', () => {
  test('the executor block is strict and bounded', () => {
    assert.equal(EXECUTOR_BLOCK_SCHEMA.safeParse({ maxWorkers: 2, confirmDelivery: true }).success, true)
    // 未知键、越界与类型错误都拒绝（strict）。
    for (const value of [{ nope: 1 }, { maxWorkers: 0 }, { maxWorkers: 2.5 }, { confirmDelivery: 'yes' }]) {
      assert.equal(EXECUTOR_BLOCK_SCHEMA.safeParse(value).success, false, JSON.stringify(value))
    }
  })

  test('a source block validates its config with the kind schema and prefixes the issues', () => {
    const githubConfig = object({ repository: string(), cli: string() }).strict()
    const parsed = validateSettingsBlock(
      'source:github',
      { enabled: true, config: { repository: 'acme/widgets', cli: 'gh' } },
      { sourceConfig: () => (value) => githubConfig.safeParse(value) }
    )
    assert.equal(parsed?.success, true)
    // config 的 issues 落到 `config.<key>`：面板与 CLI 读的是同一条路径。
    const bad = validateSettingsBlock(
      'source:github',
      { config: { repository: 'acme/widgets' } },
      { sourceConfig: () => (value) => githubConfig.safeParse(value) }
    )
    assert.equal(bad?.success, false)
    if (bad !== undefined && !bad.success) {
      assert.deepEqual(bad.issues, [{ path: ['config', 'cli'], message: 'expected string' }])
    }
    // 认不出的块名是 undefined（调用方按 missing / invalid_value 拒绝）。
    assert.equal(validateSettingsBlock('nope', {}), undefined)
  })

  test('account candidates are found anywhere in a block, nested config included', () => {
    assert.deepEqual(accountCandidatesIn({ config: { repository: 'acme/widgets', cli: 'gh' } }), {
      repository: 'acme/widgets',
      cli: 'gh'
    })
    assert.deepEqual(accountCandidatesIn({ maxWorkers: 2 }), {})
    assert.equal(hasAccountCandidates({ nested: [{ cli: 'gh-agent' }] }), true)
  })
})

describe('settings save over the command surface (§K.8)', () => {
  test('saves an ordinary block at its base revision; a stale base revision is refused', async () => {
    const h = surface()
    try {
      const first = (await h.call('PUT settings/:block', {
        params: { block: 'eval' },
        body: { value: { timeoutSeconds: 120 }, revision: 0, origin: 'tool' }
      })) as Record<string, unknown>
      assert.deepEqual(first, {
        block: 'eval',
        revision: 1,
        settings_revision: 1,
        policy_changed: false,
        restarting: false,
        changed: true,
        origin: 'tool'
      })
      const stale = await apiRefusal(
        h.call('PUT settings/:block', {
          params: { block: 'eval' },
          body: { value: { timeoutSeconds: 300 }, revision: 0, origin: 'tool' }
        })
      )
      assert.equal(stale.code, 'stale_revision')
      assert.equal(stale.status, 400, '§G.3 maps stale_revision to 400')
      // 拒绝没有写第二个版本：库里仍是第一次那份。
      assert.deepEqual(h.store.settingsVersions.latest()?.config, { timeoutSeconds: 120 })
    } finally {
      h.cleanup()
    }
  })

  test('an invalid value is invalid_value with issues[], and nothing is written', async () => {
    const h = surface()
    try {
      const refused = await apiRefusal(
        h.call('PUT settings/:block', {
          params: { block: 'eval' },
          body: { value: { timeoutSeconds: 5 }, revision: 0, origin: 'tool' }
        })
      )
      assert.equal(refused.code, 'invalid_value')
      assert.deepEqual(refused.issues, [{ path: 'timeoutSeconds', message: 'expected at least 30' }])
      assert.equal(h.store.kvGet(SETTINGS_REVISION_KEY), null)
      assert.equal(h.store.settingsVersions.latest(), null)
      // 认不出的块名同样是固定拒绝，且带字段级 issue。
      const unknown = await apiRefusal(
        h.call('PUT settings/:block', { params: { block: 'nope' }, body: { value: {}, revision: 0 } })
      )
      assert.equal(unknown.code, 'invalid_value')
      assert.equal(unknown.issues?.[0]?.path, 'block')
    } finally {
      h.cleanup()
    }
  })

  test('a tool origin may not change a setup field', async () => {
    const h = surface()
    try {
      const refused = await apiRefusal(
        h.call('PUT settings/:block', {
          params: { block: 'executor' },
          body: { value: { baseRepo: '/repos/widgets' }, revision: 0, origin: 'tool' }
        })
      )
      assert.equal(refused.code, 'origin_forbidden')
      assert.equal(refused.status, 403)
      assert.equal(h.store.settingsVersions.latest(), null)
    } finally {
      h.cleanup()
    }
  })

  test('a failing account-field setup check refuses with setup_failed and leaves the database unchanged', async () => {
    const seen: { cli?: string; repository?: string }[] = []
    const h = surface({
      checkAccount: async (candidate) => {
        seen.push(candidate)
        return [
          {
            place: 'github',
            code: 'account_unreadable',
            kind: 'missing',
            detail: 'the agent GitHub CLI cannot read its account',
            fix: 'sign in as the agent account: gh auth login',
            checkAgain: 'superagent setup check'
          }
        ]
      }
    })
    try {
      const refused = await apiRefusal(
        h.call('PUT settings/:block', {
          params: { block: 'source:github' },
          body: {
            value: { enabled: true, config: { repository: 'acme/widgets', cli: 'gh-agent' } },
            revision: 0,
            origin: 'panel'
          }
        })
      )
      assert.equal(refused.code, 'setup_failed')
      assert.equal(refused.status, 400, 'a failed account check is a fixed refusal (400)')
      // 检查用的是**候选值**，不是旧设置。
      assert.deepEqual(seen, [{ repository: 'acme/widgets', cli: 'gh-agent' }])
      // 库一点没动：没有版本、没有历史、没有块修订号。
      assert.equal(h.store.kvGet(SETTINGS_REVISION_KEY), null)
      assert.equal(h.store.settingsVersions.latest(), null)
      assert.equal(h.store.kvGet(settingsBlockRevisionKey('source:github')), null)
    } finally {
      h.cleanup()
    }
  })

  test('an unchanged account field skips the setup check (only a change re-probes)', async () => {
    const { store, cleanup } = openTempStore()
    const checked: unknown[] = []
    const config = object({ repository: string(), cli: string(), pollSeconds: number() }).strict()
    const handlers = createSettingsHandlers({
      settings: createSettings({ store, now: () => AT, policy: fixedPolicy() }),
      validate: (name) =>
        name === 'source:github' ? (value: unknown) => config.safeParse(value) : undefined,
      blocks: () => ['policy', 'eval', 'executor', 'source:github'],
      effective: () => ({}),
      checkAccount: async (candidate) => {
        checked.push(candidate)
        return []
      }
    })
    const call = async (body: unknown): Promise<unknown> => {
      const handler = handlers.get('PUT settings/:block')
      assert.ok(handler)
      return handler({
        params: { block: 'source:github' },
        query: {},
        body,
        caller: { role: 'operator' },
        at: AT,
        requestId: null
      })
    }
    try {
      await call({
        value: { repository: 'acme/widgets', cli: 'gh', pollSeconds: 60 },
        revision: 0,
        origin: 'panel'
      })
      assert.equal(checked.length, 1, 'a new account field is checked')
      // 只改轮询间隔：账号字段没变，不再跑探针。
      await call({
        value: { repository: 'acme/widgets', cli: 'gh', pollSeconds: 120 },
        revision: 1,
        origin: 'panel'
      })
      assert.equal(checked.length, 1, 'an unchanged account field is not re-probed')
      // 改了就再检查一次。
      await call({
        value: { repository: 'acme/widgets', cli: 'gh-agent', pollSeconds: 120 },
        revision: 2,
        origin: 'panel'
      })
      assert.equal(checked.length, 2, 'a changed account field is checked again')
      assert.deepEqual(checked.at(-1), { repository: 'acme/widgets', cli: 'gh-agent' })
    } finally {
      cleanup()
    }
  })

  test('an account-field save that passes the setup check is written', async () => {
    const h = surface({ checkAccount: async () => [] })
    try {
      const saved = (await h.call('PUT settings/:block', {
        params: { block: 'source:github' },
        body: {
          value: { enabled: true, config: { repository: 'acme/widgets', cli: 'gh' } },
          revision: 0,
          origin: 'panel'
        }
      })) as Record<string, unknown>
      assert.equal(saved['revision'], 1)
      assert.equal(saved['settings_revision'], 1)
      assert.equal(saved['origin'], 'panel')
      assert.deepEqual(h.store.settingsVersions.latest()?.config, {
        enabled: true,
        config: { repository: 'acme/widgets', cli: 'gh' }
      })
    } finally {
      h.cleanup()
    }
  })

  test('settings get reads one block or all of them, and an unknown block is missing', async () => {
    const h = surface()
    try {
      await h.call('PUT settings/:block', {
        params: { block: 'eval' },
        body: { value: { timeoutSeconds: 120 }, revision: 0, origin: 'tool' }
      })
      const single = (await h.call('GET settings', { query: { block: 'eval' } })) as {
        readonly revision: number
        readonly blocks: readonly Record<string, unknown>[]
      }
      assert.equal(single.revision, 1)
      assert.equal(single.blocks.length, 1)
      assert.equal(single.blocks[0]?.['block'], 'eval')
      assert.equal(single.blocks[0]?.['revision'], 1, 'the block revision is what --revision carries')
      assert.deepEqual(single.blocks[0]?.['value'], { timeoutSeconds: 120 })
      assert.equal((single.blocks[0]?.['saved'] as Record<string, unknown>)['origin'], 'tool')
      const all = (await h.call('GET settings')) as { readonly blocks: readonly Record<string, unknown>[] }
      assert.deepEqual(all.blocks.map((block) => block['block']), ['policy', 'eval', 'executor', 'source:github'])
      const missing = await apiRefusal(h.call('GET settings', { query: { block: 'nope' } }))
      assert.equal(missing.code, 'missing')
    } finally {
      h.cleanup()
    }
  })

  test('the history read lists the versions newest first', async () => {
    const h = surface()
    try {
      for (const seconds of [120, 300]) {
        await h.call('PUT settings/:block', {
          params: { block: 'eval' },
          body: { value: { timeoutSeconds: seconds }, revision: h.store.kvGet(SETTINGS_REVISION_KEY) ?? 0, origin: 'tool' }
        })
      }
      const history = (await h.call('GET policy/history')) as { readonly history: readonly Record<string, unknown>[] }
      assert.deepEqual(history.history.map((entry) => entry['revision']), [2, 1])
      assert.equal(history.history[0]?.['origin'], 'tool')
    } finally {
      h.cleanup()
    }
  })
})

describe('policy sync over the command surface (§I.3)', () => {
  test('syncs through the driver and reports the allow-list diff', async () => {
    let synced = 0
    const h = surface({
      policySync: {
        syncable: () => ['github'],
        sync: async () => {
          synced += 1
          return { allowed: [{ id: 'alice' }, { id: 'bob' }] }
        },
        allowed: () => [{ id: 'carol' }],
        policy: () => ({ revision: 4, version: 'abc123' })
      }
    })
    try {
      const result = (await h.call('POST policy-sync/:id', { params: { id: 'github' } })) as Record<
        string,
        unknown
      >
      assert.equal(synced, 1, 'the driver ran exactly once')
      assert.deepEqual(result, {
        policy: { revision: 4, version: 'abc123' },
        allowed: [{ id: 'alice' }, { id: 'bob' }],
        added: ['alice', 'bob'],
        removed: ['carol']
      })
    } finally {
      h.cleanup()
    }
  })

  test('a non-syncable source is not_syncable, and a failing sync is sync_failed', async () => {
    let fail = false
    const h = surface({
      policySync: {
        syncable: () => ['github'],
        sync: async () => {
          if (fail) throw new Error('lark-cli exited with code 1')
          return { allowed: [] }
        },
        allowed: () => [],
        policy: () => ({ revision: 0, version: null })
      }
    })
    try {
      const notSyncable = await apiRefusal(h.call('POST policy-sync/:id', { params: { id: 'feishu' } }))
      assert.equal(notSyncable.code, 'not_syncable')
      assert.equal(notSyncable.status, 400)
      fail = true
      const failed = await apiRefusal(h.call('POST policy-sync/:id', { params: { id: 'github' } }))
      assert.equal(failed.code, 'sync_failed')
      // 错误原文只进健康条目与日志（§N.5），信封里不出现它。
      assert.equal(failed.message.includes('lark-cli'), false)
    } finally {
      h.cleanup()
    }
  })
})

// 机器限额的版本化设置块（§M.3 Deployment 组、§H.12、§H.22、§L.6、§D.2 要点 5）。
//
// #47 把四个限额做成了只读读数，因为当时没有块也没有写者。本票用 `app/settings.ts` 的同一套
// 版本记账把它们变成可保存的设置：`limits` 块（`promptMaxChars`、`admissionContextMaxPages`、
// `admissionContextTimeoutMs`、`retention.days`），缺省值仍是 200 000 / 10 / 15 000 / 90。
//
// 断言面：块的 strict 形状、保存记账（版本 + 块修订号 + 历史）、叠到宿主设置上的优先级，
// 以及「保存 → 重启 → 部署视图与运行中的限额都读到新值」。
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import {
  LIMITS_BLOCK_SCHEMA,
  MACHINE_LIMITS_BLOCK,
  validateSettingsBlock
} from '../src/worker/app/settings-blocks.ts'
import { createSettings, SettingsError } from '../src/worker/app/settings.ts'
import {
  DEFAULT_MACHINE_LIMITS,
  machineLimits,
  withMachineLimits
} from '../src/worker/app/limits.ts'
import {
  admissionSettingsOf,
  DEFAULT_ADMISSION_PAGES,
  DEFAULT_ADMISSION_TIMEOUT_MS
} from '../src/worker/sources/admission-context.ts'
import { openStore } from '../src/worker/app/store.ts'
import { readApiToken } from '../src/worker/infra/tokens.ts'
import { createSettingsHandlers } from '../src/worker/http/settings.ts'
import { AT, openTempStore, removeTree } from './support/state.ts'
import { openBoot } from './support/boot.ts'

/** 一份完整的限额块（四个旋钮都写了）。 */
const SAVED_LIMITS = {
  promptMaxChars: 250_000,
  admissionContextMaxPages: 7,
  admissionContextTimeoutMs: 12_000,
  retention: { days: 30 }
} as const

describe('the limits block shape (§K.8)', () => {
  test('the four knobs are strict and bounded', () => {
    assert.equal(LIMITS_BLOCK_SCHEMA.safeParse(SAVED_LIMITS).success, true)
    // 全部可选：只写一个旋钮时其余沿用默认值（面板只提交改动过的值不该被拒）。
    assert.equal(LIMITS_BLOCK_SCHEMA.safeParse({}).success, true)
    assert.equal(LIMITS_BLOCK_SCHEMA.safeParse({ retention: {} }).success, true)
    for (const value of [
      { nope: 1 },
      { promptMaxChars: 0 },
      { promptMaxChars: 2.5 },
      { admissionContextMaxPages: 0 },
      { admissionContextMaxPages: 21 },
      { admissionContextTimeoutMs: 500 },
      { admissionContextTimeoutMs: 600_000 },
      { retention: { days: 0 } },
      { retention: { days: 1.5 } },
      { retention: { nope: 1 } },
      { retention: { days: '30' } }
    ]) {
      assert.equal(LIMITS_BLOCK_SCHEMA.safeParse(value).success, false, JSON.stringify(value))
    }
  })

  test('the block is known to the settings surface, with the design defaults', () => {
    const parsed = validateSettingsBlock(MACHINE_LIMITS_BLOCK, SAVED_LIMITS)
    assert.equal(parsed?.success, true)
    const bad = validateSettingsBlock(MACHINE_LIMITS_BLOCK, { admissionContextMaxPages: 0 })
    assert.equal(bad?.success, false)
    if (bad !== undefined && !bad.success) {
      assert.deepEqual(bad.issues, [
        { path: ['admissionContextMaxPages'], message: 'expected at least 1' }
      ])
    }
    // 缺省值就是 #47 展示的那四个数（设计规定的 200 000 / 10 / 15 000 / 90）。
    assert.deepEqual({ ...machineLimits(withMachineLimits({}, {})) }, {
      promptMaxChars: 200_000,
      admissionContextMaxPages: 10,
      admissionContextTimeoutMs: 15_000,
      retentionDays: 90
    })
  })

  test('the running evaluation window agrees with the limits the panel shows', () => {
    // 面板显示缺省 10 页 / 15 000 ms，运行时读的必须是同一组数（#47 的显示值不是另一套）。
    assert.equal(DEFAULT_ADMISSION_PAGES, DEFAULT_MACHINE_LIMITS.admissionContextMaxPages)
    assert.equal(DEFAULT_ADMISSION_TIMEOUT_MS, DEFAULT_MACHINE_LIMITS.admissionContextTimeoutMs)
    assert.deepEqual(admissionSettingsOf({}), {
      maxPages: DEFAULT_MACHINE_LIMITS.admissionContextMaxPages,
      timeoutMs: DEFAULT_MACHINE_LIMITS.admissionContextTimeoutMs
    })
  })
})

describe('a saved limits block is the value in force', () => {
  test('the saved block wins; the host snapshot fills the rest', () => {
    const merged = withMachineLimits(
      {
        promptMaxChars: 111,
        retention: { relayDays: 7 }
      },
      { promptMaxChars: 300_000, retention: { days: 30 } }
    )
    assert.deepEqual({ ...machineLimits(merged) }, {
      promptMaxChars: 300_000,
      admissionContextMaxPages: 10,
      admissionContextTimeoutMs: 15_000,
      retentionDays: 30
    })
    // 同一棵树里的其他键不被覆盖（`retention.relayDays` 是 Router relay 的保留天数）。
    assert.deepEqual(merged['retention'], { relayDays: 7, days: 30 })
  })

  test('a broken saved value falls back instead of stopping the plugin', () => {
    const merged = withMachineLimits({}, { promptMaxChars: 0, admissionContextMaxPages: 'seven' })
    assert.deepEqual({ ...machineLimits(merged) }, { ...DEFAULT_MACHINE_LIMITS })
    // 没存过（`undefined` / 非对象）时宿主设置原样生效。
    assert.deepEqual(withMachineLimits({ promptMaxChars: 1234 }, undefined), { promptMaxChars: 1234 })
    assert.deepEqual(withMachineLimits({ promptMaxChars: 1234 }, null), { promptMaxChars: 1234 })
  })
})

describe('saving the limits block goes through the one settings writer', () => {
  test('the save records a version, the block revision and its history row', () => {
    const { store, cleanup } = openTempStore()
    try {
      const settings = createSettings({ store, now: () => AT })
      const saved = settings.save({
        block: MACHINE_LIMITS_BLOCK,
        value: SAVED_LIMITS,
        origin: 'panel',
        expectedRevision: 0,
        validate: (value) => LIMITS_BLOCK_SCHEMA.safeParse(value)
      })
      assert.equal(saved.changed, true)
      assert.equal(saved.revision, 1)
      assert.equal(saved.origin, 'panel')
      assert.equal(saved.policyVersion, null, 'the limits block is not the policy block')
      assert.equal(settings.blockRevision(MACHINE_LIMITS_BLOCK), 1)
      assert.deepEqual(settings.block(MACHINE_LIMITS_BLOCK)?.config, SAVED_LIMITS)
      assert.deepEqual(
        settings.history().map((row) => [row.block, row.revision, row.origin]),
        [[MACHINE_LIMITS_BLOCK, 1, 'panel']]
      )
      // 同一个值再存一次不产生新版本（§K.5 的保存语义）。
      const again = settings.save({
        block: MACHINE_LIMITS_BLOCK,
        value: SAVED_LIMITS,
        origin: 'panel',
        expectedRevision: 1,
        validate: (value) => LIMITS_BLOCK_SCHEMA.safeParse(value)
      })
      assert.equal(again.changed, false)
      assert.equal(settings.revision(), 1)
    } finally {
      cleanup()
    }
  })

  test('an invalid or stale save writes nothing', () => {
    const { store, cleanup } = openTempStore()
    try {
      const settings = createSettings({ store, now: () => AT })
      const validate = (value: unknown) => LIMITS_BLOCK_SCHEMA.safeParse(value)
      assert.throws(
        () =>
          settings.save({
            block: MACHINE_LIMITS_BLOCK,
            value: { admissionContextMaxPages: 0 },
            origin: 'panel',
            expectedRevision: 0,
            validate
          }),
        (error: unknown) => (error as SettingsError).code === 'invalid_settings'
      )
      assert.equal(settings.revision(), 0, 'the invalid value wrote nothing')
      settings.save({
        block: MACHINE_LIMITS_BLOCK,
        value: SAVED_LIMITS,
        origin: 'panel',
        expectedRevision: 0,
        validate
      })
      assert.throws(
        () =>
          settings.save({
            block: MACHINE_LIMITS_BLOCK,
            value: { promptMaxChars: 1000 },
            origin: 'panel',
            expectedRevision: 0,
            validate
          }),
        (error: unknown) => (error as SettingsError).code === 'conflict'
      )
      assert.equal(settings.revision(), 1, 'the stale save wrote nothing')
    } finally {
      cleanup()
    }
  })

  test('the command surface saves the block at its base revision', async () => {
    const { store, cleanup } = openTempStore()
    try {
      const handlers = createSettingsHandlers({
        settings: createSettings({ store, now: () => AT }),
        validate: (name) =>
          name === MACHINE_LIMITS_BLOCK
            ? (value: unknown) => LIMITS_BLOCK_SCHEMA.safeParse(value)
            : undefined
      })
      const handler = handlers.get('PUT settings/:block')
      assert.ok(handler)
      const saved = (await handler({
        params: { block: MACHINE_LIMITS_BLOCK },
        query: {},
        body: { value: SAVED_LIMITS, revision: 0, origin: 'panel' },
        caller: { role: 'operator' },
        at: AT,
        requestId: null
      })) as Record<string, unknown>
      assert.equal(saved['block'], MACHINE_LIMITS_BLOCK)
      assert.equal(saved['changed'], true)
      assert.equal(saved['revision'], 1)
      assert.deepEqual(store.settingsVersions.latest()?.config, SAVED_LIMITS)
    } finally {
      cleanup()
    }
  })
})

/** 对 boot 自己的 loopback 服务器发一次请求（真 HTTP，与 CLI 同一条路径）。 */
function apiCall(
  port: number,
  method: 'GET' | 'PUT',
  path: string,
  token: string,
  body?: unknown
): Promise<{ readonly status: number; readonly json: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: `/superagent/api/${path}`,
        method,
        headers: {
          host: `127.0.0.1:${port}`,
          authorization: `Bearer ${token}`,
          'x-superagent-request': '1',
          'content-type': 'application/json'
        }
      },
      (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          text += chunk
        })
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            json: text.length === 0 ? null : (JSON.parse(text) as unknown)
          })
        })
        response.on('error', reject)
      }
    )
    request.on('error', reject)
    request.end(payload)
  })
}

test('after a save and a reload the deployment view and the running prompt limit use the saved values', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'superagent-limits-'))
  // 1. 保存：与面板和 CLI 同一条写路径（`app/settings.ts` 的唯一写入器）。
  const store = openStore({ stateDir })
  try {
    const settings = createSettings({ store, now: () => AT })
    settings.save({
      block: MACHINE_LIMITS_BLOCK,
      // 提示词上限调到 500 字符：下面用它证明运行中的限额也变了，而不只是页面数字。
      value: { ...SAVED_LIMITS, promptMaxChars: 500 },
      origin: 'panel',
      expectedRevision: 0,
      validate: (value) => LIMITS_BLOCK_SCHEMA.safeParse(value)
    })
  } finally {
    store.close()
  }
  // 2. 重启：boot 把保存过的块叠到宿主设置上，部署视图与运行中的消费者读同一份。
  const harness = await openBoot({ stateDir })
  try {
    assert.deepEqual({ ...harness.handle.deployment().limits }, {
      promptMaxChars: 500,
      admissionContextMaxPages: 7,
      admissionContextTimeoutMs: 12_000,
      retentionDays: 30
    })
    // 3. 运行中的限额：boot 的 prompt 版本用的是 500 字符，超过就不可能保存。
    const port = harness.handle.port()
    assert.notEqual(port, null)
    const token = readApiToken(stateDir)
    assert.ok(token)
    const over = await apiCall(port as number, 'PUT', 'prompts', token, {
      config: { team: { communication: 'x'.repeat(600) } },
      baseRevision: 0
    })
    assert.equal(over.status, 400)
    const envelope = over.json as { readonly error?: { readonly code?: string } }
    assert.equal(envelope.error?.code, 'too_long')
    const fits = await apiCall(port as number, 'PUT', 'prompts', token, {
      config: { team: { communication: 'Keep replies short.' } },
      baseRevision: 0
    })
    assert.equal(fits.status, 200)
  } finally {
    await harness.cleanup()
  }
  await removeTree(stateDir)
})

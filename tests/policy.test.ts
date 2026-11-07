// Policy 块、Gate 与准入表（§K.1、§K.2、§K.8）：票 #20 的验收面。
//
// 断言只在两个接缝上：
// - 设置接缝：`validatePolicy()` 的 `{issues:[{path,message}]}`（保存前的严格校验）；
// - 领域接缝：`Policy.gate()` 的 `GateResult`（强度 / 依据 / 原因码），以及引擎观测到的
//   Decision 与 Trigger 去向。
//
// 夹具用一个「聊天式」Source：固定三行（`oc_team` 收全部、`oc_talk` 只收点名、`direct`）加一行
// `ci`（没有发送者）。行与格子的可用性由 `observe` 列表决定，所以「准入表只对 receive-all
// 可用」是可以逐格断言的。
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Engine, MemoryRepositories, STRENGTHS, UserError } from '../src/worker/core/index.ts'
import { createRepositories } from '../src/worker/app/repositories.ts'
import { createPolicySettingsPort, createSettings } from '../src/worker/app/settings.ts'
import type { SettingsOrigin, SettingsSaveResult } from '../src/worker/app/settings.ts'
import { settingsVersionKey } from '../src/worker/app/kv.ts'
import { openTempStore, isoAfter } from './support/state.ts'
import type {
  AcceptMode,
  Candidate,
  Mandate,
  PolicyEffect,
  ScopeResult,
  Thread,
  Ticket,
  Trigger
} from '../src/worker/core/index.ts'
import type { SchemaIssue } from '../src/worker/infra/schema.ts'
import {
  ADMISSION_DEFAULTS,
  ADMISSION_OPTIONS,
  assessmentOutcome,
  createPolicy,
  policyEffects,
  policyVersion,
  validatePolicy
} from '../src/worker/policy/index.ts'
import type {
  AdmissionRow,
  AdmissionTableConfig,
  PolicyBlock,
  PolicyKindView
} from '../src/worker/policy/index.ts'
import { array, object, string } from '../src/worker/infra/schema.ts'
import { readEvalsHealth, readUnavailableProblems } from '../src/worker/app/views/attention.ts'

/** 固定的测试时刻。 */
const AT = '2026-11-07T00:00:00.000Z'

/** Policy 里的一行接收 scope 与它们的语义（夹具，与 Feishu 的「每群一行 + other + direct」同形）。 */
const TEAM = 'oc_team' // 收全部：未点名的消息也读（receive-all）
const TALK = 'oc_talk' // 只收点名
const OTHER = 'other'
const DIRECT = 'direct'
const CI = 'ci'

/** 名单内的人、名单外的人、名单内的 bot。 */
const MEMBER = 'alice'
const GUEST = 'mallory'
const BOT = 'review-bot[bot]'

/** 一行的三个格子：`observe` 列表里的 scope 才有 receive-all 的格子。 */
function cells(observe: readonly string[], row: string): AdmissionRow['cells'] {
  if (row === CI) return { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: observe.includes(CI) }
  return {
    listedUnaddressed: observe.includes(row),
    unlistedAddressed: true,
    unlistedUnaddressed: observe.includes(row)
  }
}

/** 夹具的行表：与 `SourceKind.policy.rows()` 同形（§I.1、§I.2 的准入行）。 */
function rowsOf(observe: readonly string[]): AdmissionRow[] {
  const row = (id: string, zh: string, en: string): AdmissionRow => ({
    id,
    label: { zh, en },
    note: { zh: '夹具', en: 'Fixture' },
    cells: cells(observe, id)
  })
  return [
    row(TEAM, '团队群', 'Team chat'),
    row(TALK, '只收点名的群', 'Mentions-only chat'),
    row(OTHER, '其他群', 'Other chats'),
    row(DIRECT, '私聊', 'Direct messages'),
    row(CI, 'CI 检查', 'CI checks')
  ]
}

/** 夹具的 scope（§I.1）：行的 id 与 `rowsOf` 一一对应。 */
function scopeOf(trigger: Trigger, observe: readonly string[]): ScopeResult {
  const meta = trigger.meta
  if (meta['kind'] === 'ci') {
    return observe.includes(CI)
      ? { listened: true, observed: true, row: CI }
      : { listened: false, reason: 'ci_not_observed' }
  }
  if (meta['direct'] === true) return { listened: true, observed: false, row: DIRECT }
  const chat = String(meta['chatId'] ?? '')
  const listedRow = chat === TEAM || chat === TALK
  return {
    listened: true,
    observed: observe.includes(chat),
    row: listedRow ? chat : OTHER
  }
}

/** 一份夹具设置的原始形态（Policy 块）。 */
interface FixtureInput {
  readonly admission?: AdmissionTableConfig
  readonly acceptMode?: AcceptMode
  readonly observe?: readonly string[]
  readonly allowed?: readonly { id: string; name?: string }[]
  readonly bots?: readonly string[]
  /** 被停用的规则 id（`copy` 是夹具唯一的一条规则）。 */
  readonly disabledRules?: readonly string[]
  /** 夹具唯一那条规则的写法（影响面的测试要改它的名字或说明）。 */
  readonly rule?: { readonly name?: string; readonly en?: string; readonly zh?: string }
  /** `eval.timeoutSeconds`（§K.1 的评估预算；缺省 300，超时测试改小它）。 */
  readonly timeoutSeconds?: number
}

/** 夹具 kind 的 Policy 部分 schema：`allowed` / `bots` 之外再认一个 kind 自有的监听键。 */
const KIND_SCHEMA = object({
  allowed: array(object({ id: string(), name: string().optional() }).strict()).default([]),
  bots: array(object({ id: string() }).strict()).default([]),
  syncChat: string().optional()
}).strict()

/** 夹具 kind：准入行 + 一个 kind 自有的监听键（`syncChat`，不属于 Policy 内容，§K.5）。 */
function fixtureKind(observe: readonly string[]): PolicyKindView {
  return {
    rows: () => rowsOf(observe),
    extras: (section: Record<string, unknown>) => KIND_SCHEMA.safeParse(section)
  }
}

/** 造一个已校验的 Policy 块 + 它的 Gate；默认 observe 模式、只观察 `oc_team`。 */
function fixture(input: FixtureInput = {}) {
  const observe = input.observe ?? [TEAM]
  const raw = {
    rules: [
      {
        id: 'copy',
        name: input.rule?.name ?? 'Copy fixes',
        instruction: { zh: input.rule?.zh ?? '改错别字', en: input.rule?.en ?? 'Fix typos' },
        enabled: !(input.disabledRules ?? []).includes('copy')
      }
    ],
    acceptMode: input.acceptMode ?? 'observe',
    sources: {
      chat: {
        allowed: input.allowed ?? [{ id: MEMBER, name: 'Alice' }],
        bots: (input.bots ?? [BOT]).map((id) => ({ id })),
        admission: input.admission ?? {}
      }
    },
    eval: { timeoutSeconds: input.timeoutSeconds ?? 300 }
  }
  const kinds = (source: string): PolicyKindView | undefined =>
    source === 'chat' ? fixtureKind(observe) : undefined
  const parsed = validatePolicy(raw, { kinds })
  assert.equal(parsed.success, true, JSON.stringify(parsed))
  if (!parsed.success) throw new Error('unreachable')
  const policy = createPolicy({
    block: () => parsed.data,
    sources: { scope: (trigger: Trigger) => scopeOf(trigger, observe) },
    rows: (source: string) => (source === 'chat' ? rowsOf(observe) : []),
  })
  return { policy, block: parsed.data }
}

/** 一条测试 Trigger：默认是 `oc_team` 里名单内的人写的一条未点名消息。 */
function message(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: 'trigger-1',
    source: 'chat',
    threads: [{ source: 'chat', id: 'room' }],
    actor: { source: 'chat', id: MEMBER },
    human: true,
    at: AT,
    text: 'please fix the typo',
    meta: { chatId: TEAM, direct: false },
    ...overrides
  }
}

/** 一条不代表人写的 Trigger（bot 或 CI）：`human: false`。 */
const machine = (overrides: Partial<Trigger> = {}): Trigger =>
  message({ human: false, actor: { source: 'chat', id: BOT }, ...overrides })

/** 没有发送者的 Trigger（CI，§K.2 第 6 条）。 */
const senderless = (overrides: Partial<Trigger> = {}): Trigger =>
  message({ human: false, actor: { source: 'chat', id: '' }, meta: { kind: 'ci' }, ...overrides })

const thread = (subscriptions: readonly string[] = [], context?: readonly string[]): Thread => ({
  key: 'chat:room',
  ref: { source: 'chat', id: 'room' },
  createdAt: AT,
  subscriptions: [...subscriptions],
  ...(context === undefined ? {} : { context: [...context] }),
  correlated: [],
  pending: [],
  meta: {}
})

const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: 'ticket-1',
  title: 'Fix the copy',
  decisionId: 'decision-1',
  mandate: {
    strength: 'explicit',
    policyVersion: 'v',
    basis: { via: 'addressed', addressed: 'mention' },
    actor: { source: 'chat', id: MEMBER },
    scope: 'small'
  },
  channels: [],
  assignments: [],
  inputs: [],
  undelivered: [],
  createdAt: AT,
  updatedAt: AT,
  origin: { triggerId: 'trigger-0', triggerIds: ['trigger-0'] },
  ...overrides
})

describe('the admission table shape', () => {
  test('the cells offer only the strengths the design allows, and default to the pre-table behaviour', () => {
    assert.deepEqual(ADMISSION_OPTIONS, {
      listedUnaddressed: ['inferred', 'ignore'],
      unlistedAddressed: ['explicit', 'inferred', 'ignore'],
      unlistedUnaddressed: ['inferred', 'ignore']
    })
    assert.deepEqual(ADMISSION_DEFAULTS, {
      listedUnaddressed: 'inferred',
      unlistedAddressed: 'ignore',
      unlistedUnaddressed: 'ignore'
    })
  })
})

describe('the gate', () => {
  test('has exactly two strengths, and a refusal is not one of them', () => {
    assert.deepEqual([...STRENGTHS], ['explicit', 'inferred'])
    const { policy } = fixture()
    const refused = policy.gate(
      message({ actor: { source: 'chat', id: GUEST } }),
      thread(),
      []
    )
    assert.equal(refused.admissible, false)
    assert.equal('strength' in refused, false)
    assert.equal('basis' in refused, false)
  })

  test('an allowed person who addresses the agent is an explicit request via addressed', () => {
    const { policy } = fixture()
    for (const addressed of ['mention', 'direct'] as const) {
      const gate = policy.gate(message({ addressed }), thread(), [])
      assert.equal(gate.admissible, true)
      if (!gate.admissible) continue
      assert.equal(gate.strength, 'explicit')
      assert.equal(gate.basis.via, 'addressed')
      assert.equal(gate.basis.source, 'chat')
      assert.equal(gate.basis.row, TEAM)
      assert.equal(gate.basis.sender, 'Alice')
      if (gate.basis.via === 'addressed') assert.equal(gate.basis.addressed, addressed)
    }
  })

  test('the allowed list compares in the Source\'s own identity, ignoring case', () => {
    const { policy } = fixture({ allowed: [{ id: 'ALICE' }] })
    const gate = policy.gate(message({ addressed: 'mention' }), thread(), [])
    assert.equal(gate.admissible, true)
    if (gate.admissible) assert.equal(gate.basis.sender, 'ALICE')
  })
})

/** 在某一行里说话：`addressed` 省略即未点名；`other` 用一个不在配置里的群。 */
function inRow(
  row: string,
  sender: string,
  addressed?: 'mention' | 'direct'
): Trigger {
  if (row === DIRECT) {
    return message({
      actor: { source: 'chat', id: sender },
      meta: { direct: true },
      ...(addressed === undefined ? {} : { addressed })
    })
  }
  const chat = row === TEAM || row === TALK ? row : 'oc_elsewhere'
  return message({
    actor: { source: 'chat', id: sender },
    meta: { chatId: chat, direct: false },
    ...(addressed === undefined ? {} : { addressed })
  })
}

/** 断言一条 Gate 结果：准入则强度与依据通过，拒绝则原因码。 */
function assertAdmitted(
  gate: ReturnType<ReturnType<typeof fixture>['policy']['gate']>,
  expected: { strength: string; via: string; cell?: string }
): void {
  assert.equal(gate.admissible, true, JSON.stringify(gate))
  if (!gate.admissible) return
  assert.equal(gate.strength, expected.strength)
  assert.equal(gate.basis.via, expected.via)
  if (expected.cell !== undefined && gate.basis.via === 'admission') {
    assert.equal(gate.basis.cell, expected.cell)
  }
}

/** 断言一条 Gate 结果被拒绝，且原因码固定。 */
function assertRefused(
  gate: ReturnType<ReturnType<typeof fixture>['policy']['gate']>,
  reason: string
): void {
  assert.equal(gate.admissible, false, JSON.stringify(gate))
  if (!gate.admissible) assert.equal(gate.reason, reason)
}

describe('the gate matrix, cell by cell', () => {
  // 设计 §K.2 的逐格期望：行的可用性由 receive-all 决定，未点名的格子只有收全部的 scope 有。
  const matrix: readonly {
    row: string
    listed: boolean
    addressed?: 'mention' | 'direct'
    expected: { strength: string; via: string; cell?: string } | string
  }[] = [
    { row: TEAM, listed: true, addressed: 'mention', expected: { strength: 'explicit', via: 'addressed' } },
    { row: TEAM, listed: true, expected: { strength: 'inferred', via: 'admission', cell: 'listedUnaddressed' } },
    { row: TEAM, listed: false, addressed: 'mention', expected: 'senderNotMember' },
    { row: TEAM, listed: false, expected: 'senderNotMember' },
    { row: TALK, listed: true, addressed: 'mention', expected: { strength: 'explicit', via: 'addressed' } },
    { row: TALK, listed: true, expected: 'noMention' },
    { row: TALK, listed: false, addressed: 'mention', expected: 'senderNotMember' },
    { row: TALK, listed: false, expected: 'senderNotMember' },
    { row: OTHER, listed: true, addressed: 'mention', expected: { strength: 'explicit', via: 'addressed' } },
    { row: OTHER, listed: true, expected: 'noMention' },
    { row: OTHER, listed: false, addressed: 'mention', expected: 'senderNotMember' },
    { row: OTHER, listed: false, expected: 'senderNotMember' },
    { row: DIRECT, listed: true, addressed: 'direct', expected: { strength: 'explicit', via: 'addressed' } },
    { row: DIRECT, listed: false, addressed: 'direct', expected: 'senderNotMember' }
  ]

  for (const item of matrix) {
    test(`${item.row}, ${item.listed ? 'listed' : 'unlisted'}, ${item.addressed ?? 'unaddressed'}`, () => {
      const { policy } = fixture()
      const gate = policy.gate(
        inRow(item.row, item.listed ? MEMBER : GUEST, item.addressed),
        thread(),
        []
      )
      if (typeof item.expected === 'string') assertRefused(gate, item.expected)
      else assertAdmitted(gate, item.expected)
    })
  }

  test('reads the configured cell of the sender\'s row, and only that row', () => {
    // 名单内未点名：配置 ignore 即不产生候选。
    const quiet = fixture({ admission: { [TEAM]: { listedUnaddressed: 'ignore' } } })
    assertRefused(quiet.policy.gate(inRow(TEAM, MEMBER), thread(), []), 'admissionIgnored')
    // 名单外点名：配置 explicit 即显式；配置 inferred 即在非 off 模式下成为候选。
    const open = fixture({ admission: { [TALK]: { unlistedAddressed: 'explicit' } } })
    assertAdmitted(open.policy.gate(inRow(TALK, GUEST, 'mention'), thread(), []), {
      strength: 'explicit',
      via: 'admission',
      cell: 'unlistedAddressed'
    })
    const soft = fixture({ admission: { [TALK]: { unlistedAddressed: 'inferred' } } })
    assertAdmitted(soft.policy.gate(inRow(TALK, GUEST, 'mention'), thread(), []), {
      strength: 'inferred',
      via: 'admission',
      cell: 'unlistedAddressed'
    })
    // 别的行的格子不影响这一行。
    const elsewhere = fixture({ admission: { [OTHER]: { unlistedAddressed: 'explicit' } } })
    assertRefused(elsewhere.policy.gate(inRow(TALK, GUEST, 'mention'), thread(), []), 'senderNotMember')
    // 收全部的 scope 里，名单外未点名的格子同样说话。
    const scan = fixture({ admission: { [TEAM]: { unlistedUnaddressed: 'inferred' } } })
    assertAdmitted(scan.policy.gate(inRow(TEAM, GUEST), thread(), []), {
      strength: 'inferred',
      via: 'admission',
      cell: 'unlistedUnaddressed'
    })
  })

  test('uses the table only for unaddressed messages the Source receives in that scope', () => {
    // 只收点名：未点名的消息根本不进候选，即使格子写了 inferred。
    const strict = fixture({ admission: { [TALK]: { listedUnaddressed: 'inferred' } } })
    assertRefused(strict.policy.gate(inRow(TALK, MEMBER), thread(), []), 'noMention')
    const stranger = fixture({ admission: { [TALK]: { unlistedUnaddressed: 'inferred' } } })
    assertRefused(stranger.policy.gate(inRow(TALK, GUEST), thread(), []), 'senderNotMember')
    // 收全部：同一份配置生效。
    const open = fixture({ admission: { [TEAM]: { listedUnaddressed: 'inferred' } } })
    assertAdmitted(open.policy.gate(inRow(TEAM, MEMBER), thread(), []), {
      strength: 'inferred',
      via: 'admission',
      cell: 'listedUnaddressed'
    })
  })

  test('honours the row\'s own cell availability below the Source observation switch', () => {
    // 行声明 listedUnaddressed 不可用（配置与 observe 不一致时）：按 ignore 读，绝不产生候选。
    const off = fixtureRows({ listedUnaddressed: { [TEAM]: false } })
    assertRefused(off.policy.gate(inRow(TEAM, MEMBER), thread(), []), 'admissionIgnored')
  })

  test('accept mode off removes every inferred candidate and keeps the explicit ones', () => {
    const off = fixture({
      acceptMode: 'off',
      admission: { [TEAM]: { unlistedUnaddressed: 'inferred' }, [TALK]: { unlistedAddressed: 'inferred' } }
    })
    // 显式：名字在名单 + 点名。
    assertAdmitted(off.policy.gate(inRow(TEAM, MEMBER, 'mention'), thread(), []), {
      strength: 'explicit',
      via: 'addressed'
    })
    // 显式：准入格写 explicit。
    const explicitCell = fixture({
      acceptMode: 'off',
      admission: { [TALK]: { unlistedAddressed: 'explicit' } }
    })
    assertAdmitted(explicitCell.policy.gate(inRow(TALK, GUEST, 'mention'), thread(), []), {
      strength: 'explicit',
      via: 'admission',
      cell: 'unlistedAddressed'
    })
    // 推断：格子 inferred 也不行。
    assertRefused(off.policy.gate(inRow(TALK, GUEST, 'mention'), thread(), []), 'senderNotMember')
    assertRefused(off.policy.gate(inRow(TEAM, GUEST), thread(), []), 'senderNotMember')
  })
})

/** 夹具变体：直接指定某个格子在所有行上的可用性（证明 Gate 读的是行声明的可用性）。 */
function fixtureRows(cells: Partial<Record<string, Partial<Record<string, boolean>>>>) {
  const observe = [TEAM]
  const raw = {
    rules: [],
    acceptMode: 'auto' as const,
    sources: {
      chat: {
        allowed: [{ id: MEMBER }],
        bots: [{ id: BOT }],
        admission: { [TEAM]: { listedUnaddressed: 'inferred' as const } }
      }
    },
    eval: { timeoutSeconds: 300 }
  }
  const kinds = (source: string): PolicyKindView | undefined =>
    source === 'chat'
      ? {
          rows: () =>
            rowsOf(observe).map((row) =>
              row.id === TEAM
                ? {
                    ...row,
                    cells: {
                      ...row.cells,
                      listedUnaddressed: cells['listedUnaddressed']?.[TEAM] ?? true
                    }
                  }
                : row
            )
        }
      : undefined
  const parsed = validatePolicy(raw, { kinds })
  assert.equal(parsed.success, true, JSON.stringify(parsed))
  if (!parsed.success) throw new Error('unreachable')
  const policy = createPolicy({
    block: () => parsed.data,
    sources: { scope: (trigger: Trigger) => scopeOf(trigger, observe) },
    rows: (source: string) => (source === 'chat' ? kinds('chat')!.rows() : []),
  })
  return { policy }
}

describe('follow-ups on a Thread with a Ticket', () => {
  test('an allowed person gets explicit strength without addressing the agent', () => {
    const { policy } = fixture({ admission: { [TEAM]: { listedUnaddressed: 'ignore' } } })
    assertAdmitted(policy.gate(inRow(TEAM, MEMBER), thread(['ticket-1']), [ticket()]), {
      strength: 'explicit',
      via: 'followup'
    })
  })

  test('someone outside the list rides the Thread as an inferred candidate while assessments run', () => {
    const { policy } = fixture()
    assertAdmitted(policy.gate(inRow(TEAM, GUEST), thread(['ticket-1']), [ticket()]), {
      strength: 'inferred',
      via: 'followup'
    })
    // accept mode 为 off 时推断 follow-up 不成立；显式的仍成立。
    const off = fixture({ acceptMode: 'off' })
    assertRefused(off.policy.gate(inRow(TEAM, GUEST), thread(['ticket-1']), [ticket()]), 'senderNotMember')
    assertAdmitted(off.policy.gate(inRow(TEAM, MEMBER), thread(['ticket-1']), [ticket()]), {
      strength: 'explicit',
      via: 'followup'
    })
  })

  test('a direct message from someone outside the list never becomes a follow-up', () => {
    const { policy } = fixture()
    assertRefused(
      policy.gate(inRow(DIRECT, GUEST, 'direct'), thread(['ticket-1']), [ticket()]),
      'senderNotMember'
    )
  })

  test('a Thread followed only for context lends no follow-up authority', () => {
    const { policy } = fixture()
    assertRefused(
      policy.gate(inRow(TEAM, GUEST), thread(['ticket-1'], ['ticket-1']), [ticket()]),
      'senderNotMember'
    )
  })

  test('counts ended Tickets unless a person stopped them', () => {
    const { policy } = fixture()
    const ended = ticket({ ended: { at: AT, by: 'executor', outcome: 'completed' } })
    assertAdmitted(policy.gate(inRow(TEAM, GUEST), thread(['ticket-1']), [ended]), {
      strength: 'inferred',
      via: 'followup'
    })
    const stopped = ticket({ ended: { at: AT, by: 'human', outcome: 'stopped' } })
    // 人停过的 Ticket 不再给 follow-up；此后由准入表说话（名单内未点名 = 缺省推断）。
    assertRefused(
      policy.gate(inRow(TEAM, GUEST), thread(['ticket-1']), [stopped]),
      'senderNotMember'
    )
    assertAdmitted(policy.gate(inRow(TEAM, MEMBER), thread(['ticket-1']), [stopped]), {
      strength: 'inferred',
      via: 'admission',
      cell: 'listedUnaddressed'
    })
  })

  test('an explicit admission cell wins over a follow-up so the Ticket cannot weaken it', () => {
    const { policy } = fixture({ admission: { [TALK]: { unlistedAddressed: 'explicit' } } })
    for (const acceptMode of ['auto', 'observe', 'off'] as const) {
      const seen = fixture({ acceptMode, admission: { [TALK]: { unlistedAddressed: 'explicit' } } })
      assertAdmitted(
        seen.policy.gate(inRow(TALK, GUEST, 'mention'), thread(['ticket-1']), [ticket()]),
        { strength: 'explicit', via: 'admission', cell: 'unlistedAddressed' }
      )
    }
    assertAdmitted(policy.gate(inRow(TALK, GUEST, 'mention'), thread(['ticket-1']), [ticket()]), {
      strength: 'explicit',
      via: 'admission',
      cell: 'unlistedAddressed'
    })
  })
})

describe('bots and senderless events', () => {
  test('a listed bot may propose an inferred candidate, addressed or observed, and never an explicit one', () => {
    const { policy } = fixture({ acceptMode: 'auto' })
    assertAdmitted(policy.gate(machine({ addressed: 'mention' }), thread(), []), {
      strength: 'inferred',
      via: 'bot'
    })
    assertAdmitted(policy.gate(machine(), thread(), []), { strength: 'inferred', via: 'bot' })
    // Thread 上有 Ticket 也不提升成显式。
    const withTicket = policy.gate(machine({ addressed: 'mention' }), thread(['ticket-1']), [ticket()])
    assertAdmitted(withTicket, { strength: 'inferred', via: 'bot' })
    if (withTicket.admissible) assert.equal(withTicket.basis.via, 'bot')
  })

  test('a bot outside the bots list never gets in, even when it is on the allowed list', () => {
    const { policy } = fixture({ bots: [BOT] })
    assertRefused(
      policy.gate(machine({ actor: { source: 'chat', id: 'spam-bot' }, addressed: 'mention' }), thread(), []),
      'notHuman'
    )
    const looksHuman = fixture({ allowed: [{ id: 'friendly-bot' }], bots: [] })
    assertRefused(
      looksHuman.policy.gate(
        machine({ actor: { source: 'chat', id: 'friendly-bot' }, addressed: 'mention' }),
        thread(),
        []
      ),
      'notHuman'
    )
  })

  test('an unaddressed bot message needs a scope that reads every message', () => {
    const { policy } = fixture()
    assertRefused(policy.gate(machine({ meta: { chatId: TALK, direct: false } }), thread(), []), 'notHuman')
  })

  test('no bot candidate while accept mode is off', () => {
    const { policy } = fixture({ acceptMode: 'off' })
    assertRefused(policy.gate(machine({ addressed: 'mention' }), thread(), []), 'admissionIgnored')
  })

  test('CI has no sender and uses the last cell of its row', () => {
    const { policy } = fixture({
      acceptMode: 'auto',
      observe: [TEAM, CI],
      admission: { [CI]: { unlistedUnaddressed: 'inferred' } }
    })
    assertAdmitted(policy.gate(senderless(), thread(), []), {
      strength: 'inferred',
      via: 'admission',
      cell: 'unlistedUnaddressed'
    })
    // 没有配置就是缺省 ignore：不产生候选。
    const plain = fixture({ acceptMode: 'auto', observe: [TEAM, CI] })
    assertRefused(plain.policy.gate(senderless(), thread(), []), 'admissionIgnored')
    // accept mode off 时同样不产生候选。
    const off = fixture({
      acceptMode: 'off',
      observe: [TEAM, CI],
      admission: { [CI]: { unlistedUnaddressed: 'inferred' } }
    })
    assertRefused(off.policy.gate(senderless(), thread(), []), 'admissionIgnored')
    // 没有观察 CI 的 Source 根本不收它。
    const quiet = fixture({ acceptMode: 'auto' })
    assertRefused(quiet.policy.gate(senderless(), thread(), []), 'notHuman')
  })

  test('admits an inferred candidate only in auto mode with matched, enabled rules', () => {
    const auto = fixture({ acceptMode: 'auto' })
    assert.equal(auto.policy.admitsInferred(['copy']), true)
    assert.equal(auto.policy.admitsInferred(['unknown']), false)
    assert.equal(auto.policy.admitsInferred([]), false)
    const observe = fixture({ acceptMode: 'observe' })
    assert.equal(observe.policy.admitsInferred(['copy']), false)
  })
})

describe('the policy block schema', () => {
  const kinds = (source: string): PolicyKindView | undefined =>
    source === 'chat' ? { rows: () => rowsOf([TEAM]) } : undefined

  /** 一份最小的原始块：测试只改一个字段，就能看出它的那条问题。 */
  const raw = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    rules: [
      { id: 'copy', name: 'Copy fixes', instruction: { zh: '改错别字', en: 'Fix typos' }, enabled: true }
    ],
    acceptMode: 'observe',
    sources: { chat: { allowed: [{ id: MEMBER, name: 'Alice' }], bots: [{ id: BOT }], admission: {} } },
    eval: { timeoutSeconds: 300 },
    ...overrides
  })

  /** 一份结果的 issue 路径（`path: message`），便于逐条断言。 */
  const failures = (value: unknown, options = { kinds }): string[] => {
    const result = validatePolicy(value, options)
    assert.equal(result.success, false, 'expected the block to be refused')
    return result.success
      ? []
      : result.issues.map((issue: SchemaIssue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
  }

  test('fills the design defaults so an empty block is a valid observe-mode policy', () => {
    const result = validatePolicy({}, { kinds })
    assert.equal(result.success, true)
    if (!result.success) return
    assert.deepEqual(result.data, {
      rules: [],
      acceptMode: 'observe',
      sources: {},
      eval: { timeoutSeconds: 300 }
    })
  })

  test('rejects unknown keys at the top level and in a rule', () => {
    assert.deepEqual(failures(raw({ paused: true })), ['paused: unknown key'])
    assert.deepEqual(
      failures(
        raw({
          rules: [
            { id: 'copy', name: 'Copy fixes', instruction: { zh: '改', en: 'Fix' }, enabled: true, visual: true }
          ]
        })
      ),
      ['rules.0.visual: unknown key']
    )
  })

  test('rejects an unknown key in a Source part that the kind does not declare', () => {
    assert.deepEqual(
      failures(
        raw({ sources: { chat: { allowed: [], bots: [], admission: {}, syncChat: TEAM } } })
      ),
      ['sources.chat.syncChat: unknown key']
    )
  })

  test('keeps a kind-specific key when the kind\'s own schema accepts it', () => {
    const withSync = (source: string): PolicyKindView | undefined =>
      source === 'chat'
        ? {
            rows: () => rowsOf([TEAM]),
            extras: (section: Record<string, unknown>) =>
              object({ syncChat: string().optional() }).safeParse(section)
          }
        : undefined
    const result = validatePolicy(
      raw({ sources: { chat: { allowed: [], bots: [], admission: {}, syncChat: TEAM } } }),
      { kinds: withSync }
    )
    assert.equal(result.success, true, JSON.stringify(result))
    if (result.success) assert.equal(result.data.sources['chat']?.['syncChat'], TEAM)
  })

  test('preserves the part of a kind that is not installed, so settings can precede the kind', () => {
    const result = validatePolicy(
      raw({ sources: { later: { allowed: [{ id: 'ou_1' }], bots: [], admission: {}, syncChat: TEAM } } }),
      { kinds }
    )
    assert.equal(result.success, true, JSON.stringify(result))
    if (result.success) {
      assert.deepEqual(result.data.sources['later']?.allowed, [{ id: 'ou_1' }])
      assert.equal(result.data.sources['later']?.['syncChat'], TEAM)
    }
  })

  test('rejects an out-of-range accept mode, timeout and cell value', () => {
    assert.deepEqual(failures(raw({ acceptMode: 'always' })), [
      'acceptMode: expected one of off, observe, auto'
    ])
    assert.deepEqual(failures(raw({ eval: { timeoutSeconds: 5 } })), [
      'eval.timeoutSeconds: expected at least 30'
    ])
    assert.deepEqual(failures(raw({ eval: { timeoutSeconds: '300' } })), [
      'eval.timeoutSeconds: expected number'
    ])
    // 未点名的格子不可能是显式请求：越界即拒绝。
    assert.deepEqual(
      failures(raw({ sources: { chat: { allowed: [], bots: [], admission: { [TEAM]: { listedUnaddressed: 'explicit' } } } } })),
      [`sources.chat.admission.${TEAM}.listedUnaddressed: expected one of inferred, ignore`]
    )
  })

  test('rejects an admission row the kind does not declare', () => {
    assert.deepEqual(
      failures(raw({ sources: { chat: { allowed: [], bots: [], admission: { 'oc_gone': {} } } } })),
      ['sources.chat.admission.oc_gone: unknown receiving scope']
    )
  })

  test('rejects duplicate identities in the allowed list, ignoring case', () => {
    assert.deepEqual(
      failures(raw({ sources: { chat: { allowed: [{ id: 'alice' }, { id: 'ALICE' }], bots: [], admission: {} } } })),
      ['sources.chat.allowed.1.id: duplicate id ALICE']
    )
    assert.deepEqual(
      failures(
        raw({
          rules: [
            { id: 'copy', name: 'One', instruction: { zh: '一', en: 'One' }, enabled: true },
            { id: 'copy', name: 'Two', instruction: { zh: '二', en: 'Two' }, enabled: false }
          ]
        })
      ),
      ['rules.1.id: duplicate id copy']
    )
  })

  test('returns every issue at once, and nothing at all on failure', () => {
    const result = validatePolicy(
      raw({ acceptMode: 'nope', eval: { timeoutSeconds: 999 } }),
      { kinds }
    )
    assert.equal(result.success, false)
    if (result.success) return
    assert.equal(result.issues.length, 2)
    assert.equal(result.issues.every((issue: SchemaIssue) => issue.path.length > 0), true)
    // 全有或全无：失败结果里没有 data 字段。
    assert.equal('data' in result, false)
  })
})

/** 真引擎 + 内存仓储 + 本套件的真 Policy：只看 Gate、评估与 Decision/Ticket 的接缝。 */
function engineHarness(initial: FixtureInput = {}) {
  let current = fixture(initial)
  const opened = new MemoryRepositories()
  const repo = opened.claimWriter()
  const requests: Candidate[] = []
  const scope = { scope: (trigger: Trigger) => scopeOf(trigger, initial.observe ?? [TEAM]) }
  const policy = () =>
    createPolicy({
      block: () => current.block,
      sources: scope,
      rows: (source: string) => (source === 'chat' ? rowsOf(initial.observe ?? [TEAM]) : []),
      })
  const engine = new Engine({
    repo,
    scope,
    policy,
    assessor: {
      request: (candidate: Candidate) => {
        requests.push(candidate)
      }
    },
    executor: {
      start: () => undefined,
      deliver: () => undefined,
      stop: () => undefined
    },
    outbox: {
      send: () => undefined,
      status: () => undefined,
      withdraw: () => undefined,
      withdrawTicket: () => undefined
    },
    now: () => AT
  })
  return {
    engine,
    repo,
    requests,
    /** 当前的 Policy 块：评估的完整性/模式以它为真相（§K.4）。 */
    block: () => current.block,
    replace: (input: FixtureInput) => {
      current = fixture(input)
    }
  }
}

describe('the engine records what the gate refused', () => {
  test('a refused Trigger leaves a filtered record with its reason code, no candidate and no Ticket', () => {
    const { engine, repo, requests } = engineHarness()
    assert.equal(engine.receive(inRow(TEAM, GUEST)), 'stored')
    engine.evaluateDue()
    assert.deepEqual(repo.triggers.disposition('trigger-1')?.filtered, { code: 'senderNotMember' })
    assert.equal(requests.length, 0, 'no candidate reached the assessor')
    assert.deepEqual(repo.tickets.list(), [])
    const decisions = repo.decisions.byThread('chat:room')
    assert.equal(decisions.length, 1)
    assert.equal(decisions[0]?.kind, 'ignore')
    assert.equal(decisions[0]?.reason[0]?.code, 'senderNotMember')
  })

  test('a later evaluation that admits the Trigger clears the filtered record', () => {
    const { engine, repo, replace } = engineHarness()
    engine.receive(inRow(TEAM, GUEST))
    engine.evaluateDue()
    assert.equal(repo.triggers.disposition('trigger-1')?.filtered?.code, 'senderNotMember')
    replace({ acceptMode: 'auto', admission: { [TEAM]: { unlistedUnaddressed: 'inferred' } } })
    assert.equal(engine.reevaluate('trigger-1'), true)
    engine.evaluateDue()
    assert.equal(repo.triggers.disposition('trigger-1')?.filtered, undefined)
  })
})

describe('accept mode and the assessment outcome (§K.4)', () => {
  /** 一份通过完整性检查的评估：唯一的规则 `copy` 匹配，方向已定。 */
  const assessment = {
    decision: 'accept',
    direction: {
      implementation_requested: true,
      target_basis: 'specified',
      requires_design_decision: false,
      evidence: 'the message names the typo'
    },
    rule_assessments: [{ rule_id: 'copy', matched: true, reason: 'it is a typo fix' }],
    title: 'Fix the typo',
    scope: 'one typo',
    reason: 'asked',
    intent_evidence: 'please fix the typo',
    worktree_name: 'fix-typo'
  }

  /** 跑一次候选 → 评估 → Decision，返回观测到的这些东西。 */
  function assessed(acceptMode: AcceptMode) {
    const h = engineHarness({ acceptMode })
    h.engine.receive(inRow(TEAM, MEMBER))
    h.engine.evaluateDue()
    const candidate = h.requests[0]
    if (candidate === undefined) return { h, candidate, decision: undefined, outcome: undefined }
    const result = assessmentOutcome(assessment, h.block(), candidate.strength)
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok) throw new Error('unreachable')
    const decision = h.engine.decide('trigger-1', { ...result.outcome, evalId: candidate.evalId })
    return { h, candidate, decision, outcome: result.outcome }
  }

  test('observe records would-accept without a ticket (R6)', () => {
    const { h, candidate, decision, outcome } = assessed('observe')
    assert.notEqual(candidate, undefined, 'observe still assesses the candidate')
    assert.equal(candidate?.strength, 'inferred')
    assert.equal(outcome?.kind, 'ignore')
    assert.equal(decision?.kind, 'ignore')
    assert.equal(decision?.reason.some((reason) => reason.code === 'observed'), true)
    assert.deepEqual(decision?.audit?.['would_accept'], true)
    assert.equal(decision?.ticketId, undefined)
    assert.deepEqual(h.repo.tickets.list(), [], 'observe creates no ticket')
  })

  test('off records nothing actionable: a Decision with a reason, no ticket, no candidate', () => {
    const h = engineHarness({ acceptMode: 'off' })
    h.engine.receive(inRow(TEAM, MEMBER))
    h.engine.evaluateDue()
    assert.deepEqual(h.requests, [], 'off admits no inferred candidate')
    const [decision] = h.repo.decisions.byThread('chat:room')
    assert.equal(decision?.kind, 'ignore')
    assert.ok((decision?.reason.length ?? 0) > 0, 'the ignore carries a reason')
    assert.equal(decision?.ticketId, undefined)
    assert.deepEqual(h.repo.tickets.list(), [])
  })

  test('auto accepts the proactive candidate: a Ticket with the matched rule in its mandate', () => {
    const { h, decision, outcome } = assessed('auto')
    assert.equal(outcome?.kind, 'accept')
    assert.equal(decision?.kind, 'accept')
    const [ticket] = h.repo.tickets.list()
    assert.notEqual(ticket, undefined, 'auto creates the ticket')
    assert.equal(ticket?.id, decision?.ticketId)
    assert.deepEqual(ticket?.mandate.basis.rules, ['copy'])
    assert.equal(ticket?.mandate.strength, 'inferred')
    assert.equal(ticket?.mandate.scope, 'one typo')
  })
})

/**
 * 一份用于版本测试的原始 Policy 块。`sources.chat` 带一个 kind 自有的键（`syncChat`），
 * 它属于 Source 的监听配置，不属于谁能授权的 Policy（§K.5）。
 */
function rawPolicy(
  overrides: {
    readonly rules?: unknown[]
    readonly acceptMode?: string
    readonly allowed?: unknown[]
    readonly bots?: unknown[]
    readonly admission?: unknown
    readonly syncChat?: string
    readonly timeoutSeconds?: number
  } = {}
): unknown {
  return {
    rules: overrides.rules ?? [
      { id: 'copy', name: 'Copy fixes', instruction: { zh: '改错别字', en: 'Fix typos' }, enabled: true }
    ],
    acceptMode: overrides.acceptMode ?? 'auto',
    sources: {
      chat: {
        allowed: overrides.allowed ?? [{ id: MEMBER, name: 'Alice' }],
        bots: overrides.bots ?? [{ id: BOT }],
        admission: overrides.admission ?? { [TEAM]: { unlistedAddressed: 'explicit' } },
        ...(overrides.syncChat === undefined ? {} : { syncChat: overrides.syncChat })
      }
    },
    eval: { timeoutSeconds: overrides.timeoutSeconds ?? 300 }
  }
}

/** 一份已校验的 Policy 块（失败直接让测试炸掉）。 */
function blockOf(raw: unknown): PolicyBlock {
  const parsed = validatePolicy(raw)
  assert.equal(parsed.success, true, JSON.stringify(parsed))
  if (!parsed.success) throw new Error('unreachable')
  return parsed.data
}

describe('the policy version', () => {
  test('is a twelve-character content hash of who may authorise, not of what the Sources listen to', () => {
    const version = policyVersion(blockOf(rawPolicy()))
    assert.match(version, /^[0-9a-f]{12}$/, 'sha256 的前 12 位十六进制（§K.5）')
    assert.equal(policyVersion(blockOf(rawPolicy())), version, 'the same content hashes the same')
    // 配置决定什么进入系统，Policy 决定谁能授权：kind 自有的监听键与 eval 预算都不参与。
    assert.equal(policyVersion(blockOf(rawPolicy({ syncChat: 'oc_other' }))), version, 'listening config')
    assert.equal(policyVersion(blockOf(rawPolicy({ timeoutSeconds: 120 }))), version, 'the eval budget')
    // 键的书写顺序不是内容。
    const reordered = blockOf({
      eval: { timeoutSeconds: 300 },
      sources: {
        chat: {
          admission: { [TEAM]: { unlistedAddressed: 'explicit' } },
          bots: [{ id: BOT }],
          allowed: [{ id: MEMBER, name: 'Alice' }]
        }
      },
      acceptMode: 'auto',
      rules: [
        { id: 'copy', name: 'Copy fixes', instruction: { zh: '改错别字', en: 'Fix typos' }, enabled: true }
      ]
    })
    assert.equal(policyVersion(reordered), version)
  })

  test('changes with every authorisation input: the rules, the accept mode, the lists and the admission table', () => {
    const base = policyVersion(blockOf(rawPolicy()))
    const variants: Readonly<Record<string, unknown>> = {
      'a rule disabled': rawPolicy({
        rules: [
          { id: 'copy', name: 'Copy fixes', instruction: { zh: '改错别字', en: 'Fix typos' }, enabled: false }
        ]
      }),
      'a rule instruction edited': rawPolicy({
        rules: [
          { id: 'copy', name: 'Copy fixes', instruction: { zh: '改错字', en: 'Fix spelling' }, enabled: true }
        ]
      }),
      'a rule added': rawPolicy({
        rules: [
          { id: 'copy', name: 'Copy fixes', instruction: { zh: '改错别字', en: 'Fix typos' }, enabled: true },
          { id: 'visual', name: 'Visual fixes', instruction: { zh: '改间距', en: 'Fix spacing' }, enabled: true }
        ]
      }),
      'the accept mode lowered': rawPolicy({ acceptMode: 'observe' }),
      'an identity removed from the allowed list': rawPolicy({ allowed: [] }),
      'a bot removed from the bots list': rawPolicy({ bots: [] }),
      'an admission cell narrowed': rawPolicy({ admission: { [TEAM]: { unlistedAddressed: 'inferred' } } }),
      'an admission row added': rawPolicy({
        admission: { [TEAM]: { unlistedAddressed: 'explicit' }, [TALK]: { listedUnaddressed: 'ignore' } }
      })
    }
    for (const [what, raw] of Object.entries(variants)) {
      assert.notEqual(policyVersion(blockOf(raw)), base, what)
    }
  })

  test('treats a cell written out as its default as the same content', () => {
    const written = rawPolicy({
      admission: { [TEAM]: { listedUnaddressed: 'inferred', unlistedAddressed: 'ignore' } }
    })
    const omitted = rawPolicy({ admission: { [TEAM]: {} } })
    assert.equal(policyVersion(blockOf(written)), policyVersion(blockOf(omitted)))
  })
})

/**
 * 一条 Gate 准入结果变成的 Mandate，可补上评估匹配到的规则（accept 时 `Evals.accept` 才写
 * `basis.rules`）。复验读的就是 accept 写下的这一份，所以夹具直接用它。
 */
function mandateOf(
  policy: ReturnType<typeof fixture>['policy'],
  trigger: Trigger,
  options: { readonly thread?: Thread; readonly tickets?: readonly Ticket[]; readonly rules?: readonly string[] } = {}
): Mandate {
  const gate = policy.gate(trigger, options.thread ?? thread(), [...(options.tickets ?? [ticket()])])
  assert.equal(gate.admissible, true, JSON.stringify(gate))
  if (!gate.admissible) throw new Error('unreachable')
  return {
    strength: gate.strength,
    policyVersion: 'v1',
    basis: { ...gate.basis, ...(options.rules === undefined ? {} : { rules: [...options.rules] }) },
    actor: trigger.actor,
    scope: 'small'
  }
}

describe('revalidating a mandate under today\'s policy (§K.3)', () => {
  test('an addressed mandate requires its sender to stay on the allowed list', () => {
    const mandate = mandateOf(fixture().policy, inRow(TEAM, MEMBER, 'mention'))
    assert.equal(mandate.basis.via, 'addressed')
    assert.equal(fixture().policy.revalidate(mandate), true)
    assert.equal(fixture({ allowed: [] }).policy.revalidate(mandate), false)
  })

  test('an explicit follow-up keeps its authority while the Thread is listened to; an inferred one needs auto', () => {
    const listed = mandateOf(fixture().policy, inRow(TEAM, MEMBER), {
      thread: thread(['ticket-1']),
      rules: ['copy']
    })
    assert.equal(listed.basis.via, 'followup')
    assert.equal(listed.strength, 'explicit')
    // 人被移出名单不改变「这个 Thread 上已有工作」的事实：显式 follow-up 仍然成立。
    assert.equal(fixture({ allowed: [] }).policy.revalidate(listed), true)
    // 名单外的人经 follow-up 拿到的是推断强度：只有 auto 且匹配规则仍启用时才成立。
    const guest = mandateOf(fixture().policy, inRow(TEAM, GUEST), {
      thread: thread(['ticket-1']),
      rules: ['copy']
    })
    assert.equal(guest.strength, 'inferred')
    assert.equal(fixture({ acceptMode: 'auto' }).policy.revalidate(guest), true)
    assert.equal(fixture({ acceptMode: 'observe' }).policy.revalidate(guest), false)
    assert.equal(fixture({ acceptMode: 'auto', disabledRules: ['copy'] }).policy.revalidate(guest), false)
  })

  test('an admission mandate holds only while today\'s cell gives at least its strength and a listed sender stays listed', () => {
    // 没有 Ticket 的 Thread 才走准入表；Thread 上已有 Ticket 时那是 follow-up（§K.2 第 3 条）。
    const mandate = mandateOf(fixture().policy, inRow(TEAM, MEMBER), { tickets: [], rules: ['copy'] })
    assert.equal(mandate.basis.via, 'admission')
    assert.equal(mandate.strength, 'inferred')
    assert.equal(fixture({ acceptMode: 'auto' }).policy.revalidate(mandate), true)
    // 模式离开 auto：推断强度不再被接受。
    assert.equal(fixture({ acceptMode: 'observe' }).policy.revalidate(mandate), false)
    // 格子被收窄（inferred → ignore）。
    assert.equal(
      fixture({ acceptMode: 'auto', admission: { [TEAM]: { listedUnaddressed: 'ignore' } } }).policy.revalidate(
        mandate
      ),
      false
    )
    // 名单内的人被移出名单就是撤销——即使「未名单、未点名」那一格给的是 inferred：
    // 原来是 listed 的 Mandate 要求发送者仍在名单（§K.3）。
    assert.equal(fixture({ acceptMode: 'auto', allowed: [] }).policy.revalidate(mandate), false)
    assert.equal(
      fixture({
        acceptMode: 'auto',
        allowed: [],
        admission: { [TEAM]: { unlistedUnaddressed: 'inferred' } }
      }).policy.revalidate(mandate),
      false
    )
    // 行的可用性来自 Source 的监听配置：不再收这个群的全部消息，格子按 ignore 读。
    assert.equal(fixture({ acceptMode: 'auto', observe: [] }).policy.revalidate(mandate), false)
  })

  test('an explicit admission mandate needs its cell at the same strength, but never auto mode', () => {
    const explicit = fixture({ admission: { [TEAM]: { unlistedAddressed: 'explicit' } } })
    const mandate = mandateOf(explicit.policy, inRow(TEAM, GUEST, 'mention'), {
      tickets: [],
      rules: ['copy']
    })
    assert.equal(mandate.basis.via, 'admission')
    assert.equal(mandate.strength, 'explicit')
    // 显式强度与 accept mode、规则无关。
    assert.equal(
      fixture({
        admission: { [TEAM]: { unlistedAddressed: 'explicit' } },
        acceptMode: 'off',
        disabledRules: ['copy']
      }).policy.revalidate(mandate),
      true
    )
    // 格子降到推断强度就是「今天给不出同样的授权」。
    assert.equal(
      fixture({ admission: { [TEAM]: { unlistedAddressed: 'inferred' } }, acceptMode: 'auto' }).policy.revalidate(
        mandate
      ),
      false
    )
  })

  test('a bot mandate needs the bot listed, auto mode and every matched rule enabled', () => {
    const mandate = mandateOf(fixture({ acceptMode: 'auto' }).policy, machine(), {
      tickets: [],
      rules: ['copy']
    })
    assert.equal(mandate.basis.via, 'bot')
    assert.equal(fixture({ acceptMode: 'auto' }).policy.revalidate(mandate), true)
    assert.equal(fixture({ acceptMode: 'observe' }).policy.revalidate(mandate), false, 'mode left auto')
    assert.equal(fixture({ acceptMode: 'auto', bots: [] }).policy.revalidate(mandate), false, 'bot de-listed')
    assert.equal(
      fixture({ acceptMode: 'auto', disabledRules: ['copy'] }).policy.revalidate(mandate),
      false,
      'a matched rule was disabled'
    )
  })

  test('a senderless CI event revalidates through its last cell', () => {
    const input: FixtureInput = {
      acceptMode: 'auto',
      observe: [TEAM, CI],
      admission: { [CI]: { unlistedUnaddressed: 'inferred' } }
    }
    const mandate = mandateOf(fixture(input).policy, senderless(), { tickets: [], rules: ['copy'] })
    assert.equal(mandate.basis.via, 'admission')
    assert.equal(fixture(input).policy.revalidate(mandate), true)
    assert.equal(fixture({ ...input, acceptMode: 'observe' }).policy.revalidate(mandate), false)
  })
})

describe('how a policy change affects live tickets (§K.5)', () => {
  /** 一个 Source 的准入行（影响面读「今天的格子」时用它，与 Source 的监听配置同源）。 */
  const rowsIn = (observe: readonly string[]) => (source: string): readonly AdmissionRow[] =>
    source === 'chat' ? rowsOf(observe) : []
  /** 一次变更的影响面：旧块是 `fixture({ acceptMode: 'auto' })`，行表收全部 `oc_team`。 */
  const impact = (
    previous: ReturnType<typeof fixture>,
    next: ReturnType<typeof fixture>,
    tickets: readonly Ticket[]
  ): ReadonlyMap<string, PolicyEffect> =>
    policyEffects(previous.block, next.block, tickets, { rows: rowsIn([TEAM]) })

  test('names a matched rule that was disabled or rewritten, for explicit and inferred tickets alike', () => {
    const old = fixture({ acceptMode: 'auto' })
    const admitted = ticket({
      mandate: mandateOf(old.policy, inRow(TEAM, MEMBER), { tickets: [], rules: ['copy'] })
    })
    const addressed = ticket({
      id: 'ticket-2',
      mandate: mandateOf(old.policy, inRow(TEAM, MEMBER, 'mention'), { tickets: [], rules: ['copy'] })
    })
    const disabled = impact(old, fixture({ acceptMode: 'auto', disabledRules: ['copy'] }), [admitted])
    assert.deepEqual([...disabled], [
      [admitted.id, { rules: [{ id: 'copy', name: 'Copy fixes', change: 'disabled' }] }]
    ])
    const rewritten = impact(old, fixture({ acceptMode: 'auto', rule: { en: 'Fix spelling' } }), [
      addressed
    ])
    assert.deepEqual([...rewritten], [
      [
        addressed.id,
        { rules: [{ id: 'copy', name: 'Copy fixes', change: 'changed', instruction: 'Fix spelling' }] }
      ]
    ])
  })

  test('lowers proactive work when the accept mode leaves auto, and leaves explicit tickets alone', () => {
    const old = fixture({ acceptMode: 'auto' })
    const inferred = ticket({
      mandate: mandateOf(old.policy, inRow(TEAM, MEMBER), { tickets: [], rules: ['copy'] })
    })
    const explicit = ticket({
      id: 'ticket-2',
      mandate: mandateOf(old.policy, inRow(TEAM, MEMBER, 'mention'), { tickets: [], rules: ['copy'] })
    })
    const effects = impact(old, fixture({ acceptMode: 'observe' }), [inferred, explicit])
    assert.deepEqual([...effects.keys()], [inferred.id], 'only the proactive ticket is affected')
    assert.deepEqual(effects.get(inferred.id), { proactive: false })
  })

  test('reports a requester who can no longer start work: off the list, off the bots, or through a narrowed cell', () => {
    const old = fixture({ acceptMode: 'auto' })
    const addressed = ticket({
      mandate: mandateOf(old.policy, inRow(TEAM, MEMBER, 'mention'), { tickets: [], rules: ['copy'] })
    })
    const delisted = impact(old, fixture({ acceptMode: 'auto', allowed: [] }), [addressed])
    assert.deepEqual([...delisted], [
      [addressed.id, { requesterAllowed: false, requester: { source: 'chat', id: MEMBER } }]
    ])

    const narrow = fixture({
      acceptMode: 'auto',
      admission: { [TEAM]: { unlistedUnaddressed: 'inferred' } }
    })
    const guest = ticket({
      id: 'ticket-2',
      mandate: mandateOf(narrow.policy, inRow(TEAM, GUEST), { tickets: [], rules: ['copy'] })
    })
    const narrowed = policyEffects(narrow.block, fixture({ acceptMode: 'auto' }).block, [guest], {
      rows: rowsIn([TEAM])
    })
    assert.deepEqual([...narrowed], [
      [guest.id, { requesterAllowed: false, requester: { source: 'chat', id: GUEST } }]
    ])

    const bot = ticket({
      id: 'ticket-3',
      mandate: mandateOf(old.policy, machine(), { tickets: [], rules: ['copy'] })
    })
    const unlisted = impact(old, fixture({ acceptMode: 'auto', bots: [] }), [bot])
    assert.deepEqual([...unlisted], [
      [bot.id, { requesterAllowed: false, requester: { source: 'chat', id: BOT } }]
    ])
  })

  test('says nothing about untouched tickets, tickets already ended, or a change that keeps every authority', () => {
    const old = fixture({ acceptMode: 'auto' })
    const untouched = ticket({
      mandate: mandateOf(old.policy, inRow(TEAM, MEMBER, 'mention'), { tickets: [], rules: ['copy'] })
    })
    const ended = ticket({
      id: 'ticket-2',
      ended: { at: AT, by: 'executor', outcome: 'completed' },
      mandate: mandateOf(old.policy, inRow(TEAM, MEMBER), { tickets: [], rules: ['copy'] })
    })
    // 同一份内容：没有任何影响。
    assert.equal(impact(old, fixture({ acceptMode: 'auto' }), [untouched, ended]).size, 0)
    // 只放宽（名单变长）也不影响任何人。
    const widened = fixture({ acceptMode: 'auto', allowed: [{ id: MEMBER }, { id: GUEST }] })
    assert.equal(impact(old, widened, [untouched]).size, 0)
    // 会伤害一个开着的 Ticket 的变更，对已结束的 Ticket 什么都不说（它不再被通知）。
    const disabled = impact(old, fixture({ acceptMode: 'auto', disabledRules: ['copy'] }), [ended])
    assert.equal(disabled.size, 0)
  })
})

/**
 * 一次 Policy 保存的集成夹具：**真库** + 真仓储 + 真引擎 + 真正的设置写入器（`app/settings.ts`
 * 与它的 Policy 接线）。保存路径与生产同一条，所以断言的是「保存之后数据库、Ticket 输入与
 * 评估里发生了什么」，而不是私有方法的返回值（§P.1）。
 *
 * 生效的 Policy 块从设置里读（与组合根的同一条读法），所以一次保存立刻改变 Gate、复验与
 * 版本；没有保存过时回到夹具的初始块。
 */
function policySaveHarness(initial: FixtureInput = {}) {
  const opened = openTempStore()
  const observe = initial.observe ?? [TEAM]
  const initialBlock = fixture(initial)
  const repo = createRepositories(opened.store)
  const scope = { scope: (trigger: Trigger) => scopeOf(trigger, observe) }
  const rows = (source: string): readonly AdmissionRow[] => (source === 'chat' ? rowsOf(observe) : [])
  const requests: Candidate[] = []
  const stopped: string[] = []
  const delivered: string[] = []
  let sequence = 0
  /** 注入的虚拟时钟：超时与暂停顺延断言的是具体时刻，不 sleep（§P.1 第 4 条）。 */
  let clock = AT
  /** 处理是否暂停（§K.6；与 Policy 版本无关，因此不写进块）。 */
  let paused = false
  let engine: Engine

  const settings = createSettings({
    store: opened.store,
    now: () => clock,
    policy: createPolicySettingsPort({
      kinds: (source) => (source === 'chat' ? fixtureKind(observe) : undefined),
      rows,
      openTickets: () => repo.tickets.open(),
      changed: (from, to, effects) => engine.policyChanged(from, to, effects),
      current: () => initialBlock.block
    })
  })

  /** 生效的 Policy 块：已保存的那份，否则夹具的初始块（组合根读同一条）。 */
  const liveBlock = (): PolicyBlock => {
    const stored = settings.block('policy')?.config
    if (stored === undefined) return initialBlock.block
    const parsed = validatePolicy(stored, {
      kinds: (source) => (source === 'chat' ? fixtureKind(observe) : undefined)
    })
    return parsed.success ? parsed.data : initialBlock.block
  }

  engine = new Engine({
    repo,
    scope,
    policy: () => createPolicy({ block: liveBlock, sources: scope, rows, paused: () => paused }),
    assessor: { request: (candidate: Candidate) => void requests.push(candidate) },
    executor: {
      start: () => undefined,
      deliver: (ticket: Ticket) => void delivered.push(ticket.id),
      stop: (_ticket, _assignment, reason) => void stopped.push(reason)
    },
    outbox: {
      send: () => undefined,
      status: () => undefined,
      withdraw: () => undefined,
      withdrawTicket: () => undefined
    },
    // 虚拟时钟：超时与暂停顺延断言的是具体时刻（缺省就是夹具的 AT，不 sleep）。
    now: () => clock
  })

  /** 一条名单内的人在团队群里写的、没点名的消息（每条一个新 id）。 */
  const incoming = (): Trigger => {
    sequence += 1
    return message({ id: `trigger-${sequence}`, meta: { chatId: TEAM, direct: false } })
  }

  /** 收一条消息、跑一次评估并接受它；返回建出的 Ticket。 */
  const accept = (rules: readonly string[] = ['copy']): Ticket => {
    const trigger = incoming()
    engine.receive(trigger)
    engine.evaluateDue()
    engine.decide(trigger.id, {
      kind: 'accept',
      title: 'Fix the copy',
      scope: 'small',
      reason: 'asked for it',
      rules: [...rules]
    })
    const [ticket] = repo.tickets.list()
    assert.notEqual(ticket, undefined, 'the accept created a ticket')
    return ticket as Ticket
  }

  /** 保存一份 Policy 块（校验在写库之前，与生产一致）。 */
  const save = (value: unknown, origin: SettingsOrigin = 'panel'): SettingsSaveResult =>
    settings.save({
      block: 'policy',
      origin,
      value,
      validate: (candidate) =>
        validatePolicy(candidate, {
          kinds: (source) => (source === 'chat' ? fixtureKind(observe) : undefined)
        })
    })

  return {
    store: opened.store,
    repo,
    engine,
    settings,
    requests,
    stopped,
    delivered,
    incoming,
    accept,
    save,
    liveBlock,
    /** 当前虚拟时刻（ISO）。 */
    now: (): string => clock,
    /** 推时钟（毫秒）：过期与暂停顺延只靠它，不 sleep（§P.1）。 */
    advance: (milliseconds: number): void => {
      clock = new Date(Date.parse(clock) + milliseconds).toISOString()
    },
    /** 暂停/恢复处理（§K.6）：不写 Policy 块、不改版本。 */
    setPaused: (next: boolean): void => {
      paused = next
    },
    /** 一个 Thread 的当前行（`pending` / `evaluating` / `expired`）。 */
    thread: (key: string) => repo.threads.get(key),
    cleanup: opened.cleanup
  }
}

describe('a policy save (§K.5)', () => {
  test('records the content hash and the affected tickets in the version history', () => {
    const h = policySaveHarness({ acceptMode: 'auto' })
    try {
      const first = h.save(rawPolicy({ acceptMode: 'auto', admission: {} }))
      assert.equal(first.policyVersion, policyVersion(h.liveBlock()))
      const ticket = h.accept()
      const second = h.save(
        rawPolicy({
          acceptMode: 'auto',
          admission: {},
          rules: [
            { id: 'copy', name: 'Copy fixes', instruction: { zh: '改错别字', en: 'Fix typos' }, enabled: false }
          ]
        })
      )
      assert.notEqual(second.policyVersion, first.policyVersion, 'the version changed')
      assert.deepEqual(second.affectedTickets, [ticket.id])
      // 面板 History 读的就是这条快照（§K.5 第 5 条）：origin、policyVersion、受影响的 Ticket。
      assert.deepEqual(h.store.kvGet(settingsVersionKey(second.revision)), {
        at: AT,
        origin: 'panel',
        block: 'policy',
        policyVersion: second.policyVersion,
        affectedTickets: [ticket.id]
      })
      assert.equal(h.settings.block('policy')?.policyVersion, second.policyVersion)
    } finally {
      h.cleanup()
    }
  })

  test('records no new revision when the content is unchanged', () => {
    const h = policySaveHarness({ acceptMode: 'auto' })
    try {
      const value = rawPolicy({ acceptMode: 'auto', admission: {} })
      h.save(value)
      const again = h.save(value)
      assert.equal(again.changed, false)
      assert.equal(again.revision, 1)
      assert.equal(h.settings.revision(), 1)
      assert.deepEqual(h.store.kvGet(settingsVersionKey(2)), null)
    } finally {
      h.cleanup()
    }
  })

  test('keeps the version when only the Source listening config changes, and notifies nobody', () => {
    const h = policySaveHarness({ acceptMode: 'auto' })
    try {
      const first = h.save(rawPolicy({ acceptMode: 'auto', admission: {}, syncChat: 'oc_a' }))
      const ticket = h.accept()
      const second = h.save(rawPolicy({ acceptMode: 'auto', admission: {}, syncChat: 'oc_b' }))
      assert.equal(second.changed, true, 'the saved config did change')
      assert.equal(second.policyVersion, first.policyVersion, 'listening config is not policy content')
      assert.deepEqual(second.affectedTickets, [])
      const inputs = h.repo.tickets.get(ticket.id)?.inputs ?? []
      assert.deepEqual(inputs.filter((input) => input.kind === 'policy-changed'), [])
    } finally {
      h.cleanup()
    }
  })

  test('does not kill in-flight work: affected tickets get one policy-changed input and stay open', () => {
    const h = policySaveHarness({ acceptMode: 'auto' })
    try {
      const first = h.save(rawPolicy({ acceptMode: 'auto', admission: {} }))
      const ticket = h.accept()
      // 让 Assignment 处于 running（像 launch 回执已到）：通知经投递送去，而不是重开开工。
      const running = h.repo.tickets.get(ticket.id) as Ticket
      running.assignments[0]!.state = 'running'
      h.repo.tickets.save(running)
      const second = h.save(
        rawPolicy({
          acceptMode: 'auto',
          admission: {},
          rules: [
            { id: 'copy', name: 'Copy fixes', instruction: { zh: '改错别字', en: 'Fix typos' }, enabled: false }
          ]
        })
      )
      assert.deepEqual(h.delivered, [ticket.id], 'the notice goes through delivery to the running worker')
      const after = h.repo.tickets.get(ticket.id)
      assert.notEqual(after, undefined)
      assert.equal(after?.ended, undefined, 'a policy change never revokes a mandate on its own')
      assert.deepEqual(h.stopped, [], 'the running assignment is not interrupted')
      const notices = (after?.inputs ?? []).filter((input) => input.kind === 'policy-changed')
      assert.equal(notices.length, 1, 'one notice per affected ticket')
      assert.deepEqual(notices[0], {
        id: notices[0]?.id,
        kind: 'policy-changed',
        from: first.policyVersion,
        to: second.policyVersion,
        at: AT,
        effect: { rules: [{ id: 'copy', name: 'Copy fixes', change: 'disabled' }] }
      })
    } finally {
      h.cleanup()
    }
  })
})

describe('a policy change and the work in flight (§K.5)', () => {
  test('restarts a running assessment under the new version and requeues its trigger', () => {
    const h = policySaveHarness({ acceptMode: 'auto' })
    try {
      const first = h.save(rawPolicy({ acceptMode: 'auto', admission: {} }))
      h.engine.receive(h.incoming())
      h.engine.evaluateDue()
      const running = h.requests.at(-1)
      assert.notEqual(running, undefined)
      assert.equal(running?.policyVersion, first.policyVersion)
      const second = h.save(rawPolicy({ acceptMode: 'observe', admission: {} }))
      // 在跑的评估被结束成 unavailable(policyChanged)，它的 Trigger 重新排队。
      const [decided] = h.repo.decisions.byThread('chat:room')
      assert.equal(decided?.kind, 'unavailable')
      assert.deepEqual(decided?.reason, [{ code: 'policyChanged' }])
      h.engine.evaluateDue()
      const reassessed = h.requests.at(-1)
      assert.notEqual(reassessed, undefined)
      assert.notEqual(reassessed?.evalId, running?.evalId, 'the old assessment is discarded')
      assert.equal(reassessed?.policyVersion, second.policyVersion, 'the new one runs under the new version')
    } finally {
      h.cleanup()
    }
  })

  test('revokes a mandate that no longer holds: the ended ticket stays ended and the message goes back to the evaluation', () => {
    const h = policySaveHarness({ acceptMode: 'auto' })
    try {
      h.save(rawPolicy({ acceptMode: 'auto', admission: {} }))
      const ticket = h.accept()
      // 工作交回的结局：Ticket 结束，Mandate 仍在。
      h.engine.report(ticket.id, { state: 'ready', summary: 'done' })
      assert.equal(h.repo.tickets.get(ticket.id)?.ended?.outcome, 'completed')
      const assignments = h.repo.tickets.get(ticket.id)?.assignments.length ?? 0
      // 收紧 Policy：推断强度不再被接受。
      h.save(rawPolicy({ acceptMode: 'observe', admission: {} }))
      const message = h.incoming()
      h.engine.receive(message)
      // 复验失败：Ticket 保持结束，等它的消息不被吞掉，而是回到评估。
      const after = h.repo.tickets.get(ticket.id)
      assert.notEqual(after?.ended, undefined, 'the ticket stays ended')
      assert.equal(after?.assignments.length, assignments, 'no new assignment started')
      assert.equal(
        (h.repo.triggers.disposition(message.id)?.fanout ?? []).includes(ticket.id),
        false,
        'the Router is not told it reached the worker'
      )
      h.engine.evaluateDue()
      const candidate = h.requests.at(-1)
      assert.deepEqual(candidate?.triggers.map((trigger) => trigger.id), [message.id], 'it is evaluated')
      // Thread 上仍有一张（已结束、没被人停的）Ticket：这条消息按 follow-up 得到显式强度，
      // 可以走成一张新 Ticket，而不是被那张复验失败的 Ticket 吞掉（§K.2 第 3 条、§K.3）。
      assert.equal(candidate?.strength, 'explicit')
      assert.equal(candidate?.triggers.length, 1)
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------- Eval 超时与 unavailable（§K.7）

/** 把最新一条候选标记为「送达 assessor 会话」：截止时间从此刻起算（§K.7 起算行）。 */
function deliverLatest(h: ReturnType<typeof policySaveHarness>): string {
  const candidate = h.requests.at(-1)
  assert.notEqual(candidate, undefined, 'an eval is waiting for its candidate')
  h.engine.candidateDelivered(candidate!.evalId)
  return candidate!.evalId
}

describe('the Eval deadline (§K.7)', () => {
  test('starts at delivery, never passes before it, and the third expiry is unavailable with its attempt count', () => {
    const h = policySaveHarness({ acceptMode: 'observe', timeoutSeconds: 30 })
    try {
      h.engine.receive(h.incoming())
      h.engine.evaluateDue()
      assert.deepEqual(
        h.requests.map((item) => item.triggers.map((trigger) => trigger.id)),
        [['trigger-1']]
      )
      // 还没送达：推过三倍超时也不过期，也不记 Decision。
      h.advance(120_000)
      h.engine.evaluateDue()
      assert.equal(h.requests.length, 1, 'an undelivered candidate never expires')
      assert.deepEqual(h.repo.decisions.byThread('chat:room'), [])
      // 送达当刻起算 timeoutSeconds（断言具体时刻）。
      const deliveredAt = h.now()
      deliverLatest(h)
      assert.equal(h.thread('chat:room')?.evaluating?.delivered, deliveredAt)
      assert.equal(h.thread('chat:room')?.evaluating?.deadline, isoAfter(deliveredAt, 30_000))
      // 到点前不过期；到点那一秒过期并把 Trigger 重新入队，不记 Decision。
      h.advance(29_000)
      h.engine.evaluateDue()
      assert.equal(h.requests.length, 1)
      h.advance(2_000)
      h.engine.evaluateDue()
      assert.equal(h.requests.length, 2, 'the trigger is queued again for a new eval')
      assert.deepEqual(h.repo.decisions.byThread('chat:room'), [], 'an expiry is not a Decision')
      // 第二次到期再排一次；第三次到期记 unavailable（带尝试次数），不再重试。
      deliverLatest(h)
      h.advance(31_000)
      h.engine.evaluateDue()
      assert.equal(h.requests.length, 3)
      assert.deepEqual(h.repo.decisions.byThread('chat:room'), [])
      deliverLatest(h)
      h.advance(31_000)
      h.engine.evaluateDue()
      assert.equal(h.requests.length, 3, 'retries are bounded: no fourth attempt')
      const [decision] = h.repo.decisions.byThread('chat:room')
      assert.equal(decision?.kind, 'unavailable', 'a timeout is never an accept or an ignore')
      assert.deepEqual(decision?.reason, [{ code: 'timeout', values: { attempts: '3' } }])
      assert.equal(decision?.ticketId, undefined)
      assert.deepEqual(h.repo.tickets.list(), [], 'a failed assessment never creates a ticket')
      // 后续新 Trigger 照样开新 Eval（失败的评估不阻塞 Thread）。
      h.engine.receive(h.incoming())
      h.engine.evaluateDue()
      assert.equal(h.requests.length, 4)
    } finally {
      h.cleanup()
    }
  })

  test('pausing stops the deadline and resuming moves it by exactly the paused time', () => {
    const h = policySaveHarness({ acceptMode: 'observe', timeoutSeconds: 30 })
    try {
      h.engine.receive(h.incoming())
      h.engine.evaluateDue()
      const deliveredAt = h.now()
      deliverLatest(h)
      assert.equal(h.thread('chat:room')?.evaluating?.deadline, isoAfter(deliveredAt, 30_000))
      // 15 秒后暂停：pass 记下暂停开始的时刻；暂停不计超时（§K.6）。
      h.advance(15_000)
      h.setPaused(true)
      h.engine.evaluateDue()
      assert.equal(h.thread('chat:room')?.evaluating?.pausedAt, isoAfter(deliveredAt, 15_000))
      h.advance(1_000_000)
      h.engine.evaluateDue()
      assert.equal(h.requests.length, 1, 'a paused assessment does not expire')
      assert.deepEqual(h.repo.decisions.byThread('chat:room'), [])
      // 恢复：截止时间后移「暂停时长」（1_000_000 ms），恢复那一刻不算过期。
      h.setPaused(false)
      h.engine.evaluateDue()
      assert.equal(h.thread('chat:room')?.evaluating?.deadline, isoAfter(deliveredAt, 1_030_000))
      assert.equal(h.thread('chat:room')?.evaluating?.pausedAt, undefined)
      // 顺延后的到点前 1 ms 仍不过期，到点才过期。
      h.advance(14_999)
      h.engine.evaluateDue()
      assert.equal(h.requests.length, 1)
      h.advance(2)
      h.engine.evaluateDue()
      assert.equal(h.requests.length, 2)
    } finally {
      h.cleanup()
    }
  })

  test('pause starts no new assessment, and the one in flight can still be decided', () => {
    const h = policySaveHarness({ acceptMode: 'observe', timeoutSeconds: 30 })
    try {
      h.engine.receive(h.incoming())
      h.engine.evaluateDue()
      const evalId = deliverLatest(h)
      h.setPaused(true)
      h.engine.evaluateDue()
      // 暂停期间到来的新 Trigger 只排队，不开始评估。
      h.engine.receive(h.incoming())
      h.engine.evaluateDue()
      assert.equal(h.requests.length, 1, 'pause starts no new evaluation')
      assert.deepEqual(h.thread('chat:room')?.pending, ['trigger-2'])
      // 在跑的那次评估照样能被决定：暂停不打断已经开始的评估。
      const decision = h.engine.decide('trigger-1', { kind: 'ignore', reason: 'chatter', evalId })
      assert.equal(decision.kind, 'ignore')
      // 恢复后排队的那条才开评估。
      h.setPaused(false)
      h.engine.evaluateDue()
      assert.equal(h.requests.length, 2)
      assert.deepEqual(
        h.requests.at(-1)?.triggers.map((trigger) => trigger.id),
        ['trigger-2']
      )
    } finally {
      h.cleanup()
    }
  })

  test('an assessment that fails records unavailable and opens no ticket', () => {
    const h = policySaveHarness({ acceptMode: 'auto' })
    try {
      h.engine.receive(h.incoming())
      h.engine.evaluateDue()
      const candidate = h.requests.at(-1)!
      const decision = h.engine.decide('trigger-1', {
        kind: 'unavailable',
        reason: 'the tool read failed',
        evalId: candidate.evalId
      })
      assert.equal(decision.kind, 'unavailable')
      assert.deepEqual(decision.reason, [{ code: 'said', values: { text: 'the tool read failed' } }])
      assert.equal(decision.ticketId, undefined)
      assert.deepEqual(h.repo.tickets.list(), [])
      // 后续新 Trigger 可开新 Eval。
      h.engine.receive(h.incoming())
      h.engine.evaluateDue()
      assert.equal(h.requests.length, 2)
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------- 待人工与 evals 健康项（§K.7、§N.4）

describe('the panel\'s pending-human rule and the evals health count (§K.7)', () => {
  /** 跑一次评估并让它失败（`unavailable`，§K.7 的「评估失败」行），返回那条 Decision。 */
  function failedAssessment(h: ReturnType<typeof policySaveHarness>) {
    const trigger = h.incoming()
    h.engine.receive(trigger)
    h.engine.evaluateDue()
    const candidate = h.requests.at(-1)
    assert.notEqual(candidate, undefined)
    return h.engine.decide(trigger.id, {
      kind: 'unavailable',
      reason: 'the tool read failed',
      evalId: candidate!.evalId
    })
  }

  /** 读模型看到的问题（真库 + 注入的「现在」）。 */
  const problems = (h: ReturnType<typeof policySaveHarness>) =>
    readUnavailableProblems({ sql: h.store.sql }, { now: h.now() })

  /** 健康项 `evals` 的读数（1 h 内未解决的 unavailable，§N.4）。 */
  const health = (h: ReturnType<typeof policySaveHarness>) => readEvalsHealth({ sql: h.store.sql }, h.now())

  test('an unresolved unavailable on an idle thread is one problem, with the thread and the reason', () => {
    const h = policySaveHarness({ acceptMode: 'observe' })
    try {
      const decision = failedAssessment(h)
      const found = problems(h)
      assert.deepEqual(found, [
        {
          decisionId: decision.id,
          evalId: decision.evalId,
          threadKey: 'chat:room',
          at: h.now(),
          reason: 'the tool read failed',
          triggerIds: ['trigger-1']
        }
      ])
    } finally {
      h.cleanup()
    }
  })

  test('dismissing a problem removes it for good and creates no ticket', () => {
    const h = policySaveHarness({ acceptMode: 'observe' })
    try {
      const decision = failedAssessment(h)
      assert.equal(problems(h).length, 1)
      const dismissed = h.engine.dismiss(decision.id)
      assert.equal(dismissed.dismissed, true)
      assert.deepEqual(problems(h), [], 'a dismissed decision is not a pending problem')
      assert.deepEqual(problems(h), [], 'dismiss is permanent for that decision')
      assert.deepEqual(h.repo.tickets.list(), [], 'dismissing creates no ticket')
      // 同一条再 dismiss 是幂等的，不会变成别的状态。
      assert.equal(h.engine.dismiss(decision.id).dismissed, true)
      // 非 unavailable 的 Decision 不能被 dismiss（固定拒绝 `unknownProblem`）。
      assert.throws(
        () => h.engine.dismiss('decision-nope'),
        (error: unknown) => error instanceof UserError && error.code === 'unknownProblem'
      )
    } finally {
      h.cleanup()
    }
  })

  test('a decision that is no longer the thread\'s latest is not pending-human', () => {
    const h = policySaveHarness({ acceptMode: 'observe' })
    try {
      failedAssessment(h)
      assert.equal(problems(h).length, 1)
      h.advance(1_000)
      const later = h.incoming()
      h.engine.receive(later)
      h.engine.evaluateDue()
      h.engine.decide(later.id, { kind: 'ignore', reason: 'chatter' })
      assert.deepEqual(problems(h), [])
    } finally {
      h.cleanup()
    }
  })

  test('a thread that is queued or evaluating is not pending-human', () => {
    const h = policySaveHarness({ acceptMode: 'observe' })
    try {
      failedAssessment(h)
      assert.equal(problems(h).length, 1)
      // 新 Trigger 排队等评估（queued）。
      h.advance(1_000)
      h.engine.receive(h.incoming())
      assert.deepEqual(h.thread('chat:room')?.pending.length, 1)
      assert.deepEqual(problems(h), [], 'a queued thread hides the old problem')
      // 评估真的开始（evaluating）。
      h.engine.evaluateDue()
      assert.notEqual(h.thread('chat:room')?.evaluating, undefined)
      assert.deepEqual(problems(h), [], 'an evaluating thread hides the old problem')
    } finally {
      h.cleanup()
    }
  })

  test('a problem older than 24 hours is not pending-human, and the evals count covers only the last hour', () => {
    const h = policySaveHarness({ acceptMode: 'observe' })
    try {
      failedAssessment(h)
      assert.equal(health(h).detail, 'unavailable 1 in the last hour')
      // 59 分钟后仍然算数；超过一小时不再计入健康项。
      h.advance(59 * 60 * 1000)
      assert.equal(health(h).detail, 'unavailable 1 in the last hour')
      h.advance(2 * 60 * 1000)
      assert.equal(health(h).detail, 'unavailable 0 in the last hour')
      assert.equal(problems(h).length, 1, 'still within the 24 h panel window')
      // 超过 24 小时：面板也不再把它算进待人工（但健康项早已为 0）。
      h.advance(24 * 60 * 60 * 1000)
      assert.deepEqual(problems(h), [])
      assert.equal(health(h).state, 'ready')
    } finally {
      h.cleanup()
    }
  })

  test('dismissing and a superseding decision also leave the evals health count at zero', () => {
    const h = policySaveHarness({ acceptMode: 'observe' })
    try {
      const decision = failedAssessment(h)
      assert.equal(health(h).detail, 'unavailable 1 in the last hour')
      h.engine.dismiss(decision.id)
      assert.equal(health(h).detail, 'unavailable 0 in the last hour')

      // 同一 Thread 上的下一次失败是新的一条决定（换一个时刻，读序才确定）。
      h.advance(1_000)
      const second = failedAssessment(h)
      assert.equal(health(h).detail, 'unavailable 1 in the last hour')
      h.advance(1_000)
      const later = h.incoming()
      h.engine.receive(later)
      h.engine.evaluateDue()
      h.engine.decide(later.id, { kind: 'ignore', reason: 'chatter' })
      assert.equal(second.kind, 'unavailable')
      assert.equal(health(h).detail, 'unavailable 0 in the last hour')
    } finally {
      h.cleanup()
    }
  })
})

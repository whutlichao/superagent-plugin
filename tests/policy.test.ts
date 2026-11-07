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
import { Engine, MemoryRepositories, STRENGTHS } from '../src/worker/core/index.ts'
import type {
  AcceptMode,
  Candidate,
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
  UNVERSIONED_POLICY,
  validatePolicy
} from '../src/worker/policy/index.ts'
import type {
  AdmissionRow,
  AdmissionTableConfig,
  PolicyKindView
} from '../src/worker/policy/index.ts'
import { object, string } from '../src/worker/infra/schema.ts'

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
}

/** 造一个已校验的 Policy 块 + 它的 Gate；默认 observe 模式、只观察 `oc_team`。 */
function fixture(input: FixtureInput = {}) {
  const observe = input.observe ?? [TEAM]
  const raw = {
    rules: [
      { id: 'copy', name: 'Copy fixes', instruction: { zh: '改错别字', en: 'Fix typos' }, enabled: true }
    ],
    acceptMode: input.acceptMode ?? 'observe',
    sources: {
      chat: {
        allowed: input.allowed ?? [{ id: MEMBER, name: 'Alice' }],
        bots: (input.bots ?? [BOT]).map((id) => ({ id })),
        admission: input.admission ?? {}
      }
    },
    eval: { timeoutSeconds: 300 }
  }
  const kinds = (source: string): PolicyKindView | undefined =>
    source === 'chat' ? { rows: () => rowsOf(observe) } : undefined
  const parsed = validatePolicy(raw, { kinds })
  assert.equal(parsed.success, true, JSON.stringify(parsed))
  if (!parsed.success) throw new Error('unreachable')
  const policy = createPolicy({
    block: () => parsed.data,
    sources: { scope: (trigger: Trigger) => scopeOf(trigger, observe) },
    rows: (source: string) => (source === 'chat' ? rowsOf(observe) : []),
    version: () => UNVERSIONED_POLICY
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
    version: () => UNVERSIONED_POLICY
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
      version: () => UNVERSIONED_POLICY
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
      withdraw: () => undefined
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

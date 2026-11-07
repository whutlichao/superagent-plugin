// 设置草稿状态机与保存栏（§M.3、§C.1 `panel/draft.ts`）。
// 事实来源：设计 §M.3 的四条 —— 草稿为空时不占空间；有改动显示「N changes · Save / Discard」；
// 保存中显示进行中；失败显示 issues（字段级 invalid）；冲突（409）显示「这一段在别处被改过」。
import { assert, test } from 'orca/testing'
import {
  barShown,
  changeCount,
  changedLeafCount,
  draftReducer,
  groupSaveBar,
  initialDraft,
  saveBar,
  type DraftAction,
  type DraftState,
  type SaveBar
} from '../src/panel/draft'

/** 断言保存栏占空间，并把它收窄成可读字段的形状。 */
const shown = (bar: SaveBar): Extract<SaveBar, { visible: true }> => {
  assert.ok(barShown(bar), 'the save bar takes space')
  return bar
}

/** 一段设置块的值。 */
interface Block {
  readonly mode: 'off' | 'observe' | 'auto'
  readonly timeoutSeconds: number
}

const SAVED: Block = { mode: 'observe', timeoutSeconds: 120 }

/** 依次施加动作。 */
const after = (actions: readonly DraftAction<Block>[], from: DraftState<Block> = initialDraft(SAVED, 7)): DraftState<Block> =>
  actions.reduce(draftReducer<Block>, from)

const edit = (value: Block): DraftAction<Block> => ({ type: 'edit', value, saved: SAVED, revision: 7 })

test('a fresh draft is clean, saves no space and offers no action', () => {
  const state = initialDraft(SAVED, 7)
  assert.equal(state.phase, 'clean')
  assert.equal(state.draft, undefined)
  assert.deepEqual(saveBar('en', state), { visible: false })
})

test('editing one field makes the draft dirty and names how many values changed', () => {
  const state = after([edit({ ...SAVED, mode: 'auto' })])
  assert.equal(state.phase, 'editing')
  assert.equal(changeCount(SAVED, state.draft!.value), 1)
  assert.deepEqual(shown(saveBar('en', state)), {
    visible: true,
    status: '1 change',
    dirty: true,
    busy: false,
    canSave: true
  })
  // 改回原值等于没有草稿：不占空间。
  assert.equal(after([edit({ ...SAVED, mode: 'auto' }), edit(SAVED)]).phase, 'clean')
  assert.equal(changeCount(SAVED, { ...SAVED, mode: 'auto', timeoutSeconds: 60 }), 2)
})

test('saving holds further edits, then waits for the revision its save made', () => {
  const saving = after([edit({ ...SAVED, mode: 'auto' }), { type: 'submit' }])
  assert.equal(saving.phase, 'saving')
  assert.deepEqual(shown(saveBar('en', saving)), {
    visible: true,
    status: 'Saving…',
    dirty: true,
    busy: true,
    canSave: false
  })
  // 保存中不接受新编辑，也不接受并发到达的修订。
  assert.equal(after([edit(SAVED)], saving), saving)
  const waiting = after([{ type: 'saved', revision: 8, restarting: false }], saving)
  assert.equal(waiting.phase, 'awaitingRevision')
  assert.deepEqual(waiting.sent, { value: { ...SAVED, mode: 'auto' }, revision: 8, restarting: false })
  // 更旧的修订到达不结束等待，保存中的值继续显示。
  assert.equal(after([{ type: 'revisionArrived', saved: SAVED, revision: 7 }], waiting).phase, 'awaitingRevision')
  // 自己那次保存的修订到达 → 干净，显示「已保存」。
  const clean = after([{ type: 'revisionArrived', saved: { ...SAVED, mode: 'auto' }, revision: 8 }], waiting)
  assert.equal(clean.phase, 'clean')
  assert.deepEqual(saveBar('en', clean), { visible: false })
})

test('a failed save keeps the draft and words the failure', () => {
  const saving = after([edit({ ...SAVED, mode: 'auto' }), { type: 'submit' }])
  const failed = after([{ type: 'refused', notice: { kind: 'failed', error: 'worker is starting' } }], saving)
  assert.equal(failed.phase, 'editing')
  assert.deepEqual(shown(saveBar('en', failed)), {
    visible: true,
    error: 'Save failed: worker is starting',
    dirty: true,
    busy: false,
    canSave: true
  })
})

test('field-level issues are listed by path, in the panel language', () => {
  const saving = after([edit({ ...SAVED, mode: 'auto' }), { type: 'submit' }])
  const invalid = after(
    [
      {
        type: 'refused',
        notice: { kind: 'invalid', issues: [{ path: 'timeoutSeconds', message: 'must be 30–600' }] }
      }
    ],
    saving
  )
  assert.equal(invalid.phase, 'editing')
  const bar = shown(saveBar('en', invalid))
  assert.equal(bar.error, 'These fields are invalid: timeoutSeconds')
  assert.equal(bar.dirty, true)
})

test('a 409 asks whether to reload, and keeps the draft until the person answers', () => {
  const saving = after([edit({ ...SAVED, mode: 'auto' }), { type: 'submit' }])
  const conflict = after([{ type: 'refused', notice: { kind: 'conflict', revision: 9 } }], saving)
  assert.equal(conflict.phase, 'editing')
  const bar = shown(saveBar('en', conflict))
  assert.equal(bar.error, 'This block changed elsewhere (now at revision 9). Reload the latest?')
  assert.equal(bar.reload, true)
  assert.equal(conflict.draft!.value.mode, 'auto', 'the person keeps their text until they choose')
  // 选择重新载入 → 采纳服务端值，草稿清空。
  const reloaded = after([{ type: 'reloaded', saved: { ...SAVED, mode: 'off' }, revision: 9 }], conflict)
  assert.equal(reloaded.phase, 'clean')
  assert.deepEqual(saveBar('en', reloaded), { visible: false })
})

test('a newer revision arriving mid-edit is reported, and the next edit keeps the report until it is resolved', () => {
  const editing = after([edit({ ...SAVED, mode: 'auto' })])
  const merged = after([{ type: 'revisionArrived', saved: SAVED, revision: 8 }], editing)
  assert.equal(merged.phase, 'editing')
  assert.deepEqual(merged.draft, { base: SAVED, value: { ...SAVED, mode: 'auto' }, revision: 8 })
  assert.equal(shown(saveBar('en', merged)).status, '1 change')
  // 新修订把已保存值改成了草稿里的值：没有可保存的改动。
  const caughtUp = after(
    [{ type: 'revisionArrived', saved: { ...SAVED, mode: 'auto' }, revision: 9 }],
    merged
  )
  assert.equal(caughtUp.phase, 'clean')
})

test('discard drops the draft and its notices', () => {
  const editing = after([edit({ ...SAVED, mode: 'auto' })])
  assert.equal(after([{ type: 'discard' }], editing).phase, 'clean')
  // 保存中不能放弃。
  const saving = after([
    edit({ ...SAVED, mode: 'auto' }),
    { type: 'submit' }
  ])
  assert.equal(after([{ type: 'discard' }], saving), saving)
})

test('the save bar counts changed leaves, not just changed top-level keys', () => {
  // 一个设置组是一棵有嵌套的对象（规则、准入表、来源配置）；「N 处改动」要按真正的值数，
  // 否则改了三格的准入表会显示成「1 处改动」。数组按整体算一处（增删一行是一次改动）。
  const saved = {
    acceptMode: 'observe',
    rules: [{ id: 'ship', enabled: true }],
    sources: { github: { admission: { issues: { listedUnaddressed: 'inferred' } } } }
  }
  const drifted = {
    acceptMode: 'auto',
    rules: [{ id: 'ship', enabled: true }],
    sources: { github: { admission: { issues: { listedUnaddressed: 'ignore' } } } }
  }
  assert.equal(changedLeafCount(saved, saved), 0, 'the same value changes nothing')
  assert.equal(changedLeafCount(saved, drifted), 2, 'the mode and the admission cell')
  assert.equal(changedLeafCount(saved, { ...saved, rules: [] }), 1, 'an edited list is one change')
  assert.equal(changeCount(saved, drifted), 2, 'top-level counting is still available')

  const state = draftReducer(initialDraft(saved), { type: 'edit', value: drifted, saved, revision: 7 })
  assert.equal(shown(saveBar('en', state)).status, '2 changes')
})

test('a group draft made of several settings blocks counts every changed value', () => {
  // Sources 组一次保存两个实例块；保存栏数的是这些块加起来改了几个值（不是改了两个块）。
  interface Group {
    readonly 'source:github': { readonly enabled: boolean; readonly config: { readonly observeIssues: boolean } }
    readonly 'source:feishu': { readonly enabled: boolean; readonly config: Record<string, never> }
  }
  const saved: Group = {
    'source:github': { enabled: true, config: { observeIssues: false } },
    'source:feishu': { enabled: false, config: {} }
  }
  const value: Group = {
    'source:github': { enabled: true, config: { observeIssues: true } },
    'source:feishu': { enabled: true, config: {} }
  }
  const state = draftReducer<Group>(initialDraft(saved), { type: 'edit', value, saved, revision: 7 })
  assert.equal(state.phase, 'editing')
  assert.equal(shown(saveBar('en', state)).status, '2 changes')
  // 两个块都改回原值即没有草稿，保存栏不占空间。
  const back = draftReducer<Group>(state, { type: 'edit', value: saved, saved, revision: 7 })
  assert.equal(back.phase, 'clean')
  assert.deepEqual(saveBar('en', back), { visible: false })
})

test('the save bar speaks both languages', () => {
  const editing = after([edit({ ...SAVED, mode: 'auto' })])
  assert.equal(shown(saveBar('zh-CN', editing)).status, '1 处改动')
  const saving = after([{ type: 'submit' }], editing)
  assert.equal(shown(saveBar('zh-CN', saving)).status, '正在保存…')
  const failed = after([{ type: 'refused', notice: { kind: 'failed', error: '离线' } }], saving)
  assert.equal(shown(saveBar('zh-CN', failed)).error, '保存失败：离线')
})

test('a group bar counts every changed value across its blocks, and shows saving first', () => {
  // Sources 组一次覆盖多个块（每个实例一个块）：合成后的保存栏仍只有一条。
  const saved = { observeIssues: false, pollSeconds: 60 }
  const dirty = draftReducer(initialDraft(saved), {
    type: 'edit',
    value: { observeIssues: true, pollSeconds: 120 },
    saved,
    revision: 2
  })
  const clean = initialDraft(saved)
  const bar = shown(groupSaveBar('en', [
    { state: dirty, saved },
    { state: clean, saved }
  ]))
  assert.equal(bar.status, '2 changes')
  assert.equal(bar.dirty, true)
  // 全部干净时不占空间。
  assert.deepEqual(groupSaveBar('en', [{ state: clean, saved }]), { visible: false })
  // 任一块在保存中，整条栏说「正在保存」。
  const saving = draftReducer(dirty, { type: 'submit' })
  const savingBar = shown(
    groupSaveBar('en', [
      { state: dirty, saved },
      { state: saving, saved }
    ])
  )
  assert.equal(savingBar.status, 'Saving…')
  assert.equal(savingBar.busy, true)
  // 一条失败 notice 压过计数（人在等这一条），但草稿仍可再保存。
  const failed = draftReducer(dirty, {
    type: 'refused',
    notice: { kind: 'failed', error: 'offline' }
  })
  const failedBar = shown(groupSaveBar('en', [{ state: failed, saved }]))
  assert.equal(failedBar.error, 'Save failed: offline')
  assert.equal(failedBar.canSave, true)
})

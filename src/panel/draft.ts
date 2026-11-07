// 设置草稿状态机与保存栏（§M.3、§C.1 `panel/draft.ts`）。
// 事实来源是设计 §M.3 的五条：草稿为空时不占空间；有改动显示「N changes · Save / Discard」；
// 保存中显示进行中；失败显示 issues（字段级 invalid）；冲突（409）问「这一段在别处被改过，
// 要重新载入吗」。状态机是纯的：它不认识 `orca`，也不认识 worker，页面票只负责接线。
import { translate, type CopyKey } from './copy'

/** 草稿阶段：干净 / 编辑中 / 保存中 / 等自己那次保存的修订回来。 */
export type DraftPhase = 'clean' | 'editing' | 'saving' | 'awaitingRevision'

/** 一次被拒绝的保存，或一条要让保存栏说的话。 */
export type DraftNotice =
  | { readonly kind: 'failed'; readonly error: string }
  | { readonly kind: 'invalid'; readonly issues: readonly { readonly path: string; readonly message: string }[] }
  | { readonly kind: 'conflict'; readonly revision: number }

/** 草稿本体：`base` 是它开始编辑时的已保存值。 */
export interface DraftBody<V> {
  readonly base: V
  readonly value: V
  readonly revision: number
}

/** 设置块的状态。 */
export interface DraftState<V> {
  readonly phase: DraftPhase
  readonly draft?: DraftBody<V>
  readonly sent?: { readonly value: V; readonly revision: number; readonly restarting: boolean }
  readonly notice?: DraftNotice
}

/** 页面在草稿上能施加的动作。 */
export type DraftAction<V> =
  | { readonly type: 'edit'; readonly value: V; readonly saved: V; readonly revision: number }
  | { readonly type: 'discard' }
  | { readonly type: 'submit' }
  | { readonly type: 'saved'; readonly revision: number; readonly restarting: boolean }
  | { readonly type: 'refused'; readonly notice: DraftNotice }
  | { readonly type: 'revisionArrived'; readonly saved: V; readonly revision: number }
  | { readonly type: 'reloaded'; readonly saved: V; readonly revision: number }

/**
 * 一个干净的初始状态。起点的已保存值与修订号由页面在第一次 `edit` 动作里带上，
 * 所以这里不需要参数（`initialDraft(SAVED, 7)` 的调用形态保留给页面票读起来更清楚）。
 */
export function initialDraft<V>(saved?: V, revision?: number): DraftState<V> {
  void saved
  void revision
  return { phase: 'clean' }
}

/** 结构化相等：设置块是 JSON 值，键序不影响相等。 */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** 两个值之间改了几个叶子（顶层键；数组与嵌套对象算一个值）。 */
export function changeCount(saved: unknown, value: unknown): number {
  if (!isRecord(saved) || !isRecord(value)) return same(saved, value) ? 0 : 1
  const keys = new Set([...Object.keys(saved), ...Object.keys(value)])
  let changed = 0
  for (const key of keys) {
    if (!same(saved[key], value[key])) changed += 1
  }
  return changed
}

/**
 * 把一个值摊平成「路径 → 叶子」：对象递归，数组与标量算叶子。
 * 数组按整体算一处改动（增删一行是一次改动，不按元素拆开数）。
 */
export function flattenLeaves(value: unknown, prefix = ''): Record<string, unknown> {
  if (!isRecord(value)) return { [prefix]: value }
  const leaves: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    Object.assign(leaves, flattenLeaves(item, path))
  }
  return leaves
}

/**
 * 两个值之间的叶子改动数（保存栏的「N changes」）：设置组是一棵有嵌套的对象，
 * 按顶层键数会把「改了三格准入表」显示成一处改动，而人要知道真正改了几个值。
 */
export function changedLeafCount(saved: unknown, value: unknown): number {
  const before = flattenLeaves(saved)
  const after = flattenLeaves(value)
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  let changed = 0
  for (const key of keys) {
    if (!same(before[key], after[key])) changed += 1
  }
  return changed
}

/**
 * 一个组里真正改了的块名（多个块的组按块保存）：顺序按草稿里的键序。
 * 只用于「该发几次保存」，不参与「N changes」的计数。
 */
export function changedBlocks(
  saved: Readonly<Record<string, unknown>>,
  value: Readonly<Record<string, unknown>>
): string[] {
  const keys = new Set([...Object.keys(saved), ...Object.keys(value)])
  return [...keys].filter((key) => !same(saved[key], value[key]))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 状态机：唯一改变状态的地方，动作之外没有副作用。 */
export function draftReducer<V>(state: DraftState<V>, action: DraftAction<V>): DraftState<V> {
  switch (action.type) {
    case 'edit': {
      if (state.phase === 'saving' || state.phase === 'awaitingRevision') return state
      if (same(action.value, action.saved)) return { phase: 'clean' }
      const draft: DraftBody<V> = {
        base: state.draft?.base ?? action.saved,
        value: action.value,
        revision: state.draft?.revision ?? action.revision
      }
      return {
        phase: 'editing',
        draft,
        ...(state.notice ? { notice: state.notice } : {})
      }
    }
    case 'discard':
      return state.phase === 'saving' || state.phase === 'awaitingRevision' ? state : { phase: 'clean' }
    case 'submit':
      return state.phase === 'editing' ? { ...state, phase: 'saving' } : state
    case 'saved':
      return state.phase === 'saving' && state.draft
        ? {
            phase: 'awaitingRevision',
            draft: state.draft,
            sent: { value: state.draft.value, revision: action.revision, restarting: action.restarting }
          }
        : state
    case 'refused':
      return { ...state, phase: state.phase === 'saving' ? 'editing' : state.phase, notice: action.notice }
    case 'revisionArrived': {
      if (state.phase === 'saving') return state
      if (state.sent) {
        return action.revision >= state.sent.revision ? { phase: 'clean' } : state
      }
      if (!state.draft) return state
      if (same(state.draft.value, action.saved)) return { phase: 'clean' }
      if (state.draft.revision === action.revision) return state
      // 新修订进来：草稿以新的已保存值为 base，改过的值仍是草稿的值。
      return {
        phase: 'editing',
        draft: { base: action.saved, value: state.draft.value, revision: action.revision },
        ...(state.notice ? { notice: state.notice } : {})
      }
    }
    case 'reloaded':
      // 重新载入采纳服务端的已保存值：草稿结束。
      return { phase: 'clean' }
  }
}

/** 保存栏要渲染的东西；`visible: false` 时它不占空间。 */
export type SaveBar =
  | { readonly visible: false }
  | {
      readonly visible: true
      readonly status?: string
      readonly error?: string
      /** 草稿与已保存值不同 → 「保存 / 放弃修改」可用。 */
      readonly dirty: boolean
      readonly busy: boolean
      readonly canSave: boolean
      /** 冲突（409）时给「重新载入」入口。 */
      readonly reload?: boolean
    }

/** 判断保存栏是否占空间（测试与页面都先看这个，再读其余字段）。 */
export function barShown(bar: SaveBar): bar is Extract<SaveBar, { visible: true }> {
  return bar.visible
}

/** 一条 notice 的保存栏（失败 / 字段级 invalid / 冲突四种措辞只在这里写一次）。 */
function noticeBar(locale: string, notice: DraftNotice, dirty: boolean): SaveBar {
  if (notice.kind === 'failed') {
    return {
      visible: true,
      error: translate(locale, 'draft.failed', { error: notice.error }),
      dirty,
      busy: false,
      canSave: dirty
    }
  }
  if (notice.kind === 'invalid') {
    const fields = notice.issues.map((issue) => issue.path).join(translate(locale, 'draft.listSeparator'))
    return {
      visible: true,
      error: translate(locale, 'draft.invalid', { fields }),
      dirty,
      busy: false,
      canSave: dirty
    }
  }
  return {
    visible: true,
    error: translate(locale, 'draft.conflict', { revision: notice.revision }),
    dirty,
    busy: false,
    canSave: false,
    reload: true
  }
}

/** 保存栏「N changes」怎么数（只有页面自己能回答时才传：例如 Prompts 的 override 记的
 * `base` 是账，不是一次编辑）。 */
export type SaveBarChangeCount<V> = (state: DraftState<V>) => number

/** 按状态给出保存栏的文字与按钮状态（§M.3 的五条）。 */
export function saveBar<V>(
  locale: string,
  state: DraftState<V>,
  saved?: V,
  countChanges?: SaveBarChangeCount<V>
): SaveBar {
  if (state.phase === 'clean') return { visible: false }
  const dirty = state.draft !== undefined && (saved === undefined || !same(state.draft.value, saved))
  const notice = state.notice
  if (notice !== undefined) return noticeBar(locale, notice, dirty)
  if (state.phase === 'saving') {
    return { visible: true, status: translate(locale, 'draft.saving'), dirty, busy: true, canSave: false }
  }
  if (state.phase === 'awaitingRevision') {
    return { visible: true, status: translate(locale, 'draft.saved'), dirty: false, busy: true, canSave: false }
  }
  const draft = state.draft
  let count = 0
  if (countChanges !== undefined) count = countChanges(state)
  else if (draft !== undefined) count = changedLeafCount(draft.base, draft.value)
  const key: CopyKey = count === 1 ? 'draft.changeOne' : 'draft.changes'
  return { visible: true, status: translate(locale, key, { count }), dirty, busy: false, canSave: dirty }
}

/** 一个组里的一块的草稿与它当前的已保存值。 */
export interface GroupDraftEntry<V> {
  readonly state: DraftState<V>
  readonly saved: V
}

/**
 * 一个组的保存栏：Sources 这类组一次覆盖多个块（每个实例一个块），但设计要求「每组一个
 * 保存栏」。合成规则：保存中/等修订优先显示进度；其次第一条 notice（失败/字段级/冲突）；
 * 否则数所有块的叶子改动。没有草稿与 notice 时不占空间。
 */
export function groupSaveBar<V>(locale: string, entries: readonly GroupDraftEntry<V>[]): SaveBar {
  if (entries.length === 0) return { visible: false }
  const saving = entries.find((entry) => entry.state.phase === 'saving')
  if (saving !== undefined) {
    return {
      visible: true,
      status: translate(locale, 'draft.saving'),
      dirty: true,
      busy: true,
      canSave: false
    }
  }
  const waiting = entries.find((entry) => entry.state.phase === 'awaitingRevision')
  if (waiting !== undefined) {
    return {
      visible: true,
      status: translate(locale, 'draft.saved'),
      dirty: false,
      busy: true,
      canSave: false
    }
  }
  const dirty = entries.some(
    (entry) => entry.state.draft !== undefined && !same(entry.state.draft.value, entry.saved)
  )
  const notice = entries.map((entry) => entry.state.notice).find((entry) => entry !== undefined)
  if (notice !== undefined) return noticeBar(locale, notice, dirty)
  const count = entries.reduce(
    (sum, entry) =>
      sum + (entry.state.draft === undefined ? 0 : changedLeafCount(entry.state.draft.base, entry.state.draft.value)),
    0
  )
  if (count === 0 && !dirty) return { visible: false }
  const key: CopyKey = count === 1 ? 'draft.changeOne' : 'draft.changes'
  return { visible: true, status: translate(locale, key, { count }), dirty, busy: false, canSave: dirty }
}

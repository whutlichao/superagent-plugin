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

/** 按状态给出保存栏的文字与按钮状态（§M.3 的五条）。 */
export function saveBar<V>(locale: string, state: DraftState<V>, saved?: V): SaveBar {
  if (state.phase === 'clean') return { visible: false }
  const dirty = state.draft !== undefined && (saved === undefined || !same(state.draft.value, saved))
  const notice = state.notice
  if (notice?.kind === 'failed') {
    return {
      visible: true,
      error: translate(locale, 'draft.failed', { error: notice.error }),
      dirty,
      busy: false,
      canSave: dirty
    }
  }
  if (notice?.kind === 'invalid') {
    const fields = notice.issues.map((issue) => issue.path).join(translate(locale, 'draft.listSeparator'))
    return {
      visible: true,
      error: translate(locale, 'draft.invalid', { fields }),
      dirty,
      busy: false,
      canSave: dirty
    }
  }
  if (notice?.kind === 'conflict') {
    return {
      visible: true,
      error: translate(locale, 'draft.conflict', { revision: notice.revision }),
      dirty,
      busy: false,
      canSave: false,
      reload: true
    }
  }
  if (state.phase === 'saving') {
    return { visible: true, status: translate(locale, 'draft.saving'), dirty, busy: true, canSave: false }
  }
  if (state.phase === 'awaitingRevision') {
    return { visible: true, status: translate(locale, 'draft.saved'), dirty: false, busy: true, canSave: false }
  }
  const count = state.draft ? changeCount(state.draft.base, state.draft.value) : 0
  const key: CopyKey = count === 1 ? 'draft.changeOne' : 'draft.changes'
  return { visible: true, status: translate(locale, key, { count }), dirty, busy: false, canSave: dirty }
}

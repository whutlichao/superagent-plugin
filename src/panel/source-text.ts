// Source 页的纯逻辑（§M.2 的 Source 卡、§M.5 的双语）：两面文案的取值、字段值的显示文字、
// drop 原因的文案键。与页面拆开，取词规则在测试里单独钉。
//
// 纯函数：不 import `orca`，也不碰 worker（§C.2 规则 3）。原因码的文案表在 `copy.ts`：
// 被过滤的 Trigger 用 `eval.ts` 的 `reasonText`（`reason.<code>`，未知码原样显示——它们是
// Source/Policy 自己的数据）；被 drop 的消息用本页自己的 `source.drop.<reason>`。
import { isChinese, translate, type CopyKey } from './copy'
import type { PanelDroppedMessage, PanelLocalizedText, PanelSourceRow, PanelSourceValue } from './protocol'

/** 一段两面文案在给定语言下的文字；不需要翻译的数据文本原样返回。 */
export function localizedText(locale: string, text: PanelLocalizedText): string {
  return typeof text === 'string' ? text : isChinese(locale) ? text.zh : text.en
}

/** 一个标量字段值的显示文字（`rows` 由页面逐行画，不在这里拼）。 */
export function fieldValueText(locale: string, value: PanelSourceValue): string {
  switch (value.type) {
    case 'flag':
      return translate(locale, value.on ? 'field.on' : 'field.off')
    case 'choice':
      return localizedText(locale, value.label)
    case 'rows':
      return ''
    default:
      return value.text
  }
}

/** 一个 `rows` 字段的一行：键列 + 其余列，用 ` · ` 连接（空列不占位）。 */
export function rowText(locale: string, row: PanelSourceRow): string {
  const cells = row.cells.map((cell) => localizedText(locale, cell)).filter((cell) => cell !== '')
  return [row.key, ...cells].filter((part) => part !== '').join(' · ')
}

/** 一条被 drop 消息的原因（§J.1 的两种送不到，加上撤回）。 */
export function dropReasonText(locale: string, reason: PanelDroppedMessage['reason']): string {
  return translate(locale, `source.drop.${reason}` as CopyKey)
}

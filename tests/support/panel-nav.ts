// 面板导航的测试夹具：七页的导航现在是面板自有的可换行按钮条（`Toolbar` + `Button`），
// 不再是宿主的 `Tabs`（7 项 `Tabs` 的最小内容宽约 544px 且不换行，窄面板上会把整页撑出横向
// 滚动条）。导航记忆仍然写在插件存储的 `panel.page` 里，所以「现在停在哪一页」读存储最准。
import type { TestPanel } from 'orca/testing'
import { translate } from '../../src/panel/copy'
import { NAV_PAGES, type NavPage } from '../../src/panel/protocol'

/** 七页在当前语言下的导航文案（顺序即 §M.1 的顺序）。 */
export function navLabels(locale: string): readonly string[] {
  return NAV_PAGES.map((page) => translate(locale, `nav.${page}`))
}

/** 面板此刻停在哪一页（导航记忆的单一事实来源）。 */
export function currentPage(panel: TestPanel): string | undefined {
  const stored = panel.persisted.storage['panel.page']
  return typeof stored === 'string' ? stored : undefined
}

/** 用导航按钮切到某一页（唯一动作；页面读数由面板在切换时自己读）。 */
export async function openPage(panel: TestPanel, page: NavPage, locale = 'en'): Promise<void> {
  await panel.press({ type: 'Button', text: translate(locale, `nav.${page}`) })
}

/** 切到 Settings 的某一组（五组是面板自有的可换行单选条，窄面板上会折行）。 */
export async function openSettingsGroup(panel: TestPanel, group: string, locale = 'en'): Promise<void> {
  await panel.select({ type: 'RadioGroup', label: translate(locale, 'nav.settings') }, group)
  await panel.settled()
}

/** 切到 Prompts 的某一子页（四子页同样是可换行单选条）。 */
export async function openPromptPage(panel: TestPanel, page: string, locale = 'en'): Promise<void> {
  await panel.select({ type: 'RadioGroup', label: translate(locale, 'prompt.tabs') }, page)
  await panel.settled()
}

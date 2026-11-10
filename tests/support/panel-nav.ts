// 面板导航的测试夹具：七页的导航是面板自有的可换行单选条（`RadioGroup`），不是宿主的
// `Tabs`（7 项 `Tabs` 的最小内容宽约 544px 且不换行，窄面板上会把整页撑出横向滚动条）。
// `RadioGroup` 带真单选语义，当前页就是「选中的那一项」——状态不靠颜色，读屏能播报。
// 导航记忆仍然写在插件存储的 `panel.page` 里，所以「现在停在哪一页」读存储最准。
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

/** 导航控件：一个 RadioGroup，选项名就是七页的文案。 */
export function navControl(locale: string): { readonly type: 'RadioGroup'; readonly label: string } {
  return { type: 'RadioGroup', label: translate(locale, 'panel.title') }
}

/** 切到某一页（唯一动作；页面读数由面板在切换时自己读）。 */
export async function openPage(panel: TestPanel, page: NavPage, locale = 'en'): Promise<void> {
  await panel.select(navControl(locale), page)
  await panel.settled()
}

/** 导航控件此刻的取值——就是当前页（单选语义下的「选中项」）。 */
export function selectedNavPage(panel: TestPanel, locale = 'en'): string | undefined {
  const value = panel.valueOf(navControl(locale))
  return typeof value === 'string' ? value : undefined
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

/** 树里的一个节点（`tree()` 的形状；只声明本夹具用到的字段）。 */
interface TreeNode {
  readonly type?: string
  readonly props?: {
    readonly label?: string
    readonly options?: readonly { readonly value: string; readonly label: string }[]
  }
  readonly children?: readonly (TreeNode | string)[]
}

/** 按控件的无障碍名找到那个 `RadioGroup`。 */
function findRadio(node: TreeNode, label: string): TreeNode | undefined {
  if (node.type === 'RadioGroup' && node.props?.label === label) return node
  for (const child of node.children ?? []) {
    if (typeof child === 'string') continue
    const hit = findRadio(child, label)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** 导航条的选项（值 + 文案），按渲染顺序——也就是 §M.1 的页面顺序。 */
export function navOptions(
  panel: TestPanel,
  locale = 'en'
): readonly { readonly value: string; readonly label: string }[] {
  const control = findRadio(panel.tree() as TreeNode, translate(locale, 'panel.title'))
  return control?.props?.options ?? []
}

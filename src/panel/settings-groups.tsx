// Settings 页的分组（§M.3：Sources / Eval / Execution / Prompts / Deployment）。
//
// 每组一个 `Tab`，各自管自己的读取、草稿与保存栏；本文件只负责「有哪几组、默认哪一组、
// 切过去时读一次」。已有的一组是 Deployment（#47）与 Prompts（#43）；Sources/Eval/Execution
// 由 #42 填进同一张表——**新增一组就加一行**，别在页面里写 if。
//
// 页头导航与重开面板都调 `openSettingsGroup()`：它按当前分组读一次，于是「渲染里不发请求」
// （§M.6）与「停在哪个分组都读得到」同时成立。
import { atom, read, set, Tab, Tabs, type OrcaElement } from 'orca'
import { translate } from './copy'
import { Deployment, openDeployment, resetDeployment } from './deployment'
import { openPrompts, Prompts, resetPrompts } from './prompts.tsx'

/** 分组的取值（导航与存储的校验都读这一处）。 */
export const SETTINGS_GROUPS = ['deployment', 'prompts'] as const
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number]

/** 一个值是否是分组之一（存储里的旧值也走它）。 */
export function isSettingsGroup(value: unknown): value is SettingsGroup {
  return typeof value === 'string' && (SETTINGS_GROUPS as readonly string[]).includes(value)
}

/** 当前分组（缺省 Deployment：它是这一页最早的一整块读数）。 */
const group = atom<string>('panel.settingsGroup', 'deployment', { persist: 'storage' })

/** 当前分组（存储里的旧值按 Deployment 渲染）。 */
function currentGroup(): SettingsGroup {
  const stored = read(group)
  return isSettingsGroup(stored) ? stored : 'deployment'
}

/** 读当前分组的那一份读数（渲染里不发请求，§M.6）：页面切换由 `panel.tsx` 负责。 */
export async function openSettingsGroup(): Promise<void> {
  const shown = currentGroup()
  if (shown === 'prompts') await openPrompts()
  else await openDeployment()
}

/** 分组切换：先记住选择，再读新分组的读数。 */
async function show(next: string): Promise<void> {
  if (!isSettingsGroup(next) || next === currentGroup()) return
  set(group, next)
  if (next === 'prompts') await openPrompts()
  else await openDeployment()
}

/** 面板卸载：两个分组都不再响应晚到的读数。 */
export function resetSettings(): void {
  resetDeployment()
  resetPrompts()
}

/** Settings 页：五组设置放在一张分组表里（每组自带保存栏，§M.3）。 */
export function SettingsGroups(props: { readonly locale: string }): OrcaElement {
  const locale = props.locale
  const shown = currentGroup()
  return (
    <Tabs
      label={translate(locale, 'settings.groups')}
      value={shown}
      onChange={(next) => void show(next)}
    >
      <Tab value="deployment" label={translate(locale, 'settings.group.deployment')}>
        {shown === 'deployment' ? <Deployment locale={locale} /> : null}
      </Tab>
      <Tab value="prompts" label={translate(locale, 'settings.group.prompts')}>
        {shown === 'prompts' ? <Prompts locale={locale} /> : null}
      </Tab>
    </Tabs>
  )
}

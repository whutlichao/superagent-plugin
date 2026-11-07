// 已知限制（§A.3 的「只能近似的能力」、§H 差异表里标「是」的行、附录 B）。
//
// 十一项，一份来源：面板 Deployment 页的 Limitations 段与仓库 README 的已知限制段读同一条
// 文案（`copy.ts` 的 `limitation.<id>.title` / `.impact`，中英各一份）。`refs` 指向差异表里
// 能查到的行号，于是「近似」不只是形容词——每一条都能在 §H 找到对应的事实与影响。
//
// 面板侧纯数据模块：不 import `orca`，不碰 worker（§C.2 规则 3）。
import type { CopyKey } from './copy'

/** 一条已知限制：编号、文案键与它在 §H 差异表里的行。 */
export interface Limitation {
  /** 稳定 id（`limitation.<id>.*` 的文案键就用它）。 */
  readonly id: string
  /** §H 差异表的行号（顺序即阅读顺序；`H.19` 与 `H.1` 同属工具集）。 */
  readonly refs: readonly string[]
  readonly titleKey: CopyKey
  readonly impactKey: CopyKey
}

/**
 * 十一项只能近似的能力，顺序照 §A.3 的编号（1–11）。上游的 preset、系统提示词注入、
 * 30 分钟预算、模型预算重试、Plugin Manager、Web 面板、服务脚本、skills 注册表、`dsh` CLI、
 * 提问工具，以及进程隔离与执行环境注入。
 */
export const LIMITATIONS: readonly Limitation[] = [
  { id: 'preset', refs: ['H.1', 'H.19'], titleKey: 'limitation.preset.title', impactKey: 'limitation.preset.impact' },
  {
    id: 'systemPrompt',
    refs: ['H.2'],
    titleKey: 'limitation.systemPrompt.title',
    impactKey: 'limitation.systemPrompt.impact'
  },
  {
    id: 'background',
    refs: ['H.3'],
    titleKey: 'limitation.background.title',
    impactKey: 'limitation.background.impact'
  },
  {
    id: 'modelRetry',
    refs: ['H.4'],
    titleKey: 'limitation.modelRetry.title',
    impactKey: 'limitation.modelRetry.impact'
  },
  {
    id: 'pluginManager',
    refs: ['H.5'],
    titleKey: 'limitation.pluginManager.title',
    impactKey: 'limitation.pluginManager.impact'
  },
  {
    id: 'webPanel',
    refs: ['H.6'],
    titleKey: 'limitation.webPanel.title',
    impactKey: 'limitation.webPanel.impact'
  },
  {
    id: 'serviceScript',
    refs: ['H.7'],
    titleKey: 'limitation.serviceScript.title',
    impactKey: 'limitation.serviceScript.impact'
  },
  { id: 'skills', refs: ['H.8'], titleKey: 'limitation.skills.title', impactKey: 'limitation.skills.impact' },
  { id: 'dshCli', refs: ['H.9'], titleKey: 'limitation.dshCli.title', impactKey: 'limitation.dshCli.impact' },
  {
    id: 'questions',
    refs: ['H.10'],
    titleKey: 'limitation.questions.title',
    impactKey: 'limitation.questions.impact'
  },
  {
    id: 'environment',
    refs: ['H.11', 'H.20'],
    titleKey: 'limitation.environment.title',
    impactKey: 'limitation.environment.impact'
  }
]

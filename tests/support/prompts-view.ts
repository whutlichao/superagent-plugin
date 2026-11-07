// Prompts 组的最小读数：分片来自**真注册表**（`worker/app/prompts.ts`），其余是固定值。
//
// 只给「组起来了、四个子页画得出来」用：Settings 页的测试（`tests/panel-settings.test.tsx`）
// 只需要证明 Prompts 那一格渲染的是真编辑器而不是占位；Prompts 自己的行为
// （override、全文 diff、历史恢复、技能）在 `tests/panel-prompts.test.tsx` 里用更完整的读数断言。
import type { PanelPromptPart, PanelPromptsView } from '../../src/panel/protocol'
import { PROMPT_PART_KEYS, PROMPT_PARTS } from '../../src/worker/app/prompts.ts'

/** 一个分片的读数：正文用分片键代替（面板只显示它，不解释）。 */
function partOf(key: (typeof PROMPT_PART_KEYS)[number]): PanelPromptPart {
  const registered = PROMPT_PARTS[key]
  return {
    key,
    roles: [...registered.roles],
    kind: registered.kind,
    placement: registered.placement,
    text: `Built-in text of ${key}`,
    placeholders: [...registered.placeholders],
    base: `b-${key}`
  }
}

/** 一份可渲染的 Prompts 读数（没有 override、没有 default-updated、没有团队技能）。 */
export function minimalPromptsView(overrides: Partial<PanelPromptsView> = {}): PanelPromptsView {
  return {
    revision: 1,
    saved: { revision: 1, predecessor: null, at: '2026-11-07T03:00:00.000Z', origin: 'panel' },
    config: {},
    sections: ['communication', 'scope', 'delivery'],
    parts: PROMPT_PART_KEYS.map(partOf),
    defaultChanged: [],
    removedParts: [],
    changes: [],
    history: [{ revision: 1, predecessor: null, at: '2026-11-07T03:00:00.000Z', origin: 'panel' }],
    skills: [],
    stateDir: '/var/lib/superagent',
    maxChars: 200_000,
    texts: {
      saved: { orchestrator: 'orchestrator saved text', worker: 'worker saved text' },
      defaults: { orchestrator: 'orchestrator default text', worker: 'worker default text' }
    },
    ...overrides
  }
}

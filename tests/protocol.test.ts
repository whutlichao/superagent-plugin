import { assert, test } from 'orca/testing'
import {
  isNavPage,
  NAV_PAGES,
  PLUGIN_PANEL_EVENTS,
  PLUGIN_REQUESTS,
  type AttentionItem,
  type PanelState
} from '../src/panel/protocol'

// 面板壳协议测试：契约集中一处，两侧共用，且纯数据层不把 `orca` 的运行时值拖进来。

test('the worker push is the one state.changed event, carrying a monotonic revision', () => {
  assert.deepEqual([...PLUGIN_PANEL_EVENTS], ['state.changed'])
})

test('the panel declares the state snapshot, the list pages and the Deployment group', () => {
  // 每个票据追加自己那一组请求：Overview 的 `check`/`ticket.retry`/`terminal.focus`（#37）、
  // Execution 的列表/详情与五个动作（#38）、Trigger 的列表/详情与两个动作（#39）、Eval 的
  // 列表/详情/dismiss（#40）、Deployment 组的读数、doctor、重跑探针、轮换 token、重启
  // Router（#47）、Source 页的读数与打开/关闭/立即同步/刷新显示名（#41），以及 Prompts
  // 组的读数/预览/保存/恢复（#43）。
  assert.deepEqual([...PLUGIN_REQUESTS], [
    'state',
    'pause',
    'check',
    'decisions',
    'decision.detail',
    'decision.dismiss',
    'threads',
    'thread.detail',
    'trigger.requeue',
    'thread.unsubscribe',
    'tickets',
    'ticket.detail',
    'ticket.retry',
    'ticket.stop',
    'ticket.note',
    'ticket.requestStatus',
    'terminal.focus',
    'workspace.open',
    'workspace.remove',
    'deployment',
    'doctor',
    'setupCheck',
    'rotateToken',
    'restartRouter',
    // Source 页（#41）：卡片读数、开关、名单同步与显示名刷新。
    'sources',
    'source.setEnabled',
    'source.sync',
    'source.labels',
    'prompts',
    'prompts.preview',
    'prompts.save',
    'prompts.restore',
    // Settings 页（#42）：四个可编辑组的读数、块保存与版本历史。
    'settings.read',
    'settings.save',
    'settings.history',
    // Search 页（#48）：一次查询，三组命中。
    'search'
  ])
})

test('the state request returns the shared PanelState shape, not a loose object', () => {
  const item: AttentionItem = { id: 't1', title: 'Fix it', action: 'review', at: 1 }
  const state: PanelState = {
    revision: 1,
    booted: true,
    health: {
      error: false,
      paused: false,
      setupMissing: false,
      sources: { enabled: 0, problems: 0 },
      activity: { received: 0, evaluated: 0, accepted: 0, ignored: 0, ended: 0 },
      executor: { running: 0, maxWorkers: 4, humanSlot: 'free' }
    },
    attention: { answer: 1, review: 0, problems: 0, items: [item] },
    problems: []
  }
  assert.equal(state.attention.items[0]?.title, 'Fix it')
})

test('the seven navigation pages are the design list, in order', () => {
  assert.deepEqual([...NAV_PAGES], [
    'overview',
    'source',
    'trigger',
    'eval',
    'execution',
    'settings',
    'search'
  ])
})

test('a remembered page is accepted only when it is one of the seven', () => {
  for (const page of NAV_PAGES) assert.equal(isNavPage(page), true)
  for (const value of ['glossary', 'policy', '', 7, null, undefined, { page: 'eval' }]) {
    assert.equal(isNavPage(value), false, String(value))
  }
})

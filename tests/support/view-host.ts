// 测试夹具：§G.3 视图读面的最小接线（`read overview/sources/search/threads/thread/decisions/models`）。
//
// 数据从**真库**来（`createRepositories` 与 `store.triggerThreads`），面板快照、Source 总览、
// 角色与 `find` 由调用方给缺省值——这样 HTTP/CLI 的用例与生产走同一份读模型，只把
// 「面板/Source 注册表/Router 设置」这三处外部事实换成固定值（§P.1 第 3 条）。
import { emptyState } from '../../src/worker/app/state-source.ts'
import { createRepositories } from '../../src/worker/app/repositories.ts'
import type { Store } from '../../src/worker/app/store.ts'
import type { PanelState } from '../../src/panel/protocol'
import type { SourceOverview } from '../../src/worker/sources/registry.ts'
import { createViewReadTools, type ViewReadTools } from '../../src/worker/app/views/read.ts'
import { githubFind } from '../../src/worker/sources/github/read.ts'

/** 测试里的视图读面选项：缺省全是空面板、没有 Source、`pi` 两个角色。 */
export interface TestViewOptions {
  readonly now?: () => string
  readonly panel?: () => PanelState
  readonly sources?: () => readonly SourceOverview[]
  readonly roles?: () => {
    readonly router: { readonly agent: string; readonly model?: string; readonly effort?: string }
    readonly worker: { readonly agent: string; readonly model?: string; readonly effort?: string }
  }
}

/**
 * 造一套接到真库上的视图读工具。`now` 缺省是固定时刻（与 `tests/support/state.ts` 的 `AT`
 * 同值），面板/Source/角色缺省为空——调用方只覆盖自己关心的一项。
 */
export function createTestViewTools(store: Store, options: TestViewOptions = {}): ViewReadTools {
  const repo = createRepositories(store)
  return createViewReadTools({
    reader: { sql: store.sql },
    now: options.now ?? (() => '2026-11-07T03:26:00.000Z'),
    panel: options.panel ?? (() => emptyState()),
    sources: options.sources ?? (() => []),
    roles: options.roles ?? (() => ({ router: { agent: 'pi' }, worker: { agent: 'pi' } })),
    find: (query) => githubFind(query),
    threads: () => repo.threads.list(),
    thread: (key) => repo.threads.get(key),
    timeline: {
      tail: (key, limit) => store.triggerThreads.tail(key, limit),
      before: (key, cursor, limit) => store.triggerThreads.before(key, cursor, limit),
      after: (key, cursor, limit) => store.triggerThreads.timeline(key, { after: cursor, limit }),
      item: (key, cursor) => store.triggerThreads.item(key, cursor)
    },
    trigger: (id) => repo.triggers.get(id),
    disposition: (id) => repo.triggers.disposition(id),
    threadDecisions: (key) => repo.decisions.byThread(key),
    allDecisions: () => repo.decisions.list(),
    tickets: () => repo.tickets.list(),
    ticket: (id) => repo.tickets.get(id)
  })
}

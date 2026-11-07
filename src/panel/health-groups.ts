// 健康明细的分组（§N.4 的写者表 → 面板上「按部件」的分区）。
//
// 条目名属于 worker 的固定清单（`infra/health.ts` 的 `HEALTH_ENTRIES` + `sync:<source id>` 前缀），
// 面板只负责把它们归到**部件**下并按固定顺序渲染；技术名原样显示（文档、代码与工具用英文术语，
// §M.5），组标题才是文案表里的词。
//
// 纪律：任何条目都不能被吞掉——不认识的条目落进「其他」，于是健康板新增一行时页面不会静默漏读。
import type { CopyKey } from './copy'
import type { HealthDetail } from './protocol'

/** 七个分区（前六个对应 §N.4 的写者，最后一个接住将来新增的条目）。 */
export type HealthGroupKey = 'runtime' | 'passes' | 'effects' | 'executor' | 'router' | 'sources' | 'other'

/** 一个分区：组标题的文案键 + 组内条目（顺序固定）。 */
export interface HealthGroup {
  readonly key: HealthGroupKey
  readonly labelKey: CopyKey
  readonly entries: readonly HealthDetail[]
}

/**
 * 归属表：条目名 → 分区。`sync:` 前缀的条目属于「来源与同步」，在 `groupOf` 里单独判。
 * 顺序即阅读顺序（与 §N.4 的表格一致）。
 */
const GROUP_OF: Readonly<Record<string, HealthGroupKey>> = {
  runtime: 'runtime',
  passes: 'passes',
  evals: 'passes',
  models: 'passes',
  assessment: 'effects',
  launch: 'effects',
  delivery: 'effects',
  relay: 'effects',
  notice: 'effects',
  reply: 'effects',
  return: 'effects',
  backup: 'effects',
  worker: 'executor',
  router: 'router',
  sources: 'sources',
  github: 'sources',
  feishu: 'sources',
  history: 'sources'
}

/** 分区的顺序与文案键（渲染读这一份）。 */
export const HEALTH_GROUPS: readonly { readonly key: HealthGroupKey; readonly labelKey: CopyKey }[] = [
  { key: 'runtime', labelKey: 'deployment.group.runtime' },
  { key: 'passes', labelKey: 'deployment.group.passes' },
  { key: 'effects', labelKey: 'deployment.group.effects' },
  { key: 'executor', labelKey: 'deployment.group.executor' },
  { key: 'router', labelKey: 'deployment.group.router' },
  { key: 'sources', labelKey: 'deployment.group.sources' },
  { key: 'other', labelKey: 'deployment.group.other' }
]

/** 一个条目属于哪个分区：已知名字查表，`sync:<id>` 归来源，其余归「其他」。 */
export function groupOf(name: string): HealthGroupKey {
  const known = GROUP_OF[name]
  if (known !== undefined) return known
  if (name.startsWith('sync:')) return 'sources'
  return 'other'
}

/** 已知条目名在一个分区里的固定顺序（照 §N.4 的表格）；不在表里的按名字排序。 */
const CANONICAL: readonly string[] = Object.keys(GROUP_OF)

/** 组内排序：先按 `GROUP_OF` 的键序，未知条目按名字升序排在后面。 */
function rank(name: string): number {
  const index = CANONICAL.indexOf(name)
  return index < 0 ? CANONICAL.length : index
}

/**
 * 把健康板的一份读数分到七个区里（空区不出现——「没接上的部件」是缺行，不是一行假就绪）。
 * 组内顺序固定，于是同一份读数每次渲染都一样。
 */
export function groupHealth(entries: readonly HealthDetail[]): readonly HealthGroup[] {
  const buckets = new Map<HealthGroupKey, HealthDetail[]>()
  for (const entry of entries) {
    const key = groupOf(entry.name)
    const bucket = buckets.get(key)
    if (bucket === undefined) buckets.set(key, [entry])
    else bucket.push(entry)
  }
  const groups: HealthGroup[] = []
  for (const group of HEALTH_GROUPS) {
    const bucket = buckets.get(group.key)
    if (bucket === undefined || bucket.length === 0) continue
    bucket.sort((left, right) => {
      const byRank = rank(left.name) - rank(right.name)
      return byRank === 0 ? left.name.localeCompare(right.name) : byRank
    })
    groups.push({ key: group.key, labelKey: group.labelKey, entries: bucket })
  }
  return groups
}

/** 一条健康状态的中文/英文措辞（`deployment.state.*` 的文案键）。 */
export function healthStateKey(state: HealthDetail['state']): CopyKey {
  return `deployment.state.${state}` as CopyKey
}

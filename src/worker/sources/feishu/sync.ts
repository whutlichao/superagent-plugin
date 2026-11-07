// Feishu 名单同步（§I.3「同步」行、§K.1 的 `syncChat`）：从同步来源群读成员，生成允许名单。
//
// 三条纪律：
// - **名单只有一份来源**：同步之后 `allowed` 恰好是这个群里的人——留下的人按原顺序更新名字，
//   新成员追加，离开的人移除。顺序稳定，Policy version 的内容哈希才不会因为顺序抖动而变；
// - **不完整就是失败**：`has_more` 或服务端 `truncations` 说明还有成员没读到。把半份名单当成
//   全部会把没读到的成员踢出允许名单，所以这里抛错，让设置层按退避重试；
// - **不写库**：本文件只读 CLI、返回新的 part；保存（origin=`sync`）与 `sync:<id>` 健康条目
//   归设置层（§N.4 的写者表）。
//
// 依赖纪律（§C.2）：只经 `CommandsHost` 调 `lark-cli`（argv 数组，§I.4），不 import app。
import type { SyncContext } from '../kind.ts'
import type { FeishuConfig } from './config.ts'
import { FEISHU_SOURCE } from './translate.ts'

/** 群里的一位成员：open_id + 群里的名字（可空）。 */
export interface FeishuMember {
  readonly id: string
  readonly name?: string
}

/** 一个对象是否像 `{...}`（null 与数组都不算）。 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 解析 `+chat-members-list` 的 JSON；不是对象就让这一次同步失败。 */
function pageOf(output: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    throw new Error('lark-cli returned a member list that is not JSON')
  }
  if (!isRecord(parsed)) throw new Error('lark-cli returned a member list that is not an object')
  return parsed
}

/**
 * 读一页成员并拒绝不完整的名单（`--page-all --page-limit 0` 之后还缺，就是服务端截断）。
 * 读不懂的成员条目跳过（§I.6 的容忍解析），但整份名单缺页不算「读不懂」，那是失败。
 */
export function membersOf(output: string): readonly FeishuMember[] {
  const page = pageOf(output)
  if (page['has_more'] === true) throw new Error('Feishu returned an incomplete member list')
  const truncations = page['truncations']
  if (Array.isArray(truncations) && truncations.length > 0) {
    throw new Error('Feishu returned an incomplete member list')
  }
  const rows = Array.isArray(page['users']) ? page['users'] : []
  const members: FeishuMember[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const id = typeof row['member_id'] === 'string' ? row['member_id'] : ''
    if (id === '') continue
    const rawName = typeof row['name'] === 'string' ? row['name'].trim() : ''
    members.push({ id, ...(rawName === '' ? {} : { name: rawName }) })
  }
  return members
}

/** 一个 part 现有的名单条目（`{id, name?}`；形状不对的条目跳过）。 */
function allowedOf(part: Record<string, unknown>): { id: string; name?: string }[] {
  const rows = Array.isArray(part['allowed']) ? part['allowed'] : []
  const allowed: { id: string; name?: string }[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const id = typeof row['id'] === 'string' ? row['id'] : ''
    if (id === '') continue
    const name = typeof row['name'] === 'string' && row['name'].length > 0 ? row['name'] : undefined
    allowed.push({ id, ...(name === undefined ? {} : { name }) })
  }
  return allowed
}

/**
 * 读同步来源群的成员，返回名单是「这个群里的人」的新 part（§I.3 同步行）。
 * `host.config` 给出机器人 `lark-cli`；同步本身拿不到实例配置的其余部分也不需要。
 */
export async function runFeishuSync(
  host: SyncContext,
  part: Record<string, unknown>,
  signal: AbortSignal
): Promise<Record<string, unknown>> {
  const cli = host.config<FeishuConfig>(FEISHU_SOURCE)?.cli ?? ''
  if (cli.trim() === '') throw new Error('The Feishu Source has no CLI')
  const chat = typeof part['syncChat'] === 'string' ? part['syncChat'] : ''
  if (chat === '') throw new Error('The Feishu policy names no sync chat')
  const output = await host.commands.withSignal(signal).run(cli, [
    'im',
    '+chat-members-list',
    '--as',
    'bot',
    '--chat-id',
    chat,
    '--member-types',
    'user',
    '--page-all',
    '--page-limit',
    '0'
  ])
  const members = membersOf(output)
  const existing = allowedOf(part)
  const names = new Map(members.map((member) => [member.id, member.name]))
  const known = new Set(existing.map((entry) => entry.id))
  const allowed = [
    // 留下的人：保持原顺序，名字跟随群（群里改了名，名单里也改）。
    ...existing
      .filter((entry) => names.has(entry.id))
      .map((entry) => {
        const name = names.get(entry.id)
        return { ...entry, ...(name === undefined ? {} : { name }) }
      }),
    // 新成员：追加在最后。
    ...members.filter((member) => !known.has(member.id)).map((member) => ({ ...member }))
  ]
  return { ...part, allowed }
}

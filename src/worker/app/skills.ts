// 技能文件的落盘与增删改（§L.6、§H.8 的近似）。
//
// 上游由宿主的 skills 注册表按名加载技能；Orca 没有注册表（§H.8），所以技能**是文件**：
// `<stateDir>/skills/<name>/SKILL.md`，prompt 只写绝对路径并要求和某类工作一起读
// （路径与那几行文本在 `app/prompts.ts` 的 `skillPointerLines`，这里只负责磁盘）。
//
// 四条规则：
// 1. 内置技能（`superagent-github`、`superagent-feishu`）每次启动从分片常量写盘；正文没变
//    就不重写（不制造无意义的 mtime 变化）。正文含 `<!-- team-edited -->` 的文件**不覆盖**：
//    那是团队在磁盘上改过的副本，升级不该吞掉它。
// 2. 团队技能也在这一个目录里：新建写文件、编辑改写同一个路径、从配置里删掉即删目录。
//    团队技能的真相源是保存下来的配置（版本表里有历史），因此这里总是按配置写回。
// 3. 目录里既不是内置名、也不在当前配置里的子目录，是「被删掉的团队技能」留下的残留：
//    同步时删除（`removed`），于是删技能不需要第二份登记表。
// 4. 写失败抛错：组合根记一条警告并继续启动——技能缺失是「读不到」而不是「插件坏了」，
//    但绝不假装写成功（返回值只列真的写过的名字）。
//
// 依赖纪律（§C.2）：`app/skills.ts → app/prompts.ts` 单向；本文件不碰 HTTP、runtime 或时钟。
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  BUILT_IN_SKILLS,
  SKILLS_DIR,
  composeSkill,
  isBuiltInSkill,
  promptTextOf,
  skillFilePath,
  type PromptConfig
} from './prompts.ts'

/**
 * 团队改过磁盘副本的标记（§L.6）：文件正文含它就跳过内置技能的覆盖。写在这里由
 * `syncSkillFiles` 只读不写——标记是给人的约定，插件自己不制造它。
 */
export const TEAM_EDITED_MARKER = '<!-- team-edited -->'

/** 一次同步需要的输入：状态目录 + 保存下来的配置（团队技能在 `config.skills`）。 */
export interface SkillFilesInput {
  readonly stateDir: string
  /** 当前配置；省略等于「没有 override、没有团队技能」（每次启动照样写内置技能）。 */
  readonly config?: PromptConfig
}

/** 一次同步做了什么：写过的、因团队改过而保留的、删掉的团队技能名。 */
export interface SkillFilesResult {
  readonly written: readonly string[]
  readonly kept: readonly string[]
  readonly removed: readonly string[]
}

/** 一个文件的正文；不存在（或读不出来）时 `null`。 */
function contentOf(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** 写到内容确实不同为止；返回是否真的写了（正文相同不算一次写）。 */
function writeSkill(path: string, text: string): boolean {
  if (contentOf(path) === text) return false
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, { encoding: 'utf8' })
  return true
}

/**
 * 把技能目录同步成「两个内置技能 + 当前配置里的团队技能」，删掉已不在配置里的团队技能目录。
 * 幂等：同样的输入第二次调用不再写任何文件。
 */
export function syncSkillFiles(input: SkillFilesInput): SkillFilesResult {
  const config = input.config ?? {}
  const text = promptTextOf(config)
  const directory = join(input.stateDir, SKILLS_DIR)
  mkdirSync(directory, { recursive: true })
  const written: string[] = []
  const kept: string[] = []
  // 1. 内置技能：带标记的文件保留原样（团队改过），其余按当前分片正文重写。
  for (const skill of BUILT_IN_SKILLS) {
    const path = skillFilePath(input.stateDir, skill.name)
    const existing = contentOf(path)
    if (existing !== null && existing.includes(TEAM_EDITED_MARKER)) {
      kept.push(skill.name)
      continue
    }
    if (writeSkill(path, composeSkill(skill.kind, text))) written.push(skill.name)
  }
  // 2. 团队技能：配置是真相源，按名字的稳定路径写回（编辑 = 同一个路径换了正文）。
  const team = config.skills ?? {}
  for (const name of Object.keys(team).sort()) {
    if (writeSkill(skillFilePath(input.stateDir, name), team[name] as string)) written.push(name)
  }
  // 3. 删掉的团队技能：目录里既不是内置名、也不在配置里的子目录就是残留。
  const removed: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (isBuiltInSkill(entry.name) || Object.hasOwn(team, entry.name)) continue
    rmSync(join(directory, entry.name), { recursive: true, force: true })
    removed.push(entry.name)
  }
  return { written, kept, removed }
}

// KV 键的单一命名处（§D.3）。**键字面量只允许出现在本文件与 `migration.ts`**，
// 由 `tests/store.test.ts` 的源码扫描守住（§D.2 要点 3「上线约束」）。
//
// 结构：`KV_KEY_LITERALS` 是字面量的唯一列表（精确键与族前缀都在这里写一次），
// 下面的常量与构造函数全部由它派生。扫描测试读 `KV_KEY_LITERALS`，因此新增键只改一处。

/** 键字面量（精确键与族前缀）。前缀以 `:` 结尾，构造函数在其后接参数。 */
export const KV_KEY_LITERALS = {
  schemaVersion: 'schema-version',
  pluginVersion: 'plugin-version',
  settingsRevision: 'settings-revision',
  settingsVersionPrefix: 'settings-version:',
  settingsBlockRevisionPrefix: 'settings-block-revision:',
  promptRevision: 'prompt-revision',
  promptBuiltinBase: 'prompt-builtin-base',
  promptVersionPrefix: 'prompt-version:',
  routerTerminal: 'router-terminal',
  routerWorkspace: 'router-workspace',
  routerToken: 'router-token',
  routerRestarts: 'router-restarts',
  tokenHashPrefix: 'token-hash:',
  requestIdPrefix: 'request-id:',
  githubCursorPrefix: 'github-cursor:',
  githubBodyPrefix: 'github-body:',
  githubCiPrefix: 'github-ci:',
  feishuCursorPrefix: 'feishu-cursor:',
  feishuChats: 'feishu-chats',
  feishuTopicsPrefix: 'feishu-topics:',
  threadSeenPrefix: 'thread-seen:',
  sourceLabelsPrefix: 'source-labels:',
  lockPid: 'lock-pid',
  lastPrune: 'last-prune',
  apiPort: 'api-port',
  backupIndex: 'backup-index',
  pauseState: 'pause-state'
} as const

/** schema 版本（唯一版本源，§D.2 要点 3）。 */
export const SCHEMA_VERSION_KEY = KV_KEY_LITERALS.schemaVersion

/** 上一次运行的插件版本（§N.6 第 5 条：版本变了就把在跑的 Assignment 当作中断）。 */
export const PLUGIN_VERSION_KEY = KV_KEY_LITERALS.pluginVersion

/** 设置版本族（§D.3「设置版本」行）。 */
export const SETTINGS_REVISION_KEY = KV_KEY_LITERALS.settingsRevision
export const settingsVersionKey = (revision: number): string =>
  `${KV_KEY_LITERALS.settingsVersionPrefix}${revision}`
export const settingsBlockRevisionKey = (block: string): string =>
  `${KV_KEY_LITERALS.settingsBlockRevisionPrefix}${block}`

/** Prompt 版本族（§D.3「Prompt 版本」行、§L.4）。 */
export const PROMPT_REVISION_KEY = KV_KEY_LITERALS.promptRevision
export const PROMPT_BUILTIN_BASE_KEY = KV_KEY_LITERALS.promptBuiltinBase
export const promptVersionKey = (revision: number): string =>
  `${KV_KEY_LITERALS.promptVersionPrefix}${revision}`

/** Router 快照族（§D.3「Router」行、§D.4 写者表）。 */
export const ROUTER_TERMINAL_KEY = KV_KEY_LITERALS.routerTerminal
export const ROUTER_WORKSPACE_KEY = KV_KEY_LITERALS.routerWorkspace
export const ROUTER_TOKEN_KEY = KV_KEY_LITERALS.routerToken
export const ROUTER_RESTARTS_KEY = KV_KEY_LITERALS.routerRestarts

/**
 * token 与幂等的族（本票新增，§D.6、§G.1 幂等行）：
 * - `token-hash:<sha256(token)>` → `{role, ticketId?, assignmentId?, expiresAt}`：库里只存哈希；
 * - `request-id:<tokenHash>:<requestId>` → 首次结果：同 id 一小时内重试返回首次结果。
 */
export const tokenHashKey = (hash: string): string => `${KV_KEY_LITERALS.tokenHashPrefix}${hash}`
export const requestIdKey = (tokenHash: string, requestId: string): string =>
  `${KV_KEY_LITERALS.requestIdPrefix}${tokenHash}:${requestId}`

/** 幂等族的前缀（保留策略与键扫描用；字面量同样只活在这里）。 */
export const REQUEST_ID_PREFIX = KV_KEY_LITERALS.requestIdPrefix

/** Source 状态族（§D.3「Source 状态」行）。 */
export const githubCursorKey = (notificationId: string): string =>
  `${KV_KEY_LITERALS.githubCursorPrefix}${notificationId}`
/**
 * Issue/PR 正文指纹（§I.2 的 issue-body 编辑、票 #18）：键按编号，值只有正文指纹。
 * #36 的 receive-all 复用同一个键名，不要再起一套。
 */
export const githubBodyKey = (issue: number | string): string =>
  `${KV_KEY_LITERALS.githubBodyPrefix}${issue}`
/**
 * 一个 PR 的某个 head 提交的 CI 指纹（§I.2 CI 行、票 #19）：键按「PR + head sha」，值只有指纹。
 * 换了 head 就是新的基线（新提交的检查从第一次读到开始比）。
 */
export const githubCiKey = (pull: number | string, headSha: string): string =>
  `${KV_KEY_LITERALS.githubCiPrefix}${pull}#${headSha}`
export const feishuCursorKey = (chat: string): string => `${KV_KEY_LITERALS.feishuCursorPrefix}${chat}`
/**
 * 事件流见过的会话（`chat_id -> 是否私聊`）：回填要它才知道哪些群/私聊可以读（§I.3 回填）。
 */
export const feishuChatsKey = KV_KEY_LITERALS.feishuChats
/** 一个群里见过的话题（`thread_id -> 最后一次见到消息的时刻`），话题轮询的候选集。 */
export const feishuTopicsKey = (chat: string): string =>
  `${KV_KEY_LITERALS.feishuTopicsPrefix}${chat}`
export const threadSeenKey = (threadKey: string): string => `${KV_KEY_LITERALS.threadSeenPrefix}${threadKey}`
export const sourceLabelsKey = (kind: string): string => `${KV_KEY_LITERALS.sourceLabelsPrefix}${kind}`

/**
 * 状态目录族的文件名（§D.5、§G.4 第 1 条）：这两个名字不是 KV 键，而是 `<stateDir>` 下的
 * 普通文件；CLI 与 worker 都按同一处字面量找它们（`infra/paths.ts` 从这里再导出）。
 */
export const STATE_DIR_NAME = 'orca-superagent'
export const STATE_DIR_ENV = 'ORCA_SUPERAGENT_STATE_DIR'
export const STATE_DIR_POINTER = 'state-dir-pointer'

/** 维护族（§D.3「维护」行）。 */
export const LOCK_PID_KEY = KV_KEY_LITERALS.lockPid
export const LAST_PRUNE_KEY = KV_KEY_LITERALS.lastPrune
export const API_PORT_KEY = KV_KEY_LITERALS.apiPort
export const BACKUP_INDEX_KEY = KV_KEY_LITERALS.backupIndex

/** 暂停状态（§K.6：独立设置，不改变 Policy version；唯一读写处 `app/pause.ts`）。 */
export const PAUSE_STATE_KEY = KV_KEY_LITERALS.pauseState

/** 保留策略要扫的两个版本族（§D.2 要点 5：删「非当前」的旧快照）。 */
export const VERSION_SNAPSHOT_PREFIXES = {
  settings: KV_KEY_LITERALS.settingsVersionPrefix,
  prompt: KV_KEY_LITERALS.promptVersionPrefix
} as const

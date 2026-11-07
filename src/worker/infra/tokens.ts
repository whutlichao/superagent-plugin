// API token 的签发与吊销（§D.6、§O 鉴权、§G.1 角色）。
//
// 三种角色：
// - `operator`：`<stateDir>/api-token`，首启生成 32 字节 base64url，0600；
// - `router`：`<stateDir>/tokens/router`，0600，每次签发轮换（重启即轮换），旧 token 立即失效；
// - `assignment`：`<stateDir>/tokens/<assignmentId>`，0600，绑定 `{ticketId, assignmentId, expiresAt}`，
//   Assignment 结束时删除。
//
// 库内**只存哈希**：`kv['token-hash:<sha256>'] = {role, ticketId?, assignmentId?, expiresAt?}`。
// 校验走「算哈希 → 查记录」，再对候选记录做常数时间比较（§O）；token 原文不落库、不落日志。
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { tokenHashKey } from '../app/kv.ts'
import type { Store } from '../app/store.ts'

/** 主 token 文件（§D.5、§D.6）。 */
export const API_TOKEN_FILE = 'api-token'

/** 每 Assignment 与 Router 的 token 目录（§D.5）。 */
export const TOKENS_DIR = 'tokens'

/** Router token 的文件名（§D.5）。 */
export const ROUTER_TOKEN_FILE = 'router'

/** 三种 token 角色（§G.1 角色行）。 */
export type TokenRole = 'operator' | 'router' | 'assignment'

/** 一次校验通过的调用者身份。 */
export interface Caller {
  readonly role: TokenRole
  /** assignment 角色：该 token 绑定的 Ticket。 */
  readonly ticketId?: string
  /** assignment 角色：该 token 绑定的 Assignment。 */
  readonly assignmentId?: string
}

/** 库里的 token 记录（只按哈希存）。 */
export interface TokenRecord {
  readonly role: TokenRole
  readonly ticketId?: string
  readonly assignmentId?: string
  /** assignment 角色的过期时刻（ISO-8601）；operator/router 不带。 */
  readonly expiresAt?: string
}

/** 签发的 token：原文 + 文件路径 + 绑定的记录。 */
export interface IssuedToken {
  readonly token: string
  readonly path: string
  readonly record: TokenRecord
}

/** token 文件的权限（§D.6：0600）；doctor 用它判定「有没有被别人读的权限」。 */
export const TOKEN_MODE = 0o600

/** 签发所需的输入。 */
interface IssueOptions {
  readonly store: Store
  readonly stateDir: string
  /** 生成随机串（测试注入固定值）。 */
  readonly random?: (bytes: number) => string
}

/** 32 字节 base64url：43 个字符，无填充（§D.6）。 */
export function randomToken(): string {
  return randomBytes(32).toString('base64url')
}

/** 一个 token 原文在库里的键：只存 sha256 十六进制。 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** 写一个 0600 的文件（先删后建，确保已存在文件的权限也被收紧）。 */
function writeSecretFile(path: string, value: string): void {
  try {
    unlinkSync(path)
  } catch {
    // 不存在就是我们要的结果。
  }
  const fd = openSync(path, 'w', TOKEN_MODE)
  try {
    writeSync(fd, value, 'utf8')
  } finally {
    closeSync(fd)
  }
}

/** 读一个 secret 文件；不存在或读不出都给 `null`（调用方只关心「有没有」）。 */
function readSecretFile(path: string): string | null {
  try {
    const text = readFileSync(path, 'utf8').trim()
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}

/** 记录落库：`token-hash:<hash>` → `TokenRecord`。 */
function rememberToken(store: Store, token: string, record: TokenRecord): void {
  store.kvSet(tokenHashKey(hashToken(token)), record)
}

/** 把 token 记录从库里删掉（返回是否删了一行）。 */
function forgetToken(store: Store, token: string): boolean {
  return store.kvDelete(tokenHashKey(hashToken(token)))
}

/**
 * 确保主 token 存在：不存在就生成并写 0600；已存在就复用（**不**静默轮换，
 * 轮换是面板的破坏性动作，§D.6）。
 */
export function ensureApiToken(stateDir: string): { readonly token: string; readonly created: boolean } {
  const path = join(stateDir, API_TOKEN_FILE)
  const existing = readSecretFile(path)
  if (existing !== null) return { token: existing, created: false }
  const token = randomToken()
  writeSecretFile(path, token)
  return { token, created: true }
}

/** 读主 token；不存在时 `null`（doctor 只报有没有，不报是什么，§O）。 */
export function readApiToken(stateDir: string): string | null {
  return readSecretFile(join(stateDir, API_TOKEN_FILE))
}

/**
 * 轮换主 token（§D.6、§G.2 的 `admin rotate-token`）：生成新的 32 字节随机串并**重写**
 * `<stateDir>/api-token`（0600）。旧值随文件被覆盖而立即失效——operator 的判据就是
 * 「等于文件内容」，所以不需要额外的吊销记录。
 *
 * 返回**新 token 的哈希**而不是原文：调用方（CLI/面板）只需确认「轮换发生了」，
 * 原文留在文件里给下一次请求读（§O：token 不进程间明文传递、不进日志）。
 */
export function rotateApiToken(stateDir: string): { readonly path: string; readonly hash: string } {
  const path = join(stateDir, API_TOKEN_FILE)
  const token = randomToken()
  writeSecretFile(path, token)
  return { path, hash: hashToken(token) }
}

/**
 * 签发 Router token：写 `tokens/router`（0600），并把**旧**记录的哈希从库里删掉——
 * 于是旧 token 立即 401（§D.6「Router token 随 Router 重启轮换」）。
 */
export function issueRouterToken(options: IssueOptions): IssuedToken {
  const directory = join(options.stateDir, TOKENS_DIR)
  mkdirSync(directory, { recursive: true })
  const path = join(directory, ROUTER_TOKEN_FILE)
  const previous = readSecretFile(path)
  const token = (options.random ?? randomToken)(32)
  const record: TokenRecord = { role: 'router' }
  writeSecretFile(path, token)
  if (previous !== null) forgetToken(options.store, previous)
  rememberToken(options.store, token, record)
  return { token, path, record }
}

/**
 * 签发 Assignment token：写 `tokens/<assignmentId>`（0600），记录绑定
 * `{ticketId, assignmentId, expiresAt}`（§D.6）。
 */
export function issueAssignmentToken(
  options: IssueOptions & {
    readonly ticketId: string
    readonly assignmentId: string
    readonly expiresAt: string
  }
): IssuedToken {
  const directory = join(options.stateDir, TOKENS_DIR)
  mkdirSync(directory, { recursive: true })
  const path = join(directory, options.assignmentId)
  const previous = readSecretFile(path)
  const token = (options.random ?? randomToken)(32)
  const record: TokenRecord = {
    role: 'assignment',
    ticketId: options.ticketId,
    assignmentId: options.assignmentId,
    expiresAt: options.expiresAt
  }
  writeSecretFile(path, token)
  if (previous !== null) forgetToken(options.store, previous)
  rememberToken(options.store, token, record)
  return { token, path, record }
}

/**
 * 吊销一个 Assignment 的 token：删文件 + 删记录，返回是否真的删了记录。
 * Assignment 结束时由执行器调用（§D.6）；幂等——重复调用返回 false，不抛。
 */
export function revokeAssignmentToken(options: {
  readonly store: Store
  readonly stateDir: string
  readonly assignmentId: string
}): boolean {
  const path = join(options.stateDir, TOKENS_DIR, options.assignmentId)
  const token = readSecretFile(path)
  try {
    unlinkSync(path)
  } catch {
    // 文件不在也算吊销完成。
  }
  return token === null ? false : forgetToken(options.store, token)
}

/**
 * 校验一个 Bearer token 并给出调用者身份；无效/过期/记录缺失一律 `null`。
 *
 * operator 的判据是「等于 `api-token` 文件内容」——主 token 不进库（它由文件持有，
 * 重置即重写文件）。比较用常数时间。
 */
export function verifyToken(options: {
  readonly store: Store
  readonly stateDir: string
  readonly token: string
  readonly now?: () => Date
}): Caller | null {
  const operator = readApiToken(options.stateDir)
  if (operator !== null && constantTimeEquals(operator, options.token)) {
    return { role: 'operator' }
  }

  const stored = options.store.kvGet<TokenRecord>(tokenHashKey(hashToken(options.token)))
  if (stored === null) {
    // 兼容：库里还没有记录但文件还在（例如本票之前签发的 token）时，按文件认领一次。
    const claimed = claimFromFile(options)
    if (claimed === null) return null
    return callerFor(claimed, options.now)
  }
  return callerFor(stored, options.now)
}

/** 文件存在但库里没记录时（旧 token / 手工放置），按文件补一条记录再返回。 */
function claimFromFile(options: {
  readonly store: Store
  readonly stateDir: string
  readonly token: string
}): TokenRecord | null {
  const routerPath = join(options.stateDir, TOKENS_DIR, ROUTER_TOKEN_FILE)
  if (constantTimeEquals(readSecretFile(routerPath), options.token)) {
    const record: TokenRecord = { role: 'router' }
    rememberToken(options.store, options.token, record)
    return record
  }
  return null
}

/** 记录 → 调用者；过期的 assignment 记录视为无效。 */
function callerFor(record: TokenRecord, now: () => Date = () => new Date()): Caller | null {
  if (record.role === 'assignment' && record.expiresAt !== undefined) {
    if (now().toISOString() >= record.expiresAt) return null
  }
  const caller: Caller = {
    role: record.role,
    ...(record.ticketId === undefined ? {} : { ticketId: record.ticketId }),
    ...(record.assignmentId === undefined ? {} : { assignmentId: record.assignmentId })
  }
  return caller
}

/** 常数时间字符串比较（长度不同直接 false，因为长度不是秘密）。 */
function constantTimeEquals(known: string | null, candidate: string): boolean {
  if (known === null) return false
  if (known.length !== candidate.length) return false
  return timingSafeEqual(utf8(known), utf8(candidate))
}

/** UTF-8 字节：token 是 base64url 的 ASCII，逐字符低字节即其字节。 */
function utf8(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length)
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 0xff
  return bytes
}

// Feishu 图片（§H.17、§I.3「图片」行）：按 `<message-id>/<image-key>` 把消息里的图片下载到
// `<stateDir>/inbox/images/<key>`，返回**文件路径**与说明；读不到时明确报「无法读取图片」，
// 绝不猜内容、绝不退化成一段文本。
//
// 三条纪律：
// - **配对**：图片 id 是 `threadContext.images` 与 `eval-read --image-id` 之间的唯一契约
//   （`<message-id>/<image-key>`，§I.1）。这里先读回那条消息，确认 key 真的出现在它正文里；
//   任意远端 id 一律拒绝，不下载。
// - **落盘**：`lark-cli` 只允许把 `--output` 写进安全根（工作目录、`/tmp`、`~/files`），所以
//   用 `cwd = <stateDir>/inbox/images` + 相对文件名调用；回报的路径必须 realpath 之后仍落在
//   这个目录里，且是**非空普通文件**。逃逸、目录、空文件都算「读不了」。
// - **不猜**：任何失败都抛 `cannot read image: …`（调用方据此给出明确的 unavailable），绝不
//   返回占位路径或标题。
//
// 依赖纪律（§C.2）：只 import 命令端口、同目录的读取端口与翻译；`lark-cli` 只经 `CommandsHost`
// 调用，参数是 argv 数组（§I.4）。
import { mkdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import type { Trigger } from '../../core/index.ts'
import type { CommandsHost } from '../commands.ts'
import { createFeishuApi } from './api.ts'
import { withMentionNames } from './translate.ts'

/** 图片 key 的形态（`img_v3_…`）；`\b` 保证不会把 `file_v3_…` 之类的资源认成图片。 */
const IMAGE_KEY_PATTERN = /\bimg_[A-Za-z0-9_-]+\b/g

/** 消息 id 的形态（`om_…`）。 */
const MESSAGE_ID = /^om_[A-Za-z0-9_-]+$/

/** 图片 key 的形态。 */
const IMAGE_KEY = /^img_[A-Za-z0-9_-]+$/

/**
 * 正文里出现的图片 key，按出现顺序去重（`threadContext.images`，§I.1）：
 * 渲染后的正文是 `![Image](img_…)`，原始 API 的 `{"image_key":"img_…"}` 也认。
 */
export function admissionImageKeys(text: string): readonly string[] {
  return [...new Set(text.match(IMAGE_KEY_PATTERN) ?? [])]
}

/** 一个图片 id 的两半：把它交给 `+messages-resources-download` 时缺一不可。 */
export interface FeishuImageRef {
  readonly messageId: string
  readonly key: string
}

/**
 * 拆开 `<message-id>/<image-key>`。形态不对（没有斜杠、两半为空、不是 `om_`/`img_`）返回
 * undefined——调用方据此给出「无法读取图片」，而不是拿一个路径片段去下载。
 */
export function feishuImageRef(imageId: string): FeishuImageRef | undefined {
  const slash = imageId.indexOf('/')
  if (slash <= 0 || slash === imageId.length - 1) return undefined
  const messageId = imageId.slice(0, slash)
  const key = imageId.slice(slash + 1)
  if (!MESSAGE_ID.test(messageId) || !IMAGE_KEY.test(key)) return undefined
  return { messageId, key }
}

/** 从下载命令的输出里取落盘路径：`data.saved_path`（1.0.96 的契约），也认顶层的 `saved_path`。 */
function savedPathOf(output: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  const data = record['data']
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const nested = (data as Record<string, unknown>)['saved_path']
    if (typeof nested === 'string' && nested.length > 0) return nested
  }
  const top = record['saved_path']
  return typeof top === 'string' && top.length > 0 ? top : undefined
}

/** 一句失败原因（只用于把 CLI 的失败折进固定的「无法读取图片」文案）。 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 读一张图片需要的全部输入；`stateDir` 缺失时无法落盘（明确拒绝，不落临时目录）。 */
export interface FeishuImageRequest {
  readonly host: CommandsHost
  readonly cli: string
  readonly stateDir: string | undefined
  readonly trigger: Trigger
  readonly imageId: string
  readonly signal?: AbortSignal | undefined
}

/**
 * 下载一张图片并返回它的落地路径与说明（§H.17）。先验证 key 属于那条消息，再调用 CLI；
 * 任何一步失败都抛 `cannot read image: …`，绝不返回内容猜测。
 */
export async function downloadFeishuImage(
  request: FeishuImageRequest
): Promise<{ path: string; alt: string }> {
  const ref = feishuImageRef(request.imageId)
  if (ref === undefined) {
    throw new Error('cannot read image: use <message-id>/<image-key> as the image id')
  }
  if (request.stateDir === undefined || request.stateDir.length === 0) {
    throw new Error('cannot read image: no state directory is configured')
  }
  const chatId = typeof request.trigger.meta['chatId'] === 'string' ? request.trigger.meta['chatId'] : ''
  if (chatId.length === 0) {
    throw new Error('cannot read image: this Trigger names no chat to read the message from')
  }
  const host = request.signal === undefined ? request.host : request.host.withSignal(request.signal)

  // 1. 先读回那条消息：key 必须出现在它自己的正文里（任意远端 id 不下载）。
  const page = await createFeishuApi(host, request.cli).messages({
    messageIds: [ref.messageId],
    chatId,
    direct: request.trigger.meta['direct'] === true
  })
  const message = page.messages.find((row) => row.messageId === ref.messageId)
  if (message === undefined) throw new Error('cannot read image: that message is unavailable')
  if (message.deleted === true) throw new Error('cannot read image: that message was deleted')
  if (message.chatId !== chatId) {
    throw new Error('cannot read image: Feishu returned a message outside the source chat')
  }
  if (!admissionImageKeys(withMentionNames(message.text, message.mentions)).includes(ref.key)) {
    throw new Error('cannot read image: choose an image key that message contains')
  }

  // 2. 下载到 inbox：`cwd` 是安全根，`--output` 只是文件名。
  const images = join(request.stateDir, 'inbox', 'images')
  mkdirSync(images, { recursive: true })
  let output: string
  try {
    output = await host.run(
      request.cli,
      [
        'im',
        '+messages-resources-download',
        '--as',
        'bot',
        '--message-id',
        ref.messageId,
        '--file-key',
        ref.key,
        '--type',
        'image',
        '--output',
        ref.key
      ],
      { cwd: images }
    )
  } catch (error) {
    throw new Error(`cannot read image: ${reasonOf(error)}`)
  }

  // 3. 回报的路径必须落在 inbox 里，且是一个非空普通文件。
  const saved = savedPathOf(output)
  if (saved === undefined) throw new Error('cannot read image: the download reported no path')
  // `realpath` 之后比较：macOS 的 `/var` 本身就是指向 `/private/var` 的符号链接。
  const root = realpathSync(images)
  const candidate = isAbsolute(saved) ? saved : join(images, saved)
  // 先解析父目录（它由我们创建）：写在外面的路径哪怕文件不存在，也要报「outside」而不是「no file」。
  let parent: string
  try {
    parent = realpathSync(dirname(candidate))
  } catch {
    throw new Error('cannot read image: the download wrote no file')
  }
  const resolved = join(parent, basename(candidate))
  const outside = relative(root, resolved)
  if (outside.length === 0 || outside.startsWith('..') || isAbsolute(outside)) {
    throw new Error('cannot read image: the download wrote outside the inbox')
  }
  let path: string
  try {
    path = realpathSync(resolved)
  } catch {
    throw new Error('cannot read image: the download wrote no file')
  }
  // realpath 之后再判一次：符号链接不能把文件带出 inbox。
  const inside = relative(root, path)
  if (inside.length === 0 || inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error('cannot read image: the download wrote outside the inbox')
  }
  const info = statSync(path)
  if (!info.isFile()) throw new Error('cannot read image: the download is not a file')
  if (info.size === 0) throw new Error('cannot read image: the download is an empty file')
  return { path, alt: `Feishu image ${ref.key} from message ${ref.messageId}` }
}

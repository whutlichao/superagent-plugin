// Feishu 图片（§H.17、§I.3「图片」行）：按 `<message-id>/<image-key>` 下载到
// `<stateDir>/inbox/images/<key>`，返回**文件路径**与说明；读不到时明确报「无法读取图片」，
// 绝不猜内容、绝不退化成空文本。
//
// 四条纪律：
// - 只接受这条消息正文里出现过的 key（与上游 `image` 的校验同），任意远端 id 一律拒绝；
// - 下载参数全部是 argv 元素（§I.4），图片落在自己的 inbox 里，路径逃逸被拒；
// - 落盘失败、没有路径、不是普通文件、空文件都报 `cannot read image`；
// - 同一个 key 重复读得到同一个路径（幂等）。
//
// 不发网络：`lark-cli` 调用经 `FakeCommands`（§I.6），临时目录是真目录（§P.1）。
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeCommands, cliFailure } from './support/fake-commands.ts'
import { key } from '../src/worker/core/index.ts'
import type { Trigger } from '../src/worker/core/index.ts'
import { admissionImageKeys } from '../src/worker/sources/feishu/image.ts'
import { feishuThreadContext } from '../src/worker/sources/feishu/read.ts'
import type { ThreadContext } from '../src/worker/sources/admission-context.ts'
import type { FeishuConfig } from '../src/worker/sources/feishu/config.ts'

const CHAT = 'oc_chat'
const MESSAGE = 'om_source'
const IMAGE = 'img_v3_one'
/** 一条 Trigger：图片与消息 id 的配对由它带来（§I.1 的 `<message-id>/<image-key>` 契约）。 */
function triggerOf(): Trigger {
  return {
    id: key('feishu', MESSAGE),
    source: 'feishu',
    threads: [{ source: 'feishu', id: `${CHAT}:om_root` }],
    actor: { source: 'feishu', id: 'ou_alice' },
    human: true,
    at: '2026-11-09T12:00:00.000Z',
    text: `look at ![Image](${IMAGE})`,
    channel: { source: 'feishu', thread: `feishu:${CHAT}`, address: { chatId: CHAT, messageId: MESSAGE } },
    meta: { chatId: CHAT, messageId: MESSAGE, direct: false, rootId: 'om_root', parentId: 'om_parent' }
  }
}

/** `+messages-mget` 的一行（真实输出的字段集合；图片消息的正文渲染成 `![Image](img_…)`）。 */
function imageMessage(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    messages: [
      {
        message_id: MESSAGE,
        chat_id: CHAT,
        msg_type: 'image',
        create_time: '1790000000000',
        sender: { id: 'ou_alice', name: 'Alice', sender_type: 'user' },
        content: `![Image](${IMAGE})`,
        deleted: false,
        ...overrides
      }
    ],
    total: 1
  })
}

/** `ThreadContext.image` 在接口上是可选的；Feishu 实现了它，所以测试先断言它在。 */
function imageOf(context: ThreadContext<FeishuConfig>): NonNullable<ThreadContext<FeishuConfig>['image']> {
  const image = context.image
  assert.ok(image !== undefined, 'Feishu reads images')
  return image
}

/** 一个临时状态目录；每个用例自己建、自己清。 */
function stateDirOf(): string {
  return mkdtempSync(join(tmpdir(), 'feishu-image-'))
}

/** 下载命令的 argv（命令名与每个 flag 都是 lark-cli 1.0.96 的实测面）。 */
function downloadArgs(imageKey = IMAGE): string[] {
  return [
    'im',
    '+messages-resources-download',
    '--as',
    'bot',
    '--message-id',
    MESSAGE,
    '--file-key',
    imageKey,
    '--type',
    'image',
    '--output',
    imageKey
  ]
}

/** 脚本化一次「下载成功」：按 CLI 的契约在给定目录里写出文件并回报路径。 */
function scriptDownload(cli: FakeCommands, directory: string, fileName = `${IMAGE}.png`): void {
  cli.script(['im', '+messages-resources-download'], () => {
    const saved = join(directory, fileName)
    writeFileSync(saved, 'PNGDATA')
    return JSON.stringify({ code: 0, data: { saved_path: saved, size_bytes: 7 } })
  })
}

describe('extracting image keys from a message', () => {
  test('rendered and raw key forms are both recognised, without duplicates', () => {
    assert.deepEqual(admissionImageKeys('![Image](img_v3_one) and {"image_key":"img_v3_two"} img_v3_one'), [
      'img_v3_one',
      'img_v3_two'
    ])
    assert.deepEqual(admissionImageKeys('no attachments here'), [])
    // 其它 key 形态（文件、音频）不是图片。
    assert.deepEqual(admissionImageKeys('file_v3_one audio_v3_two'), [])
  })
})

describe('downloading an image into the state directory', () => {
  test('the path is returned with a description, and the CLI writes inside the inbox', async () => {
    const stateDir = stateDirOf()
    try {
      const cli = new FakeCommands()
      const images = join(stateDir, 'inbox', 'images')
      cli.script(['im', '+messages-mget'], () => imageMessage())
      scriptDownload(cli, images)
      const image = await imageOf(feishuThreadContext('lark-cli', { stateDir }))(
        cli,
        triggerOf(),
        `${MESSAGE}/${IMAGE}`,
        new AbortController().signal
      )

      // 返回的是 realpath（macOS 的 `/var` 是指向 `/private/var` 的符号链接）。
      assert.equal(image.path, realpathSync(join(images, `${IMAGE}.png`)))
      assert.equal(statSync(image.path).size, 7)
      assert.ok(image.alt.includes(IMAGE), 'the description names the image')
      assert.ok(image.alt.includes(MESSAGE), 'the description names the message it belongs to')
      // 先验证 key 属于这条消息，再下载；两次调用都是 argv 数组。
      assert.deepEqual(cli.args, [
        ['im', '+messages-mget', '--as', 'bot', '--message-ids', MESSAGE, '--no-reactions'],
        downloadArgs()
      ])
      // 下载的当前目录就是 inbox：CLI 的 `--output` 只允许落在工作目录之类的安全根内。
      assert.equal(cli.calls[1]?.options.cwd, images)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test('reading the same image twice lands on the same path', async () => {
    const stateDir = stateDirOf()
    try {
      const cli = new FakeCommands()
      const images = join(stateDir, 'inbox', 'images')
      cli.script(['im', '+messages-mget'], () => imageMessage())
      scriptDownload(cli, images)
      scriptDownload(cli, images)
      const image = imageOf(feishuThreadContext('lark-cli', { stateDir }))
      const signal = new AbortController().signal
      const first = await image(cli, triggerOf(), `${MESSAGE}/${IMAGE}`, signal)
      const second = await image(cli, triggerOf(), `${MESSAGE}/${IMAGE}`, signal)
      assert.equal(first.path, second.path)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})

describe('refusing to guess when the image cannot be read', () => {
  test('a key that is not in that message is refused before any download', async () => {
    const stateDir = stateDirOf()
    try {
      const cli = new FakeCommands()
      cli.script(['im', '+messages-mget'], () => imageMessage())
      await assert.rejects(
        imageOf(feishuThreadContext('lark-cli', { stateDir }))(
          cli,
          triggerOf(),
          `${MESSAGE}/img_v3_other`,
          new AbortController().signal
        ),
        /cannot read image/
      )
      assert.deepEqual(cli.programs, ['lark-cli'], 'only the message read happened')
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test('a malformed image id is refused without a CLI call', async () => {
    const stateDir = stateDirOf()
    try {
      const cli = new FakeCommands()
      const image = imageOf(feishuThreadContext('lark-cli', { stateDir }))
      for (const imageId of ['img_v3_one', `${MESSAGE}/`, `/${IMAGE}`, `../${IMAGE}`, `${MESSAGE}/../${IMAGE}`]) {
        await assert.rejects(image(cli, triggerOf(), imageId, new AbortController().signal), /cannot read image/, imageId)
      }
      assert.deepEqual(cli.calls, [], 'nothing was downloaded')
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test('a download failure is `cannot read image`, never a placeholder', async () => {
    const stateDir = stateDirOf()
    try {
      const cli = new FakeCommands()
      cli.script(['im', '+messages-mget'], () => imageMessage())
      cli.fail(
        'lark-cli',
        downloadArgs(),
        cliFailure('lark-cli', { code: 234003, stderr: '{"code":234003,"msg":"File not in msg"}' })
      )
      await assert.rejects(
        imageOf(feishuThreadContext('lark-cli', { stateDir }))(
          cli,
          triggerOf(),
          `${MESSAGE}/${IMAGE}`,
          new AbortController().signal
        ),
        /cannot read image/
      )
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test('a path outside the inbox, a directory, a missing path or an empty file are all refused', async () => {
    const stateDir = stateDirOf()
    try {
      const outside = mkdtempSync(join(tmpdir(), 'feishu-outside-'))
      const images = join(stateDir, 'inbox', 'images')
      const cases: readonly { readonly reply: () => string; readonly why: RegExp }[] = [
        // 路径逃逸：绝对路径落在 inbox 之外。
        { reply: () => JSON.stringify({ data: { saved_path: join(outside, 'sneaky.png') } }), why: /outside/i },
        // 回报的是一个目录而不是文件。
        { reply: () => JSON.stringify({ data: { saved_path: images } }), why: /cannot read image/ },
        // 没有回报路径。
        { reply: () => JSON.stringify({ data: { size_bytes: 7 } }), why: /cannot read image/ },
        // 空文件不是一张能读的图。
        {
          reply: () => {
            const saved = join(images, `${IMAGE}.png`)
            writeFileSync(saved, '')
            return JSON.stringify({ data: { saved_path: saved } })
          },
          why: /cannot read image/
        },
        // 输出不是 JSON 对象。
        { reply: () => 'not json', why: /cannot read image/ }
      ]
      for (const one of cases) {
        const cli = new FakeCommands()
        cli.script(['im', '+messages-mget'], () => imageMessage())
        cli.script(['im', '+messages-resources-download'], () => one.reply())
        await assert.rejects(
          imageOf(feishuThreadContext('lark-cli', { stateDir }))(
            cli,
            triggerOf(),
            `${MESSAGE}/${IMAGE}`,
            new AbortController().signal
          ),
          one.why
        )
      }
      rmSync(outside, { recursive: true, force: true })
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test('a deleted message has no readable image, and no state directory means no download', async () => {
    const stateDir = stateDirOf()
    try {
      const deleted = new FakeCommands()
      deleted.script(['im', '+messages-mget'], () => imageMessage({ deleted: true, content: '' }))
      await assert.rejects(
        imageOf(feishuThreadContext('lark-cli', { stateDir }))(
          deleted,
          triggerOf(),
          `${MESSAGE}/${IMAGE}`,
          new AbortController().signal
        ),
        /cannot read image/
      )
      assert.deepEqual(deleted.programs, ['lark-cli'], 'only the message read happened')

      // 没有 stateDir 时无法落盘：明确拒绝，而不是落到某个临时目录。
      const bare = new FakeCommands()
      await assert.rejects(
        imageOf(feishuThreadContext('lark-cli'))(
          bare,
          triggerOf(),
          `${MESSAGE}/${IMAGE}`,
          new AbortController().signal
        ),
        /cannot read image/
      )
      assert.deepEqual(bare.calls, [])
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})

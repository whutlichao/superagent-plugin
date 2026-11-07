// 日志（§N.5、§P.2、R14）：`<stateDir>/logs/worker-<YYYYMMDD>.log` 的 JSON 行、按日滚动只留
// 十个、关键行同时进 `orca.log`，以及最硬的一条——token、密钥、消息正文、命令参数永不入日志。
//
// 断言只看磁盘上的字节与注入的镜像出口：日志是给人看的产物，测试不需要知道它怎么组织内部。
import { assert, test } from 'orca/testing'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger, LOG_KEEP } from '../src/worker/infra/log'
import type { LogLine } from '../src/worker/infra/log-line'
import { tempStateDir } from './support/state'

/** 一天之后（UTC，按整日推进）。 */
function dayAfter(base: Date, days: number): Date {
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000)
}

/** 读一个日志文件的所有行（每行一个 JSON 对象）。 */
function readLines(path: string): LogLine[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LogLine)
}

test('writes one JSON line per call into logs/worker-<YYYYMMDD>.log', () => {
  const stateDir = tempStateDir()
  try {
    const now = (): Date => new Date('2026-11-07T03:26:00.000Z')
    const logger = createLogger({ stateDir, now })

    logger.info('worker started', { ticketId: 'ticket-11' })
    logger.warn('github read was slow', { status: 502, code: 'upstream_error' })

    const path = join(stateDir, 'logs', 'worker-20261107.log')
    assert.ok(existsSync(path), 'the daily file is where §D.5 says it is')
    assert.deepEqual(readLines(path), [
      { ts: '2026-11-07T03:26:00.000Z', level: 'info', msg: 'worker started', fields: { ticketId: 'ticket-11' } },
      {
        ts: '2026-11-07T03:26:00.000Z',
        level: 'warn',
        msg: 'github read was slow',
        fields: { status: 502, code: 'upstream_error' }
      }
    ])
    // 没有字段的行不带 `fields` 键（形状与 `infra/log-line.ts` 一致）。
    logger.info('no fields')
    const last = readLines(path).at(-1)
    assert.deepEqual(last, { ts: '2026-11-07T03:26:00.000Z', level: 'info', msg: 'no fields' })
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('rolls by day and keeps exactly ten daily files, deleting the oldest', () => {
  const stateDir = tempStateDir()
  try {
    const first = new Date('2026-11-01T09:00:00.000Z')
    let day = 0
    const logger = createLogger({ stateDir, now: () => dayAfter(first, day) })

    for (day = 0; day < 12; day += 1) logger.info(`day ${day}`)

    const files = readdirSync(join(stateDir, 'logs'))
      .filter((name) => name.startsWith('worker-'))
      .sort()
    assert.equal(LOG_KEEP, 10)
    assert.equal(files.length, 10, 'only ten daily files survive')
    assert.deepEqual(files, [
      'worker-20261103.log',
      'worker-20261104.log',
      'worker-20261105.log',
      'worker-20261106.log',
      'worker-20261107.log',
      'worker-20261108.log',
      'worker-20261109.log',
      'worker-20261110.log',
      'worker-20261111.log',
      'worker-20261112.log'
    ])
    // 当天一直往同一个文件追加，最早的十一、十二两天的文件被删掉。
    assert.equal(readLines(join(stateDir, 'logs', 'worker-20261112.log')).length, 1)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('redacts tokens, secrets, message bodies and CLI argv; keeps ids, lengths and codes', () => {
  const stateDir = tempStateDir()
  try {
    const logger = createLogger({ stateDir, now: () => new Date('2026-11-07T03:26:00.000Z') })
    const token = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    const secret = 'sk-live-0123456789abcdefghijklmnop'
    const accessToken = 'Q2hhbmdlVGhpc1Rva2VuXzEyMzQ1Njc4OTBhYmNkZWZnaGlqa2xtbm9wcXJzdHV2'
    const body = 'Please fix the login bug. Here is the full comment body with all of its details.'
    const argv = ['gh', 'api', '--method', 'POST', '-f', `body=${body}`, '/repos/x/issues/46/comments']

    logger.warn('github write failed', {
      ticketId: 'ticket-11',
      messageId: 'msg-42',
      length: body.length,
      status: 502,
      code: 'upstream_error',
      token,
      secret,
      accessToken,
      body,
      argv
    })
    // 密钥也可能被拼进人写的那一行：两种形态都要挡。
    logger.error(`request failed: Authorization: Bearer ${token}`)
    logger.info(`retrying with token=${secret}`)

    const text = readFileSync(join(stateDir, 'logs', 'worker-20261107.log'), 'utf8')
    for (const leak of [token, secret, accessToken, body, 'gh', 'api', '--method', '-f', '/repos/x']) {
      assert.equal(text.includes(leak), false, `the log must not contain ${leak}`)
    }
    const lines = readLines(join(stateDir, 'logs', 'worker-20261107.log'))
    assert.deepEqual(lines[0]?.fields, {
      ticketId: 'ticket-11',
      messageId: 'msg-42',
      length: body.length,
      status: 502,
      code: 'upstream_error',
      token: '[redacted]',
      secret: '[redacted]',
      accessToken: '[redacted]',
      body: '[redacted]',
      argv: '[redacted]'
    })
    assert.ok(lines[1]?.msg.includes('Bearer [redacted]'), 'the token in a message is redacted')
    assert.ok(lines[2]?.msg.includes('token=[redacted]'), 'an assignment-shaped secret is redacted')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a logger passed as a LogSink keeps the same redaction rules', () => {
  const stateDir = tempStateDir()
  try {
    const logger = createLogger({ stateDir, now: () => new Date('2026-11-07T03:26:00.000Z') })
    const token = 'github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    logger.sink({ ts: '2026-11-07T03:26:00.000Z', level: 'error', msg: 'delivery failed', fields: { token } })

    const text = readFileSync(join(stateDir, 'logs', 'worker-20261107.log'), 'utf8')
    assert.equal(text.includes(token), false)
    assert.ok(text.includes('[redacted]'))
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('key lines and warnings are mirrored to orca.log; plain info lines stay on disk', () => {
  const stateDir = tempStateDir()
  try {
    const mirrored: string[] = []
    const logger = createLogger({
      stateDir,
      now: () => new Date('2026-11-07T03:26:00.000Z'),
      mirror: (message) => void mirrored.push(message)
    })

    logger.info('quiet detail')
    logger.key('listening on 127.0.0.1:3847', { port: 3847 })
    logger.warn('lock is held by another instance', { pid: 4242 })
    logger.error('database schema 7 is newer than this plugin (1)')

    assert.equal(mirrored.length, 3, 'info lines are not mirrored')
    assert.ok(mirrored[0]?.includes('listening on 127.0.0.1:3847'))
    assert.ok(mirrored[1]?.includes('lock is held by another instance'))
    assert.ok(mirrored[2]?.includes('database schema 7 is newer than this plugin (1)'))
    // 镜像出去的也是脱敏后的文本：同一个 token 不可能从 `orca.log` 漏出去。
    assert.equal(
      mirrored.some((line) => line.includes('ghp_')),
      false
    )
    logger.key('saw token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')
    assert.equal(mirrored.at(-1)?.includes('ghp_'), false, 'mirrored lines go through the same redaction')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

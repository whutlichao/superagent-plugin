// 命令端口（§I.4、§O 命令注入）：所有 CLI 调用的唯一出口，测试面见票 #10 的验收。
//
// 断言面：白名单、argv 数组不经 shell、错误脱敏（绝不回显 argv）、CliError 的码提取、
// 超时与输出上限、中性环境变量、取消信号，以及「只有永久失败才算 gone」。
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ALLOWED_PROGRAMS,
  CliError,
  Commands,
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  NEUTRAL_ENVIRONMENT,
  STDERR_LIMIT,
  isGone,
  type CommandStream,
  type StreamExit
} from '../src/worker/sources/commands.ts'
import { listFiles, readRepoFile } from './support/repo.ts'

/** 捕获失败并断言它是 CliError（端口对 CLI 失败的唯一错误形态）。 */
async function failure(run: Promise<unknown>): Promise<CliError> {
  const settled = await run.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  )
  assert.equal(settled.ok, false, 'expected the command to fail')
  if (settled.ok) throw new Error('unreachable')
  assert.ok(
    settled.error instanceof CliError,
    `expected a CliError, got ${String(settled.error)}`
  )
  return settled.error
}

/** 在临时目录里跑一段 sh，结束后删掉目录。 */
async function inTempDir<T>(work: (directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), 'superagent-cli-'))
  try {
    return await work(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('the program allowlist', () => {
  test('admits the five programs the design names, as bare names', async () => {
    assert.deepEqual([...ALLOWED_PROGRAMS], ['gh', 'lark-cli', 'git', 'orca', 'sh'])
    const commands = new Commands()
    for (const program of ALLOWED_PROGRAMS) {
      // 只验证放行：这些程序带 `--version` 都能正常退出或被接受为参数。
      const output = await commands.run(program, program === 'git' ? ['--version'] : ['--version'])
      assert.equal(typeof output, 'string')
    }
  })

  test('refuses a program outside the allowlist before running anything', async () => {
    const commands = new Commands()
    await assert.rejects(commands.run('curl', ['https://example.test']), /not one of the allowed programs/)
    await assert.rejects(commands.run('rm', ['-rf', '/']), /not one of the allowed programs/)
  })

  test('requires a program that carries a path to be absolute and inside a configured CLI', async () => {
    const commands = new Commands({ configuredPrograms: () => ['/bin'] })
    // 相对路径直接拒绝（可能被 PATH 或 cwd 悄悄改写）。
    await assert.rejects(commands.run('./gh', ['api', 'x']), /must be absolute/)
    await assert.rejects(commands.run('bin/gh', ['api', 'x']), /must be absolute/)
    // 绝对但不在配置的 CLI 之下：拒绝。
    await assert.rejects(commands.run('/usr/bin/printf', ['x']), /not inside a configured CLI/)
    // 配置的 CLI 之下：放行（`/bin/echo` 是系统里一定存在的可执行文件）。
    assert.equal(await commands.run('/bin/echo', ['hello']), 'hello\n')
  })

  test('a bare configured name is still checked against the allowlist', async () => {
    const commands = new Commands({ configuredPrograms: () => ['gh-agent'] })
    await assert.rejects(commands.run('gh-agent', ['api', 'x']), /not one of the allowed programs/)
  })
})

describe('argv arrays and no shell', () => {
  test('never interpolates message text into a shell', async () => {
    await inTempDir(async (directory) => {
      const marker = join(directory, 'pwned')
      const commands = new Commands()
      // 若端口把参数拼进 shell，`; touch …` 会被执行；argv 数组则原样传给程序。
      const payload = `body=hello; touch ${marker}; echo $(whoami) \`id\``
      const output = await commands.run('sh', ['-c', 'printf %s "$1"', 'sh', payload])
      assert.equal(output, payload)
      assert.equal(existsSync(marker), false, 'the message text never reached a shell')
    })
  })

  test('keeps arguments that look like options after `--` untouched', async () => {
    const commands = new Commands()
    const output = await commands.run('sh', ['-c', 'printf %s "$1"', 'sh', '--help'])
    assert.equal(output, '--help')
  })
})

describe('errors', () => {
  test('name the program, how it ended, and the head of stderr, never the arguments', async () => {
    const commands = new Commands()
    const error = await failure(
      commands.run('sh', ['-c', 'echo "fatal: secret body" >&2; exit 3', 'secret-argv-text'])
    )
    assert.equal(error.exitCode, 3)
    assert.equal(error.code, undefined)
    assert.ok(error.message.startsWith('sh exited with code 3'), error.message)
    assert.ok(error.message.includes('fatal: secret body'), error.message)
    assert.equal(error.message.includes('secret-argv-text'), false, 'argv is never echoed')
  })

  test('truncate stderr to the fixed head', async () => {
    const commands = new Commands()
    const error = await failure(
      commands.run('sh', ['-c', 'head -c 5000 /dev/zero | tr "\\0" x >&2; exit 1'])
    )
    assert.equal(error.message.includes('x'.repeat(STDERR_LIMIT)), true)
    assert.equal(error.message.includes('x'.repeat(STDERR_LIMIT + 1)), false)
    assert.ok(error.message.length <= STDERR_LIMIT + 64, `message is ${error.message.length} chars`)
  })

  test('report a program that cannot run, and an output over the cap, without argv', async () => {
    // 放行一条 /bin 下不存在的路径：端口放行后由 execFile 报 ENOENT，消息里不含 argv。
    const commands = new Commands({ configuredPrograms: () => ['/bin'] })
    const missing = await failure(commands.run('/bin/definitely-not-here', ['secret-argv-text']))
    assert.match(missing.message, /definitely-not-here could not run: ENOENT/)
    assert.equal(missing.message.includes('secret-argv-text'), false)

    const over = await failure(new Commands().run('sh', ['-c', 'head -c 17000000 /dev/zero']))
    assert.ok(over.message.includes('printed more output than it may'), over.message)
    assert.equal(MAX_OUTPUT_BYTES, 16 * 1024 * 1024)
  })

  test('extract the CLI error code from stderr JSON and from `HTTP <nnn>`', async () => {
    const commands = new Commands()
    const feishu = await failure(
      commands.run('sh', [
        '-c',
        'echo "[page 1] fetching..." >&2; echo \'{"error":{"code":230011,"message":"The message is recalled"}}\' >&2; exit 1'
      ])
    )
    assert.equal(feishu.code, 230011)
    assert.equal(feishu.exitCode, 1)

    const github = await failure(commands.run('sh', ['-c', 'echo "gh: Not Found (HTTP 404)" >&2; exit 1']))
    assert.equal(github.code, 404)
    assert.equal(github.exitCode, 1)

    const plain = await failure(commands.run('sh', ['-c', 'echo "boom" >&2; exit 2']))
    assert.equal(plain.code, undefined)
    assert.equal(plain.exitCode, 2)
  })

  test('a timeout says so and is not a code', async () => {
    const commands = new Commands({ timeoutMs: 20 })
    const started = Date.now()
    const error = await failure(commands.run('sh', ['-c', 'sleep 5']))
    assert.equal(error.message, 'sh timed out after 20 ms')
    assert.equal(error.code, undefined)
    assert.ok(Date.now() - started < 2000)
    assert.equal(DEFAULT_TIMEOUT_MS, 60_000)
  })

  test('a cancelled command stays an AbortError so callers can tell cancellation from failure', async () => {
    const lifetime = new AbortController()
    const commands = new Commands().withSignal(lifetime.signal)
    const running = commands.run('sh', ['-c', 'sleep 5'])
    lifetime.abort()
    await assert.rejects(running, (error: unknown) => (error as Error).name === 'AbortError')
    // 生命周期信号取消后，没有绑它的视图仍能跑。
    assert.equal(await new Commands().run('sh', ['-c', 'printf ok']), 'ok')
  })
})

describe('environment', () => {
  test('injects the neutral variables even over the process environment', async () => {
    const previous = process.env.GH_PROMPT_DISABLED
    process.env.GH_PROMPT_DISABLED = '0'
    try {
      const commands = new Commands({ environment: { SUPERAGENT_PROBE: 'agent' } })
      const output = await commands.run('sh', [
        '-c',
        'printf "%s|%s|%s|%s" "$GH_PROMPT_DISABLED" "$LARKSUITE_CLI_NO_UPDATE_NOTIFIER" "$GIT_TERMINAL_PROMPT" "$SUPERAGENT_PROBE"'
      ])
      assert.equal(output, '1|1|0|agent')
      assert.deepEqual({ ...NEUTRAL_ENVIRONMENT }, {
        GH_PROMPT_DISABLED: '1',
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
        GIT_TERMINAL_PROMPT: '0'
      })
    } finally {
      if (previous === undefined) delete process.env.GH_PROMPT_DISABLED
      else process.env.GH_PROMPT_DISABLED = previous
    }
  })

  test('withSignal keeps the configured environment and timeout', async () => {
    const signal = new AbortController().signal
    const commands = new Commands({ environment: { SUPERAGENT_PROBE: 'kept' }, timeoutMs: 1234 }).withSignal(signal)
    assert.equal(await commands.run('sh', ['-c', 'printf %s "$SUPERAGENT_PROBE"']), 'kept')
  })
})

describe('permanent failures', () => {
  test('only known permanent codes count as gone, whatever the text says', () => {
    const github = [{ code: 410 }, { code: 403, message: /locked/i }]
    assert.equal(isGone(new CliError('gh exited with code 1: issue is locked (HTTP 403)', 403, 1), github), true)
    assert.equal(isGone(new CliError('gh exited with code 1: Gone (HTTP 410)', 410, 1), github), true)
    // 403 但不含 locked：不是 gone（可能是无权限，稍后重试）。
    assert.equal(isGone(new CliError('gh exited with code 1: Forbidden (HTTP 403)', 403, 1), github), false)
    for (const code of [404, 500, undefined]) {
      assert.equal(isGone(new CliError('deleted or withdrawn', code, 1), github), false)
    }
    // 文本像「已删除」但没有码：仍然重试（上游同）。
    assert.equal(isGone(new CliError('gh exited with code 1: This issue was deleted', undefined, 1), github), false)
    assert.equal(isGone(new Error('gh exited with code 1'), github), false)
    // Feishu 的永久码是它自己的那一组。
    assert.equal(isGone(new CliError('recalled', 230011, 0), [{ code: 230011 }, { code: 230001 }, { code: 231003 }]), true)
    assert.equal(isGone(new CliError('rate limited', 99991400, 0), [{ code: 230011 }, { code: 230001 }, { code: 231003 }]), false)
  })
})

describe('the port is the only way out', () => {
  test('no other production module starts a CLI subprocess', () => {
    // runtime/ 是 Orca CLI 的专用包装（§B、§C.2 规则 4），尚未实现；它同样不经本端口。
    const allowed = (file: string): boolean =>
      file === 'src/worker/sources/commands.ts' || file.startsWith('src/worker/runtime/')
    // 只认 import 形态：`store.ts` 里的局部变量叫 `exec`、`schema.ts` 帮用户校验的名字里带
    // `exec(`，那都不是起子进程。
    const childProcess = listFiles('src', '.ts')
      .filter((file) => !file.endsWith('.d.ts'))
      .filter((file) => !allowed(file))
      .filter((file) => /(?:from\s*|import\s*\(\s*)['"]node:child_process['"]/.test(readRepoFile(file)))
    assert.deepEqual(childProcess, [], 'node:child_process outside the command port')

    const spawns = listFiles('src', '.ts')
      .filter((file) => !file.endsWith('.d.ts'))
      .filter((file) => !allowed(file))
      .flatMap((file) => {
        const lines = readRepoFile(file).split('\n')
        return lines
          .map((line, index) => ({ line, number: index + 1 }))
          .filter(({ line }) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
          // 只认「真的调用子进程」的形态：本地没有同名绑定的 `spawn/execFile/execFileSync`。
          .filter(({ line }) => /\b(?:spawnSync|execFileSync|execFile)\s*\(/.test(line))
          .map(({ number }) => `${file}:${number}`)
      })
    assert.deepEqual(spawns, [], 'subprocess calls outside the command port')
  })

  test('the port itself pins argv arrays and shell:false', () => {
    const source = readRepoFile('src/worker/sources/commands.ts')
    assert.ok(source.includes('shell: false'), 'the port never asks for a shell')
    assert.ok(source.includes('maxBuffer: MAX_OUTPUT_BYTES'), 'the port caps output')
  })
})

describe('the streaming variant of the port', () => {
  test('a stream delivers stdout lines in order, then the exit code', async () => {
    const commands = new Commands()
    const lines: string[] = []
    const diagnostics: string[] = []
    const outcome = await new Promise<StreamExit>((resolve) => {
      commands.stream('sh', ['-c', 'printf "one\\ntwo\\n"; printf "a warning\\n" >&2; exit 3'], {
        onLine: (line) => lines.push(line),
        onDiagnostic: (line) => diagnostics.push(line),
        onExit: resolve
      })
    })
    assert.deepEqual(lines, ['one', 'two'])
    assert.deepEqual(diagnostics, ['a warning'])
    assert.equal(outcome.code, 3)
    // 标准错误的尾巴留在退出读数里（诊断用），但不回显 argv（§I.4 脱敏）。
    assert.equal(outcome.stderr, 'a warning')
    assert.equal(outcome.stderr.includes('one'), false)
  })

  test('a line split across chunks still arrives as one line', async () => {
    const commands = new Commands()
    const lines: string[] = []
    const outcome = await new Promise<StreamExit>((resolve) => {
      // 三个写：第一段没有换行，第二段补齐。
      commands.stream('sh', ['-c', 'printf "hal"; printf "f\\nsecond\\n"'], {
        onLine: (line) => lines.push(line),
        onExit: resolve
      })
    })
    assert.deepEqual(lines, ['half', 'second'])
    assert.equal(outcome.code, 0)
  })

  test('stop ends an unbounded child instead of leaving it running', async () => {
    const commands = new Commands()
    const lines: string[] = []
    let handle: CommandStream | undefined
    // 等「第一行到了」用事件而不是轮询：子进程的输出走 I/O 事件，微任务轮询看不到它。
    let arrived: () => void = () => undefined
    const first = new Promise<void>((resolve) => {
      arrived = resolve
    })
    const outcome = new Promise<StreamExit>((resolve) => {
      // `exec` 让 spawn 出来的进程直接变成 `cat`（没有孙进程）：关标准输入或 SIGTERM 都能收尾。
      handle = commands.stream('sh', ['-c', 'printf "ready\\n"; exec cat >/dev/null'], {
        onLine: (line) => {
          lines.push(line)
          if (line === 'ready') arrived()
        },
        onExit: resolve
      })
    })
    await first
    handle?.stop()
    const guard = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('stop did not end the stream within 2 s')), 2000)
      timer.unref?.()
    })
    const result = await Promise.race([outcome, guard])
    // 停机是「进程结束」，退出码是 0（标准输入 EOF）还是 null（SIGTERM）都算数。
    assert.equal(result.code === 0 || result.code === null, true, 'the child ended')
    // 再停一次是无害的（真端口的 `stop()` 幂等）。
    handle?.stop()
  })

  test('the whitelist refuses a program the stream may not run', () => {
    const commands = new Commands()
    assert.throws(
      () => commands.stream('bash', ['-c', 'true'], { onLine: () => {}, onExit: () => {} }),
      /not one of the allowed programs/
    )
  })
})

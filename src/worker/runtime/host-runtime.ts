// `HostOrcaRuntime`（§B.4 的生产实现）：把 `OrcaWorkerApi`（Host API）与 `orca` CLI 拼成
// seam 的唯一实现。`runtime/` 之外没有任何模块 import `orca`、host.call 或起 `orca` 子进程。
//
// 分工（§B.3 的落地路径）：Host API 有方法的走 Host（工作区列举、agent 启动的回落、终端
// 读写、通知、状态栏、存储/设置/密钥）；Host API 没有的走 CLI（建 worktree、关终端、
// `terminal list` 的全机枚举、prepare 的一次性命令）。两条路径的错误都折成 `OrcaRuntimeError`。
import type { OrcaWorkerApi, AgentStatusChangedPayload } from './worker-api'
import type {
  AgentHandle,
  AgentRow,
  AgentSpec,
  AgentStatusEvent,
  CommandHandle,
  CommandSpec,
  JsonValue,
  OrcaRuntime,
  RuntimeStorage,
  StatusBarUpdate,
  TerminalRow,
  WorkspaceHandle,
  WorkspaceInfo,
  WorkspaceSpec
} from './orca-runtime'
import { OrcaRuntimeError } from './orca-runtime'
import type { OrcaCli } from './cli'
import { createOrcaCli } from './cli'

/** Host API 的错误码（`references/host-api.md §Errors`）；未知码按 `action_failed` 处理。 */
const HOST_ERROR_CODES = new Set([
  'invalid_request',
  'invalid_params',
  'unknown_method',
  'capability_denied',
  'consent_required',
  'not_permitted',
  'rate_limited',
  'unavailable',
  'action_failed',
  'cancelled',
  'timeout',
  'conflict',
  'too_large'
])

/** 一个对象字段（读取 CLI 回执时用；取不到就是 undefined）。 */
function field(value: JsonValue, key: string): JsonValue {
  return typeof value === 'object' && value !== null ? (value as Record<string, JsonValue>)[key] : undefined
}

/** 一个字符串字段。 */
function text(value: JsonValue, key: string): string | undefined {
  const found = field(value, key)
  return typeof found === 'string' ? found : undefined
}

/** 一个布尔字段。 */
function flagOf(value: JsonValue, key: string): boolean {
  return field(value, key) === true
}

/** 一个数组字段。 */
function listOf(value: JsonValue, key: string): readonly JsonValue[] {
  const found = field(value, key)
  return Array.isArray(found) ? found : []
}

/** 把 Host API 的失败折成 seam 错误（码在表内就原样用，否则 `action_failed`）。 */
function hostError(method: string, error: unknown): OrcaRuntimeError {
  const raw = error as { readonly code?: unknown; readonly message?: unknown } | null
  const code = typeof raw?.code === 'string' && HOST_ERROR_CODES.has(raw.code) ? raw.code : 'action_failed'
  const message = typeof raw?.message === 'string' && raw.message.length > 0 ? raw.message : `${method} failed`
  return new OrcaRuntimeError(code as OrcaRuntimeError['code'], message.slice(0, 300))
}

/** 一遍 `terminal list --json` 的行 → seam 的终端行。 */
function terminalRowOf(value: JsonValue): TerminalRow | undefined {
  const handle = text(value, 'handle')
  if (handle === undefined) return undefined
  return {
    handle,
    worktreeId: text(value, 'worktreeId') ?? null,
    worktreePath: text(value, 'worktreePath') ?? null,
    title: text(value, 'title') ?? null,
    connected: flagOf(value, 'connected'),
    orphaned: flagOf(value, 'orphaned')
  }
}

/** 构造依赖：宿主对象 + 可注入的 CLI 包装（测试用替身）。 */
export interface HostRuntimeOptions {
  readonly cli?: OrcaCli
  readonly program?: string
  /** 一次性命令的轮询间隔（测试注入 0，不 sleep）。 */
  readonly wait?: (milliseconds: number) => Promise<void>
  readonly log?: (message: string) => void
}

/**
 * 用 `OrcaWorkerApi` 实现 seam。构造时只保存宿主与 CLI，不做任何 I/O（首次调用才动）。
 */
export function createHostRuntime(orca: OrcaWorkerApi, options: HostRuntimeOptions = {}): OrcaRuntime {
  const cli = options.cli ?? createOrcaCli(options.program ?? 'orca')
  const wait = options.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const log = options.log ?? (() => undefined)

  /** 一次 Host 调用：失败按码折成 seam 错误。 */
  const call = async <T>(method: string, params: Record<string, JsonValue>): Promise<T> => {
    try {
      return (await (orca.host.call as (name: string, value: Record<string, JsonValue>) => Promise<JsonValue>)(method, params)) as T
    } catch (error) {
      throw hostError(method, error)
    }
  }

  const terminals = async (): Promise<readonly TerminalRow[]> => {
    const result = await cli.run(['terminal', 'list'])
    return listOf(result, 'terminals').flatMap((row) => {
      const parsed = terminalRowOf(row)
      return parsed === undefined ? [] : [parsed]
    })
  }

  const runtime: OrcaRuntime = {
    api: { major: orca.api.major, minor: orca.api.minor, locale: 'en' },
    supports(method: string): boolean {
      return orca.host.has(method)
    },

    async ensureWorkspace(spec: WorkspaceSpec, signal?: AbortSignal): Promise<WorkspaceHandle> {
      const existing = (await runtime.listWorkspaces()).find(
        (workspace) => workspace.name === spec.name || (spec.branch !== undefined && workspace.branch === spec.branch)
      )
      if (existing !== undefined) {
        return { workspaceId: existing.workspaceId, path: existing.path, branch: existing.branch, created: false }
      }
      const selector = spec.repo?.path ?? spec.repo?.id ?? spec.repo?.name
      const args = [
        'worktree',
        'create',
        '--name',
        spec.name,
        ...(selector === undefined ? [] : ['--repo', spec.repo?.path !== undefined ? `path:${selector}` : spec.repo?.id !== undefined ? `id:${selector}` : `name:${selector}`]),
        ...(spec.baseBranch === undefined ? [] : ['--base-branch', spec.baseBranch]),
        ...(spec.branch === undefined ? [] : ['--branch', spec.branch]),
        '--setup',
        spec.setup ?? 'skip',
        ...(spec.parent === 'none' ? ['--no-parent'] : []),
        ...(spec.activate === true ? ['--activate'] : [])
      ]
      const result = await cli.run(args, { timeoutMs: 120_000, ...(signal === undefined ? {} : { signal }) })
      const worktree = field(result, 'worktree') ?? result
      const path = text(worktree, 'path')
      const workspaceId = text(worktree, 'id') ?? text(worktree, 'worktreeId') ?? path
      if (path === undefined || workspaceId === undefined) {
        throw new OrcaRuntimeError('cli_failed', 'orca worktree create returned no path')
      }
      return { workspaceId, path, branch: text(worktree, 'branch') ?? null, created: true }
    },

    async listWorkspaces(): Promise<readonly WorkspaceInfo[]> {
      const result = await call<{ workspaces?: readonly JsonValue[] }>('workspace.list', {})
      return (result.workspaces ?? []).flatMap((row) => {
        const workspaceId = text(row, 'id') ?? text(row, 'workspaceId')
        const path = text(row, 'path')
        if (workspaceId === undefined || path === undefined) return []
        return [
          {
            workspaceId,
            kind: text(row, 'kind') === 'folder' ? 'folder' : 'worktree',
            name: text(row, 'name') ?? path,
            path,
            branch: text(row, 'branch') ?? null
          }
        ]
      })
    },

    async openWorkspace(workspaceId: string): Promise<void> {
      await call('workspace.open', { workspaceId })
    },

    async launchAgent(spec: AgentSpec, signal?: AbortSignal): Promise<AgentHandle> {
      const launchedAt = Date.now()
      try {
        const result = await cli.run(
          [
            'agent',
            'launch',
            '--agent',
            spec.agent,
            '--worktree',
            `path:${spec.workspace.path}`,
            '--surface',
            'terminal',
            ...(spec.model === undefined ? [] : ['--model', spec.model]),
            ...(spec.effort === undefined ? [] : ['--effort', spec.effort]),
            ...(spec.prompt === undefined ? [] : ['--prompt', spec.prompt])
          ],
          { timeoutMs: 120_000, ...(signal === undefined ? {} : { signal }) }
        )
        const launch = field(result, 'launch')
        const handle =
          text(field(launch, 'outcome'), 'handle') ?? text(result, 'agentTerminalHandle') ?? text(result, 'terminalId')
        if (handle === undefined) throw new OrcaRuntimeError('agent_gone', 'the launch receipt carried no terminal handle')
        return { terminalId: handle, workspaceId: spec.workspace.workspaceId, launchedAt }
      } catch (error) {
        // 回落（§E.2）：没配 model/effort 且 Host 有 agent.launch 时走 Host。
        if ((spec.model !== undefined || spec.effort !== undefined) || !orca.host.has('agent.launch')) throw error
        log(`agent launch fell back to the host API: ${error instanceof Error ? error.message : String(error)}`)
        const result = await call<{ terminalId?: string }>('agent.launch', {
          workspaceId: spec.workspace.workspaceId,
          agent: spec.agent,
          ...(spec.prompt === undefined ? {} : { prompt: spec.prompt })
        })
        if (result.terminalId === undefined) throw new OrcaRuntimeError('agent_gone', 'agent.launch returned no terminal')
        return { terminalId: result.terminalId, workspaceId: spec.workspace.workspaceId, launchedAt }
      }
    },

    async listAgents(): Promise<readonly AgentRow[]> {
      const result = await call<{ agents?: readonly JsonValue[] }>('agents.list', {})
      return (result.agents ?? []).map((row) => ({
        terminalId: text(row, 'terminalId') ?? null,
        title: text(row, 'title') ?? null,
        agent: text(row, 'agent') ?? null,
        state: (text(row, 'state') ?? 'working') as AgentRow['state'],
        stateStartedAt: Number(field(row, 'stateStartedAt') ?? 0)
      }))
    },

    async findAgent(workspaceId: string): Promise<AgentHandle | null> {
      const matches = (await terminals()).filter(
        (row) => row.worktreeId === workspaceId && row.connected && !row.orphaned
      )
      return matches.length === 1
        ? { terminalId: matches[0]!.handle, workspaceId, launchedAt: Date.now() }
        : null
    },

    listTerminals: terminals,

    onAgentStatus(handler: (event: AgentStatusEvent) => void): () => void {
      const disposable = orca.events.on('agent.status.changed', (payload: AgentStatusChangedPayload) => {
        handler({
          workspaceId: payload.workspaceId,
          paneKey: payload.paneKey,
          ...(payload.terminalId === undefined ? {} : { terminalId: payload.terminalId }),
          state: payload.state,
          receivedAt: payload.receivedAt
        })
      })
      return () => disposable.dispose()
    },

    async sendText(terminalId: string, value: string, sendOptions: { readonly enter?: boolean } = {}): Promise<{ readonly accepted: boolean }> {
      try {
        const result = await call<{ accepted?: boolean }>('terminal.sendText', {
          terminalId,
          text: value,
          ...(sendOptions.enter === undefined ? {} : { enter: sendOptions.enter })
        })
        return { accepted: result.accepted === true }
      } catch (error) {
        // 附录 C S1：宿主只允许向**聚焦**工作区发文本；未聚焦时回落 CLI。
        if (!(error instanceof OrcaRuntimeError) || !['unavailable', 'action_failed'].includes(error.code)) throw error
        await cli.run([
          'terminal',
          'send',
          '--terminal',
          terminalId,
          '--text',
          value,
          ...(sendOptions.enter === true ? ['--enter'] : [])
        ])
        return { accepted: true }
      }
    },

    async readTerminal(terminalId: string, readOptions: { readonly maxLines?: number } = {}): Promise<{ readonly lines: readonly string[]; readonly truncated: boolean }> {
      const result = await call<{ lines?: readonly string[]; truncated?: boolean }>('terminal.read', {
        terminalId,
        ...(readOptions.maxLines === undefined ? {} : { maxLines: readOptions.maxLines })
      })
      return { lines: result.lines ?? [], truncated: result.truncated === true }
    },

    async closeTerminal(terminalId: string): Promise<void> {
      await cli.run(['terminal', 'close', '--terminal', terminalId])
    },

    async runCommand(spec: CommandSpec, signal?: AbortSignal): Promise<CommandHandle> {
      const marker = `__SUPERAGENT_EXIT_${Date.now().toString(36)}`
      const command = `${spec.command}; printf '\\n${marker}:%s\\n' "$?"`
      const created = await cli.run(
        ['terminal', 'create', '--worktree', `path:${spec.workspace.path}`, '--command', command],
        { timeoutMs: 120_000, ...(signal === undefined ? {} : { signal }) }
      )
      const terminalId = text(created, 'handle') ?? text(created, 'terminalId')
      if (terminalId === undefined) throw new OrcaRuntimeError('cli_failed', 'orca terminal create returned no handle')
      const deadline = Date.now() + spec.timeoutMs
      let output: readonly string[] = []
      for (;;) {
        const read = await cli.run(['terminal', 'read', '--terminal', terminalId, '--limit', '200'])
        output = listOf(read, 'tail').filter((line): line is string => typeof line === 'string')
        const exitLine = output.find((line) => line.includes(`${marker}:`))
        if (exitLine !== undefined) {
          const code = Number(exitLine.slice(exitLine.lastIndexOf(':') + 1).trim())
          return { terminalId, exitCode: Number.isFinite(code) ? code : null, output }
        }
        if (Date.now() >= deadline) return { terminalId, exitCode: null, output }
        await wait(200)
      }
    },

    async notify(input: { readonly title: string; readonly body?: string }): Promise<{ readonly delivered: boolean }> {
      const result = await call<{ delivered?: boolean }>('notifications.show', {
        title: input.title,
        ...(input.body === undefined ? {} : { body: input.body })
      })
      return { delivered: result.delivered === true }
    },

    async setStatusBar(update: StatusBarUpdate): Promise<void> {
      await call('statusBar.update', {
        id: update.id,
        ...(update.text === undefined ? {} : { text: update.text }),
        ...(update.tone === undefined ? {} : { tone: update.tone }),
        ...(update.tooltip === undefined ? {} : { tooltip: update.tooltip }),
        ...(update.visible === undefined ? {} : { visible: update.visible })
      })
    },

    storage: {
      async get(key: string): Promise<JsonValue | null> {
        const result = await call<{ value?: JsonValue }>('storage.get', { key })
        return result.value ?? null
      },
      async set(key: string, value: JsonValue): Promise<void> {
        await call('storage.set', { key, value })
      },
      async delete(key: string): Promise<void> {
        await call('storage.delete', { key })
      },
      async keys(): Promise<readonly string[]> {
        const result = await call<{ keys?: readonly string[] }>('storage.keys', {})
        return result.keys ?? []
      }
    } satisfies RuntimeStorage,

    settings: {
      async get(): Promise<Readonly<Record<string, JsonValue>>> {
        const result = await call<{ settings?: Readonly<Record<string, JsonValue>> }>('settings.get', {})
        return result.settings ?? {}
      },
      async set(key: string, value: JsonValue): Promise<void> {
        await call('settings.set', { key, value })
      }
    },

    secrets: {
      async get(key: string): Promise<string | null> {
        const result = await call<{ value?: string | null }>('secrets.get', { key })
        return result.value ?? null
      },
      async set(key: string, value: string): Promise<void> {
        await call('secrets.set', { key, value })
      },
      async delete(key: string): Promise<void> {
        await call('secrets.delete', { key })
      },
      async protection(): Promise<'os-keyring' | 'unavailable'> {
        const result = await call<{ status?: string }>('secrets.protection', {})
        return result.status === 'os-keyring' ? 'os-keyring' : 'unavailable'
      }
    }
  }
  return runtime
}

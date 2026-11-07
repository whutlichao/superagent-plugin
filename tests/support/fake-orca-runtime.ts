// `FakeOrcaRuntime`（设计 §B.4 的测试替身）：内存里的工作区、agent 与终端表，加上可注入的
// 结果/异常与逐次调用记录。执行器的测试只经 `OrcaRuntime` 接口观察外部行为（§P.1：真库 +
// 临时目录 + 注入时钟，不 mock 内部层）。
//
// 为什么放在 `tests/support/` 而不是 `src/worker/runtime/fake-runtime.ts`：
// - `runtime-seam.test.ts` 断言生产 seam 目录里「只有接口、没有实现」（#4 的规则），
//   测试替身一旦进 `src/` 就会把那条断言改成假绿或被迫放宽；
// - 它不是插件的一部分，不随插件发布；放在测试面也不影响 §C.2 的依赖方向。
// 设计 §B.4 描述的是替身的**语义**（内存表、脚本注入、记录调用），位置是测试面。
import { OrcaRuntimeError } from '../../src/worker/runtime/orca-runtime.ts'
import type {
  AgentHandle,
  AgentRow,
  AgentSpec,
  AgentStatusEvent,
  CommandHandle,
  CommandSpec,
  JsonValue,
  OrcaRuntime,
  RepoRow,
  RepoSelector,
  StatusBarUpdate,
  TerminalRow,
  WorkspaceHandle,
  WorkspaceInfo,
  WorkspaceSpec
} from '../../src/worker/runtime/orca-runtime.ts'

/** 一次 `sendText` 的记录：执行器断言「发的是什么、有没有回车」。 */
export interface SentText {
  readonly terminalId: string
  readonly text: string
  readonly enter: boolean
}

/** 测试替身能逐方法注入的结果；不注入就走默认行为（建表、记账、成功）。 */
export interface FakeOrcaScript {
  ensureWorkspace?: (spec: WorkspaceSpec) => WorkspaceHandle | Promise<WorkspaceHandle>
  launchAgent?: (spec: AgentSpec) => AgentHandle | Promise<AgentHandle>
  findAgent?: (workspaceId: string) => AgentHandle | null | Promise<AgentHandle | null>
  sendText?: (
    terminalId: string,
    text: string,
    options?: { readonly enter?: boolean }
  ) => { readonly accepted: boolean } | Promise<{ readonly accepted: boolean }>
  readTerminal?: (
    terminalId: string,
    options?: { readonly maxLines?: number }
  ) => { readonly lines: readonly string[]; readonly truncated: boolean } | Promise<{
    readonly lines: readonly string[]
    readonly truncated: boolean
  }>
  closeTerminal?: (terminalId: string) => void | Promise<void>
  focusTerminal?: (terminalId: string) => void | Promise<void>
  runCommand?: (spec: CommandSpec) => CommandHandle | Promise<CommandHandle>
  listTerminals?: () => readonly TerminalRow[] | Promise<readonly TerminalRow[]>
  listRepos?: () => readonly RepoRow[] | Promise<readonly RepoRow[]>
  searchRefs?: (selector: RepoSelector, query: string) => readonly string[] | Promise<readonly string[]>
}

/** 逐次调用的记录；测试按它断言顺序、次数与参数。 */
export interface FakeOrcaCalls {
  readonly ensureWorkspace: WorkspaceSpec[]
  readonly launchAgent: AgentSpec[]
  readonly findAgent: string[]
  readonly sent: SentText[]
  readonly readTerminal: { readonly terminalId: string; readonly maxLines: number | undefined }[]
  readonly closeTerminal: string[]
  readonly focusTerminal: string[]
  readonly runCommand: CommandSpec[]
  readonly listWorkspaces: number[]
  readonly listAgents: number[]
  readonly listTerminals: number[]
  readonly listRepos: number[]
  readonly searchRefs: { readonly selector: RepoSelector; readonly query: string }[]
}

/** 终端在替身里的内容：按行存，`sendText` 追加，`readTerminal` 截取尾部。 */
interface FakeTerminal {
  readonly handle: string
  readonly workspaceId: string
  readonly lines: string[]
}

/**
 * 运行缝的测试替身。默认行为尽量像真宿主：建工作区就记进表，启动 agent 就发一个句柄并
 * 把它登记到工作区（反查因此默认能找到），发送文本就写进终端内容（回读因此默认能看到）。
 * 需要「坏掉」的路径（CLI 失败、回执缺句柄、终端吞字）用 `script` 注入。
 */
export class FakeOrcaRuntime implements OrcaRuntime {
  readonly api = { major: 1, minor: 3, locale: 'en' }
  readonly calls: FakeOrcaCalls = {
    ensureWorkspace: [],
    launchAgent: [],
    findAgent: [],
    sent: [],
    readTerminal: [],
    closeTerminal: [],
    focusTerminal: [],
    runCommand: [],
    listWorkspaces: [],
    listAgents: [],
    listTerminals: [],
    listRepos: [],
    searchRefs: []
  }

  /** 下一次 `ensureWorkspace` 返回 `created: true` 时用的路径（确定性，测试可断言）。 */
  static readonly WORKTREE_ROOT = '/tmp/superagent-worktrees'

  readonly script: FakeOrcaScript = {}
  /** `listWorkspaces()` 的回答；测试直接改它来模拟「已有 worktree」。 */
  workspaces: WorkspaceInfo[] = []
  /**
   * `listRepos()` 的回答。缺省带一个与 `tests/support/boot.ts` 的设置相符的仓库
   * （`baseRepo: '/repos/widgets'`），于是「什么都没改」的 boot 场景 setup 通过。
   */
  repos: RepoRow[] = [{ id: 'repo-widgets', path: '/repos/widgets', name: 'widgets' }]
  /** `searchRefs()` 能命中的 ref（缺省 `main`：fixture 设置的 base ref 没配，用不到它）。 */
  refs: string[] = ['main']
  /**
   * 新建 worktree 的路径根（缺省即 `WORKTREE_ROOT`）。执行器会往这个目录里写 `.superagent/`，
   * 所以需要真文件系统的用例把它换成临时目录，避免在 `/tmp` 固定位置留垃圾。
   */
  worktreeRoot: string = FakeOrcaRuntime.WORKTREE_ROOT
  /** 反查表：`workspaceId → agent 句柄`；`launchAgent` 默认往这里登记。 */
  readonly agentsByWorkspace = new Map<string, AgentHandle>()
  /** 终端表：句柄 → 内容。 */
  readonly terminals = new Map<string, FakeTerminal>()
  #sequence = 0

  supports(): boolean {
    return true
  }

  async ensureWorkspace(spec: WorkspaceSpec): Promise<WorkspaceHandle> {
    this.calls.ensureWorkspace.push(spec)
    if (this.script.ensureWorkspace) return await this.script.ensureWorkspace(spec)
    const path = `${this.worktreeRoot}/${spec.name}`
    const handle: WorkspaceHandle = {
      workspaceId: `ws:${spec.name}`,
      path,
      branch: spec.branch ?? null,
      created: true
    }
    this.workspaces = [
      ...this.workspaces,
      {
        workspaceId: handle.workspaceId,
        kind: 'worktree',
        name: spec.name,
        path: handle.path,
        branch: handle.branch
      }
    ]
    return handle
  }

  async listRepos(): Promise<readonly RepoRow[]> {
    this.calls.listRepos.push(this.repos.length)
    if (this.script.listRepos) return await this.script.listRepos()
    return this.repos
  }

  async searchRefs(selector: RepoSelector, query: string): Promise<readonly string[]> {
    this.calls.searchRefs.push({ selector, query })
    if (this.script.searchRefs) return await this.script.searchRefs(selector, query)
    return this.refs.filter((ref) => ref.includes(query))
  }

  async listWorkspaces(): Promise<readonly WorkspaceInfo[]> {
    this.calls.listWorkspaces.push(this.workspaces.length)
    return this.workspaces
  }

  async openWorkspace(): Promise<void> {}

  async launchAgent(spec: AgentSpec): Promise<AgentHandle> {
    this.calls.launchAgent.push(spec)
    if (this.script.launchAgent) return await this.script.launchAgent(spec)
    return this.#recordLaunch(spec)
  }

  /** 默认的「启动成功」：发一个句柄、登记反查表、开一个终端。 */
  #recordLaunch(spec: AgentSpec): AgentHandle {
    this.#sequence += 1
    const handle: AgentHandle = {
      terminalId: `term_${this.#sequence}`,
      workspaceId: spec.workspace.workspaceId,
      launchedAt: 1_000 + this.#sequence
    }
    this.agentsByWorkspace.set(spec.workspace.workspaceId, handle)
    this.terminals.set(handle.terminalId, {
      handle: handle.terminalId,
      workspaceId: spec.workspace.workspaceId,
      lines: []
    })
    return handle
  }

  /** 测试用来模拟「agent 列表里出现了一台终端」（反查成功的那一支）。 */
  registerAgent(workspaceId: string, handle: AgentHandle): void {
    this.agentsByWorkspace.set(workspaceId, handle)
    this.terminals.set(handle.terminalId, { handle: handle.terminalId, workspaceId, lines: [] })
  }

  async listAgents(): Promise<readonly AgentRow[]> {
    this.calls.listAgents.push(this.agentsByWorkspace.size)
    return [...this.agentsByWorkspace.values()].map((handle) => ({
      terminalId: handle.terminalId,
      title: null,
      agent: null,
      state: 'working',
      stateStartedAt: handle.launchedAt
    }))
  }

  async findAgent(workspaceId: string): Promise<AgentHandle | null> {
    this.calls.findAgent.push(workspaceId)
    if (this.script.findAgent) return await this.script.findAgent(workspaceId)
    return this.agentsByWorkspace.get(workspaceId) ?? null
  }

  async listTerminals(): Promise<readonly TerminalRow[]> {
    this.calls.listTerminals.push(this.terminals.size)
    if (this.script.listTerminals) return await this.script.listTerminals()
    return [...this.terminals.values()].map((terminal) => ({
      handle: terminal.handle,
      worktreeId: terminal.workspaceId,
      worktreePath: null,
      title: null,
      connected: true,
      orphaned: false
    }))
  }

  onAgentStatus(): () => void {
    return () => undefined
  }

  async sendText(
    terminalId: string,
    text: string,
    options: { readonly enter?: boolean } = {}
  ): Promise<{ readonly accepted: boolean }> {
    this.calls.sent.push({ terminalId, text, enter: options.enter === true })
    if (this.script.sendText) return await this.script.sendText(terminalId, text, options)
    const terminal = this.terminals.get(terminalId)
    if (!terminal) throw new OrcaRuntimeError('agent_gone', `no terminal ${terminalId}`)
    // 真终端会把写进去的字节回显成输出行；回读因此能看到刚发的内容。
    for (const line of text.split('\n')) terminal.lines.push(line)
    return { accepted: true }
  }

  async readTerminal(
    terminalId: string,
    options: { readonly maxLines?: number } = {}
  ): Promise<{ readonly lines: readonly string[]; readonly truncated: boolean }> {
    this.calls.readTerminal.push({ terminalId, maxLines: options.maxLines })
    if (this.script.readTerminal) return await this.script.readTerminal(terminalId, options)
    const terminal = this.terminals.get(terminalId)
    if (!terminal) throw new OrcaRuntimeError('agent_gone', `no terminal ${terminalId}`)
    const maxLines = options.maxLines ?? 120
    const lines = terminal.lines.slice(-maxLines)
    return { lines, truncated: terminal.lines.length > lines.length }
  }

  async closeTerminal(terminalId: string): Promise<void> {
    this.calls.closeTerminal.push(terminalId)
    if (this.script.closeTerminal) return await this.script.closeTerminal(terminalId)
    this.terminals.delete(terminalId)
  }

  async focusTerminal(terminalId: string): Promise<void> {
    this.calls.focusTerminal.push(terminalId)
    if (this.script.focusTerminal) return await this.script.focusTerminal(terminalId)
    // 真 CLI 对不存在的终端报错：替身也让「没有这台终端」是一条可注入的失败。
    if (!this.terminals.has(terminalId)) {
      throw new OrcaRuntimeError('agent_gone', `terminal ${terminalId} is not running`)
    }
  }

  async runCommand(spec: CommandSpec): Promise<CommandHandle> {
    this.calls.runCommand.push(spec)
    if (this.script.runCommand) return await this.script.runCommand(spec)
    return { terminalId: 'term_prepare', exitCode: 0, output: [] }
  }

  async notify(): Promise<{ readonly delivered: boolean }> {
    return { delivered: true }
  }

  async setStatusBar(_update: StatusBarUpdate): Promise<void> {}

  readonly storage = {
    get: async (_key: string): Promise<JsonValue | null> => null,
    set: async (_key: string, _value: JsonValue): Promise<void> => {},
    delete: async (_key: string): Promise<void> => {},
    keys: async (): Promise<readonly string[]> => []
  }

  readonly settings = {
    get: async (): Promise<Readonly<Record<string, JsonValue>>> => ({}),
    set: async (_key: string, _value: JsonValue): Promise<void> => {}
  }

  readonly secrets = {
    get: async (_key: string): Promise<string | null> => null,
    set: async (_key: string, _value: string): Promise<void> => {},
    delete: async (_key: string): Promise<void> => {},
    protection: async (): Promise<'os-keyring' | 'unavailable'> => 'unavailable'
  }

  /** 一个没有订阅的状态事件：测试直接调，验证执行器不会把它当成枚举真源。 */
  static statusEvent(terminalId: string, state: AgentStatusEvent['state']): AgentStatusEvent {
    return { workspaceId: null, paneKey: 'p', terminalId, state, receivedAt: 0 }
  }
}

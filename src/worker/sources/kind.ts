// Source kind 协议（§I.1）：一个 Source 是一个 kind（代码）+ 一条设置实例（配置）。
//
// 这个文件只声明契约与共用的值形状，不含任何 I/O：
// - `SourceKind<C>`：配置 schema、设置表单字段、部署派生的事实、自己 claim 的 health 条目、
//   按 scope 判定「是否监听」、Channel（是否允许此地址 / 发送 / 链接）、Thread 上下文、搜索、
//   Policy 部分（准入行、bots、名单同步）、环境变量贡献、显示名刷新；
// - `SourceContext`：kind 访问引擎的**唯一**端口（§C.2 规则 2）。kind 拿不到 Engine、Store、
//   Commands 的实现，只能经这些成员读配置、收 Trigger、写自己的读位置、报告健康。
//
// 与 `core/ports.ts` 的关系（coordinator 裁决：组合，不重定义）：那里的 `SourceContext` 是
// 领域视角的端口，本文件的 `SourceContext` **继承它**，只补 §I.1 要求而领域还不需要的四件事：
// `configured()` / `problem` / `config<C>(kind)` / `commands.withSignal`。两处若有冲突，以
// `core/ports.ts` 的形状为准（领域已经在用），本文件只做加法。
import type {
  ChannelRef,
  OutboundMessage,
  ScopeResult,
  SourceContext as DomainSourceContext,
  SourceProblem,
  Trigger
} from '../core/index.ts'
import type { Schema } from '../infra/schema.ts'
import type { CommandsHost } from './commands.ts'
import type { ThreadContext } from './admission-context.ts'

// kind 的实现要写 `threadContext`，注册表与评估要读它；从这里转出，实现文件只 import 本模块。
export type {
  ContextMessage,
  ContextPart,
  ContextPartName,
  ThreadContext,
  TriggerContext
} from './admission-context.ts'

/** 两种界面语言的一段文案（§M.5）。 */
export interface Localized {
  zh: string
  en: string
}

/** 设置表单字段的公共部分：键、标签、提示，以及是否收进 Advanced 折叠区。 */
interface FieldBase {
  key: string
  label: Localized
  hint?: Localized
  advanced?: true
}

/** 一列行编辑器（`rows` 字段的列）：文本（可带 pattern / 选择 / 刷新）或下拉。 */
export type FieldColumn =
  | FieldBase & {
      type: 'text'
      pattern?: string
      readonly?: true
      optional?: true
      choose?: Localized
      refresh?: Localized
    }
  | FieldBase & { type: 'select'; options: readonly { value: string; label: Localized }[] }

/**
 * 设置表单字段（§I.1）：面板按它生成控件。`rows` 编辑一列记录（按第一列作键），
 * `fact` 显示 `facts` 派生的只读值。
 */
export type Field =
  | (FieldBase & { type: 'switch' })
  | (FieldBase & { type: 'select'; options: readonly { value: string; label: Localized }[] })
  | (FieldBase & { type: 'number'; min: number; max: number })
  | (FieldBase & { type: 'text'; pattern?: string; readonly?: true; choose?: Localized })
  | (FieldBase & { type: 'fact'; settings?: 'deployment' })
  | (FieldBase & { type: 'rows'; columns: readonly FieldColumn[] })

/** setup 派生的一条只读事实（账号、仓库）；`key` 对应表单里 `type: 'fact'` 的字段。 */
export interface Fact {
  readonly key: string
  readonly value: Localized | string
}

/**
 * 部署解析出来的、Source 能看到的只读事实（§I.1 `facts(deployment)`、§E.11 的变量源）。
 * 完整解析由部署票（#44）负责；这里只声明 Source 会读到的部分。
 */
export interface Deployment {
  /** agent 的 GitHub 账号能读写的仓库，`owner/name`；等待 setup 时为空串。 */
  readonly repository: string
  /** agent 的 GitHub CLI（命令名或绝对路径，通常是包装脚本）。 */
  readonly githubCli: string
  /** agent 的 GitHub 账号与提交邮箱（noreply）。 */
  readonly githubLogin: string
  readonly githubCommitEmail: string
  /** Feishu 机器人的 CLI / open_id / app_id；没有配置时为空串。 */
  readonly feishuCli: string
  readonly feishuBotId: string
  readonly feishuAppId: string
}

// 准入行的形状住在 `policy/admission.ts`（§K.1）：policy 不 import sources（§C.2），
// sources 可以 import policy 的类型。这里转出，kind 的实现只 import 本文件。
export type {
  AdmissionCellsConfig,
  AdmissionRow,
  AdmissionTableConfig,
  Admission
} from '../policy/admission.ts'
import type { AdmissionRow } from '../policy/admission.ts'

/** Policy 里属于某个 Source 的那一部分（§K.1、§I.1 `policy`）。 */
export interface SourcePolicyPart<P = Record<string, unknown>> {
  /** 校验这个 Source 的 Policy 部分（含 `allowed` 名单）。 */
  readonly schema: Schema<P>
  /** 该部分在设置表单里的字段；第一个是 `allowed`。 */
  readonly fields: readonly Field[]
  /** 这个 Source 认为「在跟智能体说话」是什么；名单上的人必须这样才算显式请求。 */
  readonly explicit: Localized
  /** 名单外的发送者没有可读名字时的兜底标签。 */
  readonly unnamed?: { person: Localized; bot: Localized }
  /** 接收 scope 的行（与 `scope().row` 对应）；没有 `rows` 的 kind 用表的默认行。 */
  rows?(config: Record<string, unknown>): readonly AdmissionRow[]
  /** `bots` 名单在设置表单里的字段（§K.2 第 5 条）。 */
  readonly bots?: readonly Field[]
  /** 可选的名单同步（如群成员）：`ready` 说明 `part` 是否点名了要同步的目标。 */
  readonly sync?: {
    readonly label: Localized
    ready(part: P): boolean
    run(host: SourceContext, part: P, signal: AbortSignal): Promise<P>
  }
}

/** 一条 Channel 地址的链接：`url` 为空表示缺部署信息、构造不出页面。 */
export interface ChannelLink {
  url: string
  label: Localized
}

/** 构造 Channel 链接需要的部署事实；缺哪个就少哪种链接。 */
export interface ChannelLinks {
  readonly repository?: string
  readonly feishu?: { readonly chatId?: string } | undefined
}

/** 出站消息适配器（§I.1 `channel`）：kind 自己决定怎么发、发到哪里、还能不能发。 */
export interface SourceChannel<C> {
  /** 这个地址还能不能收到回复；不实现时任何地址都可以。 */
  allowed?(address: ChannelRef['address'], config: C): boolean
  /**
   * 按消息 id 幂等地发送；目标永远收不到时返回 `gone`。可以稍后重试的失败要抛错
   * （`CliError.code` 让调用方与「永久失败」区分，§I.4）。
   */
  send(host: CommandsHost, message: OutboundMessage): Promise<'sent' | 'gone'>
  /** 地址对应的页面与标签；没有部署信息时 `url` 为空串。 */
  link?(address: ChannelRef['address'], links: ChannelLinks): ChannelLink
}

/** 环境变量声明（§E.11）：变量名 + 双语文档；值由 `values` 计算。 */
export interface VariableSpec {
  key: string
  description: Localized
}

/** 计算环境变量值时要的输入。 */
export interface EnvironmentInput<C> {
  readonly deployment: Deployment
  readonly config: C
  readonly trigger?: Trigger
}

/** Source 对执行环境的贡献（§E.11）：声明变量，并按 Ticket / 部署 / 配置算值。 */
export interface SourceEnvironment<C> {
  readonly variables: readonly VariableSpec[]
  values(input: EnvironmentInput<C>): Record<string, string>
}

/**
 * Source kind 的完整协议（§I.1）。`C` 是这条配置的类型，`schema` 决定它的校验与默认值。
 * 只有 `kind` / `title` / `description` / `schema` / `fields` / `health` 是必填的；其余按
 * kind 的能力取舍。
 */
export interface SourceKind<C = Record<string, unknown>> {
  /** 稳定 id（`github` / `feishu`）；没有存过实例时同 id 的默认实例仍存在。 */
  readonly kind: string
  readonly title: Localized
  readonly description: Localized
  /** 存库配置的校验与默认值（strict：未知键拒绝）。 */
  readonly schema: Schema<C>
  /** 生成设置表单的字段。 */
  readonly fields: readonly Field[]
  /** setup 派生的只读事实（账号、仓库）；等待 setup 时返回空表。 */
  facts?(deployment: Deployment): readonly Fact[]
  /** 本 kind 声明并 claim 的 health 条目；其他部件不得报告同名条目。 */
  readonly health: readonly string[]
  /** 这条 Trigger 是否被监听；不实现时 kind 产生的都监听、且都不算 observed。 */
  scope?(trigger: ScopeInput, config: C): ScopeResult
  /** 出站回复适配器；没有 `channel` 的 kind 不产生回复。 */
  readonly channel?: SourceChannel<C>
  /** 评估用的有界语境；没有它的 kind 评估不读语境。 */
  readonly threadContext?: ThreadContext<C>
  /** 搜索：把查询映射成候选 Thread 键与 Trigger 搜索词。 */
  find?(query: string): { threads: readonly string[]; terms: readonly string[] }
  /** 这条 Trigger 回复的是哪条 Trigger（不需要网络就能推出时）。 */
  repliesTo?(trigger: Trigger): string | undefined
  /** Policy 的这部分（发送者有自己身份的 kind 才有）。 */
  readonly policy?: SourcePolicyPart
  /** 变量的声明与取值（§E.11）。 */
  readonly environment?: SourceEnvironment<C>
  /** 重读行键的显示名（如群名），写进 KV 的 `source-labels:<kind>` 并返回。 */
  refreshLabels?(host: SourceContext, config: C, signal: AbortSignal): Promise<Record<string, string>>
}

/** 一条已存的 Source 实例：kind + 是否启用 + 已校验的配置。 */
export interface SourceInstance<C = Record<string, unknown>> {
  readonly id: string
  readonly kind: string
  readonly enabled: boolean
  readonly config: C
}

/**
 * `scope` 的输入：领域只用 `source` + `meta`（`core/ports.ts` 的 `SourceScope`），kind 的实现
 * 可以按完整 `Trigger` 写（结构化子类型的参数在方法位置上是双变的）。这样注册表既能满足
 * 领域端口，kind 又能拿到 `threads` / `actor` / `addressed` 等判定所需字段。
 */
export type ScopeInput = Pick<Trigger, 'source' | 'meta'> | Trigger

/**
 * kind 访问引擎的唯一端口（§I.1 末段、§C.2 规则 2）：`core/ports.ts` 的 `SourceContext`
 * 加上 kind 真正需要的四项。实现（`app/source-context.ts`）由组合根的票提供；本票只给契约。
 */
export interface SourceContext extends DomainSourceContext {
  /** setup 是否已经完成；Source 只在之后才轮询。 */
  configured(): boolean
  /** 挡住这个 Source 的 setup 问题；只有需要账号检查的 kind 会有。 */
  readonly problem?: SourceProblem | undefined
  /** 启用的实例配置；禁用或未安装时 undefined。 */
  config<C extends Record<string, unknown>>(kind: string): C | undefined
  /** 命令端口（唯一的 CLI 出口，§I.4）。 */
  readonly commands: CommandsHost
}

/** 校验器类型的别名：kind 的 `schema` 字段写 `SourceSchema<C>` 即可（与 `Schema<C>` 同义）。 */
export type SourceSchema<C> = Schema<C>

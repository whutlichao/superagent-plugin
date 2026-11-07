// Prompt 配置的 HTTP handler（§G.3 的 `GET prompts` / `PUT prompts` / `POST prompts/preview`、
// §L.4、§L.5）：CLI 与面板共用同一份实现，路由表只负责方法与角色。
//
// 这一层做四件事，业务判断全在 `app/prompts.ts`：
// 1. 读：把版本库、内置分片、`default-updated` 与历史拼成一个读数（面板 Prompts 页与
//    `superagent prompts get` 读同一个形状）；
// 2. 写：保存、恢复某版本、恢复默认都只是「再存一个新版本」，冲突固定码 `stale_revision`；
// 3. 预览：**同一个** `validatePromptConfig`，只是不写库（票面：面板与 CLI 同一份校验）；
// 4. 保存成功后通知活着的 Router（§F.4：一条短消息，不重启；角色层要新会话才换）。
//
// 依赖纪律（§C.2）：本文件在 `http/`，只 import 同目录的 `ApiError`/`values.ts`、`app/prompts.ts` 与
// `app/` 的类型；不读存储、不 spawn、不 import `runtime/`。部署事实（CLI 路径、token 文件、
// Policy）由组合根以 `PromptDeployment` 注入——缺省时 `--text` 与预览是明说的 `unavailable`，
// 绝不拼一份缺值的全文。
import { ApiError, ERROR_CODES } from './errors.ts'
import { bodyObject } from './values.ts'
import type { RouteCaller, RouteDefinition, RouteHandler } from './routes.ts'
import {
  builtInBases,
  composePrompt,
  isPromptPartKey,
  PROMPT_PARTS,
  PROMPT_PART_KEYS,
  PromptTextError,
  PromptVersionError,
  promptTextOf,
  TEAM_SECTIONS,
  validatePromptConfig,
  type PromptConfig,
  type PromptDefaultChange,
  type PromptEnvironment,
  type PromptPolicy,
  type PromptRole,
  type PromptSaveResult,
  type PromptVersions,
  type PromptVersion
} from '../app/prompts.ts'
import type {
  PromptConfigResult,
  PromptConfigView,
  PromptDefaultChangeView,
  PromptPartView,
  PromptPreviewResult,
  PromptSaveView,
  PromptTextResult,
  PromptVersionSummary
} from './api-types.ts'

/** 历史一页的大小（与 `read` 的缺省 20 一致；上限 50）。 */
export const PROMPT_HISTORY_PAGE = 20

/** 组装全文需要的部署事实（组合根给；缺省时 `--text`/预览固定 `unavailable`）。 */
export interface PromptDeployment {
  /** 一个角色这次会话的执行环境段（只写路径，绝不写 token 值，§D.6）。 */
  environment(input: { readonly role: PromptRole; readonly caller: RouteCaller }): PromptEnvironment
  /** 当前 Policy（Router 的 Policy 段）。 */
  policy(): PromptPolicy
}

/** handler 的接线：版本库 + 可选的部署事实 + 写成功后的两个钩子。 */
export interface PromptHandlerOptions {
  readonly versions: PromptVersions
  readonly deployment?: PromptDeployment
  /**
   * 保存产生了新版本后的通知（§F.4）：组合根接到 Router 保活器的 `notifyPromptRevision`，
   * 它把 revision 换成一条短消息排队，**不重启**会话。
   */
  readonly onSaved?: (revision: number) => void
  /** 写成功后的刷新钩子（面板 `state.changed`）。 */
  readonly afterWrite?: () => void
}

/** 一个非负整数 body 字段。 */
function requiredInteger(body: Record<string, unknown>, field: string): number {
  const value = body[field]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ApiError(ERROR_CODES.invalidParams, `${field} must be a non-negative integer`, { field })
  }
  return value
}

/** 查询串里的非负整数（缺省 `undefined`；给了但不是整数 → `invalid_value`）。 */
function queryInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ApiError(ERROR_CODES.invalidValue, `${name} must be a non-negative integer`, { field: name })
  }
  return parsed
}

/** 查询串里的开关（`?defaults`、`?text`、`?text=1`、`?text=true` 都算开）。 */
function queryFlag(value: string | undefined): boolean {
  return value !== undefined && (value === '' || value === '1' || value === 'true')
}

/** 一个固定拒绝（`PromptTextError` / `PromptVersionError`）换成带状态码的 `ApiError`。 */
function apiErrorOf(error: unknown): never {
  if (error instanceof PromptTextError || error instanceof PromptVersionError) {
    throw new ApiError(error.code, error.message, error.values)
  }
  throw error
}

/** 一个分片当前的正文（模板未填值；生成段的正文就是模板）。 */
function builtInText(key: (typeof PROMPT_PART_KEYS)[number]): string {
  return PROMPT_PARTS[key].lines.join('\n')
}

/** 内置分片的读面：正文 + 角色 + 必保留占位符 + 它当前正文的键。 */
function partViews(): readonly PromptPartView[] {
  const bases = builtInBases()
  return PROMPT_PART_KEYS.map((key) => ({
    key,
    roles: [...PROMPT_PARTS[key].roles],
    text: builtInText(key),
    placeholders: [...PROMPT_PARTS[key].placeholders],
    base: bases[key]
  }))
}

/** 一条 `default-updated` 的读面：旧默认与新默认都在这里（移除的分片新默认为 `null`）。 */
function changeView(change: PromptDefaultChange): PromptDefaultChangeView {
  const removed = change.removed === true
  return {
    part: change.part,
    base: change.base ?? null,
    previous: change.previous ?? null,
    next: removed || !isPromptPartKey(change.part) ? null : builtInText(change.part),
    removed
  }
}

/** 一个版本的摘要（`history` 与 `saved` 共用）。 */
function summaryOf(version: PromptVersion): PromptVersionSummary {
  return {
    revision: version.revision,
    predecessor: version.predecessor,
    at: version.at,
    origin: version.origin
  }
}

/** 一次保存/恢复的读数。 */
function saveView(result: PromptSaveResult): PromptSaveView {
  return {
    ...summaryOf(result),
    changed: result.changed,
    dropped: [...result.dropped]
  }
}

/**
 * 组装两个角色的全文：生成段的值来自注入的部署事实（`{variables}` 这类占位符只由部署填）。
 * 没有部署事实时固定 `unavailable`——「不知道」不能假装成一份可读的全文。
 */
function textsOf(
  deployment: PromptDeployment | undefined,
  config: PromptConfig,
  caller: RouteCaller,
  maxChars: number
): PromptTextResult['texts'] {
  if (deployment === undefined) {
    throw new ApiError(ERROR_CODES.unavailable, 'the deployment facts for the composed text are not wired', {
      reason: 'no_deployment'
    })
  }
  const policy = deployment.policy()
  return {
    orchestrator: composePrompt({
      role: 'orchestrator',
      environment: deployment.environment({ role: 'orchestrator', caller }),
      policy,
      maxChars,
      ...promptTextOf(config)
    }),
    worker: composePrompt({
      role: 'worker',
      environment: deployment.environment({ role: 'worker', caller }),
      maxChars,
      ...promptTextOf(config)
    })
  }
}

/** 把 handler 的表装进路由表（与 `withDomainHandlers` 同一模式）。 */
export function withPromptHandlers(
  routes: readonly RouteDefinition[],
  handlers: ReadonlyMap<string, RouteHandler>
): readonly RouteDefinition[] {
  return routes.map((route) => {
    const handler = handlers.get(`${route.method} ${route.path}`)
    return handler === undefined ? route : { ...route, handler }
  })
}

/** 组装三条 prompts 路由的 handler。 */
export function createPromptHandlers(options: PromptHandlerOptions): ReadonlyMap<string, RouteHandler> {
  const { versions } = options
  const handlers = new Map<string, RouteHandler>()

  /**
   * 拼两个角色的全文；拼超限（§L.6 的 `too_long`）与部署事实缺失一样是**固定拒绝**，不是
   * 内部错误——所以在这里换成带状态码的 `ApiError`，而不是让 `PromptTextError` 掉进 500。
   */
  const textsFor = (config: PromptConfig, caller: RouteCaller): PromptTextResult['texts'] => {
    try {
      return textsOf(options.deployment, config, caller, versions.maxChars())
    } catch (error) {
      apiErrorOf(error)
    }
  }

  /** 写成功之后：通知 Router（只有真的产生新版本才通知）+ 面板刷新。 */
  const saved = (view: PromptSaveView): PromptSaveView => {
    if (view.changed) options.onSaved?.(view.revision)
    options.afterWrite?.()
    return view
  }

  // ---- GET prompts：配置 / 内置分片 / default-updated / 历史；`--text` 给组装后的全文。
  handlers.set('GET prompts', ({ query, caller }) => {
    const requested = queryInteger(query['revision'], 'revision')
    const offset = queryInteger(query['offset'], 'offset') ?? 0
    const defaults = queryFlag(query['defaults'])
    const version = requested === undefined || requested === 0 ? undefined : versions.version(requested)
    if (requested !== undefined && requested !== 0 && version === undefined) {
      throw new ApiError(ERROR_CODES.missing, `no prompt version ${requested}`, { revision: String(requested) })
    }
    const shown = defaults ? undefined : (version ?? (requested === 0 ? undefined : versions.current()))
    const config = shown?.config ?? {}
    if (queryFlag(query['text'])) {
      // 全文读的是「这个请求选中的配置」：`--defaults` 读默认，`--revision N` 读那一版，否则当前。
      const result: PromptTextResult = {
        revision: shown?.revision ?? 0,
        texts: textsFor(config, caller)
      }
      return result
    }
    // `default_changed` 说的是覆盖过的分片：读某一版就按那一版算，读默认时按当前版本算。
    const reference = requested === undefined || requested === 0 ? versions.config() : config
    const changes = versions.defaultChanged(reference).map(changeView)
    const page = versions.history({ limit: PROMPT_HISTORY_PAGE + 1, offset })
    const history = page.slice(0, PROMPT_HISTORY_PAGE).map(summaryOf)
    const result: PromptConfigResult = {
      revision: shown?.revision ?? 0,
      saved: shown === undefined ? null : summaryOf(shown),
      config,
      sections: [...TEAM_SECTIONS],
      parts: partViews(),
      default_changed: changes.filter((change) => !change.removed).map((change) => change.part),
      removed_parts: changes.filter((change) => change.removed).map((change) => change.part),
      changes,
      history,
      next_offset: page.length > PROMPT_HISTORY_PAGE ? offset + PROMPT_HISTORY_PAGE : null
    }
    return result
  })

  // ---- PUT prompts：保存（`{config, baseRevision}`）、恢复某版（`{restore, baseRevision}`）、
  //      恢复默认（`{defaults: true, baseRevision}`）。三者都是「再存一个新版本」。
  handlers.set('PUT prompts', ({ body }) => {
    const request = bodyObject(body)
    const baseRevision = requiredInteger(request, 'baseRevision')
    const origin = request['origin'] === undefined ? 'panel' : request['origin']
    if (origin !== 'panel' && origin !== 'tool') {
      throw new ApiError(ERROR_CODES.invalidParams, 'origin must be panel or tool', { field: 'origin' })
    }
    try {
      if (request['restore'] !== undefined) {
        return saved(saveView(versions.restore({ revision: requiredInteger(request, 'restore'), baseRevision, origin })))
      }
      if (request['defaults'] === true) {
        return saved(saveView(versions.restore({ revision: 0, baseRevision, origin })))
      }
      if (request['config'] === undefined) {
        throw new ApiError(ERROR_CODES.invalidParams, 'a save needs config, restore or defaults', {
          field: 'config'
        })
      }
      return saved(saveView(versions.save({ config: request['config'], baseRevision, origin })))
    } catch (error) {
      apiErrorOf(error)
    }
  })

  // ---- POST prompts/preview：与保存同一份校验，只返回拼好的全文（不写库）。
  handlers.set('POST prompts/preview', ({ body, caller }) => {
    // 面板直接 POST 配置；CLI 为了与 `PUT prompts` 同形而包一层 `{config}`。两种都认。
    const request = bodyObject(body)
    const raw = request['config'] === undefined ? request : request['config']
    let validated: { readonly config: PromptConfig; readonly dropped: readonly string[] }
    try {
      // 预览与保存是同一份校验（含 §L.6 的体量上限），只是不写库。
      validated = validatePromptConfig(raw, versions.config(), { maxChars: versions.maxChars() })
    } catch (error) {
      apiErrorOf(error)
    }
    const result: PromptPreviewResult = {
      revision: versions.revision(),
      dropped: [...validated.dropped],
      config: validated.config as PromptConfigView,
      texts: textsFor(validated.config, caller)
    }
    return result
  })

  return handlers
}

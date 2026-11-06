// 运行缝里的类型再导出面：让 `src/worker/main.ts` 等模块能拿到宿主类型，而
// `from 'orca/worker'` 的字面量只出现在 `src/worker/runtime/`（§B.1 的纪律）。
// 纯类型再导出，不含实现，也不被运行缝接口（orca-runtime.ts）依赖。
export type {
  AgentStatusChangedPayload,
  CapabilityKind,
  CommandContext,
  CommandHandler,
  CommandsApi,
  EventsApi,
  HookHandler,
  HookName,
  HooksApi,
  OrcaWorkerApi,
  PanelRequestHandler,
  PanelsApi,
  WorkerEventName,
  WorkerEvents,
  WorkspaceCreatedPayload,
  WorkspaceRemovedPayload
} from 'orca/worker'

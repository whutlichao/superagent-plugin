// 领域内核的唯一出口（§C.1 `core/*`）：模型、端口、引擎与内存仓储。
// 外部只从这里 import，不深入具体文件——中文档写的是「core 目录」而不是文件清单。
export * from './model.ts'
export * from './ports.ts'
export * from './reasons.ts'
export * from './errors.ts'
export * from './stage.ts'
export { key } from './ids.ts'
export { Engine, type AssignmentLaunch, type EngineForExecutor, type EngineForMainSession, type EngineForPeople,
  type EngineForSettings, type EngineForSources, type Outcome, type Reply, type ReplyRequest,
  type WorkerReport } from './engine.ts'
export { MemoryRepositories, WriterError, type MemoryReadView } from './memory.ts'

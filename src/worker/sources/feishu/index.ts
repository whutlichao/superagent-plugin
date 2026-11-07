// Feishu 读取面（§I.3 的事件流 / 历史回填 / 话题轮询 / Trigger 翻译）的出口：组合根只认这个
// 文件，不深入 feishu 目录（与 `github/index.ts` 同一纪律）。
export { FEISHU_KIND, createFeishuKind, feishuKind } from './kind.ts'
export { feishuConfigSchema } from './config.ts'
export type { FeishuChatConfig, FeishuConfig, FeishuListen } from './config.ts'
export { createFeishuApi, DEFAULT_PAGE_SIZE } from './api.ts'
export {
  IDEMPOTENCY_KEY_MAX,
  WITHDRAWN_CODE,
  feishuGone,
  feishuIdempotencyKey,
  feishuLink,
  sendFeishu
} from './channel.ts'
export { membersOf, runFeishuSync } from './sync.ts'
export type { FeishuMember } from './sync.ts'
export { admissionImageKeys, downloadFeishuImage, feishuImageRef } from './image.ts'
export type { FeishuImageRef, FeishuImageRequest } from './image.ts'
export {
  AROUND_OLDER_PAGE,
  AROUND_SIDE,
  FEISHU_READ_PAGE_SIZE,
  feishuFind,
  feishuRead,
  feishuReadStatus,
  feishuThreadContext
} from './read.ts'
export type {
  FeishuContextOptions,
  FeishuMany,
  FeishuOne,
  FeishuReadRequest,
  FeishuReadResult,
  FeishuReadSection,
  FeishuReadStatus
} from './read.ts'
export type { FeishuApi, FeishuChat, FeishuChatQuery, FeishuPage, FeishuThreadQuery } from './api.ts'
export {
  CONSUMER_ARGS,
  FEISHU_HEALTH,
  MAX_EVENT_BYTES,
  MAX_RESTART_MS,
  MIN_RESTART_MS,
  READY_MARKER,
  READY_TIMEOUT_MS,
  WATCHDOG_MS,
  consumerRetry,
  createFeishuStream
} from './stream.ts'
export type { FeishuStream, FeishuStreamHost, FeishuStreamKeys, FeishuStreamOptions, Schedule } from './stream.ts'
export {
  CURSOR_OVERLAP_MS,
  HISTORY_HEALTH,
  POLL_HORIZON_MS,
  SEEN_LIMIT,
  createFeishuBackfill,
  refreshChatNames,
  withinHorizon
} from './poll.ts'
export type {
  FeishuBackfill,
  FeishuBackfillOptions,
  FeishuKeys,
  FeishuPollHost,
  FeishuRoundResult,
  FeishuTopic,
  HorizonInput,
  SubscribedThread
} from './poll.ts'
export {
  FEISHU_SOURCE,
  feishuChannel,
  feishuEventOf,
  feishuHistoryOf,
  feishuThreadId,
  feishuTime,
  feishuTrigger,
  feishuTriggerId,
  withMentionNames
} from './translate.ts'
export type { FeishuBot, FeishuMessage, FeishuMention } from './translate.ts'

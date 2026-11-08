// GitHub 最小切片（§I.2「通知轮询 + Issue 评论读取」）的出口：kind、轮询器与读取端口的
// 一处 import。组合根只认这个文件，不深入 github 目录。
export {
  createGithubKind,
  githubGone,
  githubKind,
  idMarker,
  GONE_RULES,
  GITHUB_KIND,
  GITHUB_HEALTH_STARTING
} from './kind.ts'
export type { GithubAddress, GithubHost } from './kind.ts'
export { createGithubPoller, subscribedThreads, withinHorizon, CURSOR_OVERLAP_MS, FAILURES_BEFORE_ERROR, POLL_HORIZON_MS } from './poll.ts'
export type {
  GithubPollResult,
  GithubPoller,
  GithubPollHost,
  GithubPullHead,
  GithubSubscribedThread
} from './poll.ts'
export { createGithubApi, issueNumberOf, rateLimited } from './api.ts'
export type {
  GithubApi,
  GithubBranchHead,
  GithubChecks,
  GithubCheckRun,
  GithubComment,
  GithubCommitStatus,
  GithubIssue,
  GithubNotification,
  GithubPull,
  GithubRead,
  GithubRepository,
  GithubReview,
  GithubStreamComment
} from './api.ts'
export { githubConfigSchema, githubSetupProblem, repositorySlug, type GithubConfig } from './config.ts'
// PR 规则与结束通知（§I.2「PR 规则」「结束通知」两行、§I.5）：组合根接「读一条 PR 再绑」与
// 「轮询对账」，规则本身在 `pull.ts` 里。
export {
  agentPull,
  claimPull,
  claimReportedPull,
  observePull,
  pullEndNotices,
  pullThread,
  ticketBranch
} from './pull.ts'
export type { GithubPullHost } from './pull.ts'
export {
  bodyFingerprint,
  branchCiFingerprint,
  branchCiSummary,
  branchCiTrigger,
  ciFailures,
  ciFingerprint,
  ciState,
  ciSummary,
  ciTrigger,
  commentTrigger,
  commentTriggerId,
  githubBranchThread,
  githubCommentChannel,
  githubReviewThread,
  githubThread,
  isSelf,
  issueBodyTrigger,
  mentionsAgent,
  reviewCommentTrigger,
  reviewText,
  reviewTrigger
} from './translate.ts'
export type { CiState, GithubBodySource } from './translate.ts'
export {
  GITHUB_READ_PAGE_SIZE,
  githubFind,
  githubMessageId,
  githubRead,
  githubReadStatus,
  githubThreadContext,
  reviewThreadOf
} from './read.ts'
export type {
  GithubContextPage,
  GithubDescription,
  GithubReadRequest,
  GithubReadStatus,
  GithubResourceRead
} from './read.ts'

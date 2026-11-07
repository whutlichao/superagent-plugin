// GitHub 最小切片（§I.2「通知轮询 + Issue 评论读取」）的出口：kind、轮询器与读取端口的
// 一处 import。组合根只认这个文件，不深入 github 目录。
export { createGithubKind, githubKind, idMarker, GONE_RULES, GITHUB_KIND, GITHUB_HEALTH_STARTING } from './kind.ts'
export type { GithubAddress, GithubHost } from './kind.ts'
export { createGithubPoller, FAILURES_BEFORE_ERROR } from './poll.ts'
export type { GithubPollResult, GithubPoller, GithubPollHost } from './poll.ts'
export { createGithubApi, issueNumberOf } from './api.ts'
export type { GithubApi, GithubComment, GithubNotification } from './api.ts'
export { githubConfigSchema, type GithubConfig } from './config.ts'
export {
  commentTrigger,
  commentTriggerId,
  githubCommentChannel,
  githubThread,
  isSelf,
  mentionsAgent
} from './translate.ts'

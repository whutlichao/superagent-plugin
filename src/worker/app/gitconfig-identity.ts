// 提交身份这一条 setup 结论的**共享文案**（§H.11、§N.2、§K.8）。
//
// 为什么单独一个模块：probe 用的结论（`app/setup.ts`，会写 `<stateDir>/worker-gitconfig`）
// 与组合根「保存之后现算」的结论（`boot.ts`，只读）必须说同一句话；把这段文案写在任一
// 调用方里，另一个就只能抄一份。两份文案一漂移，面板对不同路径的同一件事给出不同的修法。
//
// 依赖纪律（§C.2）：本文件只 import `setup-types.ts` 的类型与常量；不读存储、不跑子进程。
import type { SetupIssue } from './setup-types.ts'
import { SETUP_CHECK_AGAIN } from './setup-types.ts'

/**
 * 提交身份里的邮箱是否「像一个 email」：空串是「还没配」（合法），其余必须是一个地址。
 * 只做形状判断（`a@b`）；到底是不是 agent 账号的 noreply，文案里说清、由人负责（§O）。
 */
export function commitEmailShape(value: string): 'ok' | 'empty' | 'invalid' {
  const text = value.trim()
  if (text === '') return 'empty'
  return /^[^\s@]+@[^\s@]+$/.test(text) ? 'ok' : 'invalid'
}

/**
 * 提交身份不全（或邮箱形状不对）时的那一条结论：修法按**缺哪一项**说——邮箱是面板上的一格
 * （Settings → Execution → `executor.githubCommitEmail`），账号来自 `gh api user` 探针。
 * 身份齐了就是 `undefined`。
 */
export function commitIdentityIssue(email: string, account: string): SetupIssue | undefined {
  const shape = commitEmailShape(email)
  if (shape === 'ok' && account.trim() !== '') return undefined
  return {
    place: 'executor',
    code: 'gitconfig_missing',
    kind: 'missing',
    detail:
      shape === 'invalid'
        ? 'the worker git config has no valid commit identity yet: the agent noreply commit email is not an address'
        : shape === 'empty'
          ? 'the worker git config has no commit identity yet: the agent noreply commit email is empty'
          : 'the worker git config has no commit identity yet: the agent account is unknown',
    fix:
      shape === 'ok'
        ? 'make the agent GitHub CLI readable (gh api user), then run the check again'
        : 'set the agent noreply commit email (Settings → Execution → githubCommitEmail), then run the check again',
    checkAgain: SETUP_CHECK_AGAIN
  }
}

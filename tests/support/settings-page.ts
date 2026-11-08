// Settings 页框架的最小读数：Prompts 组（#43）挂在 #42 的五组框架里，测试只要框架读得通。
//
// 只给「什么都不用改」的空值：Sources 没有实例、Policy 没有规则、Execution 与 limits 是缺省
// 值。需要断言某一组内容的测试（`tests/panel-settings.test.tsx`）自己写更完整的读数，这一份
// 只回答「框架起来了、Prompts 的那一格能画出来」。
import type { SettingsPageView } from '../../src/panel/protocol'

/** 一份空的设置读数（四个可编辑组都没有改动）。 */
export function emptySettingsPage(): SettingsPageView {
  return {
    revision: 1,
    sources: { instances: [] },
    eval: {
      block: 'policy',
      revision: 0,
      saved: null,
      policyVersion: 'empty',
      acceptMode: 'observe',
      model: '',
      timeoutSeconds: 300,
      rules: [],
      sources: []
    },
    execution: {
      block: 'executor',
      revision: 0,
      saved: null,
      value: {
        agent: 'pi',
        model: '',
        effort: '',
        maxWorkers: 2,
        baseRepo: '',
        baseBranch: 'main',
        branchPrefix: 'agent/',
        prepare: '',
        blockedCommands: [],
        inlineLimit: 1000,
        worktreeRetention: 'keep',
        confirmDelivery: true,
        githubCommitEmail: ''
      },
      repos: [],
      variables: ['DSH_SUPERAGENT_DIR']
    },
    limits: {
      block: 'limits',
      revision: 0,
      saved: null,
      value: {
        promptMaxChars: 200_000,
        admissionContextMaxPages: 10,
        admissionContextTimeoutMs: 15_000,
        retentionDays: 90
      }
    }
  }
}

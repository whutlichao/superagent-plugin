// 运行时默认 agent（#51，产品决定 2026-11）：清单与代码都必须是 `pi`。
//
// 两个真相各自决定一件事，必须同时守住：
// - 清单的 `default` 是用户在 Orca Settings 里看到的初值；
// - 代码的回落值决定设置缺失或被清空时实际启动哪个 agent。
// 只改一边就会出现「界面写 pi、实际启动另一个 agent」的静默分裂，所以一条测试同时断言两者。
import { assert, test } from 'orca/testing'
import { AGENT_SETTING_DEFAULTS, resolveAgentSetting } from '../src/worker/app/agent-defaults'
import { readRepoJson } from './support/repo'

interface ManifestSetting {
  readonly key: string
  readonly default?: string
}

const manifest = readRepoJson<{
  contributes: { settings: readonly ManifestSetting[] }
}>('orca-plugin.json')

/** 清单里某项设置的 `default`；缺设置项或缺默认值直接失败，避免「找不到就算过」。 */
function manifestDefault(key: string): string {
  const setting = manifest.contributes.settings.find((entry) => entry.key === key)
  assert.ok(setting !== undefined, `the manifest declares the ${key} setting`)
  assert.ok(setting.default !== undefined, `the ${key} setting declares a default`)
  return setting.default
}

test('both agent settings default to pi: the manifest value and the code fallback', () => {
  assert.equal(manifestDefault('agent'), 'pi')
  assert.equal(manifestDefault('routerAgent'), 'pi')
  assert.equal(resolveAgentSetting({}, 'agent'), 'pi')
  assert.equal(resolveAgentSetting({}, 'routerAgent'), 'pi')
})

test('the code default table stays the value the manifest declares', () => {
  assert.deepEqual(
    { ...AGENT_SETTING_DEFAULTS },
    { agent: manifestDefault('agent'), routerAgent: manifestDefault('routerAgent') }
  )
})

test('a configured agent wins; a missing, blank or non-string one falls back to the default', () => {
  assert.equal(resolveAgentSetting({ agent: 'codex' }, 'agent'), 'codex')
  assert.equal(resolveAgentSetting({ routerAgent: 'codex' }, 'routerAgent'), 'codex')
  assert.equal(resolveAgentSetting({ agent: ' pi ' }, 'agent'), 'pi', 'surrounding space is trimmed')
  assert.equal(resolveAgentSetting({ agent: '' }, 'agent'), 'pi')
  assert.equal(resolveAgentSetting({ agent: '   ' }, 'agent'), 'pi')
  assert.equal(resolveAgentSetting({ agent: 7 }, 'agent'), 'pi')
  assert.equal(resolveAgentSetting({ agent: null }, 'agent'), 'pi')
})

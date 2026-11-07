// 两个角色的模型解析（#16，§N.2、§H.4）：Router 与 worker 各自从自己的设置块拿
// model/effort，agent 走清单里的两个键（`routerAgent` / `agent`，缺省 `pi`）；
// `models` 健康项恒为 ready、明细写「handled by Orca」——模型预算重试由 Orca 负责，
// 插件不假装有第二套模型目录（§H.4、§H.16）。
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveRoles } from '../src/worker/app/roles'
import { HealthBoard, claimModelsEntry, MODELS_HEALTH_DETAIL } from '../src/worker/infra/health'

describe('the two roles resolve their own model settings', () => {
  test('router and worker take agent/model/effort from their own blocks', () => {
    const roles = resolveRoles({
      agent: 'codex',
      routerAgent: 'claude',
      executor: { model: 'gpt-5', effort: 'high' },
      router: { model: 'o3', effort: 'low' }
    })
    // 设计 §F.1：`agent = settings.router.agent`、`model = settings.router.model`；
    // worker 的对应项是 `executor.model` / `executor.effort`（§E.2）。
    assert.deepEqual(roles.router, { agent: 'claude', model: 'o3', effort: 'low' })
    assert.deepEqual(roles.worker, { agent: 'codex', model: 'gpt-5', effort: 'high' })
  })

  test('missing settings fall back to pi and send no model or effort at all', () => {
    const roles = resolveRoles({})
    assert.deepEqual(roles.router, { agent: 'pi' })
    assert.deepEqual(roles.worker, { agent: 'pi' })
    // 「没有」不是「空串」：launch 收到空串会把一个不存在的模型交给 Orca。
    assert.equal('model' in roles.router, false)
    assert.equal('effort' in roles.worker, false)
  })

  test('blank or non-string settings count as absent', () => {
    const roles = resolveRoles({
      agent: '   ',
      routerAgent: 42,
      executor: { model: '  ', effort: null },
      router: { model: '', effort: 7 }
    })
    assert.deepEqual(roles.router, { agent: 'pi' })
    assert.deepEqual(roles.worker, { agent: 'pi' })
  })

  test('the design key router.agent is honored when the manifest key is absent', () => {
    // §F.1 写的是 `settings.router.agent`；清单里那一项今天叫 `routerAgent`（§N.2）。
    assert.deepEqual(resolveRoles({ router: { agent: 'claude', model: 'o3' } }).router, {
      agent: 'claude',
      model: 'o3'
    })
    // 两个都配了：清单里的 `routerAgent` 赢（它才是用户在 Orca Settings 里看到的那一项）。
    assert.equal(resolveRoles({ routerAgent: 'codex', router: { agent: 'claude' } }).router.agent, 'codex')
  })

  test('the worker role agrees with the executor settings it launches with', () => {
    // 两个解析器读同一组设置块；它们分叉会让「面板写着 gpt-5、worker 起了别的模型」。
    const raw = { agent: 'pi', executor: { model: 'gpt-5', effort: 'medium', maxWorkers: 3 } }
    assert.deepEqual(resolveRoles(raw).worker, { agent: 'pi', model: 'gpt-5', effort: 'medium' })
  })
})

describe('the models health entry', () => {
  test('is always ready and says the models are handled by Orca', () => {
    const board = new HealthBoard()
    claimModelsEntry(board)
    assert.deepEqual(board.all()['models'], { state: 'ready', detail: MODELS_HEALTH_DETAIL })
    assert.equal(MODELS_HEALTH_DETAIL, 'handled by Orca')
    // 没有失败路径：再读一次仍是同一句（它是空实现，不是「还没有报告」）。
    assert.deepEqual(board.all()['models'], { state: 'ready', detail: 'handled by Orca' })
  })
})

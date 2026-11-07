// 运行缝错误类型：宿主的全部错误码 + seam 的 7 个，以及可重试集合与填槽值（§B.2）。
// 计数说明（coordinator 裁决 2026-11-07）：§B.2 的注释写「宿主 12 个」，但它逐个列出的
// 宿主错误码是 13 个，与 references/host-api.md §Errors 的权威清单一致；「12」是文档笔误，
// 本实现以枚举与 reference 为准，合计 13 + 7 = 20。
import { assert, test } from 'orca/testing'
import {
  isOrcaRuntimeError,
  OrcaRuntimeError,
  RETRYABLE_CODES,
  type RuntimeErrorCode
} from '../src/worker/runtime/orca-runtime'

const HOST_CODES: readonly RuntimeErrorCode[] = [
  'invalid_request',
  'invalid_params',
  'unknown_method',
  'capability_denied',
  'consent_required',
  'not_permitted',
  'rate_limited',
  'unavailable',
  'action_failed',
  'cancelled',
  'timeout',
  'conflict',
  'too_large'
]

const SEAM_CODES: readonly RuntimeErrorCode[] = [
  'cli_missing',
  'cli_failed',
  'cli_timeout',
  'workspace_missing',
  'agent_gone',
  'state_dir_unwritable',
  'locked'
]

test('carries every host error code and the seven seam codes', () => {
  assert.equal(HOST_CODES.length, 13, 'references/host-api.md lists 13 host error codes')
  assert.equal(SEAM_CODES.length, 7)
  for (const code of [...HOST_CODES, ...SEAM_CODES]) {
    const error = new OrcaRuntimeError(code, 'boom')
    assert.equal(error.code, code)
    assert.ok(error instanceof Error)
    assert.equal(error.name, 'OrcaRuntimeError')
  }
})

test('marks exactly the six retryable codes as retryable', () => {
  assert.deepEqual([...RETRYABLE_CODES].sort(), [
    'action_failed',
    'cli_failed',
    'cli_timeout',
    'rate_limited',
    'timeout',
    'unavailable'
  ])
  for (const code of [...HOST_CODES, ...SEAM_CODES]) {
    assert.equal(
      new OrcaRuntimeError(code, 'boom').retryable,
      RETRYABLE_CODES.includes(code),
      `${code} retryable`
    )
  }
})

test('keeps retryAfterMs only on rate_limited and template values when given', () => {
  const limited = new OrcaRuntimeError('rate_limited', 'slow down', { retryAfterMs: 1500 })
  assert.equal(limited.retryAfterMs, 1500)
  const denied = new OrcaRuntimeError('capability_denied', 'no', {
    values: { capability: 'agent:launch' }
  })
  assert.deepEqual(denied.values, { capability: 'agent:launch' })
  assert.equal(denied.retryAfterMs, undefined)
  assert.equal(new OrcaRuntimeError('cli_failed', 'x').values, undefined)
})

test('preserves the underlying cause for CLI failures', () => {
  const cause = new Error('spawn orca ENOENT')
  const error = new OrcaRuntimeError('cli_missing', 'orca CLI not found', { cause })
  assert.equal(error.cause, cause)
})

test('the type guard accepts seam errors and rejects look-alikes', () => {
  assert.equal(isOrcaRuntimeError(new OrcaRuntimeError('locked', 'busy')), true)
  const lookAlike = Object.assign(new Error('busy'), { code: 'locked' })
  assert.equal(isOrcaRuntimeError(lookAlike), false)
  assert.equal(isOrcaRuntimeError('locked'), false)
})

// 最小校验器（§O 补充段）：零 npm 依赖的前提下，给 Source kind 的配置、Policy 部分与
// 设置块提供与 zod 等价的最小能力——`strict()`、`safeParse`、可定位的错误路径。
//
// 只测本仓库真正用到的形状（object/string/number/boolean/array/enum/union/record +
// default/optional/refine/transform）；后续票要用新形状时在这里先加一条断言。
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  array,
  boolean,
  enumOf,
  literal,
  number,
  object,
  record,
  refine,
  string,
  transform,
  union,
  SchemaError
} from '../src/worker/infra/schema.ts'

/** 把校验结果收敛成「成功值」或「失败路径」，断言只关心这两件事。 */
function outcome(
  result:
    | { readonly success: true; readonly data: unknown }
    | { readonly success: false; readonly issues: readonly { readonly path: readonly (string | number)[]; readonly message: string }[] }
): unknown {
  return result.success
    ? { ok: result.data }
    : { issues: result.issues.map((issue) => ({ path: issue.path, message: issue.message })) }
}

describe('object schemas', () => {
  test('fill defaults, strip unknown keys, and reject wrong types with a field path', () => {
    const schema = object({
      repository: string().default(''),
      pollSeconds: number().int().min(60).max(3600).default(60)
    })
    assert.deepEqual(schema.parse({}), { repository: '', pollSeconds: 60 })
    // 非 strict 时未知键被丢掉（与 zod 的默认一致），已声明的字段照常校验。
    assert.deepEqual(schema.parse({ repository: 'a/b', extra: 1 }), { repository: 'a/b', pollSeconds: 60 })
    assert.deepEqual(outcome(schema.safeParse({ pollSeconds: 'soon' })), {
      issues: [{ path: ['pollSeconds'], message: 'expected number' }]
    })
    assert.deepEqual(outcome(schema.safeParse({ pollSeconds: 10 })), {
      issues: [{ path: ['pollSeconds'], message: 'expected at least 60' }]
    })
  })

  test('strict objects refuse unknown keys and name them', () => {
    const schema = object({ name: string() }).strict()
    assert.deepEqual(schema.parse({ name: 'ok' }), { name: 'ok' })
    assert.deepEqual(outcome(schema.safeParse({ name: 'ok', surprise: true })), {
      issues: [{ path: ['surprise'], message: 'unknown key' }]
    })
  })

  test('nested objects carry the full path and partial() makes every key optional', () => {
    const schema = object({
      github: object({ cli: string(), repository: string() }).default({ cli: '', repository: '' }),
      chats: array(object({ id: string(), listen: enumOf(['mentions', 'all']) })).default([])
    }).strict()
    assert.deepEqual(outcome(schema.safeParse({ github: { cli: 1, repository: 'a/b' } })), {
      issues: [{ path: ['github', 'cli'], message: 'expected string' }]
    })
    assert.deepEqual(outcome(schema.safeParse({ chats: [{ id: 'oc_1', listen: 'none' }] })), {
      issues: [{ path: ['chats', 0, 'listen'], message: 'expected one of mentions, all' }]
    })
    assert.deepEqual(schema.parse({}), { github: { cli: '', repository: '' }, chats: [] })

    const partial = object({ a: string(), b: number() }).partial()
    assert.deepEqual(partial.parse({}), {})
    assert.deepEqual(partial.parse({ b: 2 }), { b: 2 })
  })
})

describe('scalar schemas', () => {
  test('strings trim, check length and pattern, and refuse non-strings', () => {
    const slug = string().trim().min(1).max(8).regex(/^[a-z]+$/)
    assert.equal(slug.parse('  widget '), 'widget')
    assert.deepEqual(outcome(slug.safeParse('')), { issues: [{ path: [], message: 'expected at least 1 characters' }] })
    assert.deepEqual(outcome(slug.safeParse('Widget')), { issues: [{ path: [], message: 'does not match /^[a-z]+$/' }] })
    assert.deepEqual(outcome(slug.safeParse(7)), { issues: [{ path: [], message: 'expected string' }] })
  })

  test('numbers enforce integer and both bounds; booleans only admit true and false', () => {
    assert.deepEqual(outcome(number().int().safeParse(1.5)), { issues: [{ path: [], message: 'expected integer' }] })
    assert.deepEqual(outcome(number().max(3).safeParse(4)), { issues: [{ path: [], message: 'expected at most 3' }] })
    // 数字不做字符串转换：设置来自 JSON，类型错了就是错了。
    assert.deepEqual(outcome(number().safeParse('4')), { issues: [{ path: [], message: 'expected number' }] })
    assert.deepEqual(outcome(boolean().safeParse('true')), { issues: [{ path: [], message: 'expected boolean' }] })
    assert.equal(boolean().parse(false), false)
  })

  test('enumOf and literal admit exactly their values', () => {
    assert.equal(enumOf(['a', 'b']).parse('b'), 'b')
    assert.deepEqual(outcome(enumOf(['a', 'b']).safeParse('c')), {
      issues: [{ path: [], message: 'expected one of a, b' }]
    })
    assert.equal(literal('feishu').parse('feishu'), 'feishu')
    assert.deepEqual(outcome(literal('feishu').safeParse('lark')), {
      issues: [{ path: [], message: 'expected feishu' }]
    })
  })
})

describe('collections and combinators', () => {
  test('arrays report the element index; records report the key', () => {
    assert.deepEqual(array(number()).parse([1, 2]), [1, 2])
    assert.deepEqual(outcome(array(number()).safeParse([1, 'two'])), {
      issues: [{ path: [1], message: 'expected number' }]
    })
    assert.deepEqual(record(string()).parse({ a: 'x' }), { a: 'x' })
    assert.deepEqual(outcome(record(string()).safeParse({ a: 1 })), {
      issues: [{ path: ['a'], message: 'expected string' }]
    })
  })

  test('unions try each member in order and report every path when none fits', () => {
    const schema = union([string(), number()])
    assert.equal(schema.parse('x'), 'x')
    assert.equal(schema.parse(2), 2)
    assert.deepEqual(outcome(schema.safeParse(true)), {
      issues: [
        { path: [], message: 'expected string' },
        { path: [], message: 'expected number' }
      ]
    })
  })

  test('optional admits undefined, default fills it, and refine narrows with its own message', () => {
    const schema = object({
      note: string().optional(),
      retries: number().default(3),
      ratio: refine(number(), (value) => value > 0 && value <= 1, 'expected a ratio').optional()
    })
    assert.deepEqual(schema.parse({}), { retries: 3 })
    assert.deepEqual(schema.parse({ note: 'x', retries: 1, ratio: 0.5 }), {
      note: 'x',
      retries: 1,
      ratio: 0.5
    })
    assert.deepEqual(outcome(schema.safeParse({ ratio: 2 })), {
      issues: [{ path: ['ratio'], message: 'expected a ratio' }]
    })
  })
})

describe('transforms', () => {
  test('transform maps only a valid value and passes the original issues through', () => {
    const slug = transform(
      refine(string().trim().max(20), (value) => value === '' || value.includes('/'), 'expected owner/name'),
      (value) => value.toLowerCase()
    )
    assert.equal(slug.parse(' Acme/Widgets '), 'acme/widgets')
    // 校验失败时映射不执行（值保持未规范化的原样）：issue 的路径与文案逐字透出。
    assert.deepEqual(outcome(slug.safeParse('  nope  ')), {
      issues: [{ path: [], message: 'expected owner/name' }]
    })
    assert.deepEqual(outcome(slug.safeParse(7)), { issues: [{ path: [], message: 'expected string' }] })
    // 与 default 组合时默认值也走映射：设置缺席不会绕过规范化。
    const withDefault = transform(string(), (value) => value.toUpperCase()).default('fallback')
    assert.equal(withDefault.parse(undefined), 'FALLBACK')
  })
})

describe('parse errors', () => {
  test('parse throws a SchemaError that carries every issue', () => {
    const schema = object({ a: string(), b: number() }).strict()
    assert.throws(
      () => schema.parse({ a: 1, b: 'x' }),
      (error: unknown) =>
        error instanceof SchemaError &&
        error.issues.length === 2 &&
        error.issues[0]?.path[0] === 'a' &&
        error.message.includes('a')
    )
  })
})

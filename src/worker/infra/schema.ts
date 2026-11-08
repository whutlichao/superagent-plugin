// 最小校验器（§O 补充段）：插件不允许提交 `node_modules`、也没有打包步骤，所以 zod 的
// 等价能力在这里以源码实现——`strict()`、`safeParse`、可定位的错误路径。
//
// 覆盖本仓库真正用到的形状：object / string / number / boolean / array / enum / literal /
// record / union，外加 `default` / `optional` / `partial` / `refine` 与 `trim` / `min` /
// `max` / `int` / `regex` 这类约束。新增形状时先加测试（`tests/schema.test.ts`），再扩展这里。
//
// 两条纪律：
// - 所有构造器都是不可变的：每次链式调用返回新实例，模块级 schema 常量因此可以安全共享；
// - 错误只报「路径 + 固定英文短句」，`parse` 抛 `SchemaError`，需要字段级 issues（设置保存、
//   面板表单）时走 `safeParse`。
//
// 写法约束：Orca 的测试运行器用 Node 的 strip-only 类型剥离，参数属性（`constructor(private
// readonly x: T)`）与枚举都不被支持；这里的类一律显式声明字段并在构造函数里赋值。

/** 一条校验问题：`path` 是字段路径（数组下标是数字），`message` 是固定的英文短句。 */
export interface SchemaIssue {
  readonly path: readonly (string | number)[]
  readonly message: string
}

/** `safeParse` 的结果：成功带值，失败带全部 issues（不是一个异常）。 */
export type SafeParse<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly issues: SchemaIssue[] }

/** `parse` 失败时抛的错误：`issues` 与 `safeParse` 的失败分支同形。 */
export class SchemaError extends Error {
  readonly issues: SchemaIssue[]

  constructor(issues: readonly SchemaIssue[]) {
    super(issues.map((entry) => `${entry.path.join('.') || '(root)'}: ${entry.message}`).join('; '))
    this.name = 'SchemaError'
    this.issues = [...issues]
  }
}

/** 单条字段问题的构造：所有形状共用，保证 message 只有一种写法。 */
const issue = (path: readonly (string | number)[], message: string): SafeParse<never> => ({
  success: false,
  issues: [{ path, message }]
})

/** 默认值每次取一份新副本：调用方改返回值不会污染 schema（与 zod 同语义）。 */
const clone = <T>(value: T): T =>
  value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)

/** 校验器的基类：`parse` / `safeParse` / `default` / `optional` 对所有形状一致。 */
export abstract class Schema<T> {
  /** 在给定路径下校验；子类只实现这一处。 */
  abstract parseAt(value: unknown, path: readonly (string | number)[]): SafeParse<T>

  safeParse(value: unknown): SafeParse<T> {
    return this.parseAt(value, [])
  }

  parse(value: unknown): T {
    const result = this.parseAt(value, [])
    if (!result.success) throw new SchemaError(result.issues)
    return result.data
  }

  /** 输入是 `undefined` 时取默认值；默认值自身也过一遍校验与默认值填充。 */
  default(value: T): Schema<T> {
    return new DefaultSchema<T>(this, value)
  }

  /** 输入是 `undefined` 时接受它（字段可以缺席）。 */
  optional(): Schema<T | undefined> {
    return new OptionalSchema<T>(this)
  }
}

/** 任一形状的校验器（`object` 的字段表用）。 */
export type AnySchema = Schema<unknown>

/** 从校验器推出它产出的类型。 */
export type Infer<S> = S extends Schema<infer T> ? T : never

class DefaultSchema<T> extends Schema<T> {
  readonly #inner: Schema<T>
  readonly #fallback: T

  constructor(inner: Schema<T>, fallback: T) {
    super()
    this.#inner = inner
    this.#fallback = fallback
  }

  parseAt(value: unknown, path: readonly (string | number)[]): SafeParse<T> {
    return this.#inner.parseAt(value === undefined ? clone(this.#fallback) : value, path)
  }
}

class OptionalSchema<T> extends Schema<T | undefined> {
  readonly #inner: Schema<T>

  constructor(inner: Schema<T>) {
    super()
    this.#inner = inner
  }

  parseAt(value: unknown, path: readonly (string | number)[]): SafeParse<T | undefined> {
    if (value === undefined) return { success: true, data: undefined }
    return this.#inner.parseAt(value, path)
  }
}

class RefinedSchema<T> extends Schema<T> {
  readonly #inner: Schema<T>
  readonly #predicate: (value: T) => boolean
  readonly #message: string

  constructor(inner: Schema<T>, predicate: (value: T) => boolean, message: string) {
    super()
    this.#inner = inner
    this.#predicate = predicate
    this.#message = message
  }

  parseAt(value: unknown, path: readonly (string | number)[]): SafeParse<T> {
    const result = this.#inner.parseAt(value, path)
    if (!result.success || this.#predicate(result.data)) return result
    return issue(path, this.#message)
  }
}

/** 在已校验的值上加一条业务约束（`refine(number(), (v) => v > 0, 'expected a ratio')`）。 */
export function refine<T>(
  schema: Schema<T>,
  predicate: (value: T) => boolean,
  message: string
): Schema<T> {
  return new RefinedSchema(schema, predicate, message)
}

class TransformSchema<T, U> extends Schema<U> {
  readonly #inner: Schema<T>
  readonly #map: (value: T) => U

  constructor(inner: Schema<T>, map: (value: T) => U) {
    super()
    this.#inner = inner
    this.#map = map
  }

  parseAt(value: unknown, path: readonly (string | number)[]): SafeParse<U> {
    const result = this.#inner.parseAt(value, path)
    return result.success ? { success: true, data: this.#map(result.data) } : result
  }
}

/**
 * 在已校验的值上做一次纯映射（`transform(string(), (v) => v.toLowerCase())`）：校验失败原样
 * 透出，成功时把值换成规范形态。设置保存与运行时读的是同一个规范形态，不必各写一遍。
 */
export function transform<T, U>(schema: Schema<T>, map: (value: T) => U): Schema<U> {
  return new TransformSchema(schema, map)
}

/** 一条字符串约束：返回 undefined 表示通过，否则是固定的英文短句。 */
type StringCheck = (value: string) => string | undefined

class StringSchema extends Schema<string> {
  readonly #trimFirst: boolean
  readonly #checks: readonly StringCheck[]

  constructor(trimFirst: boolean = false, checks: readonly StringCheck[] = []) {
    super()
    this.#trimFirst = trimFirst
    this.#checks = checks
  }

  /** 先去掉首尾空白，再做后面的约束（与 zod 的 `.trim()` 同序）。 */
  trim(): StringSchema {
    return new StringSchema(true, this.#checks)
  }

  min(length: number): StringSchema {
    return this.#check((value) =>
      value.length >= length ? undefined : `expected at least ${length} characters`
    )
  }

  max(length: number): StringSchema {
    return this.#check((value) =>
      value.length <= length ? undefined : `expected at most ${length} characters`
    )
  }

  regex(pattern: RegExp): StringSchema {
    return this.#check((value) =>
      pattern.test(value) ? undefined : `does not match ${pattern.toString()}`
    )
  }

  #check(check: StringCheck): StringSchema {
    return new StringSchema(this.#trimFirst, [...this.#checks, check])
  }

  parseAt(value: unknown, path: readonly (string | number)[]): SafeParse<string> {
    if (typeof value !== 'string') return issue(path, 'expected string')
    const text = this.#trimFirst ? value.trim() : value
    for (const check of this.#checks) {
      const message = check(text)
      if (message !== undefined) return issue(path, message)
    }
    return { success: true, data: text }
  }
}

/** 字符串（不做类型转换：settings 与 CLI 输出都已是 JSON 类型）。 */
export const string = (): StringSchema => new StringSchema()

type NumberCheck = (value: number) => string | undefined

class NumberSchema extends Schema<number> {
  readonly #checks: readonly NumberCheck[]

  constructor(checks: readonly NumberCheck[] = []) {
    super()
    this.#checks = checks
  }

  int(): NumberSchema {
    return this.#check((value) => (Number.isInteger(value) ? undefined : 'expected integer'))
  }

  min(bound: number): NumberSchema {
    return this.#check((value) => (value >= bound ? undefined : `expected at least ${bound}`))
  }

  max(bound: number): NumberSchema {
    return this.#check((value) => (value <= bound ? undefined : `expected at most ${bound}`))
  }

  #check(check: NumberCheck): NumberSchema {
    return new NumberSchema([...this.#checks, check])
  }

  parseAt(value: unknown, path: readonly (string | number)[]): SafeParse<number> {
    if (typeof value !== 'number' || Number.isNaN(value)) return issue(path, 'expected number')
    for (const check of this.#checks) {
      const message = check(value)
      if (message !== undefined) return issue(path, message)
    }
    return { success: true, data: value }
  }
}

/** 数字（拒绝字符串与 NaN，与 JSON 设置的类型一致）。 */
export const number = (): NumberSchema => new NumberSchema()

class BooleanSchema extends Schema<boolean> {
  parseAt(value: unknown, path: readonly (string | number)[]): SafeParse<boolean> {
    return typeof value === 'boolean'
      ? { success: true, data: value }
      : issue(path, 'expected boolean')
  }
}

/** 布尔。 */
export const boolean = (): BooleanSchema => new BooleanSchema()

class LiteralSchema<T extends string | number | boolean> extends Schema<T> {
  readonly #expected: T

  constructor(expected: T) {
    super()
    this.#expected = expected
  }

  parseAt(value: unknown, path: readonly (string | number)[]): SafeParse<T> {
    return value === this.#expected
      ? { success: true, data: this.#expected }
      : issue(path, `expected ${String(this.#expected)}`)
  }
}

/** 恰好等于某个值的字面量（例如 `literal('bot')`）。 */
export function literal<T extends string | number | boolean>(expected: T): Schema<T> {
  return new LiteralSchema(expected)
}

class EnumSchema<T extends string> extends Schema<T> {
  readonly #values: readonly T[]

  constructor(values: readonly T[]) {
    super()
    this.#values = values
  }

  parseAt(value: unknown, path: readonly (string | number)[]): SafeParse<T> {
    const found = this.#values.find((candidate) => candidate === value)
    return found === undefined
      ? issue(path, `expected one of ${this.#values.join(', ')}`)
      : { success: true, data: found }
  }
}

/** 字符串枚举：值必须是给定字面量之一。 */
export function enumOf<T extends string>(values: readonly T[]): Schema<T> {
  return new EnumSchema(values)
}

class ArraySchema<T> extends Schema<T[]> {
  readonly #item: Schema<T>

  constructor(item: Schema<T>) {
    super()
    this.#item = item
  }

  parseAt(value: unknown, path: readonly (string | number)[]): SafeParse<T[]> {
    if (!Array.isArray(value)) return issue(path, 'expected array')
    const items: T[] = []
    const issues: SchemaIssue[] = []
    value.forEach((entry, index) => {
      const result = this.#item.parseAt(entry, [...path, index])
      if (result.success) items.push(result.data)
      else issues.push(...result.issues)
    })
    return issues.length ? { success: false, issues } : { success: true, data: items }
  }
}

/** 数组：逐个元素校验，问题带下标。 */
export function array<T>(item: Schema<T>): Schema<T[]> {
  return new ArraySchema(item)
}

class RecordSchema<T> extends Schema<Record<string, T>> {
  readonly #value: Schema<T>

  constructor(valueSchema: Schema<T>) {
    super()
    this.#value = valueSchema
  }

  parseAt(value: unknown, path: readonly (string | number)[]): SafeParse<Record<string, T>> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return issue(path, 'expected object')
    }
    const record: Record<string, T> = {}
    const issues: SchemaIssue[] = []
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const result = this.#value.parseAt(entry, [...path, key])
      if (result.success) record[key] = result.data
      else issues.push(...result.issues)
    }
    return issues.length ? { success: false, issues } : { success: true, data: record }
  }
}

/** 键不定的对象：每个值过同一个 schema，问题带键名。 */
export function record<T>(valueSchema: Schema<T>): Schema<Record<string, T>> {
  return new RecordSchema(valueSchema)
}

class UnionSchema<T> extends Schema<T> {
  readonly #members: readonly Schema<unknown>[]

  constructor(members: readonly Schema<unknown>[]) {
    super()
    this.#members = members
  }

  parseAt(value: unknown, path: readonly (string | number)[]): SafeParse<T> {
    const issues: SchemaIssue[] = []
    for (const member of this.#members) {
      const result = member.parseAt(value, path)
      if (result.success) return { success: true, data: result.data as T }
      issues.push(...result.issues)
    }
    return { success: false, issues }
  }
}

/** 联合：按声明顺序试每个成员，全不匹配时返回全部路径。 */
export function union<T>(members: readonly Schema<unknown>[]): Schema<T> {
  return new UnionSchema<T>(members)
}

/** `object()` 的字段表：值可以是任何校验器，`InferShape` 从它推出对象类型。 */
export type Shape = Readonly<Record<string, AnySchema>>

/** 从字段表推出对象类型：`optional()` / `default()` 产出的字段照它们的数据类型走。 */
export type InferShape<S extends Shape> = {
  [K in keyof S]: Infer<S[K]>
}

class ObjectSchema<S extends Shape> extends Schema<InferShape<S>> {
  readonly #shape: S
  readonly #strictMode: boolean
  readonly #partialMode: boolean

  constructor(shape: S, strictMode: boolean, partialMode: boolean) {
    super()
    this.#shape = shape
    this.#strictMode = strictMode
    this.#partialMode = partialMode
  }

  /** 拒绝未声明的键（设置块与 Source 配置用它，§K.8）。 */
  strict(): ObjectSchema<S> {
    return new ObjectSchema(this.#shape, true, this.#partialMode)
  }

  /** 每个字段都变成可选（面板提交部分字段、`rows()` 读不完整配置时用）。 */
  partial(): ObjectSchema<S> {
    return new ObjectSchema(this.#shape, this.#strictMode, true)
  }

  parseAt(value: unknown, path: readonly (string | number)[]): SafeParse<InferShape<S>> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return issue(path, 'expected object')
    }
    const input = value as Record<string, unknown>
    const output: Record<string, unknown> = {}
    const issues: SchemaIssue[] = []
    for (const [key, field] of Object.entries(this.#shape)) {
      // partial() 的字段在缺席时直接跳过，不触发 default（调用方要的是「没写的就别填」）。
      if (this.#partialMode && input[key] === undefined) continue
      const result = field.parseAt(input[key], [...path, key])
      if (result.success) {
        if (result.data !== undefined) output[key] = result.data
      } else issues.push(...result.issues)
    }
    if (this.#strictMode) {
      for (const key of Object.keys(input)) {
        if (!(key in this.#shape)) issues.push({ path: [...path, key], message: 'unknown key' })
      }
    }
    return issues.length
      ? { success: false, issues }
      : { success: true, data: output as InferShape<S> }
  }
}

/** 对象：默认丢掉未知键；`.strict()` 拒绝它们，`.partial()` 让每个字段可缺席。 */
export function object<S extends Shape>(shape: S): ObjectSchema<S> {
  return new ObjectSchema(shape, false, false)
}

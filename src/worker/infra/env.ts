// 子进程环境（§I.4 的统一命令端口、§O 的命令注入面）。
//
// 一条纪律：插件起的每一个子进程（`gh` / `lark-cli` / `git` / `orca` / `sh`）都**不继承**
// 名字里带秘密语义的变量——`*_KEY`、`*_SECRET`、`*_TOKEN`、`*_PASSWORD` 之类。
// 理由不是「怕它泄漏」，而是这些 CLI 自己会用同名变量换掉已登录的身份：
// 一个残留的 `GITHUB_TOKEN` 会让 `gh` 用操作者的个人 token，而不是 agent 账号（§H.11 的同一风险）。
//
// 例外：名字里带 TOKEN 但语义是**路径**的变量（`*_TOKEN_FILE`）保留——路径不是秘密，
// 而且 `SUPERAGENT_TOKEN_FILE` 正是 worker 拿 token 的方式（§D.6）。
//
// 本文件是纯函数：不读环境、不落盘、不看时钟。

/** 一个「秘密」词：出现在变量名的某一段里就整条剥掉。 */
const SECRET_WORDS: readonly string[] = [
  'KEY',
  'KEYS',
  'SECRET',
  'SECRETS',
  'TOKEN',
  'TOKENS',
  'PASSWORD',
  'PASSWORDS',
  'PASSWD',
  'PASSPHRASE',
  'CREDENTIAL',
  'CREDENTIALS'
]

/** 名字以这些段结尾时，值是路径/地址而不是秘密（`SUPERAGENT_TOKEN_FILE`、`*_KEY_PATH`）。 */
const PATH_WORDS: readonly string[] = ['FILE', 'FILEPATH', 'PATH', 'DIR', 'DIRECTORY', 'URL', 'URI']

/**
 * 一个变量名是否携带秘密。按 `_` 分段比较**整段**（大小写不敏感）：
 * `ANTHROPIC_API_KEY`、`AWS_SECRET_ACCESS_KEY`、`LARK_APP_SECRET`、`GITHUB_TOKEN` 命中；
 * `KEYBOARD_LAYOUT`、`MONKEY`、`GIT_TERMINAL_PROMPT` 不命中（不靠子串猜）。
 */
export function isSecretName(name: string): boolean {
  const segments = name.toUpperCase().split('_').filter((segment) => segment.length > 0)
  if (segments.length === 0) return false
  const last = segments[segments.length - 1] as string
  if (PATH_WORDS.includes(last)) return false
  return segments.some((segment) => SECRET_WORDS.includes(segment))
}

/**
 * 从一份环境里剥掉秘密变量：返回值里没有 `undefined`（子进程环境里不能出现字符串
 * "undefined"），其余原样保留。调用方在 `execFile` 之前用它组 `env`。
 */
export function withoutSecretEnvironment(
  environment: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) continue
    if (isSecretName(name)) continue
    kept[name] = value
  }
  return kept
}

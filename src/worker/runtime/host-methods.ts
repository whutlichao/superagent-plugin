// Host 方法名的唯一清单（§N.3 其四）。`supports()` 用它加 `host.has` 判断宿主能力，
// 类型面（types/orca.d.ts 的 HostMethods）与它对齐，测试在两边任一漂移时先炸。
//
// 方法名与 since 均来自 `orca skills get orca-plugin-authoring --reference references/host-api.md`
// （pinned to Orca 1.4.251）。`since` 是该宿主方法引入的 Orca 版本；新增方法时同时抬
// `orca-plugin.json` 的 `engines.orca`。

/** 清单条目：宿主方法名 + 引入该方法的 Orca 版本（外加紧挨着的 `// since `<version>` 注释）。 */
export interface HostMethod {
  readonly method: string
  readonly since: string
}

/** 插件会调用的全部宿主方法。顺序即清单顺序。 */
export const HOST_METHODS = [
  // since 1.3 — references/host-api.md §Methods（worker）：列出所有 workspace。
  { method: 'workspace.list', since: '1.3' },
  // since 1.3 — references/host-api.md §Methods（worker）：在 Orca 里显示一个 workspace。
  { method: 'workspace.open', since: '1.3' },
  // since 1.2 — references/host-api.md §Methods（worker/panel/editor）：当前聚焦 workspace 的 agent 行。
  { method: 'agents.list', since: '1.2' },
  // since 1.3 — references/host-api.md §Methods（worker）：在 workspace 的终端里启动 agent。
  { method: 'agent.launch', since: '1.3' },
  // since 1.0 — references/host-api.md §Methods（worker）：向终端输入文本，可选回车。
  { method: 'terminal.sendText', since: '1.0' },
  // since 1.3 — references/host-api.md §Methods（worker）：读取终端最新输出，上限 2000 行。
  { method: 'terminal.read', since: '1.3' },
  // since 1.0 — references/host-api.md §Methods（worker/panel/editor）：桌面通知。
  { method: 'notifications.show', since: '1.0' },
  // since 1.2 — references/host-api.md §Methods（worker）：更新清单里的状态栏项。
  { method: 'statusBar.update', since: '1.2' },
  // since 1.0 — references/host-api.md §Methods（全部面）：读插件私有 JSON 存储。
  { method: 'storage.get', since: '1.0' },
  // since 1.0 — references/host-api.md §Methods（全部面）：写插件私有 JSON 存储。
  { method: 'storage.set', since: '1.0' },
  // since 1.0 — references/host-api.md §Methods（全部面）：删插件私有存储的键。
  { method: 'storage.delete', since: '1.0' },
  // since 1.0 — references/host-api.md §Methods（全部面）：列插件私有存储的键。
  { method: 'storage.keys', since: '1.0' },
  // since 1.0 — references/host-api.md §Methods（全部面）：读插件加密密钥文件。
  { method: 'secrets.get', since: '1.0' },
  // since 1.0 — references/host-api.md §Methods（全部面）：写插件加密密钥文件。
  { method: 'secrets.set', since: '1.0' },
  // since 1.0 — references/host-api.md §Methods（全部面）：删插件加密密钥。
  { method: 'secrets.delete', since: '1.0' },
  // since 1.1 — references/host-api.md §Methods（全部面）：密钥静态保护方式（os-keyring / unavailable）。
  { method: 'secrets.protection', since: '1.1' },
  // since 1.0 — references/host-api.md §Methods（全部面）：读插件全部设置。
  { method: 'settings.get', since: '1.0' },
  // since 1.0 — references/host-api.md §Methods（全部面）：写插件的一项设置。
  { method: 'settings.set', since: '1.0' }
] as const satisfies readonly HostMethod[]

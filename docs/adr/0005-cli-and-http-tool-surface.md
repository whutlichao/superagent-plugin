# 工具面是一个 CLI 加 loopback HTTP，不是宿主工具

Router 与 worker agent 的工具面是一个独立的 `superagent` CLI（经 loopback HTTP 调常驻进程），用一个 token 区分三种角色：operator、router、assignment。上游把二十个能力暴露成宿主的 agent 工具，而 Orca 的 agent 工具集由各 agent 自己决定、插件改不了，所以工具必须是任何 agent 都能从 shell 调到的独立可执行文件；token 角色替代了宿主工具调用天然携带的身份。代价是多一层进程与 HTTP 的调用开销，且参数错误表现为 CLI 的固定错误码而不是工具 schema 拒绝。备选是把工具做成宿主工具或 MCP server——那会绑死到某一种 agent。

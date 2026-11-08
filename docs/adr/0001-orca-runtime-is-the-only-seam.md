# 唯一的运行缝 `OrcaRuntime`

插件里所有接触 Orca 的代码都收敛在 `src/worker/runtime/`：只有这个目录可以 import 宿主的类型、可以用 `orca` CLI 的子进程、可以调宿主 API；其余模块只依赖 `OrcaRuntime` 接口与领域端口。上游把外部世界收在三个适配器里，Orca 这边的外部世界同样只有两类（宿主 API 与 `orca` CLI），若不收敛成一个 seam，每加一个面板或执行器动作都会长出第二个 Orca 依赖点；代价是所有对 Orca 的调用都要先经过这层接口，换来的是模块可以脱离宿主测试、替换实现只改一处。备选是各模块直接用宿主 API——那样依赖方向会随功能增长，`runtime-seam.test.ts` 也就无从扫描。

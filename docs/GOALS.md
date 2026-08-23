# dsh-agent-swarm 产品章程

本文件只定义稳定的产品目标、范围、非目标、能力依赖和验收原则，不登记当前任务、负责人、分支、候选、审查结论或里程碑进度。实时工作状态由项目绑定选定的外部 provider 或非提交式动态台账承担；版本化实现与审查结果保存在 Git、阶段报告和 ADR 中。

## 产品目标

以 official-first 的纯插件方式，为用户安装的完整官方 DeepSeek Harness 提供持久、可审查、可恢复的多 Agent 团队协作能力。官方 DSH 是唯一 Agent Runtime、Profile、Session、preset 和交互服务宿主；本插件通过公开 seam 组合 Team、Workflow、Jobs、Storage Domain、Subagent、问题/审批、Host/RPC 与 UI Consumer，不嵌入或维护第二套 Agent Runtime。

源码可以物理嵌套于官方 DSH checkout 内以缩短兼容验证路径，但目录必须避开官方 workspace glob，并由插件根 `pnpm-workspace.yaml` 固定独立工具链边界；插件始终保持独立 Git、独立 package/workspace 和独立发布权威。物理嵌套不把插件变成官方 workspace member，也不授权修改官方 DSH 的源码、manifest、lock、配置或发布状态；官方 checkout 只作为版本身份与真实 Profile/Bundle 装配的只读验收宿主，具体目录不是兼容性证据。

在 Team 协作域内，`TeamDomainPort` 是 roster、task/DAG、attempt、mailbox 和 budget 的唯一写权威；本插件未来提供的 `HumanInteractionPort` 是 Team 人机请求、receipt 和 timeline 的唯一生产者。Canvas、官方 DSH UI、命令行和其他客户端都是消费者或宿主适配器，不能从 transcript、浏览器缓存或本地 Map 重建第二份 Team/HumanInteraction 真源。

## 稳定范围

产品能力族包括：

1. 崩溃安全的 Team 聚合、任务 DAG、revision/attempt 围栏、持久邮箱和显式恢复；
2. 可替换的调度、审核、预算、验证、记忆、Workspace 与远程成员 Provider；
3. 对官方 Workflow、Jobs、Storage Domain、Workspace、Subagent、问题/审批等能力的兼容消费；
4. 用户通过 root captain 与团队沟通、修正、提问和审查的持久 HumanInteraction 路径；
5. 稳定控制面、冻结候选、独立验收、外部晋升和可验证回滚；
6. canonical Host/RPC producer、DSH-native UI，以及按合同接入的 Canvas 等宿主消费者；
7. 插件化发布、迁移、兼容退役、故障恢复和可选的分布式运行。

UI 是末端投影型 Consumer；无浏览器、无 Canvas 或 UI 卸载时，Team Runtime 仍能正确推进。Canvas 的画布、Project/Shot 和 Director 数据继续由 Canvas/Director 自己负责，不进入 Team aggregate。

## 产品红线

- 不修改 Agent Loop 来实现 Team 专属行为，不影子注册官方服务。
- 不因物理共址修改官方 DSH 的源码、manifest、lock 或配置；所有兼容与性能修正只进入本插件的独立候选。
- 不携带私有 DSH 内核、私有 `DSH_HOME` 或第二套 preset；安装和运行始终基于用户拥有的官方 DSH。
- 不把 Swarm 表示为与 Agent provider/engine 并列的第三 Runtime；它是当前官方 DSH Session 的可选 Team capability。
- 不维护两个可写 canonical 状态机；所有 Team 状态变更经过 `TeamDomainPort`，所有 HumanInteraction 记录经过唯一 producer。
- 不让 Canvas token、自由文本、UI reducer、transcript parser 或浏览器缓存成为认证主体、权限证明或 Team 状态权威。
- 权威状态 durable commit 后才发布事件、receipt 或成功结果；重复、迟到、过期和陈旧 attempt 必须可判定。
- Worker、Reviewer、Acceptor、Promoter 的权限按风险分离；候选不能批准或部署自身。
- 参考仓库只提供行为、故障和交互证据，不成为依赖或第二运行时。
- 版本、已发布 API 和实际装配事实由清单、锁文件、官方基线、目标安装包和真实 Profile 共同证明。

## 能力演进顺序

下列名称定义稳定的依赖顺序和退出边界，不表示实时完成状态：

1. **G0 — 产品与兼容基线**：统一官方单宿主、纯插件、单一 Team/HumanInteraction producer 和跨宿主消费边界；Gate A 与权威文档一致。
2. **I1 — Captain Liaison 与 durable effect correlation**：完成无 UI 的用户→captain→member/Team→captain→用户闭环，以及控制 effect 的跨重启幂等判定。
3. **I2 — HumanInteraction Host producer**：提供 context、Message/Control、问题/审查、receipt/timeline、redaction、刷新/撤销和恢复能力；客户端不能直写存储。
4. **I3 — canonical `/swarm` RPC**：冻结版本化 schema、capability、fixtures 和错误语义，并在真实官方 DSH Profile 证明装配、卸载、重载和无 UI 运行。
5. **I4 — DSH-native UI**：只消费 I3，使用官方组件、主题和生命周期，在 DSH 内提供最小可操作 Team 界面。
6. **I5 — Canvas consumer**：Canvas BFF 和原生 UI 只透传/消费已接受的 I3 合同，使用 Canvas 自身组件与主题，并与 I4 运行同一 fixture/action-parity 矩阵。
7. **M6–M9 后续能力族**：真实 Workspace/远程成员、自动记忆与 Skill Evolution、分布式原子 Team/可观测性，以及完整迁移、兼容、包装和发布。

详细依赖、非目标、风险和出口证据见 `docs/07-implementation-roadmap.md`。历史里程碑的实现事实由对应报告、ADR、Git commit/tag 和测试保存，不在本章程汇总成滚动状态。

## 产品级完成原则

一个能力只有在以下事实同时成立时才可声明交付：

- 行为落在明确的官方或项目自有 seam，且没有第二权威；
- 持久状态、并发围栏、生命周期、失败和恢复窗口有可执行证据；
- 模型可见工具、Host/RPC 或 UI 投影有与声明层级匹配的真实组合证据；
- 风险对应的非作者审查绑定到精确候选；
- 集成、发布或晋升按预期目标执行并读回结果；
- 受影响的公共、架构、合同、安全和恢复文档与同一候选一致。

## 非目标

- 在本仓库复制官方 DSH Runtime、Canvas Runtime 或参考项目 Runtime；
- 以共享 React 组件强制两个宿主视觉一致；两端共享语义合同和 fixtures，各自遵守宿主组件与主题；
- 让 I1–I5 顺带实现真实 Worktree/remote、分布式 Store、自动记忆或正式公开发布；
- 因历史候选存在而跳过当前基线重放、Gate A、选择性迁移、测试或审查。

## 章程变更

只有产品结果、范围、兼容立场、唯一权威或能力依赖发生实质变化时才修改本文件。任务排期、执行器、仓库托管位置、开发并发数、临时环境、候选 SHA 和滚动进度不得写入本章程。

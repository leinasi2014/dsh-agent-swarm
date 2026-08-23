# dsh-agent-swarm 文档

本目录是项目的设计与治理文档全集。按以下分层组织：

## 阅读路径

### 入门（10 分钟了解项目）
1. [00-vision.md](00-vision.md) — 产品目标、范围与兼容立场
2. [03-capability-family.md](03-capability-family.md) — 目标能力族与服务图
3. [07-implementation-roadmap.md](07-implementation-roadmap.md) — 里程碑分期与出口标准

### 协议与架构（实现者的权威参考）
4. [04-core-protocol.md](04-core-protocol.md) — 核心协议：revision/attempt 围栏、邮箱、调度、恢复、预算、模式与权限。**每个决策段（§8a–§8o）都可追溯到 issue/PR**
5. [01-dsh-principles.md](01-dsh-principles.md) — DSH 插件/能力模型原则
6. [02-reference-analysis.md](02-reference-analysis.md) — 官方 DSH、dsh-agent-teams、JiuwenSwarm 三方角色分析
7. [05-jiuwen-feature-mapping.md](05-jiuwen-feature-mapping.md) — 外部概念到 DSH 插件的映射（含不采纳登记）
8. [06-workspace-distributed.md](06-workspace-distributed.md) — Worktree、远程成员与原子状态

### 治理与门禁（贡献者必读）
9. [11-official-first-development.md](11-official-first-development.md) — official-first 开发门（Gate A/B/C 纪律）
10. [OFFICIAL_BASELINE.json](OFFICIAL_BASELINE.json) — 机读官方基线（`pnpm verify:gate-a` 的权威输入）
11. [09-sources.md](09-sources.md) — 源码钉住与证据政策
12. [governance/project-binding.yaml](governance/project-binding.yaml)、[governance/document-registry.yaml](governance/document-registry.yaml) 与 [governance/adoption-manifest-v1.yaml](governance/adoption-manifest-v1.yaml) — 通用敏捷开发方法的项目绑定、文档权威登记与不可变接管清单
13. [13-self-hosting-dogfood.md](13-self-hosting-dogfood.md) — 分级自托管：D1/D2 dogfood、稳定/候选 Profile、自我改进控制回路

### 验证与审计
14. [08-testing-verification.md](08-testing-verification.md) — 验证矩阵（场景审计、套件清单、门禁链）
15. [10-fusion-audit.md](10-fusion-audit.md) — 参考融合的累计历史证据、现行 pin 与冲突审计；前向顺序以 GOALS/roadmap 为准

### 记录层（已接受证据保持不可变）
- [adr/](adr/) — 已接受的架构决策（ADR-0001..0008）
- [development/](development/) — 有界实现设计与阶段完成报告；已接受的报告保持不可变，未接受且与现行架构冲突的前瞻方案可在有 Git 恢复身份、无现行引用的受审候选中 supersede 或删除
- [reviews/](reviews/) — 独立审查报告（不可变）与 PM intake（分开成文）

## 权威与证据说明

- [GOALS.md](GOALS.md) 只保存稳定产品章程，不登记滚动进度。
- 阶段报告、审查报告、ADR、Git commit/tag 是版本化历史证据，不是实时任务台账。
- 官方兼容事实以 [OFFICIAL_BASELINE.json](OFFICIAL_BASELINE.json)、目标安装包和 Gate A 结果为准。
- 当前任务、候选、审查与集成状态由项目绑定选定的外部 provider 或非提交式动态台账承担。
- 历史记录中对已删除旧规范的引用只说明当时上下文，不会恢复旧治理权威；现行方法以项目 binding 和 `$manage-agile-software-development` 为准。

## 文档规则

- 协议决策进 docs/04 的编号决策段，不散落在 README 或代码注释；
- `reviews/` 一经写入不可修改（审查证据完整性）；PM 的裁决与排期写独立的 intake 文件；
- `development/` 的设计注记先于实现（评估先行双案论证模式）；
- 官方事实变化时，`OFFICIAL_BASELINE.json` 与 docs/09 同一 commit 更新（Gate A 纪律）。

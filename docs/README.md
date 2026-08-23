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
12. [governance/project-binding.yaml](governance/project-binding.yaml) 与 [governance/document-registry.yaml](governance/document-registry.yaml) — 通用敏捷开发方法的项目绑定与文档权威登记
13. [13-self-hosting-dogfood.md](13-self-hosting-dogfood.md) — 分级自托管：D1/D2 dogfood、稳定/候选 Profile、自我改进控制回路

### 验证与审计
14. [08-testing-verification.md](08-testing-verification.md) — 验证矩阵（场景审计、套件清单、门禁链）
15. [10-fusion-audit.md](10-fusion-audit.md) — 参考融合现状、冲突、缺口与优化优先级

### 记录层（只增不改）
- [adr/](adr/) — 已接受的架构决策（ADR-0001..0008）
- [development/](development/) — 有界实现委托与阶段完成报告（含各里程碑出口报告）
- [reviews/](reviews/) — 独立审查报告（不可变）与 PM intake（分开成文）

## 当前状态速查

- **里程碑**：M1–M4 完成（tag `m1d`/`m2`/`m3`/`m4`），M5 进行中——见 [GOALS.md](GOALS.md)
- **官方基线**：DSH `0.1.1-rc.2` @ `b150a55`（release 锚定，Gate A 持续核验）
- **测试**：226 项 / 25 个机器证明场景
- **决策登记**：docs/04 §8a–§8o（F1–F17 发现编号体系）

## 文档规则

- 协议决策进 docs/04 的编号决策段，不散落在 README 或代码注释；
- `reviews/` 一经写入不可修改（审查证据完整性）；PM 的裁决与排期写独立的 intake 文件；
- `development/` 的设计注记先于实现（评估先行双案论证模式）；
- 官方事实变化时，`OFFICIAL_BASELINE.json` 与 docs/09 同一 commit 更新（Gate A 纪律）。

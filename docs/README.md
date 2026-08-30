# dsh-agent-swarm 文档

本目录保存产品、架构、协议、质量和治理权威。稳定文档描述规则与边界，不充当任务、分支、候选或审查状态看板。

## 推荐阅读

1. [GOALS.md](GOALS.md) — 稳定产品章程、范围、红线与完成原则。
2. [00-vision.md](00-vision.md) — Main Brain → Captain → Team 的用户体验和身份模型。
3. [03-capability-family.md](03-capability-family.md) — 当前实现、服务边界、Consumer 与缺口。
4. [04-core-protocol.md](04-core-protocol.md) — revision、attempt、任务、邮箱、审核、恢复和权限合同。
5. [07-implementation-roadmap.md](07-implementation-roadmap.md) — 从当前基线到 90% 产品就绪的交付顺序与出口证据。
6. [08-testing-verification.md](08-testing-verification.md) — 候选检查、场景和真实 Profile/browser 验证合同。

## 架构与兼容

- [01-dsh-principles.md](01-dsh-principles.md) — DSH 插件与 capability seam 原则。
- [02-reference-analysis.md](02-reference-analysis.md) — 官方 DSH 与两个固定参考源的角色。
- [05-jiuwen-feature-mapping.md](05-jiuwen-feature-mapping.md) — 外部概念到 DSH seam 的映射与不采纳项。
- [06-workspace-distributed.md](06-workspace-distributed.md) — execution root、远程成员和分布式边界。
- [09-sources.md](09-sources.md) — 官方与参考源码 pin、证据和刷新规则。
- [10-fusion-audit.md](10-fusion-audit.md) — 参考能力覆盖、冲突和剩余缺口。
- [11-official-first-development.md](11-official-first-development.md) — official-first 兼容开发门。
- [13-self-hosting-dogfood.md](13-self-hosting-dogfood.md) — stable control、candidate、acceptance 和 promotion 分权。
- [OFFICIAL_BASELINE.json](OFFICIAL_BASELINE.json) — `pnpm verify:compatibility` 使用的机读官方基线。

## 治理权威

- [governance/project-binding.yaml](governance/project-binding.yaml) — 项目采用的交付、隔离、审查和集成规则。
- [governance/document-registry.yaml](governance/document-registry.yaml) — 文档角色、owner、写入模式和验证入口。
- [development/2026-08-23-worktree-cleanup-ledger.md](development/2026-08-23-worktree-cleanup-ledger.md) — 迁移完成前唯一保留、不可滚动更新的恢复证据。旧 ADR、阶段报告和审查报告已由当前权威取代，历史内容由 Git 保存。

## 权威关系

| 问题 | 权威 |
|---|---|
| 产品目标、范围、非目标 | [GOALS.md](GOALS.md) |
| 用户体验与身份拓扑 | [00-vision.md](00-vision.md) |
| 服务/Provider/Consumer ownership | [03-capability-family.md](03-capability-family.md) |
| 状态机、错误、并发与权限合同 | [04-core-protocol.md](04-core-protocol.md) |
| Workspace 与 distributed 语义 | [06-workspace-distributed.md](06-workspace-distributed.md) |
| 交付顺序与出口证据 | [07-implementation-roadmap.md](07-implementation-roadmap.md) |
| 测试与验收命令 | [08-testing-verification.md](08-testing-verification.md) |
| 官方/参考事实 | [OFFICIAL_BASELINE.json](OFFICIAL_BASELINE.json)、[09-sources.md](09-sources.md) |
| 实时任务、writer、候选、审查、集成状态 | 项目绑定选定的动态 provider 或 Git common-dir ledger；不写入 Markdown |

## 维护规则

- 公共行为变化时，同一候选更新受影响的产品/协议文档；不机械刷新所有文件。
- 官方包、export 或 reference pin 变化时，只更新受影响的兼容权威并运行 `pnpm verify:compatibility`。
- 文档不能授权密钥、网络、push、release、删除或仓库外写入。
- UI、日志、截图、历史报告和 agent 消息不是 Team truth，也不能把计划能力描述为已交付。
- 协议决定进入 `04-core-protocol.md`；滚动排期和候选状态留在动态任务系统。
- 不新建同题 ADR、阶段报告或审查报告；修改现有登记权威并以测试、GitHub PR/Issue 和集成读回承载动态证据。

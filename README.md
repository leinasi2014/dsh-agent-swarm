# dsh-agent-swarm

[![verify](https://github.com/leinasi2014/dsh-agent-swarm/actions/workflows/verify.yml/badge.svg)](https://github.com/leinasi2014/dsh-agent-swarm/actions/workflows/verify.yml)
[![milestone](https://img.shields.io/badge/milestone-M5%20in%20progress-blue)](https://github.com/leinasi2014/dsh-agent-swarm/milestones)
[![official](https://img.shields.io/badge/DSH-0.1.1--rc.2-orange)](docs/OFFICIAL_BASELINE.json)
[![tests](https://img.shields.io/badge/tests-226%20passing-brightgreen)](docs/08-testing-verification.md)

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的**持久化多 Agent 团队编排插件**：崩溃安全的任务协作层——任务 DAG、attempt 围栏、审核门、持久邮箱、预算计量、可执行审查，全部构建在官方服务 seam 之上。

- **不修改 Agent Loop**、不影子注册任何官方服务——单一权威状态经 `TeamDomainPort` 存于官方 Storage Domain（ADR-0007）。
- 消费两个参考仓库的成熟机制（`dsh-agent-teams` 的团队协议、JiuwenSwarm 的预算/审核/调度思路），映射到 DSH 原生边界，不嵌入任何第二运行时。

## 状态

M1–M4 已完成（独立安全/回归审查 PASS），M5 进行中。每个里程碑都有出口报告、tag 与可复现验收：

| 里程碑 | 内容 | tag | 出口报告 |
|---|---|---|---|
| M1 | 崩溃安全协议 + 独立回归审查 + D1 dogfood 开放 | `m1d` | [report](docs/development/2026-08-21-m1d-exit-report.md) |
| M2 | 官方 WorkflowEngine/JobRegistry 桥 + 双 owner 围栏 | `m2` | [report](docs/development/2026-08-21-m2-exit-report.md) |
| M3 | 自托管安全纵切（执行根/可执行审查/晋升回滚演练） | `m3` | [report](docs/development/2026-08-22-m3-exit-report.md) |
| M4 | 预算与验证能力族 | `m4` | [report](docs/development/2026-08-22-m4-exit-report.md) |
| M5 | Workspace 隔离与权限族 | — | 进行中 |

当前基线：226 项测试 / 25 个机器证明场景（docs/08 §7）。

## 安装

```bash
# 在你的 DSH Profile 中组合插件（官方 plugin add 或 Profile yaml）
dsh plugin add leinasi2014/dsh-agent-swarm
# 或在 Profile 中声明：
# plugins:
#   - name: agent-swarm
#     source: npm:@dsh-agent-swarm
```

要求：DSH `0.1.1-rc.2` 世系（`docs/OFFICIAL_BASELINE.json` 为 Gate A 权威基线）。

### 快速开始

```
你（对 captain 说）：建一个三人团队，分解"给仓库加集成测试"并开始执行。
captain（插件驱动）：
  1. agent_swarm_create            → 建团队（captain = 当前会话）
  2. agent_swarm_add_member ×3     → continuable 成员（persona/工具围栏）
  3. agent_swarm_create_task ×N    → 任务 DAG（blockedBy 依赖 + 验收标准）
  4. （调度器自动指派 → 成员执行 → agent_swarm_submit_task）
  5. agent_swarm_review_task       → 你审核 accept/reject
```

完整工具面（17 个 `agent_swarm_*`）：见 [docs/04-core-protocol.md](docs/04-core-protocol.md) §4。

## 核心能力

- **任务板**：DAG 依赖、优先级、revision CAS + attemptId 双围栏（后到者 fail-loud，`TEAM_TASK_STALE_REVISION` / `TEAM_ATTEMPT_STALE`）；
- **审核门**：`submitted` 绝不自行完成——captain `review_task` 是唯一 accept/reject 权威，支持可执行审查（验证命令在隔离审查根执行，证据不可伪造，#101）；
- **持久邮箱**：queued-before-delivered、按消息 ID 目标侧去重、quiet/wakeup 两种语义（wakeup 的 `delivered` 仅在模型可见后提交，#52/D1）；
- **预算**：token/request/retry/deadline 四限 + 官方对齐的完整计费 token 计量（seq 游标幂等，插件账本为唯一计量路径，#127 边界声明）；
- **调度**：事件驱动（idle 边沿/任务图变更/预算释放）、搁浅自愈（live-idle 重试、cold owner 证据暴露）、可替换 Scheduler Provider；
- **编排桥**：官方 `WorkflowEngine`/`JobRegistry` 的 Team 桥（isolate 域注册，run overlay 为唯一 run 真相）、显式 `adaptive|workflow` 模式 + 单 owner 纪律（#77）；
- **执行根**：per-attempt worktree 隔离 + attemptId 围栏 + 崩溃泄漏对账（#100）；
- **自托管控制面**：候选冻结→验收→晋升→回滚的外部 promoter 全链（P0–P7 演练实证，#102/#122 加固）。

## 文档

- [docs/README.md](docs/README.md) — 全部设计文档的阅读顺序索引
- [docs/00-vision.md](docs/00-vision.md) — 产品目标与兼容立场
- [docs/04-core-protocol.md](docs/04-core-protocol.md) — 协议权威（每个决策段都可追溯到 issue/PR）
- [docs/07-implementation-roadmap.md](docs/07-implementation-roadmap.md) — 里程碑与出口标准
- [docs/11-official-first-development.md](docs/11-official-first-development.md) — official-first 开发门（Gate A/B/C）
- [docs/adr/](docs/adr/) — 架构决策记录（ADR-0001..0008）

## 开发

```bash
pnpm install && pnpm verify     # 全链：治理→结构→lint→重复→死导出→类型×2→测试→场景审计→构建→产物
pnpm verify:gate-a              # 官方基线三方核验（remote/checkout/packages）
```

当前采用单检出单写者；候选、审查、串行集成和外部推送边界见 [CONTRIBUTING.md](CONTRIBUTING.md)，项目绑定与权威入口见 [AGENTS.md](AGENTS.md)。

## 许可

MIT（见 [LICENSE](LICENSE)）。

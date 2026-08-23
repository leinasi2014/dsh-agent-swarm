# dsh-agent-swarm

[![verify](https://github.com/leinasi2014/dsh-agent-swarm/actions/workflows/verify.yml/badge.svg)](https://github.com/leinasi2014/dsh-agent-swarm/actions/workflows/verify.yml)

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的**持久化多 Agent 团队编排插件**：崩溃安全的任务协作层——任务 DAG、attempt 围栏、审核门、持久邮箱、预算计量、可执行审查，全部构建在官方服务 seam 之上。

- **不修改 Agent Loop**、不影子注册任何官方服务——单一权威状态经 `TeamDomainPort` 存于官方 Storage Domain（ADR-0007）。
- 消费两个参考仓库的成熟机制（`dsh-agent-teams` 的团队协议、JiuwenSwarm 的预算/审核/调度思路），映射到 DSH 原生边界，不嵌入任何第二运行时。

## 安装状态

本项目目前是 `private` 的预发布插件，**没有已接受的公共 npm、Git shorthand 或插件市场安装入口**。不要使用仓库历史文档中的 `leinasi2014/dsh-agent-swarm` 或 `npm:@dsh-agent-swarm` 形式；它们不是当前可解析的发布身份。

当前可执行的开发/验收路径是本地不可变 tarball：

```powershell
# 1. 在干净、冻结的候选上构建并打包；验收时记录 commit/tree/tarball digest。
$candidateDir = 'D:\path\to\candidate-artifact'
$env:npm_config_ignore_scripts = 'true'
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm pack --pack-destination $candidateDir

# 2. 只装入 fresh isolated DSH_HOME 的官方 web Profile。
$dshCli = 'D:\path\to\official-dsh\apps\cli\lib\bin.js'
$tarball = Join-Path $candidateDir 'dsh-agent-swarm-0.1.0.tgz'
$env:DSH_HOME = 'D:\path\to\fresh-isolated-dsh-home'
node $dshCli plugin --profile web add -w --ignore-scripts $tarball
node $dshCli --profile web --dump-config
```

Profile 还必须组合官方 Storage hub、KV backend、Storage Domain 和 Session persistence，并把 storage/session root 放在 Team workspace 与 sandbox root 之外。当前可执行的冻结与隔离 Profile 验证入口是 `scripts/promotion/freeze.mjs` 和 `scripts/promotion/accept-check.mjs`；[P0 里程碑](docs/07-implementation-roadmap.md#p0--immutable-package-and-real-profile-proof) 要求把安装、启动、卸载、重载和缺存储负向证据绑定到同一 tarball digest，才可把这条路径称为受支持的本地安装。

`link:<path>` 仅用于本地诊断，不能作为验收或发布身份。兼容范围由 `package.json` 的 peer dependencies、锁文件和 [docs/OFFICIAL_BASELINE.json](docs/OFFICIAL_BASELINE.json) 共同定义；不要从 README 中推断滚动版本状态。

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
- [docs/adr/](docs/adr/) — 架构决策记录（ADR-0001..0009；以各文件 `Status` 区分 proposed/accepted）

## 开发

```bash
pnpm install && pnpm verify     # 全链：治理→结构→lint→重复→死导出→类型×2→测试→场景审计→构建→产物
pnpm verify:gate-a              # 官方基线三方核验（remote/checkout/packages）
```

当前采用单检出单写者；候选、审查、串行集成和外部推送边界见 [CONTRIBUTING.md](CONTRIBUTING.md)，项目绑定与权威入口见 [AGENTS.md](AGENTS.md)。

## 许可

MIT（见 [LICENSE](LICENSE)）。

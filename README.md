# dsh-agent-swarm

[![verify](https://github.com/leinasi2014/dsh-agent-swarm/actions/workflows/verify.yml/badge.svg)](https://github.com/leinasi2014/dsh-agent-swarm/actions/workflows/verify.yml)

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的**持久化多 Agent 团队编排插件**：崩溃安全的任务协作层——任务 DAG、attempt 围栏、审核门、持久邮箱、预算计量、可执行审查，全部构建在官方服务 seam 之上。

- **不修改 Agent Loop**、不影子注册任何官方服务——单一权威状态经 `TeamDomainPort` 存于官方 Storage Domain（ADR-0007）。
- 消费两个参考仓库的成熟机制（`dsh-agent-teams` 的团队协议、JiuwenSwarm 的预算/审核/调度思路），映射到 DSH 原生边界，不嵌入任何第二运行时。

## 安装状态

本项目目前是 `private` 的预发布插件，**没有已接受的公共 npm、Git shorthand 或插件市场安装入口**。不要使用仓库历史文档中的 `leinasi2014/dsh-agent-swarm` 或 `npm:@dsh-agent-swarm` 形式；它们不是当前可解析的发布身份。

当前可执行的验收路径是从干净、冻结的插件候选构建一次本地不可变 tarball，再装入 fresh isolated official Profile。命令必须从本仓库运行；`--output` 必须是尚不存在的新目录：

```powershell
$official = 'D:\Source\DSH\deepseek-harness'
$proof = Join-Path $env:TEMP ('dsh-swarm-p0-' + [guid]::NewGuid().ToString('N'))
$candidateCommit = git rev-parse HEAD
$candidateTree = git rev-parse 'HEAD^{tree}'
node scripts/p0/run.mjs `
  --repo (Get-Location).Path `
  --official $official `
  --cli (Join-Path $official 'apps\cli\lib\bin.js') `
  --output $proof `
  --port 47940
node scripts/verify-p0-profile-proof.mjs `
  --root $proof `
  --candidate-commit $candidateCommit `
  --candidate-tree $candidateTree
```

该入口使用官方 CLI 的真实 `plugin --profile web add -w --ignore-scripts <absolute-tgz>` 语法。安装只贡献一个 `disabled: true` 的结构性 `cordis:group`，不会因 `plugin add` 自动启动 Swarm；Profile owner 必须在后一层对 `agent-swarm` 显式设置 `disabled: false` 才会激活其子插件。验收在隔离 `DSH_HOME` 中组合官方 Storage hub、JSON KV、Storage Domain、Session persistence 和 Swarm，且 workspace/sandbox、storage 与 session roots 相互分离。它重启验证默认禁用、显式启用、Swarm service/17 个工具、优雅 unload、reload、R0 再禁用、remove 后清单消失，以及显式启用但缺 Storage Domain 时 fail closed。运行态目录和端口随后清理，只保留同一 tarball、digest、命令回执与证据 manifest；不会读取或写入用户默认 `~/.dsh` Profile。

`dsh plugin`、`--dump-config` 甚至某些帮助路径都可能初始化或修复 Profile，因此不要在用户默认 home 中“试一下”这些命令。[P0 里程碑](docs/07-implementation-roadmap.md#p0--immutable-package-and-real-profile-proof) 只有在上述 evidence gate 与精确候选的非作者审查均通过后完成。

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
- **本机只读 Team 接口（R2 candidate）**：versioned `POST /swarm/v1` 与 browser-safe `dsh-agent-swarm/client`；Host 每次重绑 official live root/Session/workspace/captain Team。该接口仅在 `127.0.0.1` listener、loopback socket 与同源 authority 可验证时可用，不提供用户认证、LAN trust 或任何 write capability；进入公开使用前仍需真实 official Profile 握手和非作者审查。

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

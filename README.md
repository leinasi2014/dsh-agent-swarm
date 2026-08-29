# dsh-agent-swarm

[![verify](https://github.com/leinasi2014/dsh-agent-swarm/actions/workflows/verify.yml/badge.svg)](https://github.com/leinasi2014/dsh-agent-swarm/actions/workflows/verify.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22.19%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的持久化多智能体团队编排插件。

它让主会话保留为 Main Brain，同时为每个团队启动独立 Captain Session。Captain 可以创建成员、拆分任务 DAG、调度执行、审核交付，并通过 DSH 原生侧边工作台向用户展示目标、公告、成员、任务和运行状态。

> 当前状态：活跃开发中的预发布源码。仓库提供构建、测试和打包入口，但尚未发布公共 npm 版本；`package.json` 保持 `private: true`，防止误发布。

## 已实现能力

- **Main Brain 与独立 Captain**：`agent_swarm_create_managed` 从主会话创建独立 Captain Session，主聊天不被团队执行日志取代。
- **团队与成员身份**：Captain/成员可保存名称、职业、性格和安全像素 SVG 头像；成员由官方 continuable subagent seam 承载。
- **任务协作**：DAG 依赖、优先级、revision CAS、attemptId 围栏、定向分派、提交、重派和 Captain 审核。
- **持久运行**：团队聚合写入官方 Storage Domain；成员描述、任务、邮箱、预算和记忆支持重启后恢复。
- **消息与监督**：持久 mailbox、quiet/wakeup 投递、成员中断、预算限制、等待/状态/分页读取。
- **记忆与经验**：团队共享记忆和成员私有记忆使用各自明确的持久化与授权边界。
- **DSH Team 工作台 V3**：团队 rail、公共目标、最新公告，以及“工作台 / 任务 / 公告 / 管理”四个互斥视图；成员和任务使用覆盖式详情页，不挤占主聊天。
- **25 个 `agent_swarm_*` 工具**：完整参数、权限和状态契约见 [docs/04-core-protocol.md](docs/04-core-protocol.md)。

## 架构边界

```text
Official DSH Session / Agent Loop / Subagent
                    │
          agent_swarm_* tools
                    │
        OrchestratorRuntime + Providers
                    │
             TeamDomainPort
                    │
        Official Storage Domain (truth)
                    │
      Host read projection → DSH client UI
```

- 不修改或复制官方 Agent Loop。
- Team aggregate 是唯一业务权威；UI、Prompt 和只读 RPC 都是投影。
- 状态只在持久提交成功后发布。
- 浏览器工作台当前以读取和导航为主；修改团队状态通过 Captain Chat 与受围栏的模型工具完成。
- 官方服务缺失、Provider 未配置或 revision/attempt 陈旧时 fail loud，不静默降级成第二套状态机。

## 快速开始

### 环境要求

- Node.js `^22.19.0 || >=24`（CI 使用 Node.js 24）
- pnpm `9.15.9`
- 与 `package.json` peer dependencies 和 `docs/OFFICIAL_BASELINE.json` 匹配的 DSH checkout/Profile

### 获取源码并验证

```bash
git clone https://github.com/leinasi2014/dsh-agent-swarm.git
cd dsh-agent-swarm
corepack enable
pnpm install --frozen-lockfile
pnpm verify:candidate
```

`pnpm verify:candidate` 会运行结构、边界、lint、重复/死导出、两套类型检查、测试、场景检查、构建和包产物验证。

### 构建预发布 tarball

```powershell
$artifact = Join-Path $env:TEMP 'dsh-agent-swarm-artifact'
New-Item -ItemType Directory -Force $artifact | Out-Null
pnpm build
pnpm pack --pack-destination $artifact
$tgz = (Get-ChildItem $artifact\dsh-agent-swarm-*.tgz | Select-Object -First 1).FullName
```

只把 tarball 安装到新的隔离 `DSH_HOME`/Profile；不要在默认用户 Profile 中试装开发候选：

```powershell
$env:DSH_HOME = Join-Path $env:TEMP ('dsh-swarm-home-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $env:DSH_HOME | Out-Null
dsh plugin --profile web add --workspace-root $tgz
```

Profile 仍需组合官方 Storage hub、KV backend、Storage Domain、Session persistence、Subagent runtime 和实际 LLM Provider。插件不会在安装时自动创建 Team 或启动成员。

## 基本使用方式

在 DSH 主会话中直接描述目标，例如：

```text
创建一个独立交付团队，由队长招募需求分析、实现和评审成员，
把“为项目补齐集成测试”拆成有依赖的任务并开始执行。
```

典型流程：

1. Main Brain 调用 `agent_swarm_create_managed` 创建独立 Captain。
2. Captain 设置团队目标和自身资料，再用 `agent_swarm_add_member` 招募成员。
3. Captain 用 `agent_swarm_create_task` 建立 DAG；调度器按就绪状态分派。
4. 成员提交 fenced attempt；Captain 用 `agent_swarm_review_task` 接受或拒绝。
5. 用户在 Team 工作台查看进度，或打开 Captain Chat 直接调整目标和分工。

## 仓库结构

```text
src/        插件 Host、Client、领域、运行时、Provider 与工具
tests/      单元、组合、重启、故障与 UI 测试
packages/   项目内可复用包
docs/       产品、协议、架构、验证与历史开发记录
scripts/    工程门、隔离生命周期、打包与验收脚本
ref/        固定参考源指针；materialized source 只读
.github/    CI 工作流与 Pull Request 模板
```

## 开发与贡献

```bash
pnpm verify:isolation:status   # 写入、冻结候选和集成前
pnpm test -- <affected-test>   # 迭代期最小受影响检查
pnpm verify:candidate          # 候选冻结门
pnpm verify:policy             # 仅治理/指令/注册文档变化时
pnpm verify:compatibility      # 仅官方或参考兼容性参与决策时
```

开发分支、受管 worktree、审查与串行集成规则见 [CONTRIBUTING.md](CONTRIBUTING.md)。项目权威入口见 [AGENTS.md](AGENTS.md)。

## 文档

- [文档索引](docs/README.md)
- [产品目标](docs/GOALS.md)
- [核心协议](docs/04-core-protocol.md)
- [实现路线与出口标准](docs/07-implementation-roadmap.md)
- [测试与验证](docs/08-testing-verification.md)
- [官方优先开发策略](docs/11-official-first-development.md)

## 已知边界

- 目前没有公共 npm、插件市场或稳定 release 安装身份。
- Browser/Canvas 的 privileged write/control capability 尚未作为公共协议开放。
- 分布式跨进程 CAS、远程成员和自动 Skill Evolution 属后续能力，不应从当前本地运行证据外推。

## 许可

[MIT](LICENSE)

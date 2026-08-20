# dsh-agent-swarm

面向 DeepSeek Harness `0.1.0-rc.8` 的持久化多 Agent 团队编排插件。它吸收 `dsh-agent-teams` 已验证的团队协作机制，并把 JiuwenSwarm 的预算、审核、记忆、可替换调度与分布式 Provider 思路映射到 DSH 原生服务边界；不会嵌入第二套 Python Runtime。

## 已实现的 0.1 核心

- `ctx.agentSwarm` 宿主服务，以及 14 个 `agent_swarm_*` 模型工具；
- Captain、持续型成员、persona/tool-filter 隔离、未完成 provisioning 的失败收敛、有限退休记录复用与卸载回收；
- 任务 DAG、优先级、自动事件调度和可注册 Scheduler Provider；
- task `revision` CAS 与独立 `attemptId` fencing；
- `reserved → delivered` 分配检查点，失败时只回滚本次精确 attempt；
- `submitted → review → completed` 强制审核门，可注册 Review Provider；
- queued-before-delivered 邮箱、按消息 ID 串行派送和进程内重载重试；目标 Session 接收后、Store 确认前的进程崩溃仍可能重复投递；
- request/retry/deadline 预算，以及从 DSH `assistant/message.usage` 按 event seq 去重的完整计费 token（uncached input、output、cache read/write）计量；
- 结构化 Team memory、成员安全移除（同时取消其未投递收发邮件）、Team 归档；
- revision 游标式 `agent_swarm_wait`，无需轮询状态；
- 工作区内原子 JSON Store、完整状态校验、Windows rename 重试；
- 16 项协议测试和 2 项真实 DSH rc.8 组合测试。

## DSH 边界

官方 `packages/experimental/agent-team` 在目标提交中是 `private` 实验包，未发布到 npm；本插件因此使用非冲突的私有兼容 Team backend。目标 rc.8 **已经发布** `ctx.workflowEngine`、`ctx.jobs`、`ctx.tokenMeter`、`ctx.storageDomain` 和 `ctx.workspaceRegistry` 等通用服务。本插件 0.1 尚未接入这些服务：token 目前直接折叠权威 Session usage 事件，工作流桥和正式 Team backend adapter 仍是待实现项，不能描述为已经可替换。当前工作区 JSON 状态存在已确认的权限缺陷；ADR-0007 已把 Storage Domain、Session persistence 和 `TeamDomainPort` 前移为 M1 首要修复，但代码尚未完成。

Worktree、命令审核、Reviewer Agent、远程 Worker、工作流和 UI 属于 Provider/Consumer 扩展。当前插件只提供 Scheduler/Review 注册契约，并可使用满足 continuable、persona、toolFilter 能力的 `ctx.subagents` Provider。官方 `ctx.workspaceRegistry` 管理 Workspace 实体和 Session 归属，但不提供按子成员创建时覆盖 cwd 的 lease；真实 Worktree 隔离仍需远程/独立 Session 组合，或 DSH 上游增加通用的 continuable-child workspace/cwd seam。`writeScopes` 仅为协调提示，不是文件系统授权。

## 自托管开发边界

项目采用 ADR-0008 的分级自举模型。完整 M1D 后才允许在隔离 DSH Profile 中进行 D0/D1 试运行：一个 Lead、只读 Reviewer，以及同一时间最多一个编码写入者，候选仍由人工验收和晋升。并行自我开发需要 M2 Workflow/Jobs 和 M3 自托管安全垂直切片，必须具备真实 per-attempt Worktree/cwd/tool-root 隔离、可执行独立审核、冻结候选、独立 acceptance Profile/RPC 和外部回滚。

稳定控制 Profile 始终运行 last-known-good artifact；不得用运行中的 Profile 原地覆盖、热加载或批准自己的候选。模型使用不因套餐或响应速度被强制收敛，但并发、命令超时、重试循环、磁盘保留、取消和回滚仍作为故障保险。完整设计见 [docs/13-self-hosting-dogfood.md](docs/13-self-hosting-dogfood.md)。

## 目录

```text
.
├── src/
│   ├── domain/              # Team 协议、DAG、状态校验
│   ├── runtime/             # DSH Service、Subagent/Session 生命周期
│   ├── storage/             # 当前 workspace JSON 兼容 Store（M1 将退出默认运行时）
│   └── tools.ts             # 模型工具 Consumer
├── tests/                   # 协议与真实 rc.8 组合测试
├── docs/                    # 架构、协议、ADR、路线图和验证证据
├── ref/
│   ├── dsh-agent-teams/source/
│   └── jiuwenswarm/source/
└── .agents/skills/dsh-plugin-development/
```

## 开发与验证

所有开发先执行“官方优先兼容门”：实时核对官方远端、架构规则、包清单、相关 implemented Agent Notes、目标 exports/types 与实际 Profile 装配；随后才允许把两个参考项目的行为映射为官方 Service 的 Provider/Consumer 或独立策略 overlay。禁止修改 Agent Loop、影子注册官方服务、同时维护两个权威状态机。强制流程见 [docs/11-official-first-development.md](docs/11-official-first-development.md)。

独立安全/架构审查遵循“审查员自治、项目经理只收报告”的治理规则：用户未设置时不得限制审查时长、step、token 或套餐消耗，不得为了响应速度催收敛；全权限必须固定到单独审查 Session 并验证持久权限事件。详见 [docs/12-independent-review-management.md](docs/12-independent-review-management.md)。

开发 Team 采用相同的非微观管理原则：Lead/Workers 自主完成已委托阶段，项目经理只接收权威状态、验证证据和阶段/阻塞报告；稳定控制边界、范围和候选晋升仍由外部管理方所有。

要求 Node.js `^22.19.0` 或 `>=24.0.0`、pnpm，以及用于实际 Profile 验收的 DSH CLI。

```powershell
cd <path-to-dsh-agent-swarm>
pnpm install
pnpm verify:gate-a
pnpm verify

dsh plugin --profile agent-swarm-check add link:D:/Source/DSH/plugin/dsh-agent-swarm
dsh --profile agent-swarm-check --dump-config
```

典型模型流程：

```text
agent_swarm_create
  → agent_swarm_add_member
  → agent_swarm_create_task
  → 自动分配 / agent_swarm_claim_task
  → agent_swarm_submit_task
  → agent_swarm_review_task
  → agent_swarm_archive
```

工具调用的身份来自 `exec.agent`，但 0.1 的 `.dsh-agent-swarm/**/team.json` 仍位于成员可写工作区，prompt 里的“不要编辑”不是安全边界。在 ADR-0007 的 M1 Storage Domain 迁移和真实 sandbox/Profile 验收完成前，不要把当前 backend 用于互不信任的 coding 成员。发生 revision 冲突后调用 status 读取新状态，发生 stale attempt 后旧 Worker 必须立即停止。

## 参考源

两份参考仓库都已完整固定在 `ref/*/source`，不是一个。同步命令：

```powershell
.\ref\dsh-agent-teams\sync-reference.ps1
.\ref\jiuwenswarm\sync-reference.ps1
```

固定 SHA 与证据优先级见 [docs/09-sources.md](docs/09-sources.md)，当前融合度、冲突和优化结论见 [docs/10-fusion-audit.md](docs/10-fusion-audit.md)，总体设计从 [docs/00-vision.md](docs/00-vision.md) 开始。

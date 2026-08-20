# dsh-agent-swarm

面向 DeepSeek Harness `0.1.0-rc.8` 的持久化多 Agent 团队编排插件。它吸收 `dsh-agent-teams` 已验证的团队协作机制，并把 JiuwenSwarm 的预算、审核、记忆、可替换调度与分布式 Provider 思路映射到 DSH 原生服务边界；不会嵌入第二套 Python Runtime。

## 已实现的核心

- `ctx.agentSwarm` 宿主服务，以及 14 个 `agent_swarm_*` 模型工具；
- Captain、持续型成员、persona/tool-filter 隔离、未完成 provisioning 的失败收敛、有限退休记录复用与卸载回收；
- 任务 DAG、优先级、自动事件调度和可注册 Scheduler Provider；
- task `revision` CAS 与独立 `attemptId` fencing；
- `reserved → delivered` 分配检查点，失败时只回滚本次精确 attempt；
- `submitted → review → completed` 强制审核门，可注册 Review Provider；
- queued-before-delivered 邮箱、按消息 ID 串行派送和进程内重载重试；目标 Session 接收后、Store 确认前的进程崩溃仍可能重复投递（M1B 修复项，未实现）；
- request/retry/deadline 预算，以及从 DSH `assistant/message.usage` 按 event seq 去重的完整计费 token（uncached input、output、cache read/write）计量；
- 结构化 Team memory、成员安全移除（同时取消其未投递收发邮件）、Team 归档；
- revision 游标式 `agent_swarm_wait`，无需轮询状态；
- **M1A 权威存储（ADR-0007）**：`TeamDomainPort` 是工具与编排消费的唯一 Team 聚合权威边界；生产 Provider `StorageDomainTeamStore` 通过官方 `ctx.storageDomain` 打开 `agent_swarm` 域，按“每个 Team 一条带版本聚合记录、每个迁移一条持久回执”存储，写入先经官方域写链达到后端持久化、再更新内存并通知等待者；`sessionPersistence` 与 `storageDomain` 为必需注入，任一缺失时插件保持 pending（fail closed），没有 workspace-JSON 或非持久回退；遗留 `FileTeamStore` 仅保留为只读离线迁移读取器与测试 fixture；
- 36 项测试：16 项协议、13 项端口一致性/schema/版本/损坏/关闭/故障注入、5 项迁移（成功、目的非空、非法源、持久化失败、回执不一致）、2 项真实 rc.8 组合（真实官方存储栈 + JSONL 持久化 + continuable 成员 + 调度/审核 + 重载恢复 + 工作区篡改否认）。

## Profile 组合（部署必读）

durable 模式 fail closed：`dsh-storage-domain`、KV 后端与 `dsh-session-persistence` 缺一不可。Bundle patch 只插入 agent-swarm 行；存储栈由部署 Profile 显式组合：

```yaml
- id: storage
  name: '@deepseek-ai/dsh-storage'
- id: storage-json
  name: '@deepseek-ai/dsh-storage-json'
  config:
    # 必须是团队工作区之外的绝对路径（如用户数据目录）；
    # 放进共享工作区会重新引入 F1 威胁。
    root: <absolute-path-outside-team-workspaces>
- id: storage-domain
  name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: json
- id: session-persistence-jsonl
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: <absolute-path>
- id: agent-swarm
  name: dsh-agent-swarm
```

Team 聚合按 captain/member Session 的规范化 cwd（workspace scope）在域内分区；`agent_swarm` 域单元是 json 后端 root 下的一个文件（`<root>/agent_swarm.json`）。存储是进程内的：跨进程 CAS/租约/fencing 属于后续 Store Provider（M7），本插件不作跨进程安全声明。

### 从 0.1 workspace 状态迁移（显式、单向）

```powershell
pnpm build
node scripts/migrate-legacy-team-store.mjs `
  --state-root <workspace>/.dsh-agent-swarm `
  --storage-root <同一部署的 json 后端 root> `
  [--team team-<id>]
```

迁移逐 Team：校验遗留聚合 → 要求目的为空（同 id 记录与同 captain 活跃 Team 均为冲突）→ 经端口持久化写入并读回深比对 → 写入含源文件 SHA-256 的持久回执。重跑对已迁移 Team 是幂等 skip；回执存在而记录缺失判定为目的不一致并中止。遗留源文件永不修改，保留为回滚证据（回滚 = 回退插件版本，旧版读取未动的源文件）。运行时不做任何自动迁移、双写或回退。

## DSH 边界

官方 `packages/experimental/agent-team` 在目标提交中是 `private` 实验包，未发布到 npm；本插件不依赖、不影子注册 `ctx.agentTeams`。官方实验实现（Session-log 权威、target-side 去重、persisted-child 恢复、名字终身不可复用、pending-only 邮箱上限、`disposalTimeoutMs`）是对齐的语义目标，不是生产依赖。目标 rc.8 已发布 `ctx.workflowEngine`、`ctx.jobs`、`ctx.tokenMeter`、`ctx.storageDomain` 和 `ctx.workspaceRegistry`；本插件现已消费 `ctx.storageDomain`（Team 聚合权威）并将 `sessionPersistence` 设为必需注入，工作流桥（M2）、Token Meter 适配器（M3）与官方 Team backend adapter（等待官方包发布）仍是待实现项。

Worktree、命令审核、Reviewer Agent、远程 Worker、工作流和 UI 属于 Provider/Consumer 扩展。当前插件只提供 Scheduler/Review 注册契约，并可使用满足 continuable、persona、toolFilter 能力的 `ctx.subagents` Provider。官方 `ctx.workspaceRegistry` 管理 Workspace 实体和 Session 归属，但不提供按子成员创建时覆盖 cwd 的 lease；真实 Worktree 隔离仍需远程/独立 Session 组合，或 DSH 上游增加通用的 continuable-child workspace/cwd seam。`writeScopes` 仅为协调提示，不是文件系统授权。

## 自托管开发边界

项目采用 ADR-0008 的分级自举模型。完整 M1D 后才允许在隔离 DSH Profile 中进行 D0/D1 试运行：一个 Lead、只读 Reviewer，以及同一时间最多一个编码写入者，候选仍由人工验收和晋升。并行自我开发需要 M2 Workflow/Jobs 和 M3 自托管安全垂直切片，必须具备真实 per-attempt Worktree/cwd/tool-root 隔离、可执行独立审核、冻结候选、独立 acceptance Profile/RPC 和外部回滚。

稳定控制 Profile 始终运行 last-known-good artifact；不得用运行中的 Profile 原地覆盖、热加载或批准自己的候选。模型使用不因套餐或响应速度被强制收敛，但并发、命令超时、重试循环、磁盘保留、取消和回滚仍作为故障保险。完整设计见 [docs/13-self-hosting-dogfood.md](docs/13-self-hosting-dogfood.md)。

## 目录

```text
.
├── src/
│   ├── domain/              # Team 协议、DAG、状态校验、TeamDomainPort
│   ├── runtime/             # DSH Service、Subagent/Session 生命周期
│   ├── storage/             # StorageDomain 生产 Provider + 只读遗留读取器
│   ├── migration/           # 显式单向迁移与持久回执
│   └── tools.ts             # 模型工具 Consumer
├── scripts/
│   └── migrate-legacy-team-store.mjs   # 离线迁移 CLI
├── tests/                   # 协议、端口一致性、迁移、真实 rc.8 组合
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

真实 Profile 装配验收需要 rc.8 世系 DSH CLI 与上文存储栈组合；`--dump-config` 是独立于 `pnpm verify` 的部署门（本仓库如实区分两者）。

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

工具调用的身份来自 `exec.agent`。权威 Team 聚合位于宿主存储域，不在成员可写工作区内；普通工作区写者无法再触达 captain/review/budget/mailbox 状态（组合测试以 decoy 篡改文件证明状态不受影响）。如实声明的边界：这是对“普通工作区写者”威胁的关闭，不是对拥有 unrestricted 宿主权限攻击者的密码学防御——sandbox、文件系统与凭据能力仍是宿主安全边界；存储后端 root 必须配置在工作区之外且不在成员 sandbox 根内，否则保护失效。发生 revision 冲突后调用 status 读取新状态，发生 stale attempt 后旧 Worker 必须立即停止。

## 参考源

两份参考仓库都已完整固定在 `ref/*/source`，不是一个。同步命令：

```powershell
.\ref\dsh-agent-teams\sync-reference.ps1
.\ref\jiuwenswarm\sync-reference.ps1
```

固定 SHA 与证据优先级见 [docs/09-sources.md](docs/09-sources.md)，当前融合度、冲突和优化结论见 [docs/10-fusion-audit.md](docs/10-fusion-audit.md)，总体设计从 [docs/00-vision.md](docs/00-vision.md) 开始。

# 00. Vision and scope

## 1. Goal

`dsh-agent-swarm` 的目标是成为 **官方 DSH 专属的 Team/HumanInteraction 插件化扩展层**：用户安装的官方 DSH 是唯一 Agent Runtime、Profile、Session 与 preset 权威；本插件在不修改 Agent Loop、不引入第二套 Runtime 的前提下，融合 `dsh-agent-teams` 的 durable team protocol 与 JiuwenSwarm 的确定工作流、预算、Worktree、团队记忆、Skill Evolution、审核和分布式 Worker 思路。

最终用户体验应是：

```text
用户给出目标
  → Lead 建立或使用 Team
  → Scheduler/Workflow 选择执行策略
  → Member Provider 启动本地或远程成员
  → Workspace Provider 分配共享目录或独立 Worktree
  → Budget Policy 限制 token、请求、重试和时间
  → Task Run 通过 attempt fencing 防止陈旧写入
  → Review Gate 验证交付物
  → root captain 作为 Human Liaison 处理用户沟通、修正和问题
  → Team Memory 提取决策、经验、成员能力和上下文
  → Host/RPC 投影同一份权威状态与 HumanInteraction receipts
  → DSH-native UI / Canvas-native UI 各自按宿主主题消费同一合同
  → 冻结候选在独立验收 Profile 中启动、验证、晋升或回滚
```

## 2. Architectural position

DSH 的原则不是“有一个 Core，再让插件围绕它工作”，而是连 Agent Loop、LLM、Tool Registry、Session、Workflow 都由插件组合。团队能力也必须遵循同一方式：

```text
Service Definition  声明稳定接口与事件
Service Provider    提供本地、远程、存储、调度等实现
Consumer            提供工具、工作流桥、UI、命令和自动化
Bundle              把推荐组合安装到 Profile
```

`dsh-agent-swarm` 是项目名和未来 Bundle 名，不表示所有代码放进一个 npm 包，也不表示一个独立 Agent Runtime。Swarm 是官方 DSH Session 的可选 Team capability；Canvas 等外部宿主只能通过版本化 Host/RPC 合同消费它，不能成为 Team/HumanInteraction producer。

Architecture work is governed by `11-official-first-development.md`. At the verified rc.8 baseline, Workflow, Jobs, Token Meter, Storage Domain, Workspace and interaction are official stable capability families; the plugin must consume them rather than design parallel equivalents. Agent Team remains private/experimental, so its semantics guide a single compatibility port without becoming a production dependency.

## 3. Compatibility stance

官方 DSH `master` 已有未发布的实验性 Agent Team seam：`ctx.agentTeams`，包括 durable roster、mailbox、task DAG 与 CAS revision。该包位于 `packages/experimental`，官方规则说明实验包不进入正式发行，因此本项目：

1. 以其接口和持久语义作为长期对齐目标；
2. 当前不把 `@deepseek-ai/dsh-experimental-agent-team` 声明为生产 peer dependency；
3. 以 Adapter 隔离当前私有 backend、社区实现与未来可发布的官方 `ctx.agentTeams`；M1A 已完成 `TeamDomainPort` 抽取（工具与编排经端口消费唯一权威，生产 Provider 落在官方 Storage Domain），官方包发布后可在同一端口后替换 Provider 而不产生第二权威；
4. 不重新定义一个同名 `ctx.agentTeams` 服务，避免加载冲突；
5. 新增能力使用独立服务名，例如 Scheduler、Workspace、Budget、Review、Memory Provider Registry。

## 4. In scope

- Team domain adapter and feature detection
- Pluggable scheduling policy
- DSH Workflow bridge
- Task execution attempt fencing
- Worktree / remote-workspace allocation
- Team and task budgets
- Review and verification gates
- Team memory extraction
- Skill evolution signal bridge
- Remote member providers and distributed atomic store
- Captain Liaison、HumanInteraction producer、canonical Host/RPC
- DSH-native UI 与按合同接入的 Canvas 等宿主原生 Consumer
- Lifecycle, replay, failure recovery and real-composition tests
- Stable-control/candidate-acceptance Profile composition for supervised self-hosting

## 5. Out of scope

- Forking or embedding JiuwenSwarm/OpenJiuwen Runtime
- Replacing existing DSH capabilities such as `ctx.subagents`、`ctx.workflowEngine`、`ctx.jobs`、`ctx.tokenMeter`、`ctx.storageDomain`、`ctx.workspaceRegistry` and interaction services; target-version exports must still be verified before integration
- Modifying the DSH Agent Loop for team-specific behavior
- Treating Web UI as the source of truth
- Treating Canvas, transcript parsing, browser caches or a BFF as Team/HumanInteraction authority
- Treating Swarm as a third Canvas engine or maintaining a private DSH home/preset tree
- Requiring one shared React/CSS component library to make unlike hosts visually identical
- Assuming local JSON files provide distributed transactions
- Allowing a model’s “完成了” message to bypass verification
- Sharing one mutable checkout among parallel coding workers without an explicit policy
- Letting a running plugin overwrite, approve or promote its own mutable candidate

## 6. Success criteria

A milestone is complete only when all of these are true:

1. Behavior is mounted through documented DSH extension points.
2. The owning plugin has deterministic disposal and reload behavior.
3. Durable state has a single source of truth and replay/recovery semantics.
4. Task ownership changes reject stale mutations.
5. The assembled Profile passes a real Loader boot test.
6. Model-visible behavior has a keyless snapshot or equivalent assembled transcript test.
7. The feature can be disabled or replaced by changing Bundle/Profile composition rather than patching source.
8. Documentation explains model, token, KV-cache, persistence, security and known limitations.
9. Gate A records the current official remote, implemented direction, exports/Profile evidence, reference mapping and conflict ownership before code begins.
10. Self-hosting follows ADR-0008 readiness gates: stable control and candidate acceptance Profiles are separate, every coding attempt has a real isolated execution root, and promotion is externally owned and reversible.

The current implementation is intentionally smaller than this target. Its accepted historical evidence lives in reports, ADRs, commits/tags and tests; `10-fusion-audit.md` records reference coverage and gaps. Target architecture is never evidence that a capability has shipped.

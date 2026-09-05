# 03. 能力架构

本文件定义当前产品的 capability ownership。具体状态机、错误和并发合同以 [04-core-protocol.md](04-core-protocol.md) 为准；这里不保留历史 milestone 编号。

## 1. 组合图

```text
Official DSH execution plane
  Session + Agent + Subagent + Tools + System Prompt
  Workflow + Jobs + Storage Domain + Settings + Client slots
                              │ consumed by
                              ▼
AgentSwarmRuntime
  ├─ TeamDomainPort ── StorageDomainTeamStore
  │    Team / Captain binding / roster / tasks / attempts / mail / budget
  ├─ orchestration Providers
  │    Scheduler / Review / Workflow bridge / execution root / permission
  ├─ model Consumers
  │    26 agent_swarm_* tools + ordered usage prompt
  ├─ read producer
  │    Host binding → /swarm/v1 read RPC
  └─ client Consumers
       Team Workbench V3 + Plugin Settings
```

`TeamDomainPort` 是 Team 协作的唯一 mutation 边界。Human-interaction overlay、workflow run overlay 和 member-private-memory domain 只拥有自己的关联数据，不复制 Team aggregate。

## 2. 当前实现

| 能力 | 当前 owner / seam | 已实现边界 |
|---|---|---|
| Main Brain → Captain | official Session/Subagent + dedicated captain provisioning | 一个 managed Team 一个独立 Captain；root 留在 Team 外；支持多个 Team |
| Team state | `TeamDomainPort` → `StorageDomainTeamStore` | versioned aggregate、durable commit、显式迁移；legacy file store 只读 |
| 成员 | official continuable subagent provider | 招募/移除/唤醒/interrupt、身份资料、模型 route、durable descriptor |
| 任务 | Team domain + `AgentSwarmRuntime` | DAG、priority、target member、revision CAS、attempt fencing、submit/review/reassign |
| 调度 | Scheduler Provider registry | 默认 priority-ready；adaptive 与 workflow run 保持单一 transition owner |
| 审核 | Review Provider registry | manual、executable commands/templates、review root 与 reviewer boundary |
| 邮箱与等待 | durable Team mailbox + wakeup surface | quota、receipt、quiet/wakeup、bounded wait 与 spin fuse |
| 预算 | Team budget + committed usage fold | token/request/retry 限制、reservation、carry、exhaustion/recovery |
| Skills | `TeamSkillSurface` + `allowedSkills` setting | 三层区分（issue #184）：Team allowed（不可变策略）/ member assigned（招募时子集，持久化+重启重建，进一步收窄 surface）/ Session-visible（官方 scoped catalog，仅可见不等于拥有）；不自动演化 Skill |
| Tools | official tool restriction + plugin permission surface | Captain-only 隐藏、成员 deny-only 收窄、plugin allow/ask/deny setting |
| Memory | Team memory + private-memory domain | 共享分类记忆；成员私有 append-only memory 和独立授权 |
| Workflow/Jobs | official Workflow bridge + caller-scoped jobs projection | 可选、显式启用；唯一 Consumer seam 是 `ctx.agentSwarmWorkflow.start(request)`，仅委托同一 bridge，不提供激活/销毁权限；disabled/unload 时服务缺席，默认官方 `workflowEngine` 不变。`runtime.workflowBridge` 是内部实现细节；jobs 是 read projection，不影子注册官方 producer |
| Execution root | execution-root Provider | 可选 per-attempt 物理 root、capability 声明、settlement 和 residue 告警 |
| Host/RPC | Host read service + `/swarm/v1` | target-bound、bounded、redacted、read-only、loopback/same-origin fail-closed |
| UI | official Client slots / Session navigation / Settings | Workbench、Tasks、Announcements、Management、overlay、Captain Chat、设置页 |

## 3. 模型工具面

当前注册 26 个 `agent_swarm_*` 工具，分为六组：

- Team lifecycle：create/create-managed、identity、goal、announcement、member、archive、interrupt。
- Task board：create、claim、submit、review、reassign。
- Collaboration：send-message、wait。
- Budget and memory：set-budget、shared memory、member private memory。
- Read surfaces：status、managed teams、members、tasks、jobs、memory。
- Policy helpers：运行时按 caller role、live Agent/Session、revision 和 attempt 过滤权限。

工具只暴露 Team 概念，不暴露 Storage key、内部 Session token 或 Provider 私有状态。授权来自 `exec.agent` 和权威绑定；参数中的 id 只是查找条件。

## 4. Host、RPC 与 UI

Host 每次从 live root Agent、Session、workspace scope 和 Team Captain binding 建立读上下文。`/swarm/v1` 只发布严格、版本化的 read envelope；客户端不能上传 principal、Captain Session 或 provenance 来扩大权限。

Workbench 消费同一 read contract：

- Team rail 支持 Main Brain 管理的多 Team 原位切换；
- 公开目标、公告、成员 identity、Skills/tools、任务/attempt、budget 和 activity 都来自权威 projection；
- Captain/member 或 task detail 以 overlay 展示；
- “打开 Captain Chat”调用官方 Session navigation；
- direct browser Team writes 仍 unavailable，不以自由文本或缓存冒充 Control。

Plugin Settings 是独立的官方 Settings Consumer。它配置默认模型、成员 provider/depth、Skills、Scheduler/Review、tool policy、Workflow/Jobs/execution roots 和资源限制；设置在重启后重新组装 runtime。

## 5. 生命周期与失败语义

- `sessionPersistence` 和 `storageDomain` 是 required injection；缺失时插件保持 pending，不降级为易失状态。
- 未知 Provider、无驱动的 workflow mode、非法 Skill/tool policy、stale revision/attempt 和 identity mismatch 都 fail loud。
- 注册、route、listener、timer、waiter、subagent、workflow、storage domain 和 React mount 均由 Cordis effect 或显式 disposer 回收。
- unload 先关闭 admission，再收敛在途事务，最后释放资源。
- Workflow bridge 恢复在局部 store/domain 上完成后才发布；恢复失败按 store → domain 回收，保留原始和清理错误。同域可重试；正在打开资源时的 unload 等待该次 activation 回收，不留下部分激活的句柄。
- legacy Team import 只允许显式单向迁移、空目的地和 durable read-back；不自动迁移、双写或 fallback。

## 6. 尚缺能力

| 缺口 | 所需边界 |
|---|---|
| 公共稳定发布 | immutable package identity、兼容矩阵、upgrade/rollback、发布观察 |
| browser/RPC direct controls | verified human principal、operation-scoped idempotency/read-back、逐 capability 开放 |
| Canvas Consumer | 复用已接受的 RPC schema/fixtures，Canvas 只做宿主原生投影 |
| 远程成员与 distributed store | real remote executor、CAS/lease/fencing、partition/late-ACK/recovery tests |
| 自动 Skill Evolution | accepted evidence → proposal → deterministic validation → approval → write 分权 |
| 发布级 UX/E2E | fresh Profile、多 Team、重启、accessibility、error/reconnect、卸载/升级矩阵 |

缺口不能通过新增 UI 状态、第二 storage、transcript parser 或更宽模型权限绕过。

## 7. 拆包原则

当前实现保持一个 dual-face package。只有出现第二 Provider/Consumer、独立 lifecycle、独立发布价值或 host/client 编译边界时才拆分；目录整齐本身不是理由。未来官方 Agent Team 成为受支持依赖时，也只能在 `TeamDomainPort` 后替换 Provider，不能并存两个可写 Team authority。

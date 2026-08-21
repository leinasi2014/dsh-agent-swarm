# M2-3 design note — explicit orchestration modes and the single-owner discipline (2026-08-21)

状态：issue #77 实现设计（同 PR 交付）。证据基线：本仓 `main @ 9fbc8e1`（#75 桥 + #83 idle 边闩锁之后）；#75 的逐行官方契约分析见 `2026-08-21-m2a-workflow-bridge-design.md`（不重复引用）；规划陷阱 2（共享唤醒/预算面）见 `2026-08-20-m2-planning-note.md` §2.2。本注记只引用本仓代码与 #75 已核对的官方事实。

## 1. 问题：两种驱动面共享一个 Team 聚合

#75 落地后存在两个可以推进同一 Team 的驱动面：

- **事件调度面（adaptive）**：`agent/status → idle` 监听 → `recoverAgent` → `requestSchedule` → 串行 `SchedulingPass`（mailbox 积压 → reserved 折叠 → 搁浅自愈 → 新指派）；外加 `armRekick` 定时器。它以成员空闲边为编排时钟，自主决定"谁接下来做什么"。
- **workflow run 面**：`TeamRun` 经公共运行时面（`create`/`addMember`/`createTask`/`reviewTask`）驱动一个自有 Team，以脚本 DAG 为编排时钟。

#75 让 run 复用调度通路做投递（设计注记 §2.3"不改 scheduling.ts"），两面在缺省配置下是**协作**而非互斥——但协作的前提是没人违反围栏。issue #77 要求把前提变成**显式纪律**：同一 Team 同一时刻只被一个驱动面拥有；并用对抗测试证明即使纪律被绕过，revision CAS / attempt fencing 仍然拒绝后到者、状态零损坏、预算零双计。

## 2. 模式语义（配置面）

新增插件配置 `orchestrationMode: 'adaptive' | 'workflow'`（缺省 `'adaptive'`）：

| | `adaptive`（缺省，零变化） | `workflow` |
|---|---|---|
| `agent/status → idle` 全局监听 | 注册（与 main 逐字节一致） | **不注册** |
| 搁浅自愈 / re-kick | 非 run-owned Team 上启用（与 main 一致；run-owned Team 上被单 owner 纪律停用） | 全局停用 |
| run 的 Team 由谁推进 | 该 run 自己（见 §3 驱动器） | 该 run 自己 |
| `workflowBridge` | 可选（共存） | **必需**——`workflow` + `workflowBridge:false` 在激活时 fail closed（无驱动面存在） |
| 非 run 的 Team（captain 手工工具面） | 事件面 + 操作面 | 仅操作面（每次工具变更触发一次 pass；无自主时钟） |

两条硬约束：

1. **缺省逐字节一致（红线）**：`adaptive` 缺省（桥关）时不存在任何 workflow-owned Team，`eventFaceActive` 恒真，监听注册、`recoverAgent`、heal、re-kick 行为与 `main @ 9fbc8e1` 完全一致。现有全套调度/搁浅/桥测试不改动即须全绿。
2. **fail closed**：`workflow` 模式没有桥就没有驱动面——在构造 runtime 之前拒绝激活（结构化错误，零副作用）。

**"事件调度面停用"的精确定义**（workflow 模式）：不注册 idle 监听驱动的调度 pass（issue 原文），且 pass 内的自主段落（搁浅自愈、re-kick）按模式停用。操作触发的 pass（`createTask`/`reviewTask`/`reassignTask`/`removeMember`/`afterActivation` 显式变更后的一次投递收敛）保留——它们是调用者自己的显式行为，受 revision CAS 围栏，不是自主时钟。`workflow` 模式下非 run Team 的语义因此是"只有操作推动"，如实记录，不是缺陷。

## 3. 单 owner 纪律（运行时所有权注册表）

`AgentSwarmRuntime` 维护进程内注册表 `orchestrationOwners: Map<teamKey, runId>`（teamKey = `scope\0teamId`）：

- `acquireOrchestration(scope, teamId, runId)`：`TeamRun.begin()` 在 Team 创建 + overlay `running` 提交**之后**、`workflow/start` 发布之前获取；他人持有即 `TEAM_ORCHESTRATION_OWNER_CONFLICT`（run 以 `error` settle，零发布）。
- `releaseOrchestration(scope, teamId, runId)`：`settle()` 首个终态路径同步释放（`dispose()` 尾部防御性再释放；runId 守卫幂等）。
- `driveOrchestration(scope, teamId, runId, captain)`：run 自己的调度入口——仅当注册表确认该 runId 持有时才 `requestSchedule`。

纪律的两个执行点：

1. **自主入口让位**：`recoverAgent`（idle 监听与激活恢复共用的真实公共入口）对 workflow-owned Team 跳过末尾的 `requestSchedule`；`SchedulingPass.healStrandedOwnership`（含 re-kick 装填）要求 `eventFaceActive(scope, teamId) := orchestrationMode === 'adaptive' && !workflowOwned`。于是 run-owned Team 上**任何**自主推进都不存在——无论来自全局监听、激活恢复还是 run 自己的驱动器（run 驱动器触发的 pass 同样跳过 heal：heal 是 adaptive 编排决策，不是投递机制）。
2. **run 自带驱动器**：`TeamRun` 为自己的成员 Session 注册 `agent/status → idle` 监听（run 生命周期内，settle/dispose 摘除），成员空闲边经 `driveOrchestration` 只推进自己的 Team。这是"编排由 workflow run 驱动"的机制本体，也是 workflow 模式下 run 的任务指派能落地的原因：`startContinuable` 在 join turn 的 **inbox 接受**时即返回（官方 `ContinuableStart` 契约），`afterActivation` 触发的 pass 常见地撞上 `running` 成员（live-status 过滤按 #12/F10 纪律跳过），全局监听在 workflow 模式又不存在——没有 run 驱动器，任务永远 `pending`。两模式统一：**run 的 Team 只被 run（驱动器 + 它自己的操作）推进**。

为什么 run-owned Team 仍保留操作面 pass：run 的 `createTask`/`afterActivation` 需要一次投递收敛（claim + followup 投递本来就是 `SchedulingPass` 第 4 段）；它们是 run 的显式行为、经 teamKey 串行队列与 revision CAS，不构成第二 owner。captain 手工对 run Team 的操作同理——被围栏拒绝的输家路径由 §5 对抗测试证明。

`createUniqueForCaptain`（roster 的"一 captain 一活跃 Team"）是结构性的第一道互斥：同一 parent 的第二个 run 在 `runtime.create` 处被结构化拒绝（run `error` settle、零发布、零 overlay 记录）。注册表冲突是给未来缝隙的显式契约 + 测试面，不是对既有语义的改动。

## 4. 模式切换语义（决策：接缝处结构化拒绝 + 生命周期边界受控收敛；不提供运行中切换 API）

issue 要求在"拒绝并结构化报错"与"受控收敛"之间论证选择。结论是**分层组合，两者都用，且不新增中途切换面**：

1. **一次激活内模式不可变**（无任何 mutation API——刻意）。Cordis 的配置变更本身就是 fiber 拆卸 + 重新 apply，操作员已有的杠杆就是 dispose/重载，没有必要制造第二个更弱的杠杆。
2. **运行中切换 = 拆卸边界上的受控收敛**（已存在，不新写）：拆卸序里桥先于 runtime（LIFO，#75 已布线）——live run `cancel` → `disposeGraceMs` 内 settle（合成 `cancelled` 端）→ Team 归档；调度 pass 排空；聚合状态持久。重载后：`workflow` 模式把 overlay `running` 证据性重标 `interrupted`（#75 恢复入口，不重驱动）；`adaptive` 模式的事件面直接接管持久 Team。收敛的唯一要求是"旧 owner 停、新 owner 起、无 in-flight attempt"，而唯一能有界保证这一点的位置就是拆卸边界。
3. **不可能组合结构化拒绝**（新增，fail closed）：
   - `orchestrationMode: 'workflow'` + `workflowBridge: false` → 激活前拒绝（无驱动面）；
   - `acquireOrchestration` 冲突 → `TEAM_ORCHESTRATION_OWNER_CONFLICT`（防御性不变量：公开流程下结构性不可达，因为 `createUniqueForCaptain` 先拒绝；注册表把单 owner 契约显式化给未来缝隙与测试）。

**为什么不做运行中收敛式切换**：中途把 run-owned Team 交给事件面（或反向）必须要么杀死 live run（破坏性，等价于拆卸却更弱），要么在 in-flight attempt 上换手（制造 dual-owner 窗口，必须靠 cancel+retry 搅动围栏）——两者都严格劣于"拒绝 + 走拆卸边界"。若未来真需要热切换，前置条件是先设计 attempt 级的 quiescence 契约，那不属于 #77。

已知残余（如实记录，非缺陷）：`workflow` 模式重载后，之前 adaptive Team 的 in-flight 任务没有自主时钟（状态持久、可手工操作推进、切回 `adaptive` 即复活）；run 与 acquire 之间的崩溃窗口（Team 已建、overlay 无记录）留下一个无 owner 的孤儿聚合——overlay 是 run 真相，无记录即无 run，Team 按普通非 run Team 对待。

## 5. 双 owner 对抗测试（本 issue 核心交付，红→绿）

`tests/dual-owner-fencing.spec.ts`（真实组合树：AgentLoop + 官方 durable 栈 + in-process spawn + 桥 + gated/内容感知成员适配器 + followup 间谍）。场景 31（docs/08 §3 新增行）：

1. **并发双驱动的围栏拒绝**（红→绿核心）：run 的成员 assignment turn 被 gate 停住（task `in_progress`、attempt `delivered`、owner=成员）后，后到者从 captain/域两侧同时攻击：
   - 过期 revision 的 claim → `TEAM_TASK_STALE_REVISION`；
   - 当前 revision 的 claim → `TEAM_TASK_NOT_READY`（in_progress 不可再指派——claim 侧的 attempt 围栏）；
   - 非 owner 的 submit（当前 revision + 正确 attempt）→ `TEAM_TASK_OWNER_REQUIRED`；
   - 错误 attemptId 的 submit → `TEAM_ATTEMPT_STALE`。
2. **第二驱动面的真实并发 pass**：同一停驻窗口内，captain 以工具面在同 Team `createTask`（操作入口触发的真实 `SchedulingPass`，与 run 的等待循环并发）——成员恰好收到**一次** assignment 帧（followup 间谍零重复投递 = 唤醒不双发，陷阱 2 的 owner/turn 层幂等在我们缝上的形态），新任务不被塞给 busy 成员。
3. **状态零损坏**：task 单一 `currentAttemptId`、attempts 数组无攻击者产物、revision 单调、run 照常走完（提交→auto-review accept→completed→Team 归档）。
4. **预算零双计（陷阱 2）**：`budget.usedRequests` 恰等于合法就座的 attempt 数（每次 claim 恰计一次请求——CAS 拒绝让第二次就座不可能发生）；`usedTokens` 逐事件等于两个 face（投递路径 + afterActivation 路径）折叠出的成员/captain 会话 `assistant/message` 计费和（`recordSessionUsageBatch` 的 per-seq cursor 幂等，重放不双计）。
5. **同一 parent 的第二个 run**：`createUniqueForCaptain` 结构化拒绝，第二个 run `error` settle 零发布，第一个 run 的 Team 原样。

红→绿证据（PR 正文记录，本地变异、不入库）：分别临时破坏 (a) `team-domain-board.ts` 的 `taskRevision`/`assertCurrentAttempt` CAS、(b) `orchestrationOwners` 门（`eventFaceActive` 恒真）后，对抗测试与模式测试变红；恢复后全绿。围栏语义本身零改动（红线：测试验证它，不是修改它）。

`tests/orchestration-modes.spec.ts`（场景 32）：`workflow`+无桥 fail closed；`workflow` 模式下非 run Team 的成员空闲边之后任务保持 `pending`（无 pass、零 followup、无定时器）；`workflow` 模式下 run 经自有驱动器走完（join turn 停驻 → 放行 → idle 边 → run 驱动器指派 → 提交 → completed）；`adaptive` + 桥开时 run-owned Team 越过搁浅宽限不自愈（对比无门变异变红），且 `acquireOrchestration` 冲突码直接可探。

## 6. 触碰面与泳道避让

- `src/index.ts`（配置 + fail-closed 校验 + 条件监听注册）、`src/runtime/orchestrator-runtime.ts`（注册表 + 门 + `driveOrchestration`）、`src/runtime/scheduling.ts`（`eventFaceActive` dep + heal 门）、`src/runtime/workflow/team-run.ts`（acquire/release + run 驱动器——#75 桥的"开关消费点"，桥本体语义零改动）。错误码 `TEAM_ORCHESTRATION_OWNER_CONFLICT` 为新字符串（`TeamDomainError` 的码面是开放字符串表，`src/domain/error.ts` 无需改动）。
- 不触碰：JobRegistry 泳道的新模块、`frame-visibility.ts`、`message-delivery.ts`、域围栏语义、`docs/reviews/`、`GOALS`、`.agents/`。

## 7. 变更记录（docs/11 §7 格式）

```text
Official remote SHA/date: 141eb6fef83422698aef7a981029e843e8161534 / 2026-08-20（rc.8，未漂移；本 issue 未新增官方契约消费，证据沿用 #75 注记）
Relevant implemented Agent Notes/packages: dsh-subagent（ContinuableStart 的 inbox-acceptance 语义）、dsh-workflow（run 生命周期对照）、dsh-storage-domain
Installed/Profile capability evidence: 沿用 docs/09 既有登记；本变更只消费本仓自有缝（runtime 注册表 + scheduling 门）
Stable / experimental / absent / overlay classification: 模式面=项目自有配置/策略 overlay；调度串行与围栏=既有项目自有；官方 seam 无新增消费
Reference behaviors and failure cases selected: 规划陷阱 2（共享唤醒/预算面不双计）；Jiuwen 显式编排模式作为行为参照（不引其运行时架构）
Canonical state owner: Team 聚合=agent_swarm 域（不变）；run 记录=agent_swarm_workflow overlay（不变）；编排所有权=进程内注册表（run 生命周期附着，不入 durable——overlay 的 running/interrupted 已是 run 真相）
Transition owner and conflict prevention: run-owned Team 的每个迁移仍唯一经域事务（revision CAS + attempt fencing）；自主推进入口按 §3 让位；`TEAM_ORCHESTRATION_OWNER_CONFLICT` 为新增结构化码
Plugin shape: 配置开关（orchestrationMode）+ runtime 策略门 + 桥消费点；无新 Service/Domain
Lifecycle/persistence/security limits: run 驱动器监听随 run settle/dispose 摘除；注册表随 dispose 清空；已知残余见 §4
Migration/rollback: orchestrationMode 缺省 adaptive=行为与 main 逐字节一致；workflow 为纯增量（配置改回即回退）
Unit/conformance/fault/real-composition gates: tests/orchestration-modes.spec.ts、tests/dual-owner-fencing.spec.ts（官方组合树，含变异红→绿证据）
Docs/Skill files updated: docs/04 §8g、docs/08 §3/§7（场景 31/32）、docs/09、docs/10、README、本注记
```

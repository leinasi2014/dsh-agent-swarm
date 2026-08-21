# M2-5 design note — Team budget shared across runs + wake-budget semantics closed (2026-08-22)

状态：issue #79 实现设计（同 PR 交付）。证据基线：官方 DSH `141eb6fef83422698aef7a981029e843e8161534`（rc.8，未漂移，本 issue 未新增官方契约消费，证据沿用 #75/#77 注记）；本仓 `main @ 044d4c0`（#75 桥 + #76/#87 投影 + #77 模式面 + #83/#84 stranded 之后）；规划陷阱 2（共享 wake budget）见 `2026-08-20-m2-planning-note.md` §2.2。本注记只引用本仓代码与已核对的官方事实。

## 1. 问题与红线

#79 的四项要求：(1) 预算生命周期与 run 解耦——同一预算面跨 workflow run / 调度 pass 持续有效（`set_budget` 一次、多个 run 消费），M1B usage 游标 refold 语义延伸到 run 边界（run 结束不重置账本，重载后跨 run 一致）；(2) 规划陷阱 2——唤醒投递的预算消耗归入 Team 预算面单一账本，审计桥层（#75）是否另立计数，若有则收口；(3) 预算耗尽时 run 收敛为终态（结构化 `TEAM_BUDGET_*` 错误 → `error` settle，不悬挂）；(4) 四类测试。

红线：M1B usage 幂等语义本体零改动（只验证/延伸）；#75/#76/#77 已合并行为只消费/收口；预算域 schema 零变化（无新字段——见 §2.4，无需 ADR-0007 版本化）；`docs/reviews/`、`GOALS`、`.agents/` 只读。

## 2. 设计

### 2.1 预算生命周期与 run 解耦：跨 run 结转（carry）

结构性事实：#75 的 run↔Team 生命周期映射是 1:1（run 建队、settle 归档），且 #77 的 `createUniqueForCaptain` 排斥同一 captain 的并发 run。因此"同一 Team 的 budget 跨 run 持续有效"只能落在**同一 captain 的顺序 run 链**上：每个 run 仍是自己的 Team（映射不动），但新 run 建队后、首次 claim 前，把该 captain **最近一个前置 run Team 的最终预算面**（limits + used 计数器整体）原子地结转（adopt）到新账本。`set_budget` 在 run 1 上设一次，run 2..N 消费同一配额的剩余部分——这是 Jiuwen "shared budget spent/remaining across linked runs"（docs/07 M2 fusion）在本仓结构下的实现。

- **来源是纯持久状态**：overlay 的非 `running` 记录（`agent_swarm_workflow` 域）+ 归档聚合（`agent_swarm` 域）经权威端口读取（`snapshot` 的 F14 归档 captain 读路径）。captain 匹配（`captainSessionId`）+ 归档态过滤；`createUniqueForCaptain` 保证新 run 建队时该 captain 的既有 Team 必然全部归档。进程内无任何缓存——重载后结转源不变（测试 4 证明）。
- **`adoptBudget` 域操作**（`src/domain/team-domain-budget.ts`）：单事务 captain 权限校验 + carried 面校验（limits 正整数、used 非负、limits ≥ used，与 `setBudget` 输入同构）+ **只允许落在全新账本**（目标预算面仍是 fresh 默认值，否则 `TEAM_BUDGET_INVALID`）——结转是种子，不是对在途账本的覆盖。与 `setBudget` 一致不 bump revision（预算配置不是板面迁移）。这不是 usage 写入：per-session 游标与 M1B fold 语义零接触。
- **结转跳过条件**：前置预算面等于 fresh 默认（无 limits、零 usage）时跳过（adopt 与 fresh 观测等价，避免每次 run 白写一笔）。
- **失败即建立失败**：结转读取/写入失败（非 `TEAM_UNAUTHORIZED` 的读失败、校验失败）走 #75 既有的 establish 失败路径——run `error` settle 零发布（静默分叉账本更糟）。
- **run 边界的 refold 幂等（验证而非重造）**：run 2 的成员是全新 Session（游标从 -1 起），captain 游标由 `createTeam` 播种在当前最后事件 seq——run 1 已计事件在任何路径下都不可重计；run 内的重载恢复仍走既有 `accountAgentUsage` 游标折返。测试 4 用真实成员事件整批重放 `recordSessionUsageBatch` 证明账本零变化。

### 2.2 唤醒预算单一账本：审计结论（陷阱 2）

**结论：桥层（#75）不存在旁路计数，无需收口，仅有验证性收口（测试）。** 证据：

1. run 驱动的唤醒投递（assignment followup）与 adaptive 驱动的唤醒投递走**同一个** `SchedulingPass.dispatchAssignment`，其前置 `claimTask` 在 `seatAttempt` 里恰好计一次 `usedRequests`（`team-domain-board.ts:129-134`）。两个 face 的差别只在触发 `requestSchedule` 的一方（run 的 ownership-gated idle driver vs 全局 idle 监听/操作入口 pass），不在计费路径。
2. 桥层的计数只有两个：`agentsStarted`（官方事件配对计数）与 executor 的 `started`（AGENT_CAP 回停）——都不触碰预算域。成员 provisioning、auto-review、overlay 写入、`workflow/*` 事件、jobs 投影（#76，只读）均不计费。
3. 规划陷阱 2 的官方语义（`maxConsecutiveWakes`，`tool-jobs/src/index.ts:45`）属于官方 agent-loop 的 owner 唤醒预算，不是 Team 预算面的组成部分；#77 已在 owner/turn 层做投递幂等（每个 frame 恰好一次投递，scenario 31 的 followup 间谍）。本 issue 的职责是证明 Team 侧计量单一：`usedRequests` 恰等于两个 face 合法就座的 attempt 数、`usedTokens` 逐事件恰等于参与方 Session 计费和（测试 2 量化证明；captain 的跨 Team 事件按各 Team 的播种游标天然分流）。

### 2.3 预算耗尽的 run 收敛

缺口（红→绿核心）：run 的 `agent()` 在 `awaitTaskCompletion` 里 park 在 `waitForChange` 上；claim 被 `budgetAvailable` 以 `TEAM_BUDGET_REQUESTS/TOKENS/DEADLINE/RETRIES` 拒绝时，错误被 `requestSchedule` 的 catch 吞成 warn 日志——revision 不变、无事件可醒，run 永久悬挂。

收口路径（复用 #77 的单一 owner 注册表，无新权威）：

1. **路由**：`requestSchedule` 的 catch 在既有 warn 之外把失败交给 `orchestration.notePassFailure(scope, teamId, error)`——注册表内部判定：仅当错误是 `BUDGET_EXHAUSTION_CODES`（四码集合，域词汇表导出；`TEAM_BUDGET_INVALID` 是输入错误不计）中的 `TeamDomainError` 且存在 live run owner 时才路由。无 run owner 的 Team（一切 adaptive Team）与非预算失败保持原样：仅日志，行为逐字节不变。
2. **watcher 生命周期 = ownership 生命周期**：run 在 `acquire` 成功后注册 `watchBudget(runId, handler)`，`releaseDriving`（settle 的终态边 + dispose 的防御路径）摘除——settle 后到达的迟到信号是 no-op。
3. **`TeamRun.failBudget`**：镜像 `cancel` 的终止机制（executor 在下一 hook 边界死亡、in-flight waitForChange 被 run controller abort 打断、`disposeGraceMs` 宽限后 force-settle 兜底、`endStrandedAgents('failed')` 合成配对端），唯一差别是终态 `stopReason: 'error'` 且 `result.error` 携带结构化码（`workflow run stopped by the Team budget gate: TEAM_BUDGET_REQUESTS: …`）。`awaitTaskCompletion` 的 catch 新增 budget 分支（先于 cancel 分支；首个终止源获胜，已 cancel 的 run 不重分类）。executor 的终止状态机从 `cancelled` 单态泛化为 `{error, stopReason: 'cancelled' | 'error'}`（`cancel()` 外部行为逐字节不变，新增 `fail(fatal)`）。
4. **overlay/event 对齐**：`error` 终态提交 overlay（`state: 'error'`），`workflow/end` 恰好一次、error 存在（官方 payload 语义），agent-start/agent-end 保持配对（`failed` 端），Team 按既有 `archiveBounded` 归档——全部是 #75 run 生命周期的既有形态。

### 2.4 schema 决策

预算域零 schema 变化：carry 只读取/搬移既有 `TeamBudget` 七字段，无新字段、无版本 bump、无 `agent_swarm` 域触碰——ADR-0007 的版本冻结约束因此不受触发，无需版本化论证。overlay 记录形状亦不变（结转是聚合内事务，不是 run 记录字段）。

## 3. 测试（真实组合，教训 28/29：`vi.waitFor` ≥15s、用例预算 ≥60s）

`tests/budget-runs.spec.ts`（场景 33，docs/08 §3 新行）——M2-3 modes 组合树 + gated 内容感知成员适配器：

1. **跨 run 连续性**：run 1 park 在 assignment 上时 `set_budget(requestLimit=10)`（run Team 唯一可变窗口），完成后归档 `{requestLimit:10, usedRequests:1}`；run 2（同 captain）建队即继承该面，自身 claim 后 `usedRequests=2`、token 续增——set 一次、多个 run 消费。
2. **唤醒计入单一账本（两 face）**：`parallel` 双 agent 的 run：`usedRequests===2` 且 `agentsStarted===2`（桥层计数=域计数，无第二本账），token 面等于成员+captain 计费事件恰一次；随后同 captain 的 adaptive Team（run Team 已归档，captain 可再建队）：idle 边 pass claim 计 1、wakeup 投递、提交、review accept 后仍 1——pass/heal/review 不加计。
3. **耗尽收敛**：run 1 以 `requestLimit=1` 完成归档；run 2 继承已耗尽账本，首次 claim 被拒 → 15s 内 `error` settle（`result.error` 与 overlay 均含 `TEAM_BUDGET_REQUESTS`）、事件流 `start→agent-start→agent-end(failed)→end(error)` 配对完整、Team 归档——不悬挂。
4. **重载一致**：树 A（固定 captain session id）run 1 完成后优雅拆卸；树 B 同存储根同 captain 重挂——overlay 与归档账本原样可读；run 2 从持久面结转（`requestLimit=5, usedRequests=2`）；用 run 2 成员真实事件整批重放 `recordSessionUsageBatch` 账本零变化（游标幂等跨 run 边界）；完成后总量恰为两 run 之和。

`tests/team-budget-adoption.spec.ts` 场景 33（域单元，真实官方存储栈）：跨 Team adopt（limits+used 整体）、carried 配额被尊重（第 3 个 claim `TEAM_BUDGET_REQUESTS`）、fresh-ledger 门槛、captain 权限、carried 自洽校验。

红→绿证据（本地变异、不入库，PR 正文记录）：临时让 (a) `notifyBudgetExhausted` 变 no-op、(b) `TeamRun.begin` 跳过结转后，测试 3（耗尽收敛，run 2 悬挂到超时）与测试 1/4（连续性，run 2 从零账本开始）分别变红；恢复后全绿。

## 4. 触碰面与泳道避让

- `src/domain/team-domain-budget.ts`（`BUDGET_EXHAUSTION_CODES` + `adoptBudget`）、`team-domain-port.ts`/`team-domain.ts`（端口面）、`src/runtime/orchestration-ownership.ts`（watcher，#77 面的增量）、`orchestrator-runtime.ts`（catch 路由）、`src/runtime/workflow/budget-carry.ts`（新模块，结转解析）、`team-run.ts`（结转调用 + failBudget + budget 分支）、`script-executor.ts`（终止状态机泛化，cancel 行为不变）。
- 不触碰：M1B `recordSessionUsageBatch`/`UsageAccountant` 语义、`scheduling.ts` 的 pass 结构、#75 的 run↔Team 生命周期映射、#76 投影、域围栏、预算 schema、`docs/reviews/`、`GOALS`、`.agents/`。

## 5. 变更记录（docs/11 §7 格式）

```text
Official remote SHA/date: 141eb6fef83422698aef7a981029e843e8161534 / 2026-08-20（rc.8，未漂移；本 issue 未新增官方契约消费，证据沿用 #75/#77 注记）
Relevant implemented Agent Notes/packages: dsh-workflow（run 生命周期/settle 语义对照）、tool-jobs 唤醒预算 note（陷阱 2 的官方侧事实，仅语义对照，不消费其实现）、dsh-storage-domain
Installed/Profile capability evidence: 沿用 docs/09 既有登记；本变更只消费本仓自有缝（域端口 + ownership 注册表 + 桥）
Stable / experimental / absent / overlay classification: 预算面/结转=项目自有；唤醒单账本=项目自有；无官方 seam 新增消费
Reference behaviors and failure cases selected: Jiuwen shared budget spent/remaining across linked runs（行为参照）；规划陷阱 2（不得在桥层另立计数——审计结论：无旁路）
Canonical state owner: Team 聚合=agent_swarm 域（不变，schema 零变化）；run 记录=agent_swarm_workflow overlay（不变）；结转=聚合内事务，无新存储
Transition owner and conflict prevention: adoptBudget 单事务（captain 权限 + fresh-ledger 门槛）；耗尽信号=ownership 注册表路由（run 生命周期附着，settle 后 no-op）；终止源竞争=首源获胜（cancel 先行不重分类）
Plugin shape: 无新 Service/Domain/配置；域端口 + runtime/桥内部增量
Lifecycle/persistence/security limits: 结转源纯持久（重载不变）；failBudget 有界（grace 兜底）；watcher 随 ownership 摘除
Migration/rollback: 行为增量式——无前置 run 时结转为 no-op（首次部署零变化）；无配置开关（#79 是既定预算协议语义，非可选面）
Unit/conformance/fault/real-composition gates: tests/budget-runs.spec.ts（场景 33，四类）、tests/team-domain.spec.ts（场景 33 域单元）；docs/08 §3/§7 同步
Docs/Skill files updated: docs/04 §8h、docs/07 M2、docs/08、docs/10、README、本注记（Skill/docs/reviews/GOALS 按红线只读）
```

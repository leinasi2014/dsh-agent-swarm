# M2-1 design note — Team bridge Provider for the official WorkflowEngine (2026-08-21)

状态：issue #75 实现设计（同 PR 交付）。证据基线：官方 DSH `141eb6fef83422698aef7a981029e843e8161534`（rc.8，本地 checkout 逐文件核对；引用省略前缀 `packages/`）；本仓 `main @ 7cb6dca`；规划陷阱与桥接预研见 `2026-08-20-m2-planning-note.md`。官方行号全部来自 sparse checkout 的源文件，非发布产物。

## 1. 官方 WorkflowEngine 契约逐项分析

### 1.1 Service Definition（`workflow/workflow/src/index.ts`）

| 契约项 | 出处 | 内容 |
|---|---|---|
| 服务挂载 | index.ts:31-34,158-160 | `declare module '@deepseek-ai/cordis'` 增加 `ctx.workflowEngine: WorkflowEngine`；抽象类构造器 `super(ctx, 'workflowEngine')` —— 服务名硬编码在基类 |
| 抽象方法面 | index.ts:168 | 唯一抽象方法 `start(request: WorkflowStartRequest): WorkflowRun` |
| 事件面 | index.ts:36-90,93-100 | 六个 `workflow/*` 事件（`@mode emit`）：`start`（id+meta 快照）、`phase`（标题原样）、`log`（消息原样）、`agent-start`/`agent-end`（按 `agent.seq` 配对；start 未收到 published run 的调用两端都不发）、`end`（result settle 时恰好一次；payload 刻意不含 `value`） |
| 错误面 | index.ts:108-148 | `WorkflowErrorCode` 11 值闭合 union；`WorkflowError extends HarnessError` 携带 `fatal`（默认 true）；`isFatalWorkflowError` 以宿主 `instanceof` 判定（脚本 realm 不可伪造） |
| 生命周期纪律 | index.ts:151-156,175-186 | 无效请求在发布前 throw；live run 归 holder；`result` 永不 reject；取消与 dispose 有界；dispose 在界内等子代清理；监听器失败被遏制（`emitWorkflowEvent` 逐个 try/catch） |

### 1.2 请求/运行/结果类型

- `runtime-types.ts:19-34` `WorkflowStartRequest`：`{ script, meta, args?, subagentProvider?, maxTotalAgents?, parent: Agent, signal? }`——`meta`/`args` 是纯 JSON 数据；`parent` 必填（所有 `agent()` 子代归属它）。
- `runtime-types.ts:40-49` `WorkflowRun`：`{ readonly id, readonly meta, readonly result: Promise<WorkflowResult>, cancel(reason?), dispose(): Promise<void> }`——holder 持有、`dispose()` 幂等。
- `types.ts:63` `stopReason` 闭合 union `completed|cancelled|error`；`types.ts:72-87` `WorkflowResult`（`value` 仅 completed 有意义；`agentsStarted` 在终止路径退化为宿主观测值）；`types.ts:124-131` `WorkflowResultInfo`（end 事件 payload，无 `value`）。

### 1.3 官方不变量伙伴（`workflow/workflow/src/invariant.ts`）

bridge 在有 invariant 服务的树里必须满足：run id/name/description 非空（72-73）、run id 不重复（75）、`agent-start` seq 正整数且 childId 非空（84-87）、`agent-end` 身份与 start 完全一致（40-48）、`workflow/end` 时零未配对 agent（52）、`agentsStarted` 为覆盖全部观测 start 的安全整数（53-55）、`error` 恰好在非 completed 时存在（56-58）。

### 1.4 官方默认实现与组合方式

- 默认 Provider：`workflow/workflow-worker-thread/src/index.ts:112-203` `WorkerThreadWorkflowEngine`（`static inject = ['subagents']`；Config：provider/maxConcurrentAgents/maxTotalAgents/maxItemsPerCall/syncTimeoutMs/disposeGraceMs）。`start()` 同步序：`validateMeta`（META_INVALID，返回归一化副本，`meta.ts:76-82`）→ 宿主侧 parse 检查（SCRIPT_PARSE，`index.ts:64-74`，与 worker 同一 `(async () => {\n…})()` 包装）→ provider 解析（未注册即 AGENT_START，`index.ts:77-89`）→ `maxTotalAgents` 只降不升（INVALID_ARGUMENT，`index.ts:92-104`）→ 铸 UUID → 构造 run → 发 `workflow/start` → `result.then` 发 `workflow/end`。
- run 语义（`host.ts`）：取消在 `disposeGraceMs` 内强制 settle 并 TERMINATE worker（191-204）；`dispose()` 有界等待 result+子代静默（221-252）；`agent-end` 恰好一次的配对门（560-564）+ 终止路径合成 `cancelled` 端（578-582）。
- 脚本 realm（`runtime.ts:100-113`）：冻结 hooks `agent/parallel/pipeline/phase/log` + `args`；取消在**下一个 hook 边界**抛 `CANCELLED`（122-150）；`drive()` 永不 reject（162-187）；并发槽 FIFO（227-247）；`agent()` 选项词表 `label/phase/schema/provider/model`（39-41）；返回值物化失败即 `RESULT_UNSERIALIZABLE`（208-220）；`parallel/pipeline` 普通错误降为 per-item `null`、fatal 传播（400-458）。
- **bundle 组合**：base bundle `bundle/base/cordis.patch.yml:335-341` 组合 `workflow-worker-thread`（`config.provider: spawn`）与 `tool-workflow`；`docs/subsystems/workflow.md:5` 明示**每 context 恰一个引擎实现**（无 provider 注册表，第二引擎以插件配置替换第一个，而非并存）。
- Cordis 服务机制（本地 cordis@4.0.1 源）：`Service` 构造器立即 `ctx.reflect.provide(name, …)`（`src/service.ts:42-59`）；**同隔离域重复注册同名服务直接 throw**（`src/reflect.ts:289-291`）；`ctx.isolate(name)` 提供"不影响父作用域的另一种实现"（`src/context.ts:109-125`）。

### 1.5 能力分类（Gate A）

| 能力 | 分类 |
|---|---|
| `@deepseek-ai/dsh-workflow`（Service Definition + 类型 + invariant 伙伴） | 官方 stable、公开（OFFICIAL_BASELINE.json 已列 public） |
| `@deepseek-ai/dsh-workflow-worker-thread`（默认引擎） | 官方 stable Provider；bridge **不依赖**它（见 §4.3），仅作语义对照 |
| Team 桥引擎（本 PR） | 官方 seam 之上的**项目自有 Provider**：官方抽象类的实现类，注册于 `ctx.isolate('workflowEngine')` 隔离域，绝不占据默认域的 `ctx.workflowEngine` |
| run overlay 存储 | 项目自有（trap 1：官方无嵌套 run 的持久真相，overlay 即唯一真相） |

## 2. Team 桥映射设计（WorkflowRun ↔ Team 生命周期）

### 2.1 生命周期映射表

| 官方 WorkflowRun 侧 | Team 侧（bridge 驱动，captain = `request.parent`） |
|---|---|
| `start()` 同步校验（meta/parse/provider/cap） | 无 Team 副作用；任一失败在发布前 throw（index.ts:151-156 契约） |
| run 建立 | `domain.createTeam(scope, parent.id, name=meta.name, description=meta.description)`；随后 overlay 记录（§3）durable 提交后才发 `workflow/start` |
| `agent(prompt, opts)` | 完整 Team 协议轨迹：`provisionMember`（durable 先行）→ `subagents.startContinuable`（join notice + `memberPersona`，toolFilter 隐藏 captain-only 工具）→ `settleMember active` → 发 `workflow/agent-start`（childId=成员 sessionId）→ `createTask`（subject=label，description=prompt）→ 既有调度通路（`requestSchedule`→SchedulingPass→claim+wakeup 投递）分配 → 成员执行并 `agent_swarm_submit_task` → bridge 以 captain 自动 review（`manual` provider 尊重请求决定）→ 任务 completed |
| agent() 结果 | 任务 `output` 文本（无 schema 支持，见 §4.4）；任务 failed/成员失败 → `null`（官方"子失败降 null"语义） |
| `phase()/log()` | 直接投官方事件（Team 状态不参与；投影方向见下） |
| 事件流 → Team 状态投影 | 方向是 **Team 状态 → 官方事件**：每个 agent() 的成员激活发 `agent-start`，任务终态发 `agent-end`（completed/failed/cancelled 由任务/尝试终态决定）；不反向复制 Workflow 状态进 Team（docs/10 §6 既定） |
| `cancel(reason)` | hook 边界抛 CANCELLED；对 bridge 的 in_progress 任务 `cancelAttempt`（captain）+ interrupt 成员；`disposeGraceMs` 宽限后强制 settle `cancelled` 并为每个已 start 未 end 的 seq 合成 `cancelled` 端（对位 host.ts:578-582）；随后归档 Team |
| run 完成/失败 | `workflow/end`（result settle 时恰好一次）→ overlay 终态提交 → `archiveTeam`（interrupt+drain 成员，受 `disposalTimeoutMs` 界） |
| `dispose()` | cancel + 有界等待（result 与成员静默，grace 界内）+ overlay 终态（若未提交）+ Team 归档；幂等 |
| 进程崩溃 | overlay 的 durable `running` 记录即全部真相；下次激活 `recoverInterruptedRuns()` 把 `running` 重标 `interrupted`（evidence-only，不重驱动——重驱动属 #77/#76） |

### 2.2 关键时序决策：`workflow/start` 在权威提交之后

官方引擎在 `start()` 内同步发 `workflow/start`（worker 构造是同步的）。Team 桥的建队是异步 durable 写，不能阻塞同步 `start()` 返回。决策：**`workflow/start` 在 Team+overlay 双双 durable 提交之后异步发出**（仍在 start() 返回后的微任务/事件轮次内）。依据：AGENTS 规则 6"Publish state only after its authoritative commit"——事件先于记录会导致崩溃窗口里出现无真相的事件。这是对官方时序的**已论证偏离**（不影响任何不变量：invariant 伙伴只约束配对与身份，不约束发射时机；提前注册的监听器仍能收到）。

### 2.3 与调度/模式的边界（#77 泳道）

本桥只通过**既有公共面**驱动任务（`runtime.createTask`/`runtime.reviewTask`/domain port），不改 `scheduling.ts`/`frame-visibility.ts`（#83 泳道）。`adaptive|workflow` 模式选择、双 owner CAS 归 #77；本期桥未注册时**默认行为零变化**（不注册 Provider、不开 overlay 域、不加监听器）。

## 3. overlay 存储决策：独立域 `agent_swarm_workflow`

**决策**：新开独立 Storage Domain `agent_swarm_workflow`（version 1，表 `runs`，键 = runId），由 bridge 单写。

**按 ADR-0007 与官方域语义论证（不进 `agent_swarm` 域的理由）**：

1. **版本戳是硬门且无迁移缝**：官方 `KvFacet.open` 对"medium 上已盖章版本 ≠ descriptor.version"直接 `version-mismatch`（`storage/storage/src/backend.ts:34-35`；`storage-json/src/format.ts:62-67`），子系统文档明示"no migration, pre-release stance"（`docs/subsystems/storage.md:47`）。往 `agent_swarm` 加表要么升 version（拒绝一切已存 v1 medium，摧毁 dogfood Team 状态），要么同版本改声明布局（官方语义未定义的读取）。独立域零影响。
2. **ADR-0007 固定 `agent_swarm` 为 Team 聚合权威**：run 记录是另一种记录族（linkage + run 真相），有自己的 schema 演进节奏；与聚合共用 unit 会让聚合迁移和 overlay 演进互相锁死。
3. **单权威不受损**：`runs` 表唯一写者是 bridge；runId 是键；记录持 linkage（teamId/scope/meta 摘要）与 run 状态。ADR-0007 的"one authority"约束的是 Team 聚合的写者，不禁止同插件多域。
4. **trap 1 对策**：Team 自起 run 无官方 durable 记录（`tool-workflow/src/index.ts:291-294` 嵌套 transport 不写、事件为该包私有），overlay 是**唯一 run 真相**——独立域让"唯一真相"有独立的持久边界与 schema 版本（记录内 `schemaVersion` 字段），不依赖也不复制任何官方 run 存储。

记录形状：`{ schemaVersion: 1, runId, teamId, scope, meta: { name, description }, state: 'running'|'completed'|'cancelled'|'error'|'interrupted', stopReason?, error?, agentsStarted, createdAt, updatedAt, settledAt? }`。

## 4. 实现设计

### 4.1 注册形态：官方抽象类 + 隔离域

- `TeamBridgeWorkflowEngine extends WorkflowEngine`（官方抽象类实现类），构造于 `ctx.isolate('workflowEngine')`——官方机制"a different implementation can be provided without affecting the parent scope"（cordis `src/context.ts:121-125`）。父作用域的 `ctx.workflowEngine` 保持官方 worker-thread 引擎（或无），同树双引擎不冲突（不同隔离域 store key，绕开 `reflect.ts:289-291` 的同名 throw），满足 workflow.md:5"每 context 一个引擎"在各自作用域内成立。
- 事件仍经全局事件总线（`emitWorkflowEvent` 用 `this.ctx.events.dispatch`），官方消费者/invariant 伙伴照常观测——这是"官方 workflow 消费方语义对位"的机制基础。
- 生命周期归属：插件 fiber 拥有该注册；bridge 的 dispose 并入 `AgentSwarmRuntime.dispose()` 链（有界）。
- 入口：插件配置 `workflowBridge: boolean`（默认 **false**——不注册时与 main 行为逐字节一致）。程序化消费经 `runtime.workflowBridge`（#77 的模式选择面将消费它）。

### 4.2 文件布局（均 <600 行门禁）

| 文件 | 职责 |
|---|---|
| `src/runtime/workflow/realm.ts` | 物化器/`renderThrown`（镜像官方 realm.ts 语义：纯 JSON 走查、循环/稀疏/异构原型拒绝、`__proto__` defineProperty 防护） |
| `src/runtime/workflow/script-executor.ts` | 官方语义脚本执行器：vm realm、冻结 hooks、并发槽、AGENT_CAP/ITEM_CAP、取消=下一 hook 边界、`drive()` 永不 reject；`agent()` 委托注入的 `AgentDriver` 端口 |
| `src/runtime/workflow/team-run.ts` | `TeamRun implements WorkflowRun`：建队/装配、agent 驱动（§2.1 全轨迹）、取消/宽限/合成端、dispose 有界、overlay 提交 |
| `src/runtime/workflow/team-bridge-engine.ts` | 引擎类：meta 校验（镜像 `meta.ts` 语义）、parse 预检、provider/cap 解析、隔离域构造、恢复入口 |
| `src/storage/workflow-run-overlay.ts` | `agent_swarm_workflow` 域 spec + overlay store（open/get/list/put/close） |

### 4.3 刻意不依赖 `dsh-workflow-worker-thread`

worker-thread 是**默认引擎包**；桥作为替代引擎必须在不含它的 Profile 里可组合。meta 校验与 realm 物化因此镜像官方语义本地实现（行号已在 §1 引用），差异为零语义、非零实现的复刻，设计注记即对照证据。

### 4.4 已论证的能力裁剪

- `agent({ schema })`：continuable 成员路径不支持 outputSchema（`startContinuable` 请求类型即无此字段），桥以 `UNSUPPORTED_OPTION` 拒绝并注明 Team-bridge 限制（拒绝优于静默忽略）。
- 脚本隔离级别：in-process `node:vm`（每 run 新 context，`instanceof` 伪造免疫与官方一致）+ 同步片 `syncTimeoutMs` 超时；**无 worker 线程终止**——永不 settle 的脚本在取消/dispose 时以 grace 强制 settle run 结果、孤儿续体被遏制（dropped-promise catch）并随引用释放 GC。对位 docs/07 M2 exit"worker-thread 执行是事件循环隔离而非安全沙箱"：桥的隔离更弱一档（同线程），作为已知限制记录。
- `parallel()`/`pipeline()`：语义与官方一致（per-item null vs fatal 传播、item cap）。
- 成员上限：`agent()` 数受 `min(maxTotalAgents 请求/引擎上限, Team maxMembers)` 约束；越界映射为 fatal `AGENT_CAP`。

### 4.5 测试设计（真实组合，教训 28/29：`vi.waitFor` ≥15s、用例预算 ≥60s）

树：`mountAgentLoopTestDependencies` + JsonlSessionPersistence + Storage/StorageJson/StorageDomain + AgentLoop + SubagentService + SubagentSpawn + **官方 `@deepseek-ai/dsh-invariants` + `@deepseek-ai/dsh-workflow/invariant` 伙伴** + swarm 插件（workflowBridge 开）。LLM 用可编程 ScriptedAdapter（按请求内容决定响应：成员收到 assignment 帧时回 tool-call 调 `agent_swarm_submit_task`，参数从帧内 `task_id/expected_revision/attempt_id` 解析）。

1. **run 完成 + 事件流对位**：`bridge.start()` → run id/overlay `running` → Team 建立（域内可读）→ 成员激活→任务 in_progress→submitted→review→completed → `result` resolve `completed`、`value` 为任务 output → 官方 invariant 伙伴全程在场零失败（配对/agentsStarted/error-absent 由官方检查器执行）→ overlay `completed` → Team `archived`。
2. **取消 → 有界关停**：run 进行中 `cancel()` → `disposeGraceMs` 内 `result` settle `cancelled` → 每个已 start 的 seq 恰好一个 `cancelled` 端 → attempt 被 cancel、Team 归档 → `dispose()` 幂等且有界。
3. **崩溃恢复（overlay 重载可读）**：树 A 启动 run 至 `running`；不 settle、不优雅拆卸（进程死亡的等价物：durable 状态留存、进程内状态消失）；树 B 同存储根重挂 → 恢复入口把 `running` 重标 `interrupted`（durable），Team 聚合原样可读，无重驱动。
4. **默认零变化**：`workflowBridge` 缺省时树行为与 main 一致（无 overlay 域打开、`ctx.workflowEngine` 不被占据）。

## 5. 官方消费者语义对位说明（验收项）

| 官方消费者 | 对位 |
|---|---|
| invariant 伙伴（`dsh-workflow/invariant`） | 测试 1/2 直接组合运行，事件流由官方检查器验证 |
| `tool-workflow`（model 工具） | 本期不经模型工具（planning note §1：seam 即公共面）；`#77` 模式面决定何时把桥暴露给工具层 |
| `ui-workflow-run`（client 投影） | 依赖 `workflow/*` 事件总线，桥的事件与官方形状一致（id/meta/seq/childId/stopReason/agentsStarted），投影层无需感知引擎差异；未在本期实测，列为 #77+ 验证项 |

## 6. 变更记录（docs/11 §7 格式）

```text
Official remote SHA/date: 141eb6fef83422698aef7a981029e843e8161534 / 2026-08-20（rc.8，未漂移）
Relevant implemented Agent Notes/packages: dsh-workflow（+invariant 伙伴）、dsh-workflow-worker-thread（对照）、dsh-storage/storage-domain、dsh-subagent
Installed/Profile capability evidence: @deepseek-ai/dsh-workflow@0.1.0-rc.8 npm 可装且导出 ./invariant；base bundle cordis.patch.yml:335-341 组合 worker-thread+tool-workflow
Stable / experimental / absent / overlay classification: seam=官方 stable；worker-thread=官方默认 Provider（不依赖）；Team 桥=项目自有 Provider；run overlay=项目自有（唯一真相）
Reference behaviors and failure cases selected: Jiuwen 确定性工作流映射（官方 script DSL）；官方 host/runtime 的取消/配对/宽限失败面
Canonical state owner: Team 聚合=agent_swarm 域（不变）；run 记录=agent_swarm_workflow 域（bridge 单写）
Transition owner and conflict prevention: run 的每个状态迁移唯一由 TeamRun 驱动；#77 前桥不接管任何默认调度
Plugin shape: Provider（官方抽象类实现，隔离域注册）+ Storage Domain + 插件配置开关
Lifecycle/persistence/security limits: in-process vm 隔离（弱于 worker，§4.4）；dispose 有界；overlay durability-before-publication
Migration/rollback: workflowBridge=false 即回退（零残留：域为空时仅新文件）
Unit/conformance/fault/real-composition gates: tests/workflow-bridge.spec.ts（官方 invariant 在场）
Docs/Skill files updated: docs/04 §8f、docs/07 M2、docs/09、docs/10、README、本注记
```

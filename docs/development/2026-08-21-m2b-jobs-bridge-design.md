# M2-2 design note — Team 桥 JobRegistry + 只读状态投影 (2026-08-21)

状态：issue #76 实现设计（同 PR 交付）。证据基线：官方 DSH `141eb6fef83422698aef7a981029e843e8161534`（rc.8，本地 checkout 逐文件核对；引用省略前缀 `packages/`，官方行号来自 sparse checkout 源文件）；本仓 `main @ 9fbc8e1`（含 #75）；#75 先例：`2026-08-21-m2a-workflow-bridge-design.md`（隔离域注册模式、overlay 域决策、fail-closed 纪律）。

## 1. 官方 JobRegistry 契约逐项分析

### 1.1 Service Definition（`jobs/jobs/src/index.ts`）

| 契约项 | 出处 | 内容 |
|---|---|---|
| 服务挂载 | index.ts:29-33,62-71 | `declare module '@deepseek-ai/cordis'` 增加 `ctx.jobs: JobRegistry`；抽象类构造器 `super(ctx, 'jobs')` —— 服务名硬编码在基类；直接实例化抽象类在构造器内 throw（index.ts:67-69） |
| 抽象方法面 | index.ts:82-176 | 九个抽象方法：`start`/`list`/`get`/`read`/`kill`/`wait`/`onJobDone`/`onJobsChanged`/`attachController` |
| 生产者推模型 | index.ts:82,types.ts:46-69 | `start(spec)` 携带生产者 `run(): JobHooks` —— **job 由生产者注册驱动 work**，registry 拥有身份/访问/生命周期状态，生产者拥有执行资源 |
| 归属与访问 | index.ts:47-49 | owned-job 按 owner session id 围栏；"authorization — not secrecy — is the boundary"；id 可预测（`<kind>-N`） |
| settle 语义 | index.ts:49-53 | first-wins：恰好一条终态记录、释放 waiter、一轮受控 listener 通知；完成通知最后发（记录已提交且其它观察者已见） |
| 准入门 | index.ts:54-60 | `start` 在无 controller 服务该 owner 时拒绝工作 |
| owner 相对性 | index.ts:57-60 | 一个 registry 服务进程内所有组合；listener/controller 的送达按注册 context 的 scope 分层（global layer + owner 链） |

### 1.2 类型面（`jobs/jobs/src/types.ts`、`brand.ts`）

- types.ts:17 `JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'`；`stopping` 仅出现在取消请求后（kill/teardown），非独立调度态。
- types.ts:23-29 `JobKindMap`（默认 `bash`/`subagent`）**merge 可扩展**——官方测试消费方以包根 `declare module '@deepseek-ai/dsh-jobs' { interface JobKindMap {…} }` 扩展（jobs-local `tests/jobs.spec.ts:12-16`），registry 把 kind 当不透明 id 命名空间。
- brand.ts:19-28 `JobId = Branded<'JobId'>`，registry 生成 `<kind>-N`。
- types.ts:46-91 `JobStart`/`JobHooks`：`cancel` 同步幂等、`done` 永不 reject、可选 `readOutput`（流式 vs 终态输出型）。
- types.ts:97-128 `JobSnapshot`：fresh 只读投影；`finishedAt` 恰在终态出现；`reported` 抑制重复完成通知（kill/read/wait/teardown 认领）。
- types.ts:130-140 `JobRead`：终态输出型 job live 时 `text` 为空、settle 后幂等返回 `output`。

### 1.3 官方不变量伙伴（`jobs/jobs/src/invariant.ts`）

快照跨字段校验（invariant.ts:17-43）：id 必须 `<kind>-` + 正整数序号；label 非空；`startedAt` 非负 epoch；`finishedAt` 恰在终态出现且 `>= startedAt`；`ownerSession` 与完成通知的 owner `Agent?.id` 全等。安装方式（invariant.ts:46-49）：`ctx.jobs.list()` 现存记录 + `ctx.jobs.onJobDone` 终态流，`inject: ['jobs']`。

### 1.4 官方默认实现与组合方式

- 默认 Provider：`jobs/jobs-local/src/index.ts:91` `LocalJobRegistry`——进程内 store、fresh snapshot、`ScopedLayers` 按 scope 分层 controller/listener、owner 清理经 `agents` 精确实例校验（index.ts:448-463）、teardown 先关 listener 再 cancel+await+清空（index.ts:481-500）、throwing cancel 强制 fail 单条记录（index.ts:507-531）。
- **`start()` 是唯一注册入口**：preflight（controller 服务该 owner、kind/label/outputLimit 校验、每 owner 活跃上限）→ 同步调用 `spec.run()` 取 hooks → 登记 → `hooks.done.then(settle)`（index.ts:131-190）。
- 组合：jobs 是"每 context 恰一个实现"（index.ts:38-40 明示第二实现以标准 duplicate-service throw 拒绝）；Cordis `ctx.isolate('jobs')` 提供"不影响父作用域的另一实现"（cordis `src/context.ts:109-125`，#75 §1.4 已核）。
- 模型消费方 `jobs/tool-jobs/src/index.ts`：`job_list/job_get/job_read/job_kill/job_wait` 工具族消费 `ctx.jobs`（属 #77+ 模式面的对接对象，本期不接模型工具）。

### 1.5 能力分类（Gate A）

| 能力 | 分类 |
|---|---|
| `@deepseek-ai/dsh-jobs`（Service Definition + 类型 + invariant 伙伴） | 官方 stable、公开（OFFICIAL_BASELINE.json 已列 public，evidence 含 `2026-07-26-job-registry-seam.md`） |
| `@deepseek-ai/dsh-jobs-local`（进程内默认 Provider） | 官方 stable Provider；桥**不依赖**它（对照物） |
| Team 桥 JobRegistry（本 PR） | 官方 seam 之上的**项目自有 Provider**：官方抽象类的实现类，注册于 `ctx.isolate('jobs')` 隔离域，绝不影子默认域 `ctx.jobs` |
| job 投影存储 | **无**——投影是纯派生内存状态，权威全在 `agent_swarm` 域的 Team 聚合（与 #75 的 overlay 决策相反且理由相反：#75 的 run 无官方 durable 真相故 overlay 即真相；本期 task 状态已有唯一 durable 真相，任何第二存储都会制造双权威） |

## 2. 映射表：job 生命周期 ↔ task/attempt 状态机（先行交付物）

方向声明：**Team 聚合 → job 面**，单向。job 记录是 Team 任务板的派生投影；job 面上的任何调用不写 Team 权威（§3）。

### 2.1 状态映射

| Team 侧（权威，`src/domain/types.ts:30-89`） | job 投影侧（派生） | 依据/说明 |
|---|---|---|
| task `pending` 且无任何 attempt（从未被认领） | **无 job 记录** | 官方 job 语义是"正在执行的后台工作"；待认领任务不是执行工作，留在任务板面（`agent_swarm_list_tasks`） |
| task 首次 `in_progress`（attempt `running`，assignment `reserved`→`delivered`） | job 记录创建：`status='running'`、`startedAt`=该 task 全部 attempt 的最早 `createdAt`、`kind='team-task'`、`label`=task.subject | 认领即执行开始；`startedAt` 取 attempt 创建时刻使重建与实时派生同值（确定性） |
| task 保持 `in_progress` 经历就地重试（`retryAttempt`：旧 attempt `stale` + 同 owner 后继 attempt，issue #83） | job 保持 `running`，**不产生新 job、不 settle** | attempt 世代内化：job 面对 task 粒度投影，重试是任务内部世代更替 |
| task `submitted`/`verifying`（attempt `submitted`/`verifying`，等船长裁决） | job 保持 `running` | Team 协议的最终裁决未落；官方 `stopping` 语义是"取消已请求"，不可挪用 |
| 船长 review **reject** → task 回 `pending`（attempt `rejected`，执行清空，retry 预算 +1，`team-domain-board.ts:288-299`） | job 保持 `running`（task 已有 attempt，谓词仍真） | 同一逻辑工作未完成；重认领会以新 attempt 继续同一 job |
| 重认领（reject 后再次 claim → 新 attempt `running`） | job 保持 `running`（同上） | job 与 task 一对一；attempt 失败/重试循环整个内化 |
| task `completed`（attempt `accepted`） | job settle `'completed'`：`output`=task.output、`finishedAt`=task.updatedAt、`detail` 携带 task/attempt 关联 + 接受诊断 | 首个观察到的 live→终态迁移才发 `onJobDone`（§3.3） |
| task `failed`（词表值；当前域转移未产生，预留给预算耗尽等终局路径） | job settle `'failed'`：`detail` 携带终局 attempt 的 diagnostic | 前瞻映射，与 `completed`/`cancelled` 同构 |
| task `cancelled` 且有 attempt（执行中 `cancelAttempt`，或归档时清场 `archiveTeam` 将非终态任务置 `cancelled`，`team-domain-roster.ts:273-284`） | job settle `'killed'`：`detail` 携带取消诊断 | 官方 `killed` = "cancelled"结局（types.ts:34） |
| task `cancelled` 且无 attempt | **无 job 记录** | 从未执行即取消；无工作可投影 |
| Team 归档（`archived`） | 不改变已终态 job；归档清场产生的 `cancelled` 任务按上表 settle `killed` | 投影镜像权威清场语义 |

### 2.2 attempt 重试与 job "重试"的边界（红线判断）

官方 `JobRegistry` 契约（§1.1-1.2）里 **job 没有重试概念**：`JobStatus` 终态封闭、settle first-wins 且不可逆、id 一次性。因此"job 重试"唯一可能的含义是经 job 面重新驱动工作——即 `start()`/`kill()` 具备写权威的通路。本桥的判断：

1. **job 是投影，不是驱动器**。官方契约的生产者推模型（`start(spec.run)` 注册生产者 hooks）与"job 面只读投影权威 Team 聚合"不兼容——桥无法为任意 Team 任务合成一个诚实的生产者（工作资源属成员 Subagent，不属桥）。
2. **投影单向性是红线**：`start()` 与 `kill()` 是 job 面仅有的两个写通路（注册工作 / 取消工作），两者都必须拒绝（§3.2），否则 TeamDomainPort 单权威被绕过（船长取消经 `cancelAttempt` 的 CAS+围栏语义会被 job 面旁路）。
3. attempt 失败重试完全属于 Team 面（`retryAttempt`/review-reject 循环），投影只保证 job 在整个循环期间持续 `running` 并随任务终态收敛——这就是"投影随任务终态收敛"的验收含义。

### 2.3 观察缝：官方 `domain/changed` 事件（无轮询、无私有钩子）

- 投影刷新挂在官方 Storage Domain 事件 `domain/changed`（`storage-domain/src/events.ts:41-51`：每次 durable 写在 backend 确认持久后恰好发一次，`put` 携带**新快照全值**；`storage-domain/src/domain.ts:249-261` 观察者失败被遏制）。过滤 `domain='agent_swarm' && table='teams' && operation='put'` 即得"Team 聚合提交后"的派生时机——天然满足"Publish state only after its authoritative commit"。
- 事件携带 `{ workspace, team }` 全值，故无需 per-team `waitForChange`（那需要成员 actor 围栏，桥不是成员）也无需探测 scope。
- 每团队维护 `lastDerivedRevision`：迟到/乱序快照（revision 更低）直接丢弃——派生是全量重算（幂等），旧快照重放不会回退投影。
- scope 发现：`runtime.create()`（船长建队）与 `runtime.recoverAgent()`（激活恢复）通知桥 `watchScope(scope)`（种子重建 + 锁定该 scope 的后续事件）；程序化消费方（测试、#77 模式面）可直接 `runtime.jobsBridge.watchScope(scope)`。未 watch 的 scope 不投影（scope 是存储分区键，桥不猜测）。

### 2.4 崩溃恢复：投影重建语义

投影是进程内派生状态（同官方 LocalJobRegistry 的内存 store——registry 记录本就不跨进程存活）。恢复 = **从权威聚合全量重导**：

- `watchScope(scope)` 种子：`store.list(scope)` 逐 Team 全量派生（含终态任务——`finishedAt`/`startedAt`/`output` 全部取自聚合字段，重建值 = 实时值，确定性成立）。
- 重建的终态记录**静默登记**（发 `onJobsChanged`——可见集确实变了；**不发 `onJobDone`**——该 job 未在本 registry 实例前发生 live→终态迁移，伪造 settle 通知违反 first-wins 语义）。
- 进程死亡等价物（#75 测试 3 的方法）：durable 聚合留存、进程内投影消失；树 B `watchScope` 后投影与聚合逐字段一致，无重驱动（投影只读，结构上不可能重驱动）。

## 3. 投影单向性：契约面逐方法的裁剪决策

### 3.1 完整实现（语义对齐官方 LocalJobRegistry）

| 方法 | 行为 |
|---|---|
| `list(caller?)` | 注册序返回全部快照（投影记录全部 unowned，见 §4.4——任何 caller 可见；fresh 对象） |
| `get(id, caller?)` | 非消费快照；未知 id throw `unknown job` |
| `read(id, caller?)` | 终态输出型（无 `readOutput`）：live 时空文本，settle 后幂等返回 `output`；终态 read 置 `reported` |
| `wait(id, timeoutMs, caller?, signal?)` | settle/超时返回快照、不取消；caller abort 仅在 live 时 reject；终态返回置 `reported`；正有限 timeout 校验 |
| `onJobDone(listener)` | effect-scoped 受控送达（throw/reject 被遏制+记日志）；只在观察到的 live→终态迁移发（§2.4）；dispose 后不再送 |
| `onJobsChanged(listener)` | effect-scoped 受控；记录创建、settle、dispose 清空时通知（owner 恒 `undefined`） |
| `attachController(name)` | 登记 token + 返回 disposer（契约面完整性；`start` 恒拒故 controller 仅存在性意义） |

### 3.2 拒绝面（已论证偏离，fail-loud 而非静默）

| 方法 | 行为 | 论证 |
|---|---|---|
| `start(spec)` | 一律 throw（消息指明 Team 面创建路径） | 红线：job 面注册工作 = 写权威。官方 `start` 本就有拒绝语义（无 controller 服务 owner 时拒绝，§1.4），拒绝是契约内行为；消息 fail-loud 指引正确入口（`agent_swarm_*` 工具 / `TeamDomainPort`） |
| `kill(id, …)` | 一律 throw（取消经船长 `cancelAttempt`） | 红线：转发取消 = 写权威；投影内伪造 `stopping` 态 = 撒谎（权威里没有对应迁移）。官方 `kill` 契约的 throw 面（unknown/foreign job）在此扩展到全部投影记录——**判断性偏离**，消息说明 Team 面路径 |

### 3.3 settle 语义（first-wins 对齐）

- 观察到任务终态的 put → 记录置终态（first-wins：已终态记录忽略后续派生）→ 释放全部 waiter → `onJobsChanged` → `onJobDone`（最后，且仅当此前非终态）。
- `reported` 由 kill（不可能，恒拒）/read/wait 终态返回置位——waiter 在场时 settle 即置 `reported`（对齐 jobs-local index.ts:422）。
- dispose：不再送 `onJobDone`；`onJobsChanged` 收到一次清空通知（对齐 jobs-local disposeAll 的 emptying 通知）；在途 waiter 以 disposal 错误 reject；**不 settle 记录**（权威 Team 可能仍活着——桥关停不等于任务死亡，与 local provider 的"teardown cancel 活工作"相反且必须相反：那是对自己注册的生产者，这里是别人的权威）。

## 4. 实现设计

### 4.1 注册形态：官方抽象类 + 隔离域（对齐 #75 §4.1）

- `TeamJobProjection extends JobRegistry`，构造于 `ctx.isolate('jobs')`——官方机制提供"不影响父作用域的另一实现"；父作用域 `ctx.jobs`（官方 local registry，组合时）不被占据，同树双 registry 各在各自隔离域成立。
- 生命周期：插件 fiber 拥有注册；dispose 并入 `apply()` 的 effect 链（注册于 runtime disposal effect 之后 → LIFO 先于 store 关闭拆卸）。
- 入口：插件配置 `jobsBridge: boolean`（默认 **false**——不注册时零行为差异）；程序化消费经 `runtime.jobsBridge`（镜像 `runtime.workflowBridge`）。与 `workflowBridge` 相互独立（job 投影不依赖 #75 桥；一致性测试同时开启）。

### 4.2 文件布局（<600 行门禁）

| 文件 | 职责 |
|---|---|
| `src/runtime/jobs/team-job-projection.ts` | `TeamJobProjection extends JobRegistry`：九个抽象方法、watch/dispose、事件订阅、reconcile |
| `src/runtime/jobs/projection-derive.ts` | 纯派生函数：`TeamState` → 该 Team 的期望记录集（§2.1 谓词的字面翻译）+ 快照构造 |

### 4.3 派生与 reconcile

- 记录字段：`{ id, teamId, taskId, label, status, detail, output, startedAt, finishedAt?, reported }`；`byTask: Map<teamId+\n+taskId>` 定位；`<kind>-N` 序号 = registry 实例内单调计数（重导可能重排序号——id 是 registry 实例句柄而非权威身份，task 关联在 `detail` 与 `byTask`，已在 §2.4 论证）。
- 每条 `domain/changed`（watched scope）→ `derive(team)` 全量重算该 Team 期望集 → 与现存记录 reconcile（缺失登记、终态 settle、first-wins 忽略回退）。
- `watchScope` 种子经 per-scope 串行链（种子中的并发事件因 revision 守卫无损）。

### 4.4 unowned 决策与访问模型

投影记录一律 **unowned**（`owner: undefined`，`ownerSession` 缺席）：

1. 官方 owner 语义绑定"精确存活 `Agent` 实例 + agent disposal 取消工作"（types.ts:53-58、jobs-local index.ts:448-463）——投影的任务工作属成员 Subagent 会话，桥无法诚实拥有；绑船长则成员侧不可见，绑成员则船长侧不可见，都制造假围栏。
2. 官方围栏的威胁模型是"同进程其它组合的模型工具越权读 label"；本 registry 在隔离域，可达性已由持有 `runtime.jobsBridge` 的程序化消费方限定（#77 模式面接模型工具时再决定 owner 面）。
3. invariant 伙伴对 unowned 的期望（`ownerSession` 缺席且完成 owner `undefined`）自洽（§1.3）。
4. 成员/任务关联走 `detail`（`task task-N (attempt a-M)` + 终局诊断），不滥用 `ownerSession` 作关联字段。

### 4.5 kind 扩展

`declare module '@deepseek-ai/dsh-jobs' { interface JobKindMap { 'team-task': 'team-task' } }` —— 官方 merge 机制（§1.2），job id 形如 `team-task-3`，invariant 伙伴的前缀校验按 kind 动态前缀匹配（invariant.ts:19-24），自洽。

### 4.6 官方 invariant 伙伴的组合事实（对位说明）

`@deepseek-ai/dsh-jobs/invariant` 的 installer `inject: ['jobs']` 在 **invariants 服务自己的 owner context** 下解析（`runtime-diagnostics/invariants/src/index.ts:172,178-181`——`register` 用 `this.ownerCtx` 建子插件）。让官方检查器跑在本桥投影上需要两级已实测的组合事实（worktree 内最小复现脚本逐项验证）：

1. Cordis 对同 store 的重名 provide 直接 throw（`reflect.ts:289-291`；isolate 只隔离单一键）——在桥 context 下直接挂第二个 InvariantRegistry 被拒；必须先 `bridgeCtx.isolate('invariants')` 再挂。
2. 在本插件参与的树里，官方伙伴以 namespace plugin 形态 `ctx.plugin(JobsInvariant)` 挂载后其 apply 拿不到已声明的 `invariants` 注入（"cannot get property without inject"，fiber store 未接线；哑插件树可复现差异）；改用官方 `ctx.inject(['invariants'], c => JobsInvariant.apply(c))` 惰性作用域载体后注册与 installer 均正常完成。

最终组合：`bridgeCtx.isolate('invariants')` 下挂第二个 InvariantRegistry，经 `ctx.inject` 载体运行官方伙伴——该子树解析 `invariants` → 第二服务、`jobs` → 桥投影（隔离键链：root → isolate('jobs') → isolate('invariants')）。测试侧另以 `expectOfficialSnapshotShape` 镜像 invariant.ts:17-43 的跨字段断言保证可观测性（受控 listener 内的 InvariantError 会被遏制进日志）。此组合事实记入 docs/09。

### 4.7 已论证的能力裁剪

- `readOutput`（流式）：不支持——任务板无流语义；终态输出型（官方词表内的合法形态，types.ts:135-137）。
- `outputLimitBytes`：投影不设（生产者字段；截断策略属 #77+ 模型工具面）。
- `stopping` 态：结构上不可达（唯一入口 `kill` 恒拒）——词表值合法缺席，invariant 伙伴不校验 stopping 的存在性。

## 5. 测试设计（真实组合，教训 28/29：`vi.waitFor` ≥15s、用例预算 ≥60s）

树（复用 #75 harness）：`mountAgentLoopTestDependencies` + JsonlSessionPersistence + Storage/StorageJson/StorageDomain + AgentLoop + SubagentService + SubagentSpawn + 官方 invariants +（jobs 用例额外）`bridgeCtx` 下第二 InvariantRegistry + 官方 `@deepseek-ai/dsh-jobs/invariant` 伙伴 + swarm 插件（workflowBridge + jobsBridge 同开）。成员用内容驱动 ScriptedAdapter（复用 #75 的 assignment-frame 应答）。

1. **双面一致性 + 终态收敛**：`bridge.start()` 一个 run → 官方 workflow 事件流出现 `agent-start`/`agent-end`；同一时刻 `runtime.jobsBridge.list()` 出现 `team-task-1` 且经 `running` 收敛 `completed`；`agent-end.outcome='completed'` ⟺ job `status='completed'` 且 `read().text` = 任务 output = workflow `settled.value` 的成员输出；两官方面（workflow 事件 + jobs invariant 伙伴在场）零失败。
2. **取消路径映射**：run 进行中 `cancel()` → 任务经 `cancelAttempt` 置 `cancelled` → job settle `killed`（非 `failed`）、`finishedAt` 存在；`start/kill` 拒绝面断言（throw 且消息指向 Team 面）。
3. **崩溃恢复重建**：树 A 建队至任务 `in_progress`（job `running`）→ 不优雅拆卸；树 B 同存储根重挂 → `jobsBridge.watchScope(scope)` 种子重建 → 投影与聚合逐字段一致（`running`，`startedAt` 同值）、无 `onJobDone` 伪造、无重驱动。
4. **默认零变化**：`jobsBridge` 缺省 → `runtime.jobsBridge` undefined、默认域 `ctx.jobs` 不被占据、无行为差异。

## 6. 官方消费者语义对位说明（验收项）

| 官方消费者 | 对位 |
|---|---|
| invariant 伙伴（`dsh-jobs/invariant`） | 测试 1/2 在隔离域下组合运行，快照由官方检查器验证（§4.6 组合事实） |
| `tool-jobs`（模型工具族） | 本期不接（job 面 kill/start 拒绝，模型工具需要只读子集——`job_list/get/read/wait` 可用、`job_kill` 不可）；#77+ 模式面决定暴露策略 |
| `ui-jobs`（client 投影） | 快照形状与官方一致；未实测，列为 #77+ 验证项 |

## 7. 变更记录（docs/11 §7 格式）

```text
Official remote SHA/date: 141eb6fef83422698aef7a981029e843e8161534 / 2026-08-20（rc.8，未漂移）
Relevant implemented Agent Notes/packages: dsh-jobs（+invariant 伙伴）、dsh-jobs-local（对照）、dsh-storage-domain（domain/changed 事件面）
Installed/Profile capability evidence: @deepseek-ai/dsh-jobs@0.1.0-rc.8 npm 可装、exports 含 ./invariant；OFFICIAL_BASELINE 已列 public + job-registry-seam Agent Note evidence
Stable / experimental / absent / overlay classification: seam=官方 stable；jobs-local=官方默认 Provider（不依赖）；Team 桥=项目自有 Provider；投影存储=无（纯派生，权威唯一）
Reference behaviors selected: Jiuwen 任务可观测性需求映射到官方 jobs 面（观察/等待/完成通知）；官方 local registry 的 settle/waiter/reported 语义作对照
Canonical state owner: Team 聚合=agent_swarm 域（不变，唯一权威）；job 记录=进程内派生投影（无持久化，重建即重导）
Transition owner and conflict prevention: 投影状态唯一由 domain/changed 派生路径迁移；start/kill 拒绝面封死 job→Team 写通路；revision 守卫防旧快照回退
Plugin shape: Provider（官方抽象类实现，隔离域注册）+ 插件配置开关；无新 storage 域
Lifecycle/persistence/security limits: 依赖 domain/changed 的 post-durability 语义；dispose 不 settle 记录（权威可能仍活）；unowned 访问模型（隔离域可达性限定）
Migration/rollback: jobsBridge=false 即回退（零残留：无存储、无服务）
Unit/conformance/fault/real-composition gates: tests/jobs-bridge.spec.ts（官方 jobs invariant 伙伴在场 + #75 workflow 桥同树双面一致性）
Docs/Skill files updated: docs/04 §8g、docs/07 M2、docs/09、docs/10、README、本注记
```

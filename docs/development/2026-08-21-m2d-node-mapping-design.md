# M2-4 design note — Jiuwen node-type mapping over the Team task DAG (2026-08-21)

状态：issue #78 实现设计（同 PR 交付）。证据基线：本仓 `origin/main @ 044d4c0`（#75 桥 + #76 job 投影 + #77 模式面之后；开工时基于 `f230aa7`，#76 合入后 rebase——本 issue 未触碰 #76 的 jobs 投影面）；#75 的官方契约逐项分析见 `2026-08-21-m2a-workflow-bridge-design.md`、#77 的模式/单 owner 论证见 `2026-08-21-m2c-modes-design.md`（不重复）；规划陷阱 3 见 `2026-08-20-m2-planning-note.md` §2。Jiuwen 行号全部来自 `ref/jiuwenswarm/source @ 36c7959`（`SOURCE_POINTER.json`，只读证据；引用省略 `ref/jiuwenswarm/source/` 前缀）。

AGENTS 规则 11 定位：SwarmFlow 是**行为/故障模型参考**，不是架构移植对象。本注记把五类节点映射到既有 Team 任务 DAG（`blockedBy` 依赖 + revision/attempt fencing + review 门），不引入第二套工作流引擎，域层（task 板 schema）零变化。

## 1. Jiuwen 节点语义与故障形态（证据先行）

SwarmFlow 脚本形如顶层 `META` + `async def run(args)`，算子经 `from swarmflow import ...` 映射到引擎 facade（`docs/zh/TUI使用SwarmFlow指南.md:23`）。五类节点（含其 base 单元 `agent()`）：

| 节点 | Jiuwen 行为 | 出处（file:line） | Jiuwen 故障形态 | 出处 |
|---|---|---|---|---|
| `agent(prompt)` | 拉起一次性 worker；`options={model,timeout,isolation,agent_type}` | TUI指南:35,68-71 | 节点 `failed`（error 记录在节点上） | TUI指南:539；workflow_state.py:950-956 |
| `phase(title)` | 标记当前阶段，发出阶段事件，与 `META.phases` 对齐 | TUI指南:39 | 阶段切换时前一阶段 seal 为 `completed`（含仍在跑的节点）；run 终态时 running 阶段 seal 为终态、`planned` 阶段不动 | workflow_state.py:421-469,354-365,528-530 |
| `parallel(thunks)` | fork-join：lazy thunk 并行，**全部等齐**后返回；失败项为 `None`，调用不抛错 | TUI指南:36 | 单项失败不传染同伴（per-item null） | TUI指南:36 |
| `pipeline(items,*stages)` | 无 barrier 流水线：每项独立穿过各 stage，**item 间不等齐** | TUI指南:37 | 单项失败只终止该项链，其余 item 继续 | TUI指南:37 |
| `workflow(name_or_path)` | 内联运行另一份脚本，**最多嵌套一层**，共享并发与 budget | TUI指南:56 | 嵌套子流显示为 child phase 卡（`▸ name #N`）；budget 耗尽 → run `failed` 且不可 resume | TUI指南:119,366,519 |
| `human(prompt)` | 单次人工提问，答完即关；节点进入 `waiting_for_human`，回复后回 `running` 再终态 | TUI指南:50；workflow_state.py:958-994 | teardown 时仍等待的 human 节点被强制关闭（前端不空转）；run 终态统一 seal | workflow_state.py:336-352,537-540 |

Run 级故障：脚本 throw 或 token budget 超限 → `workflow_failed`，running 阶段/节点统一 seal（`workflow_state.py:1008-1019`）；运行时被拆卸而无终态事件 → `finalize_if_running` 强制 `stopped`（`workflow_state.py:315-327`）。引擎级准入：嵌套共享并发与 budget（TUI指南:56）——fan-out 的天然上界。

## 2. 映射表（Jiuwen 节点 → Team 任务 DAG）

权威全部落在任务板：每行右侧只是 **`create_task`/`blocked_by` 调用序列的构图糖**（模式层 builder），执行、围栏、调度、预算、审阅一律走既有不变面。

| Jiuwen 节点 | Team DAG 映射 | 依赖边 | 故障形态对照 |
|---|---|---|---|
| `phase(title)`（串行阶段） | 阶段容器：阶段内节点按声明序串行（Jiuwen 脚本逐 `await` 语义），**阶段边界 = join**——下一阶段所有任务的 `blockedBy` = 上一阶段全部任务的 id（`graph.ts:48-52`：每条依赖 `completed` 才 ready） | 阶段间全量 join 边 | Jiuwen 阶段 seal/终态传染 → 板上**失败保持**：上游任务未完成（reject 回 pending / 搁浅 / 预算拒认领）时下游恒 `pending`、`ready=false`、`blocked_by` 具名可见，绝不静默跳过或自毁（对照差异见 §4.1） |
| `parallel(items)`（并行扇出） | 同层任务：同一 `blockedBy` 入边（前一元素出口 frontier），**彼此零依赖**；出口 = 全部 item（join 由下一元素的入边表达，对位"全部等齐"） | 入边同源、无内部边 | Jiuwen"失败项为 None 不抛错" → 板上：单 item 的失败/搁浅**不产生任何同胞边**（结构上无依赖可传染），其余 item 照常被调度；item 的"None 化"由 operator 显式终决（cancel/改派），不由映射自动生成 |
| `pipeline(items, stages)` | 每 item 一条跨阶段链：`(i,s)` `blockedBy` `(i,s-1)`；**item 间零边**（无 barrier 对位） | 仅 item 内部链边 | Jiuwen"单项失败只停该项链" → 板上：item 链在未完成 stage 处**保持**，后续 stage 恒 pending；其他 item 链结构无涉。中间产物：上游任务的 `output` 字段是**板上持久工件**（completed 任务携带），向下传递经邮箱（quiet/wakeup）显式投递或 captain 转发——builder 只在下游描述里埋**真实上游任务 id 引用**（apply 时解析替换），不搬运数据（无状态） |
| `workflow(...)`（嵌套） | 成员自建 Team：嵌套节点 = 父板上**一个**任务，其完成契约 = 受派成员以自己 Session 自建子 Team（`createTeam` 无 membership 前置，`orchestrator-runtime.ts:219-226`）执行工作、归档子 Team、把结果折叠进父任务提交 | 单任务 + 前序边 | Jiuwen"最多嵌套一层"由**两个既有面**围出：(a) F11 歧义面——成员建队后其隐式 `requireMembership` 命中两个活跃 Team，`TEAM_MEMBERSHIP_AMBIGUOUS` fail-loud（`team-domain-roster.ts:69-87`），嵌套组合必须显式（teamId）驱动；(b) 官方深度面——成员（深度 1）再派子代 `resolveChildDepth > maxDepth` 即 `SubagentDepthError`（`dsh-subagent` child-agent 契约；F15 预检强制 provider 具备 `depthLimit`，`member-provisioning.ts:83-92,117`） |
| `human(prompt)`（人工节点） | review 门人工腿：一个成员任务（成员组装决策材料并提交）+ **review 挂点**——任务的完成必须经 review 事务的人工决定（`reviewProvider: 'manual'` 尊重请求决定，`providers.ts:58-65`；review 事务含"optional human approval"腿，docs/04 §5） | 单任务 + 前序边 | Jiuwen `waiting_for_human` → 板上任务 `submitted` 停在 review 门；人工回答 = review 决定 + diagnostic（accept=批准 / reject=拒绝）；Jiuwen"回复后 completed/failed" → 板上 **reject ≠ 终态失败**：`reviewTask` reject 清执行回 `pending`、`usedRetries+1`、触发一次调度 pass 改派重做（`team-domain-board.ts:288-298`、`orchestrator-runtime.ts:364`）——重做环是 review 事务的既有语义（docs/04 §5"rejected: … return pending"） |

基础单元 `agent()` 对应一个普通任务（无节点概念，subject/description 即 prompt 面）——#75 桥在 workflow 模式已逐项对位（m2a 注记 §2.1），本映射不重复该路径。

**准入即背压（陷阱 3，映射不得绕过）**：builder 对 fan-out **不设自己的并发控制**——parallel/pipeline 的全部任务一次性 upfront 创建（尺寸受板 `maxTasks`/`maxDependencies` 准入，`team-domain-board.ts:99-101`），实际并发由既有配额围出：成员每人同时至多一个 open 任务（claim 时 `TEAM_MEMBER_BUSY`，`team-domain-board.ts:156`）、roster 配额（`TEAM_MEMBER_LIMIT`）、邮箱 pending 配额（`TEAM_MAILBOX_FULL`）。超扇出的多余任务诚实停在 `pending/ready=true` 等待空闲成员——这是板上可见的背压，不是 builder 的队列。

## 3. 选型论证：独立 builder API，不改脚本面

两条候选（issue 原文）：(a) workflow 脚本面（#75 桥的 `agent()` 语境扩展）；(b) 独立 builder API。**选 (b)**：

1. **#75 桥的 realm 钩子词表是官方冻结契约的镜像**（`agent/parallel/pipeline/phase/log` + `args`，`script-executor.ts:140-151`，对位官方 worker-thread runtime）。往 realm 里加 Jiuwen 节点钩子 = 桥的脚本契约偏离它刻意镜像的官方词表 = 触碰已合并的 #75 语义（红线）。
2. **官方组合子是控制流**：`parallel/pipeline` 的依赖存在于脚本异步局部变量里，run 终止即消失。#78 的映射目标是**板上持久 DAG 状态**（`blockedBy` 在任务板上，任意模式可被既有调度 pass 驱动、可审计、可恢复）。映射进脚本面等于把 DAG 藏进瞬时控制流——正是"第二套工作流引擎"的形状（红线）。
3. **builder 只产调用**：`compileNodePlan`（纯函数：声明 → 拓扑序 `create_task` 操作序列 + review 挂点描述符，无 I/O 无状态）+ `applyNodePlan`（顺序执行 `runtime.createTask`，解析符号依赖为真实 TaskId——`assertTaskGraph` 要求被依赖任务先存在，编译器给出的即拓扑序）。每次 create 走完整既有面：membership、图校验、限额、revision、requestSchedule。builder 不 watch、不取消、不记账。
4. **模式无关**：映射在 `adaptive`（既有事件面调度）与 `workflow`（run 驱动）两模式下同样成立——本次测试在 adaptive 真实组合上证明；不依赖桥启用，#77 语义零改动（只消费）。

**schema/prompt 面**：声明本身即 schema 面类型（`NodePlan` 五类节点闭集，编译期校验：未知 kind/空 phase/空 items/空 question 结构化拒绝）；prompt 面补一条 captain 用法准则（`src/index.ts` usage 第 3 条后），声明阶段化分解与 fan-out 配额纪律。**不加第 17 个模型工具**：README 声明的 16 工具面零变化；工具暴露与 #77 模式面的工具层决策（m2a 注记 §5）同批处理。

**已知裁剪（如实记录）**：声明计划是**一次性 upfront 编译**——阶段 N+1 的任务在阶段 N 完成前就已存在（板上可见、`ready=false`），不支持 Jiuwen 式运行中按 `budget.remaining()` 动态改图（那是脚本面的能力，板上等价物 = captain 的显式 `agent_swarm_create_task`/改派操作）。`schema`/`timeout`/`isolation` 等 `options` 键无板上等价物，不进映射词表。

## 4. 已论证偏离（Jiuwen 行为 vs 板上语义）

1. **失败传播：fail-fast → hold-the-chain**。Jiuwen fatal（脚本 throw/budget 尽）让 run `failed` 并统一 seal（`workflow_state.py:1008-1019`）。板上映射：上游失败（reject 回 pending、成员搁浅、预算拒领）让下游**保持阻塞**（`ready=false` 具名可见），不自动失败、不自动取消、不跳过。理由：持久 DAG 状态不得越过围栏自突变（AGENTS 规则 15 故障遏制；docs/04 §3 回滚纪律）；Jiuwen 的 fail-fast 是脚本进程属性，持久聚合上的等价物是"保持 + operator 显式终决（重做/改派/cancel）"。
2. **per-item null → item 链保持 + 同胞零影响**。Jiuwen `parallel/pipeline` 把失败项折为 `None` 继续汇合（TUI指南:36-37）。板上：失败 item 的链停在未完成处（下游 stage 恒 pending），同胞 item 结构上无涉、照常调度；"null 结果"由 operator 显式终决产生，映射绝不代答。
3. **human reject ≠ 节点终态失败**。Jiuwen human 回复后节点 `completed/failed` 二值（TUI指南:338）；板上 reject 是**重做信号**（pending + retry 计费 + 改派），完成仍需一次 accept。这是 review 事务既有语义（docs/04 §5），映射复用而非改造。
4. **嵌套预算分离**。Jiuwen 嵌套 `workflow()` 共享父 run 的并发与 budget（TUI指南:56）；板上子 Team 是独立聚合（自有 budget 面；父预算只看到该成员自身用量）。持久边界（聚合/域）优先于引用实现的共享进程预算——分布式成员（M3+）下共享进程 budget 本就不可承诺。

## 5. 实现设计

### 5.1 文件布局

| 文件 | 职责 |
|---|---|
| `src/patterns/node-mapping.ts` | 纯编译器 + 应用器：`NodePlan`/`PlanNodeDecl` 类型（五类节点闭集 + base task）、`compileNodePlan`（校验 + 拓扑序操作序列 + review 挂点描述符）、`applyNodePlan`（顺序 `runtime.createTask`，符号依赖 → 真实 TaskId，`{upstream:<key>}` 占位符替换） |
| `tests/node-mapping.spec.ts` | 五类节点真实组合测试 + 编译校验测试（§5.3） |

`src/index.ts` 导出公共类型与两个函数；域层、`scheduling.ts`、桥、模式面零改动。新顶层族 `src/patterns/` 即"模式层"落点：非权威、非运行时协作器，纯构图辅助。

### 5.2 编译代数（无歧义定义）

- 计划 = 串行阶段序列；每阶段 = 串行节点序列。
- frontier（出口集合）：初始空；每节点入口 = 当前 frontier、出口 = 自身任务集；frontier := 出口。
- `task`：1 任务。`parallel`：n 任务同入边、无内边、出口=全部。`pipeline`：item i 的 stage 0 入边 = frontier，stage s>0 入边 = {item i stage s-1}，出口 = 各 item 末 stage。`nested`/`human`：各 1 任务（human 另附 review 挂点描述符）。
- 阶段边界：下一阶段首节点入口 = 上一阶段出口 frontier（join = 依赖链）。
- 键自动分配（`k1..kN`，创作序），apply 返回 `key → TeamTask` 映射 + `phase → taskIds` 分组证据 + 解析后的 review 挂点（真实 taskId）。
- 校验（结构化 `TEAM_INPUT_INVALID`）：计划/阶段/节点非空；subject/description/question 非空字符串；parallel items、pipeline items/stages 非空。尺寸上限交给板准入（TEAM_TASK_LIMIT/TEAM_TASK_DEPENDENCY_LIMIT 在 createTask 处 fail loud）。

### 5.3 测试设计（真实组合；教训 28/29：`vi.waitFor` ≥15s、用例预算 ≥60s）

树复用 `tests/workflow-bridge.spec.ts` 形态（AgentLoop + 官方 durable 栈 + in-process spawn + swarm 插件，adaptive 缺省），LLM 用门控 ScriptedAdapter（assignment 帧解析 + 可释放提交门）。场景 33（docs/08 §3 新行，§7 审计行同步）：

1. **phase（场景 33 证据位）**：两阶段计划（P1 两任务、P2 一任务）。断言：P2 任务 `blockedBy` = P1 两任务 id；P1 其一完成而另一未完成时 P2 `ready=false`；**故障路径**：P1 一任务 review reject → 回 pending + `usedRetries+1`，P2 保持 pending（失败保持）；重做再提交 accept 后 P2 ready → 被调度 → 完成（链条恢复）。
2. **parallel**：4 item 扇出 + 2 成员（`maxMembers: 2`）。门控暂停两成员：恰好 2 in_progress、2 pending 且 ready（背压可见）；第 3 名成员 `TEAM_MEMBER_LIMIT` 拒绝（roster 配额）；放行后 4 任务全完成。全程序采样断言 in_progress 峰值 ≤2（板上围栏，非 builder 机制）。
3. **pipeline**：2 item × 2 stage。断言：stage-2 仅依赖本 item stage-1（`blocked_by` 精确断言零跨 item 边）；**中间产物**：stage-1 accept 后其 `output` 在板上；captain 以 quiet 邮箱把工件文本投给成员（下一轮次注入，F13 语义）；stage-2 成员提交的 output 嵌入工件标记（adapter 从会话中提取）——"任务输出 + 邮箱"双通道对位。
4. **nested**：嵌套节点被调度给成员 M1（真实指派）。测试以 M1 的 Session 身份（host 面）自建子 Team（成功——F11 允许建队）；断言 F11 面：M1 的隐式 `addMember`/`status` 双双 `TEAM_MEMBERSHIP_AMBIGUOUS`（fail-loud，零提交）；断言深度面：`resolveChildDepth(M1, memberMaxDepth=1)` 抛 `SubagentDepthError`（官方一层上界）；子 Team 经显式 domain port 归档；M1 经正常工具面提交父任务（归档后歧义消除）、captain accept、父链完成。
5. **human**：三阶段计划（prep → human 门 → publish）。断言：门任务描述携带问题数据 + review 挂点描述符解析出真实 taskId；成员提交后任务 `submitted`（对位 `waiting_for_human`）；**拒绝路径**：review reject → pending + `usedRetries+1`、publish 保持 pending；调度改派重做、再提交；accept（批准 + diagnostic）→ completed、publish ready → 完成。
6. **编译校验（纯函数）**：空阶段/空节点/空 items/空 question/未知字段结构化拒绝；拓扑序正确（依赖先于依赖者）；键唯一。

## 6. 变更记录（docs/11 §7 格式）

```text
Official remote SHA/date: 141eb6fef83422698aef7a981029e843e8161534 / 2026-08-20（rc.8，未漂移；本 issue 未新增官方契约消费——官方 dsh-subagent 的 resolveChildDepth/SubagentDepthError 为已装包既有导出，证据沿用 #75/#77 注记）
Relevant implemented Agent Notes/packages: dsh-subagent（ContinuableStart/depth 面）、dsh-workflow（脚本 realm 词表对照——不改动）
Installed/Profile capability evidence: 沿用 docs/09 既有登记；本变更只消费本仓既有缝（createTask/blockedBy、review Provider、F11/F15、邮箱）
Stable / experimental / absent / overlay classification: 节点映射=项目自有模式层构图糖（无新 Service/Domain/工具；域 schema 零变化）
Reference behaviors and failure cases selected: SwarmFlow 五类节点行为与故障形态（TUI指南:23,33-42,50,56,119,366,519,528-540；workflow_state.py:137,315-327,354-365,421-469,958-994,1008-1019）——行为/故障参考，非架构移植（AGENTS 规则 11）
Canonical state owner: Team 聚合=agent_swarm 域（不变）；节点声明是瞬时构图输入，无持久化、无第二真相
Transition owner and conflict prevention: 全部经既有 createTask/reviewTask/调度面（revision CAS + attempt fencing + 配额准入）；builder 无状态无 watch
Plugin shape: 纯模块导出（compileNodePlan/applyNodePlan）+ prompt usage 准则一条；默认行为零变化（不调用即不存在）
Lifecycle/persistence/security limits: upfront 编译（无动态改图）；任务描述经 F8 定界（既有 assignment prompt 面）；计划尺寸受板准入
Migration/rollback: 纯增量导出，无配置无存储变化；回退=删除导出
Unit/conformance/fault/real-composition gates: tests/node-mapping.spec.ts（五类节点 + 故障路径 + 编译校验，场景 33）
Docs/Skill files updated: docs/04 §8h、docs/07 M2、docs/08 §3/§7（场景 33）、docs/09、docs/10、README、本注记
```

# M2 planning note — official Workflow/Jobs bridge (pre-research, 2026-08-20)

状态：M1D 进行中时的前瞻预研。官方接口面清单来自 sparse checkout `141eb6f` 的逐文件核对（引用格式 `文件:行号`，省略前缀 `packages/`）；本文在 M2 开工时转化为 issue 分解与委派合同素材。**M2 开工前置：`src/tools.ts` 594/600 行，先拆分**。

## 1. 桥接策略（预研结论）

- **挂点**：Team 直接调 `ctx.workflowEngine.start({ script, meta, args?, subagentProvider?, maxTotalAgents?, parent: <team owner agent> })`——seam 即公共面，不经 model 工具（`workflow\workflow\src\index.ts:157-187`、`runtime-types.ts:19-34`）。
- **per-run `subagentProvider`** 是把 child 路由到 Team 自有 provider 的官方通道；名字必须已注册于 `ctx.subagents`，否则同步 `AGENT_START` throw（`workflow-worker-thread\src\index.ts:77-89`）。
- **`maxTotalAgents` 只降不升**（>部署天花板即 `INVALID_ARGUMENT`，默认天花板 1000，`workflow-worker-thread\src\index.ts:92-104,32-49`）。
- **run 包装为 job**（长操作披露/取消/等待走官方 jobs）：`JobHooks.cancel` 必须转发 `run.cancel`；`done` 必须在 `run.dispose()` 完成后才 settle（dispose 即"资源已释放"语义，`jobs\jobs\src\types.ts:72-91`）；取消路径先 `kill` 再等 `done`/`dispose`。

## 2. 三个关键陷阱（官方语义，原文吸收进合同）

1. **Team 自起 run 无 Chat 记录**：durable `tool-workflow/*` Session 事件是 `tool-workflow` 包私有的，且嵌套 transport 执行（`exec.parent !== undefined`）不写（`tool-workflow\src\index.ts:291-294`，note 2026-08-10）。Team 桥的 run id/状态**overlay 是唯一事实源**；如需 Chat 可见性，须自记事件并自建 invariant（官方 cold-load 校验不认识外来序列）——M2 初版接受 overlay-only。
2. **唤醒预算共享**：Team 自身的 idle-owner 唤醒与 job completion 唤醒消耗同一 `maxConsecutiveWakes`（默认 3，仅用户输入恢复；`tool-jobs\src\index.ts:45`，note 2026-08-11）。防重复唤醒在 owner/turn 层做（inject 与 wakeup 在 wakeDriver 处幂等），不在 producer 层。
3. **准入即背压**：run-as-job 批量启动撞 `maxConcurrentJobsPerOwner`（默认 10，按精确 Agent 实例分桶、stopping 占容量、拒绝零残留可重试；`jobs-local\src\index.ts:143-148`，note 2026-08-11）——直接用作 M2 fan-out 上限语义。

其余硬约束：单引擎无 provider 注册表（`docs\subsystems\workflow.md:5`）；`stopReason` 闭合 union（completed|cancelled|error）；`WorkflowError.fatal` 默认 re-throw；meta 未知字段即 `META_INVALID` 且返回归一化副本；取消在 `disposeGraceMs` 内强制 settle 并 TERMINATE worker。

## 3. M2 issue 分解草案（开工时建 issue，里程碑 M2）

1. **M2-0 前置**：拆分 `src/tools.ts`（>594/600；按工具族拆模块，公共 API 不变，场景审计/门禁全绿）；
2. **M2-1 orchestration mode 框架**：`adaptive | workflow` 显式配置（单 owner：同一 attempt 的 assign/retry/cancel/settle 归恰好一个模式）；模式切换的团队级 CAS 语义；
3. **M2-2 workflow 执行 Provider**：`ctx.workflowEngine.start` 桥 + run id/状态 overlay 存储（经 `TeamDomainPort` 增量，schema 版本决策）；Jiuwen phase/parallel/pipeline 映射为官方 script 契约（官方脚本 DSL：`agent()/pipeline()/parallel()/phase()/log()/args`，见 tool-workflow DESCRIPTION `tool-workflow\src\index.ts:220-256`）；
4. **M2-3 jobs 披露与取消**：run-as-job 包装（§1 规则）+ `job_output/job_list/job_kill` 透传语义 + 完成唤醒与 Team 调度的 owner 层幂等；
5. **M2-4 双 owner 故障测试**：官方测试面对齐（`workflow\tool-workflow\tests\tool-workflow.spec.ts` 的 abort-桥/嵌套不记录/isError 区分；`jobs\jobs-local\tests\jobs.spec.ts` 的准入/owner isolation/teardown；`jobs\tool-jobs\tests\tool-jobs.spec.ts` 的通知 lane）+ 我方场景矩阵新条目（预计 §3 新增场景 31+，audit 行同步）；
6. **M2-5 human 节点**（官方 questions/approval 服务消费；Jiuwen human 节点映射）——可拆 M2 后半或 M5 前置，开工时定。

## 4. 与宪法的对照

- 不注册影子 `ctx.workflowEngine`/`ctx.jobs`——只作 Consumer（docs/11 §6）；
- overlay 不复制 Workflow 状态，只存 linkage（docs/10 §6 冲突表既定）；
- 预算共享/准入背压属故障遏制（宪法规则 15 允许且要求）。

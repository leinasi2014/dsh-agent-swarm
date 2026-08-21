# 项目目标登记表

本文件是项目的目标权威登记：一个总目标 + 一个当前开发目标。当前目标完成时，由项目管理工程师在收尾 PR 内登记下一个目标（按 `docs/07-implementation-roadmap.md` 顺序）；每日复盘核对本文件与实际进度一致。里程碑完成的判定始终以 docs/07 的 exit criteria 为准。

## 总目标

以官方优先（official-first）的纯插件方式，为 DeepSeek Harness 交付持久、可审查的多代理 Team 协作层：M1（崩溃安全协议 + 独立回归审查）放行 → D1 单写入者 dogfood → M2 官方 Workflow/Jobs 编排 → M3 自托管安全纵切（D2 并行自我开发）→ M4-M8 能力族（记账/验证/Workspace 隔离/记忆进化/分布式）→ M9 客户端与正式发布。全程不修改 Agent Loop、不影子注册官方服务、单一权威状态（`TeamDomainPort`）。

**范围确认（用户，2026-08-20）**：执行全路线图——M1C→M1D→M2→…→M8 全部完成，**M9（含 optional client package / WebUI）压轴最后**；插件内核始终为纯 Swarm 能力，UI 只是末端的投影型 Consumer。开发模式：PM 统筹 + 实现智能体并行 worktree 隔离开发（CONTRIBUTING §2a），合并串行 + 双绿守卫（merge-guard）。M1D 前置环境依赖：rc.8 世系 DSH CLI（F16，用户准备）。

**双线并行（用户，2026-08-20 起）**：同一项目管理工程师同时推进本项目与 **dsh-canvas**（影视创作平台插件化，`github.com/leinasi2014/dsh-canvas`，W1-W5 路线图）——同一套开发/治理规范与 git 纪律双侧一致，管理文档同构且负有双侧同步义务（CONTRIBUTING §8）。本文件仍只登记本项目目标；双线运行状态见两侧 ops skill 快照，审查带宽按里程碑优先级调度（本项目 M1D 优先于 canvas 抽取波次）。canvas 的视频生成 API 对接在本项目编排能力（M2+）就绪后启动。

## 当前开发目标

**M3 — 自托管安全纵切（D2 并行自我开发）（2026-08-21 接替 M2）**

**入口门（开工前完成）**：#92（计费缺口诊断——seq 游标 reorder-safe 修复，replay-safe 不回退）、#93（jobs 投影的模型面读工具暴露）、#94（官方 UI 消费方对 team-task 投影的核验）。

1. 真实 per-attempt 执行根（每次尝试独立执行根隔离）；
2. 独立可执行审查（Reviewer 与实现者分离的可执行验证面）；
3. 候选验收 Profile 分离 + 外部晋升/回滚（ADR-0008 全文纪律）；
4. 开工先做 Gate A + issue 分解 + ADR-0008 的 D2 前置条件逐项核验。

**D1 单写入者 dogfood 持续**（2026-08-21 起开放；约束与观察清单见 `docs/development/2026-08-21-m1d-exit-report.md` §4，`.dsh-mkdir` 上游抖动与 P3-3 活性角落持续观察中）。

## 上一目标（已完成的登记记录）

**M2 — 官方 Workflow/Jobs 编排模式（2026-08-21 完成）**：入口门 #60/#61/#62 全关（PR#68/#67/#71）；#74 tools 拆分（PR#81）、#75 WorkflowEngine 桥（PR#85，isolate 注册 + agent_swarm_workflow overlay 域）、#76 JobRegistry 桥（PR#87，只读投影崩溃即重导）、#77 显式模式 + 双 owner 对抗（PR#86，变异法四重验证）、#78 节点类型映射（PR#89，纯构图糖非第二引擎）、#79 预算跨 run 结转（PR#90，单一唤醒账本）。伴随：#83 三重自愈缺陷修复（PR#84）、CI 守卫与窗口族加固、Gate C 第四次 re-pin、泳道扩容 3-6、教训 24-33。121 测试、场景审计 19/33；tag `m2`。尾巴转 M3 入口门 #93/#94。证据：`docs/development/2026-08-21-m2-exit-report.md`。

**M1D — 装配验收与放行（2026-08-21 完成）**：#37（M1D-1 双环境 Profile 装配，PR#48）、#38（M1D-2 重载/恢复/关停，PR#51，**发现 D1**）、#52（D1 修复：waking 确认仅认领形态，PR#54+追补 PR#56）、#39（独立 GLM-5.3 回归审查 **verdict PASS**，报告 `docs/reviews/2026-08-21-m1d-regression-review.md`）、#40（出口报告）。伴随：CI 守卫修复 PR#57、测试窗口加固 PR#58、教训库 PR#59。审查非阻断项立案 #60/#61/#62（M2 入口门）。85/85 测试；tag `m1d`。证据：`docs/development/2026-08-21-m1d-exit-report.md`。**M1（M1A→M1D）全量收束：D1 单写入者 dogfood 开放。**

**M1C — 生命周期、协调与输入加固（2026-08-20 完成）**：#12/#13/#14/#15/#19 全部关闭（含 CI 稳定化 PR #33）；F4/F7(usage)/F8/F10 与伴随组在生命周期/调度/prompt 快照/兼容测试中通过；78/78 测试、场景审计 16/30；tag `m1c`。证据：`docs/development/2026-08-20-m1c-exit-report.md`。

**M1B — 崩溃安全协议（2026-08-20 完成）**：#7/#3/#4/#5/#6/#8 全部关闭；F2/F3/F6/F7 被真实崩溃/故障注入测试关闭；场景审计 12/30；tag `m1b`。证据：`docs/development/2026-08-20-m1b-exit-report.md`。

## 登记规则

- 当前目标完成 = 其全部 issue 关闭 + docs/07 exit criteria 核验 + tag 推送；由 PM 在收尾 PR 中把"下一个目标"提升为"当前开发目标"并按 docs/07 登记再下一个。
- 目标变更（增删范围）必须在 PR 中说明理由并与 docs/07 同步；本文件不承载范围论证，只登记状态。

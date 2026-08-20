# 项目目标登记表

本文件是项目的目标权威登记：一个总目标 + 一个当前开发目标。当前目标完成时，由项目管理工程师在收尾 PR 内登记下一个目标（按 `docs/07-implementation-roadmap.md` 顺序）；每日复盘核对本文件与实际进度一致。里程碑完成的判定始终以 docs/07 的 exit criteria 为准。

## 总目标

以官方优先（official-first）的纯插件方式，为 DeepSeek Harness 交付持久、可审查的多代理 Team 协作层：M1（崩溃安全协议 + 独立回归审查）放行 → D1 单写入者 dogfood → M2 官方 Workflow/Jobs 编排 → M3 自托管安全纵切（D2 并行自我开发）→ M4-M8 能力族（记账/验证/Workspace 隔离/记忆进化/分布式）→ M9 客户端与正式发布。全程不修改 Agent Loop、不影子注册官方服务、单一权威状态（`TeamDomainPort`）。

**范围确认（用户，2026-08-20）**：执行全路线图——M1C→M1D→M2→…→M8 全部完成，**M9（含 optional client package / WebUI）压轴最后**；插件内核始终为纯 Swarm 能力，UI 只是末端的投影型 Consumer。开发模式：PM 统筹 + 实现智能体并行 worktree 隔离开发（CONTRIBUTING §2a），合并串行 + 双绿守卫（merge-guard）。M1D 前置环境依赖：rc.8 世系 DSH CLI（F16，用户准备）。

**双线并行（用户，2026-08-20 起）**：同一项目管理工程师同时推进本项目与 **dsh-canvas**（影视创作平台插件化，`github.com/leinasi2014/dsh-canvas`，W1-W5 路线图）——同一套开发/治理规范与 git 纪律双侧一致，管理文档同构且负有双侧同步义务（CONTRIBUTING §8）。本文件仍只登记本项目目标；双线运行状态见两侧 ops skill 快照，审查带宽按里程碑优先级调度（本项目 M1D 优先于 canvas 抽取波次）。canvas 的视频生成 API 对接在本项目编排能力（M2+）就绪后启动。

## 当前开发目标

**M2 — 官方 Workflow/Jobs 编排模式（2026-08-21 接替 M1D）**

**入口门（开工前完成，M1D 回归审查 remediation）**：#60（P2-1 assignment 认领可见性——#52 claimed-gate 同构推广）、#61（P2-2 `TEAM_SELF_MESSAGE` 官方对齐）、#62（P3-4 fence 卫生清理）。

1. `ctx.workflowEngine`/`ctx.jobs` 的 Team 桥 Consumer；
2. `adaptive`/`workflow` 显式模式（单 owner）；Jiuwen phase/parallel/pipeline/nested/human 节点映射；
3. Team 预算跨 run 共享；双 owner 故障测试；
4. 开工先做 Gate A + issue 分解（注意：`src/tools.ts` 已 594/600 行，扩工具前先拆分）；
5. 规划陷阱预登记已就位：`docs/development/2026-08-20-m2-planning-note.md`。

**D1 单写入者 dogfood 已开放（2026-08-21 起）**：M1 放行即生效，约束与观察清单见 `docs/development/2026-08-21-m1d-exit-report.md` §4。

## 上一目标（已完成的登记记录）

**M1D — 装配验收与放行（2026-08-21 完成）**：#37（M1D-1 双环境 Profile 装配，PR#48）、#38（M1D-2 重载/恢复/关停，PR#51，**发现 D1**）、#52（D1 修复：waking 确认仅认领形态，PR#54+追补 PR#56）、#39（独立 GLM-5.3 回归审查 **verdict PASS**，报告 `docs/reviews/2026-08-21-m1d-regression-review.md`）、#40（本出口报告）。伴随：CI 守卫修复 PR#57、测试窗口加固 PR#58、教训库 PR#59。审查非阻断项立案 #60/#61/#62（M2 入口门）。85/85 测试；tag `m1d`。证据：`docs/development/2026-08-21-m1d-exit-report.md`。**M1（M1A→M1D）全量收束：D1 单写入者 dogfood 开放。**

**M1C — 生命周期、协调与输入加固（2026-08-20 完成）**：#12/#13/#14/#15/#19 全部关闭（含 CI 稳定化 PR #33）；F4/F7(usage)/F8/F10 与伴随组在生命周期/调度/prompt 快照/兼容测试中通过；78/78 测试、场景审计 16/30；tag `m1c`。证据：`docs/development/2026-08-20-m1c-exit-report.md`。

**M1B — 崩溃安全协议（2026-08-20 完成）**：#7/#3/#4/#5/#6/#8 全部关闭；F2/F3/F6/F7 被真实崩溃/故障注入测试关闭；场景审计 12/30；tag `m1b`。证据：`docs/development/2026-08-20-m1b-exit-report.md`。

## 下一个目标（预登记，当前目标完成后生效）

**M3 — 自托管安全纵切（D2 并行自我开发）**：真实 per-attempt 执行根、独立可执行审查、候选验收 Profile 分离、外部晋升/回滚（ADR-0008）。入口条件：M2 完成且 D1 dogfood 无未决阻断发现。

## 登记规则

- 当前目标完成 = 其全部 issue 关闭 + docs/07 exit criteria 核验 + tag 推送；由 PM 在收尾 PR 中把"下一个目标"提升为"当前开发目标"并按 docs/07 登记再下一个。
- 目标变更（增删范围）必须在 PR 中说明理由并与 docs/07 同步；本文件不承载范围论证，只登记状态。

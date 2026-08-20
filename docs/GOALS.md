# 项目目标登记表

本文件是项目的目标权威登记：一个总目标 + 一个当前开发目标。当前目标完成时，由项目管理工程师在收尾 PR 内登记下一个目标（按 `docs/07-implementation-roadmap.md` 顺序）；每日复盘核对本文件与实际进度一致。里程碑完成的判定始终以 docs/07 的 exit criteria 为准。

## 总目标

以官方优先（official-first）的纯插件方式，为 DeepSeek Harness 交付持久、可审查的多代理 Team 协作层：M1（崩溃安全协议 + 独立回归审查）放行 → D1 单写入者 dogfood → M2 官方 Workflow/Jobs 编排 → M3 自托管安全纵切（D2 并行自我开发）→ M4-M8 能力族（记账/验证/Workspace 隔离/记忆进化/分布式）→ M9 客户端与正式发布。全程不修改 Agent Loop、不影子注册官方服务、单一权威状态（`TeamDomainPort`）。

**范围确认（用户，2026-08-20）**：执行全路线图——M1C→M1D→M2→…→M8 全部完成，**M9（含 optional client package / WebUI）压轴最后**；插件内核始终为纯 Swarm 能力，UI 只是末端的投影型 Consumer。开发模式：PM 统筹 + 实现智能体并行 worktree 隔离开发（CONTRIBUTING §2a），合并串行 + 双绿守卫（merge-guard）。M1D 前置环境依赖：rc.8 世系 DSH CLI（F16，用户准备）。

## 当前开发目标

**M1D — 装配验收与放行（进行中，2026-08-20 接替 M1C）**

1. 真实 rc.8 Profile 装配 + `--dump-config` + 重载/恢复/有界关停验证（Windows）——**前置环境依赖：rc.8 世系 DSH CLI（用户侧准备，F16）**；
2. `pnpm verify:gate-a` + 完整项目套件 + package artifact 检查；
3. 委派独立 GLM-5.3 回归/安全审查（按 docs/12，审查员自主不设限；输入 = 原始报告 + intake + M1B/M1C exit 报告的 remediation diff 清单）；
4. 通过后 M1 放行 + D1 单写入者 dogfood 门开放 + tag 里程碑。

退出标准（docs/07 M1D）：每个接受的 M1 blocker 关闭、无 P0/P1 回归、独立审查员掌握最终 verdict、仓库指向可复现提交。

## 上一目标（已完成的登记记录）

**M1C — 生命周期、协调与输入加固（2026-08-20 完成）**：#12/#13/#14/#15/#19 全部关闭（含 CI 稳定化 PR #33）；F4/F7(usage)/F8/F10 与伴随组在生命周期/调度/prompt 快照/兼容测试中通过；78/78 测试、场景审计 16/30；tag `m1c`。证据：`docs/development/2026-08-20-m1c-exit-report.md`。

**M1B — 崩溃安全协议（2026-08-20 完成）**：#7/#3/#4/#5/#6/#8 全部关闭；F2/F3/F6/F7 被真实崩溃/故障注入测试关闭；场景审计 12/30；tag `m1b`。证据：`docs/development/2026-08-20-m1b-exit-report.md`。

## 下一个目标（预登记，当前目标完成后生效）

**M2 — 官方 Workflow/Jobs 编排模式**：`ctx.workflowEngine`/`ctx.jobs` 的 Team 桥 Consumer；`adaptive`/`workflow` 显式模式（单 owner）；Jiuwen phase/parallel/pipeline/nested/human 节点映射；Team 预算跨 run 共享；双 owner 故障测试。开工时先做 Gate A + issue 分解（注意：`src/tools.ts` 已 594/600 行，扩工具前先拆分）。

## 登记规则

- 当前目标完成 = 其全部 issue 关闭 + docs/07 exit criteria 核验 + tag 推送；由 PM 在收尾 PR 中把"下一个目标"提升为"当前开发目标"并按 docs/07 登记再下一个。
- 目标变更（增删范围）必须在 PR 中说明理由并与 docs/07 同步；本文件不承载范围论证，只登记状态。

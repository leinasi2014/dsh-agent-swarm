# 项目目标登记表

本文件是项目的目标权威登记：一个总目标 + 一个当前开发目标。当前目标完成时，由项目管理工程师在收尾 PR 内登记下一个目标（按 `docs/07-implementation-roadmap.md` 顺序）；每日复盘核对本文件与实际进度一致。里程碑完成的判定始终以 docs/07 的 exit criteria 为准。

## 总目标

以官方优先（official-first）的纯插件方式，为 DeepSeek Harness 交付持久、可审查的多代理 Team 协作层：M1（崩溃安全协议 + 独立回归审查）放行 → D1 单写入者 dogfood → M2 官方 Workflow/Jobs 编排 → M3 自托管安全纵切（D2 并行自我开发）→ M4-M8 能力族（记账/验证/Workspace 隔离/记忆进化/分布式）→ M9 客户端与正式发布。全程不修改 Agent Loop、不影子注册官方服务、单一权威状态（`TeamDomainPort`）。

## 当前开发目标

**M1C — 生命周期、协调与输入加固（进行中，2026-08-20 接替 M1B）**

关闭以下 issue（docs/07 M1C）：

1. #13 F4 有界卸载（disposalTimeoutMs）+ 伴随组（F11 歧义 fail-loud / F12 名字复用决策 / F14 归档只读 / F15 depthLimit 预检 / usage 写合并）
2. #19 官方兼容语义组（waitForChange 契约 / quiet 不冷唤醒+有序旁路 / keepInbox interrupt / Unicode 成员名）
3. #12 F10 live-status 调度 + 搁浅自愈（邮箱优先、CAS 守卫回滚）
4. #14 F8 不可信内容定界 + 首个模型可见快照测试
5. #15 模型体验（noProgress 短路、任务列表过滤分页、紧凑输出 schema）

退出标准（docs/07 M1C）：F4、F7(usage 部分)、F8、F10 与接受的伴随发现在生命周期/调度/prompt 快照/兼容测试中通过。

## 上一目标（已完成的登记记录）

**M1B — 崩溃安全协议（2026-08-20 完成）**：#7/#3/#4/#5/#6/#8 全部关闭；F2/F3/F6/F7 被真实崩溃/故障注入测试关闭；场景审计 12/30；tag `m1b`。证据：`docs/development/2026-08-20-m1b-exit-report.md`。

## 下一个目标（预登记，当前目标完成后生效）

**M1D — 装配验收与放行**：真实 rc.8 Profile 装配 + `--dump-config` + 重载/恢复/有界关停（Windows）；委派独立 GLM-5.3 回归/安全审查（按 docs/12，审查员自主不设限，输入 = 原始报告 + intake + M1B/M1C remediation diff 清单）；通过后 D1 单写入者 dogfood 门开放。

## 登记规则

- 当前目标完成 = 其全部 issue 关闭 + docs/07 exit criteria 核验 + tag 推送；由 PM 在收尾 PR 中把"下一个目标"提升为"当前开发目标"并按 docs/07 登记再下一个。
- 目标变更（增删范围）必须在 PR 中说明理由并与 docs/07 同步；本文件不承载范围论证，只登记状态。

# 项目目标登记表

本文件是项目的目标权威登记：一个总目标 + 一个当前开发目标。当前目标完成时，由项目管理工程师在收尾 PR 内登记下一个目标（按 `docs/07-implementation-roadmap.md` 顺序）；每日复盘核对本文件与实际进度一致。里程碑完成的判定始终以 docs/07 的 exit criteria 为准。

## 总目标

以官方优先（official-first）的纯插件方式，为 DeepSeek Harness 交付持久、可审查的多代理 Team 协作层：M1（崩溃安全协议 + 独立回归审查）放行 → D1 单写入者 dogfood → M2 官方 Workflow/Jobs 编排 → M3 自托管安全纵切（D2 并行自我开发）→ M4-M8 能力族（记账/验证/Workspace 隔离/记忆进化/分布式）→ M9 客户端与正式发布。全程不修改 Agent Loop、不影子注册官方服务、单一权威状态（`TeamDomainPort`）。

## 当前开发目标

**M1B — 崩溃安全协议（进行中）**

关闭以下 issue 并打 tag `m1b`：

1. #7 拆分 `team-domain.ts`（归还 600 行护栏例外；纯重构先行，为语义改造提供干净基线）
2. #3 F2 目标侧稳定消息 id 去重（官方 `TeamMessageSource` 机制为模板，docs/02 §7.1）
3. #4 F3 persisted-child 对账恢复（官方四要素校验为模板）
4. #5 F6 邮箱 pending/retained 语义对齐官方（per-target pending + bounded receipts）
5. #6 F7 attempt 上限与修剪（不得复活已淘汰 attempt id）
6. #8 M1B exit：docs/07/10 同步、remediation diff 清单、tag

退出标准（docs/07 M1B）：F2、F3、F6 与 attempt 增长部分被真实崩溃/故障注入测试关闭。

## 下一个目标（预登记，当前目标完成后生效）

**M1C — 生命周期、协调与输入加固**：F4 有界卸载（disposalTimeoutMs）、F10 live-status 调度与搁浅自愈、F8 不可信内容定界 + 快照测试、官方兼容语义组（waitForChange 契约 / quiet 语义 / keepInbox interrupt / Unicode 成员名 / 兼容小项 F11/F14/F15）、usage 写合并。issue 已建于 M1C 里程碑。

## 登记规则

- 当前目标完成 = 其全部 issue 关闭 + docs/07 exit criteria 核验 + tag 推送；由 PM 在收尾 PR 中把"下一个目标"提升为"当前开发目标"并按 docs/07 登记再下一个。
- 目标变更（增删范围）必须在 PR 中说明理由并与 docs/07 同步；本文件不承载范围论证，只登记状态。

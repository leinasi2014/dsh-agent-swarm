# M1B exit report — crash-safe protocol

- Report: 2026-08-20（M1B 收尾，由项目管理工程师执行，issue #8）
- Milestone: M1B（docs/07），前置 M1A exit 报告 `2026-08-20-glm53-m1a-report.md`
- Verdict: **M1B complete** — F2/F3/F6/F7 关闭；F7 的 usage 写合并伴随项属 M1C（#13）；M1C 未开始

## 1. Exit criteria 核验（docs/07 M1B）

"F2, F3, F6 和 attempt 增长部分（F7）被真实崩溃/故障注入测试关闭"：

| 要求 | 证据 |
|---|---|
| F2 崩溃窗口（目标已接受/Store 未 ack → 不重投） | `tests/message-delivery.spec.ts` scenario 5（真实组合：Jsonl 持久化 + 官方存储栈；断言目标历史仅一份 + 补 ack）；红→绿证据在 PR #22 |
| F3 provisioning 对账（激活或 drain，无孤儿） | `tests/member-provisioning.spec.ts` scenario 6 崩溃半边 + 失配 drain + 不可判定路径；红→绿在 PR #24 |
| F6 邮箱语义（per-target pending + 有界回执） | `tests/team-domain.spec.ts` scenario 17（超配额全成功、修剪保序、v1 存量 1024 条兼容）；红→绿在 PR #25 |
| F7 attempt 上限（无 stale 复活） | `tests/team-attempt-retention.spec.ts` scenario 18（修剪后被剪 id 仍 TEAM_ATTEMPT_STALE、大小有界、v1 存量 300 条兼容）；红→绿在 PR #26 |
| 场景审计 | `pnpm verify:scenarios` PASS：12/30 machine-proven（1,3,4,5,6,7,8,11,12,16,17,18） |

## 2. Remediation diff 清单（供 M1D 独立回归审查直接取用）

M1D 审查员应收到本清单 + 原始审查报告 + manager intake（见 `docs/reviews/`）：

| 发现 | Issue | PR | 合并提交（main） | 要点 |
|---|---|---|---|---|
| 基线重构（非发现，审查前置） | #7 | #21 | `77974f4` | team-domain 拆分 6 子域，护栏零例外，纯重构 |
| F2 目标侧去重 | #3 | #22 | `0b68461` | 帧身份折叠 + `sessionPersistence.inspect` + flush-后-ack；新增 required inject `sessions` |
| F3 persisted-child 对账 | #4 | #24 | `83231a2` | 官方四要素 + live-preferred 枚举 + drain/激活/不可判定三分支；`session-acceptance.ts` 共用折叠 |
| F6 邮箱配额语义 | #5 | #25 | `9a1346b` | `maxPendingMessagesPerMember=64`、`TEAM_MAILBOX_FULL`、`maxRetainedMessages=256` 事务内修剪；schema v1 不变 |
| F7 attempt 上限 | #6 | #26 | `a45e1b7` | `maxRetainedAttempts=64`、stale 锚定 `currentAttemptId`、保留集水位 generation；schema v1 不变 |
| （治理）jiuwenswarm 重 pin | — | #23 | `cbf9f59` | Gate C：漂移 diff 复核，proactive 域不采纳，证据面零变化 |

测试基线：36（M1A）→ 49（M1B 后）；5 个 spec 文件；CI 全矩阵绿。

## 3. M1C 交接（下一目标，issue #12-#15、#19）

按 GOALS.md 登记规则，M1C 的五个 issue 已就位：#13（F4 有界卸载+伴随组）、#19（官方兼容语义组）、#12（F10 调度自愈）、#14（F8 定界+快照）、#15（模型体验）。开工前置：`pnpm verify:gate-a` 重跑（本报告执行时已 PASS）。

## 4. 已知限制（诚实边界）

- usage 高频写合并未做（#13/M1C）；F4 卸载时限未做（M1C）；调度仍不看 live status（M1C/#12）。
- 整聚合写边界仍随任务/记忆增长（typed incremental backend 属后续里程碑）。
- F2 折叠为精确帧文本匹配；结构化 `TeamMessageSource` 留给官方 adapter（不影子注册其 source kind）。
- 真实 rc.8 CLI Profile 装配仍是 M1D 部署门（本机无 rc.8 CLI，F16 不变）。

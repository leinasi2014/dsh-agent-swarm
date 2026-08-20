# M1D 独立回归/安全审查委派书（草案 v1——#37/#38 证据落地后定稿执行）

- 委派人：项目管理工程师（ZCode 会话，受用户全权委托）
- 状态：**草案**——M1D-1（#37）与 M1D-2（#38）证据入库后，PM 补齐 §3 证据包索引的待定项并宣布生效；生效前审查不得开始
- 目标 issue：#39

## 1. 审查目标与威胁模型

对 dsh-agent-swarm 在 **M1A→M1D 全部 remediation（F1-F15 + 伴随项）** 上的回归与安全复审，最终 verdict 决定 M1 放行与 D1 dogfood 开放。重点威胁面：

1. M1B/M1C 修复是否引入新缺陷（崩溃安全、邮箱幂等、attempt 防复活、有界关停、Unicode/定界边界）；
2. 权威状态边界是否仍单一（`TeamDomainPort`/存储域；工作区无权威）；
3. 模型可见面（定界/快照/新工具输出 schema）的注入与上下文成本回归；
4. 官方 seam 消费面（rc.8 `141eb6f`）无影子、无 Agent Loop 修改；
5. 真实 Profile 装配/恢复证据（M1D-1/2）与声明一致性。

## 2. 项目/官方/参考根

- 插件仓库：`D:\Source\DSH\plugin\dsh-agent-swarm`（审查基准 = main @ 待定稿时 HEAD）
- 官方证据 checkout：`D:\Source\DSH\framework\deepseek-harness`（sparse @ 141eb6f）；完整 rc.8 工作区：`D:\Source\DSH\framework\deepseek-harness-rc8-full`
- 参考（只读）：`ref/dsh-agent-teams` @ 801954d、`ref/jiuwenswarm` @ 56da762

## 3. 证据包索引

| 输入 | 路径 | 状态 |
|---|---|---|
| 原始安全审查（不可变） | `docs/reviews/2026-08-20-glm53-full-security-review.md` | 已有 |
| Manager intake | `docs/reviews/2026-08-20-glm53-manager-intake.md` | 已有 |
| M1B remediation 清单 | `docs/development/2026-08-20-m1b-exit-report.md` §2 | 已有 |
| M1C remediation 清单 | `docs/development/2026-08-20-m1c-exit-report.md` §2 | 已有 |
| M1D-1 装配证据 | `docs/development/2026-08-20-m1d1-profile-assembly.md` | **待 #37** |
| M1D-2 恢复/关停证据 | `docs/development/`（#38 产出） | **待 #38** |
| 官方基线 | `docs/OFFICIAL_BASELINE.json`（Gate A 持续核验） | 已有 |

## 4. 模型与权限事实

- 审查员：独立 GLM-5.3 专用审查会话（与实现会话分离）
- 权限：按 docs/12 §3 委派时另行记录（full-access 需用户显式授权并 pin；默认最小够用）
- **无用户设定的时长/轮次/token/成本上限**（宪法与 docs/12 §1；PM 不得施加）

## 5. 允许写入

- 唯一：审查报告文件（路径 §7）。测试与诊断可运行；既有源/文档只读（本委派不含修复授权；P0/P1 修复由 PM 另行立案后回修复审）。

## 6. 严重度标尺

沿用原始审查分级（P0 现实可触发权限丧失/数据损坏；P1 现实可触发高影响；P2 有条件/受控；P3 低影响/流程）。verdict：`PASS` / `CONDITIONAL PASS`（附阻断清单）/ `FAIL`。

## 7. 报告路径与完成信号

- 报告：`docs/reviews/<日期>-m1d-regression-review.md`（入库后不可变，PM intake 单独成文）
- 完成信号：审查员自然结束并写入 verdict；PM 只做 docs/12 §5 的稀疏监控（不催收敛、不注入结论）

## 8. M1 放行规则

`PASS`（或用户明示接受的条件性结论）→ #40 执行：tag、里程碑关闭、D1 宣言；任何 P0/P1 阻断 → 回修循环（立案→委派→复审）。

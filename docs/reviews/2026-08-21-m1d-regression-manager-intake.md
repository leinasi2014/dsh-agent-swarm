# M1D 回归审查 — Manager Intake（2026-08-21）

- Intake 人：项目管理工程师（ZCode 会话）
- 对象：`docs/reviews/2026-08-21-m1d-regression-review.md`（verdict **PASS**）
- 结论采信：审查覆盖面（六威胁面 + 官方源码行级对照 + 败者路径专项）满足委派书 §1；局限声明（§5）诚实且不触及 verdict 依据。**PASS 采信，M1 放行条件满足。**

## 逐项裁决

| 发现 | 裁决 | 处置 |
|---|---|---|
| P2-1 assignment 认领确认落在 pending 形态（D1 同类窗口未随 #52 关闭） | **接受**。与 D1 同构的结构缺口，stranded 自愈只是缓解不是闭环；M2 的编排深化与 D2 并行自托管都会放大该窗口的暴露频率。 | 立 issue（M2 入口门）：#52 claimed-gate 同构推广到 `acknowledgeAssignment` + assignment-visibility 对称回归测试 |
| P2-2 `TEAM_SELF_MESSAGE` 对齐缺口（captain 自发消息 wakeup 形态永久不可投递 + 配额侵蚀） | **接受**。官方有明文语义而我方缺负向校验，模型可合法触达。 | 立 issue（M2 入口门）：`queueMessage` 自发送拒绝 + 负向测试 |
| P3-1 委派书 §1.6 写 2s、实现 5s | 接受（文档漂移：v2 定稿于 #56 落地前）。 | 本收尾 PR 内更正委派书文本并附更正说明 |
| P3-2 send 路径至多 5s 阻塞 | 接受为已文档化取舍（有界、换正确性）。 | 不动；官方 adapter 对齐时随 P3 表内"语义分歧"一并重估 |
| P3-3 pending-forever 活性角落 | 接受（fail-safe 方向正确，但"最终 delivered 或可重投"仅弱意义成立）。 | 纳入 D1 dogfood 观察清单（本 intake §观察项）；若 dogfood 实测出现长期 queued 事件，升级为 M2 修复项 |
| P3-4 `assignmentPrompt` 未围栏 team 名 | 接受（信任距离短，但 F8 的原则是模型可见面全围栏）。 | 并入 M2 入口门的 fence 卫生清理（与 tools.ts JSON 渲染取舍一并复审） |
| P3-5 GOALS 未登记 #52 | 接受（登记滞后）。 | 本收尾 PR 内补记 |

## D1 dogfood 观察清单（放行即生效）

1. **P3-3 角落**：长期 `queued` 且目标非 live 的消息出现频率；外部事件（新 wakeup/assignment/自返）是否总能触发收敛。
2. **官方分歧面**：waking ack 严于官方 `checkpointDelivered`——观察 dogfood 中是否出现依赖官方 pending-ack 语义的消费方冲突。
3. **assignment 窗口（P2-1 缓解有效性）**：dogfood 重载/关停期间的 `stranded=owner-not-live` 证据出现率与 captain reassign 响应。
4. CI `.dsh-mkdir` 抖动频率（守卫自愈率）——持续偏高则立上游 issue。

## Remediation 排期（非阻断，M1 放行不依赖）

- **M2 入口门**（M2 开工前完成）：P2-1、P2-2、P3-4（fence 卫生）——各一 issue、worktree 隔离、双绿合并。
- **随收尾 PR**：P3-1（委派书更正）、P3-5（GOALS 补记）。
- **dogfood 期间观察**：P3-3（条件升级）。

## 流程备注

- 审查中途一次模型请求超时（基础设施），经原席位恢复续跑完成，审查独立性未受影响（同一席位、同一基准、无 PM 结论注入）。
- 本 intake 遵循 docs/12 §5/§6：不改写审查结论、不替答 verdict；上表"裁决"仅针对处置排期，不修改发现的严重度或内容。

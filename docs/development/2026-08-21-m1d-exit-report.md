# M1D 出口报告 — 装配验收与 M1 放行（2026-08-21）

- 报告人：项目管理工程师（ZCode 会话）
- 结论：**M1D 完成，M1 放行**。退出标准（docs/07 M1D）逐项核验见 §2。
- 基准：main @ 本报告合并后 HEAD（tag `m1d`）；测试 85/85（17 套件）；场景审计 16/30（机器证明口径不变）。

## 1. M1D 交付清单（issue → PR → 提交 映射）

| 项 | issue | PR | 合并提交 | 内容 |
|---|---|---|---|---|
| M1D-1 Profile 装配 | #37 | #48 | （见 PR#48） | 双环境（官方 rc.8-full + 用户 runtime）真实 Profile 装配、`--dump-config`、fail-closed 语义核验，零缺陷 |
| M1D-2 重载/恢复/关停 | #38 | #51 | 99b2b96 | 4 项验收全过（reload/recovery/teardown/跨重载一致性）；**发现 D1**（§7.1 取证：wakeup `delivered` 但从未模型可见） |
| D1 修复 | #52 | #54 | 2142aa0 | waking 确认仅认领形态（claimed `user/message`）；pending 视为瞬态、idle 边沿重扫恰好一次补投 |
| D1 追补（CI 时序） | #52（同族） | #56 | e1a0dfd | claim grace 2s→5s（冷 runner 首次成员组装；作者本地提交因静默推送失败未进 #54，PM 核 head 实证后捡回） |
| CI 守卫修复 | — | #57 | b666766 | `.dsh-mkdir` 签名重试守卫捕获缺陷（Tee 拿不到子进程 stderr，三连哑火）→ 文件捕获 |
| 测试窗口加固 | — | #58 | e67ffb6 | message-delivery 9 处 5s 窗 + 测试预算双重缺陷修复（D1 契约迁移遗留） |
| 审查委托书 v2 | #39（前置） | #55 | 3c68798 | 证据包索引齐备 + D1 回归面入威胁模型 |
| 独立回归审查 | #39 | —（报告转录） | — | **verdict PASS**（无 P0/P1）：`docs/reviews/2026-08-21-m1d-regression-review.md` + intake `docs/reviews/2026-08-21-m1d-regression-manager-intake.md` |
| 运维教训库 | — | #59 | cb80a5b | Skill 教训 24-28（句柄丢失≠死亡/守卫须验触发/推送静默失败/长路径清理/窗口全量清点） |

审查发现的非阻断项已立案：**#60**（P2-1 assignment 认领可见性，D1 同构推广）、**#61**（P2-2 `TEAM_SELF_MESSAGE` 对齐）、**#62**（P3-4 fence 卫生）。三者构成 **M2 入口门**（M2 开工前完成）；P3-1/P3-5 随本 PR 更正。

## 2. 退出标准核验（docs/07 M1D）

1. ✅ **每个接受的 M1 blocker 关闭**：#37/#38/#39/#40 关闭路径见 §4；#52（D1，M1D-2 期间发现并接受）已随 PR#54 关闭。
2. ✅ **无 P0/P1 回归**：独立审查 verdict PASS（§1 威胁面 1/2/4/6 专项走查 + 官方源码行级对照）。
3. ✅ **独立审查员掌握最终 verdict**：GLM-5.3 审查席位（与实现会话分离、无时限/轮次限制、中途一次基础设施超时经原席位恢复）出具 PASS；PM 未改写任何结论（intake 仅处置排期）。
4. ✅ **仓库指向可复现提交**：main @ 3c68798 + 本收尾 PR；官方基线 `docs/OFFICIAL_BASELINE.json`（rc.8 @ 141eb6f）经 Gate A 持续核验。

## 3. M1 全景（M1A→M1D 收束）

- M1A 单权威域（`TeamDomainPort`/ADR-0007）→ M1B 崩溃安全协议（F2/F3/F6/F7，tag `m1b`）→ M1C 生命周期/协调/输入加固（F4/F8/F10/F11-F15，tag `m1c`）→ M1D 装配验收 + 独立回归审查（本报告，tag `m1d`）。
- F1-F15 全部关闭或明确决策；F16（rc.8 CLI）已就位；**D1 类可见性缺陷经发现→修复→独立审查确认闭环**。
- 测试从 78（M1C 出口）→ 85；新增第 16 个执行套件（wakeup-visibility）。
- 审查确认的与官方语义分歧（有意加固，须在官方 adapter 对齐时重估）：waking ack 严于官方 `checkpointDelivered`（pending 不 ack）；反向缺口 #61 待补。

## 4. D1 单写入者 dogfood 宣言（放行即生效）

按 ADR-0008，M1 放行即开放 **D1 单写入者 dogfood**：本插件可在**隔离 Profile**（独立 DSH_HOME、独立存储根、单写入者）下用于真实开发任务的自我托管验证。约束重申：

1. **仅单写入者**：一个 dogfood 会话一个 Team 一个存储根；并行编码自我开发仍属 D2（M3 门后）。
2. **隔离硬边界**：绝不触碰 `~/.dsh` 既有 Profile（headless/web）；绝不 mutable-link 运行中稳定 Profile。
3. **dogfood 观察清单**（intake §观察项，随 dogfood 持续记录）：
   - P3-3 pending-forever 角落：长期 queued 且目标非 live 的消息出现频率与外部事件收敛；
   - 官方分歧面：依赖官方 pending-ack 语义的消费方冲突；
   - P2-1 缓解有效性：重载/关停期间 `stranded=owner-not-live` 证据率与 captain reassign 响应；
   - CI `.dsh-mkdir` 抖动频率（守卫自愈率）——持续偏高立上游 issue。
4. dogfood 发现的问题按普通 issue 流转（发现→立案→修复→回归），不因自我托管绕过门禁。

## 5. 移交（M2）

- M2 目标与入口门：GOALS.md「下一个目标」提升为当前（含 #60/#61/#62 入口门与 `src/tools.ts` 594/600 行先拆分约束）。
- M2 规划陷阱已预登记：`docs/development/2026-08-20-m2-planning-note.md`（Team-run 无 chat 记录→overlay 为唯一真相；共享 wake budget；有界准入作为 fan-out 背压）。
- 遗留清理备忘：`ref/jiuwenswarm` 嵌套库内陈旧本地 `refs/heads/develop`（惰性本地状态，不在 verify 链内）——下次 Gate C 一并清理。

# M1D 独立回归/安全审查报告（2026-08-21）

- 审查员：GLM-5.3 独立审查席位（glm53-review）
- 基准：main @ 3c68798；官方 rc.8 @ 141eb6f
- 委派书：docs/reviews/2026-08-20-m1d-regression-review-commission.md（v2）
- 转录说明（PM）：本文件为审查员最终报告的逐字转录（转录入库，内容作者为审查员；HTML 实体引号还原为字面引号）。中途一次模型请求超时经恢复后续跑完成，不影响审查独立性。

## 1. 审查覆盖与方法（逐威胁面：读了什么、对照了什么）

本审查为纯静态对抗走查（本席位无执行工具；未运行任何测试或诊断命令，见 §5）。插件侧逐行读取：`src/runtime/message-delivery.ts`、`src/runtime/session-acceptance.ts`、`src/runtime/scheduling.ts`、`src/runtime/orchestrator-runtime.ts`、`src/runtime/member-provisioning.ts`、`src/runtime/usage-accounting.ts`、`src/runtime/disposal.ts`、`src/runtime/member-control.ts`、`src/runtime/authority.ts`、`src/runtime/providers.ts`、`src/runtime/prompts.ts`、`src/index.ts`、`src/tools.ts`、`src/domain/` 全部 8 个子域模块 + `state-validation.ts` + `graph.ts`、`src/storage/team-spec.ts` + `storage-domain-team-store.ts`。测试侧全文读取 `tests/wakeup-visibility.spec.ts`、`tests/message-delivery.spec.ts`，读取 `tests/official-compat-semantics.spec.ts` 主体（含 5 处断言迁移位），并 grep 核对全部 spec 的 phase 断言迁移位。证据文档全文读取：M1D-1、M1D-2（§7.1 = D1 取证）、M1B/M1C exit、docs/04 §6/§7/§8、GOALS.md、M2 规划笔记。

官方 rc.8 源码对照（`D:\Source\DSH\framework\deepseek-harness-rc8-full`）：`packages/core/agent/src/runtime-types.ts`（cancel/keepInbox、send/steer/inject、status 生命周期）、`packages/core/agent/src/inbox.ts`（claim/clear/splice 事件形态）、`packages/core/agent-loop/src/agent.ts`（preStep 认领先于模型请求：229 行；user/message 追加：282-284 行；turn 间不落 idle 边沿：324-329 行；kick finally 才置 idle：210-222 行）、`packages/subagent/subagent/src/continuation.ts`（followup 三态路由 502-531、interrupt keepInbox:true 590-593、finishDisposal 的 keepInbox:false cancel 1359-1364 及 1489-1490 注释、reportFrom 与 "Background subagent … reported:" 包裹 609-679、coldResume 的 lineage/descriptor 校验 945-994）、`packages/experimental/agent-team/src/session-message.ts`（官方 acceptance fold，与插件逐字节等价）、`.../mailbox.ts`（官方 dispatchOnce/checkpointDelivered/TEAM_SELF_MESSAGE/recoverFor）。败者路径专项走查：waitForClaim 的 abort/deadline 分支、flush 抛错分支、chains 串行化下的并发 CAS 失败分支、disposal 各 bound 步超时后置分支、withLock 链 poisoned 检查、waitForChange 的 close/abort 唤醒分支。

**威胁面 1（M1B/M1C 修复回归）**：F2 折叠（live/persisted 双读 + flush 后确认 + 三值语义）、F3（四因子 verdict + 不可验证 fail-safe）、F6（queued-minus-delivered 配额、非 queued 才可剪、queued 永不剪：team-domain-mailbox.ts:43-49,105-115）、F7（仅 terminal 可剪、currentAttemptId 永不剪、generation 水位单调：team-domain-board.ts:60-72,335-351）、F4（boundedSettle 败者全观察：disposal.ts:20-46）、usage 批写（cursor 幂等、升序折叠、恢复 refold：team-domain-budget.ts:87-122）、Unicode/NFC 名字折叠（`foldMemberName` `\p{L}\p{N}`，成员名不可能携带 fence 破坏字符：team-domain-shared.ts:36-59）、有界关停顺序与 closing 短路（orchestrator-runtime.ts:536-561）。未发现新缺陷。

**威胁面 2（权威边界单一性）**：权威聚合仅在 `agent_swarm` Storage Domain 单记录（team-spec.ts:148-156；ADR-0007）；工作区无权威写入；FileTeamStore 仅离线迁移读；store 跨 scope 读取 fail-closed（storage-domain-team-store.ts:110-112）；快照/等待均为投影（team-domain-projection.ts:17-24）。无违反。

**威胁面 3（模型可见面注入/上下文成本）**：fence 自适应反超（prompts.ts:26-32）数学上成立（n+1 反引号不可能出现在最长 n-run payload 内）；`messageFrame` 为存储记录纯函数，投递与折叠两侧同一 identity；声明位与 fence 位分离，`senderName` 经名字折叠不含反引号/换行。发现一处未围栏信任位与一处既有已文档化取舍（见 F5/F6）。

**威胁面 4（官方 seam 消费面）**：`inject` 列表仅官方服务（index.ts:64-72）；全部交互走公共 seam（followup/reportFrom/interrupt/drainContinuableChildren/inject/sessions.flush/sessionPersistence.inspect/storageDomain.open/systemPrompt.section/tools.register）；grep 全 src 无 prototype/monkeypatch/dispatch 直写；providers.ts 为插件私有注册表，不遮蔽官方服务；未修改 Agent Loop。无影子。

**威胁面 5（M1D-1/2 真实 Profile 证据一致性）**：逐项核对见 §3。

**威胁面 6（#52/D1 回归面）**：三值折叠语义（session-acceptance.ts:38-56 拆分 claimed/pending；message-delivery.ts:192-199 waking 读侧三值、quiet 侧保持 messageAccepted 二值）；5s claim grace 与 idle 边沿收敛链逐环验证（index.ts:199-201 → observeAgentIdle → recoverAgent:476-495 → requestSchedule → SchedulingPass 步骤 1；官方 agent.ts 324-329 证实 turn 间不产生 idle 边沿、kick finally 才置 idle，最终 idle 边沿兜底完成补认领 ack）；quiet 路径不变性（member 侧 inject+targetFlushedAndRecorded、captain 侧 reportFrom quiet 均维持 pending 认可）；reportFrom 对称性（官方包裹文本块不破坏 frame 谓词——谓词按 content.some 精确文本块匹配，coldResume 对 captain 不可达因 reportFrom 要求 live parent）；轮询循环中止正确性（claim 先于 abort 检查属正确次序：已耐久认领即 ack；flush 抛错 → 外层 catch → queued；deadline 过期 → queued → idle 边沿补 ack）；5 处旧断言迁移定位核对（message-delivery.spec.ts:222、:364；official-compat-semantics.spec.ts:383；stranded-ownership.spec.ts:86；model-experience.spec.ts:139，恰 5 处，且 official-compat:247/:314 两个快路径 delivered 断言属应保留形态）。

## 2. 发现（按严重度）

**P0：无。**

**P1：无。**

**P2-1｜assignment 认领确认仍落在 pending 形态——D1 同类窗口未随 #52 关闭（应修，建议 M2 前立案）**
- 证据：`src/runtime/scheduling.ts:142-149`（dispatchAssignment：`followup` 返回即视为送达）+ `:161-170`（随即 `acknowledgeAssignment`）；`src/domain/team-domain-board.ts:185-191`（`assignmentPhase → 'delivered'`，无 claimed 形态校验）；官方丢弃路径 `packages/subagent/subagent/src/continuation.ts:1364`（finishDisposal `cancel({kind:'parent'})`，keepInbox 缺省 false，1489-1490 行注释明言"durably clears whatever it never claimed"）；插件 `orchestrator-runtime.ts:547-554`（dispose 对 ownedChildren 逐个 drain 触发该路径）；恢复面仅补投 `reserved`（scheduling.ts:75-84）。
- 影响：assignment 帧在 [inbox 接纳 .. 首 pre-step 认领] 窗口内遭遇重载/关停 drain 时被耐久丢弃，而 attempt 已记 `delivered`：任务 in_progress、owner 冷置，store 与成员可见性背离（正是 M1D-2 §7.1 描述的 D1 形态，但作用对象是 assignment 而非 message）。窗口为冷恢复物化时长（亚秒至秒级），小于 message D1 的整 turn 窗口。
- 触发条件：重载/进程关停（或任何对成员的 disposal drain）恰好落在 assignment 投递的接纳-认领窗口内；removeMember/archive 因先 fence 不在此列。
- 缓解（已核实存在）：stranded 自愈覆盖 live-idle owner（60s 宽限，scheduling.ts:215-252）；冷 owner 以 `stranded=owner-not-live` 证据暴露（:273-279），captain 可 reassign。故定 P2 而非 P1。
- 建议：将 #52 的 claimed-gate 同构推广到 `acknowledgeAssignment`（或恢复 pass 对 `delivered` 且 owner 长期无认领证据的 attempt 提供复核），并补一条与 wakeup-visibility 对称的 assignment-visibility 测试。

**P2-2｜captain→captain 自发消息被准入且 wakeup 形态永久不可投递（官方 `TEAM_SELF_MESSAGE` 对齐缺口）**
- 证据：`src/domain/team-domain-mailbox.ts:36-40`（`captain` 伪名解析为 captainSessionId，无自发送拒绝）对照官方 `packages/experimental/agent-team/src/mailbox.ts:121`（`a Team member cannot message itself` / `TEAM_SELF_MESSAGE`）；`src/runtime/message-delivery.ts:116`（captain 分支要求 `sender.id !== captainSessionId`，自发消息落入 member 路径）与 `:152-161`（wakeup 走 `followup(captain, captainSessionId, …)`——把自己当 child）；官方 coldResume `continuation.ts:963`（authorizeLineage：captain 会话无 parentSession，拒绝）与 `:967-974`（无 continuable descriptor → NOT_RESUMABLE）。
- 影响：quiet 自发为自注入（pending 即 ack，怪异但有界）；wakeup 自发在每次投递尝试中抛错（message-delivery.ts:168-171 吞为 warn），消息永久 queued，每个调度 pass 重复尝试（日志噪声 + 对 captain 目标的 pending 配额侵蚀，上限 64 后 `TEAM_MAILBOX_FULL`）。工具 schema 明示 `target: captain or an active member name`（tools.ts:381），模型可合法产生该调用。无测试覆盖 `target:'captain'`。
- 触发条件：captain 模型调用 send_message 且 target 写 'captain'（或自身名折叠为 captain 伪名）。
- 建议：`queueMessage` 增加 `senderSessionId === targetSessionId → TEAM_SELF_MESSAGE` 拒绝（对齐官方），补一条负向测试。

**P3-1｜委派书文本与实现的 grace 值漂移**：委派书 §1.6 写"2s claim grace"，实现与 docs/04 §6 均为 5s（message-delivery.ts:46 `WAKEUP_CLAIM_GRACE_MS = 5_000`）。文档级不一致，不影响行为。

**P3-2｜send 路径延迟回归**：wakeup 发送给未及时认领的目标时，工具调用阻塞至多 5s（message-delivery.ts:99-110,167），官方 `dispatchOnce` 在 flush 后即刻返回（官方 mailbox.ts:280-289）。有界、已文档化的取舍；纯模型体验成本。

**P3-3｜pending-forever 活性角落**：冷恢复若在"帧已插入、认领未发生"之间失败，帧停在冷成员 inbox，`targetAlreadyAccepted` 恒返回 undefined（message-delivery.ts:198-199），系统自身不再为该消息重触发；收敛依赖任意外部事件（新 wakeup/assignment/成员自返/captain 干预）。fail-safe 方向正确（不丢、不重、store 如实显示 queued），与 docs/04 §6 声明一致，但"每条消息最终要么 delivered 要么可重投"仅在弱意义上成立（可重投的前提是 acceptance 既非 claimed 亦非 pending）。建议在 D1 dogfood 观察清单中记录该角落。

**P3-4｜`assignmentPrompt` 的 `Team: ${team.name}` 未围栏**（prompts.ts:62）：team 名仅 `nonEmpty(…,128)`（roster:42），可含反斜杠/换行；成员可自建 Team（F11 场景）后其成员名下的嵌套 assignment 提示携带该未围栏文本。当前接收面为该成员自己的子成员，信任距离短，注入增益有限；建议并入 M2 前的 fence 卫生清理。同族既有已文档化取舍：list_tasks 等工具输出以紧凑 JSON 渲染未围栏 task 字段（tools.ts:18-26，M1C exit §3.3 已登记）。

**P3-5｜GOALS.md M1D 条目未登记 #52**（GOALS.md:15-22 仅列 4 项）：#52/D1 修复在委派书 v2 与 docs/04 §6 在案，登记滞后，收尾 PR 应补记。

## 3. 与既有声明的一致性核对

| 声明来源 | 核对结果 |
|---|---|
| M1B §2 F2（帧身份折叠 + inspect + flush-后-ack + required inject `sessions`） | 与 message-delivery.ts/session-acceptance.ts 现状一致；折叠逻辑与官方 session-message.ts 逐字节等价 |
| M1B §2 F3（四要素 + live-preferred + 三分支） | member-provisioning.ts:249-302 一致；M1D-2 §4.2 的 failed 收敛路径与 `childVerdict` 分支吻合 |
| M1B §2 F6/F7（配额/修剪/stale 锚定） | mailbox/board 现状一致；v1 schema 不变（state-validation schemaVersion===1） |
| M1C §1 各项（disposalTimeoutMs=5000 同名同值、批写 seq 幂等、fence 反超、mailbox-first、CAS 守卫回滚、wait 窗口 10s-1h、quiet inject、keepInbox interrupt、Unicode NFC） | 逐项在源码定位属实（index.ts:75、team-domain-budget.ts:87-122、prompts.ts:26-32、scheduling.ts:66-71/185-203、authority.ts:35-39、member-control.ts:60、team-domain-shared.ts:36） |
| M1C §3 已知限制 | 三条（tools.ts 行数护栏、12 工具人类可读渲染、noProgress 电平契约）与现状一致，无扩大 |
| M1D-1（16 工具/1 节/fail-closed/双环境） | tools.ts 恰 16 个注册、index.ts:191-209 fail-closed 顺序（start 成功先于任何注册）支持其声明；真实 Profile 输出为自报告证据（见 §5） |
| M1D-2 §7.1 D1 取证与根因推测 | 与 pre-#52 代码形态及官方 turn/disposal 生命周期（agent.ts、continuation.ts:1364/1489）交叉验证成立 |
| #52 修复声明（docs/04:112） | pending-only 折叠三值、5s grace、quiet 不变、discarded 帧经 rescan 恰好一次重投、`tests/wakeup-visibility.spec.ts` 红绿——除 P3-3 弱化点外逐句属实；"5 处旧断言迁移"恰定位 5 处 |
| 与官方的语义分歧（需跟踪） | 插件 waking ack 现严于官方（官方 `checkpointDelivered` 以 pending 形态 ack，mailbox.ts:280-289 + messageAccepted）；docs/04 §6 已声明为有意加固。非缺陷，但官方后续若演进，此分歧须在官方 adapter 对齐时重估。另有 P2-2 的 TEAM_SELF_MESSAGE 反向缺口 |

## 4. verdict 与阻断清单

**verdict：PASS**（无 P0/P1 回归；M1 放行规则 docs/07 M1D exit "无 P0/P1 回归" 满足）。

非阻断跟进清单（建议 PM 在 D1 dogfood 开放前/中立案排期，不构成本次门禁条件）：
1. P2-1 assignment 认领可见性缺口（#52 同构推广 + 对称测试）；
2. P2-2 `TEAM_SELF_MESSAGE` 对齐 + 负向测试；
3. P3-1 委派书 2s/5s 文本更正；P3-5 GOALS 补记 #52；
4. P3-3 pending-forever 角落纳入 dogfood 观察项；P3-4 fence 卫生清理。

## 5. 审查局限

1. 本席位无执行工具：全部结论基于静态走查 + 库内证据文档与官方源码对照；未运行 `pnpm verify`、未复跑任何 spec，不对外声明测试通过。
2. M1D-1/M1D-2 的真实 Profile 运行结果为实现侧自报告证据（临时探针与驱动脚本已随 %TEMP% 销毁，不可复跑）；我核对了其与当前源码的结构一致性（工具数、fail-closed 顺序、恢复入口、disposal 步名），未独立复现其运行时观测。
3. PR#51/#54 的 GitHub 正文与 CI 记录不在库内，无法直接核阅；以库内等价物（测试文件、docs/04 §6、两份 M1D 证据报告）替代。
4. 测试侧非全文精读的 spec（team-domain、team-domain-m1c-hardening、unicode-names、attempt-retention、prompt-injection-delimiting、prompt-snapshot、dsh-composition、scheduling-discipline、stranded-ownership、migration、team-domain-port、team-assignment-checkpoint、member-provisioning、team-domain-port、model-experience 部分）仅做了断言位 grep 与选择性段落读取；`tests/helpers/*`、`src/migration/migrate-legacy-store.ts`、`src/storage/team-store.ts` 未逐行审（属 M1A 遗产面，非本次六威胁面核心）。
5. Windows 长路径/文件占用/原子写等平台行为（M1D-2 场景 4）超出静态审查可判定范围，采信其证据报告。

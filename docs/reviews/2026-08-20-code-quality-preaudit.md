# 代码质量预审报告（advisory，#39 独立回归审查的前置输入）

- 审查席：glm53-review 只读对抗审查（用户授权的空闲时段全量质量审查）
- 对象：main @ M1D-1 合并后；范围 = M1B+M1C+M1D-1 全部已合并交付（域层 9 文件、运行时 10 文件、工具层、9 spec、helpers）
- 性质：**advisory**——发现项由 PM 分诊立案（#47/#46/#45…），不构成 gate；分诊与修复证据将作为 #39 的补充输入
- 总体判定：需修改后通过（1×P1 现实可触发；无数据损坏级阻断）

## P1 现实可触发缺陷

- `[P1] src/runtime/member-provisioning.ts:129-149 | settleMember(active) 已提交后 afterActivation 失败的回滚半边制造矛盾终态` | 触发链：addMember → `settleMember(active:true)` 提交成功 → `afterActivation` 内 `accountAgentUsage` 直连 `recordSessionUsageBatch` 写失败（上游 jsonl `.dsh-mkdir` ENOENT flake 当日 CI 命中 4 次，证明该写路径真实失败）→ catch 分支的 `settleMember(active:false)` 必然抛 `TEAM_MEMBER_PHASE_INVALID`（成员已 active）→ 仅 warn → 排干 child → 向调用者抛原错误。终态：roster 行 active、child 冷、captain 看到 addMember 失败、重试同名撞 `TEAM_MEMBER_NAME_TAKEN`（F12 终身占用）。scenario 6（dsh-composition.spec.ts:370）只覆盖 settle 本身失败的半边（回滚成功、failed 终态一致），此半边零覆盖 | 修复方向：catch 内区分 settle 已否提交——未提交才回滚+drain；已提交则 afterActivation 失败降级为 warn、保留 active 终态 | **PM 分诊：issue #47，立即修复**

## P2 有条件缺陷 / 质量问题

- `[P2] src/runtime/scheduling.ts:161-170 | acknowledgeAssignment 的 revision CAS 对并发非任务写过敏，放大重复投递` | dispatch 与 ack 之间任何 bump revision 的写（usage 记账、quiet 邮箱 ack）都使 `task.revision` CAS 失败 → attempt 留 reserved → 下一 pass 对成员重复 followup 同一 assignment。注释已承认并接受 re-dispatch 语义，但该处 revision CAS 的保护面与 attempt fencing（`assertCurrentAttempt`）完全重叠，只增加触发面 | 修复方向：acknowledgeAssignment 放宽为 attemptId-only 校验（assignmentPhase 幂等已在域层）| **PM 分诊：issue #46**
- `[P2] src/domain/team-domain-budget.ts:104-108 | recordSessionUsageBatch 假定 entries 升序，乱序批静默丢账` | batch `[5,3]` 计入 seq5 跳过 seq3，与逐条提交语义不一致。当前两个调用方天然升序故未爆发，但该方法在公开端口合同上，第三方 Provider 乱序提交即触发 | 修复方向：折叠前按 eventSeq 排序，或端口文档强制升序并 fail-loud | **PM 分诊：issue #46**
- `[P2] src/runtime/usage-accounting.ts:71 | 每条 usage 事件链执行 findMembership → store.list(scope) 全量深验证` | flush 对 scope 内全部聚合做 deep-clone + `assertTeamState`，高频 assistant/message 下读放大 O(teams×聚合大小)；微批只合并了写侧——"整聚合写边界"已知限制的未登记读侧孪生 | 修复方向：session→team 缓存或把 membership 检查内联进 transact | **PM 分诊：backlog（#45，M4 一并）**

## P3 建议

- `[P3] team-domain-board.ts:94-97 | acceptanceCriteria/writeScopes/evidence 仅限单元素字节、数量无界`（补上限）
- `[P3] team-domain-shared.ts:74-82 | replaceTask/replaceAttempt 在 id 缺失时写 index -1 静默错位`（显式 findIndex 断言）
- `[P3] orchestrator-runtime.ts:391-394 | 超时兜底 snapshot 重读抛错会掩盖 changed:false 契约`（回退最后已知快照）
- `[P3] scheduling.ts:263 | armRekick 依赖"最小 deadline 单调不降"隐式论证`（加不变式注释）

**PM 分诊：全部入 #45 backlog。**

## 测试网与文档一致性（审查席核对）

- 场景标签与 docs/08 §7 audit 行（implemented = 1-9, 11, 12, 16-20）双向核对一致，无漂移。
- 抽查断言具体且强（attempt-retention 的 generation 单调+反复活红线+F8 fence 反超）；异步边界一致 `vi.waitFor`，未见恒真断言。缺口：P1 半边、healStrandedOwnership 的 claimTask 失败降级半边。
- 官方契约抽查无违背（`Agent.inject` quiet 语义、wait 窗口、quiet 不冷唤醒均与 docs/02 §7 相符）。

## 总体评价

代码质量趋势健康：域层纯函数化+单事务不变式纪律严明，fencing/修剪水位论证正确，store 锁与 waiter 唤醒在单进程模型下无 lost-wakeup，测试网强度高。最值得优先处理：P1-1、P2-2、P2-4。

## 核对范围声明

已读：src/domain 9 文件、src/storage 3、src/runtime 10、migration、index/tools、9 spec 中 6 个全文或关键段、helpers 3、M1B/M1C exit 报告、docs/08 §7、安装包 rc.8 类型引用面。未执行测试或构建（只读席）；`.dsh-mkdir` ENOENT 依已知背景记为上游 flake。

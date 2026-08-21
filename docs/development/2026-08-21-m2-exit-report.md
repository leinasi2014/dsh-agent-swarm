# M2 出口报告 — 官方 Workflow/Jobs 编排（2026-08-21）

- 报告人：项目管理工程师（ZCode 会话）
- 结论：**M2 完成**。docs/07 M2 Exit 四项逐项核验见 §2；两项尾巴 + 一项诊断转 M3 入口门。
- 基准：main @ 本报告合并后 HEAD（tag `m2`）；测试 121（25 文件）；场景审计 19/33。

## 1. 交付清单（issue → PR → 合并提交）

| 项 | issue | PR | 合并 | 内容 |
|---|---|---|---|---|
| 前置：tools 拆分 | #74 | #81 | 9de8103 | src/tools.ts 597 → 46 行薄壳 + 6 域模块（逐字节零行为证明） |
| WorkflowEngine 桥 | #75 | #85 | 9fbc8e1 | 官方抽象类实现经 ctx.isolate 注册；run overlay 独立域 agent_swarm_workflow（overlay-as-truth，陷阱 1 对策）；agent() 走完整 Team 协议；取消有界；崩溃恢复证据性重标 |
| JobRegistry 桥 | #76 | #87 | 044d4c0 | 只读投影（start/kill 拒绝）；无投影存储崩溃即重导；attempt 世代内化映射表 |
| 显式模式 + 双 owner | #77 | #86 | f230aa7 | orchestrationMode 配置；OrchestrationOwnership 单 owner 注册表；变异法四重验证的双 owner 对抗（场景 31） |
| 节点类型映射 | #78 | #89 | ed95f6f | 五类 SwarmFlow 节点 → 任务板构图糖（纯编译器，非第二引擎）；配额天然背压（陷阱 3）；场景 33 |
| 预算跨 run | #79 | #90 | 6b6b736 | adoptBudget 结转账本（run↔Team 1:1 不破）；耗尽收敛 failBudget；唤醒单一账本审计（陷阱 2，无旁路结论） |

伴随修复：#83 三重自愈缺陷（1924cd8，idle 边闩锁 + 原子 retryAttempt + reinstateAttempt）；F8 存活回归（7cb6dca）；结算窗口族（e67ffb6/a18b19b/PR#91）；CI 守卫双步加固（b666766/af3f35d）；Gate C 第四次 re-pin（2fe3b29）；泳道扩容治理（823239a）；运维教训 24-33（cb80a5b/14056b8/PR#88）。

## 2. 出口标准核验（docs/07 M2 Exit）

1. ✅ **模式可经 Profile 配置换**：`orchestrationMode: adaptive|workflow` 配置面（#77），缺省与 main 逐字节一致。
2. ✅ **双 owner 故障测试证明无重复指派/结算**：场景 31 四路攻击全拒 + 真实并发 pass 单帧投递 + 预算单计（#77，变异法红→绿四重：claim CAS/submit 围栏/所有权注册表/模式门）。
3. ✅ **取消/后台完成唤醒/重载/状态披露走官方服务**：取消镜像官方取消面（#75）；唤醒经官方 followup/claim 链（M1 语义）；重载 = overlay 域恢复 + 聚合 refold（#75/#79）；状态披露经官方 ctx.jobs 投影（#76）。
4. ✅ **worker-thread 隔离定位已文档化**：桥的 vm 脚本执行器弱于官方 worker 线程终止，作为已知限制记录于设计注记与 docs/04 §8f（非安全沙箱定位明确）。

## 3. 转 M3 入口门（不构成本次出口阻断）

1. **#92**：慢 runner 计费缺口诊断（usedTokens 226 vs 249 永久性缺口，疑 seq 游标乱序跳过——M1B 语义的 reorder-safe 修复，replay-safe 不得回退）；
2. **#93**：jobs 投影的模型面读工具暴露（M2 尾巴转正）；
3. **#94**：官方 UI 消费方对 team-task 投影的核验（M2 尾巴转正）。

## 4. 移交（M3）

M3 = 自托管安全纵切（D2 并行自我开发）：真实 per-attempt 执行根、独立可执行审查、候选验收 Profile 分离、外部晋升/回滚（ADR-0008）。入口条件：上列三项 + D1 dogfood 无未决阻断发现。D1 dogfood 观察清单继续有效（含 P3-3 活性角落、`.dsh-mkdir` 上游抖动频率观察——本周持续偏高，#92 诊断结果可能揭示关联根因）。

## 5. 双线联动

canvas C-M2 的协同项（视频生成长任务挂官方 workflow/jobs 面）随本出口解锁——swarm 侧桥面已稳定（isolate 注册 + overlay 域 + 双 owner 纪律），canvas 可开始对接设计。

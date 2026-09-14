# 05. Product feature mapping

JiuwenSwarm contributes product concepts and failure cases. It does not contribute runtime authority. Every feature below must land on an official DSH seam or a project-owned adapter with one explicit owner.

## 1. Capability map

| Product capability | DSH landing surface | Ownership rule |
|---|---|---|
| one-shot worker | `ctx.subagents.start()` | official Subagent Provider |
| persistent member | continuable subagent | official lifecycle plus Team member adapter |
| adaptive Team scheduling | Team task DAG and Scheduler policy | `TeamDomainPort` is the only task writer |
| deterministic workflow | `ctx.workflowEngine` Team bridge | Workflow owns run state; Team owns Team tasks |
| background observation/cancel | `ctx.jobs` or a read-only Team job projection | never shadow the default Job registry |
| human question/approval | `ctx.userQuestions` / `ctx.approval` | official interaction owner |
| token/request/retry/deadline budget | Team policy ledger | official token-meter remains a host-side measurement face |
| Worktree execution | managed workspace lease plus a Session/tool root that actually changes | prompt-only paths are forbidden |
| local/remote member | member Provider registry | one selected Provider per member execution |
| distributed reservation | remote control-plane lease/ACK Provider | transport is replaceable and absent from the Service contract |
| Team memory | authorized manual append through Team domain | compact categories, optional evidence references, bounded content and rule-based redaction; not task-board state |
| private member memory | Agent-scoped append-only memory domain | owning active member only |
| Skill Evolution | signal → proposal → validation → approval → write | Team supplies evidence, never self-authorization |
| tool permission | creation-time tool filter plus host sandbox/permission policy | deny-only overlays cannot widen host authority |
| Team UI | official Client extension points and read-only Host projections | UI owns no scheduler or persistence state |
| self-development | stable control Profile, managed writers, frozen candidate and separate acceptance Profile | candidate cannot accept or promote itself |

## 2. Adaptive and deterministic execution

Both modes can exist, but never advance the same Team concurrently.

- Adaptive mode lets the Lead and Scheduler create and assign work dynamically.
- Workflow mode fixes phases, barriers, schemas, human points and completion rules.
- Mode is selected at a lifecycle boundary. Runtime mode switching fails loud unless in-flight work has been explicitly settled.
- Workflow/Job/UI projections may merge observations for users; they do not duplicate the Team aggregate or mutate through a second route.

## 3. Worktree and self-development

Worktree isolation is true only when the actual execution cwd, filesystem capability and tools resolve inside the leased root. A declared path in a prompt is disclosure, not enforcement.

Repository self-development follows the [project binding](governance/project-binding.yaml) and [self-hosting boundary](13-self-hosting-dogfood.md): managed writers, immutable candidates, independent acceptance and promotion/rollback outside the candidate runtime.

## 4. Memory and Skill growth

Current Team memory accepts authorized manual append operations. It stores a category, bounded content and optional evidence references, with rule-based redaction. It does not extract accepted evidence automatically or verify that a cited result was accepted. Typical compact records are:

```text
[decision] choice, alternatives, trade-off and evidence
[lesson] condition, outcome and reusable response
[member] demonstrated capability and confidence
[context] durable project or stakeholder constraint
```

Skill growth is a separate future pipeline, not an implemented effect of appending shared memory:

```text
accepted signal
  → attributed proposal
  → deterministic validation
  → independent approval
  → versioned write
  → load in a later Agent lifecycle
```

That future pipeline must reject raw private reasoning and unsupported candidate claims as verified knowledge. A failed task may supply a reproducible, independently checked counterexample; its unaccepted output is not a validated lesson. Current rule-based memory redaction does not establish complete secret/personal-data detection or evidence authenticity.

## 5. Distributed boundary

The design separates:

- control plane: discovery, reservation lease, bootstrap, readiness ACK and release;
- data plane: tasks, messages, outputs, budget and durable status.

SDK, ACP, Redis Streams, gRPC or another transport may implement a Provider. The public service and stored Team records must not name one transport. Process-local serialization is never described as distributed atomicity; cross-process ownership requires lease, fencing and stale-writer rejection.

## 6. Explicitly out of scope

- embedding Jiuwen's Python Runtime or its transport stack;
- nine-channel IM adapters, proactive recommendations, AutoHarness, GitCode issue automation, media/phone toolkits and hardware KV-cache management;
- a plugin self-updater or multi-instance manager with promotion authority;
- a second MCP/tool ownership model;
- turn-level undo/redo or Session state copying outside official Session/fork behavior;
- pre-packaged expert groups that become a second roster authority;
- dynamic per-task rescoping of a persistent member until the official child seam can express it safely.

Implementation status and exit criteria belong in `docs/07-implementation-roadmap.md`; protocol details belong in `docs/04-core-protocol.md`.

## 7. Jiuwen 源码审计与采用限制

2026-09-13 依据仓库固定参考 `c7bf529a15dfdf422b854ee03f6ef1eb80f6fe24` 静态审计；不是运行验收。兼容性检查发现 develop 已前进到 `8c7bfecdf0cc7607b07763fe687e08bf24f6ab83`，本节仍只对固定提交作断言，未刷新 ref。其 `pyproject.toml:20` 引用外部 agent-core `0af325ebe9f891e53fa211dae3392a4aff9d923d`；本地 ref 不含该依赖实现，不能从调用点推定内核已通过恢复、安全或质量验证。

| 所读路径与事实 | 采用的设计 | 限制或避免事项 |
|---|---|---|
| `team_monitor_handler.py:get_team_snapshot` / `get_member_list_from_db`：从 core monitor 或持久成员定义投影 | 持久身份与运行态分开，休眠成员仍可发现 | UI 快照不证明每个模型已获得相关态势；不复制 TeamMonitor/RuntimePool |
| `team_helpers.py:_is_member_addressed`：委托 core 解析 @member、$sender、@all；`_deliverable` 避免重复身份信封 | 明确发送人、接收人与消息通道 | 文本前缀不作为授权；自主选人质量、跨队边界与恢复仍需本地验收 |
| `providers/skills.py:build_member_skill_toolkit` 与本地 SkillManager | 一份技能资产，成员可见性分开，安装不自动扩大显式 allow-list | DSH 继续使用官方 scoped SkillRegistry；目录可见不等于实际使用精确版本 |
| `evolution_rails.py` 导入 core 演进 Rail；gateway `EvolutionApprovalCoordinator` 有 auto_save 自动接受 | 提案、验证、批准和写入分别明确 owner | 不能称一律独立批准；不继承自动批准默认值，未读依赖不声称内核验证有效 |
| `skilldev/stages/plan_stage.py` 有 placeholder-skill；`test_run_stage.py:_run_single_eval` 抛 NotImplementedError；`evaluate_stage.py` 未调用 grader | 阶段分离、暂停恢复和对照思路 | 有阶段枚举、checkpoint 或 zip 包不等于真实试跑、评分与发布闭环 |
| `auto_memory/extraction_runner.py` 与 `memory/dreaming/sweeper.py` 有提取/整理/写入路径 | 原始证据、提取结果与可重建检索分开，限制写入范围 | 不照搬文件扫描器与并列数据库；自动写记忆不证明个人隔离或任务收益 |
| `symphony/evolution/service.py:record_plan_outcome` 按 evidence_id 去重并重建动态 overlay | 从结果事实构建可重建效果投影 | 图权重变化不是 Skill 发布或模型训练，也不证明因果质量提升 |

以上路径位于固定 [JiuwenSwarm 源码树](https://github.com/openJiuwen-ai/jiuwenswarm/tree/c7bf529a15dfdf422b854ee03f6ef1eb80f6fe24/jiuwenswarm)。对应 DSH 唯一职责及落点见 [架构](03-capability-family.md)，接口与验收见 [协议](04-core-protocol.md) 和 [实施顺序](07-implementation-roadmap.md)。产品宣传、外部依赖接口与本仓可运行实现分别对待。

## 8. LLM 蜂群研究与工程取舍

检索截至 2026-09-13，由调研专用子智能体读取论文摘要/相关正文、作者或官方仓库并抽查核心代码。以下是本次筛选到的研究，非穷尽书目；近期预印本的发布时间不代表成熟度。未安装运行这些仓库，论文实验不作为 DSH 本机收益或安全证明。表中日期为论文首发及所读修订版，版本化链接用于防止旧摘要与新结果混用。

| 论文与日期 | 借鉴设计及实验范围 | DSH 取舍与限制 |
|---|---|---|
| [Kernel-Managed Shared Memory for System-Wide Personalization](https://arxiv.org/html/2609.10144v1)，2026-09-09 v1 | owner/user/type/共享策略由确定性运行时过滤，排序和 token 预算统一；1800 次合成个性化任务、3 模型 | 采用默认私有、元数据和集中授权；其 Mem0 对照 private-only 与方案共享设置不同，不能泛化为全面优胜；文中 context injection 不证明抵抗恶意注入；不迁入 AIOS kernel |
| [Beyond Memory Majority: Latent-Source Reasoning for Multi-Agent Memory Arbitration](https://arxiv.org/html/2608.19701v1)，2026-08-20 v1 | 按潜在来源处理相关记忆，追溯反证；在三个记忆基准的受控相关性增强版本验证 | 转述同一来源不重复计票，保留出处与冲突；来源缺失的长期真实污染仍待证，暂不引入学习型仲裁器 |
| [Discovering Efficient and Explainable Communication Topologies for LLM-based Multi-Agent Systems via Causal Inference](https://arxiv.org/html/2608.12921v2)，2026-08-13 / 08-14 v2 | E2-Explainer 遮蔽通信边衡量贡献，按预算选子图；Qwen3-8B、6 基准，需校准样本 | 借鉴通信消融，先用规则选择同伴；静态问答/代码任务结果不证明长期协作收益，不直接引入 GNN/离线训练，路由成本计入总量 |
| [SkillJack: Persistent Skill Backdoors in Self-Evolving Agents](https://arxiv.org/html/2608.03509v2)，2026-08-04 / 08-07 v2 | 经验到技能可能掩盖污染并持久化；150 轨迹、2 系统，报告删除原始污染后仍有攻击持续 | 保留来源与派生版本、独立验收和撤销；删除原笔记不等于恢复。代码含 mock 验证，实验比例不外推为 DSH 实际风险率 |
| [CoEvoSkills: Self-Evolving Agent Skills via Co-Evolutionary Verification](https://arxiv.org/html/2604.01687v3)，2026-04-02 / 08-10 v3，论文页标注 COLM accepted | Generator、Surrogate Verifier、真实 oracle 分工；SkillsBench 85 任务及跨模型实验 | 借鉴职责隔离，最终保留集不得参与演进。代理通过后仍查询真实 oracle 通过/失败位，并非无真实反馈；新 Session 和同容器事后日志扫描不证明权限隔离 |
| [TacoMAS: Test-Time Co-Evolution of Topology and Capability in LLM-based Multi-Agent Systems](https://arxiv.org/html/2605.09539v1)，2026-05-10 v1 | 快环更新角色上下文/能力，慢环调整成员与通信边；4 个交互基准 | 借鉴有界节奏和关键角色保护；prompt/工具配置变化不是模型训练或跨任务成长。允许无收益时 no-op，不为显示演进而强制改图 |
| [MemSkill: Learning and Evolving Memory Skills for Self-Evolving Agents](https://arxiv.org/abs/2602.02474v2)，2026-02-02 / 05-24 v2 | controller/executor/designer 分工；LoCoMo、LongMemEval、HotpotQA、ALFWorld | 这里的 skills 是“如何记忆”的操作，不是业务技能。借鉴操作与内容分离；训练/选择/测试划分还需复核，当前恢复仅 outer-epoch 边界 |
| [Towards a Science of Scaling Agent Systems](https://arxiv.org/html/2512.08296v3)，2025-12-09 / 2026-04-08 v3 | 最新为 260 配置、6 基准、5 架构、3 模型家族；效果随任务结构显著变化，顺序规划可能退化 | 保留单成员、同工具同预算对照；成员更多不必更好，混模不保证错误独立。初步扩至9成员，经验饱和阈值不能硬编码，勿混用旧版180配置结果 |
| [Why Do Multi-Agent LLM Systems Fail?](https://arxiv.org/abs/2503.13657v3)，2025-03-17 / 10-26 v3 | MAST 14 类失败：系统设计、成员错位、验证；分类来自150专家分析轨迹，最新数据1600+轨迹/7框架 | 作为原 Session 轨迹复盘标签，帮助定位任务不清、错误交接、缺乏验证；不是自动修复器或独立归责权威 |
| [Improving Multi-Agent Debate with Sparse Communication Topology](https://arxiv.org/abs/2406.11776v1)，2024-06-17 v1 | 有限轮 debate 中稀疏通信可节约计算并保持质量 | 作为固定稀疏对照；不能证明生产投递、长期状态或成长闭环，首版不强制全连接 |

前3项、Scaling 和稀疏 debate 的论文专属作者仓库本轮未核实；不把第三方复现冒充作者代码。MAST 的 [作者数据与代码](https://github.com/multi-agent-systems-failure-taxonomy/MAST) 用于诊断研究。重点工程仓库核查如下，tree SHA 是 Git 树身份，非发布版本或运行验收；未固定版本的规范不得当作正式依赖 pin。

| 官方/作者仓库 | 所读身份与许可情况 | 可以采用 / 不能推定 |
|---|---|---|
| [A2A](https://github.com/a2aproject/A2A) / [规范](https://a2a-protocol.org/latest/specification/) | 未归档，Apache-2.0；所读 latest 未固定 release，API 最近推送 2026-09-11 | AgentCard 的能力/Skills/认证描述可参考；Send Message §3.3.1 仅 MAY 幂等，推送也可能重复，协议不提供任意业务 exactly-once。后续仅作为互操作 adapter |
| [CoEvoSkills](https://github.com/Zhang-Henry/CoEvoSkills) | Apache-2.0；tree `da5a53db0e6d12e61e81e64588ad085e37a73e19` | `independent_verifier.py` 有独立 Session 与 pytest；同 Docker 容器及事后越界日志扫描不能替代实际工具/文件授权，正式验收继续独立于候选 |
| [MemSkill](https://github.com/ViktorAxelsen/MemSkill) | Apache-2.0；tree `9907c35f8cc71684d06a1f00e0b9c5c4a7b12c4c` | 操作库/困难案例迭代/checkpoint 可研究；只读 README/树，未完整审计训练。test-query sampling 配置提示须核查拆分，既不宣称泄漏也不宣称无泄漏 |
| [TacoMAS-MultiAgent](https://github.com/chenxu2-gif/TacoMAS-MultiAgent) | tree `6f0d545f2493cf95d2eb6a325d1a6686acf658eb`；API license=null，所读树未见 LICENSE | `evolution_controller.py:_force_min_graph_change` 明确为让演进可见而强制图变化，不采用。许可未明不直接复制代码；只参考机制 |
| [AI-Infra-Guard / SkillJack](https://github.com/Tencent/AI-Infra-Guard/tree/main/Research/SkillJack) | 根仓 Apache-2.0；tree `036c39bd03b39ce4a811f7f125bc3b8f47e39b7c`；子目录另写 research purposes only，适用关系未判定 | 借鉴污染、派生和撤销的防御实验；外部依赖 clone 地址仍有占位，mock 与真实执行分开，不把仓库存在当作复现完成 |

## 9. 将研究转为本地验收

下列是设计推论与实验建议，不是论文直接证明的 DSH 能力；沿原测试/验收入口执行，不新建框架或第二裁判系统。

| 需要验证的选择 | 最小对照/故障 | 判断依据 |
|---|---|---|
| 选择性通信是否值得 | 同模型/工具/总预算，比较单成员、全广播、固定稀疏及规则选择；覆盖可并行、严格顺序、公开审查，加入关键阻塞与无关高频消息 | 关键相关消息不漏达，无关成员不唤醒；质量、实际 token、路由成本、总延迟与失败分别记录。小样本仅证明路径/趋势，不宣布统计收益 |
| 是否避免错误共识 | 三人转述同一错误来源，另有独立反证；比较同模型、混模型、独立工具核验 | 同源转述不计为独立证据；保留分歧，Captain 按证据验收，混模效果实测 |
| 投递是否可恢复 | 提交后/发送后/消费后崩溃、重复/乱序、重启、退出后迟到 | 原记录与 Session 可重建，无静默丢失；消息幂等与外部业务 effect 分别界定，超时不等于任务取消 |
| 记忆是否守住边界 | 本人私有、同队共享、外队事实，撤权、过期版本、恶意指令型记忆 | 检索、摘要、工具结果和实际请求均不新增泄漏；撤销阻止后续注入，不宣称已见历史可以遗忘 |
| 技能是否实际改进 | 原版/候选版、演进集/最终保留集，限制 oracle 反馈；污染经验→技能→删来源→撤销派生 | 确定版本实际加载，保留集未参与演进，结果与成本有对照；派生版本可定位撤销，无收益允许不发布，文件/发言/技能数量不作为成长指标 |

第一交付优先 C1/C2 公开协作，规则感知随后接入；通信拓扑学习、记忆仲裁训练和大规模自动演进均须在基础闭环与上述对照形成证据后再评估。完整架构、唯一职责和工作量窗口继续只由 [03](03-capability-family.md)、[04](04-core-protocol.md)、[07](07-implementation-roadmap.md) 承载。

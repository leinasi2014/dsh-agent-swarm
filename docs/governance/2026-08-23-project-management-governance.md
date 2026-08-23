# 项目管理与多智能体治理规范

状态：`APPROVED / IMPLEMENTATION_PENDING`

本文件只回答：谁负责、怎样拆分和派工、允许多少并发、何时审查/复审、如何判定任务完成、异常时怎样暂停和恢复。Git、worktree、CI、合并与发布的技术执行见《项目开发规范》。

## 1. 治理目标

治理必须同时实现：

- 一个结果只有一个最终责任人；
- 一个可变工件同一时刻只有一个写入权威；
- 多智能体只并行互相独立的工作包；
- 候选、审查、集成和关闭均有可验证证据；
- 风险越低，流程越短；同一候选不重复审查；
- 会话结束、智能体自报完成、PR merged 和用户验收是不同状态。

不建设为了治理而存在的治理平台。规则只有在能改变风险决策、阻止真实错误或缩短恢复时间时才进入必需门禁。

## 2. 权威与角色

| 角色 | 责任 | 禁止 |
|---|---|---|
| 用户/Owner | 最终产品目标、重大范围与外部权限 | 被智能体默认扩张授权 |
| 主脑/Accountable Lead | 范围、风险、依赖、验收、任务调整和是否发布 | 重复独立 reviewer 的同一轮代码审查 |
| 实现智能体 | 在声明的文件面内实现、自证、冻结候选 | 修改主树、他人领地、共享权威或自行验收 |
| 独立 reviewer | 对最终候选做一次必要审查 | 修复自己审查的候选或批准移动中的工作区 |
| Observer/监工 | 观察已提交状态、风险和阻塞，向主脑建议 | 写代码、重新派工、批准、合并或替代主脑决策 |
| Integrator | 串行核验并晋升已接受候选，完成关闭 | 修改候选后继续使用旧 verdict |
| Publisher | 从受保护权威 main 晋升同一制品 | 从 worktree、镜像或未接受分支发布 |

LOW 不要求强制角色分离；MEDIUM 要求 reviewer 非作者；HIGH 的 author、reviewer、integrator、publisher 按服务端稳定身份分离。主脑的风险/发布授权不是第二轮代码审查。

## 3. 风险分级

### LOW

文案、注释、无状态纯视觉、孤立组件、只新增且不削弱断言的测试。不改合同、权限、持久化、CI、锁文件或发布。

- 作者自证 + 自动 affected checks；
- 默认不要求人工 reviewer；
- 敏感路径、分类不确定或抽样命中时升级 MEDIUM。

### MEDIUM

普通功能/缺陷、RPC 内部实现、非破坏性存储、生命周期、Manifest、构建和共享组件。

- affected CI；
- 一名非作者 reviewer 审一次最终候选；
- 主脑只确认风险和门禁事实。

### HIGH

凭据/权限、206 管理、治理控制面、破坏性迁移、发布、运行时制品替换、数据真源和 breaking contract。

- 主脑确认范围、威胁和回滚；
- 安全/领域 reviewer 并行收敛成一轮；
- 独立集成/发布；
- 发布级验证只施加到真正发布的制品。

风险按影响而非文件扩展名判断。治理、CI、权限、凭据、锁文件、发布和破坏性合同即使是 Markdown/YAML 也不得列为 LOW。

## 4. 任务拆分与 WIP

工作包必须按工件边界和依赖拆分，不按希望启动的智能体数量拆分。每个工作包至少声明：

- outcome、scope、non-goal；
- owner、owned paths、forbidden paths；
- base identity、依赖和预期集成顺序；
- 风险级、受影响验证、需要的证据；
- stop/escalation 条件。

共享 schema、治理文件、锁文件、CI、迁移、release manifest 和集成始终单写者。

最大活跃写者：

```text
min(可用执行槽位, 独立工件边界, 审查与集成承载力)
```

满足任一条件即停止新增写泳道：

- 等待审查或集成的候选超过 2 个；
- 最老候选超过一个集成周期；
- 共享合同/CI/governance/release 正在修改；
- 权威 main、必要门禁或依赖合同为 RED/UNKNOWN；
- 存在未登记、不可恢复或无法裁决的活跃候选。

只读研究、审查和观察可以继续并行。

## 5. 普通任务状态

只使用五个派生状态：

```text
OPEN -> CANDIDATE -> ACCEPTED -> INTEGRATED -> CLOSED
OPEN/CANDIDATE -> ARCHIVED
```

- CANDIDATE：最终 head/base/change digest 已冻结；
- ACCEPTED：满足风险级的唯一验收已绑定该候选；
- INTEGRATED：权威 main 的结果 SHA 已验证；
- CLOSED：本地 worktree/branch 已回收或有明确保留决定；
- ARCHIVED：候选具备经过恢复验证的持久位置。

镜像和本地清理失败不会让代码退回重新审查；它们形成可重试的运维/清理事件。HIGH release_required 任务只有 promotion/release 完成后才可关闭。

## 6. 审查一次生成、按需复用

以下不触发人工复审：

- 同一候选 SHA 的 CI 重跑或基础设施失败；
- main/base 前进但 effective diff 和相关上下文未变；
- merge queue、主线验证、镜像、发布晋升或 cleanup 重试；
- 状态/文档视图重新生成；
- 已接受的同一制品在环境间晋升。

只有以下情况触发复审：

- effective diff 变化；
- 手工冲突解决或与 base 变化面重叠；
- changed paths、风险、权限或合同影响扩大；
- 相关策略、依赖、工具链或 producer contract 变化；
- reviewer 撤回；
- 主线验证发现必须改代码。

普通修订做 delta review；只读上一批准候选以来的新 diff 和 finding-to-fix。只有安全边界或整体设计改变才重做完整审查。

严禁 PM 在独立审查后再重复相同代码审查，或多个 reviewer 串行重复读取同一候选。HIGH 的安全/领域视角并行完成，最终一次收敛。

## 7. 派工与工作区绑定

每次创建 DSH/其他智能体会话必须显式设置：

- project/workspace identity；
- repository root；
- provider/model/reasoning；
- read-only 或 write 权限；
- branch/worktree/base；
- 允许/禁止文件面；
- 交付和验收命令。

不能继承当前侧栏分组或上一个会话的 workspace。会话误归类只修复会话归属，不移动仓库或项目文件。监工是否运行以会话状态和可见事件为准，不以“已经派过”推断。

## 8. 监督与任务调整

监督只观察物化事件：candidate SHA、提交、CI、review verdict、阻塞、lease、merge/main 结果。不要轮询私有思考，也不要用叙述长度当进度。

主脑在以下情况调整任务：

- owner 越界或两个 writer 争用同一工件；
- 重复同一失败且没有新证据；
- 工作包过大，长时间没有可审候选；
- 依赖/合同改变；
- review/integration 队列成为瓶颈；
- 会话所在 workspace、仓库或模型与任务不符。

调整前记录原因和新的边界；Observer 只能建议，由主脑决断。

## 9. 暂停、外部中断与恢复

206、模型服务、CI 或宿主不可用时：

1. 停止新的外部写入和新 worktree；
2. 让当前 writer 在安全边界冻结本地候选和状态；
3. 记录未完成外部副作用，不把基础设施中断标为代码失败；
4. 服务恢复后先读取远端真相、main SHA、open change 和 active worktree；
5. reconcile 后再恢复任务，不重做已存在的候选/审查。

仓库移动时只使用 Git 原生 worktree move/repair 和动态 root/common-dir 发现。禁止把旧绝对路径复制到规范或继续在旧位置创建任务。

## 10. 过去两天真实开发经验

| 实际问题 | 根因 | 固定解决方式 |
|---|---|---|
| 大量会话结束但 worktree/分支仍存在，最终集中清理 | 把 session finished 当作 task closed；merge 与 cleanup 分离 | `INTEGRATED/CLOSED` 分开；pre-cleanup intent、幂等回收、cleanup-result；定时 reconcile |
| 创建了过多隔离树，集成队列远慢于写入 | 并发按模型数量而非集成能力扩张 | WIP 由独立边界和集成承载力决定；队列超过2停止新 writer |
| H4a/H4a4 大任务堆给一个智能体，排出长队 | 按里程碑标题派工，没有按工件/依赖拆分 | 先拆 contract、host service、projection、RPC、tests；共享面串行 |
| 审查会话出现在“视频”工作区，其他会话进入未分组 | 新会话继承当前 UI workspace | 派工前显式 workspace/project binding；错误只重建/归类会话，不移动仓库 |
| 仓库和 worktree 位置被移动后仍引用旧绝对路径 | 规范写死本机路径，未以 Git common-dir 为真源 | 动态发现 root/common-dir；移动后 repair + reconcile；绝对路径只存在于本地任务缓存 |
| 206 重启期间仍有继续派工的倾向 | 外部服务中断没有单独状态 | 冻结新写入、保存候选、恢复后先读远端真相；不把中断触发成重复开发 |
| GitHub 与 206 都被当作 origin/主线 | 缺少唯一权威和单向晋升规则 | 206 唯一开发权威；GitHub 异步镜像；镜像不反向发布 |
| 已归档候选只剩当前机器本地分支 | 删除物理目录前没有耐久恢复位置 | 重要候选先建立受保护 archive ref 或验证过的 bundle，再回收 |
| 新旧 Skill、GOALS、roadmap 和脚本互相冲突 | 动态状态复制到多份文档 | 稳定规则版本化；动态事实来自206；其他文档只做生成/校验视图 |
| `pnpm verify` 绿但真实发行脚本未接线 | 只检查文件存在或脚本名，不检查调用链 | 每类 Gate 一个真实入口；总验证必须调用它；正反例验证实际路径 |
| schema/manifest 存在但没有真实消费者/validator | 把词汇冻结误当运行时能力 | 合同必须包含 endpoint、fixture、handshake、lifecycle 和 consumer conformance |
| HTTP 200/Node smoke 被误写成浏览器 UI 完成 | 证据等级未区分 | L0静态、L1单元、L2产物、L3官方Profile、L4真实UI；声明不得越级 |
| UI 作者没有先看真实截图，审查者才发现样式问题 | 作者自证只跑代码测试 | UI 作者必须先读截图/交互；多模态复核为补充，不替代自动门禁 |
| 监工会话被期待实时指挥开发或直接批准 | Observer 与主脑/审查权混淆 | 监工只报告证据与建议；任务调整、批准和合并仍由主脑/指定角色 |
| 上游 DSH/pi-ai/参考仓升级引发跨仓状态漂移 | 只记录版本名，没有实际安装/contract handshake | 按真实合同边 pin resolved version/integrity/SHA；变化只使受影响 feature flag STALE |
| CI 事件处理故障导致重复推提交重触发 | 把平台故障误当代码变化 | 增加 manual dispatch/concurrency；同 SHA 重跑不生成新候选或触发复审 |

这些经验来自近两日 worktree 清理提交、吞吐恢复纪律、跨仓经验文档、UI 多模态自证、promotion 崩溃/Windows 修复和 CI 事件故障。环境性能调参不进入治理规则，只按外部依赖暂停/恢复处理。

## 11. 复盘与指标

只在用户可见故障、数据损坏、发布回滚、安全/门禁绕过、同类问题重复或监控漏报时做正式复盘。普通 CI 红不自动创建事故文档。

最小系统指标：

- lead time；
- review/integration queue age；
- change fail rate；
- failed deployment recovery time；
- rework rate；
- 未裁决候选和镜像漂移时长。

不按 token、模型品牌或单个智能体输出量考核。

## 12. 管理闭环退出标准

- 任一活跃任务可回答 owner、risk、scope、candidate、next decision；
- 没有两个 writer 同时拥有同一可变工件；
- LOW/MEDIUM/HIGH 走不同长度流程；
- 同一候选不会因 CI/镜像/cleanup 重试重复审查；
- session、task、candidate、integration 和 close 状态不再混用；
- 外部中断和仓库移动可以恢复而不重做已完成工作；
- 动态 WIP 不超过 review/integration 承载力；
- Observer、reviewer、integrator 和主脑权责没有重叠歧义。

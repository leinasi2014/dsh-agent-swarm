# 04. Team 核心协议

本文件定义插件运行时必须共同遵守的身份、状态、并发、权限、持久和错误合同。实现细节可以重构，以下语义不能被 UI、Provider 或兼容层绕过。

## 1. 身份拓扑

```text
Main Brain Session（Team 外）
  └─ managed create → 独立 Captain Session
                         └─ Team aggregate
                              └─ continuable Member Sessions
```

- Main Brain 传递完整用户目标并创建 managed Team；之后只做跨 Team 观察和路由。
- Captain 是 Team 的唯一管理主体，负责身份档案、招募、任务、公告、公共目标、审核和重派。
- Member 只能读取其所属 Team，并在分配给自己的当前 attempt 上提交工作。
- 一个 Session 可参与显式寻址的多个上下文时，隐式 Team 解析必须拒绝歧义。
- UI 中的“当前队长会话”与 Main Brain Chat 必须清楚区分；打开 Captain 只导航官方 Session。

## 2. Team aggregate

一个 Team 至少包含：

- `teamId`、scope、状态、revision、创建/更新时间；
- root Captain Session 绑定与 Captain identity profile；
- member roster、runtime descriptor、profile phase 与失败原因；
- task DAG、每任务 revision、owner/target、attempt 历史与 review 结果；
- mailbox message/receipt；
- public goal、announcement、shared memory、budget/usage；
- bounded effects、verification declarations 和恢复信息。

Team 阶段为 `staged | active | archived`：`staged` 是 Plan-first 声明态（尚无 Captain Session/成员/任务，`captainSessionId` 为空标记），`active` 进入正常编排，`archived` 为终态；`discardReason='discarded'` 标记被放弃的计划草稿（staged→archived，幂等）。

聚合通过 schema 验证后整体提交。新增 durable 字段（如 `planDraft`）必须同时修改类型、Storage Domain schema、state validator、reload 测试和读 projection；只改 TypeScript 类型不算实现。

### 2.1 Plan-first staged 审批

- `agent_swarm_create_managed(stage=true)` 仅创建 staged 聚合，不 provisioning Captain；same-managed-origin 重复调用幂等返回既有 staged Team。
- `agent_swarm_set_plan` 写入有界 `planDraft`（成员声明含可选 route/deny，任务图用 plan-local key + dependencies + target），revision CAS。
- `agent_swarm_approve_plan` 先把 staged→active 原子提交（durable authority first），再 provision 声明的专用 Captain、成员与任务图（key→真实 task id、target→member session、依赖接线）；`ask_user=true` 走官方 `ctx.userQuestions` 单一问题，放弃选项直接归档；缺服务 fail-closed。
- 审批提交后任何 provisioning 缺失都由激活恢复路径补齐（`recoverApprovedTeam`：补 Captain/缺失成员/空任务图，幂等），不静默回滚。
- `agent_swarm_discard_plan` 归档 staged 草稿且不创建任何工作，幂等；被放弃的 Team 不会隐式复活。
- staged Team 不参与调度/成员资格；只读投影暴露 `plan` 摘要（声明成员/任务数），Main Brain 绑定允许唯一 staged Team。

## 3. revision 与 attempt 围栏

- Team mutation 在聚合 revision 上串行提交。
- 面向现有 task 的控制操作携带 `expected_revision`；stale revision 返回结构化冲突，不做部分写入。
- 每次执行生成唯一 attempt；submit/review/reassign 绑定当前 attempt 和 task revision。
- 旧 attempt、外来 owner、错误 target、重复 effect 和终态重放必须拒绝或幂等返回，不能覆盖较新状态。
- review reject、重派和自动调度的组合必须保持单一当前 attempt；缺少原子 seam 时保持失败可见，不伪装成功。

## 4. 任务与调度

任务状态围绕 `pending → in_progress → submitted → completed` 演进；review 可将 submitted 返回 pending 形成新的 fenced generation，失败/取消/归档按显式终态记录。`blockedBy` 形成有向无环图；只有依赖完成、预算允许、owner 可用且 orchestration owner 允许时才 ready。

Scheduler Provider 只选择可调度对象，不直接写 aggregate。Runtime 在 Domain port 上完成 claim，再把 assignment frame 投递到 continuable Member。投递只有在 frame 成为模型可见历史后才记为 delivered；pending inbox acceptance 不是稳定可见证据。

`adaptive` 模式由成员 idle/event 驱动；`workflow` 模式由 Team-backed Workflow run 驱动。一个 Team 同一时刻只有一个 orchestration owner，显式 Captain 操作仍受 revision/attempt 围栏。

## 5. 成员招募与身份

成员身份包含技术名、显示名、短职业、人格、个人简介/identity card、可选安全像素 SVG、model/provider、Skills 与工具权限投影。像素头像只允许一个有限 `svg` 根和 bounded `rect` 子元素；验证必须发生在 durable member commit 前。

成员创建顺序是：输入/route/tool-policy/identity 预检 → provisional provisioning → 官方 continuable child 启动 → descriptor/phase 提交 → 可调度。启动失败必须保持单一失败记录且可恢复容量，不能产生重复可见员工。当前 route 预检和失败 roster 回收的完整修复仍由 GitHub Issue #176 跟踪，未完成前 UI 必须显示真实失败状态。

Captain identity 独立于 Member roster。`set_captain_profile` 成功提交后，Host/RPC 下一轮 projection 必须发布新 revision；占位文案不能被解释为 Captain Session 创建失败。

## 6. 工具与权限

插件注册 26 个 `agent_swarm_*` 工具，按以下能力组维护：

- managed/team/member lifecycle；
- Captain profile、goal、announcement；
- task create/claim/submit/review/reassign；
- mailbox send/wait；
- budget、shared/private memory；
- status、members、tasks、jobs、managed Teams 等 read surface。

工具 schema 的 `name` 是机器协议，`description` 是模型和 UI 的语义来源。普通 UI 应显示本地化短说明，不直接堆函数名；不能解析时诚实显示 unavailable。

权限是单调收窄：官方 preset/tool runtime 先决定可用上界，插件 `allow/ask/deny` 不能扩大它。Captain-only 工具对 Member 永久不可用；Member policy 在 provisioning 时冻结进 descriptor。`ask` 只适用于当前 root Captain 的同一具体调用，delegated member 上等价 deny。

## 7. Skills 与成长

插件设置提供新 Team 默认 Skill allow-list，Team 可保存自己的 allow-list；成员只能使用 host catalog 与 Team allow-list 的交集。Skills 名称来自实际 catalog projection，用户不手填服务器路径。

私有记忆、共享经验、Skill proposal、验证、独立批准、发布/回滚是不同层。当前已实现成员私有记忆和 Team shared memory；自动经验提炼、语义检索、自动晋升和 Skill Evolution 尚未交付，不能从职业、头像或记忆推断能力。

## 8. 持久化、读取与 UI

- `agent_swarm` Storage Domain 保存 Team aggregate。
- workflow、human interaction 和 private memory 使用独立插件 domain，不能偷改 Team schema 权威。
- Host service 和 `/swarm/v1` RPC 只返回 bounded、caller-scoped projection。
- Team Workbench 只读取 projection；页面轮询以 revision/内容变化发布，不得永久缓存占位数据。
- 多 Team 切换通过 Main Brain/Host projection 选择 Captain Session，不在侧边栏维护第二套 Team registry。
- official Session list/Chat 仍由 DSH 拥有；插件只提供可读 label 与导航。

## 9. Review、execution root 与可选桥接

Review Provider 返回判定和 bounded evidence，Domain port 完成状态 mutation；候选不能审核自己。Executable review 运行于声明的 review root，并将命令、退出码和产物身份绑定当前 attempt。

Execution root 是每 attempt 的工作目录租约，不是开发 writer lane。插件为持有租约的成员安装 scoped tool Consumer，复用官方 `read`/`read_image`/`write`/`edit`/`pwsh`/`bash` 的 schema、真实 Agent 身份、执行实现与取消生命周期；文件相对路径和 shell cwd 自动解析到租约目录，拒绝显式目录越界及已有链接越界。持久 shell 每次命令先切回本次租约目录。Team namespace 和 Session header.cwd 保持不变；租约结束后旧成员的这些工具拒绝执行，不能回落到共享目录。此路径约束不解析任意 shell 代码，也不替代部署 sandbox 的 OS 隔离。

git-worktree 提交先以创建时 HEAD 为基线，在临时 Git index 中采集 committed/staged/unstaged/untracked 的非忽略文件与 binary diff，不改成员 index；排除租约 marker。补丁写入、flush、原子发布到工作目录外后才允许 Domain submit 和回收。捕获失败（含旧 marker 缺少基线）拒绝提交并保留租约，供明确恢复；不丢弃错误继续回收。crash residue 必须扫描、标记和交给显式清理，不静默删除。

Workflow bridge、Jobs projection、human control 和 remote/distributed Provider 都是可选面：启用条件、能力缺失、owner 和 disposer必须可见。Jobs 是 Team task 的只读 projection，不注册或替换官方 `ctx.jobs` 写权威。

## 10. 错误与未知结果

协议错误使用稳定 code，至少区分：输入无效、身份/成员关系错误、revision/attempt 冲突、依赖未就绪、额度/预算拒绝、Provider/route 不可用、存储失败、权限拒绝、能力未配置和结果未知。

- 验证失败发生在写前时，状态零变化。
- durable commit 后通知失败时，返回未知结果并要求权威读回，不能重复写。
- 不可恢复启动失败保留诊断但释放可用容量或提供 fenced cleanup。
- UI/RPC 不把缺数据、stale、loading、offline 和 failed 混成同一个“不可用”。

## 11. 配置合同

配置唯一来源是 `src/plugin/config.ts`，在 DSH Settings → Plugins → dsh-agent-swarm 展示。主要组包括启用状态、Captain/Member provider+model、成员深度、scheduler/review、成员/任务/消息上限、workflow/jobs/execution-root 可选面、tool policy、Team Skills 和 prompt order。

设置修改按 restart 语义生效；Runtime 构造前读取已保存层并验证组合。空 Provider、非法 workflow 组合、非法 execution root、冲突 tool tiers 或错误 Skill 声明必须在任何 listener/store/member side effect 前拒绝。

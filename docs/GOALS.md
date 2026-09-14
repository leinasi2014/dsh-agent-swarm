# dsh-agent-swarm 产品章程

本文件只定义稳定产品结果、范围、红线与完成标准。它不记录任务、负责人、分支、候选 SHA、审查结论或滚动进度。

## 产品结果

让一个人建立和管理由多个智能体部门组成的公司：先创建长期部门，再任命管理员，由管理员招募、管理具有独立身份的员工；员工完整入职后，通过现有 Team 执行任务、协作、交付，并在授权范围内积累个人经验与职业 Skills。

这是重构目标，不是当前版本能力声明。候选范围、身份与恢复合同见[能力架构 §11](03-capability-family.md#11-单人多部门公司的重构候选合同)。先完成架构咨询、三模型审查和统筹裁决，再按可安装验收的纵向切片开发。SoloIPs 仅为长期背景，本轮不包含 IP 生产、发行、商业化、SaaS 租户或财务人事业务系统。

既有独立 Team 模式继续保留：Main Brain 创建与统筹多个持久 Team，独立 Captain Session 招募成员、监督执行和审核交付。旧 Team 不自动变为部门，旧成员不自动成为已完成入职的员工。

产品必须是 official-first 的纯插件组合：官方 DSH 是唯一 Agent Runtime、Profile、Session、Agent Loop 和交互宿主；本项目提供 Team domain、编排 policy、模型工具、Host/RPC projection 和 DSH-native UI，不复制第二套 Runtime。

## 既有执行层身份与权威

```text
Main Brain（Team 外）
  ├─ Captain Session A → Team A → Members A1..An
  └─ Captain Session B → Team B → Members B1..Bn
```

- Main Brain 负责创建和跨 Team 路由，不是 Captain，也不进入 roster。
- 每个 Team 恰好绑定一个独立 Captain；只有该 Captain 拥有 Captain-only mutation。
- Member 是官方 continuable subagent，只能在分配给自己的当前 attempt 权限内工作。
- `TeamDomainPort` 是 roster、task/DAG、attempt、mailbox、budget、公共目标和公告的唯一写权威。
- Session 日志保存模型历史；官方 Storage Domain 保存 Team 业务状态；UI/RPC 只做 bounded projection。
- durable commit 之后才发布事件、receipt 或成功结果。

## 产品范围

1. **团队与身份**：多 Team、独立 Captain、本人选择的公开姓名/职业/性格/简介/头像、模型与 Skill 配置。队长分配团队职责与专业职业；队长和成员各自保存并读回四项身份文字，再按自身喜好设计头像。头像可以是人物、动物、物品或抽象图案，统一格式与点阵分辨率。
2. **任务交付**：DAG、优先级、定向分配、revision CAS、attempt fencing、提交、审核、重派和恢复。
3. **协作政策**：Scheduler、Workflow、Review、budget、tool permission、memory、同伴交流及频率控制、execution root 和 remote/distributed Provider 边界。
4. **用户入口**：按角色授权的模型工具、Main Brain/Captain Chat、Host/RPC read contract、Team Workbench 和官方 Plugins 设置；工具目录由当前注册提供。
5. **可运营性**：持久化、卸载/重载、迁移、隔离验收、候选/晋升/回滚分权与故障诊断。
6. **个人经验与技能管理**：成员维护并有界召回本人笔记；独立 Skills 模块及专用模型通过授权工作事实处理 Captain 的申请、复用与修订技能，经独立验证和批准后由 Captain 分配给成员。Team 不另设成长评分或发布状态机，实际使用版本与效果分别留痕。

## 产品红线

- 不修改或复制官方 Agent Loop，不注册与官方 service 冲突的影子 Runtime。
- 不维护第二个可写 Team 状态机；UI reducer、transcript、browser cache、Canvas/BFF 或本地 Map 都不是权威。
- 不把用户可控文本、Team id、Session label 或 Canvas token 当作认证主体。
- 不把 prompt 中的目录声明当成真实 filesystem/worktree 隔离。
- 不允许 stale revision、stale attempt、重复 effect 或候选自我验收/晋升静默成功。
- 不把 reference repository 当作运行依赖；它们只提供固定版本的行为与故障证据。
- 不把源码存在、mock 测试、开放端口、截图或 agent 报告单独称为交付。

## 产品级完成标准

公司重构基础版要求至少两个部门并存、管理员实际招募管理、完整入职覆盖所有正式任务入口、受控跨部门交接、成果审核及重启恢复。生命周期、个人记忆与 Skills 的可用范围须有相应运行证据；混合资产权利或宿主删除能力未定时，不宣称完整解雇。阶段包可先交付已验收的独立切片，不等待远期扩展；Git 发布关联使用、迁移、限制和恢复说明。

一个能力只有同时满足以下条件才可称为已交付：

- 通过明确的官方或项目自有 seam 组合，且只有一个状态/transition owner；
- 权限、持久化、并发围栏、lifecycle、错误和恢复语义有可执行测试；
- 模型工具、Host/RPC 或 UI claim 具有相应层级的真实组合证据；
- 候选按风险完成检查和非作者审查，并集成到预期目标后读回；
- 用户文档明确支持范围、配置和限制，不把目标架构写成实现事实。

## 非目标

- 复制 DSH、Canvas、JiuwenSwarm 或 `dsh-agent-teams` Runtime。
- 用一套共享 React/CSS 强制不同宿主视觉一致。
- 在同一交付中同时解决公共发布、远程执行和分布式共识；无授权的技能自我改写、自批发布与自动扩大权限。
- 用 Team 工具或文档授权密钥、push、release、生产数据或破坏性清理。

## 章程变更

只有产品结果、范围、身份/权威边界或完成标准改变时才修改本文件。实现现状与下一步进入 [能力架构](03-capability-family.md) 和 [实施路线](07-implementation-roadmap.md)，动态工作状态留在项目任务系统。

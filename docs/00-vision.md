# 00. 产品愿景与体验边界

## 1. 愿景

用户只需向 Main Brain 描述结果，不必手工管理一组聊天窗口。Main Brain 创建独立 Captain；Captain 根据目标选择成员、模型、Skills 和工具边界，建立依赖任务并对结果负责。用户随时可以在统一 Workbench 中查看多个 Team，或进入某个 Captain Chat 直接干预。

```text
用户目标
  → Main Brain 创建 managed Team，并把完整目标交给独立 Captain
  → Captain 设置公开目标/公告，招募有身份和能力边界的成员
  → Captain 建立任务 DAG，Scheduler 或 Workflow 分派 ready work
  → Member 在当前 attempt 的真实执行根中工作并提交证据
  → Review Gate 接受、拒绝或要求 rework
  → Workbench 从同一 Team authority 展示状态
  → 用户继续由 Main Brain 跨 Team 统筹，或打开 Captain Chat 调整单个 Team
```

## 2. 三层身份

| 身份 | 职责 | 不能做什么 |
|---|---|---|
| Main Brain | 接收用户目标、创建/列举多个 managed Team、路由用户关注 | 不能冒充 Captain 修改 Team，不能在建队后轮询独立团队 |
| Captain | Team 唯一负责人；招募、建任务、分配、公告、审核和恢复 | 不能把模型声明当作已验收结果，不能批准自己的发布候选 |
| Member | 在一个 fenced attempt 内完成专业任务并提交证据 | 不能调用 Captain-only 管理面，不能写入陈旧 attempt |

名称、职业、人格和安全像素头像是可展示 identity profile；真正权限来自官方 live Agent/Session 绑定和 Host 验证，不来自显示名称。

## 3. 产品界面

- **Main Chat** 保持 Main Brain 会话，不因选中 Team 而改名。
- **Team rail** 在一个页面中切换多个 Team。
- **Workbench** 展示公共目标、最新公告、成员、任务、attempt、预算、能力和最近活动。
- **Tasks / Announcements / Management** 提供互斥视图；成员和任务详情在 overlay 中打开，不挤压主聊天。
- **Captain Chat** 使用官方 Session navigation 打开所选 Captain；不是 `/swarm` 的隐式写操作。
- **Plugin settings** 配置 Captain/成员模型、Skills、工具 policy、编排/review 选择和资源上限；保存后由官方 Settings 在重启时应用。

UI 必须诚实显示 unavailable、stale、reconnect 和 error。没有权威数据时显示未知或不可用，而不是从 transcript 或本地缓存猜测。

## 4. 技术位置

DSH 的 Session、Agent、Subagent、Tools、Workflow、Storage、Settings 和 Client slots 都是官方能力。本插件只在这些 seam 上组合：

```text
Service Definition → Provider → Consumer → Bundle/Profile composition
TeamDomainPort      → StorageDomainTeamStore → tools / Host / RPC / UI
```

项目不会注册第二个 `ctx.agentTeams`。在官方 experimental Agent Team 尚未成为受支持发布依赖时，当前 `TeamDomainPort` 隔离 project-owned provider；未来替换 Provider 也必须保持单一权威和迁移证据。

## 5. 支持范围

当前产品方向包括 durable Team、任务/attempt、邮箱、budget、review、memory、Skills/tools policy、Workflow/Jobs bridge、execution roots、Host/RPC、DSH Workbench、设置、迁移和受控发布。

以下是后续能力而非现有承诺：远程成员、跨进程 distributed Team store、通用 browser direct writes、Canvas-native Consumer、自动 Skill Evolution 和公共市场发布。

## 6. 成功体验

面向用户的完整代表场景是：

1. 在 fresh isolated official DSH Profile 安装不可变插件包并启动。
2. Main Brain 创建至少两个独立 Captain Team。
3. Captain 设置身份/目标/公告，招募带不同 Skills、模型和工具 policy 的成员。
4. 一个含依赖的任务 DAG 经分配、执行、提交、验证、接受和失败恢复完成。
5. Workbench 原位切换 Team，所有身份、任务和活动与权威读回一致；Captain Chat 导航到正确 Session。
6. 重启后状态恢复；禁用、卸载、升级和回滚不泄漏 listener、route、timer、Session 或 storage authority。

这个场景通过真实 Profile/browser 和持久化重启证据后，才支撑对应产品 claim。目标设计、单元测试或截图不能单独替代它。

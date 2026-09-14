# 官方接口架构

本文件是"插件只用官方接口"的唯一权威：规定允许使用的官方入口、每个产品功能对应的官方面，以及官方没有入口时的功能处置。历史补丁路线已作废。

## 铁律

1. 插件只能通过官方公开接口工作：已安装的 `@deepseek-ai/*` 包及其 `exports` 暴露的入口，包含官方明确发布的子路径（如 `@deepseek-ai/dsh-subagent/internal`）。
2. 严禁修改官方代码：不得使用 `pnpm patch`/`pnpm.patchedDependencies`、猴子补丁、私有路径导入、复制官方状态机或直接改 Agent Loop。
3. 插件仓库的 `patches/` 与 `node_modules` 对运行时无效——宿主只加载它自己的官方包。任何"只有打补丁才存在"的接口一律视为不可用，不得作为功能依赖。
4. 官方没有对应接口的功能，按下文处置表降级或明确不做；不得为它开发官方补丁或私有分叉。

## 运行时事实（为何第 3 条成立）

DSH 客户端的模块由宿主下发（`/plugins/??@deepseek-ai/dsh-client-*/client.js`），解析自宿主自己的依赖树；插件包只提供自己的 `lib/client.js`，它 `require` 的官方包全部由宿主提供。因此补丁只在插件仓库的 dev/test 生效，"测试全绿"不能证明运行时可用；运行时可用性只看宿主的实际装配。

## 官方接口清单（实测 0.1.5-rc.2）

### 客户端 slot

| slot | kind / scope | 用途 |
|---|---|---|
| `sidebar.brand.mark` / `sidebar.brand.name` | single / root | 侧栏品牌位 |
| `sidebar.panellist` | **list** / root | 侧栏唯一的列表区（团队/分组导航只能落在这里） |
| `sidebar.workspaces` | single / root | 工作区切换区 |
| `sidebar.settings` | single / root | 侧栏设置入口 |
| `sidebar.footer.action` | list / root | 侧栏底部动作 |
| `main` | **keyed** / root | 全局主面板；`options.key` 即面板 id |
| `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title` | keyed / session | 右栏页签与其标题 |
| `settings.plugin.item` | — | 插件设置卡 |
| `conversation.session.header.lineage` | single | 会话头 lineage 位 |

### 客户端服务与行为

- `sidebarRight.openTabIn(sessionId, kind, options)`：目标寻址的页签打开，可跨会话保留。
- `sidebarRight.isExpanded()` / `toggleExpanded()`：**仅当前挂载面**的展开态与切换；官方没有按目标 Session 读取/写入展开态的接口。
- `sidebarRightTabs.register({ id, kind, title, ... })`：注册页签类型。
- `layout.selectPanel(id)` / `toggleSidebar()` / `openRightbar(track, fullscreen)` / `closeRightbar()`。
- `layout` **没有** per-panel 列宽接口。几何由框架常量决定：侧栏默认 280、下限 264、上限 420；右栏默认约视口 45%、下限 300；视口 <1024 自动折叠。
- Chat 视图首次打开即滚到底部（`toBottom`），仅在存在被保存的阅读位置时恢复该位置。插件不应再请求"打开即最新"。

### 服务端

- `@deepseek-ai/dsh-subagent/internal`（官方 exports 子路径）：`queueHostSubagentPrompt`、`steerHostSubagentPrompt`、`isAdjacentAgentSendMessageTool`。
- 官方 continuation activation。
- `connection.rpc.handle(channel, handler)`：插件 RPC 频道的官方挂载入口；Web 载体由官方 Connection 自己绑定。0.1.5-rc.2 的注册实现需要 Connection 提供方声明 `webServer` 依赖，因此本 Bundle 对既有官方 `connection` 行补充 `inject: [webRuntime, webServer]`，保留原有 Web 配置依赖与配置值。名称断言只允许该官方提供方；非 Web 组合没有此行时由官方 Include 警告并跳过，不创建 Connection。仅在 Consumer 注入 `webServer` 或把测试 WebServer 提供到根 Context，不能证明真实 Profile 中的提供方作用域可用。

## 历史耦合与处置

| 历史依赖（补丁自造，禁止再用） | 官方等价 | 处置 |
|---|---|---|
| `layout.registerPanelPresentation`（每面板列宽 profile） | 无等价接口 | 删除调用，使用框架默认几何 |
| `chatNavigation.requestLatest`（一跳即最新） | 无等价接口；官方首次打开即到底部 | 删除消费，依赖官方行为 |
| `sidebar.navigation.section`（侧栏第二个导航区） | `sidebar.panellist`（list） | 团队/分组导航注册到 `sidebar.panellist` |
| `conversation.session.header.lineage.display`（嵌套 slot） | `conversation.session.header.lineage`（single） | 注册到官方 lineage，或不做该装饰面 |
| `sidebarRight.isExpandedIn/setExpandedIn`（按目标 Session 继承展开态） | 只有当前面的 `isExpanded/toggleExpanded` | 放弃跨会话继承；导航后按当前面处理 |

补丁清单（`patches/` 七个文件与 `pnpm.patchedDependencies`）不再属于任何功能路径，必须删除；删除后 `pnpm verify:engineering` 必须仍然全绿，该绿灯即为兼容判据。

## 能力分类与处置（A / B / C）

插件每一项用户可见能力都必须归入下面三类之一。分类以**已安装官方包的实测面**为依据，不以设计意图为依据。

- **A 类 —— 直接能力仍需官方开面**：当前 4 项缺少对应的官方直接入口。A1/A2/A3 在 `src/client/official-capabilities.ts` 保留能力探测与空实现，各有探测失败用例；它们所要求的精确行为在 0.1.5-rc.2 下不可交付。A4 缺少通用无消息 lease，但 `src/runtime/continuable-child.ts` 可组合既有官方恢复与 maintenance 完成本插件所需的冷投递，具体合同见 B6—B9；不把这些组合能力也判为不可实现。
- **B 类 —— 不修改源码可绕开**：官方没有直接入口，但可用其他官方接口加插件自有实现达成。当前 10 项。
- **C 类 —— 已使用官方接口**：无需动作。当前 7 项。

### A 类：必须官方开面（4）

| 编号 | 能力 | 官方缺失证据 | 现状与预留 |
|---|---|---|---|
| A1 | 侧栏常驻团队/成员/归档列表 | 官方侧栏只有 `sidebar.panellist`（list，语义是面板图标）、`sidebar.workspaces`（被官方 WorkspaceBrowser 占用，`replaceRisk: shadows-shipped-ui`）、`brand.*`、`settings`、`footer.action`；没有通用列表区 | 当前群聊入口改用既有 Main 会话与官方右栏，不消费这个列表预留。**预留已实现**：`registerSidebarNavigation(slots, install, region)` 同时探测保留 region 名与官方 registrar，缺失则不注册、无副作用；官方开面后只改 `RESERVED_SIDEBAR_LIST_SLOT` 与该入口 |
| A2 | 每面板列宽（左 166 / 右 320 / `rightSidebar` 跟随） | `ui-layout` 的 `ILayout`/`LayoutController` 公开面只有 `selectPanel/beginNavigation/toggleSidebar/openRightbar/closeRightbar`；`setSidebar/setRightbar` 仅存在于内部 store | 使用框架默认几何。**预留已实现**：`probePanelGeometry(layout)` 探测官方 presentation 入口，当前会话方案不消费；独立探测保留供后续明确需求使用 |
| A3 | 跨会话"一跳即最新" | 官方 chat 无 `requestLatest` 类接口；官方 ChatView 首次打开到底、存在已保存阅读位置时恢复该位置 | 采纳官方行为。**预留已实现**：`requestLatestNavigation(ctx, sessionId)` 经 `ctx.get('chatNavigation')` 探测，存在则请求，否则空实现 |
| A4 | 无消息的 continuation activation lease | 官方 `SubagentRuntime` 无 `withContinuableChild` 等价面；既有 host queue/steer 负责完整 descriptor 恢复，`Agent.runMaintenance` 可持有非模型活动 | `withLiveChild` 以精确 plugin transport marker 进入官方恢复，在同步 inbox 插入边界取得 maintenance 后仅移除自身 marker；模型、persona、toolFilter 和 Activation 仍由官方重建。空闲 live child 使用 maintenance，运行中路径继续重验身份；不声称官方已提供通用 lease |

### B 类：不修改源码可绕开（10）

| 编号 | 能力 | 官方依据 | 状态 |
|---|---|---|---|
| B1 | 侧栏面板图标入口 | `sidebar.panellist`（官方 list，id 即主面板 key） | 已完成 |
| B2 | 当前面板选中高亮 | `usePanelInfo`（`main` 与 `sidebar.right.pane.tab` 的 standardProps 均含） | 已完成 |
| B3 | 会话头团队上下文徽标 | `conversation.session.header.actions`（官方 list，`replaceRisk: none`，官方 experimental agent-team 也在用） | 已完成（`TeamHeaderBadge`） |
| B4 | 跨会话右栏展开记忆 | `openTabIn`（目标寻址）+ 当前面 `isExpanded/toggleExpanded`；插件自存期望态，目标 adopted 后应用 | 待做 |
| B5 | 收起右栏后的成员入口 | 当前会话头部动作 + 官方 SidebarRight 导航 | 群头/个人头部的“成员(n)”打开同一官方 Team 页签 |
| B6 | 成员（非队长）公共消息投递 | 官方 host queue/steer + `agent/inbox/inserted` + `Agent.runMaintenance` | 精确成员的公开输入保持原投递，冷 Captain 配置与成员结束后续轮次由真实组合回归覆盖；运行部署单独验收 |
| B7 | 成员带图消息 / 视觉协助建立 | 同上 + 官方 attachments `readImage` | 已迁移，待验 |
| B8 | goal 自动协调续跑唤醒 | 同上 | maintenance 内只完成原消息 admission，释放后核对原 notice 的耐久 claim；调度沿用该次取消信号，创建 Task 等待 admission 后返回。有限目标与维护恢复组合回归覆盖；运行部署单独验收 |
| B9 | 冷恢复生命周期释放 | 官方 continuation Activation + `drainContinuableChildren` | 复用持久 Session lineage 重建的 Team 后代目录与现有卸载 drain；移除裸恢复和插件私有 AgentHandle 登记 |
| B10 | 无补丁兼容判据与已知缺失声明 | 工程实现与本文档，不需要官方面 | 收口中 |

### C 类：已使用官方接口（7）

| 编号 | 能力 | 官方依据 |
|---|---|---|
| C1 | Main 会话的 Team 群聊 | `main.conversation`（single/session-maybe）公开 priority 覆盖整个 ConversationRoot；个人会话和卸载时 disposer 恢复官方原 root，保留外层官方 rightbar |
| C2 | 右栏 Team 页签与标题 | `sidebar.right.pane.tab` / `.title` + `sidebarRightTabs.register` |
| C3 | 插件设置卡 | `settings.plugin.item` |
| C4 | 普通成员邮箱投递与唤醒 | `subagents.prompt` / `Agent.inject` |
| C5 | 工具策略、成员模型路由、continuation activation | 官方包，含 `@deepseek-ai/dsh-subagent/internal`（官方 `exports` 子路径） |
| C6 | 会话永久删除 / retirement | `sessionPersistence` / `session-query` 公开面 |
| C7 | 视觉协助读取原图 | `attachments.readImage` |

### 预留接口的强制规则

1. A1—A3 的预留能力必须有**唯一入口函数**，内部做能力探测；调用方不得直接依赖被探测的成员名。A4 的组合实现在 `withLiveChild` 单点维护，调用方不依赖并不存在的官方 lease 方法。
2. 探测失败时行为必须是"官方默认 + 无副作用"，不得抛错、不得静默改写官方状态。
3. 官方开面后只允许修改该入口函数的实现与其测试，不重构调用方。
4. A1—A3 的缺失由探测返回 false 的用例观察；A4 由实际官方恢复、maintenance、取消和后续普通输入的组合测试验证，不能用不存在的方法外形代替生命周期行为。
5. 预留入口必须存在于**产品代码**中：只存在于测试替身里的入口不算预留（A4 曾因此被误记为已预留）。

## 验证规则

1. 兼容判据 = 无补丁的官方包下 `pnpm verify:engineering` 全绿；测试不得依赖补丁面。
2. 客户端可用性以宿主实际下发的模块与宿主包为准（boot payload + 宿主官方包特征），不以插件仓库测试为准。
3. 官方基线只追 rc 与正式发布；通道规则见 [11-official-first-development.md](11-official-first-development.md)。

### 主面板与 Session 右栏的显示边界

- 官方 global mainPanel 非空时不挂载 `rightbar.session`。因此群聊内的团队栏由同一个 `main` 组件 `TeamGroupPanel` 实际渲染，复用既有导航、群聊与详情内容；局部展开状态不改变 Session、mainPanel 或官方 Sidebar 状态。普通 Session 的 Team 页签注册与 coordinator 合同保留。
- 官方 `openTabIn → actionsFor(sessionId)` 只要求目标 store 已 adopt，不要求目标 surface 已挂载；`isExpanded()/toggleExpanded()` 则读取当前挂载面。coordinator 的 reveal gate 与官方右栏是否可见必须分别验证，不能把 store 调用成功或手工 `observeTab` 当成 React 座位已显示。
- `tests/team-dashboard-surface-coordinator.spec.ts` 的静态官方夹具只证明寻址、展开调用和 observer 生命周期。`tests/team-group-panel.spec.tsx` 挂载实际注册的群聊主组件，验证无右栏座位时群聊与详情共存、开关不重挂群聊、当前 viewer/Team 绑定和成员导航；官方 app shell 的显示与几何仍按本文件验证规则 2 验证。

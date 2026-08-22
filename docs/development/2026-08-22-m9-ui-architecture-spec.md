# dsh-agent-swarm UI 架构与开发规范（v1）

> 提前拉 M9 UI 的正式开工依据。调研证据全部来自官方 rc.8 checkout、canvas 仓库（只读）与本插件仓库的源码阅读（file:line 标注）。正式实现 S4 前需按 §10-1 补 Gate A 记录。

## 1. 背景与目标（提前拉 M9 的范围声明）

`docs/07-implementation-roadmap.md:278-292` 定义 M9 为 "client, migration and release"，其中 UI 条目为：**optional client package projects authoritative roster/DAG/run/workspace/budget/review state**，退出条件两条硬边界：

- "client mount/dispose and HMR tests pass"（`docs/07:287`）
- **"UI is never required for runtime progress"**（`docs/07:288`）——UI 是投影面，永远不是运行时依赖。

本规范将 M9 的 UI 条目提前启动，交付两个面板，共享同一组件层：

- **Part 1 — DSH 官方面板**：以官方 `ui-slots` slot 系统挂载的 `dsh.client` 双面插件（参照 `ui-subagent`/`ui-jobs` 官方范例）。
- **Part 2 — Canvas 面板**：挂载进 `dsh-canvas` web 端 AgentPanel 的 swarm 状态页，数据来自 canvas-agent 的 HTTP 状态面（W4b-S2 投影）。

范围边界（继承 M9 原文 + AGENTS.md 红线）：

1. UI 只读投影权威 Team 状态，不写任何权威状态；创建/取消等操作一律引导回模型工具面或既有命令面。
2. 不接管官方默认作用域 jobs registry（#76 红线，`docs/07:149`）。
3. 不修改官方 Agent Loop、不注册冲突 `ctx.agentTeams`（AGENTS.md 规则 5/8）。
4. UI 插件失败/未装载时运行时零变化。
5. 每个注册（slot/locale/service）必须有 disposer 与生命周期属主（AGENTS.md 规则 6）。

## 2. 总体架构（共享组件层 + 双挂载面）

```
                        ┌────────────────────────────────────────────┐
                        │   @dsh-agent-swarm/panel（共享组件层）      │
                        │   纯展示 React 组件 + 只读数据契约 (TS 类型) │
                        │   + 单文件 CSS（只消费 --swarm-* 主题变量） │
                        │   React 18 API 基线，零宿主依赖             │
                        └──────────┬───────────────────┬─────────────┘
                 npm 依赖 + DSH 模块表行        npm 依赖（vite 打包）
          （dsh.client.external 请求）          （web/package.json deps）
                                   │                   │
      ┌────────────────────────────▼──────┐  ┌─────────▼──────────────────────┐
      │ Part 1: DSH 官方面板               │  │ Part 2: Canvas 面板             │
      │ @dsh-agent-swarm/ui-panel          │  │ dsh-canvas/web 内 Swarm 标签页  │
      │ dsh.client 双面包                  │  │ (local-agent-panel 新 tab)      │
      │ - node 半: 空 apply                │  │ - AgentPanelTabs 加 "Swarm"     │
      │ - browser 半: slot 注册            │  │ - react-query 轮询              │
      │   conversation.view 'team' 标签    │  │                                 │
      │   + header.actions 触发器(可选)    │  │                                 │
      └─────────────┬─────────────────────┘  └─────────┬─────────────────────┘
                    │ 数据面 A                            │ 数据面 B
        ┌───────────▼───────────────┐        ┌──────────▼──────────────────────┐
        │ DSH host 进程内            │        │ canvas-agent (Express)           │
        │ AgentSwarmRuntime.status() │        │ GET /agent/dsh/status            │
        │ + TeamJobProjection(#76)   │        │   → status + swarm 投影(仅计数)  │
        │ → 经 Remote/RPC 桥到浏览器  │        │ GET /agent/swarm/review/:id      │
        │ （bundle 纯度门禁禁止直引   │        │ GET /agent/engine, SSE /events   │
        │  宿主包值导入）             │        └─────────────────────────────────┘
        └───────────────────────────┘
```

分层原则：

- **组件层**只认"Team 状态快照"数据契约与 `--swarm-*` CSS 自定义属性，不 import 任何宿主框架/组件库/i18n 库——这是唯一能在 React 18 + CSS Modules（DSH）与 React 19 + Tailwind 4 + antd（Canvas）两种宿主下复用的形态。
- **适配层**各宿主自带：DSH 侧由 UI 插件做 slot 注册 + `--dsw-*`→`--swarm-*` 主题映射 + 数据服务订阅；Canvas 侧由 web 仓库做 tab 挂载 + `canvasThemes`/Tailwind 变量→`--swarm-*` 映射 + HTTP 轮询。
- **数据层**保持只读投影。

## 3. 官方 slot 系统调研结果

### 3.1 核心 API（`packages/client/ui-slots/src/`）

**SlotMap 与声明合并**。slot 契约表 `interface SlotMap {}` 由各所有者通过 `declare module` 合并声明（`ui-slots/src/index.ts:23-24`）；每条目 `SlotEntryDef = { kind, scope, owner?, keyProps?, hookContext?, inject? }`（`index.ts:100-122`）。轴：

- kind：`'single' | 'list' | 'keyed' | 'chain'`（`index.ts:88`）——单占位 / 有序列表 / 按 key 分发 / 选择器路由链。
- scope：`'root' | 'session-maybe' | 'session'`（`index.ts:91`）——决定框架注入的标准 kit（session scope 自动获得 `sessionId`/`useSession` 等，`index.ts:178-221`）。

**register 签名**（`index.ts:741-796`）：

```ts
ctx.slots.register(
  { name, children?, store?, locale?, registrant?, ...kindOptions, inject? },
  Component,
) => () => void   // disposer
```

- kindOptions 按 kind 不同（`index.ts:480-509`）：single/keyed/list → `priority?`（遮蔽秩，升序，默认 0，最低者渲染；同 cell 同 priority 抛错，`index.ts:796-824`）；list 额外 `id`（必填）、`order`（显示序）、`label`（可为 thunk 跟随 locale，`index.ts:474`）；chain → `select`（必填，纯函数选择器，首个非 null 当选，`index.ts:246-257`）；keyed → `key`。
- **组件 props = 四股交集** `ComposedProps = PropsRuntime & PropsRenderSlots & PropsStore & InjectFace<I> & PropsLocale<N>`（`index.ts:442-450`）。
- **注册进未声明的 slot 会抛错**（`index.ts:789-791`）；**children 表即声明**——一次 register 可同时贡献组件并声明新子 slot，"declaring is claiming"，同 key 二次声明抛错（`index.ts:826-831`），disposer 级联回收全部子 slot（`index.ts:1128-1149`）。
- store 座：`defineStore` 产物（spec/init + actions 纯 draft 变换 + persist 键，`store.ts:42-48`）；组件只见 `useStore` 选择器 + baked actions（`store.ts:123-125`），禁止模块级导出 handle（跨插件重载伪装单例，`store.ts:76-81`）。

**locale 注入**。`LocaleNamespaceMap` 同样声明合并（`index.ts:27-34`）；register 时声明 `locale: NS` 即在组件 props 上获得类型化 `t`（`index.ts:80-85`）；渲染依赖 locale 插件安装的 `LocaleFace`（`renderer.ts:18-28`）。字典经 `ctx.locale.register(NS, { zh, en })` 注册（用法见 `ui-subagent/src/client/index.ts:47`）。

**运行时 Service 包装**（`packages/client/runtime/src/client/slots.ts`）：`SlotRegistry extends Service`，内置 `root` slot（`slots.ts:41`）；关键方法 `slots.inject(key, callback)`（`slots.ts:143-196`）——按 slot 声明生命周期对齐的注册 effect：目标 slot 未声明时等待，声明出现时执行 callback，声明坍缩时自动 teardown。所有官方 UI 插件都用它注册（防加载顺序竞态）。

### 3.2 官方 UI 插件范例：全要素清单

以 `ui-subagent`（最完整）为准，做一个官方 UI 插件需要 **12 类要素**：

| # | 要素 | 证据（`packages/client/ui-subagent/`） |
|---|------|------|
| 1 | package.json：`exports["."]`（node 半）+ `exports["./client"]`（browser 半）+ `"./src/*"` + `"./package.json"`；`files` 列出 lib 产物 | `package.json:16-31,74-79` |
| 2 | `dsh.client` 声明：`{ inject: [...依赖的模块表包], platform: "web", external?: [...] }` | `package.json:32-43` |
| 3 | peerDependencies 声明全部 workspace 依赖（react 18 + @types/react 在 devDeps） | `package.json:49-73` |
| 4 | node 半 `src/index.ts`：**空 apply**（仅为进 cordis.yml/Loader） | `src/index.ts:8-9` |
| 5 | invariant 伴生件 `src/invariant.ts`（InvariantInstaller + `inject=['invariants']`） | `src/invariant.ts:9-23` |
| 6 | browser 半 `src/client/index.ts`：`LocaleNamespaceMap` declare-merge → `export const inject = ['sessions','slots','locale']` → `apply(ctx)` 内 `ctx.effect(() => ctx.locale.register(NS,{zh,en}), '...')` + `ctx.slots.inject(key, () => ctx.slots.register({...}, Component))` | `src/client/index.ts:13-18,28,46-79` |
| 7 | React 组件 + CSS Modules：props 用 `PropsRuntime<'slot'> & Injected & PropsLocale<typeof NS>` 组合；import `@deepseek-ai/dsh-client-ui-primitives` 基础件 | `src/client/SubagentCatalogAction.tsx:1-30`；CSS 用 `var(--dsw-alias-*)` 令牌（`SubagentCatalogAction.module.css:14,58,84`） |
| 8 | `locales.ts`：`NS` 常量、zh 字典（key 真源）、`en: Record<SubagentKey,string>`、`SubagentKey = keyof typeof zh` | `src/client/locales.ts:4,7-78,81` |
| 9 | `src/css-modules.d.ts`（`*.module.css` 与 `*.css` 模块声明） | `src/css-modules.d.ts:1-5` |
| 10 | `tsconfig.json` extends `tsconfig.base.client.json` + project references 到依赖包 | `tsconfig.json:1-33` |
| 11 | `tsdown.config.ts` 调共享 preset：`clientBundle('@deepseek-ai/dsh-client-ui-subagent', ['lib/types/index.js','lib/types/invariant.js'])` | `tsdown.config.ts:1-3`；preset 产出 `lib/client.js`（CJS 闭包工厂 + `window.__ModuleLoader__.load` 横幅，`packages/client/tsdown.client.ts:555-565`） |
| 12 | 测试：`tests/browser-plugin.client.spec.ts`（apply/inject 假件装配）+ 组件 spec；README 三语 | `tests/browser-plugin.client.spec.ts:1-40` |

`ui-jobs` 是单组件极简范例：仅一个 `JobListAction` 注册进 `conversation.session.header.actions`（`order: 20`，排在 subagent 目录 `order:10` 之后，注释明言 "session lineage reads before process work"，`ui-jobs/src/client/index.ts:30-39`）；**数据完全来自 `useSessions(state => state.jobsBySession)` 列表镜像，"the plugin issues no RPC and holds no state of its own beyond popover visibility"**（`ui-jobs/src/client/index.ts:3-6`，`JobListAction.tsx:95`）——这是"宿主帧推送镜像"数据模式的官方范式。

### 3.3 web-app 如何发现/装载客户端插件

- **宿主 roster**：`packages/bundle/web-app/cordis.patch.yml` 的 browser roster（`dsh.client` 行）列出全部 30+ 客户端插件。第三方插件经**自己包内 `cordis.patch.yml`** 的 `dsh.bundle.patch` 声明行加入组合（本插件现状：`dsh-agent-swarm/cordis.patch.yml:1-19`；UI 包需新增自己的行）。
- **发现机制**：`@deepseek-ai/dsh-client-modules` 的 node 半扫描宿主 Loader 的 entries 中声明了 `dsh.client` 的包，组合 `window.__DSH_BOOT__` 模块表（`packages/client/modules/src/index.ts:1-4`）。
- **装载形态**：**动态加载，不打包进 web-app**。每个客户端 bundle 是 `lib/client.js`（CJS 闭包工厂），经 `/plugins/<id>/client.js?rev=<rev>` 拉取（`modules/src/client/manifest.ts:52-64`）；执行只注册工厂，首次 import 才物化（含 CSS 注入，`manifest.ts:8-17`）。
- **模块表**：冻结的共享行 = `PLATFORM_MODULES = ['react','react/jsx-runtime','react-dom','react-dom/client','@deepseek-ai/cordis','@deepseek-ai/dsh-client-ui-slots','@deepseek-ai/dsh-client-ui-primitives']`（`packages/client/web/src/platform.ts:8-14`）；包私有额外行经 `dsh.client.external` 请求（`tsdown.client.ts:393-425`）。
- **bundle 纯度门禁（红线）**：客户端 bundle 中**跨插件值 import 一律禁止**——非请求行、非 inline-safe wire 层的 `@deepseek-ai/*` 值 import 直接构建报错，"cross-plugin value imports are forbidden; … collaborate through cordis services"（`tsdown.client.ts:479-497`）。⇒ **UI 插件不能 import `dsh-agent-swarm` 宿主包取数据**，共享组件包要被 DSH 侧引用就必须声明为 `dsh.client.external` 模块表行（机制存在：动态包先于消费者注册工厂即可，`manifest.ts:22-24`）。
- CSS：`x.module.css` 由 lightningcss 编进 bundle（hashed class map + `style[data-plugin-css]` 注入，`tsdown.client.ts:499-522`）；普通 `.css` 作为全局样式注入（`tsdown.client.ts:540-553`）。
- HMR：`client-hmr` 行常驻，重写 client bundle 即热替换（`cordis.patch.yml:145-152`）。

### 3.4 官方主题系统

- **双层令牌**：`packages/client/ui-theme/src/styles/design-platform.css` —— `--dsw-static-*` 原始色板（body 上 light 全量 + `body[data-ds-dark-theme]` dark 覆盖，共 324 处 `dsw-` 引用）；业务样式只消费 `--dsw-alias-*`（语义别名：bg-base/bg-layer-1/bg-overlay/border-l1/l2/brand-primary/label-primary…/state-error|success|warn-primary）与 `--dsw-specific-*`；阴影 `--dsw-shadow-lv3`；滚动条 `--dsh-scrollbar-thumb`（证据：`ui-subagent/.../SubagentCatalogAction.module.css:14,58-62,84`）。
- **主题服务**：`ctx.theme`（ThemeRuntime，`ui-theme/src/client/index.ts:151-332`）：light/dark 内建 + `system`（matchMedia 跟随，`:168-188`）；`register(ThemeDefinition)` 注册整主题（`:249-264`）；**`overrideTokens(source, {light, dark})` 叠加令牌覆盖层**（seq 序、后层按令牌胜出、双模式强制、`:282-291`）；变更经 `theme/change` 事件发布（`:327-331`）。
- **ui-primitives 基础件清单**（`packages/client/ui-primitives/src/index.ts:5-54`）：StateDot、DisclosureRow、Button、Pill、Input、Menu、HoverCard、Modal、RiskConfirmation、ConnectionBanner、Tooltip、Toast、JsonTree、TerminalBlock、ReadBlock、DiffBlock、SearchBlock、WebBlock、CodeBlock、MarkdownText、MessageText、图标族、hooks。样式方案 = **CSS Modules + dsw 令牌**，无 Tailwind/styled。
- 深浅色：由 `body[data-ds-dark-theme]` 属性切换驱动整套 static 色板翻转；组件层零感知。

### 3.5 可用 slot 位置枚举（截至 rc8）

**布局层**（`ui-layout/src/client/index.ts:33-85`）：`root`（被 AppFrame 占据）；`sidebar`；`conversation`；`details`；**`shell.overlay`（list/root，"the additive seat for a frame-wide surface of your own"，点击穿透）**。

**侧栏层**（`ui-sidebar/src/client/contract/slots.ts:16-48`）：`sidebar.brand.mark`、`sidebar.brand.name`、`sidebar.workspaces`、`sidebar.settings`；**`sidebar.footer.action`（list/root）**。

**会话层**（`ui-conversation/src/client/contract/slots.ts:60-262`）：

- `conversation.session`（single/session）；**`conversation.session.header.actions`（list/session——ui-subagent/ui-jobs 挂点）**；`conversation.session.header.utilities`（list）；
- **`conversation.view`（list/session，视图环：每条目一个 tab，chat 在此，"trajectory/waterfall from ui-trajectory"，`:96-103`）**；
- `conversation.chat.node`（keyed）、`conversation.message.images`、`conversation.chat.commandview`（keyed）、`conversation.chat.turnTail`（chain）、`conversation.chat.assistant-actions`（list）；
- `conversation.details.tool`（single）；`conversation.composer`（chain）、`conversation.composer.bar`（single）；
- **`conversation.input.dock`**（composer 卡上方整行，"queue rows, a todo strip, a goal bar"，`:185-195`——ui-goal 的 GoalBar 挂点）、**`conversation.composer.dock`**（卡下环境读出行，`:198-204`）、**`conversation.input.left` / `.right`**（`:206-221`）；
- hero 层：`conversation.hero.workspace`、`.brand.mark`、`.agentPreset`。

**设置层**（`ui-settings/src/client/contract/slots.ts:13-90`）：**`settings.section`（list，"One settings page per list entry"，id 驱动导航）**、`settings.general.item`（list）等。

**工具层**（`ui-tool/src/client/contract/slots.ts:9-25`）：**`tool.call.toolview`（keyed/session，key = wire 工具名，key 域开放）** ⇒ `agent_swarm_*` 工具的行内视图合法挂点。

**"团队状态面板"挂点结论**：多选可行。推荐组合：

1. **主面板：`conversation.view` list 条目（id: `'team'`，session scope）** —— 与 ui-trajectory 同型的会话视图 tab，承载完整 roster/DAG/budget/review 面板。
2. **入口触发器：`conversation.session.header.actions`（id: `'swarm-status'`，order: 30）** —— 计数徽章 + 点击切到 team tab。
3. 可选全局徽章：`shell.overlay`（跨会话进程级状态 pill）。
4. 可选工具行内视图：`tool.call.toolview`，key = `agent_swarm_status` / `agent_swarm_list_tasks` / `agent_swarm_list_jobs`。
5. 可选设置页：`settings.section`（只读诊断/配置展示）。

**新 slot 可行性**：官方支持。任何 register 的 `children` 表都可声明新子 slot（声明即独占渲染权，`ui-slots/src/index.ts:825-889`）；约束：新 slot 只能由声明它的条目组件渲染，且 disposer 级联回收。

## 4. Canvas UI 体系调研结果

### 4.1 组件体系（`dsh-canvas/web`）

- **React 19.2.5** + react-dom 19；**antd 6.4.2** + @ant-design/icons 6 + pro-components；**Tailwind CSS 4** + radix-ui/shadcn + class-variance-authority/clsx/tailwind-merge；lucide-react 图标；**zustand 5**；**@tanstack/react-query 5**（可用轮询基建）；react-router 7；i18next + react-i18next；vite 7 构建。
- 样式根：`globals.css` 以 `@import "tailwindcss"` + `@theme inline` 把 `--background/--card/--popover/--primary/--border/...` oklch 变量映射为 Tailwind 色（`web/src/styles/globals.css:1-59`），暗色经 `.dark` class 变体（`:4,105+`）。

### 4.2 插件面板体系（`dsh-canvas/plugins/canvas/`）

- **节点插件 SDK（`@infinite-canvas/plugin-sdk`）**：`definePlugin` + 宿主注入 React + jsx-runtime 桥。插件 = `{ id, name, version, css?, nodes: CanvasNodeDefinition[], setup? }`；节点定义 = `{ type: "<pluginId>:<name>", Content?, Panel?, toolbar?, ... }`。
- **形态定位：这是"画布内嵌节点 + 节点下方 Panel"的 SDK，不是全局面板体系**。全局面板（AgentPanel）的 tab 集硬编码于 `local-agent-panel.tsx:1366-1370`，不可由外部插件扩展。⇒ Part 2 需要 canvas 仓库内的源码 PR（加一个 tab）。

### 4.3 canvas-agent HTTP 状态面（W4b-S2 投影面）

- **`GET /agent/dsh/status`**（`canvas-agent/src/server/routes-agent.ts:17-23`）：返回 `{ ok, status: DshRuntimePublicStatus, ...ctx.swarm.swarmStatusProjection() }`。**swarm 投影**：脱敏纪律——仅计数与时间戳（`swarm-orchestration.ts:18-24,290-303`）。
- 关联端点：`GET /agent/engine`（当前引擎 + capabilities）、`POST /agent/engine/switch`；swarm 审批桥 `POST/GET/DELETE /agent/swarm/review(/:requestId)`；turn 进度相位 SSE `GET /events`。
- **轮询现状**：web 端目前没有任何代码消费 `/agent/dsh/status`（全仓 grep 无命中）。⇒ Swarm 面板是此端点的**首个 web 消费者**。

### 4.4 主题统一性调研（用户点名）

**结论：不存在官方"主题桥"，且两套体系差异是结构性的，短期不可能视觉统一；Canvas 必须自维护皮肤，共享组件层用"主题变量契约"双适配。**

| 维度 | DSH 官方 web-app | dsh-canvas web |
|------|------------------|----------------|
| React | 18.2/18.3 | 19.2.5 |
| 样式方案 | CSS Modules + 设计令牌 | Tailwind 4 utility + shadcn/radix + antd |
| 令牌 | `--dsw-static-*`/`--dsw-alias-*`（rgb） | `--background/--card/...`（oklch）+ `canvasThemes` JS 对象 |
| 暗色机制 | `body[data-ds-dark-theme]` 属性 | `.dark` class + zustand 持久化 |
| 基础件 | ui-primitives（自有） | antd 6 + shadcn/radix + lucide |

DSH 官方未提供任何跨应用主题导出/桥接面。Canvas 接入 DSH 后端（swarm 引擎）不改变其前端栈。因此主题适配层是唯一务实解。

## 5. 共享组件包设计：`@dsh-agent-swarm/panel`

### 5.1 定位与形态

- **包名**：`@dsh-agent-swarm/panel`（pnpm workspace 包，随插件仓发布；canvas 以 npm 依赖引入）。
- **技术基线**：TypeScript + **React 18 API 面**（函数组件 + 零 19 专有 API，在 DSH React 18 与 Canvas React 19 下均可运行）；**零宿主依赖**。
- **构建产物**：ESM + 单个 `panel.css`（结构类名 `.swarm-*` 前缀，只引用 `--swarm-*` 自定义属性，不自带颜色）。
- **在 DSH 的接线**：UI 插件包在 `dsh.client.external` 声明 `"@dsh-agent-swarm/panel"`——绕开"跨插件值 import 禁令"的唯一合法通道。

### 5.2 数据契约（只读，包内 `types.ts`）

```ts
export interface SwarmPanelSnapshot {
  team: { id: string; name: string; revision: number }
  members: ReadonlyArray<{ id: string; role: string; phase: 'active' | string }>
  tasks: ReadonlyArray<{
    id: string; title: string
    status: 'pending' | 'ready' | 'in_progress' | 'completed' | 'failed' | string
    ownerId?: string; attempts: number
    blockedBy?: readonly string[]
  }>
  counters: { total: number; completed: number; ready: number; queuedMessages: number; memoryEntries: number }
  budget?: { usedTokens: number; usedRequests: number; usedRetries: number; observedAt?: string }
  review?: ReadonlyArray<{ requestId: string; state: string; summary?: string }>
}
```

Canvas MVP 允许**降级快照**（仅有 `counters` + `budget`），组件对缺省段渲染空态。

### 5.3 组件清单与 props 契约

| 组件 | Props | 说明 |
|------|------|------|
| `TeamSummaryCard` | `{ snapshot, strings, onOpenDetail? }` | team 名/revision/活跃成员数/任务计数条 |
| `StatusCounters` | `{ counters, strings }` | total/completed/ready/queued 计数 |
| `BudgetMeter` | `{ budget?, strings }` | usedTokens/usedRequests/usedRetries；缺省整体隐藏 |
| `MemberRoster` | `{ members, strings }` | 成员行（phase 徽标） |
| `TaskBoard` | `{ tasks, strings, onSelectTask? }` | 列表 + blockedBy 折叠 |
| `TaskDag`（v2） | `{ tasks, connections, strings }` | SVG 简图（纯内联） |
| `ReviewQueue` | `{ review?, strings, onOpen? }` | 审批请求行 |
| `SwarmPanel` | `{ snapshot?, loading, error, strings, onRefresh? }` | 顶层组合（空态/错误态/加载态内建） |

**文案策略**：所有组件经 `strings: Readonly<Record<string, string>>` 接收文案；DSH 侧由 locale 字典填充（zh 真源），Canvas 侧由 react-i18next 填充。

### 5.4 主题适配层（`--swarm-*` 契约）

```css
.swarm-panel {
  --swarm-bg:  /* 面板底 */       --swarm-bg-raised: /* 卡片底 */
  --swarm-fg:  /* 主文本 */        --swarm-fg-muted:  /* 次文本 */
  --swarm-border:                  --swarm-accent:   /* 强调 */
  --swarm-state-running:           --swarm-state-done:  --swarm-state-error:
  --swarm-radius: 8px;             --swarm-mono: ui-monospace, monospace;
}
```

- **DSH 适配**：`--swarm-bg: var(--dsw-alias-bg-layer-1)`、`--swarm-fg: var(--dsw-alias-label-primary)` 等——深浅色自动翻转。
- **Canvas 适配**：从 `useThemeStore` → `canvasThemes[theme]` + Tailwind 变量映射到同名 `--swarm-*`。

两宿主各自映射约 30 行 CSS/TS，组件层永不改。

## 6. Part 1 规范：DSH 官方面板

### 6.1 包名与形态

包名 `@dsh-agent-swarm/ui-panel`（发布名 `dsh-agent-swarm-ui`），12 要素对齐 §3.2。

`dsh.client` 声明：
```json
"dsh": { "client": {
  "inject": ["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-conversation", "@deepseek-ai/dsh-client-ui-primitives"],
  "external": ["@dsh-agent-swarm/panel"],
  "platform": "web"
} }
```

### 6.2 文件结构

```
packages/ui-panel/
  package.json  cordis.patch.yml  tsconfig.json  tsdown.config.ts
  src/
    index.ts (空 apply)   invariant.ts
    client/
      index.ts (LocaleNamespaceMap merge + inject + apply)
      locales.ts  theme.css (--dsw → --swarm 映射)
      TeamView.tsx  SwarmStatusAction.tsx  SwarmToolViews.tsx  data-adapter.ts
  tests/  browser-plugin.client.spec.ts  team-view.client.spec.tsx
```

### 6.3 slot 注册骨架

```ts
ctx.slots.inject('conversation.view', () => ctx.slots.register({
  name: 'conversation.view', id: 'team', order: 20, locale: NS,
}, TeamView))
ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
  name: 'conversation.session.header.actions', id: 'swarm-status', order: 30, locale: NS,
}, SwarmStatusAction))
```

### 6.4 数据适配器（不经工具调用读宿主服务）

1. **（推荐，S4）宿主包提供浏览器可达只读服务**：`AgentSwarmRuntime.status()` + `TeamJobProjection.list()` 经官方 api-gateway Remote 通道暴露——需 Gate A 归类（project-owned overlay）。
2. **（S3 保守回退）会话 transcript 投影**：解析 `agent_swarm_status` 工具结果帧——零宿主改动，非实时权威。
3. 禁止：直连默认作用域 jobs registry；浏览器重建权威状态。

## 7. Part 2 规范：Canvas 面板

### 7.1 挂载点

`local-agent-panel.tsx` tab 数组追加 `{ value: "swarm", label, icon }` + 渲染分支 `activeTab === "swarm" ? <SwarmTab/> : ...`。这是 canvas 仓库内的源码 PR。

### 7.2 数据轮询

`web/src/services/api/canvas-agent.ts` 增加 `fetchDshStatus` / `fetchSwarmReview`；`SwarmTab` 用 react-query `useQuery({ queryKey: ['swarm','status'], refetchInterval: 5_000 })`；`GET /agent/engine` 判定 tab 可见性；审批走既有 `/agent/swarm/review` 端点。

### 7.3 一致性

主题容器根做 `--swarm-*` 映射；tab 图标/布局复用 `AgentPanelTabs` 形态；i18n key `agent.panel.swarm` 填充共享包 strings；面板只读——审批操作走既有权限/token 校验路径。

## 8. 开发规范（两包共同门禁）

1. 插件仓内新增 `packages/panel`（共享组件）与 `packages/ui-panel`（DSH 插件）；类名 `swarm-` 前缀。
2. 每个 effect/inject/register/override/订阅必须返回 disposer；mount/dispose 测试是合入前置。
3. DSH 侧每次改 external/inject 必须过 client bundle 纯度检查。
4. UI 缺席时宿主运行时行为逐字节不变（合入验证含"UI 缺席"用例）。
5. 面板渲染的一切数值必须可回溯到权威提交；UI 不缓存派生权威态。
6. vitest + `@deepseek-ai/dsh-client-test-runtime` 假件范式；组件 spec 覆盖空态/降级/dispose。
7. 审查命令按 AGENTS.md 规则 10 报告实际跑过的。
8. 文档同步（docs/07/09/10/11 + Skill）同一变更内完成。
9. 共享包 CSS 禁止硬编码颜色；DSH 模块 CSS 只用 `--dsw-*`。
10. 对齐官方范例的 aria 实践；tab/按钮键盘可达。

## 9. 分期交付计划

| 切片 | 内容 | 验收 |
|------|------|------|
| S0 契约冻结 | panel 骨架：types + `--swarm-*` 契约 + StringsKey + 空态测试 | 契约评审通过 |
| S1 共享组件 MVP | StatusCounters / BudgetMeter / TeamSummaryCard / TaskBoard + 双主题映射示例 | 双环境渲染冒烟 |
| S2 Canvas 面板 MVP | fetchDshStatus + SwarmTab + react-query 轮询 + 可见性门 + 主题桥 | swarm 引擎跑通时 tab 实时显示计数 |
| S3 DSH 插件骨架 | 12 要素 + header.actions + conversation.view（transcript 数据源） | 装载/HMR/mount-dispose 绿；纯度门禁绿 |
| S4 DSH 数据 seam | 宿主只读 Remote + 权威快照 + jobs 列表 | Gate A 记录 + docs 同步 |
| S5 完整版 | MemberRoster / TaskDag / ReviewQueue / toolview / 全量文案 | M9 UI exit 项达成 |

依赖：S2 只依赖 S1；S3 依赖 S1；S4 依赖 S3；S5 各项可并行。

## 10. 开放问题（PM/用户决策）

1. **Gate A 归类**（阻塞 S4）：数据 seam 属 project-owned overlay，是否同时向上游提 proposal？
2. **挂点确认**：Team 状态是进程级而非会话级——MVP 单 Team；全量版再议 root 级全局面。
3. **Canvas 侧落地方式**：S2 需 canvas 仓库 PR，由 canvas 所有者执行还是本插件团队提？
4. **信息脱敏边界**：Canvas 面板要显示 roster/DAG 需 canvas-agent 新增 additive 只读端点（如 `GET /agent/swarm/team`）——脱敏纪律放宽范围需 canvas 所有者确认。
5. **共享包发布形态**：npm 发布 / git 依赖 / file: 依赖？
6. **React 基线与 antd 共存**：Canvas 侧如需 antd 风格深度统一，是否在适配层再包 antd 壳？
7. **i18n 真源**：两份字典以 StringsKey 对齐为准，还是建共享 JSON 同步机制？
8. **toolview 范围**：MVP 仅 status/list_tasks/list_jobs 三个高频读工具。

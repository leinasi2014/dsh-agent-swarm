# dsh-agent-swarm

[![verify](https://github.com/leinasi2014/dsh-agent-swarm/actions/workflows/verify.yml/badge.svg)](https://github.com/leinasi2014/dsh-agent-swarm/actions/workflows/verify.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

`dsh-agent-swarm` 是 DeepSeek Harness（DSH）的多 Agent 团队插件。它保留根会话作为 **Main Brain**，为每个 Team 创建独立的 **Captain Session**，再由 Captain 招募成员、拆分任务、调度执行并审核结果。

> 当前状态：`0.1.1` 预发布源码，`private: true`。仓库可以构建、测试和打包，但尚无公共 npm 版本或稳定发布承诺。

## 用户体验

```text
用户与 Main Brain 对话
  ├─ 创建 Team A → 独立 Captain A → Members A1..An
  └─ 创建 Team B → 独立 Captain B → Members B1..Bn

Captain：设定目标和公告、招募成员、建立任务 DAG、审核提交
Member：只处理当前 fenced attempt，提交结果后等待 Captain 决策
Workbench：在主聊天旁切换 Team，查看成员、任务、公告和管理信息
Captain Chat：通过官方 Session 导航直接与选中的 Captain 对话
```

Main Brain 不加入 Team roster，也不获得 Captain 权限。多个 Team 的 Captain、成员、任务和会话彼此隔离；浏览器 UI 只投影权威状态，不拥有另一套任务状态机。

## 已实现

- 独立 Captain Session、多个 managed Team、Captain/成员身份资料与安全像素 SVG 头像。
- 26 个 `agent_swarm_*` 工具，覆盖建队、成员、任务 DAG、定向分配、提交/审核、邮箱、预算、记忆、等待与分页读取。
- `revision` CAS 与 `attemptId` fencing；陈旧提交、重复执行和越权调用明确失败。
- 官方 Storage Domain 中的 durable Team aggregate；成员、任务、attempt、邮箱、预算、公告和公共目标可跨重启恢复。
- continuable subagent 成员、可替换 Scheduler/Review Provider、可选 Workflow bridge、Jobs 只读投影和每 attempt execution root。
- Team 级 Skill allow-list、成员 tool deny policy、Captain/成员模型路由、资源上限和重启生效的官方 Plugins 设置页。
- 团队共享记忆与成员私有 append-only memory，二者具有独立授权和持久化边界。
- read-only Host projection、同源 `/swarm/v1` RPC 与 DSH Team Workbench V3：多 Team 切换、Workbench/Tasks/Announcements/Management、成员/任务 overlay、Captain Chat 跳转。

## 尚未交付

- 公共 npm/插件市场发布、稳定版本兼容矩阵和面向用户的升级/回滚流程。
- 由已验证 human principal 驱动的通用 browser/RPC 直接写控制；当前主要写路径仍是 Main Brain、Captain 和成员通过模型工具执行。
- Canvas 原生 Consumer、远程成员、跨进程分布式 CAS/lease/fencing 与完整变更流。
- 自动 Skill Evolution；现有 Skills、记忆和验收证据不会自动改写 Skill。
- 覆盖所有支持环境的发布级 E2E、可访问性和故障恢复矩阵。

这些缺口的优先顺序和“90% 产品就绪”定义见 [实施路线](docs/07-implementation-roadmap.md)。

## 架构

```text
Official DSH
  Sessions / Agents / Subagents / Tools / Workflow / Storage / Settings / Client slots
                              │
                              ▼
AgentSwarmRuntime → TeamDomainPort → StorageDomainTeamStore
       │                 │
       │                 └─ Team、roster、task、attempt、mailbox、budget 的唯一写权威
       ├─ Scheduler / Review / Workflow / Workspace / Permission Providers
       ├─ 26 scoped model tools
       └─ Host read projection → /swarm/v1 → Team Workbench
```

- 官方 DSH 是唯一 Runtime、Profile、Session 与 Agent Loop 宿主。
- 所有 Team mutation 经过 `TeamDomainPort`，durable commit 成功后才发布结果和事件。
- UI、RPC、prompt、日志和缓存都是 Consumer 或 projection，不能重建第二份 Team truth。
- 每个注册、监听、timer、route、subagent 和 client mount 都必须有 lifecycle owner 与 disposer。

详细边界见 [产品章程](docs/GOALS.md)、[愿景](docs/00-vision.md)、[能力架构](docs/03-capability-family.md) 和 [核心协议](docs/04-core-protocol.md)。

## 界面

![Team Workbench](docs/assets/readme/team-workbench.png)

![Plugin settings](docs/assets/readme/plugin-settings.png)

截图来自隔离的官方 DSH Web Profile。它们证明对应候选的真实组合路径，不代表尚未交付能力已经完成。

## 本地构建

要求：Node.js `^22.19.0 || >=24`、pnpm `9.15.9`，以及与 `package.json` peer dependencies 和 `docs/OFFICIAL_BASELINE.json` 一致的官方 DSH。

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm verify:candidate
pnpm build
pnpm pack --pack-destination <artifact-directory>
```

预发布包只应安装到 fresh、isolated `DSH_HOME` / Profile。Profile 还必须显式组合官方 Storage、Storage Domain、Session persistence、Subagent runtime 和真实 LLM Provider。安装插件不会自动创建 Team 或成员。

```powershell
$env:DSH_HOME = Join-Path $env:TEMP ('dsh-swarm-' + [guid]::NewGuid().ToString('N'))
dsh plugin --profile web add --workspace-root <absolute-path-to-tarball>
dsh --profile web --dump-config
dsh --profile web --host 127.0.0.1 --port 3180 --no-open
```

## 基本使用

在根会话中描述完整目标，例如：

```text
创建一个独立交付团队。让 Captain 招募需求、实现和审查成员，建立依赖任务，
完成此仓库的集成测试，并以可执行测试结果作为验收证据。
```

Main Brain 调用 `agent_swarm_create_managed` 后应结束当前轮次，不轮询 Team。后续执行由独立 Captain 和成员负责；用户通过 Team Workbench 观察，或打开 Captain Chat 直接调整目标。

## 开发入口

```bash
pnpm verify:isolation:status
pnpm test -- <affected-test>
pnpm verify:candidate
pnpm verify:policy          # 变更治理、指令或登记文档时
pnpm verify:compatibility   # 官方/参考兼容事实参与决策时
```

仓库开发只允许通过 `pnpm isolation open|status|close|reconcile` 使用受管 writer allocation；不要直接创建 Git worktree。贡献规则见 [CONTRIBUTING.md](CONTRIBUTING.md)，文档入口见 [docs/README.md](docs/README.md)。

## License

[MIT](LICENSE)

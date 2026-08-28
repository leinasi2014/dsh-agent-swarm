---
name: dsh-plugin-development
description: 证据驱动地设计、实现、重构、调试、验证和发布 DeepSeek Harness 插件。覆盖 Everything-is-a-plugin、capability seam、函数/Service 插件、inject/effect/event、工具、Bundle/Profile、Host/Client、持久化、Subagent、Workflow、Agent Team、真实组合测试与故障恢复。使用本 Skill 时必须完成可运行或可验证的开发步骤，不能只输出概念说明。
metadata:
  version: "1.5.0"
  evidence_authority: "docs/OFFICIAL_BASELINE.json and ref/*/SOURCE_POINTER.json"
---

# DSH 插件开发

本 Skill 面向真正执行开发任务的 Agent。目标是把框架理论转化成正确的包结构、服务接口、生命周期、持久语义、测试和 Profile 验证。任何结论都必须能追溯到当前项目、目标安装包、官方 DSH 源码或固定参考源。

仓库开发隔离由 `docs/governance/project-binding.yaml` 唯一决定，当前由项目自有 `pnpm isolation open|status|close|reconcile` 生命周期在 Git common-dir ledger 中管理，最多两个 owner/generation 围栏 writer allocation。只有 primary 的干净 `main` 可变更该生命周期；原始 Git worktree 命令、未登记目录和布局门 PASS 均不授权分配或并行写入。本文的 Worktree/执行根内容描述插件产品能力与隔离测试，不授权创建开发 worktree。

## 何时使用

以下任务必须启用本 Skill：

- 创建或重构 DSH Bundle、Host、Client、工具、Service、Provider、Consumer；
- 给现有插件增加持久状态、HTTP、UI、Subagent、Workflow、Agent Team 或后台任务；
- 排查插件未加载、inject pending、Bundle 不生效、Client bundle 崩溃、HMR 泄漏、未知 Session event、Windows 文件写入问题；
- 把其他 Agent Runtime 的能力迁移为 DSH 插件；
- 设计 capability seam 或插件族；
- 发布 npm/Git 源插件并做真实 Profile 验证。

简单业务代码、纯文档编辑或与 DSH 无关的 TypeScript 不需要使用。

---

# 一、理论模型

## 1. Everything is a plugin

DSH 不是“核心应用 + 周边插件”。LLM、工具、Session、Agent Loop、Subagent、Workflow、Storage、Web Host 都由 Cordis 插件树组合。新增行为默认通过已有扩展点挂载；修改 Agent Loop 是最后手段，并要求同步更新架构文档和跨 SDK 行为。

先问：

```text
它是稳定能力吗？            → Service Definition
需要多个实现吗？            → Provider Registry / Provider plugin
模型要调用吗？              → Tool Consumer
人要操作吗？                → Command / Approval / UI Consumer
只需观察或拦截吗？          → Typed Event listener
事实要跨重启吗？            → Session event 或 storage domain
需要推荐安装组合吗？        → Bundle patch
```

## 2. Capability seam

完整 seam 由三种角色构成：

1. **Service Definition**：接口、类型、错误、事件、身份、生命周期承诺；
2. **Provider**：实现 IO、存储、传输、调度或计算；
3. **Consumer**：工具、命令、UI、工作流桥或产品行为。

不要让一个工具的参数直接定义整个 Service API。也不要为了目录整齐拆出没有独立生命周期、替换价值或 Consumer 的空包。

## 3. Authority and source of truth

- 权限和身份从当前 `exec.agent` 或精确 live Agent 推导，不能从用户可伪造的字符串推导。
- Session 日志是模型历史的来源；模型可见内容必须可从日志重建。
- 业务状态只有一个权威来源；UI、Prompt、缓存、快照都从它投影。
- 状态在 durable commit 成功后才发布事件或成功结果。

## 4. Lifecycle ownership

注册即 effect。监听器、路由、Provider、工具、timer、watcher、socket、React root、Worker、Subagent 都必须有 disposer。卸载时：先停止新请求，再取消/收敛在途事务，最后释放资源。HMR/重载后不能保留重复监听、孤儿 Agent 或占用端口。

## 5. Fail loud

配置错误、未知 Provider、不支持 capability、持久化缺失、路由冲突、陈旧 revision/attempt 都应在最早可确定点明确失败。不得把 distributed 静默降为 local、把 Worktree 静默降为 shared checkout、把 review 静默降为信任模型。

---

# 二、执行流程

复杂任务按以下顺序执行。除非用户明确限制，不跳步。

## Step 0：确认工作区与用户改动

执行：

```sh
pwd
git rev-parse --show-toplevel
git status --short --branch
node --version
pnpm --version
pnpm verify:isolation:status
```

若 Step 1 的兼容性触发条件命中，运行仓库的 `verify:compatibility`；否则复用身份未变化的兼容性回执。

读取：

- 根 `AGENTS.md`、`CLAUDE.md`（注意可能是链接）；
- `package.json`、`cordis.patch.yml`、`tsconfig*`、构建配置；
- 相关 `src/`、tests、README、Agent Note/ADR；
- 用户已有改动，不覆盖、不 reset、不删除。

若 Node 不满足 `^22.19.0 || >=24`，不要把构建失败误判成源码错误；可做静态检查，并在结果中明确环境限制。

## Step 1：建立证据基线

这是触发式 official-first compatibility gate。以下任一情况命中时重新取证：官方 Service/package/export/types/Profile 事实参与本次决策；baseline、reference pin、lockfile 或目标 Profile 改变；真实运行结果与缓存分类冲突；新增 seam、状态 owner 或潜在 shadowing。其余功能切片复用以 official baseline digest、两个 reference pin、lockfile 与受影响能力为键的已接受回执，不重复远端扫描。

触发时按优先级取证：

1. 查询官方 `deepseek-ai/deepseek-harness` 远端 HEAD/目标分支和两个参考分支，记录当前 SHA 与本地 pin 是否一致；
2. 读取官方根/包级规则、`docs/architecture.md`、包清单、相关 subsystem 和 implemented Agent Notes，确定已实现功能与明确开发方向；
3. 检查相关官方包的 manifest、exports、types、README、测试与 private/publish 状态，并确认引用的 Agent Notes/包源码已真实 materialize 到证据 checkout；
4. 检查当前项目和目标 Profile 的实际配置，以及已安装 `@deepseek-ai/*` 的真实导出；
5. 将能力分类为 official stable、official experimental/private、absent 或 project-owned overlay；
6. deepseekdocs 仅作为学习材料；
7. `ref/dsh-agent-teams/source/` 用于可移植的 Team 协议与故障用例；
8. `ref/jiuwenswarm/source/` 用于产品能力、执行流程和故障模型。

Developer Preview 期间 API 会变化。不要凭记忆写包名、服务 key 或类型。官方仓库与目标安装版本冲突时，以目标部署导出的 API 为执行边界，并记录官方新方向、版本差异和兼容层。Reference 上游移动只冻结受影响的 re-pin/compatibility 流水线，不阻塞已由未变化 pin 支撑的无关实现。

## Step 2：写一页实现设计

新增/改变 Service、Provider、共享契约、权威状态、权限、生命周期或失败语义时，编码前写一页设计。普通局部切片只需流水线短卡：outcome、owner、代表性验收、immutable base、影响面、适用条件门。

如果用户要的是可运行 UI、工具或工作流，而代表性 walking skeleton 还没有在目标官方 Profile 中跑起来，禁止新建第二份设计、ADR、架构图、receipt/evidence wrapper、oracle 或 verifier。此时只能修改最小现有设计/测试或直接推进 Host/Client、打包安装与真实交互。相同支持机制在可见结果前出现第三个 correction generation，必须停止该路线并回到最短产品路径。

一页设计写清：

```text
唯一职责：
官方 stable/experimental/absent 分类：
复用的官方 Service Definition：
两个 ref 的行为映射：
冲突与单一 owner：
Host / Client / Dual-face：
函数插件 / Service 插件：
Service Definition：
Provider：
Consumer：
Required inject：
Optional services：
权威状态：
模型可见输入及日志来源：
资源 owner / disposer：
配置与限制：
失败语义：
测试层：
已知限制：
```

若只是一个无状态工具，不强行设计 Service。若存在两个实现或多个 Consumer，不把 Provider 逻辑写进工具。

## Step 3：选择插件形态

### 函数插件

适合注册工具、监听事件、挂 Consumer，无独立稳定 Service：

```ts
export const name = 'my-plugin'
export const inject = ['tools'] as const
export const Config = z.object({ enabled: z.boolean().default(true) })
export function apply(ctx: Context, config: Config): void {}
```

函数插件只使用 named exports，不添加 default export。

### Service 插件

适合提供稳定 `ctx.xxx` 能力：

```ts
export default class MyService extends Service {
  static inject = ['sessions']
  constructor(ctx: Context, config: Config) {
    super(ctx, 'myService')
  }
}
```

Service 包 default-export Service class。用 TypeScript declaration merging 声明 `Context` 类型。不要混合 default Service 与函数插件 namespace，否则 Loader 可能丢弃函数插件元数据。

### Host/Client

- 无 Web 需求：Host-only，不声明 `dsh.client`。
- 有浏览器 UI：Host + `exports['./client']` + `dsh.client`；Client 自己导出 `inject`/`apply`。
- UI 只是投影，不拥有调度或持久状态。

## Step 4：实现依赖与 effect

- Required service：静态 `inject`。
- Optional service：`ctx.get(name)`，或 `ctx.inject([...], childCtx => ...)` 惰性挂载。
- `register()` 返回 disposer；放进 `ctx.effect()` 或保证注册 API 已自动绑定 fiber。
- 资源型 Provider 在 disposer 中关闭 medium/worker/socket。
- 先禁止 admission，再等待在途事务；不要先删除状态再取消 Worker。

## Step 5：实现工具和模型体验

使用 `defineTool()`。工具设计必须包含：

- 何时调用与前置条件；
- 参数 schema；
- canonical output schema；
- `output.render` 稳定、短、纯函数；
- 失败语义；
- `exec.agent` authority；
- `exec.signal` cancellation；
- side effect 的幂等/CAS/锁策略；
- timeout 和完整结果大小限制；
- render intent（generic/terminal/diff/locations）。

模型看见的概念应是任务概念，不是数据库表、ZMQ 地址或 UI 状态。

## Step 6：实现状态与事件

### Session event

用于必须随会话 replay/fork/resume 的事实。扩展 `SessionEventMap`，确保目标 Harness 认识事件；未知且非 ignorable 的事件会使旧 Harness 拒绝日志。不要靠运行时篡改只读事件集合维持兼容。

### Storage domain

用于非 Session 业务数据。Consumer 依赖 typed domain，不直接访问 JSON/SQLite backend。明确版本、schema、原子写、close、迁移策略。

### 并发

区分：

- process-local serialization；
- backend single-call atomicity；
- distributed CAS/lease/fencing；
- event notification（不是事务参与者）。

不要把本地 mutex 描述成跨进程安全。

## Step 7：Subagent / Workflow / Team

- 使用 `ctx.subagents` Provider，不自行复制 Agent lifecycle。
- one-shot 与 continuable child 语义不同；continuable 的唯一消息队列是 Agent inbox。
- 先核对目标 DSH 版本是否真的发布通用 workflow 服务；存在时复用它承载确定工作流，不存在时保留显式 Provider 边界并记录缺口，绝不能把 Team Scheduler 伪装成私有工作流引擎。发布与装配事实只由 `docs/OFFICIAL_BASELINE.json`、目标安装包导出和实际 Profile 共同证明。
- 长工具/工作流使用 `ctx.jobs` 提供观察、取消、等待和完成通知。
- Human node 使用 `ctx.userQuestions` / `ctx.approval`。
- Agent Team 优先对齐官方 `ctx.agentTeams`；实验包未发布时通过 adapter 隔离。
- 任务元数据 CAS (`revision`) 与执行 generation (`attemptId`) 是不同机制。
- Worktree 必须改变真实执行 cwd/FS capability，不能只写进 Prompt。

详见 `references/state-subagent-workflow.md` 与 `references/team-orchestration.md`。

## Step 8：Bundle、Profile 与发布

Bundle 包：

```json
{
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

Patch 必须是顶层数组。`id` 是稳定配置身份；`name` 必须 Node 可解析且与实际包一致；config 覆盖是整段替换。

本地开发：

```sh
pnpm build
dsh plugin --profile <isolated-profile> add link:/absolute/path/to/plugin
dsh --profile <isolated-profile> --dump-config
```

Bundle 修改后重启 Profile。不要手写用户 profile 的 bundle manifest。

### 自托管/自更新组合

插件用自己组成开发 Team 时，必须把控制面与候选面分开：

- stable control Profile 只加载 last-known-good artifact；
- 当前仓库只允许一个编码 writer 在已绑定 checkout 中工作；产品的隔离执行根只能作为受测运行时能力使用，不能反向授权并行仓库写入；
- 提交后冻结 commit 和 package digest，Reviewer 不审查 Worker 仍可改写的目录；
- candidate 只进入独立 acceptance Profile/port/state root；
- promotion/rollback 由 candidate 运行时之外的控制器拥有；
- 运行中的 stable Profile 不得原地覆盖、mutable link 或用自身候选热重载；
- candidate/Worker 无权修改 stable storage、credentials、官方/ref evidence 或批准自身。

仓库 dogfood 同样服从绑定的受管 lifecycle。并行 writer 只能通过已验收的 open/status/close/reconcile allocation 取得，产品里程碑或 ADR 的运行时就绪结论不能替代该门；候选也不能验收或激活自身。模型不因费用或响应速度被强制收敛，但命令超时、并发、重试循环、保留上限、取消和回滚仍是故障边界。

## Step 9：验证

迭代中只执行与改动相匹配的检查；冻结功能/集成候选时执行一次候选工程门。条件门只在其 claim 命中时运行：

```sh
pnpm test -- <affected-test>
pnpm verify:isolation:status
pnpm verify:candidate
pnpm verify:policy          # governance/instruction/document authority changed
pnpm verify:isolation       # isolation policy/layout changed
pnpm verify:compatibility   # official/reference compatibility is decision-bearing
node .agents/skills/dsh-plugin-development/scripts/verify-dsh-plugin.mjs .
dsh --profile <check-profile> --dump-config
```

本仓库的 `pnpm verify:candidate`（`pnpm verify` 为兼容别名）包含工程门禁（`docs/08` §9）：oxlint、jscpd 重复检测、knip 死导出检测、`noUnused*` 类型检查、测试、场景审计、构建、artifact 和 src 600 行上限。`verify-dsh-plugin`、真实 Profile、coverage 与 promotion 仅在变更的产品/部署 claim 需要时运行，不重复证明无关事实。

产品/模型可见改动需要真实 Loader 组合和 snapshot/e2e。Mock-only 单元测试不能证明 Bundle、依赖注入、Session 日志或模型文本正确。

## Step 10：交付报告

最终报告按此格式：

```text
完成的行为：
变更文件：
使用的 DSH 扩展点：
权威状态与失败语义：
执行的检查及结果：
未执行检查及原因：
已知限制/后续：
```

不要声称未运行的测试通过。

---

# 三、实用决策树

## 1. 是否需要新 Service？

- 只有一个工具、无替代实现、无其他 Consumer：不需要。
- 两个 Provider、多个 Consumer、独立生命周期或稳定公共能力：需要。
- Service 方法只有一个包内调用者：可能是过度抽象，优先私有 closure。

## 2. 状态放哪里？

- 模型历史/会话事实：Session event。
- 非会话业务状态：storage domain。
- 纯运行时临时状态：operation-local controller。
- 多进程 claim/lease：专用 atomic store Provider，不能只靠 process-local chain。

## 3. 是否需要 Client？

- 只是工具/后台能力：不需要。
- 必须展示 UI：需要 dual-face；Host 提供授权 API/快照，Client 投影。
- 运行依赖浏览器轮询才能推进：设计错误，回到 Host/runtime。

## 4. 是否应该修改 Agent Loop？

通常不应该。先检查：

- agent/* waterfall/serial event；
- tools/* pipeline；
- system prompt section；
- inbox/inject/steer/followup；
- subagent/workflow/jobs/interaction seams；
- per-agent scoped registration。

只有不存在可表达语义的扩展点时才提出 Core 变更，并设计通用 seam，而不是业务特例。

---

# 四、验证矩阵

| 变更 | 必需验证 |
|---|---|
| 工具 schema/render | unit + assembled snapshot |
| Service/Provider | contract + lifecycle dispose + real composition |
| Session event | replay/fork/resume + old/unknown event behavior |
| Storage | backend failure、schema/version、close、并发 |
| Subagent | start failure rollback、interrupt、cold resume、dispose |
| Team task | CAS、stale attempt、DAG、reassign、recovery |
| Mailbox | queue-before-delivery、dedupe、order、crash window |
| Client | mount/dispose、session switch、no duplicate poll/listener |
| Bundle | clean package artifact、link/npm/git install、dump-config |
| Windows | path、rename/locking、PowerShell、UTF-8 |
| Distributed | lease expiry、late ACK、network partition、split brain |

---

# 五、失败处理

## 1. 环境失败

网络、sandbox、权限、Node 版本或缺依赖导致命令失败时，保留原命令和原错误。只在有证据时归因环境，不要“修复”成绕过测试的代码。

## 2. 不确定 API

停止猜测。查：目标 `node_modules` → 官方 types/README → 固定 checkout。仍不确定时选择最小、可安全失败的实现并把假设写入 ADR/README。

## 3. 插件不加载

依次查：

1. `package.json` main/exports/files 是否真实；
2. function/default export 是否混用；
3. Bundle patch 顶层数组与 package name；
4. `--dump-config` 的实际层；
5. inject 是否缺 Provider而 pending；
6. 构建产物是否存在；
7. Client 注册 id/exports 是否匹配；
8. 浏览器与 host 日志。

## 4. 状态卡死

不要先改 UI。检查权威日志/store、operation controller、member live status、未完成 attempt、mailbox ack、dispose/recovery。需要人工修复时先备份并提供迁移工具，不让 Agent 直接编辑生产 JSON。

## 5. 测试冲突

测试描述现有行为，不天然证明行为正确。若设计明确改变，更新测试和文档；若测试揭示 rollback/authorization/durability 破坏，修实现，不删除断言。

---

# 六、本项目专用规则

开发 `dsh-agent-swarm` 时额外遵守：

1. `ref/` 两个 checkout 均只读；更新通过各自 sync 脚本并记录 pin。
2. 不依赖未发布的 `@deepseek-ai/dsh-experimental-agent-team` 作为正式 peer。
3. 不注册冲突的 `ctx.agentTeams`；通过 adapter 对齐。适配完成状态必须由当前实现、测试和 `docs/10-fusion-audit.md` 证明，不得固化在本 Skill。
4. Jiuwen 功能必须先映射到已有 DSH seam；只有确实缺失时设计通用新 seam。
5. Scheduler、Workspace、Budget、Review、Memory、Remote Member、UI 都是插件；不塞回 Team core。
6. `revision` 与 `attemptId` 均保留。
7. 实现产品执行根能力时必须验证独立 DSH/ACP Session 的真实 cwd/FS/tool root，不做 Prompt 假隔离；这不授权开发 worktree。
8. 跨进程状态需要 atomic claim/lease/fencing Provider。
9. Canonical task completed 必须服从配置的 Review Gate。
10. 每个阶段按 `docs/07-implementation-roadmap.md` 的 exit criteria 验收。
11. 服务的发布状态以 `docs/OFFICIAL_BASELINE.json` 与目标安装包为准；“已发布”“Profile 已装配”“本插件已接入”必须分别陈述。
12. `ctx.workspaceRegistry` 不是 Worktree lease 或 continuable child cwd override；没有真实执行 cwd/FS capability 变化时不得宣称 Worktree 隔离。
13. 官方/ref 事实变化时，同一候选只更新受影响的注册权威文档、`docs/09-sources.md` 和必要的审计基线，并全文检索旧结论；不机械触碰无关 README、ADR、roadmap 或 Skill。
14. `docs/11-official-first-development.md` 的 Gate A 由兼容性触发条件启动；未命中时复用身份未变化的回执。Gate A 失败只阻塞受影响的兼容/re-pin 流水线，不冻结无关功能。
15. 独立安全/架构审查按 `$manage-agile-software-development` 与 `docs/governance/project-binding.yaml` 的风险分级执行；审查范围、权限、候选身份和验收问题由工作包明确，项目经理接收报告并核验证据，不改写结论。
16. 用户明确授权全权限审查时，将 `danger-full-access` 与 `approval=never` 固定在独立 Session，核对持久权限事件；临时修改未来 Session 默认值后立即恢复。运行时全权限不等于允许改生产源码，审查写入范围仍由任务约束。
17. M1A 已实现 ADR-0007：`sessionPersistence` 和 `storageDomain` 是 fail-closed 必需注入（缺失组合中插件保持 pending）；权威 Team aggregate 位于官方 `agent_swarm` Storage Domain（`TeamDomainPort` → `StorageDomainTeamStore`，每 Team 一条版本化记录 + 迁移回执），绝不在共享工作区；`FileTeamStore` 只读（迁移读取器/fixture，无写路径）；迁移仅经 `scripts/migrate-legacy-team-store.mjs` 显式单向执行（空目的、读回校验、回执、源只读），禁止运行时自动迁移、双写或回退；该保护 denies ordinary workspace writer，不是对 unrestricted host access 的防御，存储 root 必须配置在工作区与 sandbox 根之外。持久边界事实（M4-3/#129 探针实证，docs/09 §1）：官方 storage-domain 的 `put` 原样存储记录，但加载路径按表 value schema zod 解析并**剥离未声明键**——向聚合新增可选字段时必须同时扩展 `src/storage/team-spec.ts` 的 zod 表 schema 与 `assertTeamState`，否则字段仅在单进程存活、重载即静默丢失（`verification`/`replacesAttemptId` 曾因此中招）。
18. 自托管运行时依 ADR-0008 分级；仓库开发始终以项目绑定为准，D2 并行开发仅通过项目自有受管 lifecycle 分配，最多两个 writer，集成仍串行。
19. Stable control、candidate commit/artifact、acceptance Profile/state/RPC、promotion/rollback 必须分权；candidate 不能批准或部署自身。
20. Dogfood 管理只观察权威 Team/Job/lease/verification 状态和阶段报告，不轮询私有推理；失败通过 Lead 建立 fresh fenced task，不直接篡改 canonical state。
21. Skill Evolution 只能消费 accepted evidence，并分离 proposal、deterministic validation、approval 和 write；Agent 不得自行扩大授权它的 Skill。
22. 不为节约套餐或响应速度限制健康开发/审查的 token、step 或时间；仍必须实施故障型 concurrency/timeout/retry/retention/cancel/rollback 控制。

---

# 七、延伸材料

按任务读取，而不是一次性把所有材料塞进上下文：

- `references/theory.md`
- `references/plugin-shapes.md`
- `references/services-effects-events.md`
- `references/tools-config-bundles.md`
- `references/state-subagent-workflow.md`
- `references/team-orchestration.md`
- `references/testing-debugging.md`
- `references/source-map.md`
- `templates/`
- `scripts/inspect-environment.mjs`
- `scripts/verify-dsh-plugin.mjs`

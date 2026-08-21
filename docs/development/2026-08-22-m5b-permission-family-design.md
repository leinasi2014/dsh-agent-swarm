# M5-2 设计注记：权限能力族——成员工具权限策略面扩展（issue #136）

日期：2026-08-22。分支 `feat/m5-permission-family`（基线 main @ 42a09e1）。

## 0. 任务与范围

现有 toolFilter（M1A 落地：成员 provisioning 时静态 deny `CAPTAIN_ONLY_TOOLS`）的策略深化。issue #136 要求：

1. 策略声明面选型：per-role/per-task 工具权限的动态化评估（provisioning 时静态扩展 vs 保持静态 + 任务级声明）；
2. 官方 rc.2 credentials/authorization 面对照（Gate A rc.2 分析 D 类发现）：评估消费或边界声明；
3. 与 #100 执行根 / #101 审查根的权限交互声明；
4. 测试：策略生效路径 + 越权 fail-loud。

红线：M1A toolFilter 静态语义零回退（F15 预检不动）；F8 定界原则不破；官方包只消费；credentials/密钥永远 env 注入；`docs/reviews/`、`GOALS.md` 只读。

## 1. Gate A 证据基础

- 官方 pin：`b150a55`（`dsh@0.1.1-rc.2`，docs/09 §1，`verify:gate-a` 在本变更内复核通过）。
- 本注记新增查验的官方源（`D:\Source\DSH\framework\deepseek-harness-rc8-full`，rc.8 全源 = rc.2 允许的证据面）：
  - `packages/subagent/subagent/src/types.ts`：`SubagentCapabilities.toolFilter`；`SubagentStartRequest.toolFilter?: ToolRestriction`（"applied as a scoped `tools.restrict()` in the child's creation window … vanish from the child's prompt AND refuse to execute (one visibility), with loud unknown-name validation"）。
  - `packages/subagent/subagent/src/continuation.ts`：`ContinuableStartSpec.request = Omit<SubagentStartRequest, 'label'|'signal'|'outputSchema'>`（`toolFilter` 仅随 start 传入）；`startContinuable` 把 `request.toolFilter` 快照进持久 descriptor（`snapshotSubagentDescriptor`），冷恢复时从 descriptor 重放（`composition: { persona: descriptor.persona, toolFilter: descriptor.toolFilter }`）；**`SubagentFollowupOptions` 只有 `source` 与 `signal`，没有任何 composition 字段**——任务投递（followup）在官方面上无法改变工具可见性。
  - `packages/subagent/subagent/src/child-agent.ts`：`applyChildComposition` 仅在子创建窗口执行一次 `childCtx.tools.restrict(composition.toolFilter)`；同文件 `captureDelegatedPolicyOverrides`/`DelegatedPolicyOverrides` 记录官方委托边界的其余授权面（父会话显式 sandbox-mode override 种子到子日志、approval 固定 pin `'never'`——被委托子代永远不能请求审批）。
  - `packages/core/tools/src/index.ts`：`ToolRestriction = { allow?: readonly string[]; deny?: readonly string[] }`（restrictions intersect）；`restrict()` 的 fail-loud 契约——空 filter 抛错（no-op 防护）、未知全局工具名抛错并列出已知集合、保留 Code Mode transport 名拒绝。
  - `packages/credentials/credentials/src/index.ts` + `types.ts` + README（rc.2 新增，D 类发现对象）：`CredentialProvider` Service Definition（`ctx.credentials`），POSIX env-var 名的 branded `CredentialRef`，per-operation `resolve`、value-free `describe`、shadow-rejecting `set/unset`，`credentials/updated` 事件。本插件依赖树（package.json peer/dev 集合）未安装该包。
- 项目现状面：`src/runtime/member-provisioning.ts`（F15 预检 + `toolFilter: { deny: [...CAPTAIN_ONLY_TOOLS] }`）、`src/runtime/prompts.ts`（`CAPTAIN_ONLY_TOOLS`、F8 定界）、`src/runtime/execution-roots.ts`（#100）、`src/runtime/review-root.ts`（#101）、docs/03 §2/§3、docs/04 §8d/§8l。

## 2. D1 策略声明面选型：provisioning 时静态扩展（deny-only 单调收窄），不做 per-task 动态化

**结论：扩展 provisioning 时的静态声明面——`agent_swarm_add_member` 新增可选 `deny_tools`（deny-only、与强制 `CAPTAIN_ONLY_TOOLS` deny 求并）；per-task 动态工具权限判定为官方 seam 不可表达，落边界声明。** 依据：

1. **官方 seam 事实（决定性）**：continuable 成员的工具围栏是子创建窗口语义——`toolFilter` 随 `startContinuable` 传入、快照进持久 descriptor、冷恢复从 descriptor 重放；followup（任务投递）无 composition 面。长期成员模型下 per-task 动态 scoping 在官方面上没有落点。
2. **备选逐项排除**：
   - *per-task 一次性子代*：不是策略扩展而是架构替换——推翻 roster 身份、邮箱 F2/F3 对账、按会话计费与 F12 名字终身制。否决。
   - *任务级工具限制以 prompt/assignment 文本声明*：advisory 文本冒充授权，被自有架构明文禁止（docs/03 §3 TeamWorkspace："Tool authorization must derive from the actual Agent workspace/sandbox, not from advisory task fields"；docs/11 §6 forbidden designs；docs/04 §8d 权威边界段）。否决。
   - *插件侧 per-task 拦截宿主工具*：需改 Agent Loop 或注册全局 tools guard 影响整个宿主（宪法第 5/9 条）。否决。
   - *角色名→策略表（operator config 键控 captain 自由文本 role）*：权威混合（operator 拥有策略、captain 拥有 role 文本），且 role 是 F8 意义上的不可信自由文本。内联 per-member 声明保持单一 transition owner（captain，经 `TEAM_CAPTAIN_REQUIRED` 域检查），否决配置表形态。
3. **威胁模型（deny-only 单调性）**：声明只能收窄——组合为 `deny = CAPTAIN_ONLY_TOOLS ∪ declared`，无 `allow` 面、无任何放宽路径；声明 captain-only 名是幂等 no-op（并集吸收）。最坏情形（captain 被注入或声明损坏）是成员被锁死（可见、fail-loud、可另 provisioning 新成员恢复），**不存在提权方向**——与 F8"权威在域检查 + toolFilter"的方向性一致。声明走 captain 工具参数（模型驱动），与 `addMember` 本身的既有权威面相同，不新增信任假设。
4. **M1A/F15 零回退**：F15 预检（`depthLimit`/`persona`/`toolFilter` 能力检查）不动；无 `deny_tools` 时组合结果与现状逐字节一致（仅 `CAPTAIN_ONLY_TOOLS`）；`allow` 键结构性不存在。
5. **fail-loud 契约分层**：结构性校验在插件侧且**先于任何 provisioning 记录提交**（与 F15 同一预检纪律；非空、工具名 pattern、无重复、≤64 项，`TEAM_TOOL_POLICY_INVALID`，无 roster 副作用）；存在性校验归官方权威——`tools.restrict()` 在子创建窗口对未知全局工具名抛错（列出已知集合），`startContinuable` 拒绝 → `addMember` 既有失败路径 settle `failed` 并上抛。插件**不做**存在性预检：子作用域的 restrictable 集合与插件作用域视图不可比，预检既会误拒也会漏报，官方 seam 已有权威校验。
6. **权威与可重建性**：应用的 filter 的单一权威记录 = 持久子 descriptor（官方快照）；**不**在 Team 聚合复制策略字段（避免第二权威/漂移；ADR-0007 聚合 schema 零改动）。声明本身可从 captain 会话日志（工具调用参数）重建，应用结果可从子会话 descriptor 重建——满足"模型可见必须可从 Session 日志重建"。已知缺口如实申报：roster/list 面不展示成员策略（读取需折叠 descriptor，留待有真实消费者时再做）。
7. **persona 不改**：官方语义是"one visibility"（被 deny 的工具从子 prompt 消失且执行被拒），成员不会看到被拒工具，无需 persona 解释；在 persona 里复述被拒清单反而制造可与真实 filter 漂移的第二声明面。
8. **per-task 的真实执行时权威已在别处**：成员对 Team 状态的 per-attempt 权威是域检查（attempt fencing、`TEAM_CAPTAIN_REQUIRED`、`TEAM_ATTEMPT_STALE`），本就不依赖工具可见性；本扩展覆盖的是宿主工具面（bash/read/write 等），该面在官方设计里就是 per-child 静态。

**边界声明（per-task 动态化）**：跟随 followup 的 composition/toolFilter 面在官方 rc.2 不存在。重开触发条件：官方为 continuable followup 增加组合/围栏面，或提供成员级 policy 服务。此为上游 seam 提案记录，不是本插件可自行兑现的能力。

## 3. D2 官方 credentials/authorization 面：边界声明，不消费

- **消费评估**：本插件没有 secret-value 消费者——不自建 LLM/HTTP 调用（成员跑在宿主组合的 AgentLoop 与宿主配置的 provider 上），Team 状态按宪法永不携带凭据值或引用（env 注入属部署面；F8 定界纪律同时封住把引用当数据的通道）。`ctx.credentials` 的 `resolve`/`describe`/`set`/`unset` 四操作没有一个有本项目侧的调用点。**结论：边界声明，不新增依赖。**
- **官方委托授权面的完整刻画（登记入 docs/09 §1）**：官方对被委托子代的授权面由四件事构成——创建窗口 `toolFilter`（`ToolRestriction` allow/deny，loud 校验）、父会话显式 sandbox-mode override 的委托种子（持久进子日志，冷恢复重放）、approval pin `'never'`（被委托子代确定性不可请求审批）、`maxDepth` 深度帽。本插件的策略覆盖严格落在 `toolFilter` 一项之内，与另三项组合而不触碰。
- **credentials 与工具策略的正交性**：`deny_tools` 操作工具**名**，不是秘密访问面；`CredentialRef` 不进 Team 状态、不进工具参数、不进 prompt。若未来出现成员需按引用取凭据的真实需求（当前没有），必须先重开本节边界评估——届时正确形态是宿主组合 `ctx.credentials` 并由部署 Profile 决定，而不是插件自持秘密。

## 4. D3 与执行根 / 审查根的权限交互声明

三个权限面分属不同权威平面，互相不可替代、不可扩张：

| 平面 | 权威 | 已实现机制 | 边界 |
|---|---|---|---|
| 成员工具面 | 官方 `tools.restrict()`（创建窗口，M1A + 本扩展 deny-only 收窄） | `CAPTAIN_ONLY_TOOLS` ∪ `deny_tools` | per-child 静态；无 per-task 动态面（§2.8） |
| 成员执行根（#100） | 插件侧根供给 Provider（`git-worktree`/temp） | 指派帧可信头声明确定性绝对路径，经官方 workdir/绝对路径语义消费 | 声明级（合作成员）而非硬文件系统围栏（docs/04 §8l 已知缺口）；硬约束属后续 sandbox/远程成员工作（ADR-0008 D2/D4） |
| 审查根（#101） | Review Provider 自身进程权威 | 隔离根内执行 captain 冻结的验证命令，证据只由根产出，被审方无句柄 | 审查命令的权限 = 宿主插件进程权限（有界超时 + cwd 限于根内），不受成员 deny-list 约束也不被其扩张 |

交互声明：deny-list 收窄成员自己的工具面，不围栏执行根也不触碰审查根；执行根不放宽工具（根只是路径约定）；审查根是被审方之外的独立验证平面——一个被 deny 了 `bash` 的成员仍可能产出被审查根用 shell 命令检验的工件，这是设计而非漏洞（验证权威本来就不在成员手里）。`writeScopes` 维持纯提示语义不变。

## 5. 实现清单

1. `src/runtime/tool-policy.ts`（新）：`memberToolDeny(declared?)` 纯函数——结构校验（非空 trim、`^[A-Za-z0-9][A-Za-z0-9_.-]*$`、无重复、≤64 项；违规抛 `TEAM_TOOL_POLICY_INVALID`）后返回 `CAPTAIN_ONLY_TOOLS ∪ declared`（去重、captain-only 前置保持稳定序）。
2. `src/runtime/member-provisioning.ts`：`addMember` 输入增 `denyTools?: readonly string[]`；组合在 F15 预检后、`provisionMember` 提交前完成（结构违规零 roster 副作用）；`toolFilter: { deny }`。F15 预检与其余路径逐字节不动。
3. `src/runtime/orchestrator-runtime.ts`：`addMember` 输入透传。
4. `src/tools/team-lifecycle.ts`：`agent_swarm_add_member` 增可选 `deny_tools: string[]` 参数（描述声明 deny-only 收窄语义与 fail-loud 行为）。输出 schema 不变。
5. 测试 `tests/tool-policy.spec.ts`（真实组合，模式同 `member-provisioning.spec.ts`）：见 §6。
6. docs 同步：docs/03（家族状态 + 权限段）、docs/04（新 §8o，F17 决策）、docs/09（§1 两条官方事实：credentials 面刻画与边界；toolFilter 创建窗口/followup 无 composition 面）、docs/10（§分层表 tiered permissions 行更新）、docs/07（M5 进度注记）、docs/11（§4 所有权映射增 credentials 行）、README（已实现核心 + DSH 边界 + 测试计数）。Skill 无需变更：其纪律条款（权限从 `exec.agent` 推导等）不被本变更证伪。

## 6. 测试计划

1. **策略生效路径（真实组合）**：`deny_tools` 指名一个成员本可见的真实插件工具（`agent_swarm_send_message`）→ provisioning 成功 → 子会话持久 descriptor 折叠出的 `toolFilter.deny` 恰为 captain-only ∪ 声明（且无 `allow` 键）——同时证明持久可重建性。
2. **M1A 零回退**：无 `deny_tools` → descriptor `deny` 与 `CAPTAIN_ONLY_TOOLS` 逐项相等（顺序保持）。
3. **越权 fail-loud（真实组合）**：`deny_tools` 含不存在的工具名 → `add_member` isError；roster 记录 settle `failed` 且 error 含官方 unknown-name 诊断；官方 `restrict()` 校验作为存在性权威被真实走到。
4. **结构校验单元**：空名/pattern 违规/重复/超 64 项 → `TEAM_TOOL_POLICY_INVALID`；captain-only 名幂等接受（并集吸收，无重复输出）。
5. 既有套件全绿（F15 预检、F8 场景 19、provisioning 对账等不受影响）。

## 7. 变更记录（docs/11 §7 模板）

```text
Official remote SHA/date: b150a551b8d465e31e418e1b2eaf5e79bbb7d28e / 2026-08-22 (dsh@0.1.1-rc.2)
Relevant implemented Agent Notes/packages: dsh-subagent (types.ts/continuation.ts/child-agent.ts),
  dsh-tools core tools registry (ToolRestriction/restrict), dsh-credentials (rc.2 新增, 未安装未消费)
Installed/Profile capability evidence: peer/dev 依赖树无 dsh-credentials; toolFilter 面经既有真实组合测试在用
Stable / experimental / absent / overlay classification: toolFilter = 官方稳定 seam 消费;
  member tool policy = project-owned overlay (deny-only 单调收窄); per-task 动态面 = absent(边界声明);
  credentials = 官方稳定 Service Definition, 边界声明不消费
Reference behaviors and failure cases selected: Jiuwen 分层 allow/ask/deny 仅作需求方向 (docs/05 §7.2,
  不导入其 Permission Engine); dsh-agent-teams 无对应面
Canonical state owner: 应用的 filter = 持久子 descriptor (官方); 声明 = captain 会话日志 (工具调用参数);
  Team 聚合不复制策略字段
Transition owner and conflict prevention: addMember 单入口, F15 预检先行, provisionMember 记录先于子启动
Plugin shape (definition/provider/consumer/bundle): 纯 runtime overlay + 既有工具面扩展, 无新服务/依赖
Lifecycle/persistence/security limits: deny-only 单调; 无 allow 面; 官方 restrict() loud 校验为存在性权威;
  执行根/审查根边界见 §4
Migration/rollback: 无 schema/存储变化; 旧调用 (无 deny_tools) 行为逐字节不变
Unit/conformance/fault/real-composition gates: tests/tool-policy.spec.ts (§6) + 全量 pnpm verify
Docs/Skill files updated: docs/03/04/07/09/10/11, README, 本注记; Skill 评估后无需变更
```

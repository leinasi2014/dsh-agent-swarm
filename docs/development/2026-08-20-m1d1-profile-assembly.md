# M1D-1 证据报告 — 真实 rc.8 Profile 装配验证（双环境取证）

- Report: 2026-08-20（M1D 第一项，实现工程师执行；issue #37，PM 委派）
- Plugin under test: worktree `D:\Source\DSH\plugin\dsh-agent-swarm-wt-m1d1`，分支 `test/m1d-profile-assembly`，commit `c298dcd`（`docs(m1c): milestone exit, goal handover, PM methodology and guard hardening`），`lib/` 构建产物就绪
- 任务性质：纯验证（取证），未修改 `src/`、`ref/`、`docs/reviews/`、Skill 与任何运行时行为
- 结论先行：**全部验收项通过，未发现插件缺陷**；1 项环境/上游发现（pnpm 9 与 `dsh plugin add` 的交互，见 §8），2 项非缺陷观察（§8.2/§8.3）

## 1. 隔离与红线合规

所有 Profile 状态、存储根与探针均位于 `%TEMP%\m1d-check`（路径含 `m1d-check`），通过官方 `DSH_HOME` 环境变量整体重定向，**从未触碰 `~/.dsh`（用户既有 `headless`/`web` profile 与默认状态零接触，全程只读未写）**：

| 用途 | 绝对路径（正斜杠形式供 Node） |
|---|---|
| 主环境 DSH_HOME | `C:/Users/windo/AppData/Local/Temp/m1d-check/home` |
| 主环境 json KV 后端 root | `C:/Users/windo/AppData/Local/Temp/m1d-check/storage-root` |
| 主环境 session persistence root | `C:/Users/windo/AppData/Local/Temp/m1d-check/sessions-root` |
| 第二环境 DSH_HOME | `C:/Users/windo/AppData/Local/Temp/m1d-check/env2/home` |
| 第二环境 json KV root / sessions root | `C:/Users/windo/AppData/Local/Temp/m1d-check/env2/{storage-root,sessions-root}` |
| 探针包 | `C:/Users/windo/AppData/Local/Temp/m1d-check/probe/dsh-m1d-probe` |

Profile 命名全部为全新 `agent-swarm-m1d-check*`：`agent-swarm-m1d-check`（完整栈）、`agent-swarm-m1d-check-load`（完整栈+探针）、`agent-swarm-m1d-check-nodomain`、`agent-swarm-m1d-check-nopersist`（主环境裁剪）、`agent-swarm-m1d-check-2`、`agent-swarm-m1d-check-2-nodomain`（第二环境）。

存储根均在团队工作区与 sandbox 根之外（`%TEMP%` 下专用目录），满足 F1 威胁模型对存储根的部署要求（README「Profile 组合」）。杀进程仅限本报告自己启动的隔离 Profile 进程（`timeout` 一次，§3.3）；未做恢复类实验（属 #38）。

运行时版本：Node `v24.18.0`，pnpm `9.15.9`（机器全局；交互影响见 §8.1），Git Bash（GNU coreutils `timeout 8.32`）。

## 2. 双环境版本证明

| 环境 | CLI 入口 | `--version` 输出 |
|---|---|---|
| 主环境（官方纯净 checkout） | `node D:/Source/DSH/framework/deepseek-harness-rc8-full/apps/cli/lib/bin.js` | `0.1.0-rc.8` |
| 第二环境（用户项目 Runtime，DEV-DSH-BOOT-001） | `node D:/Source/infinite-canvas-worktrees/DEV-DSH-BOOT-001/dsh/apps/cli/lib/bin.js` | `0.1.0-rc.8` |

两 CLI 均为 rc.8 世系（`apps/cli` 同构；第二环境 `packageManager` 亦 pin `pnpm@11.7.0`，与官方 checkout 一致）。

## 3. 主环境：完整装配取证

以下命令在 Git Bash 中逐条执行；`DSH_HOME` 已 export 指向 §1 的隔离 home。CLI 变量 `CLI=D:/Source/DSH/framework/deepseek-harness-rc8-full/apps/cli/lib/bin.js`。

### 3.1 plugin add（隔离 Profile 初始化 + 链接插件）

命令原文：

```sh
node "$CLI" plugin --profile agent-swarm-m1d-check add -w link:D:/Source/DSH/plugin/dsh-agent-swarm-wt-m1d1
```

关键输出（`-w` 的必要性见 §8.1；CLI 将参数原样转发给 pnpm）：

```
dsh: initialized profile agent-swarm-m1d-check at C:\Users\windo\AppData\Local\Temp\m1d-check\home\profiles\agent-swarm-m1d-check
dependencies:
+ dsh-agent-swarm 0.1.0 <- D:\Source\DSH\plugin\dsh-agent-swarm-wt-m1d1
Done in 364ms using pnpm v9.15.9
```

退出码 0。安装后 profile manifest 的 `dsh.profile.bundles` 由 CLI 自动对账为 `["@deepseek-ai/dsh-base","dsh-agent-swarm"]`——插件因声明 `dsh.bundle.patch` 被接纳为 Profile 层（官方 `reconcilePlugins` 语义）。

### 3.2 存储栈 patch（Profile `cordis.patch.yml` 全文）

写入 `$DSH_HOME/profiles/agent-swarm-m1d-check/cordis.patch.yml`（load/第二环境 profile 同构，仅 root 不同）：

```yaml
# M1D-1 (issue #37) durable storage-stack composition for dsh-agent-swarm.
# json KV root and session-persistence root are isolated check directories
# OUTSIDE every team workspace and sandbox root (F1 threat model, plugin README).
- insert:
    - id: storage
      name: '@deepseek-ai/dsh-storage'
    - id: storage-json
      name: '@deepseek-ai/dsh-storage-json'
      config:
        root: 'C:/Users/windo/AppData/Local/Temp/m1d-check/storage-root'
    - id: storage-domain
      name: '@deepseek-ai/dsh-storage-domain'
      config:
        backend: json
- id: session-persistence-jsonl
  config:
    root: 'C:/Users/windo/AppData/Local/Temp/m1d-check/sessions-root'
```

组合说明：`dsh-base` 模板已内建 `session-persistence-jsonl` 行（root 缺省 `dshHomePath('sessions')`），故按官方 patch 语义以 id 定向覆盖其 `config.root` 至隔离目录；`storage`/`storage-json`/`storage-domain` 三行为插入（base 无存储栈）。三行包名无需 pnpm add——CLI 的 `healProfilesModuleFallback` 会把 CLI 依赖图中的全部 `@deepseek-ai/*` 包 symlink 进 `$DSH_HOME/profiles/node_modules`，Profile 行即可解析（这同时是插件 peerDependencies 的解析来源）。

### 3.3 `--dump-config` 取证

命令原文：`node "$CLI" --profile agent-swarm-m1d-check --dump-config`（退出码 0）。关键节选（完整转储另存证据文件）：

```
# == dsh-agent-swarm
- id: agent-swarm
  name: dsh-agent-swarm
  config:
    enabled: true
    memberProvider: spawn
    memberMaxDepth: 1
    schedulerProvider: priority-ready
    reviewProvider: manual
# == C:\...\m1d-check\home\profiles\agent-swarm-m1d-check\cordis.patch.yml
- id: storage
  name: '@deepseek-ai/dsh-storage'
- id: storage-json
  name: '@deepseek-ai/dsh-storage-json'
  config:
    root: C:/Users/windo/AppData/Local/Temp/m1d-check/storage-root
- id: storage-domain
  name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: json
```

以及 base 层被定向覆盖后的行：

```
# == @deepseek-ai/dsh-base, patched by C:\...\agent-swarm-m1d-check\cordis.patch.yml
- id: session-persistence-jsonl
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: C:/Users/windo/AppData/Local/Temp/m1d-check/sessions-root
```

fail-closed 必需服务齐备：`sessionPersistence`（session-persistence-jsonl 行，隔离 root）与 `storageDomain`（storage-domain 行，backend=json 路由至 json KV 后端，后端 root 在工作区之外）。

### 3.4 真实 boot（无探针纯装配）

命令原文：`timeout --kill-after=5 25 node "$CLI" --profile agent-swarm-m1d-check`。结果：

- 25 秒窗口内进程健康存活（`EXIT=124` 仅为 `timeout` 到期信号），stdout/stderr 0 字节——官方 `boot()` 的 `assertEntriesActivated` 审计若见任一 pending/failed 条目会以 `dsh: fatal load failure` 立即非零退出（对照 §4/§5），故「无 fatal + 存活」即证明全部条目（含 agent-swarm）ACTIVE。
- 物理证据：boot 前删除 `storage-root` 目录，boot 后该目录被重建（`JsonStorageBackend.openUnit` 的 `mkdir root recursive`）——重建只能来自插件激活路径 `AgentSwarmRuntime.start() → ctx.storageDomain.open(teamDomainSpec)`，即 `agent_swarm` 域在真实 CLI 进程内真实打开。

### 3.5 加载验证（探针 boot：工具注册数 + systemPrompt 节）

探针是只读验证 bundle（源码见 §6），经同一官方路径装入独立 Profile `agent-swarm-m1d-check-load`（`plugin add -w link:...` 两次：插件 + 探针；`--dump-config` 退出码 0，层序 `@deepseek-ai/dsh-base → dsh-agent-swarm → dsh-m1d-probe`）。探针注入 `agentSwarm` 服务，因此只在插件完全激活后运行。

命令原文：`node "$CLI" --profile agent-swarm-m1d-check-load`。退出码 **0**，stdout：

```json
{
  "probe": "m1d-profile-assembly-load-evidence",
  "agentSwarmServicePresent": true,
  "totalToolCount": 41,
  "agentSwarmToolCount": 16,
  "agentSwarmToolNames": [
    "agent_swarm_add_member", "agent_swarm_add_memory", "agent_swarm_archive",
    "agent_swarm_claim_task", "agent_swarm_create", "agent_swarm_create_task",
    "agent_swarm_interrupt_member", "agent_swarm_list_tasks",
    "agent_swarm_reassign_task", "agent_swarm_remove_member",
    "agent_swarm_review_task", "agent_swarm_send_message",
    "agent_swarm_set_budget", "agent_swarm_status",
    "agent_swarm_submit_task", "agent_swarm_wait"
  ],
  "promptSectionNames": [
    "harness:identity", "deployment:persona", "plan:policy", "tool:read",
    "tool:write", "tool:edit", "tool:glob", "tool:grep", "tool:pwsh",
    "tool:jobs", "tool:web_search", "tool:goal", "tool:workflow",
    "tool:ralph", "tool:subagent", "agent-swarm:usage"
  ],
  "agentSwarmSectionPresent": true,
  "agentSwarmSectionExcerpt": "Use agent_swarm_* when the user requests a coordinated multi-agent Team.\n1. Create one Team, then add role-specific continuable members.\n2. Decompose the goal i"
}
```

判读：16 个 `agent_swarm_*` 工具与 `src/tools.ts` 的 16 处注册一一对应（名称完全一致）；systemPrompt 组装结果含 `agent-swarm:usage` 节（order 118，节选文本与 `src/index.ts` 的 `usage` 一致）；进程经 `ctx.appExit(0)` 干净退出。

## 4. 主环境：fail-closed 裁剪组合复证（≥2 种缺失组合）

裁剪 A（`agent-swarm-m1d-check-nodomain`，patch = §3.2 去掉 `storage-domain` 行）：

```yaml
- insert:
    - id: storage
      name: '@deepseek-ai/dsh-storage'
    - id: storage-json
      name: '@deepseek-ai/dsh-storage-json'
      config:
        root: 'C:/Users/windo/AppData/Local/Temp/m1d-check/storage-root'
- id: session-persistence-jsonl
  config:
    root: 'C:/Users/windo/AppData/Local/Temp/m1d-check/sessions-root'
```

命令原文：`node "$CLI" --profile agent-swarm-m1d-check-nodomain`（`--dump-config` 退出码 0，转储无 `storage-domain` 行）。boot 退出码 **1**：

```
Error: dsh: plugin tree failed to load: dsh: 1 entry did not activate
dsh-agent-swarm: pending (waiting for service: storageDomain)
```

裁剪 B（`agent-swarm-m1d-check-nopersist`，patch = §3.2 完整存储栈 + 禁用持久化行）：

```yaml
- id: session-persistence-jsonl
  disabled: true
```

（`--dump-config` 退出码 0，该行渲染为 `... disabled: true`。）boot 退出码 **1**：

```
Error: dsh: plugin tree failed to load: dsh: 2 entries did not activate
@deepseek-ai/dsh-session-checkpoint-policy: pending (waiting for service: sessionPersistence)
dsh-agent-swarm: pending (waiting for service: sessionPersistence)
```

判读：两种缺失组合下插件在真实 CLI 上均保持 pending（fail closed）、无降级回退、无部分工具注册（activation 审计在任何条目未激活时拒绝整棵树，工具注册发生在 `runtime.start()` 成功之后，故失败组合下 0 个 `agent_swarm_*` 工具可见）。官方 `dsh-session-checkpoint-policy` 同因缺 `sessionPersistence` pending 属预期连带（§8.3）。

## 5. 第二环境（DEV-DSH-BOOT-001 Runtime）核心装配复证

命令原文（`CLI2=D:/Source/infinite-canvas-worktrees/DEV-DSH-BOOT-001/dsh/apps/cli/lib/bin.js`，`DSH_HOME` 指向 env2 隔离 home）：

```sh
node "$CLI2" --version                       # → 0.1.0-rc.8
node "$CLI2" plugin --profile agent-swarm-m1d-check-2 add -w link:D:/Source/DSH/plugin/dsh-agent-swarm-wt-m1d1
node "$CLI2" plugin --profile agent-swarm-m1d-check-2 add -w link:C:/Users/windo/AppData/Local/Temp/m1d-check/probe/dsh-m1d-probe
# 写入 env2-full patch（同 §3.2，root 换 env2 目录）
node "$CLI2" --profile agent-swarm-m1d-check-2 --dump-config   # 退出码 0
node "$CLI2" --profile agent-swarm-m1d-check-2                 # 探针 boot
```

结果：

- 两次 `plugin add -w` 退出码 0（`+ dsh-agent-swarm 0.1.0 <- D:\Source\DSH\plugin\dsh-agent-swarm-wt-m1d1`、`+ dsh-m1d-probe 0.0.1`），bundles 对账为 `["@deepseek-ai/dsh-base","dsh-agent-swarm","dsh-m1d-probe"]`；
- `--dump-config` 退出码 0，层序与行集合与主环境一致（`# == dsh-agent-swarm`、`# == dsh-m1d-probe`、storage/storage-json(隔离 root)/storage-domain 行齐备）；
- 探针 boot 退出码 **0**，输出与 §3.5 **逐字段一致**（`agentSwarmToolCount: 16`、`agentSwarmSectionPresent: true`、同一 41 工具目录与 16 节 systemPrompt）；
- 物理证据：boot 前删除 `env2/storage-root`，探针 boot（含干净退出）后目录被重建；
- fail-closed 抽查（`agent-swarm-m1d-check-2-nodomain`，同裁剪 A，root 换 env2 路径）：boot 退出码 **1**，`dsh-agent-swarm: pending (waiting for service: storageDomain)`。

## 6. 探针源码（验证辅助，不入库；verbatim）

`C:/Users/windo/AppData/Local/Temp/m1d-check/probe/dsh-m1d-probe/package.json`：

```json
{
  "name": "dsh-m1d-probe",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "lib/index.mjs",
  "exports": {
    ".": "./lib/index.mjs",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml`：

```yaml
# M1D-1 load-evidence probe (issue #37): a read-only verification bundle.
# It injects the agentSwarm service so it activates strictly AFTER
# dsh-agent-swarm, assembles the real system prompt, prints the tool catalog
# and prompt-section evidence as JSON, then requests a bounded exit 0.
# It registers no tools, no prompt sections, and writes no state.
- insert:
    - id: m1d-probe
      name: dsh-m1d-probe
```

`lib/index.mjs`：

```js
export const name = 'm1d-load-probe'
export const inject = ['agentSwarm', 'tools', 'systemPrompt']

export async function apply(ctx) {
  const assembly = await ctx.systemPrompt.assemble({})
  const toolNames = assembly.tools.map(tool => tool.name)
  const swarmTools = toolNames.filter(name => name.startsWith('agent_swarm_')).sort()
  const section = assembly.sections.find(entry => entry.name === 'agent-swarm:usage')
  const evidence = {
    probe: 'm1d-profile-assembly-load-evidence',
    agentSwarmServicePresent: ctx.get('agentSwarm') !== undefined,
    totalToolCount: toolNames.length,
    agentSwarmToolCount: swarmTools.length,
    agentSwarmToolNames: swarmTools,
    promptSectionNames: assembly.sections.map(entry => entry.name),
    agentSwarmSectionPresent: section !== undefined,
    agentSwarmSectionExcerpt: section === undefined ? null : section.text.slice(0, 160),
  }
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
  const exit = ctx.get('appExit')
  if (typeof exit === 'function') exit(0)
  else process.exit(0)
}
```

探针只经官方 seam 读状态（`ctx.systemPrompt.assemble()`、`ctx.get()`）并退出，不注册工具/节、不写任何状态；不改变被测插件行为。原始命令输出（含完整 `--dump-config` 转储）存于 `C:/Users/windo/AppData/Local/Temp/m1d-check/evidence/`（01–18 号文件，临时证据区，随系统清理销毁；报告已内嵌全部关键节选）。

## 7. 双环境结论表

| # | 验收项（issue #37） | 主环境（官方纯净 rc.8） | 第二环境（DEV-DSH-BOOT-001 rc.8） |
|---|---|---|---|
| 1 | CLI 版本 | 0.1.0-rc.8 | 0.1.0-rc.8 |
| 2 | 隔离 Profile 一次装配成功 | `plugin add -w link:` 退出 0；bundles 对账含 `dsh-agent-swarm` | 同左（退出 0） |
| 3 | 完整存储栈组合（hub+json KV+domain 路由+session persistence，root 在工作区/sandbox 之外） | `--dump-config` 退出 0，四类行齐备、root 全部隔离 | 同左（root 为 env2 隔离目录） |
| 4 | 真实 boot 加载 | 无 fatal 存活；storage root 被域打开重建 | 探针 boot 退出 0；storage root 重建 |
| 5 | 工具注册 | `agentSwarmToolCount: 16`，名称与 `src/tools.ts` 一致 | 同左（逐字段一致） |
| 6 | systemPrompt 节 | `agent-swarm:usage` 在组装结果中（order 118，文本一致） | 同左 |
| 7 | fail-closed 裁剪 A（缺 storageDomain） | boot 退出 1：`dsh-agent-swarm: pending (waiting for service: storageDomain)` | 同左（抽查，退出 1 同文） |
| 8 | fail-closed 裁剪 B（缺 sessionPersistence） | boot 退出 1：`dsh-agent-swarm: pending (waiting for service: sessionPersistence)`（连带官方 checkpoint-policy pending，§8.3） | —（未重复，主环境已复证） |
| 9 | 插件缺陷 | **未发现** | **未发现** |

## 8. 发现的缺陷与观察（不擅改；立案建议归 PM）

### 8.1 环境/上游发现：pnpm 9 下 `dsh plugin add` 需要 `-w`（非插件缺陷）

现象：按 README/docs 官方句式 `dsh plugin --profile X add link:<path>` 在 pnpm `9.15.9` 下失败：

```
ERR_PNPM_ADDING_TO_ROOT  Running this command will add the dependency to the workspace root, ... run this command again with the -w flag
```

定位：CLI 的 `initProfile` 模板 `PROFILE_PNPM_WORKSPACE` 写入 `packages:\n  - .`，pnpm 9 据此把 Profile 目录视为 workspace 根并拒绝无 `-w` 的 `add`；CLI 将参数原样转发给 pnpm（`runPlugin`），追加 `-w` 即成功（本报告全部装配即用此法）。版本谱系实测：pnpm `9.15.9` 失败；`10.34.5` 与 `11.7.0`（两个 rc.8 checkout 的 `packageManager` pin）均无需 `-w` 成功。归属：上游 CLI/pnpm 版本交互（机器默认 pnpm 9 旧于官方 pin），不是插件缺陷。建议：可立案一个小 issue 在 README「开发与验证」为 pnpm 9 用户补一句 `add -w` 备注（或提上游），由 PM 决定。

### 8.2 观察：`--dump-config` 不求值 `!!js`（官方设计）

dump 中被禁用行的缺省 config 渲染为 `root: !!js dshHomePath('sessions')` 原文——`runDumpConfig` 明确不 boot、不求值 `!!js`，属官方设计而非缺陷；判读 dump 时以 patch 后行集合为准。

### 8.3 观察：裁剪 B 的连带 pending（预期语义）

禁用 `session-persistence-jsonl` 同时使官方 `@deepseek-ai/dsh-session-checkpoint-policy` pending（它同样注入 `sessionPersistence`）。这不是本插件引入的退化，反而与 fail-closed 语义一致：缺持久化的组合整树拒绝激活。

## 9. 仓库影响

本变更仅为本证据报告（docs-only）；不触碰 `src/`、`ref/`、`docs/reviews/`、`docs/GOALS.md`、Skill。`pnpm verify` 全链（结构/lint/重复/死导出/双类型检查/测试/构建/产物校验）在 worktree 实测 exit 0（见 PR CI）。

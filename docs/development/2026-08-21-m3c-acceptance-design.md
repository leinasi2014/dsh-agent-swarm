# M3-3 design note — 候选验收 Profile 分离 + 外部晋升/回滚（issue #102 预研，零实现）

- 状态：**设计注记（docs-only，零代码零脚本变更）**。实现泳道等 #100（PR#106 执行根）、#101（PR#103 可执行审查）、#105（PR#109 release-anchored Gate A）合并后另行委派；本文件是其输入，不是实现。
- 日期：2026-08-21。委派：项目管理工程师（PM）→ 调研智能体（本会话）。
- 证据基线：
  - 官方 DSH rc.8 本地 checkout `D:\Source\DSH\framework\deepseek-harness-rc8-full`（`141eb6f` 世系，只读，本次逐文件复核；引用省略 `packages/` 前缀时的官方源以相对路径标注）；
  - 本仓 `main @ fe4d769`；
  - 官方 Profile/`--profile` 活体核验记录：`D:\Source\dsh-canvas\docs\notes\w4b1-s1-verification.md`（canvas W4b-1，跨仓证据，形态参考）；
  - 本仓 M1D 装配/重载实证：`docs/development/2026-08-20-m1d1-profile-assembly.md`（下称 M1D-1）、`docs/development/2026-08-21-m1d-exit-report.md` §4（D1 约束）；
  - #100/#101 的能力面**以 PR#106/PR#103 正文声明为准**，本设计不预设其合并冲突细节与最终形态。
- 上位文档：`docs/adr/0008-self-hosting-dogfood-control-plane.md`（四权分立原文）、`docs/13-self-hosting-dogfood.md`（D2 required 清单与候选生命周期）、`docs/04-core-protocol.md` §5（审查事务的 freeze 步）、`docs/07-implementation-roadmap.md` M3 exit、CONTRIBUTING §2a（worktree 隔离实践——我们自己就是 D2 隔离纪律的人工先例）。

## 0. 范围与非目标

**范围**：D2 前置之三的控制面设计——候选工件面、验收 Profile 拓扑、外部晋升/回滚机制、端到端演练设计、ADR-0008 对照检查表、开放问题清单。

**非目标**：不写任何脚本/代码；不修改 `docs/reviews/`、`docs/GOALS.md`、`.agents/`、swarm 主仓与任何 ref checkout；不裁决 #100/#101 的实现归属或合并顺序；不宣称 D2 开放（开放宣言以 issue #102 验收 + 独立审查为准）。

## 1. 候选工件面

### 1.1 工件形态三选一论证（判定：**包 tarball**）

判据来自 ADR-0008 决策 5/6、docs/13 §3 D2「frozen commit and package artifact digest before verification」与宪法红线 14（绝不 mutable-link 运行中稳定 Profile）：

| 形态 | 冻结性 | 官方 seam 证据 | 判定 |
|---|---|---|---|
| **git ref**（`add github:<repo>#<sha>`） | 差：git 规格安装触发包内 `prepare` 构建脚本，**装入验收 Profile 的字节是安装时构建的**，不是提交时冻结的——能记 commit SHA，不能记「实际加载字节」的 digest | `apps/cli/src/plugin.ts` `reconcilePlugins` 注释明示 git/path/tarball/alias 规格均按真实包名对账（能力上可行） | **否**，另有两点硬伤：私有仓需把 git 凭据引入验收环境（安全边界要求验收面只收工件不收凭据）；验收引入网络依赖 |
| **lib 构建产物**（目录 + `link:` / 目录复制） | `link:` 就是 mutable link——宪法红线 14 的字面命中；目录复制无内容寻址纪律，复制体仍可被构建者改写、装入字节无法与冻结点绑定 | 同上（path 规格官方支持） | **否**。M1D-1/D1 dogfood 用 `link:` 合法，因为那是**开发态**装配验证；D2 验收面是**晋升证据**，纪律必须升级 |
| **包 tarball**（`pnpm pack` 产物，SHA-256 记录于冻结 manifest） | 好：字节冻结于冻结时点；digest 是全链（manifest → 验收证据 → 晋升台账）的流通货币，promoter 安装前重哈希复核 | `plugin add` 是 pnpm 转发器，官方 `reconcilePlugins` 显式按 tarball 的真实包名对账（`apps/cli/src/plugin.ts` 注释原文 "a git/path/tarball/alias spec on the command line reconciles by its true package name"）；M1D-1 已实证 `plugin add` 全流程 | **采用** |

tarball 形态的三个附加论证：

1. **与 LKG 载体同构**：晋升动作的客体本来就是一份字节（见 §3.2），tarball 即晋升货币本体，链路上没有形态转换。
2. **离线安装**：验收 Profile 组装不需网络与凭据，验收环境最小化。
3. **已有产物门可复用**：`scripts/verify-package-artifact.mjs` 已校验 packed entry 形状（main/types/exports/patch 存在 + `apply`/`name`/`AgentSwarmRuntime`/`TeamId` 可导入），冻结步骤直接以它为门。

**随判定申报的两个 caveat**（开放问题 OQ-1/OQ-2，见 §6）：

- `package.json` 的 `postinstall: lefthook install` 会随 tarball 分发；pnpm ≤9 默认执行依赖包生命周期脚本（lefthook 在非 git 的 Profile 目录中的行为待实测），rc.8 两个 checkout 均pin pnpm 11（脚本需 `onlyBuiltDependencies` 审批，预期不执行）。实现泳道必须实测并登记结论。
- 包版本恒为 `0.1.0`，同名同版本 tarball 的重复 `add` 的解析/缓存行为需实测；缓解：验收每代全新 DSH_HOME（§2.1，无缓存碰撞面），稳定 Profile 用 remove+add（§3.1）。

### 1.2 候选从哪来（判定：**PM 侧冻结泳道构建**，执行根内构建为 D1 级降级选项）

先立一个不可回避的事实：**tarball 重建不具字节可复现性**（打包条目携带 mtime 等非源内容），因此「worker 自建 tarball 的 digest」与「PM 重建 tarball 的 digest」不可能相等——**完整性锚必须是 git commit SHA（内容寻址、可复现），tarball digest 只是工件身份（构建一次、全链一致）**。由此推论构建位置：

| 方案 | 描述 | 问题 |
|---|---|---|
| A. 执行根内构建 | worker 在自己的 per-attempt 执行根（#100/PR#106 声明的 worktree）内 `pnpm build && pnpm pack`，提交面携带 tarball | 无法证明「tarball ≡ commit」：威胁模型上 worker 可在打包时夹带未提交字节（M3-2 已证明被审方可伪造 verdict 文本，同理可伪造工件）；且 #100 声明的持有规则在 submit 即释放执行根，工件必须先于释放离根 |
| B. **冻结泳道构建**（采用） | 外部冻结步骤（PM 侧，运行于稳定 main checkout 的一个干净 worktree——CONTRIBUTING §2a 的标准 worktree 实践）检出冻结 commit → `pnpm build && pnpm pack` → 计算 digest → 写 manifest → 复制（绝不 link）到控制根 `candidates/` | 构建者与候选运行时分离，直接对应 ADR-0008 决策 6「状态机 owned outside the candidate runtime」与 docs/13 §8「controller not loaded from the candidate artifact」；构建可复现性锚在 commit SHA |

与 docs/04 §5 审查事务的关系：§5 的序列是「freeze or snapshot → execute deterministic checks」——冻结先于确定性检查。#101（PR#103）的审查根验证命令跑在**提交的源**上（行为验证）；本设计的冻结泳道产出**工件**（装配验证的输入）。两面互补：审查验证行为，验收验证工件与组合，共同构成晋升证据（§2.3 runbook 把两面串起来）。

**降级声明**：D1 单写入者 dogfood 期间允许方案 A（构建者=唯一 writer，纪律补足机制，manifest 如实记录 `builtBy: writer@<session>`）；D2 并行自我开发必须方案 B。

### 1.3 冻结记录（candidate manifest，字段契约）

`candidates/<candidateId>/manifest.json`（实现泳道落为 JSON schema）：

| 字段 | 说明 |
|---|---|
| `schemaVersion` | 契约版本 |
| `candidateId` | 本地唯一（建议 `<date>-<short-sha>-<seq>`） |
| `gitCommit` / `gitTree` | 冻结 commit 与 tree SHA（完整性锚） |
| `tarballSha256` / `tarballBytes` | 工件身份（构建一次后全链只读此值） |
| `builtBy` | 构建身份：`freeze-lane@stable-main-<SHA>` 或 D1 降级的 `writer@<session>` |
| `builtAt` / `buildCommand` | 时间戳与确切命令（可重放叙述） |
| `packageVersion` / `peerPins` | `0.1.0` 与官方 peer 依赖版本（对齐 OFFICIAL_BASELINE） |
| `acceptanceFloor` | 本次验收采用的 verify 子集声明（§2.3） |
| `reviewRef` | M3-2 审查证据引用（task id + diagnostic digest） |

## 2. 验收 Profile 拓扑

### 2.1 目录布局（dogfood 控制根）

引入**控制根**（dogfood control root）：仓库与 `~/.dsh` 之外的专用目录（建议同盘短路径，例如 `D:\Source\DSH\dogfood\dsh-agent-swarm\`；最终路径由 PM 在实现泳道固定并记入演练证据）。四权在目录层面物理分离：

```text
<dogfood-root>/
  control/                          # ① 稳定控制面（last-known-good）
    home/                           #    稳定 DSH_HOME（其 profiles/control 装配 LKG tarball）
    storage-root/                   #    稳定 Team 权威存储（TeamDomainPort 单权威）
    sessions-root/
  lkg/                              # ② last-known-good 载体（§3.2）
    g<N>/dsh-agent-swarm.tgz        #    每代一个不可变目录：tarball + lkg.json
    lkg.json                        #    currentGen 数字指针（纯文件，无符号链接）
  candidates/<candidateId>/         # ③ 冻结工件暂存（worker 写根之外；ADR-0008 安全边界）
  drills/<date>-<slug>/             # ④ 验收域（每代全新）
    home/                           #    验收 DSH_HOME（含 profiles/<accept-name>）
    storage-root/  sessions-root/   #    验收存储根（用后即弃，证据另行导出）
    workspace/                      #    验收 dogfood 任务的 scratch 工作区
    evidence/                       #    证据链产物（§4 清单）
  ledger/promotion-ledger.jsonl     #    晋升/回滚台账（追加式，§3.1）
```

要点：

- **绝不触碰 `~/.dsh`**（M1D exit §4 D1 约束原文延续；M1D-1 §1 的隔离纪律照抄到两个 home）。
- **验收 home 每代新建**（`drills/<…>/home`）：官方 Profile 名校验是平坦名（`resolveProfileDir` 拒绝 `/`、`\`、`.`、`..`、`node_modules`），固定名 `agent-swarm-acceptance` 配每代新 home 即无状态穿透、无 pnpm 缓存碰撞（OQ-2 缓解）；重装成本秒级（pnpm store 硬链接，M1D-1 §3.1 实证 364ms）。
- 控制根整体位于一切 Worker 写根之外：#100 的执行根布局 `executionRootsBase/<scopeHash>/…`（PR#106 声明）默认在平台临时目录分区，与 `<dogfood-root>` 不相交；Promoter/冻结泳道以 PM 会话身份持有写权。

### 2.2 验收 Profile 的组合与候选注入（红线 14 合规论证）

**模板选择**：验收需要「验收 RPC/状态面」（issue #102 第 2 条）。官方三个组合层级（`packages/boot/app-boot/src/profile.ts:114-118`）：

- `web` 模板 = `dsh-base + dsh-web-app`：自带 apiproxy HTTP 面（canvas W4b-1 已活体验证 `POST /api/session.create|prompt|history` 全通）与存储栈（`packages/bundle/web-app/cordis.patch.yml` 自带 storage/storage-json/storage-domain，root 缺省在 DSH_HOME 下＝演练域内）；
- `headless` 模板 = `dsh-base + dsh-headless`：官方 patch 注释明示「mounts no Host, HTTP server, Web runtime」——**无 RPC 面**，不适合验收；
- 无模板自定义名 = 仅 `dsh-base`（`DEFAULT_PROFILE_BUNDLES`）：可作纯装配/探针面（M1D-1 正是此形态）。

**判定**：验收 Profile 用 **web 模板 + 候选 tarball + 存储根显式覆盖**——存储根仍按 M1D-1 §3.2 的 patch 形态显式指到 `drills/<…>/storage-root|sessions-root`，虽然缺省 root 已在演练 home 内，但显式化让证据布局可读且与 README 部署纪律同构。

**注入序列**（命令形态，实现泳道脚本化）：

```sh
DSH_HOME=<dogfood-root>/drills/<d>/home
node <CLI> --version                                   # rc.8 世系断言
node <CLI> plugin --profile agent-swarm-acceptance add -w <candidates>/<id>/dsh-agent-swarm.tgz
#  pnpm 9 需 -w（M1D-1 §8.1 实证）；rc.8 checkout pin pnpm 11 无需
#  写 drills/<d>/home/profiles/agent-swarm-acceptance/cordis.patch.yml（存储根覆盖，M1D-1 §3.2 形态）
node <CLI> --profile agent-swarm-acceptance --dump-config   # 层序 + fail-closed 必需行证据
node <CLI> --profile agent-swarm-acceptance --host 127.0.0.1 --port <验收端口>   # RPC 面
```

**红线 14 逐点对照**：

| 红线动作 | 本设计的反面机制 |
|---|---|
| 覆盖运行中稳定 Profile | 验收与稳定是不同 DSH_HOME、不同 profile 目录、不同 node_modules；安装动作只发生在演练 home 内 |
| mutable-link 运行中稳定 Profile | 候选以 tarball 经 pnpm 物化复制进验收 home（官方 plugin.ts 转发 pnpm 安装）；全链无 `link:`/`junction`/符号链接（Windows 权限与红线双重理由）；`lkg.json` 用数字代际指针而非链接 |
| 热加载自测候选 | 验收进程独立端口独立生命周期；稳定 Profile 在验收全程不重启不重载（静默检查见 §3.1） |
| 候选写控制存储 | 验收存储根在演练域内，与 `control/storage-root` 物理分离；即使候选全权写盘也只写演练域 |

**fail-closed 复证**：沿用 M1D-1 §4 的裁剪组合（缺 `storage-domain` / 禁 `session-persistence-jsonl` → boot 退出 1、`dsh-agent-swarm: pending`）作为验收 runbook 的负路径探针（§2.3 A3）。

### 2.3 验收跑什么（runbook A0–A7）

issue #102 要求「验收 Profile 内跑受控验收（verify 链或其子集），结果为晋升证据」。设计上把验收拆成**源级、工件级、组合级**三层，全部产物进 `drills/<…>/evidence/`：

| 步 | 内容 | 面与依据 |
|---|---|---|
| A0 | 前置：manifest 完整、tarball digest 复核、验收 home 为全新空目录 | 冻结纪律 |
| A1 | **源级 floor verify**：在冻结 commit 的隔离验证根执行 verify 链子集 | 验证命令根复用 #101（PR#103）声明的 ReviewRootProvider 族形态；floor 选型见下 |
| A2 | **工件级**：tarball sha256 复核 + 对 packed entry 跑 `verify:artifact` 语义门 | `scripts/verify-package-artifact.mjs` 已有形状 |
| A3 | **装配**：plugin add → `--dump-config` 证据 + fail-closed 负路径探针（一次即可） | M1D-1 §3/§4 模式 |
| A4 | **boot + 加载**：boot 存活/退出码 + 只读探针 bundle（M1D-1 §6 探针：工具注册数、`agent-swarm:usage` 节、agentSwarm 服务在场） | M1D-1 §3.5 模式 |
| A5 | **RPC 健康 + 受控 dogfood**：`host.describe` → `session.create/prompt/history` 微回路；然后验收 Profile 内建 1 captain + 1 worker + 1 任务，任务带冻结 verification 命令（#101 面）在 scratch 工作区跑一个小确定性检查，断言 review diagnostic 全由根产证据构成、`submitted` 停驻后经 captain 落定 | RPC 面 W4b-1 已验；审查事务语义 PR#103 已测 |
| A6 | **reload/recovery/teardown 子集**：验收 Profile 重载后存储根一致性 + 有界关停（M1D-2 面在验收域复证一次） | M1D-2 验收面 |
| A7 | **verdict**：`acceptance-verdict.json`（gate 列表逐项 pass/fail + 各证据文件 sha256 + run 元数据） | 晋升输入（§3.1 只认此文件） |

**A1 verify 子集选型论证**。全链 = `structure → lint → duplication → exports → typecheck → typecheck:test → test → build → artifact`（docs/08 §9）：

- **不可降级 floor**：`typecheck`（类型即对外契约，artifact 携带 .d.ts）、`typecheck:test`、`test`（行为证据）、`verify:scenarios`（场景审计双向等值——防「验收通过的子集恰好漏掉被删场景」）、`build`、`verify:artifact`（工件完整性）。
- **可降级**：`lint`/`duplication`/`exports`/`structure`——仓库卫生门，已被 CI 与 pre-commit 常态门禁，不是候选**行为**证据；验收 lane 若重跑它们，成本重复而边际证据为零。
- **首演全链**：第一次端到端演练（§4）跑全链 `pnpm verify`，以最保守子集（全集）立基线；此后按 floor 执行，降级决定记入 manifest `acceptanceFloor`（可审计）。

**端口与进程纪律**：验收端口与稳定控制端口从两个不相交的分配池取（docs/07 M3 exit 把「port conflicts」列为故障测试面）；演练收尾断言进程零残留（W4b-1 §3 的 `Win32_Process` 计数法）。

## 3. 外部晋升/回滚机制

### 3.1 晋升状态机与外部 promoter 契约（设计，零代码）

状态机沿用 docs/13 §4（`built → frozen → verified → acceptance-booted → accepted → promoted | rejected`），本设计把每态落到载体：

| 态 | 载体 | 生产者 |
|---|---|---|
| built | `candidates/<id>/` tarball + manifest | 冻结泳道（§1.2 B） |
| frozen | manifest 的 digest 复核通过（A0） | promoter `freeze` |
| verified | A1–A2 证据 | 验收 lane（在隔离验证根内执行，非候选进程） |
| acceptance-booted | A3–A6 证据 | 验收 lane |
| accepted | `acceptance-verdict.json` 全过 | 验收 lane（只出证据，**无晋升动词**） |
| promoted | `lkg/g<N>/` + 台账记录 | **promoter `promote`**（PM 会话执行） |
| rejected | 工件与证据原样保留 + 转 corrective task（docs/13 §5：观察到的失败成为 Lead 所属新任务） | 任一 gate 失败即入 |

**promoter 形态**：运行于**稳定 main checkout** 的外部脚本（实现归实现泳道；命名建议 `scripts/promote-candidate.mjs`——本设计只定契约）。宪法依据：docs/13 §8「Automation may later perform the mechanical switch only … from a controller that is not loaded from the candidate artifact」；首版由 PM 手动执行同效。子命令契约：

| 子命令 | 输入 | 动作 | 拒绝条件（fail-loud） |
|---|---|---|---|
| `freeze` | commit ref | 冻结泳道构建 + manifest（§1.3） | 工作树脏、构建失败、digest 缺失 |
| `accept-check` | verdict + manifest | 复核每 gate 证据 digest 与 manifest 一致 | 任一 gate fail/缺证据/digest 不符 |
| `promote` | verdict + manifest | 静默检查 → 稳定 Profile remove+add 新 tarball → 写 `lkg/g<N>` → 台账追加 → 稳定重启健康探针 | 静默检查不过、`lkg.json` currentGen 与台账不符（代际 fencing）、健康探针失败（触发自动回滚预案） |
| `rollback` | 目标代（默认 prev） | §3.3 | 目标代目录不完整 |
| `status` | — | 打印 currentGen、台账尾记录、各域健康 | — |

**静默前置检查（quiesce）**——晋升是阶段边界动作（ADR-0008 决策 8），三个判据全过才动手：稳定 `agent_swarm` 域内无 active Team（读 `control/storage-root/agent_swarm.json` 权威面）；无持续活跃 RPC 会话（ops skill 教训 13/33 的判据：`~/.dsh/sessions/--D-Source--/` mtime 二次轮询 2 分钟无刷新）；稳定 DSH 进程不在运行（进程表）。任一不过即拒绝并报告（不等待、不强杀）。

**晋升序列**（外部、非候选自决）：`quiesce → 复核 → pnpm remove + add 新 tarball（规避同名同版本重装解析坑，OQ-2）→ 复制 tarball 至 lkg/g<N>/ + lkg.json{currentGen=N, prev=N-1, digests, verdictRef} → 台账追加 → 稳定 Profile 重启 → 健康探针（boot + dump-config + RPC describe）→ 失败即 rollback`。

**写权限边界**：`lkg/`、`ledger/`、`control/` 仅 PM 会话身份可写；任何 Team 成员与候选进程的执行根（#100 布局）与之不相交；Windows 下以目录归属纪律承担（不依赖 ACL 产品化——开放问题 OQ-5 记自动化）。

### 3.2 last-known-good 载体三选一论证（判定：**目录快照**，tag 作谱系补充，branch 否决）

| 载体 | 论证 |
|---|---|
| **git tag**（如 `lkg/g<N>` annotated） | 谱系优秀：annotated tag 不可变（除非显式 force）、携带元数据、本地可用。但**操作面不能直接消费**：`plugin add <git spec>` 会触发安装时构建（§1.1 已否决），tag → 可安装工件必须再经冻结泳道——即 tag 无法独任载体 |
| **git branch** | **否决**：可变是 branch 的本性；私有免费仓无分支保护（ops skill 教训 11：ruleset 403 实证，保护暂靠纪律）——给候选留了一个可 push 的目标面，恰与「外部晋升」的方向相反 |
| **目录快照**（`lkg/g<N>/` = tarball + lkg.json，数字代际指针） | **采用**：操作面就是晋升货币本体（回滚 = 重装 prev 目录的 tarball + 重启，无需任何构建/git 操作）；Windows 天然无符号链接需求；不可变性 = 目录一次写入后只读 + lkg.json 指针链（g_N 记 prev）+ 台账交叉引用；保留策略有界（默认保 3 代，磁盘上限入 OQ-7） |

**谱系补充（推荐非必需）**：每次晋升打本地 annotated tag `lkg/g<N>`，消息体记 manifest 摘要——把目录快照锚回 git 历史，防「控制根目录被误删/漂移」的谱系断裂；是否推远端属 OQ-11（涉及凭据面）。

### 3.3 回滚路径

触发面（任一）：稳定健康探针失败；PM 观察清单（docs/13 §5）发现控制面退化；用户显式指令。

```text
rollback(g_prev):
  quiesce（同晋升前置）
  → 完整性校验 lkg/g<prev>/（tarball digest 与 lkg.json 一致）
  → 稳定 Profile remove + add g<prev> tarball
  → lkg.json currentGen 回拨（prev 链不动，历史代不删）
  → 台账追加 rollback 记录（from/to/digest/原因）
  → 稳定重启 + 健康复探针（boot/dump-config/RPC describe）
  → 失败代目录转 evidence 归档（rejected 同款：不可变证据，转 corrective task）
```

演练断言（§4 P5）：回滚后稳定 boot 探针绿、RPC 健康绿、`agent_swarm` 域可读且与回滚前快照一致（回滚不丢稳定面 Team 状态——稳定存储根从未被动过，这是四权分离的红利）。

## 4. 端到端演练设计（一次受控 dogfood 的分步清单）

场景：对真实 main 做一个小型真实变更（或 PM 指定的合成变更），走完整「构建 → 验收 → 晋升 → 失败注入 → 回滚」。全程产物入 `drills/<date>-m3c/evidence/`。

| 阶段 | 步骤 | 通过断言 | 证据产物 |
|---|---|---|---|
| **P0 预备** | 建控制根布局；以当前 main 冻结首代 `lkg/g0`（走 §1.2 B 全流程，把「现状」确立为 last-known-good）；稳定 Profile 以 g0 组装启动 | g0 健康探针绿 | 布局清单、g0 manifest、稳定健康证据 |
| **P1 候选构建** | 冻结泳道：干净 worktree 检出候选 commit → build/pack → manifest → `candidates/<id>/` | digest 复核过；worktree 无脏字节 | manifest、构建日志、worktree `git status` 证据 |
| **P2 验收** | runbook A0–A7 全走（首演 A1 跑全链 `pnpm verify`） | verdict 全过 | verdict、dump-config、探针 JSON、RPC 回路记录、dogfood 任务诊断、reload/recovery 记录 |
| **P3 外部晋升** | promoter `promote`（含 quiesce） | `lkg/g1` 落盘、台账 2 条（g0 建立 + g1 晋升）、稳定重启健康绿 | 台账、lkg.json、健康探针 |
| **P4 失败注入**（两型，均只发生在演练域/测试代，不碰 g0/g1 谱系） | (a) **验收拒绝型**：冻结一个故意带缺陷的候选（verification 命令必败，如改一处使 floor 测试红）→ 验收 A1/A5 必须抓住 → rejected 证据保留；(b) **晋升后存活型**：走一轮针对**演练专用稳定副本**的 promote，注入方式 = 健康探针面对坏工件失败（prebuilt 损坏 tarball 走 promote 直到探针步失败，或直接以损坏副本触发探针） | (a) verdict fail + rejected 态 + 稳定面零扰动（stable 仍 g1 健康绿）；(b) 探针红且自动回滚预案触发 | 注入记录（注入点/预期/实际）、rejected 证据、探针失败记录 |
| **P5 回滚** | promoter `rollback`（目标 = 真实演练的 prev 代） | 稳定恢复健康；currentGen 回拨；台账 rollback 记录；失败代工件完整保留 | 台账、健康复探针、失败代归档清单 |
| **P6 证据链打包** | 对 `evidence/` 逐文件 sha256 汇总 | 清单与文件一一对应 | evidence-manifest.json |
| **P7 收尾** | 进程零残留断言（Win32_Process 计数）、演练域清理（保留 evidence/ 与台账）、演练报告（引用本设计，交 #102 实现泳道与独立审查） | 计数 0、端口无监听 | 残留断言记录、演练报告 |

**证据链产物清单**（P6 汇总的目标集合）：候选 manifest（commit/tree/tarball digest/builtBy）→ A1 floor（或全链）verify 日志与退出码 → A2 工件复核 → A3 dump-config 与 fail-closed 负路径 → A4 探针 JSON → A5 RPC 回路 + dogfood 诊断（根产证据）→ A6 reload/recovery 记录 → A7 verdict → 晋升台账条目（g0/g1/rollback）→ lkg.json 链 → 注入与回滚记录 → 健康探针（每态一份）。

## 5. ADR-0008 对照检查表

### 5.1 ADR-0008 决策与边界逐条

| ADR-0008 条款 | 本设计对应 | 演练证据位 |
|---|---|---|
| 决策 5：稳定控制跑 last-known-good；冻结候选装入**独立**验收 Profile + 独立 RPC；绝不覆盖/mutable-link/热重载 | §2.1 控制根四域分离；§2.2 红线 14 对照表；LKG=目录快照（§3.2） | P0/P3 布局与台账、dump-config 双 Profile 身份差异 |
| 决策 6：晋升状态机 owned outside candidate runtime；失败保稳定工件并转为新 Team 任务 | §3.1 状态机载体表（promoter 独占 promoted/rejected 转移）；P4(a) rejected → corrective task | 台账、rejected 证据、 corrective task 引用 |
| 决策 7：Team/任务/attempt 权威只在 `TeamDomainPort`；验收报告是投影/证据 | 验收域独立存储根，verdict 是纯证据文件；候选无控制存储写路径（§2.2 对照） | verdict、验收域存储快照 |
| 决策 8：PM 观察持久状态，只在阶段边界干预 | §3.1 quiesce 三判据；晋升/回滚均为边界动作 | quiesce 检查记录 |
| Security boundary：稳定 runtime/存储/凭据/ref checkout/晋升元数据在 Worker 写根外；验收 Profile 只收候选工件与专用临时状态；候选不能自宣告接受或改稳定指针 | §2.1 控制根外置；§1.1 tarball（无凭据面）；§3.1 写权限边界；A7 verdict 无晋升动词 | 布局清单、promoter 拒绝条件演示 |
| Readiness 表 D2 行（frozen candidate acceptance and rollback） | 本设计全部 + #100/#101 供给 | 演练全记录 |
| 宪法红线 14（AGENTS.md） | §2.2 逐点对照表 | 同决策 5 |

### 5.2 docs/13 §3 D2 required 清单逐项归属

| D2 要求 | 归属 |
|---|---|
| Workflow/Jobs 单转移 owner、durable run id、取消与完成披露 | M2 已交付（#75/#76/#77） |
| 每 attempt 一个不可变基线修订 + 唯一 branch/Worktree/lease | #100（PR#106 声明：detached worktree + attemptId 围栏 + `.dsh-execution-root.json`） |
| 进程外执行的实际 cwd/文件/shell 根 = lease | #100 声明的边界：prompt 级声明 + 部署 sandbox 根（硬围栏遗留面，OQ 归 #100 泳道） |
| command/check + 独立 Reviewer Provider，canonical completion 不可绕过 | #101（PR#103 声明：冻结 verification 元数据 + 审查根 + floor-not-ceiling） |
| 冻结 commit 与包工件 digest 先于验证 | 本设计 §1（manifest 是 digest 流通起点） |
| 独立验收 Profile/端口/状态根 + 健康检查 + 确定性回滚 | 本设计 §2/§3 |
| merge queue 串行化晋升、拒绝陈旧 attempt/lease 代际 | 仓库层已有 merge-guard 串行合并；晋升层 = 台账 + `lkg.json` 代际 fencing（promoter 拒绝条件） |
| 结构化诊断脱敏凭据、关联 Team/task/run id | #101 证据面 + 本设计 verdict/台账字段（diagnostic 携带溯源行） |

## 6. 风险与开放问题（留给实现泳道的决策点）

| # | 问题 | 备注 |
|---|---|---|
| OQ-1 | tarball `postinstall: lefthook install` 在 pnpm 9（默认跑脚本）与 pnpm 11（需 onlyBuiltDependencies 审批）下于 Profile 目录的实际行为 | 实测定论；必要时冻结泳道登记 onlyBuiltDependencies 决策或上游提议打包面拆 dev 脚本 |
| OQ-2 | 同名同版本 tarball 重复 `add` 的解析/缓存行为 | 缓解已内置（验收每代新 home；稳定面 remove+add）；实测确认后写死进 promoter |
| OQ-3 | 冻结泳道（§1.2 B）与 #101 已声明的「候选工件检入审查根」（worker 侧面）的一致性衔接 | 工件一致性锚 = commit SHA；两面 digest 不等（mtime）是事实，衔接协议由实现泳道定 |
| OQ-4 | 验收 RPC 端口分配策略与 web 模板 `--no-open`（浏览器标签问题，canvas W4b-1 §4.2.6 遗 PM 裁决） | 首版可手选固定端口 + 显式 `--no-open`（若官方旗标可用） |
| OQ-5 | quiesce 三判据的实现面（存储读 / RPC 探测 / 进程表）与自动化程度 | 首版 promoter 手动执行 + 判据打印；自动化属后续 |
| OQ-6 | 验收 dogfood 任务（A5）的 scratch 工作区产生方式与保留策略 | 建议 drills 域内临时 clone，用后即弃 |
| OQ-7 | LKG 保留代数与磁盘上限 | 建议默认 3 代（含 current）；超限代转归档需台账记录 |
| OQ-8 | Windows 长路径与进程树击杀 | 控制根路径长度预算；杀树沿用 #101 的 `taskkill /T /F` 先例；清理沿用 ops 教训 27（MSYS rm -rf + worktree prune） |
| OQ-9 | 演练是否新增 docs/08 场景行（预计实现泳道补「验收拒绝」「晋升后回滚」两行入场景审计） | 场景审计双向等值门会强制 |
| OQ-10 | #105（PR#109）release-anchored Gate A 合并后，manifest `peerPins`/基线引用的更新责任 | 实现泳道开工首日核对 |
| OQ-11 | `lkg/g<N>` tag 是否推远端 | 推远端引入凭据/网络面；首版本地 tag 即可 |
| OQ-12 | 多候选并行验收 | 首版串行；并行需端口池与 drills 域命名空间化后再开 |

## 7. 仓库影响与验证

本变更为单一设计注记（docs-only）：零代码、零脚本、零配置变更；`docs/reviews/`、`docs/GOALS.md`、`.agents/`、`ref/`、swarm 主仓均未触碰。`node scripts/verify-project.mjs` 实测 PASS（见 PR）。#100/#101/#105 的合并顺序与冲突细节以各 PR 正文与 PM 合并时的语义并集裁决为准，本文件不预设。

# M1D-2 证据报告 — 真实 rc.8 Profile 上的重载/恢复/有界关停故障验证

- Report: 2026-08-20（M1D 第二项，实现工程师执行；issue #38，PM 委派）
- Plugin under test: worktree `D:\Source\DSH\plugin\dsh-agent-swarm-wt-m1d2`，分支 `test/m1d-reload-recovery`，基线 commit `82ad1a9`（M1D-1 证据合并后），`lib/` 构建产物就绪
- 任务性质：纯验证（取证），未修改 `src/`、`ref/`、`docs/reviews/`、`docs/GOALS.md`、Skill 与任何运行时行为
- 结论先行：**四项验收全部通过（重载无重复注册、重启恢复一致、有界关停、Windows 抽样）**；发现 1 项插件行为缺陷候选（D1，见 §7.1）、1 项官方 compose 行为观察（O1，见 §7.2）、2 项环境备注（§7.3）

## 1. 隔离与红线合规

所有 Profile 状态、存储根、会话根、探针与工作区均位于 `%TEMP%\m1d-check2`（独立于 #37 的 `%TEMP%\m1d-check`），通过官方 `DSH_HOME` 环境变量整体重定向，**从未触碰 `~/.dsh` 既有状态**（用户既有 `headless`/`web` profile 与默认状态零接触；一次命令行误初始化的空模板 profile `test-x` 已当场删除，`~/.dsh/profiles` 恢复原状）。杀进程仅限本报告自启的隔离 Profile 进程（`taskkill /F` 与 Node `SIGKILL`=TerminateProcess，二者均只作用于自启 PID；MSYS bash 的 `$!` 是 shim PID，实测不指向真实 node 进程，全部杀灭均先经 PowerShell `Get-CimInstance` 解析真实 PID 或由 node spawn 直接持有子进程句柄）。

| 用途 | 绝对路径（正斜杠形式供 Node） |
|---|---|
| DSH_HOME | `C:/Users/windo/AppData/Local/Temp/m1d-check2/home` |
| 存储根（按场景隔离，不共享） | `%TEMP%/m1d-check2/storage-{reload,restart,f3,f2,teardown,smoke,ident,diag,hmrt,long,deep,lock}` |
| 会话根（同上隔离） | `%TEMP%/m1d-check2/sessions-{...}` |
| 团队工作区（= captain cwd = scope） | `%TEMP%/m1d-check2/workspace-{...}` |
| 探针包 | `C:/Users/windo/AppData/Local/Temp/m1d-check2/probe/dsh-m1d2-probe` |

Profile 命名全部为全新 `agent-swarm-m1d-check2*`；本报告仅用 1 个 Profile `agent-swarm-m1d-check2-run`（bundles：`["@deepseek-ai/dsh-base","dsh-agent-swarm","dsh-m1d2-probe"]`），场景隔离由 `!!js` 环境参数化的存储/会话/工作区根实现（每场景独立根目录，绝不跨场景复用）。

运行时：Node `v24.18.0`，pnpm `9.15.9`（`plugin add -w` 备注 See M1D-1 §8.1），CLI `node D:/Source/DSH/framework/deepseek-harness-rc8-full/apps/cli/lib/bin.js`（`0.1.0-rc.8`）。工具执行全程 `DSH_PERMISSION_MODE=danger-full-access`（仅作用于隔离 Profile 进程）。

## 2. 组合与驱动方式（M1D-1 配方的扩展）

Profile `cordis.patch.yml`（核心行；root 经 `!!js` 按场景注入）：

```yaml
- insert:
    - id: storage
      name: '@deepseek-ai/dsh-storage'
    - id: storage-json
      name: '@deepseek-ai/dsh-storage-json'
      config:
        root: !!js process.env.M1D2_STORAGE_ROOT
    - id: storage-domain
      name: '@deepseek-ai/dsh-storage-domain'
      config:
        backend: json
- id: session-persistence-jsonl
  config:
    root: !!js process.env.M1D2_SESSIONS_ROOT
- id: agent-loop
  config:
    agents:
      - id: m1d2-captain
        sessionId: m1d2-captain        # 首启 create-or-restore
        cwd: !!js process.env.M1D2_WORKSPACE
        provider: mock
        model: mock                    # 二者必须同时提供（否则成员 turn 报 no provider/model）
```

驱动探针 `dsh-m1d2-probe`（验证辅助，不入库）：只经官方 seam 驱动与观察——`ctx.llm.registerAdapter(['mock'], adapter)`（脚本化 mock LLM，无凭据依赖）、`ctx.tools.execute`（真实工具层）、`ctx.subagents.registerProvider`（仅场景 3 注册永不 settle 的 continuable provider）、`ctx.systemPrompt.assemble`、`ctx.sessionPersistence.inspect`、`ctx.get('agentSwarm')`（运行时 host API）。探针刻意**不**静态 inject `agentSwarm`（fiber reload 不连带重启探针），且所有 reload 后访问都经服务访问器重新获取（旧 runtime 的 store 已关闭）。探针 `apply()` 决不 await 其他条目的 reload（loader 将树变更串行化在 pending apply 之后——见 §7.3 备注 B）。

崩溃窗口杀灭的确定性：探针以 3ms 间隔轮询权威 aggregate，在**耐久事实落盘的同一刻**（provisioning 行/message queued 行可见）打出 marker；node 驱动器在 marker 后 **1–5ms** 内 `SIGKILL`（实测杀灭滞后：F3 为 marker+5ms，F2 为 marker+1ms），保证杀点落在 [记录 commit .. 激活/ack commit] 窗口内。杀灭后先读原始存储文件取证再重启。

官方根会话恢复 seam：`agent-loop` 配置行的 `resumeSessionId`（显式恢复形态）——重启相第二阶段将 captain 行切换为 `resumeSessionId: m1d2-captain`，重启经官方 `resumeWith`（`persistence.prepare` → restore → publish）恢复 captain 全量历史（§7.2 记录 `sessionId` 形态在本组合下的差异）。

会话日志取证工具：官方 jsonl 后端将每批追加写为**独立拼接的 zstd frame**，Node `zstdDecompressSync` 只解第一帧——取证脚本按 zstd magic（`28 b5 2f fd`）逐帧解压再重放（含 `agent/inbox/spliced` 的插入/移除重放，与运行时 F2 折叠同一语义）。

## 3. 场景 1：插件 fiber reload 无重复注册 — 通过

路径：官方 HMR 用户层热重载（`apps/cli/src/profile-boot.ts` → `watchUserPatches`，base 的 `hmr` 行在本组合未激活服务，CLI 按"watch-only instance"回退挂载——探针 `ctx.get('hmr')` 实测 `HMR-SERVICE-ABSENT`，但 `cordis.patch.yml` 编辑仍实时生效，与该回退的文档语义一致）。overlay 追加 `- id: agent-swarm` 行将 `disposalTimeoutMs: 5000 → 3333`（整段 config 替换，官方语义）。

命令等价物（bash 驱动脚本 `driver/reload.sh` 原文节选）：

```sh
node "$CLI" --profile agent-swarm-m1d-check2-run &   # M1D2_MODE=reload-drive
# 探针：create team → add member → create task → send wakeup（delivered）
# marker RELOAD-READY 后：
printf '\n- id: agent-swarm\n  config: {..., disposalTimeoutMs: 3333}\n' >> "$PATCH"
# 等待 RELOAD-EVIDENCE；探针随后自行 appExit(0)
```

最终通过轮（t 单位 ms，epoch 尾数）：

```text
RELOAD-READY    t=…825697   （setup 完成态：member active、task in_progress、wakeup delivered）
overlay append  t=…8259xx
RELOAD-OBSERVED t=…825997   disposalTimeoutChanged:true  disposalTimeoutMs:3333
                 （runtime.config 值变化 = 新 fiber 已以新 config 重新 apply）
RELOAD-EVIDENCE t=…828257   wokenCopiesAtTarget:0（D1，见 §7.1）
                 postReloadCopiesAtTarget:1  （重载后的 runtime 投递恰好一次）
                 messages: woken=delivered, postReload=delivered
                 assembly: totalToolCount=41, agentSwarmToolCount=16, agentSwarmSectionCount=1
final rc=0（探针经官方 appExit 有界退出）
```

判读（三轮全一致，含一次复证轮）：

1. **工具数恒 16**：全程 `systemPrompt.assemble` 采样中 `agent_swarm_*` 工具从未超过 16、总数从未超过 41；交换瞬间出现过的唯一中间态是 `total=25/swarm=0/section=0`（旧注册先行卸载，与"重复注册"相反的方向）；重载完成后回到 41/16/1。
2. **systemPrompt 节唯一**：`agent-swarm:usage` 出现次数全程恒 1。
3. **行为证据（消息不双投）**：重载后经**新 runtime** 发送的 wakeup 消息在目标侧耐久会话日志中恰好 1 份（`user/message` 历史 1、pending inbox 0）；重载 recovery rescan 未把重载前已 delivered 的消息再投（§4 主样本另证）。
4. reload 生效的判定信号是 runtime config 值变化（`ctx.get` 每次调用返回新 proxy，对象恒等不是信号——实测 `sameTickStable:false`）。

附带证明（诊断轮）：无 team 状态的裸 Profile 上同一编辑在 ~250ms 内生效（5000→3333）。

## 4. 场景 2：进程重启恢复 — 通过（主样本 + F3/F2 崩溃窗口抽样）

### 4.1 主样本：创建 → 杀进程 → 重启 → 聚合一致

Phase 1（`M1D2_MODE=setup`）完成态（`SETUP-COMPLETE` 快照原文节选）：

```json
{"revision":8,
 "memberPhases":[{"name":"worker-1","phase":"active","sessionId":"…"}],
 "tasks":[{"id":"task-1","status":"in_progress"}],
 "messages":[
   {"id":"…","phase":"delivered","delivery":"wakeup","targetName":"worker-1","deliveredAt":…},
   {"id":"…","phase":"queued","delivery":"quiet","targetName":"worker-1"}],
 "budget":{"usedTokens":0,"usedRequests":1,"usedRetries":0}}
```

（quiet 消息发出前成员已 drain 为 inactive——官方 F13 inactive-target 形态。）随后 `taskkill /F`（真实 PID），杀后原始存储文件与此快照逐字段一致。

Phase 2（同根重启，captain 行切 `resumeSessionId`）：`captain-resumed`（恢复会话 34 events，与磁盘日志一致）→ `recover-agent-driven`（探针驱动与 idle 监听器/激活恢复相同的 `recoverAgent` 入口）→ `verify-converged`：

```json
{"revision":14,
 "memberPhases":[{"name":"worker-1","phase":"active"}],
 "tasks":[{"id":"task-1","status":"in_progress"}],
 "messages":[
   {"…wakeup…","phase":"delivered"},                       // 未重投（deliveredAt 不变）
   {"…quiet…","phase":"delivered","deliveredAt":<重启后>}], // 重启 rescan 期间恰好投递一次
 "budget":{"usedTokens":8,"usedRequests":1,"usedRetries":0}}
```

判定：

- **存储域恢复**：重启后 `agent_swarm` 单元整树重开、schema 校验通过、revision 连续（8→14 的推进全部来自恢复路径自身的合法提交：排队邮件投递与恢复记账），成员/任务/budget 结构一致，`task-1` 保持 in_progress（官方"restart with open runs"的恢复侧语义；stranded 60s grace 内未被误retry）。
- **F2 抽样①（已投递不重投）**：kill 前 delivered 的 wakeup 消息在重启与后续 rescan 中保持 delivered、deliveredAt 不变，目标侧份数不变（无第二次投递）。
- **F2 抽样②（queued 邮件耐久 + 恰好一次）**：跨硬杀存活的 quiet 消息经重启 rescan 投递，目标侧耐久日志恰 1 份（`frameCounts.quiet=1`）。
- **F13 抽样**：重启后成员 inactive 期间 quiet 邮件保持 queued（`member-live-before-wakeup live:false` 且消息 delivered 发生在任务恢复唤起成员的 rescan 内）；随后探针发送的 post-restart wakeup 冷恢复成员并投递，`postRestartWakeup copies=1`。

### 4.2 F3 抽样：provisioning 崩溃窗口 → 对账收敛

三次独立轮（不同 team id），形态一致。代表轮（`driver/f3.sh` + node 毫秒杀灭器）：

```text
[f3-driver] provisioning row visible; SIGKILL at …299173   （marker …299168，滞后 5ms）
[f3-driver] child exit: signal=SIGKILL  addMemberReturned=false   （窗口内，工具未返回）
[f3-driver] durable store: revision=2 members=[f3-worker:provisioning]   （中断记录耐久）
phase 2 → {"revision":3,"memberPhases":[{"name":"f3-worker","phase":"failed", …}]}
```

判定：重启后 `recoverAgent → recoverInterrupted` 将中断的 provisioning 记录**收敛**为 failed settlement（revision 2→3 提交，成员名保持占用，无卡死的 provisioning 行）。杀点落在子会话四因子可验证之前，故按 F3 语义走 failed 分支（"unverifiable evidence keeps the failed settlement"）；无孤儿成员复活为 active 的误判。**F3 真实持久化复证通过。**

### 4.3 F2 抽样：发送崩溃窗口（[queue commit .. delivered ack]）

杀灭滞后 1ms。三轮形态：

- 代表轮（成员初始事件已落盘）：

```text
[f2-driver] message queued; SIGKILL at …851331（marker 同毫秒）
[f2-driver] durable: revision=4 members=[f2-worker:active] messages=[message-…:queued]
phase 2 → POST-RESTART-F2-EVIDENCE:
  window 消息 message-c4d67…: queued → delivered，目标侧 copies=1
  post-restart wakeup message-a1e28…: delivered，copies=1
```

- 失败安全轮（杀点更早、成员会话日志尚未 materialize）：重启后投递无法验证目标 → **两条消息保持 queued**（`inspect-failed: session not found` 被探针记录为耐久事实；不投、不双投、不损坏）。

判定：崩溃窗口内消息要么经恢复 rescan **恰好一次**投递（1 目标副本），要么不确定性下保持 queued（fail-safe）。两种窗口落点均为正确语义。**F2 目标侧折叠/不重投在真实持久化上复证通过**（折叠谓词的输入——目标耐久 inbox/历史——即上面逐帧重放的同一事实源）。

## 5. 场景 3：有界关停（disposalTimeoutMs 真实关停路径）— 通过

Profile overlay 将 `disposalTimeoutMs` 设为 **1500**（整段 config 替换）。探针（`M1D2_MODE=teardown`）按 in-process 场景 9 同构注入：经官方 `ctx.subagents.registerProvider` 注册 `prepareContinuable` 永不 settle 的 continuable provider（capabilities 全真），再经 host API 准入一条永不 settle 的 `addMember`，待 provisioning 行耐久（marker `HANGING`）后断言真实 Profile 上的 runtime 自身 dispose 契约：

```json
{"marker":"DISPOSAL-EVIDENCE",
 "disposalTimeoutMs":1500,
 "disposeDurationMs":1513,
 "failed":true,
 "aggregateErrors":["Team orchestrator disposal step \"member provisioning\" exceeded 1500ms"],
 "teamDisposalTimeout":{"code":"TEAM_DISPOSAL_TIMEOUT",
   "message":"Team orchestrator disposal step \"member provisioning\" exceeded 1500ms"}}
```

随后探针走官方 `appExit(0)`（CLI 的 `createProcessShutdown` 有界关停路径）：整个进程退出 **1553ms、exit code 0**（dispose 的 AggregateError 被 CLI 关停路径按设计吞为有界退出；re-enter 的 dispose 因 closing 标志立即返回）。杀后耐久存储：`members=[hung-worker:provisioning]`——被中断的准入记录保持耐久，由下一次加载的恢复路径负责收敛（该收敛已在 §4.2 F3 抽样中独立证明：同一形态的 provisioning 行重启后收敛为 failed）。

判定：`disposalTimeoutMs` 在真实 Profile 关停路径上生效——挂起 provider 的清理步骤在 bound+13ms 内 fail loud（`TEAM_DISPOSAL_TIMEOUT`，指名 `member provisioning` 步），进程整体退出有界，耐久记录不丢失。**场景 9 语义在真实 Profile 复证通过。**

## 6. 场景 4：Windows 最小抽样（docs/08 §5）— 通过

- **长路径**：系统 `LongPathsEnabled=0`（注册表实测）；以 60 层 `lvl` 嵌套的工作区（工作区路径 ~239 字符）真实 boot，最深真实工件路径 **334 字符**（会话根 + cwd-mangled 分区 + `m1d2-captain/session.jsonl.zstd`），boot 全程健康（10s 窗口 33 个 assembly 采样，41/16/1），长路径下会话写入/读取正常。
- **文件占用**：以 `ShareMode.None` 独占句柄持有权威存储文件 `agent_swarm.json` 后重启 Profile：插件**不激活**（窗口内 `agentSwarm` 服务未出现、无 Team 工具、无部分注册——fail-closed 而非降级），进程不损坏任何状态；句柄释放后存储文件完整解析（teams=1）。
- **原子写**：全部硬杀场景遗留的 **5 个存储 JSON 全部完整解析、10 个会话 zstd 日志全部逐帧可解**（跨约 10 次 `SIGKILL`/`taskkill /F`，含 1ms/5ms 崩溃窗口内的活动写入），零撕裂记录。
- 路径比较未破坏盘符语义（全程正斜杠 spec + `resolve()` 规范化，scope 按会话 cwd 划分在长路径/普通路径下一致）。

## 7. 发现的缺陷与观察（不擅改；立案归 PM）

### 7.1 插件行为缺陷候选 D1：初始 provisioning turn 存活期间的 wakeup 邮件"delivered 但从未模型可见"

- 复现（3/3，含 provider 修复后的 2 次确认轮；更早 3 轮 turn 错误形态下目标侧序列形状相同）：`addMember` 返回后立即（同毫秒级）向该成员发送 `delivery: wakeup` 消息，随后创建任务（触发调度 pass 的 assignment followup）。
- 现象：send 工具返回 `phase: delivered`（store ack 已提交）；目标成员的耐久会话日志中该 frame 被插入 next-turn inbox 后**未经读取即被移除**，`user/message` 历史恒 0——成员从未模型可见该消息，且 store 显示 delivered 使重投不可能。
- 目标侧耐久重放（verbatim，member session jsonl）：

```text
seq 5  insert next-turn  "You joined Team …"（初始提示）
seq 7  remove next-turn 1                （turn 1 认领初始提示）
seq 8  insert next-turn  "Team message <woken-id> from captain: …"  ← 唤醒 frame 落盘
seq 9  remove next-turn 1                ← 未读取即移除（无对应 user/message）
seq 10 turn/end reason=aborted(parent)   （turn 1 被父方中止）
seq 12 insert next-turn  "Team assignment from captain. …"（assignment 随后到达）
seq 14 remove 1；seq 16 user/message = assignment（turn 2 读到的是 assignment）
…      后续 wakeup（重载后/重启后）均为 insert→claim→user/message 恰好一次（正常）
```

- 定位推测：`MessageDelivery.deliverMessage` 的 wakeup 路径无条件走 `subagents.followup`；当目标成员仍在初始 provisioning turn 中时，followup 的落帧与该 turn 的中止/后续 assignment followup 竞争，frame 随被中止 turn 的 pending inbox 一并取消，而 `targetFlushedAndRecorded` 在 seq 8 落盘即返回 true、ack 提交。与 #19 F13"quiet 对 running 成员经 inject 不另起 turn"的精细处理相比，wakeup 对 running 成员的竞争窗口缺少等价保护（in-process 测试覆盖了调度 pass 的 mailbox-first 顺序与场景 5 崩溃窗口，但未覆盖"send 路径 wakeup followup × 初始 turn/assignment followup"竞争）。
- 影响：模型可见的消息丢失（store 与目标会话不一致）；需要 PM 决定是否立案与目标 in-process 复现。

### 7.2 官方行为观察 O1（非插件缺陷）：`agent-loop` 配置行 `sessionId` 形态在硬杀后不复用

同一配置行首启用 `sessionId: m1d2-captain`（文档语义"first use creates fresh; remounts resume"）；进程硬杀后同形态重启，captain 以**全新会话**出现（3 events vs 磁盘 34），首次写回即被会话持久化以 `id collision` 拒绝（`session "m1d2-captain" already has a persisted log on disk that does not match this live session (id collision)`）。改用显式 `resumeSessionId` 形态后恢复完全正常（本报告主样本即用该形态）。归属：官方 `restoreOrCreateConfigured`/resume 交互（可能与硬杀留下的未闭合 turn 有关），建议提上游；对本插件的启示：依赖配置行 resume 的部署应显式用 `resumeSessionId`。

### 7.3 环境备注

- **B（取证方法论）**：Cordis loader 将树变更（HMR fiber reload）串行化在 pending entry `apply()` 之后——探针在 `apply()` 内 await reload 会造成 150s 级互相等待（实测：探针 150s 超时释放后 reload 于 28ms 内完成）。所有 reload 观察必须在 `apply()` 返回后经 effect-scoped 后台任务进行。此为 loader 语义，非缺陷；记录供后续取证探针复用。
- **B2**：Windows 下 Node `child.kill('SIGINT')` 是即时硬杀（18ms、signal=SIGINT），不走 CLI 的 SIGINT 优雅关停；真实关停路径验证应使用 `appExit`（§5）。MSYS bash `$!` 为 shim PID；bash 内联 `VAR=… cmd &` 会把整段复合命令后台化（本报告驱动脚本均已改为脚本文件 + PowerShell 真实 PID 解析）。
- **B3**：官方 jsonl 会话后端按批追加独立 zstd frame；单次 `zstdDecompressSync` 只解首帧。取证需按 magic 逐帧解压（§2）。另：JSON 按空格缩进序列化，简单正则计数 `"phase":"x"` 会漏配（F3 首轮 provisioning-rows=0 即此伪象）。

## 8. 结论表

| # | 验收项（issue #38） | 判定 | 关键证据 |
|---|---|---|---|
| 1 | 重载无重复注册（工具/prompt 节/监听器唯一） | **通过** | 官方 HMR 用户层编辑触发 fiber reload（runtime config 5000→3333）；全程 16 工具/1 节/41 总数从未超额；重载后 wakeup 消息恰好投递 1 次；进程干净退出 rc=0 |
| 2a | 进程重启恢复：聚合状态一致（存储域恢复） | **通过** | 硬杀后 revision 8 快照与磁盘一致；重启重开域、恢复 captain（34 events）、收敛于 revision 14；成员/任务/budget 一致 |
| 2b | F2 复证（queued 不重投/目标侧折叠） | **通过** | delivered 不重投（deliveredAt/份数不变）；跨杀 queued 恰好投 1 次（copies=1）；崩溃窗口 [queue..ack] 1ms 杀灭后 queued→delivered copies=1；不可验证目标时保持 queued（fail-safe） |
| 2c | F3 复证（provisioning 对账收敛） | **通过** | [commit..settle] 窗口 5ms 杀灭；耐久 provisioning 行 → 重启 recoverInterrupted 收敛 failed（revision 2→3），3/3 轮一致 |
| 3 | 有界关停（disposalTimeoutMs 真实路径） | **通过** | bound 1500：dispose 1513ms 返回，`TEAM_DISPOSAL_TIMEOUT`（member provisioning 步）；appExit 有界退出 1553ms/code 0；准入记录耐久（hung-worker:provisioning） |
| 4 | Windows 抽样（长路径/占用/原子写） | **通过** | 334 字符工件路径健康运行（LongPathsEnabled=0）；独占句柄下 fail-closed 不激活、无损坏、释放后完整；10 次硬杀后 5 JSON + 10 zstd 全部完整 |
| 5 | 缺陷 | **D1**（插件行为候选，§7.1）；O1（官方观察）；B/B2/B3（环境备注） | — |

## 9. 仓库影响

本变更仅为本证据报告（docs-only）；不触碰 `src/`、`ref/`、`docs/reviews/`、`docs/GOALS.md`、Skill。探针与驱动脚本位于临时证据区 `%TEMP%\m1d-check2/{probe,driver}`（随系统清理销毁；报告已内嵌全部关键节选与复现命令形态）。`pnpm verify` 全链在 worktree 实测 exit 0（见 PR CI 与 §执行记录）。issue #38 验收项全部满足且证据并入本 M1D 证据报告；缺陷走 PM 立案决定。

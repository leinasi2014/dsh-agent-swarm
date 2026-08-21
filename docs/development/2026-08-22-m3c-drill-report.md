# M3-3 演练证据报告 — P0–P7 端到端受控 dogfood（issue #102 验收记录）

- Report: 2026-08-22（M3-3 实现泳道执行；PM 委派，设计输入 `docs/development/2026-08-21-m3c-acceptance-design.md`，PR #110 已合并）
- 结论先行：**P0–P7 全部通过（exit 0）**。g0 基线冻结/建立 → 候选冻结 → A0–A7 全链验收 → 外部晋升 g1 → 双型失败注入（验收拒绝型 + 晋升后存活型）→ 回滚 g0 → 证据打包 → 进程零残留。全流程仅发生在 dogfood 控制根与演练域，`~/.dsh` 全程零接触（事后核验：`~/.dsh` 下无晚于演练起点的文件改动）。
- 演练身份与工具链：

| 项 | 值 |
|---|---|
| dogfood 控制根 | `D:\Source\DSH\dogfood\dsh-agent-swarm`（四域：control/lkg/candidates/drills + ledger） |
| g0 冻结 commit | `bfcf20bf`（origin/main @ 演练时点） |
| 候选冻结 commit | `2809cd17`（feat/m3-acceptance-d2 实现头，即本 PR 的实现态） |
| 官方 CLI | `deepseek-harness-rc8-full/apps/cli/lib/bin.js`（`--version` = `0.1.0-rc.8` 世系） |
| 端口池 | 控制面 47830 / 验收面 47930（不相交固定池，`--no-open` 恒传） |
| 演练运行 | `drills/20260821174517-m3c`（drill-ledger 哈希链 9 条记录，P0→P7 逐相 sha256 链接） |

## 1. 逐相结果（drill-ledger 链记录 sha256 前 16 位）

| 相 | 结果 | 链值 | 要点 |
|---|---|---|---|
| P0 | pass | `9c1ce3d8f2842175` | main `bfcf20bf` 冻结为 `…-g0-bfcf20bf`（tarball sha256 `cd5caa58…`，580,352 B）→ `promote --establish` 建立 lkg/g0 → 稳定面健康探针绿（dump-config 身份 + boot 2.1s + `host.describe` ok + 端口回收） |
| P1 | pass | `8740dea0f9315859` | 候选 `2809cd17` 冻结（digest `2b0c308d…`，干净 detached worktree 构建，worktree-status 证据 `clean`） |
| P2 | pass | `b75e0ae12ccb56c3` | 验收 A0–A7 全过（verdict digest `eb356f52…`），A1 跑**全链 9 lane**（lint/duplication/exports/typecheck×2/test/scenarios/build/artifact 全绿，无重试），fail-closed 负路径探针红（`dsh-agent-swarm: pending` + boot 退出 1） |
| P3 | pass | `8fc7c9c5d01823a0` | 外部 promote：quiesce 三判据过 → remove+add → lkg/g1 + 指针 + 台账 → 健康探针绿 → 链核验一致 |
| P4a | pass | `30788b621db7c2ca` | **验收拒绝型注入**：候选的一提交子代 `d2276678`（加一个确定性失败测试）→ 冻结 → 验收 A1 floor 红（两次尝试均红，确定性）→ verdict fail → 台账 `reject` 记录 → 稳定面仍 g1 健康绿（零扰动探针） |
| P4b | pass | `1fd981e869399490` | **晋升后存活型注入**：候选 tarball 重打包（插件入口 import 即 throw）+ 自洽 digest 的 manifest/verdict（标记 `injected`），对**演练专用稳定副本谱系**（lkg+ledger 复制、全新 control home）promote → 健康探针红 → **有界自动回滚**恢复 g1（副本台账 promote+rollback 两记录、g2 目录保留）→ **真实根指针逐字节未动**（currentGen=1 且 updatedAt 不变断言过） |
| P5 | pass | `a6a738ad454e42e1` | 真实根 rollback 1→0：目标完整性校验 → remove+add g0 tarball → 指针回拨 → 台账 rollback 记录 → 健康复探针绿；g1 目录原样保留 |
| P6 | pass | `861ce6bfe1f9658b` | evidence-manifest.json（drill 证据 6 文件 + 2 个验收域证据 + 3 个候选目录逐文件 sha256） |
| P7 | pass | `09a43ae6309d71b8` | 零残留：Win32_Process 引用控制根的 node 进程 = 0（不含自身），双端口回收（netstat 内核真值），一次性演练域清理（evidence/ledger/lkg/candidates 保留） |

## 2. 真实根台账（5 条哈希链记录，链核验 ok）

```text
seq1 gen-established → g0 (candidate …-g0-bfcf20bf, commit bfcf20bf…)
seq2 accepted        (candidate …-cand-2809cd17, verdictRef sha256 eb356f52…)
seq3 promote         g0 → g1 (commit 2809cd17…, digest 2b0c308d…, profileIdentity {web, control/home})
seq4 reject          (candidate …-p4a-defect-d2276678 — P4a 注入, failedGates [a1-source-floor])
seq5 rollback        g1 → g0 (reason: drill P5)
```

终态：`lkg/lkg.json` currentGen=0（演练后回到基线），g0/g1 双代目录完整，`status.mjs` 链核验 PASS。g2 只存在于 P4b 副本谱系（按设计随 P7 清理，其断言与副本台账尾记录已固化进 drill-ledger 的 P4b 记录）。

## 3. OQ-1..12 逐条裁决（实现泳道，均属实现细节级；无改变设计承诺项）

| # | 裁决 | 证据/论证 |
|---|---|---|
| OQ-1 | **pnpm 9 实测：tarball 的 `postinstall: lefthook install` 在 Profile 目录内失败**（`'lefthook' 不是内部或外部命令` → ELIFECYCLE 1，lefthook 是 devDependency 不随 tarball 分发）。裁决：晋升/验收 lane 的 Profile 安装一律 `--ignore-scripts`（插件 lib 预构建、无安装期脚本需求；pnpm 10+ 本就默认拦截依赖脚本）。上游面备注：可立案把 postinstall 拆为 dev-only（如 `lefthook install || true`），非本 PR 范围 | 实测探针：无旗标 exit 1；带旗标 13.3s 安装绿 + dump-config 身份行齐 |
| OQ-2 | 同名同版本 tarball 重复 add 的缓解**写死进 promoter**：稳定面恒 remove+add；验收每代全新 DSH_HOME（无缓存碰撞面）。演练实测两代安装均绿 | P0/P3/P5 三次 remove+add |
| OQ-3 | 冻结泳道（PM 侧工件）与 #101 审查根（worker 侧行为）以 **commit SHA 为共同锚**；tarball digest 仅作工件身份，两面 digest 不相等（mtime 事实）已在设计 §1.2 声明，衔接协议即「manifest.gitCommit 是两面的Join键」 | manifest 字段 + verify root 检出同一 commit |
| OQ-4 | 端口采用**固定不相交池**（47830/47930）+ 恒显式 `--no-open`（官方 startup.ts 实证旗标存在）；不引入动态分配（P7 零残留断言需要可预测端口） | 演练全程两端口零冲突，P7 netstat 断言 |
| OQ-5 | quiesce 三判据实现面：c1 = 直读 `control/storage-root/agent_swarm.json`（不可解析即视为活跃，fail-safe）；c2 = 会话根文件指纹双轮询（缺省 120s，演练域参数化为 3s 并记录）；c3 = CIM `Win32_Process` 命令行匹配 control home。首版手动执行 + 判据全打印（自动化属后续） | lib.mjs `evaluateQuiesce` + 单测三判据双向 |
| OQ-6 | A5 dogfood 任务面降级为**无模型回路的 RPC 健康**（host.describe → session.create → session.history）+ 演练域存储根物化证据；模型驱动任务不在验收面（见 §4 裁决 D1） | a5-rpc-health.json |
| OQ-7 | LKG 保留代数：**默认不设硬上限**（当前 2 代 + 失败代证据），保留策略记录为台账可审计动作；磁盘上限待真实代数增长后定 | 无超限场景演练 |
| OQ-8 | 长路径预算：控制根同盘短路径（`D:\Source\DSH\dogfood\dsh-agent-swarm`）；杀树沿用 `taskkill /T /F`；清理 MSYS rm -rf + worktree prune | 演练全程无路径超限 |
| OQ-9 | docs/08 新增场景行 **35（验收拒绝型）与 36（外部晋升/回滚 fencing）**，场景 27/28 由本泳道关闭；审计行同步为 `implemented = 1-9, 11, 12, 16-21, 27, 28, 31-36` | docs/08 §3/§7 + 机器审计 25/36 |
| OQ-10 | `peerPins` 记录冻结 commit 的 package.json peerDependencies 原文；#105 的 release-anchored Gate A 是 PM 侧证据门，不进入验收 floor（见裁决 D4） | manifest.peerPins |
| OQ-11 | `lkg/g<N>` annotated tag **未打**：目录快照 + 台账已提供操作面与谱系；本地 tag 作谱系补充留待 PM 决定是否仪式化（推远端明确排除——凭据面） | 设计 §3.2 推荐非必需 |
| OQ-12 | 多候选并行验收：**串行**（首版）；drills 域按时间戳+candidateId 命名空间化已就绪，端口池并行化待需要时扩 | 演练串行执行 |

## 4. 实现泳道的裁决性偏离（相对设计注记的字面形态，均已论证）

1. **验收 Profile 名采用官方模板名 `web`**（而非设计例名 `agent-swarm-acceptance`）：官方 `PROFILE_TEMPLATES` 只按名字授模板（自定义名 = 仅 dsh-base，无 RPC 面）；要给自定义名组合 web-app 需网络拉包或手改 manifest（皆违反 official-first/卫生）。隔离由每代全新 DSH_HOME 承担（设计自己的 OQ-2 论证），身份证据由 dump-config 存储根行 + 演练域物化承担。
2. **A5 无模型回路**：ADR-0008 安全边界明文「验收 Profile 只收候选工件与专用临时状态」——凭据禁入是 ADR 级约束，压过设计 §2.3 A5 的 runbook 草图（prompt/history 微回路）；行为证据由 A1 floor 的真实组合测试族承担（其本身就是官方 testkit 组合）。
3. **A1 全链不含 `verify:structure`/`verify:references`**：二者是 PM 侧 Gate A 对本地 `ref/` 证据的核验，commit-only 的验证根**不可能也不应该**复放（ref/ 不入 git 是仓库纪律）；floor 的其余 9 lane 是 commit 的纯函数。manifest `acceptanceFloor` 如实记录。
4. **单 lane 一次有据重试**：组合测试族存在已知间歇 `.dsh-mkdir` ENOENT 竞态（本泳道在两个不同套件各命中一次，均复跑绿；属 #100/#101 已合并语义，未改动）。重试两次均留证据；确定性失败（P4a 注入）两次皆红不受影响。
5. **P4b 伪造 verdict 显式标记 `injected`**：演练以自洽 digest 的 manifest/verdict 驱动 promoter 走到探针步——这是设计 §4 P4 允许的注入方式（「直接以损坏副本触发探针」），注入点/预期/实际全部记录于 drill-ledger。

## 5. 观察与遗留（不阻塞本 issue）

- **启动伪影一行**（`freeze failed: unknown argument --cli`）：出现在每次后台启动的 drill 日志第 1 行（包括全绿 run），不来自任何已提交代码路径（全仓 grep：无任何调用以 `--cli` 传给 freeze.mjs；控制实验：平凡后台命令的日志无此行；演练 exit 0、证据链完整不受影响）。判定为启动环境伪影，机理未定，如实记录；若 PM 侧复现可追 bash 包装层。
- **Windows 环回端口探针假阳性**（已在代码注释+提交信息固化）：同进程曾持过到已死服务端的连接时，connect() 探针可对陈旧元组假完成 >170s 而 netstat 全空——端口真值必须读 netstat（本演练三次失败注入排查的根因之一）。
- 演练后 dogfood 根保持 g0 基线（健康），供后续 PM 侧操作；candidates/ 内保留三个候选（g0、候选、P4a 缺陷）的完整工件与日志。
- 机器审计：docs/08 场景 25/36 machine-proven（新增 27/28/35/36）；`tests/promotion-contract.spec.ts` 15 测试绿。

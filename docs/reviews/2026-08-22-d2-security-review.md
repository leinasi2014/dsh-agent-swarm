# D2 开放前置条件 A — 独立安全/架构审查报告（2026-08-22）

- 审查员：独立安全/架构审查席（GLM-5.3 只读席位，与全部实现会话分离）
- 基准：main @ tag `m3` 后 HEAD（67cd69c）
- 委派书：`docs/reviews/2026-08-22-d2-security-review-commission.md`（v1 生效稿）
- 证据包：M3 出口报告、D2 设计注记、P0-P7 演练报告、`scripts/promotion/` 全部 8 文件逐行、`tests/promotion-contract.spec.ts` 全文、`src/runtime/execution-roots.ts`、`src/runtime/execution-root-surface.ts`、`src/runtime/review-root.ts`、`src/runtime/executable-review.ts`、ADR-0008、`src/runtime/prompts.ts` 与 `src/index.ts` 接线面（grep 级）
- 转录说明（PM）：本文件为审查员最终报告的逐字转录（内容作者为审查员）。

## 1. 覆盖与方法（逐威胁面）

**面 1 晋升/回滚完整性**。逐行读 `promote.mjs`/`rollback.mjs`/`lib.mjs`/`plane-ops.mjs`/`runner.mjs` 与契约测试。推演路径：并发 promote 交错（两个 runPromote 同窗）、ledger 整链重算伪造、lkg 记录+tarball 自洽改写、quiesce 判据通过后的反悔窗口。判定：并发交错【未覆盖但受控】（单写者纪律 + `lib.mjs:331-338` 的 fresh-pointer 末线复查；残余窗口毫秒级）；整链伪造【现实可触发】，但前提是获得文件写权——写权来源见面 3（发现 F1）；quiesce TOCTOU【未覆盖但受控】（后果被探针兜底为可用性事件而非完整性事件，见 F6）；**第三形态（P4a/P4b 未覆盖）：跳过验收的静默晋升**【现实可触发】（发现 F4，下详）。

**面 2 隔离不变量**。核对 `controlRootLayout` 全路径派生（`lib.mjs:26-40`，无一处引用用户主目录）、`acceptanceIsolation` 双向包含检查（`lib.mjs:591-609`）及其测试、verdict 证据路径逃逸检查（`lib.mjs:428`）。判定：路径拓扑【演练/测试已覆盖】；**env 凭据边界【现实可触发违背】**（发现 F2）：`runner.mjs:45,51,139` 全量继承 `process.env`——验收 lane 进程与验收 plane boot（运行候选插件代码）可读 PM 会话全部环境变量。

**面 3 执行根/审查根组合**。核实声明级围栏的准确形态（`prompts.ts:71`——纯提示词纪律）、执行根确定性布局与冲突 fail-loud（`execution-roots.ts:193-227`）、orphan 不自动删（`execution-roots.ts:414-427`）、审查根证据只由根产出（`executable-review.ts:148-175`、工件名安全段校验 `review-root.ts:74`）、执行根 base 与 dogfood 根不相交（`execution-roots.ts:431-433`）。**组合失效点不在两根交互，而在冻结/验收泳道本体**（发现 F1）：`freeze.mjs:77` 与 `accept-check.mjs:92` 的 `pnpm install` 均不带 `--ignore-scripts`，候选 commit 控制 package.json 脚本与 lockfile——候选代码自冻结步起即以 PM 主体执行，而 PM 主体恰是 lkg/ledger/control 与 ~/.dsh 的写权持有者。判定【现实可触发】。

**面 4 stable 面 ~/.dsh 接触面**。对 `src/` + `scripts/` 全量 grep `homedir|USERPROFILE|~/.dsh`：除注释外零引用；所有 promotion 路径由 dogfood root 派生。判定：已提交代码路径【已覆盖，零接触成立】；候选行为路径【实证非穷举，且经 F1 存在现实接触通道】（进程 env 仍含 USERPROFILE，DSH_HOME 覆盖只防官方 CLI 误写，不防候选代码显式写）。

**面 5 台账与证据链**。单元级覆盖真实（`tests/promotion-contract.spec.ts:76-121` 篕改/重排/伪造三向）。端到端形态：链为无密钥 sha256 自洽链，无外部锚——持写权者可整链重算（发现 F5）；promoter 侧的 verdict 校验弱于契约测试自证的最强形态（发现 F4）。

## 2. 发现

**F1（P1）候选代码以晋升者主体执行——ADR-0008 安全边界的 OS 层执行机制缺位**
- 证据：`scripts/promotion/freeze.mjs:77`（候选 commit 的 worktree 内 `pnpm install --frozen-lockfile`，无 `--ignore-scripts`，依赖生命周期脚本执行）、`freeze.mjs:80-85`（候选 build/pack 脚本）、`accept-check.mjs:92`（同形态）、`accept-check.mjs:143,156-172` 与 `180-207`（候选插件在验收 plane 内 boot 并运行 activate 代码）。对比：插件 tarball 装 Profile 时有 `--ignore-scripts`（`accept-check.mjs:143`、`plane-ops.mjs:53`），但仓库级 install 没有——防护不对称。
- 触发条件：恶意或被污染的候选提交（D2 并行自我开发的内部人/子版本威胁，即 ADR-0008 安全边界的原文对象）。该代码可写 ledger（整链重算）、改 lkg 记录+tarball 自洽、预写 `candidates/<id>/acceptance-verdict.json`、或直接触碰 ~/.dsh。
- 与 ADR-0008 的冲突：`docs/adr/0008-self-hosting-dogfood-control-plane.md` §Security boundary——"credentials ... outside Worker write roots"、"A candidate cannot declare itself accepted or mutate the stable artifact pointer"。当前该边界只在接口层成立（verdict 无晋升动词、promoter 外置），主体层不成立。
- 建议：验收/冻结泳道降权执行（独立低权账户或受限 token + 对 dogfood root 与 ~/.dsh 的 deny-write ACL），或提前 D4 沙箱面——这是前置条件 B 的核心输入。

**F2（P1）验收域 env 继承暴露凭据面，与"验收面只收工件不收凭据"声明冲突**
- 证据：`scripts/promotion/runner.mjs:45,51`（`{ ...process.env, ...options.env }`）、`runner.mjs:139`（bootPlane 同形态）。A4/A5 boot 的进程内运行的是候选插件代码，可读 PM 会话全部环境变量（模型供应商密钥、token 等）。
- 冲突文本：ADR-0008 "credentials ... are outside Worker write roots"；M3 出口报告 §3.4 与演练 OQ-6 裁决声明"验收 Profile 只收候选工件与专用临时状态，never credentials"。实现只在"不发生模型调用"意义上守住了声明，在"候选代码不可读凭据"意义上没有。
- 建议：验收域 spawn 改 env 白名单（PATH/SYSTEMROOT/TEMP + DSH_HOME），与 F1 的降权互为补位；成本低，可先行。

**F3（P2）promote 半应用态无补偿且不可机检**
- 证据：`scripts/promotion/promote.mjs:85-105`——顺序为 install（85）→ establishGeneration（91），而代际末线复查（`lib.mjs:331-338`）与台账追加（`lib.mjs:347`）在 install 之后。install 后任一失败（并发写者、copyFile/磁盘错误、ledger 追加失败、进程崩溃）留下：稳定 Profile 已装候选字节、指针/台账未动。auto-rollback 只覆盖探针失败路径（`promote.mjs:109-128`），不覆盖 establishGeneration 抛出的路径。且 `status.mjs:31-48` 只读 Profile package.json 的依赖存在性，从不将已装字节 digest 与 `pointer.currentTarballSha256` 对账——此分叉下 chainOk 仍为 true，静默。另一崩溃窗：pointer 写后 ledger append 前崩溃 → pointer/ledger 分歧 → `checkFencing`（`lib.mjs:278-280`）拒绝一切后续动作，`rollback.mjs:50-53` 同样拒绝——晋升面死锁且无修复工具。
- 触发条件：单写者纪律下的磁盘故障/进程崩溃即可，不需要对手。
- 建议：establishGeneration 失败时补偿性重装 prev 代 tarball；status.mjs 增加已装字节与 currentTarballSha256 的对账；提供 pointer/ledger 分歧的显式修复子命令。

**F4（P2）promoter 的 verdict 校验弱于其自身契约测试，存在"跳过验收的静默晋升"路径（P4a/P4b 未覆盖的第三形态）**
- 证据：`scripts/promotion/promote.mjs:62`——`verifyVerdict(verdict, manifest)` 不传 `evidenceBaseDir`，gate 证据 digest 复核（`lib.mjs:428-431`）整体跳过；`verifyVerdict` 不强制最低 gate 集合、不要求 gate 携带证据（`lib.mjs:422-431`——evidencePath/evidenceSha256 缺失时直接 continue）；promote 也不与台账既有 `accepted` 记录的 `verdictRef.sha256` 交叉核对（`accept-check.mjs:235-248` 写入，promote 不读）。P4b 演练的伪造 verdict（单 gate、无证据，`drill.mjs:244`）真实通过了 promoter 校验——演练把它当注入手段，但它同时就是缺口的实证。
- 推演（第三形态）：在 candidates/<id>/ 预写一个绑定真候选 digest、overall=pass、单 gate 无证据的 verdict → manifest 校验过、verdict 校验过、fencing/quiesce 过、安装真候选（健康）→ 探针绿 → **未经验收的代码成为 LKG，台账看似全链自洽**。前置条件仅是候选目录写权（经 F1 的候选代码执行即可获得）。
- 建议：promote 强制 gate 集合（八 gate 命名+状态+证据三重在场）、传入 evidenceBaseDir（drillDir 已在 ledger accepted 记录 `record.drillDir` 中可定位）、比对 verdict 文件 digest 与 accepted 记录的 verdictRef。

**F5（P2）ledger/LKG 链无密钥、无外部锚——写权即伪造权**
- 证据：`scripts/promotion/lib.mjs:132-192`（sha256 自链）、`lib.mjs:226-263`（内部自洽校验，无外部事实交叉；ledger 记录与 gen 记录的 tarballSha256 亦不互查）。防护完全落在"写权边界=PM 身份"声明上（设计注记 §3.1 自己承认"不依赖 ACL 产品化"），而 F1 显示 PM 身份在验收期执行候选代码。
- 建议：每次晋升将链尾 hash 锚入 git（设计 §3.2 本就推荐 annotated tag——OQ-11 裁决暂不打，建议翻案为"打本地 tag 至少锚链尾"），或对台账记录加签名/HMAC（密钥不得出现在继承 env 中——与 F2 修复联动）。

**F6（P3）quiesce 判据的 TOCTOU 与启发式缺口**
- 证据：`scripts/promotion/lib.mjs:490-533`。判据通过到 install 之间无锁；后果由探针兜底（端口冲突→探针红→好候选被自动回滚——可用性损失而非完整性，因 install 不触存储根）。`lib.mjs:452-453`：合法 JSON 但缺 `tables.teams` 时静默返回无活跃（被裁剪的权威面放行，与 448 行 unparseable→active 的 fail-safe 姿态不一致）。`lib.mjs:570-573`：进程扫描只及 `node.exe` 名且命令行须含 control home 路径。
- 建议：缺 `tables.teams` 键按 fail-safe 处理；进程判据文档化其启发式边界。

**F7（P3）并发 appendLedgerRecord 无互斥**：双写者同读尾 seq 可双写 N+1（`lib.mjs:141-161`），Windows appendFile 非原子还可能交错断行；事后链校验会 fail-loud 但文件已损需人工修。受单写者纪律控制。

**F8（P3）waitPortFree 的 reclaim 会杀任何监听 drill 池端口的进程**（`scripts/promotion/runner.mjs:241-258`）：共享开发机上端口被无关进程占用时误杀。其"drill 残留即自产"推理在专用池成立，在共享机不严格成立。

**F9（P3）readMarker 不校验 marker.path 与实际路径一致**（`src/runtime/execution-roots.ts:118-131`）：worker 写假 marker 可误导 scanResidue 报告（仅信息面，不授权动作）。

**F10（P3）establishGeneration fencing 失败时 gen 目录残留**（`lib.mjs:310-346`：指针复查前已写 gen 目录）——仅残留，下次同名代 copyFile 覆盖，无完整性影响。

无 P0。F1/F2 为 P1，构成 CONDITIONAL 的阻断清单主体。

## 3. 与 P0-P7 演练声明的交叉核验

- **P4b"真实根指针逐字节未动"**：核实为真——`drill.mjs:256-258` 确实逐字段（currentGen+updatedAt）断言，且注入只发生在复制谱系。声明成立。
- **"~/.dsh 零接触"**：在"已提交代码"域内我独立核实成立（全仓 grep 零引用）；在"候选行为"域内它是良性候选的实证、非穷举——F1/F2 给出了演练未走的现实通道。声明按其措辞（实证）成立，不得外推为结构性保证。
- **"进程零残留/端口回收"**：P7 断言实现核实（`drill.mjs:293-299`，netstat 真值 + Win32_Process 计数排除自身）。成立。
- **OQ-5 quiesce 三判据实现**：与声明一致；缺口见 F6。
- **演练报告 §5 的"启动伪影一行"**：我核对 `drill.mjs:149-153` 确不向 freeze 传 `--cli`，freeze 的 parseArgs 确会拒绝之（`freeze.mjs:38`）。机理未定的登记是如实的，不升级。
- **"验收拒绝型 + 晋升后存活型"双型之外**：第三形态（跳过验收的静默晋升，F4）演练未覆盖且推演可通——这是委派书点名要找的缺口，已列为发现。

## 4. verdict 与前置条件 B 输入

**verdict：CONDITIONAL**（维持受控开放；全面并行编码开放前关闭 F1/F2，F3/F4/F5 列入阻断清单随下一迭代修复）。

依据：无 P0；两项 P1（F1/F2）均为"候选恶意/被污染"前置的现实可触发路径，直接影响 ADR-0008 安全边界的可执行性。受控开放（PM 盯守、候选来源为本团队开发回路、单写者纪律）下当前风险敞口可接受——与 M3 出口报告"有条件开放"的原姿态一致，本审查将其从"宣言级"落到"清单级"。

**前置条件 B 输入（sandbox 围栏裁决建议）**：
1. 声明级围栏在 D2 并行场景**对抗恶意候选不够**（F1：候选代码自冻结步起即以 PM 主体执行，可及控制面与凭据 env），**作为良性防误写机制有效**（提示词纪律 + git worktree 物理分离防并行 attempt 互踩，这部分是真围栏）。
2. 不必等完整 D4 沙箱即可降级的三个先行项：(a) 验收/冻结泳道降权执行（低权账户或 deny-write ACL 覆盖 dogfood root 与 ~/.dsh）；(b) env 白名单（闭合 F2）；(c) 台账链尾锚入 git（闭合 F5 的伪造面）。三项落地后 F1/F2/F5 可降为 P2/P3。
3. 若三项不能先行，建议将完整沙箱（D4 面）提前为 D2 全面开放的硬前置。

## 5. 审查局限

- 只读席位：未运行任何脚本/测试/演练；drill-ledger 哈希链值、演练 exit 0、三次 remove+add 实测等运行时观测按演练报告采信，未独立复放。
- 实盘 dogfood 根（`D:\Source\DSH\dogfood\dsh-agent-swarm`）不在本仓内，未读取其实际台账/指针文件——F3/F5 的文件级分析基于实现代码而非实盘数据。
- 官方 rc.8 源码（DSH_HOME 覆盖完备性、apiproxy 行为）未逐文件复核，以 M1D-1/W4b-1 跨仓证据与设计注记引用为准。
- pnpm 行为（OQ-1/OQ-2 裁决）未独立复测。
- 未评估候选生成侧（worker 会话本身）的提示注入面——委派书范围是控制面。

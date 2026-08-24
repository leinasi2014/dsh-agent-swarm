# 07. Official-first product delivery roadmap

本路线图定义稳定的产品里程碑、依赖、非目标、风险和出口证据，不保存当前任务、分支、候选、负责人或滚动进度。历史实现和验收事实由 `docs/development/`、`docs/reviews/`、ADR、Git commit/tag 与测试保存；执行中的状态由项目绑定指定的动态权威保存。

## Gate A — every production milestone

每个生产里程碑在编码前执行 `docs/11-official-first-development.md` 的 Official-first compatibility gate：

- 验证目标官方 DSH release、安装包 exports/types/tests 和真实 Profile 组合；
- 把官方 checkout 当作只读身份与装配宿主；插件保持独立 Git、workspace、候选和发布权威；
- 复核两个 pinned reference checkout 的受影响行为与故障用例；
- 把能力分类为 official stable、experimental/private、absent 或 project-owned overlay；
- 明确 Service Definition、Provider、Consumer、唯一状态 owner、生命周期和失败语义；
- 拒绝 Agent Loop patch、影子服务、私有 DSH Runtime 和双 canonical state。

Gate A 只证明兼容性基线，不证明功能已实现。参考源更新必须审查旧 pin→新 pin 的实际差异；不得为过门而弱化校验。

## Product dependency graph

```text
G0 product/compatibility baseline
  -> P0 immutable package + real isolated official Profile proof
    -> F1 frozen read contract floor (no further speculative expansion)
      -> R1 / I2-R read-only Host projection
        -> R2 / I3-R canonical read-only /swarm RPC
          -> R3 / I4-R DSH Team read UI + open official Captain Chat
            -> R4 / I5-R Canvas read consumer + open the same Captain Chat

Existing I1a headless liaison
  -> W1 operation-scoped durable effect acceptance
    -> W2 I2-W/I3-W direct Host/RPC capabilities
      -> I4-W/I5-W controls enabled only capability by capability

R1-R4 do not require W1. One blocked effect never blocks unrelated reads.
R2/R4 do not unlock M6/M8 distributed claims.
```

共享 schema、capability 名称、权限规则、RPC envelope 和跨仓 fixtures 属于串行 producer 面。Consumer 可以针对冻结 fixtures 开发；真实接线和默认启用必须等待对应 producer 证据。UI 的“打开 Captain Chat”进入官方 DSH Session，不是 `/swarm` 的隐式写操作。

## G0 — product and compatibility baseline

### Outcome

冻结产品方向：用户安装的官方 DSH 是唯一 Agent Runtime/Profile/Session/preset 权威；Swarm 是纯插件和 Team/HumanInteraction producer；DSH UI 与 Canvas 是宿主原生消费者。

开发 checkout 可以物理嵌套于官方 DSH，但必须位于官方 workspace glob 之外，并由插件根 workspace boundary 解析自己的工具链。不修改官方 manifest/lock/config，也不从物理路径推导兼容性。真实验收由独立插件 artifact 经官方 Profile/Bundle Loader 装配完成。

### Exit evidence

- `docs/GOALS.md`、vision、capability architecture、roadmap 与 fusion/source 记录一致；
- Gate A 对审查过的 official/reference identity 通过；
- plugin workspace 不借用父宿主工具链；
- 旧 dual-host/Canvas-owned-Team 方向已删除或明确 supersede；
- stable documents 不保存动态任务状态。

Risk: S3/HIGH，原因是跨仓权威与兼容方向；需要精确候选的非作者审查。

## P0 — immutable package and real Profile proof

### Outcome

把“源码和测试存在”变成“用户拥有的官方 DSH 能装载这个独立插件候选”。从一个冻结 Git candidate 构建一次本地 tarball，记录 artifact digest，并只在 fresh isolated `DSH_HOME` 的官方 `web` Profile 中安装和验证。预发布阶段不宣称公共 npm/Git 安装入口。

### Required behavior

- package manifest、Bundle patch、packed files、peer resolution 和独立 workspace 均来自插件候选；
- Bundle 只贡献 `disabled: true` 的结构性 `cordis:group`，真实 Swarm 子插件位于其 `config`；`plugin add` 后首次重启的官方清单必须显示子插件 `enabled=false/fiberPhase=null`，Profile owner 的后一层显式 enable 才能激活；
- Profile 显式组合 Storage hub、KV backend、Storage Domain、Session persistence 和 Swarm；storage/session root 位于 Team workspace 与 sandbox root 之外；
- `plugin add`、`--dump-config`、默认禁用、显式启用、service/tool presence、unload、reload、R0 再禁用、remove 后清单消失和 fail-closed missing-storage 证据绑定同一 artifact digest，且每次状态判断都经过真实重启；
- 官方 checkout 在验证前后 source-clean；用户默认 `~/.dsh` 不被测试触碰；
- link 只允许开发诊断；接受和后续 Consumer 绑定 packed immutable artifact。

### Exit evidence

Artifact manifest/digest、隔离 Profile config、完整命令回执、官方 `pluginInventory/list` 在默认禁用/显式启用/R0/remove 各状态的只读快照、真实 service/tool probe、reload/dispose、缺依赖负向组合、官方与插件 Git status read-back，以及精确候选的非作者审查。

Risk: S2/MEDIUM；若进入用户默认 Profile、发布或远端分发则升级 S3。

## F1 — frozen pre-transport read contract floor

### Outcome

保留现有 versioned strict schemas、canonical fixtures/digest、Cordis lifecycle service，以及 exact-root-authorized 的 bounded Team snapshot/receipt projection。`message.write`、`control.write` 和 `effect.cancel` 继续在 payload inspection 或任何 I1a effect 前返回 unavailable。

### Boundary

F1 已足以作为 read lane 的 vocabulary seed，但不是 Host/RPC 或用户价值。不得继续为假想 Consumer 增加 schema、context、principal、cursor、event stream 或 transport 层。下一次 contract 变更必须由 R1/R2 的真实 consumer acceptance 驱动，并产生新 digest/candidate。

Risk: S2/MEDIUM shared contract；写能力硬关闭，不继承 effect mutation 风险。

## R1 / I2-R — read-only Host producer

### Outcome

在 P0 和 F1 上提供最小内部 Host read service。Host 从官方 live root/session 和 authoritative Team 建立有界绑定，投影 UI 真正需要的 roster、task/attempt、budget、pending interaction 和 capability 状态；客户端不能提交 Agent/Session/principal 真相，也不能直读写 Storage Domain。

### Required behavior

- Host-owned binding 唯一关联官方 root Session、workspace scope 和 Team；caller hint 只用于查找，最终 identity 必须由 Host 解析；
- reads bounded、strict、redacted、cursor/resync capable；projection 不复制 Team truth；
- missing/deleted/archived/mismatched Team 和 Session switch 明确失败或投影 terminal state；
- no human principal verifier、no direct effect gateway、no Team/overlay write；
- close admission、drain、unprovide 和 authority teardown 顺序可执行验证。

### Exit evidence

Host contract negatives、真实 Cordis provide/dispose/reload、bounded/redaction、Session/Team mismatch、archive/reconnect、lifecycle leak checks，以及 exact candidate 非作者审查。

Risk: S2/MEDIUM；读取身份若越界则升级 S3。

## R2 / I3-R — canonical read-only `/swarm` RPC

### Outcome

在 R1 上发布唯一 browser-safe、versioned `/swarm` read namespace：capability discovery、binding/status、snapshot、task/attempt/pending-interaction page 和 bounded projection resync cursor。所有 write capability 在协议中继续明确 unavailable。

### Contract gate

- canonical JSON fixtures、schema/fixture digest、RPC version 和 capability set 是 immutable artifacts；
- request/result 拒绝 unknown、oversized、cyclic、accessor/proxy-like 或矛盾数据；
- browser 或 Canvas 不能上传 root Agent、captain Session、scope 或 principal 作为 authority；
- transport origin/trust 不等于 human identity；
- official webserver route/upgrade lifecycle、mount/unmount/reload 和 no-UI operation 通过；
- packed browser-safe consumer 不能导入 Host/storage/runtime-only module。

R2 的首个实现固定为本机单用户、只读、target-bound 而非 principal-bound。`rootSessionId`/`teamId` 只是查找提示；Host 每次独立核验 exact live root Agent、同一 live Session 对象、root registry、workspace cwd 和 Team captain，再经官方 `withInitiator` 进入 R1。由于官方 Connection handler 不提供 remote peer 或原始 Origin，R2 使用官方 raw `WebServer.register` exact route `/swarm/v1`，并在解析正文前同时要求 listener=`127.0.0.1`、socket 两端 loopback、Host 为实际 listener port、Origin（若存在）与 Host 完全同源且 Fetch Metadata 非 cross-site。listener 为 `0.0.0.0` 或上下文不可验证时所有 read capability unavailable/route fail closed；不得把它解释为 LAN trust 或 human principal。该兼容 seam 随官方 WebServer/request-context 变化重新走 Gate A。

### Exit evidence

RPC contract/transport/failure tests、packed consumer purity、真实官方 web Profile handshake/lifecycle、fixtures/digest validation、完整项目检查和 exact-candidate 独立安全审查。

Risk: external read boundary 为 S3/HIGH。

## R3 / I4-R — DSH Team read UI and official Captain Chat handoff

Implementation state: code/build/unit candidate complete on 2026-08-24;
immutable official Profile/browser evidence and final exact-SHA review remain
the acceptance gate.

### Outcome

使用官方 slots、components、locale 和 theme tokens 提供最小 DSH client plugin。它只消费 R2，展示 Team、成员、任务/attempt、预算、pending interaction、capability、stale/reconnect/error，并提供明确的“打开 Captain Chat”操作进入同一官方 DSH root Session。

完整 Team 面板只使用公开 Slot priority 语义临时占用官方 `details` 列，使 Chat 在宿主允许三栏时真实重排；Team 图标是直接的打开/关闭二态开关，不再存在 `shell.overlay` Peek、compact 卡片、三段点击或插件自有宽度门槛。Session header 中紧邻 Team 的 Tool Details 操作释放该 occupant、停止 Team 读取并调用官方 `openDetails()`，由原有 DetailsPanel 自动接管；插件不维护 Tool 状态，也不复制官方 DetailsPanel。较小窗口是否将 details 派生为 0 完全服从官方 AppFrame concession，Swarm 不用浮层兜底、不注入私有 DOM/CSS 布局补丁；窗口重新可容纳时官方栏自动恢复。DSH locale 是 Swarm UI 唯一语言权威，DSH theme token cascade 是唯一主题权威；插件不保存自己的语言或主题偏好。

Captain Chat 是首个用户修正纵切：用户通过官方 Session 对 captain 说明修改，captain 再使用已有 `agent_swarm_*` 工具操作 Team。UI 不把聊天文本解释为 typed Control，不从 transcript 派生 Team truth，也不等待 direct `/swarm` writes 才提供价值。

### Exit evidence

Fixture-driven components、accessibility、mounted locale live switch、official theme-token resolution、真实 client bundle purity、动态 details occupant 的 winner/rollback/entry-error、Team→Tool 单向移交、Session/viewport 切换、mount/dispose/HMR、Session handoff identity、宽屏 Chat reflow、直接二态关闭，以及窄屏官方 details concession 与“无浮层回退”截图/交互检查，并完成 final candidate 非作者审查。只能宣称恢复官方 occupant/功能，不能宣称恢复公开 API 未提供的历史栏宽、开闭状态或窄屏 Tool 可见性。

Risk: ordinary UI 为 S2/MEDIUM；错误 Session handoff 为 S3/HIGH。

## R4 / I5-R — Canvas read consumer

### Outcome

Canvas 在已接受的 R3 candidate 基础上连接用户的同一官方 DSH，复用已接受的 R2 capability，并以 Canvas-native 组件投影同一 Team read contract。Canvas 可以打开/聚焦同一官方 Captain Chat；Canvas BFF 只提供 origin/token/rate-limit/transport 保护，不成为 Team/HumanInteraction producer。

### Start gate

R4 只能在 exact R3 candidate 已接受后开始。Canvas 必须收到该 candidate 的 artifact identity、canonical schemas/fixtures/digest、RPC version/capability set、真实 Profile mount/dispose/reload 证据，以及 DSH UI/Canvas read parity evidence；Canvas 仍复用已接受的 R2 contract，不创建第二份 consumer contract。

### Boundaries

- Swarm 是当前官方 DSH Session capability，不是 Canvas 第三 engine；
- Canvas 不创建私有 `DSH_HOME`、复制 presets、解析 captain transcript 或把 Canvas token 当 human principal；
- Canvas graph/Director 继续由 Canvas 负责；
- 两端共享 semantic fixtures，不强制共享 component library 或 visual skin；
- read lane 不显示尚未接受的直接 Control 为可用。

### Exit evidence

Producer/consumer conformance、真实 handshake、same-Session captain-chat handoff、stale/reconnect/abort、Canvas-native rendering/accessibility，以及跨仓 S3 compatibility acceptance。

Risk: cross-repository identity boundary 为 S3/HIGH；ordinary rendering 为 S2/MEDIUM。

## W0 — existing headless liaison baseline

现有 I1a 保留：root captain 是唯一 Human Liaison；成员问题经持久 Team mail 路由；typed requests、receipts、caller authority、revision/attempt fences 和 `OUTCOME_UNKNOWN` quarantine 已定义。它不承诺跨重启 exactly-once，也不自动使 browser principal 或 direct Control 可用。

W0 与 R1-R4 并行提供基础，不是 read lane 的前置 blocker。

## W1 — operation-scoped durable effect acceptance

### Outcome

按操作而不是按“全部 HumanInteraction”开放写能力。每个 capability 单独冻结 identity、authority、atomicity/read-back、retry/reconcile、capacity、redaction、crash window 和 unsupported cases；未通过的操作保持 unavailable/held，不拖住已通过能力或 read lane。

### Operation classes

1. **Team-internal atomic effect**：mutation 与 applied evidence 可在同一 Team transaction 提交，例如 proposed `queueMessageOnce`；需要 accepted schema/migration decision。
2. **Canonical-state reconcilable effect**：revision/attempt fencing 加 operation-specific authoritative read-back 能唯一分类 applied/not-applied/conflict；不能靠宽泛 transcript 推断。
3. **External idempotent Provider effect**：Provider 必须给 stable operation identity、payload conflict refusal 和 authoritative query。
4. **Opaque external effect**：当前 `userQuestions.ask`、`subagents.interrupt` 或 unconstrained review 等无 read-back 操作保持 unavailable/outcome-unknown。

ADR-0009 仍是 proposed 方案，只约束选择其 v2 ledger 且需要处理 v1 media/old binary 的写 slice。Clean-profile v2、显式离线迁移、supported-backend conversion 和 downgrade policy 必须先做产品裁决；不得用该 proposal 阻断 reads，也不得未经接受实现其迁移控制面。

### Exit evidence per capability

真实持久存储与 process-boundary reopen、operation-specific fault matrix、authorized retry/read-back、conflict/capacity/redaction、capability fixture/digest、完整受影响检查，以及风险匹配的独立审查。

Risk: durable control transition 为 S3/HIGH；pure advisory Message 若不直接 mutate Team 可单独降级评估。

## W2 — Host/RPC/UI write projection

### Outcome

R1/R2 的 capability discovery 逐项公布 W1 已接受的 write operation。Host mint/refresh/revoke context 与 verified human principal 只为需要它的能力存在；RPC 和两个 UI 不能自行扩大 capability。

### Rules

- capability unavailable 是正常协议状态，不用自动 fallback 或自由文本冒充 Control；
- unknown result 先 read-back/resync，禁止 blind retry；
- context、principal、request id、Team/task revision、attempt 和 receipts 分别由正确 owner 提供；
- DSH UI 和 Canvas 在同 fixtures 上做 action parity，但各用宿主 UI；
- 新 capability 只增量审查其 contract/risk delta，不重复审查未变 read candidate。

Risk: S3/HIGH。

## M6–M9 subsequent capability families

- **M6 real Workspace and remote member**：实际 cwd/fs/tool roots 与 attempt lease 一致；late ACK、expiry、disconnect、conflict、cleanup failure 被围栏。产品 execution root 不授权仓库开发 worktree。
- **M7 Team memory and Skill Evolution**：只有 accepted evidence 进入有界、可追溯 proposal；proposal、deterministic validation、approval、write 分离。
- **M8 distributed atomic Team and observability**：Store Provider 提供 CAS、lease、fencing、idempotent mailbox 和 change feed；partition 停止不可证明工作；UI/log 仍是 projection。
- **M9 migration, compatibility, packaging and release**：支持的 legacy import、官方 experimental Team migration trigger、public immutable package、compatibility matrix、upgrade/rollback 与 controlled release observation。P0 是本地可安装证据，不等于 M9 public release。

这些能力族不得插队阻断 P0/R1-R4。每个能力族有自己的 Gate A、failure-injection suite、recovery evidence 和风险分级审查。

## Candidate salvage and supersession

历史 feature branch 与 report 是 recovery/evidence input，不是当前 accepted candidate。新里程碑从 authoritative target 开始，只选择与本路线图兼容的 behavior/tests，排除 retired governance/ref-pin material，重跑当前 gates，冻结新 candidate 并接受当前风险对应审查。

凡是把 Team truth 交给 Canvas、从 transcript 派生 Team 状态、把 Swarm 作为第三 Runtime、把共享跨宿主 UI component 当权威，或恢复 raw worktree lifecycle command 的文档，都被本路线图和 project binding 取代。

## Permanent work rules

- One state domain, one canonical owner; one transition, one owner.
- Official services, canonical authorities and state machines are consumed, never shadowed. A public UI Slot may use its documented priority-shadow contract only through a bounded, reversible, failure-tested presentation decision that leaves the official occupant registered and restores it on release.
- Reference repositories contribute characterized behavior, not runtime duplication.
- Read delivery and privileged write acceptance are separate dependency lanes.
- One blocked effect blocks only its own capability.
- UI and RPC are consumers/projections over durable Host/Team authority.
- Shared contracts integrate before consumers; target-level checks read back the result.
- Milestone status changes only with executable evidence and synchronized authoritative documentation.
- Self-hosting follows ADR-0008: stable control and candidate acceptance Profiles are separate, and promotion is externally owned.
- Repository development remains `single-checkout` until a project-owned open/status/close/reconcile gate and its independent acceptance change the binding.

# 07. Official-first product delivery roadmap

本路线图定义稳定的产品里程碑、依赖、非目标、风险和出口证据，不保存当前任务、分支、候选、负责人或滚动进度。历史实现和验收事实由 `docs/development/`、`docs/reviews/`、ADR、Git commit/tag 与测试保存；执行中的状态由项目绑定指定的动态权威保存。

## Gate A — every production milestone

每个生产里程碑在编码前执行 `docs/11-official-first-development.md` 的 Official-first compatibility gate：

- 验证目标官方 DSH release、安装包 exports/types/tests 和真实 Profile 组合；
- 复核两个 pinned reference checkout 的受影响行为与故障用例；
- 把能力分类为 official stable、experimental/private、absent 或 project-owned overlay；
- 明确 Service Definition、Provider、Consumer、唯一状态 owner、生命周期和失败语义；
- 拒绝 Agent Loop patch、影子服务、私有 DSH Runtime 和双 canonical state。

Gate A 只证明兼容性基线，不证明功能已实现。参考源更新必须审查旧 pin→新 pin 的实际差异；不得为过门而弱化校验。

## 产品依赖图

```text
G0 product/compatibility baseline
  -> I1 headless captain liaison + durable effect correlation
    -> I2 executable HumanInteraction Host producer
      -> I3 canonical /swarm RPC + fixtures + real Profile proof
        -> I4 DSH-native UI
        -> I5 Canvas BFF/native UI consumer

I3/I5 do not unlock M6/M8 distributed claims by themselves.
M6 Workspace/remote -> M8 distributed atomic Team
I1/I3 accepted evidence -> M7 memory/Skill Evolution proposals
I4/I5 + M6/M7/M8 evidence -> M9 migration/package/release
```

共享合同、状态 schema、权限规则、RPC schema 和跨仓兼容属于串行 producer 面。Consumer 可针对冻结 fixtures 开发，但真实接线和默认启用必须等待所需 producer 证据。

## G0 — product and compatibility baseline

### Outcome

冻结一个产品方向：用户安装的官方 DSH 是唯一 Agent Runtime/Profile/Session/preset 权威；Swarm 是纯插件和 Team/HumanInteraction 唯一 producer；DSH UI 与 Canvas 是宿主原生消费者。

### Non-goals

- 不迁移 H1–H4 生产代码；
- 不实现 RPC/UI；
- 不公开发布或执行远程变更；
- 不重新开放并行仓库 worktree。

### Exit evidence

- `docs/GOALS.md`、vision、capability architecture、roadmap 与 fusion/source 记录一致；
- Gate A 对审查过的官方/reference identity 通过；
- 旧 dual-host/Canvas-owned-Team 文档已删除或显式 supersede，且保留 Git 恢复身份；
- 项目治理和文档链接通过，stable documents 没有动态任务状态。

Risk: S3/HIGH，原因是跨仓权威与兼容方向；需要精确候选的非作者审查。

## I1 — Captain Liaison and durable effect correlation

### Outcome

无 UI 时，root captain 是唯一 Human Liaison。成员通过持久 Team mail 路由问题和结果；用户 Message 与 typed review/control 经 additive HumanInteraction port 进入，所有 Team mutation 仍由 `TeamDomainPort` 提交。进程在 effect commit 与 receipt acknowledgement 之间丢失后，已提交 effect 可 exactly-once reconcile。

### Required behavior

- free text 是 advisory data，必须 injection-fenced，不能授权；
- controls 按需携带 request identity、Team/task revision 与 attempt/member fence；
- duplicate、stale、late、expired、cancelled、spoofed 请求确定性失败；
- restart reconciliation 能区分 not-applied、applied、acknowledged，不重复 domain effect；
- 缺 question provider 时返回 visible held/unavailable，而不是编造答案；
- 查询状态不能重启 idle/open work，继续与转派必须是显式 owner action。

### Delivery order and architecture gate

I1 is delivered as bounded dependent slices rather than one broad effect claim:

1. **I1a — headless liaison and fail-closed quarantine:** typed request/admission/receipt contracts, caller and reviewer boundaries, Team-only mutation path, process-local replay refusal and secret-free `OUTCOME_UNKNOWN`.
2. **I1b-1A — Team-v2 authority and first correlated effect:** after independent acceptance of [ADR-0009](adr/0009-i1b-v2-effect-ledger-authority.md), explicitly migrate the v1 Team authority into the single `agent_swarm_v2` aggregate, add an atomic bounded effect ledger, and prove `queueMessageOnce` plus member-question relay across real crash/reopen windows.
3. **I1b-1B — mail controls:** reuse the accepted ledger for wake/correct mail. Answer mail waits for authoritative question-result read-back rather than inferring presentation state.
4. **I1b-1C — task controls:** correlate the canonical Team reassignment and deterministic/provider-correlated review transition. Live interrupt and provider-side effects remain outside the claim until their official seams expose durable operation identity and query.

The v2 migration is quiesced, validated, one-way and compatibility-fenced: v2 becomes the only writer, v1 remains read-only recovery evidence, and neither dual-write nor old-binary fallback is rollback. `ctx.userQuestions.ask`, `ctx.subagents.interrupt` and unconstrained Review Providers are explicit upstream blockers under the contracts in ADR-0009; their unknown outcomes remain held, not replayed.

### Non-goals

不加入 browser context、Host service、RPC、Canvas adapter、公开发布或 distributed claim。

### Exit evidence

Contract/domain/unit tests、真实 official interaction composition、quiesced v1→v2 migration/read-back/compatibility evidence、crash-window/replay/restart tests、model-visible data-boundary snapshots、完整受影响检查，以及 exact candidate 的独立安全/持久性审查。外部 seam blocker 必须以可复现的不可判定窗口保留为 fail-loud evidence，不能算作 exactly-once PASS。

Risk: review、permission 与 durable control transition 为 S3/HIGH；纯 advisory Message path 为 S2/MEDIUM。

## I2 — executable HumanInteraction Host producer

### Outcome

提供一个内部 Host service：解析 exact live root captain 与 authoritative Team，签发有界 opaque context，把 browser-safe Message/five Control 翻译为 I1 操作，并从 durable overlay 投影有界脱敏 snapshot、receipt 与 timeline。

### Required behavior

- context mint/refresh/rotation/revoke 有单一 lifecycle owner 和容量上限；
- `authenticated-human` 只存在于已验证的 host principal seam；否则 privileged action 必须经 captain confirmation 或降级为 message-only；
- client 只提交 plain untrusted payload，不能盖章 provenance、revision、attempt 或 principal；
- read 必须 bounded、cursor-authenticated、projection-only，客户端不能直读写 Storage Domain；
- abort、expiry、dispose、overlay restart 和 adapter failure 均 fail-closed，错误稳定且脱敏。

### Exit evidence

Host contract negative tests、真实 Cordis provide/dispose/reload composition、bounded-read/redaction、restart/replay/cancel、lifecycle leak checks，以及 exact candidate 的独立安全审查。

Risk: identity、control authority 与 durable replay 为 S3/HIGH。

## I3 — canonical `/swarm` RPC producer

### Outcome

在 I2 上发布唯一 browser-safe、versioned `/swarm` RPC namespace，提供 capability discovery、context、snapshot、Message、五 Controls、cancel、receipt 和 timeline；不得反射动态错误或接受 caller-minted authority。

### Contract gate

- canonical JSON fixtures、schema/fixture digest、RPC version 和 capability set 是 immutable candidate artifacts；
- request/result schemas 拒绝 unknown、oversized、cyclic、accessor/proxy-like 或矛盾数据，以各 runtime 可证明边界为准；
- transport origin/trust 不等于 human identity；
- cancellation 在底层 Host operation 真实 settle 前不能释放 physical capacity；
- production Host adapter 先把 caller hint 解析成 host-owned exact authority key，之后才可 mint/effect；
- 真实官方 DSH Profile mount/unmount/reload 与 UI-absent operation 通过。

### Non-goals

不实现 UI、Canvas-specific interpretation、transcript projection、共享 React package 或公开发布。

### Exit evidence

RPC contract/transport/failure tests、packed browser-safe subpath consumer、distribution purity gate、真实 Profile handshake/lifecycle、fixtures/digest validation、完整项目检查和 exact-candidate 独立安全审查。

Risk: external request 与 identity boundary 为 S3/HIGH。

## I4 — DSH-native minimum UI

### Outcome

使用官方 slots、components、locale 和 theme tokens 提供 DSH client plugin。它只消费 I3，展示 Message、五 Controls、pending question/review、receipt/timeline 与 stale/refresh/error 状态。

### Boundaries

- DSH UI 只拥有 rendering 与 ephemeral view state；
- 不解析 transcript，不持有 browser Team truth；
- UI 缺席不影响 runtime progress；
- polling/subscription cadence 有界，idle discovery 不能退化成 busy polling；
- 每个 slot/service/subscription 都有 mount/dispose/HMR 证据。

### Exit evidence

Fixture-driven component tests、受影响 controls 的 accessibility checks、真实 client bundle purity、mount/dispose/HMR、screenshot/interaction inspection，以及 final candidate 的一个非作者审查。

Risk: 普通 UI 为 S2/MEDIUM；identity/privileged-control regression 继承 I3 的 S3 控制。

## I5 — Canvas consumer integration

### Outcome

Canvas 连接用户的官方 DSH，发现已接受 I3 capability，并渲染自己的 Canvas-native Team UI。BFF 提供 origin/token/rate-limit/transport 保护并透传 canonical envelope；它不成为 Team/HumanInteraction producer。

### Start gate

Canvas 写入工作必须同时收到一个已接受 producer candidate 的：

1. exact producer artifact identity；
2. canonical schema、JSON fixtures 与 digest；
3. `/swarm` RPC version 与 capability set；
4. I1 crash-window machine evidence；
5. 真实官方 DSH Profile mount/dispose/reload 与 UI-absent evidence。

### Boundaries

- Swarm 是当前官方 DSH Session 的 capability，不是 Canvas 第三 engine；
- Canvas 不创建私有 `DSH_HOME`、复制 presets、解析 captain transcript 为 Team truth，或把 Canvas token 当 DSH human principal；
- Canvas graph/Director domain 仍由 Canvas 负责；
- DSH 与 Canvas 共享 semantic fixtures/action parity，不强制共用 component library 或 visual skin。

### Exit evidence

同 fixtures 上的 producer/consumer conformance、真实 handshake、Message/Control parity、stale/reconnect/abort tests、Canvas-native rendered interaction/accessibility，以及跨仓 S3 compatibility acceptance。

Risk: cross-repository authority/identity boundary 为 S3/HIGH；普通 rendering 为 S2/MEDIUM。

## M6–M9 subsequent capability families

- **M6 real Workspace and remote member**：实际 cwd/fs/tool roots 与 attempt lease 一致；late ACK、expiry、disconnect、conflict、cleanup failure 被围栏。产品 execution root 不授权仓库开发 worktree。
- **M7 Team memory and Skill Evolution**：只有 accepted evidence 进入有界、可追溯 proposal；proposal、deterministic validation、approval、write 分离。
- **M8 distributed atomic Team and observability**：Store Provider 提供 CAS、lease、fencing、idempotent mailbox 和 change feed；partition 停止不可证明工作；UI/log 仍是 projection。
- **M9 migration, compatibility, packaging and release**：支持的 legacy import、官方 experimental Team migration trigger、immutable package artifact、compatibility matrix、upgrade/rollback 与 controlled release observation。

每个能力族有自己的 Gate A、failure-injection suite、recovery evidence 和风险分级审查。I1–I5 不暗示这些能力已经完成。

## Candidate salvage and supersession

历史 feature branch 与 report 是 recovery/evidence input，不是当前 accepted candidate。新里程碑从 authoritative target 开始，只选择与本路线图兼容的 behavior/tests，排除 retired governance/ref-pin material，重跑当前 gates，冻结新 candidate 并接受当前风险对应审查。旧分支、测试计数或完成消息不能绕过该流程。

凡是把 Team truth 交给 Canvas、从 transcript 派生 Team 状态、把 Swarm 作为第三 Runtime、把共享跨宿主 UI component 当权威，或恢复 raw worktree lifecycle command 的文档，都被本路线图和 project binding 取代。

## Permanent work rules

- One state domain, one canonical owner; one transition, one owner.
- Official stable seams are consumed, never shadowed.
- Reference repositories contribute characterized behavior, not runtime duplication.
- UI and RPC are consumers/projections over durable Host/Team authority.
- Shared contracts integrate before consumers; target-level checks read back the result.
- Milestone status changes only with executable evidence and synchronized authoritative documentation.
- Self-hosting follows ADR-0008: stable control and candidate acceptance Profiles are separate, and promotion is externally owned.
- Repository development remains `single-checkout` until a project-owned open/status/close/reconcile gate and its independent acceptance change the binding.

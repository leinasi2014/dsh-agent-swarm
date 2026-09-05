# 02. Reference boundaries

本文件只登记外部参考在本项目中的角色与不可跨越的边界。当前产品行为以源码、测试、`docs/OFFICIAL_BASELINE.json` 和目标 Profile 的真实组合为准；历史设计稿、阶段报告与审查报告不再作为架构权威。

## 1. Reference roles

| Source | What it owns | What this project may borrow | What this project must not do |
|---|---|---|---|
| Official DeepSeek Harness | Framework contracts, Session/Agent lifecycle and published service seams | Service Definitions, Providers, Consumers, tools, events, storage forms, Profile/Bundle composition | patch Agent Loop, duplicate an official state machine, or treat a private experimental package as a published dependency |
| `NanmiCoder/dsh-agent-teams` | Direct DSH Team implementation prior art | continuable member lifecycle, task DAG, revision/attempt fencing, durable mailbox, scheduler and fault cases | copy its monolithic storage/UI/policy coupling or make its file store canonical |
| `openJiuwen-ai/jiuwenswarm` | Product and failure-model prior art | workflow, Worktree, memory, Skill Evolution, permissions and distributed-reservation concepts | import its Python runtime, transport or types into the DSH capability contract |

## 2. Adopted Team semantics

The following constraints survive the retired ADR and development-note set:

- `dsh-agent-swarm` is a capability family assembled as a Bundle, not a second Harness runtime.
- Published official DSH seams are canonical. Project code may be a Provider, Consumer, adapter or policy overlay only.
- The private experimental official Agent Team defines compatibility semantics but is not a production dependency. Until it is public, the non-conflicting host façade remains `ctx.agentSwarm`; a future official adapter replaces the selected Team Provider instead of becoming a second writer.
- Exactly one `TeamDomainPort` Provider owns roster, task board, attempts, mailbox, budget and Team revision for a Team.
- Canonical task mutation uses `expectedRevision`; execution writes additionally require the current `attemptId`. Reassignment invalidates the old attempt before another execution generation starts.
- Durable Team state lives outside the shared workspace in the official Storage Domain. Workspace JSON is migration input only. Migration is explicit, one-way, read-back verified and never dual-written.
- Mailbox delivery is durable before best-effort live delivery. A store acknowledgement alone is not proof that the target Session consumed a message.
- The in-place Team aggregate effect ledger proves only effects committed in that same aggregate transaction. It cannot prove external provider effects or cross-process exactly-once delivery.
- Adaptive scheduling and deterministic workflow may project into one UI, but only one mode owns assignment, retries and completion at a time.
- UI, Jobs, Workflow, Git state, logs and acceptance reports are projections or evidence; none is a writable Team authority.

## 3. Official compatibility boundary

- Official Session log and Agent lifecycle remain canonical.
- Every registration owns a disposer; reload cannot leave duplicate listeners, routes, React roots, workers, Agents or ports.
- Durable state is published only after its authoritative commit succeeds.
- Unknown Provider, unsupported capability, stale revision/attempt, ambiguous membership and missing persistence fail loud.
- `ctx.workspaceRegistry` proves workspace identity/membership, not a Worktree lease or a child cwd override.
- Prompt text and a declared path are not authorization. Isolation is real only when the executing Session and its filesystem/tool roots are changed and verified.
- Storage Domain loads values through the registered schema and strips undeclared object keys. Every persisted aggregate field must be added to both the table schema and runtime assertion before it can be considered durable.
- Continuable-member tool filtering is fixed at child creation on the current official seam; follow-up messages cannot silently rescope a member's tools.

## 4. Reference use order

When a behavior is uncertain:

1. inspect current project code and the target Profile;
2. inspect installed package manifests, exports, types and README files;
3. inspect the pinned official evidence checkout;
4. inspect official subsystem notes and examples;
5. use `dsh-agent-teams` for Team behavior and failure precedents;
6. use JiuwenSwarm for product concepts and operational failure cases;
7. if still uncertain, implement the smallest fail-loud behavior and record the assumption in an existing registered authority.

Secondary guides are learning material, never proof that a package, service or method exists in the target installation.

## 5. Rejected architectural shortcuts

- a monolithic Team plugin that owns workflow, workspace, storage, policy and UI;
- a private workflow runner when `ctx.workflowEngine` is the canonical service;
- a fake Worktree implemented only through prompt text;
- a second task/message database or UI-owned state machine;
- candidate self-acceptance, in-place self-update or mutable-link promotion;
- automatic memory/Skill mutation without accepted evidence, deterministic validation and separate approval;
- importing a reference runtime merely because its feature vocabulary is useful.

The detailed current ownership map belongs in `docs/03-capability-family.md`, protocol behavior in `docs/04-core-protocol.md`, feature mapping in `docs/05-jiuwen-feature-mapping.md`, and pinned identities in `docs/09-sources.md`.

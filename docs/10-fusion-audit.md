# 10. Reference fusion, conflict and architecture audit

Recorded and verified: 2026-08-20.

## 1. Conclusion

The two `ref` repositories are both present, complete checkouts at recorded commits. Their strengths are **not thoroughly fused** into the plugin. The shipped 0.1 package is a real, process-local Team core rather than a scaffold, and its protocol direction is reasonable: it uses DSH tools, continuable subagents, Agent/Session events, service lifecycle and a non-conflicting `ctx.agentSwarm` façade without patching Agent Loop. It implements several of the hardest coordination invariants, especially task CAS, execution fencing and a mandatory review transition.

It remains a partial synthesis. Jiuwen's workflow, Worktree, distributed control/data plane, human nodes, permission tiers, automatic Team memory, Skill Evolution and UI are absent. Several official/community robustness properties are also incomplete: the authoritative Team file is writable from the shared coding workspace, target-side message de-duplication across a crash is missing, persisted-child recovery is incomplete, unload is unbounded, retained messages and attempts grow with incorrect or missing limits, and scheduling ignores actual member availability.

There is no active state-machine conflict with official Workflow or Agent Team today because the plugin does not integrate them and uses a different service name. There are clear **future conflict risks** if those services are added without one-owner rules and adapters.

The independent GLM-5.3 review on 2026-08-20 issued `CONDITIONAL PASS` with P0 = 0, P1 = 4, P2 = 6 and P3 = 7. Its manager intake confirmed all P1 source citations. ADR-0007 therefore moves official Storage Domain integration from M3 to M1 and blocks release until the accepted remediation list receives independent regression review.

## 2. Evidence baseline

| Source | Verified revision | Role |
|---|---|---|
| `deepseek-ai/deepseek-harness` | `141eb6fef83422698aef7a981029e843e8161534`; remote `HEAD` and `master` matched on 2026-08-20 | framework and published-service truth |
| `NanmiCoder/dsh-agent-teams` | `801954dd7be67213cf4adc1aeb6f97bd3daa12cc`, version 0.1.8 | direct DSH Team implementation prior art |
| `openJiuwen-ai/jiuwenswarm` | `152583aa305836e87481e6de8a5f34e8c7d0928b`, WorkSwarm 0.2.5.beta1 | product architecture and failure-case prior art; the 2026-08-20 delta from `bddf335` is limited to gateway cron and Session metadata |

The official target publishes `ctx.workflowEngine`, `ctx.jobs`, `ctx.tokenMeter`, `ctx.storageDomain` and `ctx.workspaceRegistry`. Its Agent Team package is private/experimental and unpublished. These facts supersede earlier project text claiming that rc.8 had no public workflow or token-meter service.

## 3. `dsh-agent-teams` fusion matrix

| Strength in reference | 0.1 status | Current evidence / gap |
|---|---|---|
| Captain and continuable members | Implemented | members are created/followed through `ctx.subagents`; provider/model/persona/tool-filter data is retained |
| DAG and dependency readiness | Implemented | domain validation, ready-task calculation and tests |
| revision CAS | Implemented | every control-plane task mutation uses expected revision |
| attempt fencing and reassignment invalidation | Implemented | independent opaque `attemptId` guards worker submissions |
| durable-before-delivery mailbox | Partial | queued state precedes followup and process-local delivery is serialized; target-side persisted identity de-duplication is missing and delivered/cancelled retention incorrectly exhausts the lifetime quota |
| actual Agent status drives availability | Partial | `agent/status=idle` wakes scheduling, but available-member selection only checks active membership and open Team-task ownership |
| provisioning recovery | Partial | interrupted records are failed/reused; persisted child descriptor/parent/initial-message reconciliation is absent |
| safe removal/archive | Implemented for local backend | queued mail is cancelled and retired identities are not reused; distributed leases are out of scope |
| bounded disposal | Missing | runtime awaits admitted Provider operations without a timeout; a hung Provider can block unload |
| bounded attempt history | Missing | fencing is correct, but every retry appends an attempt and no retention limit exists |
| command/HTTP/UI projection | Missing | intentionally not ported into the host-only 0.1 package |

The plugin adds useful behavior not present in that reference: mandatory review state, request/retry/deadline/token budgets, structured Team memory entries and revision-based waiting. These additions do not mean the source reference has been completely absorbed.

## 4. JiuwenSwarm fusion matrix

| Strength in reference | 0.1 status | Boundary |
|---|---|---|
| deterministic SwarmFlow, parallel/pipeline/nested nodes | Missing | rc.8 `ctx.workflowEngine` exists, but no Team bridge is installed |
| stateful members | Implemented | DSH continuable subagents provide the native execution primitive |
| team token/request/retry/time budget | Partial | cumulative local ledger exists; no Workflow reservation, monetary policy or official token-meter adapter |
| human and approval nodes | Missing | published interaction seams are not consumed |
| Worktree option | Missing | no lease and no child cwd override; Jiuwen evidence establishes the product behavior, not code copied into this plugin |
| local/distributed Team and reservation/ACK | Missing | current Store and locks are process-local |
| personal plus shared Team memory and round-end extraction | Partial | only manual structured Team entries exist; no personal/shared visibility split or automatic extraction |
| tiered allow/ask/deny permissions | Partial | member tool visibility/execution deny list plus domain authority checks exist; no team policy language or approval override |
| Skill Evolution | Missing | no signal/proposal/approval/write pipeline |
| Team UI/monitoring tree | Missing | no client package |

## 5. Official DSH pluginization audit

| Official seam | Used now | Assessment |
|---|---|---|
| `ctx.tools` | Yes | 14 model tools are scoped and disposed through Cordis effects |
| `ctx.subagents` | Yes | correct reuse of continuable child lifecycle; no second Agent runtime |
| `ctx.agents` / status events | Yes, partial semantics | lifecycle wakeup is native, but live status is not passed into Scheduler availability |
| Session events | Yes | token events are folded by sequence; model-visible followups enter normal inbox/history |
| Session persistence | Assumed, not declared | durability is advertised while `inject` does not require the persistence service; activation should fail or explicitly declare degraded mode when unavailable |
| `ctx.workflowEngine` / `ctx.jobs` | No | published official seams should host deterministic/background orchestration |
| `ctx.tokenMeter` | No | direct event folding is valid local accounting, but an adapter boundary is needed before integration |
| `ctx.storageDomain` | No | `FileTeamStore` is hardcoded and workspace-writable; ADR-0007 makes the official Storage Domain Provider an M1 authority prerequisite |
| `ctx.workspaceRegistry` | No | useful for Workspace identity only; insufficient for Worktree/cwd isolation |
| questions/approval | No | required for Jiuwen-style human nodes and human review |
| experimental `ctx.agentTeams` | No | correct not to depend on a private package; however the promised backend adapter is not implemented |

The design follows DSH's “everything is a plugin” principle at the outer execution seam, but is not yet thoroughly pluginized internally. Scheduler and Review are the only real Provider registries. Store, budget accounting, memory, workflow, workspace and policy remain embedded or absent.

## 6. Conflict analysis

| Potential conflict | Trigger | Required prevention |
|---|---|---|
| dual canonical Team state | add official `ctx.agentTeams` while retaining private `TeamDomain` writes | one `TeamDomainPort`, exactly one selected backend, explicit migration/reconciliation |
| Scheduler versus Workflow | both assign/retry/settle one task attempt | explicit `adaptive` or `workflow` orchestration mode and one owner lease per run |
| double token accounting/gating | direct Session folding and `ctx.tokenMeter` both mutate budget | one measurement adapter, defined cumulative semantics and idempotency cursor |
| duplicate mailbox authority | custom mailbox and official Team mailbox both deliver | backend owns mailbox end-to-end; overlay only stores linkage |
| memory dual source | manual Team array plus future memory service both canonical | memory service is canonical; Team stores evidence/checkpoint ids only |
| permission disagreement | prompt/tool filter, domain authority and future allow/ask/deny policy overlap | domain authority remains final; policy narrows tool access; prompt is never authorization |

No current active conflict was found between the two references inside the runtime because most overlapping advanced features are not implemented. The table describes integration hazards, not observed simultaneous execution today.

### Self-hosting conflict boundary

ADR-0008 deliberately does not make either reference runtime or the candidate plugin a deployment authority. Self-hosting composes official DSH seams around one `TeamDomainPort`, uses Jiuwen Worktree/permission behavior and the direct reference's fencing/lifecycle cases, then keeps promotion in an external stable controller. The primary new hazards and owners are:

| Hazard | Single owner / prevention |
|---|---|
| running plugin overwrites itself | stable control Profile stays on last-known-good immutable artifact |
| candidate approves/promotes itself | independent Review Providers plus external promotion controller |
| parallel members share files | Workspace Provider gives one real Worktree/cwd/tool root per attempt |
| Git branch/log becomes Team truth | TeamDomainPort remains canonical; Git/Jobs/logs are linked evidence |
| acceptance failure destroys control RPC | separate Profile, port and state root with rollback |
| Skill proposal broadens its own authority | accepted-evidence extraction, deterministic validation and separate approval |

These capabilities are target design. Current 0.1 has not earned D0-D4 readiness.

## 7. Security and execution-flow priorities

### M1 authority and protocol blockers

1. Extract one `TeamDomainPort`, require Session persistence and official Storage Domain, and move authoritative Team aggregates outside the shared workspace without a dual-write fallback.
2. Add target-side stable message identity and recovery lookup so the inbox-acceptance/Store-ack crash window cannot redeliver a peer message.
3. Reconcile provisioning against persisted child descriptor, direct parent and initial inbox/history before activating or failing; drain proven orphans.
4. Align limits with behavior: per-target pending mailbox quota, bounded retained receipts and bounded attempt history.
5. Add configured admission/disposal timeouts and diagnostics so a hung Provider cannot block plugin unload.
6. Feed live Agent availability into Scheduler selection, coalesce usage writes, delimit untrusted model-visible data and carry the accepted compatibility hardening.

### Later official integrations

1. Add a `ctx.workflowEngine`/`ctx.jobs` bridge with explicit orchestration ownership, cancellation and event linkage after M1 authority is stable.
2. Introduce a token-accounting adapter and characterize `ctx.tokenMeter` projection semantics before replacing the existing event-sequence ledger.
3. Add command checks, Reviewer Agent and human approval Providers; manual captain acceptance should remain a visibly configured policy, not an implied security verifier.
4. After M1D, run D1 single-writer dogfood; after Workflow/Jobs, implement the M3 stable-control/Worktree/review/acceptance vertical before allowing parallel self-development.

### P2 product parity

Implement workspace leases/remote members, distributed claims and fencing, automatic memory extraction, skill-evolution proposals, permission policy, human workflow nodes and a client projection as separate packages with failure-injection suites.

## 8. Performance findings

- Every `FileTeamStore` transaction reads, parses, clones, validates and rewrites the whole Team JSON document. Cost grows with retained tasks/messages/memory; a typed incremental backend is needed before large Teams or multiple processes.
- Scheduler wakeups rescan full task/member arrays and currently may queue work onto a non-idle Agent. Status-aware candidate filtering is the first coordination-efficiency fix; indexes/change projections follow only if profiling proves necessary.
- The 14 tool schemas and full status summaries consume model context. Keep Captain/member tool sets role-scoped, add pagination/delta status and avoid returning retained arrays that the caller did not request.
- Direct Session-event token folding is deterministic and replay-safe through sequence cursors, but duplicates an official projection surface. Consolidating measurement reduces maintenance; it does not remove the need for a cumulative Team budget ledger.
- Process-local JSON locks cannot improve distributed throughput or ownership safety. Scale-out requires domain CAS/lease/fencing operations, not a faster generic key-value wrapper.

## 9. Does DSH core need optimization?

Most improvements belong in this plugin family and do **not** require an Agent Loop patch. DSH already exposes the correct tools, subagents, workflow, jobs, token, storage, workspace identity and interaction seams.

One generic upstream capability would materially improve safe coding-agent coordination: allow a continuable-child Provider to receive a validated per-child Workspace/cwd capability at creation, with persistence and sandbox/tool-root agreement. The current creation spec only contributes history seed, and Workspace Registry does not change child cwd. Until such a generic seam exists, use a remote/out-of-process DSH or ACP Session actually started in the leased Worktree. This is a framework-level capability proposal, not permission to add Team-specific logic to Agent Loop.

Promotion/stabilization of official experimental Agent Team is an upstream product decision. The plugin should remain adapter-ready but must not patch or shadow `ctx.agentTeams`.

## 10. Documentation maintenance rule

This file is the implementation-status baseline, not a timeless claim. On every official or reference update, execute Gate A in `11-official-first-development.md`, verify remote refs, installed exports and actual source integration; then update this audit, `09-sources.md`, affected design docs/ADRs, README and the project Skill in one change. A target diagram or roadmap checkbox never counts as proof that code is shipped.

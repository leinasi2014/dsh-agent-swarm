# Legacy feature recovery and deduplication matrix

- Status: recovery decision candidate
- Authoritative base: `79aa240b73922fc4868cb0b17d7dab69dc5efff1`
- Legacy UI/runtime candidate: `0b999cd29c96647493a2c7329dc93f97c6e4051f`
- Shared ancestor: `0a62e839670f5a0467bfa322c58f39b10aa8f894`
- Canonical writable root: `D:\Source\DSH\deepseek-harness\packages\.external\dsh-agent-swarm`
- Legacy root: recovery-only; never a development authority
- Recovery object copy: `D:\Source\DSH\.recovery\dsh-agent-swarm-legacy-20260826-git`

## Purpose and decision rules

This report prevents a repository move or architecture replacement from silently discarding completed behavior. It is a one-time recovery decision, not a live task ledger and not a second product architecture authority.

Every legacy capability receives exactly one disposition:

- `KEEP_MAIN`: current main already owns the required behavior and authority;
- `PORT_TESTS`: preserve useful legacy behavior/oracles but implement against current main;
- `REIMPLEMENT`: product outcome remains required, but the legacy implementation violates current authority or dependency order;
- `HOLD`: preserve the candidate, but do not activate it before its accepted dependency/ADR;
- `ARCHIVE_NOT_PRODUCT`: retain recovery evidence without treating the implementation as a shipped product capability.

No branch, checkout, document, or object may be deleted merely because its architecture is old. Deletion requires authoritative-main containment, an accepted replacement, or durable archive plus an explicit product disposition.

## Repository and candidate findings

- Current main and the legacy candidate diverged after the shared ancestor: main has 37 unique commits and the legacy candidate has 99; 23 core files changed on both lines.
- A read-only merge simulation found 24 textual conflict segments and larger semantic conflicts that Git would otherwise merge silently.
- The legacy candidate deletes accepted current-main HostContext, receipt pagination, restart-safe binding, reviewer candidate identity, managed worktree lifecycle, and policy/isolation/compatibility workflows. It cannot be merged wholesale.
- Unmerged M5/H4 branches form a mostly cumulative prefix stack, not several independent runtime products. Their useful delta is the HumanInteraction effect-correlation behavior and its tests.
- The old clone is clean but contains local refs, divergent branches, reflog and previously unreachable objects. Its `.git` object database has been copied and byte-count checked outside the old root.

## Functional deduplication and recovery decisions

| Capability | Current main evidence | Legacy evidence | Duplicate/new/conflict | Disposition |
|---|---|---|---|---|
| Team aggregate and durable store | `src/domain/team-domain*.ts`, `src/storage/storage-domain-team-store.ts`, `src/storage/team-spec.ts` | Parallel `team-state-v2`, `team-domain-v2-*`, `storage-domain-team-store-v2` | Duplicate authority; legacy creates a second writable Team state machine | `KEEP_MAIN`; archive the V2 implementation |
| Task, DAG, attempt and review | current board plus `review-root`, `review-transaction`, `reviewer-boundary` and attempt-retention tests | V2 task candidate/completion/effect receipts | Core behavior duplicates main; some exact receipt tuple invariants are stronger | `KEEP_MAIN` + `PORT_TESTS` for exact tuple/fault cases |
| Member roster and provisioning | `team-domain-roster`, `member-provisioning`, `member-control` | modified lifecycle, lazy start and skill-policy code | Basic lifecycle duplicates main; lazy/phantom-member semantics are not accepted | `KEEP_MAIN`; `HOLD` lazy-member behavior |
| Provider/model/tools/Skill member details | official durable child descriptor remains the intended authority | legacy stores provider/model/deniedTools/assignedSkills in TeamMember | Desired read projection is new; persisted TeamMember policy is a conflicting second authority | `REIMPLEMENT` later from the official child descriptor through bounded Host/RPC projection |
| Basic permission policy | current `permission-policy`, `permission-surface`, `tool-policy`, reviewer boundary and composition tests | M5 H3 introduced allow/ask/deny behavior | Basic tiers overlap, but this row does not cover the later official-tool inheritance changes | `KEEP_MAIN` basic authority; evaluate the compatibility delta in the next row |
| Official host-tool inheritance and child report/code transport | Baseline `be453d3` lacks inherited downstream authority, `run_code`, and guarded child-scoped `report` pass-through; this feature chain implements them | legacy evidence supplied the compatibility shape | Explicit policy/captain-only/global-report cases remain denied; official downstream guards remain decisive | No second Team policy/store; scoped report bypasses Team membership lookup and returns to the official pipeline. Authority is confirmed only by merged-target readback. |
| Execution roots | current `execution-roots` and `execution-root-surface` with accepted tests | legacy handoff/identity extensions | Main owns the contract; legacy contains useful identity negatives | `KEEP_MAIN` + `PORT_TESTS`; redesign any future handoff |
| Restart binding | `src/runtime/restart-binding.ts` and exact test | replaced by fresh-v2 recovery driver | Legacy replacement removes an accepted fence | `KEEP_MAIN`; archive V2 restart state |
| Mailbox | current Team mailbox domain/tool and bounded receipt behavior | V2 mailbox, cold claim and continuation dispatch | Core mailbox duplicates main; cold continuation is new but V2-coupled | `KEEP_MAIN`; `PORT_TESTS` for bounded/self-message/exact dispatch; continuation is `REIMPLEMENT` |
| Continuation and long-running recovery | no complete current continuation subsystem | legacy fresh-v2 continuation, fold, recovery, restart and task-control chain | Truly new product behavior, but implemented on the rejected second state machine | `HOLD` implementation; later `REIMPLEMENT` on main Team/attempt/review authorities using legacy tests as specification |
| Directed member task (`targetMemberSessionId`) | absent from current main | legacy adds schema/domain/create/cancel/reassign/scheduler/read-surface support and negative tests | Truly new targeted-scheduling behavior; independent of lazy-member creation even though the old branch developed them together | `HOLD` then `REIMPLEMENT` as a scheduler/domain capability against the official durable child identity; preserve the complete legacy behavior/test chain |
| Model interrupt evidence admission and supervision discipline | absent as a complete current-main capability | legacy permits model interrupt only for a Host-observed, unsettled tool call beyond the accepted threshold, returns `TEAM_INTERRUPT_EVIDENCE_REQUIRED`, and adds supervision prompt discipline | Truly new safety boundary for long-running members; old wiring is coupled to legacy runtime assumptions | `HOLD` then `REIMPLEMENT` before enabling autonomous interrupt; port Host-evidence negatives and prompt/transport tests |
| Fresh-v2 state/store/runtime | absent from current main | complete parallel V2 stack | New experimental implementation but violates the single canonical Team owner and depends on an unaccepted migration decision | `HOLD`/archive; never activate or merge wholesale |
| Captain Liaison and official Chat handoff | current `captain-liaison`, official question presentation and tests | M5 H1/H2 and legacy UI handoff | Liaison is duplicate; Details Chat handoff interaction remains useful | `KEEP_MAIN`; port only the R3 Details handoff UI behavior |
| HumanInteraction store/controls | current `src/human/*`, HostContext service, bounded receipt page and tests | cumulative M5 H2/H3/H4/H4a stack | Most behavior is already on main; H4a2 durable effect recovery is a real incremental specification | `KEEP_MAIN`; later `REIMPLEMENT` H4a2 effect recovery on current overlay/Host contracts and port its fault tests |
| Host read producer and read RPC | current R1 internal `host-read-*`, R2 `src/rpc/read-rpc-*`, and `producer-contract` floor | legacy “host contract” is primarily HumanInteraction admission | Not the same RPC capability; no legacy replacement is valid | `KEEP_MAIN` R1/R2 and their current contract |
| Workflow bridge and Jobs | current workflow realm/script/team bridge/run overlay and tests | same inherited workflow foundation | Duplicate | `KEEP_MAIN` |
| Budget | current Team budget, budget-memory tool, workflow carry and tests | same inherited budget family | Duplicate | `KEEP_MAIN` |
| Team memory | current Team aggregate memory and bounded tool behavior | legacy adds memory/profile UI and V2 memory | Basic Team memory duplicates main; target M7 Memory Provider is not implemented correctly on either legacy UI path | `KEEP_MAIN` current behavior; `REIMPLEMENT` M7 as an independent Memory Provider before richer UI |
| Personal/member memory and semantic query | not accepted as a standalone current service | legacy stores/query fields through Team/profile structures | Truly new user outcome, wrong authority | `HOLD`; later `REIMPLEMENT` behind a dedicated Memory Provider and accepted-evidence boundary |
| Skill assignment and Skill Evolution | current product docs require proposal/validation/approval separation | legacy member fields/settings imply direct assignment state | Desired outcome is new; implementation conflicts with official Skill/child-descriptor authority | `HOLD`; later `REIMPLEMENT` through official Skill resolver and explicit approval/write path |
| Team settings card | no accepted standalone settings consumer | legacy settings namespace/card and profile flows | New UI consumer, but configuration owner and live update contract are unresolved | `HOLD`; restore only after official settings seam and precedence/read-back are fixed |
| R3 Team UI surface | current main uses `TeamDashboardOverlay` and an accepted but now superseded overlay design | legacy evolves peek/compact into official `details` slot with coordinator, close behavior and tests | Same feature implemented twice; the user-selected product behavior is the final Details version | `REIMPLEMENT NOW` as a minimal R3 slice on current main; delete Overlay only in the accepted replacement candidate |
| R3 internationalization | current main registers `en`/`zh`, but W0 proof forced `en-US` and did not prove live switching | legacy browser proof performs official `English -> 中文 -> English` on the same mounted panel | Basic dictionaries duplicate; real official-locale synchronization proof is new | `PORT_TESTS` and implementation wiring with the minimal Details R3 slice; no plugin-local language setting |
| Knowledge graph runtime/tools | no current product module | legacy KG tools, generated graph and documents | Truly new implementation, but not a stable product-runtime capability and must not become a second architecture authority | `ARCHIVE_NOT_PRODUCT`; a non-authoritative generated development projection may be proposed separately |
| P0 Profile/member-loop proof | current immutable artifact and clean Profile W0 evidence accepted at `79aa240` | several earlier Profile/smoke generations | Duplicate; current main is the stronger accepted proof | `KEEP_MAIN` |
| Governance, worktree and verification rewrites | current risk-routed gates and managed isolation lifecycle | legacy removes/replaces several accepted controls | Conflicting regression, not product functionality | `KEEP_MAIN`; archive legacy governance rewrite |

## Required recovery order

1. Preserve current main P0/F1/R1/R2, HostContext, receipt pagination, restart binding, reviewer identity, policy routing and managed isolation without change.
2. Recover one minimal R3 feature only: official Details surface, one Team action/close lifecycle, existing R2 read fields, same official Captain Chat handoff, official live locale switching, host theme tokens and current error/stale behavior.
3. Run affected unit/component tests, packed client purity, official `English -> 中文 -> English` browser interaction, Team/Tool Details handoff, real Captain Session handoff, disable/unload and clean Profile proof.
4. After required QA/review passes, immediately integrate R3 into authoritative main and read back target checks before pulling another feature.
5. Recover provider/model/tools/Skill details only after an official child-descriptor read projection exists.
6. Recover official tool inheritance/`run_code`/child `report` only through a dedicated compatibility and permission pipeline with current installed-DSH evidence; do not silently keep either blanket deny or legacy allow behavior.
7. Recover directed member scheduling as its own domain/scheduler pipeline, using the official durable child identity rather than lazy-member or TeamMember policy state.
8. Recover model interrupt admission before autonomous interrupt is enabled: Host-observed unsettled-call evidence, threshold semantics, explicit failure and supervision transport all need current-main tests.
9. Treat M6 execution-root extensions, M7 Memory/Skill, W1 effect recovery and continuation as separate later pipelines. Each starts from integrated main and reuses legacy tests as specification, never the legacy state authority.

## Explicitly preserved but not currently activated

The following are not discarded: fresh-v2 continuation/fault tests, H4a2 effect-correlation tests, directed-member task tests, official tool inheritance/`run_code`/child `report` composition tests, model-interrupt Host-evidence tests, member-profile/settings UI evidence, memory/Skill product ideas, KG artifacts and old runtime candidates. They remain recoverable evidence until their disposition is implemented and integrated or the product authority explicitly retires them. “Not in the current recovery slice” does not mean deleted or completed.

## Completion condition for this recovery decision

This report is integrated only when the authoritative main contains it and target verification passes. It does not itself deliver any recovered product feature. Each later recovery slice must name the legacy evidence it consumes and update only affected stable architecture/roadmap documents in the same candidate.

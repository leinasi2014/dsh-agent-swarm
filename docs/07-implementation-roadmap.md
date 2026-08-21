# 07. Official-first implementation roadmap

Rebased: 2026-08-22 against official DSH `141eb6fef83422698aef7a981029e843e8161534`, `dsh-agent-teams` `fe854d19d20c88d9436d13338f86257f741955c9` and JiuwenSwarm `962f0a4426041d54cef60e980a10491df84546ef`. ADR-0008 adds staged self-hosting readiness and renumbers the post-M2 milestones.

## Gate A — required before every milestone

Every milestone first executes `11-official-first-development.md`:

- verify the current official remote and local/installed target;
- review official rules, package map, subsystem docs, implemented Agent Notes, exports/types/tests and Profile composition;
- classify capabilities as stable, experimental/private, absent or project overlay;
- re-read affected behavior/failure cases in both reference repositories;
- update ownership/conflict/migration tables;
- reject Agent Loop patches, shadow services and dual canonical state.

No milestone enters implementation without this record. A moved official ref reopens the gate.

## Current factual baseline — M1A complete

Implemented:

- host-only `ctx.agentSwarm` façade and 14 scoped model tools;
- DSH continuable members with persona/tool filtering;
- process-local task DAG, revision CAS, attempt fencing and dispatch checkpoints;
- adaptive priority Scheduler and external Scheduler registration contract;
- mandatory submitted/review/completed transition and Review registration contract;
- request/retry/deadline/cumulative token budgets using Session-event sequence folding;
- manual structured Team memory, revision wait and safe removal/archive;
- **M1A**: one `TeamDomainPort` consumed by tools and orchestration; required `sessionPersistence` + `storageDomain` injections with fail-closed composition; the `StorageDomainTeamStore` production Provider over the official `agent_swarm` Storage Domain (one versioned Team aggregate per record, durable migration receipts, per-workspace scope partition); `FileTeamStore` reduced to a read-only offline migration reader; explicit one-way migration CLI with empty-destination enforcement, durable read-back verification, receipt retention and untouched sources; workspace tamper-denial composition evidence;
- 36 tests: 16 protocol, 13 port conformance/schema/version/corruption/close/fault, 5 migration, 2 real rc.8 composition;
- engineering gates mirroring the official DSH toolchain (2026-08-20): oxlint/jscpd/knip lanes inside `pnpm verify`, `noUnused*` typecheck, a 600-line source ceiling with reasoned milestone-due exceptions (team-domain.ts due M1B), LF normalization, lefthook pre-commit lint, GitHub Actions full-matrix CI (references, official evidence, Gate A, coverage) and src-scoped coverage reporting — see `docs/08` §9.

Not complete:

- official Team backend adapter (experimental package unpublished), persisted-child-aware provisioning recovery, bounded disposal;
- live Agent availability gating;
- official Workflow/Jobs, Token Meter, Workspace and interaction integrations;
- Worktree/remote/distributed execution, automatic memory extraction, Skill Evolution, tiered permission policy and UI.

Target-side cross-restart mailbox de-duplication (F2) is implemented: delivery folds the target's durable inbox/history on the stable framed message id before any resend and flushes the accepting target before acknowledging (scenario-5 crash-window test).

The current core remains usable only within its documented process-local limits. It is not evidence that later milestones are complete.

## M0 — governance and evidence baseline (release gate reopened)

Deliverables:

- mandatory official-first constitution, source register, fusion audit and ADR;
- two full pinned reference checkouts;
- official stable/experimental capability ownership map;
- superseded workflow/token-meter claims removed;
- isolated repository and reproducible verification commands.

Exit:

- remote official HEAD/date and all three pins are recorded;
- official implemented Agent Notes and relevant package sources are materially present in the sparse checkout and checked by `pnpm verify:gate-a`;
- `rg` finds no known stale API claim;
- README, Skill, architecture, audit and roadmap agree.
- the repository has a reproducible initial commit; a zero-commit untracked worktree does not satisfy the evidence gate.

Gate A repeats at the start of M1 and every later milestone.

## M1 — canonical Team port and protocol hardening (next release blocker)

### M1A — authority, port and migration — IMPLEMENTED (2026-08-20)

- `sessionPersistence` and `storageDomain` are required injections; a composition missing either keeps the plugin pending (composition-tested);
- `TeamDomainPort` is the sole aggregate authority consumed by tools and orchestration;
- `StorageDomainTeamStore` opens the official `agent_swarm` Storage Domain and stores one versioned Team aggregate per record plus migration receipts, partitioned by canonical workspace scope;
- workspace `FileTeamStore` is removed from the default runtime and retained only as a read-only offline migration reader/fixture;
- `scripts/migrate-legacy-team-store.mjs` migrates only into an empty destination, verifies the durable read-back, retains a receipt and never dual-writes; sources stay untouched;
- the official private `ctx.agentTeams` package remains a semantic target only.

Exit: **met** — F1 and F5 are closed by the real storage composition (workspace files hold no Team authority; a decoy tamper file cannot change authoritative state); port conformance, schema/version, migration, corruption and close tests pass over the real official stack. Stated boundary: this denies ordinary workspace writers, not a process with unrestricted host access; the storage backend root must live outside team workspaces and sandbox roots. Full evidence: `docs/development/2026-08-20-glm53-m1a-report.md`.

### M1B — crash-safe protocol

- fold target inbox/history by stable Team message id before sending or acknowledging — **done (F2, 2026-08-20)**: `sessionPersistence.inspect` reconciliation, exact-frame folding, target flush before the delivered acknowledgement, scenario-5 crash-window and idempotent-rescan tests;
- reconcile provisioning from persisted child descriptor, exact parent and admitted initial inbox/history, then activate or drain — **done (F3, 2026-08-20)**: official four-factor reconciliation (`listChildren` live-preferred enumeration + `sessionPersistence.inspect`), orphan re-activation with member tracking, explicit mismatch drain, indeterminate-evidence failed settlement, scenario-6 crash-window/mismatch/indeterminate tests;
- count mailbox limits per target pending messages, bound retained receipts and preserve ordered replay — **done (F6, 2026-08-20)**: `maxPendingMessagesPerMember` (official default 64) counts queued-minus-delivered mail per target with the official `TEAM_MAILBOX_FULL` code, retained delivered/cancelled receipts are bounded (`maxRetainedMessages`) and pruned oldest-first without ever removing queued mail or breaking creation order/revision continuity, and pre-F6 schema-v1 records (including 1024-message populations) load unchanged (scenario-17 suite);
- bound/prune attempt history without permitting stale attempt ids to become valid again — **done (F7, 2026-08-20)**: `maxRetainedAttempts` (default 64 per task) keeps the current attempt plus the newest N terminal attempts, terminal transitions prune the oldest inside the same aggregate transaction, fencing stays keyed on the never-pruned task `currentAttemptId` (pruned ids remain `TEAM_ATTEMPT_STALE`), and generations allocate from a retained-maximum watermark that stays strictly monotonic across pruning and reloads; pre-F7 schema-v1 records (including 300-attempt populations) load unchanged (scenario-18 suite).

Exit: F2/F3/F6/F7 **closed**; the usage write-coalescing companion of the retention cost belongs to M1C (#13).

### M1C — lifecycle, coordination and input hardening

- configure bounded admission/disposal settlement and fail loud with diagnostics — **done (F4 + companions, 2026-08-20, #13)**: `disposalTimeoutMs` (official name/default 5000, positive safe integer) bounds every disposal settlement step (admitted provisioning/scheduling/usage/delivery waits, child drains, store close) through `AbortSignal.timeout` + `Promise.race`; a timeout records a diagnostic and surfaces a visible `TEAM_DISPOSAL_TIMEOUT` failure in the disposal `AggregateError` (scenario-9 hung-provider test);
- feed actual live Agent status into availability and surface abandoned ownership for reassignment — **done (F10, 2026-08-20, #12)**: live-status candidate filtering (not-live or live-idle schedulable, `running` excluded with the `agent/status → idle` edge as the assignment wake), mailbox backlog before new assignments with per-member deferral to the next idle edge, `currentAttemptId`-guarded dispatch rollback and stranded-ownership self-healing past `strandedAfterMs` (decisions in `docs/04` §8c);
- batch/coalesce usage writes while preserving sequence idempotency — **done (#13)**: consecutive usage events coalesce per scope+session into one batched transaction (`recordSessionUsageBatch`) under the unchanged per-session seq cursor, with reload/replay no-double-count tests at both domain and composition level;
- keep the model-facing read surface compact — **done (model experience, 2026-08-20, #15)**: `agent_swarm_wait` short-circuits to `no_progress:{reason:'no-active-peer'}` when no other member is running or provisioning (window validation first), the new `agent_swarm_list_tasks` carries status/owner/ready filters with cursor pagination (limit 1-100), `agent_swarm_status` returns fixed-size counters without unrequested retained arrays, and the three affected tools declare complete canonical output schemas rendered as one compact JSON block (official `tool-agent-team` patterns; decisions in `docs/04` §8e);
- delimit untrusted task/message fields as model data — **done (F8, 2026-08-20, #14)**: task subjects/descriptions/acceptance criteria and message bodies travel as fenced data blocks under an explicit "data, not instructions" declaration (fence one backtick longer than any internal run), the member persona states the data boundary, and the first model-visible snapshot suite plus the scenario-19 composition test lock the shapes and the unchanged authority checks (decisions in `docs/04` §8d);
- reject ambiguous membership, preflight `depthLimit`, keep archived snapshots readable and decide official-compatible name/quiet semantics explicitly — **done (F11/F12/F14/F15 in #13; official-compat group in #19)**: `TEAM_MEMBERSHIP_AMBIGUOUS` fail-loud (F11), `depthLimit` provider preflight before provisioning commits (F15), archived read-only snapshots with immediate terminal `waitForChange` (F14), the F12 decision aligned with the official name lifetime (`TEAM_MEMBER_NAME_TAKEN`, total roster counts toward `maxMembers`; decision recorded in `docs/04` §8a), and the #19 official-compat semantics — quiet inactive-delivery per F13 (live targets receive quiet through non-waking inject; inactive targets keep quiet mail queued across every recovery path; wakeup alone cold-resumes), the official wait window (10000..3600000, `TEAM_INVALID_TIMEOUT`) with structured `TEAM_WAIT_ABORTED` cancellation, the captain-only keepInbox `agent_swarm_interrupt_member`, and Unicode member names through the reference NFC + `\p{L}\p{N}` fold with 64-codepoint rejection (decisions and divergences in `docs/04` §8b and the ADR-0002 appendix; scenario-20 suite).

Exit: F4, F8, F10 and accepted companion findings pass lifecycle, scheduling, prompt snapshot and compatibility tests. F4, F11-F15, usage coalescing, the #19 official-compat semantics group, F10 (live-status scheduling with stranded-ownership self-healing, #12), F8 (untrusted-content delimiting + prompt snapshots, #14) and the #15 tool-layer model-experience group are closed; every M1C issue is closed.

### M1D — assembled acceptance

- boot a real rc.8-seam Profile with Storage Domain, KV backend, Session persistence and this Bundle;
- prove clean load, `--dump-config`, reload, recovery and bounded teardown on Windows;
- run `pnpm verify:gate-a`, the complete project suite and package artifact checks;
- provide the original report, intake, exact remediation diff and test evidence to an autonomous GLM-5.3 regression/security review.

Exit: every accepted M1 blocker is closed, no P0/P1 regression remains, the independent reviewer controls the final verdict, and the repository points to a committed reproducible revision.

Dogfood gate D1: after this exit, an isolated last-known-good Profile may run a Lead, read-only reviewers and exactly one coding writer at a time. Promotion remains manual; parallel writers and automatic self-upgrade remain forbidden.

## M2 — official Workflow/Jobs orchestration mode

Official integration:

- implement a Consumer of `ctx.workflowEngine` and `ctx.jobs`;
- store stable Workflow run/link ids in the orchestration overlay;
- expose explicit `adaptive` or `workflow` mode; exactly one owner assigns, retries, cancels and settles an attempt;
- project phases/events/status without copying Workflow state.

Progress (2026-08-21, issue #75 / M2-1): the Team bridge workflow engine is implemented — an implementation of the official abstract `WorkflowEngine` registered in an isolated `workflowEngine` service scope (never over the default-scope official engine), whose runs are backed by a Team aggregate (captain = the start request's parent; every `agent()` call drives member provisioning, task creation, scheduler assignment, member submission and the captain review gate). The durable run overlay lives in the new `agent_swarm_workflow` Storage Domain and is the only run truth (nested Team runs have no official durable record — planning-note trap 1); crash recovery reclassifies interrupted runs evidence-only. Real-composition tests run the bridge beside the official `dsh-workflow/invariant` companion (event-stream pairing validated by the official checker) and cover run completion, bounded cancellation with synthesized agent ends, crash-recovery overlay reload, the synchronous official error surface, and default-off zero-change. Design note: `docs/development/2026-08-21-m2a-workflow-bridge-design.md`; protocol decisions: `docs/04` §8f. Progress (2026-08-21, issue #77 / M2-3): the explicit orchestration-mode surface is implemented — `orchestrationMode: 'adaptive' | 'workflow'` (default `adaptive` is byte-identical to main while no run is live; `workflow` deactivates the autonomous event face and requires the bridge, failing activation closed otherwise), a process-local per-Team orchestration ownership registry with structured `TEAM_ORCHESTRATION_OWNER_CONFLICT` (a live run owns its Team from the durable `running` overlay commit to its terminal settle; autonomous entries — idle-edge passes, stranded heal, re-kick — defer to the owner in either mode; the run drives its own Team through an ownership-gated idle driver because `startContinuable` resolves at the join turn's inbox acceptance), and mode switching argued as structured rejection at the seams plus controlled convergence at the dispose/reload boundary (no mid-flight switch API, deliberately). Dual-owner adversarial tests (docs/08 scenario 31) park a workflow run mid-assignment and attack the same Team from a second face — late stale claims, current-revision claims, foreign submits, bogus attempt ids, and a real operation-triggered scheduling pass — proving the unchanged revision CAS/attempt fencing rejects every latecomer with zero state corruption, exactly one assignment frame delivered (no double wake), and a single-counted shared budget; red→green is evidenced by local mutation runs (claim CAS, submit fences, ownership registry, mode gates). Design note: `docs/development/2026-08-21-m2c-modes-design.md`; protocol decisions: `docs/04` §8g. Progress (2026-08-21, issue #78 / M2-4): the Jiuwen node-type mapping is implemented as a pattern-layer composition aid over the task DAG — `src/patterns/node-mapping.ts` compiles the five Jiuwen node kinds (phase/parallel/pipeline/nested/human, plus the plain `task` base unit) into a topological `create_task`/`blocked_by` call sequence plus resolved human review-gate descriptors, applied through `runtime.createTask` only (the board stays the single authority; the builder holds no state; the #75 script realm and #77 mode surface are consumed, not changed). Fan-out rides the existing member/mailbox quotas as its only backpressure; failure holds the chain (reject → pending + retry charge; downstream `ready=false` until rework or explicit resolution); pipeline artifacts ride the upstream task's board output plus Team mail; nested self-Teams reuse the F11 face bounded by the ambiguity check and the delegation-depth cap; human legs gate at the review transaction's manual provider. Five-node real-composition tests plus compiler validation live in `tests/node-mapping.spec.ts` (docs/08 scenario 33). Design note: `docs/development/2026-08-21-m2d-node-mapping-design.md`; protocol decisions: `docs/04` §8i. Both M2 carry-overs are closed: the model-facing jobs reader landed with issue #93 as `agent_swarm_list_jobs`, and the official consumers' UI projection verification was closed at M3 entry (issue #94 — the official rc.8 web job list is shape-compatible with `team-task` records with zero field mismatch, but reads only the default-scope registry, so the isolated-scope projection stays invisible to it by design; counterpart record in `docs/09` §1).

Progress (2026-08-21, issue #76 / M2-2): the Team bridge job registry is implemented — `TeamJobProjection`, an implementation of the official abstract `JobRegistry` registered in an isolated `jobs` service scope (never over the default-scope official registry) behind `jobsBridge: true` (default false). The job face is a read-only projection of the authoritative task board: one `team-task-N` job per task that has entered execution (attempt generations and review-reject requeues are internal to the running job), first-wins terminal settlement (`completed`/`failed`/`killed`) derived from post-durability `domain/changed` snapshots and explicit `watchScope` seeds, with no projection store — crash recovery re-derives byte-identical records from the aggregate. `start`/`kill` refuse work loudly (creation and cancellation stay on the Team face — the projection is strictly one-way). Real-composition tests prove dual-face consistency with the M2-1 bridge (the same Team state change observed on the official `workflow/*` event stream and the official jobs face with the `dsh-jobs/invariant` companion composed over the projection), the cancellation→`killed` mapping with the refusal surface, crash-recovery rebuild, and default-off zero-change. Design note: `docs/development/2026-08-21-m2b-jobs-bridge-design.md`; protocol decisions: `docs/04` §8g.

Progress (2026-08-21, issue #78 / M2-4): the Jiuwen node-type mapping is implemented as a pattern-layer composition aid over the task DAG — `src/patterns/node-mapping.ts` compiles the five Jiuwen node kinds (phase/parallel/pipeline/nested/human, plus the plain `task` base unit) into a topological `create_task`/`blocked_by` call sequence plus resolved human review-gate descriptors, applied through `runtime.createTask` only (the board stays the single authority; the builder holds no state; the #75 script realm and #77 mode surface are consumed, not changed). Fan-out rides the existing member/mailbox quotas as its only backpressure; failure holds the chain (reject → pending + retry charge; downstream `ready=false` until rework or explicit resolution); pipeline artifacts ride the upstream task's board output plus Team mail; nested self-Teams reuse the F11 face bounded by the ambiguity check and the delegation-depth cap; human legs gate at the review transaction's manual provider. Five-node real-composition tests plus compiler validation live in `tests/node-mapping.spec.ts` (docs/08 scenario 33). Design note: `docs/development/2026-08-21-m2d-node-mapping-design.md`; protocol decisions: `docs/04` §8i. Both M2 carry-overs are closed: the model-facing jobs reader landed with issue #93 as `agent_swarm_list_jobs`, and the official consumers' UI projection verification was closed at M3 entry (issue #94 — the official rc.8 web job list is shape-compatible with `team-task` records with zero field mismatch, but reads only the default-scope registry, so the isolated-scope projection stays invisible to it by design; counterpart record in `docs/09` §1).

Progress (2026-08-22, issue #79 / M2-5): the Team budget is shared across runs and the wake-budget semantics are closed — the budget lifecycle is decoupled from the workflow run (a run still owns exactly one Team per the #75 mapping, but a captain's sequential runs consume one carried ledger: the new run's fresh Team adopts the most recent prior run Team's final budget face through the single-transaction domain `adoptBudget`, sourced purely from durable overlay+aggregate state, zero schema change); wake deliveries of both orchestration faces charge the single `claimTask`-seated ledger exactly once (audit conclusion: the bridge keeps no bypass counter — verified quantitatively, nothing to fold in); and a scheduling pass rejected by the budget admission gate routes its structured `TEAM_BUDGET_*` error through the orchestration-ownership registry to the owning run, which converges to a bounded `error` terminal (grace-backed, paired event stream, archived Team) instead of parking on the unseatable claim — adaptive Teams keep the logged-diagnostic-only behavior byte-identically. Real-composition tests (docs/08 scenario 33) prove cross-run continuity, both faces' single counting, exhaustion convergence and reload consistency with replayed usage batches folding free; red→green is evidenced by local mutation runs (notify no-op → convergence hangs; carry skip → run 2 starts from a zero ledger). Design note: `docs/development/2026-08-22-m2e-budget-runs-design.md`; protocol decisions: `docs/04` §8h.

Reference fusion:

- map Jiuwen phase, parallel, pipeline, nested workflow and stateful-agent-session behavior to official Workflow scripts/events;
- add human nodes through official questions/approval services;
- keep Team budget shared across linked runs — done (M2-5, issue #79): sequential runs of one captain consume one carried ledger (`docs/04` §8h).

Exit:

- deterministic and adaptive modes are replaceable by Profile config;
- dual-owner fault tests prove no duplicate assignment/settlement;
- cancellation, background completion wakeup, reload and status disclosure use official services;
- worker-thread execution is documented as isolation from the event loop, not a security sandbox.

## M3 — supervised self-hosting safety vertical

Official integration:

- compose M2 Workflow/Jobs observation with the canonical Team port; every long operation has a stable run id, cancellation and completion disclosure;
- use `ctx.workspaceRegistry` only for identity/linkage and start each coding attempt in an out-of-process DSH/ACP Session whose actual cwd and tool roots match a unique Worktree lease;
- consume target-verified permission/sandbox/tool enforcement points and official interaction seams for the minimum command-check, independent Reviewer and optional human promotion gates;
- keep the stable control Profile on a last-known-good artifact and load each frozen candidate into a separate acceptance Profile, port and state root.

Progress (2026-08-20, issue #93 / M3 entry gate): the model-facing jobs reader is implemented — `agent_swarm_list_jobs` (read-surface module group; the tool surface is now 17) reads only the #76 `TeamJobProjection` (`list()` snapshots, never the authoritative domain, never `read()`/`wait()` which mark `reported`), with kind/status filters determined by the projected `JobSnapshot` shape (no team field — correlation rides `detail`), list_tasks-aligned cursor pagination and compact-JSON canonical output, and the structured `TEAM_JOBS_BRIDGE_DISABLED` error when the projection is not mounted (fail loud over an empty-list lie or a domain fallback). Tests: `tests/jobs-reader.spec.ts`. Protocol decisions: `docs/04` §8h.

Progress (2026-08-22, issue #94 / M3 entry gate): the official consumers' UI projection verification is closed — official rc.8 does consume `ctx.jobs` in the web UI, through exactly one view (the `dsh-client-ui-jobs` session-header popover over whole-snapshot `session/jobs` frames pushed by the host-plane api-proxy), and the M2-2 `team-task` record shape renders losslessly in it: kind/label/detail/status all display (the `detail` correlation string replaces the generic status word; an unknown kind renders as its raw text — the designed open-string extension path), duration and ordering ride `startedAt`/`finishedAt`, the three wire-dropped fields (`ownerSession`/`reported`/`outputLimitBytes`) are dropped by design, and no field mismatch exists, so no fix issue was opened. Registered boundary (deliberate, not a defect): the official UI carrier reads only the default-scope registry while `TeamJobProjection` registers under `ctx.isolate('jobs')` — a same-process official web-app job list therefore shows no `team-task` rows (shape-compatible, scope-invisible); surfacing Team tasks there is a separate composition decision that must not take over the default-scope registry (#76 red line). Evidence and counterpart record: `docs/09` §1 (M3 entry gate bullet); fusion-audit registration: `docs/10` §5 jobs seam row.

Reference fusion:

- implement Jiuwen's `isolation=worktree` behavior for the local dogfood path: immutable base, unique branch/lease, freeze, verify, merge gate and cleanup;
- preserve `dsh-agent-teams` attempt fencing, status-driven scheduling, durable mailbox and lifecycle behavior while exposing failures as Team/Job evidence;
- convert observed load, coordination, review and rollback failures into new canonical tasks rather than letting a candidate mutate control state.

Exit:

- two coding members can work in parallel without sharing a mutable checkout, and shell/filesystem roots match the advertised lease;
- canonical completion requires executable checks plus an independent Reviewer; frozen evidence cannot be rewritten by the Worker;
- candidate build, artifact digest, isolated RPC/Profile boot, reload/recovery checks, rejection and rollback are reproducible;
- the running control Profile is never overwritten or linked to mutable candidate output;
- late attempt/lease updates, merge races, port conflicts, failed cleanup and candidate boot failure pass fault tests;
- D2 supervised parallel self-development is approved by an independent security/regression review.

M3 is a vertical dogfood slice, not completion of the full permission, remote Workspace or release product families. Their Providers are broadened and hardened in M5, M6 and M9.

Historical reports created before ADR-0008 retain their original milestone numbers. Interpret their old M3/M4/M5/M6/M7/M8 labels as current M4/M5/M6/M7/M8/M9 respectively; immutable reviewer reports are not rewritten.

## M4 — accounting and scalable Store Providers

Official integration:

- define one token-measurement adapter and characterize `ctx.tokenMeter` current-request/context projections;
- retain one cumulative Team budget ledger; remove or disable direct Session folding when the official adapter owns measurement;
- retain the M1 `ctx.storageDomain` local Provider and add a separate atomic Store Provider only when a distributed Consumer exists.

Reference fusion:

- preserve Jiuwen shared budget spent/remaining behavior and per-run reservations;
- preserve dsh-agent-teams process-local serialization cases while making backend capabilities explicit.

Exit:

- replay/resume cannot double count tokens;
- measurement backends pass one accounting conformance suite;
- accounting replay tests and distributed-store CAS/lease/fencing conformance pass for the Providers that exist;
- local backend never claims cross-process safety.

## M5 — verification and permission Provider family

Official integration:

- command/check, Reviewer Agent and human approval Providers;
- integrate official interaction/permission/sandbox/tool seams; domain authority remains final;
- separate verification evidence/artifacts from mutable worker output.

Reference fusion:

- adapt Jiuwen tiered allow/ask/deny and human-intervention behavior as policy requirements, not by importing its Permission Engine;
- keep current mandatory review transition and add independent verification.

Exit:

- canonical completion cannot bypass the selected gate;
- parameter/path policy, reviewer compromise, command timeout and approval replay tests pass;
- prompt/tool descriptions are never treated as authorization.

## M6 — real Workspace isolation and remote member Provider

Official integration:

- use `ctx.workspaceRegistry` for Workspace identity/membership only;
- allocate per-attempt lease and start the actual execution Session/tool capability in the leased cwd;
- first implementation uses a remote/out-of-process DSH/ACP Provider unless DSH has added a generic continuable-child Workspace/cwd seam;
- propose that generic upstream seam rather than patch Agent Loop.

Reference fusion:

- implement Jiuwen's `isolation=worktree` product contract: unique branch/worktree, freeze, verify, merge gate and cleanup;
- adapt distributed discovery/reservation/bootstrap/ACK failure cases;
- preserve attempt fencing across lease generations.

Exit:

- two coding members never share a mutable checkout;
- shell/fs/sandbox roots match the advertised cwd;
- late ACK, expired lease, disconnect, merge conflict and cleanup-failure tests pass;
- no prompt-only isolation claim remains.

## M7 — automatic Team memory and Skill Evolution

Official integration:

- memory extractor consumes accepted task/run evidence and writes through the selected memory capability;
- Team stores evidence/checkpoint ids rather than a second canonical memory copy;
- Skill Evolution uses official skill and approval seams with proposal/validation/write separation.

Reference fusion:

- implement Jiuwen personal writable memory, shared read-only Team memory and accepted-round extraction semantics where compatible;
- implement failure/user-correction/review-rejection signals, rails, proposal approval and deterministic validation.

Exit:

- extraction/evolution can be disabled without Team correctness changes;
- provenance, de-duplication, visibility, size limits and malicious-memory tests pass;
- no Agent silently rewrites a Skill without policy approval.

Dogfood gate D3: accepted failure/review/user-correction evidence may now feed Team memory and Skill proposals, but validation and approval remain separate from the proposing Worker/candidate.

## M8 — distributed atomic Team and observability

Official integration:

- add a Store Provider with domain CAS, leases, fencing, idempotent mailbox operations and change feeds;
- add remote member metrics and Jobs/UI projections without making logs/UI authoritative.

Reference fusion:

- use Jiuwen reservation/bootstrap/teardown and partition failure cases;
- retain `dsh-agent-teams` status-driven reuse, takeover and archive semantics.

Exit:

- multi-process fault tests prove single owner, stale-generation rejection and ordered idempotent delivery;
- partitions stop unprovable work;
- observability exposes stable ids, owners, phases, budgets and cancellation safely.

## M9 — client, migration and release

- optional client package projects authoritative roster/DAG/run/workspace/budget/review state;
- migration tool imports supported community `.agent-teams` state through the canonical port;
- official experimental Team promotion, if it occurred, triggers Gate C and a one-authority migration to the official backend;
- publish compatibility matrix, upgrade/rollback notes and isolated Bundle defaults.

Exit:

- client mount/dispose and HMR tests pass;
- UI is never required for runtime progress;
- packed artifacts, local link, `--dump-config`, real Profile and model-visible snapshots pass;
- experimental/remote/distributed Providers remain explicit opt-ins.

Dogfood gate D4: unattended/distributed operation is allowed only after M8 ownership/fencing and M9 release/rollback evidence both pass. Local D2 success is not evidence of D4 readiness.

## Permanent work rules

- Every non-trivial milestone begins with an ADR/Agent Note containing the Gate A record.
- Implement no abstraction without a current Consumer or second Provider.
- Fix the introducing milestone before stacking dependent features.
- One state domain, one canonical owner; one transition, one owner.
- Official stable seams are consumed, never shadowed.
- Reference repositories contribute characterized behavior, not runtime duplication.
- Milestone status changes only with executable evidence and synchronized documentation.
- Self-hosting follows ADR-0008: stable control and candidate acceptance Profiles are separate, promotion is externally owned, and no running plugin overwrites itself in place.

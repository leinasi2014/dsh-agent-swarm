# 08. Testing and verification

## 1. Test layers

| Layer | Purpose | Examples |
|---|---|---|
| Pure/unit | DAG, transition, budget arithmetic, path normalization | cycle rejection, exact token limit |
| Provider contract | every Provider obeys one Service Definition | JSON/SQLite/Redis store conformance |
| Lifecycle | admission, rollback, disposal, reload | orphan child cleanup, route removal |
| Fault matrix | concurrency/restart/late delivery | stale attempt storms, lease expiry |
| Real composition | Loader, Profile, Bundle and actual services | boot test `cordis.yml`, local link install |
| Snapshot | model-visible tool/prompt/transcript | status, claim, stale error, review rejection |
| E2E | real model/provider behavior where needed | continuable child and remote worker |
| Client | projection, dispose, navigation | panel mounts/unmounts; no duplicate polling |

## 2. Minimum gate for every package

- `pnpm verify:gate-a` completed at the start of development, with official/reference remotes, materialized evidence, clean pins and package baseline recorded or a visible network limitation;
- official stable/experimental ownership and Profile composition reviewed; no service/state-machine shadowing;
- strict typecheck;
- build from clean tree;
- package exports point to real artifacts;
- Bundle patch parses and row name resolves;
- each registration disappears on dispose;
- invalid configuration fails visibly;
- README/JSDoc updated with behavior;
- known limitations documented;
- no credentials or machine-specific absolute paths.

## 3. Team protocol matrix

Required scenarios:

1. two concurrent claims with the same task revision;
2. reassign while old member is running;
3. 50+ late updates using invalid attempt ids;
4. delivery failure after mailbox persistence;
5. crash after target inbox acceptance but before delivered ack;
6. member spawn success followed by Team-state commit failure;
7. removal while member owns open work;
8. DAG mutation creating self, duplicate, missing or cyclic dependency;
9. plugin disposal during admitted spawn/message/claim;
10. restart with open claimed/in-progress/submitted/verifying runs;
11. exact limits for bytes, tasks, members and tokens;
12. multi-byte message at byte limit;
13. review rejection and retry with fresh attempt;
14. Worktree cleanup failure;
15. remote reservation expiry and late ACK.
16. a workspace member attempts to forge captain/task/budget state and cannot reach the authoritative Storage Domain;
17. send and acknowledge more than the pending-mail quota over time without permanent mailbox exhaustion;
18. repeated reject/reassign cycles keep retained attempt history bounded while every stale attempt remains rejected;
19. task descriptions and peer messages containing instruction-like text remain delimited model data;
20. ambiguous membership, missing `depthLimit`, archived read and quiet inactive-delivery compatibility cases.
21. two coding attempts receive distinct branches, Worktrees, cwd values and filesystem/tool roots;
22. a Worker cannot write the stable artifact, control storage, credentials, official checkout or either reference checkout;
23. frozen commit/artifact evidence cannot be changed by the submitting Worker or candidate Profile;
24. command failure, Reviewer rejection and human denial prevent canonical completion and promotion;
25. stale attempt/lease, late bootstrap ACK and a competing merge cannot promote a candidate;
26. candidate Profile load, inject, port, reload, recovery or teardown failure preserves the last-known-good control Profile;
27. acceptance Profile state and RPC endpoint are isolated from the control Profile;
28. promotion and rollback record exact commits, artifact digests, Profile identity and evidence ids;
29. retry/recursion, process concurrency and artifact/diagnostic retention limits contain faults without imposing a model-cost convergence policy;
30. observed dogfood defects become fresh fenced tasks with regression evidence rather than direct canonical-state edits.
31. two orchestration faces driving one Team concurrently (a parked workflow run plus late claims, foreign submits, bogus attempt ids and a real operation-triggered scheduling pass) are fenced apart with zero state corruption and a single-counted shared budget;
32. explicit orchestration-mode discipline: workflow mode without a driver fails activation closed, idle edges schedule nothing without a run, a run drives its own Team, and a run-owned Team suppresses the stranded self-heal past the grace;
33. the five Jiuwen node types (phase/parallel/pipeline/nested/human) compile onto the Team task DAG as pure `create_task`/`blocked_by` composition sugar — authority stays on the board; fan-out rides the member/mailbox quotas as its only backpressure, a failed stage holds the chain until rework releases it, pipeline artifacts ride task output plus Team mail, human legs gate at the review transaction, and nested self-Teams are bounded by the F11 ambiguity face and the delegation-depth cap.
32. explicit orchestration-mode discipline: workflow mode without a driver fails activation closed, idle edges schedule nothing without a run, a run drives its own Team, and a run-owned Team suppresses the stranded self-heal past the grace.
33. one Team budget ledger spans sequential workflow runs of a captain (set once, consumed by many runs through a durable carried face), wake deliveries of BOTH orchestration faces charge that single ledger exactly once, budget exhaustion converges the run to a bounded structured terminal instead of parking, and the carried ledger plus per-seq usage cursors stay consistent across a full storage reload.
34. usage settlement loss faces stay closed: a billing flush resolves its ledger while the member row is still provisioning (the authority face refuses, the billing face resolves), usage observed during runtime closing folds instead of dropping at the entry gate, activation roster recovery folds a cold member's dropped usage exactly once from persisted history (cursor-idempotent on repeats), a late live flush after a recovery refold is cursor-skipped so both writer lanes count each event once, and one batch's out-of-order arrivals fold exactly once with replay free.

## 4. Real Profile verification

```sh
pnpm install
pnpm verify:gate-a
pnpm build
pnpm verify

dsh plugin --profile agent-swarm-check add link:/absolute/path/to/dsh-agent-swarm
dsh --profile agent-swarm-check --dump-config
dsh --profile agent-swarm-check "调用 agent_swarm_status"
```

For Web/client packages, start an isolated port and inspect browser console plus mount/dispose behavior. Do not test against the user’s normal Profile while developing.

### Self-hosting Profile verification

D0/D1 requires a dedicated check/control Profile on a last-known-good artifact and manual promotion. D2 additionally requires a separately rooted acceptance Profile and RPC endpoint. A passing unit suite or in-process Loader test cannot substitute for:

1. packing/freezing the candidate at an exact commit and digest;
2. installing it into the acceptance Profile without changing the control Profile;
3. proving actual Worktree cwd/shell/filesystem roots for every coding Session;
4. exercising RPC tools, Jobs, reload, crash recovery, rejection and rollback;
5. verifying the stable control RPC remains healthy after every candidate failure.

## 5. Windows verification

Because the target location is `D:\Source`:

- use forward slash in `link:D:/Source/...` package spec;
- test file replacement while antivirus/editor holds a target handle;
- normalize path comparison without destroying drive/UNC semantics;
- keep all docs/files UTF-8;
- avoid shell-only assumptions in npm scripts;
- verify Worktree cleanup after process termination;
- test PowerShell provider separately from Bash behavior.

## 6. Observability

Every long operation should expose:

- stable operation/run id;
- owner/team/task/member;
- phase and last transition;
- start/update timestamps from the authoritative event/store;
- budget usage;
- workspace/remote lease identity;
- diagnostic safe for display without secrets;
- cancellation/disposal result.

Logs are not the state source. UI snapshots and metrics derive from committed records/events.

## 7. Current implementation verification

The post-M1A core has twenty-eight executable suites (the per-suite bullets below cover the M1 lineage plus the M2-3/M2-4 and #93 additions; the M2-1/M2-2/M2-5 bridge and budget suites are described in their docs/04 §8f/§8h/§8j decision sections and design notes):

- `tests/team-domain.spec.ts`: 20 protocol tests over the real official storage stack covering concurrent claims, review gating, stale attempts, DAG validation, budgets, full-frame byte limits, semantically corrupt stored state without absolute-path disclosure (a zod-valid record failing the deep invariant check), usage de-duplication including out-of-order coalesced batches folding completely under the seq cursor (issue #45), interrupted-provisioning **failure settlement** with the retired name kept occupied under the official F12 lifetime rule, safe removal/archive, revision waiting, and queued-mail durability across a full storage reopen; the F6 mailbox-retention tests add per-target pending admission with the official `TEAM_MAILBOX_FULL` code, quota+10 send/acknowledge cycles without mailbox exhaustion, oldest-first retained-receipt pruning that never removes queued mail (creation order, revision continuity and reload replay intact), cancel-path pruning on member removal, and a hand-written pre-F6 `schemaVersion: 1` record holding 1024 retained messages that loads unchanged and keeps correct semantics past the old lifetime cap (scenario 17);
- `tests/team-assignment-checkpoint.spec.ts`: 4 assignment-delivery checkpoint tests over the same real official storage stack (issue #45): delivery is recorded separately without changing the task revision, the checkpoint is fenced by the exact attempt only — tolerant of concurrent non-task aggregate writes (usage accounting, mailbox acknowledgements) and of task metadata revision bumps between dispatch and ack, either of which used to strand the attempt `reserved` (the pre-#45 revision CAS rejected the latter with `TEAM_TASK_STALE_REVISION`) — and an acknowledgement whose attempt lost the fencing race still rejects with `TEAM_ATTEMPT_STALE`;
- `tests/team-attempt-retention.spec.ts`: 3 F7 attempt-retention tests over the same real official storage stack: 12 claim/reassign cycles bounded to the newest terminal window per task with a bounded unit file (4227 bytes retained versus 6801 unpruned), strictly monotonic fencing generations across pruning and full reloads, pruned-id submissions still rejected with exactly `TEAM_ATTEMPT_STALE` (including post-reload and legacy-record cases), the referenced current attempt of a completed task surviving pruning, and a hand-written pre-F7 `schemaVersion: 1` record holding 300 terminal attempts that loads unchanged, fences its next generation from the retained maximum (301, then 302 — never a reused historical one) and prunes lazily on its next terminal transition (scenario 18);
- `tests/team-domain-port.spec.ts`: 13 port-conformance tests over the real `dsh-storage` + `dsh-storage-json` + `dsh-storage-domain` composition: scope isolation, durable reopen, no-op transactions, captain/id uniqueness, revision-wait wake/abort, `version-mismatch` and `invalid-record` rejection at reopen, closed-store lifecycle (reads/writes/waiters rejected, domain name freed after close), backend durability failure leaving state untouched, failed migration import retried, **fail-closed plugin activation** (no persistence / no storage stack keeps the plugin pending; the full composition activates and serves tools), and the domain error vocabulary;
- `tests/migration.spec.ts`: 5 migration tests: validated aggregates migrate with durable read-back, SHA-256 receipts and byte-identical sources, re-runs are idempotent skips, and records survive a storage reopen; non-empty destinations (same id / same active captain) and invalid legacy sources abort without writing; injected backend write failures abort without a receipt and then recover; a receipt without its record is an inconsistent destination;
- `tests/dsh-composition.spec.ts`: 3 real-composition tests mount actual Cordis + AgentLoop + JSONL persistence + Storage hub + json KV backend + Storage Domain + Subagent + in-process spawn rc.8 services, then verify tool registration, model-visible structured Team errors, custom and missing Scheduler/Review Providers, continuable member creation, automatic dispatch, complete billed-token accounting including cache fields (settled via wait, no accounting race — including the tamper-path check, which since issue #114 waits for exact equality because the official settlement notice wakes the captain into one more billed turn after every member turn completion, racing any immediate read), review, durable state, plugin reload over the same storage root with the budget still matching the adapter exactly after the reload's cursor refold, queued-mail retry, cold resume/disposal, retained child ownership when activation commit plus immediate drain both fail, **no Team state files in the shared workspace**, **workspace tamper denial** (a decoy legacy state file cannot alter authoritative state), and **bounded disposal** (scenario 9: a registered provider whose continuable preparation never settles keeps the admitted addMember unsettled, and `dispose` returns within `disposalTimeoutMs` failing loud with `TEAM_DISPOSAL_TIMEOUT` while the admitted provisioning record stays durable);
- `tests/message-delivery.spec.ts`: 2 mailbox crash-window tests over the same real composition (AgentLoop + continuable spawn members + JSONL persistence + the storage stack harness): scenario 5 injects the kill -9 half-window (real followup acceptance checkpointed durably, one rejected `acknowledgeMessage` write, member drained cold) and proves the reload rescan folds the already-accepted stable message id into a make-up acknowledgement — exactly one model-visible copy at the target, exactly one followup; the idempotency test repeats the rescan while the ack store stays down and proves repeated `deliverQueuedMessage` calls never add a second copy, then commits the pending ack once the store recovers;
- `tests/wakeup-visibility.spec.ts`: 2 waking-visibility tests over the same real composition (issue #52 / D1): a wakeup parked pending behind a held member turn is NOT acknowledged (`phase: queued` — pending-inbox acceptance is transient; official turn teardown and Activation disposal drains discard unclaimed inbox work), survives an explicit discard drain still queued, and is redelivered exactly once with the acknowledgement committing only on the claimed `user/message` history form; the fast path proves an idle target's claim (which precedes its first model request) still acknowledges in-send;
- `tests/assignment-visibility.spec.ts`: 2 assignment-visibility tests over the same real composition (issue #60 / P2-1, the #52 gate's assignment isomorph): a member self-claims a ready task while its turn is held, so the next scheduling pass delivers the reserved assignment frame into the RUNNING member where it parks pending — the attempt stays `reserved` past the claim grace (never acknowledged on the transient form), survives an explicit discard drain (the official reload/shutdown clearing path) still reserved, and the reload-recovery pass redelivers exactly once (exactly two assignment followups) with the checkpoint committing only on the claimed `user/message` form of the SAME fenced attempt; the fast path proves an idle/cold member's claim (which precedes its first model request) still commits the checkpoint within the drive — `delivered` always implies the claimed form;
- `tests/team-domain-m1c-hardening.spec.ts`: 5 M1C companion-hardening tests over the real official storage stack (issue #13): ambiguous membership across two active teams fails loud with `TEAM_MEMBERSHIP_AMBIGUOUS` naming both team ids (F11), retired member names stay occupied for the Team's lifetime with the total roster counting toward `maxMembers` under the official `TEAM_MEMBER_NAME_TAKEN` code (F12), the archived captain reads terminal snapshots — `waitForChange` returns immediately even at a current cursor because an archived Team can never commit a later revision — while mutations stay `TEAM_ARCHIVED`-rejected and the read path prefers the captain's next active Team (F14), and coalesced usage batches stay sequence-cursor idempotent across a full storage reopen without double-counting (usage write coalescing);
- `tests/team-domain-unicode-names.spec.ts`: 3 Unicode member-name tests over the same real official storage stack (issue #19): distinct CJK/Cyrillic names provision, address and remove correctly with mail targets resolving to the exact rows, canonically equivalent inputs (NFC composition, case, separator runs) fold onto one identity with `TEAM_MEMBER_NAME_TAKEN` on the duplicate, and over-length (65 code points against the admitted 64), letter-less and reserved (`captain`) names are rejected `TEAM_MEMBER_NAME_INVALID`/`TEAM_MEMBER_NAME_RESERVED` instead of digest-synthesized;
- `tests/scheduling-discipline.spec.ts`: 3 live-status scheduling-discipline tests over the same real composition as the mailbox suite (issue #12 / F10): a live `running` member is never selected for a new assignment (the task waits for the idle edge) while an idle/cold member receives work in the same pass and a second task routes to the idle member past the running owner; one pass delivers the queued wakeup backlog before any new assignment and the assignment for the member that just received waking mail defers to its next idle edge (mailbox-first order locked by followup frame order); and a failed dispatch whose concurrent captain handoff already fenced the attempt (`currentAttemptId` changed) never calls `cancelAttempt` — the handoff's reserved attempt survives and the next pass delivers it (CAS-guarded rollback);
- `tests/stranded-ownership.spec.ts`: 4 stranded-ownership self-healing tests over the same real composition (issue #12 / F10, decisions in docs/04 §8c): a live-and-idle member interrupted keepInbox while holding an open in_progress task is retried under a fresh fenced attempt past the `strandedAfterMs` grace with the old attempt stale and diagnostic retained, while inside the grace the exact attempt is untouched; a concurrent reader polling the authoritative store across the whole healing window sees the task `in_progress` throughout — never the transient `pending` the pre-fix cancel-then-reclaim pair exposed between its two domain transitions (issue #83 atomicity lock); a not-live (drained) owner's stranded task surfaces `stranded=owner-not-live` in the `agent_swarm_list_tasks` row (the hint moved out of the removed status task_summary with issue #15) and is never auto-released across grace-elapsed passes — the grace is allowed to elapse BEFORE the drain (the CI coverage timing of issue #83), locking that only the owner's own idle-stretch clock holds the self-heal back through the teardown window — with the captain's explicit `reassignTask` reviving it; and scenario 2 (reassign while the old member is running) fences the old attempt, rejects the old member's late submission with `TEAM_ATTEMPT_STALE` against a deterministically pending task, and continues under a fresh attempt; the domain-level `retryAttempt`/`reinstateAttempt` contracts (one-transition retry, misfire reversal onto the recorded replaced attempt, delivered retries irreversible) live in `tests/team-domain-retry.spec.ts` over the same official storage stack;
- `tests/official-compat-semantics.spec.ts`: 4 official-compat tests over the same real composition as the mailbox suite (issue #19): scenario 20 proves quiet mail to an inactive member stays durably queued across the send path and the reload-recovery rescan (no followup, no cold resume) while wakeup cold-resumes the same member and delivers, after which the still-queued quiet message delivers via the non-waking inject on the next rescan with exactly one model-visible copy of each frame; quiet mail to a live running member delivers through inject without starting a second model turn or any followup; the captain-only keepInbox interrupt (`agent_swarm_interrupt_member`) cancels a member's running turn while roster, task ownership, attempts and durable mail survive and a later wakeup resumes the member, with `TEAM_CAPTAIN_REQUIRED`/`TEAM_INVALID_TARGET`/`TEAM_MEMBER_NOT_FOUND` authorization and target validation on the host API; and the wait contract enforces the official 10000..3600000 window with `TEAM_INVALID_TIMEOUT`, resolves early on a committed revision edge at the 1h cap, rejects caller abort with structured `TEAM_WAIT_ABORTED`, and returns the unchanged snapshot with `changed=false` at timeout.
- `tests/prompt-snapshot.spec.ts`: 5 model-visible snapshot tests (M1C/F8, issue #14 — the roadmap's first prompt snapshot suite): the assignment prompt, its default acceptance-criteria variant, the peer-message frame and the member persona are locked byte-exact with inline snapshots over instruction-like untrusted content ("ignore previous instructions", "become captain", read-.env payloads with embedded newlines), after exact structural assertions prove the F8 invariants — the data-not-instructions declaration precedes the block, payloads occur only between the fences, trusted instructions only outside, and the fence grows one backtick past the longest internal backtick run (through the builders and through `untrustedDataBlock` directly);
- `tests/prompt-injection-delimiting.spec.ts`: 1 scenario-19 composition test over the same real composition as the scheduling suite (issue #14): a member-addressable task whose description and one acceptance criterion embed injection instructions delivers byte-identical delimited data (the followup frame equals the runtime's `assignmentPrompt` output for the authoritative snapshot), a peer-member wakeup message with the same hostile shape delivers as the delimited `messageFrame`, and the injected member's own captain-only host-API attempts (`interruptMember`, `setBudget`) still fail loud `TEAM_CAPTAIN_REQUIRED` with authoritative state unchanged.
- `tests/dual-owner-fencing.spec.ts`: 2 dual-owner adversarial tests over the same real composition with the bridge co-enabled (M2-3, issue #77 — the core deliverable): scenario 31 parks a workflow run mid-assignment (task in_progress/delivered, owner set) and attacks the same Team from a second face — a claim carrying the pre-claim revision (`TEAM_TASK_STALE_REVISION`), a claim with the current revision (`TEAM_TASK_NOT_READY`), a foreign captain submit with the correct fence pair (`TEAM_TASK_OWNER_REQUIRED`), the owner's session with a bogus attempt id (`TEAM_ATTEMPT_STALE`) and a REAL operation-triggered scheduling pass (`agent_swarm_create_task`) racing the parked run — then proves zero corruption (exactly the run's single seated attempt, one assignment frame ever delivered to the member, one request charge, token folds equal to the participants' billed events exactly once), the structural rejection of a second run on the same captain (`TEAM_ALREADY_ACTIVE` settling `error` with zero publication), and the fenced Team still running to completion afterwards; the companion test proves the ownership registry's runId-guarded release contract (foreign releases never steal, the owning id can, and a released run can no longer drive). Red→green evidence is recorded in the PR via local mutation runs (claim CAS+readiness disabled, submit fences disabled, ownership registry disabled, mode gates removed — each turns the suite red);
- `tests/orchestration-modes.spec.ts`: 4 orchestration-mode tests over the same real composition (M2-3, issue #77, decisions in docs/04 §8g): `orchestrationMode: 'workflow'` without `workflowBridge` fails plugin activation closed with zero side effects; scenario 32 proves workflow mode's autonomous event face is off (a non-run Team's member idle edge leaves the task pending, zero followup deliveries, zero request charges) while a workflow run still drives its own Team end-to-end through its ownership-gated idle driver (assignment lands only after the run-relevant idle edge, submission, review, archive, ownership released at settle); and in adaptive mode a run-owned Team constructed into the stranded-heal trigger (live-and-idle holder past the grace, exactly the adaptive suite's interrupt choreography) never heals while the run owns it, the public recovery entry stays gated, the structured `TEAM_ORCHESTRATION_OWNER_CONFLICT` contract is probeable, the budget folds exactly once, and cancellation converges bounded with the ownership released.
- `tests/node-mapping.spec.ts`: 6 Jiuwen node-mapping tests over the same real composition in default adaptive mode (M2-4, issue #78, decisions in docs/04 §8i, design note `docs/development/2026-08-21-m2d-node-mapping-design.md` — the mapping is pure composition sugar over `create_task`/`blocked_by`, the board stays the only authority): scenario 33 proves the phase mapping (the phase boundary IS the dependency chain — the joining task names both fan-out blockers; a rejected stage holds the chain with `ready=false` and `usedRetries` charged, rework releases it); the parallel test proves fan-out backpressure rides the existing quotas only (a third member is `TEAM_MEMBER_LIMIT`-refused at `maxMembers: 2`, both parked owners hold exactly one open task each with the overflow honestly `pending`, and the sampled in-flight peak never exceeds the member count); the pipeline test proves per-item chains with zero cross-item edges, the `{upstream}` symbolic artifact reference resolved to the real task id at apply, and the artifact channel (stage-1 board `output` + quiet Team mail whose marker the stage-2 submission embeds); the nested test proves the F11 self-Team face (the assignee's session founds a sub-Team, every implicit membership face then fails `TEAM_MEMBERSHIP_AMBIGUOUS`, `resolveChildDepth` throws `SubagentDepthError` at the configured cap, the sub-Team folds through the explicit teamId-addressed domain port and stays F14-readable archived, and the parent task completes normally); the human test proves the review-gate leg (the compiled plan's review hook resolves to the real task id, `submitted` at the gate is the waiting form, refusal rejects to pending with the retry charged while the downstream stays held, approval completes and releases it); and the compiler test proves malformed plans reject `TEAM_INPUT_INVALID` while the emission order is topological with unique auto keys.
- `tests/model-experience.spec.ts`: 3 tool-layer model-experience tests over the same real composition (issue #15, decisions in docs/04 §8e): `agent_swarm_wait` returns `no_progress:{reason:'no-active-peer'}` immediately — under the 1h window bound — when no other member is running or provisioning (empty roster and a live keepInbox-interrupted idle member alike) with the authoritative cursor state in the payload and the compact single-JSON-block render asserted, while invalid windows still fail `TEAM_INVALID_TIMEOUT` before the shortcut and a genuinely running peer parks until a committed revision wakes the wait; and `agent_swarm_list_tasks` proves status/owner/ready filters (including the `unowned` token and member-name owner rows with attempt ids through claim/submit/review), cursor pagination with `next_cursor` chaining and the `TEAM_INPUT_INVALID` bounds (limit 0/101, negative cursor), while `agent_swarm_status` returns fixed-size counters only — no `ready_task_ids` array, no `task_summary`.
- `tests/jobs-reader.spec.ts`: 2 jobs-reader tests over the same real composition with `jobsBridge: true` mounted (M3 entry gate, issue #93, decisions in docs/04 §8h): the projection read path proves the tool's rows agree with the authoritative task board exactly where #76's derivation says they do — pending-unclaimed work projects no job (the empty list there is the derivation contract, not a missing read), a claim seats exactly one running row whose `detail` names the board's fencing attempt, an accepted submission settles the row `completed` with `finished_at >= started_at`, and a second claim grows the visible set in board order — plus the compact single-JSON-block render, kind/status filters (an unknown kind filters to empty rather than erroring) and cursor pagination with `next_cursor` chaining and the `TEAM_INPUT_INVALID` bounds, all aligned with the list_tasks precedent; the disabled-bridge test proves the lifecycle-fail-loud form: with no projection mounted the call answers the structured `TEAM_JOBS_BRIDGE_DISABLED` error naming the enabling config (never an empty-list lie, never a domain fallback) while input validation still precedes the capability check.

`pnpm verify` additionally runs strict source/test typechecks, a clean build, structural checks and package-artifact import/exports checks. The offline migration CLI was additionally exercised end-to-end on a real legacy fixture (migrate → idempotent re-run → explicit miss → exit codes). A real CLI Profile remains a separate deployment gate because the DSH CLI is not installed in every development shell.

Scenario coverage is machine-audited (`pnpm verify:scenarios`, wired into `pnpm verify`): tests prove a §3 scenario either with an `it('scenario N: …')` title (exact match) or a `// scenario-evidence: N` marker at the proving assertion, and the line below is the single source of truth that must equal the evidence found in tests, in both directions — claiming a scenario without a proving test fails the gate, and so does a proving test the docs forget to claim.

Scenario audit: implemented = 1-9, 11, 12, 16-20, 21, 31-34; not yet proven = 10, 13-15, 22-30.

The unproven set still contains the full failure windows this section cares about: restart with open runs (10) and the remaining Worktree/remote/self-hosting scenarios (14, 15, 22-30 → M3+). Scenario 21 closed with the M3-1 execution-roots group (issue #100, `tests/execution-roots.spec.ts`): two parallel attempts hold distinct detached git-worktree roots of the same repository with zero cross-contamination, the member-face root declaration rides the official cwd semantics (absolute `workdir`/paths — no Agent-Loop change), a failed attempt's root is reclaimed, and crash-left roots are detected, alarmed and marked reclaimable without auto-deletion (decisions in `docs/04` §8l); the per-attempt-branch dimension of the original wording rides detached worktrees — no branch objects are created, the isolation is the worktree/filesystem root itself. Scenario 2 closed with the #12 live-status scheduling group: the captain-initiated reassign while the old member still runs its turn fences the old attempt, the old member's late submission is rejected `TEAM_ATTEMPT_STALE` while the released task deterministically stays pending, and the scheduler continues the task under a fresh fenced attempt. Scenario 20 closed with the #19 official-compat group: its F11/F14/F15 members were already implemented and tested individually (#13), and the quiet inactive-delivery half landed with issue #19 — an inactive target's quiet mail never cold-wakes across sends and recovery rescans, wakeup cold-resumes and delivers, the live-target quiet path injects without waking, and the wait/interrupt/name contracts hold over the real composition. Scenario 19 closed with the #14 F8 group: untrusted task descriptions/acceptance criteria and peer-message bodies reach member Sessions only as fenced data under an explicit "data, not instructions" declaration (shapes locked by the first model-visible snapshot suite), and the injected member's captain-only attempts still fail the domain check with authoritative state unchanged — delimiting is presentation, never authorization (decisions in `docs/04` §8d). Scenario 6's crash half is strengthened by the F3 reconciliation suite (`tests/member-provisioning.spec.ts`): the persisted child that durably accepted its initial prompt before the activation commit re-activates as a member, a four-factor mismatch settles failed with an explicit orphan drain, and unverifiable evidence keeps the failed settlement; its M1C test additionally proves the F15 `depthLimit` provider-capability preflight rejects at `addMember` — before any provisioning record commits and before the continuation manager is reached. The workspace-writer protection proven above (protocol-matrix scenario 16) covers ordinary workspace writers with the storage root configured outside the workspace and sandbox roots — it is not protection against a process with unrestricted host access. The status above must be updated whenever tests or implementation change; test names alone are not evidence of a guarantee.

## 8. Independent review gate

Security and milestone reviews follow `12-independent-review-management.md`. The reviewer receives the assembled source, official/reference evidence and permission needed to run diagnostics without a manager-imposed time/step/token limit. The report is preserved unchanged; the manager separately verifies findings, records triage and commissions regression re-review after fixes.

M3 self-hosting acceptance requires an independent regression/security review of the stable/candidate boundary, Worker permissions, frozen evidence, merge/promotion ownership and rollback. The candidate's own report is input evidence, not the verdict.

## 9. Engineering quality gates

Mirrors the official DSH engineering family so code quality is machine-enforced rather than reviewer-dependent:

| Gate | Tool | Command | Enforcement |
|---|---|---|---|
| Lint (correctness=error, suspicious=warn) | oxlint | `pnpm lint` | inside `pnpm verify`; staged files on pre-commit (lefthook) |
| Copy-paste duplication (60 tokens / 6 lines) | jscpd | `pnpm verify:duplication` | inside `pnpm verify`; 0 clones |
| Dead exports / dead dependencies | knip | `pnpm verify:exports` | inside `pnpm verify`; 0 findings |
| Unused locals / parameters | tsc `noUnusedLocals`/`noUnusedParameters` | `pnpm typecheck` | typecheck lane |
| Source file size | `scripts/verify-project.mjs` | `pnpm verify:structure` | 600-line ceiling for `src`/`scripts`/`tests` `.ts`; exceptions registered with reason + retiring milestone (currently zero exceptions) |
| Line endings / encoding | `.gitattributes` + verify-project | `pnpm verify:structure` | LF working tree (CRLF for `ps1`/`cmd`), UTF-8, final newline |
| Full matrix on push/PR | GitHub Actions | `.github/workflows/verify.yml` | windows-latest: pinned reference syncs, official evidence checkout (`DSH_OFFICIAL_CHECKOUT`), `pnpm verify`, live Gate A verification, coverage |
| Coverage visibility | `@vitest/coverage-v8` scoped to `src/**` | `pnpm test:coverage` | report-only at introduction (86.5% statements / 74.8% branches); thresholds may follow M1D |

The verify chain is `verify:structure -> lint -> duplication -> exports -> typecheck -> typecheck:test -> test -> build -> artifact`. `verify-project.mjs` additionally asserts that the lint/duplication/export lanes stay wired into `pnpm verify`, that `packageManager` pins pnpm, and that every tooling file exists, so the gates cannot be silently deleted.

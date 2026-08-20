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

The post-M1A core has ten executable suites:

- `tests/team-domain.spec.ts`: 20 protocol tests over the real official storage stack covering concurrent claims, review gating, stale attempts, DAG validation, budgets, full-frame byte limits, semantically corrupt stored state without absolute-path disclosure (a zod-valid record failing the deep invariant check), assignment checkpoints, usage de-duplication, interrupted-provisioning **failure settlement** with the retired name kept occupied under the official F12 lifetime rule, safe removal/archive, revision waiting, and queued-mail durability across a full storage reopen; the F6 mailbox-retention tests add per-target pending admission with the official `TEAM_MAILBOX_FULL` code, quota+10 send/acknowledge cycles without mailbox exhaustion, oldest-first retained-receipt pruning that never removes queued mail (creation order, revision continuity and reload replay intact), cancel-path pruning on member removal, and a hand-written pre-F6 `schemaVersion: 1` record holding 1024 retained messages that loads unchanged and keeps correct semantics past the old lifetime cap (scenario 17);
- `tests/team-attempt-retention.spec.ts`: 3 F7 attempt-retention tests over the same real official storage stack: 12 claim/reassign cycles bounded to the newest terminal window per task with a bounded unit file (4227 bytes retained versus 6801 unpruned), strictly monotonic fencing generations across pruning and full reloads, pruned-id submissions still rejected with exactly `TEAM_ATTEMPT_STALE` (including post-reload and legacy-record cases), the referenced current attempt of a completed task surviving pruning, and a hand-written pre-F7 `schemaVersion: 1` record holding 300 terminal attempts that loads unchanged, fences its next generation from the retained maximum (301, then 302 — never a reused historical one) and prunes lazily on its next terminal transition (scenario 18);
- `tests/team-domain-port.spec.ts`: 13 port-conformance tests over the real `dsh-storage` + `dsh-storage-json` + `dsh-storage-domain` composition: scope isolation, durable reopen, no-op transactions, captain/id uniqueness, revision-wait wake/abort, `version-mismatch` and `invalid-record` rejection at reopen, closed-store lifecycle (reads/writes/waiters rejected, domain name freed after close), backend durability failure leaving state untouched, failed migration import retried, **fail-closed plugin activation** (no persistence / no storage stack keeps the plugin pending; the full composition activates and serves tools), and the domain error vocabulary;
- `tests/migration.spec.ts`: 5 migration tests: validated aggregates migrate with durable read-back, SHA-256 receipts and byte-identical sources, re-runs are idempotent skips, and records survive a storage reopen; non-empty destinations (same id / same active captain) and invalid legacy sources abort without writing; injected backend write failures abort without a receipt and then recover; a receipt without its record is an inconsistent destination;
- `tests/dsh-composition.spec.ts`: 3 real-composition tests mount actual Cordis + AgentLoop + JSONL persistence + Storage hub + json KV backend + Storage Domain + Subagent + in-process spawn rc.8 services, then verify tool registration, model-visible structured Team errors, custom and missing Scheduler/Review Providers, continuable member creation, automatic dispatch, complete billed-token accounting including cache fields (settled via wait, no accounting race), review, durable state, plugin reload over the same storage root with the budget still matching the adapter exactly after the reload's cursor refold, queued-mail retry, cold resume/disposal, retained child ownership when activation commit plus immediate drain both fail, **no Team state files in the shared workspace**, **workspace tamper denial** (a decoy legacy state file cannot alter authoritative state), and **bounded disposal** (scenario 9: a registered provider whose continuable preparation never settles keeps the admitted addMember unsettled, and `dispose` returns within `disposalTimeoutMs` failing loud with `TEAM_DISPOSAL_TIMEOUT` while the admitted provisioning record stays durable);
- `tests/message-delivery.spec.ts`: 2 mailbox crash-window tests over the same real composition (AgentLoop + continuable spawn members + JSONL persistence + the storage stack harness): scenario 5 injects the kill -9 half-window (real followup acceptance checkpointed durably, one rejected `acknowledgeMessage` write, member drained cold) and proves the reload rescan folds the already-accepted stable message id into a make-up acknowledgement — exactly one model-visible copy at the target, exactly one followup; the idempotency test repeats the rescan while the ack store stays down and proves repeated `deliverQueuedMessage` calls never add a second copy, then commits the pending ack once the store recovers;
- `tests/team-domain-m1c-hardening.spec.ts`: 5 M1C companion-hardening tests over the real official storage stack (issue #13): ambiguous membership across two active teams fails loud with `TEAM_MEMBERSHIP_AMBIGUOUS` naming both team ids (F11), retired member names stay occupied for the Team's lifetime with the total roster counting toward `maxMembers` under the official `TEAM_MEMBER_NAME_TAKEN` code (F12), the archived captain reads terminal snapshots — `waitForChange` returns immediately even at a current cursor because an archived Team can never commit a later revision — while mutations stay `TEAM_ARCHIVED`-rejected and the read path prefers the captain's next active Team (F14), and coalesced usage batches stay sequence-cursor idempotent across a full storage reopen without double-counting (usage write coalescing);
- `tests/team-domain-unicode-names.spec.ts`: 3 Unicode member-name tests over the same real official storage stack (issue #19): distinct CJK/Cyrillic names provision, address and remove correctly with mail targets resolving to the exact rows, canonically equivalent inputs (NFC composition, case, separator runs) fold onto one identity with `TEAM_MEMBER_NAME_TAKEN` on the duplicate, and over-length (65 code points against the admitted 64), letter-less and reserved (`captain`) names are rejected `TEAM_MEMBER_NAME_INVALID`/`TEAM_MEMBER_NAME_RESERVED` instead of digest-synthesized;
- `tests/official-compat-semantics.spec.ts`: 4 official-compat tests over the same real composition as the mailbox suite (issue #19): scenario 20 proves quiet mail to an inactive member stays durably queued across the send path and the reload-recovery rescan (no followup, no cold resume) while wakeup cold-resumes the same member and delivers, after which the still-queued quiet message delivers via the non-waking inject on the next rescan with exactly one model-visible copy of each frame; quiet mail to a live running member delivers through inject without starting a second model turn or any followup; the captain-only keepInbox interrupt (`agent_swarm_interrupt_member`) cancels a member's running turn while roster, task ownership, attempts and durable mail survive and a later wakeup resumes the member, with `TEAM_CAPTAIN_REQUIRED`/`TEAM_INVALID_TARGET`/`TEAM_MEMBER_NOT_FOUND` authorization and target validation on the host API; and the wait contract enforces the official 10000..3600000 window with `TEAM_INVALID_TIMEOUT`, resolves early on a committed revision edge at the 1h cap, rejects caller abort with structured `TEAM_WAIT_ABORTED`, and returns the unchanged snapshot with `changed=false` at timeout.

`pnpm verify` additionally runs strict source/test typechecks, a clean build, structural checks and package-artifact import/exports checks. The offline migration CLI was additionally exercised end-to-end on a real legacy fixture (migrate → idempotent re-run → explicit miss → exit codes). A real CLI Profile remains a separate deployment gate because the DSH CLI is not installed in every development shell.

Scenario coverage is machine-audited (`pnpm verify:scenarios`, wired into `pnpm verify`): tests prove a §3 scenario either with an `it('scenario N: …')` title (exact match) or a `// scenario-evidence: N` marker at the proving assertion, and the line below is the single source of truth that must equal the evidence found in tests, in both directions — claiming a scenario without a proving test fails the gate, and so does a proving test the docs forget to claim.

Scenario audit: implemented = 1, 3-9, 11, 12, 16-18, 20; not yet proven = 2, 10, 13-15, 19, 21-30.

The unproven set still contains the full failure windows this section cares about: restart with open runs (10), untrusted prompt delimiting (19 → F8/M1C) and every Worktree/remote/self-hosting scenario (14, 15, 21-30 → M3+). Scenario 20 closed with the #19 official-compat group: its F11/F14/F15 members were already implemented and tested individually (#13), and the quiet inactive-delivery half landed with issue #19 — an inactive target's quiet mail never cold-wakes across sends and recovery rescans, wakeup cold-resumes and delivers, the live-target quiet path injects without waking, and the wait/interrupt/name contracts hold over the real composition. Scenario 6's crash half is strengthened by the F3 reconciliation suite (`tests/member-provisioning.spec.ts`): the persisted child that durably accepted its initial prompt before the activation commit re-activates as a member, a four-factor mismatch settles failed with an explicit orphan drain, and unverifiable evidence keeps the failed settlement; its M1C test additionally proves the F15 `depthLimit` provider-capability preflight rejects at `addMember` — before any provisioning record commits and before the continuation manager is reached. The workspace-writer protection proven above (protocol-matrix scenario 16) covers ordinary workspace writers with the storage root configured outside the workspace and sandbox roots — it is not protection against a process with unrestricted host access. The status above must be updated whenever tests or implementation change; test names alone are not evidence of a guarantee.

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

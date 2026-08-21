# M4-3 design note: retry economics, budget reservation and degraded continuation (issue #129)

Status: decided. Date: 2026-08-22. Base: main @ a8b7a81 (#127 boundary declaration in force).

## 0. Gate A record

```text
Official remote SHA/date: b150a551b8d465e31e418e1b2eaf5e79bbb7d28e (release dsh@0.1.1-rc.2, unchanged from the #127 re-pin; pnpm verify:gate-a re-run green on this branch)
Relevant implemented Agent Notes/packages: packages/storage/storage-domain (table record load path parses through the table value schema — new contract fact registered this change, docs/09 §1), packages/llm/token-meter (boundary unchanged, docs/09 §1), packages/core/session (usage event facts, registered for #92)
Installed/Profile capability evidence: @deepseek-ai/* 0.1.1-rc.2 devDependencies of this repo; the Team budget needs NO new official service — measurement, admission and carry stay project-owned (M4-1 Option B boundary: the official tokenMeter is not consumed by the budget)
Stable / experimental / absent / overlay classification: cumulative Team budget ledger with per-seq cursors, admission, carry = project-owned overlay (unchanged); retry economics, reservation admission and degraded continuation are NEW project-owned policy overlays over the existing ledger — no official seam exists for any of them (the official experimental agent-team has no budget face; tokenMeter is request-pressure/per-session only)
Reference behaviors and failure cases selected: Jiuwen shared budget spent/remaining + per-run reservations (docs/05 budget rows — the reservation floor and the "degrade and continue after recovery" shape); dsh-agent-teams process-local retry accounting (retry limit semantics)
Canonical state owner: Team budget aggregate + task board (agent_swarm Storage Domain record) — the reservation DECLARATION joins the task record; the reservation HOLD and all derived admission/hold predicates are computed, never stored
Transition owner: TeamDomain board/budget modules (claim/retry/seat transitions and admission checks); scheduler (selection pre-filter, heal gating); runtime setBudget wrapper (recovery pass trigger)
Plugin shape: no new service, no new Provider registry — domain policy + scheduler lane + evidence fields on the existing tool surface
Lifecycle/persistence/security limits: no new limits (reservationTokens bounded as a positive safe integer; admission bounded by tokenLimit arithmetics)
Migration/rollback: none (schemaVersion stays 1 — Section 5 argument; stored media unchanged for every pre-M4-3 record)
Unit/conformance/fault/real-composition gates: tests/budget-family.spec.ts (scenarios 37-39: real storage stack + real gated composition)
Docs/Skill files updated: docs/03, docs/04 (§7, §8n), docs/07, docs/08, docs/09, docs/10, README, this note, SKILL.md (durable-boundary fact)
```

The one official-package fact this change adds (probe-proven against the installed
0.1.1-rc.2 `@deepseek-ai/dsh-storage-domain`): `put(key, value)` stores the given
record as-is, but the load path (`loadAll` → `parseRecord` → `valueSchema.parse(raw)`)
runs every stored record through the table's zod schema, and zod object parse
STRIPS undeclared keys. An additive optional aggregate field therefore survives
write+read only while the record is live in one process; a reopen (or any later
load) silently drops it unless the durable table schema declares it. This fact
was never registered and it produced two latent defects (Section 5.3) fixed here.

## 1. Item 1 — Retry economics

### 1.1 Failed-attempt token attribution (已耗 token 归属)

**Decision: the Team ledger keeps counting a failed attempt's consumed tokens,
unchanged — attribution stays per session event seq (M1B/#92), never per attempt
generation, and nothing is refunded.**

- The ledger measures real provider spend. Tokens burned by an attempt that
  later went stale/rejected/cancelled are real cost; the provider does not
  refund them, so the ledger must not either. Re-windowing usage into attempt
  generations would require the fold to know attempt lifetimes, which the
  per-seq-cursor exactly-once fold deliberately does not model (a session works
  many attempts; usage events carry no task identity).
- Per-attempt cost remains RECONSTRUCTABLE evidence: the attempt's
  `createdAt`/`updatedAt` window over the member Session log (or the #127
  official `tokenUsage` projection read face) derives it without any new
  authoritative state. Evidence, not a second ledger.
- #127 boundary holds: retry economics adds admission POLICY over the one
  measurement path; it does not add a measurement face.

### 1.2 Cost-aware `retryLimit`

**Pre-M4-3 defect:** `retryAttempt` (the in-place retry of issue #83) CHECKED
`budgetAvailable` — including the retry face — but consumed nothing from it:
`usedRetries` grew only on review-reject. A `retryLimit` therefore never bounded
in-place retries (the stranded self-heal loop was bounded only by the request
seat charge), and a retry budget exhausted by review rework also blocked heals
of tasks that had never been reworked.

**Decision: every FAILURE-driven re-execution generation consumes one retry.**

- In-place `retryAttempt` now charges `usedRetries + 1` (inside the same
  transaction, after the unchanged `budgetAvailable` check and request seat
  charge).
- Review-reject keeps its existing charge (docs/04 §5/§8i: reject → pending +
  retry charge) — a rework is a re-execution.
- Captain `cancelAttempt` reassignment and member-removal requeue stay
  UNCHARGED, deliberately: they are captain CONTROL acts, not failure-driven
  re-executions; charging them would couple the retry budget to routine
  scheduling decisions. Documented as the deliberate line.
- `reinstateAttempt` (misfire reversal of an undelivered retry) refunds
  nothing: charges are transition costs of real committed transitions, exactly
  like the request seat charge it already does not refund; refunding would add
  a decrement path with no honesty gain (the reversal itself proves the retry
  was attempted).

`retryLimit` is now the true bound on failure-driven re-executions (rework +
in-place retry), with `requestLimit` bounding every seat and the token ledger
measuring every real token. Red-line check: the M1B token fold is untouched;
`adoptBudget`'s carried-face validation (`retryLimit >= usedRetries`) is
untouched; #79 carry mechanics untouched.

### 1.3 Retry × reservation interplay (reserve/release discipline)

An in-place retry keeps the task continuously `in_progress` (issue #83), so its
reservation hold is already accounted: no release/re-acquire, no re-admission —
retrying never re-enters the reservation gate (Section 2.3). Review-reject
settles the attempt (task → pending), which RELEASES the hold; the rework's
re-claim passes fresh reservation admission (headroom may have been taken
meanwhile — the rework waits like any other reservation-insufficient claim,
which is the honest economic answer, not a starvation bug: the captain can
raise the limit or lower competing reservations).

## 2. Item 2 — Budget reservation (预算预留)

### 2.1 Declaration face

`create_task` accepts an optional `reservation_tokens` (positive safe integer):
the captain/member-declared **guaranteed minimum token allocation** for the
task ("保底额度"). Stored as the optional `TeamTask.reservationTokens` field,
absent when undeclared. Jiuwen's per-run reservation concept maps onto this as
a per-task floor over the one shared ledger — no second ledger, no Jiuwen
`budget.remaining()`-style dynamic fan-out (docs/04 §8i's deliberate not-wired
decision stands).

### 2.2 Admission predicate (pure, shared by domain and scheduler)

```text
reservationAdmissible(budget, outstandingReserved, taskReservation):
  budget.tokenLimit === undefined                       → true  (reservations are inert without a token limit — documented)
  budget.usedTokens + outstandingReserved + taskReservation <= budget.tokenLimit → true
  otherwise                                             → false
outstandingReserved = Σ reservationTokens of tasks with status 'in_progress'
```

- Holds are held while the task is `in_progress` ONLY: that is the state whose
  member may still spend. Submitting (`submitted`/`verifying`) finishes
  execution, so the hold releases at submit — the headroom serves queued work;
  a review-reject rework re-claims under fresh admission (Section 1.3).
- Unreserved tasks (floor 0) are never blocked by the predicate — reservations
  guarantee minimums, they do not monopolize the remaining budget.
- The invariant the predicate maintains: `usedTokens + Σ(holds of in_progress
  tasks) <= tokenLimit` after every admitted claim.

### 2.3 Enforcement faces

- **Domain (`claimTask`)** — the authoritative check, so member self-claims
  obey too: after `budgetAvailable`, before seating; failure throws the NEW
  structured code `TEAM_BUDGET_RESERVATION`. The code is deliberately NOT in
  `BUDGET_EXHAUSTION_CODES`: reservation insufficiency is admission-POSTPONE
  (headroom may free when an in_progress task settles), never budget
  exhaustion (which converges run-owned Teams per §8j — a reservation
  postponement must never settle a run).
- **Scheduler (new-assignment lane)** — budget-aware selection: the pass
  filters ready tasks to reservation-admissible ones BEFORE offering them to
  the Provider, and treats `TEAM_BUDGET_RESERVATION` from a racing claim the
  same as `TEAM_TASK_STALE_REVISION`/`TEAM_MEMBER_BUSY` (skip, next pass).
  Insufficient new tasks are POSTPONED, exactly the issue's wording; the
  Provider contract itself is unchanged (it sees fewer candidates).
- **Retry face** — no reservation re-admission (Section 1.3).

### 2.4 Evidence face

`agent_swarm_list_tasks` rows gain an evidence-only `hold` field (beside the
§8c `stranded` hints): `hold: 'reservation'` for a pending reserved task that
is not currently admissible (team not exhausted — under exhaustion the blocker
is the shared budget face). Derived at read time; never stored.

## 3. Item 3 — Degraded continuation (降级续作)

### 3.1 Suspension semantics — no new status, no schema change

A task is **budget-held** when it is `in_progress` and the Team budget face is
exhausted. "Exhausted" is the new non-throwing predicate `budgetExhaustion(budget,
now)` (returns the first failing `TEAM_BUDGET_*` code or `undefined`);
`budgetAvailable` is refactored onto it — zero behavior change for every
existing caller.

- **Boundary vs stranding self-healing (not the same "stuck"):** stranding is
  an OWNER-LIVENESS defect — a live-and-idle owner lost the turn that was
  executing the task; the heal retries the same owner in place, grace-bounded
  (§8c). Budget-hold is a TEAM-ECONOMICS state — the task is held because the
  Team cannot admit further spend, regardless of owner liveness or grace; no
  retry is attempted because none can pass admission. The heal therefore SKIPS
  Teams whose budget face is exhausted (checked once per pass before the heal
  section): pre-M4-3 such a Team produced a doomed `retryAttempt` domain call
  and a warn log on every pass forever; now it holds silently with structured
  evidence.
- In-flight member turns are NOT interrupted (unchanged since M1B): limits gate
  admission, not execution; usage keeps folding truthfully and may overshoot
  the limit (the ledger records real spend).
- Workflow-run convergence is UNCHANGED: `TEAM_BUDGET_*` from `budgetAvailable`
  at claim/seat still propagates and converges the owning run (§8j). Degraded
  continuation is the adaptive face's semantics — a Team without a run owner
  parks (never self-converges), its open tasks budget-held with evidence,
  waiting for the captain's explicit recovery. This upgrades today's
  "logged-diagnostic-only" behavior (§8j) to structured, inspectable state
  without changing any transition.
- Evidence face: `agent_swarm_list_tasks` rows carry `hold: 'budget'` for
  `in_progress` tasks under an exhausted face.

### 3.2 Continuation face (预算恢复后的续作)

Recovery = the captain raises the budget through `set_budget` such that
`budgetExhaustion` passes again (token/request/retry limits can rise; a passed
`deadlineAt` can be extended to the future).

- **The §7 "budget release" scheduling event is now actually wired:** the
  runtime's `setBudget` wrapper requests one scheduling pass after a successful
  budget change (docs/04 §7 has listed "budget release" as a scheduler event
  since M1; nothing ever triggered it).
- The recovery pass re-drives budget-held tasks through EXISTING lanes only —
  no new transition, no ownership auto-release: an undelivered reserved
  attempt redelivers (the reserved fold); a live-and-idle owner re-enters the
  stranded heal (its anchor is typically long past the grace, so the in-place
  retry fires immediately and now passes `budgetAvailable`); a cold delivered
  owner stays evidence-only (captain reassigns — the §8c discipline is
  untouched).
- Deliberately NOT built: a `suspended` task status (no schema change, no new
  board transitions — the hold is derived, so it cannot drift from the budget
  face); forced cancellation of in-flight turns at exhaustion; carry-time
  budget top-up (a new run adopting an exhausted ledger stays exhausted —
  recovery is an explicit captain act, never a side effect of running).

## 4. Item 4 — Interaction with the #79 carry

1. **Reservations never carry.** Holds are per-Team derived state (the prior
   run's Team is archived — its tasks terminal, its holds vacated by
   definition); declarations live on tasks, and tasks never cross run
   boundaries (each run = one fresh Team, §8f unchanged). `adoptBudget`
   carries limits + used counters only — its code, fresh-ledger gate and
   carried-face validation are untouched (#79 zero regression).
2. **The carried face is the admission basis.** A new run's reservation
   admission is computed against the carried ledger: `carried.tokenLimit`,
   `carried.usedTokens`. A nearly-exhausted carried ledger postpones the new
   run's reserved tasks until the captain raises the limit — the exhaustion
   convergence of §8j still applies to claims that fail `budgetAvailable`
   proper; only the reservation floor postpones without converging.
3. Run-boundary refold idempotency rides unchanged M1B semantics (cursors;
   replayed batches fold free) — reservations add no usage write of any kind.

## 5. Storage-surface decision (ADR-0007 argument)

### 5.1 The split: durable declaration, derived hold

- The DECLARATION (`reservationTokens` on the task) is durable task contract
  metadata, like `priority` and `verification`: if it lived only in runtime
  state, a plugin reload would silently drop the guarantee and scheduling
  would diverge across the reload boundary. It joins the aggregate.
- The HOLD (outstanding reserved sum), the admission decisions and both hold
  hints are DERIVED from the authoritative snapshot on every evaluation —
  never stored, never booked, no second ledger, no reservation records to
  crash-recover. Release is settlement-derived (task leaves `in_progress`),
  so a crash can never strand a phantom hold.

### 5.2 Why schemaVersion stays 1 (no version bump)

ADR-0007 freezes the aggregate VERSION and its one-way migration policy; the
discipline this project has applied to additive-optional fields (#101
`verification`, #83 `replacesAttemptId`, `ownerSessionId`, `output`, ...) is:
an optional field with an absent-when-unused default keeps every pre-existing
stored record byte-identical and parseable — old records lack the key and
parse; new records carry it as a declared optional; there is no representation
change for any existing fact, hence no versioned migration to own.
`reservationTokens` is exactly that shape. A bump to `schemaVersion: 2` would
demand a migration for records that need no change and would additionally
re-engage the Storage Domain version gate (`TEAM_DOMAIN_VERSION`) for a
no-op rewrite — cost without correctness gain.

### 5.3 The durable-boundary defect this argument exposed (fixed here)

The additive-optional argument is only as good as the durable schema actually
carrying the field — and it did not: `src/storage/team-spec.ts` (the zod table
schema at the official Storage Domain boundary) was never extended for
`verification` (M3-2/#101) or `replacesAttemptId` (#83). Because the official
load path parses every stored record through the table value schema and zod
strips undeclared keys (Section 0 fact), BOTH fields were silently dropped on
reopen: a reload between creation and review erased a task's frozen
verification list (executable review would run vacuous after a reload), and a
reloaded in-place retry lost `replacesAttemptId` (breaking `reinstateAttempt`
and the execution-root reinstate-window hold rule across reloads).
Probe-proven on this branch against the installed 0.1.1-rc.2 packages
(two red probes: `verification`/`replacesAttemptId` both `undefined` after
reopen; green after the schema fix). Fix in this change: the zod task schema
declares `verification` and the new `reservationTokens`; the attempt schema
declares `replacesAttemptId`; `assertTeamState` already validated all three —
no stored media changes (every pre-existing record parses unchanged); locked
by the scenario-38 reload regression.

## 6. Implementation inventory

- `src/domain/types.ts` — `TeamTask.reservationTokens?: number`.
- `src/domain/team-domain-budget.ts` — `budgetExhaustion` predicate (non-throwing
  refactor of `budgetAvailable`); `outstandingReservationTokens` +
  `reservationAdmissible` pure helpers; `taskHoldEvidence` derivation.
- `src/domain/team-domain-board.ts` — `createTask` validates/stores the
  declaration; `claimTask` enforces reservation admission
  (`TEAM_BUDGET_RESERVATION`); `retryAttempt` charges `usedRetries + 1`.
- `src/domain/team-domain-port.ts` — `CreateTaskInput.reservationTokens`;
  claimTask contract docs.
- `src/domain/state-validation.ts` — optional `reservationTokens` validation.
- `src/storage/team-spec.ts` — zod schemas gain `verification` (task),
  `reservationTokens` (task), `replacesAttemptId` (attempt) — the 5.3 fix.
- `src/runtime/scheduling.ts` — heal skips exhausted Teams; new-assignment
  lane pre-filters reservation-insufficient tasks and postpones on
  `TEAM_BUDGET_RESERVATION`.
- `src/runtime/orchestrator-runtime.ts` — `setBudget` requests the recovery
  pass (§7 budget release event); hold-evidence passthrough.
- `src/tools/task-board.ts` — `agent_swarm_create_task` gains
  `reservation_tokens`.
- `src/tools/read-surface.ts` — row field `hold: 'budget' | 'reservation'`.
- `tests/budget-family.spec.ts` — scenarios 37-39 (Section 7).

## 7. Verification plan (docs/08 scenarios 37-39)

- **Scenario 37 (retry economics, real storage stack):** a claimed task folds
  member usage into the ledger; an in-place retry charges request AND retry
  faces while the failed attempt's folded tokens stay attributed to the same
  ledger (no refund, no re-windowing); review-reject keeps its charge;
  `retryLimit` now actually bounds the in-place retry (`TEAM_BUDGET_RETRIES`),
  and the charged face carries across `adoptBudget` (#79 interaction).
- **Scenario 38 (reservation admission, real storage stack + real gated
  composition):** a reserved task's claim is refused with
  `TEAM_BUDGET_RESERVATION` while headroom is held by an in_progress reserved
  task; an unreserved task claims through the same remaining budget; settling
  the holder releases the hold and the postponed task admits; the scheduler
  lane assigns only the admissible task and picks up the postponed one after
  the blocker settles; the declaration survives a full storage reload (with
  the `verification`/`replacesAttemptId` reload regressions of 5.3).
- **Scenario 39 (degraded continuation + carry, real gated composition):**
  with the budget exhausted, an `in_progress` task under a live-idle owner is
  NOT retried past the grace (heal skipped, `hold: 'budget'` evidence, no
  request/retry charge, no re-kick noise); the captain's `set_budget` recovery
  triggers the pass and the task continues under a fresh in-place attempt of
  the same owner; a new Team adopting the exhausted carried face computes its
  reserved admission against the carried ledger (postponed) and admits after
  the limit is raised on the live Team.

## 8. Known limitations / deferred

- Reservation is a token floor only; request/deadline floors are not
  declarable (the request face is already bounded per-member by the busy rule;
  a deadline floor has no meaningful guarantee semantics).
- The hold covers `in_progress` only; a task sitting at `submitted` whose
  review rejects re-enters admission (documented, Section 1.3).
- Reservation admission is advisory to the CAPTAIN's manual reassignment
  flow in one sense: `cancelAttempt` + `createTask`-less re-claim still passes
  through `claimTask`, so the domain check covers every path that seats an
  attempt — no bypass exists.
- Per-attempt token attribution stays evidence-only (Section 1.1); if a future
  Consumer needs authoritative per-attempt cost, that is a new design with its
  own storage argument.

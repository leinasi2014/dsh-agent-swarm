# 04. Team execution protocol

## 1. Two concurrency controls, not one

The combined design needs both:

### Task revision

A monotonic integer on the canonical task snapshot. Every metadata/status mutation presents `expectedRevision`. It prevents two current callers from overwriting each other.

### Attempt id

A random opaque capability for one execution generation. Every worker update presents the current `attemptId`. Reassignment invalidates it before another worker starts. It prevents a previously valid but now stale worker from writing after takeover.

They solve different races:

```text
revision:  concurrent control-plane edits
attemptId: late data-plane result from an old worker
```

Retained attempt history is bounded per task (M1B/F7): `maxRetainedAttempts` (default 64, a project-owned bound) keeps the current attempt plus the newest N terminal attempts (accepted/rejected/cancelled/stale) of each task; each terminal transition (review settlement, reassignment, member-removal requeue, archive) prunes the oldest terminal attempts beyond the bound inside the same aggregate transaction. Pruning can never revive a stale id: worker updates fence against the task's `currentAttemptId` (a task field that is never pruned, and pruning never removes the referenced attempt), while new generations allocate from a watermark derived from the retained maximum generation — because only the oldest terminal attempts are pruned, the retained maximum is always the historical maximum, so generations stay strictly monotonic without a persisted counter. The stored record shape is unchanged — pre-F7 `schemaVersion: 1` records (including 300-attempt populations) load unchanged and are pruned lazily by their next terminal transition.

## 2. Recommended overlay records

```ts
interface TaskRun {
  runId: TaskRunId
  teamId: TeamId
  taskId: TeamTaskId
  taskRevisionAtStart: number
  attempt: number
  attemptId: AttemptId
  memberId: SessionId
  phase: 'reserved' | 'running' | 'submitted' | 'verifying' | 'accepted' | 'rejected' | 'cancelled'
  workspaceLeaseId?: WorkspaceLeaseId
  budgetReservationId?: BudgetReservationId
  outputRef?: string
  diagnostic?: string
}
```

Opaque ids crossing package boundaries should be branded types, not bare strings.

## 3. Assignment transaction

```text
read task + member + budget + workspace policy
  → verify dependencies and task revision
  → reserve budget
  → allocate workspace lease
  → create TaskRun and attemptId
  → claim/assign canonical task with expectedRevision
  → persist run
  → dispatch prompt to member
```

If dispatch fails, rollback only resources owned by this exact transaction. A later reassignment or new run wins and must not be reverted by the old rollback.

## 4. Worker protocol

A worker receives:

- stable Team/task/run identity;
- current `attemptId`;
- exact acceptance criteria;
- workspace path and policy;
- budget/deadline summary;
- tool restrictions;
- where and how to report.

Worker steps:

1. acknowledge/claim the exact run;
2. mark running with matching attempt;
3. work only inside authorized scope;
4. submit output and evidence;
5. report blocker or completion;
6. stop immediately on stale-attempt rejection.

The worker does not mark the canonical task completed when a review gate exists. It marks the run submitted.

## 5. Review transaction

```text
submitted run
  → freeze or snapshot output/worktree
  → execute deterministic checks
  → optional reviewer Agent
  → optional human approval
  → accepted: commit/merge artifact, complete task
  → rejected: record diagnostics, create fresh attempt or return pending
```

Reviewers must not mutate the worker’s live workspace unless the provider contract explicitly creates a repair attempt.

## 6. Mailbox

The target protocol uses a stable id and sender identity. The sender/Lead stores queued state before delivery; the target Session persists the same identity; a delivered acknowledgement follows target durability.

Guarantees should be stated precisely:

- process-local ordered retry;
- target-side de-duplication;
- no implicit cross-process exactly-once claim;
- wakeup versus quiet delivery is explicit;
- a quiet message to a member delivers only while the target is live, through the non-waking `Agent.inject` seam, and an inactive target's quiet message stays durably queued — sends, scheduler passes and reload-recovery rescans never cold-resume it; only wakeup delivery (or the member's own return) may resume it (issue #19/F13, official `dispatchOnce`/`recoverFor` parity);
- queued result means “durable but not immediately delivered,” not “send again.”

Current 0.1 satisfies the process-local ordering, explicit wakeup, queued-before-delivery and target-side de-duplication portions. It serializes delivery by message id, retries queued records after reload, frames every delivery with the stable message id, and folds the target's live or persisted inbox/history (via `sessionPersistence.inspect`, flushing the accepting target's durability checkpoint first) before any resend: a message the target already accepted is only acknowledged, never redelivered (M1B/F2, closed by the scenario-5 crash-window test in `tests/message-delivery.spec.ts`). The fold matches the exact framed text instead of the official `TeamMessageSource` source kind, so this compatibility layer does not shadow the official seam its future adapter will own.

Mailbox admission follows the official per-target pending semantics (M1B/F6): `maxPendingMessagesPerMember` (default 64, the official value) counts only queued-minus-delivered mail per target and rejects further sends with the official `TEAM_MAILBOX_FULL` code; delivered and cancelled receipts never occupy the admission quota. Retained delivered/cancelled receipts are separately bounded (`maxRetainedMessages`, default 256, a project-owned bound the official journal does not need): each terminal transition prunes the oldest receipts beyond the bound inside the same aggregate transaction, never touches queued mail, and leaves the creation-ordered replay, message identities and the revision sequence continuous. The stored record shape is unchanged — pre-F6 `schemaVersion: 1` records (including ones already holding 1024 retained messages) load unchanged and are pruned lazily by their next terminal transition.

## 7. Scheduling

The event scheduler reacts to:

- task graph mutation;
- member status becoming idle/inactive/available;
- attempt settlement;
- budget release;
- review rejection or acceptance;
- mailbox fallback readiness.

Each wake performs bounded work. It never holds a model turn open merely to poll. `waitForChange()` or capability events are preferable to UI/HTTP polling for runtime coordination.

## 8. Recovery

On process restart or plugin reload:

1. reconstruct Team state from the authoritative Session/store;
2. reconstruct open TaskRuns;
3. compare live/persisted member state;
4. invalidate attempts whose execution epoch cannot be proven alive;
5. retain artifacts and diagnostics;
6. allocate a fresh attempt before retry;
7. deliver queued-minus-delivered mailbox entries in order;
8. never reuse a retired member/run identity.

Recovery must be idempotent and safe to race with an in-process operation that was already admitted before the scan.

The 0.1 compatibility backend implements process-local checkpoints: assignment is persisted as `reserved` before delivery and `delivered` after inbox acceptance; queued messages are rescanned by stable id — with the quiet rule of §6 (an inactive target's quiet mail is skipped by every rescan; only wakeup delivery may cold-resume it, issue #19/F13); continuable children cold-resume through `ctx.subagents.followup`; active member ids are re-adopted for later disposal. Interrupted `provisioning` records are reconciled against the persisted child Session before settling (M1B/F3, official template): when the durable log proves the exact parent Session, a continuable descriptor, the provisioned provider and a durably accepted initial user prompt — enumerated live-preferred through `ctx.subagents.listChildren` when the optional projection registry is mounted, always inspected through `ctx.sessionPersistence.inspect` — the record settles `active` and the orphan child is tracked as a member again; a provable mismatch settles `failed` with an explicit drain of the orphan; evidence that cannot be verified keeps the failed settlement without draining. Removing a member cancels queued mail both to and from that member. Token usage is de-duplicated by Session event seq and counts the rc.8 disjoint `inputTokens`, `outputTokens`, `cacheReadTokens`, and `cacheWriteTokens` fields; consecutive usage events are coalesced per scope+session into one batched durable write (M1C) under the same cursor semantics, so replay and reload recovery never double-count. Cross-process leases and exactly-once delivery remain properties of a future distributed Store/Member Provider, not of the JSON backend.

## 8a. Member name lifetime, membership ambiguity and archived reads (M1C decisions)

**F12 — names live for the Team's lifetime (official alignment).** A member name is immutable and never reusable: `failed` and `removed` records stay in the roster with their names occupied forever, and the total roster size — not only occupied rows — is what `maxMembers` bounds. This matches the official experimental roster (`TEAM_MEMBER_NAME_TAKEN`, `state.members.size`), replacing the pre-M1C bounded retired-slot replacement (which also carried a latent defect: replacing the first retired slot could duplicate a name held by a different retired record). Stored v1 records load unchanged; only new provisions obey the lifetime rule. The selection boundary with the #5 F6 persistence-format work is unchanged: the stored record shape was not modified.

**F11 — ambiguity fails loud.** This domain permits a member to found its own Team in the same workspace scope, so one Session can genuinely match several active Teams (member of one, captain of another). `findMembership` collects every match and throws `TEAM_MEMBERSHIP_AMBIGUOUS` naming all matched Team ids instead of silently picking the first — routing authority, mail or accounting by list position would be arbitrary. This is an intentional hardening over the official experimental first-match resolution (the official service cannot construct that overlap); the #19 official-compat group revisits it if the official adapter needs a deterministic preference rule.

**F14 — archived Teams are read-only, not unreadable.** Reads and writes split their authority resolution: every mutation keeps rejecting on an archived aggregate with `TEAM_ARCHIVED`, while `snapshot`/`waitForChange` resolve the archived captain so the terminal state stays inspectable. An archived Team can never commit a later revision, so a `waitForChange` caller whose cursor is already current gets the terminal snapshot immediately instead of waiting out its timeout (`changed` derives from the authoritative revision). Members removed at archive are not archived readers. The read membership path prefers the captain's next active Team once one exists, and captainship of several archived Teams is the same `TEAM_MEMBERSHIP_AMBIGUOUS` failure.

**F15 — capability preflight.** Every member carries the configured delegation-depth cap, so `addMember` preflights the provider's advertised `depthLimit` capability (alongside `persona`/`toolFilter`) and rejects with `TEAM_MEMBER_PROVIDER_INCOMPATIBLE` before any provisioning record commits — a provider without the capability surfaces at preflight instead of late (or silently ignored) at child start.

## 8b. Official compatibility semantics (M1C issue #19 decisions)

Four semantic groups were decided explicitly against the pinned official experimental `agent-team` sources (`141eb6f`; details in `02` §7.1) and the `dsh-agent-teams` reference. Each row is either aligned or a documented intentional divergence:

| Group | Decision | Rationale |
|---|---|---|
| `waitForChange` window | **Aligned**: the wait tool and runtime validate an integer window of 10000..3600000 ms (default 30000) and reject with the official `TEAM_INVALID_TIMEOUT` code. | The official `TeamActivity.wait` window bounds accidental long parks and mis-typed units; there is no reason to keep the pre-#19 1..300000 private range. |
| `waitForChange` return shape | **Intentional divergence**: the runtime keeps `{snapshot, changed}` and the tool keeps `{changed, revision, ready_task_ids, queued_messages}` instead of the official single `{timedOut}`. | This domain's wait is cursor-based over the revision CAS (an intentional superset, `02` §7.1): the caller observes the authoritative aggregate state at wake, so no follow-up list/status round-trip is needed. `changed === !timedOut` for every non-archived resolution, and an archived Team resolves immediately even at a current cursor (F14). The future official adapter maps `changed` to `timedOut` and drops the surplus snapshot fields. |
| No replay of already-happened edges | **Documented**: level-triggered by design. | Official waiters are edge-triggered (registered after an edge waits for the next one). Ours resolves whenever the authoritative revision exceeds the caller's cursor — from the caller's perspective that state is new information, not a replay, and the cursor contract (not registration order) is the wake authority. Same divergence family as the revision superset itself. |
| Structured cancellation | **Aligned**: caller abort rejects before registration (`throwIfAborted`) and surfaces as one structured `TEAM_WAIT_ABORTED` domain error wrapping the abort reason. | Model-visible structured errors are the domain error contract; raw `AbortError` reasons are not. |
| Quiet to an inactive member (F13) | **Aligned**: quiet mail to a member delivers only while the target is live (`ctx.agents`), through the non-waking `Agent.inject` seam; an inactive target's quiet message stays durably queued across sends, scheduler passes and reload-recovery rescans. | Official `dispatchOnce`/`recoverFor` parity: quiet must never cold-resume a member; the send tool's queued result already means "durable, do not resend". |
| Quiet ordered bypass (`messagePrecedes`) | **Structural equivalent, formal serialization diverged**: the inject-based quiet delivery never queues behind an in-flight wakeup dispatch (the official bypass's effect), but per-target dispatch serialization in durable queue order (official `dispatchTails`) is not implemented — delivery chains are per message id and per scheduling pass iterate the aggregate's creation-ordered pending ids. | Per-target dispatch tails were absent before #19 (pre-existing property); adding them is adapter-era work because it interacts with the cross-process store Provider (M7). The per-pass creation-ordered iteration preserves practical ordering; the frame-identity fold (F2) keeps any interleaving idempotent at the target. |
| Lead-only keepInbox interrupt | **Aligned**: captain-only `interruptMember` runtime API plus the `agent_swarm_interrupt_member` tool cancel one member's current turn through `ctx.subagents.interrupt(kind: 'ancestor')` — which is `Agent.cancel(cause, {keepInbox: true})` — without releasing task ownership, removing the roster row, cancelling mail or draining the Activation. | Official roster `interrupt` parity; exposing the tool follows the official `interrupt_agent` model tool and the existing captain-only tool family (`removeMember` keeps its stronger fence+drain semantics). |
| Unicode member names | **Project overlay adopting the reference pattern**: names fold through NFC normalization plus the `\p{L}\p{N}` whitelist (runs of anything else fold to `-`), so CJK/Cyrillic/Greek names stay distinct; over-length (>64 code points) and letter-less names are **rejected** (`TEAM_MEMBER_NAME_INVALID`) rather than truncated with a digest suffix; `captain` stays reserved. Mail targets and interrupt targets resolve through the same fold. | The official roster is ASCII-kebab-only, so Unicode names are a reference-derived project capability, not an official seam. Rejection over digest suffix: a roster name is an identity (collisions already fail loud through `TEAM_MEMBER_NAME_TAKEN`), the ref needed digests only because its keys are filesystem segments, and truncation would manufacture new collisions. Stored records are unchanged; only new provisions obey the policy. |


## Authoritative storage transition (implemented in M1A)

The pre-M1A Team aggregate was a structurally validated JSON file inside the shared workspace. That protected against malformed state but not a workspace writer forging valid captain, task, budget or mailbox fields; prompt guidance could not authorize or protect that file.

ADR-0007 defines the M1 authority transition, implemented in M1A: one `TeamDomainPort` Provider opens the official `agent_swarm` Storage Domain, stores one versioned Team aggregate per record (plus durable migration receipts), and commits durability before publishing a change. `sessionPersistence` and `storageDomain` are required injections; a Profile missing either never activates the plugin. `FileTeamStore` is now a read-only offline migration reader. Import requires an empty destination, verifies the durable read-back, retains a receipt and never enables dual write; the runtime performs no automatic migration or fallback. This local Provider is still process-local; distributed ownership waits for a Provider with atomic claims, leases and fencing.

## 9. Limits

Every retained or emitted value needs explicit limits at the point where its complete size is known:

- members/tasks/messages;
- message bytes including framing;
- task description/output bytes;
- DAG depth/edges;
- pending attempts;
- worktree disk usage;
- token/request/retry/time budget;
- teardown timeout.

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
- queued result means “durable but not immediately delivered,” not “send again.”

Current 0.1 satisfies the process-local ordering, explicit wakeup, queued-before-delivery and target-side de-duplication portions. It serializes delivery by message id, retries queued records after reload, frames every delivery with the stable message id, and folds the target's live or persisted inbox/history (via `sessionPersistence.inspect`, flushing the accepting target's durability checkpoint first) before any resend: a message the target already accepted is only acknowledged, never redelivered (M1B/F2, closed by the scenario-5 crash-window test in `tests/message-delivery.spec.ts`). The fold matches the exact framed text instead of the official `TeamMessageSource` source kind, so this compatibility layer does not shadow the official seam its future adapter will own.

The current `maxMessages` counts delivered and cancelled history as well as queued mail. Because no retention path removes those records, a Team can reach the limit with zero pending messages and lose its mailbox permanently. M1 changes the admission quota to per-target pending mail and gives retained receipts a separate bounded policy.

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

The 0.1 compatibility backend implements process-local checkpoints: assignment is persisted as `reserved` before delivery and `delivered` after inbox acceptance; queued messages are rescanned by stable id; continuable children cold-resume through `ctx.subagents.followup`; active member ids are re-adopted for later disposal. Interrupted `provisioning` records are reconciled against the persisted child Session before settling (M1B/F3, official template): when the durable log proves the exact parent Session, a continuable descriptor, the provisioned provider and a durably accepted initial user prompt — enumerated live-preferred through `ctx.subagents.listChildren` when the optional projection registry is mounted, always inspected through `ctx.sessionPersistence.inspect` — the record settles `active` and the orphan child is tracked as a member again; a provable mismatch settles `failed` with an explicit drain of the orphan; evidence that cannot be verified keeps the failed settlement without draining. A later provision replaces one retired `failed`/`removed` slot and deletes that retired Session usage cursor, keeping the retained member array bounded by `maxMembers` without reusing its Session identity. Removing a member cancels queued mail both to and from that member. Token usage is de-duplicated by Session event seq and counts the rc.8 disjoint `inputTokens`, `outputTokens`, `cacheReadTokens`, and `cacheWriteTokens` fields. Attempt records are currently append-only and unbounded; M1 must retain stale-id audit/fencing while bounding historical detail. Cross-process leases and exactly-once delivery remain properties of a future distributed Store/Member Provider, not of the JSON backend.

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

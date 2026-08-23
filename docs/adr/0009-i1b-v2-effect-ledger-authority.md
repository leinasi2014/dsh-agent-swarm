# ADR-0009: I1b requires a migrated v2 Team authority for restart-safe effect correlation

- Status: Proposed — implementation is blocked until independent architecture acceptance
- Date: 2026-08-23
- Supersedes: no accepted decision; extends ADR-0007 for the I1b storage-format transition
- Scope: Team-domain effect correlation only; Host, RPC, UI, Canvas and distributed ownership are excluded

## Context

SW-I1a persists HumanInteraction requests and receipts in `agent_swarm_human`, then sends every Team mutation through the sole `TeamDomainPort`. It deliberately quarantines an operation as `TEAM_INTERACTION_OUTCOME_UNKNOWN` when a process can fail after an effect may have committed but before its HumanInteraction receipt is acknowledged. Process-local locking prevents a blind retry in the same activation, but after a crash the overlay alone cannot distinguish an effect that never reached the Team aggregate from one that committed and lost only its projected receipt.

The existing `agent_swarm` Storage Domain stores a `schemaVersion: 1` Team as one aggregate record. That single-record boundary is valuable: roster, task, attempt, mailbox, budget and revision mutations commit together. It does not contain a durable interaction-effect receipt. Adding a receipt to a second Storage Domain would place the Team mutation and its evidence in separate writes, preserving the exact crash window I1b is meant to close.

The official Storage Domain currently has no in-place domain-version migration seam. Reopening stamped v1 media with a bumped descriptor fails closed, while changing a same-version record layout is undefined. A silent optional field added to v1 would therefore evade, not satisfy, the versioned authority contract established by ADR-0007.

## Decision

### 1. Establish one v2 Team authority through explicit migration

I1b will introduce a new canonical Storage Domain identity, `agent_swarm_v2`, whose domain descriptor starts at version 1 and whose Team record has `schemaVersion: 2`. The v2 Team aggregate adds the effect ledger described below while retaining one Team per atomic record. It replaces `agent_swarm`; it never runs beside it as a second writer.

Migration runs before normal plugin activation and while Team/HumanInteraction admission is quiesced. Before its first write, it requires a verified pre-migration backup locator and digest outside the live authority medium. It is single-process and follows this order for every source Team:

1. open the v1 source through its frozen read schema and enumerate a stable source set;
2. validate the complete v1 aggregate and record its Team id, revision and canonical source digest;
3. require the corresponding v2 destination and migration-receipt key to be absent, except for an exact idempotent resume described below;
4. transform to a validated `schemaVersion: 2` aggregate with an empty effect ledger and otherwise equivalent authority state;
5. durably write the v2 aggregate, read it back, validate it and compare its canonical target digest;
6. durably append a migration receipt binding source domain/version, Team id, source revision, source digest, target schema, target digest and migration time;
7. read back the receipt and destination before that Team is considered migrated.

A restart normally resumes when the existing destination and receipt exactly match the re-read v1 source and the deterministic transform. One deliberately supported partial state closes the write→receipt crash window: when the destination exists without a receipt, the source digest/revision is unchanged, and a fresh read-back proves the destination byte-equivalent to the deterministic transform, migration may append and verify the missing receipt without rewriting the Team. A receipt without its destination, a mismatched destination, a changed source, or any other validation/read-back disagreement is an inconsistency and fails loud. No step silently overwrites either side.

After every source Team has a verified destination and receipt and the source set has not changed, migration writes and reads back one v2 authority-cutover record. That record binds authority epoch 2, the complete source/destination set digests, the backup evidence digest and the minimum compatible artifact contract. New installations create the equivalent fresh-v2 authority record before their first Team. Normal activation requires this record and never treats a partially migrated set as runnable.

After cutover, production code opens v2 as the sole writable Team authority; it does not dual-write, read-fallback or auto-import from v1. The v1 source is closed and retained only as read-only recovery evidence under deployment controls.

### 2. Rollback is compatibility-fenced, not an old-binary restart

An old binary knows only `agent_swarm` v1. Starting it after v2 cutover could accept writes into the retired source and create two divergent Team histories. That is split-brain, not rollback. The release/activation compatibility gate must therefore reject an artifact that does not understand the recorded v2 authority epoch once migration has completed. Operators must keep a pre-migration backup and the immutable migration receipts.

Supported recovery is limited to:

- restore the complete pre-migration backup before admitting any v2 write;
- keep v2 authoritative and apply a reviewed forward repair or replacement binary; or
- use an explicitly verified compatibility adapter that reads the v2 authority without reopening v1 as a writer.

There is no automatic merge of divergent v1/v2 histories and no downgrade fallback. If an old binary was admitted after cutover, both media are quarantined, v2 remains the declared authority, and recovery requires an evidence-backed forward decision.

### 3. Put the applied-effect receipt inside the Team transaction

`TeamState` v2 contains a bounded `interactionEffects` ledger. One entry represents an effect proven applied by the same aggregate transaction that performed its canonical Team mutation. Absence is authoritative evidence of `not-applied` only for an operation whose mutation and receipt share that transaction.

Each entry contains only:

- a stable `effectId` derived from the canonical `(workspace scope, Team id, request id, effect step)` tuple;
- request id, request creation time and a secret-free structural binding of intent, target and revision/attempt fences;
- a closed effect-step enum such as `relay-mail`, `answer-mail`, `wake-mail`, `correct-mail`, `task-reassign` or `task-review`;
- `status: applied`, application time and resulting Team revision;
- bounded authority evidence appropriate to the step: message id, task id, attempt id or decision enum.

It never stores message/answer bodies, free-form diagnostics, principal references, provider exceptions, paths, tokens, credentials or raw causes. The HumanInteraction overlay remains the request and final receipt authority; the Team ledger records only the fact needed to classify the Team mutation. Public diagnostics remain fixed and secret-free.

The ledger has an explicit per-Team capacity. Applied receipts are not pruned merely because a delivered message or settled attempt leaves its normal retention window: deleting the last deduplication fact would make a later replay unsafe. Capacity exhaustion fails closed before mutation with a stable error. Safe compaction requires its own accepted tombstone/archive protocol and is not part of I1b-1A.

### 4. Apply Team effects with once-only domain methods

The first implementation slice adds `queueMessageOnce` to `TeamDomainPort`. Inside one `TeamAggregateStore.transact` it validates caller and mailbox admission, then:

- returns the stored authority evidence without mutation when the same `effectId` and structural binding already exist;
- fails loud on an identity/binding conflict;
- otherwise creates exactly one Team message and appends exactly one applied-effect receipt in the same v2 aggregate write.

The first consumer is member-question relay mail. The overlay is durably prepared before the call; after the call it projects the returned message id and Team revision. A crash after the aggregate write but before overlay acknowledgement is recovered from the v2 effect receipt and cannot create a second mail item. Existing target-side mailbox delivery and visibility remain responsible for delivery; a Team applied receipt is not proof that the target observed the message.

Later Team-internal steps may use the same pattern for wake/correct mail, canonical task reassignment and the final Team review transition. They require their own focused work packages and fault tests.

### 5. Recover by classification, never by automatic replay

Startup keeps public HumanInteraction admission closed while an internal recovery pass scans non-terminal and `TEAM_INTERACTION_OUTCOME_UNKNOWN` overlay records. For every Team-internal effect it reads the v2 ledger by exact scope, Team, request and step:

- no matching entry: `not-applied`;
- one matching applied entry: `applied`, then finalize the overlay projection without invoking the effect again;
- a final overlay receipt referring to the matching evidence: `acknowledged`;
- mismatched, orphaned or duplicate evidence: `corrupt`, fail loud and preserve both records;
- an effect owned by an external seam without authoritative read-back: remain `outcome-unknown`.

Recovery may classify or finish a projection. It does not mint a caller, re-execute an effect, or revive expired human intent. Even a proven `not-applied` request requires a fresh authorized retry of the same request, including live-captain/principal admission and current Team/task/attempt fences. Cancel and expiry may settle only a Team-internal effect proven absent; they never overwrite an applied or externally unknown effect.

Process-local request serialization and the per-Team aggregate transaction remain required. Cross-process exactly-once, distributed CAS, leases and fencing remain M8 work and are not implied by this design.

### 6. External effect seams remain blockers

The following effects cannot enter an `applied` Team receipt merely because the plugin invoked an adapter:

- **Question presentation.** Current official `ctx.userQuestions` exposes `ask()` but no durable operation identity or `read` result. A deterministic question id is presentation data, not proof of provider deduplication. The required upstream capability is `askOnce(operationId, request)` plus `read(operationId) -> not-found | pending | answered`, with durable payload-conflict rejection owned by the provider.
- **Member interrupt.** Current `ctx.subagents.interrupt` admits synchronously, issues cancellation asynchronously and returns without target observation. It lacks a target activation/turn epoch and a durable operation receipt/query. The required seam is an idempotent `interruptOnce` bound to a stable target epoch plus `readInterrupt(operationId) -> not-found | accepted | observed`.
- **Review Provider execution.** `TeamReviewProvider` currently declares neither deterministic purity nor operation-result recovery. Only a provider explicitly proven pure and deterministic may be replayed safely. Other providers require `executeOnce(operationId)` plus `readResult`; the human provider inherits the question-presentation blocker. The final Team review mutation can use the v2 ledger only after a trustworthy decision exists.

Until those contracts exist, presentation, interrupt and affected review requests remain durable, secret-free `outcome-unknown` and fail loud. Swarm must not infer their result from transcript text, Agent status, process memory or a private browser queue.

## Verification contract

I1b-1A must exercise real persistent storage and process-boundary reopen, not mocks alone. The minimum matrix covers:

1. migration interruption before destination write, after destination write, after read-back and before/after receipt write;
2. idempotent migration resume, changed-source refusal, partial destination/receipt corruption and source-set drift;
3. process death after overlay prepare but before Team transaction;
4. process death after the v2 aggregate put but before `queueMessageOnce` returns;
5. process death after return but before overlay acknowledgement, and after acknowledgement;
6. reopen plus authorized retry proving one effect receipt and one relay mail even after normal terminal-mail retention;
7. identity/binding conflict, effect-capacity exhaustion, cross-scope/Team request-id isolation and concurrent same-effect calls;
8. legacy I1a unknown without a v2 receipt remaining unresolved rather than guessed;
9. admission remaining closed throughout recovery and cancellation/expiry refusing applied or unknown effects;
10. injected path/token/payload markers absent from effect receipts, migration receipts and public error chains.

Tests for question presentation and interrupt must demonstrate the current unobservable crash window and the resulting fail-loud blocker; they cannot convert the absence of read-back into a passing exactly-once claim.

## Delivery order and non-goals

- **I1b-1A:** v2 authority migration, effect-ledger/domain contract, `queueMessageOnce`, relay-mail vertical and crash matrix.
- **I1b-1B:** wake/correct mail; answer mail only after the question provider gains authoritative read-back.
- **I1b-1C:** canonical task reassignment and deterministic/provider-correlated review; live interrupt remains blocked until its official seam changes.

This ADR does not authorize executable Host/RPC/browser/context/UI/Canvas work, transcript-derived truth, multi-process claims, automatic intent replay, effect-ledger pruning, public release or an in-place v1 schema change.

## Consequences

I1b-1A is larger than adding a second receipt table, because correctness requires the applied receipt and Team mutation to share one durability boundary. The migration and old-binary compatibility gate become prerequisites for code. In return, Team-internal effects can be classified after restart without duplicate mutations, while unsupported external effects remain honestly blocked instead of being inferred.

# ADR-0009: I1b requires a migrated v2 Team authority for restart-safe effect correlation

- Status: Proposed — implementation is blocked until independent architecture acceptance
- Date: 2026-08-23
- Supersedes: no accepted decision; extends ADR-0007 for the I1b storage-format transition
- Scope: Team-domain effect correlation only; Host, RPC, UI, Canvas and distributed ownership are excluded

## Context

SW-I1a persists HumanInteraction requests and receipts in `agent_swarm_human`, then sends every Team mutation through the sole `TeamDomainPort`. It deliberately quarantines an operation as `TEAM_INTERACTION_OUTCOME_UNKNOWN` when a process can fail after an effect may have committed but before its HumanInteraction receipt is acknowledged. Process-local locking prevents a blind retry in the same activation, but after a crash the overlay alone cannot distinguish an effect that never reached the Team aggregate from one that committed and lost only its projected receipt.

The existing `agent_swarm` Storage Domain stores a `schemaVersion: 1` Team as one aggregate record. That single-record boundary is valuable: roster, task, attempt, mailbox, budget and revision mutations commit together. It does not contain a durable interaction-effect receipt. Adding a receipt to a second Storage Domain would place the Team mutation and its evidence in separate writes, preserving the exact crash window I1b is meant to close.

The official Storage Domain currently has no in-place domain-version migration seam. Reopening stamped v1 media with a bumped descriptor fails closed, while changing a same-version record layout is undefined. A silent optional field added to v1 would therefore evade, not satisfy, the versioned authority contract established by ADR-0007.

## Proposal authority and applicability

This ADR remains a proposal. It is registered as decision reference, not accepted stable authority, and cannot by itself block an independently safe read-only delivery slice or authorize migration code. Acceptance requires a later immutable candidate and independent architecture review; rejection or replacement does not reverse ADR-0007's existing single-Team-authority rule.

The blocker described below applies only when a write capability depends on the proposed v2 effect ledger and the deployment may contain v1 media or admit a pre-v2 binary. It does not block:

- packaging and real isolated-Profile proof of the existing plugin;
- the already frozen read-only contract floor;
- bounded read-only Host and `/swarm` RPC projections;
- DSH-native or Canvas-native read consumers;
- opening the same official DSH Session so the user can communicate with the root captain through official Chat.

Those read/advisory slices mint no Team authority and keep every direct privileged write capability unavailable. Clean-profile v2, explicit offline migration, supported-backend conversion and downgrade policy are separate product decisions to evaluate before accepting this proposal; they must not be silently replaced by a universal online-migration requirement.

## Decision

### 1. Establish one v2 Team authority through explicit migration

I1b will introduce a new canonical Storage Domain identity, `agent_swarm_v2`, whose domain descriptor starts at version 1 and whose Team record has `schemaVersion: 2`. The v2 Team aggregate adds the effect ledger described below while retaining one Team per atomic record. It replaces `agent_swarm`; it never runs beside it as a second writer. The correlation overlay also moves explicitly to `agent_swarm_human_v2` record schema 2: migrated records carry `admissionAuthorityEpoch: 1`, while requests admitted only after cutover carry epoch 2. This avoids guessing a request's origin from timestamps or from ledger absence.

Migration runs outside normal plugin activation under one host-owned migration controller. Before its first v2 write, that sole lifecycle owner must hold an exclusive single-process cutover lease and complete a durable quiescence protocol. It stops new admission and drains provisioning, scheduler passes, message delivery, usage folding, workflow Team drivers, HumanInteraction operations and overlay writes; it then closes every **runtime writer** handle for the v1 Team and HumanInteraction domains. A durable drain receipt at the controller's configured evidence locator outside both live domains records the owner identity, source artifact digest, subsystem watermarks, final Team/overlay set digests and the close results, and is read back by digest. Any concurrent admission, drain timeout, unsettled operation or close failure aborts before the first v2 write. "The process looks idle" and the existing M3 promoter's session stillness check are not substitutes for this lifecycle receipt.

Before that drain begins, the compatibility blocker in §2 must be resolved. Before the first write, migration also requires a verified pre-migration backup locator and digest outside the live authority medium. After runtime handles close, only the migration controller may reopen v1 through a process-internal frozen read-only adapter: it exports and invokes no mutation interface, and closes after the source read/verification. This is a software capability restriction, not a claim that the current official Domain handle or storage medium is physically read-only; physical retirement requires the independently verified Provider fence in §2. The controller then follows this order:

1. open the v1 source through its frozen read schema and enumerate a stable source set;
2. validate the complete v1 Team aggregate and record its Team id, revision and canonical source digest;
3. require the corresponding v2 destination and migration-receipt key to be absent, except for an exact idempotent resume described below;
4. transform to a validated `schemaVersion: 2` aggregate with an empty effect ledger and otherwise equivalent authority state;
5. durably write the v2 aggregate, read it back, validate it and compare its canonical target digest;
6. durably append a migration receipt binding source domain/version, Team id, source revision, source digest, target schema, target digest and migration time;
7. read back the receipt and destination before that Team is considered migrated;
8. transform every v1 HumanInteraction record into human-v2 schema without changing request/receipt meaning, marking it `admissionAuthorityEpoch: 1`, then write, read back and receipt that migration under the same closed-source discipline.

A restart normally resumes when the existing destination and receipt exactly match the re-read v1 source and the deterministic transform. One deliberately supported partial state closes the write→receipt crash window: when the destination exists without a receipt, the source digest/revision is unchanged, and a fresh read-back proves the destination byte-equivalent to the deterministic transform, migration may append and verify the missing receipt without rewriting the Team. A receipt without its destination, a mismatched destination, a changed source, or any other validation/read-back disagreement is an inconsistency and fails loud. No step silently overwrites either side.

Before any v2 write, the owner also enumerates the complete bounded set of v1 HumanInteraction records whose receipt is nonterminal or carries `TEAM_INTERACTION_OUTCOME_UNKNOWN`. For each `(scope, teamId, requestId)` it computes only a domain-separated canonical key digest: NFC UTF-8 fields encoded as unsigned length-prefixed bytes, prefixed with the fixed tag `dsh-agent-swarm/i1b/legacy-key/v1`. It sorts and deduplicates those digests, enforces a declared manifest capacity, and computes a second digest under `dsh-agent-swarm/i1b/legacy-set/v1` over the count plus the complete ordered digest list. Exceeding capacity, malformed canonical input or duplicate ambiguity aborts before the first v2 write. Raw scope, workspace path and tuple text are never written to the manifest.

After every source Team and overlay record has a verified destination and migration receipt and both source sets remain equal to the durable drain receipt, migration writes and reads back one v2 authority-cutover record. That record binds authority epoch 2, the complete source/destination set digests, the backup and drain-receipt digests, the minimum compatible artifact contract, the legacy-manifest capacity/count/full digest list and its set digest. New installations create the equivalent fresh-v2 authority record with an empty legacy manifest before their first Team or request. Normal activation requires this record and never treats a partially migrated set as runnable. Epoch-2 admission writes only human-v2 records with `admissionAuthorityEpoch: 2`.

After cutover, production code opens v2 as the sole writable Team authority; it does not dual-write, read-fallback or auto-import from v1. The v1 source is closed and retained as retired recovery evidence; the new runtime exports no v1 writer. This is not a physical-read-only guarantee unless the verified retired-medium Provider capability from §2 is the selected fence.

### 2. Old-binary exclusion is an implementation blocker

An old binary knows only `agent_swarm` v1. Starting it after v2 cutover could accept writes into the retired source and create two divergent Team histories. That is split-brain, not rollback. The current project has no executable pre-plugin gate capable of stopping such a binary before it opens v1, and the M3 promoter is not a mandatory activation path. Therefore v2 migration and cutover are **implementation-blocked** until one of these independently verified mechanisms exists:

1. a plugin-external, host-owned pre-plugin activation compatibility registry; or
2. a Storage Provider capability that durably retires the v1 medium and rejects every later open/write, including from an old plugin.

For option 1, the host bootstrap owner—not the Swarm candidate—owns a configured registry locator outside plugin-controlled state. Each immutable artifact entry binds artifact digest, declared supported authority epochs, registry schema/version and issuance evidence; the registry also owns the active authority selection state. The migration controller first changes that state by fenced CAS from epoch 1 to `migration-in-progress`, binding its lease and source artifact digest; read-back of that state blocks **all** plugin loading while the sources drain and migration runs. After the v2 cutover record is read back, the controller changes the registry by fenced CAS to epoch 2, binding the cutover-record digest, then reads it back before releasing the lease. A crash leaves `migration-in-progress` fail-closed for explicit resume or backup recovery—never an implicit old-plugin restart.

At every ordinary boot, host bootstrap resolves the exact artifact, reads the registry, verifies and reads back the same artifact/entry/registry digests, and admits plugin loading only when the artifact explicitly declares support for the active authority epoch. A missing entry, an old artifact with no epoch declaration, `migration-in-progress`, an unreadable/mismatched registry or a stale digest rejects **before any plugin module loads and before any v1 domain open/write**. The cutover record binds the accepted registry locator identifier and digest, but not a machine-specific path or secret.

For option 2, the Provider/controller must durably fence new plugin starts while draining, then retire v1 before the first v2 write; a conformance test must prove both fences survive process restart and cause an actual old artifact's v1 open/write to fail before mutation. A configuration flag interpreted only by the new plugin is insufficient. In either option, a real pre-v2 artifact is the negative fixture: after epoch-2 selection it must be unable to open or change v1, while the exact accepted v2 artifact passes and the owner reads the decision back. Until that evidence exists, migration code may be designed and tested against disposable fixtures but must not start cutover on user media.

Supported recovery is limited to:

- restore the complete pre-migration backup before admitting any v2 write;
- keep v2 authoritative and apply a reviewed forward repair or replacement binary; or
- use an explicitly verified compatibility adapter that reads the v2 authority without reopening v1 as a writer.

There is no automatic merge of divergent v1/v2 histories and no downgrade fallback. If an old binary was admitted after cutover, both media are quarantined, v2 remains the declared authority, and recovery requires an evidence-backed forward decision. Operators must keep a verified pre-migration backup and immutable drain/migration/cutover receipts.

### 3. Put the applied-effect receipt inside the Team transaction

`TeamState` v2 contains a bounded `interactionEffects` ledger. One entry represents an effect proven applied by the same aggregate transaction that performed its canonical Team mutation. Absence is authoritative evidence of `not-applied` only for an operation whose mutation and receipt share that transaction.

Each entry contains only:

- a stable `effectId` computed as a cryptographic digest of NFC UTF-8, unsigned length-prefixed tuple fields under the fixed domain tag `dsh-agent-swarm/i1b/effect-key/v1` for `(scope, Team id, request id, effect step)`;
- request id, request creation time and a secret-free structural binding of intent, target and revision/attempt fences;
- a closed effect-step enum such as `relay-mail`, `answer-mail`, `wake-mail`, `correct-mail`, `task-reassign` or `task-review`;
- `status: applied`, application time and resulting Team revision;
- bounded authority evidence appropriate to the step: message id, task id, attempt id or decision enum.

It never stores the raw scope/workspace path, message/answer bodies, free-form diagnostics, principal references, provider exceptions, paths, tokens, credentials or raw causes. The Team id already belongs to the containing aggregate; request/step evidence is bounded and contains no path. The HumanInteraction overlay remains the request and final receipt authority; the Team ledger records only the fact needed to classify the Team mutation. Public diagnostics remain fixed and secret-free. Canonical encoders are shared protocol primitives with fixed test vectors, never `JSON.stringify` or host-locale ordering.

The ledger has an explicit per-Team capacity. Applied receipts are not pruned merely because a delivered message or settled attempt leaves its normal retention window: deleting the last deduplication fact would make a later replay unsafe. Capacity exhaustion fails closed before mutation with a stable error. Safe compaction requires its own accepted tombstone/archive protocol and is not part of I1b-1A.

### 4. Apply Team effects with once-only domain methods

The first implementation slice adds `queueMessageOnce` to `TeamDomainPort`. Before durable access it strictly parses and bounds the request, resolves the actual caller independently of payload ids, and constructs the canonical effect binding. Inside one `TeamAggregateStore.transact` it authenticates that caller against the exact Team and then follows this order:

- find by `effectId`; return stored authority evidence with zero target/quota/fence/mutation side effects when the existing receipt and binding match exactly;
- fail loud with zero side effects when that identity exists with a different binding;
- only when the receipt is absent, execute the current mailbox target resolution, self-send rejection, quota, content and revision/attempt fence admission;
- create exactly one Team message and append exactly one applied-effect receipt in the same v2 aggregate write.

The first consumer is member-question relay mail. The overlay is durably prepared before the call; after the call it projects the returned message id and Team revision. A crash after the aggregate write but before overlay acknowledgement is recovered from the v2 effect receipt and cannot create a second mail item. Existing target-side mailbox delivery and visibility remain responsible for delivery; a Team applied receipt is not proof that the target observed the message.

Later Team-internal steps may use the same pattern for wake/correct mail, canonical task reassignment and the final Team review transition. They require their own focused work packages and fault tests.

### 5. Recover by classification, never by automatic replay

Startup keeps public HumanInteraction admission closed while an internal recovery pass scans non-terminal and `TEAM_INTERACTION_OUTCOME_UNKNOWN` human-v2 records. It recomputes the canonical tuple digest and reads the cutover legacy manifest before interpreting ledger absence. For every Team-internal effect it then reads the v2 ledger by exact scope, Team, request and step:

- a record with `admissionAuthorityEpoch: 1` or a tuple digest present in the complete legacy manifest: `legacy-unresolved`, regardless of ledger absence;
- an epoch-2 record whose tuple digest is absent from the legacy manifest and has no matching entry: `not-applied`;
- one matching applied entry: `applied`, then finalize the overlay projection without invoking the effect again;
- a final overlay receipt referring to the matching evidence: `acknowledged`;
- mismatched, orphaned or duplicate evidence: `corrupt`, fail loud and preserve both records;
- an effect owned by an external seam without authoritative read-back: remain `outcome-unknown`.

Ledger absence alone is never enough: only the conjunction of epoch-2 admission, absence from the frozen legacy manifest and absence from the atomic v2 ledger proves `not-applied`. Any epoch/manifest disagreement is corrupt and fails loud. Recovery may classify or finish a projection. It does not mint a caller, re-execute an effect, or revive expired human intent. Even a proven `not-applied` request requires a fresh authorized retry of the same request, including live-captain/principal admission and current Team/task/attempt fences. Cancel and expiry may settle only a Team-internal effect proven absent; they never overwrite an applied, legacy-unresolved or externally unknown effect.

Process-local request serialization and the per-Team aggregate transaction remain required. Cross-process exactly-once, distributed CAS, leases and fencing remain M8 work and are not implied by this design.

### 6. External effect seams remain blockers

The following effects cannot enter an `applied` Team receipt merely because the plugin invoked an adapter:

- **Question presentation.** Current official `ctx.userQuestions` exposes `ask()` but no durable operation identity or `read` result. A deterministic question id is presentation data, not proof of provider deduplication. The required upstream capability is `askOnce(operationId, request)` plus `read(operationId) -> not-found | pending | answered`, with durable payload-conflict rejection owned by the provider.
- **Member interrupt.** Current `ctx.subagents.interrupt` admits synchronously, issues cancellation asynchronously and returns without target observation. It lacks a target activation/turn epoch and a durable operation receipt/query. The required seam is an idempotent `interruptOnce` bound to a stable target epoch plus `readInterrupt(operationId) -> not-found | accepted | observed`.
- **Review Provider execution.** `TeamReviewProvider` currently declares neither deterministic purity nor operation-result recovery. Only a provider explicitly proven pure and deterministic may be replayed safely. Other providers require `executeOnce(operationId)` plus `readResult`; the human provider inherits the question-presentation blocker. The final Team review mutation can use the v2 ledger only after a trustworthy decision exists.

Until those contracts exist, presentation, interrupt and affected review requests remain durable, secret-free `outcome-unknown` and fail loud. Swarm must not infer their result from transcript text, Agent status, process memory or a private browser queue.

## Verification contract

I1b-1A must exercise real persistent storage and process-boundary reopen, not mocks alone. The minimum matrix covers:

1. all listed runtime writers stopped and drained by the sole lifecycle owner, with concurrent admission, every subsystem timeout and every v1 close failure proving zero v2 writes;
2. migration interruption before destination write, after destination write, after read-back and before/after receipt write;
3. idempotent Team/human-overlay migration resume, changed-source refusal, partial destination/receipt corruption and source-set drift;
4. bounded complete legacy-manifest construction, canonical digest test vectors, capacity refusal and raw scope/path absence;
5. actual old artifacts rejected before v1 open/write by the host registry or verified retired-medium fence, plus exact registry locator/digest read-back;
6. process death after overlay prepare but before Team transaction;
7. process death after the v2 aggregate put but before `queueMessageOnce` returns;
8. process death after return but before overlay acknowledgement, and after acknowledgement;
9. reopen plus authorized retry proving one effect receipt and one relay mail even after normal terminal-mail retention;
10. exact replay returning before target/quota/fence admission, identity/binding conflict, effect-capacity exhaustion, cross-scope/Team request-id isolation and concurrent same-effect calls;
11. every migrated/manifest-listed I1a unknown remaining legacy-unresolved while an epoch-2 non-manifest absence alone becomes not-applied;
12. admission remaining closed throughout recovery and cancellation/expiry refusing applied, legacy or unknown effects;
13. injected path/token/payload markers absent from effect/legacy digests, durable receipts and public error chains.

Tests for question presentation and interrupt must demonstrate the current unobservable crash window and the resulting fail-loud blocker; they cannot convert the absence of read-back into a passing exactly-once claim.

## Delivery order and non-goals

- **I1b-1A:** v2 authority migration, effect-ledger/domain contract, `queueMessageOnce`, relay-mail vertical and crash matrix.
- **I1b-1B:** wake/correct mail; answer mail only after the question provider gains authoritative read-back.
- **I1b-1C:** canonical task reassignment and deterministic/provider-correlated review; live interrupt remains blocked until its official seam changes.

This ADR does not authorize executable Host/RPC/browser/context/UI/Canvas work, transcript-derived truth, multi-process claims, automatic intent replay, effect-ledger pruning, public release or an in-place v1 schema change.

## Consequences

If accepted for a deployment that carries v1 authority, I1b-1A is larger than adding a second receipt table, because correctness requires the applied receipt and Team mutation to share one durability boundary. The migration and old-binary compatibility gate become prerequisites for activating the affected write capabilities, not for the read lane. In return, Team-internal effects can be classified after restart without duplicate mutations, while unsupported external effects remain honestly blocked instead of being inferred.

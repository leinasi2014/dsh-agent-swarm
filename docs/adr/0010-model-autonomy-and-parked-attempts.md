# ADR-0010: Model autonomy, parked attempts and explicit continuation

- Status: Proposed / unique non-author QA required
- Date: 2026-08-25
- Candidate base: `b87979c9f96c654f95a4fd95f18326cfd23d2d70`
- Amends: `docs/development/2026-08-24-team-runtime-architecture-blueprint-v1.md`
- Supersedes after acceptance: the default time-driven stranded self-heal in `docs/04-core-protocol.md` §8c
- Does not modify: official DSH, its Agent Loop, provider reasoning behavior, or user media

## 1. Outcome and non-goals

The Team control plane governs identity, ownership, permissions, durable intent, evidence, recovery and acceptance. It does not prescribe how an LLM reasons, how many plans it may form, or how soon it must modify a file. Different providers and models may plan deeply, act immediately, revise a plan after new evidence, or spend a whole valid turn on diagnosis.

This decision replaces one unsafe inference in the current plugin: an official member becoming `idle` while retaining an `in_progress` task does not prove that the attempt failed or was abandoned. The target state is neutral and durable: the attempt becomes `parked`, retains its identity and execution root, and continues only through an explicit fenced resume. A new generation is created only by explicit reassignment/retry authority or by a proven hard-lease takeover in a future distributed Provider.

This ADR does not add a second Agent Loop, private model runner, private transcript, periodic polling daemon, or reasoning observer. It does not make a heartbeat, timeout, UI projection or model report authoritative completion evidence.

## 2. Evidence and rejected alternatives

Three independent read-only reviews agreed on the same boundary:

- `src/runtime/usage-prompt.ts`, `src/runtime/member-control.ts` and `docs/04-core-protocol.md` already prohibit interruption based on silence, planning time, missing file changes or model claims; only host-confirmed unmatched tool calls currently authorize model-side emergency interruption.
- ADR-0008 §Decision 8-9 requires the manager to observe durable state instead of private reasoning and gives model execution no manager-imposed convergence ceiling unless the user configures one.
- The reviewed dsh-agent-teams `0.1.13` reference preserves an idle owner/attempt and uses explicit resume instead of status-query-driven retry storms.

The R10 real-team audit supplies direct counterevidence to a universal first-output timer. Frontend, backend and QA first wrote business/test artifacts only after roughly 280, 262 and 223 seconds respectively, while continuing to emit official step/tool evidence. Frontend and backend then completed useful tested work under generation 1. A stale “write within 60 seconds” followup arrived only after frontend acceptance and rewrote the accepted root with byte-equivalent content. R10 therefore proves that the timer would false-positive healthy work and that post-accept root mutation must be closed; it does not quantify one model as universally better or prove durable recovery.

The following alternatives are rejected:

| Alternative | Rejection |
|---|---|
| Prompt says “one plan” or “write within 60 seconds” | Not enforceable as a runtime contract; biases models toward premature or meaningless output and creates a prompt-level shadow loop. |
| `idle` automatically creates a fresh same-owner attempt after a global delay | `idle` is a lifecycle observation, not abandonment evidence; it duplicates cost and loses intentional pause semantics. |
| Missing heartbeat fails or completes the task | Heartbeat is lease/liveness evidence only. Expiry revokes an execution right and starts reconciliation; it proves no business outcome. |
| File diff or token growth defines progress | Both produce false positives and false negatives. Only acceptance-bearing events and decision-relevant evidence matter. |
| Automatic interruption from suspected repetition | A detector can be wrong. The first implementation may project evidence, but only deterministic host/tool-call evidence or an explicit authorized control act may interrupt. |

## 3. Authority boundaries

```text
Official DSH Agent Loop
  owns model requests, reasoning mode, steps, tools, Session and turn settlement
                     │ official events / continuable child seam
                     ▼
Team control plane
  owns Team / Task / Attempt / Mailbox / review / effect intent and CAS
                     │ bounded projections
          ┌──────────┴──────────┐
          ▼                     ▼
      UI / RPC               Jobs / logs
      read-only              observation/cancel surface
```

The plugin may configure the official provider/model/reasoning options exposed by DSH. It may not infer hidden thought state, count “plans”, impose a private step budget, or re-run the model outside the official loop.

## 4. Target task and attempt state machines

Task status remains:

```text
pending -> in_progress -> submitted -> verifying -> completed
   │            │              │            │
   └────────────┴──────────────┴────────────┴-> failed | cancelled
```

The v2 attempt lifecycle becomes:

```text
reserved
   │ exact assignment frame claimed + durable checkpoint
   ▼
running ── official turn settles without submit ──> parked
   │                                                │
   │ submit                                         │ explicit resume, same fence
   ▼                                                ▼
submitted -> verifying -> accepted              running
                 │
                 └─ reject/reassign -> stale or rejected
                                      + fresh generation
```

`parked` means only: the exact attempt still owns the task and root, no Team-owned member turn is currently executing it, and continuation requires an explicit durable resume intent. It is not failure, completion, cancellation, retry eligibility or proof that the model was stuck.

Minimum v2 fields:

```ts
type TaskAttemptPhase =
  | 'running' | 'parked' | 'submitted' | 'verifying'
  | 'accepted' | 'rejected' | 'cancelled' | 'stale'

interface ParkedAttemptState {
  parkedAt: number
  parkedReason: 'turn-settled' | 'owner-not-live' | 'migration-unknown'
  lastSessionSeq?: number
  resumeEffectId?: string
}
```

The stored reason is evidence classification, not a policy verdict. A `running` attempt may move to `parked` only when the official Session/status evidence proves that the owning turn settled and the task is still the same `in_progress` revision/attempt. A raced submit/review/reassign wins through CAS.

## 5. Scheduling and continuation protocol

One bounded scheduling pass keeps the existing order—reconcile durable debt, deliver mailbox debt, derive ready tasks, ask a finite scheduler Provider, commit through CAS, perform bounded official effects, then return—with these corrections:

1. `running` with an official live `running` owner is left alone regardless of elapsed time, token count, silence, planning style or file changes.
2. `running` whose exact owning turn settles without submission is CAS-transitioned to `parked`; no retry generation is created and no timer is armed.
3. `parked` is excluded from ordinary ready-task selection. It retains its task ownership, attempt ID, evidence and execution root.
4. `resumeAttempt(teamId, taskId, expectedRevision, attemptId)` is an explicit capability. Captain authorization is required for the first product slice; a later member-self-resume capability requires its own policy decision.
5. Resume commits a durable `resume_requested` effect for the same tuple, then sends one typed, byte-identical wake through official continuable-child/mailbox seams. When the frame is claimed, the pre-model gate atomically changes `parked -> running`, checkpoints the exact Session sequence/effect ID, reads it back, then permits the official model request.
6. A pending resume frame is not resent. A claimed frame settles idempotently. A proven-absent frame may be redelivered once under the same effect ID. Unknown visibility blocks.
7. `reassignTask` is distinct from resume: it fences the old attempt `stale`, creates a fresh generation and transfers ownership under the existing captain-only CAS contract.

```text
agent/status idle
  -> read exact task/attempt/session evidence
  -> CAS running -> parked
  -> publish projection; no self-wake

captain resume
  -> CAS durable resume intent (same attempt)
  -> official wakeup admission
  -> target frame claimed + Session flush
  -> CAS parked -> running + receipt
  -> official Agent Loop continues
```

Normal Team messages cannot impersonate a resume intent. They may be queued or delivered according to mailbox semantics, but task tools continue rejecting work against a `parked` attempt until the exact resume transition succeeds.

## 6. Heartbeat, lease, progress and timeout separation

| Signal | Meaning | Permitted consequence | Forbidden inference |
|---|---|---|---|
| Control tick / LoopX-style heartbeat | Wake control plane to read durable state and decide one bounded pass | quiet skip, one bounded transition/effect, gate notification | model progress, failure or completion |
| Worker liveness heartbeat | A runtime/sidecar renewed lease generation and cursor | renew/revoke execution right; reconcile after expiry | semantic progress or accepted output |
| Acceptance-bearing event | CAS transition, claimed frame, evidence digest, submission or review settlement | update canonical state or acceptance evidence | periodic liveness requirement |
| UI freshness poll | Refresh projection | read-only display update | mutation authority |
| Wait timeout | No relevant change in the wait window | return `changed=false` | fail/retry the task |
| Transport timeout | Caller lacks a result | read back exact effect/receipt; keep `unknown` until proven | blind retry or rollback |
| Task deadline/budget | Explicit task/team contract, possibly absent | hold, notify, cancel or reassign according to declared policy | universal model-thinking limit |
| Disposal timeout | Resource convergence bound | fail loud and preserve cleanup debt | task outcome |

Hard lease TTL exists only when a Provider supplies atomic acquire/renew/revoke/takeover with a monotonic fencing token. Local DSH uses attempt fencing and official live/Session evidence and must not pretend to provide distributed leases. A runtime-side heartbeat may renew a lease while a model call is in flight; a model-authored tool call cannot safely be the sole renewal channel for long reasoning.

## 7. Suspected-loop evidence

A future first version may expose `suspected_loop` as evidence-only projection. It must require completed, observable cycles whose normalized action/failure signatures repeat while all relevant Team revision, task/attempt phase, mailbox cursor, artifact/evidence digest and declared external-wait facts remain unchanged. Any new evidence, changed parameters, authoritative transition or explicit wait resets the suspicion.

`suspected_loop` may notify the captain or user. It cannot interrupt, reassign, consume a retry, create a new attempt or mark failure. Automatic interruption remains limited to deterministic host-attested safety evidence such as the existing unmatched long-running tool call; direct user control remains authoritative.

## 8. Recovery decisions

Recovery is read-back-first and preserves the attempt unless a stronger fence says otherwise:

| Exact observation | Recovery decision |
|---|---|
| Assignment `reserved`, frame claimed | Acknowledge delivery idempotently; do not resend. |
| Assignment `reserved`, frame pending | Wait for an official claim/status edge; do not resend or self-wake. |
| Assignment `reserved`, frame proven absent | Redeliver once under the same attempt/frame identity. |
| `running`, owner officially live/running | Preserve; no elapsed-time action. |
| `running`, exact turn settled, no submit | CAS to `parked`, retain root and ownership. |
| `parked`, no resume intent | Preserve indefinitely or until an explicit deadline/control decision; no retry timer. |
| `parked`, resume frame pending/claimed/absent | Apply the exact message-visibility fold; settle same attempt only after claim/read-back. |
| Owner not live after restart, Session evidence proves settled | `parked(owner-not-live)`; captain chooses resume or reassign. |
| Liveness/Session evidence ambiguous | `parked(migration-unknown)` or explicit recovery debt; fail closed, never mint a generation. |
| Hard distributed lease expired with valid fencing Provider | Revoke old token, reconcile effects, then a policy-authorized fresh attempt may take over. |
| External effect response lost | Query operation receipt/read-back before retry; unknown remains blocking. |

Execution roots remain attempt-owned through `running` and `parked`. They release only after exact accepted/rejected/cancelled/stale terminal read-back and the existing handoff/retention rules. A restart never falls back to an older generation's root.

## 9. Completion and archival

Whole-Team completion remains derived and review-owned. In addition to the blueprint predicate, any `parked` attempt, pending resume intent, suspected unresolved recovery, or unknown lease/effect outcome blocks completion. `idle`, heartbeat expiry, task deadline, model prose and file presence cannot complete a task. Only the configured review/acceptance gate may produce `accepted/completed`.

Archival is a separate captain-authorized action. A captain may cancel or explicitly waive parked work only through a typed transition that identifies the exact task revision and attempt; archival never silently converts parked work into success.

### 9.1 Immutable delivery and integration

Model autonomy does not weaken delivery identity. A member may reason and execute in its own style, but submission freezes a content-addressed candidate bound to task/attempt generation, tree/artifact/evidence digests, source build identity and resolved write policy. Review uses an independent read-only materialization. Accepted roots cannot receive later writes; a stale followup is rejected or starts a new authorized candidate/attempt.

Every artifact family required by acceptance must have an explicit writable namespace before dispatch. The runtime enforces that policy where the execution-root Provider claims isolation; prompt-only compliance is labelled advisory. Required browser/tool/Skill/provider capabilities are host- or target-attested before dependent work. `assignedSkills` is intent, not proof of load.

Accepted dependencies carry source candidate digest, accept revision, selected scopes and target digest. A serial integrator mutates an expected target once and records the result digest or an `outcome-unknown` debt. QA tests that exact result. A temporary consumer root without an integration receipt proves only a development smoke.

### 9.2 Clean failure generations

A failed product, harness or oracle attempt remains failed and immutable. Correction produces a separate candidate, then the same scenario runs in a fresh test-attempt generation or from an authoritative deterministic reset. Evidence, screenshots, data, processes, profiles and ports from the failed generation are preserved or disposed with read-back and cannot be overwritten into a pass. Fixed numeric waits may exist inside a specific test/tool/transport contract; they do not become universal model-progress policy.

## 10. Configuration and migration

The accepted implementation changes the safe default:

```yaml
idleRecoveryPolicy: manual
strandedAfterMs: 0   # deprecated compatibility field; no hidden default retry
```

- New and absent configuration defaults to `manual`; no elapsed-time retry exists.
- A legacy explicit positive `strandedAfterMs` is not silently treated as the new default. During the compatibility window it is accepted only with explicit `idleRecoveryPolicy: legacy-timed-retry`, emits a deprecation warning, remains local-only, and is excluded from release acceptance for the new architecture.
- A configuration that supplies a positive legacy delay without the explicit legacy policy fails closed with an actionable migration message.
- The legacy policy is removed at the v2 cutover after a published compatibility window; it never enters the v2 durable schema.

v1 aggregate migration into the blueprint's v2 authority uses exact evidence:

1. terminal and submitted/verifying attempts retain their exact phases and identities;
2. `running/reserved` remains delivery debt and uses the existing exact visibility fold;
3. `running/delivered` plus a proven live/running owner remains `running`;
4. `running/delivered` plus a proven settled or absent owner becomes `parked` with the corresponding evidence reason;
5. ambiguous runtime/Session evidence becomes `parked(migration-unknown)` or explicit recovery debt and blocks completion;
6. existing stale/retry history is preserved; migration never creates another generation;
7. user-media cutover remains blocked by ADR-0009's pre-plugin retirement fence. This ADR grants no migration authority.

Rollback before cutover uses the unchanged v1 artifact/media. After cutover, rollback is a forward corrective migration; an old binary cannot reopen v2.

## 11. Acceptance and implementation order

No product code may implement this ADR until one unique non-author QA accepts the exact architecture candidate containing this ADR and the amended blueprint. Review must verify:

1. official DSH remains the only Agent Loop;
2. no timer, prompt, token counter, file-diff check or plan counter can interrupt or rotate a healthy attempt;
3. `running -> parked -> running` preserves one attempt/root and is CAS/read-back fenced;
4. resume, reassign, interrupt, deadline and lease-expiry have distinct authority and effects;
5. every pending/claimed/absent/unknown resume and restart branch has one recovery decision;
6. parked/recovery/unknown states block completion;
7. default configuration disables time-driven idle retry and handles explicit legacy config without silent semantic change;
8. tests cover different model styles, long reasoning, long tools, explicit pause/resume, restart, duplicate resume, late old attempt, deadline, transport unknown and unique QA acceptance.
9. candidate/review/dependency/integration receipts bind immutable digests and reject post-accept mutation or expected-target races;
10. task scopes cover all required artifact families, required capabilities are preflighted, and every fault route reruns from a clean generation without old process/port/root leakage.

After architecture acceptance, implementation proceeds as vertical slices:

1. change default/config semantics and add negative tests proving no timer-driven retry;
2. add v2 parked state and exact idle-settlement transition over a fresh isolated Profile;
3. add typed same-attempt resume intent, message visibility fold and UI/RPC projection;
4. add enforced artifact namespaces, capability preflight, immutable candidate/review roots and expected-target integration receipts;
5. add restart/migration reconciliation and root retention tests;
6. run a clean multi-member long task across these test-specific routes: deep-planning model, immediate-action model, long tool call, intentional park/resume, crash while parked, duplicate resume, explicit reassign and review rejection/rework;
7. reset the Profile/state/workspace for every fault route and accept only direct browser/runtime/storage evidence bound to the frozen integrated result.

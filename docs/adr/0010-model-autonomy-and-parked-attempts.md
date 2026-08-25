# ADR-0010: Model autonomy, parked attempts and explicit continuation

- Status: Proposed / unique non-author QA required
- Date: 2026-08-25
- Candidate base: `b87979c9f96c654f95a4fd95f18326cfd23d2d70`
- Amends: `docs/development/2026-08-24-team-runtime-architecture-blueprint-v1.md`
- Supersedes after acceptance: the default time-driven stranded self-heal in `docs/04-core-protocol.md` §8c
- Does not modify: official DSH, its Agent Loop, provider reasoning behavior, or user media

Implementation snapshot (not acceptance): the config-gated A2a online member-self-continuation slice implements `running -> requested -> parked -> admitted -> frame-pending -> dispatch-pending -> dispatch-entered -> settled/running` over official Session, Subagent followup/inbox and Agent Loop seams. Accepted A2a-R1a folds entered cold outcomes, accepted A2a-R1b stages one proof-bound deterministic recovery reservation after exact physical cold repair, and accepted A2a-R1c publishes a distinct typed recovery trigger only when absent, atomically hands off its durable claim and reuses the existing Provider witness and assistant settlement. The R1d candidate makes running exact-member submit and the fence/release phase of captain-only reassign supersede every open initial/continuation/recovery epoch and applied receipt in one Team transaction; interruption follows the committed fence, stale typed frames or stale Agent Loop permits cannot enter Provider, and a retired stale permit cannot poison a later request. This slice does not create or dispatch the successor Attempt. A durably pending unclaimed trigger remains capability-blocked because official DSH exposes no public resume-only operation for its exact MessageId. Explicit cancel, Team-leader/human request principals and unknown-result parity remain absent, so this ADR remains Proposed.

## 1. Outcome and non-goals

The Team control plane governs identity, ownership, permissions, durable intent, evidence, recovery and acceptance. Within the task's declared authority envelope, the member and Team leader autonomously plan, coordinate, checkpoint and continue the work without manager approval. The control plane does not prescribe how an LLM reasons, how many plans it may form, or how soon it must modify a file. Different providers and models may plan deeply, act immediately, revise a plan after new evidence, or spend a whole valid turn on diagnosis.

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
reserved ── official assistant execution evidence ──> running
    │                                                   │
    │ non-repair turn end, no assistant                 │ turn settles without submit
    ▼                                                   ▼
  parked ── explicit typed resume + assistant evidence ─┘

running ── submit ──> submitted ──> verifying ──> accepted
                                       │
                                       └─ reject/reassign fence ──> stale/rejected + task pending[target?]
                                                                          │
                                                                          └─ later scheduler/claim -> fresh generation -> reserved
```

`parked` means only: the exact attempt still owns the task and root, no Team-owned member turn is currently executing it, and continuation requires an explicit durable resume intent. It is not failure, completion, cancellation, retry eligibility or proof that the model was stuck.

Minimum v2 fields:

```ts
type TaskAttemptPhase =
  | 'reserved' | 'running' | 'parked' | 'submitted' | 'verifying'
  | 'accepted' | 'rejected' | 'cancelled' | 'stale'

interface ParkedAttemptState {
  parkedAt: number
  parkedReason: 'turn-settled' | 'owner-not-live' | 'migration-unknown'
  lastSessionSeq?: number
  continuationPolicy: 'team-autonomous' | 'captain' | 'human'
  currentContinuationIntentId?: string
}

type ContinuationIntentPhase =
  | 'requested' | 'admitted' | 'claimed' | 'dispatch-pending' | 'dispatch-entered'
  | 'dispatch-unknown' | 'settled'
  | 'superseded' | 'cancelled'

type ContinuationPrincipal =
  | { kind: 'member'; memberId: string; memberSessionId: string }
  | { kind: 'team-leader'; captainSessionId: string }
  | { kind: 'authenticated-human'; subjectId: string }

interface ContinuationIntent {
  continuationEffectId: string
  taskId: string
  attemptId: string
  expectedTaskRevision: number
  requestedBy: ContinuationPrincipal
  requestedAt: number
  checkpointDigest?: string
  wakeCondition?: string
  resumeEffectId?: string
  currentDispatchId?: string
  phase: ContinuationIntentPhase
}

type ModelDispatchPhase =
  | 'frame-pending' | 'frame-claimed' | 'dispatch-pending'
  | 'dispatch-entered' | 'dispatch-unknown'
  | 'settled' | 'superseded' | 'cancelled'

interface ModelDispatchEpoch {
  dispatchId: string
  kind: 'initial' | 'continuation' | 'recovery'
  ordinal: number
  effectId: string
  recoveryOf?: string
  targetSessionId: string
  turn?: number
  step?: number
  messageSeq?: number
  witnessCapabilityDigest: string
  phase: ModelDispatchPhase
}
```

The stored reason is evidence classification, not a policy verdict. A `running` attempt may move to `parked` only when the official Session/status evidence proves that the owning turn settled and the task is still the same `in_progress` revision/attempt. A raced submit/review/reassign wins through CAS.

`continuationPolicy` grants who may request continuation; it is never itself an intent or wake condition. `team-autonomous` admits the owning `member` or the `team-leader`; `captain` admits only the `team-leader`; `human` admits only an `authenticated-human`. The root Captain is the Team leader's official DSH Session and is not misrepresented as a `TeamMember`. An Attempt has at most one nonterminal `ContinuationIntent`, identified by `teamId + taskId + attemptId + continuationEffectId`. All principals use the same CAS slot. Repeating the same identity is idempotent; a different concurrent identity receives the authoritative existing intent/conflict and cannot enqueue another wake.

No model tool, RPC or public payload accepts `requestedBy`. At request creation, a member principal is derived from the exact live `exec.agent`, roster row and current Attempt owner; a Team-leader principal is derived from the exact live root Agent instance, root registration and `team.captainSessionId`. Human continuation is NOT_CONFIGURED unless the existing host-only `HumanPrincipalVerifier` and an accepted write gateway produce an opaque attestation for the concrete request; Captain prose, a browser field or a copied subject ID cannot mint one. Later admission/restart revalidates the stored member/team-leader principal against the current nonterminal durable roster, captain binding, Attempt owner, policy, revision/generation and intent slot; it does not require that Agent to be currently resident. Human attestation is revalidated by its host verifier when required. Separately, wake admission requires proof that no live/in-flight owner exists. Forged, stale, replayed or old-generation principals fail before mutation.

`ModelDispatchEpoch` is the common dispatch authority for both first assignment and continuation. Initial assignment settlement creates `kind=initial`; a claimed continuation creates `kind=continuation`; a proven-not-entered crash recovery terminalizes the old epoch and creates `kind=recovery` with the next ordinal. The same witness, result fold, unknown rule and bounded receipt ledger apply to every kind. Thus first assignment has no weaker crash semantics than later continuation.

## 5. Scheduling and continuation protocol

One bounded scheduling pass keeps the existing order—reconcile durable debt, deliver mailbox debt, derive ready tasks, ask a finite scheduler Provider, commit through CAS, perform bounded official effects, then return—with these corrections:

1. `running` with an official live `running` owner is left alone regardless of elapsed time, token count, silence, planning style or file changes.
2. `running` whose exact owning turn settles without submission is CAS-transitioned to `parked`; no retry generation is created and no timer is armed.
3. `parked` is excluded from ordinary ready-task selection. It retains its task ownership, attempt ID, evidence and execution root.
4. `resumeAttempt(teamId, taskId, expectedRevision, attemptId)` is an explicit capability. The default `team-autonomous` policy permits the owning member or Team leader to request same-attempt continuation within the already granted task authority. `captain` and `human` are explicit per-task restrictions for sensitive work; they are not global defaults.
5. Before its turn settles, a member may persist a semantic checkpoint and a typed `continue_requested` intent that names the same task/attempt fence, an idempotency key and the next runnable condition. Admission requires the exact current revision/Attempt to be `parked`, the owning turn to be durably settled, and official evidence of no live/in-flight owner. Mere `idle`, elapsed time, policy or an unresolved task is never an intent or admission fact.
6. One v2 Team transaction CASes `requested -> admitted` and persists the `resumeEffectId`/once-only effect intent. The dispatcher then sends one typed, byte-identical wake through official continuable-child/mailbox seams. It never exposes `admitted` without a recoverable effect identity.
7. A pending resume frame is not resent. A claimed frame settles idempotently. A proven-absent frame may be redelivered once under the same effect ID. Unknown visibility blocks.
8. `reassignTask` is distinct from resume and is two-phase: this captain-only transaction fences the old attempt `stale`, returns the task to `pending` and may pin the next eligible member; a later independently admitted scheduler/claim transaction creates and dispatches the fresh generation. The current fresh-v2 R1d slice implements only the first phase, so the task may remain pending.
9. Submission, cancellation, reassignment and any transition that terminalizes or replaces the current Attempt atomically terminalize its nonterminal continuation intent as `superseded` or `cancelled`. The effect dispatcher and target pre-model gate both revalidate the exact current task revision, attempt generation and nonterminal intent before send/claim. A terminal intent is evidence only and can never wake an Attempt.
10. Claiming the wake does not prove model dispatch. The `agent/request` pre-model gate flushes the exact claimed assignment `user/message`, CASes `claimed -> dispatch-pending`, retains the Attempt as `parked`, checkpoints the exact Session turn/message/step identity and then calls `next()`.
11. A global/prepend plugin-owned `llm/stream` dispatch witness consumes a one-shot permit created by the exact official `agent/request` callback. The permit binds `sessionId + turn + step` and the same live `AbortSignal` object; the stream must present that identical signal, resolve the identical live Agent/Session and match the exact Team-owned `dispatch-pending` epoch. An imported `isAgentLoopRequest(options)` WeakSet is not cross-package authority because a normal Profile installation may resolve another peer-package instance; it may only be an additional shared-instance sentinel. After another exact Session flush and before downstream `next()`, the witness consumes the permit, CASes `dispatch-pending -> dispatch-entered`, reads back, then delegates to the official LLM waterfall. This is an admission witness, not proof of a provider result: if the process dies before outcome evidence, recovery changes it to `dispatch-unknown` and uses Provider read-back or an explicit forward decision. The intent settles and the Attempt becomes `running` only after official assistant execution evidence for that exact step. A durable `turn/end` without assistant output settles the wake but leaves the task parked with the exact error/wait evidence.
12. Gate A and real Loader sentinels must prove the witness wraps every configured terminal adapter and short-circuit route for Team-owned requests. A capability digest binds official build, Loader graph and witness registration to each epoch. HMR/graph change revokes admission, drains admitted calls and reruns the sentinels. If assistant output or a non-repair `turn/end` appears without the matching entered receipt, the route becomes `dispatch-unknown` and autonomous recovery is disabled for that Profile. It never infers not-dispatched. If ordering cannot be established, the capability is unavailable rather than weakening the boundary or modifying official DSH.
13. The same witness covers initial, continuation and recovery epochs. A recovery trigger never replays the original assignment: after the new trigger message is claimed and flushed, one CAS settles the old proven-not-entered epoch and binds a new `kind=recovery` ordinal to the new turn/step/message before it may reach `dispatch-pending`. Repeated trigger claims return the existing epoch.

```text
agent/status idle
  -> read exact task/attempt/session evidence
  -> CAS running -> parked
  -> publish projection; no timer or inferred self-wake

durable member continuation intent or Team-authorized resume
  -> CAS durable resume intent (same attempt)
  -> official wakeup admission
  -> target frame claimed + Session flush
  -> CAS intent -> dispatch-pending; Attempt remains parked
  -> llm/stream witness flush + CAS dispatch-entered before downstream next()
  -> official assistant execution evidence (or dispatch-unknown recovery)
  -> CAS Attempt -> running + terminal intent receipt
  -> official Agent Loop continues
```

Normal Team messages cannot impersonate a resume intent. They may be queued or delivered according to mailbox semantics, but task tools continue rejecting work against a `parked` attempt until the exact resume transition succeeds.

Continuation intent recovery is deterministic:

| Exact intent observation | Decision |
|---|---|
| `requested`, exact current `parked` Attempt whose prior turn is settled and owner is not live/in-flight | One v2 Team transaction may CAS it to `admitted` and persist the once-only resume effect identity. |
| `requested`, Attempt still `running` or owner live/in-flight | Preserve the request; do not admit or wake until the exact parked/settled evidence exists. |
| `admitted`, effect/frame proven absent | Publish the exact byte-identical frame once under the persisted `resumeEffectId`; do not create another effect or intent. |
| `admitted`, frame pending | Preserve and wait; do not create or resend another identity. |
| `claimed`, exact current parked Attempt | Flush the exact assignment message, CAS intent to `dispatch-pending`, retain Attempt `parked`, checkpoint Session/turn/step, then allow the official request waterfall to continue. |
| `dispatch-pending`, valid bound witness capability, no assistant output, and either (a) the original Activation/request is exactly quiesced/fenced with no live Agent/Session owner or (b) exclusive cold `load/prepare` read-back appended `turn/end {kind:'interrupted'}` for this epoch's formerly open turn/step | Downstream model dispatch was not admitted. Treat the exact quiescence/cold repair as proven-not-entered, enqueue the v2 ledger's separate once-only recovery trigger and never replay/append the assignment frame again. |
| `dispatch-pending`, original Activation/request remains live/in-flight or quiescence is unknown | Preserve pending; do not admit recovery or another wake. |
| `dispatch-pending`, assistant output, any non-interrupted/non-cold-repair `turn/end`, or witness/repair capability/ordering absent, changed or ambiguous | CAS `dispatch-unknown`, revoke autonomous recovery for the Profile and require read-back/explicit decision. Never infer not-dispatched. |
| `dispatch-entered`, assistant output/turn-end is absent after process death | CAS to `dispatch-unknown`; reconcile by Provider request identity when available, otherwise escalate this true blocker for an explicit forward decision. Never retry blindly. |
| `dispatch-entered`, exact assistant output/execution boundary exists | CAS Attempt to `running`, settle the intent receipt and release the current slot. |
| `dispatch-entered`, exact turn ended without assistant output | Settle the wake receipt, release the slot and keep/return the Attempt `parked` with the classified error/wait evidence. |
| Response/effect visibility unknown | Read back the same intent/effect/frame identity; block only that route until known. |
| Same intent identity repeated | Return the existing result idempotently. |
| Different principal request races with a nonterminal intent | CAS rejects it and returns the current intent; the Team may explicitly supersede only through an authorized state transition. |
| Intent belongs to an accepted, cancelled, stale, replaced or otherwise terminal Attempt | CAS it to `superseded`/`cancelled`, preserve the receipt and prohibit wake delivery. |
| Crash after request but before admission | Reopen `requested`; policy alone creates nothing. Admit only if the exact Attempt is still current, `parked`, settled and has no live/in-flight owner. |

Settling, superseding or cancelling an intent atomically appends its terminal receipt to ADR-0009's bounded v2 effect ledger and clears the current slot. A later request first checks both the slot and retained receipts: an old identity returns its recorded result, while a new identity may occupy an empty slot. Ledger capacity exhaustion fails closed and requires the ledger's declared retention/compaction procedure; it never drops a live idempotency record. This permits multiple sequential continuation rounds on one Attempt without losing dedupe evidence or creating an unbounded second history.

### 5.1 Low-interference supervision boundary

The external manager observes canonical state and intervenes only after a concrete blocking signal. It does not inspect private reasoning or supervise ordinary planning, timing, tool choice or file cadence. Before any interrupt, reassignment, corrective prompt or product-code change, the manager classifies the evidence:

| Classification | Required manager behavior |
|---|---|
| Normal/in-flight Team work | No action. Preserve the member, attempt and execution root. |
| Declared external wait or dependency wait | Wait or notify only; do not treat it as a defect. |
| Product/plugin defect with reproducible evidence | Preserve the failed generation, assign one bounded fix, then rerun from a clean generation. |
| Environment, provider, tool or capability unavailable | Correct or hold only the affected path; do not mutate product code to hide the environment problem. |
| Test harness or oracle defect | Correct and freeze the harness candidate, then rerun the same route cleanly. |
| New authority, permission or human decision required | Ask the smallest exact question and keep unrelated Team work running. |
| External effect outcome unknown | Read back/reconcile the exact operation identity; never retry blindly. |
| Repeated completed observable failures with no new decision-relevant evidence | Project `suspected_loop` and ask the Team leader to diagnose; do not automatically interrupt or mint a generation. |

The Team leader may reprioritize, coordinate, resume, reassign and create a replacement generation inside the pre-authorized Team/task policy without external-manager approval. Escalation is required only when the remedy needs new authority or permissions, changes budget/deadline policy or accepted scope, invokes an unavailable external capability, or must decide an external effect whose outcome remains unknown.

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
| Top-level Attempt `reserved`, assignment delivered, dispatch epoch pending/entered/unknown | Apply the common dispatch fold; pending plus exact cold synthetic `interrupted` repair remains proven-not-entered, entered/ambiguous stays unknown, and only assistant evidence produces `running`. |
| `running`, owner officially live/running | Preserve; no elapsed-time action. |
| `running`, exact turn settled, no submit | CAS to `parked`, retain root and ownership. |
| `parked`, no resume intent | Preserve indefinitely or until a declared dependency, deadline or authorized Team decision supplies a typed intent; no retry timer. |
| `parked`, continuation requested/admitted/claimed/dispatch-pending | Apply the exact intent/effect/Session fold; claim alone never proves model dispatch and `dispatch-unknown` blocks blind retry. |
| Owner not live after restart, Session evidence proves settled | `parked(owner-not-live)`; preserve the same attempt. Apply an exact persisted intent if present; `continuationPolicy` alone never creates one. Reassignment still requires its distinct authority. |
| Liveness/Session evidence ambiguous | `parked(migration-unknown)` or explicit recovery debt; fail closed, never mint a generation. |
| Hard distributed lease expired with valid fencing Provider | Revoke old token, reconcile effects, then a policy-authorized fresh attempt may take over. |
| External effect response lost | Query operation receipt/read-back before retry; unknown remains blocking. |

Execution roots remain attempt-owned through `reserved`, `running` and `parked`. They release only after exact accepted/rejected/cancelled/stale terminal read-back and the existing handoff/retention rules. A restart never falls back to an older generation's root.

## 9. Completion and archival

Whole-Team completion remains derived and review-owned. In addition to the blueprint predicate, any current `reserved` or `parked` Attempt, nonterminal continuation/dispatch intent for the current Attempt, suspected unresolved recovery, or unknown lease/effect outcome blocks completion. A `superseded` or `cancelled` receipt is retained as evidence but does not block completion. `idle`, heartbeat expiry, task deadline, model prose and file presence cannot complete a task. Only the configured review/acceptance gate may produce `accepted/completed`.

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
continuationPolicy: team-autonomous
strandedAfterMs: 0   # deprecated compatibility field; no hidden default retry
```

- New and absent configuration defaults to `manual` idle recovery and `team-autonomous` explicit continuation. `manual` means that idle time cannot fabricate retry authority; it does not require a human to approve ordinary same-attempt continuation.
- A legacy explicit positive `strandedAfterMs` is not silently treated as the new default. During the compatibility window it is accepted only with explicit `idleRecoveryPolicy: legacy-timed-retry`, emits a deprecation warning, remains local-only, and is excluded from release acceptance for the new architecture.
- A configuration that supplies a positive legacy delay without the explicit legacy policy fails closed with an actionable migration message.
- The legacy policy is removed at the v2 cutover after a published compatibility window; it never enters the v2 durable schema.

v1 aggregate migration into the blueprint's v2 authority uses exact evidence:

1. terminal and submitted/verifying attempts retain their exact phases and identities;
2. legacy `running/reserved` maps to v2 top-level `reserved` delivery debt and uses the exact visibility fold;
3. legacy `running/delivered` plus exact assistant execution evidence maps to `running`;
4. legacy `running/delivered` plus a proven settled owner and no ambiguous dispatch maps to `parked` with the corresponding evidence reason;
5. legacy delivered state without exact execution/settlement evidence becomes explicit dispatch/recovery debt and blocks completion;
6. existing stale/retry history is preserved; migration never creates another generation;
7. user-media cutover remains blocked by ADR-0009's pre-plugin retirement fence. This ADR grants no migration authority.

Rollback before cutover uses the unchanged v1 artifact/media. After cutover, rollback is a forward corrective migration; an old binary cannot reopen v2.

## 11. Acceptance and implementation order

No product code may implement this ADR until one unique non-author QA accepts the exact architecture candidate containing this ADR and the amended blueprint. Review must verify:

1. official DSH remains the only Agent Loop;
2. no timer, prompt, token counter, file-diff check or plan counter can interrupt or rotate a healthy attempt;
3. initial `reserved -> running` requires assistant execution evidence, and later `running -> parked -> running` preserves one attempt/root and is CAS/read-back fenced;
4. resume, reassign, interrupt, deadline and lease-expiry have distinct authority and effects;
5. every requested/admitted/claimed/dispatch-pending/dispatch-entered/dispatch-unknown/settled/superseded/cancelled continuation and restart branch has one recovery decision;
6. parked/recovery/unknown states block completion;
7. default configuration disables time-driven idle retry and handles explicit legacy config without silent semantic change;
8. tests cover different model styles, long reasoning, long tools, explicit pause/resume, restart, duplicate resume, late old attempt, deadline, transport unknown and unique QA acceptance.
9. candidate/review/dependency/integration receipts bind immutable digests and reject post-accept mutation or expected-target races;
10. task scopes cover all required artifact families, required capabilities are preflighted, and every fault route reruns from a clean generation without old process/port/root leakage.
11. normal Team work and typed same-attempt continuation require no external-manager approval, while every intervention route first classifies product, environment/capability, harness, authority, external-wait or outcome-unknown evidence.
12. continue-vs-submit/reassign/cancel, concurrent principal requests, multi-round continuation, admission/effect/frame/request/cold-repair kill points and old-intent/new-generation races have one CAS/recovery decision; terminal receipts cannot wake or block completion.

After architecture acceptance, implementation proceeds as vertical slices:

1. change default/config semantics and add negative tests proving no timer-driven retry;
2. add v2 `reserved`/`parked` states, assistant-evidence admission to `running`, and exact idle-settlement transition over a fresh isolated Profile;
3. add typed member/Team same-attempt continuation intent, per-task continuation policy, message visibility fold and UI/RPC projection;
4. add enforced artifact namespaces, capability preflight, immutable candidate/review roots and expected-target integration receipts;
5. add restart/migration reconciliation and root retention tests;
6. run a clean multi-member long task across these test-specific routes: deep-planning model, immediate-action model, long tool call, intentional park/resume, crash while parked, duplicate resume, explicit reassign and review rejection/rework;
7. reset the Profile/state/workspace for every fault route and accept only direct browser/runtime/storage evidence bound to the frozen integrated result.

# ADR-0009: I1b relay-once uses an in-place Team aggregate v2 ledger

- Status: Accepted for the narrow I1b-1A relay-mail vertical
- Date: 2026-08-23
- Scope: one Team-internal member-question relay-mail effect; Host, RPC, UI, Canvas, external providers and distributed ownership are excluded

## Context

SW-I1a persists HumanInteraction requests and receipts in `agent_swarm_human`, but an overlay alone cannot distinguish a Team mutation that committed before its receipt from one that never committed. The Team aggregate already owns roster, task, attempt, mailbox, budget and revision mutations in one record under the `agent_swarm` Storage Domain.

I1b keeps that identity and descriptor version. It explicitly upgrades only a `TeamState` record from schema v1 to v2 under the existing per-Team transaction: add an empty, bounded `interactionEffects` ledger, strictly validate it, durably write it, then read it back before exposing the Team. Unknown or malformed records fail loud. There is no second Storage Domain, dual writer, global migration controller or old-binary cutover claim.

## Decision

### Team v2 is an in-place aggregate format

New Teams are v2. A v1 Team is transformed to the equivalent v2 Team with an empty ledger on that Team's first locked read, list, or transaction; the write is strictly read back before that operation returns it. This is lazy per-Team compatibility, not a global startup migration, cross-process cutover or old-binary fence. The same `agent_swarm` aggregate remains the sole authority. The overlay stays in `agent_swarm_human`; its v2 record may identify an epoch-2 relay candidate, but it is not a second Team authority.

### The first applied effect is member-question relay-mail

`interactionEffects` is permanent and bounded per Team. Its canonical, domain-separated SHA-256 identity covers scope, Team id, request id and step; a separate fixed binding digest covers authoritative sender Session, target Session, body digest and delivery. The receipt stores only those fixed digests/fields, resulting Team message id, frozen resulting Team revision and commit time; it never stores raw message bodies, scope paths, principals, diagnostics, credentials or provider errors.

`queueMessageOnce` performs target validation, mailbox mutation and receipt append in one Team aggregate transaction. An exact replay returns the permanent receipt before current membership, target or quota admission; it remains safe after normal terminal-mail retention prunes the old mailbox row. A reused request/step with a different binding fails loud. Full ledger capacity fails before mutation and is never silently pruned. This proves once-only Team mutation for this aggregate boundary; it does not claim cross-process exactly-once.

### Reload recovery classifies; it never replays

After a crash between the Team commit and overlay acknowledgement, a fresh Context reads the exact v2 ledger entry and projects the acknowledgement only. It does not send another mail. An epoch-2 relay with verified absence can settle as not-applied; a v1 or non-epoch-2 overlay record has no ledger-proof contract and remains `TEAM_INTERACTION_OUTCOME_UNKNOWN`. Mismatched evidence fails loud. Question presentation, interrupt, review-provider execution and other external seams remain outcome-unknown until their official owner exposes durable operation identity and read-back.

## Non-goals

- No `agent_swarm_v2` or `agent_swarm_human_v2` domain.
- No global migration, old-artifact exclusion, cross-process lease, dual write, or automatic intent retry.
- No effect families beyond member-question relay-mail.
- No Host, RPC, UI, Canvas, provider, preset, Skill or memory feature.

## Verification contract

I1b-1A requires real Storage Domain persistence, clean Context disposal and reopen. The focused suite proves per-Team v1-to-v2 strict read-back, exact replay after terminal-mail retention, binding conflict, bounded capacity, scope/Team isolation, no duplicate mail, redacted digest evidence, both a persisted-then-throw and absent Team-write crash window, fresh-context classification/projection, and legacy outcome-unknown preservation. It must not represent an external effect as applied merely because an adapter was invoked.

## Consequences

The narrow relay has durable same-aggregate deduplication evidence and a recoverable overlay projection. Every later effect must add its own canonical binding, aggregate mutation and focused fault/reopen tests. It may not reuse this ledger as proof for an external provider operation or introduce another Team state machine.

# ADR-0007: M1 moves Team authority out of the shared workspace

- Status: Accepted — implemented in M1A (2026-08-20)
- Date: 2026-08-20
- Evidence: official DSH `141eb6fef83422698aef7a981029e843e8161534`; GLM-5.3 findings F1–F10; JiuwenSwarm `152583aa305836e87481e6de8a5f34e8c7d0928b`

## Context

The 0.1 runtime stores the authoritative Team aggregate below the shared coding workspace. A teammate that can edit that workspace can replace structurally valid JSON and bypass captain authority, task review, budgets and mailbox state. The official `ctx.storageDomain` service is already public in rc.8 and owns schema-validated non-Session application storage with durability-before-publication and lifecycle-managed domain handles. Leaving its integration until M3 would preserve the highest-impact security defect throughout M1.

The official experimental Agent Team package remains private and stores its durable roster, task and mailbox events in the Lead Session. It is a semantic target, not a production dependency. The current Storage Domain is single-process and does not provide distributed CAS, leases or cross-table transactions.

## Decision

1. M1 requires `sessionPersistence` and `storageDomain`; durable Team mode has no workspace-JSON or non-durable fallback.
2. Tools and orchestration consume one `TeamDomainPort`. Exactly one selected Provider owns roster, task board and mailbox state.
3. The first production Provider opens one namespaced Storage Domain and stores each Team as one versioned aggregate record. Keeping one Team in one record preserves the existing revision transaction boundary while the Provider remains explicitly single-process.
4. `FileTeamStore` leaves the default runtime. It may remain only as an offline migration reader and test fixture.
5. Migration is explicit and one-way per Team: validate the old aggregate, require an empty destination, write and verify the new record, record a migration receipt, and leave the source read-only for rollback evidence. Runtime dual-write and automatic silent fallback are forbidden.
6. Target-Session mailbox identity and receipt de-duplication remain a Session/inbox responsibility coordinated through the selected Team Provider; a Store acknowledgement alone is not proof of target receipt.
7. A future published official `ctx.agentTeams` adapter replaces the local Provider behind the same port after an explicit one-authority migration. It never runs as a second writer.
8. Distributed claims, leases and fencing still require a later atomic Store Provider. M1 must not describe Storage Domain's process-local write serialization as cross-process safety.

Moving state outside the shared checkout reduces the ordinary coding-member threat surface; it is not a cryptographic defense against a process with unrestricted host access. The sandbox, filesystem and credential capabilities remain the host security boundary.

## Remediation order

M1 is implemented in dependency order:

1. M1A — repository/evidence baseline, `TeamDomainPort`, required injections, Storage Domain Provider and migration;
2. M1B — target-side mailbox de-duplication, persisted-child recovery and mailbox retention semantics;
3. M1C — bounded disposal, attempt/history limits, live-status scheduling, prompt-data delimiting and small compatibility hardening;
4. M1D — real rc.8 Profile reload/fault tests and independent GLM-5.3 regression/security review.

Workflow/Jobs integration remains M2 so deterministic orchestration does not change while the canonical Team authority and crash semantics are being repaired. Storage Domain remains in M1. ADR-0008 subsequently inserted the self-hosting safety vertical at M3, so Token Meter/accounting moved to M4 without changing this ADR's authority decision.

## Consequences

M1 becomes larger but closes the authority flaw before adding more Consumers. Deployments must compose official storage, a KV-capable backend and Session persistence. Existing workspace state requires an explicit migration. The local Provider remains process-local, but its limitations are accurate and its state is no longer an ordinary project file available to coding members.

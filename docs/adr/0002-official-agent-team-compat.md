# ADR-0002: Align with official experimental `ctx.agentTeams` without hard-depending on it

- Status: Accepted
- Date: 2026-08-20

## Context

Official DSH source now includes an experimental Agent Team service with durable roster, mailbox and task DAG. It is under `packages/experimental`, which is excluded from official releases. The community plugin has different state and tool contracts.

## Decision

- Treat official Team semantics as the future compatibility target.
- Do not publish an external service named `ctx.agentTeams` that could collide.
- Keep the compatibility Team domain implementation private, and expose current Consumers through the non-conflicting `ctx.agentSwarm` host façade.
- Supply characterized adapters for supported backends.
- When the official package becomes public, make it the preferred Provider and retire duplicated protocol state.

Current implementation note (2026-08-20): this is an accepted target decision, not completed implementation. The 0.1 runtime constructs `TeamDomain(FileTeamStore)` directly and has no selectable official/community adapter. ADR-0007 fixes the M1 sequence: introduce `TeamDomainPort`, move the local Provider to official Storage Domain with one-way migration, then add conformance and crash-safety work before any future official backend replacement.

## Consequences

- The project can start before the official seam stabilizes.
- Protocol decisions must stay conservative.
- Adapter tests become mandatory once the first adapter is introduced; none currently exist.
- Some community-plugin features such as `attemptId` live in the orchestrator TaskRun overlay instead of changing the official task record.

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

Current implementation note (updated 2026-08-20, M1A): tools and orchestration now consume one `TeamDomainPort`; the production Provider persists the Team aggregate through the official Storage Domain (`StorageDomainTeamStore` over the `agent_swarm` domain), and the legacy workspace `FileTeamStore` is a read-only migration reader. The official `ctx.agentTeams` package remains private/unpublished, so the official backend adapter is still a future replacement behind the same port after an explicit one-authority migration; conformance suites for the port already exist (13 tests over the real official stack).

## Consequences

- The project can start before the official seam stabilizes.
- Protocol decisions must stay conservative.
- Adapter tests become mandatory once the first adapter is introduced; none currently exist.
- Some community-plugin features such as `attemptId` live in the orchestrator TaskRun overlay instead of changing the official task record.

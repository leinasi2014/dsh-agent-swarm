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

## Appendix: 2026-08-20 issue #19 compatibility-promise decisions

The M1C official-compat group (issue #19) fixed four semantic contracts against the pinned official experimental sources. These rows are compatibility promises the future adapter must keep or consciously renegotiate (full rationale in `docs/04` §8b):

| Contract | Promise |
|---|---|
| Wait window | Aligned to the official integer window 10000..3600000 ms with `TEAM_INVALID_TIMEOUT`; callers must not rely on any pre-#19 private range. |
| Wait result | **Diverged (kept)**: cursor-based `{snapshot, changed}` return instead of the official `{timedOut}` single value. The adapter maps `changed` to `timedOut`; the surplus snapshot fields are this plugin's superset contract (same family as the revision CAS). |
| Wait wake semantics | **Diverged (kept)**: level-triggered on the caller's revision cursor, not edge-triggered on waiter registration. Not a replay from the caller's perspective; revisit only if the official edge contract becomes load-bearing for an official consumer. |
| Wait cancellation | Aligned: structured `TEAM_WAIT_ABORTED` on caller abort, `throwIfAborted` before registration. |
| Quiet delivery (F13) | Aligned: quiet-to-member delivers only to live targets via `Agent.inject`; inactive targets keep quiet mail queued forever and every recovery path skips it; only wakeup cold-resumes. |
| Quiet ordered bypass | **Diverged (kept)**: no per-target durable-order dispatch serialization (`messagePrecedes`/`dispatchTails`); the inject path achieves the bypass effect structurally. Revisit with the cross-process store Provider (M7). |
| Member interrupt | Aligned: captain-only keepInbox interrupt (`ctx.subagents.interrupt` ancestor authority) that cancels the current turn only — ownership, roster, mail and Activation survive. |
| Member names | Project overlay (reference pattern), not an official seam: NFC + `\p{L}\p{N}` fold with dash separators, 64-codepoint cap enforced by rejection (no digest suffix), `captain` reserved. The adapter maps names onto the official ASCII roster at migration time if it keeps the official rule. |

# ADR-0003: Use both task revision and execution attempt fencing

- Status: Accepted
- Date: 2026-08-20

## Context

Official experimental Team tasks use revision compare-and-set. The community plugin uses `attemptId` to reject a worker after reassignment. Either mechanism alone leaves a race class uncovered.

## Decision

- Canonical task mutations use `expectedRevision`.
- Every execution run has a random branded `attemptId` and monotonic attempt number.
- Reassignment invalidates the current attempt before dispatching another worker.
- Worker updates require both current task/run identity and attempt token.

## Consequences

Control-plane conflicts and late data-plane writes are independently rejected. More records and tests are required, but ownership failure semantics become explicit.

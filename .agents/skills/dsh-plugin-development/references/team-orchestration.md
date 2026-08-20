# Team orchestration design reference

## Canonical Team domain

Align with official Agent Team semantics now, while keeping the private package out of production dependencies until promoted:

- root Session is Lead identity;
- teammate Session ids are durable authority identities;
- durable roster/mailbox/task DAG;
- task revision compare-and-set;
- queued-before-delivered mailbox;
- bounded wait/change observation.

Before every Team change, re-check the official experimental package and its implemented Agent Notes for contract or promotion movement. Use a single `TeamDomainPort` and exactly one selected canonical backend; never write both private and official Team state.

## Orchestrator overlay

Keep policy outside canonical task:

- TaskRun and `attemptId`;
- Scheduler decision;
- Workspace lease;
- Budget reservation;
- Review status;
- workflow linkage;
- memory checkpoint.

## Safe reassignment

1. CAS task/run state;
2. invalidate old attempt;
3. mark handoff/quiescing;
4. interrupt old member;
5. await or time-bound quiescence;
6. create fresh attempt/workspace/budget reservation;
7. dispatch new work;
8. reject every late old update.

## Completion

Worker submission is evidence, not final completion. Verification Gate accepts or rejects. Only accepted output commits the canonical task completion.

## Distributed

Provider contract must include reservation generation, bootstrap ACK, lease renewal, interrupt, artifact transfer and teardown. Store contract must provide atomic claims and fencing. Generic KV alone is insufficient.

# DBG-023 — Newly added lazy member rejects immediate message delivery

Status: `FIXED_CANDIDATE / CLEAN_PROFILE_RETEST_PENDING`

Observed: 2026-08-25 in clean R4 official DSH `web` Profile acceptance.

Scope: `dsh-agent-swarm`; official DSH source remained unchanged.

## Representative failure

The Captain added three lazy members, created the six-task DAG, and immediately called `agent_swarm_send_message` for `backend-dev`. The member was still `provisioning`, so the outer Code program failed with:

`target "backend-dev" is not active`

Earlier mutations had committed. The Captain correctly queried Team status and task authority before retrying, did not recreate the Team or tasks, then observed that `backend-dev` had become active and claimed `task-1`.

## Required behavior

Member creation, task assignment, and first delivery need one unambiguous contract. Prefer one of these bounded outcomes:

- queue the message/task while the member is `provisioning` and activate it exactly once; or
- return a typed readiness result with an authoritative revision that the caller can wait on before delivery.

A normal lazy-start transition must not surface as an ambiguous failed program after prior mutations committed. The fix requires focused lifecycle tests and a new clean full-path attempt; R4 remains valid evidence for DBG-022 but cannot close DBG-023.

## Cause and correction

The canonical mailbox resolver accepted only `active` roster rows even though lazy members already have durable names and Session identities while `provisioning`. The scheduler and delivery layers already preserve queued mail for such a member until its authoritative first assignment activates it; admission contradicted that existing contract.

Mailbox admission now resolves both `provisioning` and `active` members. Sending to a declared lazy member commits a queued frame without creating an unassigned model turn. The first assignment remains its first user frame, and normal scheduling delivers the retained mail only after activation. If provisioning instead settles or recovers as failed, the same aggregate transaction cancels every queued message to or from that terminal member and removes it from the pending projection.

## Candidate evidence

- `tests/lazy-member-start.spec.ts` now sends real `agent_swarm_send_message` mail before the first task, proves the frame is queued without starting a model turn, proves the assignment is still the first user message, and observes the retained frame reaching `delivered` afterward;
- the same suite covers both explicit provisioning failure and reload-style recovery retirement, proving queued mail becomes `cancelled` and leaves `pendingMessageIds`;
- focused mailbox, Team domain, lazy lifecycle and provisioning recovery suites: 4 files / 33 tests pass.

Acceptance remains open until the frozen candidate passes the full project gate, one non-author review, and a new clean Profile repeats add-member → immediate send → first assignment → delivery without an outer Code failure.

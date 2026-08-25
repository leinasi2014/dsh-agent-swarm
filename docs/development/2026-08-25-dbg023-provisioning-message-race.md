# DBG-023 — Newly added lazy member rejects immediate message delivery

Status: `OBSERVED / RECOVERED / FIX_PENDING`  
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

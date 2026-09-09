# Team orchestration design reference

## Canonical Team domain

Use the selected product's identity contract and official Session authority while keeping private experimental packages out of production dependencies:

- this plugin keeps the Main Brain outside the Team and provisions a distinct Captain Session; a reference's root-as-Lead topology does not override that contract;
- teammate Session ids are durable authority identities;
- durable roster/mailbox/task DAG;
- task revision compare-and-set;
- queued-before-delivered mailbox;
- bounded wait/change observation.

Recheck official/reference evidence when a changed API, package cohort, pin or contradictory real result makes compatibility decision-bearing; otherwise reuse the matching accepted evidence. Use a single `TeamDomainPort` and exactly one selected canonical backend; never write both private and official Team state.

## Orchestrator overlay

Keep execution policy out of tools and UI, while retaining each fact in its existing authoritative domain:

- Team owns its tasks, `attemptId`, reservations and review outcome;
- the Scheduler selects work through the Team mutation boundary;
- execution-root Providers own physical leases and release handles;
- Workflow owns run state and links to Team tasks without copying their transitions;
- private memory and interaction overlays own only their separate correlated records.

## Safe reassignment

Reassignment must invalidate the old attempt through CAS before a new generation can commit work. Interrupt and resource settlement use the selected Provider's real lifecycle guarantees; do not invent a generic quiescence API or a second handoff state machine. Current code settles the Team transition, interrupts the old member and sweeps/schedules through the same runtime owner. Late old submissions remain fenced, and a released execution root must reject further tool use. Verify the exact implementation and failure windows in the core protocol and focused tests.

## Completion

Worker submission is evidence, not final completion. Verification Gate accepts or rejects. Only accepted output commits the canonical task completion.

## Distributed

Provider contract must include reservation generation, bootstrap ACK, lease renewal, interrupt, artifact transfer and teardown. Store contract must provide atomic claims and fencing. Generic KV alone is insufficient.

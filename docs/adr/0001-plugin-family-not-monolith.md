# ADR-0001: Build a capability family, not a monolithic Team plugin

- Status: Accepted
- Date: 2026-08-20

## Context

The community `dsh-agent-teams` proves that durable members, DAG tasks, mailbox and automatic scheduling work inside DSH. JiuwenSwarm demonstrates additional product features. Putting all of them into one package would couple protocol, Providers, policy, UI and storage and would contradict DSH’s replaceable plugin composition.

## Decision

`dsh-agent-swarm` is a Bundle/project name. Independently evolving Service Definitions, Providers and Consumers will be separate packages. Team protocol remains minimal; workflow, workspace, budget, review, memory, distributed transport and UI are optional plugins.

## Consequences

Positive:

- Profile patches can replace Providers.
- Host-only deployments avoid client dependencies.
- Local and distributed implementations share contracts.
- Features can be tested and released independently.

Costs:

- more package/contract design;
- explicit lifecycle and compatibility work;
- Bundle composition and documentation become first-class deliverables.

## Rejected alternatives

- Embed JiuwenSwarm Runtime: duplicates DSH capabilities and creates two lifecycles.
- Fork `dsh-agent-teams` and add features in-place indefinitely: fast initially, but preserves hard storage/UI/policy coupling.

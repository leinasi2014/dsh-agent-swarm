# ADR-0005: Official-first, pure-plugin integration is mandatory

- Status: Accepted
- Date: 2026-08-20

## Context

DSH is an everything-is-a-plugin system whose official stable capabilities already include Workflow, Jobs, Token Meter, Storage Domain, Workspace, interaction and Subagent seams. Agent Team is incubating as a private experimental domain/tool split. This project also uses two references whose runtime architectures overlap several official domains. Without a mandatory compatibility gate, the project can create duplicate services, state machines and accounting paths or document an official capability as absent when it exists.

## Decision

- Every change first passes the evidence gate in `docs/11-official-first-development.md`.
- Official stable Service Definitions are canonical. The project integrates only as Provider, Consumer, policy overlay or Bundle composition.
- Official experimental/private capabilities define compatibility semantics but are not production dependencies until promoted.
- An absent capability may receive a generic plugin seam only after recorded source evidence and an ownership/conflict review.
- Agent Loop remains unchanged for Team-specific behavior.
- Each durable domain and transition has exactly one authoritative owner.
- Both reference repositories contribute characterized behaviors and failure cases, not a second runtime.
- Official fact changes require synchronized updates to source records, architecture, audit, roadmap, ADRs, README and Skill.

## Consequences

Feature work has a deliberate evidence cost before coding, but upgrades become deletion/adaptation instead of collision repair. Some reference features will remain unimplemented until a safe official mapping exists. Milestone completion is based on assembled runtime evidence and conflict-free ownership, not feature-count claims.

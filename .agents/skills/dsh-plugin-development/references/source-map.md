# Source map

## Official DSH

Read in order:

1. `AGENTS.md`
2. `docs/architecture.md`
3. `packages/AGENTS.md`
4. `packages/README.md`
5. target group/package README
6. generated subsystem docs and exported types
7. tests and Agent Notes

Read the exact release anchor and package cohort from [OFFICIAL_BASELINE.json](../../../../docs/OFFICIAL_BASELINE.json), and publication/adoption boundaries from [the source register](../../../../docs/09-sources.md). Do not keep a second SHA or dated remote-HEAD claim in this guide. Inspect the affected public packages, installed exports and tests before inventing a seam; a private experimental package is not a production dependency.

## Community learning docs

- quickstart
- plugin user guide
- plugin anatomy
- first plugin
- write tool/service/event
- config and publish

Use for explanation; verify against official source/installed package.

## Direct plugin reference

`ref/dsh-agent-teams/source/` is pinned by [SOURCE_POINTER.json](../../../../ref/dsh-agent-teams/SOURCE_POINTER.json). The separate `source-snapshot/` is a labelled historical reading aid, not that current checkout.

Use this checkout for DSH packaging, lifecycle, scheduler, mailbox, persistence,
Host/Client and composition-test implementation examples. It is prior art, not
the framework contract.

## Jiuwen prior art

`ref/jiuwenswarm/source/` is pinned by [SOURCE_POINTER.json](../../../../ref/jiuwenswarm/SOURCE_POINTER.json).

Use this checkout for SwarmFlow, Worktree, budgets, Team memory, Skill
Evolution, tool-permission and distributed-Team concepts. Extract requirements
and failure cases; do not copy its Python Runtime, transport choices or types
into DSH contracts.

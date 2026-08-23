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

Recorded baseline: `deepseek-ai/deepseek-harness@b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`.

On 2026-08-20, remote `HEAD` and `refs/heads/master` were verified at this same commit. At this baseline, inspect the public `workflow`, `jobs`, `token-meter`, `storage-domain`, `workspace`, interaction, skill, compaction and spill packages before inventing a seam. The experimental Agent Team package is private/unpublished.

## Community learning docs

- quickstart
- plugin user guide
- plugin anatomy
- first plugin
- write tool/service/event
- config and publish

Use for explanation; verify against official source/installed package.

## Direct plugin reference

`ref/dsh-agent-teams/source/` pinned to `912aae5225d3d85fa841a1b0c8a5c77021876c25`.

Use this checkout for DSH packaging, lifecycle, scheduler, mailbox, persistence,
Host/Client and composition-test implementation examples. It is prior art, not
the framework contract.

## Jiuwen prior art

`ref/jiuwenswarm/source/` pinned to
`openJiuwen-ai/jiuwenswarm@e90d9ea80cdeccb84a1f92f296a85aa23e84133d`.

Use this checkout for SwarmFlow, Worktree, budgets, Team memory, Skill
Evolution, tool-permission and distributed-Team concepts. Extract requirements
and failure cases; do not copy its Python Runtime, transport choices or types
into DSH contracts.

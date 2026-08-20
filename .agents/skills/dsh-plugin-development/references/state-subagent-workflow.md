# State, Subagent and Workflow

## State choice

- Session event: durable session fact/model history/replay.
- Storage domain: non-session application state.
- Controller: one in-flight asynchronous operation.
- Distributed store: atomic domain claim/lease/fencing.

Do not duplicate the same canonical state in Session and database without a clearly owned projection/reconciliation protocol.

## Subagent

DSH supports multiple named Providers. One-shot child returns a disposable run/result. Continuable child is a durable Session with transient Activation; followups enter its normal inbox. Parent authority and child Session lineage are security data.

A continuable Provider’s current creation spec may only contribute history seed. Do not assume it can override cwd/workspace unless target types prove it.

## Workflow

Use DSH workflow engine for model-authored/deterministic orchestration. Worker-thread execution is event-loop isolation, not a security boundary. Long workflows integrate with jobs/observability. Workflow state and Team task state remain separate authoritative domains joined by stable ids.

Verified rc.8 services are `ctx.workflowEngine` and `ctx.jobs`. A Team bridge must select one orchestration owner per run so adaptive scheduling and deterministic workflow cannot both assign, retry or settle the same attempt.

## Human collaboration

Use question/approval seams. A human answer entering model context follows normal durable message behavior. Do not create a private browser-only human queue.

## Compaction and token pressure

Use token meter/compaction/spill seams. A Team plugin may set policy or scope but should not duplicate model history compression.

Verified rc.8 `ctx.tokenMeter` is replay-aware and exposes Session projections for current usage/context pressure. Do not assume it is a cumulative Team budget ledger; define the accounting boundary and prevent double counting before replacing direct Session-event folding.

## Workspace

Verified rc.8 `ctx.workspaceRegistry` owns Workspace identity, canonical directories and Session membership. It is not a per-attempt Worktree allocator and does not override continuable-child cwd. Real isolation needs a Session/tool execution capability rooted at the leased directory or a generic upstream child-workspace seam.

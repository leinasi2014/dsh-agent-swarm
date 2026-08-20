# ADR-0004: Ship a process-local 0.1 core with replaceable policy Providers

- Status: Accepted
- Date: 2026-08-20

## Context

The target DSH rc.8 publishes Cordis services for Agent, Session, tools and continuable subagents. It also publishes generic workflow (`ctx.workflowEngine`), jobs (`ctx.jobs`), token-meter (`ctx.tokenMeter`), storage-domain and workspace-registry services. The experimental Agent Team package remains private/unpublished. The 0.1 plugin was intentionally scoped to one useful, testable process-local release and does not yet integrate those published generic services.

## Decision

- Publish `ctx.agentSwarm` as the host façade; model tools are one Consumer.
- Keep the JSON Team store process-local and fail visibly on corrupt state; do not claim distributed atomicity.
- Provide registries for Scheduler and Review policy. Bundle `priority-ready` and `manual`, while command checks, Reviewer Agents and cost policies remain external Providers.
- Measure complete billed rc.8 token usage from committed `assistant/message.usage` events (`inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`) and persist a per-session event-seq cursor.
- Do not implement a private workflow runner or fake Worktree isolation. Workflow integration must consume the published host service; Worktree integration waits for a remote/out-of-process composition or a verified generic child-workspace/cwd seam.

## Consequences

The 0.1 core delivers real process-local team coordination, checkpoint recovery, review and budget behavior on current DSH. Scheduler/Review are currently replaceable registries; Store, workflow and token measurement are not yet deploy-time replaceable. Cross-process ownership, enforced isolated workspaces, workflow bridging and UI require later packages and separate failure-injection suites.

# FP-JOBS-OWNER-01 — scoped Team job read projection

Status: implementation design. Immutable base: `fe5488eb1077ab084f7a4616f561b9774fffea05`.

## Outcome and boundary

With `jobsBridge: true`, a model or Host reader can observe only the durable
Team aggregate for its current live Agent's authorized Team in its own workspace
scope. A missing, stale, or unauthorized caller fails loudly. Workspace A can
never learn workspace B's task label, attempt diagnostic, or task existence
through the jobs read surface.

The official `@deepseek-ai/dsh-jobs@0.1.1-rc.2` `JobRegistry` is a stable
Service Definition, but its contract owns producer admission, owner-relative
controller coverage, cancellation, teardown settlement, and session-scoped
access. A derived Team task view owns none of those resources: TeamDomainPort
remains the sole writer and captain cancellation is a CAS-fenced Team action.
It must therefore not masquerade as a complete `JobRegistry` Provider.

## Shape and authority

`TeamJobProjection` becomes a private, read-only projection object rather than
an extension of `JobRegistry`; `jobsBridge` no longer calls `ctx.isolate('jobs')`
or provides `ctx.jobs`. The default official jobs registry is neither replaced
nor shadowed. The retained public runtime field is a deliberately narrowed
projection API:

```text
list(caller: live Agent) -> fresh JobSnapshot[] for exactly one authorized Team
```

`domain/changed` remains the only live update input and `watchScope()` remains
the crash-reseed path. The in-memory view indexes every observed aggregate by
`scope + teamId`, including Teams without an attempted task, so authorization
does not infer access from a visible job. Records also retain their scope. The
view admits only an exact live `ctx.agents.get(caller.id) === caller` identity,
then mirrors `requireReadMembership` semantics from the latest durable
aggregate: one active Team as captain or active member; otherwise exactly one
archived Team captained by that session. No match and ambiguity fail loudly.

The tool passes `exec.agent` directly to this API. It never falls back to a
domain scan or treats a missing caller as an unowned observer. The compact
result omits the Team id because the caller has already resolved it; that is no
longer a secrecy assumption.

## Lifecycle and failure semantics

The projection owns one `domain/changed` listener and drops its view on dispose;
it never settles, cancels, starts, or reports Team work. `jobsBridge` remains
default-off, has no storage domain, and its disabled tool error remains
`TEAM_JOBS_BRIDGE_DISABLED`. Read authorization failures use existing
`TEAM_NOT_JOINED` / `TEAM_MEMBERSHIP_AMBIGUOUS` semantics, while absent or stale
Agent identity fails `TEAM_JOBS_CALLER_REQUIRED` before any snapshot is exposed.

## Verification

Focused composition tests create active Teams in two different workspace roots
in one process, claim work in each, and prove A's caller and model tool only
see A. They also prove missing/stale callers fail and a single Team's existing
read behaviour still returns its task job. Typecheck and the focused jobs
reader/bridge tests provide author evidence. The former official jobs invariant
composition is intentionally removed: it verifies a Provider contract this
narrowed view no longer claims.

Known limit: this is not an official `ctx.jobs` UI/tool integration. A future
official consumer integration needs an owner-capable producer or an upstream
read-only scoped registry seam; it cannot reuse this view as a hidden provider.

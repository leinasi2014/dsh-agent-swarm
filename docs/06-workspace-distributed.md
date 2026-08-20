# 06. Workspace isolation and distributed execution

## 1. Shared checkout modes

| Mode | Safety | Use |
|---|---|---|
| shared-readonly | high | research/review; no writes |
| shared-advisory | low | single writer or strictly partitioned files |
| worktree | high | parallel coding and independent commits |
| temporary copy | medium | generated artifacts; merge via export |
| remote | depends on provider | another machine/container/process |

`writeScopes` are useful warnings but are not locks. Real enforcement belongs to filesystem/sandbox/workspace Providers.

Target rc.8 `ctx.workspaceRegistry` registers persistent Workspace entities, canonical directories and Session membership. It is useful for identity and lookup, but it does not allocate a per-attempt Worktree or override the immutable cwd of an in-process continuable child. The current `ContinuableCreateSpec` only contributes history seed. A real Worktree member therefore needs an out-of-process/remote Session created with that cwd, or a generic upstream child-workspace creation seam; changing only prompts or task metadata is not isolation.

## 2. Workspace lease

A lease should record:

```ts
interface WorkspaceLease {
  id: WorkspaceLeaseId
  teamId: TeamId
  taskId: TeamTaskId
  runId: TaskRunId
  mode: 'shared-readonly' | 'shared-advisory' | 'worktree' | 'temporary' | 'remote'
  cwd: string
  baseRevision?: string
  branch?: string
  ownerId: SessionId
  phase: 'allocating' | 'active' | 'frozen' | 'merged' | 'released' | 'failed'
}
```

The Provider owns allocation, cleanup and merge metadata. The Team service only stores the lease identity on the run.

## 3. Git Worktree flow

```text
validate clean/base repository
  → choose immutable base revision
  → create unique branch/worktree
  → start member Session with exact cwd
  → worker commits or exports a diff
  → freeze after submission
  → verification runs in frozen snapshot
  → merge/rebase/cherry-pick through a dedicated gate
  → cleanup only after durable result
```

Never let two attempts reuse the same branch/worktree. A rejected run may start a fresh attempt from the prior submitted commit if policy explicitly allows it.

## 4. Self-hosting repository and Profile flow

Self-hosting adds two boundaries around the Worktree flow:

```text
stable control Profile + last-known-good artifact
  → immutable base commit
  → per-attempt branch/Worktree and out-of-process Session
  → submitted commit
  → freeze commit and package artifact digest
  → independent verification in frozen snapshot
  → isolated acceptance Profile/port/state root
  → external promote or reject/rollback
```

The control checkout, stable artifact, control storage, credentials, official DSH checkout and both `ref` checkouts are outside every coding lease. The acceptance Profile receives only frozen candidate inputs and dedicated temporary state. It may report health but cannot switch the stable artifact. D1 permits a single writer with manual promotion after M1D; parallel writers require the M3 exit evidence in ADR-0008.

## 5. Remote member provider

A remote Provider needs:

- discovery identity and capabilities;
- reservation lease and expiry;
- authenticated bootstrap request;
- readiness acknowledgement;
- message/turn delivery;
- interrupt and shutdown;
- final report/artifact transfer;
- owner fencing so one Worker cannot serve two Teams simultaneously;
- cold recovery semantics.

DSH already offers subagent backends such as ACP and DSH SDK. Prefer adapting those over inventing a parallel Agent wire protocol.

## 6. Distributed atomic state

Current local JSON/process-lock patterns do not coordinate multiple DSH processes. A distributed store must offer domain operations, not just generic key-value access:

- atomic task claim with expected revision;
- attempt creation/invalidation;
- lease acquire/renew/release;
- ordered durable message enqueue/ack;
- idempotency keys;
- monotonic event cursor;
- watch/change feed or bounded wait;
- transaction timeout and fencing token.

A Redis Provider could use Lua/MULTI/Streams. A PostgreSQL Provider could use transactions and row locks. The Team Scheduler depends on the service contract, never on Redis commands.

## 7. Control-plane states

Suggested remote member phases:

```text
idle
  → reserved
  → bootstrapping
  → ready
  → running
  → draining
  → idle
```

Every transition uses a reservation generation/fencing token. A late bootstrap ACK from an expired reservation must not mark the new reservation ready.

## 8. Failure policy

- Discovery unavailable: fail or remain local only if configured; no silent fallback.
- Bootstrap delivery failure: release exact reservation.
- ACK timeout: invalidate generation and clean remote partial runtime.
- Worker disconnect during run: invalidate attempt, retain workspace/artifacts, reschedule according to policy.
- Store partition: do not execute work whose ownership cannot be renewed/proven.
- Merge conflict: task remains submitted/rejected; never mark completed.
- Candidate boot/reload/health failure: reject the frozen candidate, preserve the last-known-good control Profile and create a fresh repair attempt.
- Promotion controller unavailable: retain the accepted candidate as evidence but do not infer promotion from candidate/Agent output.

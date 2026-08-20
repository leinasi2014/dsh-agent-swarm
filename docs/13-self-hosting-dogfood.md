# 13. DSH RPC self-hosting and dogfood design

Status: accepted target design; no readiness level is implemented merely because this document exists. ADR-0008 is authoritative.

## 1. Objective

Use an isolated DSH Profile and RPC endpoint to let `dsh-agent-swarm` form a development Team that improves this repository, while preserving an external control path, independent verification and rollback. The loop is intended to reveal real coordination defects and convert verified failures into canonical repair tasks without allowing the candidate plugin to approve or deploy itself.

## 2. Composition

```text
project manager / user
  -> stable control Profile (last-known-good plugin + DSH RPC)
       -> Lead Session
            -> TeamDomainPort (one authoritative backend)
            -> adaptive Scheduler OR Workflow owner
            -> Jobs projection and cancellation
            -> Workspace Provider
                 -> Worker A: Worktree A, exact cwd/tool roots
                 -> Worker B: Worktree B, exact cwd/tool roots
            -> Review Providers
                 -> command/check
                 -> independent Reviewer Agent
                 -> optional human approval
       -> frozen candidate artifact
            -> isolated acceptance Profile + separate RPC/state
                 -> load/dump-config/reload/recovery/e2e/security checks
                      -> external promotion or rejection
```

The control Profile owns Team admission and promotion coordination. The selected Team backend owns roster, mailbox and task state. A Workspace Provider owns leases and cleanup. Review Providers own evidence evaluation. The acceptance Profile can report health but cannot promote itself.

## 3. Readiness gates

### D0 — Profile smoke after M1D

Required:

- all M1 security/protocol blockers closed and independently re-reviewed;
- real Profile composes Session persistence, Storage Domain, KV backend and this Bundle;
- clean load, `--dump-config`, RPC tool visibility, reload, recovery and bounded teardown pass;
- stable artifact and rollback command are recorded.

D0 does not perform autonomous source mutation.

### D1 — supervised single-writer dogfood after M1D

Allowed:

- one Lead, one coding writer at a time and any number of read-only research/review members;
- a dedicated project clone or Worktree that is not the stable control checkout;
- manual review, merge, acceptance Profile startup and promotion;
- low-frequency manager observation of committed Team/Job state and final reports.

Forbidden:

- two members writing the same checkout;
- automatic merge or stable Profile replacement;
- candidate writes to control storage, official/ref checkouts or credentials;
- describing prompt-only `writeScopes` as isolation.

### D2 — supervised parallel self-development after M2 and M3

Required:

- Workflow/Jobs integration with one transition owner, durable run ids, cancellation and completion disclosure;
- one immutable base revision and one unique branch/Worktree/lease per attempt;
- out-of-process DSH/ACP execution whose actual cwd, filesystem and shell roots equal the lease;
- command/check and independent Reviewer Providers; canonical completion cannot bypass them;
- frozen commit and package artifact digest before verification;
- separate acceptance Profile/port/state root, health checks and deterministic rollback;
- merge queue serializes promotion and rejects stale attempt/lease generations;
- structured diagnostics redact credentials and remain linked to Team/task/run ids.

### D3 and D4

D3 adds accepted-evidence memory and approval-separated Skill Evolution. D4 adds distributed CAS/leases/fencing, remote observability, packaged release, migration and unattended rollback. Neither level is implied by successful local parallel dogfood.

## 4. Candidate lifecycle

```text
planned
  -> leased
  -> running
  -> submitted
  -> frozen
  -> verified
  -> acceptance-booted
  -> accepted
  -> promoted
```

Any verification, boot, recovery or health failure moves the candidate to `rejected`. A rejected candidate remains immutable evidence. A repair uses a fresh attempt and lease; it never reopens the old accepted/rejected generation. Promotion records stable and candidate commit, artifact digest, Profile configuration identity, verification evidence and rollback target.

## 5. Observation and management loop

The manager reads structured facts rather than member reasoning:

- Team/task/run/revision/attempt identifiers and transitions;
- live Agent status, lineage and abandoned ownership;
- mailbox ids, pending/ack state and recovery outcome;
- Workspace lease, exact cwd, branch, base and cleanup result;
- Job phase, cancellation, timeout and safe diagnostic;
- test/review evidence, frozen commit/artifact digest and acceptance health;
- token/request/context projections used for efficiency analysis;
- final stage or blocker report.

Observed failures become Lead-owned tasks with reproduction evidence, expected invariant and acceptance check. The manager does not directly patch canonical state, rewrite reviewer conclusions or push a healthy Team toward early convergence.

## 6. Defects this dogfood must expose

- duplicate/lost messages across crash windows;
- orphan or double-provisioned members;
- Scheduler selecting busy/unavailable Agents;
- stale attempt, lease or bootstrap ACK acceptance;
- hung admission/disposal/cancellation;
- cross-Worktree or control-root writes;
- review bypass, reviewer/worker collusion and mutable evidence;
- merge races, dirty base, cleanup failure and rollback failure;
- Bundle/inject/Profile drift, port conflict and reload leakage;
- excessive tool/status context, repeated scans and accounting duplication.

Each confirmed defect requires a regression test in the owning layer and an update to the implementation-status documents. Logs alone are not closure evidence.

## 7. Permission and resource policy

Model usage is not constrained for cost or forced convergence unless the user requests it. Fault containment remains mandatory:

- bounded concurrent writers and processes;
- cancellable commands with explicit timeout and captured result;
- retry/recursion detection and stale-generation fencing;
- disk, artifact, mailbox, attempt and diagnostic retention limits;
- deny write access to stable control artifacts, storage roots, secrets and evidence checkouts;
- recoverable cleanup and a tested rollback path.

These controls protect correctness and host availability; they are not billing policy.

## 8. Promotion rule

The first releases use manual external promotion. Automation may later perform the mechanical switch only after all configured gates accept and only from a controller that is not loaded from the candidate artifact. No Agent, reviewer, candidate Profile, UI or prompt message can alone mark a candidate promoted.


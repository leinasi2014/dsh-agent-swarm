# 05. Product feature mapping

JiuwenSwarm contributes product concepts and failure cases. It does not contribute runtime authority. Every feature below must land on an official DSH seam or a project-owned adapter with one explicit owner.

## 1. Capability map

| Product capability | DSH landing surface | Ownership rule |
|---|---|---|
| one-shot worker | `ctx.subagents.start()` | official Subagent Provider |
| persistent member | continuable subagent | official lifecycle plus Team member adapter |
| adaptive Team scheduling | Team task DAG and Scheduler policy | `TeamDomainPort` is the only task writer |
| deterministic workflow | `ctx.workflowEngine` Team bridge | Workflow owns run state; Team owns Team tasks |
| background observation/cancel | `ctx.jobs` or a read-only Team job projection | never shadow the default Job registry |
| human question/approval | `ctx.userQuestions` / `ctx.approval` | official interaction owner |
| token/request/retry/deadline budget | Team policy ledger | official token-meter remains a host-side measurement face |
| Worktree execution | managed workspace lease plus a Session/tool root that actually changes | prompt-only paths are forbidden |
| local/remote member | member Provider registry | one selected Provider per member execution |
| distributed reservation | remote control-plane lease/ACK Provider | transport is replaceable and absent from the Service contract |
| Team memory | accepted-evidence extractor Consumer | not task-board state |
| private member memory | Agent-scoped append-only memory domain | owning active member only |
| Skill Evolution | signal → proposal → validation → approval → write | Team supplies evidence, never self-authorization |
| tool permission | creation-time tool filter plus host sandbox/permission policy | deny-only overlays cannot widen host authority |
| Team UI | official Client extension points and read-only Host projections | UI owns no scheduler or persistence state |
| self-development | stable control Profile, managed writers, frozen candidate and separate acceptance Profile | candidate cannot accept or promote itself |

## 2. Adaptive and deterministic execution

Both modes can exist, but never advance the same Team concurrently.

- Adaptive mode lets the Lead and Scheduler create and assign work dynamically.
- Workflow mode fixes phases, barriers, schemas, human points and completion rules.
- Mode is selected at a lifecycle boundary. Runtime mode switching fails loud unless in-flight work has been explicitly settled.
- Workflow/Job/UI projections may merge observations for users; they do not duplicate the Team aggregate or mutate through a second route.

## 3. Worktree and self-development

Worktree isolation is true only when the actual execution cwd, filesystem capability and tools resolve inside the leased root. A declared path in a prompt is disclosure, not enforcement.

Repository self-development follows the project binding:

1. the stable control Profile loads a last-known-good immutable artifact;
2. writers use only project-managed owner/generation-fenced allocations;
3. a candidate is frozen to a commit and immutable package digest;
4. review and acceptance run against the frozen candidate in a separate Profile/state root;
5. GitHub `main` is updated only after the required candidate checks and review;
6. `origin` receives a backup only after GitHub-main identity is read back;
7. rollback selects a previously accepted immutable artifact from outside the candidate runtime.

## 4. Memory and Skill growth

Team memory is derived from accepted evidence and keeps compact, attributable records:

```text
[decision] choice, alternatives, trade-off and evidence
[lesson] condition, outcome and reusable response
[member] demonstrated capability and confidence
[context] durable project or stakeholder constraint
```

Skill growth is a separate controlled pipeline:

```text
accepted signal
  → attributed proposal
  → deterministic validation
  → independent approval
  → versioned write
  → load in a later Agent lifecycle
```

Raw private reasoning, unaccepted task output and a candidate's own claims are not admissible growth evidence. Secrets and personal data are filtered before shared memory or Skill proposals.

## 5. Distributed boundary

The design separates:

- control plane: discovery, reservation lease, bootstrap, readiness ACK and release;
- data plane: tasks, messages, outputs, budget and durable status.

SDK, ACP, Redis Streams, gRPC or another transport may implement a Provider. The public service and stored Team records must not name one transport. Process-local serialization is never described as distributed atomicity; cross-process ownership requires lease, fencing and stale-writer rejection.

## 6. Explicitly out of scope

- embedding Jiuwen's Python Runtime or its transport stack;
- nine-channel IM adapters, proactive recommendations, AutoHarness, GitCode issue automation, media/phone toolkits and hardware KV-cache management;
- a plugin self-updater or multi-instance manager with promotion authority;
- a second MCP/tool ownership model;
- turn-level undo/redo or Session state copying outside official Session/fork behavior;
- pre-packaged expert groups that become a second roster authority;
- dynamic per-task rescoping of a persistent member until the official child seam can express it safely.

Implementation status and exit criteria belong in `docs/07-implementation-roadmap.md`; protocol details belong in `docs/04-core-protocol.md`.

# 05. Mapping JiuwenSwarm features to DSH plugins

## 1. Mapping table

| JiuwenSwarm feature | DSH implementation | Package ownership |
|---|---|---|
| SwarmFlow script | published `ctx.workflowEngine` plus Team bridge | `team-workflow-bridge` Consumer |
| `agent()` one-shot | `ctx.subagents.start()` | existing DSH subagent Provider |
| `agent_session()` | continuable subagent | existing DSH subagent + Team member adapter |
| `human()` / `human_session()` | `ctx.userQuestions` and `ctx.approval` | interaction Consumer |
| `parallel` / `pipeline` | workflow scripts/operators | published workflow service, not Team core |
| nested workflow | workflow composition | published workflow service |
| token budget | `ctx.tokenMeter` projection + cumulative Team policy ledger | 0.1 direct Session folding / future official adapter |
| `isolation=worktree` | workspace lease Provider | `team-workspace-worktree` |
| local/distributed Team | member Provider registry | local subagent / remote DSH providers |
| registry reservation | remote member control plane | `team-member-remote` |
| shared task/message DB | distributed atomic Team store | store Provider |
| Team memory | extractor Consumer writing memory service | `team-memory` |
| personal member memory | Agent-scoped memory provider | generic memory family |
| Dreaming | idle schedule/job Consumer | generic memory-dreaming plugin |
| Skill Evolution | signal detector + proposal + approval + writer | generic skill-evolution plugin |
| tiered permissions | DSH permission/sandbox/tool events | existing interaction/security seams |
| context offload | compaction/spill Provider | existing DSH seams |
| heartbeat tasks | schedule/jobs Consumer | generic plugin, not Team core |
| self-improving coding Team | stable control + Worktree Workers + Review + acceptance Profile | ADR-0008 project composition over official seams |

## 2. Deterministic workflow versus adaptive team

Both modes should coexist:

### Adaptive scheduling

Lead and Scheduler create/assign tasks dynamically. Best for discovery, changing requirements and loosely coupled work.

### Deterministic workflow

A workflow definition fixes phases, barriers, schemas, human points and budget behavior. Best for repeatable delivery pipelines.

The workflow bridge will write Team task/run observations, while workflow state remains owned by published `ctx.workflowEngine`. The bridge is absent in 0.1. Before adding it, define an explicit run mode so adaptive Scheduler and deterministic Workflow cannot both own assignment, retries or completion. Team UI may display a merged projection without duplicating either state machine.

## 3. Worktree isolation

Jiuwen demonstrates the product value of one worktree per coding worker. DSH’s current continuable child preparation contract only contributes parent-history seed; it does not let an in-process Provider override cwd. Therefore the first correct implementation choices are:

1. remote DSH/ACP member whose Session starts with the Worktree cwd; or
2. a new generic DSH child-workspace capability accepted upstream; or
3. a tool-level workspace executor that never claims the Agent itself has a different cwd.

Do not fake isolation by only telling the model a path while its shell/fs tools still resolve another workspace.

For plugin self-development, Worktree isolation is paired with a last-known-good control Profile. Submitted commits and package artifacts are frozen before independent review and loaded only in a separate acceptance Profile/port/state root. The candidate cannot approve/promote itself or write control storage, credentials, official source or either reference checkout. M1D permits single-writer dogfood; parallel self-development requires the M2/M3 exit evidence.

## 4. Team memory

Team memory is an asynchronously derived product, not the task board. It should preserve compact reusable entries:

```text
[decision] choice, alternatives, trade-off and evidence
[lesson] failure/success condition and reusable response
[member] demonstrated capability and confidence
[context] durable project constraint or stakeholder requirement
```

Every entry should link back to Team/task/run/session evidence. Extraction must merge/de-duplicate and enforce a size policy.

## 5. Skill evolution

Useful signals:

- tool failures and timeouts;
- review-gate rejection;
- stale assumption discovered by another member;
- explicit user correction;
- repeated manual workaround;
- capability gap.

Flow:

```text
signal detector
  → attributed evidence
  → evolution proposal
  → deterministic validation
  → approval policy
  → write evolutions record or Skill patch
  → next Skill load sees the accepted update
```

This belongs to generic Skill capability extensions. Agent Team only contributes additional evidence and team-level visibility policy.

## 6. Distributed control/data plane

Borrow the separation, not the exact ZMQ implementation:

- Control plane: discovery, reservation lease, bootstrap, readiness ACK, destroy/release.
- Data plane: tasks, messages, outputs, budget and durable status.

DSH Providers may use SDK, ACP, Redis Streams, gRPC or another transport. The Service contract must not name one transport.

## 7. 2026-08-20 inventory additions

Newly verified capabilities (source files under `ref/jiuwenswarm/source/jiuwenswarm/`), mapped to this plugin's milestone plan or explicitly not adopted.

### 7.1 Adopted as requirements or reference patterns

| Capability | Source | Placement |
|---|---|---|
| Agent loop circuit breaker (generic_repeat / unknown_tool_repeat / ping_pong / global, WARNING/CRITICAL dual thresholds) | `agents/harness/common/rails/execution_guard/circuit_breaker_rail.py` | M5 fault-containment Provider (AGENTS.md rule 15's retry-loop detection) |
| Memory write masking for secrets/PII (including Chinese natural language and Markdown table shapes) | `agents/harness/common/memory/forbidden.py` | M7 mandatory memory security requirement |
| Hybrid memory retrieval (SQLite FTS + vector + embedding cache) and background "dreaming" compaction/promotion (30-day/10-session/5-promotion bounds) | `agents/harness/common/memory/manager.py`, `memory/dreaming/sweeper.py` | post-M7 optional enhancement; not M7 scope |
| Symphony progressive tree skill indexing/retrieval, capability fingerprints, versioned graph storage, plan.outcome learning with failure attribution | `symphony/{indexing,retrieval,evolution}` | reference only; M7 consumes official skill seams first |
| A2X HTTP registry client (reservation envelope, ownership file lock, schema-versioned atomic rewrite) | `agents/harness/team/a2x/` | M8 distributed reservation/ACK reference |
| Session-event graceful degradation (host-unknown types omitted, disk authoritative) | ref/dsh-agent-teams `src/events.ts` | M8 observability consumer pattern |
| Heartbeat liveness (HEARTBEAT.md protocol, active_hours) | `gateway/heartbeat/heartbeat.py` | M8 liveness evidence idea for dogfood |
| Trajectory/debug observability (span processors, subagent capture) | `server/runtime/debug_trace`, har

## 7. 2026-08-20 inventory additions

Newly verified capabilities (source files under `ref/jiuwenswarm/source/jiuwenswarm/`), mapped to this plugin's milestone plan or explicitly not adopted.

### 7.1 Adopted as requirements or reference patterns

| Capability | Source | Placement |
|---|---|---|
| Agent loop circuit breaker (generic_repeat / unknown_tool_repeat / ping_pong / global, WARNING/CRITICAL dual thresholds) | `agents/harness/common/rails/execution_guard/circuit_breaker_rail.py` | M5 fault-containment Provider (AGENTS.md rule 15's retry-loop detection) |
| Memory write masking for secrets/PII (including Chinese natural language and Markdown table shapes) | `agents/harness/common/memory/forbidden.py` | M7 mandatory memory security requirement |
| Hybrid memory retrieval (SQLite FTS + vector + embedding cache) and background "dreaming" compaction/promotion (30-day/10-session/5-promotion bounds) | `agents/harness/common/memory/manager.py`, `memory/dreaming/sweeper.py` | post-M7 optional enhancement; not M7 scope |
| Symphony progressive tree skill indexing/retrieval, capability fingerprints, versioned graph storage, plan.outcome learning with failure attribution | `symphony/{indexing,retrieval,evolution}` | reference only; M7 consumes official skill seams first |
| A2X HTTP registry client (reservation envelope, ownership file lock, schema-versioned atomic rewrite) | `agents/harness/team/a2x/` | M8 distributed reservation/ACK reference |
| Session-event graceful degradation (host-unknown types omitted, disk authoritative) | ref/dsh-agent-teams `src/events.ts` | M8 observability consumer pattern |
| Heartbeat liveness (HEARTBEAT.md protocol, active_hours) | `gateway/heartbeat/heartbeat.py` | M8 liveness evidence idea for dogfood |
| Trajectory/debug observability (span processors, subagent capture) | `server/runtime/debug_trace`, harness `agent_observability.py` | M8 observability projections |
| Human team membership via IM (/join seat claiming, GODVIEW/MEMBER roles, $-mention) | `gateway/routing/session_sharing.py` | optional M9 client roles note; official questions/approval remain the M5 seam |

### 7.2 Not adopted (recorded to prevent re-litigation)

| Capability | Reason |
|---|---|
| Nine IM channel adapters, attachments pipeline, proactive recommendation engine, eternal-conversation background agents, AutoHarness, GitCode issue auto-fix, video/image/phone toolkits | product domain outside `docs/00` scope; nothing is embedded from the Jiuwen runtime |
| KV-cache affinity lifecycle (Ascend evict/offload/prefetch, task guard) | host/hardware infrastructure, not a plugin layer; official tokenMeter owns the measurement surface |
| Self-updater and multi-instance manager | conflicts with ADR-0008: promotion must stay with an external stable controller; a running plugin never updates itself |
| Turn-level undo/redo, session fork/rewind/state-copy | official Sessions/fork + the Session log already own this domain |
| MCP runtime and tool ownership model | official mcp-client package already provides it |
| Monetary budgets | the reference has none either (only `swarmflow_budget` and WS byte limits) — M4 stays token/request/retry/deadline plus the tokenMeter adapter |
| E2A envelope / A2A bidirectional protocol stacks | remote-agent interop arrives through official subagent providers (ACP/codex/claude-code) in M6, not a parallel transport |
| **AgentGroup packages in hybrid team mode** (upstream `36c7959`, 2026-08-21 review) | product concept candidate, not adopted: if pre-packaged expert teams (leader + predefined members + shared skills) are ever wanted, the landing surface is official Bundle/Profile composition, never the Team core; a hybrid roster must keep "predefined members are an initial roster snapshot, not a second authority" — same single-authority rule as `TeamDomainPort` |
| **Session-immutable selection binding + multi-source conflict-reject** (same commit) | not adopted as features, but recorded as external corroboration: upstream's four-branch immutable-binding matrix (first-create optional / missing-inherit / switch-reject / late-reject) is a clean failure-mode sample for future session-bound config (budget/permission profiles), and its choice of conflict-reject over shadowing for same-named packages corroborates docs/10 §6's "single authority, reject ambiguity" conflict table; also note its prompt-ownership split (template snapshots keep capabilities only; `TeamMemberSpec.prompt` is the sole persistent truth) — the same capability/prompt separation as our "prompt is never authorization" boundary |

# Member private memory — design, official-API boundary and fault evidence (2026-08-26)

Status: candidate-implemented (branch `codex/member-private-memory`, baseline `0e14df1d`). Protocol contract: `docs/04` §8p.

## Objective

Give the **current active owning member** an append-only, private, durable memory exposed by two minimal tools appended after the established 19-tool surface:

- `agent_swarm_add_private_memory`
- `agent_swarm_list_private_memory`

Both are member-facing (never added to `CAPTAIN_ONLY_TOOLS`), take **no target-member parameter**, and read/write only the caller's own partition.

## Official API boundary and controller ruling

The original intent was a namespaced non-surface **Session event** (`agent_swarm/member-private-memory`) as the single durable truth, with the member's own official append-only Session as the source. That is not expressible on the installed official API:

- `@deepseek-ai/dsh-session`'s `KNOWN_SESSION_EVENT_TYPES` is **first-party only**. Its own doc comment states *"Downstream (out-of-repo) plugin events are outside this list by construction; a registration surface for them is deferred"*. The persistence read path refuses to interpret a log containing a type outside that set **unless the envelope carries `ignorable: true`**.
- The public `Session.append(type, data, ...opts)` accepts **no `ignorable` marker** (its only option is surface metadata for surface-eligible types). The installed build's append never stamps `ignorable` on any event.
- Therefore a plugin cannot add its own durable Session event type without patching DSH. Equivalent forbidden routes: monkey-patching `KNOWN_SESSION_EVENT_TYPES`, modifying DSH, reusing unrelated known types (`feedback/…`, `team/…`, `hook/…`) as a disguise, or placing private content in a surface message.

**Ruling (controller, 2026-08-26):** persist private memory in a **plugin-owned official Storage Domain append-only log** — the workflow (`docs/04` §8f) / human-interaction overlay precedent. It is **not TeamState, not a second Team state machine, never copied into TeamState**, and must not change Team snapshot/revision/shared memory. A minimal Storage Domain spec/table is the necessary persistence adaptation allowed by the ruling. The explicit list tool's `tool/call` + `tool/result` naturally enter the member's official Session, so the model-visible content is still replayable from that Session; there is no prompt injection.

## Single source of truth and what it is NOT

- **Truth:** the `memories` table of the `agent_swarm_member_private_memory` Storage Domain (schemaVersion 1). Appends are durable-before-resolve (domain write chain), so a committed record survives a crash/reopen.
- **NOT:** the `agent_swarm` Team aggregate (never written by these tools), a second Team state machine, a copy of the shared `team.memory` ledger (which keeps its own `maxMemories` cap and ADR-0007 schema), or any set of in-memory records.

## Isolation and keying

Isolation is the **workspace scope + durable Team identity + member's durable Session identity** tuple. The table key is `JSON.stringify([scope, teamId, memberSessionId, seq])`. At the durable read boundary the store enforces a **two-way key↔record check**: every stored record must satisfy `key === memoryKey(record.scope, record.teamId, record.memberSessionId, record.seq)`, otherwise reads fail loud with `TEAM_PRIVATE_MEMORY_TAMPERED` — so neither a foreign key carrying a victim tuple nor a victim key carrying a foreign tuple can slip into any member's view. Records are then isolated to a partition by the authoritative fields, and `seq` is the member-local monotonic creation index (`memory_id = private-memory-<seq>`). All input, stored, appended-return and list-return graphs are **deep-copied** (`structuredClone`), so counter-mutation by a caller can never pollute the authority memory (the official Storage Domain stores records by reference).

## Authorization (owning active member only)

`MemberPrivateMemoryService.owningMember` (the sibling service, assembled in `apply` and provided as `ctx.agentSwarmPrivateMemory`) requires `exec.agent`, verifies the **exact live registered Agent** via an injected `ctx.agents.get(agent.id) === agent` oracle, then calls `domain.requireMembership(scope, agent.id)` and narrows to `role === 'member'` (an active roster row, Phase `active`). Because the partition key is the caller's own durable Session id, a member can never address another member's private memory; there is no target parameter to attack.

Rejected callers and codes:

- no active `role === 'member'` membership → `TEAM_NOT_JOINED` (external sessions, failed/removed/archived members, archived teams);
- joined as captain → `TEAM_PRIVATE_MEMORY_UNAUTHORIZED`;
- store closed → `TEAM_PRIVATE_MEMORY_STORE_CLOSED`;
- store not mounted (pre-open) → `TEAM_PRIVATE_MEMORY_UNAVAILABLE`.

This is deliberately stricter than the shared-memory read face (F14 keeps an archived captain's terminal read): archived members lose all private-memory access.

## Reader design

`agent_swarm_list_private_memory` is an explicit, point-in-time, paginated read in creation order. No semantic search, no prompt injection, no LLM extraction. Reuses already-justified single-entry bounds: content ≤ 16384 UTF-8 bytes, each evidence ref ≤ 2048 bytes (shared `nonEmpty` / `TEAM_INPUT_INVALID` / `TEAM_INPUT_LIMIT`), and the model face truncates the ref list to the first 32 with `evidence_refs_truncated: true` (the shared `list_memory` reader precedent). Pagination reuses the established aggregate-reader `cursor`/`limit` window (`limit` 1–100, default 50, `next_cursor` only when more rows exist). **No arbitrary total-entry cap** is introduced (the shared `maxMemories` bounds only TeamState).

## Lifecycle

- `apply` opens the domain via `ctx.storageDomain.open(privateMemoryDomainSpec)`, constructs `MemberPrivateMemoryStore`, assembles the sibling `MemberPrivateMemoryService`, and provides it as **`ctx.agentSwarmPrivateMemory`** (the `AgentSwarmRuntime` object is deliberately untouched).
- Closed by a `ctx.effect` disposer (`closePrivateMemory`) and by every later apply-failure path (`closePrivateMemory` before `runtime.dispose()`), mirroring the human-interaction domain's reverse-dispose discipline.
- Writes/reads fail loud when closed.

## Non-leakage

Private content is never projected by `agent_swarm_status`, shared `agent_swarm_list_memory`, `agent_swarm_list_members`, the jobs projection, Host/RPC, or any member-description summary. Locked by the real-composition test's read-surface assertions.

## Test evidence

- `tests/member-private-memory-store.spec.ts` (12 unit tests over the real storage-domain stack with an injected faultable medium): ordering/id monotonicity, pagination, **scope isolation with identical Team+member ids**, cross-member/cross-team isolation, evidence truncation, invalid input (`TEAM_INPUT_INVALID`/`TEAM_INPUT_LIMIT`), flush/append failure leaving no partial state, closed-store rejection, **both tamper directions failing loud with `TEAM_PRIVATE_MEMORY_TAMPERED`** (victim key / foreign tuple and foreign key / victim tuple), deep-copy input/append-return/list-return mutation isolation, and **cold-reopen deep-copy isolation** over the same medium.
- `tests/member-private-memory-real-composition.spec.ts` (2 real dual-context tests): (1) member writes in Context A; Team snapshot deep-memory/content invariants + read-surface non-leakage; full dispose of A; B reopened over the SAME official SQLite + Storage Domain roots with only official `ctx.agents.resume` recovery; exact `list` restoration, further appends in B, pagination, peer/captain/outsider rejection, removed-member and archived-team rejection. (2) a precise invariant: after quiescing the Team revision, a **direct `ctx.agentSwarmPrivateMemory.add` call with the exact live member exec** leaves the whole Team snapshot **deep-equal**, and the real tool face still **functions** (returns success and reads back) — a functional-return proof only; it does not run an AgentLoop and is not Session evidence.
- `tests/member-private-memory-session-evidence.spec.ts` (1 real AgentLoop test): a gated model adapter emits actual `agent_swarm_add_private_memory` + `agent_swarm_list_private_memory` tool calls on a genuine member turn (scheduler-driven); the member official Session carries the exact `tool/call` (with the durable content in `arguments`) paired to its `tool/result` by `callId`, replayable, and the private content never appears in any `user/message` prompt (no auto-injection).
- `tests/member-private-memory-startup-rollback.spec.ts` (1): a human-assembly apply failure runs `closePrivateMemory`, releasing `ctx.agentSwarmPrivateMemory` and freeing the `agent_swarm_member_private_memory` domain name for a fresh open.

Note on revision: a legitimate `agent_swarm_*` tool call by a member bills that member's Session into the Team ledger (`docs/04` §8k), which bumps the Team revision — that is expected and unrelated to private storage. The content-absence and deep-equality assertions are the precise, non-flaky invariants.

## Non-targets

- No second Team state machine, no changes to TeamState schema, no shared-memory reuse, no target-member parameter, no prompt injection, no semantic search, no automatic extraction, no total-entry cap, no change to `KNOWN_SESSION_EVENT_TYPES` or any official DSH code, no UI/Settings/Knowledge Graph/Canvas/fresh-v2, no new worktree/branch/push/merge.

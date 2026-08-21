# 03. Capability-family architecture

## 1. Official-first composition architecture

The architecture is organized around official ownership, not around copying either reference repository:

```text
Official DSH execution plane
  Sessions + persistence ─ Agents ─ Subagents ─ Tools/System Prompt
             │               │          │
             └───────────────┴──────────┘
                             │ consumed by
Canonical Team port          │
  TeamDomainPort ────────────┘
    ├─ current: ctx.storageDomain local Provider (one Team aggregate per record)
    ├─ legacy: read-only FileTeamStore migration reader (never runtime authority)
    └─ future: official ctx.agentTeams Provider after publication/promotion
                             │
Project-owned orchestration overlay
  TaskRun/attempt fencing ─ Scheduler ─ Review ─ Team budget/memory checkpoints
       │                       │
       ├─ ctx.workflowEngine + ctx.jobs bridge (deterministic mode)
       ├─ ctx.tokenMeter boundary: host-side official metering face; Team measurement stays the plugin's per-seq fold (M4-1)
       ├─ ctx.storageDomain Store Provider
       ├─ ctx.workspaceRegistry linkage + real remote/worktree executor
       └─ questions/approval interaction Providers
                             │
Consumers and composition
  scoped model tools ─ command/UI projections ─ recommended Bundle/Profile
                             │
Self-hosting composition     │
  stable control Profile ─ frozen artifact ─ isolated acceptance Profile
          │                         │                    │
      Team/Jobs owner          immutable evidence     health/reload/RPC
```

Every vertical domain has one canonical owner. The overlay stores linkage/fencing/policy facts only; it never mirrors an official service's writable state. Adaptive scheduling and deterministic workflow are mutually exclusive transition owners for a run.

ADR-0008 adds a composition boundary, not a new canonical domain. The stable Profile runs a last-known-good artifact and owns admission. Workers write only leased Worktrees. Review Providers evaluate a frozen candidate, an isolated acceptance Profile proves real loading, and an external promotion controller selects or rolls back the stable artifact. Candidate logs, Git branches and Profile health are evidence linked to Team/Job ids, never writable Team truth.

Independently deployable project packages should evolve only when a current Consumer or second Provider requires the split:

```text
dsh-agent-swarm                         recommended Bundle/composition
  ├─ dsh-team-domain                    Service Definition (`TeamDomainPort`)
  ├─ dsh-team-domain-local              current compatibility Provider
  ├─ dsh-team-domain-official           future official-agent-team adapter
  ├─ dsh-team-orchestrator              TaskRun/fencing + mode ownership
  ├─ dsh-team-scheduler-*               adaptive policy Providers
  ├─ dsh-team-workflow-bridge           official Workflow/Jobs Consumer
  ├─ dsh-team-budget                    policy + Token Meter adapter
  ├─ dsh-team-review-*                  command/Agent/human Providers
  ├─ dsh-team-workspace-*               lease/remote execution Providers
  ├─ dsh-team-memory                    extraction/checkpoint Consumer
  ├─ dsh-tool-agent-swarm               model Consumer
  └─ dsh-ui-agent-swarm                 optional client Consumer
```

Names are provisional until packages actually split. No new public service key or durable format is committed without a current Consumer, official collision check and ADR.

## 2. Core versus optional capabilities

### 0.1 concrete host seam

The first release publishes `ctx.agentSwarm` from the Bundle package because model tools already provide a real Consumer and host-side tests need the same authority path. It owns the compatibility domain, Scheduler/Review Provider registries, DSH lifecycle composition and durable projections. The default Providers are `priority-ready` and `manual`; external plugins register alternatives and dispose their registrations with their own Cordis fiber.

The model-facing `agent_swarm_*` tools call this service. They never read or patch persisted records directly. Since M1A the authoritative Store is `StorageDomainTeamStore`, a process-local Provider behind the `TeamAggregateStore` interface that opens the `agent_swarm` official Storage Domain and persists one versioned Team aggregate record per Team plus durable migration receipts; durability lands through the official domain write chain before any read or waiter observes a change. The legacy `FileTeamStore` is a read-only offline migration reader and test fixture; the runtime never constructs it, and a workspace writer can no longer reach Team authority.

The selected Scheduler and Review Providers are validated before a task is committed. This preserves extension registration order during plugin activation while ensuring an unknown configured Provider cannot leave a durable task that will never run or be reviewable.

### M1 authority boundary (implemented in M1A)

ADR-0007 moved storage integration ahead of Workflow and Token Meter integration; M1A implements it:

- `sessionPersistence` and `storageDomain` are required injections (a Profile missing either keeps the plugin pending — fail closed, covered by composition tests);
- tools and orchestration consume one `TeamDomainPort`, implemented by `TeamDomain` over one selected `TeamAggregateStore`;
- the local production Provider opens the namespaced `agent_swarm` official Storage Domain and retains one versioned Team aggregate per record so one Team revision remains one write boundary; migration receipts are a second durable table;
- `FileTeamStore` is removed from the default runtime and retained only as a read-only offline migration reader and fixture;
- migration refuses a nonempty destination, verifies the durable read-back, retains a receipt and never dual-writes; the runtime performs no automatic migration or fallback;
- the Provider remains process-local because official Storage Domain change visibility and write serialization are not distributed claims or leases.

This is a host capability boundary, not cryptographic protection from a process with unrestricted host access. Coding members must receive workspace-scoped filesystem/shell permissions that cannot write the Harness storage root.

### Canonical Team domain

Target ownership is official `ctx.agentTeams` when a supported published API is available, or one compatibility adapter during migration. Current ownership is the private `TeamDomain` behind `TeamDomainPort`, persisted through the official Storage Domain Provider; the official adapter remains unwired until the experimental package is published:

- Team membership and authority
- durable roster
- durable mailbox
- task DAG
- task revision/CAS
- member interrupt and observation
- domain lifecycle and events

### Orchestrator overlay

Owned by this project:

- scheduling strategy
- execution attempt/fencing record
- workflow run linkage
- workspace lease
- budget reservation/consumption
- review/verification record
- memory extraction checkpoint

Keeping the overlay separate lets official Team task states remain small while richer execution policy evolves independently.

## 3. Proposed service roles

### TeamDomainAdapter

Purpose: present the subset of Team operations needed by the orchestrator, whether the backend is official Agent Team or a characterized community implementation.

It must not duplicate Team state. It maps identity, task revision, mailbox and change observation onto one authority source.

### TeamScheduler

A provider registry rather than one hardcoded loop.

Candidate providers:

- `event-ready`: reacts to member idle and Team changes;
- `workflow`: workflow script owns phase order;
- `priority`: selects by explicit priority/deadline;
- `cost-aware`: selects model/member using remaining budget;
- `manual`: no automatic assignment.

The scheduler issues decisions. It does not mutate storage directly; it calls Team/Run services with expected revisions.

### TeamWorkspace

Creates and owns a workspace lease for one execution attempt:

```text
shared-readonly | shared-advisory | worktree | temporary | remote
```

A lease contains canonical cwd, base revision, cleanup policy and merge metadata. Tool authorization must derive from the actual Agent workspace/sandbox, not from advisory task fields.

### TeamBudget

Reserves and accounts limits for Team, workflow and task runs:

- input/output tokens;
- request count;
- retries;
- elapsed/deadline;
- optional monetary cost;
- member concurrency.

Target publishes `ctx.tokenMeter` (`@deepseek-ai/dsh-token-meter`; published at rc.8 and fold-identical through 0.1.1-rc.2, where only the `ProjectionDefinition` contract shape changed). Its two faces are characterized and registered (`docs/development/2026-08-22-m4a-tokenmeter-design.md`, M4-1/issue #127): `measure()` reports current request/surface pressure for the NEXT request of one session (no cumulative total), and the `tokenUsage` session projection is a per-session cumulative fold of provider usage with chunk-early/message-final replacement semantics (a final `assistant/message` usage replaces its step's chunk sample; chunk-only usage from failed requests still counts; totals are deliberately non-monotone under corrections). Neither face is a Team budget ledger: there is no cross-session aggregation, admission, carry or per-event attribution.

Boundary (decided, Option B of M4-1): the Team budget keeps exactly ONE measurement path — this plugin's own fold over committed `assistant/message.usage` events under durable per-session sequence cursors (M1B/#92 semantics; #79 carry) — and the official tokenMeter stays the host-side official metering face, not consumed by the budget, so double counting is excluded by construction. Parity is proven, not assumed: `tests/tokenmeter-parity.spec.ts` drives one real composition (official `SessionStore` + `SessionProjectionRegistry` + `TokenMeter` and the plugin's `UsageAccountant` over the same firehose) and pins numeric equality on every log shape where the faces are defined to agree — usage-bearing steps (equal or corrected samples), aborted-turn usage — plus the single declared divergence: a provider usage chunk from a request that failed before assembling content bills on the official face and deliberately does not bill the Team ledger. Re-evaluation trigger for consuming the official face as measurement source: it must first expose per-event usage attribution (or a monotone per-step settled-usage face); watermark-plus-delta folding over today's whole-value totals cannot preserve the M1B exactly-once cursor semantics (non-monotone corrections yield negative deltas; recovery loses seq attribution).

### TeamReview

Converts “worker submitted output” into an independently accepted result. Providers may run:

- build/lint/test commands;
- diff and changed-file policy;
- schema validation;
- security checks;
- reviewer Agent;
- human approval.

A task reaches canonical completed only after the configured gate accepts it.

### TeamMemory

Listens after an accepted round/task and writes structured experience through a memory service/provider. Suggested categories from Jiuwen prior art:

- decision
- lesson
- member
- context

Memory extraction is not Team state and must not block task commit unless explicitly configured as a required postcondition.

## 4. Consumer packages

### Model tools

Tools expose stable task concepts, not Provider names or database details. Operations should be narrow and authorization derived from `exec.agent`.

### Workflow bridge

Maps published DSH `ctx.workflowEngine` runs/events to Team task/run records and uses `ctx.jobs` for background observability. The bridge must declare exactly one orchestration owner per run: adaptive Scheduler or deterministic Workflow. It must not let both state machines assign or settle the same attempt. Interaction services are used for human nodes after their target exports are verified.

### UI

Renders roster, task DAG, attempts, workspaces, budget and gates from authoritative snapshots/events. UI actions call host contracts; they do not patch JSON files.

### Bundle

The Bundle chooses one coherent default composition. Each row remains replaceable by Profile patches.

### Self-hosting controller composition

Self-hosting reuses the Bundle, RPC host, Team tools, Workflow/Jobs, Workspace and Review Providers; it does not add a private Agent runtime or self-update service. D1 uses one writer and manual promotion after M1D. D2 requires the M3 vertical slice: actual out-of-process Worktree cwd/tool roots, executable independent review, frozen package evidence and a separate acceptance Profile. The candidate runtime cannot promote itself or write the stable control artifact/state root.

## 5. Current package versus target family

The package graph above is a target decomposition. The shipped 0.1 package is one host-only bundle containing domain, runtime, workspace file storage, tools, default Scheduler/Review providers, budget and manual memory. Only Scheduler and Review have runtime registration contracts. ADR-0007 fixes the next decomposition: Team Domain plus official Storage Domain Provider first, then crash/lifecycle hardening. Workflow/Jobs follows in M2; ADR-0008 inserts the self-hosting safety vertical at M3; Token Meter/accounting moves to M4. Full verification/permission, Workspace/remote, memory, distributed and UI families remain later work.

## 6. Why this is not over-modularization

A package split is justified only when at least one is true:

- multiple Providers coexist;
- the role has independent lifecycle/resources;
- host and client compile separately;
- policy must be replaceable without changing protocol;
- the package can be installed or tested independently;
- it prevents a Consumer from defining the Service contract.

Until these conditions exist, keep code private inside the owning package.

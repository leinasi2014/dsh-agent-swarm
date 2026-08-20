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
    ├─ current 0.1: workspace FileTeamStore (unsafe compatibility backend)
    ├─ M1: ctx.storageDomain local Provider (one Team aggregate per record)
    └─ future: official ctx.agentTeams Provider after publication/promotion
                             │
Project-owned orchestration overlay
  TaskRun/attempt fencing ─ Scheduler ─ Review ─ Team budget/memory checkpoints
       │                       │
       ├─ ctx.workflowEngine + ctx.jobs bridge (deterministic mode)
       ├─ ctx.tokenMeter accounting adapter
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

The model-facing `agent_swarm_*` tools call this service. They never read or patch JSON directly. The file Store is a process-local implementation behind the internal `TeamStore` TypeScript interface. In 0.1, the runtime still hardcodes `new FileTeamStore()` below the shared workspace; it is not a deploy-time replaceable Provider and a workspace writer can tamper with Team authority. It is a compatibility backend awaiting M1 migration, not an acceptable durable production boundary.

The selected Scheduler and Review Providers are validated before a task is committed. This preserves extension registration order during plugin activation while ensuring an unknown configured Provider cannot leave a durable task that will never run or be reviewable.

### M1 authority boundary

ADR-0007 moves storage integration ahead of Workflow and Token Meter integration:

- `sessionPersistence` and `storageDomain` become required injections;
- tools and orchestration depend on one `TeamDomainPort`;
- the local production Provider opens one namespaced official Storage Domain and retains one versioned Team aggregate per record so one Team revision remains one write boundary;
- `FileTeamStore` is removed from the default runtime and retained only for explicit offline migration and fixtures;
- migration refuses a nonempty destination and never dual-writes;
- the Provider remains process-local because official Storage Domain change visibility and write serialization are not distributed claims or leases.

This is a host capability boundary, not cryptographic protection from a process with unrestricted host access. Coding members must receive workspace-scoped filesystem/shell permissions that cannot write the Harness storage root.

### Canonical Team domain

Target ownership is official `ctx.agentTeams` when a supported published API is available, or one compatibility adapter during migration. Current 0.1 ownership is the private `TeamDomain`; the adapter described below is not yet wired:

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

Target rc.8 publishes `ctx.tokenMeter`. Its replay-aware Session projection measures current request/context usage; it is not by itself a cumulative Team budget ledger. The 0.1 implementation independently consumes committed `assistant/message.usage` Session events and persists a per-session sequence cursor. A future accounting adapter should consume the official projection where its semantics match, while preserving one cumulative Team ledger and avoiding double counting.

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

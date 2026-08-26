# 11. Official-first plugin development constitution

Status: mandatory. Effective: 2026-08-20.

## 1. Fixed rule

Every design, feature, refactor, fix and milestone starts by checking the accepted official DSH capability classification relevant to its change. A fresh remote/evidence scan is trigger-based, not a ritual for every edit. This project integrates through pure plugins and must not conflict with, shadow, fork or independently reimplement an official capability.

“Official-first” does not mean importing every official package. It means that official stable Service Definitions own their domains; this project contributes Providers, Consumers, policy overlays and Bundle composition. An official experimental/private package is a semantic compatibility target but is not a production dependency until officially promoted. A genuinely absent capability may receive a generic project seam only after the absence and ownership boundary are recorded.

The plugin checkout may be physically nested under the official checkout, but it must remain outside the official workspace globs (the current relocation target is `packages/.external/dsh-agent-swarm`) and carry its own `pnpm-workspace.yaml`. `pnpm verify:workspace` must resolve the workspace root and Vitest 3.x from the plugin itself rather than a parent installation. The plugin remains an independent Git repository, package workspace, candidate stream and release authority. The official checkout is a read-only evidence and Profile/Bundle acceptance host: no plugin task may modify its source, manifests, lockfiles or configuration. Gate A discovers that host from enclosing Git identity plus the pinned official root package, release and commit; directory names and persisted absolute paths are not evidence.

## 2. Gate A — triggered compatibility evidence

Run a fresh Gate A when the change depends on official Service/package/export/types/Profile facts; changes the official baseline, reference pins, lockfile or target Profile; contradicts a cached classification in real runtime evidence; or introduces a seam, state owner or shadowing risk. Otherwise reuse an accepted receipt whose key is the official baseline digest, both reference pins, lockfile identity and affected capability.

When triggered, no affected production code begins until all items pass:

1. Run `pnpm verify:compatibility` (`verify:gate-a` remains a compatibility alias); it proves the pinned official commit is a provable release, checks both reference pins and clean evidence checkouts, verifies required official source evidence, and validates package visibility against `OFFICIAL_BASELINE.json`. Record the release, SHA, date, receipt key and drift.
2. Read official `AGENTS.md`, `docs/architecture.md`, package rules/map, the relevant subsystem document and relevant implemented Agent Notes.
3. Inspect package manifests, publication/private status, exports, types, README and tests at that commit.
4. Inspect installed package exports and the target Profile's actual plugin tree. A published package is not automatically installed or composed.
5. Classify the capability:
   - official stable;
   - official experimental/private;
   - absent from the target;
   - project-owned orchestration overlay.
6. Re-read both pinned reference repositories for the affected behavior and failure cases.
7. Update the ownership/conflict table and identify exactly one canonical state owner and one transition owner.
8. Update `09-sources.md` and superseded factual claims in the same candidate when the classification actually changes; do not edit stable documents merely to record a routine rerun.
9. For self-hosting work, identify the stable control artifact/Profile, candidate Worktree/artifact, acceptance Profile and external promotion owner. Verify that no official service is being misdescribed as a self-updater or cwd isolation mechanism.

Gate A is not satisfied by a remote SHA alone. The cited implemented Agent Notes and package source must exist in the local evidence checkout, and the project revision being reviewed must be committed or otherwise reproducibly identified. Receipts are dynamic evidence, not rolling committed-document status.

The official baseline is release-anchored, not HEAD-anchored. `OFFICIAL_BASELINE.json` pins a release merge commit, and `verify:official` must prove that pin is an official release — the release tag landed on the pin or demonstrably contains it (`git merge-base --is-ancestor`) — before any snapshot check counts. Official `master` advancing past the pin between releases is expected, keeps Gate A green, and is reported as a note only; it is not by itself a drift finding.

A re-pin becomes due exactly when the official project publishes a newer release. Review the full diff from the pinned release to the new one before adopting it, then update `OFFICIAL_BASELINE.json` together with only the affected architecture/milestone authorities. `verify:official` surfaces a due re-pin as a warning, not a failure, so an unrelated open pipeline is not broken by upstream movement; the re-pin lands as its own reviewed change. Reference drift likewise blocks only the affected compatibility/re-pin pipeline until its pin is deliberately reviewed.

Gate A is red only when the pin stops being a provable release: no release tag contains the pin and the pin is neither the remote tip nor a verified ancestor of it; the pinned release was superseded without its tag ever landing; or the pinning evidence itself (checkout at the pin, Agent Notes, package visibility) no longer holds. The expected CI red windows are therefore evidence failures and transient network failures — never mere master movement. During the official npm-published/tag-pending window Gate A stays green on the fallback anchor (the pin is the remote tip, or a verified ancestor of it) with an explicit warning, and upgrades to the tag anchor once the tag lands. If network access is unavailable, record the verification limitation and do not call a cached pin “current.”

## 3. Official direction at the verified rc.8 baseline

The current official repository establishes these implemented directions:

- everything, including Agent Loop, is a replaceable plugin; new product behavior belongs beside the loop, not inside it;
- capabilities evolve as Service Definition / Provider / Consumer packages with explicit Bundle/Profile composition;
- model-visible behavior is durable and replayable through Session/inbox semantics;
- long-running orchestration uses published Workflow and Jobs seams, with durable run disclosure and cancellation/observation;
- token measurement is a replay-aware official projection; policy consumers must define their own cumulative boundary without duplicating accounting;
- Workspace is an official identity/membership domain, while execution cwd and sandbox/tool roots remain real capability boundaries;
- Agent Teams incubates as private experimental packages, split into domain and tool Consumer, with strict durability, recovery, lifecycle and test requirements;
- experimental placement relaxes publication/compatibility expectations, not security, lifecycle, documentation or real-composition requirements;
- abstractions require a current owner and current consumer; speculative compatibility layers are prohibited.

These are implemented-source facts, not a prediction of an unpublished roadmap. Future direction must be re-derived from the then-current official repository.

## 4. Capability ownership map for this plugin

| Capability | Canonical official owner | Project integration role |
|---|---|---|
| Agent execution and lifecycle | `ctx.agents` / Agent Loop plugins | observer/Consumer only; never patch loop |
| continuable members | `ctx.subagents` | Team member Provider adapter |
| durable Session facts | Session + Session persistence | required `sessionPersistence` injection since M1A; append/model messages through official paths |
| deterministic workflow | `ctx.workflowEngine` | Team workflow bridge Consumer |
| background run control | `ctx.jobs` | publish/cancel/wait long Team runs |
| token/context measurement | `ctx.tokenMeter` | M4-1 (issue #127) boundary: `measure()` and the `tokenUsage` projection are host-side official faces, characterized and registered (`docs/09` §1); the Team budget keeps its own per-seq-cursor fold as the single measurement path, the official faces are not consumed by the budget, and parity plus the declared divergence are test-pinned; an official adapter re-opens only when the official face exposes per-event usage attribution |
| application storage lifecycle | `ctx.storageDomain` | consumed since M1A: `StorageDomainTeamStore` opens the `agent_swarm` domain as the Team aggregate authority; distributed backends add domain CAS/leases later |
| Workspace identity/membership | `ctx.workspaceRegistry` | Workspace linkage; not Worktree/cwd isolation |
| credential references/secrets | `ctx.credentials` (`@deepseek-ai/dsh-credentials`, rc.2) | boundary, not consumed (M5-2/#136): no plugin-side secret consumer exists, Team state never carries values or refs, env injection stays deployment-owned |
| member host-tool scoping | `ctx.subagents` creation-window `toolFilter` + `tools.restrict()` | consumed since M1A (static captain-only deny); M5-2/F17 adds the captain-declared deny-only narrowing overlay (`deny_tools`) on the same official seam |
| human interaction | questions/approval services | human workflow/review Providers |
| Team roster/mailbox/task DAG | private experimental `ctx.agentTeams` | semantic target; current private backend behind one `TeamDomainPort` until promotion |
| attempt fencing, scheduling, review, Team budget/memory policy | this plugin family | project-owned overlay, implemented as replaceable plugins |

## 5. Reference fusion rule

The reference repositories are not runtime foundations.

From `dsh-agent-teams`, retain characterized Team protocol behavior: real status-driven scheduling, DAG readiness, revision/attempt fencing, provider/model snapshots, durable mailbox recovery, safe removal/archive and lifecycle/stress cases. Map execution and durability back to official Agent/Subagent/Session services. UI/HTTP/command surfaces become separate Consumers.

From JiuwenSwarm, retain product contracts: deterministic workflows, budgets, real Worktree isolation, human nodes, distributed reservation/ACK, personal/shared Team memory, tiered permission policy, Skill Evolution and monitoring. Map them respectively to official Workflow/Jobs, Token Meter, Workspace plus remote execution, interaction, storage, skills and UI seams. Do not embed its Python Runtime, Rails, ZMQ transport, database schema or permission engine.

A reference feature is “fused” only when all are true:

1. its behavior and failure cases have tests;
2. its official DSH owner is identified;
3. the project contributes through a Provider/Consumer/overlay without duplicate authority;
4. lifecycle, security, persistence, replay and limits are verified;
5. the assembled Profile passes real-composition verification;
6. documentation marks it implemented rather than target/partial.

## 6. Forbidden designs

- editing Agent Loop for Team-specific scheduling, memory, review or workspace behavior;
- registering a shadow `ctx.agentTeams`, `ctx.workflowEngine`, `ctx.jobs`, `ctx.tokenMeter`, `ctx.storageDomain` or `ctx.workspaceRegistry`;
- keeping private Team state and official Team state both writable;
- letting adaptive Scheduler and Workflow both own one attempt;
- counting the same usage through Session folding and Token Meter twice;
- claiming Worktree isolation when only a prompt/path field changed;
- treating tool descriptions, `writeScopes` or model role as authorization;
- copying Jiuwen's runtime/transport when an official DSH seam exists;
- marking a roadmap item complete from a diagram, interface or test name without current runtime evidence.
- loading mutable candidate output into the stable control Profile, letting a candidate promote itself, or using the candidate runtime as its own rollback controller;
- allowing parallel repository coding writers outside the project-owned open/status/close/reconcile ledger, above its accepted capacity, or before the affected candidate has independent executable review and serial target read-back.

## 7. Triggered compatibility record

When Gate A is triggered, record only the decision-bearing delta in the existing Feature Pipeline receipt or required architecture/contract document. Do not create a second milestone document or Agent Note for an ordinary direct-approved slice. Reuse unchanged accepted identities and omit fields that do not change the decision. The available field menu is:

```text
Official remote SHA/date:
Relevant implemented Agent Notes/packages:
Installed/Profile capability evidence:
Stable / experimental / absent / overlay classification:
Reference behaviors and failure cases selected:
Canonical state owner:
Transition owner and conflict prevention:
Plugin shape (definition/provider/consumer/bundle):
Lifecycle/persistence/security limits:
Migration/rollback:
Unit/conformance/fault/real-composition gates:
Docs/Skill files updated:
```

## 8. Gate B — implementation acceptance

A change cannot enter a milestone as complete until:

- no official service is shadowed and no second canonical state exists;
- required services are declared through injection and missing capabilities fail loudly;
- every effect/resource has bounded disposal;
- model-visible inputs/results are durable or reconstructable;
- security authority derives from Agent/Session/permission/workspace capabilities, never prompt text;
- reference failure cases are covered proportionally to the feature;
- real Loader/Profile composition proves actual services, not only mocks;
- `rg` finds no superseded official-fact claim;
- every affected registered authority remains synchronized; unrelated README, roadmap, ADR or Skill files are not touched merely to satisfy a checklist;

Self-hosting acceptance additionally requires ADR-0008: last-known-good control and candidate acceptance Profiles are separate; candidate evidence is frozen; promotion is externally owned and reversible; real Worker cwd/tool roots and control-root denial are tested. M1D permits D1 single-writer dogfood only. Parallel D2 operation requires the M2 and M3 exits.

Security/architecture milestones also require the risk-scaled independent review selected by `$manage-agile-software-development` and `docs/governance/project-binding.yaml`. Reviewer scope and access remain bounded by the user-authorized work package; the Feature Pipeline lead binds the verdict to the candidate and the integration authority verifies that identity without repeating the specialist review.

## 9. Gate C — official update response

When official DSH changes:

1. freeze feature expansion for the affected capability;
2. diff manifests, exports, types, Agent Notes, tests and Bundle composition;
3. classify compatibility impact;
4. prefer deleting project duplication and moving to the official seam;
5. provide state migration when canonical ownership changes;
6. rerun conformance, fault and real-composition tests;
7. update every factual and normative document in one reviewable change.

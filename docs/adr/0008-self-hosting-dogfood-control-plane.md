# ADR-0008: Self-hosting uses a stable control Profile and isolated candidates

- Status: Accepted
- Date: 2026-08-20
- Evidence: Gate A PASS at official DSH `141eb6fef83422698aef7a981029e843e8161534`; `dsh-agent-teams` `801954dd7be67213cf4adc1aeb6f97bd3daa12cc`; JiuwenSwarm `152583aa305836e87481e6de8a5f34e8c7d0928b`
- Depends on: ADR-0007 and complete M1 acceptance

## Context

The project is intended to become capable of using DSH RPC and its own Team tools to improve the plugin. Loading the plugin and creating several Agents is not a sufficient self-hosting boundary. The current 0.1 implementation lacks crash-safe mailbox reconciliation, bounded lifecycle, real Worktree execution, independent executable verification and safe candidate promotion. If a running plugin overwrites or reloads itself in place, one defective change can destroy the Team, the RPC control path and the rollback mechanism together.

Official rc.8 already supplies the correct general seams: Sessions/persistence, Agents/Subagents, Workflow, Jobs, Storage Domain, Workspace identity, tools and interaction. It does not supply a Team-specific self-updater or a continuable-child cwd override. Self-hosting therefore remains a project-owned composition and policy overlay built from official services. It must not patch Agent Loop or treat `ctx.workspaceRegistry` as execution isolation.

## Decision

1. Self-hosting is enabled by explicit readiness gates, not by a feature flag or a model claim.
2. M1D is the first dogfood boundary. It permits an isolated Profile, one coding writer at a time, read-only research/review members and manual promotion. It does not permit parallel writers or automatic self-upgrade.
3. M2 integrates official Workflow/Jobs for durable orchestration, observation, cancellation and completion disclosure.
4. A new M3 self-hosting safety vertical composes the minimum executable verification, permission and real Worktree/remote-member capabilities required for supervised parallel self-development. Later verification and Workspace milestones broaden and harden those Providers; M3 does not mark their full product families complete.
5. The stable control Profile runs a last-known-good plugin artifact. Workers modify only per-attempt Worktrees. A frozen candidate artifact is loaded into a separate acceptance Profile and RPC endpoint. The running control Profile is never overwritten, linked to a mutable output directory or hot-reloaded to test its own candidate.
6. Candidate promotion is a state machine owned outside the candidate runtime: `built -> frozen -> verified -> accepted -> promoted` or `rejected`. A failure preserves the stable artifact and turns the evidence into a new Team task.
7. Canonical Team/task/attempt state remains owned by `TeamDomainPort`. Workflow/Jobs, Git branches, logs, UI and acceptance reports are linked projections or evidence; none becomes a second writable Team authority.
8. The project manager observes durable state, Job/run ids, leases, verification evidence, health checks and final reports. It does not poll private reasoning. It commissions corrective tasks through the Lead and intervenes only at stage boundaries, genuine blockers, destructive/out-of-scope behavior or control-plane loss.
9. Model usage has no project-manager cost or convergence ceiling unless the user sets one. Operational controls such as command timeout, concurrency, retry-loop detection, disk retention, cancellation and rollback remain mandatory fault containment rather than cost controls.
10. Automatic memory extraction and Skill Evolution are enabled only after accepted evidence, provenance, deterministic validation and approval separation exist. A Worker or candidate cannot silently rewrite the governance Skill that authorizes its own promotion.

## Readiness levels

| Level | Required milestone | Allowed operation |
|---|---|---|
| D0 Profile smoke | M1D | install/link in an isolated check Profile; RPC/tool/reload/recovery tests only |
| D1 supervised dogfood | M1D | Lead plus read-only reviewers; one coding writer; manual merge and promotion |
| D2 parallel self-development | M2 and M3 | isolated Worktrees/out-of-process Sessions, executable review, frozen candidate acceptance and rollback |
| D3 learning self-improvement | M7 | accepted-evidence Team memory and approval-separated Skill Evolution |
| D4 unattended/distributed | M8 and M9 | atomic distributed ownership, full observability, release and rollback operations |

## Security boundary

The stable control runtime, its storage root, credentials, reference checkouts, official DSH checkout and promotion metadata are outside Worker write roots. Full model/runtime permission is not an authorization to cross those roots. The acceptance Profile receives only the candidate artifact and dedicated temporary state. A candidate cannot declare itself accepted or mutate the stable artifact pointer.

## Consequences

The project can dogfood after M1 without pretending parallel coding is already safe. The roadmap gains M3 and later milestones are renumbered. Initial self-hosting requires more composition work but produces direct evidence of mailbox, lifecycle, scheduling, Worktree, review and reload defects. Rollout remains reversible because a last-known-good control Profile survives every candidate failure.


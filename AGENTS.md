# AGENTS.md

This repository is an official-first DeepSeek Harness plugin project. The following compatibility gate is mandatory before changing code, architecture, milestones, or API claims:

1. Fetch/query the official `deepseek-ai/deepseek-harness` remote and record the current target commit.
2. Read the official root/package rules, architecture, package map, relevant subsystem docs and implemented Agent Notes.
3. Inspect the relevant official package manifests, exports, types, tests and the actually installed/Profile-composed services.
4. Classify each needed capability as official stable, official experimental/private, absent, or project-owned overlay.
5. Map both reference repositories' desired behavior onto those official seams and write/update the conflict-and-ownership table.
6. Reuse official Service Definitions as Consumers/Providers. If a needed seam is absent, add a generic plugin seam or an upstream proposal; never create a parallel implementation merely because the official service was not checked.

Run `pnpm verify:gate-a` for this evidence gate. A matching SHA is insufficient when cited Agent Notes/package sources are absent from the local checkout or either reference remote has moved.

No implementation phase may start until the Gate A record in `docs/11-official-first-development.md` is complete, its evidence is recorded in `docs/09-sources.md`, the architecture/milestone documents are reconciled, and the change has a single authoritative owner for every state transition.

Repository work rules:

1. Read `.agents/skills/dsh-plugin-development/SKILL.md` and only the referenced companion files needed for the task.
2. Read `docs/00-vision.md`, `docs/03-capability-family.md`, and the relevant ADRs.
3. Treat `ref/` as read-only evidence; refresh it only through the supplied sync scripts and update source pins together.
4. Verify APIs against the target installed `@deepseek-ai/*` packages and the official DSH checkout. Secondary docs are not proof of a published API.
5. Add behavior through plugins, services, providers, consumers, tools, events, storage forms, or Bundle composition. Do not patch Agent Loop for Team-specific behavior.
6. Every registration must have lifecycle ownership and a disposer. Publish state only after its authoritative commit.
7. Anything model-visible must be reconstructable from the Session log.
8. Do not register a conflicting `ctx.agentTeams`; the official experimental seam is the compatibility target.
9. Keep scheduler, workflow bridge, workspace, budget, review, memory, remote member, and UI concerns in replaceable plugins. Official stable services remain canonical; this project contributes Providers, Consumers, policy overlays and Bundle composition.
10. Run `node scripts/verify-project.mjs` and the checks appropriate to the changed surface. Report commands actually run.
11. Treat `ref/dsh-agent-teams` and `ref/jiuwenswarm` as behavior/failure-case sources only. Never import their runtime architecture when DSH already owns the capability.
12. Update README, affected design docs, ADRs, source register, fusion audit, roadmap and Skill in the same change whenever official facts or integration ownership changes.
13. Self-hosting follows `docs/adr/0008-self-hosting-dogfood-control-plane.md`: M1D permits only isolated single-writer dogfood; parallel coding requires M2/M3, real per-attempt execution roots, independent executable review and a separate candidate acceptance Profile.
14. Never overwrite or mutable-link the running stable Profile to candidate output. Stable control, candidate Worktrees/artifacts, acceptance Profile/state/RPC and external promotion/rollback are separate authorities.
15. Model usage is not bounded to save cost or force convergence unless the user requests it. Concurrency, command timeout, retry-loop detection, retention, cancellation and rollback remain mandatory fault containment.

Independent review governance:

1. A user-authorized security/architecture reviewer is autonomous: do not impose time, step, token, round or cost limits unless the user did.
2. The project manager supplies scope/evidence, removes genuine blockers, receives reports and verifies findings. Do not steer toward early convergence, cancel a healthy long review, rewrite conclusions or substitute the manager's review for the independent reviewer.
3. When full access is explicitly authorized, pin `danger-full-access` plus `approval=never` on the review Session and verify the durable permission events. Restore any temporarily changed future-session default immediately.
4. Full runtime permission does not broaden the reviewer's mutation scope: tests and diagnostics may run, but existing source/docs remain read-only unless the task explicitly authorizes fixes. The review report is the allowed review artifact.
5. Intervene only for explicit user override, destructive/out-of-scope activity, a real external blocker, lost/compromised runtime, or a request for project-manager input.
6. Follow `docs/12-independent-review-management.md` for review commissioning, monitoring, report intake, remediation and re-review.

Self-hosting development governance:

1. The Lead/Workers own technical execution inside a commissioned milestone. The manager observes committed Team/Job/lease/verification state and receives stage or genuine-blocker reports; do not poll private reasoning or inject urgency.
2. The implementing Team and independent Reviewer are separate roles/Sessions. A candidate report is evidence, never its own acceptance verdict.
3. The manager may commission corrective tasks from observed failures but does not directly edit canonical Team state, rewrite verdicts or let a candidate promote itself.

The current root package is a host-only, process-local 0.1 Team implementation, not merely a scaffold. Describe only behavior verified by `src/` and tests; keep target capabilities and known gaps explicitly separate, using `docs/10-fusion-audit.md` as the current status baseline.

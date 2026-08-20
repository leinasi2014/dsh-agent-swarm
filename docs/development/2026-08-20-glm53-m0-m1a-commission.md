# GLM-5.3 development commission: M0 baseline and M1A

- Commissioned: 2026-08-20
- Implementer: GLM-5.3 through the Infinite Canvas DSH RPC host
- Repository: `D:\Source\DSH\plugin\dsh-agent-swarm`
- Branch at commission: `codex/glm-review-fixes`
- Authority: full project read/write/build/test/Git access; no imposed time, turn, token or cost limit
- Stop boundary: finish M0 and M1A, report, and do not begin M1B

## Management contract

The implementer owns the technical work and may inspect, edit, test, build and commit without project-manager approval. The project manager receives stage completion or genuine blocker reports and does not poll private reasoning, prescribe implementation micro-steps or force early convergence.

A genuine blocker means an unavailable required external capability, irreconcilable official contract, unrecoverable repository condition or a choice that would expand scope beyond this commission. Difficulty, long runtime, failing tests or the need to investigate are not blockers. Resolve those autonomously.

The implementer must not:

- force-push, destructively reset, or delete user data;
- modify either reference checkout or the official DSH evidence checkout;
- edit or replace `docs/reviews/2026-08-20-glm53-full-security-review.md`;
- patch the official Agent Loop, invent a shadow official service, create dual canonical state, or silently fall back to workspace state;
- begin M1B, M1C or later milestone implementation.

## Mandatory reading and evidence gate

Before implementation, read and apply:

1. `AGENTS.md` and `CLAUDE.md`;
2. `.agents/skills/dsh-plugin-development/SKILL.md` and all references it routes to for this work;
3. `docs/11-official-first-development.md`;
4. `docs/adr/0007-m1-storage-authority-and-remediation-order.md`;
5. `docs/07-implementation-roadmap.md`;
6. `docs/08-testing-verification.md`;
7. `docs/10-fusion-audit.md`;
8. the immutable GLM-5.3 security review and its manager intake under `docs/reviews/`;
9. the pinned official checkout at `D:\Source\DSH\framework\deepseek-harness` and both read-only checkouts under `ref/`.

Run `pnpm verify:gate-a` before writing production code. If a pinned remote moved or material official behavior differs, update the factual baseline, affected design documents and this milestone decision before implementation. Official implemented code, exported contracts, tests and Agent Notes outrank community assumptions.

## Stage 0 — reproducible M0 baseline

The repository currently has no commit. Establish an audited initial baseline before M1A production changes:

- verify that generated artifacts, dependencies and nested reference repositories are correctly ignored;
- preserve all in-scope project material and immutable review evidence;
- run the existing M0 verification suite;
- create a clear baseline commit, for example `chore: establish audited M0 baseline`;
- record the exact baseline commit in the final report.

Use later logical commits for M1A. Do not squash away evidence needed to distinguish baseline from remediation.

## Stage 1 — M1A authority, port and migration

Implement ADR-0007 and close security findings F1 and F5 within M1A:

1. Define one `TeamDomainPort` consumed by tools and orchestration. It must be the sole abstraction for authoritative roster, task, mailbox and related Team aggregate state.
2. Require and inject official `sessionPersistence` and `storageDomain` services for durable Team mode. Fail closed on missing or failed composition; do not use a non-durable or workspace-JSON fallback.
3. Implement the local production Provider on official `ctx.storageDomain`, with one schema/versioned Team aggregate record per Team and explicit process-local semantics.
4. Remove `FileTeamStore` from the default runtime. It may remain only as a read-only offline migration reader and test fixture.
5. Implement explicit one-way migration: validate the legacy aggregate, require an empty destination, durably write, read back and verify, write/retain a migration receipt, and leave the source read-only. Runtime dual-write and automatic migration/fallback are forbidden.
6. Update dependencies, Profile/configuration examples and packaging so the real deployment composes official Storage Domain, an appropriate KV backend and Session persistence.
7. Preserve target-Session receipt semantics: a Store acknowledgement is not proof of target receipt. Do not claim M1B de-duplication or recovery is complete.
8. Keep the private official experimental Team implementation as a semantic target only. Do not import it as a production dependency.

## Required verification

Add and run evidence proportionate to the authority change:

- `TeamDomainPort` Provider conformance tests;
- schema/version, missing service, corruption and close/lifecycle tests;
- migration success, non-empty destination, invalid source, failed durability/read-back and receipt tests;
- tests proving the default runtime never reads or writes authoritative Team state in the shared workspace;
- real rc.8 composition/reload tests with Storage Domain, a KV backend, Session persistence and this plugin where the official seams permit it;
- ordinary workspace-writer tamper-denial evidence without overstating protection against unrestricted host access;
- `pnpm verify:gate-a`, all typechecks, unit/integration tests, build, package/artifact checks and the complete `pnpm verify` gate.

If a requested test cannot truthfully be implemented in M1A, document the exact official limitation, retain a failing/characterized test where useful, and classify the remaining work in the correct later milestone. Never turn an unverified claim into documentation fact.

## Documentation and skill synchronization

Update all affected architecture, roadmap, testing, source, fusion and user-facing documents as facts change. Update the project Skill when the implementation changes the reusable development procedure. Clearly distinguish implemented behavior, accepted design and future work. Do not mark M1B or later findings closed.

## Git and completion protocol

Make reviewable logical commits after the M0 baseline. Before completion, ensure `git status` is intentional and record commit hashes. Write the stage report to:

`docs/development/2026-08-20-glm53-m1a-report.md`

The report must contain:

- completed observable behavior and explicit non-goals;
- baseline and M1A commits;
- material changed files;
- official seams used and exact authority/failure model;
- migration behavior and rollback evidence;
- commands executed with pass/fail counts and any unexecuted checks with reasons;
- known limitations and the precise M1B handoff;
- any deviations from this commission and their factual justification.

Commit the report and leave the branch in a reviewable state. Then stop and send a concise RPC completion message containing the report path and final commit. If genuinely blocked, write the same file as a structured blocker report, commit all safe evidence, and stop without broadening scope.

# Contributing

This repository uses `$manage-agile-software-development` with the project adaptation in [docs/governance/project-binding.yaml](docs/governance/project-binding.yaml). [AGENTS.md](AGENTS.md) is the thin executor entry point; it does not duplicate the universal lifecycle.

## Before implementation

- Confirm the requested outcome, affected surfaces, risk, and evidence required for completion.
- Register one compact Feature Pipeline for each independently acceptable capability. Ordinary local failures stay in its author loop; frozen-candidate or real-path failures create a linked correction generation.
- Read the relevant product/architecture authorities from [docs/governance/document-registry.yaml](docs/governance/document-registry.yaml).
- Run the cheap `pnpm verify:isolation:status` before opening a write lane, freezing a candidate, and integrating. Run `pnpm verify:policy` only when governance, instructions, or document authority changes; the full `pnpm verify:isolation` only when isolation policy/layout changes; and `pnpm verify:compatibility` only when official/reference facts are decision-bearing. Reuse unchanged receipts otherwise.
- Treat `ref/` as read-only evidence.

## Isolation and ownership

The accepted backend is currently `single-checkout`, with one writer for repository mutations. Parallel write packages are `NOT_CONFIGURED`. Do not call raw worktree lifecycle commands or create an unmanaged workspace. A future worktree backend requires project-owned open/status/close/reconcile entry points, negative tests, a binding generation change, and independent acceptance.

Independent read-only investigation may run concurrently. Shared contracts, governance, document registry, integration, promotion, and destructive cleanup each have one writer.

The project direction owner intervenes only when outcome, official boundary, architecture, shared contract, authority, or contradictory real evidence changes. Normal implementation, QA pass, bounded repair, and candidate freeze remain with the Feature Pipeline lead.

## Candidate and review

- Use a focused branch and conventional commit subject (`feat|fix|docs|chore|refactor|test(scope): summary`).
- Freeze the exact Git commit before acceptance and report base, candidate, effective change, checks, limits, and documentation impact.
- LOW changes normally use author proof. MEDIUM changes require one non-author review. HIGH changes use the bounded specialist review named by the binding.
- Reuse acceptance for an unchanged candidate/risk/policy key. Corrections create a new candidate and invalidate only affected acceptance.
- Integrate serially against an expected `main` identity and read back the resulting commit. Push, mirror, release, and cleanup are separate operations requiring their own authority.

## Checks

Use the smallest affected checks during implementation, then run the engineering candidate gate once when freezing an integration candidate:

```text
pnpm test -- <affected-test>
pnpm verify:candidate
```

`pnpm verify:candidate` covers structure, lint, duplication, dead exports, type checks, tests, scenario checks, build, and package-artifact validation; `pnpm verify` remains its compatibility alias. Policy, full isolation, compatibility, coverage, and promotion drills are separate claim-triggered gates. The cheap isolation-status check protects the current single-checkout at write/freeze/integration boundaries.

## Documentation

- Stable project facts and authority live in the binding and document registry; current work does not.
- Update affected architecture, contract, public behavior, commands, security, or recovery guidance in the same candidate.
- Historical ADR and evidence records remain immutable. New disposition or remediation is a separate record.
- `docs/GOALS.md` is a stable product charter, not a task board. The worktree cleanup ledger remains immutable recovery evidence until its branch/SHA identities can be migrated without loss.

## Completion

A change is complete only when the candidate is immutable, required checks and review are bound to it, expected-target integration is read back, and unique recovery state is preserved. Never infer completion from an agent message, a clean directory, a merged review, or a process exit alone.

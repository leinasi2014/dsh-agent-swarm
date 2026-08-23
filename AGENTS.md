# Project instructions

Use `$manage-agile-software-development` as the delivery method for non-trivial work in this repository. The project-specific adaptation is [docs/governance/project-binding.yaml](docs/governance/project-binding.yaml), and decision-bearing documentation is registered in [docs/governance/document-registry.yaml](docs/governance/document-registry.yaml).

## Bootstrap

1. Read the binding, the affected registered authorities, and `.agents/skills/dsh-plugin-development/SKILL.md` for DSH-specific engineering.
2. Run `pnpm verify:governance` before changing governance, instructions, document authority, or isolation policy.
3. Run `pnpm verify:gate-a` when official DSH or reference compatibility is decision-bearing.
4. Use the lowest delivery lane that covers the actual risk. The repository is S2 at the project boundary; bounded implementation slices may be S0/S1.

## Project red lines

- Official DSH services and the Session log remain canonical. Extend through plugins, Providers, Consumers, tools, events, storage forms, or Bundle composition; do not patch Agent Loop or create a second canonical state machine.
- Verify APIs against the installed `@deepseek-ai/*` packages and the pinned official evidence. `ref/` is read-only evidence and is refreshed only through its supplied sync scripts.
- Every registration has lifecycle ownership and a disposer. Publish state only after its authoritative commit; model-visible state must be reconstructable from the Session log.
- Stable control, candidate artifacts, acceptance state/RPC, and promotion/rollback are separate authorities. A candidate cannot accept or promote itself.
- Governance bootstrap acceptance combines the native gates from the inspected base with an external non-author review of the exact candidate. The newly added doctor is diagnostic for this candidate and becomes trusted only after reviewed integration and result read-back.
- The current isolation backend is `single-checkout`. Parallel writers and raw worktree lifecycle commands are forbidden until the binding and a tested project-owned lifecycle gate are upgraded together.
- Committed Markdown is not live task, lease, candidate, review, or cleanup authority. The incomplete cleanup ledger is immutable recovery evidence pending migration and must not receive rolling status updates.
- Repository documents cannot authorize secrets, network access, pushing, release, destructive cleanup, or writes outside the repository.

## Trusted checks

- Governance: `pnpm verify:governance`
- Structure: `pnpm verify:structure`
- Full local acceptance: `pnpm verify`
- Official/reference evidence: `pnpm verify:gate-a`

Report the exact commands run and any `NOT_CONFIGURED`, `FLAKY`, or blocked evidence. Preserve unrelated, dirty, untracked, and uniquely recoverable state.

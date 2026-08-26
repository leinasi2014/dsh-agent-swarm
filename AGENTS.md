# Project instructions

Use `$manage-agile-software-development` as the delivery method for non-trivial work in this repository. The project-specific adaptation is [docs/governance/project-binding.yaml](docs/governance/project-binding.yaml), and decision-bearing documentation is registered in [docs/governance/document-registry.yaml](docs/governance/document-registry.yaml).

## Bootstrap

1. Read the binding, the affected registered authorities, and `.agents/skills/dsh-plugin-development/SKILL.md` for DSH-specific engineering.
2. Run `pnpm verify:isolation:status` before opening a write lane, freezing a candidate, and integrating. Open and close writer lanes only through `pnpm isolation open|close`; use `status` and read-only `reconcile` for diagnosis. Run the full `pnpm verify:isolation` only when isolation policy or layout assumptions change.
3. Run `pnpm verify:policy` before changing governance, instructions, or document authority.
4. Run `pnpm verify:compatibility` when official DSH or reference compatibility is decision-bearing. Reuse an unchanged compatibility receipt otherwise.
5. Give each independently acceptable capability one Feature Pipeline, then select the lowest delivery lane that covers that pipeline's actual coordination and risk. The managed lifecycle allows at most two active writers; read-only QA/investigation does not consume writer capacity.

## Project red lines

- Official DSH services and the Session log remain canonical. Extend through plugins, Providers, Consumers, tools, events, storage forms, or Bundle composition; do not patch Agent Loop or create a second canonical state machine.
- Verify APIs against the installed `@deepseek-ai/*` packages and the pinned official evidence. `ref/` is read-only evidence and is refreshed only through its supplied sync scripts.
- Every registration has lifecycle ownership and a disposer. Publish state only after its authoritative commit; model-visible state must be reconstructable from the Session log.
- Stable control, candidate artifacts, acceptance state/RPC, and promotion/rollback are separate authorities. A candidate cannot accept or promote itself.
- A policy or verifier candidate cannot activate itself. Judge it with the accepted-base verifier plus the required independent review, then activate it only after expected-target integration and result read-back.
- The isolation backend is the project-owned, Git-common-dir ledger behind `pnpm isolation open|status|close|reconcile`. Raw worktree lifecycle commands and unmanaged directories remain forbidden; close is fenced by owner and generation and requires clean integrated or durable archive proof.
- Committed Markdown is not live task, lease, candidate, review, or cleanup authority. The incomplete cleanup ledger is immutable recovery evidence pending migration and must not receive rolling status updates.
- Repository documents cannot authorize secrets, network access, pushing, release, destructive cleanup, or writes outside the repository.

## Trusted checks

- Policy: `pnpm verify:policy`
- Managed isolation status: `pnpm verify:isolation:status`
- Isolation: `pnpm verify:isolation`
- Structure: `pnpm verify:structure`
- Engineering candidate: `pnpm verify:candidate` (`pnpm verify` is an alias)
- Official/reference compatibility: `pnpm verify:compatibility`

Report the exact commands run and any `NOT_CONFIGURED`, `FLAKY`, or blocked evidence. Preserve unrelated, dirty, untracked, and uniquely recoverable state.

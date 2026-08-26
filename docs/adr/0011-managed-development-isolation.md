# ADR-0011: Managed development isolation

Status: accepted after reviewed integration and target read-back

## Context

ADR-0010 recorded the earlier single-checkout constraint while project-owned allocation did not exist. Raw Git worktree commands could create paths and branches without owner, generation, outcome, or cleanup authority, so parallel writers could not close reliably.

## Decision

Repository development now uses one project-owned `open/status/close/reconcile` lifecycle:

- the dynamic authority is a versioned ledger under the Git common directory;
- the primary checkout remains branch-attached to `main`;
- at most two owner-and-generation-fenced writer allocations may be active;
- open records intent before Git mutation and activates only after identity read-back;
- close requires a clean allocation and proves integration/patch equivalence or an existing durable `refs/archive/*` ref;
- reconcile is read-only by default and mutates only deterministic recovery state;
- ambiguous, unmanaged, foreign, or drifted state freezes new allocation;
- integration remains serial and candidate acceptance remains non-author.

Raw worktree lifecycle commands and unmanaged writer directories remain forbidden. Product runtime execution roots are a separate authority and never grant repository development isolation.

## Consequences

ADR-0011 supersedes only ADR-0010's temporary single-checkout capacity statement. It does not change ADR-0010's Feature Pipeline, risk-scaled acceptance, or candidate-self-acceptance rules. Historical cleanup evidence remains immutable until its unique identities are migrated through a reviewed recovery candidate.

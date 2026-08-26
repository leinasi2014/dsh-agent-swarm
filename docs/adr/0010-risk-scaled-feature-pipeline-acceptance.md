# ADR-0010: Risk-scaled Feature Pipeline acceptance

- Status: Accepted
- Date: 2026-08-26
- Supersedes: ADR-0006 as the active review-governance authority

## Context

The project previously coupled repository-wide coordination, independent-review autonomy, separate manager intake and repeated remediation review. That protected reviewer independence but made ordinary feature delivery wait on a central queue and preserved a one-time governance-bootstrap rule as permanent policy.

The universal `$manage-agile-software-development` method now gives each independently acceptable capability one Feature Pipeline, separates coordination from consequence, and binds acceptance to an immutable candidate without manufacturing repeated approvals.

## Decision

- Select D0/S0/S1/S2/S3 and LOW/MEDIUM/HIGH per Feature Pipeline and affected surface; the repository does not impose one global lane.
- The project direction owner handles cross-pipeline outcome, official-boundary, architecture and dependency triggers. The Feature Pipeline lead owns normal implementation, QA, bounded correction and candidate flow without another manager approval.
- Start useful implementation, QA/oracle design and read-only investigation as soon as their boundaries are ready. The current `single-checkout` limits repository writers to one; it does not collapse the team into one agent.
- LOW uses author proof unless project evidence upgrades it. MEDIUM uses one non-author review of the frozen final candidate. HIGH uses one bounded specialist round for affected domains and required privilege separation.
- QA and semantic review may be combined by one qualified non-author for ordinary MEDIUM work. Corrections normally receive delta review; unchanged candidate/risk/policy identities reuse the verdict.
- A policy or verifier candidate cannot activate itself. It is judged with the accepted-base verifier plus required independent review and becomes active only after expected-target integration and result read-back.
- Reviewer independence, write separation and user-granted unrestricted diagnostic runtime remain protected. They do not imply unbounded scope, duplicated PM intake, repeated review, or authority to repair the reviewed candidate.

## Consequences

Several logical pipelines may be registered or prepared, but active writers remain bounded by isolation, QA, integration and environment capacity. Shared contracts and integration stay serial. Historical reviews and ADR-0006 remain immutable evidence; this ADR owns current acceptance routing.

The one-time adoption manifest remains historical evidence of the removed governance documents. It is not a live approval workflow.

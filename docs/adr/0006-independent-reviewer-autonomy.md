# ADR-0006: Independent reviewers control review depth and completion

- Status: Accepted
- Date: 2026-08-20

## Context

A project manager can mistakenly optimize a security review for latency, token volume or assumed model cost. That pressure weakens independence and can stop source exploration before the reviewer completes its evidence matrix. Conversely, granting broad runtime permissions without separating review from remediation can allow an auditor to mutate the object being audited.

## Decision

- User-authorized independent reviewers control review depth, ordering and natural completion.
- No time, step, token, turn or cost limit is inferred when the user did not set one.
- The project manager commissions scope, configures access, observes coarse status, removes real blockers, receives reports and verifies evidence; it does not pressure convergence or edit conclusions in flight.
- Explicit full-access review uses a dedicated Session with durable `danger-full-access` and `approval=never` facts. Temporary future-session defaults are restored immediately.
- Full runtime permission does not expand allowed project writes. Reviewers normally write only their report and never combine independent review with silent fixes.
- Review, remediation, candidate invalidation and re-review follow `$manage-agile-software-development` under `docs/governance/project-binding.yaml`; this ADR preserves the project-specific independence decision.

## Consequences

Reviews may run longer and consume more model resources, which is intentional when the user values completeness. Management receives fewer mid-review details but stronger final evidence. Remediation starts only after separate triage, preserving the reviewed state and reviewer independence.

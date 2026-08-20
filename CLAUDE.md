Read and follow `AGENTS.md` and `.agents/skills/dsh-plugin-development/SKILL.md`.

The official-first compatibility gate is mandatory: verify the current official remote, implemented Agent Notes, published exports and assembled Profile before design or code; reuse official DSH seams through pure plugins; never patch Agent Loop, shadow an official service, or create a second canonical state machine. Update the evidence, conflict matrix, architecture and milestone gates with every official change.

Independent reviewers operate under `docs/12-independent-review-management.md`: the project manager observes and receives reports, does not pressure early convergence or cancel healthy long-running review work, and grants/pins full Session permissions only when the user explicitly authorizes them.

Self-hosting follows ADR-0008 and `docs/13-self-hosting-dogfood.md`: M1D permits only isolated single-writer dogfood; parallel coding requires M2/M3, real Worktree execution roots, independent executable review, frozen candidates, a separate acceptance Profile/RPC and external promotion/rollback. Never overwrite the running stable Profile with candidate output.

# 08. Testing and verification

## 1. Test layers

| Layer | Purpose | Examples |
|---|---|---|
| Pure/unit | DAG, transition, budget arithmetic, path normalization | cycle rejection, exact token limit |
| Provider contract | every Provider obeys one Service Definition | JSON/SQLite/Redis store conformance |
| Lifecycle | admission, rollback, disposal, reload | orphan child cleanup, route removal |
| Fault matrix | concurrency/restart/late delivery | stale attempt storms, lease expiry |
| Real composition | Loader, Profile, Bundle and actual services | boot test `cordis.yml`, local link install |
| Snapshot | model-visible tool/prompt/transcript | status, claim, stale error, review rejection |
| E2E | real model/provider behavior where needed | continuable child and remote worker |
| Client | projection, dispose, navigation | panel mounts/unmounts; no duplicate polling |

## 2. Minimum gate for every package

- `pnpm verify:gate-a` completed at the start of development, with official/reference remotes, materialized evidence, clean pins and package baseline recorded or a visible network limitation;
- official stable/experimental ownership and Profile composition reviewed; no service/state-machine shadowing;
- strict typecheck;
- build from clean tree;
- package exports point to real artifacts;
- Bundle patch parses and row name resolves;
- each registration disappears on dispose;
- invalid configuration fails visibly;
- README/JSDoc updated with behavior;
- known limitations documented;
- no credentials or machine-specific absolute paths.

## 3. Team protocol matrix

Required scenarios:

1. two concurrent claims with the same task revision;
2. reassign while old member is running;
3. 50+ late updates using invalid attempt ids;
4. delivery failure after mailbox persistence;
5. crash after target inbox acceptance but before delivered ack;
6. member spawn success followed by Team-state commit failure;
7. removal while member owns open work;
8. DAG mutation creating self, duplicate, missing or cyclic dependency;
9. plugin disposal during admitted spawn/message/claim;
10. restart with open claimed/in-progress/submitted/verifying runs;
11. exact limits for bytes, tasks, members and tokens;
12. multi-byte message at byte limit;
13. review rejection and retry with fresh attempt;
14. Worktree cleanup failure;
15. remote reservation expiry and late ACK.
16. a workspace member attempts to forge captain/task/budget state and cannot reach the authoritative Storage Domain;
17. send and acknowledge more than the pending-mail quota over time without permanent mailbox exhaustion;
18. repeated reject/reassign cycles keep retained attempt history bounded while every stale attempt remains rejected;
19. task descriptions and peer messages containing instruction-like text remain delimited model data;
20. ambiguous membership, missing `depthLimit`, archived read and quiet inactive-delivery compatibility cases.
21. two coding attempts receive distinct branches, Worktrees, cwd values and filesystem/tool roots;
22. a Worker cannot write the stable artifact, control storage, credentials, official checkout or either reference checkout;
23. frozen commit/artifact evidence cannot be changed by the submitting Worker or candidate Profile;
24. command failure, Reviewer rejection and human denial prevent canonical completion and promotion;
25. stale attempt/lease, late bootstrap ACK and a competing merge cannot promote a candidate;
26. candidate Profile load, inject, port, reload, recovery or teardown failure preserves the last-known-good control Profile;
27. acceptance Profile state and RPC endpoint are isolated from the control Profile;
28. promotion and rollback record exact commits, artifact digests, Profile identity and evidence ids;
29. retry/recursion, process concurrency and artifact/diagnostic retention limits contain faults without imposing a model-cost convergence policy;
30. observed dogfood defects become fresh fenced tasks with regression evidence rather than direct canonical-state edits.

## 4. Real Profile verification

```sh
pnpm install
pnpm verify:gate-a
pnpm build
pnpm verify

dsh plugin --profile agent-swarm-check add link:/absolute/path/to/dsh-agent-swarm
dsh --profile agent-swarm-check --dump-config
dsh --profile agent-swarm-check "调用 agent_swarm_status"
```

For Web/client packages, start an isolated port and inspect browser console plus mount/dispose behavior. Do not test against the user’s normal Profile while developing.

### Self-hosting Profile verification

D0/D1 requires a dedicated check/control Profile on a last-known-good artifact and manual promotion. D2 additionally requires a separately rooted acceptance Profile and RPC endpoint. A passing unit suite or in-process Loader test cannot substitute for:

1. packing/freezing the candidate at an exact commit and digest;
2. installing it into the acceptance Profile without changing the control Profile;
3. proving actual Worktree cwd/shell/filesystem roots for every coding Session;
4. exercising RPC tools, Jobs, reload, crash recovery, rejection and rollback;
5. verifying the stable control RPC remains healthy after every candidate failure.

## 5. Windows verification

Because the target location is `D:\Source`:

- use forward slash in `link:D:/Source/...` package spec;
- test file replacement while antivirus/editor holds a target handle;
- normalize path comparison without destroying drive/UNC semantics;
- keep all docs/files UTF-8;
- avoid shell-only assumptions in npm scripts;
- verify Worktree cleanup after process termination;
- test PowerShell provider separately from Bash behavior.

## 6. Observability

Every long operation should expose:

- stable operation/run id;
- owner/team/task/member;
- phase and last transition;
- start/update timestamps from the authoritative event/store;
- budget usage;
- workspace/remote lease identity;
- diagnostic safe for display without secrets;
- cancellation/disposal result.

Logs are not the state source. UI snapshots and metrics derive from committed records/events.

## 7. Current implementation verification

The 0.1 core has two executable suites:

- `tests/team-domain.spec.ts`: 16 protocol tests covering concurrent claims, review gating, stale attempts, DAG validation, budgets, full-frame byte limits, stored-state corruption without absolute-path disclosure, assignment checkpoints, usage de-duplication, interrupted-provisioning **failure settlement** with bounded retired-slot reuse, safe removal/archive and revision waiting;
- `tests/dsh-composition.spec.ts`: 2 real-composition tests mount actual Cordis + AgentLoop + JSONL persistence + Subagent + in-process spawn rc.8 services, then verify tool registration, model-visible structured Team errors, custom and missing Scheduler/Review Providers, continuable member creation, automatic dispatch, complete billed-token accounting including cache fields, review, durable state, plugin reload, queued-mail retry, cold resume/disposal, and retained child ownership when activation commit plus immediate drain both fail.

`pnpm verify` additionally runs strict source/test typechecks, a clean build, structural checks and package-artifact import/exports checks. A real CLI Profile remains a separate deployment gate because the DSH CLI is not installed in every development shell.

These suites do **not** yet prove scenarios 5, 9, 10 or 14–20 in their full failure windows. In particular, they do not protect authoritative state from a workspace writer, simulate a process crash after target inbox acceptance but before Store acknowledgement, prove persisted-child reconciliation after a provisioning crash, inject a hung Provider during disposal, bound mailbox/attempt retention, delimit untrusted prompt data, or exercise Worktree/remote leases because those capabilities are absent. The status above must be updated whenever tests or implementation change; test names alone are not evidence of a guarantee.

## 8. Independent review gate

Security and milestone reviews follow `12-independent-review-management.md`. The reviewer receives the assembled source, official/reference evidence and permission needed to run diagnostics without a manager-imposed time/step/token limit. The report is preserved unchanged; the manager separately verifies findings, records triage and commissions regression re-review after fixes.

M3 self-hosting acceptance requires an independent regression/security review of the stable/candidate boundary, Worker permissions, frozen evidence, merge/promotion ownership and rollback. The candidate's own report is input evidence, not the verdict.

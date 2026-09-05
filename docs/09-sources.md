# 09. Source register and evidence policy

This register contains current pinned identities and durable compatibility facts only. Historical commissions, stage reports, review transcripts and superseded design notes are preserved by Git history, issues, pull requests and executable tests rather than duplicated under `docs/`.

## 1. Official DeepSeek Harness

| Field | Value |
|---|---|
| Repository | `https://github.com/deepseek-ai/deepseek-harness` |
| Branch | `master` |
| Release anchor | `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` |
| Release | `dsh@0.1.1-rc.2` |
| Machine-readable baseline | `docs/OFFICIAL_BASELINE.json` |
| Evidence checkout | repository-managed official sparse checkout |

The evidence checkout must include the official architecture/package rules, affected package manifests/exports/types/tests/README files, relevant subsystem documents and implemented Agent Notes. `pnpm verify:compatibility` verifies the recorded identity and materialized evidence when an official/reference fact is decision-bearing.

### 1.1 Published versus private capabilities

- Workflow, Jobs, Token Meter, Storage Domain, Workspace, Session persistence, User Questions/Approval, Skills, Compaction, Spill and Subagents are published capability families at the recorded release.
- `@deepseek-ai/dsh-experimental-agent-team` is private/unpublished. It is a semantic compatibility target, not a production dependency.
- Package publication, Profile assembly and integration by this plugin are three separate facts and must be stated separately.

### 1.2 Load-bearing official facts

- The Session log and Agent lifecycle are canonical; plugins extend them through public seams rather than patching Agent Loop.
- `ctx.workspaceRegistry` owns workspace identity/membership, not Worktree allocation or continuable-child cwd changes.
- `startContinuable` resolves after the initial message is durably accepted, not after the child's first turn settles.
- A continuable child's `toolFilter` is captured at creation and restored with its descriptor. Follow-up options do not carry a composition/tool-rescoping face.
- Delegated children inherit the captured sandbox override and use `approval=never`; a plugin permission overlay can narrow tools but cannot widen host authority.
- Storage Domain `put` accepts the record, while reload parses through the table value schema; undeclared object keys are stripped. Every durable aggregate-field addition must update the table schema and runtime assertion together.
- Official token-meter `measure()` reports current request/surface pressure. Its `tokenUsage` projection is a per-Session provider-usage fold with chunk-early/message-final replacement; neither face supplies Team aggregation, admission, carry or per-event attribution.
- The official Invariants registry owns package relational invariants and lifecycle checks. It is not a verification-command runner or review-result database.
- The official Jobs registry owns job admission/controllers/cancellation. The Team job face is therefore a read-only scoped projection and must not replace or shadow the default registry.
- Official Client extension points and layout leases own shell composition. Team UI is a read-only projection and must not install a private shell, transcript parser or second navigation state machine.

These facts are represented in current source and focused tests, including storage reload, token-meter parity, workflow/Jobs composition, tool permissions and real Client lifecycle coverage.

## 2. Direct Team implementation reference

| Field | Value |
|---|---|
| Repository | `https://github.com/NanmiCoder/dsh-agent-teams` |
| Branch | `main` |
| Commit | `232a338fc9a0d393f118912386f67e7f3a6c67d6` |
| Version | `0.1.15` |
| Pointer | `ref/dsh-agent-teams/SOURCE_POINTER.json` |
| Checkout | `ref/dsh-agent-teams/source/` |

Use it for continuable-member lifecycle, roster identity, DAG/claim rules, revision and attempt fencing, durable-before-live mailbox behavior, automatic scheduling, activity presentation and crash/fault cases. Do not treat its package boundaries, file store, UI state or policy coupling as framework truth.

## 3. Product architecture reference

| Field | Value |
|---|---|
| Repository | `https://github.com/openJiuwen-ai/jiuwenswarm` |
| Branch | `develop` |
| Commit | `e8aa1b433e8b5ff1875cdd4cfd63155ad2a2a862` |
| Observed package | `workswarm 0.2.5.beta1` |
| Pointer | `ref/jiuwenswarm/SOURCE_POINTER.json` |
| Checkout | `ref/jiuwenswarm/source/` |

Use it for product concepts and failure models around SwarmFlow, Worktree, memory, Skill Evolution, permissions, distributed reservation and Team reliability. Do not import Jiuwen runtime types, persistence, transport or UI as DSH contracts.

## 4. Evidence order

When a contract is uncertain:

1. inspect current project code and the target Profile;
2. inspect installed package manifests, exports, types and README files;
3. inspect official DSH evidence at the recorded release anchor;
4. inspect official subsystem docs, examples and tests;
5. inspect the direct Team reference for behavior/fault precedent;
6. inspect JiuwenSwarm for product concepts/failure cases;
7. choose the smallest fail-loud behavior if evidence is still incomplete.

Community documentation may explain concepts but cannot prove a package or method exists. The target installation's exports and the release-anchored official evidence are the execution boundary.

## 5. Freshness and re-pin policy

Before changing a claim about an official or reference API:

1. record the old and proposed commit;
2. query the relevant remote when network access is available;
3. inspect the cumulative diff, affected manifests/exports/types/tests and license;
4. update the supplied pointer and checkout only through its sync process;
5. update only the affected registered authorities and tests;
6. search the repository for the superseded claim;
7. run `pnpm verify:compatibility` when the changed fact is decision-bearing.

Official `master` advancing beyond the release anchor is not by itself drift. A newer published release makes a baseline review due. A remote-network failure is reported as a limitation of that compatibility pipeline and does not authorize pretending cached evidence is current.

## 6. Self-development evidence boundary

The self-development composition is project-owned, not an official DSH feature. It derives from official Profiles, Sessions, Subagents, Workflow, Jobs, Storage Domain, Workspace and interaction seams plus the two reference projects' behavior/failure evidence.

- stable control and last-known-good artifact remain outside candidate write roots;
- managed worktrees provide repository writer ownership;
- candidate commit/package identity is frozen before review;
- acceptance runs in a separate Profile and state root;
- promotion/rollback authority is outside the candidate runtime;
- accepted GitHub `main` is the development/integration authority; `origin` is a local backup updated only after authoritative read-back.

Past verification results remain discoverable through Git history, GitHub issues/pull requests and the focused test suite. They are not recreated as rolling Markdown evidence.

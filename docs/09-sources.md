# 09. Source register and evidence policy

This register contains current pinned identities and durable compatibility facts only. Historical commissions, stage reports, review transcripts and superseded design notes are preserved by Git history, issues, pull requests and executable tests rather than duplicated under `docs/`.

## 1. Official DeepSeek Harness

| Field | Value |
|---|---|
| Repository | `https://github.com/deepseek-ai/deepseek-harness` |
| Branch | `master` |
| Release anchor | `b2e3b2a0125854567a4a5fcba75782e42fe84901` |
| Release | `dsh@0.1.5-alpha.2` |
| Machine-readable baseline | `docs/OFFICIAL_BASELINE.json` |
| Evidence checkout | repository-managed official sparse checkout |

The evidence checkout must include the official architecture/package rules, affected package manifests/exports/types/tests/README files, relevant subsystem documents and implemented Agent Notes. `pnpm verify:compatibility` verifies the recorded identity and materialized evidence when an official/reference fact is decision-bearing.

### 1.1 Published versus private capabilities

- Workflow, Jobs, Token Meter, Storage Domain, Workspace, Session persistence, User Questions/Approval, Skills, Compaction, Spill and Subagents are published capability families at the recorded release.
- `@deepseek-ai/dsh-experimental-agent-team` and `@deepseek-ai/dsh-experimental-tool-agent-team` are published under their experimental names at this release and carry no stability promise. Publication does not mean this plugin has adopted them: Swarm currently retains its own selected Team Provider behind `TeamDomainPort` and does not install a second Team authority.
- Package publication, Profile assembly and integration by this plugin are three separate facts and must be stated separately.

### 1.2 Load-bearing official facts

- Session V3 surface operations and source references remain in the canonical log; read-only persistence handles own their read/close lifetime. Assistant streams use an attempt identity and a revision that increases on every frame.
- The Session log and Agent lifecycle are canonical; plugins extend them through public seams rather than patching Agent Loop.
- `ctx.workspaceRegistry` owns workspace identity/membership, not Worktree allocation or continuable-child cwd changes.
- `startContinuable` resolves after the initial message is durably accepted, not after the child's first turn settles.
- A continuable child's `toolFilter` is captured at creation and restored with its descriptor. Follow-up options do not carry a composition/tool-rescoping face.
- Delegated children inherit the captured sandbox override and use `approval=never`; a plugin permission overlay can narrow tools but cannot widen host authority.
- Storage Domain `put` accepts the record, while reload parses through the table value schema; undeclared object keys are stripped. Every durable aggregate-field addition must update the table schema and runtime assertion together.
- Official token-meter `measure()` reports current request/surface pressure. Its `tokenUsage` projection is a per-Session provider-usage fold with chunk-early/message-final replacement; neither face supplies Team aggregation, admission, carry or per-event attribution.
- The official Invariants registry owns package relational invariants and lifecycle checks. It is not a verification-command runner or review-result database.
- The official Jobs registry owns job admission/controllers/cancellation. The Team job face is therefore a read-only scoped projection and must not replace or shadow the default registry.
- Official Client extension points and SidebarRight tabs own shell composition. Team UI is a read-only projection and must not install a private shell, transcript parser or second navigation state machine.
- The pinned release composes conversation under `main.conversation` and right-side panes under `rightbar.session`; SidebarRight Guide entries expose `title` without the retired `description` field. Subagent child catalogs persist through the official parent Session event. These changes require actual host composition and cold-restore checks.
- The Team lineage text display seam and Stop-only Composer correction are separately maintained Core changes, not capabilities claimed to be included in the pinned upstream release. Their source, build, installation and browser evidence must be checked as part of the composed candidate.
- Attachment admission and `readImage` are published at the pinned release. Admission can normalize image bytes, so repeating it is not a full-reference identity guarantee. File-upload receipts have receiver Agent scope and do not authorize cross-Session public image reads.
- The published `@deepseek-ai/dsh-subagent/internal` export includes `steerHostSubagentPrompt`. This internal Host adapter preserves supplied image ContentBlocks and MessageSource through the official ContinuationManager, exact-parent checks and cold lifecycle; it is not a stable public Service promise. Live and cold delivery check declared image support, while unknown capability requires a separate Host deferred policy. Version upgrades require an adapter contract check; the Team Host still owns access, integrity and lifecycle fencing.

These facts are represented in current source and focused tests, including storage reload, token-meter parity, workflow/Jobs composition, tool permissions and real Client lifecycle coverage.

## 2. Direct Team implementation reference

| Field | Value |
|---|---|
| Repository | `https://github.com/NanmiCoder/dsh-agent-teams` |
| Branch | `main` |
| Commit | `1caff61f4c0909711b515ebc56187055556186cd` |
| Version | `0.1.16-rc.1` |
| Pointer | `ref/dsh-agent-teams/SOURCE_POINTER.json` |
| Checkout | `ref/dsh-agent-teams/source/` |

Use it for continuable-member lifecycle, roster identity, DAG/claim rules, revision and attempt fencing, durable-before-live mailbox behavior, automatic scheduling, activity presentation and crash/fault cases. Do not treat its package boundaries, file store, UI state or policy coupling as framework truth.

Reference refresh notes and the labelled historical `source-snapshot/` describe their recorded cohorts. Historical host-version wording there does not override this plugin's current `OFFICIAL_BASELINE.json`, installed peer dependencies or actual Profile evidence.

## 3. Product architecture reference

| Field | Value |
|---|---|
| Repository | `https://github.com/openJiuwen-ai/jiuwenswarm` |
| Branch | `develop` |
| Commit | `c7bf529a15dfdf422b854ee03f6ef1eb80f6fe24` |
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

Its execution and promotion rules are defined once in the [project binding](governance/project-binding.yaml) and [self-hosting policy](13-self-hosting-dogfood.md). These sources do not grant candidate runtimes acceptance or promotion authority.

Past verification results remain discoverable through Git history, GitHub issues/pull requests and the focused test suite. They are not recreated as rolling Markdown evidence.

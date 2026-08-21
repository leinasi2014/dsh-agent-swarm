# 09. Source register and evidence policy

Recorded: 2026-08-22.

## 1. Primary framework sources

### DeepSeek Harness official repository

- URL: `https://github.com/deepseek-ai/deepseek-harness`
- Branch: `master`
- Commit: `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`
- Commit message: release `dsh@0.1.1-rc.2`
- Live verification: on 2026-08-22, Gate A resolved remote `HEAD` and `refs/heads/master` to this same SHA and verified the materialized official evidence at the release anchor.
- Materialized evidence: the sparse checkout now includes `.agents/notes/implemented` plus the relevant Workflow, Jobs, Token Meter, Storage, Workspace, interaction, Session, Skill, Compaction, Spill, Subagent and experimental Team source families. `OFFICIAL_BASELINE.json.evidenceFiles` and `verify-official-baseline.mjs` fail if the required Agent Notes/source evidence is no longer present.

Priority files:

- `AGENTS.md`
- `docs/architecture.md`
- `packages/AGENTS.md`
- `packages/README.md`
- `docs/subsystems/*.md`
- `packages/<group>/<package>/README.md` and exported TypeScript types
- `packages/experimental/agent-team/README.md`
- `docs/subsystems/agent-team.md`
- published service packages and exported types for `workflow`, `jobs`, `token-meter`, `storage-domain`, `workspace`, `user-questions`, `user-approval`, `skill`, `compaction` and `spill`
- relevant `.agents/notes/implemented/**` records, especially Agent Teams packaging/behavior, Workflow durable runs/status disclosure, replay token meter, Jobs seam and Workspace context

Verified target facts:

- M4-2 (issue #128) assessed the official `@deepseek-ai/dsh-invariants` registry against its installed rc.2 manifest/types and the permitted rc.8 full-source subsystem, README, tests and implemented Agent Notes. Its stable public contract registers package-owned relational runtime assertions and lifecycle-owned listeners/startup checks; it is not a command runner or verification-result registry. Verification templates and multi-root command evidence therefore remain a project-owned Review overlay, with no official invariant companion registered and no official source modified. Evidence: `docs/development/2026-08-22-m4b-verification-family.md` §1/§6;

- `@deepseek-ai/dsh-workflow`, `@deepseek-ai/dsh-jobs`, `@deepseek-ai/dsh-token-meter`, `@deepseek-ai/dsh-storage-domain` and `@deepseek-ai/dsh-workspace` are public rc.8 packages;
- `@deepseek-ai/dsh-experimental-agent-team` is `private: true` and has no publish configuration;
- official Agent Team injects Agents, Sessions, Session persistence and Subagents, and documents persisted-child-aware provisioning recovery, bounded disposal and target-session mailbox de-duplication;
- `ctx.workspaceRegistry` is a Workspace identity/membership registry, not a per-child Worktree allocator or cwd override;
- since M1A this plugin consumes the official storage family directly: `@deepseek-ai/dsh-storage` (hub), `@deepseek-ai/dsh-storage-json` (json KV backend, deployment composition), `@deepseek-ai/dsh-storage-domain` (domain form, required peer) and `@deepseek-ai/dsh-session-persistence` (service definition, required peer) — all verified at rc.8 on npm and materialized in the evidence checkout (`packages/storage/*`, `packages/session/session-persistence`);
- since M2-1 (issue #75) the plugin also consumes `@deepseek-ai/dsh-workflow` (required peer: the abstract `WorkflowEngine` Service Definition, types and `WorkflowError`/`isFatalWorkflowError`) and dev-consumes `@deepseek-ai/dsh-invariants` plus the `@deepseek-ai/dsh-workflow/invariant` companion (real-composition event-stream validation in tests) — both verified at rc.8 on npm against the evidence checkout (`packages/workflow/workflow`, `packages/runtime-diagnostics/invariants`). The official default engine `@deepseek-ai/dsh-workflow-worker-thread` is deliberately NOT a dependency: the Team bridge must compose in Profiles without it (design note §4.3);
- M2-3 (issue #77) adds no new package dependency: the mode surface is project-owned policy over seams already consumed. One additional official FACT is load-bearing and verified against the installed `@deepseek-ai/dsh-subagent` types: `startContinuable` resolves at the initial prompt's inbox acceptance (`ContinuableStart` — the durable child id plus the accepted message id), NOT at join-turn completion — this is why a workflow run needs its own idle driver for assignment delivery when the global listener defers (design note `docs/development/2026-08-21-m2c-modes-design.md` §3).
- M2-4 (issue #78) adds no new package dependency: the node mapping is a pure pattern-layer compiler over seams already consumed (`runtime.createTask`/`blockedBy`, the review Provider face, the F11/F15 discipline, the mailbox). Two already-installed `@deepseek-ai/dsh-subagent` exports are consumed as the nested bound's evidence face: `resolveChildDepth`/`SubagentDepthError` (absolute child-depth resolution, verified against the installed `lib/types/child-agent.d.ts`). Jiuwen behavior evidence rides the pinned reference checkout `ref/jiuwenswarm @ 36c7959` (`docs/zh/TUI使用SwarmFlow指南.md` operator table + `handlers/workflow_state.py` projection semantics; file:line citations in the design note `docs/development/2026-08-21-m2d-node-mapping-design.md` §1-2).
- issue #92 (usage settlement diagnosis) registers four official FACTS of the session event face, all verified line-level in the full rc.8 checkout (`packages/core/session/src/index.ts` append boundary, `packages/core/agent-loop/src/agent.ts` step driver, `packages/session/session-persistence/src/coordinator.ts` prepare/inspect/write-behind) and confirmed identical in the installed rc.8 builds: (1) `Session.append` assigns the contiguous `seq = log.length` and publishes `session/event` SYNCHRONOUSLY inside the append acceptance boundary (callbacks collected before `log.push`, invoked after; per-listener containment only catches async rejections; reentrant append rejects) — per-session firehose delivery is strictly seq-ordered in-process, so a delivery-reorder root cause for a billing gap has no reachable trigger on the official face; (2) constructor seeds never publish (`firstLiveSeq`; the `session/end-seed` marker is appended pre-attach), so replayed/resumed history reaches consumers only through refolds over `session.events` or persisted reads; (3) the persistence coordinator's `prepare`/`inspect` await `waitForRetirement` before reading, so a cold resume never seeds a log truncated under the disposed session's still-draining write-behind tail (bounded `writeBatchMaxDelayMs`, default 200ms); (4) an aborted turn still appends its `assistant/message` WITH usage (`interrupted: true`) whenever partial content was assembled, so adapter-billed usage always lands in the durable session log unless zero content existed.
- issue #114 (tamper-path settlement race diagnosis) registers one official FACT of the subagents report face, verified in the installed rc.8 build (`@deepseek-ai/dsh-subagent` `lib/index.js` `settlementSummary`, the "Background subagent … finished and will do no further work unless you send it more." line): every continuable member turn completion reports to the captain through the settlement notice's next-step delivery, which wakes the captain into one additional provider-driven LLM turn — deterministically, asynchronously to any caller that just observed the member settle. Billing consequence (decisions in `docs/04` §8k postscript): the captain's report turn bills its Session into the same Team ledger and its usage event settles only through the async accounting flush, so an immediate budget-equality read taken after any member turn completion races that fold by design; the composition's tamper assertion now waits for exact equality like its settlement checkpoint (CI probe run 32482845037: flush started 11 ms before the read, committed 6 ms after it, budget converged 58 ms later — no loss on any #92 face);
- the installed plugin dependency tree still does not install jobs/token-meter as runtime dependencies, so their published availability is not the same as current integration.
- since M2-2 (issue #76) the plugin also consumes `@deepseek-ai/dsh-jobs` (required peer: the abstract `JobRegistry` Service Definition, `JobId` and the job type face; declaration-merged `team-task` kind) and dev-consumes the `@deepseek-ai/dsh-jobs/invariant` companion over the projection in tests — verified at rc.8 on npm against the evidence checkout (`packages/jobs/jobs`, `packages/jobs/jobs-local` as the semantics reference, deliberately NOT a dependency). Two verified Cordis composition facts for that companion: a second invariants service requires `isolate('invariants')` under the bridge scope (same-store duplicate provide throws), and the companion's namespace-plugin mount leaves its declared inject unwired in this tree — the official `ctx.inject` scoped carrier works (design note §4.6);
- M3 entry gate (issue #94, verified 2026-08-22) closed the official-UI-consumer verification of the `team-task` jobs projection — the consumer face EXISTS in official rc.8, and every projected field renders losslessly. Facts, all cited against the `141eb6f` evidence checkout: the web UI consumes `ctx.jobs` through exactly one view — `@deepseek-ai/dsh-client-ui-jobs`' `JobListAction` session-header popover (`packages/client/ui-jobs/src/client/index.ts:22-39` registers the `conversation.session.header.actions` slot entry; `packages/client/ui-jobs/src/client/JobListAction.tsx:94-183` renders it; `packages/client/ui-jobs/src/invariant.ts:18-23` records that it is a read-only projection of the mirror with no runtime invariants). The host-plane carrier is the api-proxy: it reads the registry optionally (`ctx.get('jobs')`, `packages/host/apiproxy/src/api-proxy.ts:3375-3383` subscription baseline; `:3423-3440` `onJobsChanged` fan-out — an unowned-job change pushes a fresh snapshot to every subscribed session; `:433-443` `jobViews` projects `JobSnapshot`→`JobView`) and pushes whole-snapshot `session/jobs` mux frames that the client folds last-wins into `jobsBySession` (`packages/client/runtime/src/client/sessions/manager.ts:145-149`, `:705-712`). The wire view (`packages/host/apiproxy/src/api/jobs.ts:17-36`, zod schema `jobs.schema.ts:19-33`) keeps `id`/`kind`/`label`/`status`/`detail?`/`startedAt`/`finishedAt?` and deliberately drops `ownerSession`, `reported` and `outputLimitBytes`; `kind` is an open string rendered verbatim — an unrecognized kind degrades to its raw text with no fallback label, which is the documented extension path (`api/jobs.ts:20-25`; Agent Note `.agents/notes/implemented/feature/2026-08-08-web-background-job-display.md`). Counterpart record for `team-task`: `id` `team-task-N`, non-empty `kind`/`label`, `status` within the closed five-value union (the projection never emits `stopping` because `kill` refuses — subset, not mismatch), always-present `detail` clipped to 512 bytes (`src/runtime/jobs/projection-derive.ts:34`), non-negative integer timestamps — every value passes the wire schema; the UI renders kind/label/detail (`detail` replaces the generic status word once present, `JobListAction.tsx:168`), status dot + localized status word, live-ticking/frozen duration and start-order sorting, and ignores the three wire-dropped fields by design. Zero field mismatch; no missing-field degradation is ever triggered. Composition boundary (registered, deliberately not changed): the official UI carrier reads only the default-scope registry (base bundle composes `@deepseek-ai/dsh-jobs-local`, `packages/bundle/base/cordis.patch.yml:69-70`; the web-app composes `ui-jobs`, `packages/bundle/web-app/cordis.patch.yml:257-259`), while `TeamJobProjection` registers under `ctx.isolate('jobs')` (`src/index.ts:331`) — an isolated-scope registry is invisible to every sibling row outside its realm (official confirmation: `packages/bundle/web-app/cordis.patch.yml:320-331`), so a same-process official web-app job list displays no `team-task` rows: shape-compatible, scope-invisible. Making Team tasks visible in that UI is a separate composition decision (default-scope hand-off or an official multi-registry carrier), not a record-shape fix; no fix issue was opened because no mismatch exists;
- M3-1 (issue #100, verified 2026-08-21) registered the official cwd/exec seam facts the execution-root member-face injection stands on, all cited against the `141eb6f` evidence checkout: an in-process continuable child session's durable creation metadata COPIES the delegating parent's session header cwd (`packages/subagent/subagent/src/child-agent.ts:102-120`, `childSessionMeta`: `...parentHeader.cwd !== undefined ? { cwd: parentHeader.cwd } : {}`) — there is no per-child cwd at composition; neither `SubagentStartRequest` nor `ContinuableStartSpec` (`packages/subagent/subagent/src/types.ts:100-149` and `src/continuation.ts:112-130`) exposes a cwd field, so a continuable member's session cwd is the captain's workspace cwd, immutable for the session's lifetime; the official one-shot exec face resolves work relative to that session cwd but always accepts absolute input (`packages/shell/tool-bash/src/index.ts:139-156`, `resolveWorkdir`: an explicit absolute `workdir` wins, a relative one resolves against `policyWorkspaceRoot ?? canonical(headerCwd)`); and the file-sandbox `workspace-write` root derives from the same immutable header cwd (`packages/sandbox/sandbox-policy/src/index.ts:135-142`, `resolve`) — confirming ADR-0008's registered absence of a continuable-child cwd override and forbidding any per-attempt cwd enforcement through official seams. The plugin therefore injects the execution root as a model-visible declared absolute path (assignment-frame trusted header + claim-tool disclosure) consumed through the official `workdir`/absolute-path semantics; counterpart implementation: `src/runtime/execution-roots.ts`, decisions in `docs/04` §8l;
- M4-1 (issue #127, verified 2026-08-22) characterizes the official token-meter contract, cited against the `141eb6f` evidence checkout, import-verified against the installed rc.8 build at analysis time, and re-verified fold-identical at the current 0.1.1-rc.2 pin after the Gate C re-pin — the family delta is contract-shape only (`ProjectionDefinition.schema` split into `stateSchema` + `wire: { viewSchema, view }` with state types in `SessionProjectionStateMap`; chunk-early counting, message-final replacement, non-monotone corrections, `stateVersion` 1, `measure()` and the `snapshot().values.tokenUsage` wire read face unchanged; parity suite green against the installed 0.1.1-rc.2 packages): `@deepseek-ai/dsh-token-meter` default-exports the `TokenMeter` Service registering `ctx.tokenMeter` (`packages/llm/token-meter/src/index.ts`), config is an empty schema with every key rejected; `measure(session, requestHeader?)` is a PULL face returning current request/surface pressure at one consumed-log revision (`TokenMeasurement`: `logRevision`/`baseline`/signed `surfaceDeltaTokens`/`totalTokens`/`surfaceTokens`/`nodes`) — provider usage is reused only for a matching canonical envelope at least as large as the heuristic anchor, and NO cumulative total is kept (each successful call replaces the anchor; the README states occupancy figures are "a user-facing reference, not a billing record or a gating input"); when the composition provides `ctx.sessionProjections` (`packages/session/session-projection`, an optional child inject), the meter registers `tokenUsage`/`contextPressure`/`contextBreakdown` (`packages/llm/token-meter/src/usage-projection.ts`): `tokenUsage` is the per-session CUMULATIVE provider-usage fold in four disjoint buckets — a usage `assistant/chunk` counts even when the request later fails, and the final `assistant/message` usage for the same `(turn, step)` REPLACES that sample (last-wins, adjacency invariant), so totals are deliberately non-monotone under corrections (the package's own `invariant.ts` documents this); the registry owns the drive (one `session/event` subscription, per-session WeakMap watermark cells, lazy full-log fold, synchronous `snapshot`, `onChanged` feed) plus a cold-read recipe (`restore`/`restoreFloor`/`viewCheckpoint`/`checkpoint` over `(sessionId, key, ver, seq, val)` rows) whose PERSISTENCE is the separate optional `@deepseek-ai/dsh-session-projection-cache` package — neither the meter nor the registry persists anything; no face offers Team aggregation, admission, carry or per-event attribution. Selection (Option B, `docs/development/2026-08-22-m4a-tokenmeter-design.md`): the plugin's Team ledger keeps its own per-seq-cursor fold as the single measurement path; the official faces stay host-side and are NOT consumed by the budget (double counting excluded by construction), with parity proven by `tests/tokenmeter-parity.spec.ts` and the declared single divergence (chunk-only usage of failed requests bills officially, not the Team ledger); consuming the official face as measurement source is re-opened only when it exposes per-event usage attribution;
- the installed plugin dependency tree still does not install token-meter as a runtime dependency (since M4-1 it is a devDependency for the parity evidence suite only), so its published availability is not the same as runtime integration.
- M4-3 (issue #129, verified 2026-08-22) registers one official FACT of the storage-domain durable boundary, probe-proven against the installed 0.1.1-rc.2 `@deepseek-ai/dsh-storage-domain` (`lib/index.js`): `put(key, value)` stores the given record object AS-IS (no schema parse on write), but the load path (`loadAll` → `parseRecord` → `tableSpec.valueSchema.parse(raw)`) runs every stored record through the table's zod value schema, and zod object parse STRIPS undeclared keys. An additive optional aggregate field therefore survives write+read only while the record stays live in one process; any reopen silently drops it unless the durable table schema declares it. This fact produced two latent defects fixed by the same change (`src/storage/team-spec.ts` never declared the #101 `verification` task field or the #83 `replacesAttemptId` attempt field — both were stripped on every reload; probe-proven red, scenario-38 reload regression green after the fix) and is the load-bearing reason every future additive optional aggregate field must extend the zod table schema together with `assertTeamState`. M4-3 adds no new package dependency: the budget reservation/retry-economics/degraded-continuation faces are project-owned policy overlays over the seams already consumed (`docs/development/2026-08-22-m4c-budget-family.md`).

### DeepSeek Harness community documentation

- Quickstart: `https://deepseekdocs.com/docs/getting-started/quickstart`
- Plugins: `https://deepseekdocs.com/docs/user-guide/plugins`
- Plugin anatomy: `https://deepseekdocs.com/docs/learn/core/plugin-anatomy`
- First plugin: `https://deepseekdocs.com/docs/learn/dev/hello-plugin`
- Tool: `https://deepseekdocs.com/docs/learn/dev/write-tool`
- Service: `https://deepseekdocs.com/docs/learn/dev/write-service`
- Events: `https://deepseekdocs.com/docs/learn/dev/listen-events`
- Config/publish: `https://deepseekdocs.com/docs/learn/dev/config-publish`

The site currently labels rc.7 and itself states official source/release notes are authoritative. Use it for explanations and learning sequence, then verify APIs against installed/official source.

## 2. Direct implementation reference

- URL: `https://github.com/NanmiCoder/dsh-agent-teams`
- Branch: `main`
- Commit: `0c21e5d2f45ec1ea7c9ee89ffc4ee77d1cb9262e`
- Version: `0.1.9`
- Local pointer: `ref/dsh-agent-teams/SOURCE_POINTER.json`
- Full local checkout: `ref/dsh-agent-teams/source/`

Live verification on 2026-08-22 found `main` at `fe854d1` and re-pinned after a cumulative diff review (Gate C, fifth pass): three commits — V2 whale artwork asset refresh (29 binary PNG swaps plus the `ART_ALLOWLIST` rename), a client role→avatar keyword-bucket fix with four additive `verify.mjs` asset-integrity gates, and a version bump to 0.1.9. Purely decorative-plus-selfcheck: every core borrowing surface in `ref/README.md` (Bundle packaging, continuable member lifecycle, task DAG, attempt fencing, durable mailbox, event scheduling, Host/Client plugin structure) is untouched; the path-traversal guard structure of `ART_ALLOWLIST` is unchanged (exact-name `Set` membership, only its contents renamed). MIT license unchanged.

Read for implementation prior art, not framework truth.

M4-2 Gate A supersession (2026-08-22): the supplied sync script refreshed `main` to the recorded `0c21e5d` pointer and verified it as the branch tip. The older cumulative-diff paragraph above is retained as historical pin-review evidence; issue #128 uses the current checkout only as negative/behavioral evidence because it exposes repository verification practice but no verification-command runtime service.

## 3. Product architecture reference

- URL: `https://github.com/openJiuwen-ai/jiuwenswarm`
- Branch: `develop`
- Commit: `1d45d2b4a08423365eae7c37b2afdae6614a97ad`
- Develop package state observed: `workswarm` `0.2.5.beta1`
- Local pointer: `ref/jiuwenswarm/SOURCE_POINTER.json`
- Full local checkout: `ref/jiuwenswarm/source/`

Live verification on 2026-08-22 found `develop` at this commit and the pin was reviewed and updated the same day. Seven deltas from the original `bddf335` pin were each diff-reviewed before adoption: `bddf335 → 152583aa` (gateway cron scheduling and server Session metadata), `152583aa → 20097e86` (a single commit adding MCP connection-cache prewarm in `server/runtime/agent_adapter/interface_{code,deep}.py`, +78 lines), `20097e86 → 99c4b9d` (context_engine proactive-context integration, 21 files, +5693 lines; the proactive domain is explicitly not adopted per docs/05 §7.2), `99c4b9d → 56da762` (three same-day commits: Harmony frontend platform routing, cron free-model adaptation and dump trace/title fixes, 19 files +841/-45 — all in gateway/frontend/cron/trace domains that are not adopted), `56da762 → 91c9137` (MCP friendly CLI connect-error surfacing plus a uv sync index CI fix, 8 files +497/-16, with two new MCP-guard unit tests — MCP runtime is not adopted per docs/05 §7.2) and `91c9137 → 36c7959` (2026-08-21, single commit: AgentGroup packages in hybrid team mode, 27 files +1061/-10 — strictly additive: strict package loader with path-escape guards, an optional `agent_group_name` enrichment branch appended after member enrich, session-immutable selection binding, multi-source conflict-reject instead of shadowing; the assembly.py and DESIGN.md §8 edits sit outside the evidence anchors cited by the security review and docs/10 §4, and the D-list registrations are in docs/05 §7.2). `36c7959 → 962f0a4` (2026-08-22, four commits, 95 files +6264/-1968: the mode system migrated to three-segment canonical names with a `DEPRECATION_MAP` silent mapping and lazy session-metadata migration plus six contract test groups, a skill-plaza web frontend rewrite, a `/persist` TUI command, and a workswarm branch double-merge — everything lands in the not-adopted web/tui/e2a domains or as compatible additive backend changes; the M2 node-mapping anchors in `workflow_state.py` and the TUI SwarmFlow guide are byte-untouched and their line numbers verified valid at the new pin; the referenced upstream web OAuth antipattern — bundling a client secret and non-CSPRNG state — is recorded here as a not-adopted-domain observation). None of the deltas touches the SwarmFlow, Team, Worktree, memory, Skill Evolution, permission or distributed-runtime evidence used by this project. The upstream `develop` branch moved repeatedly during the 2026-08-20/21 sessions; each re-pin was handled as a single cumulative diff review of the latest reviewed head — a hot upstream is handled by reviewing cumulative diffs, not per-commit chases.

Priority documents/concepts:

M4-2 Gate A supersession (2026-08-22): the supplied sync script refreshed `develop` to the recorded `1d45d2b` pointer and verified it as the branch tip. The older cumulative-diff paragraph above remains historical evidence through `962f0a4`; issue #128 consumes only the current pinned behavioral evidence for toolchain-specific Python verification and fail-loud missing-analyzer behavior, importing no Jiuwen runtime architecture or types.

- Agent Team user guide
- Distributed Team
- TUI SwarmFlow guide
- Memory and Team Memory
- Skill Self-Evolution
- Tool Permissions & Security

Read for feature concepts and operational failure cases. Do not import OpenJiuwen types into the DSH capability contract.

## 4. Evidence order for Agents

When behavior is uncertain:

1. inspect the current project and target Profile;
2. inspect installed package `package.json`, exports, types and README;
3. inspect official DSH checkout at a recorded SHA;
4. inspect official subsystem docs and examples;
5. inspect `ref/dsh-agent-teams/source/` for direct DSH plugin prior art;
6. inspect `ref/jiuwenswarm/source/` for product concepts and failure cases;
7. if still uncertain, implement the smallest fail-loud behavior and record the assumption.

Never cite a secondary guide as proof that an unpublished package or method exists in the target installation.

## 5. Documentation freshness rule

Before changing any claim about an official API or either reference implementation:

1. query the relevant remote ref when network access is available;
2. record the exact commit and compare it with the local pin;
3. inspect the package manifest, exported types, README and tests at that commit;
4. separate “package exists”, “service is in the assembled Profile” and “this plugin integrates it” as three different facts;
5. update every affected README, design document, ADR and Skill reference in the same change;
6. run `rg` for the superseded claim and run the verification suite.

If a newer official release has been published but the pin has not been re-reviewed, document the drift; do not silently describe the old pin as current. Official master advancing between releases is not drift: the baseline is release-anchored, not HEAD-anchored (docs/11 section 2).

The machine-readable official baseline is `OFFICIAL_BASELINE.json`. Run `pnpm verify:gate-a` before feature work: it runs `verify:official` and `verify:references`, querying all three remotes and checking their clean local evidence checkouts. The official half is release-anchored: `verify:official` proves the pinned commit is an official release — the `dsh-v<release>` tag landed on the pin or demonstrably contains it, with a warned fallback to the verified remote tip/ancestor during the npm-first/tag-pending window — so master advancing past the pin does not break Gate A, while a newer published release makes a re-pin due. These network checks are intentionally separate from offline `pnpm verify`: failure to reach a remote is a visible Gate A limitation, not a reason to pretend that a cached pin is current.

Recreate or repair the official sparse evidence checkout with `scripts/sync-official-evidence.ps1`. The script refuses a dirty checkout and materializes the implemented Agent Notes plus every official capability family used by the current architecture map.

## 6. Self-hosting architecture evidence record

ADR-0008 was accepted on 2026-08-20 after `pnpm verify:gate-a` again passed against all three recorded commits. The decision adds no new claim that an official self-update or child-cwd service exists. It composes current official services and retains the verified limitation that `ctx.workspaceRegistry` is identity/membership, not Worktree allocation or execution-root enforcement.

The self-hosting behavior is derived from:

- official DSH Profile/Bundle composition, Session persistence, Subagents, Workflow, Jobs, Storage Domain, Workspace and interaction services, plus target-verified permission/tool enforcement points;
- `dsh-agent-teams` durable Team, status, fencing, mailbox and lifecycle failure behavior;
- JiuwenSwarm Worktree, verification, permission, distributed reservation and Skill Evolution product/failure contracts.

The stable-control/candidate-acceptance split, promotion state machine and readiness levels are project-owned architecture. They must not be described as official DSH features.

## 7. Updating pins

An update is a design task, not a blind `git pull`:

1. record old/new commit;
2. review official architecture, package map and target exported types;
3. search for Agent Team, subagent continuation, workflow, storage and interaction changes;
4. update `ref` pointer and sync source;
5. update affected docs/Skill templates;
6. run characterization and real-composition tests;
7. document migrations or deliberately reject incompatible state.

# 09. Source register and evidence policy

Recorded: 2026-08-20.

## 1. Primary framework sources

### DeepSeek Harness official repository

- URL: `https://github.com/deepseek-ai/deepseek-harness`
- Branch: `master`
- Commit: `141eb6fef83422698aef7a981029e843e8161534`
- Commit message: release `dsh@0.1.0-rc.8`
- Live verification: on 2026-08-20, `git ls-remote` returned this same SHA for remote `HEAD` and `refs/heads/master`; the clean local sparse checkout at `D:/Source/DSH/framework/deepseek-harness` was detached at the same commit
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

- `@deepseek-ai/dsh-workflow`, `@deepseek-ai/dsh-jobs`, `@deepseek-ai/dsh-token-meter`, `@deepseek-ai/dsh-storage-domain` and `@deepseek-ai/dsh-workspace` are public rc.8 packages;
- `@deepseek-ai/dsh-experimental-agent-team` is `private: true` and has no publish configuration;
- official Agent Team injects Agents, Sessions, Session persistence and Subagents, and documents persisted-child-aware provisioning recovery, bounded disposal and target-session mailbox de-duplication;
- `ctx.workspaceRegistry` is a Workspace identity/membership registry, not a per-child Worktree allocator or cwd override;
- since M1A this plugin consumes the official storage family directly: `@deepseek-ai/dsh-storage` (hub), `@deepseek-ai/dsh-storage-json` (json KV backend, deployment composition), `@deepseek-ai/dsh-storage-domain` (domain form, required peer) and `@deepseek-ai/dsh-session-persistence` (service definition, required peer) — all verified at rc.8 on npm and materialized in the evidence checkout (`packages/storage/*`, `packages/session/session-persistence`);
- the installed plugin dependency tree still does not install workflow/jobs/token-meter as runtime dependencies, so their published availability is not the same as current integration.

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
- Commit: `801954dd7be67213cf4adc1aeb6f97bd3daa12cc`
- Version: `0.1.8`
- Local pointer: `ref/dsh-agent-teams/SOURCE_POINTER.json`
- Full local checkout: `ref/dsh-agent-teams/source/`

Read for implementation prior art, not framework truth.

## 3. Product architecture reference

- URL: `https://github.com/openJiuwen-ai/jiuwenswarm`
- Branch: `develop`
- Commit: `36c7959cccc4e721240007c1211aa4ecbd34c22d`
- Develop package state observed: `workswarm` `0.2.5.beta1`
- Local pointer: `ref/jiuwenswarm/SOURCE_POINTER.json`
- Full local checkout: `ref/jiuwenswarm/source/`

Live verification on 2026-08-21 found `develop` at this commit and the pin was reviewed and updated the same day. Six deltas from the original `bddf335` pin were each diff-reviewed before adoption: `bddf335 → 152583aa` (gateway cron scheduling and server Session metadata), `152583aa → 20097e86` (a single commit adding MCP connection-cache prewarm in `server/runtime/agent_adapter/interface_{code,deep}.py`, +78 lines), `20097e86 → 99c4b9d` (context_engine proactive-context integration, 21 files, +5693 lines; the proactive domain is explicitly not adopted per docs/05 §7.2), `99c4b9d → 56da762` (three same-day commits: Harmony frontend platform routing, cron free-model adaptation and dump trace/title fixes, 19 files +841/-45 — all in gateway/frontend/cron/trace domains that are not adopted), `56da762 → 91c9137` (MCP friendly CLI connect-error surfacing plus a uv sync index CI fix, 8 files +497/-16, with two new MCP-guard unit tests — MCP runtime is not adopted per docs/05 §7.2) and `91c9137 → 36c7959` (2026-08-21, single commit: AgentGroup packages in hybrid team mode, 27 files +1061/-10 — strictly additive: strict package loader with path-escape guards, an optional `agent_group_name` enrichment branch appended after member enrich, session-immutable selection binding, multi-source conflict-reject instead of shadowing; the assembly.py and DESIGN.md §8 edits sit outside the evidence anchors cited by the security review and docs/10 §4, and the D-list registrations are in docs/05 §7.2). None of the deltas touches the SwarmFlow, Team, Worktree, memory, Skill Evolution, permission or distributed-runtime evidence used by this project. The upstream `develop` branch moved repeatedly during the 2026-08-20/21 sessions; each re-pin was handled as a single cumulative diff review of the latest reviewed head — a hot upstream is handled by reviewing cumulative diffs, not per-commit chases.

Priority documents/concepts:

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

If the remote has moved but the pin has not been reviewed, document the drift; do not silently describe the old pin as current.

The machine-readable official baseline is `OFFICIAL_BASELINE.json`. Run `pnpm verify:gate-a` before feature work: it runs `verify:official` and `verify:references`, querying all three remotes and checking their clean local evidence checkouts. These network checks are intentionally separate from offline `pnpm verify`: failure to reach a remote is a visible Gate A limitation, not a reason to pretend that a cached pin is current.

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

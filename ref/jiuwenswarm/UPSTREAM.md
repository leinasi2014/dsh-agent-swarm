# JiuwenSwarm reference

- Upstream: `https://github.com/openJiuwen-ai/jiuwenswarm`
- Branch observed: `develop`
- Pinned commit: `c7bf529a15dfdf422b854ee03f6ef1eb80f6fe24`
- Local checkout: `source/`

This repository is a product and architecture reference, not a DSH dependency.
Use it to study orchestration requirements, state transitions, isolation,
budgets, memory, skill evolution, permissions and distributed failure cases.
Translate those requirements onto existing DSH services and lifecycle seams.

Do not copy JiuwenSwarm's Python Runtime, persistence schema, transport choices
or public types into the DSH plugin contract. When a Jiuwen concept conflicts
with the target DSH installation, the installed DSH exports and official DSH
source are authoritative.

The pinned tree contains Git LFS videos. They are deliberately left as pointer
files because the text source is sufficient for development analysis and some
upstream media objects are unavailable.

The 2026-08-30 repin reviewed `8f34291..cfe09cc` (14 commits, 147 files).
It changes JiuwenSwarm's Web/TUI presentation, AgentOS and context-engine
paths, template/plugin loading, skills refresh, session-continuity rails and
its own Team reliability switch. The range has no changed Jobs,
Workflow-engine or Worktree ownership path consumed by this plugin. None of
that Python runtime, transport, persistence schema, public types or UI is
adopted by this DSH plugin.

On Windows, the supplied sync scripts set repository-local `core.longpaths`
before checkout: the bounded `source/` target plus this upstream's nested
documentation paths otherwise exceeds the platform path limit. A pre-existing
Git checkout without `HEAD` now fails loudly and is preserved for explicit
reconciliation; the reusable sync scripts never clean it.

The 2026-09-05 refresh covers `cfe09cc..e8aa1b4`. The cumulative path and
manifest review includes the CLI relocation, SDK pin
`691347b97ef5089a0b0caf7861c98cb9ad35aa2b`, terminal/HTTP dependency changes,
permission-audit sanitization and heartbeat lifecycle changes. The package
remains `workswarm 0.2.5.beta1` under Apache-2.0. This is a scoped reference
compatibility review, not validation of every upstream feature.

The final `bdc337c..e8aa1b4` delta removes the conflicting heartbeat
`delete_after_run` field. Persisted legacy records normalize to `max_runs`,
and model/store/scheduler tests cover continued execution after raising that
limit. This is failure-model evidence for one authoritative completion rule;
it does not add a heartbeat service, import Jiuwen runtime code or alter the
existing DSH provider contracts. Any future adoption needs its own acceptance.

The 2026-09-08 refresh covers `e8aa1b4..c7bf529` (52 commits), the
`workswarm 0.2.5.beta1` manifest and unchanged Apache-2.0 license. The SDK pin
is now GitCode agent-core `0af325ebe9f891e53fa211dae3392a4aff9d923d`. The scoped source review
covers heartbeat execution/preemption, layered permission persistence and
root approval admission, with their changed tests; the cumulative path review
also identifies browser/MCP and skill installation changes. These supply
failure cases for lifecycle cancellation, scoped authority and user-input
admission. They do not authorize a new DSH scheduler, permission store, SDK
adapter or skill marketplace. No Python runtime, transport, persistence, UI or
public type is adopted, and the upstream test suite was not executed here.

The final five commits also preserve terminal heartbeat status on a late
pause, serialize Team startup separately from live inputs, sanitize failed
MCP connections and correct skill detail/interrupt behavior. Their changed
manifests, source and regression tests were reviewed as failure evidence;
they do not change this plugin's runtime or feature commitments.

# JiuwenSwarm reference

- Upstream: `https://github.com/openJiuwen-ai/jiuwenswarm`
- Branch observed: `develop`
- Pinned commit: `e8aa1b433e8b5ff1875cdd4cfd63155ad2a2a862`
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

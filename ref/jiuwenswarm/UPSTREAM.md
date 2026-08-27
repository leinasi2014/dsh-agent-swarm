# JiuwenSwarm reference

- Upstream: `https://github.com/openJiuwen-ai/jiuwenswarm`
- Branch observed: `develop`
- Pinned commit: `8f34291906abf7c4e1a3a94d1a819e5a94c0ff3b`
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

The 2026-08-27 repin reviewed `7ebebe3..8f34291` (10 commits, 138 files).
It adds a config-gated Code-mode SDD rail (an in-memory stage machine and
methodology artifacts), AgentOS/Web token-auth and locatable gateway-log work,
agent-management/front-end work, and four Team-area presentation files. The
range has no changed Jobs, Workflow-engine or Worktree ownership path. Its SDD
``workflows`` are methodology files rather than the product Workflow runtime;
the existing Code adapter still owns its project/workspace path selection.
None of that Python runtime, transport, persistence schema, public types or UI
is adopted by this DSH plugin.

On Windows, the supplied sync scripts set repository-local `core.longpaths`
before checkout: the bounded `source/` target plus this upstream's nested
documentation paths otherwise exceeds the platform path limit. A pre-existing
Git checkout without `HEAD` now fails loudly and is preserved for explicit
reconciliation; the reusable sync scripts never clean it.

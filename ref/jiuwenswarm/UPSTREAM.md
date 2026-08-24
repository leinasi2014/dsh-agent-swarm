# JiuwenSwarm reference

- Upstream: `https://github.com/openJiuwen-ai/jiuwenswarm`
- Branch observed: `develop`
- Pinned commit: `403fe354ad9ffbce36683a9b223ba9a36179bc06`
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

The reviewed delta adds an optional persistent subagent runtime, restructures
prompt and attachment handling, hardens restart cleanup and recognizes the
canonical Team Plan modes during capability assembly. It reinforces explicit
delegation, lifecycle and plan-to-execution boundaries. None of its Python
runtime, transport, persistence schema or public types is adopted here.

The 2026-08-24 supersession adds an Autofix PR command and a Web plugin/MCP
market with skill and extension pickers. It does not change the Team, memory,
Skill Evolution, Worktree, permission or distributed-runtime evidence consumed
by this project. Its picker UI is presentation prior art only; DSH's official
settings, skills and plugin seams remain authoritative for this plugin.

The later `403fe354` supersession moves user-state config, memory and project
operations behind per-user AgentServer adapters, propagates authenticated
`user_id` only to routed tools, and adds fenced subagent-history replay UI.
This reinforces business-state ownership at the authenticated runtime and UI
as projection. It remains behavior evidence only: no Jiuwen adapter, runtime,
storage schema or frontend state type is adopted by this plugin.

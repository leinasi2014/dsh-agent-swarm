# JiuwenSwarm reference

- Upstream: `https://github.com/openJiuwen-ai/jiuwenswarm`
- Branch observed: `develop`
- Pinned commit: `9ac2fa5e7d60142146448bd1395ec2165292beaa`
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

The `59e42de9` supersession adds macOS bundle repair, Artifact and ToolPanel
presentation, one-shot cron conflict handling, caller-supplied `DeepAgentSpec`,
responsive Web UI work and Team task presentation. Review confirmed that the
Team permission rails, member reporting and distributed-runtime evidence used
by this plugin are unchanged. The declarative Agent specification is supporting
composition evidence only; no Jiuwen runtime, policy or public type is adopted.

The `2cc2048b` supersession adds a Python ForkServer fast path, restructures the
code-mode prompt and browser rail, forwards Web MCP calls, and fixes Feishu Team
reply presentation. Review found no change to the Team, memory, permission,
worktree or durable-runtime semantics consumed by this plugin.

The `9ac2fa5e` supersession adds loadable Agent templates and plugin packages,
an Agent/plugin creator surface, AgentServer adapter and upload/restart fixes,
plus test hardening. It reinforces declarative composition and stable runtime
identity but does not add or change the attempt-artifact handoff, Team CAS,
mailbox, memory, worktree or distributed-recovery semantics consumed here. No
Jiuwen runtime, plugin manifest, rail or public type is adopted.

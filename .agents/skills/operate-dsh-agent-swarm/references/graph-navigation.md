# Static graph navigation contract

The canonical query input is `docs/generated/knowledge-graph/atlas.json`. The helper first runs `scripts/verify-knowledge-graph.mjs`; missing or drifted generated output is an error, never a reason to fall back to a stale graph.

## Commands

- `check`: validate the atlas envelope and report its static graph summary.
- `search <text>`: find bounded, deterministic matches across stable id, title, kind, and tags.
- `show <id-or-unambiguous-text>`: return one node and its interpretation.
- `edges <id-or-unambiguous-text>`: return bounded incoming/outgoing relations. Add `--direction in|out|both` or `--type <edge-type>`.
- `path <from> <to>`: return one deterministic shortest path within `--depth`.
- `anchors <id-or-unambiguous-text>`: return the node anchors and bounded incident-edge anchors.

`--limit` is capped at 100 and `--depth` at 8. `KG_QUERY_LIMIT` and `KG_QUERY_DEPTH` set lower per-invocation defaults. The helper performs no network calls or writes. Verification errors named `KG_GENERATED_*` pass through unchanged; helper-owned failures use `KG_QUERY_*`.

## Interpretation boundaries

- A reviewed node is a reviewed static contract claim, not proof that a process is currently running or configured.
- A mechanical node or edge is useful only for locating source structure. Open its anchors and inspect the owning implementation before making semantic, authority, security, or lifecycle claims.
- `maturity.implementation`, `maturity.verification`, `maturity.acceptance`, and `maturity.availability` are independent. For example, `implemented` does not imply accepted or currently available.
- The graph contains no live task, member, job, lease, health, port, profile, or process state. Query the corresponding runtime API, Session log, storage domain, or project-selected dynamic authority instead.
- When navigation becomes implementation work, switch to `$dsh-plugin-development` and complete its evidence and verification gates.

Exact stable ids are preferred. Text accepted by `show`, `edges`, `path`, and `anchors` must resolve to exactly one node; otherwise the helper returns `KG_QUERY_NOT_FOUND` or `KG_QUERY_AMBIGUOUS` with bounded candidates.

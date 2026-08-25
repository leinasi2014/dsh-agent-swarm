# DBG-022 — Code Mode Team participants lost official development tools

Status: `FIXED_CANDIDATE / CLEAN_PROFILE_RETEST_PENDING`  
Observed: 2026-08-25 in a fresh official `web` Profile with the `code` preset and GLM-5.3.  
Scope: `dsh-agent-swarm`; official DSH source remained unchanged.

## Representative failure

The Captain created a real Team through `run_code`. From that point, nested
`glob`, `read`, and `pwsh` calls all failed with:

`tool "<name>" is denied by the Team tool policy (fail closed)`

The Team existed durably, but the Captain could neither inspect the workspace
nor continue implementation. The same default classifier also applied to
delegated members, so a member would have lost the tools granted by its
official DSH preset before it could perform assigned work.

The first program also returned an object containing `undefined`; official
Code Mode correctly rejected that outer completion as non-lossless JSON after
the Team side effect had committed. That is a caller-program defect, not an
invalid `agent_swarm_create` output. A failed outer completion must reconcile
Team authority before retrying a non-idempotent create.

## Cause and correction

`DEFAULT_TOOL_PERMISSION` denied every unlisted host tool. The earlier
`run_code` exception kept the transport callable but every nested official
tool re-entered `tools/pre-execute` and was still denied.

Unlisted host tools now inherit the official DSH preset, sandbox, approval and
guard result. The Team overlay only narrows that authority through explicit
`ask`/`deny`, mandatory captain-only restrictions, and the global/root
`report` denial. The official child-scoped `report` exception remains intact.
The Code Mode transport is tracked separately from the plugin's registered
19-tool inventory so the knowledge-graph closure remains exact.

## Candidate evidence

- permission boundary/composition suites: 27/27 pass;
- full suite: 60 files, 388/388 tests pass;
- typecheck and test typecheck pass;
- build passes; lint has only the seven pre-existing warnings;
- `verify-knowledge-graph`: PASS, 933 nodes / 1571 edges / 19-tool closure.

Acceptance remains open until a new fresh Profile repeats the complete
create-Team → add members → create DAG → dispatch → member filesystem/shell
work → submit/review/integrate path.

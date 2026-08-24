# DBG-021 — continuable-member `report` host-plane boundary

Status: `IMPLEMENTED_CANDIDATE / REVIEW_PENDING`  
Base: `f9f7df74b0ef79139552b6096034468cb2ae059d`  
Scope: `dsh-agent-swarm` only; official DSH remains read-only.

## 1. Defect

The official base composition installs `@deepseek-ai/dsh-tool-subagent-report` once in the Host plane. For every live continuable in-process child, that package atomically contributes the child-scoped `report` schema and the `tool:report` system-prompt section that asks the child to report before finishing. Official DSH deliberately keeps this local capability outside the child's global `toolFilter`; omitting the package is the deployment-owned way to remove it.

A Swarm member is such a continuable child. Its request therefore exposed `report` and instructed it to call the tool, but the plugin's later `tools/pre-execute` overlay classified every Team-participant call by name. The default Team policy allows the `agent_swarm_*` surface and denies unlisted host tools, so member B2's calls at Session events 2850/2851 were rejected with `denied by the Team tool policy (fail closed)`. `agent_swarm_send_message` had succeeded because it is part of the default plugin-tool allow set.

The two layers were individually behaving as designed but their composition was contradictory: one layer promised a child-local capability that the other layer could not identify as host-owned.

## 2. Decision

The Team policy abstains, rather than grants, only when all of these facts hold for the concrete call:

1. `exec.agent` is the exact live Agent registered for an active Team member;
2. `exec.name === 'report'`;
3. the member Session's durable `parentSession` exactly equals that Team's `captainSessionId`;
4. `ctx.tools.get('report', exec.agent)` exists and is not the global `ctx.tools.get('report')`, proving that the resolved definition is child-scoped.

The listener returns `await next()`. It never manufactures `{ kind: 'allow' }`, so downstream DSH policy, approval handling and monotonic guards remain authoritative. Captain calls, wrong-parent sessions, global same-name tools and every ordinary unlisted host tool continue through the existing fail-closed Team classification.

This exception belongs in the permission composition surface, not in `DEFAULT_TOOL_POLICY`: `report` is owned and authorized by official `ctx.subagents.reportFrom()`, not by the plugin's Team aggregate. The official tool re-verifies the exact live Activation and derives the only recipient from durable lineage; it accepts no recipient argument and cannot mutate Team state.

## 3. Relation to Team messaging and completion

The two member-to-captain paths retain different authority:

- `report` is the official current-Activation handoff to the direct parent Session;
- `agent_swarm_send_message` is durable Team mailbox communication and remains the blocker/progress path;
- `agent_swarm_submit_task` remains the only member submission transition. A report neither submits nor completes a Team task and does not replace the captain review gate.

Removing or contradicting the official report guidance in a member persona was rejected. The setup registry is Host-owned and not Team-scope configurable; disabling it from this plugin would affect unrelated DSH continuable children or require an official/Profile patch.

## 4. Verification contract

`tests/permission-report-composition.spec.ts` mounts the published rc.2 report package with the real ToolRuntime, Subagent service/provider, Agent Loop and Swarm plugin and proves:

1. a live member resolves a child-scoped report, reports to its exact Captain and leaves the Team snapshot byte-equivalent;
2. a downstream scoped guard still denies and produces no parent report;
3. a mismatched durable parent does not receive the exemption;
4. a global same-name report and an ordinary unlisted host tool remain denied for a member;
5. the existing unrelated-agent and monotonic-denial behavior remains intact.

The test-only dependency is exact `@deepseek-ai/dsh-tool-subagent-report@0.1.1-rc.2`, matching the project's official compatibility baseline. No production dependency or official DSH source change is introduced.

## 5. Residual boundary

The official `ToolExecution` contract exposes the resolved tool name and caller but no package/provenance identifier. The local-versus-global definition identity check is therefore the strongest available non-invasive proof of child scoping. A future official definition-origin or capability marker should replace that structural check if one is published; until then, the exact Team membership, lineage and scoped-definition conjunction prevents a name-only widening.

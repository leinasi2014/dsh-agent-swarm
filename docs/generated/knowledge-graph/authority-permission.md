<!-- DO NOT EDIT: generated from docs/knowledge-graph/manifest.json -->

# Authority and permission

Manifest digest: `fe332cc0e1a7493e66591f6961f76dfdf97eccff20afcbebfb60f1ffbdbe24ed`

Curated tool-registry digest: `331defbb12c4ac44efa0bdd7b16007d003dfa3704477b0c2c925d9cc1b665783`

> Claim ceiling: the registry is a reviewed capability overlay over exact source extraction. Per-tool deep semantic closure, acceptance, and real-Profile evidence remain explicit gaps; the complete mechanical graph is retained in `atlas.json`.

## Functional facets

| Functional facet | Title | Source anchors | Test anchors | Related tools | Evidence gaps |
|---|---|---|---|---|---|
| `team` | Team lifecycle authority | src/domain/team-domain.ts#TeamDomain | tests/team-domain.spec.ts | tool:agent_swarm_add_member<br>tool:agent_swarm_archive<br>tool:agent_swarm_create<br>tool:agent_swarm_interrupt_member<br>tool:agent_swarm_remove_member | NO_REAL_PROFILE_EVIDENCE<br>PROFILE_DEPENDENT |
| `permission` | Caller identity and monotone tool permission policy | src/runtime/permission-policy.ts#decideToolPermission<br>src/runtime/permission-surface.ts#TeamPermissionSurface.attachPreExecute | tests/permission-boundary.spec.ts<br>tests/permission-real-composition.spec.ts | tool:agent_swarm_add_member<br>tool:agent_swarm_add_memory<br>tool:agent_swarm_add_personal_memory<br>tool:agent_swarm_archive<br>tool:agent_swarm_claim_task<br>tool:agent_swarm_create<br>tool:agent_swarm_create_task<br>tool:agent_swarm_interrupt_member<br>tool:agent_swarm_list_jobs<br>tool:agent_swarm_list_memory<br>tool:agent_swarm_list_tasks<br>tool:agent_swarm_reassign_task<br>tool:agent_swarm_remove_member<br>tool:agent_swarm_review_task<br>tool:agent_swarm_send_message<br>tool:agent_swarm_set_budget<br>tool:agent_swarm_status<br>tool:agent_swarm_submit_task<br>tool:agent_swarm_wait | NO_REAL_PROFILE_EVIDENCE<br>PROFILE_DEPENDENT |

## Tool families

### team-lifecycle

```mermaid
flowchart LR
  n_66616d696c793a7465616d2d6c6966656379636c65["team-lifecycle"]
  n_66616d696c793a7465616d2d6c6966656379636c65 --> n_746f6f6c3a6167656e745f737761726d5f6164645f6d656d626572["agent_swarm_add_member"]
  n_66616d696c793a7465616d2d6c6966656379636c65 --> n_746f6f6c3a6167656e745f737761726d5f61726368697665["agent_swarm_archive"]
  n_66616d696c793a7465616d2d6c6966656379636c65 --> n_746f6f6c3a6167656e745f737761726d5f637265617465["agent_swarm_create"]
  n_66616d696c793a7465616d2d6c6966656379636c65 --> n_746f6f6c3a6167656e745f737761726d5f696e746572727570745f6d656d626572["agent_swarm_interrupt_member"]
  n_66616d696c793a7465616d2d6c6966656379636c65 --> n_746f6f6c3a6167656e745f737761726d5f72656d6f76655f6d656d626572["agent_swarm_remove_member"]
```

| Stable capability id | Capability authority (not state authority) | Caller class | Default policy |
|---|---|---|---|
| `tool:agent_swarm_add_member` | domain:agent-swarm | captain-only | allow |
| `tool:agent_swarm_archive` | domain:agent-swarm | captain-only | allow |
| `tool:agent_swarm_create` | domain:agent-swarm | captain-only | allow |
| `tool:agent_swarm_interrupt_member` | domain:agent-swarm | captain-only | allow |
| `tool:agent_swarm_remove_member` | domain:agent-swarm | captain-only | allow |

### task

```mermaid
flowchart LR
  n_66616d696c793a7461736b["task"]
  n_66616d696c793a7461736b --> n_746f6f6c3a6167656e745f737761726d5f636c61696d5f7461736b["agent_swarm_claim_task"]
  n_66616d696c793a7461736b --> n_746f6f6c3a6167656e745f737761726d5f6372656174655f7461736b["agent_swarm_create_task"]
  n_66616d696c793a7461736b --> n_746f6f6c3a6167656e745f737761726d5f726561737369676e5f7461736b["agent_swarm_reassign_task"]
  n_66616d696c793a7461736b --> n_746f6f6c3a6167656e745f737761726d5f7265766965775f7461736b["agent_swarm_review_task"]
  n_66616d696c793a7461736b --> n_746f6f6c3a6167656e745f737761726d5f7375626d69745f7461736b["agent_swarm_submit_task"]
```

| Stable capability id | Capability authority (not state authority) | Caller class | Default policy |
|---|---|---|---|
| `tool:agent_swarm_claim_task` | domain:agent-swarm | team-participant | allow |
| `tool:agent_swarm_create_task` | domain:agent-swarm | team-participant | allow |
| `tool:agent_swarm_reassign_task` | domain:agent-swarm | captain-only | allow |
| `tool:agent_swarm_review_task` | domain:agent-swarm | captain-only | allow |
| `tool:agent_swarm_submit_task` | domain:agent-swarm | team-participant | allow |

### mailbox

```mermaid
flowchart LR
  n_66616d696c793a6d61696c626f78["mailbox"]
  n_66616d696c793a6d61696c626f78 --> n_746f6f6c3a6167656e745f737761726d5f73656e645f6d657373616765["agent_swarm_send_message"]
  n_66616d696c793a6d61696c626f78 --> n_746f6f6c3a6167656e745f737761726d5f77616974["agent_swarm_wait"]
```

| Stable capability id | Capability authority (not state authority) | Caller class | Default policy |
|---|---|---|---|
| `tool:agent_swarm_send_message` | domain:agent-swarm | team-participant | allow |
| `tool:agent_swarm_wait` | domain:agent-swarm | team-participant | allow |

### read

```mermaid
flowchart LR
  n_66616d696c793a72656164["read"]
  n_66616d696c793a72656164 --> n_746f6f6c3a6167656e745f737761726d5f6c6973745f6a6f6273["agent_swarm_list_jobs"]
  n_66616d696c793a72656164 --> n_746f6f6c3a6167656e745f737761726d5f6c6973745f7461736b73["agent_swarm_list_tasks"]
  n_66616d696c793a72656164 --> n_746f6f6c3a6167656e745f737761726d5f737461747573["agent_swarm_status"]
```

| Stable capability id | Capability authority (not state authority) | Caller class | Default policy |
|---|---|---|---|
| `tool:agent_swarm_list_jobs` | domain:agent-swarm | team-participant | allow |
| `tool:agent_swarm_list_tasks` | domain:agent-swarm | team-participant | allow |
| `tool:agent_swarm_status` | domain:agent-swarm | team-participant | allow |

### budget-memory

```mermaid
flowchart LR
  n_66616d696c793a6275646765742d6d656d6f7279["budget-memory"]
  n_66616d696c793a6275646765742d6d656d6f7279 --> n_746f6f6c3a6167656e745f737761726d5f6164645f6d656d6f7279["agent_swarm_add_memory"]
  n_66616d696c793a6275646765742d6d656d6f7279 --> n_746f6f6c3a6167656e745f737761726d5f6164645f706572736f6e616c5f6d656d6f7279["agent_swarm_add_personal_memory"]
  n_66616d696c793a6275646765742d6d656d6f7279 --> n_746f6f6c3a6167656e745f737761726d5f6c6973745f6d656d6f7279["agent_swarm_list_memory"]
  n_66616d696c793a6275646765742d6d656d6f7279 --> n_746f6f6c3a6167656e745f737761726d5f7365745f627564676574["agent_swarm_set_budget"]
```

| Stable capability id | Capability authority (not state authority) | Caller class | Default policy |
|---|---|---|---|
| `tool:agent_swarm_add_memory` | domain:agent-swarm | team-participant | allow |
| `tool:agent_swarm_add_personal_memory` | domain:agent-swarm | team-participant | allow |
| `tool:agent_swarm_list_memory` | domain:agent-swarm | team-participant | allow |
| `tool:agent_swarm_set_budget` | domain:agent-swarm | captain-only | allow |

## Complete graph projection

```mermaid
flowchart LR
  n_617574686f726974793a70726f6a6563742d636f6e747261637473["Registered project contract authority"]
  n_617574686f726974793a736f757263652d74726565["Repository source-tree authority"]
  n_6361706162696c6974793a66726573682d76322d6d6f64656c2d64697370617463682d7769746e657373["Network-free per-Provider model dispatch witness capability"]
  n_646f6d61696e3a6167656e742d737761726d["Storage Domain agent_swarm v1"]
  n_646f6d61696e3a6167656e742d737761726d2d68756d616e["Storage Domain agent_swarm_human v1"]
  n_646f6d61696e3a6167656e742d737761726d2d7632["Storage Domain agent_swarm_v2 v1"]
  n_646f6d61696e3a6167656e742d737761726d2d776f726b666c6f77["Storage Domain agent_swarm_workflow v1"]
  n_67756172643a617474656d70742d72756e6e696e672d7265736572766564["runningReserved"]
  n_67756172643a6275646765742d7265736572766174696f6e2d61646d69737369626c65["budget"]
  n_67756172643a6361707461696e2d6f722d73656c662d6d656d62657273686970["membership"]
  n_67756172643a636c61696d65642d6672616d652d6f6e6c792d61636b6e6f776c656467656d656e74["claimed"]
  n_67756172643a65786163742d63757272656e742d617474656d7074["current"]
  n_67756172643a65786163742d7461736b2d7265766973696f6e["revision"]
  n_67756172643a66726573682d76322d6578706572696d656e74616c2d61637469766174696f6e["Fresh-v2 is explicit and isolated from v1 activation"]
  n_67756172643a66726573682d76322d66697865642d70726f66696c652d7769746e6573732d6361706162696c697479["Fixed-Profile host, artifact, Provider and listener-order witness"]
  n_67756172643a66726573682d76322d6f6666696369616c2d6167656e742d6c6f6f702d72657175657374["Exact official Agent Loop AbortSignal permit and Session coordinates"]
  n_67756172643a6d656d6265722d6861732d6e6f2d6f70656e2d776f726b["available"]
  n_67756172643a6f6666696369616c2d6c6976652d6469726563742d706172656e742d61646d697373696f6e["parent"]
  n_67756172643a7270632d626f756e642f7372632f636c69656e742f7465616d2d64617368626f6172642d636f6e74726f6c6c65722e74732f706167655f6c696d6974["PAGE_LIMIT = 50"]
  n_67756172643a7270632d626f756e642f7372632f7270632f726561642d7270632d636f6e74726163742e74732f737761726d5f726561645f7270635f76657273696f6e["SWARM_READ_RPC_VERSION = 1"]
  n_67756172643a7270632d626f756e642f7372632f7270632f726561642d7270632d736572766963652e74732f64656661756c745f646973706f73616c5f74696d656f75745f6d73["DEFAULT_DISPOSAL_TIMEOUT_MS = 5000"]
  n_67756172643a7270632d626f756e642f7372632f7270632f726561642d7270632d736572766963652e74732f64656661756c745f706167655f6c696d6974["DEFAULT_PAGE_LIMIT = 50"]
  n_67756172643a7270632d626f756e642f7372632f7270632f726561642d7270632d736572766963652e74732f6d61785f706167655f6c696d6974["MAX_PAGE_LIMIT = 50"]
  n_67756172643a7270632d687474702f30312d7372632f636c69656e742f726561642d636c69656e742e7473["client-fetch POST"]
  n_67756172643a7270632d687474702f30322d7372632f7270632f726561642d7270632d736572766963652e7473["route-handler POST"]
  n_67756172643a7461736b2d7265616479["ready"]
  n_6f6666696369616c2d617574686f726974793a6167656e742d6c6f6f70["Official DSH Agent Loop execution authority"]
  n_6f6666696369616c2d617574686f726974793a6c6c6d2d72756e74696d65["Official DSH LLM registry and stream waterfall authority"]
  n_6f6666696369616c2d617574686f726974793a73657373696f6e["Official Session event/history authority"]
  n_6f6666696369616c2d617574686f726974793a7375626167656e74["Official continuable Subagent admission authority"]
  n_646f6d61696e3a6167656e742d737761726d -->|owns| n_67756172643a66726573682d76322d6578706572696d656e74616c2d61637469766174696f6e
  n_6f6666696369616c2d617574686f726974793a6c6c6d2d72756e74696d65 -->|owns| n_6361706162696c6974793a66726573682d76322d6d6f64656c2d64697370617463682d7769746e657373
  n_6f6666696369616c2d617574686f726974793a6c6c6d2d72756e74696d65 -->|owns| n_67756172643a66726573682d76322d66697865642d70726f66696c652d7769746e6573732d6361706162696c697479
  n_6f6666696369616c2d617574686f726974793a6167656e742d6c6f6f70 -->|owns| n_67756172643a66726573682d76322d6f6666696369616c2d6167656e742d6c6f6f702d72657175657374
  n_646f6d61696e3a6167656e742d737761726d -->|owns| n_67756172643a617474656d70742d72756e6e696e672d7265736572766564
  n_646f6d61696e3a6167656e742d737761726d -->|owns| n_67756172643a6275646765742d7265736572766174696f6e2d61646d69737369626c65
  n_646f6d61696e3a6167656e742d737761726d -->|owns| n_67756172643a6361707461696e2d6f722d73656c662d6d656d62657273686970
  n_6f6666696369616c2d617574686f726974793a73657373696f6e -->|owns| n_67756172643a636c61696d65642d6672616d652d6f6e6c792d61636b6e6f776c656467656d656e74
  n_646f6d61696e3a6167656e742d737761726d -->|owns| n_67756172643a65786163742d63757272656e742d617474656d7074
  n_646f6d61696e3a6167656e742d737761726d -->|owns| n_67756172643a65786163742d7461736b2d7265766973696f6e
  n_646f6d61696e3a6167656e742d737761726d -->|owns| n_67756172643a6d656d6265722d6861732d6e6f2d6f70656e2d776f726b
  n_6f6666696369616c2d617574686f726974793a7375626167656e74 -->|owns| n_67756172643a6f6666696369616c2d6c6976652d6469726563742d706172656e742d61646d697373696f6e
  n_646f6d61696e3a6167656e742d737761726d -->|owns| n_67756172643a7461736b2d7265616479
```

_View capped at 30 nodes and 60 edges; use atlas.json for the complete graph._

| Stable id | Kind | Classification | Implementation | Verification | Acceptance | Availability | Owner |
|---|---|---|---|---|---|---|---|
| `authority:project-contracts` | authority | REVIEWED | implemented | static | candidate | always-registered | `authority:project-contracts` |
| `authority:source-tree` | authority | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `capability:fresh-v2-model-dispatch-witness` | public-capability | REVIEWED | implemented | composition | candidate | config-gated | `official-authority:llm-runtime` |
| `domain:agent-swarm` | domain | REVIEWED | implemented | composition | candidate | always-registered | `domain:agent-swarm` |
| `domain:agent-swarm-human` | domain | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `domain:agent-swarm-v2` | domain | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `domain:agent-swarm-workflow` | domain | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `guard:attempt-running-reserved` | guard | REVIEWED | implemented | static | candidate | always-registered | `domain:agent-swarm` |
| `guard:budget-reservation-admissible` | guard | REVIEWED | implemented | static | candidate | always-registered | `domain:agent-swarm` |
| `guard:captain-or-self-membership` | guard | REVIEWED | implemented | static | candidate | always-registered | `domain:agent-swarm` |
| `guard:claimed-frame-only-acknowledgement` | guard | REVIEWED | implemented | static | candidate | always-registered | `official-authority:session` |
| `guard:exact-current-attempt` | guard | REVIEWED | implemented | static | candidate | always-registered | `domain:agent-swarm` |
| `guard:exact-task-revision` | guard | REVIEWED | implemented | static | candidate | always-registered | `domain:agent-swarm` |
| `guard:fresh-v2-experimental-activation` | guard | REVIEWED | implemented | composition | candidate | config-gated | `domain:agent-swarm` |
| `guard:fresh-v2-fixed-profile-witness-capability` | guard | REVIEWED | implemented | composition | candidate | config-gated | `official-authority:llm-runtime` |
| `guard:fresh-v2-official-agent-loop-request` | guard | REVIEWED | implemented | composition | candidate | config-gated | `official-authority:agent-loop` |
| `guard:member-has-no-open-work` | guard | REVIEWED | implemented | static | candidate | always-registered | `domain:agent-swarm` |
| `guard:official-live-direct-parent-admission` | guard | REVIEWED | implemented | static | candidate | always-registered | `official-authority:subagent` |
| `guard:rpc-bound/src/client/team-dashboard-controller.ts/page_limit` | guard | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | unavailable | `(unclassified)` |
| `guard:rpc-bound/src/rpc/read-rpc-contract.ts/swarm_read_rpc_version` | guard | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | unavailable | `(unclassified)` |
| `guard:rpc-bound/src/rpc/read-rpc-service.ts/default_disposal_timeout_ms` | guard | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | unavailable | `(unclassified)` |
| `guard:rpc-bound/src/rpc/read-rpc-service.ts/default_page_limit` | guard | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | unavailable | `(unclassified)` |
| `guard:rpc-bound/src/rpc/read-rpc-service.ts/max_page_limit` | guard | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | unavailable | `(unclassified)` |
| `guard:rpc-http/01-src/client/read-client.ts` | guard | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | unavailable | `(unclassified)` |
| `guard:rpc-http/02-src/rpc/read-rpc-service.ts` | guard | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | unavailable | `(unclassified)` |
| `guard:task-ready` | guard | REVIEWED | implemented | static | candidate | always-registered | `domain:agent-swarm` |
| `official-authority:agent-loop` | official-authority | REVIEWED | implemented | real-profile | candidate | config-gated | `official-authority:agent-loop` |
| `official-authority:llm-runtime` | official-authority | REVIEWED | implemented | composition | candidate | config-gated | `official-authority:llm-runtime` |
| `official-authority:session` | official-authority | REVIEWED | implemented | static | candidate | always-registered | `official-authority:session` |
| `official-authority:subagent` | official-authority | REVIEWED | implemented | static | candidate | always-registered | `official-authority:subagent` |
| `public-capability:export/public-api/agentswarmhostreaddeps` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/agentswarmhostreadservice` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/agentswarmproducerfloordeps` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/agentswarmproducerfloorservice` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/agentswarmruntime` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/aggregateverificationevidence` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/appliednodeplan` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/applynodeplan` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/attemptid` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/bridgeengineconfig` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/builtinverificationtemplate` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/builtinverificationtemplates` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/candidate_output_artifact` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/canonicaljson` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/captainliaison` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/captainquestion` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/captainquestionpresentation` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/compilednodeplan` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/compiledreviewgate` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/compiledtaskinput` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/compiledtaskop` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/compilenodeplan` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/compileverificationdeclarations` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/createtaskinput` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/derivedteamjob` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/effectivetoolpolicy` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/encodeverificationcommand` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/executablereview` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/executablereviewoptions` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/executablereviewprovider` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/executablereviewresult` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/executablereviewrootcapabilities` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/execution_root_marker` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/executionlease` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/executionroot` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/executionrootisolation` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/executionrootresidue` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/executionroots` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/fileteamstore` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/gitworktreeexecutionroots` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/human_interaction_control_intents` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/human_interaction_domain_name` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/human_interaction_domain_version` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/humancontroladmission` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/humancontrolgateway` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/humancontrolgatewaydeps` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/humaninteractionadmission` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/humaninteractiondomainspec` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/humaninteractionintent` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/humaninteractionorigin` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/humaninteractionoverlaystore` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/humaninteractionport` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/humaninteractionreceipt` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/humaninteractionrecord` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/humaninteractionrequest` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/humaninteractionsource` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/humaninteractionstatus` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/humaninteractiontarget` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/humanprincipalverifier` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/humanreviewprovider` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/mergepretooldecision` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/migratelegacyteamstore` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/migrationoptions` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/migrationreceipt` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/migrationreport` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/migrationteamoutcome` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/nodeplan` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/officialcaptainquestionpresentation` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/openedverificationroot` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/orchestrationmode` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/orchestrationownership` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/parseverificationcommand` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/phasedecl` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/pipelineitemdecl` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/plannodedecl` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/presentquestioninput` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/provideagentswarmhostread` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/provideagentswarmproducerfloor` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/relaymemberquestioninput` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/resolvestateroot` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/reviewcommandevidence` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/revieweragentprovider` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/revieweragentreviewprovider` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/revieweragentverdict` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/reviewproviderinput` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/reviewproviderresult` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/reviewrootavailability` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/reviewrootcapabilities` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/reviewrootopeninput` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/reviewrootprovider` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/reviewrootsession` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/reviewverificationcommand` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/routedreviewcommandevidence` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/runtimeconfig` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/runtimecreatetaskinput` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/samehumaninteractionrequest` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/schedulerdecision` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/schedulerselectioninput` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/storagedomainteamstore` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/swarm_producer_capabilities_v1` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/swarm_producer_contract_digest_v1` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/swarm_producer_contract_v1` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/swarm_producer_contract_version` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/swarm_producer_effect_blocker` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/swarm_producer_fixtures_v1` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/swarm_producer_namespace` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/swarm_producer_protocol` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/swarm_producer_schema_dialect` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/swarmhostreadinput` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/swarmhostreadprojectionv1` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/swarmproducercapability` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/swarmproducercapabilitystate` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/swarmproducerdescriptionv1` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/swarmproducerreadinput` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/swarmproducerreceiptintent` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/swarmproducerreceiptpagev1` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/swarmproducerreceiptreadinput` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/swarmproducerreceiptrowv1` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/swarmproducerreceiptstatus` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/swarmproducersnapshotv1` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/swarmproducerunavailableerrorv1` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/taskid` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/taskstepdecl` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/team_domain_name` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/team_domain_version` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/team_task_job_kind` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/teamaggregatestore` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/teambridgeworkflowengine` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/teambudget` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/teamdomainerror` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/teamdomainport` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/teamdomainspec` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/teamexecutionrootprovider` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/teamid` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/teamjobprojection` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/teammember` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/teammemoryentry` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/teammessage` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/teammessageid` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/teampermissionsurface` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/teamreviewprovider` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/teamschedulerprovider` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/teamscope` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/teamstate` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/teamstatussnapshot` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/teamtask` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/teamtransaction` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/tempreviewrootprovider` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/toolexecutionauthority` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/toolpolicydeclaration` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/unavailablefixture` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/validatebridgemeta` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/verificationcommandroute` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/verificationcommandtemplate` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/verificationdeclaration` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/verificationevidencesummary` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/verificationrootsummary` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/verificationtemplateinvocation` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/verificationtemplateparametervalue` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/workflow_overlay_domain_name` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/workflow_overlay_domain_version` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/workflowoverlaydomainspec` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/workflowrunoverlayrecord` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/workflowrunoverlaystate` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/public-api/workflowrunoverlaystore` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/agent_swarm_settings_namespace` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/agentswarmhostreaddeps` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/agentswarmhostreadservice` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/agentswarmproducerfloordeps` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/agentswarmproducerfloorservice` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/agentswarmruntime` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/aggregateverificationevidence` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/appliednodeplan` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/apply` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/applynodeplan` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/attemptid` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/bridgeengineconfig` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/builtinverificationtemplate` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/builtinverificationtemplates` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/candidate_output_artifact` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/canonicaljson` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/captainliaison` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/captainquestion` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/captainquestionpresentation` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/compilednodeplan` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/compiledreviewgate` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/compiledtaskinput` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/compiledtaskop` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/compilenodeplan` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/compileverificationdeclarations` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/config` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/createtaskinput` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/derivedteamjob` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/effectivetoolpolicy` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/encodeverificationcommand` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/executablereview` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/executablereviewoptions` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/executablereviewprovider` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/executablereviewresult` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/executablereviewrootcapabilities` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/execution_root_marker` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/executionlease` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/executionroot` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/executionrootisolation` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/executionrootresidue` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/executionroots` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/fileteamstore` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/gitworktreeexecutionroots` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/human_interaction_control_intents` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/human_interaction_domain_name` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/human_interaction_domain_version` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/humancontroladmission` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/humancontrolgateway` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/humancontrolgatewaydeps` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/humaninteractionadmission` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/humaninteractiondomainspec` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/humaninteractionintent` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/humaninteractionorigin` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/humaninteractionoverlaystore` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/humaninteractionport` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/humaninteractionreceipt` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/humaninteractionrecord` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/humaninteractionrequest` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/humaninteractionsource` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/humaninteractionstatus` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/humaninteractiontarget` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/humanprincipalverifier` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/humanreviewprovider` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/inject` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/mergepretooldecision` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/migratelegacyteamstore` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/migrationoptions` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/migrationreceipt` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/migrationreport` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/migrationteamoutcome` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/name` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/nodeplan` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/officialcaptainquestionpresentation` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/openedverificationroot` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/orchestrationmode` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/orchestrationownership` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/parseverificationcommand` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/phasedecl` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/pipelineitemdecl` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/plannodedecl` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/presentquestioninput` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/provideagentswarmhostread` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/provideagentswarmproducerfloor` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/relaymemberquestioninput` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/resolvestateroot` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/reviewcommandevidence` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/revieweragentprovider` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/revieweragentreviewprovider` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/revieweragentverdict` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/reviewproviderinput` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/reviewproviderresult` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/reviewrootavailability` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/reviewrootcapabilities` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/reviewrootopeninput` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/reviewrootprovider` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/reviewrootsession` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/reviewverificationcommand` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/routedreviewcommandevidence` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/runtimeconfig` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/runtimecreatetaskinput` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/samehumaninteractionrequest` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/schedulerdecision` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/schedulerselectioninput` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/storagedomainteamstore` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/swarm_producer_capabilities_v1` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/swarm_producer_contract_digest_v1` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/swarm_producer_contract_v1` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/swarm_producer_contract_version` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/swarm_producer_effect_blocker` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/swarm_producer_fixtures_v1` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/swarm_producer_namespace` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/swarm_producer_protocol` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/swarm_producer_schema_dialect` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/swarmhostreadinput` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/swarmhostreadprojectionv1` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/swarmproducercapability` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/swarmproducercapabilitystate` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/swarmproducerdescriptionv1` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/swarmproducerreadinput` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/swarmproducerreceiptintent` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/swarmproducerreceiptpagev1` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/swarmproducerreceiptreadinput` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/swarmproducerreceiptrowv1` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/swarmproducerreceiptstatus` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/swarmproducersnapshotv1` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/swarmproducerunavailableerrorv1` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/taskid` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/taskstepdecl` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/team_domain_name` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/team_domain_version` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/team_task_job_kind` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/teamaggregatestore` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/teambridgeworkflowengine` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/teambudget` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/teamdomainerror` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/teamdomainport` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/teamdomainspec` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/teamexecutionrootprovider` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/teamid` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/teamjobprojection` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/teammember` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/teammemoryentry` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/teammessage` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/teammessageid` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/teampermissionsurface` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/teamreviewprovider` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/teamschedulerprovider` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/teamscope` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/teamstate` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/teamstatussnapshot` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/teamtask` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/teamtransaction` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/tempreviewrootprovider` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/toolexecutionauthority` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/toolpolicydeclaration` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/unavailablefixture` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/validatebridgemeta` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/verificationcommandroute` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/verificationcommandtemplate` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/verificationdeclaration` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/verificationevidencesummary` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/verificationrootsummary` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/verificationtemplateinvocation` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/verificationtemplateparametervalue` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/workflow_overlay_domain_name` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/workflow_overlay_domain_version` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/workflowoverlaydomainspec` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/workflowrunoverlayrecord` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/workflowrunoverlaystate` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:export/root/workflowrunoverlaystore` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:permission-policy/model-tools` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `public-capability:reexport-layer/01-src/client/index.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/02-src/client/index.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/03-src/client/index.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/04-src/client/index.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/05-src/client/plugin-entry.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/06-src/client/plugin-entry.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/07-src/host/host-read-assembly.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/08-src/host/host-read-assembly.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/09-src/host/host-read-service.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/10-src/human/human-control-gateway.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/11-src/human/human-control-gateway.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/12-src/index.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/13-src/index.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/14-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/15-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/16-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/17-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/18-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/19-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/20-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/21-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/22-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/23-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/24-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/25-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/26-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/27-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/28-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/29-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/30-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/31-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/32-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/33-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/34-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/35-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/36-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/37-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/38-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/39-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/40-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/41-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/42-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/43-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/44-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/45-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/46-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/47-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/48-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/49-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/50-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/51-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/52-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/53-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/54-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/55-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/56-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/57-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/58-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/59-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/60-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/61-src/public-api.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/62-src/runtime/execution-roots.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/63-src/runtime/orchestrator-runtime.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/64-src/runtime/orchestrator-runtime.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/65-src/runtime/orchestrator-runtime.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:reexport-layer/66-src/runtime/permission-surface.ts` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:rpc-constant/swarm_read_rpc_contract_digest_v1` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:rpc-constant/swarm_read_rpc_endpoint` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:rpc-constant/swarm_read_rpc_namespace` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:rpc-constant/swarm_read_rpc_protocol` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:rpc-constant/swarm_read_rpc_schema_dialect` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:rpc-constant/swarm_read_rpc_version` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | package-exported | `(unclassified)` |
| `public-capability:rpc-declaration/01-swarm_producer_capabilities_v1/control.write` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | unavailable | `(unclassified)` |
| `public-capability:rpc-declaration/01-swarm_producer_capabilities_v1/effect.cancel` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | unavailable | `(unclassified)` |
| `public-capability:rpc-declaration/01-swarm_producer_capabilities_v1/message.write` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | unavailable | `(unclassified)` |
| `public-capability:rpc-declaration/01-swarm_producer_capabilities_v1/receipt.read` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | profile-dependent | `(unclassified)` |
| `public-capability:rpc-declaration/01-swarm_producer_capabilities_v1/snapshot.read` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | profile-dependent | `(unclassified)` |
| `public-capability:rpc-declaration/02-readcapabilities/binding.read` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | profile-dependent | `(unclassified)` |
| `public-capability:rpc-declaration/02-readcapabilities/control.write` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | unavailable | `(unclassified)` |
| `public-capability:rpc-declaration/02-readcapabilities/effect.cancel` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | unavailable | `(unclassified)` |
| `public-capability:rpc-declaration/02-readcapabilities/message.write` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | unavailable | `(unclassified)` |
| `public-capability:rpc-declaration/02-readcapabilities/page.read` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | profile-dependent | `(unclassified)` |
| `public-capability:rpc-declaration/02-readcapabilities/snapshot.read` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | profile-dependent | `(unclassified)` |
| `public-capability:rpc-declaration/02-readcapabilities/status.read` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | profile-dependent | `(unclassified)` |
| `public-capability:rpc-declaration/03-projectioncapabilities/control.write` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | unavailable | `(unclassified)` |
| `public-capability:rpc-declaration/03-projectioncapabilities/effect.cancel` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | unavailable | `(unclassified)` |
| `public-capability:rpc-declaration/03-projectioncapabilities/message.write` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | unavailable | `(unclassified)` |
| `public-capability:rpc-declaration/03-projectioncapabilities/receipt.read` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | profile-dependent | `(unclassified)` |
| `public-capability:rpc-declaration/03-projectioncapabilities/snapshot.read` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | profile-dependent | `(unclassified)` |
| `public-capability:rpc-runtime/agentswarmreadrpcservice/binding.read` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | profile-dependent | `(unclassified)` |
| `public-capability:rpc-runtime/agentswarmreadrpcservice/control.write` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | profile-dependent | `(unclassified)` |
| `public-capability:rpc-runtime/agentswarmreadrpcservice/effect.cancel` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | profile-dependent | `(unclassified)` |
| `public-capability:rpc-runtime/agentswarmreadrpcservice/message.write` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | profile-dependent | `(unclassified)` |
| `public-capability:rpc-runtime/agentswarmreadrpcservice/page.read` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | profile-dependent | `(unclassified)` |
| `public-capability:rpc-runtime/agentswarmreadrpcservice/snapshot.read` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | profile-dependent | `(unclassified)` |
| `public-capability:rpc-runtime/agentswarmreadrpcservice/status.read` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | profile-dependent | `(unclassified)` |
| `public-capability:team-domain-port/acknowledgeassignment` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `public-capability:team-domain-port/acknowledgemessage` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `public-capability:team-domain-port/activateinitialassignment` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `public-capability:team-domain-port/addmemory` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `public-capability:team-domain-port/adoptbudget` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `public-capability:team-domain-port/archiveteam` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `public-capability:team-domain-port/cancelattempt` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `public-capability:team-domain-port/claimtask` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `public-capability:team-domain-port/consumetokens` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `public-capability:team-domain-port/createtask` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `public-capability:team-domain-port/createteam` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `public-capability:team-domain-port/findaccountingmembership` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `public-capability:team-domain-port/findmembership` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `public-capability:team-domain-port/findreadmembership` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `public-capability:team-domain-port/provisionmember` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `public-capability:team-domain-port/queuemessage` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `public-capability:team-domain-port/recordsessionusage` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `public-capability:team-domain-port/recordsessionusagebatch` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `public-capability:team-domain-port/recoverprovisioningmembers` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `public-capability:team-domain-port/reinstateattempt` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `public-capability:team-domain-port/removemember` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `public-capability:team-domain-port/requiremembership` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `public-capability:team-domain-port/requirereadmembership` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `public-capability:team-domain-port/retryattempt` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `public-capability:team-domain-port/reviewtask` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `public-capability:team-domain-port/setbudget` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `public-capability:team-domain-port/settlemember` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `public-capability:team-domain-port/snapshot` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `public-capability:team-domain-port/submittask` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `public-capability:team-domain-port/waitforchange` | public-capability | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `redline:no-pending-or-unknown-acknowledgement` | redline | REVIEWED | implemented | static | candidate | always-registered | `authority:project-contracts` |
| `redline:no-pending-or-unknown-redelivery` | redline | REVIEWED | implemented | static | candidate | always-registered | `authority:project-contracts` |
| `redline:no-rollback-after-admission` | redline | REVIEWED | implemented | static | candidate | always-registered | `authority:project-contracts` |
| `redline:storage-is-not-team-authority` | redline | REVIEWED | implemented | static | candidate | always-registered | `domain:agent-swarm` |
| `tool:agent_swarm_add_member` | model-tool | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `tool:agent_swarm_add_memory` | model-tool | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `tool:agent_swarm_add_personal_memory` | model-tool | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `tool:agent_swarm_archive` | model-tool | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `tool:agent_swarm_claim_task` | model-tool | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `tool:agent_swarm_create` | model-tool | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `tool:agent_swarm_create_task` | model-tool | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `tool:agent_swarm_interrupt_member` | model-tool | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `tool:agent_swarm_list_jobs` | model-tool | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `tool:agent_swarm_list_memory` | model-tool | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `tool:agent_swarm_list_tasks` | model-tool | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `tool:agent_swarm_reassign_task` | model-tool | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `tool:agent_swarm_remove_member` | model-tool | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `tool:agent_swarm_review_task` | model-tool | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `tool:agent_swarm_send_message` | model-tool | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `tool:agent_swarm_set_budget` | model-tool | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `tool:agent_swarm_status` | model-tool | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `tool:agent_swarm_submit_task` | model-tool | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |
| `tool:agent_swarm_wait` | model-tool | MECHANICAL / UNCLASSIFIED | implemented | none | not-candidate | always-registered | `(unclassified)` |

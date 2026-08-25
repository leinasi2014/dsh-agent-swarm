# M7-A Team memory and member profile vertical slice

Status: `IMPLEMENTED`

## Outcome

Deliver one bounded M7 slice without creating a second Agent runtime or a second memory authority:

- shared Team memory and member-owned personal memory remain records inside the authoritative `TeamDomainPort` aggregate;
- model tools can add and query memories, while the Captain UI receives only a bounded read projection;
- member creation records the runtime Provider separately from the LLM Provider/model, plus the creation-time deny snapshot and assigned Skill names;
- the official DSH Settings namespace owns optional semantic-query routing and future-member defaults;
- the official DSH Skill and LLM registries remain the availability and execution authorities.

The existing `TeamMember.provider` field is the continuable subagent runtime Provider. It is not an LLM Provider and must be labelled `runtimeProvider` in every new projection.

## Accepted source lessons

JiuwenSwarm contributes behavioral prior art only: personal/shared memory separation, bounded retrieval, evidence-bearing results, write-time masking and reviewed promotion. No Jiuwen runtime, transport or storage schema is imported.

LoopX `main` at focused reviewed commit `6aa2fb8a9fb97f0bfa6ee8b0ca6fabf6265bbe95` contributes three compatible principles: the dashboard is a projection rather than truth; a Provider supplies observations but does not own domain transitions; recalled memory is advisory evidence, not authorization or current task state. No LoopX runtime or public type is imported.

## Canonical schema

All new **Storage Domain** fields are additive optionals in schema version 1 so existing records reopen unchanged. This storage-compatibility claim does not imply R2 wire compatibility. The Storage Domain zod schema and `assertTeamState` must declare every field in the same change because the official load path strips undeclared object keys.

`TeamMember` adds:

- `llmProvider`, `model` and `modelSource`;
- `deniedTools`, the exact creation-time deny snapshot;
- `assignedSkills`, names only. Skill bodies and source paths remain official DSH Skill Registry state.

`TeamMemoryEntry` adds:

- `scope: team | member` (missing on an old record means `team`);
- `ownerSessionId` for member scope;
- `authorSessionId` for audit attribution.

Team memory is visible to active Team participants. Personal memory is visible to its owner and the Captain; another member cannot read it. Archived Team memory remains readable only through the existing archived-Captain read boundary. Removing a member does not delete their memory.

## Tool surface

- `agent_swarm_add_memory`: compatible shared-memory writer.
- `agent_swarm_add_personal_memory`: writes only the caller's personal memory; the Captain may specify an existing member owner.
- `agent_swarm_list_memory`: bounded deterministic list/search with scope, category, cursor and limit.
- optional semantic re-ranking considers only the already-authorized bounded candidate set and may return only candidate IDs. Timeout, missing route, malformed output or cancellation never becomes a false empty result; the response declares deterministic fallback and its diagnostic.

Memory content is data, never instructions. Search results do not change tasks, permissions, Skills or member configuration.

## Member creation and detail

`agent_swarm_add_member` accepts:

- `provider`: retained compatibility name for the continuable subagent runtime Provider;
- `llm_provider`, `model`;
- `deny_tools`;
- `skills`.

Skill assignment is a creation-time intent snapshot. The plugin validates names (including the 128-character R2 bound) against the official scoped Skill catalog before any roster record commits and adds a short instruction to the member persona to load those Skills through the official Skill tool when relevant. “Assigned” must not be rendered as “loaded”. Denied tool names likewise satisfy the 256-character R2 bound before commit.

The Captain member projection exposes name, role, phase, Session ID, runtime Provider, LLM selection/source, creation-time denied tools and assigned Skills. Raw member errors, credentials and paths never enter that projection. Role text is bounded to 256 code points with an explicit truncation marker. A separate Captain memory projection exposes at most 100 records; content is bounded to 2,048 code points and evidence to 64 references of 512 code points, again with explicit truncation markers. It is not mixed into member rows and does not perform semantic inference.

Explicit LLM Provider/model declarations are resolved through the official DSH LLM registry before a child identity or provisioning record is allocated. An absent route or half-declared pair fails `TEAM_MEMBER_MODEL_INVALID` with zero roster/name side effects. The runtime still owns the final child start and durable descriptor.

Per-task dynamic tool re-authorization is `NOT_SUPPORTED` on the current official continuation seam: `toolFilter` is fixed at `startContinuable`, and follow-up has no composition field. Task prose cannot expand or narrow authority. A future official follow-up composition seam is the re-evaluation trigger.

## Official Settings

Namespace: `agent-swarm`, installed with `installSettingsSection` and falling back to composition config when no Settings service exists.

The browser plugin contributes the keyed `agent-swarm` card through the official `settings.plugin.item` extension seam. It therefore appears in DSH Settings → Plugins → Plugin configuration only while the Host serves the same namespace. The card stages edits, validates semantic-route and numeric constraints, writes through `ctx.settingsScope`, reads the Host user layer back before clearing the draft, and follows the active DSH locale. It never edits the official DSH checkout or owns a second settings document.

The first section contains:

- semantic memory search enabled;
- semantic Provider/model;
- candidate and timeout bounds; result count and semantic output size remain fixed tool/runtime limits;
- default future-member runtime Provider, LLM Provider/model, denied tools and assigned Skills.

Provider credentials stay in official DSH Models settings. Settings changes affect subsequent queries and future member creation; they do not mutate existing members. A semantic helper call may be provider-billed and is not silently folded into Team execution token usage.

## Delivery sequence and acceptance

1. A0: additive schema, validation, authorization and reopen tests.
2. A1: shared/personal add and deterministic bounded query tools.
3. A2: member creation snapshot and bounded Captain projection.
4. A3: official Settings, Team UI projection, i18n and lifecycle tests.
5. A4: optional LLM re-ranking behind the Settings flag; deterministic fallback remains sufficient for availability.

Acceptance requires old-record reopen, N/N+1 bounds, cross-member denial, invalid Skill/model failure before commit, no runtime/LLM Provider confusion, no secret/raw-error projection, HMR/dispose stability, full project checks, a real official DSH Profile proof and one exact-candidate non-author QA. The Profile proof is scenario-bound: an empty Team proves only the empty branch. Member/profile acceptance requires one representative active member with visible Provider/model/deny/Skill fields; memory acceptance requires both one Team and one personal record with owner/evidence; Settings acceptance requires a real UI save plus read-back after page reload and after an official Profile restart. Synthetic P0 members prove bounded projection and persistence, not live subagent execution.

## R2 compatibility decision

M7-A is a private pre-release supersession of the R2 schema-v1 artifact, not a backward-compatible extension for already-independent v1 clients. Strict old clients correctly reject the new member/memory projection. During this pre-release phase, the DSH UI, Canvas and any other consumer must upgrade as one exact plugin/package/digest set and fail closed when `SWARM_READ_RPC_CONTRACT_DIGEST_V1` differs.

Before M9 permits independently versioned or public consumers, the project must either freeze the final v1 shape or introduce a negotiated v2 route/artifact. A published v1 must never be silently changed in place.

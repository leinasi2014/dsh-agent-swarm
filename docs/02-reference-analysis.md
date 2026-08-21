# 02. Reference analysis

## 1. Three references, three different roles

| Reference | Role in this project | What not to do |
|---|---|---|
| Official DeepSeek Harness | Framework contract and long-term compatibility target | Do not assume experimental packages are published APIs |
| `NanmiCoder/dsh-agent-teams` | Direct implementation reference and migration source | Do not preserve its monolithic package boundaries blindly |
| `openJiuwen-ai/jiuwenswarm` | Product/architecture prior art for higher-level features | Do not embed its Python Runtime or duplicate DSH capabilities |

## 2. Community dsh-agent-teams

### Strengths to retain

- Captain/member semantics map naturally to DSH continuable subagents.
- Real `agent/status` edges drive work assignment.
- Task dependencies prevent premature claim.
- `attemptId` acts as a capability/fencing token for each execution generation.
- Reassignment invalidates old workers before a new attempt begins.
- Mailbox persistence precedes best-effort live delivery.
- Per-member provider/model/reasoning snapshots survive cold resume.
- Stress tests model interruptions, stale writes, claim contention and restart.

### Boundaries to refactor

- State, scheduler, tools, prompt, HTTP and UI are coupled in one package.
- File storage and process-local locks are implementation details exposed as architecture.
- The plugin owns a custom Team lifecycle rather than consuming a stable team seam.
- Shared checkout is assumed.
- Completion is primarily model-declared.
- Budget, verification, team memory and distributed worker contracts are absent.

### Migration strategy

Do not begin with a rewrite. First extract executable characterization tests for:

1. member creation/recovery;
2. task DAG and claim rules;
3. attempt invalidation;
4. mailbox ordering and de-duplication;
5. safe member removal and team disposal;
6. event-driven automatic assignment.

Then move each responsibility behind an interface while keeping those tests green.

## 3. Official experimental Agent Team

Official DSH now has `ctx.agentTeams` under `packages/experimental/agent-team`. Its important design choices are:

- every ordinary root Session is the implicit Team Lead;
- Team identity derives from the root Session id;
- teammate Session id is the persistent identity; name is an immutable label;
- roster, task board and queued mailbox live in the Lead Session log;
- task mutations use `expectedRevision` compare-and-set;
- mailbox delivery records queued then delivered facts and de-duplicates by stable source;
- task `writeScopes` are advisory overlap warnings, not filesystem authority;
- `waitForChange()` provides bounded observation without another polling protocol.

Current limitations include one process/shared checkout, no remote member, no Worktree/merge, no automatic owner release and no cross-process exactly-once mailbox.

### Consequence for this project

The official seam should own the canonical Team domain if it becomes a published product API. `dsh-agent-swarm` should add policy and providers around it. Since M1A the runtime consumes one `TeamDomainPort` whose production Provider persists through the official Storage Domain (`agent_swarm` domain, one versioned Team aggregate per record); the workspace `FileTeamStore` survives only as a read-only migration reader. A future official backend can replace the selected Provider behind the same port without creating a second authority.

## 4. JiuwenSwarm / WorkSwarm

The latest upstream design contributes useful concepts:

- SwarmFlow: deterministic script-driven multi-agent workflow;
- parallel, pipeline, nested workflow and stateful agent session primitives;
- human/human-session nodes;
- team token budget with spent/remaining queries;
- `isolation=worktree` for parallel coding;
- local/distributed Team modes with registry reservation and bootstrap ACK;
- personal memory plus read-only shared Team memory;
- idle-time Dreaming consolidation;
- skill evolution from failures and user corrections;
- tiered tool permissions.

Most of these already have a natural DSH home:

| Jiuwen concept | DSH home |
|---|---|
| SwarmFlow | published `ctx.workflowEngine` plus a Team bridge Consumer |
| stateful member | `ctx.subagents` continuable child |
| human node | `ctx.userQuestions` / `ctx.approval` |
| background run | `ctx.jobs` |
| token accounting | published `ctx.tokenMeter` faces characterized in M4-1 (issue #127): host-side metering only — the Team budget's per-seq Session fold stays the single measurement path, with parity proven and the failed-request chunk divergence declared |
| context offload | `ctx.compaction` / spill |
| skills | `ctx.skills`; evolution adds a writer/proposal Consumer |
| shared state | Session log or `ctx.storageDomain` |
| remote worker | subagent DSH SDK/ACP Provider or Team Member Provider |

## 5. Combined insight

The correct synthesis is not “dsh-agent-teams plus JiuwenSwarm code.” It is:

```text
Official DSH seams define the execution world.
Community dsh-agent-teams contributes proven Team coordination mechanics.
JiuwenSwarm contributes product-level orchestration features and failure cases.
New plugins connect those concepts without duplicating the seams DSH already owns.
```

For self-hosting, the direct reference contributes Team durability/fencing/lifecycle cases and Jiuwen contributes Worktree/permission/review/distributed behavior. Neither reference becomes the control or deployment runtime. ADR-0008 composes those behaviors through official DSH Profiles, RPC, Workflow/Jobs, Workspace linkage, Subagent Providers and interaction seams while an external last-known-good controller owns candidate promotion.

## 6. Current fusion status

The two reference repositories are both present and pinned, but their strengths are only partially fused:

- the 0.1 core implements continuable members, DAG tasks, revision/attempt fencing, durable-before-delivery mailbox state, budgets, a mandatory review transition, structured memory records and provider registries;
- real Agent idle state is only a wake signal; Scheduler availability currently checks Team ownership, not the live `agent.status` value;
- persisted-child-aware provisioning recovery now follows the official four-factor reconciliation — the persisted child proves the exact parent Session, a continuable descriptor, the provisioned provider and a durably accepted initial user prompt, activating the orphan as a member or failing it with an explicit drain (M1B/F3, template in §7.1) — and target-side mailbox identity de-duplication now folds the target's durable inbox/history on the stable framed message id before any resend (M1B/F2, following the official template in §7.1 but matching the exact framed text instead of merging `TeamMessageSource`);
- Jiuwen workflow operators, human nodes, Worktree execution, distributed control/data planes, tiered team permissions, automatic Team-memory extraction, skill evolution and UI are not implemented;
- the current memory API is manual structured storage, not Jiuwen personal/shared memory or automatic round-end extraction.
- no stable-control/candidate-acceptance self-hosting pipeline is implemented; D0-D4 remain roadmap readiness labels.

The detailed evidence and conflict matrix are in `10-fusion-audit.md`.

## 7. 2026-08-20 three-source inventory delta (new findings beyond the tables above)

Verified against the pinned checkouts (`141eb6f` / `801954d` / `20097e8`); each item cites its source file. These feed the milestone placements recorded in `10-fusion-audit.md` §11.

### 7.1 Official DSH — Agent Teams semantic details beyond the known surface

- Target-side de-duplication mechanism: `TeamMessageSource` (kind/teamId/messageId/senderName) merged into the dsh-llm `MessageSourceMap` via declaration merging (`packages/experimental/agent-team/src/types.ts:110-122`); delivery folds the target's live or persisted inbox/history (including `agent/inbox/spliced` projections, `src/session-message.ts:9-31`) and acknowledges without resend when already present — the M1B/F2 implementation template.
- Persisted-child provisioning protocol: `spawnAdmitted` commits the `provisioning` member before `startContinuable`, `checkpointInitialPrompt` flushes/waits until the initial prompt is a durable user message in the child log, and creation/settlement races surface as `TEAM_PROVISIONING_CONFLICT`; `reconcileProvisioning` settles each still-provisioning member from the persisted child log alone — `parentSession` equals the Lead, the folded descriptor is continuable with the recorded provider, and a user-source message was durably accepted — activating on full match, failing otherwise, and skipping live children whose creator owns the terminal edge (`src/roster.ts:244-431`) — the M1B/F3 implementation template. The projection-backed `ctx.subagents.listChildren/listDescendants` enumeration is the official live-preferred child-discovery seam (`@deepseek-ai/dsh-subagent`, requires the optional `sessionProjections` registry).
- Receipt ordering: the `team/message/delivered` receipt flushes the target Session before the Lead log is written; dispatch registration happens inside the durable transaction so concurrent senders serialize per target in durable queue order (`src/mailbox.ts:141-148, 279-305`).
- quiet/wakeup: quiet messages may overtake an earlier active dispatch in order (`messagePrecedes`, `src/mailbox.ts:190-196`); an inactive target's quiet message stays queued forever and is skipped by Lead recovery (`src/mailbox.ts:250-253, 84-98`).
- Limit semantics: `maxMembers=8` counts every ever-provisioned name (never reusable), `maxTasks=256` counts only undeleted tasks, `maxMessageBytes=65536` covers the complete framed delivery (`src/index.ts:41-65`).
- `waitForChange`: 10s–1h window, `{timedOut}` single-value contract, never replays edges that already happened, `TEAM_WAIT_ABORTED` structured cancellation (`src/activity.ts:22-86`).
- Lead-only `interrupt` is keepInbox: cancels the current turn without releasing task ownership or deleting durable mail (`src/roster.ts:203-214`).
- Task board: 8 CAS actions (claim/release/edit/set_dependencies/complete/reopen/reassign[Lead-only]/delete-with-tombstone) plus `TEAM_TASK_HAS_DEPENDENTS` delete protection (`src/task-board.ts:176-202`); `task-<n>` exhaustion is loud (`TEAM_TASK_LIMIT`).
- `./invariant` companion plugin validates candidate Team events pre-append against the committed prefix through the package-level `ctx.invariants` registry (`src/invariant.ts:16-35`).
- Tool layer model experience: `wait_agent` returns an immediate `noProgress` short-circuit when no peer is active; `team_task_list` supports status/owner/ready filters with cursor pagination; every tool declares a full output schema rendered compactly (`packages/experimental/tool-agent-team/src/index.ts:134-387`).
- Explicitly deleted surfaces (negative boundary, simplification note 2026-08-12): `TeamSnapshot`, global revision, `team/changed` events and snapshot timestamps do not exist officially; this plugin's revision CAS is an intentional superset and must be mapped by the future official adapter.

### 7.2 dsh-agent-teams — behavior beyond the §2 tables

- `/agent-teams` deterministic activation: closed-namespace command via `ctx.commands` plus a `agent/pre-step` waterfall gesture boundary that only honors a leading, whitespace-bounded token in genuine `source.kind === 'user'` turns (`src/command.ts:54, 99-149`); `slashCommand: false` disables both.
- HTTP/command face: `GET /plugins/dsh-agent-teams/state` (exact, `?archived=1`) and an allowlisted assets route; web services are discovered lazily across `webServer|httpServer` renames with `internal/service` retries so headless profiles stay tool-only (`src/index.ts:159-252`).
- `steerCaptainReport`: member reports are injected at the captain's latest model boundary via `Agent.steer()`, falling back to the mailbox; `agent_teams_send_message` returns a three-state `delivered: 'live' | 'wake' | 'mailbox'` (`src/tools.ts:206-217, 843`).
- Member LLM selection: `reasoningEffort` inheritance (same route inherits the captain's current effort; changed route omits it; explicit wins; `"default"` forces the target default) validated through `ctx.llm.resolveCallConfig` before child creation (`src/members.ts:124-185`); cold-resume resolves the `agent-teams:<teamId>:<memberName>` label against the saved descriptor and fails loud on route mismatch (`src/members.ts:194-254`).
- Retired-member guard: `ctx.subagents.listChildren/listDescendants/followup` are wrapped so retired ids disappear from catalogs and `followup` throws `NOT_RESUMABLE` (`src/members.ts:422-463`).
- Scheduler discipline: per-member serial queues deliver **mailbox backlog before new assignments**; rollback of a failed dispatch is CAS-guarded on the attempt id; an idle member still holding an open task is retried under a fresh attempt (`src/scheduler.ts:139-234`).
- Unicode member keys: NFC normalization plus `\p{L}\p{N}` whitelist (non-Latin names stay distinct), 48-codepoint cap with digest suffix (`src/state.ts:52-87`).
- Session-event vocabulary degrades gracefully: host-unknown event types are silently omitted (debug-once per type) while disk stays authoritative (`src/events.ts`).
- Protocol guards: one captain one team **and** one participant one team; claim authorization is checked before idempotent returns; captains cannot directly update member-held tasks; reassign is double-guarded (reassigning flag + handoff CAS); terminal tasks are idempotent-immutable (`src/tools.ts:596-837`).
- Verification corpus: `scripts/{verify,lifecycle-verify,stress-verify}.mjs` enumerate ~60 named fault scenarios (gesture forging, cold restart with open tasks, 50 late writes, claim storms, archive三代, Windows real file-lock retries) — reference material for M1B/M1D fault suites and the M1D regression review.
- Packaging contract for the eventual public release: all peerDependencies optional, client bundle purity gates (no `@deepseek-ai/*` value imports outside platform modules), OIDC npm publish, skills dual-directory sync check (`scripts/verify.mjs` §1, `.github/workflows/publish.yml`).

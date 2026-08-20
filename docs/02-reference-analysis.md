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

The official seam should own the canonical Team domain if it becomes a published product API. `dsh-agent-swarm` should add policy and providers around it. The current 0.1 runtime does **not** yet implement that adapter boundary: it constructs its own `TeamDomain` over a workspace `FileTeamStore`. ADR-0007 makes `TeamDomainPort`, official Storage Domain persistence and a one-way migration the first M1 stage; a future official backend can then replace the selected Provider without creating a second authority.

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
| token accounting | published `ctx.tokenMeter` projection + Team budget policy; direct Session folding remains a compatible 0.1 implementation detail |
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
- target-side mailbox identity de-duplication across a process crash and persisted-child-aware provisioning recovery are not yet at official/community parity;
- Jiuwen workflow operators, human nodes, Worktree execution, distributed control/data planes, tiered team permissions, automatic Team-memory extraction, skill evolution and UI are not implemented;
- the current memory API is manual structured storage, not Jiuwen personal/shared memory or automatic round-end extraction.
- no stable-control/candidate-acceptance self-hosting pipeline is implemented; D0-D4 remain roadmap readiness labels.

The detailed evidence and conflict matrix are in `10-fusion-audit.md`.

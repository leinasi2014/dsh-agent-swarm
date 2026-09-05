/**
 * Model-experience read surface tools (issue #74 split of src/tools.ts, shape
 * from issue #15 / docs/04 §8e): fixed-size Team counters and the paginated,
 * filtered task row list with evidence-only stranded hints. Issue #93 adds
 * the jobs reader: the same filtered/paginated compact-JSON contract over the
 * caller-scoped TeamJobProjection (never over the authoritative domain directly). The
 * memory reader is a bounded projection of the same authoritative aggregate.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { JobSnapshot, JobStatus } from '@deepseek-ai/dsh-jobs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { expectDomain, TeamDomainError } from '../domain/error.js'
import { taskHoldEvidence } from '../domain/team-domain-budget.js'
import type { TeamMemoryEntry, TeamState, TeamTask } from '../domain/types.js'
import type { AgentSwarmRuntime } from '../runtime/orchestrator-runtime.js'
import { requireAgent } from '../runtime/authority.js'
import { compactJsonOutput, register } from './shared.js'

/** One compact task row (issue #15): the `team_task_list` view over our CAS fields. */
const TASK_ROW_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    task_id: { type: 'string', required: true },
    revision: { type: 'number', required: true },
    subject: { type: 'string', required: true },
    description: { type: 'string', required: true },
    status: {
      type: 'string', required: true,
      enum: ['pending', 'in_progress', 'submitted', 'verifying', 'completed', 'failed', 'cancelled'],
    },
    ready: { type: 'boolean', required: true },
    blocked_by: { type: 'array', required: true, items: { type: 'string' } },
    owner: { type: 'string', description: 'Member name, or captain when the captain holds it.' },
    target_member: { type: 'string', description: 'Strict captain-selected member, including while the task is blocked or pending. Omit at creation to declare generic work any available member may execute.' },
    attempt_id: { type: 'string' },
    stranded: { type: 'string', enum: ['idle-holder', 'owner-not-live'] },
    hold: {
      type: 'string',
      enum: ['budget', 'reservation'],
      description: 'Evidence-only budget hold (M4-3): budget = mid-execution while the Team budget face is exhausted (continues after the captain raises the budget); reservation = pending with a reservation floor that does not fit the remaining headroom.',
    },
  },
} as const

const TASK_LIST_VALUE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    tasks: { type: 'array', required: true, items: TASK_ROW_SCHEMA },
    next_cursor: { type: 'number', description: 'Present only when more filtered rows exist.' },
  },
} as const

/** One durable Team-memory row, in its stored creation order. */
const MEMORY_ROW_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    memory_id: { type: 'string', required: true },
    category: { type: 'string', required: true, enum: ['decision', 'lesson', 'member', 'context'] },
    content: { type: 'string', required: true },
    evidence_refs: { type: 'array', required: true, items: { type: 'string' } },
    evidence_refs_truncated: { type: 'boolean', required: true },
    created_at: { type: 'number', required: true },
  },
} as const

const MEMORY_LIST_VALUE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    memories: { type: 'array', required: true, items: MEMORY_ROW_SCHEMA },
    next_cursor: { type: 'number', description: 'Present only when more filtered rows exist.' },
  },
} as const

/** One safe, durable-composition member row; raw persona never reaches a tool result. */
const MEMBER_PROFILE_ROW_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    role: { type: 'string', required: true },
    phase: { type: 'string', required: true, enum: ['provisioning', 'active', 'failed', 'removed'] },
    created_at: { type: 'number', required: true },
    profile_state: { type: 'string', required: true, enum: ['available', 'pending', 'unavailable', 'invalid'] },
    profile_reason: {
      type: 'string', required: true,
      enum: ['available', 'provisioning', 'startup_failed', 'removed', 'inspection_failed', 'active_session_missing', 'binding_invalid', 'descriptor_invalid', 'not_continuable', 'tool_filter_invalid'],
    },
    runtime_provider: { type: 'string', required: true, description: 'Team provisioning/recovery Provider; available rows verify it against the official continuable descriptor. Not the LLM provider.' },
    llm_provider: { type: 'string', description: 'Optional LLM provider recorded in the continuable descriptor.' },
    model: { type: 'string', description: 'Optional model recorded in the continuable descriptor.' },
    preset_id: { type: 'string', description: 'Optional preset id recorded in the immutable Session header.' },
    persona_configured: { type: 'boolean', description: 'Whether the descriptor records a persona; the persona text is never returned.' },
    denied_tools: { type: 'array', items: { type: 'string' }, description: 'Declared deny-only child filter, not an effective capability set.' },
  },
} as const

const MEMBER_PROFILE_LIST_VALUE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    members: { type: 'array', required: true, items: MEMBER_PROFILE_ROW_SCHEMA },
    next_cursor: { type: 'number', description: 'Present only when more filtered rows exist.' },
  },
} as const

/** Shared bounded cursor contract for aggregate-backed list readers. */
export function pageWindow(args: { cursor?: number; limit?: number }): { cursor: number; limit: number } {
  const cursor = args.cursor ?? 0
  const limit = args.limit ?? 50
  expectDomain(Number.isSafeInteger(cursor) && cursor >= 0, 'cursor must be a non-negative safe integer', 'TEAM_INPUT_INVALID')
  expectDomain(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'limit must be an integer from 1 through 100', 'TEAM_INPUT_INVALID')
  return { cursor, limit }
}

/** More conservative page bound because each requested row reads one Session log. */
function memberPageWindow(args: { cursor?: number; limit?: number }): { cursor: number; limit: number } {
  const cursor = args.cursor ?? 0
  const limit = args.limit ?? 25
  expectDomain(Number.isSafeInteger(cursor) && cursor >= 0, 'cursor must be a non-negative safe integer', 'TEAM_INPUT_INVALID')
  expectDomain(Number.isSafeInteger(limit) && limit >= 1 && limit <= 50, 'limit must be an integer from 1 through 50', 'TEAM_INPUT_INVALID')
  return { cursor, limit }
}

/** Preserve evidence order while bounding one reader row from legacy input. */
function memoryRow(memory: TeamMemoryEntry) {
  const evidenceRefs = memory.evidenceRefs.slice(0, 32)
  return {
    memory_id: memory.id,
    category: memory.category,
    content: memory.content,
    evidence_refs: evidenceRefs,
    evidence_refs_truncated: evidenceRefs.length < memory.evidenceRefs.length,
    created_at: memory.createdAt,
  }
}

/** Adapt the evidence-only stranded hint (docs/04 §8c) into one row field. */
function strandedHint(runtime: AgentSwarmRuntime, task: TeamTask):
  { stranded: 'idle-holder' | 'owner-not-live' } | Record<string, never> {
  const evidence = runtime.strandedEvidence(task).trim()
  return evidence === '' ? {} : { stranded: evidence.slice('stranded='.length) as 'idle-holder' | 'owner-not-live' }
}

/** `agent_swarm_status`. */
export function registerStatusTool(ctx: Context, runtime: AgentSwarmRuntime): void {
  register(ctx, defineTool({
    name: 'agent_swarm_status',
    description: 'Active-Team-participant or archived-Captain only. Read the fixed-size Team counters: roster size, task counts by outcome, readiness, queued mail, budgets and memory. Task rows — owners, attempts, filters, pagination — come from agent_swarm_list_tasks; this summary never embeds them. A managed Main Brain remains outside the Team and must use agent_swarm_list_managed_teams or the Host Team UI instead.',
    parameters: {},
    output: compactJsonOutput({
      type: 'object', additionalProperties: false,
      properties: {
        team_id: { type: 'string', required: true },
        name: { type: 'string', required: true },
        revision: { type: 'number', required: true },
        members: { type: 'number', required: true },
        tasks: { type: 'number', required: true },
        completed_tasks: { type: 'number', required: true },
        ready_tasks: { type: 'number', required: true },
        queued_messages: { type: 'number', required: true },
        obsolete_messages: { type: 'number', required: true, description: 'Mail settled obsolete by the admission funnel or an explicit supersede (real terminal state, never counted as queued).' },
        memory_entries: { type: 'number', required: true },
        used_tokens: { type: 'number', required: true },
        used_requests: { type: 'number', required: true },
        used_retries: { type: 'number', required: true },
      },
    }),
    async execute(_args, exec) {
      const snapshot = await runtime.status(exec)
      return {
        team_id: snapshot.team.id,
        name: snapshot.team.name,
        revision: snapshot.team.revision,
        members: snapshot.team.members.filter(member => member.phase === 'active').length,
        tasks: snapshot.team.tasks.length,
        completed_tasks: snapshot.team.tasks.filter(task => task.status === 'completed').length,
        ready_tasks: snapshot.readyTaskIds.length,
        queued_messages: snapshot.pendingMessageIds.length,
        obsolete_messages: snapshot.team.messages.filter(message => message.phase === 'obsolete').length,
        memory_entries: snapshot.team.memory.length,
        used_tokens: snapshot.team.budget.usedTokens,
        used_requests: snapshot.team.budget.usedRequests,
        used_retries: snapshot.team.budget.usedRetries,
      }
    },
  }), 'status tool')
}

/** `agent_swarm_list_tasks`. */
export function registerListTasksTool(ctx: Context, runtime: AgentSwarmRuntime): void {
  register(ctx, defineTool({
    name: 'agent_swarm_list_tasks',
    description: 'List Team tasks with optional status/owner/ready filters and cursor pagination. Rows are compact and bounded (limit 1-100, default 50); use next_cursor to continue. Prefer this over reading full status for task inspection.',
    parameters: {
      status: { type: 'string', enum: ['pending', 'in_progress', 'submitted', 'verifying', 'completed', 'failed', 'cancelled'], description: 'Optional exact status filter.' },
      owner: { type: 'string', description: 'Optional member-name filter; use "unowned" for tasks without an owner.' },
      ready: { type: 'boolean', description: 'Optional readiness filter.' },
      cursor: { type: 'integer', description: 'Zero-based result offset. Defaults to 0.' },
      limit: { type: 'integer', description: 'Number of rows, 1 through 100. Defaults to 50.' },
    },
    output: compactJsonOutput(TASK_LIST_VALUE_SCHEMA),
    async execute(args, exec) {
      const { cursor, limit } = pageWindow(args)
      const snapshot = await runtime.status(exec)
      const ownerNames = new Map(snapshot.team.members.map(member => [member.sessionId, member.name]))
      const readyIds = new Set(snapshot.readyTaskIds)
      const filtered = snapshot.team.tasks.filter(task =>
        (args.status === undefined || task.status === args.status)
        && (args.owner === undefined || (args.owner === 'unowned'
          ? task.ownerSessionId === undefined
          : ownerNames.get(task.ownerSessionId ?? '') === args.owner))
        && (args.ready === undefined || readyIds.has(task.id) === args.ready))
      const tasks = filtered.slice(cursor, cursor + limit).map(task => {
        const hold = taskHoldEvidence(snapshot.team.budget, snapshot.team.tasks, task, Date.now())
        return {
          task_id: task.id,
          revision: task.revision,
          subject: task.subject,
          description: task.description,
          status: task.status,
          ready: readyIds.has(task.id),
          blocked_by: task.blockedBy,
          ...(task.targetMemberSessionId === undefined ? {} : { target_member: ownerNames.get(task.targetMemberSessionId) ?? 'unknown' }),
          ...(task.ownerSessionId === undefined ? {} : { owner: ownerNames.get(task.ownerSessionId) ?? 'captain' }),
          ...(task.currentAttemptId === undefined ? {} : { attempt_id: task.currentAttemptId }),
          ...strandedHint(runtime, task),
          ...(hold === undefined ? {} : { hold }),
        }
      })
      return { tasks, ...(cursor + limit < filtered.length ? { next_cursor: cursor + limit } : {}) }
    },
  }), 'list-tasks tool')
}

/** `agent_swarm_list_memory`: bounded, membership-authorized Team memory reads. */
export function registerListMemoryTool(ctx: Context, runtime: AgentSwarmRuntime): void {
  register(ctx, defineTool({
    name: 'agent_swarm_list_memory',
    description: 'List durable Team memories in creation order with optional category and case-insensitive content-substring filters. Rows are bounded by cursor pagination (limit 1-100, default 50); use next_cursor to continue. This reads the current Team only and never performs semantic search or changes memory.',
    parameters: {
      category: { type: 'string', enum: ['decision', 'lesson', 'member', 'context'], description: 'Optional exact category filter.' },
      query: { type: 'string', description: 'Optional case-insensitive literal substring filter over memory content; not semantic search.' },
      cursor: { type: 'integer', description: 'Zero-based result offset. Defaults to 0.' },
      limit: { type: 'integer', description: 'Number of rows, 1 through 100. Defaults to 50.' },
    },
    output: compactJsonOutput(MEMORY_LIST_VALUE_SCHEMA),
    async execute(args, exec) {
      const { cursor, limit } = pageWindow(args)
      const query = args.query?.trim()
      expectDomain(query === undefined || (query !== '' && [...query].length <= 1_024), 'query must contain at most 1024 non-whitespace characters', 'TEAM_INPUT_INVALID')
      const normalizedQuery = query?.toLowerCase()
      // `status` is the established reader-membership/runtime readiness
      // boundary. This projection intentionally only slices its durable
      // aggregate: no list call writes state or invents a second memory owner.
      const snapshot = await runtime.status(exec)
      const filtered = snapshot.team.memory.filter(memory =>
        (args.category === undefined || memory.category === args.category)
        && (normalizedQuery === undefined || memory.content.toLowerCase().includes(normalizedQuery)))
      const memories = filtered.slice(cursor, cursor + limit).map(memoryRow)
      return { memories, ...(cursor + limit < filtered.length ? { next_cursor: cursor + limit } : {}) }
    },
  }), 'list-memory tool')
}

/** `agent_swarm_list_members`: durable child-composition facts, never a live-control surface. */
export function registerListMembersTool(ctx: Context, runtime: AgentSwarmRuntime): void {
  register(ctx, defineTool({
    name: 'agent_swarm_list_members',
    description: 'List Team roster members in stable roster order with optional phase filtering and bounded cursor pagination (limit 1-50, default 25). Each page reads only its members’ durable official Session header and continuable descriptor; unavailable or invalid rows stay row-local. This never resumes, wakes, repairs, or changes a member. persona text, private memory, Skill assignment, and effective tool permissions are not exposed.',
    parameters: {
      phase: { type: 'string', enum: ['provisioning', 'active', 'failed', 'removed'], description: 'Optional exact roster phase filter.' },
      cursor: { type: 'integer', description: 'Zero-based result offset. Defaults to 0.' },
      limit: { type: 'integer', description: 'Number of rows, 1 through 50. Defaults to 25.' },
    },
    output: compactJsonOutput(MEMBER_PROFILE_LIST_VALUE_SCHEMA),
    async execute(args, exec) {
      const { cursor, limit } = memberPageWindow(args)
      const listed = await runtime.listMemberProfiles(exec, {
        cursor,
        limit,
        ...(args.phase === undefined ? {} : { phase: args.phase }),
      })
      const members = listed.members.map(member => ({
        name: member.name,
        role: member.role,
        phase: member.phase,
        created_at: member.createdAt,
        profile_state: member.profileState,
        profile_reason: member.profileReason,
        runtime_provider: member.runtimeProvider,
        ...(member.llmProvider === undefined ? {} : { llm_provider: member.llmProvider }),
        ...(member.model === undefined ? {} : { model: member.model }),
        ...(member.presetId === undefined ? {} : { preset_id: member.presetId }),
        ...(member.personaConfigured === undefined ? {} : { persona_configured: member.personaConfigured }),
        ...(member.deniedTools === undefined ? {} : { denied_tools: [...member.deniedTools] }),
      }))
      return { members, ...(listed.nextCursor === undefined ? {} : { next_cursor: listed.nextCursor }) }
    },
  }), 'list-members tool')
}

/** One compact managed/owned Team row the caller may enumerate (identity + phase + goal + counts). */
const MANAGED_TEAM_ROW_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    team_id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    phase: { type: 'string', required: true, enum: ['staged', 'active', 'archived'] },
    captain_session_id: { type: 'string', required: true, description: 'Official dedicated Captain Session navigation id; open it via the official Session seam.' },
    managed_origin: { type: 'string', description: 'Managed-Team operation identity; present only on agent_swarm_create_managed Teams (absent for captain-owned compat Teams).' },
    display_name: { type: 'string', description: 'Captain display name; present only when the Captain declared an identity profile.' },
    profession: { type: 'string', description: 'Captain profession; present only when the Captain declared an identity profile.' },
    personality: { type: 'string', description: 'Captain personality; present only when the Captain declared an identity profile.' },
    goal: {
      type: 'object', additionalProperties: false,
      properties: {
        state: { type: 'string', required: true, enum: ['generated', 'not_generated'] },
        text: { type: 'string', description: 'Canonical public goal text; present only when state is generated.' },
        reason: { type: 'string', description: 'Stable reason; present only when state is not_generated.' },
      },
    },
    member_count: { type: 'number', required: true, description: 'Active roster members (count only, never rows).' },
    task_count: { type: 'number', required: true, description: 'Total Team tasks (count only, never rows).' },
  },
} as const

const MANAGED_TEAM_LIST_VALUE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    teams: { type: 'array', required: true, items: MANAGED_TEAM_ROW_SCHEMA },
    next_cursor: { type: 'number', description: 'Present only when more visible Teams exist.' },
  },
} as const

/** The public-goal summary: canonical text when set, an honest `not_generated` marker otherwise. */
function publicGoalSummary(team: TeamState): { state: 'generated'; text: string } | { state: 'not_generated'; reason: 'goal_not_set' } {
  return team.publicGoal === undefined
    ? { state: 'not_generated', reason: 'goal_not_set' }
    : { state: 'generated', text: team.publicGoal }
}

/**
 * `agent_swarm_list_managed_teams`: the read-only enumeration that lets a Main
 * Brain root (which sits outside every Team, so the membership-bounded readers
 * cannot see its Teams) list the managed Teams it owns/oversees. The runtime
 * reapplies the exact Host visibility predicate to the live `exec.agent`
 * (never caller text): a Team is listed iff the caller is its Captain, a
 * managed dedicated Captain child of the caller, or the persisted parent of
 * its Captain — otherwise it is dropped fail-closed. Scope is the caller's
 * workspace only; multi-Team is legal, zero is an explicit empty list. Rows
 * carry Team/Captain identity (with the official Captain Session navigation
 * id), phase, public goal summary, and member/task counts — counts only, never
 * task/member rows.
 */
export function registerListManagedTeamsTool(ctx: Context, runtime: AgentSwarmRuntime): void {
  register(ctx, defineTool({
    name: 'agent_swarm_list_managed_teams',
    description: 'Read-only list of the managed/owned Teams visible to the caller. A Team is listed iff the caller is its Captain, a managed dedicated Captain child of the caller, or the persisted parent of its Captain; anything else is dropped fail-closed with no foreign metadata leak, within the caller\'s workspace scope only. Returns Team/Captain identity (including the official Captain Session navigation id), phase, public goal summary, and active-member/task counts, with cursor pagination (limit 1-100, default 50).',
    parameters: {
      cursor: { type: 'integer', description: 'Zero-based result offset. Defaults to 0.' },
      limit: { type: 'integer', description: 'Number of rows, 1 through 100. Defaults to 50.' },
    },
    output: compactJsonOutput(MANAGED_TEAM_LIST_VALUE_SCHEMA),
    async execute(args, exec) {
      const { cursor, limit } = pageWindow(args)
      const teams = await runtime.listManagedTeams(exec)
      const rows = teams.slice(cursor, cursor + limit).map(team => ({
        team_id: team.id,
        name: team.name,
        phase: team.phase,
        captain_session_id: team.captainSessionId,
        ...(team.managedOrigin === undefined ? {} : { managed_origin: team.managedOrigin }),
        ...(team.captainProfile?.displayName === undefined ? {} : { display_name: team.captainProfile.displayName }),
        ...(team.captainProfile?.profession === undefined ? {} : { profession: team.captainProfile.profession }),
        ...(team.captainProfile?.personality === undefined ? {} : { personality: team.captainProfile.personality }),
        goal: publicGoalSummary(team),
        member_count: team.members.filter(member => member.phase === 'active').length,
        task_count: team.tasks.length,
      }))
      return { teams: rows, ...(cursor + limit < teams.length ? { next_cursor: cursor + limit } : {}) }
    },
  }), 'list-managed-teams tool')
}

/**
 * The status vocabulary the projection can emit (projection-derive maps every
 * non-terminal task state to `running` and never fabricates `stopping`).
 * A snapshot outside this set would violate the derivation contract, so the
 * row builder fails loud instead of widening the canonical output schema.
 */
const PROJECTED_JOB_STATUSES = ['running', 'completed', 'failed', 'killed'] as const
type ProjectedJobStatus = typeof PROJECTED_JOB_STATUSES[number]

/** Narrow one official job status onto the projection's emitted vocabulary. */
function projectedJobStatus(status: JobStatus): ProjectedJobStatus {
  const narrow = PROJECTED_JOB_STATUSES.find(candidate => candidate === status)
  if (narrow === undefined) {
    throw new TeamDomainError(
      `the Team job projection emitted the unsupported status ${JSON.stringify(status)}`,
      'TEAM_JOBS_PROJECTION_INVALID',
    )
  }
  return narrow
}

/** One compact projected job row: the official `JobSnapshot` read face, snake_cased. */
const JOB_ROW_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    job_id: { type: 'string', required: true, description: 'Projection-issued id, reads team-task-N.' },
    kind: { type: 'string', required: true },
    label: { type: 'string', required: true, description: 'The task subject.' },
    status: { type: 'string', required: true, enum: PROJECTED_JOB_STATUSES },
    detail: { type: 'string', description: 'Task/attempt correlation plus the settling diagnostic.' },
    started_at: { type: 'number', required: true, description: 'Epoch ms of the earliest attempt of the task.' },
    finished_at: { type: 'number', description: 'Epoch ms of the terminal transition; absent while live.' },
  },
} as const

const JOB_LIST_VALUE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    jobs: { type: 'array', required: true, items: JOB_ROW_SCHEMA },
    next_cursor: { type: 'number', description: 'Present only when more filtered rows exist.' },
  },
} as const

/**
 * `agent_swarm_list_jobs` (issue #93): the model-facing read face over the
 * caller-scoped TeamJobProjection. Reads ONLY projected snapshots and passes
 * the exact `exec.agent` identity; it never falls back to a process-wide list
 * or to the authoritative domain directly.
 * Filters follow the projected record shape: `kind` and `status`. No team
 * filter exists because the official `JobSnapshot` carries no team identity —
 * the task correlation rides `detail` by design (#76). When the projection is
 * not mounted (`jobsBridge: false`) the call fails loud with a structured
 * error naming the enabling config: an empty list would assert "no jobs"
 * where the honest statement is "no projection", and falling back to the
 * domain would bypass the projection contract.
 */
export function registerListJobsTool(ctx: Context, runtime: AgentSwarmRuntime): void {
  register(ctx, defineTool({
    name: 'agent_swarm_list_jobs',
    description: 'List background Team executions from the read-only jobs projection with optional kind/status filters and cursor pagination (limit 1-100, default 50; use next_cursor to continue). Every row is one Team task that has entered execution; create work as Team tasks and cancel through the Team face — this face never creates or cancels jobs. Requires the jobsBridge projection.',
    parameters: {
      kind: { type: 'string', description: 'Optional exact kind filter. This projection emits only "team-task".' },
      status: { type: 'string', enum: [...PROJECTED_JOB_STATUSES], description: 'Optional exact status filter.' },
      cursor: { type: 'integer', description: 'Zero-based result offset. Defaults to 0.' },
      limit: { type: 'integer', description: 'Number of rows, 1 through 100. Defaults to 50.' },
    },
    output: compactJsonOutput(JOB_LIST_VALUE_SCHEMA),
    async execute(args, exec) {
      const cursor = args.cursor ?? 0
      const limit = args.limit ?? 50
      expectDomain(Number.isSafeInteger(cursor) && cursor >= 0, 'cursor must be a non-negative safe integer', 'TEAM_INPUT_INVALID')
      expectDomain(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'limit must be an integer from 1 through 100', 'TEAM_INPUT_INVALID')
      const projection = runtime.jobsBridge
      if (projection === undefined) {
        throw new TeamDomainError(
          'the jobs read surface is not mounted: enable config jobsBridge: true to project Team executions (this tool reads only the projection, never the authoritative domain)',
          'TEAM_JOBS_BRIDGE_DISABLED',
        )
      }
      const caller = requireAgent(exec)
      const filtered = projection.list(caller).filter((job: JobSnapshot) =>
        (args.kind === undefined || job.kind === args.kind)
        && (args.status === undefined || job.status === args.status))
      const jobs = filtered.slice(cursor, cursor + limit).map((job: JobSnapshot) => ({
        job_id: String(job.id),
        kind: job.kind,
        label: job.label,
        status: projectedJobStatus(job.status),
        ...(job.detail === undefined ? {} : { detail: job.detail }),
        started_at: job.startedAt,
        ...(job.finishedAt === undefined ? {} : { finished_at: job.finishedAt }),
      }))
      return { jobs, ...(cursor + limit < filtered.length ? { next_cursor: cursor + limit } : {}) }
    },
  }), 'list-jobs tool')
}


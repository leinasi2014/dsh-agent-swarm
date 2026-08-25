/**
 * Model-experience read surface tools (issue #74 split of src/tools.ts, shape
 * from issue #15 / docs/04 §8e): fixed-size Team counters and the paginated,
 * filtered task row list with evidence-only stranded hints. Issue #93 adds
 * the jobs reader: the same filtered/paginated compact-JSON contract over the
 * #76 TeamJobProjection (never over the authoritative domain directly).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { JobSnapshot, JobStatus } from '@deepseek-ai/dsh-jobs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { expectDomain, TeamDomainError } from '../domain/error.js'
import { taskHoldEvidence } from '../domain/team-domain-budget.js'
import type { TeamTask } from '../domain/types.js'
import type { AgentSwarmRuntime } from '../runtime/orchestrator-runtime.js'
import { coordinationCursorOf } from '../runtime/wait-surface.js'
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
    description: 'Read the fixed-size Team counters: roster size, task counts by outcome, readiness, queued mail, budgets and memory. Task rows — owners, attempts, filters, pagination — come from agent_swarm_list_tasks; this summary never embeds them.',
    parameters: {},
    output: compactJsonOutput({
      type: 'object', additionalProperties: false,
      properties: {
        team_id: { type: 'string', required: true },
        name: { type: 'string', required: true },
        revision: { type: 'number', required: true },
        coordination_cursor: { type: 'string', required: true },
        members: { type: 'number', required: true },
        tasks: { type: 'number', required: true },
        completed_tasks: { type: 'number', required: true },
        ready_tasks: { type: 'number', required: true },
        queued_messages: { type: 'number', required: true },
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
        coordination_cursor: coordinationCursorOf(snapshot),
        members: snapshot.team.members.filter(member => member.phase === 'active').length,
        tasks: snapshot.team.tasks.length,
        completed_tasks: snapshot.team.tasks.filter(task => task.status === 'completed').length,
        ready_tasks: snapshot.readyTaskIds.length,
        queued_messages: snapshot.pendingMessageIds.length,
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
      const cursor = args.cursor ?? 0
      const limit = args.limit ?? 50
      expectDomain(Number.isSafeInteger(cursor) && cursor >= 0, 'cursor must be a non-negative safe integer', 'TEAM_INPUT_INVALID')
      expectDomain(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'limit must be an integer from 1 through 100', 'TEAM_INPUT_INVALID')
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
 * #76 TeamJobProjection. Reads ONLY projected snapshots (`list()` — the pure
 * read that never marks a record `reported`), never the authoritative domain
 * directly; projection/board consistency is the #76 dual-face tests' charge.
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
    async execute(args) {
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
      const filtered = projection.list().filter((job: JobSnapshot) =>
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

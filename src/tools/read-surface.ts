/**
 * Model-experience read surface tools (issue #74 split of src/tools.ts, shape
 * from issue #15 / docs/04 §8e): fixed-size Team counters and the paginated,
 * filtered task row list with evidence-only stranded hints.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { expectDomain } from '../domain/error.js'
import type { TeamTask } from '../domain/types.js'
import type { AgentSwarmRuntime } from '../runtime/orchestrator-runtime.js'
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
      const tasks = filtered.slice(cursor, cursor + limit).map(task => ({
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
      }))
      return { tasks, ...(cursor + limit < filtered.length ? { next_cursor: cursor + limit } : {}) }
    },
  }), 'list-tasks tool')
}

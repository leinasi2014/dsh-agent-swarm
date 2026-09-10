/** Main proposals and Captain decisions reuse the official Team task authority. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { TeamDomainError } from '../domain/error.js'
import { TaskId } from '../domain/types.js'
import type { WorkRequestResult } from '../domain/work-request.js'
import type { AgentSwarmRuntime } from '../runtime/orchestrator-runtime.js'
import { compactJsonOutput, register } from './shared.js'

const resultSchema = { type: 'object', additionalProperties: false, properties: {
  work_request_id: { type: 'string', required: true }, revision: { type: 'number', required: true },
  team_revision: { type: 'number', required: true }, replayed: { type: 'boolean', required: true },
  decision: { type: 'string', enum: ['pending', 'accept', 'reject'], required: true },
  tasks: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    item_key: { type: 'string', required: true }, task_id: { type: 'string', required: true },
  } } },
} } as const
function result(value: WorkRequestResult) {
  const decision = value.request.resolution
  return { work_request_id: value.request.id, revision: value.request.revision, team_revision: value.teamRevision,
    replayed: value.replayed, decision: decision?.kind ?? 'pending' as const,
    tasks: decision?.kind === 'accept' ? Object.entries(decision.taskIdsByItemKey).map(([item_key, task_id]) => ({ item_key, task_id })) : [] }
}

export function registerWorkRequestTools(ctx: Context, runtime: AgentSwarmRuntime): void {
  register(ctx, defineTool({
    name: 'agent_swarm_submit_work_request',
    description: 'The exact managed Main Session proposes work to its Team Captain. Reuse request_id and the identical payload after uncertain results. This preserves your real source; it creates no formal task or attempt. Only the Captain resolves the request.',
    parameters: { team_id: { type: 'string', required: true }, request_id: { type: 'string', required: true },
      description: { type: 'string', required: true }, acceptance_criteria: { type: 'string' } },
    output: compactJsonOutput(resultSchema),
    async execute(args, exec) {
      return result(await runtime.work.submitMain(exec, args.team_id, { requestId: args.request_id, description: args.description,
        ...(args.acceptance_criteria === undefined ? {} : { acceptanceCriteria: args.acceptance_criteria }) }))
    },
  }), 'submit work request tool')
  register(ctx, defineTool({
    name: 'agent_swarm_list_work_requests',
    description: 'Captain-only: read pending work requests, preserving the genuine operator or Main source. Each request is not yet a task. Use its id and revision to accept one complete bounded task plan or reject with a reason; do not independently recreate tasks with create_task.',
    parameters: { cursor: { type: 'integer', description: 'Zero-based pending request offset, default 0.' },
      limit: { type: 'integer', description: '1-20 requests, default 5; follow next_cursor for more.' } },
    output: compactJsonOutput({ type: 'object', additionalProperties: false, properties: {
      requests: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        work_request_id: { type: 'string', required: true }, revision: { type: 'number', required: true },
        origin: { type: 'string', enum: ['local-operator', 'main'], required: true }, main_session_id: { type: 'string' },
        description: { type: 'string', required: true }, acceptance_criteria: { type: 'string' }, created_at: { type: 'number', required: true },
      } } },
      next_cursor: { type: 'number' }, total_count: { type: 'number', required: true },
    } }),
    async execute(args, exec) {
      const cursor = args.cursor ?? 0, limit = args.limit ?? 5
      if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
        throw new TeamDomainError('Request page requires cursor >= 0 and limit 1-20', 'TEAM_INPUT_INVALID')
      }
      const pending = await runtime.work.list(exec)
      return { total_count: pending.length, ...(cursor + limit < pending.length ? { next_cursor: cursor + limit } : {}),
        requests: pending.slice(cursor, cursor + limit).map(request => ({
      work_request_id: request.id, revision: request.revision, origin: request.origin.kind, description: request.description,
      created_at: request.createdAt, ...(request.origin.kind === 'main' ? { main_session_id: request.origin.sessionId } : {}),
      ...(request.acceptanceCriteria === undefined ? {} : { acceptance_criteria: request.acceptanceCriteria }),
    })) } },
  }), 'list work requests tool')
  register(ctx, defineTool({
    name: 'agent_swarm_resolve_work_request',
    description: 'Captain-only: atomically accept one complete plan of 1-32 task items or reject a pending request. item_key is unique in this plan; blocked_by_items links this plan while blocked_by links existing tasks. Reuse the identical decision after uncertain results to recover the original task mapping. No partial plans are committed. Open-claim tasks wait for participant self-claim; automatic tasks use the existing scheduler.',
    parameters: {
      work_request_id: { type: 'string', required: true }, expected_request_revision: { type: 'integer', required: true },
      decision: { type: 'string', required: true, enum: ['accept', 'reject'] }, public_reason: { type: 'string', description: 'Required for rejection; no tasks may accompany rejection.' },
      items: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        item_key: { type: 'string', required: true }, subject: { type: 'string', required: true }, description: { type: 'string', required: true },
        acceptance_criteria: { type: 'array', items: { type: 'string' } }, blocked_by: { type: 'array', items: { type: 'string' } },
        blocked_by_items: { type: 'array', items: { type: 'string' } }, write_scopes: { type: 'array', items: { type: 'string' } },
        priority: { type: 'number' }, reservation_tokens: { type: 'number' }, assignment_mode: { type: 'string', enum: ['automatic', 'open-claim'] },
        target_member_session_id: { type: 'string', description: 'Exact current Team directory Session id, only for automatic tasks. A stable identity is retained on retries even if the member later leaves.' },
        verification: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
          command: { type: 'string', required: true }, timeout_ms: { type: 'number' },
        } } },
      } } },
    },
    output: compactJsonOutput(resultSchema),
    async execute(args, exec) {
      if (args.decision === 'reject' && (args.items !== undefined || args.public_reason === undefined)
        || args.decision === 'accept' && (args.items === undefined || args.public_reason !== undefined)) {
        throw new TeamDomainError('Accept requires only items; reject requires only a reason', 'TEAM_INPUT_INVALID')
      }
      const decision = args.decision === 'reject' ? { kind: 'reject' as const, publicReason: args.public_reason! }
        : { kind: 'accept' as const, items: args.items!.map(item => ({
          itemKey: item.item_key, subject: item.subject, description: item.description,
          ...(item.acceptance_criteria === undefined ? {} : { acceptanceCriteria: item.acceptance_criteria }),
          ...(item.blocked_by === undefined ? {} : { blockedBy: item.blocked_by.map(TaskId) }),
          ...(item.blocked_by_items === undefined ? {} : { blockedByItems: item.blocked_by_items }),
          ...(item.write_scopes === undefined ? {} : { writeScopes: item.write_scopes }),
          ...(item.priority === undefined ? {} : { priority: item.priority }),
          ...(item.reservation_tokens === undefined ? {} : { reservationTokens: item.reservation_tokens }),
          ...(item.assignment_mode === undefined ? {} : { assignmentMode: item.assignment_mode }),
          ...(item.target_member_session_id === undefined ? {} : { targetMemberSessionId: item.target_member_session_id }),
          ...(item.verification === undefined ? {} : { verification: item.verification.map(check => ({ command: check.command,
            ...(check.timeout_ms === undefined ? {} : { timeoutMs: check.timeout_ms }) })) }),
        })) }
      return result(await runtime.work.resolve(exec, { workRequestId: args.work_request_id, expectedRequestRevision: args.expected_request_revision, decision }))
    },
  }), 'resolve work request tool')
}

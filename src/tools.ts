import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type InferValue, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { TaskId, type TeamStatusSnapshot, type TeamTask } from './domain/types.js'
import { expectDomain } from './domain/error.js'
import type { AgentSwarmRuntime } from './runtime/orchestrator-runtime.js'

function register(ctx: Context, tool: Parameters<typeof ctx.tools.register>[0], label: string): void {
  ctx.effect(() => ctx.tools.register(tool), `agent-swarm: ${label}`)
}

/**
 * Declare one canonical output schema with compact model-facing JSON — the
 * official `tool-agent-team` `jsonOutput` pattern (issue #15, docs/02 §7.1):
 * `defineTool` compiles the schema, the compiler checks `execute` against the
 * value the model is promised, and the pure single-block render never falls
 * back to a generic projection. Stays unfenced by the accepted issue #62
 * trade-off (quantified in docs/04 §8d): JSON.stringify output is one line
 * that can forge no fence or message boundary, and the single-block JSON is
 * the official output contract locked by the model-experience tests.
 */
function compactJsonOutput<const S extends ValueSchemaSpec>(schema: S): {
  schema: S
  render: (args: unknown, value: InferValue<S>) => [{ type: 'text'; text: string }]
} {
  return {
    schema,
    render: (_args: unknown, value: InferValue<S>) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}

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

/** Official `NO_ACTIVE_PEER_MESSAGE` shape, adapted to this plugin's tool names. */
const NO_ACTIVE_PEER_MESSAGE = 'No other Team member is running or provisioning. agent_swarm_wait cannot make progress or wake inactive members. Re-read the Team with agent_swarm_status and agent_swarm_list_tasks, then use agent_swarm_send_message with delivery "wakeup" to resume each required inactive member before waiting again.'

function projectWait(result: { changed: boolean; snapshot: TeamStatusSnapshot }) {
  return {
    changed: result.changed,
    revision: result.snapshot.team.revision,
    ready_task_ids: result.snapshot.readyTaskIds,
    queued_messages: result.snapshot.pendingMessageIds.length,
  }
}

/** Adapt the evidence-only stranded hint (docs/04 §8c) into one row field. */
function strandedHint(runtime: AgentSwarmRuntime, task: TeamTask):
  { stranded: 'idle-holder' | 'owner-not-live' } | Record<string, never> {
  const evidence = runtime.strandedEvidence(task).trim()
  return evidence === '' ? {} : { stranded: evidence.slice('stranded='.length) as 'idle-holder' | 'owner-not-live' }
}

/** Register the model-facing Consumer over the Team orchestrator runtime. */
export function registerAgentSwarmTools(ctx: Context, runtime: AgentSwarmRuntime): void {
  register(ctx, defineTool({
    name: 'agent_swarm_create',
    description: 'Create one durable DSH Team. The calling Agent becomes captain; one captain may own one active Team per workspace.',
    parameters: {
      name: { type: 'string', required: true, description: 'Human-readable Team name.' },
      description: { type: 'string', required: true, description: 'Concrete goal and completion boundary.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          team_id: { type: 'string', required: true },
          name: { type: 'string', required: true },
          revision: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Created Team "${value.name}" (${value.team_id}, revision ${value.revision}).` }],
    },
    async execute(args, exec) {
      const team = await runtime.create(exec, args.name, args.description)
      return { team_id: team.id, name: team.name, revision: team.revision }
    },
  }), 'create tool')

  register(ctx, defineTool({
    name: 'agent_swarm_add_member',
    description: 'Captain-only. Create a durable continuable DSH subagent member with an isolated persona and Team-safe tool permissions.',
    parameters: {
      name: { type: 'string', required: true, description: 'Immutable member name: NFC-normalized Unicode letters/digits with dash separators, at most 64 code points.' },
      role: { type: 'string', required: true, description: 'Member specialty and responsibility.' },
      provider: { type: 'string', description: 'Optional continuable subagent Provider; defaults to plugin config.' },
      model: { type: 'string', description: 'Optional member model override.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          session_id: { type: 'string', required: true },
          role: { type: 'string', required: true },
          provider: { type: 'string', required: true },
          phase: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Member ${value.name} (${value.session_id}) is ${value.phase} via ${value.provider}.` }],
    },
    async execute(args, exec) {
      const member = await runtime.addMember(exec, {
        name: args.name,
        role: args.role,
        ...(args.provider === undefined ? {} : { provider: args.provider }),
        ...(args.model === undefined ? {} : { model: args.model }),
      })
      return {
        name: member.name,
        session_id: member.sessionId,
        role: member.role,
        provider: member.provider,
        phase: member.phase,
      }
    },
  }), 'add-member tool')

  register(ctx, defineTool({
    name: 'agent_swarm_create_task',
    description: 'Create one dependency-aware Team task. Ready unowned tasks are assigned automatically to available members by priority.',
    parameters: {
      subject: { type: 'string', required: true, description: 'Short task title.' },
      description: { type: 'string', required: true, description: 'Complete work instructions.' },
      acceptance_criteria: { type: 'array', items: { type: 'string' }, description: 'Evidence-based acceptance criteria.' },
      blocked_by: { type: 'array', items: { type: 'string' }, description: 'Existing task ids that must complete first.' },
      write_scopes: { type: 'array', items: { type: 'string' }, description: 'Advisory workspace-relative paths; not authorization.' },
      priority: { type: 'number', description: 'Higher values are scheduled first.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          revision: { type: 'number', required: true },
          status: { type: 'string', required: true },
          ready: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Task ${value.task_id} created at revision ${value.revision}; status=${value.status}, ready=${String(value.ready)}.` }],
    },
    async execute(args, exec) {
      const task = await runtime.createTask(exec, {
        subject: args.subject,
        description: args.description,
        ...(args.acceptance_criteria === undefined ? {} : { acceptanceCriteria: args.acceptance_criteria }),
        ...(args.blocked_by === undefined ? {} : { blockedBy: args.blocked_by.map(TaskId) }),
        ...(args.write_scopes === undefined ? {} : { writeScopes: args.write_scopes }),
        ...(args.priority === undefined ? {} : { priority: args.priority }),
      })
      return { task_id: task.id, revision: task.revision, status: task.status, ready: task.status === 'pending' }
    },
  }), 'create-task tool')

  register(ctx, defineTool({
    name: 'agent_swarm_remove_member',
    description: 'Captain-only. Fence all open attempts owned by one member, requeue their tasks, cancel queued mail to them, then interrupt and drain the continuable child.',
    parameters: {
      name: { type: 'string', required: true },
      reason: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          phase: { type: 'string', required: true },
          requeued_task_ids: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Removed ${value.name}; requeued=${value.requeued_task_ids.join(', ') || 'none'}.` }],
    },
    async execute(args, exec) {
      const removed = await runtime.removeMember(exec, args.name, args.reason)
      return {
        name: removed.member.name,
        phase: removed.member.phase,
        requeued_task_ids: removed.requeuedTaskIds,
      }
    },
  }), 'remove-member tool')

  register(ctx, defineTool({
    name: 'agent_swarm_archive',
    description: 'Captain-only. Irreversibly archive the active Team, cancel all unfinished tasks and queued messages, fence attempts, and drain every member.',
    parameters: {
      reason: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          team_id: { type: 'string', required: true },
          phase: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Archived Team ${value.team_id}; phase=${value.phase}.` }],
    },
    async execute(args, exec) {
      const team = await runtime.archive(exec, args.reason)
      return { team_id: team.id, phase: team.phase }
    },
  }), 'archive tool')

  register(ctx, defineTool({
    name: 'agent_swarm_claim_task',
    description: 'Claim one ready task for the calling Team participant using the exact current revision. Returns the attempt capability required for every later submission.',
    parameters: {
      task_id: { type: 'string', required: true },
      expected_revision: { type: 'number', required: true },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          revision: { type: 'number', required: true },
          attempt_id: { type: 'string', required: true },
          generation: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Claimed ${value.task_id} revision ${value.revision}; attempt=${value.attempt_id} generation=${value.generation}.` }],
    },
    async execute(args, exec) {
      const claim = await runtime.claimTask(exec, args.task_id, args.expected_revision)
      return {
        task_id: claim.task.id,
        revision: claim.task.revision,
        attempt_id: claim.attempt.id,
        generation: claim.attempt.generation,
      }
    },
  }), 'claim-task tool')

  register(ctx, defineTool({
    name: 'agent_swarm_submit_task',
    description: 'Submit the current execution attempt for independent captain review. This never completes the canonical task by itself. A stale attempt must stop immediately.',
    parameters: {
      task_id: { type: 'string', required: true },
      expected_revision: { type: 'number', required: true },
      attempt_id: { type: 'string', required: true },
      output: { type: 'string', required: true, description: 'Concise result and important limitations.' },
      evidence: { type: 'array', items: { type: 'string' }, description: 'Test, artifact, diff, source, or diagnostic references.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          revision: { type: 'number', required: true },
          status: { type: 'string', required: true },
          review_required: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Submitted ${value.task_id} at revision ${value.revision}; captain review is required.` }],
    },
    async execute(args, exec) {
      const task = await runtime.submitTask(exec, {
        taskId: args.task_id,
        expectedRevision: args.expected_revision,
        attemptId: args.attempt_id,
        output: args.output,
        ...(args.evidence === undefined ? {} : { evidence: args.evidence }),
      })
      return { task_id: task.id, revision: task.revision, status: task.status, review_required: true }
    },
  }), 'submit-task tool')

  register(ctx, defineTool({
    name: 'agent_swarm_reassign_task',
    description: 'Captain-only. Fence the current attempt before interruption, return the task to pending, and let the scheduler create a fresh attempt.',
    parameters: {
      task_id: { type: 'string', required: true },
      expected_revision: { type: 'number', required: true },
      reason: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          revision: { type: 'number', required: true },
          status: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Fenced and released ${value.task_id}; revision=${value.revision}, status=${value.status}.` }],
    },
    async execute(args, exec) {
      const task = await runtime.reassignTask(exec, args.task_id, args.expected_revision, args.reason)
      return { task_id: task.id, revision: task.revision, status: task.status }
    },
  }), 'reassign-task tool')

  register(ctx, defineTool({
    name: 'agent_swarm_review_task',
    description: 'Captain-only verification gate. Accept a submitted attempt to complete the canonical task, or reject it so a fresh fenced attempt can run.',
    parameters: {
      task_id: { type: 'string', required: true },
      expected_revision: { type: 'number', required: true },
      attempt_id: { type: 'string', required: true },
      decision: { type: 'string', required: true, enum: ['accept', 'reject'] },
      diagnostic: { type: 'string', description: 'Verification evidence or rejection reason.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          revision: { type: 'number', required: true },
          status: { type: 'string', required: true },
          decision: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Review ${value.decision}: ${value.task_id} is now ${value.status} at revision ${value.revision}.` }],
    },
    async execute(args, exec) {
      const decision = args.decision as 'accept' | 'reject'
      const reviewed = await runtime.reviewTask(exec, {
        taskId: args.task_id,
        expectedRevision: args.expected_revision,
        attemptId: args.attempt_id,
        decision,
        ...(args.diagnostic === undefined ? {} : { diagnostic: args.diagnostic }),
      })
      return {
        task_id: reviewed.task.id,
        revision: reviewed.task.revision,
        status: reviewed.task.status,
        decision: reviewed.decision,
      }
    },
  }), 'review-task tool')

  register(ctx, defineTool({
    name: 'agent_swarm_interrupt_member',
    description: 'Captain-only. Cancel one member\'s current turn while keeping its pending inbox, task ownership and roster membership; a later wakeup message resumes it.',
    parameters: {
      name: { type: 'string', required: true, description: 'Active member name.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          previous_status: { type: 'string', required: true, enum: ['running', 'idle', 'inactive'] },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Interrupted ${value.name}; previous_status=${value.previous_status}. Inbox, ownership and membership are preserved.` }],
    },
    async execute(args, exec) {
      const interrupted = await runtime.interruptMember(exec, args.name)
      return { name: interrupted.name, previous_status: interrupted.previousStatus }
    },
  }), 'interrupt-member tool')

  register(ctx, defineTool({
    name: 'agent_swarm_send_message',
    description: 'Persist a Team message before best-effort delivery. A queued result is durable and must not be resent by the caller.',
    parameters: {
      target: { type: 'string', required: true, description: 'captain or an active member name.' },
      content: { type: 'string', required: true },
      delivery: { type: 'string', enum: ['quiet', 'wakeup'], description: 'quiet delivers without waking the recipient and stays queued while the target is inactive; wakeup follows up and may cold-resume an inactive member.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          message_id: { type: 'string', required: true },
          target: { type: 'string', required: true },
          phase: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Message ${value.message_id} to ${value.target}: ${value.phase}. Do not resend a queued message.` }],
    },
    async execute(args, exec) {
      const message = await runtime.sendMessage(
        exec, args.target, args.content, (args.delivery ?? 'wakeup') as 'quiet' | 'wakeup',
      )
      return { message_id: message.id, target: message.targetName, phase: message.phase }
    },
  }), 'send-message tool')

  register(ctx, defineTool({
    name: 'agent_swarm_set_budget',
    description: 'Captain-only. Configure Team token, request, retry, and deadline limits. Existing usage is retained.',
    parameters: {
      token_limit: { type: 'number' },
      request_limit: { type: 'number' },
      retry_limit: { type: 'number' },
      deadline_at: { type: 'number', description: 'Absolute Unix timestamp in milliseconds.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          used_tokens: { type: 'number', required: true },
          used_requests: { type: 'number', required: true },
          used_retries: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Budget usage: tokens=${value.used_tokens}, requests=${value.used_requests}, retries=${value.used_retries}.` }],
    },
    async execute(args, exec) {
      const budget = await runtime.setBudget(exec, {
        ...(args.token_limit === undefined ? {} : { tokenLimit: args.token_limit }),
        ...(args.request_limit === undefined ? {} : { requestLimit: args.request_limit }),
        ...(args.retry_limit === undefined ? {} : { retryLimit: args.retry_limit }),
        ...(args.deadline_at === undefined ? {} : { deadlineAt: args.deadline_at }),
      })
      return {
        used_tokens: budget.usedTokens,
        used_requests: budget.usedRequests,
        used_retries: budget.usedRetries,
      }
    },
  }), 'budget tool')

  register(ctx, defineTool({
    name: 'agent_swarm_add_memory',
    description: 'Store a compact Team decision, lesson, member capability, or durable context with evidence references.',
    parameters: {
      category: { type: 'string', required: true, enum: ['decision', 'lesson', 'member', 'context'] },
      content: { type: 'string', required: true },
      evidence_refs: { type: 'array', items: { type: 'string' } },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          memory_id: { type: 'string', required: true },
          category: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Stored ${value.category} memory ${value.memory_id}.` }],
    },
    async execute(args, exec) {
      const category = args.category as 'decision' | 'lesson' | 'member' | 'context'
      const entry = await runtime.addMemory(exec, category, args.content, args.evidence_refs ?? [])
      return { memory_id: entry.id, category: entry.category }
    },
  }), 'memory tool')

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

  register(ctx, defineTool({
    name: 'agent_swarm_wait',
    description: 'Wait without polling until the authoritative Team revision exceeds after_revision, or return unchanged at timeout. Returns no_progress immediately when no other member is running or provisioning — waiting cannot help then. Caller cancellation fails with TEAM_WAIT_ABORTED.',
    parameters: {
      after_revision: { type: 'number', required: true },
      timeout_ms: { type: 'number', description: '10000..3600000; defaults to 30000.' },
    },
    output: compactJsonOutput({
      type: 'object', additionalProperties: false,
      properties: {
        changed: { type: 'boolean', required: true },
        no_progress: {
          type: 'object', additionalProperties: false,
          description: 'Present only on the model-only shortcut that skips the wait.',
          properties: {
            reason: { type: 'string', required: true, const: 'no-active-peer' },
            message: { type: 'string', required: true },
          },
        },
        revision: { type: 'number', required: true },
        ready_task_ids: { type: 'array', required: true, items: { type: 'string' } },
        queued_messages: { type: 'number', required: true },
      },
    }),
    async execute(args, exec) {
      const timeoutMs = args.timeout_ms ?? 30_000
      // Official parity: the authoritative window validation precedes the
      // model-only no-progress shortcut, so invalid timeouts still surface
      // TEAM_INVALID_TIMEOUT instead of a misleading no_progress value.
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 3_600_000) {
        return projectWait(await runtime.waitForChange(exec, args.after_revision, timeoutMs))
      }
      const evidence = await runtime.activePeerEvidence(exec)
      // The shortcut only covers a current cursor: this domain's wait is
      // level-triggered (docs/04 §8b), so a caller whose cursor is already
      // surpassed must still observe changed=true through the real wait,
      // which resolves immediately without parking.
      if (!evidence.activePeer && evidence.snapshot.team.revision <= args.after_revision) {
        return {
          changed: false,
          no_progress: { reason: 'no-active-peer' as const, message: NO_ACTIVE_PEER_MESSAGE },
          revision: evidence.snapshot.team.revision,
          ready_task_ids: evidence.snapshot.readyTaskIds,
          queued_messages: evidence.snapshot.pendingMessageIds.length,
        }
      }
      return projectWait(await runtime.waitForChange(exec, args.after_revision, timeoutMs))
    },
  }), 'wait tool')
}

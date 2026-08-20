import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { TaskId } from './domain/types.js'
import type { AgentSwarmRuntime } from './runtime/orchestrator-runtime.js'

function register(ctx: Context, tool: Parameters<typeof ctx.tools.register>[0], label: string): void {
  ctx.effect(() => ctx.tools.register(tool), `agent-swarm: ${label}`)
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
    description: 'Read the authoritative Team snapshot: roster, task revisions/attempts, readiness, queued mail, budgets, and memory count.',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          team_id: { type: 'string', required: true },
          name: { type: 'string', required: true },
          revision: { type: 'number', required: true },
          members: { type: 'number', required: true },
          tasks: { type: 'number', required: true },
          completed_tasks: { type: 'number', required: true },
          ready_task_ids: { type: 'array', items: { type: 'string' }, required: true },
          queued_messages: { type: 'number', required: true },
          memory_entries: { type: 'number', required: true },
          used_tokens: { type: 'number', required: true },
          used_requests: { type: 'number', required: true },
          used_retries: { type: 'number', required: true },
          task_summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `Team ${value.name} (${value.team_id}) revision ${value.revision}`,
          `members=${value.members}, tasks=${value.tasks}, completed=${value.completed_tasks}`,
          `ready=${value.ready_task_ids.join(', ') || 'none'}, queued_messages=${value.queued_messages}, memory=${value.memory_entries}`,
          `budget: tokens=${value.used_tokens}, requests=${value.used_requests}, retries=${value.used_retries}`,
          value.task_summary,
        ].join('\n'),
      }],
    },
    async execute(_args, exec) {
      const snapshot = await runtime.status(exec)
      const summary = snapshot.team.tasks.map(task => (
        `${task.id}@${task.revision}:${task.status}${task.ownerSessionId === undefined ? '' : ` owner=${task.ownerSessionId}`}${task.currentAttemptId === undefined ? '' : ` attempt=${task.currentAttemptId}`}`
      )).join('\n')
      return {
        team_id: snapshot.team.id,
        name: snapshot.team.name,
        revision: snapshot.team.revision,
        members: snapshot.team.members.filter(member => member.phase === 'active').length,
        tasks: snapshot.team.tasks.length,
        completed_tasks: snapshot.team.tasks.filter(task => task.status === 'completed').length,
        ready_task_ids: snapshot.readyTaskIds,
        queued_messages: snapshot.pendingMessageIds.length,
        memory_entries: snapshot.team.memory.length,
        used_tokens: snapshot.team.budget.usedTokens,
        used_requests: snapshot.team.budget.usedRequests,
        used_retries: snapshot.team.budget.usedRetries,
        task_summary: summary || 'No tasks.',
      }
    },
  }), 'status tool')

  register(ctx, defineTool({
    name: 'agent_swarm_wait',
    description: 'Wait without polling until the authoritative Team revision exceeds after_revision, or return unchanged at timeout. Caller cancellation fails with TEAM_WAIT_ABORTED.',
    parameters: {
      after_revision: { type: 'number', required: true },
      timeout_ms: { type: 'number', description: '10000..3600000; defaults to 30000.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          changed: { type: 'boolean', required: true },
          revision: { type: 'number', required: true },
          ready_task_ids: { type: 'array', items: { type: 'string' }, required: true },
          queued_messages: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Team revision ${value.revision}; changed=${String(value.changed)}, ready=${value.ready_task_ids.join(', ') || 'none'}, queued_messages=${value.queued_messages}.`,
      }],
    },
    async execute(args, exec) {
      const result = await runtime.waitForChange(exec, args.after_revision, args.timeout_ms ?? 30_000)
      return {
        changed: result.changed,
        revision: result.snapshot.team.revision,
        ready_task_ids: result.snapshot.readyTaskIds,
        queued_messages: result.snapshot.pendingMessageIds.length,
      }
    },
  }), 'wait tool')
}

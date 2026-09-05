/**
 * Task board tools (issue #74 split of src/tools.ts): create dependency-aware
 * tasks, claim with revision CAS and attempt fencing, submit for captain
 * review, reassign through fenced release, and review as the verification
 * gate. Pure refactor: every schema, error and render is byte-identical.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { TaskId } from '../domain/types.js'
import type { AgentSwarmRuntime } from '../runtime/orchestrator-runtime.js'
import type { VerificationDeclaration } from '../runtime/verification-commands.js'
import { register } from './shared.js'

/** `agent_swarm_create_task`. */
export function registerCreateTaskTool(ctx: Context, runtime: AgentSwarmRuntime): void {
  register(ctx, defineTool({
    name: 'agent_swarm_create_task',
    description: 'Create one dependency-aware Team task. Ready unowned tasks are assigned automatically by priority; a task WITHOUT target_member is safe for any eligible member, and specialist work MUST name target_member (it never falls back to another member).',
    parameters: {
      subject: { type: 'string', required: true, description: 'Short task title.' },
      description: { type: 'string', required: true, description: 'Complete work instructions.' },
      acceptance_criteria: { type: 'array', items: { type: 'string' }, description: 'Evidence-based acceptance criteria.' },
      blocked_by: { type: 'array', items: { type: 'string' }, description: 'Existing task ids that must complete first.' },
      write_scopes: { type: 'array', items: { type: 'string' }, description: 'Advisory workspace-relative coordination paths, not filesystem authorization; delivered to the assigned member as untrusted guidance.' },
      priority: { type: 'number', description: 'Higher values are scheduled first.' },
      target_member: { type: 'string', description: 'Optional exact Team member name. The task waits for this member and never falls back to another member.' },
      verification: {
        type: 'array',
        description: 'Captain-declared verification checks frozen into the task. Each entry is either a raw command or a named command-library template with parameters; templates expand before the task commit and may select a Node/Python root family.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            command: { type: 'string', description: 'Raw shell command executed with the configured legacy review root as cwd; mutually exclusive with template.' },
            template: { type: 'string', description: 'Registered template name such as node.test or python.lint; mutually exclusive with command.' },
            parameters: {
              type: 'array',
              description: 'Named template parameters. Builtin templates accept the single parameter args.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', required: true },
                  value: { type: 'string', required: true },
                },
              },
            },
            timeout_ms: { type: 'number', description: 'Per-command deadline in ms; bounded by the deployment ceiling.' },
          },
        },
      },
      reservation_tokens: {
        type: 'number',
        description: 'Guaranteed minimum token allocation for this task (M4-3): while a token limit is configured, the task is only claimed once the remaining budget covers this floor plus the reservations of every in-progress task; otherwise it waits (hold=reservation) until headroom frees or the limit rises. Inert without a token limit.',
      },
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
        ...(args.target_member === undefined ? {} : { targetMemberName: args.target_member }),
        ...(args.verification === undefined ? {} : {
          verification: args.verification.map(entry => ({
            ...(entry.command === undefined ? {} : { command: entry.command }),
            ...(entry.template === undefined ? {} : { template: entry.template }),
            ...(entry.parameters === undefined ? {} : { parameters: entry.parameters }),
            ...(entry.timeout_ms === undefined ? {} : { timeoutMs: entry.timeout_ms }),
          } as VerificationDeclaration)),
        }),
        ...(args.reservation_tokens === undefined ? {} : { reservationTokens: args.reservation_tokens }),
      })
      return { task_id: task.id, revision: task.revision, status: task.status, ready: task.status === 'pending' }
    },
  }), 'create-task tool')
}

/** `agent_swarm_claim_task`. */
export function registerClaimTaskTool(ctx: Context, runtime: AgentSwarmRuntime): void {
  register(ctx, defineTool({
    name: 'agent_swarm_claim_task',
    description: 'Claim one ready task for the calling Team participant using the exact current revision. Returns the attempt capability required for every later submission, plus this attempt\'s isolated execution root when the capability is enabled.',
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
          execution_root: { type: 'string', description: 'Absolute path of this attempt\'s isolated execution root (present only when the capability is enabled).' },
          execution_root_isolation: { type: 'string', description: 'How the root is isolated: git-worktree (a detached worktree of the Team workspace repository) or temp-directory (the workspace holds no repository).' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Claimed ${value.task_id} revision ${value.revision}; attempt=${value.attempt_id} generation=${value.generation}.${value.execution_root === undefined ? '' : ` Execution root: ${value.execution_root} (${value.execution_root_isolation}).`}` }],
    },
    async execute(args, exec) {
      const claim = await runtime.claimTask(exec, args.task_id, args.expected_revision)
      return {
        task_id: claim.task.id,
        revision: claim.task.revision,
        attempt_id: claim.attempt.id,
        generation: claim.attempt.generation,
        ...(claim.executionRoot === undefined ? {} : {
          execution_root: claim.executionRoot.path,
          execution_root_isolation: claim.executionRoot.isolation,
        }),
      }
    },
  }), 'claim-task tool')
}

/** `agent_swarm_submit_task`. */
export function registerSubmitTaskTool(ctx: Context, runtime: AgentSwarmRuntime): void {
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
}

/** `agent_swarm_reassign_task`. */
export function registerReassignTaskTool(ctx: Context, runtime: AgentSwarmRuntime): void {
  register(ctx, defineTool({
    name: 'agent_swarm_reassign_task',
    description: 'Captain-only. Fence the current attempt before interruption and return the task to pending. target_member strictly routes the fresh attempt to that member.',
    parameters: {
      task_id: { type: 'string', required: true },
      expected_revision: { type: 'number', required: true },
      reason: { type: 'string', required: true },
      target_member: { type: 'string', description: 'Optional exact Team member name for the fresh attempt.' },
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
      const task = await runtime.reassignTask(exec, args.task_id, args.expected_revision, args.reason, args.target_member)
      return { task_id: task.id, revision: task.revision, status: task.status }
    },
  }), 'reassign-task tool')
}

/** `agent_swarm_review_task`. */
export function registerReviewTaskTool(ctx: Context, runtime: AgentSwarmRuntime): void {
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
}

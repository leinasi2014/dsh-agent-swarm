import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContinuationIntent } from '../domain/team-state-v2.js'
import type { ToolExecutionAuthority } from '../runtime/authority.js'
import { register } from './shared.js'

export interface ContinuationRuntime {
  continueTask(exec: ToolExecutionAuthority, input: {
    readonly taskId: string
    readonly expectedRevision: number
    readonly attemptId: string
    readonly idempotencyKey: string
    readonly checkpointDigest?: string
    readonly wakeCondition?: string
  }): Promise<ContinuationIntent>
}

/** `agent_swarm_continue_task`: declare one explicit after-current-turn continuation. */
export function registerContinueTaskTool(ctx: Context, runtime: ContinuationRuntime): void {
  register(ctx, defineTool({
    name: 'agent_swarm_continue_task',
    description: 'Request exactly one next official DSH turn for the calling member\'s current task and Attempt after this turn settles. This does not end the current turn, create a new Attempt, or prove that the next model call ran. Reuse the same idempotency_key only for the same intended continuation.',
    parameters: {
      task_id: { type: 'string', required: true },
      expected_revision: { type: 'number', required: true },
      attempt_id: { type: 'string', required: true },
      idempotency_key: { type: 'string', required: true, description: 'Stable identity for this one intended continuation; use a new key for a later turn.' },
      checkpoint_digest: { type: 'string', description: 'Optional lowercase SHA-256 digest of a durable semantic checkpoint.' },
      wake_condition: { type: 'string', description: 'Optional concrete next runnable condition; policy or elapsed time is not a condition.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          attempt_id: { type: 'string', required: true },
          continuation_id: { type: 'string', required: true },
          phase: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Continuation ${value.continuation_id} is ${value.phase} for ${value.task_id}/${value.attempt_id}.` }],
    },
    async execute(args, exec) {
      const intent = await runtime.continueTask(exec, {
        taskId: args.task_id,
        expectedRevision: args.expected_revision,
        attemptId: args.attempt_id,
        idempotencyKey: args.idempotency_key,
        ...(args.checkpoint_digest === undefined ? {} : { checkpointDigest: args.checkpoint_digest }),
        ...(args.wake_condition === undefined ? {} : { wakeCondition: args.wake_condition }),
      })
      return {
        task_id: intent.taskId,
        attempt_id: intent.attemptId,
        continuation_id: intent.continuationEffectId,
        phase: intent.phase,
      }
    },
  }), 'continue-task tool')
}

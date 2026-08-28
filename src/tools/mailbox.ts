/**
 * Mailbox and wait tools (issue #74 split of src/tools.ts): durable-before-
 * delivery messages, and the revision-cursor wait whose no-active-peer
 * shortcut is specified in wakeup-delivery terms (docs/04 §8b).
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TeamStatusSnapshot } from '../domain/types.js'
import { AttemptId, TaskId, TeamMessageId } from '../domain/types.js'
import { TeamDomainError } from '../domain/error.js'
import type { AgentSwarmRuntime } from '../runtime/orchestrator-runtime.js'
import type { WaitResult, WaitSpinObservation } from '../runtime/wait-surface.js'
import { compactJsonOutput, register } from './shared.js'

/** Terminal no-active-peer guidance: it must not induce another wait turn. */
const NO_ACTIVE_PEER_MESSAGE = 'No other Team member is running or provisioning, so waiting cannot make progress or wake inactive members. Re-read the Team with agent_swarm_status and agent_swarm_list_tasks; if needed, use agent_swarm_send_message with delivery "wakeup" once for a required inactive member, then end this turn without looping.'

function projectWait(result: { changed: boolean; snapshot: TeamStatusSnapshot }) {
  return {
    changed: result.changed,
    revision: result.snapshot.team.revision,
    ready_task_ids: result.snapshot.readyTaskIds,
    queued_messages: result.snapshot.pendingMessageIds.length,
  }
}

function fuseOrThrow(runtime: AgentSwarmRuntime, exec: Parameters<AgentSwarmRuntime['waitForChange']>[0], observation: WaitSpinObservation, timeoutMs: number): void {
  const verdict = runtime.noteWaitSpin(exec, observation, timeoutMs)
  if (verdict === 'no-progress-repeat') {
    throw new TeamDomainError('repeated no-progress on the same Team revision; end this turn', 'TEAM_WAIT_NO_PROGRESS_REPEAT')
  }
  if (verdict === 'stalled') {
    throw new TeamDomainError('three exact consecutive timeouts (30000, 60000, 120000ms) without Team revision progress', 'TEAM_WAIT_STALLED')
  }
}

/** `agent_swarm_send_message`. */
export function registerSendMessageTool(ctx: Context, runtime: AgentSwarmRuntime): void {
  register(ctx, defineTool({
    name: 'agent_swarm_send_message',
    description: 'Persist a Team message before best-effort delivery. A queued result is durable and must not be resent by the caller.',
    parameters: {
      target: { type: 'string', required: true, description: 'captain or an active member name.' },
      content: { type: 'string', required: true },
      delivery: { type: 'string', enum: ['quiet', 'wakeup'], description: 'quiet delivers without waking the recipient and stays queued while the target is inactive; wakeup follows up and may cold-resume an inactive member.' },
      task_id: { type: 'string', description: 'Optional causal task id binding: the message is delivered only while the task is still open (not completed/cancelled).' },
      attempt_id: { type: 'string', description: 'Optional causal attempt id binding: the message is delivered only while this attempt is still the task\'s current attempt.' },
      revision: { type: 'integer', description: 'Optional causal task revision at send time (audit identity).' },
      supersedes: { type: 'string', description: 'Optional explicit supersede: settle the referenced still-pending message obsolete and deliver this one instead.' },
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
      const causal = args.task_id === undefined && args.attempt_id === undefined && args.revision === undefined
        ? undefined
        : {
            ...(args.task_id === undefined ? {} : { taskId: TaskId(args.task_id) }),
            ...(args.attempt_id === undefined ? {} : { attemptId: AttemptId(args.attempt_id) }),
            ...(args.revision === undefined ? {} : { revision: args.revision }),
          }
      const message = await runtime.sendMessage(
        exec, args.target, args.content, (args.delivery ?? 'wakeup') as 'quiet' | 'wakeup',
        causal, args.supersedes === undefined ? undefined : TeamMessageId(args.supersedes),
      )
      return { message_id: message.id, target: message.targetName, phase: message.phase }
    },
  }), 'send-message tool')
}

/** `agent_swarm_wait`. */
export function registerWaitTool(ctx: Context, runtime: AgentSwarmRuntime): void {
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
        const result = {
          changed: false,
          outcome: 'no-progress' as const,
          revision: evidence.snapshot.team.revision,
          ready_task_ids: evidence.snapshot.readyTaskIds,
          queued_messages: evidence.snapshot.pendingMessageIds.length,
        }
        fuseOrThrow(runtime, exec, {
          outcome: 'no-progress', changed: false, snapshot: evidence.snapshot,
        }, timeoutMs)
        return {
          changed: result.changed,
          no_progress: { reason: 'no-active-peer' as const, message: NO_ACTIVE_PEER_MESSAGE },
          revision: result.revision,
          ready_task_ids: result.ready_task_ids,
          queued_messages: result.queued_messages,
        }
      }
      const result: WaitResult = await runtime.waitForChange(exec, args.after_revision, timeoutMs)
      fuseOrThrow(runtime, exec, result, timeoutMs)
      return projectWait(result)
    },
  }), 'wait tool')
}

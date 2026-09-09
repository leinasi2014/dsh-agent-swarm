import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TeamCommunicationIntensity } from '../domain/types.js'
import type { AgentSwarmRuntime } from '../runtime/orchestrator-runtime.js'
import { register } from './shared.js'

export function registerSetCommunicationTool(ctx: Context, runtime: AgentSwarmRuntime): void {
  register(ctx, defineTool({
    name: 'agent_swarm_set_communication',
    description: 'Captain-only. Set this Team\'s communication intensity with the current Team revision. quiet/balanced/active allow 1/4/12 proactive peer wakeups per member per minute; overflow stays as quiet mail. Captain traffic and first valid replies remain available. inherit clears the durable override and follows plugin settings. This controls wakeups, not a hard message-send rate.',
    parameters: {
      expected_revision: { type: 'integer', required: true },
      intensity: { type: 'string', required: true, enum: ['inherit', 'quiet', 'balanced', 'active'] },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        revision: { type: 'number', required: true },
        intensity: { type: 'string', required: true },
        source: { type: 'string', required: true },
        peer_wakeups_per_minute: { type: 'number', required: true },
        window_seconds: { type: 'number', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: `Communication is ${value.intensity} (${value.source}); up to ${value.peer_wakeups_per_minute} proactive peer wakeups/member/minute. Excess is quiet mail, not discarded. Team revision ${value.revision}.` }],
    },
    async execute(args, exec) {
      const policy = await runtime.setCommunication(exec, args.expected_revision, args.intensity === 'inherit' ? undefined : args.intensity as TeamCommunicationIntensity)
      return { revision: policy.revision, intensity: policy.intensity, source: policy.source, peer_wakeups_per_minute: policy.peerWakeupsPerMinute, window_seconds: policy.windowSeconds }
    },
  }), 'communication intensity tool')
}

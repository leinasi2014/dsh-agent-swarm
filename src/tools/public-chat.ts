import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AgentSwarmRuntime } from '../runtime/orchestrator-runtime.js'
import { register } from './shared.js'

export function registerPublicReplyTool(ctx: Context, runtime: AgentSwarmRuntime): void {
  register(ctx, defineTool({
    name: 'agent_swarm_public_reply',
    description: 'Publish a deliberate public reply to an existing message in your managed Team. Your exact executing Session is the author. Detailed Session output stays private. Use one stable request_id per logical reply and reuse it unchanged if the result is uncertain. This creates no task and wakes nobody.',
    parameters: { request_id: { type: 'string', required: true }, reply_to: { type: 'string', required: true }, text: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        message_id: { type: 'string', required: true }, sequence: { type: 'number', required: true },
        team_revision: { type: 'number', required: true }, replayed: { type: 'boolean', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: `Public reply ${value.message_id}, sequence ${value.sequence}${value.replayed ? ' (replayed)' : ''}.` }],
    },
    async execute(args, exec) {
      const result = await runtime.publicReply(exec, args.request_id, args.reply_to, args.text)
      return { message_id: result.message.id, sequence: result.message.sequence, team_revision: result.teamRevision, replayed: result.replayed }
    },
  }), 'public reply tool')
}

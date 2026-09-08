import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CAPTAIN_APPROVAL_TOOL } from '../runtime/captain-tool-approval.js'
import { compactJsonOutput, register } from './shared.js'

export function registerToolApproval(ctx: Context): void {
  register(ctx, defineTool({
    name: CAPTAIN_APPROVAL_TOOL,
    description: 'Current Captain only. Decide one pending member tool call described in a Team approval message. Review its exact arguments first. Approval applies once to that original invocation and cannot override official tool restrictions. Unknown, expired, duplicate or foreign requests fail closed.',
    parameters: {
      request_id: { type: 'string', required: true },
      decision: { type: 'string', enum: ['approve', 'deny'], required: true },
    },
    output: compactJsonOutput({ type: 'object', additionalProperties: false, properties: {
      request_id: { type: 'string', required: true }, decision: { type: 'string', required: true },
    } }),
    async execute(args, exec) {
      await ctx.agentSwarmPermission.decideToolApproval(exec, args.request_id, args.decision as 'approve' | 'deny')
      return { request_id: args.request_id, decision: args.decision }
    },
  }), 'captain tool approval')
}

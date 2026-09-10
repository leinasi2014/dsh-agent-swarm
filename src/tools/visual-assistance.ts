/** Deliberate model calls; identities and image refs come only from the Host. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { ToolOutputDefinition } from '@deepseek-ai/dsh-tools'
import { publicVisualAssistanceOutcomeSchema, publicVisualAssistanceFailureSchema } from '../shared/public-image-content.js'
import type { AgentSwarmRuntime } from '../runtime/orchestrator-runtime.js'
import { requestVisualAssistance, completeVisualAssistance } from '../runtime/visual-assistance.js'
import { register } from './shared.js'

const text = { type: 'string' } as const
const output: ToolOutputDefinition = { schema: { type: 'object', additionalProperties: false, properties: {
  assistance_id: text, request_message_id: text, result_id: text, expires_at: { type: 'number' }, replayed: { type: 'boolean' },
  state: { type: 'string', enum: ['pending', 'completed', 'failed'] },
  outcome: { type: 'object', additionalProperties: false, properties: { state: { type: 'string', enum: ['completed', 'failed'] },
    summary: text, reason: { type: 'string', enum: publicVisualAssistanceFailureSchema.options } }, required: ['state'] },
}, required: ['assistance_id', 'request_message_id', 'result_id', 'expires_at', 'replayed', 'state'] },
render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
const result = (value: Awaited<ReturnType<typeof requestVisualAssistance>>) => ({ assistance_id: value.assistance.assistanceId,
  request_message_id: value.assistance.requestMessageId, result_id: value.assistance.resultId,
  expires_at: value.assistance.expiresAt, replayed: value.replayed, state: value.assistance.result?.outcome.state ?? 'pending',
  ...(value.assistance.result === undefined ? {} : { outcome: value.assistance.result.outcome }) })

export function registerVisualAssistanceTools(ctx: Context, runtime: AgentSwarmRuntime): void {
  register(ctx, { name: 'agent_swarm_request_visual_assistance',
    description: 'Ask another currently image-capable member from agent_swarm_directory to inspect images in a public message actually addressed to you. Reuse a stable request_id unchanged after an uncertain result. Pass only source_message_id and image_ids from your input, never file paths or attachment refs. The helper cannot delegate this request. This preserves task owner and review; the text result returns to you.',
    parameters: { type: 'object', additionalProperties: false, properties: { request_id: text, source_message_id: text,
      image_ids: { type: 'array', description: 'Select 1 to 256 unique original image IDs.', items: text }, helper_member_id: text,
      question: { type: 'string', description: 'Nonblank question, at most 8192 UTF-8 bytes after trimming.' } },
    required: ['request_id', 'source_message_id', 'image_ids', 'helper_member_id', 'question'] }, output,
    async execute(args, exec) {
      const input = z.object({ request_id: z.string(), source_message_id: z.string(), image_ids: z.array(z.string()),
        helper_member_id: z.string(), question: z.string() }).strict().parse(args)
      return result(await requestVisualAssistance(ctx, runtime, exec, { requestId: input.request_id,
        sourceMessageId: input.source_message_id, imageIds: input.image_ids, helperSessionId: input.helper_member_id, question: input.question }))
    },
  }, 'visual assistance request tool')
  register(ctx, { name: 'agent_swarm_complete_visual_assistance',
    description: 'Complete a visual assistance addressed to your exact Session. Use a stable request_id and assistance_id from the request. Outcome is {state:"completed",summary:"public description"} or {state:"failed",reason: one of helper-unavailable, image-capability-unknown, image-model-unsupported, image-unavailable, permission-revoked, expired}. Only the public summary returns to the requester; no task ownership or review changes.',
    parameters: { type: 'object', additionalProperties: false, properties: { request_id: text, assistance_id: text,
      // Use the official plain-JSON subset; Zod metadata and length/pattern keywords cannot form SDK types.
      // Runtime Zod/domain validation below still enforces length, nonblank text and image-set bounds.
      outcome: { oneOf: [
        { type: 'object', additionalProperties: false, properties: { state: { type: 'string', const: 'completed' },
          summary: { type: 'string', description: 'Nonblank public summary, 1 to 8192 UTF-16 code units.' } }, required: ['state', 'summary'] },
        { type: 'object', additionalProperties: false, properties: { state: { type: 'string', const: 'failed' },
          reason: { type: 'string', enum: publicVisualAssistanceFailureSchema.options } }, required: ['state', 'reason'] },
      ] } }, required: ['request_id', 'assistance_id', 'outcome'] }, output,
    async execute(args, exec) {
      const input = z.object({ request_id: z.string(), assistance_id: z.string(), outcome: publicVisualAssistanceOutcomeSchema }).strict().parse(args)
      return result(await completeVisualAssistance(ctx, runtime, exec, { requestId: input.request_id, assistanceId: input.assistance_id, outcome: input.outcome }))
    },
  }, 'visual assistance completion tool')
}

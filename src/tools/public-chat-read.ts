/** Model-facing C1 read tools: paged public history and exact public-message reads. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AgentSwarmRuntime } from '../runtime/orchestrator-runtime.js'
import {
  createPublicChatReadSurface, PUBLIC_HISTORY_DEFAULT_BYTES, PUBLIC_HISTORY_DEFAULT_LIMIT,
  PUBLIC_MESSAGE_DEFAULT_CHARS,
} from '../runtime/public-chat-read.js'
import { compactJsonOutput, register } from './shared.js'

const authorSchema = { type: 'object', additionalProperties: false, properties: {
  kind: { type: 'string', required: true }, session_id: { type: 'string' }, role: { type: 'string' },
  name: { type: 'string' }, display_name: { type: 'string' },
} } as const
const imageSchema = { type: 'object', additionalProperties: false, properties: {
  image_id: { type: 'string', required: true }, media_type: { type: 'string', required: true },
  bytes: { type: 'number', required: true }, width: { type: 'number', required: true },
  height: { type: 'number', required: true }, name: { type: 'string' },
} } as const
const rowSchema = { type: 'object', additionalProperties: false, properties: {
  message_id: { type: 'string', required: true }, sequence: { type: 'number', required: true },
  created_at: { type: 'number', required: true }, author: { required: true, ...authorSchema },
  text: { type: 'string', required: true }, images: { type: 'array', required: true, items: imageSchema },
  reply_to: { type: 'string' }, text_omitted_by_bytes: { type: 'boolean' }, text_total: { type: 'number' },
} } as const

const historyOutput = compactJsonOutput({ type: 'object', additionalProperties: false, properties: {
  entries: { type: 'array', required: true, items: rowSchema },
  total_count: { type: 'number', required: true }, returned_count: { type: 'number', required: true },
  limit: { type: 'number', required: true }, has_earlier: { type: 'boolean', required: true },
  has_more: { type: 'boolean', required: true }, truncated_by_bytes: { type: 'boolean', required: true },
  first_sequence: { type: 'number' }, last_sequence: { type: 'number' },
} })

const messageOutput = compactJsonOutput({ type: 'object', additionalProperties: false, properties: {
  ...rowSchema.properties,
  text_offset: { type: 'number', required: true }, max_chars: { type: 'number', required: true },
  text_total: { type: 'number', required: true }, truncated: { type: 'boolean', required: true },
  has_more_text: { type: 'boolean', required: true }, complete: { type: 'boolean', required: true },
} })

export function registerPublicChatReadTools(ctx: Context, runtime: AgentSwarmRuntime): void {
  const reads = createPublicChatReadSurface({
    ctx, domain: () => runtime.domain, scopeOf: agent => runtime.scopeOf(agent),
    closingSignal: () => runtime.closingSignal,
  })
  register(ctx, defineTool({
    name: 'agent_swarm_public_history',
    description: 'Read a recent bounded page of your Team\'s public messages with your own Session identity. Entries carry the full public text, author, optional reply_to and public image ids with metadata only — never attachment refs, request ids or private transcripts. Default returns the newest limit entries; before_sequence pages older, after_sequence pages newer (never both). The serialized page respects max_bytes exactly: under budget pressure it keeps the end your cursor continues from (the newest entries for default/before_sequence, the earliest for after_sequence) and has_earlier/has_more always describe exactly the returned kept range; if even one full entry cannot fit, the kept end returns as locatable headers (message_id, sequence and author kept, text emptied with text_omitted_by_bytes and text_total) — never an empty page. Continue paging from first_sequence/last_sequence and resolve each listed message_id fully with agent_swarm_public_message. An empty total_count means this Team genuinely has no public history. Reads wake nobody and never boot recovery, deliver, or create tasks.',
    parameters: {
      limit: { type: 'number', description: `Entries per page, 1..50 (default ${PUBLIC_HISTORY_DEFAULT_LIMIT}).` },
      before_sequence: { type: 'number', description: 'Page older than this exclusive sequence.' },
      after_sequence: { type: 'number', description: 'Page newer than this exclusive sequence.' },
      max_bytes: { type: 'number', description: 'Serialized page byte budget 1024..65536 (default 32768).' },
    },
    output: historyOutput,
    async execute(args, exec) {
      return await reads.history(exec, {
        limit: args.limit ?? PUBLIC_HISTORY_DEFAULT_LIMIT,
        ...(args.before_sequence === undefined ? {} : { beforeSequence: args.before_sequence }),
        ...(args.after_sequence === undefined ? {} : { afterSequence: args.after_sequence }),
        maxBytes: args.max_bytes ?? PUBLIC_HISTORY_DEFAULT_BYTES,
      })
    },
  }), 'public history tool')
  register(ctx, defineTool({
    name: 'agent_swarm_public_message',
    description: 'Read one of your Team\'s public messages by its exact public id (public-... as returned by agent_swarm_public_history or a delivery frame). Over-long originals are never silently truncated: the page reports text_offset/text_total with explicit truncated and has_more_text, and you continue by calling again with the next offset (Unicode code points, complete only covers what was returned). Text is sliced at code-point boundaries, so no character can split; images expose public image ids and metadata only. Refusals distinguish an unknown id from an invalid offset. Reads wake nobody and never boot recovery, deliver, or create tasks.',
    parameters: {
      message_id: { type: 'string', required: true },
      offset: { type: 'number', description: 'Code-point offset into the public text (default 0).' },
      max_chars: { type: 'number', description: 'Maximum code points returned, 1..20000 (default 8000).' },
    },
    output: messageOutput,
    async execute(args, exec) {
      return await reads.message(exec, {
        messageId: args.message_id, offset: args.offset ?? 0, maxChars: args.max_chars ?? PUBLIC_MESSAGE_DEFAULT_CHARS,
      })
    },
  }), 'public message tool')
}

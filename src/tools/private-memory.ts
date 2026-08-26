/**
 * The two member-private-memory tools (2026-08-26): append-only, member-private
 * memory persisted in the plugin-owned `agent_swarm_member_private_memory`
 * Storage Domain (see `src/storage/member-private-memory.ts`). They are
 * appended after the established 19-tool surface and both are member-facing:
 * there is no target-member parameter, authority is the current active owning
 * member resolved through the runtime membership gate, and the private content
 * never appears on Team/Host/RPC read surfaces.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { TeamDomainError } from '../domain/error.js'
import { MemberPrivateMemoryService } from '../runtime/member-private-memory-service.js'
import { MemberPrivateMemoryStore } from '../storage/member-private-memory.js'
import { compactJsonOutput, register } from './shared.js'
import { pageWindow } from './read-surface.js'

/** Shared bounded cursor contract (the established aggregate-backed readers' pageWindow). */
function privatePageWindow(args: { cursor?: number; limit?: number }): { cursor: number; limit: number } {
  return pageWindow(args)
}const PRIVATE_MEMORY_ROW_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    memory_id: { type: 'string', required: true },
    content: { type: 'string', required: true },
    evidence_refs: { type: 'array', required: true, items: { type: 'string' } },
    evidence_refs_truncated: { type: 'boolean', required: true },
    created_at: { type: 'number', required: true },
    seq: { type: 'number', required: true },
  },
} as const

const PRIVATE_MEMORY_LIST_VALUE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    memories: { type: 'array', required: true, items: PRIVATE_MEMORY_ROW_SCHEMA },
    next_cursor: { type: 'number', description: 'Present only when more rows exist.' },
  },
} as const

const PRIVATE_MEMORY_ADD_VALUE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    memory_id: { type: 'string', required: true },
    seq: { type: 'number', required: true },
  },
} as const

/** `agent_swarm_add_private_memory`: append one record to the caller's own private memory. */
export function registerAddPrivateMemoryTool(ctx: Context, service: MemberPrivateMemoryService | undefined): void {
  register(ctx, defineTool({
    name: 'agent_swarm_add_private_memory',
    description: 'Append one private-memory record to your own durable member-private memory. Only you, the current active owning member, can read or write this private memory; no other member, the captain, or an external session can access it. There is no target member. This never touches the shared Team memory or any Team aggregate state.',
    parameters: {
      content: { type: 'string', required: true },
      evidence_refs: { type: 'array', items: { type: 'string' } },
    },
    output: compactJsonOutput(PRIVATE_MEMORY_ADD_VALUE_SCHEMA),
    async execute(args, exec) {
      if (service === undefined) {
        throw new TeamDomainError('member private memory service is not mounted', 'TEAM_PRIVATE_MEMORY_UNAVAILABLE')
      }
      const record = await service.add(exec, args.content, args.evidence_refs ?? [])
      return { memory_id: record.memoryId, seq: record.seq }
    },
  }), 'add private memory tool')
}

/** `agent_swarm_list_private_memory`: explicitly read the caller's own private memory. */
export function registerListPrivateMemoryTool(ctx: Context, service: MemberPrivateMemoryService | undefined): void {
  register(ctx, defineTool({
    name: 'agent_swarm_list_private_memory',
    description: 'Explicitly list your own durable private-memory records in creation order with cursor pagination (limit 1-100, default 50; use next_cursor to continue). Only you, the current active owning member, can read this private memory. Pure point-in-time read: no prompt injection, no semantic search, no LLM extraction, and no change to any Team state.',
    parameters: {
      cursor: { type: 'integer', description: 'Zero-based result offset. Defaults to 0.' },
      limit: { type: 'integer', description: 'Number of rows, 1 through 100. Defaults to 50.' },
    },
    output: compactJsonOutput(PRIVATE_MEMORY_LIST_VALUE_SCHEMA),
    async execute(args, exec) {
      if (service === undefined) {
        throw new TeamDomainError('member private memory service is not mounted', 'TEAM_PRIVATE_MEMORY_UNAVAILABLE')
      }
      const { cursor, limit } = privatePageWindow(args)
      const page = await service.list(exec, { cursor, limit })
      const memories = page.rows.map(row => MemberPrivateMemoryStore.row(row))
      return { memories, ...(page.nextCursor === undefined ? {} : { next_cursor: page.nextCursor }) }
    },
  }), 'list private memory tool')
}

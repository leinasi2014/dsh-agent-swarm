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
import type { PrivateMemoryMaintenanceInput } from '../storage/member-private-memory-operations.js'
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
    // Fold metadata: present only on rows maintenance touched or v2 created
    // (explicitly marked via created_via, never inferred), so legacy v1-only
    // partitions keep the byte-identical historical row shape.
    status: { type: 'string', description: "Fold status: 'active', 'invalidated', or 'superseded'." },
    head_seq: { type: 'number', description: 'Newest operation seq touching this note (folded rows only).' },
    superseded_by: { type: 'string', description: 'Replacement note id when this row was superseded by a replace.' },
    provenance: {
      type: 'object', additionalProperties: false,
      description: "Host-derived origin: {kind:'unattributed'} or {kind:'task', task_id, attempt_id?, team_revision, observed_at}.",
      properties: {
        kind: { type: 'string', required: true },
        task_id: { type: 'string' },
        attempt_id: { type: 'string' },
        team_revision: { type: 'number' },
        observed_at: { type: 'number' },
      },
    },
    tags: { type: 'array', items: { type: 'string' }, description: 'Canonical tags (trimmed, deduped, stable order) from the latest complete payload.' },
    applicability: { type: 'string', description: "Bounded plain-text applicability from the latest complete payload; '' means unconditional." },
    created_via: {
      type: 'object', additionalProperties: false,
      description: 'Set when this note was created BY a v2 add/replace operation (explicit creation origin).',
      properties: {
        operation_id: { type: 'string', required: true },
        operation: { type: 'string', required: true },
        seq: { type: 'number', required: true },
      },
    },
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

/** The strict receipt value the maintenance tool returns (the minimal prefix receipt). */
const PRIVATE_MEMORY_MAINTAIN_VALUE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    operation_id: { type: 'string', required: true },
    operation: { type: 'string', required: true, enum: ['add', 'revise', 'invalidate', 'replace'] },
    operation_seq: { type: 'number', required: true },
    result_memory_id: { type: 'string', required: true },
    head_seq: { type: 'number', required: true },
    status: { type: 'string', required: true, enum: ['active', 'invalidated', 'superseded'] },
    replaced_memory_id: { type: 'string', description: 'Set only by replace: the superseded note this operation replaced.' },
    replayed: { type: 'boolean', required: true, description: 'true when this call was a legal retry of a previously committed operation and appended NOTHING.' },
  },
} as const

/** Per-branch strict input face; anything outside the whitelist is rejected WITHOUT echoing values. */
function maintenanceInputFromArgs(operation: string, args: Record<string, unknown>): PrivateMemoryMaintenanceInput {
  const invalid = (field: string): TeamDomainError =>
    new TeamDomainError(`agent_swarm_maintain_private_memory input is invalid: ${field}`, 'TEAM_INPUT_INVALID')
  const whitelist: Record<string, readonly string[]> = {
    add: ['operation', 'operation_id', 'content', 'evidence_refs', 'tags', 'applicability'],
    revise: ['operation', 'operation_id', 'target_memory_id', 'expected_head_seq', 'content', 'evidence_refs', 'tags', 'applicability'],
    invalidate: ['operation', 'operation_id', 'target_memory_id', 'expected_head_seq'],
    replace: ['operation', 'operation_id', 'target_memory_id', 'expected_head_seq', 'content', 'evidence_refs', 'tags', 'applicability'],
  }
  const allowed = whitelist[operation]
  if (allowed === undefined) throw invalid('operation')
  for (const key of Object.keys(args)) if (!allowed.includes(key)) throw invalid(`unknown field '${key}'`)
  const text = (key: string): string => {
    const value = args[key]
    if (typeof value !== 'string') throw invalid(key)
    return value
  }
  // Presence is REQUIRED, never defaulted: a payload-bearing branch missing any
  // of the four fields must reject, so an omission can never silently clear
  // prior metadata under a promise of FULL replacement.
  const strings = (key: string): string[] => {
    const value = args[key]
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw invalid(key)
    return value as string[]
  }
  const operationId = text('operation_id')
  const payloadFields = () => ({
    content: text('content'),
    evidenceRefs: strings('evidence_refs'),
    tags: strings('tags'),
    applicability: text('applicability'),
  })
  if (operation === 'add') return { operation: 'add', operationId, ...payloadFields() }
  const targetMemoryId = text('target_memory_id')
  const expectedHeadSeq = args.expected_head_seq
  if (!Number.isInteger(expectedHeadSeq)) throw invalid('expected_head_seq')
  if (operation === 'invalidate') return { operation: 'invalidate', operationId, targetMemoryId, expectedHeadSeq: expectedHeadSeq as number }
  const branch = operation as 'revise' | 'replace'
  return { operation: branch, operationId, targetMemoryId, expectedHeadSeq: expectedHeadSeq as number, ...payloadFields() }
}

/**
 * `agent_swarm_maintain_private_memory`: one durable self-maintenance write on
 * the caller's OWN private memory (add/revise/invalidate/replace). A stable
 * `operation_id` makes the logical operation retry-idempotent: a legal retry
 * (same normalized input) appends nothing and replays the ORIGINAL receipt
 * (`replayed: true`); the same id with different content is a conflict. The
 * caller's identity, Team, provenance and seq are Host-derived and not
 * expressible as input.
 */
export function registerMaintainPrivateMemoryTool(ctx: Context, service: MemberPrivateMemoryService | undefined): void {
  register(ctx, defineTool({
    name: 'agent_swarm_maintain_private_memory',
    description: 'Perform ONE durable maintenance write on your own private memory: add (a strict v2 note), revise (FULL replacement of a note\'s content and metadata — no partial patch), invalidate (terminal), or replace (supersede one note IN ONE operation while tail-appending the complete new note). `expected_head_seq` is record-level CAS: the target note\'s newest-operation seq you actually saw; a stale value conflicts and writes nothing. A stable `operation_id` makes this retry-idempotent: retrying the SAME logical operation (same branch, target/head and payload) appends nothing and replays the original receipt with `replayed: true` even after capacity or head moved on; the same operation_id with DIFFERENT content is a conflict. Your identity, provenance and record seq are Host-derived and cannot be supplied here. Only you, the current active owning member, may maintain this private memory; it never touches shared Team memory.',
    parameters: {
      operation: { type: 'string', required: true, enum: ['add', 'revise', 'invalidate', 'replace'] },
      operation_id: { type: 'string', required: true, description: 'Stable caller-chosen id (≤128 UTF-8 bytes) making this logical operation retry-idempotent. Reuse it UNCHANGED when retrying the same write.' },
      target_memory_id: { type: 'string', description: 'The note this operation maintains (memory_id from list). Required for revise/invalidate/replace; absent for add.' },
      expected_head_seq: { type: 'integer', description: 'CAS: the target note\'s newest-operation seq at the time you composed this write — use the list row\'s head_seq when present; for an untouched legacy v1 row without head_seq, use its seq. Required for revise/invalidate/replace.' },
      content: { type: 'string', description: 'REQUIRED (with evidence_refs, tags and applicability) for add/revise/replace — a payload-bearing branch missing any of the four rejects rather than silently clearing metadata. Complete note content (≤16,384 UTF-8 bytes); forbidden for invalidate.' },
      evidence_refs: { type: 'array', items: { type: 'string' }, description: 'REQUIRED array (may be empty) for add/revise/replace; forbidden for invalidate. Up to 64 evidence references, each ≤2,048 bytes.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'REQUIRED array (may be empty) for add/revise/replace; forbidden for invalidate. Up to 32 tags, each ≤128 bytes; canonicalized (trimmed, deduplicated, stable order).' },
      applicability: { type: 'string', description: 'REQUIRED string for add/revise/replace (\'\' = unconditional), ≤2,048 bytes; forbidden for invalidate. Revise is a FULL replacement: these four fields replace the note\'s current content and metadata completely — no partial patch.' },
    },
    output: compactJsonOutput(PRIVATE_MEMORY_MAINTAIN_VALUE_SCHEMA),
    async execute(args, exec) {
      if (service === undefined) {
        throw new TeamDomainError('member private memory service is not mounted', 'TEAM_PRIVATE_MEMORY_UNAVAILABLE')
      }
      const record = args as unknown as Record<string, unknown>
      const operation = typeof record.operation === 'string' ? record.operation : ''
      const input = maintenanceInputFromArgs(operation, record)
      const { receipt, replayed } = await service.maintain(exec, input)
      return {
        operation_id: receipt.operationId,
        operation: receipt.operation,
        operation_seq: receipt.operationSeq,
        result_memory_id: receipt.resultMemoryId,
        head_seq: receipt.headSeq,
        status: receipt.status,
        ...(receipt.replacedMemoryId === undefined ? {} : { replaced_memory_id: receipt.replacedMemoryId }),
        replayed,
      }
    },
  }), 'maintain private memory tool')
}

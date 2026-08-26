/**
 * The `agent_swarm` Storage Domain declaration (ADR-0007, M1A): the durable
 * boundary of the authoritative Team aggregate. One record per Team in the
 * `teams` table, one migration receipt per migrated Team in
 * `migration_receipts`. Record schemas are zod at the durable boundary —
 * mirroring `assertTeamState` structurally — exactly as the official
 * Storage Domain form prescribes.
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { MigrationReceipt, TeamScope } from '../domain/team-domain-port.js'
import type { TeamId, TeamState } from '../domain/types.js'

/** Storage Domain unit/table names must satisfy the official `UNIT_NAME_RE`. */
export const TEAM_DOMAIN_NAME = 'agent_swarm'
/** Domain format version; a medium stamped differently rejects at open. */
export const TEAM_DOMAIN_VERSION = 1

const teamIdSchema = z.string().regex(/^team-[a-z0-9-]{8,80}$/)
const sessionId = z.string().min(1)
const timestamp = z.number().int().min(0)

const memberSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  sessionId,
  provider: z.string().min(1),
  phase: z.enum(['provisioning', 'active', 'failed', 'removed']),
  createdAt: timestamp,
  error: z.string().min(1).optional(),
})

const taskSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().min(1),
  subject: z.string().min(1),
  description: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)),
  status: z.enum(['pending', 'in_progress', 'submitted', 'verifying', 'completed', 'failed', 'cancelled']),
  blockedBy: z.array(z.string().min(1)),
  writeScopes: z.array(z.string().min(1)),
  priority: z.number().int(),
  // Durable-boundary additive optionals (M4-3, issue #129, declared here
  // after the probe-proven strip defect — the official load path parses every
  // stored record through this schema, and zod drops undeclared keys): the
  // frozen verification list (#101) and the reservation floor. Absent fields
  // parse; every pre-existing record is byte-identical.
  verification: z.array(z.object({
    command: z.string().min(1),
    timeoutMs: z.number().int().min(1).optional(),
  })).optional(),
  reservationTokens: z.number().int().min(1).optional(),
  targetMemberSessionId: sessionId.optional(),
  ownerSessionId: sessionId.optional(),
  currentAttemptId: z.string().min(1).optional(),
  output: z.string().min(1).optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
})

const attemptSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  generation: z.number().int().min(1),
  memberSessionId: sessionId,
  phase: z.enum(['running', 'submitted', 'verifying', 'accepted', 'rejected', 'cancelled', 'stale']),
  assignmentPhase: z.enum(['reserved', 'delivered']),
  assignmentDeliveredAt: timestamp.optional(),
  // #83 in-place retry linkage — same durable-boundary declaration fix.
  replacesAttemptId: z.string().min(1).optional(),
  output: z.string().min(1).optional(),
  evidence: z.array(z.string().min(1)),
  diagnostic: z.string().min(1).optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
})

const messageSchema = z.object({
  id: z.string().min(1),
  senderSessionId: sessionId,
  senderName: z.string().min(1),
  targetSessionId: sessionId,
  targetName: z.string().min(1),
  content: z.string().min(1),
  delivery: z.enum(['quiet', 'wakeup']),
  phase: z.enum(['queued', 'delivered', 'cancelled']),
  createdAt: timestamp,
  deliveredAt: timestamp.optional(),
})

const budgetSchema = z.object({
  tokenLimit: z.number().int().min(1).optional(),
  requestLimit: z.number().int().min(1).optional(),
  retryLimit: z.number().int().min(1).optional(),
  deadlineAt: z.number().int().min(1).optional(),
  usedTokens: z.number().int().min(0),
  usedRequests: z.number().int().min(0),
  usedRetries: z.number().int().min(0),
})

const memorySchema = z.object({
  id: z.string().min(1),
  category: z.enum(['decision', 'lesson', 'member', 'context']),
  content: z.string().min(1),
  evidenceRefs: z.array(z.string().min(1)),
  createdAt: timestamp,
})

/** Structural durable-boundary schema of one `teams` record. */
const storedTeamRecordSchema = z.object({
  workspace: z.string().min(1),
  team: z.object({
    schemaVersion: z.literal(1),
    id: teamIdSchema,
    revision: z.number().int().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    captainSessionId: sessionId,
    phase: z.enum(['active', 'archived']),
    members: z.array(memberSchema),
    tasks: z.array(taskSchema),
    attempts: z.array(attemptSchema),
    messages: z.array(messageSchema),
    budget: budgetSchema,
    usageCursors: z.record(z.string().min(1), z.number().int().min(-1)),
    memory: z.array(memorySchema),
    nextTaskNumber: z.number().int().min(1),
    nextMemoryNumber: z.number().int().min(1),
    createdAt: timestamp,
    updatedAt: timestamp,
  }),
})

/**
 * One persisted Team record: the workspace-scope envelope plus the complete
 * versioned aggregate. Keeping one Team in one record preserves the existing
 * revision transaction boundary while the store stays explicitly
 * process-local. The hand-written type mirrors the zod schema; the schema
 * object itself (not this annotation) performs the durable validation.
 */
export interface TeamRecord {
  readonly workspace: TeamScope
  readonly team: TeamState
}

// Single contained type-erasure: the zod literal owns runtime validation at
// the durable boundary; `TeamRecord` is its precise in-memory projection.
const teamRecordSchema = storedTeamRecordSchema as unknown as z.ZodType<TeamRecord>

/** Stored `migration_receipts` record schema; ids re-brand through transform. */
const migrationReceiptSchema: z.ZodType<MigrationReceipt> = z.object({
  teamId: teamIdSchema.transform(value => value as TeamId),
  scope: z.string().min(1),
  sourcePath: z.string().min(1),
  sourceSha256: z.string().length(64),
  revision: z.number().int().min(1),
  migratedAt: timestamp,
})

/** The `agent_swarm` domain spec opened through `ctx.storageDomain`. */
export const teamDomainSpec = defineDomain({
  name: TEAM_DOMAIN_NAME,
  version: TEAM_DOMAIN_VERSION,
  tables: {
    teams: domainTable<TeamId, TeamRecord>(teamRecordSchema),
    migration_receipts: domainTable<string, MigrationReceipt>(migrationReceiptSchema),
  },
})

/** Build one durable record envelope from an in-memory aggregate. */
export function teamRecordOf(scope: TeamScope, team: TeamState): TeamRecord {
  return { workspace: scope, team: structuredClone(team) }
}

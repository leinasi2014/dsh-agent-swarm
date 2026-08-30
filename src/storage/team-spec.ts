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
import { CAPTAIN_ANNOUNCEMENT_ID_RE, isSafePixelAvatarSvg, MAX_CAPTAIN_ANNOUNCEMENTS } from '../domain/identity-profile.js'
import type { MigrationReceipt, TeamScope } from '../domain/team-domain-port.js'
import type { TeamId, TeamState } from '../domain/types.js'
import { MAX_TEAM_ALLOWED_SKILLS } from '../domain/team-skill-policy.js'

/** Storage Domain unit/table names must satisfy the official `UNIT_NAME_RE`. */
export const TEAM_DOMAIN_NAME = 'agent_swarm'
/** Domain format version; a medium stamped differently rejects at open. */
export const TEAM_DOMAIN_VERSION = 1

const teamIdSchema = z.string().regex(/^team-[a-z0-9-]{8,80}$/)
const sessionId = z.string().min(1)
const timestamp = z.number().int().min(0)

/**
 * Durable-boundary code-point cap matching the admission limit
 * (`normalizeMemberIdentity` uses `[...value].length`). `z.string().max(N)`
 * counts UTF-16 code units, so a 128-codepoint emoji displayName (256 units)
 * would be wrongly rejected on reload; this mirrors the same codepoint rule so
 * 128 emoji restart PASS and 129 FAIL identically to admission.
 */
const codePointCapped = (max: number, label: string): z.ZodType<string> =>
  z.string().min(1).superRefine((value, ctx) => {
    if ([...value].length > max) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} exceeds ${max} code points` })
    }
  }) as unknown as z.ZodType<string>

const memberSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  sessionId,
  provider: z.string().min(1),
  phase: z.enum(['provisioning', 'active', 'failed', 'removed']),
  createdAt: timestamp,
  error: z.string().min(1).optional(),
  // Captain-declared identity profile. All optional so pre-existing records
  // parse byte-identical; text limits mirror admission (code points) and the
  // stored avatar is re-allowlisted at the durable boundary so an unsafe svg
  // that somehow reached storage is rejected on load.
  displayName: codePointCapped(128, 'displayName').optional(),
  profession: codePointCapped(256, 'profession').optional(),
  personality: codePointCapped(1024, 'personality').optional(),
  pixelAvatarSvg: z.string().min(1).max(16384)
    .refine(isSafePixelAvatarSvg, { message: 'pixelAvatarSvg violates the strict allowlist' })
    .optional(),
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
  phase: z.enum(['queued', 'delivered', 'cancelled', 'obsolete']),
  createdAt: timestamp,
  deliveredAt: timestamp.optional(),
  // Mail-obsolescence causal identity, explicit supersede and obsolete
  // settlement. All optional so pre-existing records parse byte-identical;
  // a record that settles obsolete carries obsoletedReason/obsoletedAt.
  causal: z.object({
    taskId: z.string().min(1).optional(),
    attemptId: z.string().min(1).optional(),
    revision: z.number().int().min(1).optional(),
  }).optional(),
  supersedes: z.string().min(1).optional(),
  supersededBy: z.string().min(1).optional(),
  obsoletedAt: timestamp.optional(),
  obsoletedReason: z.string().min(1).optional(),
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

const interactionEffectSchema = z.object({
  effectId: z.string().regex(/^i1b:[a-f0-9]{64}$/),
  requestId: z.string().regex(/^human-[a-z0-9-]{8,80}$/),
  step: z.literal('member-question-relay-mail'),
  bindingDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  senderSessionId: sessionId,
  targetSessionId: sessionId,
  bodyDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  delivery: z.enum(['quiet', 'wakeup']),
  messageId: z.string().min(1),
  resultingTeamRevision: z.number().int().min(1),
  committedAt: timestamp,
}).strict()

const captainProfileSchema = z.object({
  displayName: codePointCapped(128, 'captainProfile.displayName').optional(),
  profession: codePointCapped(256, 'captainProfile.profession').optional(),
  personality: codePointCapped(1024, 'captainProfile.personality').optional(),
  pixelAvatarSvg: z.string().min(1).max(16384)
    .refine(isSafePixelAvatarSvg, { message: 'captainProfile.pixelAvatarSvg violates the strict allowlist' })
    .optional(),
}).strict().superRefine((profile, ctx) => {
  // Captain profile must be an object carrying at least one canonical field.
  const hasField = profile.displayName !== undefined || profile.profession !== undefined
    || profile.personality !== undefined || profile.pixelAvatarSvg !== undefined
  if (!hasField) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'captainProfile requires at least one field' })
  }
  for (const key of ['displayName', 'profession', 'personality'] as const) {
    const v = profile[key]
    if (typeof v === 'string' && v !== v.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `captainProfile.${key} must be canonical (trimmed)` })
    }
  }
})

const announcementSchema = z.object({
  id: z.string().regex(CAPTAIN_ANNOUNCEMENT_ID_RE, { message: 'announcement id must be ann-<uuid>' }),
  text: codePointCapped(4096, 'announcement.text').refine(v => v === v.trim(), { message: 'announcement text must be canonical (trimmed)' }),
  createdAt: timestamp,
})

function announcementsSchema() {
  return z.array(announcementSchema).max(MAX_CAPTAIN_ANNOUNCEMENTS).superRefine((entries, ctx) => {
    const seen = new Set<string>()
    let previous = -1
    entries.forEach((entry, index) => {
      if (seen.has(entry.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `announcement[${index}].id is not unique` })
      }
      seen.add(entry.id)
      if (entry.createdAt < previous) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `announcement[${index}].createdAt is not non-decreasing` })
      }
      previous = entry.createdAt
    })
  })
}

const teamFields = {
    id: teamIdSchema,
    revision: z.number().int().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    captainSessionId: sessionId,
    phase: z.enum(['active', 'archived']),
    // Managed-Team operation identity (MainBrainSessionId + turn). Optional and
    // absent on plain captain-owned compatibility Teams so pre-existing records
    // parse byte-identical; a managed Team persists it so reload can reuse.
    managedOrigin: z.string().min(1).optional(),
    // Immutable Team Skill policy. Optional preserves pre-policy teams;
    // canonical names are revalidated at the durable boundary.
    allowedSkills: z.array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)).min(1).max(MAX_TEAM_ALLOWED_SKILLS)
      .superRefine((names, ctx) => {
        if (new Set(names).size !== names.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'allowedSkills must be unique' })
        if (names.some((name, index) => index > 0 && names[index - 1]! >= name)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'allowedSkills must be sorted' })
        }
      }).optional(),
    members: z.array(memberSchema),
    // Captain self-declared profile + public announcements + public goal
    // (schema v2 additive; absent on pre-feature records so they parse byte-identical).
    publicGoal: codePointCapped(4096, 'publicGoal').refine(v => v === v.trim(), { message: 'publicGoal must be canonical (trimmed)' }).optional(),
    captainProfile: captainProfileSchema.optional(),
    announcements: announcementsSchema().optional(),
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
}

const teamSchema = z.discriminatedUnion('schemaVersion', [
  z.object({ schemaVersion: z.literal(1), ...teamFields }).strict(),
  z.object({ schemaVersion: z.literal(2), ...teamFields, interactionEffects: z.array(interactionEffectSchema) }).strict(),
])

/** Structural durable-boundary schema of one `teams` record. */
const storedTeamRecordSchema = z.object({
  workspace: z.string().min(1),
  team: teamSchema,
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

/** The durable `agent_swarm` domain spec opened through `ctx.storageDomain`. */
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

/**
 * The `agent_swarm_skills_management` Storage Domain (S1 skills-management
 * module): the module-owned, durable truth behind the Captain skill-request
 * face and the per-Team management consumer cursor.
 *
 * Deliberately NOT TeamState and not a second Team state machine: the
 * authoritative `agent_swarm` aggregate is untouched; this domain stores only
 * (a) one request-intent record per Captain skill request and (b) one
 * consumer record per Team holding the activity cursor, dedup watermark,
 * page-pending references, and the explicit gap/conflict/source ledger. The
 * consumer record is advanced by ONE atomic `KvTable.update` per page — the
 * official single-record atomic transform is the only claimed atomicity;
 * there is no cross-table transaction and no Team-ledger copying.
 *
 * Identity discipline mirrors the member-private-memory precedent: every read
 * re-checks that the record's own fields re-derive its table key, so a
 * smuggled or corrupted record fails loud (`SKILLS_TAMPERED`) and never
 * surfaces in another Team's view.
 *
 * @module dsh-agent-swarm/storage/skills-management
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable, type Domain, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import { TeamDomainError } from '../domain/error.js'
import { CommitSequence } from '../util/commit-sequence.js'

/** Storage Domain unit/table names must satisfy the official `UNIT_NAME_RE`. */
const SKILLS_MANAGEMENT_DOMAIN_NAME = 'agent_swarm_skills_management'
/** Domain format version; a medium stamped differently rejects at open. */
const SKILLS_MANAGEMENT_DOMAIN_VERSION = 1

const timestamp = z.number().int().min(0)
const bounded = (maxBytes: number) => z.string().min(1).refine(
  value => Buffer.byteLength(value, 'utf8') <= maxBytes,
  `must not exceed ${maxBytes} UTF-8 bytes`,
)
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/)

/** One evidence entry: an opaque reference, optionally an external file with the hash it was recorded under. */
const skillsEvidenceEntrySchema = z.object({
  ref: bounded(2_048),
  external: z.boolean(),
  sha256: sha256Hex.optional(),
}).strict()
export type SkillsEvidenceEntry = z.infer<typeof skillsEvidenceEntrySchema>

/** The canonical request payload whose hash is the idempotency discriminator. */
export const skillsRequestPayloadSchema = z.object({
  question: bounded(8_192),
  goal: bounded(8_192).optional(),
  taskId: bounded(256).optional(),
  attemptId: bounded(256).optional(),
  /** Optional adoption target: the release answer only ever names THIS skill. */
  skillName: bounded(256).optional(),
  evidence: z.array(skillsEvidenceEntrySchema).max(64),
}).strict()
export type SkillsRequestPayload = z.infer<typeof skillsRequestPayloadSchema>

export const SKILLS_REQUEST_STATES = ['received', 'investigating', 'available', 'needs_evidence', 'unavailable', 'failed', 'cancelled'] as const
const SKILLS_EVIDENCE_STATES = ['proven', 'referenced', 'needs_evidence'] as const

const skillsRequestRecordSchema = z.object({
  schemaVersion: z.literal(1),
  scope: bounded(4_096),
  teamId: bounded(256),
  requestId: bounded(128),
  revision: z.number().int().min(1),
  payloadHash: sha256Hex,
  payload: skillsRequestPayloadSchema,
  state: z.enum(SKILLS_REQUEST_STATES),
  reason: bounded(2_048).optional(),
  result: z.object({
    availableVersion: z.object({ name: bounded(256), version: bounded(256) }).strict().optional(),
    /** Durable attribution of one REAL adoption (exact member Session/task/attempt + pinned manifest; never re-inferable from the current assignment list later). */
    attribution: z.object({ memberSessionId: bounded(256), taskId: bounded(256), attemptId: bounded(256).optional(), name: bounded(256), version: bounded(64), manifestHash: sha256Hex }).strict().optional(),
    evidenceStates: z.array(z.object({
      ref: bounded(2_048),
      state: z.enum(SKILLS_EVIDENCE_STATES),
      detail: bounded(512).optional(),
    }).strict()).max(128).optional(),
    sourceRevision: z.number().int().min(1).optional(),
    activityCursorSequence: z.number().int().min(0).optional(),
  }).strict().optional(),
  captainSessionId: bounded(256),
  managerSessionId: bounded(256).optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict()
export type SkillsRequestRecord = z.infer<typeof skillsRequestRecordSchema>

const consumerAnchorSchema = z.object({
  sequence: z.number().int().min(1),
  id: bounded(256),
}).strict()
const consumerBatchRefSchema = z.object({
  sequence: z.number().int().min(1),
  id: bounded(256),
  kind: bounded(64),
  taskId: bounded(256).optional(),
  attemptId: bounded(256).optional(),
  workRequestId: bounded(256).optional(),
}).strict()

/**
 * The ONE honest consumer over the official Team aggregate:
 * - at most ONE un-acked pending batch per Team (`pendingBatch`, ≤ pageSize
 *   ≤ 100 refs carrying kind); an un-acked batch is RE-SERVED, never
 *   extended, never evicted, and re-serving writes nothing;
 * - durable observed seq-ID anchors (≤ 1024, aligned with the official
 *   source retention) to detect a replaced ID at a retained sequence inside
 *   the observable window only — no claims outside it;
 * - a durable `lastAck` for idempotent ack read-back (same canonical payload
 *   replays, a differing payload conflicts, an unknown batch is refused);
 * - needsResync / regression / gaps / conflicts are sticky and deduplicated
 *   by stable identity; overflow is counted loudly, never silently sliced
 *   away; a normal read can NEVER wash an outstanding resync condition.
 */
const skillsConsumerRecordSchema = z.object({
  schemaVersion: z.literal(1),
  scope: bounded(4_096),
  teamId: bounded(256),
  /** Host/module generation that owns this consumer (fencing token). */
  generation: z.number().int().min(1),
  baseline: z.object({
    capturedTeamRevision: z.number().int().min(1),
    retainedFromSequence: z.number().int().min(1).optional(),
    throughSequence: z.number().int().min(0),
    legacyNoWorkActivity: z.boolean(),
    taskWatermarks: z.array(z.object({
      taskId: bounded(256),
      revision: z.number().int().min(1),
      status: bounded(64),
      currentAttemptId: bounded(256).optional(),
    }).strict()).max(400),
  }).strict().optional(),
  cursorSequence: z.number().int().min(0),
  lastEventId: bounded(256).optional(),
  pendingBatch: z.object({
    batchId: bounded(256),
    capturedAt: timestamp,
    refs: z.array(consumerBatchRefSchema).min(1).max(100),
  }).strict().optional(),
  lastAck: z.object({
    batchId: bounded(256),
    /** Kept so a lost-ACK retry can be re-canonicalized and idempotently replayed. */
    refs: z.array(consumerBatchRefSchema).min(1).max(100),
    /** SHA-256 over the canonical ack payload (batchId + outcome + refs). */
    payloadHash: sha256Hex,
    outcome: bounded(512),
    ackedAt: timestamp,
  }).strict().optional(),
  anchors: z.array(consumerAnchorSchema).max(1024).default([]),
  anchorsDropped: z.number().int().min(0).default(0),
  gaps: z.array(z.object({
    fromSequence: z.number().int().min(1),
    toSequence: z.number().int().min(1),
    observedAt: timestamp,
  }).strict()).max(1024),
  /** True only if dedup'd outstanding items ever exceeded the ledger cap. */
  gapsTruncated: z.boolean().default(false),
  conflicts: z.array(z.object({
    sequence: z.number().int().min(1),
    expectedEventId: bounded(256),
    actualEventId: bounded(256),
    observedAt: timestamp,
  }).strict()).max(1024),
  conflictsTruncated: z.boolean().default(false),
  sourceRegression: z.object({
    cursorSequence: z.number().int().min(0),
    observedThroughSequence: z.number().int().min(0),
    observedAt: timestamp,
  }).strict().optional(),
  sourceState: z.enum(['unknown', 'available', 'archived', 'missing']),
  /** STICKY: only a legitimate bounded recovery advances it, never a plain read. */
  needsResync: z.boolean(),
  updatedAt: timestamp,
}).strict()
export type SkillsConsumerRecord = z.infer<typeof skillsConsumerRecordSchema>
export type SkillsConsumerAnchor = z.infer<typeof consumerAnchorSchema>
export type SkillsConsumerBatchRef = z.infer<typeof consumerBatchRefSchema>

/** Durable binding of the module-owned manager Session identity: restarts resume the SAME Session (same identity/tools/permissions) instead of randomizing to a new one and stranding `investigating` holders. */
const skillsManagerBindingSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: bounded(256),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict()
export type SkillsManagerBinding = z.infer<typeof skillsManagerBindingSchema>
const storedManagerBindingSchema = skillsManagerBindingSchema as unknown as z.ZodType<SkillsManagerBinding>

// Single contained type-erasure at the durable boundary (team-spec pattern).
const storedRequestSchema = skillsRequestRecordSchema as unknown as z.ZodType<SkillsRequestRecord>
const storedConsumerSchema = skillsConsumerRecordSchema as unknown as z.ZodType<SkillsConsumerRecord>

/**
 * One APPROVED immutable release (S2 first slice): the manifest CAPTURES the
 * exact body text it was approved against, so immutability is physical (the
 * assembly serves this text, never a later source state).
 */
const skillsReleaseRecordSchema = z.object({
  schemaVersion: z.literal(1),
  scope: bounded(4_096),
  teamId: bounded(256),
  name: bounded(256),
  version: bounded(64),
  provider: bounded(256),
  locator: bounded(1_024),
  body: bounded(65_536),
  contentSha256: sha256Hex,
  resourcesSha256: sha256Hex,
  applicability: bounded(1_024),
  verification: bounded(1_024),
  approvedBy: bounded(256),
  approvedAt: timestamp,
  manifestHash: sha256Hex,
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict()
export type SkillsReleaseRecord = z.infer<typeof skillsReleaseRecordSchema>
type SkillsReleaseManifest = Pick<SkillsReleaseRecord, 'name' | 'version' | 'provider' | 'locator' | 'body' | 'contentSha256' | 'resourcesSha256' | 'applicability' | 'verification' | 'approvedBy'>

/** One Captain authorization fact: this member session may have this exact
 * release manifest assembled. CAS by `revision`; never inferred from the
 * roster's static skill view. */
const skillsAssignmentRecordSchema = z.object({
  schemaVersion: z.literal(1),
  scope: bounded(4_096),
  teamId: bounded(256),
  memberSessionId: bounded(256),
  name: bounded(256),
  version: bounded(64),
  releaseManifestHash: sha256Hex,
  assignedBy: bounded(256),
  revision: z.number().int().min(1),
  assignedAt: timestamp,
  updatedAt: timestamp,
}).strict()
export type SkillsAssignmentRecord = z.infer<typeof skillsAssignmentRecordSchema>
const storedReleaseSchema = skillsReleaseRecordSchema as unknown as z.ZodType<SkillsReleaseRecord>
const storedAssignmentSchema = skillsAssignmentRecordSchema as unknown as z.ZodType<SkillsAssignmentRecord>

/** SHA-256 over the canonical approval fields: the manifest identity an
 * assignment pins and the assembly/adoption equality check consumes. */
export function skillsReleaseManifestHash(manifest: SkillsReleaseManifest): string {
  return createHash('sha256').update(canonicalJson(manifest), 'utf8').digest('hex')
}

/** Stable release key: the isolation tuple plus the immutable version slot. */
function skillsReleaseKey(scope: string, teamId: string, name: string, version: string): string {
  return JSON.stringify([scope, teamId, name, version])
}

/** Stable assignment key: one live assignment per member + skill name. */
function skillsAssignmentKey(scope: string, teamId: string, memberSessionId: string, name: string): string {
  return JSON.stringify([scope, teamId, memberSessionId, name])
}

/** The `agent_swarm_skills_management` domain spec opened through `ctx.storageDomain`. */
export const skillsManagementDomainSpec = defineDomain({
  name: SKILLS_MANAGEMENT_DOMAIN_NAME,
  version: SKILLS_MANAGEMENT_DOMAIN_VERSION,
  tables: {
    requests: domainTable<string, SkillsRequestRecord>(storedRequestSchema),
    consumers: domainTable<string, SkillsConsumerRecord>(storedConsumerSchema),
    manager: domainTable<string, SkillsManagerBinding>(storedManagerBindingSchema),
    releases: domainTable<string, SkillsReleaseRecord>(storedReleaseSchema),
    assignments: domainTable<string, SkillsAssignmentRecord>(storedAssignmentSchema),
  },
})

/** Single binding key inside the `manager` table. */
const SKILLS_MANAGER_BINDING_KEY = 'binding'

/** Stable request record key: the scope + Team isolation tuple plus the Captain-stable requestId. */
export function skillsRequestKey(scope: string, teamId: string, requestId: string): string {
  return JSON.stringify([scope, teamId, requestId])
}

/** Stable consumer record key: one consumer per scope + Team. */
export function skillsConsumerKey(scope: string, teamId: string): string {
  return JSON.stringify([scope, teamId])
}

/** Deterministic canonical JSON (sorted object keys, codepoint order, dropped undefined). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(entry => canonicalJson(entry)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
}

/** SHA-256 of the canonical payload JSON: the stable idempotency discriminator. */
export function skillsPayloadHash(payload: SkillsRequestPayload): string {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex')
}

/** Result of one create-first attempt. */
export interface SkillsRequestPut {
  readonly created: boolean
  readonly record: SkillsRequestRecord
}

/**
 * The overlay store over one open skills-management domain handle. All writes
 * reach backend durability through the domain write chain before resolving;
 * the process-local commit sequence serializes create-first races (the
 * module's one writer per Team). Explicitly not a cross-process claim.
 */
export class SkillsManagementStore {
  private readonly requests: KvTable<string, SkillsRequestRecord>
  private readonly consumers: KvTable<string, SkillsConsumerRecord>
  private readonly manager: KvTable<string, SkillsManagerBinding>
  private readonly releases: KvTable<string, SkillsReleaseRecord>
  private readonly assignments: KvTable<string, SkillsAssignmentRecord>
  private readonly commitSequence = new CommitSequence()
  private storeClosed = false

  constructor(
    _ctx: Context,
    domain: Domain<typeof skillsManagementDomainSpec>,
    private readonly now: () => number = Date.now,
  ) {
    this.requests = domain.table('requests') as KvTable<string, SkillsRequestRecord>
    this.consumers = domain.table('consumers') as KvTable<string, SkillsConsumerRecord>
    this.manager = domain.table('manager') as KvTable<string, SkillsManagerBinding>
    this.releases = domain.table('releases') as KvTable<string, SkillsReleaseRecord>
    this.assignments = domain.table('assignments') as KvTable<string, SkillsAssignmentRecord>
  }

  private assertOpen(): void {
    if (this.storeClosed) throw new TeamDomainError('skills-management store is closed', 'SKILLS_MODULE_CLOSED')
  }

  /** Durably create one request record unless the key already exists (then report the stored one). */
  putRequestIfAbsent(scope: string, teamId: string, requestId: string, draft: Omit<SkillsRequestRecord, 'schemaVersion' | 'scope' | 'teamId' | 'requestId' | 'createdAt' | 'updatedAt'>): Promise<SkillsRequestPut> {
    return this.commitSequence.run(async () => {
      this.assertOpen()
      const key = skillsRequestKey(scope, teamId, requestId)
      const existing = this.readRequest(key)
      if (existing !== undefined) return { created: false, record: structuredClone(existing) }
      const stamp = this.now()
      const record: SkillsRequestRecord = { schemaVersion: 1, scope, teamId, requestId, ...draft, createdAt: stamp, updatedAt: stamp }
      await this.requests.put(key, structuredClone(record))
      return { created: true, record: structuredClone(record) }
    })
  }

  /** Atomic single-record transform of one request (state transitions, revision bumps). */
  updateRequest(scope: string, teamId: string, requestId: string, transform: (current: SkillsRequestRecord) => Omit<SkillsRequestRecord, 'schemaVersion' | 'scope' | 'teamId' | 'requestId' | 'createdAt'>): Promise<SkillsRequestRecord> {
    return this.commitSequence.run(async () => {
      this.assertOpen()
      const key = skillsRequestKey(scope, teamId, requestId)
      if (this.readRequest(key) === undefined) throw new TeamDomainError(`skill request ${requestId} not found`, 'SKILLS_REQUEST_NOT_FOUND')
      const updated = await this.requests.update(key, current => {
        const validated = this.assertRequestIdentity(current, key)
        const next: SkillsRequestRecord = { ...transform(validated), schemaVersion: 1, scope, teamId, requestId, createdAt: validated.createdAt, updatedAt: this.now() }
        return structuredClone(next)
      })
      return structuredClone(this.assertRequestIdentity(updated, key))
    })
  }

  /** One request record, or undefined when absent. */
  getRequest(scope: string, teamId: string, requestId: string): SkillsRequestRecord | undefined {
    this.assertOpen()
    const key = skillsRequestKey(scope, teamId, requestId)
    const record = this.readRequest(key)
    return record === undefined ? undefined : structuredClone(record)
  }

  /** Every stored request for one requestId whose Team is inside the given manifest pairs (manager-side lookup; the manifest stays authoritative). */
  findRequestByIdentity(requestId: string, allowed: ReadonlySet<string>): SkillsRequestRecord[] {
    this.assertOpen()
    const found: SkillsRequestRecord[] = []
    for (const [key, raw] of this.requests.entries()) {
      const record = this.assertRequestIdentity(raw, key)
      if (record.requestId === requestId && allowed.has(`${record.scope}\u0000${record.teamId}`)) found.push(structuredClone(record))
    }
    return found
  }

  /** Bounded startup scan: stored requests of one Team currently in the given states (mount recovery). */
  listRequestsByStates(scope: string, teamId: string, states: readonly SkillsRequestRecord['state'][], limit = 64): SkillsRequestRecord[] {
    this.assertOpen()
    const wanted = new Set<string>(states)
    const found: SkillsRequestRecord[] = []
    for (const [key, raw] of this.requests.entries()) {
      const record = this.assertRequestIdentity(raw, key)
      if (record.scope === scope && record.teamId === teamId && wanted.has(record.state)) {
        found.push(structuredClone(record))
        if (found.length >= limit) break
      }
    }
    return found
  }

  /** The durable manager Session binding, or undefined when the module never created one. */
  getManagerBinding(): SkillsManagerBinding | undefined {
    this.assertOpen()
    const raw = this.manager.get(SKILLS_MANAGER_BINDING_KEY)
    return raw === undefined ? undefined : structuredClone(raw)
  }

  /** Durable-before-use: create-first the manager Session binding (concurrent callers converge on one identity). */
  putManagerBindingIfAbsent(sessionId: string): Promise<SkillsManagerBinding> {
    return this.commitSequence.run(async () => {
      this.assertOpen()
      const existing = this.manager.get(SKILLS_MANAGER_BINDING_KEY)
      if (existing !== undefined) return structuredClone(existing)
      const stamp = this.now()
      const record: SkillsManagerBinding = { schemaVersion: 1, sessionId, createdAt: stamp, updatedAt: stamp }
      await this.manager.put(SKILLS_MANAGER_BINDING_KEY, structuredClone(record))
      return structuredClone(record)
    })
  }

  /**
   * Create-or-get the one consumer record for a scope + Team (serialized
   * first-creation). `authority` runs synchronously INSIDE the creation
   * lane immediately before the durable write — the final authorization
   * fence for the first touch.
   */
  ensureConsumer(scope: string, teamId: string, generation: number, authority?: () => void): Promise<SkillsConsumerRecord> {
    return this.commitSequence.run(async () => {
      this.assertOpen()
      const key = skillsConsumerKey(scope, teamId)
      const existing = this.readConsumer(key)
      if (existing !== undefined) return structuredClone(existing)
      const record: SkillsConsumerRecord = {
        schemaVersion: 1, scope, teamId, generation, cursorSequence: 0,
        gaps: [], gapsTruncated: false, conflicts: [], conflictsTruncated: false, anchors: [], anchorsDropped: 0,
        sourceState: 'unknown', needsResync: false, updatedAt: this.now(),
      }
      authority?.()
      await this.consumers.put(key, structuredClone(record))
      return structuredClone(record)
    })
  }

  /** One consumer record, or undefined when absent. */
  getConsumer(scope: string, teamId: string): SkillsConsumerRecord | undefined {
    this.assertOpen()
    const record = this.readConsumer(skillsConsumerKey(scope, teamId))
    return record === undefined ? undefined : structuredClone(record)
  }

  /**
   * The ONE atomic per-page consumer write: baseline, cursor, page-tail
   * watermark, pending references, gaps, conflicts and source state all move
   * inside a single official `KvTable.update` (synchronous pure transform on
   * the domain write chain; a missing key rejects loudly).
   */
  updateConsumer(scope: string, teamId: string, transform: (current: SkillsConsumerRecord) => Omit<SkillsConsumerRecord, 'schemaVersion' | 'scope' | 'teamId' | 'updatedAt'>, authority?: () => void): Promise<SkillsConsumerRecord> {
    return this.commitSequence.run(async () => {
      this.assertOpen()
      const key = skillsConsumerKey(scope, teamId)
      if (this.readConsumer(key) === undefined) throw new TeamDomainError('consumer record is missing; ensure it first', 'SKILLS_CONSUMER_MISSING')
      const updated = await this.consumers.update(key, current => {
        // FINAL commit boundary: the official queued update callback is where
        // authorization is re-validated — a late revocation/cancel can never
        // be raced past an earlier await-time check.
        authority?.()
        const validated = this.assertConsumerIdentity(current, key)
        const next: SkillsConsumerRecord = { ...transform(validated), schemaVersion: 1, scope, teamId, updatedAt: this.now() }
        return structuredClone(next)
      })
      return structuredClone(this.assertConsumerIdentity(updated, key))
    })
  }

  // ── S2 releases / assignments ─────────────────────────────────────────────

  /** Create-first one approved release; an existing key reports the stored
   * manifest unchanged (the caller decides replay vs loud conflict). */
  putReleaseIfAbsent(scope: string, teamId: string, manifest: SkillsReleaseManifest & { approvedAt: number, manifestHash: string }): Promise<{ created: boolean; record: SkillsReleaseRecord }> {
    return this.commitSequence.run(async () => {
      this.assertOpen()
      const key = skillsReleaseKey(scope, teamId, manifest.name, manifest.version)
      const existing = this.readRelease(key)
      if (existing !== undefined) return { created: false, record: structuredClone(existing) }
      const stamp = this.now()
      const record: SkillsReleaseRecord = { schemaVersion: 1, scope, teamId, ...manifest, createdAt: stamp, updatedAt: stamp }
      await this.releases.put(key, structuredClone(record))
      return { created: true, record: structuredClone(record) }
    })
  }

  /** One approved release, or undefined when absent (synchronous memory read). */
  getRelease(scope: string, teamId: string, name: string, version: string): SkillsReleaseRecord | undefined {
    this.assertOpen()
    const record = this.readRelease(skillsReleaseKey(scope, teamId, name, version))
    return record === undefined ? undefined : structuredClone(record)
  }

  /** Bounded durable scan for the assembly provider's catalog. */
  releaseEntries(limit = 256): SkillsReleaseRecord[] {
    this.assertOpen()
    const found: SkillsReleaseRecord[] = []
    for (const [key, raw] of this.releases.entries()) {
      found.push(structuredClone(this.assertReleaseIdentity(raw, key)))
      if (found.length >= limit) break
    }
    return found
  }

  /** Create-first one assignment at revision 1. */
  putAssignmentIfAbsent(scope: string, teamId: string, memberSessionId: string, draft: Pick<SkillsAssignmentRecord, 'name' | 'version' | 'releaseManifestHash' | 'assignedBy'>): Promise<{ created: boolean; record: SkillsAssignmentRecord }> {
    return this.commitSequence.run(async () => {
      this.assertOpen()
      const key = skillsAssignmentKey(scope, teamId, memberSessionId, draft.name)
      const existing = this.readAssignment(key)
      if (existing !== undefined) return { created: false, record: structuredClone(existing) }
      const stamp = this.now()
      const record: SkillsAssignmentRecord = { schemaVersion: 1, scope, teamId, memberSessionId, ...draft, revision: 1, assignedAt: stamp, updatedAt: stamp }
      await this.assignments.put(key, structuredClone(record))
      return { created: true, record: structuredClone(record) }
    })
  }

  /** One live assignment, or undefined when absent (synchronous memory read). */
  getAssignment(scope: string, teamId: string, memberSessionId: string, name: string): SkillsAssignmentRecord | undefined {
    this.assertOpen()
    const record = this.readAssignment(skillsAssignmentKey(scope, teamId, memberSessionId, name))
    return record === undefined ? undefined : structuredClone(record)
  }

  /** Bounded durable scan for the assembly provider's scoped catalog. */
  assignmentEntries(limit = 256): SkillsAssignmentRecord[] {
    this.assertOpen()
    const found: SkillsAssignmentRecord[] = []
    for (const [key, raw] of this.assignments.entries()) {
      found.push(structuredClone(this.assertAssignmentIdentity(raw, key)))
      if (found.length >= limit) break
    }
    return found
  }

  /** Stop accepting operations (the domain handle itself is closed by the owner). */
  close(): void {
    this.storeClosed = true
  }

  private readRequest(key: string): SkillsRequestRecord | undefined {
    const raw = this.requests.get(key)
    return raw === undefined ? undefined : this.assertRequestIdentity(raw, key)
  }

  private readConsumer(key: string): SkillsConsumerRecord | undefined {
    const raw = this.consumers.get(key)
    return raw === undefined ? undefined : this.assertConsumerIdentity(raw, key)
  }

  private readRelease(key: string): SkillsReleaseRecord | undefined {
    const raw = this.releases.get(key)
    return raw === undefined ? undefined : this.assertReleaseIdentity(raw, key)
  }

  private readAssignment(key: string): SkillsAssignmentRecord | undefined {
    const raw = this.assignments.get(key)
    return raw === undefined ? undefined : this.assertAssignmentIdentity(raw, key)
  }

  /** Two-way durable identity check (key ↔ record fields), fail loud on any mismatch. */
  private assertRequestIdentity(record: SkillsRequestRecord, key: string): SkillsRequestRecord {
    if (key !== skillsRequestKey(record.scope, record.teamId, record.requestId)) {
      throw new TeamDomainError('a skills request record key does not match its durable identity', 'SKILLS_TAMPERED')
    }
    return skillsRequestRecordSchema.parse(record) as SkillsRequestRecord
  }

  private assertConsumerIdentity(record: SkillsConsumerRecord, key: string): SkillsConsumerRecord {
    if (key !== skillsConsumerKey(record.scope, record.teamId)) {
      throw new TeamDomainError('a skills consumer record key does not match its durable identity', 'SKILLS_TAMPERED')
    }
    return skillsConsumerRecordSchema.parse(record) as SkillsConsumerRecord
  }

  private assertReleaseIdentity(record: SkillsReleaseRecord, key: string): SkillsReleaseRecord {
    if (key !== skillsReleaseKey(record.scope, record.teamId, record.name, record.version)) {
      throw new TeamDomainError('a skills release record key does not match its durable identity', 'SKILLS_TAMPERED')
    }
    return skillsReleaseRecordSchema.parse(record) as SkillsReleaseRecord
  }

  private assertAssignmentIdentity(record: SkillsAssignmentRecord, key: string): SkillsAssignmentRecord {
    if (key !== skillsAssignmentKey(record.scope, record.teamId, record.memberSessionId, record.name)) {
      throw new TeamDomainError('a skills assignment record key does not match its durable identity', 'SKILLS_TAMPERED')
    }
    return skillsAssignmentRecordSchema.parse(record) as SkillsAssignmentRecord
  }
}

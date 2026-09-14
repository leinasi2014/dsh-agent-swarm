/**
 * Pure vocabulary + history-folding engine for the `agent_swarm_member_private_memory`
 * medium (structure-gate split of member-private-memory.ts, Root-approved
 * 2026-09). NO I/O, no Context, no class: the strict v1|v2 record schemas, the
 * record/view/receipt types, the durable table key, and the pure `foldHistory`
 * operation-index engine. All of this stays INTERNAL to the overlay — no public
 * tool surface is expanded and no second durable state exists; the store and
 * the domain spec live in member-private-memory.ts.
 *
 * @module dsh-agent-swarm/storage/member-private-memory-operations
 */

import { Buffer } from 'node:buffer'
import { z } from 'zod'
import { TeamDomainError } from '../domain/error.js'
import { nonEmpty } from '../domain/team-domain-shared.js'
import {
  assertCanonicalQualityMetadata,
  bounded, boundedOrEmpty, canonicalizeClaim, canonicalizeObservationCore, claimSchema, observationCoreOf, observationSchema,
  provenanceSchema, sameClaim, sameObservation,
  type PrivateMemoryClaim, type PrivateMemoryNote, type PrivateMemoryObservation, type PrivateMemoryObservationCore, type PrivateMemoryProvenance,
} from './member-private-memory-claim.js'

// The claim/provenance vocabulary lives in member-private-memory-claim.ts
// (≤600 mechanical split); re-exported so every downstream consumer keeps
// importing them from this module unchanged.
export type { PrivateMemoryClaim, PrivateMemoryObservation, PrivateMemoryProvenance } from './member-private-memory-claim.js'

/** Root-confirmed v2 format bounds (separate from any future WRITE-admission threshold). */
const PRIVATE_MEMORY_MAX_TAGS = 32
const PRIVATE_MEMORY_MAX_TAG_BYTES = 128
const PRIVATE_MEMORY_MAX_APPLICABILITY_BYTES = 2_048

/**
 * WRITE-admission thresholds (docs04 §7.1 protocol version cced2c181c25b04fcd832c0415ec722e78677b3a + Root ruling):
 * operationId ≤128 UTF-8 bytes, tags ≤32 items ×128 bytes, applicability
 * ≤2,048 bytes, content ≤16,384 bytes, each evidence ref ≤2,048 bytes, and —
 * for BOTH production write paths (the legacy-v1-shaped production `add`
 * via append AND v2 maintenance) —
 * at most 64 evidence refs (legacy rows with 64 refs stay legal and readable;
 * the reader adds NO new admission bound to history). Partition CAPACITY is
 * 256 PHYSICAL history rows counting ALL of v1 notes, v2 operations AND
 * invalidated/superseded history: full means every NEW durable operation
 * (legacy or maintenance) rejects loudly; nothing is ever physically
 * reclaimed, so seq and offsets never drift and the legal history stays fully
 * readable. Archival/compaction is a separate future slice. These are fixed
 * code constants, deliberately not configuration.
 */
export const PRIVATE_MEMORY_MAINTENANCE_MAX_ROWS = 256
export const PRIVATE_MEMORY_MAX_WRITE_EVIDENCE_REFS = 64

const timestamp = z.number().int().min(0)

const privateMemoryRecordSchema = z.object({
  schemaVersion: z.literal(1),
  scope: bounded(4_096),
  teamId: bounded(256),
  memberSessionId: bounded(256),
  seq: z.number().int().min(1),
  memoryId: bounded(128),
  content: bounded(16_384),
  evidenceRefs: z.array(bounded(2_048)),
  createdAt: timestamp,
}).strict()

/** The complete payload every payload-bearing operation must durably carry. */
const operationPayloadFields = {
  content: bounded(16_384),
  evidenceRefs: z.array(bounded(2_048)),
  tags: z.array(bounded(PRIVATE_MEMORY_MAX_TAG_BYTES)).max(PRIVATE_MEMORY_MAX_TAGS),
  applicability: boundedOrEmpty(PRIVATE_MEMORY_MAX_APPLICABILITY_BYTES),
}
const operationTargetSchema = {
  targetMemoryId: bounded(128),
  expectedHeadSeq: z.number().int().min(1),
}

/**
 * Strict maintenance operation rows, one strict branch per (version,
 * operation): schemaVersion 2 keeps the FROZEN pre-M3 shape byte-identically
 * (no `claim` key at all — an old writer or reader sees nothing that moved);
 * schemaVersion 3 is the explicit M3 quality row that MUST carry the
 * declared `claim` block. A version-2 row gaining a `claim` key, or a v3 row
 * missing it, is FOREIGN and rejects at domain open. `expectedHeadSeq` is
 * the target note's newest-OPERATION physical seq at write time — no
 * separate revision clock. revise/replace carry the COMPLETE payload
 * (revise is a full replacement, not a PATCH); invalidate carries none.
 */
const operationCommonFields = {
  scope: bounded(4_096),
  teamId: bounded(256),
  memberSessionId: bounded(256),
  seq: z.number().int().min(1),
  operationId: bounded(128),
  provenance: provenanceSchema,
  createdAt: timestamp,
}

const operationBranch = (schemaVersion: 2 | 3 | 4, operation: 'add' | 'revise' | 'replace') => z.object({
  schemaVersion: z.literal(schemaVersion),
  ...operationCommonFields,
  operation: z.literal(operation),
  ...(operation === 'add' ? {} : operationTargetSchema),
  ...operationPayloadFields,
  // v3 = declared-quality row (claim mandatory); v4 = evidence row
  // (Host-witnessed observation MANDATORY, claim optional); v2 byte-untouched.
  ...(schemaVersion === 3 ? { claim: claimSchema }
    : schemaVersion === 4 ? { observation: observationSchema, claim: claimSchema.optional() } : {}),
}).strict()

// Nested discrimination is the LEGAL multi-version shape: each version's own
// union discriminates on unique operation values and the stored-record union
// selects the version (a flat list would repeat discriminator values and
// throw at schema CONSTRUCTION — host RED 2026-09).
const operationsOfVersion = (schemaVersion: 2 | 3 | 4) => z.discriminatedUnion('operation', [
  operationBranch(schemaVersion, 'add'),
  operationBranch(schemaVersion, 'revise'),
  ...(schemaVersion === 2
    ? [z.object({ schemaVersion: z.literal(2), ...operationCommonFields, operation: z.literal('invalidate'), ...operationTargetSchema }).strict()]
    : []),
  operationBranch(schemaVersion, 'replace'),
])

/** One durable note row (schemaVersion 1; the only shape writers emit). */
export interface MemberPrivateMemoryRecord {
  readonly schemaVersion: 1
  readonly scope: string
  readonly teamId: string
  readonly memberSessionId: string
  readonly seq: number
  readonly memoryId: string
  readonly content: string
  readonly evidenceRefs: string[]
  readonly createdAt: number
}

/**
 * One durable v2/v3 maintenance operation row (compat READING only). The zod
 * branch union owns per-branch strictness; this projection shows the
 * branch-optional fields as optional (presence is schema/fold-enforced).
 * schemaVersion 2 = the frozen pre-M3 shape; 3 = the explicit M3 row that
 * carries the declared `claim` block.
 */
export interface MemberPrivateMemoryOperation {
  readonly schemaVersion: 2 | 3 | 4
  readonly operation: 'add' | 'revise' | 'invalidate' | 'replace'
  readonly scope: string
  readonly teamId: string
  readonly memberSessionId: string
  readonly seq: number
  readonly operationId: string
  readonly provenance: PrivateMemoryProvenance
  readonly createdAt: number
  readonly targetMemoryId?: string
  readonly expectedHeadSeq?: number
  readonly content?: string
  readonly evidenceRefs?: string[]
  readonly tags?: string[]
  readonly applicability?: string
  readonly claim?: PrivateMemoryClaim
  readonly observation?: PrivateMemoryObservation
}

/** The strict v1|v2 durable record union for the `memories` table. */
export type StoredPrivateMemoryRecord = MemberPrivateMemoryRecord | MemberPrivateMemoryOperation

/**
 * The COMPLETE normalized model request of one operation — everything a future
 * retry comparison must judge under the same operationId: the operation branch
 * itself, the target/head the strict branch requires (add has none; the others
 * do), and the full payload the branch requires (invalidate has none). Host
 * metadata (provenance, time, assigned seq) is deliberately EXCLUDED, so a
 * Host-side re-observation can never change the identity of the model input —
 * and invalidate, which has no payload, remains comparable by target/head/op.
 */
export type PrivateMemoryNormalizedRequest =
  | { readonly operation: 'add'; readonly content: string; readonly evidenceRefs: readonly string[]; readonly tags: readonly string[]; readonly applicability: string; readonly claim?: PrivateMemoryClaim; readonly observation?: PrivateMemoryObservationCore }
  | { readonly operation: 'revise'; readonly targetMemoryId: string; readonly expectedHeadSeq: number; readonly content: string; readonly evidenceRefs: readonly string[]; readonly tags: readonly string[]; readonly applicability: string; readonly claim?: PrivateMemoryClaim; readonly observation?: PrivateMemoryObservationCore }
  | { readonly operation: 'invalidate'; readonly targetMemoryId: string; readonly expectedHeadSeq: number }
  | { readonly operation: 'replace'; readonly targetMemoryId: string; readonly expectedHeadSeq: number; readonly content: string; readonly evidenceRefs: readonly string[]; readonly tags: readonly string[]; readonly applicability: string; readonly claim?: PrivateMemoryClaim; readonly observation?: PrivateMemoryObservationCore }

/**
 * The minimal receipt of ONE operation, rebuilt strictly from that operation's
 * OWN history prefix: what the operation produced (result note, head, status
 * AT THE TIME, replacement link). It deliberately carries NO request input —
 * the request side lives in `PrivateMemoryNormalizedRequest` (clearly separate
 * typing). A receipt is derived state — no durable table, and later operations
 * can never rewrite an earlier receipt.
 */
export interface PrivateMemoryReceipt {
  readonly operationId: string
  readonly operation: 'add' | 'revise' | 'invalidate' | 'replace'
  readonly operationSeq: number
  readonly resultMemoryId: string
  readonly headSeq: number
  readonly status: 'active' | 'invalidated' | 'superseded'
  readonly replacedMemoryId?: string
}

/**
 * One entry of the partition's derived operation index: the minimal prefix
 * receipt plus the COMPLETE normalized request, kept as separate typed sides so
 * a future writer can retry-compare ONLY the normalized model input.
 */
export interface PrivateMemoryOperationIndexEntry {
  readonly receipt: PrivateMemoryReceipt
  readonly request: PrivateMemoryNormalizedRequest
}

// The folded note view + page types live in member-private-memory-claim.ts
// (≤600 mechanical split); re-exported so every consumer keeps importing
// them from this module unchanged.
export type { PrivateMemoryNote, PrivateMemoryPage } from './member-private-memory-claim.js'

// Single contained type-erasure: the zod union owns runtime validation at the
// durable boundary; `StoredPrivateMemoryRecord` is its precise projection
// (the team-spec/workflow-overlay pattern). The outer union is NON-keyed
// because the version branches themselves are the operation-discriminated
// unions (a keyed outer union over them is not a legal zod construction).
export const storedPrivateMemoryRecordSchema = z.union([
  privateMemoryRecordSchema,
  operationsOfVersion(2),
  operationsOfVersion(3),
  operationsOfVersion(4),
]) as unknown as z.ZodType<StoredPrivateMemoryRecord>

/** One durable record key: the scope + Team + member isolation tuple plus local seq. */
export function memoryKey(scope: string, teamId: string, memberSessionId: string, seq: number): string {
  return JSON.stringify([scope, teamId, memberSessionId, seq])
}

/**
 * THE operation index + receipt engine: one pure pass over a partition's
 * physically seq-ordered rows that (a) fails closed (`TEAM_PRIVATE_MEMORY_
 * TAMPERED`) on any logically forged history — non-strict seq, duplicate note
 * id, a physically reused operationId IN ONE PARTITION (the same id in a
 * DIFFERENT partition is legal and simply folds separately), a non-canonical
 * payload (content/refs trimmed; tags trimmed, deduplicated, stable code-point
 * order, no case folding; applicability trimmed-when-non-empty — the
 * Root-confirmed format limits are REALLY enforced, not just documented), an
 * unknown target, an operation on a terminal note, an `expectedHeadSeq`
 * disagreeing with the rebuilt head, an invalidate carrying input, or an
 * add/replace id collision — and (b) emits both the folded notes and, per
 * operation, an index entry: the minimal receipt computed AT that operation's
 * own prefix plus its COMPLETE normalized request (operation branch, the
 * target/head the branch requires, and the payload the branch requires —
 * invalidate none), with Host metadata excluded from the request side. No side
 * effects, no I/O, no Team reads.
 */
export function foldHistory(
  records: readonly StoredPrivateMemoryRecord[],
  scope: string,
  teamId: string,
  memberSessionId: string,
): { notes: PrivateMemoryNote[]; index: PrivateMemoryOperationIndexEntry[] } {
  interface MutableNote {
    memoryId: string
    seq: number
    content: string
    evidenceRefs: string[]
    createdAt: number
    status: 'active' | 'invalidated' | 'superseded'
    headSeq: number
    supersededBy?: string
    provenance?: PrivateMemoryProvenance
    tags?: string[]
    applicability?: string
    claim?: PrivateMemoryClaim
    observation?: PrivateMemoryObservation
    createdVia?: { operationId: string; operation: 'add' | 'replace'; seq: number }
  }
  const tampered = (reason: string): TeamDomainError =>
    new TeamDomainError(`a private-memory partition history is not foldable: ${reason}`, 'TEAM_PRIVATE_MEMORY_TAMPERED')
  // Shared reconstructions (dedup of the add/replace note build and the
  // revise/replace request expansion): the branches differ ONLY in the label
  // passed here. Field order and copies are exactly as the inline originals.
  type Payload = NonNullable<ReturnType<typeof payloadOf>>
  const newMutableNote = (memoryId: string, record: MemberPrivateMemoryOperation, payload: Payload, provenance: PrivateMemoryProvenance, createdViaOperation: 'add' | 'replace'): MutableNote => ({
    memoryId, seq: record.seq, content: payload.content,
    evidenceRefs: payload.evidenceRefs, createdAt: record.createdAt,
    status: 'active', headSeq: record.seq, provenance,
    tags: payload.tags, applicability: payload.applicability,
    ...(payload.claim === undefined ? {} : { claim: structuredClone(payload.claim) }),
    ...(record.observation === undefined ? {} : { observation: structuredClone(record.observation) }),
    createdVia: { operationId: record.operationId, operation: createdViaOperation, seq: record.seq },
  })
  const payloadRequest = (operation: 'revise' | 'replace', targetMemoryId: string, expectedHeadSeq: number, payload: Payload): PrivateMemoryOperationIndexEntry['request'] => ({
    operation, targetMemoryId, expectedHeadSeq,
    content: payload.content, evidenceRefs: payload.evidenceRefs, tags: payload.tags, applicability: payload.applicability,
    ...(payload.claim === undefined ? {} : { claim: structuredClone(payload.claim) }),
    ...(payload.observation === undefined ? {} : { observation: { ...payload.observation } }),
  })
  // Canonical payload: structural bounds live in the schema; this fold REALLY
  // enforces normalization. The returned object is a fresh deep copy, so no
  // receipt or note ever aliases a durable row.
  const payloadOf = (record: MemberPrivateMemoryOperation, requirePayload: boolean):
    { content: string, evidenceRefs: string[], tags: string[], applicability: string, claim?: PrivateMemoryClaim, observation?: PrivateMemoryObservationCore } | undefined => {
    const { content, evidenceRefs, tags, applicability, claim, observation } = record
    if (content === undefined && evidenceRefs === undefined && tags === undefined && applicability === undefined) {
      if (requirePayload) throw tampered(`operation '${record.operationId}' lacks the complete payload`)
      return undefined
    }
    if (content === undefined || evidenceRefs === undefined || tags === undefined || applicability === undefined) {
      throw tampered(`operation '${record.operationId}' lacks the complete payload`)
    }
    if (content !== content.trim()) throw tampered(`operation '${record.operationId}' content is not canonical (trimmed)`)
    if (evidenceRefs.some(reference => reference !== reference.trim())) {
      throw tampered(`operation '${record.operationId}' evidence references are not canonical (trimmed)`)
    }
    if (tags.some(tag => tag !== tag.trim())) throw tampered(`operation '${record.operationId}' tags are not canonical (trimmed)`)
    const canonicalTags = [...new Set(tags)].sort()
    if (tags.length !== canonicalTags.length || tags.some((tag, index) => tag !== canonicalTags[index])) {
      throw tampered(`operation '${record.operationId}' tags are not canonical (deduplicated, stable code-point order)`)
    }
    if (applicability !== '' && applicability !== applicability.trim()) {
      throw tampered(`operation '${record.operationId}' applicability is not canonical (trimmed)`)
    }
    // DECLARED + WITNESSED metadata (M3): a present quality/observation block
    // must match its canonical invariants; absent legacy rows stay untouched.
    assertCanonicalQualityMetadata({ claim, observation }, tampered)
    // Request-side projection: Host stamp fields stay out of the normalized
    // input like all Host metadata; the note view keeps the complete block.
    const observationCore = observation === undefined ? undefined : observationCoreOf(observation)
    return {
      content, evidenceRefs: [...evidenceRefs], tags: [...tags], applicability,
      ...(claim === undefined ? {} : { claim: structuredClone(claim) }),
      ...(observationCore === undefined ? {} : { observation: observationCore }),
    }
  }
  const notes: MutableNote[] = []
  const index: PrivateMemoryOperationIndexEntry[] = []
  const byId = new Map<string, MutableNote>()
  const seenOperationIds = new Set<string>()
  let previousSeq = 0
  for (const record of records) {
    if (record.seq <= previousSeq) throw tampered(`physical seq ${record.seq} does not strictly follow ${previousSeq}`)
    previousSeq = record.seq
    if (record.schemaVersion === 1) {
      if (byId.has(record.memoryId)) throw tampered(`note id '${record.memoryId}' is created twice (seq ${record.seq})`)
      const note: MutableNote = {
        memoryId: record.memoryId, seq: record.seq, content: record.content,
        evidenceRefs: [...record.evidenceRefs], createdAt: record.createdAt,
        status: 'active', headSeq: record.seq,
      }
      notes.push(note)
      byId.set(note.memoryId, note)
      continue
    }
    // The operation index keys on the stable id ONLY (normalized-input vs
    // Host-metadata separation): a physical duplicate in ONE partition is
    // durable corruption regardless of how the provenance differs.
    if (seenOperationIds.has(record.operationId)) {
      throw tampered(`operationId '${record.operationId}' is reused at seq ${record.seq}`)
    }
    seenOperationIds.add(record.operationId)
    const provenance = structuredClone(record.provenance)
    if (record.operation === 'add') {
      const payload = payloadOf(record, true)!
      const memoryId = `private-memory-${record.seq}`
      if (byId.has(memoryId)) throw tampered(`add operation '${record.operationId}' note id '${memoryId}' collides`)
      const note = newMutableNote(memoryId, record, payload, provenance, 'add')
      notes.push(note)
      byId.set(memoryId, note)
      index.push({
        receipt: {
          operationId: record.operationId, operation: 'add', operationSeq: record.seq,
          resultMemoryId: memoryId, headSeq: record.seq, status: 'active',
        },
        request: { operation: 'add', ...payload },
      })
      continue
    }
    const targetMemoryId = record.targetMemoryId
    const expectedHeadSeq = record.expectedHeadSeq
    if (targetMemoryId === undefined || expectedHeadSeq === undefined) {
      throw tampered(`operation '${record.operationId}' (seq ${record.seq}) lacks target/expectedHeadSeq`)
    }
    const target = byId.get(targetMemoryId)
    if (target === undefined) {
      throw tampered(`operation '${record.operationId}' (seq ${record.seq}) targets unknown note '${targetMemoryId}'`)
    }
    if (target.status !== 'active') {
      throw tampered(`operation '${record.operationId}' (seq ${record.seq}) targets ${target.status} note '${targetMemoryId}'`)
    }
    if (target.headSeq !== expectedHeadSeq) {
      throw tampered(`operation '${record.operationId}' (seq ${record.seq}) expectedHeadSeq ${expectedHeadSeq} disagrees with note '${targetMemoryId}' head ${target.headSeq}`)
    }
    switch (record.operation) {
      case 'revise': {
        // Full replacement, not a PATCH: content, refs, tags and applicability
        // all come from this operation's complete payload.
        const payload = payloadOf(record, true)!
        target.content = payload.content
        target.evidenceRefs = payload.evidenceRefs
        target.tags = payload.tags
        target.applicability = payload.applicability
        // FULL replacement semantics for the declared/witnessed dimensions:
        // a revise re-witnesses/clears, never silently keeps stale metadata.
        if (payload.claim === undefined) delete target.claim
        else target.claim = structuredClone(payload.claim)
        if (record.observation === undefined) delete target.observation
        else target.observation = structuredClone(record.observation)
        target.provenance = provenance
        target.headSeq = record.seq
        index.push({
          receipt: {
            operationId: record.operationId, operation: 'revise', operationSeq: record.seq,
            resultMemoryId: target.memoryId, headSeq: record.seq, status: target.status,
          },
          request: payloadRequest('revise', targetMemoryId, expectedHeadSeq, payload),
        })
        break
      }
      case 'invalidate': {
        payloadOf(record, false) // invalidate carries no payload; belt-and-braces against schema drift
        target.status = 'invalidated'
        target.headSeq = record.seq
        index.push({
          receipt: {
            operationId: record.operationId, operation: 'invalidate', operationSeq: record.seq,
            resultMemoryId: target.memoryId, headSeq: record.seq, status: 'invalidated',
          },
          request: { operation: 'invalidate', targetMemoryId, expectedHeadSeq },
        })
        break
      }
      case 'replace': {
        const payload = payloadOf(record, true)!
        const replacementId = `private-memory-${record.seq}`
        if (byId.has(replacementId)) throw tampered(`replace operation '${record.operationId}' replacement note id '${replacementId}' collides`)
        target.status = 'superseded'
        target.supersededBy = replacementId
        target.headSeq = record.seq
        const replacement = newMutableNote(replacementId, record, payload, provenance, 'replace')
        notes.push(replacement)
        byId.set(replacementId, replacement)
        index.push({
          receipt: {
            operationId: record.operationId, operation: 'replace', operationSeq: record.seq,
            resultMemoryId: replacementId, headSeq: record.seq, status: 'active',
            replacedMemoryId: targetMemoryId,
          },
          request: payloadRequest('replace', targetMemoryId, expectedHeadSeq, payload),
        })
        break
      }
    }
  }
  return {
    notes: notes.map(note => ({
      scope, teamId, memberSessionId,
      seq: note.seq, memoryId: note.memoryId, content: note.content,
      evidenceRefs: note.evidenceRefs, createdAt: note.createdAt,
      status: note.status, headSeq: note.headSeq,
      ...(note.supersededBy === undefined ? {} : { supersededBy: note.supersededBy }),
      ...(note.provenance === undefined ? {} : { provenance: structuredClone(note.provenance) }),
      ...(note.tags === undefined ? {} : { tags: note.tags }),
      ...(note.applicability === undefined ? {} : { applicability: note.applicability }),
      ...(note.claim === undefined ? {} : { claim: structuredClone(note.claim) }),
      ...(note.observation === undefined ? {} : { observation: structuredClone(note.observation) }),
      ...(note.createdVia === undefined ? {} : { createdVia: { ...note.createdVia } }),
    })),
    index,
  }
}

// ---------------------------------------------------------------------------
// Maintenance WRITE vocabulary (task-4): the strict model input, its
// canonicalization/admission, and the normalized-request equivalence that
// distinguishes a legal retry from a same-operationId conflict. Pure code —
// the durable row is assembled by the store; Host metadata never enters here.
// ---------------------------------------------------------------------------

/**
 * One maintenance write as the MODEL may supply it: exactly the normalized
 * operation branch (operation, the target/head the branch requires, and the
 * complete payload the branch requires). Identity, Team, provenance, seq and
 * time are Host-derived and deliberately NOT expressible in this input.
 */
export type PrivateMemoryMaintenanceInput =
  | { readonly operation: 'add'; readonly operationId: string; readonly content: string; readonly evidenceRefs: readonly string[]; readonly tags: readonly string[]; readonly applicability: string; readonly claim?: PrivateMemoryClaim; readonly observation?: PrivateMemoryObservationCore }
  | { readonly operation: 'revise'; readonly operationId: string; readonly targetMemoryId: string; readonly expectedHeadSeq: number; readonly content: string; readonly evidenceRefs: readonly string[]; readonly tags: readonly string[]; readonly applicability: string; readonly claim?: PrivateMemoryClaim; readonly observation?: PrivateMemoryObservationCore }
  | { readonly operation: 'invalidate'; readonly operationId: string; readonly targetMemoryId: string; readonly expectedHeadSeq: number }
  | { readonly operation: 'replace'; readonly operationId: string; readonly targetMemoryId: string; readonly expectedHeadSeq: number; readonly content: string; readonly evidenceRefs: readonly string[]; readonly tags: readonly string[]; readonly applicability: string; readonly claim?: PrivateMemoryClaim; readonly observation?: PrivateMemoryObservationCore }

const maintenanceInvalid = (field: string): TeamDomainError =>
  new TeamDomainError(`private-memory maintenance input is invalid: ${field}`, 'TEAM_INPUT_INVALID')
const maintenanceLimit = (bound: string): TeamDomainError =>
  new TeamDomainError(`private-memory maintenance input exceeds the ${bound} bound`, 'TEAM_INPUT_LIMIT')
const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index])

/**
 * Validate one maintenance input against the write-admission thresholds and
 * return its canonical form (content/refs trimmed non-empty; refs ≤64; tags
 * trimmed non-empty, deduplicated, stable code-point order ≤32×128B;
 * applicability trimmed, `''` = unconditional, ≤2,048B; operationId trimmed
 * non-empty ≤128B; content ≤16,384B). Invalid input fails with the shared
 * `TEAM_INPUT_INVALID`/`TEAM_INPUT_LIMIT` vocabulary and names only the
 * offending field — never the private content.
 */
export function canonicalizeMaintenanceInput(input: PrivateMemoryMaintenanceInput): PrivateMemoryMaintenanceInput {
  if (!['add', 'revise', 'invalidate', 'replace'].includes(input.operation)) throw maintenanceInvalid('operation')
  const operationId = nonEmpty(input.operationId, 'operation id', 128)
  const canonicalPayload = (payload: { content: string; evidenceRefs: readonly string[]; tags: readonly string[]; applicability: string; claim?: PrivateMemoryClaim; observation?: PrivateMemoryObservationCore }) => {
    const content = nonEmpty(payload.content, 'content', 16_384)
    if (payload.evidenceRefs.length > PRIVATE_MEMORY_MAX_WRITE_EVIDENCE_REFS) throw maintenanceLimit('evidence reference')
    const evidenceRefs = payload.evidenceRefs.map(reference => nonEmpty(reference, 'evidence reference', 2_048))
    const rawTags = payload.tags.map(tag => nonEmpty(tag, 'tag', 128))
    const tags = [...new Set(rawTags)].toSorted()
    if (tags.length > PRIVATE_MEMORY_MAX_TAGS) throw maintenanceLimit('tag')
    const applicability = payload.applicability.trim()
    if (Buffer.byteLength(applicability, 'utf8') > PRIVATE_MEMORY_MAX_APPLICABILITY_BYTES) throw maintenanceLimit('applicability')
    const claim = canonicalizeClaim(payload.claim, maintenanceInvalid)
    // Witness core re-validated at the write gate; a forged complete block
    // can never ride through — only the six core fields are even readable.
    const observation = payload.observation === undefined ? undefined : canonicalizeObservationCore(payload.observation, maintenanceInvalid)
    return {
      content, evidenceRefs, tags, applicability,
      ...(claim === undefined ? {} : { claim }),
      ...(observation === undefined ? {} : { observation }),
    }
  }
  if (input.operation === 'invalidate') {
    if (!Number.isInteger(input.expectedHeadSeq) || input.expectedHeadSeq < 1) throw maintenanceInvalid('expectedHeadSeq')
    return { operation: 'invalidate', operationId, targetMemoryId: nonEmpty(input.targetMemoryId, 'target memory id', 128), expectedHeadSeq: input.expectedHeadSeq }
  }
  if (input.operation === 'add') {
    return { operation: 'add', operationId, ...canonicalPayload(input) }
  }
  if (!Number.isInteger(input.expectedHeadSeq) || input.expectedHeadSeq < 1) throw maintenanceInvalid('expectedHeadSeq')
  return {
    operation: input.operation, operationId,
    targetMemoryId: nonEmpty(input.targetMemoryId, 'target memory id', 128),
    expectedHeadSeq: input.expectedHeadSeq,
    ...canonicalPayload(input),
  }
}

/**
 * Retry-comparison equivalence over the COMPLETE normalized request only
 * (operation branch, target/head, branch payload — witnessed core included,
 * Host stamp fields excluded). Host metadata is not part of either side, so
 * a re-observed Host context never changes whether a retry is the same
 * logical operation.
 */
export function normalizedRequestsEqual(left: PrivateMemoryNormalizedRequest, right: PrivateMemoryNormalizedRequest): boolean {
  if (left.operation !== right.operation) return false
  if (left.operation === 'add' && right.operation === 'add') {
    return left.content === right.content && sameStrings(left.evidenceRefs, right.evidenceRefs)
      && sameStrings(left.tags, right.tags) && left.applicability === right.applicability
      && sameClaim(left.claim, right.claim) && sameObservation(left.observation, right.observation)
  }
  if (left.operation === 'invalidate' && right.operation === 'invalidate') {
    return left.targetMemoryId === right.targetMemoryId && left.expectedHeadSeq === right.expectedHeadSeq
  }
  if ((left.operation === 'revise' || left.operation === 'replace') && left.operation === right.operation) {
    const other = right as typeof left
    return left.targetMemoryId === other.targetMemoryId && left.expectedHeadSeq === other.expectedHeadSeq
      && left.content === other.content && sameStrings(left.evidenceRefs, other.evidenceRefs)
      && sameStrings(left.tags, other.tags) && left.applicability === other.applicability
      && sameClaim(left.claim, other.claim) && sameObservation(left.observation, right.observation)
  }
  return false
}

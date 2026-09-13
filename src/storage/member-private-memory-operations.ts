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

/** Root-confirmed v2 format bounds (separate from any future WRITE-admission threshold). */
const PRIVATE_MEMORY_MAX_TAGS = 32
const PRIVATE_MEMORY_MAX_TAG_BYTES = 128
const PRIVATE_MEMORY_MAX_APPLICABILITY_BYTES = 2_048

const timestamp = z.number().int().min(0)
const bounded = (maxBytes: number) => z.string().min(1).refine(
  value => Buffer.byteLength(value, 'utf8') <= maxBytes,
  `must not exceed ${maxBytes} UTF-8 bytes`,
)
const boundedOrEmpty = (maxBytes: number) => z.string().refine(
  value => Buffer.byteLength(value, 'utf8') <= maxBytes,
  `must not exceed ${maxBytes} UTF-8 bytes`,
)

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

/**
 * Host-derived provenance (strict durable union): either explicitly
 * unattributed, or a task attribution the Host derives from its OWN Team
 * snapshot after checking task/attempt ownership — never a model-supplied
 * actor or scope, and never a capability score. v1 rows have NO provenance on
 * disk and their origin is UNKNOWN: the note view leaves `provenance` absent
 * rather than inventing either branch (an unknown origin is not a recorded
 * 'unattributed' statement).
 */
const provenanceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unattributed') }).strict(),
  z.object({
    kind: z.literal('task'),
    taskId: bounded(256),
    attemptId: bounded(256).optional(),
    teamRevision: z.number().int().min(0),
    observedAt: timestamp,
  }).strict(),
])

/** The complete payload every payload-bearing operation must durably carry. */
const operationPayloadSchema = {
  content: bounded(16_384),
  evidenceRefs: z.array(bounded(2_048)),
  tags: z.array(bounded(PRIVATE_MEMORY_MAX_TAG_BYTES)).max(PRIVATE_MEMORY_MAX_TAGS),
  applicability: boundedOrEmpty(PRIVATE_MEMORY_MAX_APPLICABILITY_BYTES),
}
const operationCommonSchema = {
  schemaVersion: z.literal(2),
  scope: bounded(4_096),
  teamId: bounded(256),
  memberSessionId: bounded(256),
  seq: z.number().int().min(1),
  operationId: bounded(128),
  provenance: provenanceSchema,
  createdAt: timestamp,
}
const operationTargetSchema = {
  targetMemoryId: bounded(128),
  expectedHeadSeq: z.number().int().min(1),
}

/**
 * Strict v2 maintenance operation rows, one branch per operation, each `.strict()`
 * so a wrong branch (e.g. an add carrying a target) or an unknown field is
 * FOREIGN and rejects at domain open. `expectedHeadSeq` is the target note's
 * newest-OPERATION physical seq at write time — no separate revision clock.
 * revise/replace carry the COMPLETE payload (revise is a full replacement, not
 * a PATCH); invalidate carries none. Production writers never emit v2 rows.
 */
const privateMemoryOperationSchema = z.discriminatedUnion('operation', [
  z.object({ ...operationCommonSchema, operation: z.literal('add'), ...operationPayloadSchema }).strict(),
  z.object({ ...operationCommonSchema, operation: z.literal('revise'), ...operationTargetSchema, ...operationPayloadSchema }).strict(),
  z.object({ ...operationCommonSchema, operation: z.literal('invalidate'), ...operationTargetSchema }).strict(),
  z.object({ ...operationCommonSchema, operation: z.literal('replace'), ...operationTargetSchema, ...operationPayloadSchema }).strict(),
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

/** Host-derived operation provenance (durable v2 branches only). */
type PrivateMemoryProvenance =
  | { readonly kind: 'unattributed' }
  | { readonly kind: 'task'; readonly taskId: string; readonly attemptId?: string; readonly teamRevision: number; readonly observedAt: number }

/**
 * One durable v2 maintenance operation row (compat READING only). The zod
 * four-branch union owns per-branch strictness; this projection shows the
 * branch-optional fields as optional (presence is schema/fold-enforced).
 */
interface MemberPrivateMemoryOperation {
  readonly schemaVersion: 2
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
type PrivateMemoryNormalizedRequest =
  | { readonly operation: 'add'; readonly content: string; readonly evidenceRefs: readonly string[]; readonly tags: readonly string[]; readonly applicability: string }
  | { readonly operation: 'revise'; readonly targetMemoryId: string; readonly expectedHeadSeq: number; readonly content: string; readonly evidenceRefs: readonly string[]; readonly tags: readonly string[]; readonly applicability: string }
  | { readonly operation: 'invalidate'; readonly targetMemoryId: string; readonly expectedHeadSeq: number }
  | { readonly operation: 'replace'; readonly targetMemoryId: string; readonly expectedHeadSeq: number; readonly content: string; readonly evidenceRefs: readonly string[]; readonly tags: readonly string[]; readonly applicability: string }

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

/**
 * One note in the reader's folded view — a distinct type from any stored record
 * (a v2 operation is never cast as a v1 row). `seq`/`memoryId`/`createdAt` stay
 * the ORIGINAL creation identity (ids and pagination offsets never drift);
 * `headSeq` is the newest operation seq touching the note; `status`/
 * `supersededBy` carry invalidate/replace results. `createdVia` explicitly
 * marks notes whose creation came from a v2 add/replace (never inferred from
 * status/headSeq). `provenance`/`tags`/`applicability` describe the CURRENT
 * payload's origin: ABSENT provenance means the legacy v1 origin is UNKNOWN
 * (never an invented 'unattributed'), present only once a v2 operation supplied
 * the payload; `applicability` '' means unconditional. A replace keeps the old
 * row superseded IN PLACE (its own payload origin stays unknown) and appends
 * the new note at the END of creation order; maintenance rows never surface
 * as notes.
 */
export interface PrivateMemoryNote {
  readonly scope: string
  readonly teamId: string
  readonly memberSessionId: string
  readonly seq: number
  readonly memoryId: string
  readonly content: string
  readonly evidenceRefs: string[]
  readonly createdAt: number
  readonly status: 'active' | 'invalidated' | 'superseded'
  readonly headSeq: number
  readonly supersededBy?: string
  readonly provenance?: PrivateMemoryProvenance
  readonly tags?: string[]
  readonly applicability?: string
  readonly createdVia?: { readonly operationId: string; readonly operation: 'add' | 'replace'; readonly seq: number }
}

/** One page of private-memory notes in member-local creation order. */
export interface PrivateMemoryPage {
  readonly rows: PrivateMemoryNote[]
  readonly nextCursor?: number
}

// Single contained type-erasure: the zod union owns runtime validation at the
// durable boundary; `StoredPrivateMemoryRecord` is its precise projection
// (the team-spec/workflow-overlay pattern).
export const storedPrivateMemoryRecordSchema = z.discriminatedUnion('schemaVersion', [
  privateMemoryRecordSchema,
  privateMemoryOperationSchema,
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
    createdVia?: { operationId: string; operation: 'add' | 'replace'; seq: number }
  }
  const tampered = (reason: string): TeamDomainError =>
    new TeamDomainError(`a private-memory partition history is not foldable: ${reason}`, 'TEAM_PRIVATE_MEMORY_TAMPERED')
  // Canonical payload: structural bounds live in the schema; this fold REALLY
  // enforces normalization. The returned object is a fresh deep copy, so no
  // receipt or note ever aliases a durable row.
  const payloadOf = (record: MemberPrivateMemoryOperation, requirePayload: boolean):
    { content: string, evidenceRefs: string[], tags: string[], applicability: string } | undefined => {
    const { content, evidenceRefs, tags, applicability } = record
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
    return { content, evidenceRefs: [...evidenceRefs], tags: [...tags], applicability }
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
      const note: MutableNote = {
        memoryId, seq: record.seq, content: payload.content,
        evidenceRefs: payload.evidenceRefs, createdAt: record.createdAt,
        status: 'active', headSeq: record.seq, provenance,
        tags: payload.tags, applicability: payload.applicability,
        createdVia: { operationId: record.operationId, operation: 'add', seq: record.seq },
      }
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
        target.provenance = provenance
        target.headSeq = record.seq
        index.push({
          receipt: {
            operationId: record.operationId, operation: 'revise', operationSeq: record.seq,
            resultMemoryId: target.memoryId, headSeq: record.seq, status: target.status,
          },
          request: {
            operation: 'revise', targetMemoryId, expectedHeadSeq,
            content: payload.content, evidenceRefs: payload.evidenceRefs, tags: payload.tags, applicability: payload.applicability,
          },
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
        const replacement: MutableNote = {
          memoryId: replacementId, seq: record.seq, content: payload.content,
          evidenceRefs: payload.evidenceRefs, createdAt: record.createdAt,
          status: 'active', headSeq: record.seq, provenance,
          tags: payload.tags, applicability: payload.applicability,
          createdVia: { operationId: record.operationId, operation: 'replace', seq: record.seq },
        }
        notes.push(replacement)
        byId.set(replacementId, replacement)
        index.push({
          receipt: {
            operationId: record.operationId, operation: 'replace', operationSeq: record.seq,
            resultMemoryId: replacementId, headSeq: record.seq, status: 'active',
            replacedMemoryId: targetMemoryId,
          },
          request: {
            operation: 'replace', targetMemoryId, expectedHeadSeq,
            content: payload.content, evidenceRefs: payload.evidenceRefs, tags: payload.tags, applicability: payload.applicability,
          },
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
      ...(note.createdVia === undefined ? {} : { createdVia: { ...note.createdVia } }),
    })),
    index,
  }
}
